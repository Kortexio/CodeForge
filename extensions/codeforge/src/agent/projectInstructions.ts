/**
 * Detect, generate, and load workspace AGENTS.md for the system prompt.
 */

import * as vscode from 'vscode';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';
import { AiSettingsStore } from '../settings/aiSettingsStore';
import { getGovernanceStore } from '../governance/governanceStore';

const AGENTS_FILE = 'AGENTS.md';
const MAX_INJECT_CHARS = 12_000;

export async function agentsMdUri(): Promise<vscode.Uri | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return undefined;
	return vscode.Uri.joinPath(folder.uri, AGENTS_FILE);
}

export async function agentsMdExists(): Promise<boolean> {
	const uri = await agentsMdUri();
	if (!uri) return false;
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export async function readAgentsMd(): Promise<string | undefined> {
	const uri = await agentsMdUri();
	if (!uri) return undefined;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8').trim();
		if (!text) return undefined;
		return text.length > MAX_INJECT_CHARS ? text.slice(0, MAX_INJECT_CHARS) + '\n…' : text;
	} catch {
		return undefined;
	}
}

export async function loadAgentsMdForPrompt(): Promise<string> {
	const text = await readAgentsMd();
	if (!text) return '';
	return `## Project instructions (AGENTS.md)\n${text}`;
}

async function gatherProjectSignals(bridge: VSCodeAIBridge): Promise<string> {
	const root = bridge.getWorkspaceRoot();
	const parts: string[] = [`Workspace: ${root ?? '(none)'}`];

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return parts.join('\n');

	const tryRead = async (rel: string, max = 4000): Promise<string | undefined> => {
		try {
			const uri = vscode.Uri.joinPath(folder.uri, rel);
			const bytes = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(bytes).toString('utf8').slice(0, max);
		} catch {
			return undefined;
		}
	};

	const readme = (await tryRead('README.md')) || (await tryRead('readme.md'));
	if (readme) parts.push(`### README.md\n\`\`\`\n${readme}\n\`\`\``);

	const pkg = await tryRead('package.json', 2500);
	if (pkg) parts.push(`### package.json\n\`\`\`json\n${pkg}\n\`\`\``);

	const list = await bridge.execute({
		id: 'agents-list',
		name: 'list',
		arguments: { path: '.', recursive: false },
	});
	if (list.success && list.output) {
		parts.push(`### Top-level listing\n\`\`\`\n${list.output.slice(0, 3000)}\n\`\`\``);
	}

	return parts.join('\n\n');
}

export async function generateAgentsMd(opts: {
	bridge: VSCodeAIBridge;
	store: AiSettingsStore;
	abortSignal?: AbortSignal;
}): Promise<{ path: string; created: boolean; content: string }> {
	const uri = await agentsMdUri();
	if (!uri) {
		throw new Error('Open a folder before generating AGENTS.md');
	}

	const exists = await agentsMdExists();
	if (exists) {
		const choice = await vscode.window.showWarningMessage(
			'AGENTS.md already exists. Overwrite?',
			{ modal: true },
			'Overwrite',
			'Cancel'
		);
		if (choice !== 'Overwrite') {
			const current = (await readAgentsMd()) || '';
			return { path: AGENTS_FILE, created: false, content: current };
		}
	}

	const signals = await gatherProjectSignals(opts.bridge);
	const { server, model } = opts.store.getActiveSelection();
	const cfg = vscode.workspace.getConfiguration('codeforge.ai');
	const provider = server?.kind ?? cfg.get<string>('provider') ?? 'openai';
	const apiKey = server?.apiKey ?? cfg.get<string>('apiKey') ?? '';
	const activeModel = model ?? cfg.get<string>('model') ?? 'gpt-4o';
	const baseUrl =
		server?.baseUrl ||
		cfg.get<string>('baseUrl') ||
		(provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1');

	const system =
		'You write AGENTS.md files for coding agents. Output ONLY markdown (no fences). ' +
		'Include: project overview, stack, how to build/test/run, key directories, conventions, ' +
		'and do/dont rules for an AI coding agent. Keep it under 250 lines.';

	const user = `Generate AGENTS.md for this workspace.\n\n${signals}`;

	let content: string;
	if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
		content = fallbackAgentsMd(signals);
	} else if (provider === 'anthropic') {
		content = await callAnthropic(apiKey, activeModel, system, user, opts.abortSignal);
	} else {
		content = await callOpenAiCompat(
			baseUrl,
			apiKey,
			provider === 'ollama' ? activeModel || 'llama3.2' : activeModel,
			system,
			user,
			opts.abortSignal
		);
	}

	content = content.trim().replace(/^```(?:markdown)?\n?/i, '').replace(/\n?```$/i, '').trim();
	if (!content.startsWith('#')) {
		content = `# Agent instructions\n\n${content}`;
	}

	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

	try {
		const gov = getGovernanceStore();
		const summary = content.slice(0, 2500);
		await gov.upsert({
			id: 'rule.project-agents-md',
			kind: 'rule',
			title: 'Project instructions (AGENTS.md)',
			description: 'Mirrors workspace AGENTS.md for the agent prompt',
			content: summary,
			enabled: true,
			builtin: false,
			updatedAt: new Date().toISOString(),
		});
	} catch {
		/* governance optional */
	}

	return { path: AGENTS_FILE, created: true, content };
}

function fallbackAgentsMd(signals: string): string {
	return [
		'# Agent instructions',
		'',
		'## Overview',
		'Project instructions were generated without an API key. Expand this file with stack, build, and conventions.',
		'',
		'## Workspace snapshot',
		signals.slice(0, 4000),
		'',
		'## Rules for the agent',
		'- Prefer relative paths from the workspace root.',
		'- Ask before destructive shell commands.',
		'- Make small, focused edits; verify with build/test when available.',
	].join('\n');
}

async function callOpenAiCompat(
	baseUrl: string,
	apiKey: string,
	model: string,
	system: string,
	user: string,
	signal?: AbortSignal
): Promise<string> {
	const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		signal,
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			temperature: 0.2,
			max_tokens: 4096,
			stream: false,
		}),
	});
	if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content ?? fallbackAgentsMd(user);
}

async function callAnthropic(
	apiKey: string,
	model: string,
	system: string,
	user: string,
	signal?: AbortSignal
): Promise<string> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		signal,
		body: JSON.stringify({
			model: model.includes('claude') ? model : 'claude-3-5-sonnet-20241022',
			max_tokens: 4096,
			system,
			messages: [{ role: 'user', content: user }],
		}),
	});
	if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
	return data.content?.find(c => c.type === 'text')?.text ?? fallbackAgentsMd(user);
}
