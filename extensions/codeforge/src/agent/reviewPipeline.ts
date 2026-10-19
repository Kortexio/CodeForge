/**
 * Bug-hunt pipeline: deterministic signals → readonly sub-run per file → confirmed BUGS.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runAgentWithTools, type AgentLoopOptions } from './agentLoop';
import { clipData } from './clip';
import { detectOracle, nodeOracleFs, parseFailedTests } from './oracle';
import {
	confirmFinding,
	dedupeFindings,
	formatBugsMd,
	mapPrompt,
	numberLines,
	parseCompilerSignals,
	parseFindings,
	pickCandidateFiles,
	type FileSignal,
	type Finding,
} from './reviewCore';

const MAX_FILES = 8;
const MAX_FILE_CHARS = 14000;
const WALK_SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.CodeForge', 'TestResults', 'dist', 'out']);

export interface ReviewOptions {
	forced?: boolean;
	/** Report file relative to the root. */
	reportPath?: string;
}

function walk(root: string, rel = '', out: Array<{ rel: string; text: string }> = [], depth = 6): typeof out {
	if (depth < 0 || out.length > 400) return out;
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (WALK_SKIP.has(e.name)) continue;
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) walk(root, childRel, out, depth - 1);
		else if (/\.(cs|ts|tsx|js|jsx|py|go|java|kt|rs)$/i.test(e.name)) {
			try {
				const text = fs.readFileSync(path.join(root, childRel), 'utf8');
				if (text.length < 200_000) out.push({ rel: childRel, text });
			} catch {
				/* unreadable */
			}
		}
	}
	return out;
}

function docsFor(root: string): string[] {
	const out: string[] = [];
	for (const dir of ['docs', '']) {
		for (const name of nodeOracleFs.list(path.join(root, dir))) {
			if (/\.md$/i.test(name) && !/^(BUGS|CHANGELOG|LICENSE)/i.test(name)) out.push(dir ? `${dir}/${name}` : name);
		}
	}
	return out.slice(0, 6);
}

/** Only when forced (/review): harness no longer auto-starts review from model size. */
export async function runReviewPipeline(opts: AgentLoopOptions, o: ReviewOptions = {}): Promise<string | undefined> {
	const root = opts.workspaceRoot;
	if (!root) return undefined;
	if (!o.forced) return undefined;
	const reportPath = o.reportPath ?? 'BUGS.md';

	const shell = async (command: string): Promise<string> => {
		const r = await opts.bridge.execute({
			id: `review-${Date.now()}`,
			name: 'shell',
			arguments: { command },
			abortSignal: opts.abortSignal,
		});
		return r.success ? r.output : `exit 1\n${r.error ?? ''}`;
	};

	// 1. Deterministic signals, aggregated per file.
	opts.onStatus?.('Review: build, testes e diagnostics…');
	const signals = new Map<string, FileSignal[]>();
	const addSignals = (m: Map<string, FileSignal[]>) => {
		for (const [file, list] of m) signals.set(file, [...(signals.get(file) ?? []), ...list]);
	};
	const oracle = detectOracle(root, nodeOracleFs);
	const failedTests: string[] = [];
	if (oracle) {
		for (const command of oracle.commands) {
			if (opts.cancelled()) return undefined;
			const out = await shell(command.replace(/\s-v\s+q\b/, ' -v m'));
			addSignals(parseCompilerSignals(out, root, /\btest\b/.test(command) ? 'test' : 'build'));
			failedTests.push(...parseFailedTests(out));
		}
		const target = /dotnet build (\S+)/.exec(oracle.commands[0] ?? '')?.[1];
		if (oracle.source === 'dotnet' && target) {
			const fmt = await shell(`dotnet format ${target} --verify-no-changes --no-restore -v q`);
			addSignals(parseCompilerSignals(fmt, root, 'format'));
		}
	}
	const diag = await opts.bridge.execute({ id: 'review-diag', name: 'diagnostics', arguments: {} });
	if (diag.success && diag.output) {
		for (const m of diag.output.matchAll(/^(.+?):(\d+)(?::\d+)?\s*\[(Error|Warning)\]\s*(.+)$/gm)) {
			const file = m[1].replace(/\\/g, '/');
			signals.set(file, [...(signals.get(file) ?? []), { line: Number(m[2]), code: m[3], msg: m[4], source: 'lsp' }]);
		}
	}
	// Style-only signals do not make a file a bug candidate.
	const bugSignals = new Map([...signals].map(([f, l]) => [f, l.filter(s => s.source !== 'format')] as const).filter(([, l]) => l.length));
	const signalCount = [...bugSignals.values()].reduce((s, l) => s + l.length, 0);

	// 2. Map: one readonly sub-run per candidate file.
	const files = walk(root);
	const candidates = pickCandidateFiles(files, bugSignals, MAX_FILES);
	if (!candidates.length) return undefined;
	const docs = docsFor(root);
	const all: Finding[] = [];
	opts.onTaskUpdate?.({
		id: `review-${Date.now()}`,
		name: `Review: ${candidates.length} files`,
		status: 'running',
		subtasks: candidates.map(c => ({ id: c, name: c, status: 'pending' })),
	});
	for (const [i, file] of candidates.entries()) {
		if (opts.cancelled()) break;
		const text = files.find(f => f.rel === file)?.text ?? '';
		const fileSignals = [...signals].find(([k]) => k.toLowerCase().endsWith(file.toLowerCase()))?.[1] ?? [];
		const numbered = numberLines(text);
		opts.onStatus?.(`Review ${i + 1}/${candidates.length}: ${file}`);
		opts.onActivity?.({ kind: 'checkpoint', label: `Review: ${file}` });
		const reply = await runAgentWithTools({
			...opts,
			task: mapPrompt({
				file,
				numbered: numbered.length > MAX_FILE_CHARS ? clipData(numbered, MAX_FILE_CHARS) : numbered,
				totalLines: text.split(/\r?\n/).length,
				signals: [...fileSignals, ...failedTests.slice(0, 5).map(t => ({ line: 0, code: 'TEST', msg: `failing: ${t}`, source: 'test' as const }))],
				docs,
			}),
			history: [],
			isolated: true,
			planMode: true,
			basePhase: 'explore',
			depth: 1,
			maxSteps: 8,
			hardCap: 10,
		});
		all.push(...parseFindings(reply, file).map(f => ({ ...f, file: f.file.includes('/') ? f.file : file })));
	}

	// 3. Reduce: confirm against the code, dedupe, order by confidence.
	const confirmed = dedupeFindings(
		all
			.map(f => {
				const rel = files.find(x => x.rel.toLowerCase() === f.file.toLowerCase() || x.rel.toLowerCase().endsWith(`/${f.file.toLowerCase()}`));
				return rel ? confirmFinding({ ...f, file: rel.rel }, rel.text) : undefined;
			})
			.filter((f): f is Finding => !!f)
	).sort((a, b) => Number(b.confirmed ?? false) - Number(a.confirmed ?? false) || b.confidence - a.confidence);

	const md = formatBugsMd(confirmed, { files: candidates, signals: signalCount });
	await opts.bridge.execute({ id: 'review-write', name: 'write', arguments: { path: reportPath, content: md } });
	opts.onActivity?.({ kind: 'tool', label: `write ${reportPath}`, tool: 'write', success: true });

	return [
		`Review done: ${confirmed.length} bug(s) in ${candidates.length} file(s) → \`${reportPath}\`.`,
		'',
		...confirmed.slice(0, 12).map(f => `- ${f.file}:${f.line} — ${f.description || f.kind}${f.confirmed === false ? ' (unconfirmed)' : ''}`),
	].join('\n');
}
