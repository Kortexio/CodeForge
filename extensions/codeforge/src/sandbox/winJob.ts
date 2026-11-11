/**
 * Windows Job Object helpers for sandbox level `isolated`.
 * Uses koffi → kernel32 (optional dependency; callers handle load failure).
 */

import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { killProcessTree } from './processKill';

export interface JobSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted?: boolean;
	timedOut?: boolean;
}

type NativeFn = (...args: never[]) => unknown;

type WinApi = {
	CreateJobObjectW: NativeFn;
	SetInformationJobObject: NativeFn;
	AssignProcessToJobObject: NativeFn;
	OpenProcess: NativeFn;
	CloseHandle: NativeFn;
	GetLastError: NativeFn;
};

let api: WinApi | undefined;
let loadError: string | undefined;

function loadApi(): WinApi {
	if (api) return api;
	if (loadError) throw new Error(loadError);
	try {
		// Dynamic require: koffi is optional at runtime if native binding failed to install.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const koffi = require('koffi') as {
			load: (name: string) => {
				func: (name: string, ret: string, args: string[]) => NativeFn;
			};
		};
		const kernel32 = koffi.load('kernel32.dll');
		api = {
			CreateJobObjectW: kernel32.func('CreateJobObjectW', 'void*', ['void*', 'void*']),
			SetInformationJobObject: kernel32.func('SetInformationJobObject', 'bool', [
				'void*',
				'int',
				'void*',
				'uint32',
			]),
			AssignProcessToJobObject: kernel32.func('AssignProcessToJobObject', 'bool', [
				'void*',
				'void*',
			]),
			OpenProcess: kernel32.func('OpenProcess', 'void*', ['uint32', 'int', 'uint32']),
			CloseHandle: kernel32.func('CloseHandle', 'bool', ['void*']),
			GetLastError: kernel32.func('GetLastError', 'uint32', []),
		};
		return api;
	} catch (err) {
		loadError = `Windows Job Object API unavailable (${
			err instanceof Error ? err.message : String(err)
		}). Install the koffi dependency or use restricted/safe-local.`;
		throw new Error(loadError);
	}
}

export function isWinJobAvailable(): boolean {
	if (process.platform !== 'win32') return false;
	try {
		loadApi();
		return true;
	} catch {
		return false;
	}
}

/**
 * JobObjectBasicLimitInformation.LimitFlags:
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
 */
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_ALL =
	PROCESS_SET_QUOTA | PROCESS_TERMINATE | 0x0400 /* SYNCHRONIZE */ | 0x0010; /* VM_READ minimal */

function createKillOnCloseJob(): { job: unknown; dispose: () => void } {
	const w = loadApi();
	const job = w.CreateJobObjectW(null as never, null as never);
	if (!job) {
		throw new Error(`CreateJobObjectW failed (GetLastError=${String(w.GetLastError())})`);
	}
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags @ offset 16.
	const info = Buffer.alloc(144);
	info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
	const ok = w.SetInformationJobObject(
		job as never,
		JobObjectExtendedLimitInformation as never,
		info as never,
		info.length as never
	);
	if (!ok) {
		w.CloseHandle(job as never);
		throw new Error(`SetInformationJobObject failed (GetLastError=${String(w.GetLastError())})`);
	}
	return {
		job,
		dispose: () => {
			try {
				w.CloseHandle(job as never);
			} catch {
				/* ignore */
			}
		},
	};
}

function assignPidToJob(job: unknown, pid: number): void {
	const w = loadApi();
	const handle = w.OpenProcess(PROCESS_ALL as never, 0 as never, pid as never);
	if (!handle) {
		throw new Error(`OpenProcess(${pid}) failed (GetLastError=${String(w.GetLastError())})`);
	}
	try {
		const ok = w.AssignProcessToJobObject(job as never, handle as never);
		if (!ok) {
			throw new Error(`AssignProcessToJobObject failed (GetLastError=${String(w.GetLastError())})`);
		}
	} finally {
		w.CloseHandle(handle as never);
	}
}

/** Spawn under a Job Object that kills the tree when the job handle closes. */
export function spawnInWinJob(opts: {
	shell: string;
	args: string[];
	spawnOpts: SpawnOptionsWithoutStdio;
	timeoutMs: number;
	abortSignal?: AbortSignal;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}): Promise<JobSpawnResult> {
	const { job, dispose } = createKillOnCloseJob();
	return new Promise(resolve => {
		const chunksOut: string[] = [];
		const chunksErr: string[] = [];
		let settled = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(opts.shell, opts.args, opts.spawnOpts);
		} catch (err) {
			dispose();
			resolve({
				exitCode: 1,
				stdout: '',
				stderr: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const finish = (exitCode: number, flags?: { aborted?: boolean; timedOut?: boolean }) => {
			if (settled) return;
			settled = true;
			opts.abortSignal?.removeEventListener('abort', onAbort);
			clearTimeout(timer);
			dispose(); // closes job → KILL_ON_JOB_CLOSE terminates remaining children
			resolve({
				exitCode,
				stdout: chunksOut.join(''),
				stderr: chunksErr.join(''),
				aborted: flags?.aborted,
				timedOut: flags?.timedOut,
			});
		};

		try {
			if (typeof child.pid === 'number' && child.pid > 0) {
				assignPidToJob(job, child.pid);
			} else {
				throw new Error('isolated: child pid unavailable for Job Object assignment');
			}
		} catch (err) {
			chunksErr.push(err instanceof Error ? err.message : String(err));
			killProcessTree(child);
			finish(126);
			return;
		}

		const onAbort = () => {
			killProcessTree(child);
			finish(130, { aborted: true });
		};
		opts.abortSignal?.addEventListener('abort', onAbort);

		const timer = setTimeout(() => {
			killProcessTree(child);
			finish(124, { timedOut: true });
		}, opts.timeoutMs);

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
