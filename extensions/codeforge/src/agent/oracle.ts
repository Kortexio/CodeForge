/**
 * Oracle: the workspace's own verification command decides when work is done.
 * The command is declared in `.CodeForge/oracle.json` — by the user, or by the agent after it
 * found how the project builds and tests. Nothing here knows a language or build tool:
 * a command is green when it exits 0.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface OracleError {
	file: string;
	line: number;
	/** Compiler code when the output has one (e.g. CS0246, TS2304, E0425); may be empty. */
	code: string;
	msg: string;
}

export interface OracleResult {
	ok: boolean;
	/** Commands actually run (stops at the first failing one). */
	commands: string[];
	errors: OracleError[];
	failedTests: string[];
	/** Last command output (already clipped by the shell bridge). */
	output: string;
	durationMs: number;
}

export interface OracleConfig {
	/** Run in order from the workspace root; empty when `none` is set. */
	commands: string[];
	/** Recorded reason this workspace has no automated verification. */
	none?: string;
}

export const ORACLE_FILE = '.CodeForge/oracle.json';

export interface OracleFs {
	exists(p: string): boolean;
	readText(p: string): string | undefined;
	/** Entry names of a directory ([] when missing). */
	list(p: string): string[];
	isDir(p: string): boolean;
}

export const nodeOracleFs: OracleFs = {
	exists: p => fs.existsSync(p),
	readText: p => {
		try {
			return fs.readFileSync(p, 'utf8');
		} catch {
			return undefined;
		}
	},
	list: p => {
		try {
			return fs.readdirSync(p);
		} catch {
			return [];
		}
	},
	isDir: p => {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	},
};

/** The declared verification for a workspace (`.CodeForge/oracle.json`), or undefined. */
export function detectOracle(root: string | undefined, fsx: OracleFs): OracleConfig | undefined {
	if (!root) return undefined;
	const text = fsx.readText(path.join(root, ORACLE_FILE));
	if (!text) return undefined;
	try {
		return parseOracleConfig(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** `{ commands: [...] }`, `{ command: "..." }` or `{ none: "reason" }`. */
export function parseOracleConfig(raw: unknown): OracleConfig | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const cfg = raw as { commands?: unknown; command?: unknown; none?: unknown };
	const commands = Array.isArray(cfg.commands)
		? cfg.commands.map(c => String(c).trim()).filter(Boolean)
		: typeof cfg.command === 'string' && cfg.command.trim()
			? [cfg.command.trim()]
			: [];
	if (commands.length) return { commands };
	if (typeof cfg.none === 'string' && cfg.none.trim()) return { commands: [], none: cfg.none.trim() };
	return undefined;
}

export function serializeOracleConfig(cfg: OracleConfig): string {
	const body = cfg.commands.length ? { commands: cfg.commands } : { none: cfg.none ?? '' };
	return `${JSON.stringify(body, null, 2)}\n`;
}

/** The shell could not find the program (cmd.exe 9009, POSIX 127, PowerShell). */
export function commandNotFound(shellOutput: string): boolean {
	const exit = exitCodeOf(shellOutput);
	if (exit === 9009 || exit === 127) return true;
	return /is not recognized as an internal or external command|is not recognized as the name of a cmdlet|: command not found|: not found$/im.test(
		shellOutput
	);
}

/**
 * Compiler-style errors, deduplicated. Two layouts cover most toolchains:
 * `file(line[,col]): error CODE: msg` and `file:line[:col]: error[CODE]: msg`.
 */
export function parseCompilerErrors(output: string): OracleError[] {
	const errors: OracleError[] = [];
	const seen = new Set<string>();
	const push = (e: OracleError) => {
		const key = `${e.file}:${e.line}:${e.code}:${e.msg}`;
		if (seen.has(key)) return;
		seen.add(key);
		errors.push(e);
	};
	for (const raw of String(output || '').split(/\r?\n/)) {
		const line = raw.trim();
		const paren = /^(.+?)\((\d+)(?:,\d+)?\):\s*(?:fatal\s+)?error\s+([A-Za-z]+\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
		if (paren) {
			push({ file: paren[1].replace(/\\/g, '/'), line: Number(paren[2]), code: paren[3], msg: paren[4].trim() });
			continue;
		}
		const colon = /^(.+?):(\d+)(?::\d+)?:\s*(?:fatal\s+)?error(?:\[([A-Za-z]*\d+)\])?:?\s*(.+)$/.exec(line);
		if (colon && !/^https?$/i.test(colon[1])) {
			push({ file: colon[1].replace(/\\/g, '/'), line: Number(colon[2]), code: colon[3] ?? '', msg: colon[4].trim() });
			continue;
		}
		const noFile = /^(?:(.+?)\s*:\s*)?error\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
		if (noFile) {
			push({ file: (noFile[1] ?? '').replace(/\\/g, '/'), line: 0, code: noFile[2], msg: noFile[3].trim() });
		}
	}
	return errors;
}

/** Failed test names from common runner layouts (TAP, xUnit/NUnit, jest/vitest, pytest, go test). */
export function parseFailedTests(output: string): string[] {
	const text = String(output || '');
	const names = new Set<string>();
	for (const m of text.matchAll(/^\s*Failed\s+([\w.`<>,]+(?:\([^)]*\))?)\s*\[/gm)) names.add(m[1]);
	for (const m of text.matchAll(/^\s*not ok \d+ - (.+)$/gm)) names.add(m[1].trim());
	for (const m of text.matchAll(/^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm)) names.add(m[1].trim());
	for (const m of text.matchAll(/^FAILED\s+(\S+::\S+)/gm)) names.add(m[1]);
	for (const m of text.matchAll(/^\s*--- FAIL:\s+(\S+)/gm)) names.add(m[1]);
	return [...names].slice(0, 30);
}

export function exitCodeOf(shellOutput: string): number {
	const m = /^exit\s+(\d+)/m.exec(shellOutput);
	return m ? Number(m[1]) : 0;
}

/** Run the configured commands in order, stopping at the first failure. */
export async function runOracle(
	cfg: OracleConfig,
	run: (command: string) => Promise<string>
): Promise<OracleResult> {
	const started = Date.now();
	const commands: string[] = [];
	let output = '';
	for (const command of cfg.commands) {
		commands.push(command);
		output = await run(command);
		const exit = exitCodeOf(output);
		if (exit !== 0) {
			return {
				ok: false,
				commands,
				errors: parseCompilerErrors(output),
				failedTests: parseFailedTests(output),
				output,
				durationMs: Date.now() - started,
			};
		}
	}
	return { ok: true, commands, errors: [], failedTests: [], output, durationMs: Date.now() - started };
}

/** Oracle result as the model sees it: status, parsed errors and failed tests, then the output. */
export function formatOracleResult(r: OracleResult, reason: string): string {
	const last = r.commands[r.commands.length - 1] ?? '';
	if (r.ok) {
		return `### Oracle (${reason}): GREEN\nRan: ${r.commands.join(' → ')}`;
	}
	const lines = [`### Oracle (${reason}): RED`, `Failed: ${last}`];
	if (r.errors.length) {
		lines.push(`Errors (${r.errors.length}):`);
		for (const e of r.errors.slice(0, 25)) {
			lines.push(`- ${e.file ? `${e.file}${e.line ? `:${e.line}` : ''} ` : ''}${e.code ? `${e.code} ` : ''}${e.msg}`);
		}
		if (r.errors.length > 25) lines.push(`…[+${r.errors.length - 25} errors omitted]`);
	}
	if (r.failedTests.length) {
		lines.push(`Failed tests (${r.failedTests.length}):`, ...r.failedTests.map(t => `- ${t}`));
	}
	if (!r.errors.length && !r.failedTests.length) {
		lines.push('Output:', r.output);
	} else if (r.failedTests.length) {
		const detail = /Error Message:[\s\S]{0,1500}/.exec(r.output)?.[0];
		if (detail) lines.push('First failure detail:', detail.trim());
		else lines.push('Output:', r.output);
	}
	return lines.join('\n');
}
