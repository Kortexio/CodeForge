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
import { SessionStore } from '../sessions/sessionStore';
import * as lsp from '../intelligence/lspBridge';
import * as git from '../intelligence/gitTools';
import { ProgressEval, ProgressReviewDialog } from './progressReview';
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
import { getSkillsRules } from '../skills/skillsRulesLoader';
import { runAgentHooks } from '../hooks/hooksRunner';
import { getSessionWikiStore } from '../memory/sessionWiki';
import { getProjectWikiStore } from '../memory/projectWiki';
import { getArtifactStore } from '../storage/artifacts';
import { AgentStateMachine } from './stateMachine';
import { DEFAULT_BUDGET } from '../context/engine';
import * as browser from '../browser/agent';

// Note: subagent is inlined via recursive runAgentWithTools — no separate import (avoids cycles).

const MUTATING = new Set(['write', 'delete', 'rename', 'shell', 'wiki_write', 'wiki_fact', 'browser_navigate', 'browser_click', 'browser_type']);
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

function toolResultCharCap(budget: number): number {
	// Scale with window; keep a hard ceiling so one tool dump cannot dominate.
	const soft = Math.floor(budget * 0.25);
	return Math.min(12000, Math.max(3000, soft));
}

function compactTokenThreshold(budget: number): number {
	return Math.floor(budget * 0.68);
}

function compactEveryNSteps(budget: number): number {
	if (budget >= 32000) return 12;
	if (budget >= 16000) return 8;
	return 4;
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
			description: 'Read a file from the workspace',
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
			name: 'write',
			description:
				'Create or overwrite a file. Keep content COMPLETE and valid JSON. Prefer small files (<120 lines). For large files, write a minimal stub first then patch with another write — never emit truncated content.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: {
						type: 'string',
						description: 'Full file body. Must be complete; do not cut mid-string.',
					},
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'list',
			description:
				'List files in ONE known subdirectory (non-recursive). Prefer retrieve over listing. Never recursive on repo root. Max ~2 lists per task.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					recursive: {
						type: 'boolean',
						description: 'Optional. Shallow recurse only; hard-capped. Prefer false.',
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
						description: 'safe-local | restricted | isolated | container',
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
			description: 'Delegate a focused subtask to a subagent (depth-1)',
			parameters: {
				type: 'object',
				properties: {
					task: { type: 'string' },
					context: { type: 'string' },
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
	/** Initial checkpoint size (default 20). Extended on positive reviews. */
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
]);

export async function runAgentWithTools(opts: AgentLoopOptions): Promise<string> {
	const checkpointSize = opts.maxSteps ?? 20;
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
	const gates = new GuardrailSession(
		governance.runtimeConfig({
			weakProfile,
			requireFailingTestBeforeImpl: weakProfile,
		})
	);

	const forceSkills = weakProfile ? ['skill.harness-weak-models'] : undefined;
	const skillSection = [
		governance.buildPromptSection(opts.task, { forceSkillIds: forceSkills }),
		getSkillsRules().buildPromptSection(
			opts.task,
			collectOpenFilePaths(opts.workspaceRoot)
		),
	]
		.filter(Boolean)
		.join('\n\n');
	const mcpHint = mcpTools.length
		? `MCP tools available via mcp_call: ${mcpTools.map(t => t.fullName).join(', ')}`
		: '';
	const agentsMdSection = await loadAgentsMdForPrompt();

	const planModeHint = opts.planMode
		? [
				'### PLAN MODE (active)',
				'You may explore the repo and write a plan to the wiki (wiki_write id=task-plan with checklist + Definition of Done).',
				'Do NOT implement: no write/delete/rename of source files, no mutating shell. When the plan is saved, stop and summarize the plan.',
			].join('\n')
		: '';
	const weakHint = weakProfile
		? '### WEAK MODEL HARNESS: keep steps tiny; plan first; TDD; verify APIs; build after each write.'
		: '';

	const systemBase = [
		'You are CodeForge Agent, a coding agent inside a VS Code-based IDE on Windows.',
		`Workspace root: ${opts.workspaceRoot ?? '(none — ask user to open a folder)'}`,
		'You CAN and MUST use tools to read/write files and run commands.',
		'Prefer relative paths from the workspace root.',
		'On Windows shell: commands run via cmd.exe in the workspace. Prefer `dotnet …` without `cd`. `&&` works. Do not use PowerShell-only syntax.',
		'Shell output (exit code + stdout/stderr) is returned to you — read it and adapt. Do not repeat a failing command unchanged.',
		'.NET / Blazor: use Microsoft.AspNetCore.Components.WebAssembly (NOT Microsoft.AspNetCore.Blazor.WebAssembly). Match EF Core package versions to the project TFM. Prefer `dotnet list package` then `dotnet add package <Name>` one at a time on failure.',
		'findstr on Windows: use simple substrings (e.g. findstr /i EntityFramework), not regex with \\|.',
		'Use list (not shell ls). Use write for file content. Use shell for build/test/run.',
		'Long-running servers (dotnet run, npm start, …) keep streaming in the Agent Terminal; after startup you get a handoff — do NOT re-run the same server; finish the task or keep editing.',
		'Act from CONTEXT PACKET first (IDE STATE, RETRIEVE, STABLE FACTS). Do NOT start with a tour of the repo.',
		'Default: retrieve or open/dirty files → targeted read → write/shell. Skip list unless a specific folder path is unknown.',
		'Hard limit: at most 2 list calls and 3 explore reads per task before you must write, shell, or answer. Never list "." recursively. Never list every folder "just in case".',
		'When you already know enough to answer or edit, STOP exploring. When the user goal is met, stop tools and give a short summary (what changed + how to run).',
		'Respect STABLE FACTS and IDE STATE — never invent alternate project roots.',
		'Use diagnostics after edits. Use git_* tools for VCS. Use wiki_* for durable memory. Use browser_* for visual checks when Playwright is available.',
		'Use delegate_task only for focused parallel research (depth-1), not for routine listing.',
		'CRITICAL for write tool: emit COMPLETE JSON arguments. Prefer files under ~120 lines per write. Never cut content mid-string — the gateway rejects truncated tool JSON.',
		opts.forceJson
			? 'This server expects JSON responses. Prefer native tool_calls when available; otherwise reply with ONLY JSON like {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":{"path":"...","content":"..."}}}]} — no markdown fences.'
			: '',
		opts.proseToolsOnly
			? 'This model does NOT support native tools. You MUST reply with ONLY JSON tool_calls in content (no markdown). Example: {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"retrieve","arguments":{"query":"..."}}}]}'
			: '',
		planModeHint,
		weakHint,
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
			content: truncateHistory(m.content, 6000),
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
	const warnedFingerprints = new Set<string>();
	/** Shell (and other) fingerprints that already failed once this run — block identical retry. */
	const failedFingerprints = new Map<string, number>();
	let consecutiveToolFails = 0;
	const touchedPaths = new Set<string>();
	let emptyFinishNudges = 0;
	/** Retries when gateway rejects truncated tool-call JSON (common with large writes). */
	let truncatedToolRetries = 0;
	/** Retries when model dumps tool JSON in content but parse fails. */
	let proseToolParseRetries = 0;
	/** Soft retries when model returns empty / `{}` under forceJson instead of tools. */
	let trivialFinishNudges = 0;
	/** One-shot repair when Anthropic rejects orphan tool_use without tool_result. */
	let toolHistoryRepairedOnce = false;
	/** After negative checkpoint: block explore tools for N LLM steps so the model must write/build. */
	let exploreBanSteps = 0;
	let exploreOnlyStreak = 0;
	/** Soft explore nudge fires once per streak window (avoid spam). */
	let exploreSoftNudged = false;
	/** Total list calls this run — hard-capped to stop repo tours. */
	let listCallCount = 0;
	/** Total explore-tool successes this run before a write/shell. */
	let exploreBudgetUsed = 0;
	let systemBaseWithPacket = system;
	const contextBudget = getContextBudget(opts.numCtx);
	const toolCap = toolResultCharCap(contextBudget);
	const compactEvery = compactEveryNSteps(contextBudget);
	const softCompactAt = Math.floor(contextBudget * 0.45);
	const midCompactAt = Math.floor(contextBudget * 0.58);
	const compactAt = compactTokenThreshold(contextBudget);
	const packetEvery = Math.max(3, Math.floor(compactEvery / 2));
	opts.onActivity?.({
		kind: 'context',
		label: `contextBudget ${contextBudget}`,
		detail: `num_ctx=${contextBudget}; soft@${softCompactAt} mid@${midCompactAt} hard@${compactAt}; packet every ${packetEvery}; tool cap ${toolCap}`,
	});

	// Ensure Agent Terminal is visible even before the first shell call
	try {
		await opts.bridge.prepareAgentTerminal?.();
	} catch {
		/* best-effort */
	}
	const reviewLog: string[] = [];
	let compactedOnce = false;
	const taskId = opts.sessionId ?? `task-${Date.now()}`;
	const started = Date.now();
	opts.onTaskUpdate?.({
		id: taskId,
		name: truncateHistory(opts.task, 60),
		status: 'running',
		model: opts.model,
		elapsed: 0,
	});

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
				return 'Cancelled.';
			}

			const exploreBanned = exploreBanSteps > 0;
			const tokEst = estimateTokens(messages);

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
								wiki_session: 0.08,
								wiki_project: 0.08,
								facts: 0.06,
								ide: 0.12,
								retrieve: 0.14,
								git: 0.04,
								mcp: 0.03,
								history: 0.25,
							},
						},
						boostPaths: [...touchedPaths],
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

			if (tokEst > compactAt || (step > 0 && step % compactEvery === 0)) {
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
					gates.compactStickyExtra()
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
				messages = midCompactMessages(messages, systemBaseWithPacket);
				sm.transition('executing');
			} else if (tokEst > softCompactAt) {
				sm.transition('compacting');
				opts.onActivity?.({ kind: 'compact', label: 'Soft compact (trim tool results)…' });
				messages = softCompactToolResults(messages, Math.floor(toolCap * 0.35));
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
				return 'Cancelled.';
			}

			const llmStart = Date.now();
			normalizeToolProtocolHistory(messages);
			const round = await postAgentRound(opts, url, sanitizeMessages(messages));
			if (!round.ok) {
				const errText = round.errorText;
				trace?.error('LLM error', `${round.status}: ${errText.slice(0, 300)}`);
				opts.onActivity?.({
					kind: 'checkpoint',
					label: `LLM error ${round.status || ''}`.trim(),
					detail: errText.slice(0, 400),
				});
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
					const n = normalizeToolProtocolHistory(messages);
					opts.onStatus?.(
						n
							? `Histórico de tools reparado (${n}) — a repetir…`
							: 'Histórico de tools inválido — a repetir…'
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
							'### MODEL HAS NO NATIVE TOOL SUPPORT',
							'The API rejected `tools` for this model.',
							'From now on reply with ONLY valid JSON tool_calls in your message content (no markdown fences):',
							'{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"retrieve","arguments":{"query":"relevant files"}}}]}',
							'Prefer retrieve/write/shell. Do not list the whole workspace. Stop when the user task is done.',
						].join('\n'),
					});
					opts.onStatus?.(
						`Modelo sem tools nativas (${opts.model}) — a continuar em modo JSON…`
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
							'### TOOL CALL JSON WAS TRUNCATED (gateway rejected it)',
							'Your last tool call had incomplete JSON arguments (often a cut-off `write.content`).',
							'Retry with SMALLER writes: one short file at a time (<120 lines), complete valid JSON, no mid-string cuts.',
							'Prefer fixing existing files with small patches over rewriting large Razor/HTML in one call.',
							`Attempt ${truncatedToolRetries}/3.`,
						].join('\n'),
					});
					opts.onStatus?.('Tool JSON truncado — a pedir write mais pequeno…');
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
						gates.compactStickyExtra()
					);
					normalizeToolProtocolHistory(messages);
					opts.onStatus?.('Gateway lost context — retrying with compacted history…');
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

			const data = round.data;

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
							'Your previous message looked like a tool call but was NOT valid JSON (often Windows paths need \\\\).',
							'Call tools using the native tool/function protocol if available.',
							'Otherwise reply with ONLY valid JSON (no markdown fences, no trailing ```):',
							'{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":{"path":"hello.txt","content":"Hello, World!"}}}]}',
							'Use relative paths when possible (avoid c:\\\\...).',
							'Do NOT reply with {} or prose — emit a real tool call and continue the mission.',
						].join('\n'),
					});
					step -= 1;
					continue;
				}
			}

			// When tools came from prose JSON, don't keep the raw JSON as assistant chat content
			const assistantContent = toolCalls.length && looksLikeToolJson(content) ? '' : content;

			if (!toolCalls.length) {
				const writes = actions.filter(a => a.startsWith('write ')).length;
				const shells = actions.filter(a => a.startsWith('shell')).length;
				const trivial = isTrivialAssistantContent(content);
				const substantive =
					!!content &&
					!trivial &&
					!looksLikeToolJson(content) &&
					content.trim().length >= 40;
				const codingTask =
					/\b(create|implement|add|fix|write|build|gerar|criar|implementar|corrigir|adicionar|refactor|migrate)\b/i.test(
						opts.task
					);
				const needsBuild =
					/\b(build|run|dotnet|test|compilar|executar)\b/i.test(opts.task) &&
					writes > 0 &&
					shells === 0;

				// Only force more tools for empty/broken turns — never for a real answer after listing.
				const stillNeedsTools =
					looksLikeToolJson(content) ||
					((!content || trivial) && emptyFinishNudges < 2) ||
					(codingTask && writes === 0 && !substantive && emptyFinishNudges < 2) ||
					(needsBuild && !substantive && emptyFinishNudges < 2);

				if (stillNeedsTools && step + 1 < stepBudget) {
					emptyFinishNudges += 1;
					if (trivial || !content) {
						trivialFinishNudges += 1;
					}
					const nudge = [
						'### CONTINUE — do not stop yet',
						'Your last turn had no usable tool call (empty, `{}`, or invalid tool JSON).',
						content && !trivial
							? `Last text:\n${content.slice(0, 1200)}`
							: 'Last model turn was empty/trivial.',
						codingTask && writes === 0
							? 'REQUIRED: write the change (retrieve one target file first if needed). Do NOT list the whole repo.'
							: needsBuild
								? 'REQUIRED: run shell build/test now, then summarize.'
								: 'Emit a real tool call, or if the task is already done reply with a short final summary and STOP.',
						actions.length ? `Actions so far: ${actions.slice(-8).join(' | ')}` : '',
					]
						.filter(Boolean)
						.join('\n');
					messages.push({ role: 'assistant', content: content || '(empty)' });
					messages.push({ role: 'user', content: nudge });
					opts.onStatus?.(
						`Sem progresso útil — a forçar continuação (${emptyFinishNudges}/2)…`
					);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: 'Forced continue',
						detail: trivial ? 'trivial/empty model output' : content.slice(0, 160),
					});
					continue;
				}

				const summary =
					content ||
					(actions.length
						? 'Parado sem texto final do modelo. Peça “continua” se a missão não estiver completa.'
						: '(no response)');
				// Never surface raw tool JSON as the final chat answer
				if (looksLikeToolJson(summary)) {
					return [
						'O modelo ficou a devolver JSON de ferramentas inválido e esgotou as tentativas.',
						'Desative "Require JSON responses" neste servidor ou peça de novo com um ficheiro relativo (ex.: hello.txt).',
						`Pré-visualização: ${summary.slice(0, 240)}`,
					].join('\n');
				}
				if (isTrivialAssistantContent(summary) && actions.length) {
					return [
						'O modelo parou com resposta vazia após algumas ações.',
						'Peça “continua” no chat para retomar.',
						summarizeActionsForLlm(actions),
					].join('\n');
				}
				opts.onTaskUpdate?.({
					id: taskId,
					name: truncateHistory(opts.task, 60),
					status: 'completed',
					result: summary.slice(0, 200),
					elapsed: Date.now() - started,
				});
				opts.onActivity?.({
					kind: 'checkpoint',
					label: 'Turn summary',
					detail: summarizeActionsForLlm(actions).slice(0, 400),
				});
				// Keep conversational reply clean — do not append Actions/Checkpoints dumps
				// (they pollute session history sent back to the LLM).
				return summary;
			}

			messages.push({
				role: 'assistant',
				content: assistantContent || '',
				tool_calls: toolCalls,
			});

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
				if (name === 'write' && typeof args.content === 'string' && args.content.length > 14000) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content:
							'Write rejected: content too large for a single tool call. ' +
							'Split into a smaller stub write, then follow-up writes. Keep each write under ~120 lines.',
					});
					actions.push('write blocked (too large)');
					continue;
				}
				if (exploreBanned && exploreTools.has(name)) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: [
							`BLOCKED: ${name} is temporarily banned after REPLAN (${exploreBanSteps} steps left).`,
							'You already explored enough. Next tools MUST be write and/or shell (dotnet build / dotnet run).',
							'Fix compile errors from the last build: in Razor use double quotes for strings (not single quotes); use ValidationMessageFor (not ValidationFor); replace invented PagePath(...) with href="/path".',
						].join('\n'),
					});
					actions.push(`${name} blocked (replan)`);
					continue;
				}

				// Hard caps: stop repo-wide listing tours before they eat the turn.
				if (name === 'list') {
					const listPath = String(args.path ?? '.')
						.replace(/\\/g, '/')
						.replace(/^\.\//, '')
						.trim();
					const isRoot = !listPath || listPath === '.' || listPath === '/';
					const recursive = Boolean(args.recursive);
					if (recursive && isRoot) {
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							name,
							content: [
								'BLOCKED: recursive list of the workspace root is not allowed.',
								'Use retrieve with a specific query, or list ONE subfolder (e.g. src/, Pages/).',
								'Then write/shell or answer — do not tour the tree.',
							].join('\n'),
						});
						actions.push('list blocked (root-recursive)');
						exploreOnlyStreak += 1;
						continue;
					}
					if (listCallCount >= 2) {
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							name,
							content: [
								'BLOCKED: list budget exhausted (max 2 per task).',
								'Use retrieve, read a known path, write, shell, or answer the user now.',
							].join('\n'),
						});
						actions.push('list blocked (budget)');
						exploreBanSteps = Math.max(exploreBanSteps, 3);
						continue;
					}
				}

				if (
					exploreTools.has(name) &&
					exploreBudgetUsed >= 3 &&
					!exploreBanned
				) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: [
							`BLOCKED: explore budget exhausted (${exploreBudgetUsed} explore tools).`,
							'CONTEXT PACKET + prior tool results are enough. Next: write, shell, or final answer.',
						].join('\n'),
					});
					actions.push(`${name} blocked (explore-budget)`);
					exploreBanSteps = Math.max(exploreBanSteps, 3);
					continue;
				}

				const fingerprint = toolFingerprint(name, args);
				const priorCount = recentFingerprints.filter(f => f === fingerprint).length;
				recentFingerprints.push(fingerprint);
				if (recentFingerprints.length > 40) {
					recentFingerprints.shift();
				}

				const pathKey =
					typeof args.path === 'string'
						? args.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
						: '';
				const cached = resultCache.get(fingerprint);
				const isReadonly = READONLY_TOOLS.has(name);
				const priorFails = failedFingerprints.get(fingerprint) ?? 0;

				// Block identical shell (or other mutating) retry after a prior failure.
				if (priorFails >= 1 && (name === 'shell' || !isReadonly)) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: [
							`BLOCKED: identical "${name}" already failed earlier in this run.`,
							'Do not repeat the same command/args. Change the approach (different command, fix the file, or ask the user).',
							name === 'shell'
								? 'Tip: read the previous exit/stderr, then write a fix or run a different build target.'
								: '',
						]
							.filter(Boolean)
							.join('\n'),
					});
					actions.push(`${name} blocked (failed-repeat)`);
					pendingNudges.push(
						`Circuit: "${name}" failed before with the same arguments. Try a different action.`
					);
					consecutiveToolFails += 1;
					continue;
				}

				// Cursor-like anti-re-read: same path already seen this run → refuse full dump.
				if (name === 'read' && pathKey && readPathsSeen.has(pathKey)) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: [
							`ALREADY_READ: ${args.path}`,
							'You already read this file in this run. Do NOT read it again.',
							`Known paths: ${[...readPathsSeen].slice(0, 20).join(', ')}`,
							'Next: write the needed changes, then shell (dotnet build).',
						].join('\n'),
					});
					actions.push(`read skipped (already seen)`);
					exploreOnlyStreak += 1;
					continue;
				}

				if (cached && priorCount >= 1 && isReadonly) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content:
							`[already fetched — do not re-read; use this and move on]\n${cached.slice(0, Math.min(2000, toolCap))}`,
					});
					if (!warnedFingerprints.has(fingerprint)) {
						warnedFingerprints.add(fingerprint);
						actions.push(`${name} cached`);
						pendingNudges.push(
							`You already have the result of ${name}. Do NOT call it again with the same arguments. ` +
								`Continue with writes, diagnostics, build, or a final summary.`
						);
					}
					exploreOnlyStreak += 1;
					continue;
				}

				if (priorCount >= 2 && !isReadonly) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: `Stopped: tool "${name}" repeated with the same arguments without progress. Change approach.`,
					});
					if (!warnedFingerprints.has(fingerprint)) {
						warnedFingerprints.add(fingerprint);
						actions.push(`${name} blocked (repeat)`);
						pendingNudges.push(
							'You repeated the same mutating tool call. Stop looping. Summarize progress and the next concrete step.'
						);
					}
					consecutiveToolFails += 1;
					continue;
				}

				opts.onActivity?.({
					kind: 'tool',
					label: `Running ${name}`,
					tool: name,
					toolCallId: call.id,
					toolStatus: 'running',
					detail: JSON.stringify(summarizeArgs(name, args)).slice(0, 200),
				});

				if (MUTATING.has(name)) {
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
					return 'Cancelled.';
				}

				const blocked = gates.blockReason(name, args);
				if (blocked) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: blocked,
					});
					pendingNudges.push(blocked);
					actions.push(`${name} blocked (guardrail)`);
					opts.onActivity?.({
						kind: 'checkpoint',
						label: `Guardrail blocked ${name}`,
						detail: blocked.slice(0, 240),
					});
					continue;
				}

				if (opts.planMode && !PLAN_MODE_TOOLS.has(name)) {
					const planBlock =
						`Blocked by Plan mode: tool "${name}" is not allowed. ` +
						`Use explore/wiki tools only, save task-plan via wiki_write, then switch to Agent to implement.`;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						name,
						content: planBlock,
					});
					pendingNudges.push(planBlock);
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

				if (name === 'write') {
					const policy = getApprovalPolicy();
					const previewEdits =
						vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('previewEdits') ===
						true;
					// Cursor-like: if edits are auto-approved (or user already accepted), skip DiffPreview
					// unless previewEdits is explicitly enabled.
					if (previewEdits && !policy.isAutoApproved('write')) {
						const ok = await maybeShowWriteDiff(opts.bridge, args);
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
					output = await executeTool(opts, name, args, call.id, depth);
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
					consecutiveToolFails += 1;
				}

				if (name === 'shell') {
					const nudge = gates.onShellResult(args.command, success, output);
					if (nudge) {
						pendingNudges.push(nudge);
						if (gates.lastBuildErrors.length) {
							facts = mergeStableFacts(facts, { openErrors: gates.lastBuildErrors });
						}
						opts.onActivity?.({
							kind: 'checkpoint',
							label: 'Build-fix mode',
							detail: gates.lastBuildErrors.slice(0, 3).join(' | '),
						});
					} else if (success && gates.lastBuildErrors.length === 0 && !gates.buildRed) {
						facts = mergeStableFacts(facts, { openErrors: [] });
					}
				}
				if (name === 'write' && success) {
					gates.onSuccessfulWrite(args.path);
				}

				facts = extractFactsFromTool(
					facts,
					name,
					args,
					output,
					success,
					opts.workspaceRoot
				);
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
					label: success ? `${name} ok` : `${name} failed`,
					tool: name,
					toolCallId: call.id,
					toolStatus: success ? 'ok' : 'failed',
					success,
					detail: output.slice(0, 300),
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
							: `${name} failed`
				);

				if (name === 'read' && pathKey && success) {
					readPathsSeen.add(pathKey);
				}

				if (exploreTools.has(name)) {
					exploreOnlyStreak += 1;
					exploreBudgetUsed += 1;
					if (name === 'list') {
						listCallCount += 1;
					}
				} else if (name === 'write' || name === 'shell') {
					exploreOnlyStreak = 0;
					exploreSoftNudged = false;
					exploreBudgetUsed = 0;
				}

				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					name,
					content: output.slice(0, toolCap),
				});
			}

			// Flush deferred nudges only after every tool_result for this assistant turn exists.
			for (const nudge of pendingNudges) {
				messages.push({ role: 'user', content: nudge });
			}

			// Circuit breaker: too many consecutive tool failures → force rethink.
			if (consecutiveToolFails >= 5) {
				consecutiveToolFails = 0;
				exploreBanSteps = Math.max(exploreBanSteps, 4);
				messages.push({
					role: 'user',
					content: [
						'### CIRCUIT BREAKER',
						'Too many consecutive tool failures without progress.',
						summarizeActionsForLlm(actions),
						'Stop repeating failed tools. Change strategy: write a fix, run a different command, or summarize blockers for the user.',
					].join('\n'),
				});
				opts.onActivity?.({
					kind: 'checkpoint',
					label: 'Circuit breaker',
					detail: '5 consecutive tool failures',
				});
			}

			// Soft steer early, then hard explore ban without waiting for checkpoint.
			if (
				gates.antiExploreEnabled() &&
				exploreOnlyStreak >= 2 &&
				exploreOnlyStreak < 3 &&
				!exploreBanned &&
				!exploreSoftNudged
			) {
				exploreSoftNudged = true;
				messages.push({
					role: 'user',
					content: [
						'### STOP TOURING — act now',
						'You already explored. Prefer write/shell or a final answer. Do not list more folders.',
						`Files already read: ${[...readPathsSeen].slice(0, 24).join(', ') || '(none)'}`,
					].join('\n'),
				});
			}
			if (gates.antiExploreEnabled() && exploreOnlyStreak >= 3 && !exploreBanned) {
				exploreOnlyStreak = 0;
				exploreSoftNudged = false;
				exploreBanSteps = Math.max(exploreBanSteps, 4);
				const seen = [...readPathsSeen].slice(0, 24).join(', ') || '(none yet)';
				messages.push({
					role: 'user',
					content: [
						'### IMPLEMENTATION PHASE',
						'Explore tools are now temporarily banned. Stop listing/reading.',
						`Files already read: ${seen}`,
						formatStableFactsBlock(facts),
						'REQUIRED next: write and/or shell, or a short final answer if the question is answered.',
					]
						.filter(Boolean)
						.join('\n'),
				});
				opts.onActivity?.({
					kind: 'checkpoint',
					label: 'Explore ban (early)',
					detail: `after ${actions.length} actions`,
				});
			}

			// Consume one explore-ban step after the full tool round (not before).
			if (exploreBanned) {
				exploreBanSteps = Math.max(0, exploreBanSteps - 1);
			}

			// Checkpoint review every N steps (adaptive budget extension)
			const completedSteps = step + 1;
			if (
				adaptive &&
				completedSteps === nextCheckpoint &&
				completedSteps < hardCap
			) {
				opts.onStatus?.(
					`Checkpoint ${completedSteps}/${hardCap}: a avaliar progresso…`
				);
				opts.onActivity?.({
					kind: 'checkpoint',
					label: `Checkpoint @ step ${completedSteps}`,
				});
				const evaluation = await evaluateProgress(opts, actions, reviewLog);
				const line = `[step ${completedSteps}] ${evaluation.verdict.toUpperCase()} — ${evaluation.cause}`;
				reviewLog.push(line);
				trace?.info('checkpoint', line);

				const statusBlock = [
					`### Checkpoint @ step ${completedSteps}`,
					`**Veredicto:** ${evaluation.verdict}`,
					`**Causa:** ${evaluation.cause}`,
					`**Caminho:** ${evaluation.path}`,
					evaluation.summary ? `**Resumo:** ${evaluation.summary}` : '',
				]
					.filter(Boolean)
					.join('\n');
				opts.onStatus?.(statusBlock);

				if (evaluation.verdict === 'done') {
					opts.onTaskUpdate?.({
						id: taskId,
						name: truncateHistory(opts.task, 60),
						status: 'completed',
						result: evaluation.summary.slice(0, 200),
						elapsed: Date.now() - started,
					});
					return evaluation.summary || 'Task appears complete.';
				}

				if (evaluation.verdict === 'positive') {
					const extended = Math.min(hardCap, nextCheckpoint + checkpointSize);
					stepBudget = extended;
					nextCheckpoint = extended;
					opts.onStatus?.(
						`Progresso positivo → a continuar até step ${extended} (cap ${hardCap}).\nCausa: ${evaluation.cause}`
					);
					messages.push({
						role: 'user',
						content: [
							`CHECKPOINT REVIEW (positive): extend budget to ${extended} steps.`,
							`Cause: ${evaluation.cause}`,
							`Progress: ${summarizeActionsForLlm(actions)}`,
							`Continue only what remains. Do not re-list folders or redo completed work.`,
							`If the user goal is already met, reply with a short final summary and stop tools.`,
						].join('\n'),
					});
					continue;
				}

				if (evaluation.verdict === 'blocked') {
					const choice = await ProgressReviewDialog.chooseProposal(evaluation);
					if (choice.action === 'stop') {
						opts.onTaskUpdate?.({
							id: taskId,
							name: truncateHistory(opts.task, 60),
							status: 'failed',
							result: 'Blocked — stopped by user',
							elapsed: Date.now() - started,
						});
						return [
							'## Bloqueio — parado pelo utilizador',
							`**Causa:** ${evaluation.cause}`,
							evaluation.summary,
						]
							.filter(Boolean)
							.join('\n');
					}

					const extended = Math.min(hardCap, nextCheckpoint + checkpointSize);
					stepBudget = extended;
					nextCheckpoint = extended;

					if (choice.action === 'replan') {
						exploreBanSteps = Math.max(exploreBanSteps, 8);
						opts.onStatus?.(
							`Reanálise pedida pelo utilizador → budget ${extended}.\nCausa: ${evaluation.cause}`
						);
						messages.push({
							role: 'user',
							content: await buildReplanPrompt(opts, evaluation, actions, 'user asked to replan'),
						});
					} else {
						exploreBanSteps = Math.max(exploreBanSteps, 6);
						opts.onStatus?.(
							`Opção escolhida: ${choice.proposal.title}\nCausa: ${evaluation.cause}\nNovo caminho: ${choice.proposal.detail}\nA continuar até ${extended}.`
						);
						messages.push({
							role: 'user',
							content: [
								'USER RESOLUTION for blocker:',
								`Chosen option: ${choice.proposal.title}`,
								`Details: ${choice.proposal.detail}`,
								`Prior cause: ${evaluation.cause}`,
								`Progress: ${summarizeActionsForLlm(actions)}`,
								'Follow this resolution. Do not repeat the failed approach. Budget extended.',
							].join('\n'),
						});
					}
					continue;
				}

				// negative → reanalyze and get back on track, then allow one more checkpoint
				const extended = Math.min(hardCap, nextCheckpoint + checkpointSize);
				stepBudget = extended;
				nextCheckpoint = extended;
				exploreBanSteps = Math.max(exploreBanSteps, 8);
				opts.onStatus?.(
					`Progresso insuficiente → reanálise.\nCausa: ${evaluation.cause}\nA corrigir rumo e continuar até ${extended}.\n(Exploração read/list bloqueada por ${exploreBanSteps} steps.)`
				);
				messages.push({
					role: 'user',
					content: await buildReplanPrompt(
						opts,
						evaluation,
						actions,
						'automatic replan after negative checkpoint'
					),
				});
			}
		}

		opts.onTaskUpdate?.({
			id: taskId,
			name: truncateHistory(opts.task, 60),
			status: 'failed',
			result: 'max steps',
			elapsed: Date.now() - started,
		});

		return (
			`Reached max tool steps (${stepBudget}/${hardCap}) without a final summary.\n\n` +
			`${summarizeActionsForLlm(actions)}\n` +
			(reviewLog.length ? `Last checkpoint: ${reviewLog[reviewLog.length - 1]}\n\n` : '') +
			`Tip: ask to continue, or break the task into smaller steps.`
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		opts.onTaskUpdate?.({
			id: taskId,
			name: truncateHistory(opts.task, 60),
			status: 'failed',
			result: message.slice(0, 200),
			elapsed: Date.now() - started,
		});
		throw err;
	}
}

async function executeTool(
	opts: AgentLoopOptions,
	name: string,
	args: Record<string, unknown>,
	callId: string,
	depth: number
): Promise<string> {
	try {
		switch (name) {
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
				return await git.gitStatus();
			case 'git_diff':
				return await git.gitDiff(args.path ? String(args.path) : undefined);
			case 'git_log':
				return await git.gitLog(Number(args.count ?? 10));
			case 'git_commit_msg':
				return await git.suggestCommitMessage();
			case 'git_blame':
				return await git.gitBlame(
					String(args.path),
					args.startLine !== undefined ? Number(args.startLine) : undefined,
					args.endLine !== undefined ? Number(args.endLine) : undefined
				);
			case 'git_conflicts':
				return await git.gitConflicts(args.path ? String(args.path) : undefined);
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
				return doc
					? `# ${doc.title}\n\n${doc.content}`
					: `Wiki document not found: ${id}`;
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
				const hits = await retrieveSnippets(query, Math.min(12, Math.max(1, k)));
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
				return await runAgentWithTools({
					...opts,
					task: String(args.task),
					history: args.context
						? [{ role: 'user', content: String(args.context) }]
						: opts.history,
					depth: depth + 1,
					maxSteps: 8,
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

	let oldContent: string | undefined;
	try {
		const result = await bridge.execute({
			id: 'diff-read',
			name: 'read',
			arguments: { path: filePath },
		});
		if (result.success) {
			oldContent = result.output.replace(/\n\n\.\.\. \[truncated\]$/, '');
		}
	} catch {
		oldContent = undefined;
	}

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

/** Soft: shrink older tool results in-place without wiping the turn structure. */
function softCompactToolResults(messages: ChatMessage[], maxChars: number): ChatMessage[] {
	const toolIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') toolIdxs.push(i);
	}
	const keepFull = new Set(toolIdxs.slice(-4));
	return messages.map((m, i) => {
		if (m.role !== 'tool' || keepFull.has(i)) return m;
		const text = typeof m.content === 'string' ? m.content : '';
		if (text.length <= maxChars) return m;
		return {
			...m,
			content:
				text.slice(0, maxChars) +
				`\n…[soft-compacted ${text.length - maxChars} chars]`,
		};
	});
}

/** Mid: collapse older assistant/tool turns into one summary user message. */
function midCompactMessages(messages: ChatMessage[], systemContent: string): ChatMessage[] {
	const system = messages.find(m => m.role === 'system') ?? {
		role: 'system' as const,
		content: systemContent,
	};
	const tailStart = Math.max(1, messages.length - 10);
	const head = messages.slice(1, tailStart);
	const tail = messages.slice(tailStart);
	if (head.length < 4) {
		return softCompactToolResults(messages, 1200);
	}
	const digest = head
		.map(m => {
			const role = m.role;
			const text =
				typeof m.content === 'string'
					? m.content
					: Array.isArray(m.content)
						? m.content.map(p => ('text' in p ? p.text : '')).join(' ')
						: '';
			if (role === 'tool') {
				return `tool:${m.name || '?'}: ${text.slice(0, 180)}`;
			}
			if (role === 'assistant' && m.tool_calls?.length) {
				return `assistant tools: ${m.tool_calls.map(t => t.function.name).join(', ')}`;
			}
			return `${role}: ${text.slice(0, 240)}`;
		})
		.join('\n')
		.slice(0, 3500);

	return [
		{ role: 'system', content: typeof system.content === 'string' ? system.content : systemContent },
		{
			role: 'user',
			content: `### MID-COMPACT DIGEST (older turns)\n${digest}\n\nContinue from the recent messages below.`,
		},
		...tail,
	];
}

async function compactWithLlm(
	opts: AgentLoopOptions,
	system: string,
	previous: ChatMessage[],
	actions: string[],
	history: AgentHistoryMessage[],
	facts: StableFacts,
	stickyExtra = ''
): Promise<ChatMessage[]> {
	const trace = getTrace();
	trace?.record({ type: 'compact', label: 'rolling summary' });
	opts.onActivity?.({ kind: 'compact', label: 'Building rolling summary…' });

	const recentTools = previous
		.filter(m => m.role === 'tool')
		.slice(-6)
		.map(m => `- ${(m.name ?? 'tool')}: ${contentToPlainText(m.content).slice(0, 600)}`)
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
							'Do NOT invent project paths. Canonical paths are provided separately.',
					},
					{
						role: 'user',
						content: [
							`Task: ${opts.task}`,
							formatStableFactsBlock(facts),
							summarizeActionsForLlm(actions),
							recentTools,
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
	});
	opts.onContextBadge?.(packet.badge);

	const prior =
		history.length > 0
			? `Earlier conversation:\n${history
					.slice(-6)
					.map(m => `${m.role}: ${truncateHistory(m.content, 800)}`)
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
				`Rolling summary (narrative):\n${rolling}`,
				recentTools ? `\nRecent tools:\n${recentTools}` : '',
				``,
				'### AFTER COMPACT — Cursor-style',
				'STABLE FACTS above are canonical. Do NOT invent sibling folders at workspace root.',
				'Do NOT re-read files you already have. Prefer write + shell (build) now.',
				'Continue from here. Obey STABLE FACTS paths.',
				stickyExtra,
			]
				.filter(Boolean)
				.join('\n'),
		},
	];
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
	messages: ChatMessage[]
): Promise<{
	ok: boolean;
	status: number;
	errorText: string;
	data: {
		choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			input_tokens?: number;
			output_tokens?: number;
		};
	};
}> {
	if (isNativeAnthropic(opts)) {
		return postAnthropicRound(opts, messages);
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
			max_tokens: 8192,
			stream: false,
			...(opts.proseToolsOnly
				? {}
				: { tools: AGENT_TOOLS, tool_choice: 'auto' as const }),
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
	choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
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

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === '[DONE]') continue;
		let chunk: {
			usage?: { prompt_tokens?: number; completion_tokens?: number };
			choices?: Array<{
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
				choices: [{ message: { content: null, tool_calls: lifted } }],
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
			},
		],
		usage,
	};
}

async function postAnthropicRound(
	opts: AgentLoopOptions,
	messages: ChatMessage[]
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

	const tools = AGENT_TOOLS.map(t => ({
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
			max_tokens: 8192,
			system: system || undefined,
			messages: converted,
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

async function evaluateProgress(
	opts: AgentLoopOptions,
	actions: string[],
	priorReviews: string[]
): Promise<ProgressEval> {
	const writes = actions.filter(a => a.startsWith('write ')).length;
	const fails = actions.filter(a => a.includes('failed') || a.includes('blocked')).length;
	const cached = actions.filter(a => a.includes('cached')).length;
	const reads = actions.filter(a => a.startsWith('read ') || a.startsWith('list ')).length;
	const shellFails = actions.filter(a => a === 'shell failed').length;
	const exploreSpin = writes === 0 && reads >= 3;
	const heuristicBlocked = (fails > writes + 3 && writes < 2) || (shellFails >= 1 && writes === 0 && reads >= 8);
	const heuristicPositive = writes >= 2 && fails <= writes;
	const heuristicNegative = exploreSpin || (writes === 0 && shellFails >= 1);

	const fallback: ProgressEval = heuristicBlocked
		? {
				verdict: 'blocked',
				cause: `Muitas falhas (${fails}) com pouco progresso de write (${writes}).`,
				path: compactActionPath(actions),
				summary: 'O agent parece preso sem conseguir avançar na implementação.',
				proposals: [
					{
						id: 'simplify',
						title: 'Simplificar: completar só o mínimo (1 página + build)',
						detail: 'Parar de explorar; escrever o essencial e correr dotnet build.',
					},
					{
						id: 'inspect',
						title: 'Inspecionar erros de build/diagnostics primeiro',
						detail: 'Correr diagnostics e shell build; corrigir erros antes de novos writes.',
					},
					{
						id: 'resume-writes',
						title: 'Continuar writes com paths relativos ao workspace',
						detail: 'Evitar paths absolutos e re-reads; focar em ficheiros em falta.',
					},
				],
			}
		: heuristicPositive
			? {
					verdict: 'positive',
					cause: `${writes} writes com falhas controladas (${fails}).`,
					path: compactActionPath(actions),
					summary: 'Há progresso concreto em ficheiros; continuar.',
				}
			: heuristicNegative
				? {
						verdict: 'negative',
						cause:
							shellFails > 0
								? `Build/shell falhou e ainda não houve writes para corrigir (reads=${reads}).`
								: `Só exploração (reads/lists=${reads}) sem writes — missão de implementação não avançou.`,
						path: compactActionPath(actions),
						summary:
							'Parar reads. Corrigir *.cshtml (aspas, ValidationMessageFor, href) com write, depois dotnet build e dotnet run.',
					}
				: {
						verdict: 'negative',
						cause: `Progresso fraco: writes=${writes}, fails=${fails}, cached=${cached}.`,
						path: compactActionPath(actions),
						summary: 'Reanalisar objetivo e mudar de estratégia.',
					};

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
				max_tokens: 512,
				messages: [
					{
						role: 'system',
						content:
							'You evaluate coding-agent progress. Reply ONLY valid JSON with keys: ' +
							'verdict ("positive"|"negative"|"blocked"|"done"), cause, path, summary, ' +
							'proposals (optional array of {id,title,detail}). No markdown. ' +
							'Keep cause/path/summary short (one line each). Do not list every tool call.',
					},
					{
						role: 'user',
						content: [
							`Task: ${opts.task}`,
							summarizeActionsForLlm(actions),
							`Recent path: ${compactActionPath(actions)}`,
							priorReviews.length
								? `Prior reviews: ${priorReviews.slice(-3).join(' | ')}`
								: '',
							'Rules:',
							'- positive = clear forward progress (useful writes/builds), continue',
							'- negative = spinning/re-reading/little value, needs replan',
							'- blocked = cannot proceed without user decision',
							'- done = task objective already satisfied',
						]
							.filter(Boolean)
							.join('\n'),
					},
				],
			}),
		});
		if (!res.ok) {
			return fallback;
		}
		const data = await readChatCompletionResponse(res);
		const text = data.choices?.[0]?.message?.content ?? '';
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return fallback;
		}
		const parsed = JSON.parse(jsonMatch[0]) as ProgressEval;
		if (!parsed.verdict || !parsed.cause || !parsed.path) {
			return fallback;
		}
		if (!['positive', 'negative', 'blocked', 'done'].includes(parsed.verdict)) {
			return fallback;
		}
		return {
			verdict: parsed.verdict,
			cause: String(parsed.cause),
			path: String(parsed.path),
			summary: String(parsed.summary ?? ''),
			proposals: Array.isArray(parsed.proposals)
				? parsed.proposals.map((p, i) => ({
						id: String(p.id ?? `opt${i}`),
						title: String(p.title ?? `Option ${i + 1}`),
						detail: String(p.detail ?? ''),
					}))
				: fallback.proposals,
		};
	} catch {
		return fallback;
	}
}

async function buildReplanPrompt(
	opts: AgentLoopOptions,
	evaluation: ProgressEval,
	actions: string[],
	reason: string
): Promise<string> {
	return [
		'REPLAN REQUIRED — STOP EXPLORING. EXECUTE NOW.',
		`Reason: ${reason}`,
		`Cause of deviation: ${evaluation.cause}`,
		`Evaluation summary: ${evaluation.summary}`,
		`Original task: ${opts.task}`,
		summarizeActionsForLlm(actions),
		`Recent path: ${compactActionPath(actions)}`,
		'',
		'MANDATORY next tool calls (no prose-only turns):',
		'1) write — fix broken files (especially *.cshtml compile errors).',
		'2) shell — `dotnet build` in the project folder.',
		'3) on build success — `dotnet run` (long-running handoff is OK).',
		'',
		'Razor/.NET fixes that usually unblock this project:',
		'- Strings in Razor C# must use double quotes: href="/funcionarios" NOT \'/funcionarios\' (CS1012).',
		'- Use Html.ValidationMessageFor(...) — ValidationFor does not exist (CS1061).',
		'- Do not invent PagePath(...); use plain href="/..." or asp-page.',
		'- FuncionarioViewModel already exists at ViewModels/FuncionarioViewModel.cs — do not recreate under Models/.',
		'- This app uses Razor Pages (Program.cs AddRazorPages), not the obsolete Microsoft.AspNetCore.Blazor.WebAssembly package.',
		'',
		'FORBIDDEN for the next several steps: read / list / search (they will be blocked).',
		'If a file content is unknown, write a complete correct version anyway based on the build errors.',
	].join('\n');
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

/**
 * Universal tool-protocol hygiene for all providers (OpenAI-compat + Anthropic):
 * 1) Fill missing tool results for any assistant tool_calls.
 * 2) Reorder so tool results sit contiguously right after their assistant turn
 *    (no user nudges interleaved between tool messages).
 */
function normalizeToolProtocolHistory(messages: ChatMessage[]): number {
	let changes = repairMissingToolResults(messages);
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
		const ids = new Set(m.tool_calls.map(tc => tc.id));
		const tools: ChatMessage[] = [];
		const others: ChatMessage[] = [];
		let j = i + 1;
		while (j < messages.length && messages[j].role !== 'assistant') {
			const n = messages[j];
			if (n.role === 'tool' && n.tool_call_id && ids.has(n.tool_call_id)) {
				tools.push(n);
			} else {
				others.push(n);
			}
			j++;
		}
		const byId = new Map(tools.map(t => [t.tool_call_id as string, t]));
		const orderedTools: ChatMessage[] = [];
		for (const tc of m.tool_calls) {
			const hit = byId.get(tc.id);
			if (hit) orderedTools.push(hit);
		}
		for (const t of tools) {
			if (!orderedTools.includes(t)) orderedTools.push(t);
		}
		const slice = [...orderedTools, ...others];
		const current = messages.slice(i + 1, j);
		const same =
			current.length === slice.length && current.every((c, idx) => c === slice[idx]);
		if (!same) {
			messages.splice(i + 1, j - (i + 1), ...slice);
			changes += 1;
		}
	}
	return changes;
}

/** Repair orphaned tool_use / tool_call ids across the full history. */
function repairMissingToolResults(messages: ChatMessage[]): number {
	let repaired = 0;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
		const have = new Set<string>();
		for (let j = i + 1; j < messages.length; j++) {
			const next = messages[j];
			if (next.role === 'assistant') break;
			if (next.role === 'tool' && next.tool_call_id) {
				have.add(next.tool_call_id);
			}
		}
		const missing = m.tool_calls.filter(tc => !have.has(tc.id));
		if (!missing.length) continue;
		const stubs: ChatMessage[] = missing.map(tc => ({
			role: 'tool' as const,
			tool_call_id: tc.id,
			name: tc.function.name,
			content: 'Skipped: tool result was missing from history (repaired).',
		}));
		messages.splice(i + 1, 0, ...stubs);
		repaired += stubs.length;
		i += stubs.length;
	}
	return repaired;
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

/** Compact action stats for LLM context (not a raw tool log). */
function summarizeActionsForLlm(actions: string[]): string {
	if (!actions.length) {
		return 'Progress: (no tools yet)';
	}
	const writes = actions.filter(a => a.startsWith('write '));
	const deletes = actions.filter(a => a.startsWith('delete '));
	const shellsOk = actions.filter(
		a => a.startsWith('shell ') && a !== 'shell failed' && !/blocked|denied|threw/.test(a)
	);
	const fails = actions.filter(a => /failed|blocked|denied|threw/.test(a));
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

/** Collapse consecutive duplicate actions into a short path for checkpoints. */
function compactActionPath(actions: string[], max = 8): string {
	if (!actions.length) {
		return '(sem actions)';
	}
	const parts: Array<{ text: string; n: number }> = [];
	for (const a of actions) {
		const text = shortenActionLabel(a);
		const last = parts[parts.length - 1];
		if (last && last.text === text) {
			last.n += 1;
		} else {
			parts.push({ text, n: 1 });
		}
	}
	return parts
		.slice(-max)
		.map(p => (p.n > 1 ? `${p.text}×${p.n}` : p.text))
		.join(' → ');
}

function shortenActionLabel(a: string): string {
	if (a === 'shell failed') return 'shell failed';
	if (/blocked/.test(a)) {
		return a.replace(/\s*\([^)]*\)/g, '').slice(0, 40);
	}
	if (a.startsWith('write ')) {
		const p = a.slice(6).replace(/\\/g, '/');
		const bits = p.split('/').filter(Boolean);
		return `write ${bits.slice(-2).join('/')}`;
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
	return args;
}

/** Shell exit≠0 must not be cached as success / treated as OK progress. */
function isToolSuccess(name: string, output: string): boolean {
	if (output.startsWith('Error:')) {
		return false;
	}
	if (name === 'shell') {
		const m = /^exit\s+(\d+)/m.exec(output);
		if (m && Number(m[1]) !== 0) {
			return false;
		}
	}
	return true;
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
