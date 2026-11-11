/**
 * Sandbox runtime — shell isolation levels without Docker by default.
 */

import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { killProcessTree } from './processKill';
import { isWinJobAvailable, spawnInWinJob } from './winJob';

export type SandboxLevel =
	| 'safe-local'
	| 'restricted'
	| 'isolated'
	| 'container'
	/** No env scrubbing, no blocked-command patterns. Still runs in the workspace cwd. */
	| 'unrestricted';

export const SANDBOX_LEVELS: SandboxLevel[] = [
	'safe-local',
	'restricted',
	'isolated',
	'container',
	'unrestricted',
];

/**
 * cmd.exe spawn args that keep inner double quotes intact.
 * Without verbatim args Node escapes `"` as `\"`, which cmd passes through literally,
 * so `node -e "..."` evaluates a string literal and exits 0 without running anything.
 */
export function cmdExeSpawn(command: string): { args: string[]; windowsVerbatimArguments: true } {
	return { args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
}

export function isSandboxLevel(value: unknown): value is SandboxLevel {
	return typeof value === 'string' && (SANDBOX_LEVELS as string[]).includes(value);
}

export interface SandboxOptions {
	cwd: string;
	command: string;
	shell?: string;
	args?: string[];
	level?: SandboxLevel;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	abortSignal?: AbortSignal;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface SandboxResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	level: SandboxLevel;
	aborted?: boolean;
	timedOut?: boolean;
}

const SAFE_PREFIXES = [
	'git status',
	'git log',
	'git diff',
	'git branch',
	'git blame',
	'dotnet --info',
	'dotnet build',
	'dotnet test',
	'dotnet restore',
	'dotnet list',
	'npm --version',
	'npm test',
	'npm run',
	'node --version',
	'dir',
	'ls',
	'echo',
	'type',
	'cat',
	'rg ',
	'findstr',
];

const BLOCKED_PATTERNS = [
	/\brm\s+-rf\s+(?:~|\.\.|[\\/])/i,
	/\brm\s+-rf\s+[\\/]/i,
	/\brd\s+\/s\b/i,
	/\brmdir\s+\/s\b/i,
	/\bremove-item\b[^\n\r;|&]*-recurse\b/i,
	/\bdel(?:ete)?\b(?:[^\n\r;|&]*\/[fqs]){2,}/i,
	/\bformat\s+[a-z]:/i,
	/\bshutdown\b/i,
	/\breg\s+delete\b/i,
	/\bcurl\s+.*\|\s*(sh|bash|powershell)/i,
	/\bwget\s+.*\|\s*(sh|bash)/i,
	/\biex\b/i,
	/\binvoke-expression\b/i,
	/\binvoke-webrequest\b[^\n\r;|&]*\|\s*/i,
	/\biwr\b[^\n\r;|&]*\|\s*/i,
	/\bdownloadstring\b/i,
	/\bdownloadfile\b/i,
	/\bfrombase64string\b/i,
	/\bstart-process\b[^\n\r;|&]*-verb\s+runas\b/i,
	/\bcertutil\b[^\n\r;|&]*-decode\b/i,
	/\bbscript\b/i,
	/\bcscript\b/i,
	/\bpowershell\b[^\n\r;|&]*-enc(?:odedcommand)?\b/i,
	/\bpowershell\b[^\n\r;|&]*-e\s+[A-Za-z0-9+/=]{20,}/i,
];

export function hasShellChaining(command: string): boolean {
	return /(?:&&|\|\||\||;)/.test(command);
}

const SECRET_ENV_KEYS = [
	/api[_-]?key/i,
	/secret/i,
	/token/i,
	/password/i,
	/credential/i,
	/^AWS_/i,
	/^AZURE_/i,
	/^OPENAI_/i,
	/^ANTHROPIC_/i,
	/^GITHUB_TOKEN$/i,
	/^GH_TOKEN$/i,
	/^NPM_TOKEN$/i,
	/^CODEFORGE_/i,
];

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (SECRET_ENV_KEYS.some(re => re.test(k))) continue;
		out[k] = v;
	}
	// Keep PATH / system essentials
	for (const keep of [
		'PATH',
		'Path',
		'PATHEXT',
		'SystemRoot',
		'USERPROFILE',
		'HOME',
		'TEMP',
		'TMP',
		'LANG',
		'ComSpec',
		'COMSPEC',
	]) {
		if (env[keep] !== undefined) out[keep] = env[keep];
	}
	return out;
}

export function isSafeLocalCommand(command: string): boolean {
	const c = command.trim().toLowerCase();
	return SAFE_PREFIXES.some(p => c.startsWith(p.toLowerCase()));
}

export function isBlockedCommand(command: string): string | undefined {
	for (const re of BLOCKED_PATTERNS) {
		if (re.test(command)) return `Blocked by sandbox policy: ${re}`;
	}
	return undefined;
}

export function pickSandboxLevel(_command: string, configured: SandboxLevel | undefined): SandboxLevel {
	return configured ?? 'restricted';
}

/**
 * Resolve the effective sandbox level from `codeforge.ai.shellSandbox` only.
 * `fullAgentFreedom` always wins as unrestricted.
 */
export function resolveSandboxLevel(
	command: string,
	opts?: {
		configured?: string | null;
		fullFreedom?: boolean;
	}
): SandboxLevel {
	if (opts?.fullFreedom) return 'unrestricted';
	const configured = isSandboxLevel(opts?.configured) ? opts.configured : 'restricted';
	return pickSandboxLevel(command, configured);
}

export async function runSandboxed(opts: SandboxOptions): Promise<SandboxResult> {
	const level = opts.level ?? 'restricted';
	const blocked = level === 'unrestricted' ? undefined : isBlockedCommand(opts.command);
	if (blocked && level !== 'container') {
		return {
			exitCode: 126,
			stdout: '',
			stderr: blocked,
			level,
		};
	}

	if (level === 'safe-local' && hasShellChaining(opts.command)) {
		return {
			exitCode: 126,
			stdout: '',
			stderr: 'safe-local refuses command chaining (&, &&, |, ;). Run one command at a time or use restricted+.',
			level,
		};
	}

	if (level === 'safe-local' && !isSafeLocalCommand(opts.command)) {
		return {
			exitCode: 126,
			stdout: '',
			stderr: `safe-local only allows known-safe commands; use restricted+. Got: ${opts.command.slice(0, 120)}`,
			level,
		};
	}

	if (level === 'container') {
		return runDocker(opts);
	}

	const isWin = process.platform === 'win32';
	const shell = opts.shell ?? (isWin ? 'cmd.exe' : '/bin/bash');
	const cmdDefault = isWin && !opts.shell && !opts.args ? cmdExeSpawn(opts.command) : undefined;
	const args =
		opts.args ?? cmdDefault?.args ?? (isWin ? ['/d', '/s', '/c', opts.command] : ['-lc', opts.command]);
	const env =
		level === 'unrestricted'
			? { ...process.env, ...(opts.env ?? {}) }
			: scrubEnv({ ...process.env, ...(opts.env ?? {}) });

	const spawnOpts: SpawnOptionsWithoutStdio = {
		cwd: opts.cwd,
		env,
		windowsHide: true,
		...(cmdDefault ? { windowsVerbatimArguments: true } : {}),
	};

	if (level === 'isolated') {
		return runIsolated(opts, shell, args, spawnOpts);
	}

	return spawnOnce(shell, args, spawnOpts, level, opts);
}

async function runIsolated(
	opts: SandboxOptions,
	shell: string,
	args: string[],
	spawnOpts: SpawnOptionsWithoutStdio
): Promise<SandboxResult> {
	if (process.platform !== 'win32') {
		return {
			exitCode: 126,
			stdout: '',
			stderr:
				'isolated sandbox is Windows-only (Job Object). Use restricted, safe-local, or container on this OS.',
			level: 'isolated',
		};
	}
	if (!isWinJobAvailable()) {
		return {
			exitCode: 126,
			stdout: '',
			stderr:
				'isolated sandbox requires the koffi native module for Windows Job Objects. Install extension dependencies or use restricted.',
			level: 'isolated',
		};
	}
	try {
		const result = await spawnInWinJob({
			shell,
			args,
			spawnOpts,
			timeoutMs: opts.timeoutMs ?? 120_000,
			abortSignal: opts.abortSignal,
			onStdout: opts.onStdout,
			onStderr: opts.onStderr,
		});
		return { ...result, level: 'isolated' };
	} catch (err) {
		return {
			exitCode: 126,
			stdout: '',
			stderr: `isolated Job Object failed: ${err instanceof Error ? err.message : String(err)}`,
			level: 'isolated',
		};
	}
}

async function runDocker(opts: SandboxOptions): Promise<SandboxResult> {
	const image = process.env.CODEFORGE_SANDBOX_IMAGE || 'node:20-alpine';
	const args = [
		'run',
		'--rm',
		'--network=none',
		'--user',
		'1000:1000',
		'-v',
		`${opts.cwd}:/work`,
		'-w',
		'/work',
		image,
		'sh',
		'-lc',
		opts.command,
	];
	try {
		return await spawnOnce('docker', args, { windowsHide: true }, 'container', opts);
	} catch (err) {
		return {
			exitCode: 127,
			stdout: '',
			stderr: `Docker unavailable (${err instanceof Error ? err.message : String(err)}). Use restricted/isolated instead.`,
			level: 'container',
		};
	}
}

function spawnOnce(
	shell: string,
	args: string[],
	spawnOpts: SpawnOptionsWithoutStdio,
	level: SandboxLevel,
	opts: SandboxOptions
): Promise<SandboxResult> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	return new Promise(resolve => {
		const chunksOut: string[] = [];
		const chunksErr: string[] = [];
		let settled = false;
		const child = spawn(shell, args, spawnOpts);

		const finish = (exitCode: number, flags?: { aborted?: boolean; timedOut?: boolean }) => {
			if (settled) return;
			settled = true;
			opts.abortSignal?.removeEventListener('abort', onAbort);
			clearTimeout(timer);
			resolve({
				exitCode,
				stdout: chunksOut.join(''),
				stderr: chunksErr.join(''),
				level,
				aborted: flags?.aborted,
				timedOut: flags?.timedOut,
			});
		};

		const onAbort = () => {
			killProcessTree(child);
			finish(130, { aborted: true });
		};
		opts.abortSignal?.addEventListener('abort', onAbort);

		const timer = setTimeout(() => {
			killProcessTree(child);
			finish(124, { timedOut: true });
		}, timeoutMs);

		child.stdout?.on('data', (b: Buffer) => {
			const s = b.toString('utf8');
			chunksOut.push(s);
			opts.onStdout?.(s);
		});
		child.stderr?.on('data', (b: Buffer) => {
			const s = b.toString('utf8');
			chunksErr.push(s);
			opts.onStderr?.(s);
		});
		child.on('error', err => {
			chunksErr.push(err.message);
			finish(1);
		});
		child.on('close', code => finish(code ?? 1));
	});
}
