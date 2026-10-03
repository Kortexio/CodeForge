/**
 * Background shell jobs + await (Cursor AwaitShell parity, local).
 */

import { spawn } from 'child_process';
import * as path from 'path';

export interface BgShellJob {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	done: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

const jobs = new Map<string, BgShellJob>();
let seq = 0;

function clip(s: string, max = 80_000): string {
	return s.length <= max ? s : s.slice(0, max) + `\n…[clipped ${s.length - max} chars]`;
}

export function listBgJobs(): BgShellJob[] {
	return [...jobs.values()];
}

export function getBgJob(id: string): BgShellJob | undefined {
	return jobs.get(id);
}

/** Start a cmd.exe job without blocking the agent loop. */
export function startBgShell(command: string, cwd?: string): BgShellJob {
	const id = `bg-${++seq}-${Date.now().toString(36)}`;
	const workDir = cwd && path.isAbsolute(cwd) ? cwd : cwd || process.cwd();
	const job: BgShellJob = {
		id,
		command,
		cwd: workDir,
		startedAt: Date.now(),
		done: false,
		exitCode: null,
		stdout: '',
		stderr: '',
	};
	jobs.set(id, job);

	const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
		cwd: workDir,
		windowsHide: true,
		env: process.env,
	});
	child.stdout?.on('data', (b: Buffer) => {
		job.stdout = clip(job.stdout + b.toString('utf8'));
	});
	child.stderr?.on('data', (b: Buffer) => {
		job.stderr = clip(job.stderr + b.toString('utf8'));
	});
	child.on('error', err => {
		job.error = err.message;
		job.done = true;
		job.exitCode = 1;
	});
	child.on('close', code => {
		job.exitCode = code ?? 0;
		job.done = true;
	});
	return job;
}

export interface AwaitShellResult {
	id: string;
	done: boolean;
	exitCode: number | null;
	matched?: boolean;
	elapsedMs: number;
	output: string;
}

/**
 * Wait until the job finishes, the pattern matches output, or timeout.
 */
export async function awaitBgShell(
	id: string,
	opts?: { pattern?: string; blockUntilMs?: number }
): Promise<AwaitShellResult> {
	const job = jobs.get(id);
	if (!job) {
		return {
			id,
			done: true,
			exitCode: null,
			elapsedMs: 0,
			output: `Error: unknown background job "${id}"`,
		};
	}
	const timeout = Math.min(7140_000, Math.max(0, opts?.blockUntilMs ?? 30_000));
	const deadline = Date.now() + timeout;
	let re: RegExp | undefined;
	if (opts?.pattern) {
		try {
			re = new RegExp(opts.pattern, 'm');
		} catch {
			return {
				id,
				done: job.done,
				exitCode: job.exitCode,
				elapsedMs: Date.now() - job.startedAt,
				output: `Error: invalid pattern: ${opts.pattern}`,
			};
		}
	}

	while (Date.now() < deadline) {
		const out = job.stdout + (job.stderr ? `\n${job.stderr}` : '');
		if (re && re.test(out)) {
			return {
				id,
				done: job.done,
				exitCode: job.exitCode,
				matched: true,
				elapsedMs: Date.now() - job.startedAt,
				output: clip(`matched pattern\nexit ${job.exitCode ?? '?'}\n${out}`, 24_000),
			};
		}
		if (job.done) {
			return {
				id,
				done: true,
				exitCode: job.exitCode,
				matched: re ? re.test(out) : undefined,
				elapsedMs: Date.now() - job.startedAt,
				output: clip(
					`exit ${job.exitCode ?? '?'}${job.error ? `\n${job.error}` : ''}\n${out}`,
					24_000
				),
			};
		}
		await new Promise(r => setTimeout(r, 400));
	}

	const out = job.stdout + (job.stderr ? `\n${job.stderr}` : '');
	return {
		id,
		done: job.done,
		exitCode: job.exitCode,
		matched: re ? re.test(out) : undefined,
		elapsedMs: Date.now() - job.startedAt,
		output: clip(
			`still running after ${timeout}ms\npartial:\n${out || '(no output yet)'}`,
			24_000
		),
	};
}

export function formatBgStart(job: BgShellJob): string {
	return [
		`Background shell started: ${job.id}`,
		`cwd: ${job.cwd}`,
		`command: ${job.command}`,
		`Use await_shell with id="${job.id}" to poll or wait for a pattern.`,
	].join('\n');
}
