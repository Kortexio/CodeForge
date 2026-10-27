/**
 * Run harness model-profile calibration from the Settings UI (or Command Palette).
 * Prefers the suite packaged at resources/calibrate-bench/; falls back to repo benchmarks/.
 * One model per run — harness classifies weak vs strong from protocol stats.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type CalibrateOpts = {
	model: string;
	reps?: number;
	serverId?: string;
	extensionPath?: string;
	/** Called with each progress line (already trimmed). */
	onLine?: (line: string) => void;
	token?: vscode.CancellationToken;
};

export type CalibrateResult = {
	ok: boolean;
	exitCode: number;
	reportPath?: string;
	reportMarkdown?: string;
	summary?: string;
	error?: string;
};

/** Locate packaged or source benchmarks/bench.mjs. */
export function findBenchScript(
	extensionPath?: string,
	workspaceRoots?: string[]
): string | undefined {
	const candidates: string[] = [];
	if (extensionPath) {
		candidates.push(
			path.join(extensionPath, 'resources', 'calibrate-bench', 'bench.mjs')
		);
		candidates.push(path.resolve(extensionPath, '..', '..', 'benchmarks', 'bench.mjs'));
		candidates.push(path.resolve(extensionPath, '..', '..', '..', 'benchmarks', 'bench.mjs'));
	}
	const roots =
		workspaceRoots ??
		(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	for (const root of roots) {
		candidates.push(path.join(root, 'benchmarks', 'bench.mjs'));
		candidates.push(
			path.join(root, 'extensions', 'codeforge', 'resources', 'calibrate-bench', 'bench.mjs')
		);
	}
	const envRepo = process.env.CODEFORGE_REPO?.trim();
	if (envRepo) {
		candidates.push(path.join(envRepo, 'benchmarks', 'bench.mjs'));
		candidates.push(
			path.join(envRepo, 'extensions', 'codeforge', 'resources', 'calibrate-bench', 'bench.mjs')
		);
	}
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return undefined;
}

export function calibrateUnavailableMessage(): string {
	return [
		'Model profile calibration suite is missing from this install.',
		'Reinstall CodeForge or rebuild the extension (npm run build:extensions syncs resources/calibrate-bench).',
		'Dev CLI: node benchmarks/bench.mjs calibrate --model <id>',
	].join(' ');
}

/**
 * Spawn `node …/bench.mjs calibrate --model …` and stream stdout/stderr.
 */
export function runModelProfileCalibration(opts: CalibrateOpts): Promise<CalibrateResult> {
	const bench = findBenchScript(opts.extensionPath);
	if (!bench) {
		return Promise.resolve({
			ok: false,
			exitCode: 2,
			error: calibrateUnavailableMessage(),
		});
	}

	const model = String(opts.model || '').trim();
	if (!model) {
		return Promise.resolve({
			ok: false,
			exitCode: 2,
			error: 'Choose a model to calibrate.',
		});
	}

	const reps = Math.min(5, Math.max(1, Number(opts.reps) || 3));
	const benchDir = path.dirname(bench);
	const packaged = path.basename(benchDir) === 'calibrate-bench';
	const extRoot = packaged
		? path.resolve(benchDir, '..', '..')
		: path.join(path.resolve(benchDir, '..'), 'extensions', 'codeforge');
	const repoRoot = packaged ? extRoot : path.resolve(benchDir, '..');
	const extOut = path.join(extRoot, 'out');
	const resultsDir = packaged
		? path.join(os.homedir(), '.CodeForge', 'ai', 'calibrate-results')
		: path.join(benchDir, 'results');
	const args = [
		bench,
		'calibrate',
		'--model',
		model,
		'--reps',
		String(reps),
		'--skipBuild',
	];
	if (opts.serverId) {
		args.push('--server', opts.serverId);
	}

	return new Promise(resolve => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(process.execPath, args, {
				cwd: repoRoot,
				env: {
					...process.env,
					CODEFORGE_DISABLE_HYSTERESIS: '1',
					CODEFORGE_EXT_OUT: extOut,
					NODE_PATH: [
						path.join(extRoot, 'node_modules'),
						path.join(repoRoot, 'node_modules'),
						process.env.NODE_PATH || '',
					]
						.filter(Boolean)
						.join(path.delimiter),
				},
				windowsHide: true,
			}) as ChildProcessWithoutNullStreams;
		} catch (err) {
			resolve({
				ok: false,
				exitCode: 1,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		let buf = '';
		let lastReport = '';
		const onData = (chunk: Buffer | string) => {
			buf += String(chunk);
			const parts = buf.split(/\r?\n/);
			buf = parts.pop() ?? '';
			for (const line of parts) {
				const t = line.trimEnd();
				if (!t) continue;
				opts.onLine?.(t);
				if (/^Wrote\s+.+CALIBRATE-/i.test(t) || /CALIBRATE-\d{4}-\d{2}-\d{2}\.md/.test(t)) {
					const m = /([^\s]+CALIBRATE-\d{4}-\d{2}-\d{2}\.md)/.exec(t);
					if (m) lastReport = m[1];
				}
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);

		const cancelSub = opts.token?.onCancellationRequested(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		});

		child.on('error', err => {
			cancelSub?.dispose();
			resolve({ ok: false, exitCode: 1, error: err.message });
		});

		child.on('close', code => {
			cancelSub?.dispose();
			if (opts.token?.isCancellationRequested) {
				resolve({ ok: false, exitCode: code ?? 1, error: 'Calibration cancelled.' });
				return;
			}
			const reportPath = resolveReportPath(lastReport, resultsDir);
			let reportMarkdown: string | undefined;
			if (reportPath && fs.existsSync(reportPath)) {
				try {
					reportMarkdown = fs.readFileSync(reportPath, 'utf8');
				} catch {
					/* ignore */
				}
			}
			const exitCode = code ?? 1;
			const ok = exitCode === 0;
			resolve({
				ok,
				exitCode,
				reportPath,
				reportMarkdown,
				summary: summarizeReport(reportMarkdown) || (ok ? 'Calibration finished.' : undefined),
				error: ok ? undefined : `calibrate exited ${exitCode}`,
			});
		});
	});
}

function resolveReportPath(lastReport: string, resultsDir: string): string | undefined {
	if (lastReport && fs.existsSync(lastReport)) return lastReport;
	if (lastReport) {
		const joined = path.isAbsolute(lastReport)
			? lastReport
			: path.join(resultsDir, path.basename(lastReport));
		if (fs.existsSync(joined)) return joined;
	}
	try {
		const files = fs
			.readdirSync(resultsDir)
			.filter(f => /^CALIBRATE-\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.sort()
			.reverse();
		if (files[0]) return path.join(resultsDir, files[0]);
	} catch {
		/* ignore */
	}
	return undefined;
}

function summarizeReport(md?: string): string | undefined {
	if (!md) return undefined;
	const rows = md
		.split(/\r?\n/)
		.filter(l => /^\| [^|]+ \|/.test(l) && !/^\|[-| :]+$/.test(l) && !/^\| Model \|/.test(l));
	if (!rows.length) return undefined;
	return rows.map(r => r.replace(/^\|\s*/, '').replace(/\s*\|$/, '').replace(/\s*\|\s*/g, ' · ')).join('\n');
}

/** Command Palette entry: pick one model, then calibrate. */
export async function promptAndRunCalibration(
	store: {
		getState: () => {
			activeServerId: string | null;
			activeModel?: string | null;
			servers: Array<{ id: string; models?: string[]; enabled?: boolean }>;
		};
	},
	extensionPath: string,
	output: vscode.OutputChannel
): Promise<CalibrateResult> {
	const state = store.getState();
	const server = state.servers.find(s => s.id === state.activeServerId && s.enabled !== false);
	const models = server?.models?.filter(Boolean) ?? [];
	if (!models.length) {
		void vscode.window.showErrorMessage(
			'Active server has no models. Fetch models in Settings → Models first.'
		);
		return { ok: false, exitCode: 2, error: 'No models on the active server.' };
	}

	const modelPick = await vscode.window.showQuickPick(
		models.map(m => ({
			label: m,
			description: m === state.activeModel ? 'active' : undefined,
		})),
		{ title: 'Model to benchmark & calibrate', placeHolder: state.activeModel || models[0] }
	);
	if (!modelPick) return { ok: false, exitCode: 2, error: 'Cancelled.' };

	const repsPick = await vscode.window.showQuickPick(
		[
			{ label: '1', description: 'Faster smoke (4 tasks; ×2 when the server supports thinking)' },
			{
				label: '3',
				description: 'Full calibrate (12 runs; ×2 when the server supports thinking)',
			},
		],
		{ title: 'Repetitions per task' }
	);
	if (!repsPick) return { ok: false, exitCode: 2, error: 'Cancelled.' };

	output.show(true);
	output.appendLine(`[calibrate] model=${modelPick.label} reps=${repsPick.label}`);

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Benchmark & calibrate',
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: 'Starting suite (T2, T4, CS2, CS3)…' });
			const result = await runModelProfileCalibration({
				model: modelPick.label,
				reps: Number(repsPick.label) || 3,
				serverId: server?.id,
				extensionPath,
				token,
				onLine: line => {
					output.appendLine(line);
					if (line.startsWith('=== calibrate')) {
						progress.report({ message: line.replace(/^===\s*/, '').replace(/\s*===$/, '') });
					}
				},
			});
			if (result.ok) {
				const msg =
					result.summary?.split('\n')[0] ||
					'Calibration finished. Profile updated under ~/.CodeForge.';
				const choice = result.reportPath
					? await vscode.window.showInformationMessage(msg, 'Open report')
					: await vscode.window.showInformationMessage(msg);
				if (choice === 'Open report' && result.reportPath) {
					void vscode.window.showTextDocument(vscode.Uri.file(result.reportPath));
				}
			} else {
				void vscode.window.showErrorMessage(result.error || 'Calibration failed.');
			}
			return result;
		}
	);
}

/**
 * Spawn `node …/bench.mjs revise`. Selection suite is T2/T4; a revision is
 * kept only when its mean score clears the parent.
 */
export function runHarnessRevision(opts: CalibrateOpts): Promise<CalibrateResult> {
	const bench = findBenchScript(opts.extensionPath);
	if (!bench) {
		return Promise.resolve({
			ok: false,
			exitCode: 2,
			error: calibrateUnavailableMessage(),
		});
	}
	const model = String(opts.model || '').trim();
	if (!model) {
		return Promise.resolve({ ok: false, exitCode: 2, error: 'Choose a model to revise.' });
	}
	const reps = Math.min(5, Math.max(3, Number(opts.reps) || 3));
	const benchDir = path.dirname(bench);
	const packaged = path.basename(benchDir) === 'calibrate-bench';
	const extRoot = packaged
		? path.resolve(benchDir, '..', '..')
		: path.join(path.resolve(benchDir, '..'), 'extensions', 'codeforge');
	const repoRoot = packaged ? extRoot : path.resolve(benchDir, '..');
	const extOut = path.join(extRoot, 'out');
	const args = [bench, 'revise', '--model', model, '--reps', String(reps), '--skipBuild'];
	if (opts.serverId) args.push('--server', opts.serverId);

	return new Promise(resolve => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(process.execPath, args, {
				cwd: repoRoot,
				env: {
					...process.env,
					CODEFORGE_DISABLE_HYSTERESIS: '1',
					CODEFORGE_EXT_OUT: extOut,
					NODE_PATH: [
						path.join(extRoot, 'node_modules'),
						path.join(repoRoot, 'node_modules'),
						process.env.NODE_PATH || '',
					]
						.filter(Boolean)
						.join(path.delimiter),
				},
				windowsHide: true,
			}) as ChildProcessWithoutNullStreams;
		} catch (err) {
			resolve({
				ok: false,
				exitCode: 1,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		let buf = '';
		let transcript = '';
		const onData = (chunk: Buffer) => {
			const text = chunk.toString();
			transcript += text;
			buf += text;
			let idx = buf.indexOf('\n');
			while (idx >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line) opts.onLine?.(line);
				idx = buf.indexOf('\n');
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		opts.token?.onCancellationRequested(() => {
			child.kill();
		});
		child.on('error', err => {
			resolve({ ok: false, exitCode: 1, error: err.message });
		});
		child.on('close', code => {
			if (buf.trim()) opts.onLine?.(buf.trim());
			const exitCode = code ?? 1;
			const kept = /KEPT revision/.test(transcript);
			resolve({
				ok: exitCode === 0,
				exitCode,
				summary: exitCode === 0
					? kept
						? 'Harness revision kept.'
						: 'Harness revision finished. The candidate did not beat the parent, so the previous harness stays.'
					: undefined,
				error: exitCode === 0 ? undefined : `revise exited ${exitCode}`,
			});
		});
	});
}

/** Command Palette entry: same model picker as calibrate, then one revision round. */
export async function promptAndRunHarnessRevision(
	store: {
		getState: () => {
			activeServerId: string | null;
			activeModel?: string | null;
			servers: Array<{ id: string; models?: string[]; enabled?: boolean }>;
		};
	},
	extensionPath: string,
	output: vscode.OutputChannel
): Promise<CalibrateResult> {
	const state = store.getState();
	const server = state.servers.find(s => s.id === state.activeServerId && s.enabled !== false);
	const models = server?.models?.filter(Boolean) ?? [];
	if (!models.length) {
		void vscode.window.showErrorMessage(
			'Active server has no models. Fetch models in Settings → Models first.'
		);
		return { ok: false, exitCode: 2, error: 'No models on the active server.' };
	}
	const modelPick = await vscode.window.showQuickPick(
		models.map(m => ({
			label: m,
			description: m === state.activeModel ? 'active' : undefined,
		})),
		{ title: 'Model whose harness to revise', placeHolder: state.activeModel || models[0] }
	);
	if (!modelPick) return { ok: false, exitCode: 2, error: 'Cancelled.' };

	output.show(true);
	output.appendLine(`[revise] model=${modelPick.label} suite=T2,T4 reps=3`);
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Revising harness',
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: 'Proposer, then T2 and T4 × 3…' });
			const result = await runHarnessRevision({
				model: modelPick.label,
				reps: 3,
				serverId: server?.id,
				extensionPath,
				token,
				onLine: line => {
					output.appendLine(line);
					if (line.startsWith('=== revise') || line.startsWith('KEPT') || line.startsWith('REVERTED')) {
						progress.report({ message: line.replace(/^===\s*/, '').replace(/\s*===$/, '') });
					}
				},
			});
			if (result.ok) {
				void vscode.window.showInformationMessage(result.summary || 'Harness revision finished.');
			} else {
				void vscode.window.showErrorMessage(result.error || 'Harness revision failed.');
			}
			return result;
		}
	);
}
