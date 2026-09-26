/**
 * Agent tool-calling loop — OpenAI-compatible chat.completions + VSCodeAIBridge.
 */

import * as vscode from 'vscode';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';
import { ApprovalDialog } from '../ui/approvalDialog';
import { DiffPreview } from '../ui/diffPreview';
import { getApprovalPolicy } from '../policy/approvalPolicy';
import { getTrace } from '../trace/traceService';
import { getMcp } from '../mcp/mcpClient';
import { approvalLevelForRisk, getToolRegistry, type ToolRisk } from './toolRegistry';
import { getAgentModeRegistry, toolVisibleInMode, type AgentModeDefinition } from './agentModes';
import { SessionStore } from '../sessions/sessionStore';
import { buildPriorAgentTranscript } from './priorContext';
import {
	calibratedTokens,
	isContextOverflowError,
	parseOverflowTokens,
	updateTokenCalibration,
} from './contextOverflow';
import {
	filterAnthropicToolResults,
	formatReadLedger,
	midCompactMessages,
	normalizeToolProtocolHistory,
	softCompactToolResults,
} from './toolHistory';
import * as lsp from '../intelligence/lspBridge';
import * as git from '../intelligence/gitTools';
import {
	StableFacts,
	emptyStableFacts,
	extractFactsFromTool,
	formatStableFactsBlock,
	mergeStableFacts,
	normalizeFacts,
} from './stableFacts';
import { buildContextPacket } from './contextPacket';
import { loadAgentsMdForPrompt } from './projectInstructions';
import {
	retrieveSnippets,
	formatRetrievedBlock,
	ensureWorkspaceIndex,
} from '../intelligence/workspaceIndex';
import { getGovernanceStore } from '../governance/governanceStore';
import { GuardrailSession } from '../governance/guardrailEngine';
import { decideGates, enabledGates, getGateRegistry, type GateSession } from '../governance/gateRegistry';
import { getSkillsRules, skillsMatchingHints } from '../skills/skillsRulesLoader';
import { runAgentHooks } from '../hooks/hooksRunner';
import { getSessionWikiStore } from '../memory/sessionWiki';
import { learnFromShellFailure, isShellNoiseFailure } from '../memory/extendedMemory';
import { getProjectWikiStore } from '../memory/projectWiki';
import {
	discoverStatusRefs,
	finishTurn,
	parseRepoSnapshot,
	saveProjectStatus,
	shouldRequireStatusUpdate,
	type StatusOutcome,
} from './projectStatus';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { getArtifactStore } from '../storage/artifacts';
import { AgentStateMachine } from './stateMachine';
import { DEFAULT_BUDGET } from '../context/engine';
import * as browser from '../browser/agent';
import {
	claimsBuildOrTestGreen,
	EMPTY_TURN_NOTE,
	finalReplyNote,
	LENGTH_CAP_NOTE,
	oracleRejectNote,
	parseBlockedClaim,
	STATUS_UPDATE_NOTE,
} from './nudges';
import { clipData, clipToolOutput } from './clip';
import {
	canonicalizePathKey,
	invalidatePaths,
	parseReadCoverage,
	readAliasesFor,
	rememberedReadWindow,
} from './readMemory';
import { detectOracle, exitCodeOf, formatOracleResult, nodeOracleFs, runOracle, type OracleResult } from './oracle';
import {
	buildDotnetCommand,
	currentPhase,
	DOTNET_TOOL,
	isPartialRewrite,
	isStatusQuestion,
	LARGE_FILE_LINES,
	mentionsErrorFile,
	toolNamesFor,
	type AgentPhase,
} from './toolsets';

/** Oracle result plus the cookbook fix for each error code present (only those). */
export function oracleNote(result: OracleResult, reason: string): string {
	const hints = result.ok ? [] : getSkillsRules().cookbookHints(result.errors.map(e => e.code)).slice(0, 6);
	return formatOracleResult(result, reason) + (hints.length ? `\n\nKnown fixes:\n${hints.map(h => `- ${h}`).join('\n')}` : '');
}
import { applyEdit } from './editTool';

function dotnetCommandLine(args: Record<string, unknown>): string {
	const built = buildDotnetCommand(args);
	return 'command' in built ? built.command : '';
}

// Note: subagent is inlined via recursive runAgentWithTools — no separate import (avoids cycles).

const MUTATING = new Set(['write', 'edit', 'dotnet', 'delete', 'rename', 'shell', 'wiki_write', 'wiki_fact', 'browser_navigate', 'browser_click', 'browser_type']);
const READONLY_TOOLS = new Set([
	'read',
	'list',
	'search',
	'retrieve',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'git_commit_msg',
	'git_blame',
	'git_conflicts',
	'open',
	'wiki_read',
	'wiki_search',
	'wiki_facts',
	'browser_snapshot',
]);

function normalizeShellCommand(cmd: string): string {
	return cmd
		.replace(/\r\n/g, '\n')
		.replace(/\\/g, '/')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/** Strip Unix pipes that break on Windows cmd.exe; return cleaned command + note. */
export function stripUnixPipes(command: string): { command: string; note?: string } {
	const cleaned = command.replace(/\s*\|\s*(tail|head|grep)\b[^|&;]*/gi, '').trim();
	if (cleaned === command.trim()) return { command: command.trim() };
	return {
		command: cleaned,
		note: 'Removed Unix pipe (tail/head/grep) — shell is cmd.exe on Windows.',
	};
}

function annotateRetrieveWithReadMemory(
	output: string,
	readPathsSeen: Set<string>,
	readMaxEnd: Map<string, number>
): string {
	if (!output.startsWith('### RETRIEVED') || !readPathsSeen.size) return output;
	return output.replace(/^####\s+(\S+):(\d+)/gm, (full, filePath: string, line: string) => {
		const key = canonicalizePathKey(filePath);
		const alt = key.startsWith('docs/') ? key.slice(5) : `docs/${key}`;
		const seen = readPathsSeen.has(key) || readPathsSeen.has(alt);
		if (!seen) return full;
		const end = readMaxEnd.get(key) ?? readMaxEnd.get(alt);
		return `${full} (already read${end ? ` ~L${end}` : ''} — prefer acting)`;
	});
}

function simpleHash(text: string): string {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

function toolFingerprint(name: string, args: Record<string, unknown>): string {
	const normalized: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === 'string' && (k === 'path' || k === 'oldPath' || k === 'newPath')) {
			normalized[k] = v.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
		} else if (name === 'shell' && k === 'command' && typeof v === 'string') {
			normalized[k] = normalizeShellCommand(v);
		} else if (k === 'content' && typeof v === 'string') {
			// Avoid fingerprinting full file bodies — path + size/hash is enough for repeats.
			normalized[k] = `len:${v.length}:h:${simpleHash(v)}`;
		} else {
			normalized[k] = v;
		}
	}
	return `${name}:${JSON.stringify(normalized)}`;
}

/** Target context window (tokens). Prefers server numCtx, then setting. */
function getContextBudget(override?: number): number {
	if (typeof override === 'number' && override >= 2048) {
		return Math.floor(override);
	}
	const n = vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget');
	return n && n > 0 ? n : 32768;
}

/** Reserve completion headroom so prompt + max_tokens cannot exceed numCtx. */
function outputTokenReserve(budget: number, maxTokens = 8192): number {
	return Math.max(Math.floor(budget * 0.25), Math.min(maxTokens, Math.floor(budget * 0.4)));
}

/** Effective prompt budget after reserving space for the completion. */
function promptTokenBudget(budget: number, maxTokens = 8192): number {
	return Math.max(2048, budget - outputTokenReserve(budget, maxTokens));
}

function completionMaxTokens(budget: number): number {
	if (budget <= 16384) return 4096;
	if (budget <= 24576) return 6144;
	return 8192;
}

function toolResultCharCap(budget: number): number {
	// Use a real slice of the window — 32k should keep substantial tool bodies (Cursor-style).
	const usable = promptTokenBudget(budget);
	const soft = Math.floor(usable * 0.28);
	const ceiling = budget >= 32000 ? 18000 : budget >= 16000 ? 12000 : 8000;
	return Math.min(ceiling, Math.max(3500, soft));
}

function compactTokenThreshold(budget: number): number {
	// Hard-compact when the usable prompt window is nearly full.
	return Math.floor(promptTokenBudget(budget) * 0.9);
}

function softCompactTokenThreshold(budget: number): number {
	return Math.floor(promptTokenBudget(budget) * 0.72);
}

function midCompactTokenThreshold(budget: number): number {
	return Math.floor(promptTokenBudget(budget) * 0.82);
}

function compactEveryNSteps(budget: number): number {
	// Soft hygiene only; never force a hard LLM compact on a timer.
	if (budget >= 32000) return 24;
	if (budget >= 16000) return 16;
	return 8;
}

/** Chars for prior-turn continuity — keep light (Cursor-style), not a second repo dump. */
function priorTranscriptCharBudget(budget: number): number {
	// ~10–12% of the token window in characters; hard caps so 110 old tools cannot dominate.
	const target = Math.floor(budget * 0.45);
	const ceiling = budget >= 32000 ? 10000 : budget >= 16000 ? 6000 : 3500;
	return Math.min(ceiling, Math.max(2500, target));
}

/** Extra fields for Ollama-compatible gateways (ignored if unsupported). */
function llmContextOptions(budget: number): Record<string, unknown> {
	return {
		options: { num_ctx: budget },
		num_ctx: budget,
	};
}

/** OpenAI-compat JSON mode — ignored by servers that do not support it. */
function llmJsonOptions(forceJson?: boolean): Record<string, unknown> {
	if (!forceJson) return {};
	return {
		response_format: { type: 'json_object' },
	};
}

export const AGENT_TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'read',
			description:
				'Read a slice of a workspace file with line numbers. Default 120 lines from startLine; use startLine+limit for another slice.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					startLine: {
						type: 'number',
						description: '1-based start line (default 1)',
					},
					limit: {
						type: 'number',
						description: 'Max lines to return (default 120, max 400)',
					},
					offset: {
						type: 'number',
						description: 'Alias for startLine',
					},
					endLine: {
						type: 'number',
						description: 'Optional inclusive end line (alternative to limit)',
					},
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'write',
			description:
				'Create a new file, or replace a whole file when most of it changes. To change part of an existing file use edit. content is the complete file body.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: {
						type: 'string',
						description: 'Complete file body.',
					},
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'edit',
			description:
				'Replace an exact text span in an existing file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Include 2-3 surrounding lines to make it unique.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					old_string: { type: 'string', description: 'Exact existing text to replace' },
					new_string: { type: 'string', description: 'Replacement text' },
					replace_all: {
						type: 'boolean',
						description: 'Replace every occurrence (default false)',
					},
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	},
	DOTNET_TOOL,
	{
		type: 'function' as const,
		function: {
			name: 'list',
			description:
				'List the files of one folder (non-recursive by default).',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					recursive: {
						type: 'boolean',
						description: 'Optional shallow recursion (capped).',
					},
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search',
			description: 'Search workspace files for a regex/text pattern',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string' },
					path: { type: 'string' },
				},
				required: ['pattern'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'retrieve',
			description:
				'Retrieve top-k code snippets relevant to a query (hybrid lexical + semantic when embeddings are indexed). Prefer this over dumping full files.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					k: { type: 'number', description: 'Max snippets (default 6)' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'delete',
			description: 'Delete a file',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'rename',
			description: 'Rename or move a file',
			parameters: {
				type: 'object',
				properties: {
					oldPath: { type: 'string' },
					newPath: { type: 'string' },
				},
				required: ['oldPath', 'newPath'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'open',
			description: 'Open a file in the editor',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'shell',
			description:
				'Run a shell command in the workspace (cmd.exe on Windows) under the sandbox (restricted by default: secret env scrubbed). Optional args.sandbox: safe-local|restricted|isolated|container. Output streams to the Agent Terminal. Long-running servers hand off after startup — do not re-run them.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Command to run' },
					sandbox: {
						type: 'string',
						description: 'safe-local | restricted | isolated | container | unrestricted',
					},
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'diagnostics',
			description: 'Get language diagnostics (errors/warnings) for a file or the whole workspace',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'symbols',
			description: 'List document symbols or search workspace symbols',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path for document symbols' },
					query: { type: 'string', description: 'Workspace symbol query' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'references',
			description: 'Find references at a position (1-based line)',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					line: { type: 'number' },
					character: { type: 'number' },
				},
				required: ['path', 'line'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'definition',
			description: 'Go to definition at a position (1-based line)',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					line: { type: 'number' },
					character: { type: 'number' },
				},
				required: ['path', 'line'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_status',
			description: 'Show git status',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_diff',
			description: 'Show git diff',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_log',
			description: 'Show recent git commits',
			parameters: {
				type: 'object',
				properties: { count: { type: 'number' } },
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_commit_msg',
			description: 'Suggest a commit message from current changes',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_blame',
			description: 'Git blame for a file (optional line range)',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					startLine: { type: 'number' },
					endLine: { type: 'number' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'git_conflicts',
			description: 'List merge conflicts and conflict markers in the workspace',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'wiki_read',
			description: 'Read a project wiki document by id (or list ids if omitted)',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string' } },
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'wiki_write',
			description: 'Create/update a project wiki document (persisted across sessions)',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					content: { type: 'string' },
					category: { type: 'string' },
				},
				required: ['id', 'title', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'wiki_search',
			description: 'Search project wiki documents',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string' } },
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'wiki_fact',
			description: 'Add or supersede a temporal project fact (key/value)',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string' },
					value: { type: 'string' },
					reason: { type: 'string' },
				},
				required: ['key', 'value'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'wiki_facts',
			description: 'List current (non-superseded) temporal facts',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'update_status',
			description:
				'Write where the work stopped to .CodeForge/memory/status.json. Call this before the final reply of every turn. The next turn reads this file instead of scanning the repo.',
			parameters: {
				type: 'object',
				properties: {
					objective: { type: 'string', description: 'What the current work is trying to do' },
					stoppedAt: { type: 'string', description: 'Where the work stopped, in one or two sentences' },
					next: { type: 'string', description: 'The next concrete step' },
					blockers: { type: 'string', description: 'What is blocking progress, if anything' },
					files: {
						type: 'array',
						items: { type: 'string' },
						description: 'Paths touched or still relevant',
					},
				},
				required: ['objective', 'stoppedAt', 'next'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_navigate',
			description: 'Open a URL in the embedded browser agent (Playwright optional)',
			parameters: {
				type: 'object',
				properties: { url: { type: 'string' } },
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_snapshot',
			description: 'Capture text snapshot of the current browser page',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_click',
			description: 'Click a CSS selector in the browser',
			parameters: {
				type: 'object',
				properties: { selector: { type: 'string' } },
				required: ['selector'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_type',
			description: 'Type into a CSS selector in the browser',
			parameters: {
				type: 'object',
				properties: {
					selector: { type: 'string' },
					text: { type: 'string' },
				},
				required: ['selector', 'text'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_screenshot',
			description: 'Take a full-page screenshot (saved as artifact)',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'delegate_task',
			description:
				'Delegate a focused subtask to a subagent (depth-1). For broad “where is X” questions when exploreSubagent is on, pass mode: "explore" (read-only).',
			parameters: {
				type: 'object',
				properties: {
					task: { type: 'string' },
					context: { type: 'string' },
					mode: {
						type: 'string',
						description: 'Optional: "explore" for read-only codebase survey',
					},
				},
				required: ['task'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'mcp_call',
			description: 'Call an MCP tool by full name (server__tool)',
			parameters: {
				type: 'object',
				properties: {
					tool: { type: 'string' },
					arguments: { type: 'object' },
				},
				required: ['tool'],
			},
		},
	},
];

const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map(t => t.function.name));

function allAgentToolNames(mode?: AgentModeDefinition): string[] {
	const registry = getToolRegistry();
	const ext = registry
		.list()
		.filter(t => toolVisibleInMode(t, mode))
		.map(t => t.name);
	return [...new Set([...AGENT_TOOL_NAMES, ...ext])];
}

function toolsForRound(activeToolNames: Set<string>, mode?: AgentModeDefinition): typeof AGENT_TOOLS {
	const registry = getToolRegistry();
	const native = AGENT_TOOLS.filter(t => activeToolNames.has(t.function.name));
	const ext = registry
		.toOpenAiTools()
		.filter(t => {
			if (!activeToolNames.has(t.function.name) || AGENT_TOOL_NAMES.has(t.function.name)) return false;
			const def = registry.get(t.function.name);
			return def ? toolVisibleInMode(def, mode) : false;
		});
	return [...native, ...(ext as unknown as typeof AGENT_TOOLS)];
}

function riskForAgentTool(name: string): ToolRisk {
	const ext = getToolRegistry().get(name);
	if (ext && !AGENT_TOOL_NAMES.has(name)) return ext.risk;
	if (READONLY_TOOLS.has(name) || name === 'update_status') return 'read';
	if (name === 'shell' || name === 'dotnet') return 'shell';
	if (name === 'mcp_call') return 'remote-write';
	if (MUTATING.has(name)) return 'local-write';
	return 'read';
}

type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

type ChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentPart[];
	tool_call_id?: string;
	name?: string;
	tool_calls?: ToolCall[];
};

interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface AgentActivityEvent {
	kind: 'thinking' | 'tool' | 'compact' | 'checkpoint' | 'thought' | 'context';
	label: string;
	detail?: string;
	tool?: string;
	success?: boolean;
	/** Correlate running → done for tool cards in the chat stream. */
	toolCallId?: string;
	toolStatus?: 'running' | 'ok' | 'failed';
}

export interface AgentHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface AgentLoopOptions {
	bridge: VSCodeAIBridge;
	provider: string;
	apiKey: string;
	model: string;
	baseUrl: string;
	workspaceRoot?: string;
	task: string;
	/** Optional vision parts (data URLs) attached to the user turn. */
	images?: Array<{ mime: string; dataUrl: string; label?: string }>;
	history?: AgentHistoryMessage[];
	cancelled: () => boolean;
	abortSignal?: AbortSignal;
	onStatus?: (text: string) => void;
	onActivity?: (event: AgentActivityEvent) => void;
	onContextBadge?: (badge: { indexed: number; inContext: number }) => void;
	/** Prompt tokens used vs context window limit (for the composer ring). */
	onContextUsage?: (usage: { used: number; limit: number }) => void;
	/** User-turn index for tool traces (0-based). */
	turnIndex?: number;
	onTaskUpdate?: (update: {
		id: string;
		name: string;
		status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
		model?: string;
		elapsed?: number;
		result?: string;
		subtasks?: Array<{
			id: string;
			name: string;
			status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
		}>;
	}) => void;
	sessionStore?: SessionStore;
	sessionId?: string | null;
	/** Override context window (tokens). Prefer server.numCtx from settings. */
	numCtx?: number;
	/** Prefer JSON responses (response_format=json_object) for this server. */
	forceJson?: boolean;
	/**
	 * When true, do not send native `tools` — local/gateway models that reject tools
	 * must emit tool_calls as JSON in content (parsed by parseProseToolCalls).
	 */
	proseToolsOnly?: boolean;
	/** Initial checkpoint size (default 30). Extended on positive reviews. */
	maxSteps?: number;
	/** Absolute hard cap (default 100). */
	hardCap?: number;
	depth?: number;
	/** Weak-model harness for this run (auto-detected or forced). */
	weakProfile?: boolean;
	/**
	 * Plan mode: allow explore + wiki tools only (no production writes/shell mutators).
	 */
	planMode?: boolean;
	/**
	 * Clean context (orchestrator items): no chat history, no prior-session transcript or read memory.
	 * Stable facts and tool traces are still shared through the session.
	 */
	isolated?: boolean;
	/** Phase decided by the caller (orchestrator items) instead of inferred from the task text. */
	basePhase?: AgentPhase;
	/** Extension agent mode. When omitted, the registry's active mode is used. */
	agentModeId?: string;
}

const PLAN_MODE_TOOLS = new Set([
	'list',
	'read',
	'search',
	'retrieve',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'git_blame',
	'open',
	'wiki_read',
	'wiki_search',
	'wiki_write',
	'wiki_fact',
	'wiki_facts',
	'update_status',
]);

export async function runAgentWithTools(opts: AgentLoopOptions): Promise<string> {
	const checkpointSize = opts.maxSteps ?? 30;
	const hardCap = opts.hardCap ?? 100;
	const depth = opts.depth ?? 0;
	const adaptive = depth === 0; // subagents keep fixed short budget
	let stepBudget = adaptive ? checkpointSize : Math.min(opts.maxSteps ?? 8, 8);
	let nextCheckpoint = stepBudget;
	const base = (opts.baseUrl || defaultBase(opts.provider)).replace(/\/$/, '');
	const url = `${base}/chat/completions`;
	const trace = getTrace();
	const mcp = getMcp();
	const mcpTools = mcp?.listTools() ?? [];
	const governance = getGovernanceStore();
	const weakProfile = opts.weakProfile === true;
	const gates = new GuardrailSession(governance.runtimeConfig({ weakProfile }));
	const agentMode = opts.agentModeId
		? getAgentModeRegistry().get(opts.agentModeId)
		: getAgentModeRegistry().active();
	const extGateSession: GateSession = {
		workspaceRoot: opts.workspaceRoot,
		sessionId: opts.sessionId ?? undefined,
		task: opts.task,
		notes: [],
	};

	const openPaths = collectOpenFilePaths(opts.workspaceRoot);
	const hintedSkillIds = agentMode?.skillHints?.length
		? skillsMatchingHints(governance.getState().skills, agentMode.skillHints).map(s => s.id)
		: [];
	const forceSkills = [
		...(weakProfile ? ['skill.harness-weak-models'] : []),
		...(openPaths.some(p => /\.cshtml$|\.razor$|\/(Pages|Views)\//i.test(p)) ? ['skill.dotnet-razor'] : []),
		...hintedSkillIds,
	];
	const skillSection = [
		governance.buildPromptSection(opts.task, { forceSkillIds: forceSkills }),
		getSkillsRules().buildPromptSection(
			opts.task,
			openPaths,
			Math.min(5000, Math.max(2000, Math.floor(getContextBudget(opts.numCtx) * 0.08))),
			agentMode?.skillHints ?? []
		),
	]
		.filter(Boolean)
		.join('\n\n');
	const mcpHint = mcpTools.length && (!weakProfile || /\bmcp\b/i.test(opts.task))
		? `MCP tools available via mcp_call: ${mcpTools.map(t => t.fullName).join(', ')}`
		: '';
	const agentsMdSection = await loadAgentsMdForPrompt();

	const statusQuestion = isStatusQuestion(opts.task);
	if (statusQuestion) {
		stepBudget = 4;
		nextCheckpoint = hardCap;
	}
	const planModeHint = opts.planMode && opts.isolated
		? 'Only exploration tools are available in this run.'
		: opts.planMode
		? [
				'### PLAN MODE (active)',
				'Explore the repo and write a plan to the wiki (wiki_write id=task-plan with checklist + Definition of Done).',
				'Only explore and wiki tools are available in this mode. When the plan is saved, reply with a summary of it.',
			].join('\n')
		: '';
	const systemBase = [
		'You are CodeForge Agent, a coding agent inside a VS Code-based IDE on Windows.',
		`Workspace root: ${opts.workspaceRoot ?? '(none — ask user to open a folder)'}`,
		'Use the tools to read and change files and to run commands. Paths are relative to the workspace root.',
		'For .NET use the `dotnet` tool (new, sln_add, add_reference, add_package, build, test); it runs from the workspace root with explicit paths.',
		'Shell runs cmd.exe in the workspace root: `&&` works; PowerShell syntax and Unix pipes (tail/grep/head) do not.',
		'Shell results include the exit code and output. When a command fails, change the command or the files before running it again.',
		'Long-running servers (dotnet run, npm start) hand off after startup and keep streaming in the Agent Terminal; one start is enough.',
		'The CONTEXT PACKET (PROJECT STATUS, IDE STATE, RETRIEVE, STABLE FACTS) is your starting point. PROJECT STATUS is where the work stopped; answer that from the block. STABLE FACTS hold the canonical project roots and open build errors.',
		'Before the final reply, call update_status (objective, stoppedAt, next) so .CodeForge/memory/status.json stays current for the next turn.',
		'Typical flow: retrieve/search → read the slice you will change → edit (existing file) or write (new file) → build/test.',
		'Tool results stay in this chat. A repeated read of a range you already have returns the remembered text, marked as already in context.',
		'Independent reads/searches can be issued together in one step.',
		vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('exploreSubagent')
			? 'For broad “where is X across the repo” questions, you may call delegate_task with mode explore (read-only). Prefer retrieve for focused lookups.'
			: '',
		'The IDE runs the project build/test (oracle) after a few writes and when you finish; the task is done when it is green. If you cannot finish, reply with `blocked: <reason>`.',
		'Final reply: a short summary of what changed and how to run it.',
		opts.forceJson
			? 'This server expects JSON responses. Prefer native tool_calls when available; otherwise reply with ONLY JSON like {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":{"path":"...","content":"..."}}}]} — no markdown fences.'
			: '',
		opts.proseToolsOnly
			? 'This model has no native tools: reply with only JSON tool_calls in content (no markdown). Example: {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"retrieve","arguments":{"query":"..."}}}]}'
			: '',
		statusQuestion
			? 'This turn asks where the work stopped. Answer from PROJECT STATUS only. Do not explore the repo, run shell, or call git. The only tool is update_status, after the answer.'
			: '',
		planModeHint,
		agentMode
			? [
					`### Mode: ${agentMode.title}`,
					agentMode.description ?? '',
					agentMode.systemPrompt ?? '',
				]
					.filter(Boolean)
					.join('\n')
			: '',
		agentsMdSection,
		skillSection,
		mcpHint,
	]
		.filter(Boolean)
		.join('\n');

	const history = (opts.history ?? [])
		.filter(m => m.content?.trim())
		.slice(-16)
		.map(m => ({
			role: m.role as 'user' | 'assistant',
			content: clipData(m.content.trim(), 6000),
		}));

	let facts: StableFacts = emptyStableFacts();
	if (opts.sessionId && opts.sessionStore) {
		const session = opts.sessionStore.get(opts.sessionId);
		if (session?.stableFacts) {
			facts = normalizeFacts(session.stableFacts);
		}
	}
	if (opts.workspaceRoot) {
		facts = mergeStableFacts(facts, { projectRoots: [opts.workspaceRoot] });
	}

	const sm = new AgentStateMachine();
	sm.transition('planning');
	trace?.state?.('planning');
	if (opts.sessionId) {
		await getSessionWikiStore().ensure(opts.sessionId, opts.task);
		trace?.setSession?.(opts.sessionId);
	}

	const packet = await buildContextPacket({
		task: opts.task,
		facts,
		workspaceRoot: opts.workspaceRoot,
		includeRetrieve: depth === 0,
		sessionId: opts.sessionId ?? undefined,
		budget: { ...DEFAULT_BUDGET, total: getContextBudget(opts.numCtx) },
		historyText: history
			.slice(-6)
			.map(h => `${h.role}: ${String(h.content).slice(0, 500)}`)
			.join('\n'),
		rerankFn: depth === 0 ? makeRerankFn(opts) : undefined,
	});
	opts.onContextBadge?.(packet.badge);
	opts.onActivity?.({
		kind: 'context',
		label: `${packet.badge.indexed} indexed · ${packet.badge.inContext} in context`,
		detail: packet.markdown.slice(0, 400),
	});

	const system = `${systemBase}\n\n${packet.markdown}`;

	let messages: ChatMessage[] = [
		{ role: 'system', content: system },
		...history,
		{ role: 'user', content: buildUserContent(opts.task, opts.images) },
	];

	sm.transition('executing');
	trace?.state?.('executing');

	const actions: string[] = [];
	const recentFingerprints: string[] = [];
	const resultCache = new Map<string, string>();
	const readPathsSeen = new Set<string>();
	/** Highest end line already returned per path (1-based inclusive). */
	const readMaxEnd = new Map<string, number>();
	const readWindows = new Map<string, Array<{ start: number; end: number }>>();
	const buildReadLedger = () => formatReadLedger(readWindows);
	const listPathsSeen = new Set<string>();
	const retrieveQueriesSeen = new Set<string>();
	const warnedFingerprints = new Set<string>();
	/** Shell (and other) fingerprints that already failed once this run — block identical retry. */
	const failedFingerprints = new Map<string, number>();
	/** successfulWriteCount at the time a fingerprint last failed (a later write allows a retry). */
	const failedAtWriteCount = new Map<string, number>();
	let successfulWriteCount = 0;
	let consecutiveToolFails = 0;
	const touchedPaths = new Set<string>();
	/** Paths successfully written/edited this turn — used for the project handoff. */
	const writtenPaths = new Set<string>();
	let emptyFinishNudges = 0;
	let statusUpdated = false;
	let statusNudges = 0;
	let turnOutcome: StatusOutcome = 'done';
	let turnBlockedReason = '';
	let handoffDone = false;
	/** Extra retries when completion hits max_tokens (~8192) without a tool call. */
	let lengthTruncationNudges = 0;
	/** Retries when gateway rejects truncated tool-call JSON (common with large writes). */
	let truncatedToolRetries = 0;
	/** Retries when model dumps tool JSON in content but parse fails. */
	let proseToolParseRetries = 0;
	/** One-shot repair when Anthropic rejects orphan tool_use without tool_result. */
	let toolHistoryRepairedOnce = false;
	/** Soft-memory hits per path this run (UI only). */
	const softReadHits = new Map<string, number>();
	let phase: AgentPhase = 'implement';
	let lastPhase: AgentPhase | undefined;
	let activeToolNames = new Set(AGENT_TOOL_NAMES);
	/** Consecutive explore calls while the build is red (weak-profile gate). */
	let readsWhileRed = 0;
	/** Successful write/edit calls since the oracle last ran. */
	let writesSinceOracle = 0;
	/** Finish attempts refused because the oracle was red. */
	let oracleRejections = 0;
	const MAX_ORACLE_REJECTIONS = 6;
	let gateFinishRejections = 0;
	const MAX_GATE_FINISH_REJECTIONS = 2;
	const oracleCfg = opts.planMode ? undefined : detectOracle(opts.workspaceRoot, nodeOracleFs);
	let lastProgressMarker = '';
	const progressMarker = () =>
		`${successfulWriteCount}|${readPathsSeen.size}|${gates.buildRed ? 'red' : 'ok'}|${gates.lastBuildErrors.length}`;
	const runOracleNow = async (reason: string) => {
		opts.onStatus?.(`Oracle: ${reason}…`);
		const result = await runOracle(oracleCfg!, async command => {
			const r = await opts.bridge.execute({
				id: `oracle-${Date.now()}`,
				name: 'shell',
				arguments: { command },
				abortSignal: opts.abortSignal,
			});
			const out = r.success ? r.output : `exit 1\n${r.error ?? 'oracle command failed'}`;
			gates.onShellResult(command, exitCodeOf(out) === 0, out);
			return out;
		});
		if (!result.ok) {
			facts = mergeStableFacts(facts, {
				openErrors: result.errors.length
					? result.errors.slice(0, 15).map(e => `${e.file}${e.line ? `:${e.line}` : ''} ${e.code} ${e.msg}`)
					: result.failedTests.slice(0, 15).map(t => `test failed: ${t}`),
			});
		} else {
			facts = mergeStableFacts(facts, { openErrors: [] });
		}
		writesSinceOracle = 0;
		trace?.info('oracle', `${result.ok ? 'green' : 'red'} ${reason} ${result.commands.join(' → ')}`);
		opts.onActivity?.({
			kind: 'checkpoint',
			label: `Oracle ${result.ok ? 'verde' : 'vermelho'}`,
			detail: result.ok
				? result.commands.join(' → ')
				: [...result.errors.slice(0, 3).map(e => `${e.code} ${e.file}:${e.line}`), ...result.failedTests.slice(0, 3)].join(' | '),
		});
		return result;
	};

	// Remember what this session already explored (survives "continua") — soft memory, not bans.
	if (opts.sessionId && opts.sessionStore && !opts.isolated) {
		const prior = opts.sessionStore.get(opts.sessionId)?.toolTraces ?? [];
		const cap = toolResultCharCap(getContextBudget(opts.numCtx));
		for (const t of prior) {
			if (!t.success) continue;
			const p =
				typeof t.arguments?.path === 'string'
					? String(t.arguments.path)
							.replace(/\\/g, '/')
							.replace(/\/+/g, '/')
							.toLowerCase()
					: '';
			if (MUTATING.has(t.name)) {
				// Later writes make earlier reads/lists stale.
				const changed = [p, String(t.arguments?.oldPath ?? ''), String(t.arguments?.newPath ?? '')]
					.map(x => canonicalizePathKey(x))
					.filter(Boolean);
				invalidatePaths(resultCache, readPathsSeen, readMaxEnd, changed.flatMap(readAliasesFor));
				for (const k of [...resultCache.keys()]) if (k.startsWith('list:')) resultCache.delete(k);
				listPathsSeen.clear();
				continue;
			}
			if (t.name === 'list' && p) {
				listPathsSeen.add(p);
				if (t.output) {
					resultCache.set(`list:${p}`, t.output.slice(0, cap));
				}
			}
			if (t.name === 'read' && p) {
				readPathsSeen.add(p);
				const start = Math.max(1, Number(t.arguments.startLine ?? t.arguments.offset ?? 1) || 1);
				const limit = Math.max(1, Number(t.arguments.limit ?? 120) || 120);
				const parsed = parseReadCoverage(t.output ?? '');
				const end = parsed?.end ?? start + limit - 1;
				readMaxEnd.set(p, Math.max(readMaxEnd.get(p) ?? 0, end));
				if (parsed?.total) {
					// Whole file already seen — treat as fully covered so re-reads soft-hit.
					if (parsed.end >= parsed.total) {
						readMaxEnd.set(p, Math.max(readMaxEnd.get(p) ?? 0, parsed.total));
					}
				}
				resultCache.set(`readwin:${p}@${start}@${limit}`, (t.output ?? '').slice(0, cap));
			}
			if (t.name === 'retrieve' || t.name === 'search') {
				const q = String(t.arguments.query ?? t.arguments.pattern ?? '')
					.trim()
					.toLowerCase();
				if (q) {
					retrieveQueriesSeen.add(`${t.name}:${q}`);
				}
			}
		}
	}

	if (readPathsSeen.size || listPathsSeen.size) {
		const mem = [
			'Paths opened earlier in this chat:',
			listPathsSeen.size ? `Folders: ${[...listPathsSeen].join(', ')}` : '',
			readPathsSeen.size
				? `Files: ${[...readPathsSeen]
						.map(p => {
							const end = readMaxEnd.get(p);
							return end ? `${p} (L1-${end})` : p;
						})
						.join(', ')}`
				: '',
		]
			.filter(Boolean)
			.join('\n');
		messages[0] = {
			role: 'system',
			content: `${system}\n\n${mem}`,
		};
	}

	// Cursor-style: light continuity — path index + few recent tool bodies (not the whole tour).
	const priorSession =
		opts.sessionId && opts.sessionStore && !opts.isolated ? opts.sessionStore.get(opts.sessionId) : undefined;
	const priorTraces = priorSession?.toolTraces ?? [];
	const priorTranscript = buildPriorAgentTranscript(
		priorTraces,
		priorTranscriptCharBudget(getContextBudget(opts.numCtx)),
		getContextBudget(opts.numCtx),
		priorSession?.rollingSummary
	);
	if (priorTranscript) {
		const sys = messages[0];
		const rest = messages.slice(1);
		const head = rest.slice(0, -1);
		const latestUser = rest[rest.length - 1];
		messages = [
			sys,
			...head,
			{
				role: 'user',
				content: priorTranscript,
			},
			{
				role: 'assistant',
				content:
					'Understood — I have the earlier paths and recent tool results.',
			},
			latestUser,
		];
		opts.onActivity?.({
			kind: 'context',
			label: 'Prior context (Cursor-style)',
			detail: `${priorTraces.length} traces → light index + recent bodies`,
		});
	}

	/** Git availability for this run (IDE probe). */
	let gitAvailable = true;
	try {
		await git.gitStatus();
	} catch {
		gitAvailable = false;
	}
	let systemBaseWithPacket =
		typeof messages[0]?.content === 'string' ? messages[0].content : system;
	const contextBudget = getContextBudget(opts.numCtx);
	const toolCap = toolResultCharCap(contextBudget);
	const compactEvery = compactEveryNSteps(contextBudget);
	const softCompactAt = softCompactTokenThreshold(contextBudget);
	const midCompactAt = midCompactTokenThreshold(contextBudget);
	const compactAt = compactTokenThreshold(contextBudget);
	const packetEvery = Math.max(4, Math.floor(compactEvery / 2));
	opts.onActivity?.({
		kind: 'context',
		label: `contextBudget ${contextBudget}`,
		detail: `num_ctx=${contextBudget}; soft@${softCompactAt} mid@${midCompactAt} hard@${compactAt}; packet every ${packetEvery}; tool cap ${toolCap}; priorTx ${priorTranscriptCharBudget(contextBudget)}`,
	});

	// Ensure Agent Terminal is visible even before the first shell call
	try {
		await opts.bridge.prepareAgentTerminal?.();
	} catch {
		/* best-effort */
	}
	const reviewLog: string[] = [];
	let compactedOnce = false;
	let historyNukeOnce = false;
	let tokenCalibration = 1;
	let lastRealPromptTokens = 0;
	let contextOverflowRetries = 0;
	const taskId = opts.sessionId ?? `task-${Date.now()}`;
	const started = Date.now();
	const completionCap = completionMaxTokens(contextBudget);
	opts.onTaskUpdate?.({
		id: taskId,
		name: truncateHistory(opts.task, 60),
		status: 'running',
		model: opts.model,
		elapsed: 0,
	});

	const recordHandoff = async (): Promise<void> => {
		if (handoffDone) return;
		handoffDone = true;
		try {
			const rolling =
				opts.sessionId && opts.sessionStore
					? opts.sessionStore.get(opts.sessionId)?.rollingSummary
					: undefined;
			const [repo, refs] = await Promise.all([
				gatherRepoSnapshotForHandoff(opts.workspaceRoot),
				discoverStatusRefs(opts.workspaceRoot),
			]);
			const modelFiles = statusUpdated ? [...writtenPaths] : [];
			await finishTurn({
				workspaceRoot: opts.workspaceRoot,
				isolated: opts.isolated,
				depth,
				task: opts.task,
				modelUpdated: statusUpdated,
				actionsSummary: summarizeActionsForLlm(actions),
				reviewLog: reviewLog.length ? reviewLog[reviewLog.length - 1] : undefined,
				files: uniqHandoffPaths([...writtenPaths, ...modelFiles]),
				openErrors: facts.openErrors,
				outcome: turnOutcome,
				blockedReason: turnBlockedReason,
				repo: repo ?? undefined,
				refs,
				rollingSummary: rolling,
			});
		} catch {
			/* handoff is best-effort */
		}
	};

	try {
		for (let step = 0; step < stepBudget; step++) {
			if (opts.cancelled() || opts.abortSignal?.aborted) {
				opts.onTaskUpdate?.({
					id: taskId,
					name: truncateHistory(opts.task, 60),
					status: 'cancelled',
					result: 'Cancelled',
					elapsed: Date.now() - started,
				});
				turnOutcome = 'cancelled';
				return 'Cancelled.';
			}

			const tokEst = Math.max(
				calibratedTokens(estimateTokens(messages), tokenCalibration),
				lastRealPromptTokens
			);

			// Refresh context packet periodically so IDE/retrieve stay current.
			if (step > 0 && step % packetEvery === 0 && depth === 0) {
				try {
					const fresh = await buildContextPacket({
						task: opts.task,
						facts,
						workspaceRoot: opts.workspaceRoot,
						includeRetrieve: true,
						retrieveK: 4,
						sessionId: opts.sessionId ?? undefined,
						budget: {
							total: contextBudget,
							alloc: {
								system: 0.1,
								status: 0.05,
								wiki_session: 0.08,
								wiki_project: 0.08,
								facts: 0.06,
								lessons: 0.07,
								ide: 0.12,
								retrieve: 0.14,
								git: 0.04,
								mcp: 0.03,
								history: 0.17,
							},
						},
						boostPaths: [...touchedPaths],
						rerankFn: makeRerankFn(opts),
						historyText: [
							...history.slice(-3).map(h => `${h.role}: ${String(h.content).slice(0, 350)}`),
							...messages
								.filter(m => m.role === 'user' || m.role === 'assistant')
								.slice(-4)
								.map(m => {
									const text =
										typeof m.content === 'string'
											? m.content
											: Array.isArray(m.content)
												? m.content.map(p => ('text' in p ? p.text : '')).join(' ')
												: '';
									return `${m.role}: ${text.slice(0, 350)}`;
								}),
						]
							.filter(Boolean)
							.join('\n')
							.slice(0, 6000),
					});
					systemBaseWithPacket = `${systemBase}\n\n${fresh.markdown}`;
					if (messages[0]?.role === 'system') {
						messages[0] = { role: 'system', content: systemBaseWithPacket };
					}
					opts.onContextBadge?.(fresh.badge);
					opts.onActivity?.({
						kind: 'context',
						label: `context refresh @${step + 1}`,
						detail: `${fresh.badge.inContext} in context`,
					});
				} catch {
					/* best-effort */
				}
			}

			// Compact only when the window is actually filling up.
			// Do NOT hard-compact on a step timer — that wastes a 32k context (Cursor fills the window).
			if (tokEst > compactAt) {
				sm.transition('compacting');
				opts.onActivity?.({
					kind: 'compact',
					label: `Hard compact (budget ${contextBudget})…`,
				});
				messages = await compactWithLlm(
					opts,
					systemBase,
					messages,
					actions,
					history,
					facts,
					gates.compactStickyExtra(),
					buildReadLedger()
				);
				if (messages[0]?.role === 'system') {
					const sys = messages[0].content;
					systemBaseWithPacket =
						typeof sys === 'string' && sys ? sys : systemBaseWithPacket;
				}
				sm.transition('executing');
			} else if (tokEst > midCompactAt) {
				sm.transition('compacting');
				opts.onActivity?.({ kind: 'compact', label: 'Mid compact (summarize old turns)…' });
				messages = midCompactMessages(
					messages as Parameters<typeof midCompactMessages>[0],
					systemBaseWithPacket,
					{ readLedger: buildReadLedger() }
				) as ChatMessage[];
				sm.transition('executing');
			} else if (
				tokEst > softCompactAt ||
				(step > 0 && step % compactEvery === 0 && tokEst > Math.floor(softCompactAt * 0.85))
			) {
				sm.transition('compacting');
				opts.onActivity?.({ kind: 'compact', label: 'Soft compact (trim old tool results)…' });
				messages = softCompactToolResults(
					messages as Parameters<typeof softCompactToolResults>[0],
					Math.floor(toolCap * 0.55)
				) as ChatMessage[];
				sm.transition('executing');
			}

			opts.onStatus?.(
				`Thinking… (step ${step + 1}/${stepBudget}${adaptive ? `, cap ${hardCap}` : ''})`
			);
			opts.onActivity?.({
				kind: 'thinking',
				label: `Thinking… step ${step + 1}/${stepBudget}`,
			});
			opts.onTaskUpdate?.({
				id: taskId,
				name: truncateHistory(opts.task, 60),
				status: 'running',
				model: opts.model,
				elapsed: Date.now() - started,
				subtasks: actions.slice(-8).map((a, i) => ({
					id: `${taskId}-a${i}`,
					name: a,
					status: 'completed' as const,
				})),
			});

			if (opts.cancelled() || opts.abortSignal?.aborted) {
				opts.onTaskUpdate?.({
					id: taskId,
					name: truncateHistory(opts.task, 60),
					status: 'cancelled',
					result: 'Cancelled',
					elapsed: Date.now() - started,
				});
				turnOutcome = 'cancelled';
				return 'Cancelled.';
			}

			const llmStart = Date.now();
			normalizeToolProtocolHistory(messages as Parameters<typeof normalizeToolProtocolHistory>[0]);
			const sentTokenEstimate = estimateTokens(messages);
			phase = opts.basePhase
				? opts.basePhase === 'implement' && gates.buildRed
					? 'fix'
					: opts.basePhase
				: currentPhase(opts.task, { buildRed: gates.buildRed });
			activeToolNames = toolNamesFor(phase, opts.task, {
				weakProfile,
				allNames: allAgentToolNames(agentMode).filter(n => !opts.planMode || PLAN_MODE_TOOLS.has(n) || !AGENT_TOOL_NAMES.has(n)),
			});
			if (phase !== lastPhase) {
				opts.onActivity?.({ kind: 'context', label: `Phase: ${phase}`, detail: [...activeToolNames].join(', ') });
				lastPhase = phase;
			}
			const round = await postAgentRound(
				opts,
				url,
				sanitizeMessages(messages),
				completionCap,
				toolsForRound(activeToolNames, agentMode)
			);
			if (!round.ok) {
				const errText = round.errorText;
				trace?.error('LLM error', `${round.status}: ${errText.slice(0, 300)}`);
				opts.onActivity?.({
					kind: 'checkpoint',
					label: `LLM error ${round.status || ''}`.trim(),
					detail: errText.slice(0, 400),
				});
				// Window overflow: shrink locally (a summarizing LLM call could overflow too) and retry.
				if (isContextOverflowError(round.status, errText) && contextOverflowRetries < 2) {
					contextOverflowRetries += 1;
					const over = parseOverflowTokens(errText);
					tokenCalibration = updateTokenCalibration(
						tokenCalibration,
						sentTokenEstimate,
						over.prompt
					);
					const aggressive = contextOverflowRetries > 1;
					messages = midCompactMessages(
						softCompactToolResults(
							messages as Parameters<typeof softCompactToolResults>[0],
							aggressive ? 700 : Math.floor(toolCap * 0.35),
							aggressive ? 0 : 3,
							aggressive ? 900 : 1800
						),
						systemBaseWithPacket,
						{ readLedger: buildReadLedger() }
					) as ChatMessage[];
					normalizeToolProtocolHistory(
						messages as Parameters<typeof normalizeToolProtocolHistory>[0]
					);
					opts.onStatus?.(
						`Context full${over.prompt && over.ctx ? ` (${over.prompt}/${over.ctx})` : ''} — compacting and retrying…`
					);
					opts.onActivity?.({
						kind: 'compact',
						label: `Context overflow — compact + retry ${contextOverflowRetries}/2`,
						detail: errText.slice(0, 200),
					});
					step -= 1;
					continue;
				}
				if (round.status === 408 || /timeout|timed out|cancelled/i.test(errText)) {
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'LLM timeout (408)',
						detail: errText.slice(0, 240),
					});
				}
				// All providers: orphan tool_calls / broken tool turns → normalize and retry once.
				if (isBrokenToolHistoryError(round.status, errText) && !toolHistoryRepairedOnce) {
					toolHistoryRepairedOnce = true;
					const n = normalizeToolProtocolHistory(
						messages as Parameters<typeof normalizeToolProtocolHistory>[0]
					);
					opts.onStatus?.(
						n
							? `Tool history repaired (${n}) — retrying…`
							: 'Invalid tool history — retrying…'
					);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Repaired tool history',
						detail: errText.slice(0, 200),
					});
					step -= 1;
					continue;
				}
				// Models like CodeGemma reject native tools — switch the whole loop to prose JSON tools.
				// Never for native Anthropic or for broken tool-history protocol errors.
				if (
					!opts.proseToolsOnly &&
					!isNativeAnthropic(opts) &&
					!isBrokenToolHistoryError(round.status, errText) &&
					(round.status === 400 || round.status === 404) &&
					/tool/i.test(errText)
				) {
					opts.proseToolsOnly = true;
					messages.push({
						role: 'user',
						content: [
							'The API rejected native tools for this model. From now on, call tools with JSON in the message content (no markdown fences):',
							'{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"retrieve","arguments":{"query":"relevant files"}}}]}',
						].join('\n'),
					});
					opts.onStatus?.(
						`Model has no native tools (${opts.model}) — continuing in JSON mode…`
					);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Switched to prose tool mode',
						detail: `${opts.model}: ${errText.slice(0, 180)}`,
					});
					step -= 1;
					continue;
				}
				if (isTruncatedToolCallError(round.status, errText) && truncatedToolRetries < 3) {
					truncatedToolRetries += 1;
					messages.push({
						role: 'user',
						content: [
							'The gateway rejected your last tool call: its JSON arguments were incomplete (usually a long write.content cut off).',
							'Repeat it smaller: change an existing file with edit, or write a new file in parts.',
						].join('\n'),
					});
					opts.onStatus?.('Truncated tool JSON — asking for a smaller write…');
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Retry: truncated tool JSON',
						detail: errText.slice(0, 200),
					});
					step -= 1;
					continue;
				}
				if (isBrokenToolHistoryError(round.status, errText) && !compactedOnce) {
					compactedOnce = true;
					messages = await compactWithLlm(
						opts,
						systemBase,
						messages,
						actions,
						history,
						facts,
						gates.compactStickyExtra(),
						buildReadLedger()
					);
					normalizeToolProtocolHistory(
						messages as Parameters<typeof normalizeToolProtocolHistory>[0]
					);
					opts.onStatus?.('Gateway lost context — retrying with compacted history…');
					step -= 1;
					continue;
				}
				if (isBrokenToolHistoryError(round.status, errText) && !historyNukeOnce) {
					historyNukeOnce = true;
					const digest = [
						`Task: ${opts.task}`,
						summarizeActionsForLlm(actions),
						reviewLog.length ? `Last checkpoint: ${reviewLog[reviewLog.length - 1]}` : '',
						'The earlier tool transcript was invalid and was reset; the progress above is what happened so far. Files may be read again as needed.',
					]
						.filter(Boolean)
						.join('\n');
					messages = [
						{ role: 'system', content: systemBaseWithPacket },
						{ role: 'user', content: digest },
					];
					opts.onStatus?.('Invalid history — minimal reset, retrying…');
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Nuked broken tool history',
						detail: errText.slice(0, 200),
					});
					step -= 1;
					continue;
				}
				if (isBrokenToolHistoryError(round.status, errText)) {
					if (isNativeAnthropic(opts)) {
						throw new Error(`LLM error ${round.status}: ${errText}`);
					}
					return runProseToolFallback(opts, messages, actions);
				}
				throw new Error(`LLM error ${round.status}: ${errText}`);
			}
			truncatedToolRetries = 0;
			toolHistoryRepairedOnce = false;
			contextOverflowRetries = 0;

			const data = round.data;
			tokenCalibration = updateTokenCalibration(
				tokenCalibration,
				sentTokenEstimate,
				data.usage?.prompt_tokens ?? data.usage?.input_tokens
			);
			const realIn = Number(data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0) || 0;
			if (realIn > 0) {
				lastRealPromptTokens = realIn;
			}
			const usedTokens = lastRealPromptTokens || calibratedTokens(sentTokenEstimate, tokenCalibration);
			const limitTokens = opts.numCtx && opts.numCtx > 0 ? opts.numCtx : 0;
			if (limitTokens > 0 && usedTokens > 0) {
				opts.onContextUsage?.({ used: usedTokens, limit: limitTokens });
			}

			trace?.llm({
				label: `step ${step + 1}`,
				durationMs: Date.now() - llmStart,
				tokensIn: data.usage?.prompt_tokens ?? data.usage?.input_tokens,
				tokensOut: data.usage?.completion_tokens ?? data.usage?.output_tokens,
			});

			const msg = data.choices?.[0]?.message;
			if (!msg) {
				throw new Error('Empty LLM response');
			}
			const finishReason = String(
				data.choices?.[0]?.finish_reason ?? data.choices?.[0]?.stop_reason ?? ''
			).toLowerCase();
			const tokensOut =
				Number(data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0) || 0;

			let toolCalls = normalizeToolCalls(msg.tool_calls ?? []);
			// Some local models put text in alternate fields or return huge empty generations
			const alt = msg as Record<string, unknown>;
			let content = coerceMessageContent(msg.content);
			if (!content) {
				content = coerceMessageContent(alt.reasoning) || coerceMessageContent(alt.thinking);
			}
			content = content.trim();

			const thoughtRaw =
				(typeof alt.reasoning === 'string' && alt.reasoning) ||
				(typeof alt.thinking === 'string' && alt.thinking) ||
				'';
			if (thoughtRaw && thoughtRaw !== content) {
				opts.onActivity?.({
					kind: 'thought',
					label: 'Thought briefly',
					detail: String(thoughtRaw).slice(0, 1500),
				});
			} else if (content && toolCalls.length) {
				opts.onActivity?.({
					kind: 'thought',
					label: 'Thought briefly',
					detail: content.slice(0, 800),
				});
			}

			// Local models (Tabby/Qwen/Granite) often paste tool_calls as JSON in `content`
			// instead of native message.tool_calls — lift them into real tool calls.
			if (!toolCalls.length && content) {
				const parsed = parseProseToolCalls(content);
				if (parsed.length) {
					toolCalls = parsed;
					proseToolParseRetries = 0;
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Parsed tool_calls from text',
						detail: parsed.map(t => t.function.name).join(', '),
					});
				} else if (looksLikeToolJson(content) && proseToolParseRetries < 3) {
					proseToolParseRetries += 1;
					trace?.error('tool_json_parse_failed', content.slice(0, 400));
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Tool JSON parse failed — retrying',
						detail: content.slice(0, 200),
					});
					messages.push({
						role: 'assistant',
						content,
					});
					messages.push({
						role: 'user',
						content: [
							'Your previous message looked like a tool call but was not valid JSON (Windows backslashes need escaping as \\\\; relative paths avoid this).',
							'Use the native tool protocol, or reply with only valid JSON (no markdown fences):',
							'{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":{"path":"hello.txt","content":"Hello, World!"}}}]}',
						].join('\n'),
					});
					step -= 1;
					continue;
				}
			}

			// When tools came from prose JSON, don't keep the raw JSON as assistant chat content
			const assistantContent = toolCalls.length && looksLikeToolJson(content) ? '' : content;

			if (!toolCalls.length) {
				const trivial = isTrivialAssistantContent(content);
				const hitLengthCap =
					finishReason === 'length' ||
					tokensOut >= 7500 ||
					(content.length >= 12000 && !looksLikeToolJson(content));

				// Completion budget ran out mid-answer: a technical event, so say so and continue.
				if (hitLengthCap && lengthTruncationNudges < 5 && step + 1 <= stepBudget) {
					lengthTruncationNudges += 1;
					messages.push({ role: 'assistant', content: clipData(content || '(truncated)', 1500) });
					const note = LENGTH_CAP_NOTE;
					trace?.info('harness', String(note.length));
					messages.push({ role: 'user', content: note });
					opts.onStatus?.(`Truncated reply (max_tokens) — continuing (${lengthTruncationNudges}/5)…`);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Truncated completion — retry tools',
						detail: `finish_reason=${finishReason || '?'} tokensOut=${tokensOut}`,
					});
					step -= 1;
					continue;
				}

				// Empty turn before any work: one neutral reminder, then accept.
				if ((!content || trivial) && successfulWriteCount === 0 && emptyFinishNudges < 2 && step + 1 < stepBudget) {
					emptyFinishNudges += 1;
					const note = EMPTY_TURN_NOTE;
					trace?.info('harness', String(note.length));
					messages.push({ role: 'assistant', content: content || '(empty)' });
					messages.push({ role: 'user', content: note });
					continue;
				}

				const summary =
					content && !trivial
						? content
						: actions.length
							? `Stopped without a final reply from the model.\n${summarizeActionsForLlm(actions)}`
							: '(no response)';
				if (looksLikeToolJson(summary)) {
					return [
						'The model kept returning invalid tool JSON and ran out of retries.',
						'Disable "Require JSON responses" on this server, or ask again with a relative file path (e.g. hello.txt).',
						`Preview: ${summary.slice(0, 240)}`,
					].join('\n');
				}

				// Done is decided by the oracle: after changes, build/test must be green (or the model says blocked).
				const blocked = parseBlockedClaim(summary);
				const changedFiles = successfulWriteCount > 0;
				let doneNote = '';
				if (!blocked && changedFiles && !opts.planMode && oracleCfg && !gates.hasVerifiedGreen()) {
					const result = await runOracleNow('finish check');
					if (!result.ok && oracleRejections < MAX_ORACLE_REJECTIONS && step + 1 < stepBudget) {
						oracleRejections += 1;
						const note = oracleRejectNote(oracleNote(result, 'finish check'));
						trace?.info('harness', String(note.length));
						messages.push({ role: 'assistant', content: summary });
						messages.push({ role: 'user', content: note });
						opts.onStatus?.(`Oracle vermelho — a continuar (${oracleRejections}/${MAX_ORACLE_REJECTIONS})…`);
						continue;
					}
					if (!result.ok) {
						doneNote = finalReplyNote('still-red', result.commands[result.commands.length - 1]);
					}
				} else if (!blocked && changedFiles && !oracleCfg && claimsBuildOrTestGreen(summary) && !gates.hasVerifiedGreen()) {
					doneNote = finalReplyNote('unverified');
				}

				if (
					shouldRequireStatusUpdate({
						isolated: opts.isolated,
						alreadyUpdated: statusUpdated,
						nudges: statusNudges,
					}) &&
					step + 1 < stepBudget
				) {
					statusNudges += 1;
					trace?.info('harness', String(STATUS_UPDATE_NOTE.length));
					messages.push({ role: 'assistant', content: summary });
					messages.push({ role: 'user', content: STATUS_UPDATE_NOTE });
					opts.onStatus?.('A gravar o ponto de situação…');
					continue;
				}

				if (!blocked) {
					const finishDecision = await decideGates(
						enabledGates(getGateRegistry().list(), governance.getState().guardrails),
						extGateSession
					);
					if (finishDecision.action !== 'allow') {
						let accepted = false;
						if (finishDecision.action === 'require-approval') {
							const approval = await ApprovalDialog.show({
								tool: 'finish',
								arguments: {},
								risk: 'medium',
								reason: finishDecision.reason,
							});
							trace?.record({
								type: 'approval',
								label: 'finish',
								detail: approval.approved ? 'gate approved' : 'gate denied',
							});
							accepted = approval.approved;
						}
						if (!accepted) {
							if (
								gateFinishRejections < MAX_GATE_FINISH_REJECTIONS &&
								step + 1 < stepBudget
							) {
								gateFinishRejections += 1;
								const note = `Not finished: ${finishDecision.reason}`;
								trace?.info('harness', String(note.length));
								messages.push({ role: 'assistant', content: summary });
								messages.push({ role: 'user', content: note });
								opts.onStatus?.(
									`Guardrail held the finish (${gateFinishRejections}/${MAX_GATE_FINISH_REJECTIONS})…`
								);
								continue;
							}
							doneNote += `\n\nGuardrail: ${finishDecision.reason}`;
						}
					}
				}

				opts.onTaskUpdate?.({
					id: taskId,
					name: truncateHistory(opts.task, 60),
					status: blocked ? 'failed' : 'completed',
					result: summary.slice(0, 200),
					elapsed: Date.now() - started,
				});
				opts.onActivity?.({
					kind: 'checkpoint',
					label: blocked ? 'Blocked' : 'Turn summary',
					detail: blocked ?? summarizeActionsForLlm(actions).slice(0, 400),
				});
				turnOutcome = blocked ? 'blocked' : 'done';
				turnBlockedReason = blocked ?? '';
				return summary + doneNote;
			}

			messages.push({
				role: 'assistant',
				content: assistantContent || '',
				tool_calls: toolCalls,
			});
			lengthTruncationNudges = 0;
			emptyFinishNudges = 0;

			const exploreTools = new Set([
				'read',
				'list',
				'search',
				'retrieve',
				'symbols',
				'definition',
				'references',
			]);

			/** User nudges deferred until all tool_results for this turn are present (all providers). */
			const pendingNudges: string[] = [];

			for (const call of toolCalls) {
				if (opts.cancelled() || opts.abortSignal?.aborted) {
					ensureToolResultsForCalls(messages, toolCalls, 'Cancelled by user');
					turnOutcome = 'cancelled';
					return 'Cancelled.';
				}

				let args: Record<string, unknown> = {};
				try {
					args = parseToolArguments(call.function.arguments || '{}');
				} catch (parseErr) {
					const detail =
						parseErr instanceof Error ? parseErr.message : String(parseErr);
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name: call.function.name,
						content:
							`Invalid tool arguments JSON (${detail}). ` +
							`Call ${call.function.name} again with COMPLETE valid JSON. ` +
							`For write: keep content short and fully closed (no truncated strings).`,
					});
					actions.push(`${call.function.name} bad-args`);
					continue;
				}

				const name = call.function.name;
				const toolAdvice: string[] = [];
				const refuse = (content: string, label: string) => {
					trace?.info('harness', String(content.length));
					messages.push({ role: 'tool', tool_call_id: call.id, name, content });
					actions.push(`${name} blocked (${label})`);
				};

				if (name === 'write' && typeof args.content === 'string' && args.content.length > 14000) {
					refuse(
						'Not written: content is larger than one tool call can carry reliably (14k chars). Write the file in parts (write the first part, then add the rest with edit).',
						'too large'
					);
					continue;
				}

				if (statusQuestion && !activeToolNames.has(name)) {
					refuse(
						`Tool "${name}" is not available on a status question. Answer from PROJECT STATUS. The only tool is update_status.`,
						'status'
					);
					continue;
				}

				if (weakProfile && !activeToolNames.has(name) && AGENT_TOOL_NAMES.has(name)) {
					refuse(
						`Tool "${name}" is not available in the ${phase} phase. Available now: ${[...activeToolNames].join(', ')}.`,
						'phase'
					);
					continue;
				}

				// Weak profile: a full rewrite of a large existing file loses code; edit is the tool for that.
				if (weakProfile && name === 'write' && gates.cfg.blockMassRewrite && typeof args.path === 'string') {
					const existing = await opts.bridge.readRaw(String(args.path));
					const existingLines = existing?.split(/\r?\n/).length ?? 0;
					if (existing !== undefined && existingLines > LARGE_FILE_LINES && isPartialRewrite(existing, String(args.content ?? ''))) {
						refuse(
							`Not written: ${args.path} already has ${existingLines} lines and most of them would stay the same. Change the parts that differ with edit (old_string → new_string).`,
							'large rewrite'
						);
						continue;
					}
				}

				// Weak profile: with the build red, three reads are enough to locate the error; broad exploration waits.
				if (
					weakProfile &&
					gates.buildRed &&
					readsWhileRed >= 3 &&
					(name === 'list' || name === 'retrieve' || name === 'search' || (name === 'read' && !mentionsErrorFile(String(args.path ?? ''), gates.lastBuildErrors)))
				) {
					refuse(
						[
							'Not run: the build is red and three reads have happened since. Edit the files named in the errors, or run the build again.',
							'Open errors:',
							...gates.lastBuildErrors.slice(0, 8).map(e => `- ${e}`),
						].join('\n'),
						'red build'
					);
					continue;
				}

				if (name === 'list') {
					const listPath = String(args.path ?? '.')
						.replace(/\\/g, '/')
						.replace(/^\.\//, '')
						.trim();
					const isRoot = !listPath || listPath === '.' || listPath === '/';
					if (Boolean(args.recursive) && isRoot) {
						args.recursive = false;
						toolAdvice.push('(recursive listing of the workspace root is shallow — list a subfolder for more)');
					}
				}

				const fingerprint = toolFingerprint(name, args);
				const priorCount = recentFingerprints.filter(f => f === fingerprint).length;
				recentFingerprints.push(fingerprint);
				if (recentFingerprints.length > 40) {
					recentFingerprints.shift();
				}

				const pathKey =
					typeof args.path === 'string'
						? canonicalizePathKey(args.path)
						: typeof args.oldPath === 'string'
							? canonicalizePathKey(String(args.oldPath))
							: '';
				const cached = resultCache.get(fingerprint);
				const isReadonly = READONLY_TOOLS.has(name);
				const priorFails = failedFingerprints.get(fingerprint) ?? 0;

				if (name === 'list' && pathKey && listPathsSeen.has(pathKey) && resultCache.has(`list:${pathKey}`)) {
					const prior = resultCache.get(`list:${pathKey}`) ?? '';
					const content = `(already in context — earlier listing of ${args.path})\n${clipData(prior, toolCap)}`;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content,
					});
					actions.push(`list ${args.path} cached`.trim());
					opts.onActivity?.({
						kind: 'tool',
						label: `list cached ${args.path}`,
						tool: name,
						toolCallId: call.id,
						toolStatus: 'ok',
						success: true,
						detail: content.slice(0, 200),
					});
					continue;
				}

				// Same path + covered window: return remembered content; new startLine past coverage still runs.
				const readStart = Math.max(
					1,
					Number(args.startLine ?? args.offset ?? 1) || 1
				);
				const readLimit = Math.max(1, Math.min(400, Number(args.limit ?? 120) || 120));
				const readAliases = readAliasesFor(pathKey);
				const coveredEnd = Math.max(
					0,
					...readAliases.map(k => readMaxEnd.get(k) ?? 0)
				);
				const alreadyRead = readAliases.some(k => readPathsSeen.has(k));
				const readWindowKey =
					name === 'read' && pathKey ? `${pathKey}@${readStart}@${readLimit}` : '';
				const cachedWindow =
					name === 'read' && pathKey && alreadyRead
						? rememberedReadWindow(resultCache, readAliases, readStart, readLimit)
						: undefined;
				if (name === 'read' && cachedWindow !== undefined && readStart <= coveredEnd) {
					const hits = (softReadHits.get(pathKey) ?? 0) + 1;
					softReadHits.set(pathKey, hits);
					const content = `(already in context up to L${coveredEnd})\n${clipData(cachedWindow, toolCap)}`;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content,
					});
					actions.push(`read ${args.path} cached`.trim());
					opts.onActivity?.({
						kind: 'tool',
						label: `read cached ${args.path}`,
						tool: name,
						toolCallId: call.id,
						toolStatus: 'ok',
						success: true,
						detail: content.slice(0, 200),
					});
					continue;
				}

				// Identical failed command: not re-run (same input, same failure) unless files changed since.
				if (
					priorFails >= 1 &&
					(name === 'shell' || name === 'dotnet') &&
					failedAtWriteCount.get(fingerprint) === successfulWriteCount
				) {
					const refusal = [
						'Not run: this exact command already failed in this run and no file changed since.',
						'Change the command, or fix the files named in its output first.',
					].join('\n');
					messages.push({ role: 'tool', tool_call_id: call.id, name, content: refusal });
					actions.push(`${name} advised (failed-repeat)`);
					consecutiveToolFails += 1;
					continue;
				}

				if (cached && priorCount >= 1 && isReadonly) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: `(already in context — same ${name} result for the same arguments)\n${clipToolOutput(name, cached, toolCap)}`,
					});
					if (!warnedFingerprints.has(fingerprint)) {
						warnedFingerprints.add(fingerprint);
						actions.push(`${name} cached`);
					}
					continue;
				}

				const extDef = getToolRegistry().get(name);
				if (extDef && !AGENT_TOOL_NAMES.has(name) && !toolVisibleInMode(extDef, agentMode)) {
					refuse(
						`Tool "${name}" is not available in mode ${agentMode?.title ?? 'this mode'}.`,
						'mode'
					);
					continue;
				}

				const gateDecision = await decideGates(
					enabledGates(getGateRegistry().list(), governance.getState().guardrails),
					extGateSession,
					{ name, args, risk: riskForAgentTool(name) }
				);
				if (gateDecision.action === 'block') {
					refuse(gateDecision.reason || `Blocked by guardrail: ${name}`, 'gate');
					continue;
				}
				let gateApproved = false;
				if (gateDecision.action === 'require-approval') {
					const approval = await ApprovalDialog.show({
						tool: name,
						arguments: summarizeArgs(name, args),
						risk: approvalLevelForRisk(riskForAgentTool(name)),
						reason: gateDecision.reason,
					});
					trace?.record({
						type: 'approval',
						label: name,
						detail: approval.approved ? 'gate approved' : 'gate denied',
					});
					if (!approval.approved) {
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							name,
							content: `Denied by user: ${name}`,
						});
						actions.push(`${name} denied (gate)`);
						continue;
					}
					gateApproved = true;
				}

				opts.onActivity?.({
					kind: 'tool',
					label: formatToolActivityLabel(name, args),
					tool: name,
					toolCallId: call.id,
					toolStatus: 'running',
					detail: JSON.stringify(summarizeArgs(name, args)).slice(0, 200),
				});

				if (MUTATING.has(name) && !gateApproved) {
					if (opts.sessionId && opts.sessionStore) {
						await opts.sessionStore.createCheckpoint(
							opts.sessionId,
							`approval:${name}`,
							{ name, arguments: args },
							{ pause: false }
						);
					}
					const approval = await ApprovalDialog.show({
						tool: name,
						arguments: summarizeArgs(name, args),
						risk: name === 'shell' || name === 'delete' ? 'high' : 'medium',
						reason: describeMutation(name, args),
					});
					trace?.record({
						type: 'approval',
						label: name,
						detail: approval.approved ? 'approved' : 'denied',
					});
					if (!approval.approved) {
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							name,
							content: `Denied by user: ${name}`,
						});
						actions.push(`${name} denied`);
						continue;
					}
				}

				if (opts.cancelled() || opts.abortSignal?.aborted) {
					ensureToolResultsForCalls(messages, toolCalls, 'Cancelled by user');
					turnOutcome = 'cancelled';
					return 'Cancelled.';
				}

				const guardAdvice = gates.adviceFor(name, args);
				if (guardAdvice) {
					toolAdvice.push(guardAdvice);
				}

				if (opts.planMode && !PLAN_MODE_TOOLS.has(name)) {
					const planBlock = opts.isolated
						? `Not run: "${name}" is not available in this run (exploration tools only).`
						: `Not run: "${name}" is not available in Plan mode (explore and wiki tools only; the plan goes to wiki_write id=task-plan).`;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: planBlock,
					});
					actions.push(`${name} blocked (plan mode)`);
					continue;
				}

				if (name === 'write' || name === 'delete' || name === 'rename') {
					gates.markMutatingWriteAllowed();
				}

				const hookPre = await runAgentHooks(
					'preToolUse',
					{ tool: name, args, workspaceRoot: opts.workspaceRoot },
					line => opts.onActivity?.({ kind: 'checkpoint', label: 'hook', detail: line })
				);
				if (hookPre.permission === 'deny') {
					const msg = hookPre.userMessage || `Blocked by preToolUse hook: ${name}`;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: msg,
					});
					actions.push(`${name} blocked (hook)`);
					continue;
				}
				if (name === 'shell') {
					const hookShell = await runAgentHooks(
						'beforeShellExecution',
						{
							tool: name,
							args,
							command: String(args.command ?? ''),
							workspaceRoot: opts.workspaceRoot,
						},
						line => opts.onActivity?.({ kind: 'checkpoint', label: 'hook', detail: line })
					);
					if (hookShell.permission === 'deny') {
						const msg =
							hookShell.userMessage ||
							`Blocked by beforeShellExecution hook: ${String(args.command ?? '')}`;
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							name,
							content: msg,
						});
						actions.push('shell blocked (hook)');
						continue;
					}
				}

				if (name === 'write' || name === 'edit') {
					const policy = getApprovalPolicy();
					const previewEdits =
						vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('previewEdits') ===
						true;
					// Cursor-like: if edits are auto-approved (or user already accepted), skip DiffPreview
					// unless previewEdits is explicitly enabled.
					let previewArgs: Record<string, unknown> | undefined = args;
					if (name === 'edit') {
						const current = await opts.bridge.readRaw(String(args.path ?? ''));
						const applied =
							current === undefined
								? undefined
								: applyEdit(current, String(args.old_string ?? ''), String(args.new_string ?? ''), args.replace_all === true);
						previewArgs = applied?.ok ? { path: args.path, content: applied.text } : undefined;
					}
					if (previewArgs && previewEdits && !policy.isAutoApproved('write')) {
						const ok = await maybeShowWriteDiff(opts.bridge, previewArgs);
						if (!ok) {
							messages.push({
								role: 'tool',
								tool_call_id: call.id,
								name,
								content: 'Write rejected in diff preview',
							});
							actions.push('write rejected (diff)');
							continue;
						}
					}
				}

				const toolStart = Date.now();
				let output: string;
				let durationMs: number;
				let success: boolean;
				try {
					output = await executeTool(opts, name, args, call.id, depth, { gitAvailable });
					durationMs = Date.now() - toolStart;
					success = isToolSuccess(name, output);
				} catch (toolErr) {
					durationMs = Date.now() - toolStart;
					success = false;
					output =
						`Tool "${name}" threw: ` +
						(toolErr instanceof Error ? toolErr.message : String(toolErr));
					failedFingerprints.set(fingerprint, priorFails + 1);
					consecutiveToolFails += 1;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: output.slice(0, toolCap),
					});
					actions.push(`${name} threw`);
					opts.onActivity?.({
						kind: 'tool',
						label: `${name} failed`,
						tool: name,
						toolCallId: call.id,
						toolStatus: 'failed',
						success: false,
						detail: output.slice(0, 300),
					});
					trace?.tool({ name, durationMs, success: false, detail: output.slice(0, 120) });
					continue;
				}
				if (success) {
					resultCache.set(fingerprint, output);
					consecutiveToolFails = 0;
					if (pathKey) {
						touchedPaths.add(pathKey);
					}
				} else {
					failedFingerprints.set(fingerprint, priorFails + 1);
					failedAtWriteCount.set(fingerprint, successfulWriteCount);
					consecutiveToolFails += 1;
				}

				const shellLike = name === 'shell' || name === 'dotnet';
				if (shellLike) {
					const cmdStr = name === 'dotnet' ? dotnetCommandLine(args) : String(args.command ?? '');
					const buildAdvice = gates.onShellResult(cmdStr, success, output);
					if (gates.buildRed && gates.lastBuildErrors.length) {
						facts = mergeStableFacts(facts, { openErrors: gates.lastBuildErrors });
						if (buildAdvice) {
							opts.onActivity?.({
								kind: 'checkpoint',
								label: 'Build-fix mode',
								detail: gates.lastBuildErrors.slice(0, 3).join(' | '),
							});
						}
					} else if (success && !gates.buildRed) {
						facts = mergeStableFacts(facts, { openErrors: [] });
					}
					if (!success && (name === 'shell' || name === 'dotnet')) {
						if (name === 'shell') {
							output = enrichShellFailure(cmdStr, output, opts.workspaceRoot);
						}
						try {
							const learned = await learnFromShellFailure(opts.workspaceRoot, cmdStr, output);
							if (learned) {
								output = `${output}\n\n${learned.adviceBlock}`;
								opts.onActivity?.({
									kind: 'checkpoint',
									label: 'Lesson learned',
									detail: learned.lesson.id,
								});
							}
						} catch {
							/* best-effort */
						}
					} else if (name === 'shell' && success) {
						const original = String(args.command ?? '');
						const stripped = stripUnixPipes(original);
						if (stripped.note) {
							try {
								const learned = await learnFromShellFailure(
									opts.workspaceRoot,
									original,
									stripped.note
								);
								if (learned) {
									output = `${output}\n\n${learned.adviceBlock}`;
									opts.onActivity?.({
										kind: 'checkpoint',
										label: 'Lesson learned',
										detail: learned.lesson.id,
									});
								}
							} catch {
								/* best-effort */
							}
						}
					}
				}
				if ((name === 'write' || name === 'edit') && success) {
					gates.onSuccessfulWrite(args.path);
					successfulWriteCount += 1;
					writesSinceOracle += 1;
					if (typeof args.path === 'string' && args.path.trim()) {
						writtenPaths.add(args.path.replace(/\\/g, '/'));
					}
				}
				if (name === 'delete' || name === 'rename') {
					if (success) successfulWriteCount += 1;
				}
				if (name === 'update_status' && success) {
					statusUpdated = true;
				}

				facts = extractFactsFromTool(
					facts,
					name,
					args,
					output,
					success,
					opts.workspaceRoot
				);

				if (toolAdvice.length) {
					const advice = toolAdvice.join('\n\n');
					trace?.info('harness', String(advice.length));
					output = `${output}\n\n${advice}`;
				}
				if (opts.sessionId && opts.sessionStore) {
					await opts.sessionStore.setStableFacts(opts.sessionId, facts);
					await getSessionWikiStore().pushTool(opts.sessionId, name);
				}

				const spilled = await getArtifactStore().maybeSpill(output, {
					maxChars: toolCap,
					name: `${name}-${Date.now()}.txt`,
					type: 'tool-output',
					sessionId: opts.sessionId ?? undefined,
				});
				output = spilled.text;

				opts.onActivity?.({
					kind: 'tool',
					label: formatToolActivityLabel(name, args),
					tool: name,
					toolCallId: call.id,
					toolStatus: success ? 'ok' : 'failed',
					success,
					detail: cleanToolDetailForUi(output).slice(0, 400),
				});

				trace?.tool({ name, durationMs, success, detail: output.slice(0, 120) });
				if (opts.sessionId && opts.sessionStore) {
					await opts.sessionStore.appendToolTrace(opts.sessionId, {
						id: call.id,
						name,
						arguments: summarizeArgs(name, args),
						output: output.slice(0, 8000),
						success,
						durationMs,
						turn: opts.turnIndex,
					});
					if (opts.sessionStore.get(opts.sessionId)?.state === 'paused') {
						await opts.sessionStore.updateState(opts.sessionId, 'running');
					}
				}

				actions.push(
					output.startsWith('FILE_NOT_FOUND:')
						? `${name} missing ${args.path ?? ''}`.trim()
						: success
							? `${name} ${args.path ?? args.oldPath ?? args.command ?? args.tool ?? args.task ?? args.query ?? ''}`.trim()
							: name === 'shell' &&
								  isShellNoiseFailure(String(args.command ?? ''), output)
								? 'shell failed (cmd-noise)'
								: `${name} failed`
				);

				if (name === 'read' && pathKey && success) {
					readPathsSeen.add(pathKey);
					readsWhileRed = gates.buildRed ? readsWhileRed + 1 : 0;
					const parsed = parseReadCoverage(output);
					const endLine = parsed?.end ?? readStart + readLimit - 1;
					const startLine = parsed?.start ?? readStart;
					readMaxEnd.set(pathKey, Math.max(readMaxEnd.get(pathKey) ?? 0, endLine));
					if (parsed?.total && parsed.end >= parsed.total) {
						readMaxEnd.set(pathKey, Math.max(readMaxEnd.get(pathKey) ?? 0, parsed.total));
					}
					const wins = readWindows.get(pathKey) ?? [];
					wins.push({ start: startLine, end: endLine });
					readWindows.set(pathKey, wins);
					if (readWindowKey) {
						resultCache.set(`readwin:${readWindowKey}`, output);
					}
				}
				if (name === 'list' && pathKey && success) {
					listPathsSeen.add(pathKey);
					resultCache.set(`list:${pathKey}`, output);
				}
				if (name !== 'read' && !exploreTools.has(name)) {
					readsWhileRed = 0;
				}

				if (
					success &&
					(name === 'write' || name === 'edit' || name === 'delete' || name === 'rename') &&
					pathKey
				) {
					const keys = new Set(readAliases.length ? readAliases : [pathKey]);
					if (name === 'rename' && typeof args.newPath === 'string') {
						keys.add(canonicalizePathKey(String(args.newPath)));
					}
					invalidatePaths(resultCache, readPathsSeen, readMaxEnd, keys);
					for (const k of keys) softReadHits.delete(k);
					// Directory listings may now be stale too.
					for (const cacheKey of [...resultCache.keys()]) {
						if (cacheKey.startsWith('list:')) resultCache.delete(cacheKey);
					}
					listPathsSeen.clear();
				}

				if (name === 'retrieve' && success) {
					output = annotateRetrieveWithReadMemory(output, readPathsSeen, readMaxEnd);
				}

				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					name,
					content: clipToolOutput(name, output, toolCap + 400),
				});
			}

			// Flush deferred nudges only after every tool_result for this assistant turn exists.
			for (const nudge of pendingNudges) {
				trace?.info('harness', String(nudge.length));
				messages.push({ role: 'user', content: nudge });
			}

			// Oracle after a batch of writes: the project's build/test speaks instead of advice text.
			if (
				oracleCfg &&
				!opts.planMode &&
				writesSinceOracle >= gates.cfg.maxWritesWithoutBuild &&
				gates.writesSinceBuild > 0
			) {
				const result = await runOracleNow(`automatic after ${writesSinceOracle} writes`);
				const note = oracleNote(result, `automatic after ${writesSinceOracle} writes`);
				trace?.info('harness', String(note.length));
				messages.push({ role: 'user', content: note });
				writesSinceOracle = 0;
			}

			// Step budget: extend silently while there is measurable progress (no LLM judge).
			const completedSteps = step + 1;
			if (adaptive && completedSteps === nextCheckpoint && completedSteps < hardCap) {
				const progress = progressMarker();
				if (progress !== lastProgressMarker) {
					lastProgressMarker = progress;
					const extended = Math.min(hardCap, nextCheckpoint + checkpointSize);
					stepBudget = extended;
					nextCheckpoint = extended;
					reviewLog.push(`[step ${completedSteps}] progress → budget ${extended}`);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: `Checkpoint @ step ${completedSteps}`,
						detail: `progress → budget ${extended}/${hardCap}`,
					});
				} else {
					reviewLog.push(`[step ${completedSteps}] no progress since last checkpoint`);
				}
			}
		}

		opts.onTaskUpdate?.({
			id: taskId,
			name: truncateHistory(opts.task, 60),
			status: 'failed',
			result: 'max steps',
			elapsed: Date.now() - started,
		});
		turnOutcome = 'max-steps';

		let finalSummary = '';
		try {
			opts.onStatus?.('Hard cap — asking for a final summary…');
			const base = (opts.baseUrl || defaultBase(opts.provider)).replace(/\/$/, '');
			const res = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
				},
				signal: opts.abortSignal,
				body: JSON.stringify({
					model: opts.model,
					temperature: 0.2,
					stream: false,
					max_tokens: 700,
					...llmContextOptions(getContextBudget(opts.numCtx)),
					...llmJsonOptions(opts.forceJson),
					messages: [
						{
							role: 'system',
							content:
								'Summarize agent progress in under 200 words. Cover what was done, what remains, and how to continue. Do not invent paths.',
						},
						{
							role: 'user',
							content: [
								`Task: ${opts.task}`,
								summarizeActionsForLlm(actions),
								reviewLog.length
									? `Last checkpoint: ${reviewLog[reviewLog.length - 1]}`
									: '',
							]
								.filter(Boolean)
								.join('\n'),
						},
					],
				}),
			});
			if (res.ok) {
				const data = await readChatCompletionResponse(res);
				finalSummary = data.choices?.[0]?.message?.content?.trim() ?? '';
			}
		} catch {
			finalSummary = '';
		}

		let statusFallback = '';
		if (statusQuestion) {
			const { loadProjectStatus, formatStatusForPrompt, emptyStatusPrompt } = await import('./projectStatus');
			const saved = await loadProjectStatus(opts.workspaceRoot);
			statusFallback = (saved ? formatStatusForPrompt(saved) : emptyStatusPrompt()) + '\n\n';
		}

		return (
			statusFallback +
			`Reached max tool steps (${stepBudget}/${hardCap}) without finishing tools.\n\n` +
			(finalSummary ? `${finalSummary}\n\n` : '') +
			`${summarizeActionsForLlm(actions)}\n` +
			(reviewLog.length ? `Last checkpoint: ${reviewLog[reviewLog.length - 1]}\n\n` : '') +
			`Tip: ask to continue, or break the task into smaller steps.`
		);
	} catch (err) {
		turnOutcome = 'error';
		const message = err instanceof Error ? err.message : String(err);
		opts.onTaskUpdate?.({
			id: taskId,
			name: truncateHistory(opts.task, 60),
			status: 'failed',
			result: message.slice(0, 200),
			elapsed: Date.now() - started,
		});
		throw err;
	} finally {
		await recordHandoff();
	}
}

async function executeTool(
	opts: AgentLoopOptions,
	name: string,
	args: Record<string, unknown>,
	callId: string,
	depth: number,
	caps?: { gitAvailable?: boolean }
): Promise<string> {
	try {
		if (name.startsWith('git_') && caps?.gitAvailable === false) {
			return 'Error: git is unavailable in this workspace (no repository, or git is not on PATH).';
		}
		switch (name) {
			case 'dotnet': {
				const built = buildDotnetCommand(args);
				if ('error' in built) return `Error: ${built.error}`;
				const result = await opts.bridge.execute({
					id: callId,
					name: 'shell',
					arguments: { command: built.command },
					abortSignal: opts.abortSignal,
				});
				return result.success ? `$ ${built.command}\n${result.output}` : `Error: ${result.error ?? 'failed'}`;
			}
			case 'diagnostics':
				return (
					await opts.bridge.execute({
						id: callId,
						name: 'diagnostics',
						arguments: args,
					})
				).output || 'No diagnostics';
			case 'symbols':
				if (args.query) {
					return await lsp.workspaceSymbols(String(args.query));
				}
				if (args.path) {
					return await lsp.documentSymbols(String(args.path));
				}
				return 'Provide path or query';
			case 'references':
				return await lsp.findReferences(
					String(args.path),
					Number(args.line ?? 1),
					Number(args.character ?? 0)
				);
			case 'definition':
				return await lsp.gotoDefinition(
					String(args.path),
					Number(args.line ?? 1),
					Number(args.character ?? 0)
				);
			case 'git_status':
			case 'git_diff':
			case 'git_log':
			case 'git_commit_msg':
			case 'git_blame':
			case 'git_conflicts': {
				try {
					if (name === 'git_status') return await git.gitStatus();
					if (name === 'git_diff') {
						return await git.gitDiff(args.path ? String(args.path) : undefined);
					}
					if (name === 'git_log') return await git.gitLog(Number(args.count ?? 10));
					if (name === 'git_commit_msg') return await git.suggestCommitMessage();
					if (name === 'git_blame') {
						return await git.gitBlame(
							String(args.path),
							args.startLine !== undefined ? Number(args.startLine) : undefined,
							args.endLine !== undefined ? Number(args.endLine) : undefined
						);
					}
					return await git.gitConflicts(args.path ? String(args.path) : undefined);
				} catch (err) {
					return `Error: git tool failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
			case 'wiki_read': {
				const wiki = getProjectWikiStore();
				const id = args.id ? String(args.id) : '';
				if (!id) {
					const list = wiki.listDocuments();
					return list.length
						? list.map(d => `- ${d.id}: ${d.title}`).join('\n')
						: 'No project wiki documents yet. Use wiki_write to create one.';
				}
				const doc = wiki.getDocument(id);
				if (doc) {
					return `# ${doc.title}\n\n${doc.content}`;
				}
				// Models often confuse wiki ids with docs/*.md filenames.
				if (/\.md$/i.test(id) || /^C\d+/i.test(id) || /CONVENCOES|convencoes/i.test(id)) {
					const candidates = [id, id.replace(/^docs\//i, ''), `docs/${id.replace(/^docs\//i, '')}`];
					for (const cand of candidates) {
						const result = await opts.bridge.execute({
							id: `${callId}-wiki-fallback`,
							name: 'read',
							arguments: { path: cand },
						});
						if (result.success && !String(result.output).startsWith('FILE_NOT_FOUND:')) {
							return [`("${id}" is a workspace file, not a wiki id — showing ${cand})`, result.output].join('\n');
						}
					}
				}
				const list = wiki.listDocuments().slice(0, 12);
				return [
					`Wiki document not found: ${id}`,
					list.length
						? `Known wiki ids: ${list.map(d => d.id).join(', ')}`
						: 'No wiki documents yet. For cards use read on docs/*.md.',
				].join('\n');
			}
		case 'wiki_write': {
				const { ensureProjectWiki } = await import('../memory/projectWiki');
				await ensureProjectWiki(opts.workspaceRoot);
				const wiki = getProjectWikiStore();
				const doc = await wiki.upsertDocument(
					String(args.id),
					String(args.title),
					String(args.content),
					args.category ? String(args.category) : 'general'
				);
				return `Saved wiki document ${doc.id} (${doc.title})`;
			}
			case 'wiki_search': {
				const hits = getProjectWikiStore().search(String(args.query ?? ''), 8);
				return hits.length
					? hits.map(d => `## ${d.id} — ${d.title}\n${d.summary || d.content.slice(0, 300)}`).join('\n\n')
					: 'No wiki matches.';
			}
			case 'wiki_fact': {
				const { ensureProjectWiki } = await import('../memory/projectWiki');
				await ensureProjectWiki(opts.workspaceRoot);
				const fact = await getProjectWikiStore().addFact(
					String(args.key),
					String(args.value),
					args.reason ? String(args.reason) : undefined
				);
				return `Fact recorded: ${fact.key} = ${fact.value} (${fact.id})`;
			}
			case 'wiki_facts': {
				const facts = getProjectWikiStore().currentFacts();
				return facts.length
					? facts.map(f => `- ${f.key}: ${f.value}`).join('\n')
					: 'No current facts.';
			}
			case 'update_status': {
				const files = Array.isArray(args.files) ? args.files.map(f => String(f)) : [];
				const saved = await saveProjectStatus(opts.workspaceRoot, {
					objective: String(args.objective ?? ''),
					stoppedAt: String(args.stoppedAt ?? ''),
					next: String(args.next ?? ''),
					blockers: args.blockers ? String(args.blockers) : '',
					files,
					outcome: 'done',
				});
				return `Project status saved (${saved.updatedAt}). Stopped at: ${saved.stoppedAt}`;
			}
			case 'browser_navigate':
				return await browser.browserNavigate(String(args.url));
			case 'browser_snapshot': {
				const snap = await browser.browserSnapshot();
				return `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.text}`;
			}
			case 'browser_click':
				return await browser.browserClick(String(args.selector));
			case 'browser_type':
				return await browser.browserType(String(args.selector), String(args.text));
			case 'browser_screenshot':
				return await browser.browserScreenshot(opts.sessionId ?? undefined);
			case 'retrieve': {
				const query = String(args.query ?? '');
				const k = Number(args.k ?? 6);
				await ensureWorkspaceIndex();
				const hits = await retrieveSnippets(query, Math.min(12, Math.max(1, k)), {
					rerank: true,
					rerankFn: makeRerankFn(opts),
				});
				opts.onActivity?.({
					kind: 'tool',
					label: `retrieve ${hits.length} snippets`,
					tool: 'retrieve',
					success: true,
				});
				return hits.length
					? formatRetrievedBlock(hits)
					: `No snippets for "${query}"`;
			}
			case 'delegate_task':
				if (depth >= 1) {
					return 'Error: max subagent depth reached';
				}
				{
					const exploreOn =
						vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('exploreSubagent') ===
						true;
					const wantExplore =
						exploreOn &&
						(/\bexplor/i.test(String(args.mode ?? '')) ||
							/\b(where is|across the repo|encontrar onde)\b/i.test(String(args.task ?? '')));
					return await runAgentWithTools({
						...opts,
						task: wantExplore
							? `${String(args.task)}\n\n(Explore mode: read-only. End with findings and path:startLine-endLine cites.)`
							: String(args.task),
						history: args.context
							? [{ role: 'user', content: String(args.context) }]
							: opts.history,
						depth: depth + 1,
						maxSteps: wantExplore ? 10 : 8,
						planMode: wantExplore ? true : opts.planMode,
						isolated: wantExplore ? true : opts.isolated,
						onTaskUpdate: opts.onTaskUpdate
							? update =>
									opts.onTaskUpdate?.({
										...update,
										id: `${opts.sessionId ?? 'task'}-sub-${update.id}`,
										name: `[sub] ${update.name}`,
									})
							: undefined,
						onStatus: text => opts.onStatus?.(`[subagent] ${text}`),
						onActivity: ev =>
							opts.onActivity?.({ ...ev, label: `[sub] ${ev.label}` }),
					}).then(r => `Subagent result:\n${r}`);
				}
			case 'mcp_call': {
				const mcp = getMcp();
				if (!mcp) {
					return 'Error: MCP not initialized';
				}
				const toolName = String(args.tool);
				const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
				return await mcp.callTool(toolName, toolArgs);
			}
			default: {
				const registry = getToolRegistry();
				const def = registry.get(name);
				if (def) {
					const result = await registry.execute(name, args, {
						workspaceRoot: opts.workspaceRoot,
						sessionId: opts.sessionId ?? undefined,
						signal: opts.abortSignal ?? new AbortController().signal,
						trace: {
							record: partial =>
								getTrace()?.record({
									type: (partial.type as 'info' | 'tool' | 'error' | 'approval' | 'compact' | 'llm' | 'state') || 'info',
									label: partial.label,
									detail: partial.detail,
									durationMs: partial.durationMs,
								}),
						},
						approve: async req => {
							const approval = await ApprovalDialog.show({
								tool: req.tool,
								arguments: summarizeArgs(req.tool, req.arguments),
								risk: req.risk,
								reason: req.reason,
							});
							return approval.approved;
						},
						progress: msg => opts.onActivity?.({ kind: 'checkpoint', label: name, detail: msg }),
						extras: { callId, depth, opts },
					});
					return result.isError ? `Error: ${result.content}` : result.content;
				}
				const result = await opts.bridge.execute({
					id: callId,
					name,
					arguments: args,
					abortSignal: opts.abortSignal,
				});
				return result.success ? result.output : `Error: ${result.error ?? 'failed'}`;
			}
		}
	} catch (err) {
		return `Error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function maybeShowWriteDiff(
	bridge: VSCodeAIBridge,
	args: Record<string, unknown>
): Promise<boolean> {
	const filePath = String(args.path ?? '');
	const newContent = String(args.content ?? '');
	if (!filePath) return true;

	const oldContent = await bridge.readRaw(filePath);

	if (oldContent === undefined) {
		return true; // create — no preview required
	}
	if (oldContent === newContent) {
		return true;
	}

	const preview = await DiffPreview.show([
		{
			path: filePath,
			type: 'modify',
			oldContent,
			newContent,
		},
	]);
	return preview.accepted.includes(filePath);
}

/** Soft/mid compact helpers live in ./toolHistory (pure, unit-tested). */

async function compactWithLlm(
	opts: AgentLoopOptions,
	system: string,
	previous: ChatMessage[],
	actions: string[],
	history: AgentHistoryMessage[],
	facts: StableFacts,
	stickyExtra = '',
	readLedger = ''
): Promise<ChatMessage[]> {
	const trace = getTrace();
	trace?.record({ type: 'compact', label: 'rolling summary' });
	opts.onActivity?.({ kind: 'compact', label: 'Building rolling summary…' });

	const recentTools = previous
		.filter(m => m.role === 'tool')
		.slice(-6)
		.map(m => `- ${(m.name ?? 'tool')}: ${clipToolOutput(m.name ?? '', contentToPlainText(m.content), 900)}`)
		.join('\n');

	let rolling = '';
	try {
		const base = (opts.baseUrl || defaultBase(opts.provider)).replace(/\/$/, '');
		const res = await fetch(`${base}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
			},
			signal: opts.abortSignal,
			body: JSON.stringify({
				model: opts.model,
				temperature: 0.1,
				stream: false,
				max_tokens: 1024,
				...llmContextOptions(getContextBudget(opts.numCtx)),
				...llmJsonOptions(opts.forceJson),
				messages: [
					{
						role: 'system',
						content:
							'Summarize the agent progress in under 300 words as narrative only. ' +
							'Preserve objective, decisions, changed files, errors, blockers. ' +
							'Mention only paths that appear in the input; canonical paths are provided separately.',
					},
					{
						role: 'user',
						content: [
							`Task: ${opts.task}`,
							formatStableFactsBlock(facts),
							summarizeActionsForLlm(actions),
							recentTools,
							readLedger ? `### FILES ALREADY READ\n${readLedger}` : '',
						]
							.filter(Boolean)
							.join('\n'),
					},
				],
			}),
		});
		if (res.ok) {
			const data = await readChatCompletionResponse(res);
			rolling = data.choices?.[0]?.message?.content?.trim() ?? '';
		}
	} catch (err) {
		if (opts.abortSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
			rolling = summarizeActionsForLlm(actions);
		} else {
			rolling = '';
		}
	}

	if (!rolling) {
		rolling = summarizeActionsForLlm(actions);
	}

	if (opts.sessionId && opts.sessionStore) {
		await opts.sessionStore.setRollingSummary(opts.sessionId, rolling);
		await opts.sessionStore.setStableFacts(opts.sessionId, facts);
	}

	const packet = await buildContextPacket({
		task: opts.task,
		facts,
		workspaceRoot: opts.workspaceRoot,
		includeRetrieve: true,
		retrieveK: 4,
		rerankFn: makeRerankFn(opts),
	});
	opts.onContextBadge?.(packet.badge);

	const prior =
		history.length > 0
			? `Earlier conversation:\n${history
					.slice(-6)
					.map(m => `${m.role}: ${clipData(m.content.trim(), 1200)}`)
					.join('\n')}`
			: '';

	return [
		{ role: 'system', content: `${system}\n\n${packet.markdown}` },
		{
			role: 'user',
			content: [
				prior,
				`Current task:\n${opts.task}`,
				``,
				'### Rolling summary + facts',
				'The conversation was compacted. STABLE FACTS (system message) hold the canonical paths and open errors.',
				rolling,
				readLedger ? `### FILES ALREADY READ\n${readLedger}` : '',
				recentTools ? `\nRecent tool results:\n${recentTools}` : '',
				stickyExtra,
			]
				.filter(Boolean)
				.join('\n'),
		},
	];
}

function makeRerankFn(opts: AgentLoopOptions): (prompt: string) => Promise<string> {
	return async (prompt: string) => {
		const base = (opts.baseUrl || defaultBase(opts.provider)).replace(/\/$/, '');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 4000);
		const onAbort = () => controller.abort();
		opts.abortSignal?.addEventListener('abort', onAbort);
		try {
			const res = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
				},
				signal: controller.signal,
				body: JSON.stringify({
					model: opts.model,
					temperature: 0,
					stream: false,
					max_tokens: 128,
					messages: [
						{
							role: 'system',
							content: 'You rank code snippets. Reply with JSON only.',
						},
						{ role: 'user', content: prompt },
					],
				}),
			});
			if (!res.ok) return '';
			const data = await readChatCompletionResponse(res);
			return data.choices?.[0]?.message?.content?.trim() ?? '';
		} finally {
			clearTimeout(timer);
			opts.abortSignal?.removeEventListener('abort', onAbort);
		}
	};
}

function isNativeAnthropic(opts: AgentLoopOptions): boolean {
	if (opts.provider !== 'anthropic') return false;
	const base = (opts.baseUrl || '').toLowerCase();
	// OpenAI-compatible Anthropic proxies keep /v1/chat/completions
	if (base.includes('openrouter') || base.includes('/openai') || base.includes('compatible')) {
		return false;
	}
	return true;
}

async function postAgentRound(
	opts: AgentLoopOptions,
	openaiUrl: string,
	messages: ChatMessage[],
	maxTokens = 8192,
	tools: typeof AGENT_TOOLS = AGENT_TOOLS
): Promise<{
	ok: boolean;
	status: number;
	errorText: string;
	data: ChatCompletionData;
}> {
	if (isNativeAnthropic(opts)) {
		return postAnthropicRound(opts, messages, maxTokens, tools);
	}

	const response = await fetch(openaiUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
		},
		signal: opts.abortSignal,
		body: JSON.stringify({
			model: opts.model,
			messages,
			temperature: 0.2,
			max_tokens: maxTokens,
			stream: false,
			...(opts.proseToolsOnly
				? {}
				: { tools, tool_choice: 'auto' as const }),
			...llmContextOptions(getContextBudget(opts.numCtx)),
			...llmJsonOptions(opts.forceJson),
		}),
	});
	if (!response.ok) {
		return { ok: false, status: response.status, errorText: await response.text(), data: {} };
	}
	try {
		const data = await readChatCompletionResponse(response);
		return { ok: true, status: 200, errorText: '', data };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 502, errorText: message, data: {} };
	}
}

type ChatCompletionData = {
	choices?: Array<{
		message?: { content?: string | null; tool_calls?: ToolCall[] };
		finish_reason?: string | null;
		stop_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		input_tokens?: number;
		output_tokens?: number;
	};
};

/**
 * TabbyAPI / some OpenAI-compat servers ignore stream:false and return SSE
 * (text/event-stream). Aggregate chunks into a single chat.completion shape.
 */
async function readChatCompletionResponse(response: Response): Promise<ChatCompletionData> {
	const ctype = (response.headers.get('content-type') || '').toLowerCase();
	if (!ctype.includes('text/event-stream') && !ctype.includes('event-stream')) {
		// Still peek: some servers mis-label but send SSE body.
		const text = await response.text();
		const trimmed = text.trim();
		if (trimmed.startsWith('data:') || trimmed.startsWith(':')) {
			return aggregateSseChatCompletion(trimmed);
		}
		return liftProseToolsFromCompletion(JSON.parse(text) as ChatCompletionData);
	}
	const text = await response.text();
	return aggregateSseChatCompletion(text);
}

/** Normalize message.content (string | parts[] | object) into plain text. */
function coerceMessageContent(raw: unknown): string {
	if (raw == null) return '';
	if (typeof raw === 'string') return raw;
	if (Array.isArray(raw)) {
		return raw
			.map(part => {
				if (typeof part === 'string') return part;
				if (part && typeof part === 'object') {
					const o = part as Record<string, unknown>;
					if (typeof o.text === 'string') return o.text;
					if (typeof o.content === 'string') return o.content;
				}
				return '';
			})
			.join('');
	}
	if (typeof raw === 'object') {
		// Some gateways return already-parsed JSON in `content`
		try {
			return JSON.stringify(raw);
		} catch {
			return '';
		}
	}
	return String(raw);
}

/** Lift prose {"tool_calls":[...]} from content into native tool_calls when missing. */
function liftProseToolsFromCompletion(data: ChatCompletionData): ChatCompletionData {
	const choice = data.choices?.[0];
	const msg = choice?.message;
	if (!msg) return data;
	if (msg.tool_calls?.length) return data;
	const text = coerceMessageContent(msg.content).trim();
	if (!text) return data;
	const lifted = parseProseToolCalls(text);
	if (!lifted.length) return data;
	return {
		...data,
		choices: [
			{
				...choice,
				message: {
					...msg,
					content: null,
					tool_calls: lifted,
				},
			},
		],
	};
}

function aggregateSseChatCompletion(raw: string): ChatCompletionData {
	let content = '';
	const toolMap = new Map<
		number,
		{ id: string; type: 'function'; function: { name: string; arguments: string } }
	>();
	let usage: ChatCompletionData['usage'];
	let finishReason: string | null | undefined;
	let stopReason: string | null | undefined;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === '[DONE]') continue;
		let chunk: {
			usage?: ChatCompletionData['usage'];
			choices?: Array<{
				finish_reason?: string | null;
				stop_reason?: string | null;
				delta?: {
					content?: string | null;
					tool_calls?: Array<{
						index?: number;
						id?: string;
						type?: string;
						function?: { name?: string; arguments?: string };
					}>;
				};
				message?: { content?: string | null; tool_calls?: ToolCall[] };
			}>;
		};
		try {
			chunk = JSON.parse(payload);
		} catch {
			continue;
		}
		if (chunk.usage) {
			usage = chunk.usage;
		}
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		if (choice.stop_reason) stopReason = choice.stop_reason;
		// Rare non-streaming chunk shaped as full message inside SSE
		if (choice.message) {
			if (choice.message.content) content += choice.message.content;
			if (choice.message.tool_calls?.length) {
				for (let i = 0; i < choice.message.tool_calls.length; i++) {
					const tc = choice.message.tool_calls[i];
					toolMap.set(i, {
						id: tc.id,
						type: 'function',
						function: {
							name: tc.function.name,
							arguments: tc.function.arguments || '',
						},
					});
				}
			}
			continue;
		}
		const delta = choice.delta;
		if (!delta) continue;
		if (typeof delta.content === 'string') {
			content += delta.content;
		}
		for (const tc of delta.tool_calls ?? []) {
			const idx = tc.index ?? 0;
			const prev = toolMap.get(idx) ?? {
				id: tc.id || `call_${idx}`,
				type: 'function' as const,
				function: { name: '', arguments: '' },
			};
			if (tc.id) prev.id = tc.id;
			if (tc.function?.name) prev.function.name += tc.function.name;
			if (tc.function?.arguments) prev.function.arguments += tc.function.arguments;
			toolMap.set(idx, prev);
		}
	}

	const tool_calls = [...toolMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, v]) => v)
		.filter(t => t.function.name);

	// If the model streamed tool JSON only into content (no native tool_calls deltas)
	if (!tool_calls.length && content.trim()) {
		const lifted = parseProseToolCalls(content);
		if (lifted.length) {
			return {
				choices: [
					{
						message: { content: null, tool_calls: lifted },
						finish_reason: finishReason,
						stop_reason: stopReason,
					},
				],
				usage,
			};
		}
	}

	return {
		choices: [
			{
				message: {
					content: content || null,
					tool_calls: tool_calls.length ? tool_calls : undefined,
				},
				finish_reason: finishReason,
				stop_reason: stopReason,
			},
		],
		usage,
	};
}

async function postAnthropicRound(
	opts: AgentLoopOptions,
	messages: ChatMessage[],
	maxTokens = 8192,
	activeTools: typeof AGENT_TOOLS = AGENT_TOOLS
): Promise<{
	ok: boolean;
	status: number;
	errorText: string;
	data: {
		choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
}> {
	const system = messages
		.filter(m => m.role === 'system')
		.map(m => contentToPlainText(m.content))
		.join('\n');
	const converted: Array<Record<string, unknown>> = [];

	for (const m of messages) {
		if (m.role === 'system') continue;
		if (m.role === 'user') {
			converted.push({ role: 'user', content: toAnthropicContent(m.content) });
			continue;
		}
		if (m.role === 'assistant') {
			const content: Array<Record<string, unknown>> = [];
			const text = contentToPlainText(m.content);
			if (text) {
				content.push({ type: 'text', text });
			}
			for (const tc of m.tool_calls ?? []) {
				let input: Record<string, unknown> = {};
				try {
					input = JSON.parse(tc.function.arguments || '{}');
				} catch {
					input = {};
				}
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.function.name,
					input,
				});
			}
			converted.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
			continue;
		}
		if (m.role === 'tool') {
			const resultBlock: Record<string, unknown> = {
				type: 'tool_result',
				tool_use_id: m.tool_call_id,
				content: contentToPlainText(m.content),
			};
			const last = converted[converted.length - 1];
			const lastContent = last?.content;
			const canMerge =
				last &&
				last.role === 'user' &&
				Array.isArray(lastContent) &&
				(lastContent as Array<Record<string, unknown>>).length > 0 &&
				(lastContent as Array<Record<string, unknown>>).every(c => c.type === 'tool_result');
			if (canMerge) {
				(lastContent as Array<Record<string, unknown>>).push(resultBlock);
			} else {
				converted.push({
					role: 'user',
					content: [resultBlock],
				});
			}
		}
	}

	const safeConverted = filterAnthropicToolResults(converted);

	const tools = activeTools.map(t => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters,
	}));

	const response = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': opts.apiKey,
			'anthropic-version': '2023-06-01',
		},
		signal: opts.abortSignal,
		body: JSON.stringify({
			model: opts.model,
			max_tokens: maxTokens,
			system: system || undefined,
			messages: safeConverted,
			tools,
		}),
	});

	if (!response.ok) {
		return { ok: false, status: response.status, errorText: await response.text(), data: {} };
	}

	const raw = (await response.json()) as {
		content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};

	const textParts = (raw.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '');
	const toolUses = (raw.content ?? []).filter(c => c.type === 'tool_use');
	const tool_calls: ToolCall[] = toolUses.map((t, i) => ({
		id: t.id ?? `ant_${i}`,
		type: 'function',
		function: {
			name: t.name ?? 'unknown',
			arguments: JSON.stringify(t.input ?? {}),
		},
	}));

	return {
		ok: true,
		status: 200,
		errorText: '',
		data: {
			choices: [
				{
					message: {
						content: textParts.join('\n'),
						tool_calls: tool_calls.length ? tool_calls : undefined,
					},
				},
			],
			usage: raw.usage,
		},
	};
}

function isBrokenToolHistoryError(status: number, errText: string): boolean {
	if (status < 400) return false;
	return /no user query found|multi_step_tool_call_failed|argo exception|tool_use ids were found without|without\s+`?tool_result|each `tool_use` block must have|tool_use.*tool_result|tool_result.*tool_use|tool_call_id|messages with role ['"]tool['"]|did not find (a )?tool (response|result)|tool_calls must be followed|unclosed tool|missing tool (call )?result|invalid.*tool.*message|tool call result/i.test(
		errText
	);
}

/** Ensure every tool_call from the last assistant turn has a matching tool message. */
function ensureToolResultsForCalls(
	messages: ChatMessage[],
	toolCalls: ToolCall[],
	reason: string
): void {
	const have = new Set(
		messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id as string)
	);
	for (const call of toolCalls) {
		if (have.has(call.id)) continue;
		messages.push({
			role: 'tool',
			tool_call_id: call.id,
			name: call.function.name,
			content: reason,
		});
		have.add(call.id);
	}
}

/** Gateway (llama-server) rejected tool call because arguments JSON was cut mid-stream. */
function isTruncatedToolCallError(status: number, errText: string): boolean {
	if (status < 400) return false;
	return /invalid tool call arguments|unexpected end of json|tool call arguments/i.test(
		errText
	);
}

/**
 * Parse tool arguments; attempt light repair when local models truncate trailing braces/quotes.
 */
function parseToolArguments(raw: string): Record<string, unknown> {
	const text = raw.trim() || '{}';
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* try repair */
	}
	let repaired = text;
	// Close an open JSON string if content was cut mid-file.
	const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
	if (quoteCount % 2 === 1) {
		repaired += '"';
	}
	const opens = (repaired.match(/\{/g) || []).length;
	const closes = (repaired.match(/\}/g) || []).length;
	if (opens > closes) {
		repaired += '}'.repeat(opens - closes);
	}
	try {
		return JSON.parse(repaired) as Record<string, unknown>;
	} catch (err) {
		throw new Error(err instanceof Error ? err.message : 'unexpected end of JSON input');
	}
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.map(m => {
		const next: ChatMessage = { role: m.role, content: m.content ?? '' };
		if (m.tool_call_id) next.tool_call_id = m.tool_call_id;
		if (m.name) next.name = m.name;
		if (m.tool_calls?.length) next.tool_calls = m.tool_calls;
		return next;
	});
}

function buildUserContent(
	task: string,
	images?: Array<{ mime: string; dataUrl: string; label?: string }>
): string | ContentPart[] {
	if (!images?.length) return task;
	const parts: ContentPart[] = [{ type: 'text', text: task }];
	for (const img of images) {
		parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
	}
	return parts;
}

function contentToPlainText(content: string | ContentPart[]): string {
	if (typeof content === 'string') return content;
	return content
		.map(p => (p.type === 'text' ? p.text : p.type === 'image_url' ? '[image]' : ''))
		.filter(Boolean)
		.join('\n');
}

function toAnthropicContent(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
	if (typeof content === 'string') return content;
	return content.map(p => {
		if (p.type === 'text') return { type: 'text', text: p.text };
		const url = p.image_url.url;
		const m = /^data:([^;]+);base64,(.+)$/i.exec(url);
		if (m) {
			return {
				type: 'image',
				source: { type: 'base64', media_type: m[1], data: m[2] },
			};
		}
		return { type: 'image', source: { type: 'url', url } };
	});
}

function estimateTokens(messages: ChatMessage[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

function truncateHistory(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

async function runProseToolFallback(
	opts: AgentLoopOptions,
	messages: ChatMessage[],
	actions: string[]
): Promise<string> {
	messages.push({
		role: 'user',
		content:
			'Your API does not support native tools. Reply with ONLY a JSON array of tool calls like ' +
			'[{"name":"write","arguments":{"path":"file.ts","content":"..."}}] ' +
			'or a final plaintext answer if no tools are needed.',
	});

	const base = (opts.baseUrl || defaultBase(opts.provider)).replace(/\/$/, '');
	const response = await fetch(`${base}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
		},
		signal: opts.abortSignal,
		body: JSON.stringify({
			model: opts.model,
			messages,
			temperature: 0.1,
			stream: false,
			max_tokens: 2048,
		}),
	});

	if (!response.ok) {
		throw new Error(`LLM error ${response.status}: ${await response.text()}`);
	}

	const data = await readChatCompletionResponse(response);
	const text = data.choices?.[0]?.message?.content ?? '';
	const calls = parseProseToolCalls(text);

	if (!calls.length) {
		return text || '(empty)';
	}

	for (const call of calls) {
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
		} catch {
			args = {};
		}
		if (MUTATING.has(call.function.name)) {
			const approval = await ApprovalDialog.show({
				tool: call.function.name,
				arguments: summarizeArgs(call.function.name, args),
				risk: 'medium',
				reason: describeMutation(call.function.name, args),
			});
			if (!approval.approved) {
				actions.push(`${call.function.name} denied`);
				continue;
			}
		}
		const output = await executeTool(opts, call.function.name, args, call.id, opts.depth ?? 0);
		actions.push(
			output.startsWith('Error:')
				? `${call.function.name} failed`
				: `${call.function.name} ${String(args.path ?? '')}`.trim()
		);
	}

	return actions.length
		? `Done.\n${summarizeActionsForLlm(actions)}`
		: text;
}

function uniqHandoffPaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		const n = String(p ?? '')
			.trim()
			.replace(/\\/g, '/');
		if (!n) continue;
		const k = n.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(n);
		if (out.length >= 24) break;
	}
	return out;
}

async function gatherRepoSnapshotForHandoff(workspaceRoot?: string) {
	if (!workspaceRoot) return null;
	try {
		const [headRes, statusRes] = await Promise.all([
			execFileAsync('git', ['rev-parse', 'HEAD'], {
				cwd: workspaceRoot,
				windowsHide: true,
				maxBuffer: 64 * 1024,
			}),
			execFileAsync('git', ['status', '--short', '--branch'], {
				cwd: workspaceRoot,
				windowsHide: true,
				maxBuffer: 512 * 1024,
			}),
		]);
		return (
			parseRepoSnapshot({
				head: (headRes.stdout || '').trim(),
				statusShort: (statusRes.stdout || statusRes.stderr || '').trim(),
			}) ?? null
		);
	} catch {
		return null;
	}
}

/** Compact action stats for LLM context (not a raw tool log). */
function summarizeActionsForLlm(actions: string[]): string {
	if (!actions.length) {
		return 'Progress: (no tools yet)';
	}
	const writes = actions.filter(a => a.startsWith('write ') || a.startsWith('edit '));
	const deletes = actions.filter(a => a.startsWith('delete '));
	const shellsOk = actions.filter(
		a => a.startsWith('shell ') && a !== 'shell failed' && !/blocked|denied|threw/.test(a)
	);
	const fails = actions.filter(
		a =>
			/\b(failed|denied|threw|bad-args)\b/.test(a) ||
			/blocked \(plan mode\)|blocked \(hook\)|blocked \(too large\)|rejected \(diff\)/.test(a)
	);
	const patterns = new Map<string, number>();
	for (const f of fails) {
		const key = shortenActionLabel(f);
		patterns.set(key, (patterns.get(key) || 0) + 1);
	}
	const failSummary = [...patterns.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
		.join('; ');
	const recentWrites = [...new Set(writes.map(shortenActionLabel))].slice(-6);
	return [
		`Progress: writes=${writes.length}, deletes=${deletes.length}, shell_ok=${shellsOk.length}, fails=${fails.length}, total=${actions.length}`,
		recentWrites.length ? `Recent writes: ${recentWrites.join('; ')}` : '',
		failSummary ? `Failure patterns: ${failSummary}` : '',
	]
		.filter(Boolean)
		.join('\n');
}

function shortenActionLabel(a: string): string {
	if (a === 'shell failed') return 'shell failed';
	if (/blocked/.test(a)) {
		return a.replace(/\s*\([^)]*\)/g, '').slice(0, 40);
	}
	if (a.startsWith('write ') || a.startsWith('edit ')) {
		const verb = a.startsWith('edit ') ? 'edit' : 'write';
		const p = a.slice(verb.length + 1).replace(/\\/g, '/');
		const bits = p.split('/').filter(Boolean);
		return `${verb} ${bits.slice(-2).join('/')}`;
	}
	if (a.startsWith('delete ')) {
		const p = a.slice(7).replace(/\\/g, '/');
		const bits = p.split('/').filter(Boolean);
		return `delete ${bits.slice(-2).join('/')}`;
	}
	if (a.startsWith('shell ')) {
		const cmd = a.slice(6);
		if (/^type\s|^Get-Content\b|^cat\s/i.test(cmd)) return 'shell type(file)';
		if (/dotnet\s+build/i.test(cmd)) return 'shell dotnet build';
		if (/dotnet\s+test/i.test(cmd)) return 'shell dotnet test';
		if (/^dir\b|^ls\b/i.test(cmd)) return 'shell list';
		if (/^if exist\b/i.test(cmd)) return 'shell if-exist';
		return `shell ${cmd.slice(0, 36)}${cmd.length > 36 ? '…' : ''}`;
	}
	return a.slice(0, 48);
}

function normalizeToolCalls(raw: ToolCall[] | undefined): ToolCall[] {
	if (!raw?.length) return [];
	return raw
		.map((tc, i) => {
			const name = tc.function?.name;
			if (!name) return null;
			const rawArgs = tc.function.arguments as unknown;
			const argumentsJson =
				rawArgs && typeof rawArgs === 'object'
					? JSON.stringify(rawArgs)
					: String(rawArgs ?? '{}');
			return {
				id: tc.id || `call_${i}`,
				type: 'function' as const,
				function: {
					name,
					arguments: argumentsJson || '{}',
				},
			};
		})
		.filter((x): x is ToolCall => Boolean(x));
}

function stripMarkdownFences(text: string): string {
	return text
		.replace(/```(?:json|javascript|js|ts)?\s*/gi, '')
		.replace(/```/g, '')
		.trim();
}

/** Repair invalid JSON escapes like c:\Teste → c:\\Teste inside quoted strings. */
function repairJsonStringEscapes(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\' && inString) {
			const next = text[i + 1];
			if (next && '"\\/bfnrtu'.includes(next)) {
				out += ch;
				escaped = true;
			} else {
				// Invalid escape (e.g. \T in Windows paths) → double the backslash
				out += '\\\\';
			}
			continue;
		}
		if (ch === '"') {
			inString = !inString;
		}
		out += ch;
	}
	return out;
}

function extractJsonObjectSpan(text: string): string | null {
	const obj = text.indexOf('{');
	const arr = text.indexOf('[');
	if (obj < 0 && arr < 0) return null;
	// Take from the first structure to the end so truncated closers can be balanced.
	const start = obj < 0 ? arr : arr < 0 ? obj : Math.min(obj, arr);
	return text.slice(start).trim();
}

/** Insert missing }/] when local models truncate or under-close tool JSON. */
function balanceJsonBrackets(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\' && inString) {
			out += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			out += ch;
			continue;
		}
		if (inString) {
			out += ch;
			continue;
		}
		if (ch === '{' || ch === '[') {
			stack.push(ch);
			out += ch;
			continue;
		}
		if (ch === '}' || ch === ']') {
			const expect = ch === '}' ? '{' : '[';
			while (stack.length && stack[stack.length - 1] !== expect) {
				const top = stack.pop()!;
				out += top === '{' ? '}' : ']';
			}
			if (stack.length && stack[stack.length - 1] === expect) {
				stack.pop();
				out += ch;
			}
			continue;
		}
		out += ch;
	}
	if (inString) {
		out += '"';
	}
	while (stack.length) {
		const top = stack.pop()!;
		out += top === '{' ? '}' : ']';
	}
	return out;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
	const candidates = [
		text,
		repairJsonStringEscapes(text),
		balanceJsonBrackets(text),
		balanceJsonBrackets(repairJsonStringEscapes(text)),
	];
	for (const c of candidates) {
		try {
			let v: unknown = JSON.parse(c);
			// Double-encoded JSON string
			if (typeof v === 'string') {
				const inner = v.trim();
				if (inner.startsWith('{') || inner.startsWith('[')) {
					v = JSON.parse(balanceJsonBrackets(repairJsonStringEscapes(inner)));
				}
			}
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				return v as Record<string, unknown>;
			}
		} catch {
			/* next */
		}
	}
	return null;
}

function tryParseJsonArray(text: string): unknown[] | null {
	const candidates = [
		text,
		repairJsonStringEscapes(text),
		balanceJsonBrackets(text),
		balanceJsonBrackets(repairJsonStringEscapes(text)),
	];
	for (const c of candidates) {
		try {
			let v: unknown = JSON.parse(c);
			if (typeof v === 'string') {
				const inner = v.trim();
				if (inner.startsWith('[')) {
					v = JSON.parse(balanceJsonBrackets(repairJsonStringEscapes(inner)));
				}
			}
			if (Array.isArray(v)) return v;
		} catch {
			/* next */
		}
	}
	return null;
}

function parseProseToolCalls(text: string): ToolCall[] {
	const cleaned = stripMarkdownFences(text);
	const span = extractJsonObjectSpan(cleaned) ?? cleaned;

	const asToolCall = (
		name: string,
		args: unknown,
		id: string,
		index: number
	): ToolCall | null => {
		if (!name) return null;
		let argumentsJson: string;
		if (typeof args === 'string') {
			const repaired = tryParseJsonObject(args);
			argumentsJson = repaired ? JSON.stringify(repaired) : args;
		} else {
			argumentsJson = JSON.stringify(args && typeof args === 'object' ? args : {});
		}
		return {
			id: id || `prose_${index}`,
			type: 'function',
			function: { name, arguments: argumentsJson || '{}' },
		};
	};

	const fromArray = (arr: unknown[]): ToolCall[] =>
		arr
			.map((item, i) => {
				if (!item || typeof item !== 'object') return null;
				const o = item as Record<string, unknown>;
				const fn = o.function as Record<string, unknown> | undefined;
				if (fn && typeof fn.name === 'string') {
					return asToolCall(fn.name, fn.arguments, String(o.id ?? ''), i);
				}
				if (typeof o.name === 'string') {
					return asToolCall(o.name, o.arguments ?? o.args, String(o.id ?? ''), i);
				}
				return null;
			})
			.filter((x): x is ToolCall => Boolean(x));

	const obj = tryParseJsonObject(span);
	if (obj) {
		if (Array.isArray(obj.tool_calls)) {
			return fromArray(obj.tool_calls);
		}
		// tool_calls sometimes arrives as a JSON string
		if (typeof obj.tool_calls === 'string') {
			const arr = tryParseJsonArray(obj.tool_calls);
			if (arr?.length) return fromArray(arr);
		}
		if (typeof obj.name === 'string' && (obj.arguments !== undefined || obj.args !== undefined)) {
			const one = asToolCall(obj.name, obj.arguments ?? obj.args, String(obj.id ?? 'prose_0'), 0);
			return one ? [one] : [];
		}
		if (obj.function && typeof obj.function === 'object') {
			const fn = obj.function as Record<string, unknown>;
			const one = asToolCall(
				String(fn.name ?? ''),
				fn.arguments,
				String(obj.id ?? 'prose_0'),
				0
			);
			return one ? [one] : [];
		}
	}

	const asArray = tryParseJsonArray(span);
	if (asArray?.length) {
		const calls = fromArray(asArray);
		if (calls.length) return calls;
	}

	// Regex fallback: write({ path, content }) dumped as almost-JSON
	const writeMatch =
		/"name"\s*:\s*"write"[\s\S]*?"path"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(
			cleaned
		) ||
		/write[\s\S]*?"path"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(
			cleaned
		);
	if (writeMatch) {
		const unescape = (s: string) => {
			try {
				return JSON.parse(`"${s}"`) as string;
			} catch {
				return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
			}
		};
		return [
			{
				id: 'prose_write_0',
				type: 'function',
				function: {
					name: 'write',
					arguments: JSON.stringify({
						path: unescape(writeMatch[1]),
						content: unescape(writeMatch[2]),
					}),
				},
			},
		];
	}

	const shellMatch =
		/"name"\s*:\s*"shell"[\s\S]*?"command"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(cleaned);
	if (shellMatch) {
		const unescape = (s: string) => {
			try {
				return JSON.parse(`"${s}"`) as string;
			} catch {
				return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
			}
		};
		return [
			{
				id: 'prose_shell_0',
				type: 'function',
				function: {
					name: 'shell',
					arguments: JSON.stringify({ command: unescape(shellMatch[1]) }),
				},
			},
		];
	}

	const listMatch =
		/"name"\s*:\s*"list"[\s\S]*?"path"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(cleaned);
	if (listMatch) {
		const unescape = (s: string) => {
			try {
				return JSON.parse(`"${s}"`) as string;
			} catch {
				return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
			}
		};
		const recursive = /"recursive"\s*:\s*true/i.test(cleaned);
		return [
			{
				id: 'prose_list_0',
				type: 'function',
				function: {
					name: 'list',
					arguments: JSON.stringify({
						path: unescape(listMatch[1]),
						recursive,
					}),
				},
			},
		];
	}

	const writeBlock = /```write\s+([^\n]+)\n([\s\S]*?)```/i.exec(text);
	if (writeBlock) {
		return [
			{
				id: 'prose_write_0',
				type: 'function',
				function: {
					name: 'write',
					arguments: JSON.stringify({
						path: writeBlock[1].trim(),
						content: writeBlock[2],
					}),
				},
			},
		];
	}

	return [];
}

function looksLikeToolJson(text: string): boolean {
	return /"tool_calls"\s*:/i.test(text) || /"name"\s*:\s*"(write|shell|read|list)"/i.test(text);
}

/** Empty / `{}` / tiny JSON that local models emit under forceJson instead of tools. */
function isTrivialAssistantContent(text: string): boolean {
	const t = (text || '').trim();
	if (!t) return true;
	if (/^\{[\s,]*\}$/.test(t)) return true;
	if (/^\[[\s,]*\]$/.test(t)) return true;
	if (/^null$/i.test(t)) return true;
	if (t.length <= 8 && !/"tool_calls"|write|shell|list|read/i.test(t)) return true;
	return false;
}

function describeMutation(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case 'write':
			return `Write file ${args.path}`;
		case 'edit':
			return `Edit ${args.path}`;
		case 'dotnet':
			return `Run: ${dotnetCommandLine(args) || `dotnet ${String(args.action ?? '')}`}`;
		case 'delete':
			return `Delete ${args.path}`;
		case 'rename':
			return `Rename ${args.oldPath} → ${args.newPath}`;
		case 'shell':
			return `Run shell: ${args.command}`;
		default:
			return `Execute ${name}`;
	}
}

function summarizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	if (name === 'write') {
		const content = String(args.content ?? '');
		return {
			path: args.path,
			contentPreview: content.length > 400 ? content.slice(0, 400) + '…' : content,
			bytes: content.length,
		};
	}
	if (name === 'edit') {
		const clip = (s: unknown) => {
			const t = String(s ?? '');
			return t.length > 300 ? `${t.slice(0, 300)}…[+${t.length - 300} chars]` : t;
		};
		return {
			path: args.path,
			old_string: clip(args.old_string),
			new_string: clip(args.new_string),
			...(args.replace_all ? { replace_all: true } : {}),
		};
	}
	return args;
}

/** Short label for the chat timeline (Cursor-like: "Shell npm test", not "shell ok"). */
function formatToolActivityLabel(name: string, args: Record<string, unknown>): string {
	const title = name
		.replace(/_/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase())
		.replace(/^Mcp /, 'MCP ');
	const primary = String(
		args.path ??
			args.oldPath ??
			args.command ??
			args.pattern ??
			args.query ??
			args.tool ??
			args.task ??
			args.id ??
			''
	)
		.replace(/\s+/g, ' ')
		.trim();
	if (!primary) return title;
	const clipped = primary.length > 72 ? primary.slice(0, 69) + '…' : primary;
	if (name === 'shell' || name === 'dotnet') return `Shell ${clipped}`;
	if (name === 'read' || name === 'write' || name === 'edit' || name === 'delete' || name === 'open') {
		return `${title} ${clipped}`;
	}
	return `${title} ${clipped}`;
}

/**
 * Detail shown under a timeline row — keep the useful error, drop sandbox chrome and lesson footers
 * (lessons stay in the tool result the model sees).
 */
function cleanToolDetailForUi(output: string): string {
	let text = (output || '').trim();
	if (!text) return '';
	text = text.replace(/\n*\(lesson —[\s\S]*$/i, '').trim();
	const lines = text.split(/\r?\n/).filter(line => {
		const t = line.trim();
		if (!t) return false;
		if (/^cwd:\s/i.test(t)) return false;
		if (/^sandbox:\s/i.test(t)) return false;
		if (/^exit\s+\d+\s*$/i.test(t)) return false;
		if (/^\(no output\)$/i.test(t)) return false;
		if (/^\(failed — cwd:/i.test(t)) return false;
		if (/^\[Aborted/i.test(t) || /^\[Timeout\]/i.test(t)) return true;
		return true;
	});
	const body = lines.join('\n').trim();
	const exit = /^exit\s+(\d+)/im.exec(output);
	if (exit && Number(exit[1]) !== 0) {
		const err = body || '(no output)';
		return `exit ${exit[1]}\n${err}`.slice(0, 400);
	}
	return body.slice(0, 400);
}

/** Shell exit≠0 must not be cached as success / treated as OK progress. */
function isToolSuccess(name: string, output: string): boolean {
	if (output.startsWith('Error:')) {
		return false;
	}
	if (name.startsWith('git_') && /Git is unavailable|Git tool failed/i.test(output)) {
		return false;
	}
	if (name === 'shell' || name === 'dotnet') {
		const m = /^exit\s+(\d+)/m.exec(output);
		if (m && Number(m[1]) !== 0) {
			return false;
		}
		if (/Shell failed with empty stdout/i.test(output)) {
			return false;
		}
	}
	return true;
}

/** Enrich failed shell results so the model can decide without guessing. */
function enrichShellFailure(command: string, output: string, workspaceRoot?: string): string {
	const trimmed = (output || '').trim();
	const cwd = workspaceRoot || '(workspace root unknown)';
	if (trimmed.length > 0 && !/exit\s*code/i.test(trimmed) && !/^exit\s+\d+/m.test(trimmed)) {
		return [trimmed, '', `(failed — cwd: ${cwd}; command: ${command})`].join('\n');
	}
	if (trimmed.length > 0) {
		return trimmed;
	}
	return [
		`Shell failed with empty stdout/stderr.`,
		`cwd: ${cwd}`,
		`command: ${command}`,
		'(empty output usually means the program was not found or was killed)',
	].join('\n');
}

function defaultBase(provider: string): string {
	if (provider === 'ollama') return 'http://localhost:11434/v1';
	if (provider === 'lmstudio') return 'http://localhost:1234/v1';
	if (provider === 'vllm') return 'http://localhost:8000/v1';
	return 'https://api.openai.com/v1';
}

function collectOpenFilePaths(workspaceRoot?: string): string[] {
	const paths: string[] = [];
	const root = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : '';
	for (const ed of vscode.window.visibleTextEditors) {
		if (ed.document.uri.scheme !== 'file') continue;
		const fsPath = ed.document.uri.fsPath.replace(/\\/g, '/');
		paths.push(fsPath);
		if (root && fsPath.toLowerCase().startsWith(root.toLowerCase() + '/')) {
			paths.push(fsPath.slice(root.length + 1));
		}
	}
	return Array.from(new Set(paths));
}
