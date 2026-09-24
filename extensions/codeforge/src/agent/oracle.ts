/**
 * Oracle: the project's own build/test decides when work is done.
 * Detection + parsing are pure (fs is injected) so they are unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface OracleError {
	file: string;
	line: number;
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
	commands: string[];
	source: 'oracle.json' | 'dotnet' | 'npm';
}

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

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.CodeForge', 'TestResults']);

function quote(p: string): string {
	return /\s/.test(p) ? `"${p}"` : p;
}

/** csproj files up to `depth` levels below root (relative, forward slashes). */
function findProjects(root: string, fsx: OracleFs, depth = 3): string[] {
	const out: string[] = [];
	const walk = (rel: string, d: number) => {
		const abs = rel ? path.join(root, rel) : root;
		for (const name of fsx.list(abs)) {
			if (SKIP_DIRS.has(name)) continue;
			const childRel = rel ? `${rel}/${name}` : name;
			if (name.toLowerCase().endsWith('.csproj')) out.push(childRel);
			else if (d > 0 && fsx.isDir(path.join(abs, name))) walk(childRel, d - 1);
		}
	};
	walk('', depth);
	return out.sort();
}

function isTestProject(rel: string, fsx: OracleFs, root: string): boolean {
	if (/tests?\b|\.tests?\.csproj$/i.test(rel)) return true;
	const text = fsx.readText(path.join(root, rel)) ?? '';
	return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true/i.test(text);
}

/** Pick the build/test commands for a workspace (override: .CodeForge/oracle.json). */
export function detectOracle(root: string | undefined, fsx: OracleFs): OracleConfig | undefined {
	if (!root) return undefined;
	const override = fsx.readText(path.join(root, '.CodeForge', 'oracle.json'));
	if (override) {
		try {
			const cfg = JSON.parse(override) as { commands?: unknown; command?: unknown };
			const commands = Array.isArray(cfg.commands)
				? cfg.commands.map(String).filter(Boolean)
				: typeof cfg.command === 'string' && cfg.command.trim()
					? [cfg.command.trim()]
					: [];
			if (commands.length) return { commands, source: 'oracle.json' };
		} catch {
			/* fall through to detection */
		}
	}

	const top = fsx.list(root);
	const solution =
		top.find(n => n.toLowerCase().endsWith('.slnx')) ?? top.find(n => n.toLowerCase().endsWith('.sln'));
	if (solution) {
		return {
			source: 'dotnet',
			commands: [
				`dotnet build ${quote(solution)} -nologo -v q`,
				`dotnet test ${quote(solution)} --no-build -nologo -v q`,
			],
		};
	}
	const projects = findProjects(root, fsx);
	if (projects.length) {
		const tests = projects.filter(p => isTestProject(p, fsx, root));
		const commands = projects.map(p => `dotnet build ${quote(p)} -nologo -v q`);
		for (const t of tests) commands.push(`dotnet test ${quote(t)} --no-build -nologo -v q`);
		return { source: 'dotnet', commands };
	}

	const pkgText = fsx.readText(path.join(root, 'package.json'));
	if (pkgText) {
		try {
			const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
			const scripts = pkg.scripts ?? {};
			const commands: string[] = [];
			if (scripts.build) commands.push('npm run build --silent');
			if (scripts.test && !/no test specified/i.test(scripts.test)) commands.push('npm test --silent');
			if (commands.length) return { source: 'npm', commands };
		} catch {
			/* invalid package.json — no oracle */
		}
	}
	return undefined;
}

/** Structured compiler errors (CS/RZ/MSB/NU/NETSDK) from dotnet output, deduplicated. */
export function parseDotnetErrors(output: string): OracleError[] {
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
		const withFile = /^(.+?)\((\d+)(?:,\d+)?\):\s*error\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
		if (withFile) {
			push({
				file: withFile[1].replace(/\\/g, '/'),
				line: Number(withFile[2]),
				code: withFile[3],
				msg: withFile[4].trim(),
			});
			continue;
		}
		const noFile = /^(?:(.+?)\s*:\s*)?error\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
		if (noFile) {
			push({ file: (noFile[1] ?? '').replace(/\\/g, '/'), line: 0, code: noFile[2], msg: noFile[3].trim() });
		}
	}
	return errors;
}

/** Failed test names from dotnet test / node --test / jest output. */
export function parseFailedTests(output: string): string[] {
	const text = String(output || '');
	const names = new Set<string>();
	for (const m of text.matchAll(/^\s*Failed\s+([\w.`<>,]+(?:\([^)]*\))?)\s*\[/gm)) names.add(m[1]);
	for (const m of text.matchAll(/^\s*not ok \d+ - (.+)$/gm)) names.add(m[1].trim());
	for (const m of text.matchAll(/^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm)) names.add(m[1].trim());
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
				errors: parseDotnetErrors(output),
				failedTests: parseFailedTests(output),
				output,
				durationMs: Date.now() - started,
			};
		}
	}
	return { ok: true, commands, errors: [], failedTests: [], output, durationMs: Date.now() - started };
}

/** Oracle result as the model sees it: status, structured errors, failed tests. */
export function formatOracleResult(r: OracleResult, reason: string): string {
	const last = r.commands[r.commands.length - 1] ?? '';
	if (r.ok) {
		return `### Oracle (${reason}): GREEN\nRan: ${r.commands.join(' → ')}`;
	}
	const lines = [`### Oracle (${reason}): RED`, `Failed: ${last}`];
	if (r.errors.length) {
		lines.push(`Errors (${r.errors.length}):`);
		for (const e of r.errors.slice(0, 25)) {
			lines.push(`- ${e.file ? `${e.file}${e.line ? `:${e.line}` : ''} ` : ''}${e.code} ${e.msg}`);
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
	}
	return lines.join('\n');
}
