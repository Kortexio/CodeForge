/**
 * Cursor-like agent hooks (minimal).
 *
 * Project: {workspace}/.CodeForge/hooks.json + hooks/*
 * User:    ~/.CodeForge/hooks.json + hooks/*
 *
 * Events: preToolUse, beforeShellExecution
 * Handlers: type "command" — script gets JSON on stdin, returns JSON on stdout.
 * Fail-open: errors / missing scripts allow the tool.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type HookEvent = 'preToolUse' | 'beforeShellExecution';

export type HookPermission = 'allow' | 'deny';

export interface HookResult {
	permission: HookPermission;
	userMessage?: string;
}

export interface HookPayload {
	event: HookEvent;
	tool: string;
	args: Record<string, unknown>;
	command?: string;
	workspaceRoot?: string;
}

interface HookCommand {
	type?: 'command';
	command: string;
	args?: string[];
	/** Optional regex matched against tool name (preToolUse) or shell command. */
	matcher?: string;
	timeoutMs?: number;
}

interface HooksFile {
	version?: number;
	hooks?: Partial<Record<HookEvent, HookCommand[]>>;
}

export async function runAgentHooks(
	event: HookEvent,
	payload: Omit<HookPayload, 'event'>,
	log?: (line: string) => void
): Promise<HookResult> {
	const configs = await loadHookConfigs();
	const handlers = configs.flatMap(c => c.hooks?.[event] ?? []);
	if (!handlers.length) {
		return { permission: 'allow' };
	}

	const full: HookPayload = { event, ...payload };
	for (const h of handlers) {
		if (h.matcher) {
			try {
				const rx = new RegExp(h.matcher, 'i');
				const subject =
					event === 'beforeShellExecution'
						? String(payload.command ?? payload.args.command ?? '')
						: payload.tool;
				if (!rx.test(subject)) continue;
			} catch {
				log?.(`[hooks] invalid matcher: ${h.matcher}`);
				continue;
			}
		}
		const result = await runCommandHook(h, full, log);
		if (result.permission === 'deny') {
			return result;
		}
	}
	return { permission: 'allow' };
}

async function loadHookConfigs(): Promise<HooksFile[]> {
	const paths: string[] = [path.join(os.homedir(), '.CodeForge', 'hooks.json')];
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (ws) {
		paths.push(path.join(ws, '.CodeForge', 'hooks.json'));
	}
	const out: HooksFile[] = [];
	for (const p of paths) {
		try {
			const raw = await fs.readFile(p, 'utf8');
			const parsed = JSON.parse(raw) as HooksFile;
			if (parsed && typeof parsed === 'object') {
				out.push(parsed);
			}
		} catch {
			/* missing / invalid — skip */
		}
	}
	return out;
}

async function runCommandHook(
	hook: HookCommand,
	payload: HookPayload,
	log?: (line: string) => void
): Promise<HookResult> {
	const cwd =
		payload.workspaceRoot ||
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
		os.homedir();
	const timeoutMs = hook.timeoutMs ?? 15_000;
	const args = (hook.args ?? []).map(a =>
		a.replace(/^\.\//, path.join(cwd, '.CodeForge') + path.sep).replace(/\\/g, path.sep)
	);

	return new Promise(resolve => {
		let settled = false;
		const finish = (r: HookResult) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};

		let child;
		try {
			child = spawn(hook.command, args, {
				cwd,
				shell: true,
				windowsHide: true,
				env: { ...process.env, CODEFORGE_HOOK_EVENT: payload.event },
			});
		} catch (err) {
			log?.(
				`[hooks] spawn failed (${payload.event}): ${err instanceof Error ? err.message : String(err)}`
			);
			finish({ permission: 'allow' });
			return;
		}

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString('utf8');
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString('utf8');
		});

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			log?.(`[hooks] timeout ${payload.event} (${timeoutMs}ms) — fail-open`);
			finish({ permission: 'allow' });
		}, timeoutMs);

		child.on('error', err => {
			clearTimeout(timer);
			log?.(`[hooks] error ${payload.event}: ${err.message} — fail-open`);
			finish({ permission: 'allow' });
		});

		child.on('close', code => {
			clearTimeout(timer);
			if (stderr.trim()) {
				log?.(`[hooks] ${payload.event} stderr: ${stderr.trim().slice(0, 200)}`);
			}
			const parsed = parseHookStdout(stdout);
			if (!parsed) {
				if (code && code !== 0) {
					log?.(
						`[hooks] ${payload.event} exit ${code} without JSON — fail-open`
					);
				}
				finish({ permission: 'allow' });
				return;
			}
			// Cursor-like: deny | ask | continue:false → block (fail-closed only on explicit deny).
			const denied =
				parsed.permission === 'deny' ||
				parsed.permission === 'ask' ||
				parsed.continue === false;
			finish({
				permission: denied ? 'deny' : 'allow',
				userMessage:
					typeof parsed.userMessage === 'string'
						? parsed.userMessage
						: typeof parsed.message === 'string'
							? parsed.message
							: undefined,
			});
		});

		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {
			/* ignore */
		}
	});
}

function parseHookStdout(stdout: string): Record<string, unknown> | undefined {
	const text = stdout.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		// last JSON object in output
		const start = text.lastIndexOf('{');
		const end = text.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}
