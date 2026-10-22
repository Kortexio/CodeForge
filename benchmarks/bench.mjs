#!/usr/bin/env node
/**
 * CodeForge harness benchmark — semi-automatic (the agent runs inside the IDE).
 *
 *   node benchmarks/bench.mjs list
 *   node benchmarks/bench.mjs setup CS1 --label bonsai [--open]
 *   node benchmarks/bench.mjs check latest
 *   node benchmarks/bench.mjs report
 *   node benchmarks/bench.mjs selftest
 *   node benchmarks/bench.mjs run T1 --label baseline-qwen35b [--server id] [--model id] [--weak on|off]
 *
 * Runs live in %USERPROFILE%/codeforge-bench (override with CODEFORGE_BENCH_DIR).
 * Headless `run` uses the active server/model from ~/.CodeForge/ai/settings.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveBenchLayout } from './layout.mjs';

const LAYOUT = resolveBenchLayout();
const HERE = LAYOUT.here;
const FIXTURES = {
	shop: path.join(HERE, 'fixtures', 'shop'),
	billing: path.join(HERE, 'fixtures', 'billing'),
	scaffold: path.join(HERE, 'fixtures', 'scaffold'),
	'billing-bugs': path.join(HERE, 'fixtures', 'billing-bugs'),
	'router-cards': path.join(HERE, 'fixtures', 'router-cards'),
};
const TASKS_DIR = path.join(HERE, 'tasks');
const RESULTS_DIR =
	process.env.CODEFORGE_BENCH_RESULTS?.trim() || LAYOUT.resultsDir;
let RUNS_ROOT = process.env.CODEFORGE_BENCH_DIR || path.join(os.homedir(), 'codeforge-bench');
const CF_HOME = path.join(os.homedir(), '.CodeForge');
const HIDDEN_DIR = '.bench-hidden';
const JUNK = /(^|\/)(_tmp|tmp_|_vip_|_check_)[^/]*$|\.py$/i;
const COPY_SKIP = new Set(['bin', 'obj', 'node_modules', '.git', 'TestResults']);

// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const pos = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const [k, v] = a.slice(2).split('=');
			if (v !== undefined) flags[k] = v;
			else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
			else flags[k] = true;
		} else {
			pos.push(a);
		}
	}
	return { pos, flags };
}

function loadTasks() {
	return fs
		.readdirSync(TASKS_DIR, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => ({
			...JSON.parse(fs.readFileSync(path.join(TASKS_DIR, d.name, 'task.json'), 'utf8')),
			dir: path.join(TASKS_DIR, d.name),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

function findTask(key) {
	const k = String(key || '').toLowerCase();
	const t = loadTasks().find(
		t => t.id.toLowerCase() === k || t.id.toLowerCase().startsWith(`${k}-`) || t.id.toLowerCase().startsWith(k)
	);
	if (!t) die(`Unknown task "${key}". Use: list`);
	return t;
}

function die(msg) {
	console.error(msg);
	process.exit(1);
}

function git(dir, args) {
	return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function normPath(p) {
	return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (COPY_SKIP.has(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

function copyFixture(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		if (COPY_SKIP.has(e.name)) continue;
		const from = path.join(src, e.name);
		const to = path.join(dest, e.name);
		if (e.isDirectory()) copyFixture(from, to);
		else {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
		}
	}
}

function taskRuntime(task) {
	return task.runtime || (task.fixture === 'billing' || task.fixture === 'scaffold' ? 'dotnet' : 'node');
}

function taskFixture(task) {
	const name = task.fixture || 'shop';
	const dir = FIXTURES[name];
	if (!dir || !fs.existsSync(dir)) die(`Unknown fixture "${name}" for ${task.id}`);
	return dir;
}

// ---------------------------------------------------------------------------
// setup

function cmdSetup(taskKey, flags) {
	const task = findTask(taskKey);
	const label = String(flags.label || 'model').replace(/[^\w.-]+/g, '_');
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
	const name = `${task.id.split('-')[0]}-${label}-${stamp}`;
	const dir = path.join(RUNS_ROOT, name);

	fs.mkdirSync(RUNS_ROOT, { recursive: true });
	copyFixture(taskFixture(task), dir);
	const overlay = path.join(task.dir, 'overlay');
	if (fs.existsSync(overlay)) copyFixture(overlay, dir);

	git(dir, ['init', '-q']);
	git(dir, ['add', '-A']);
	const commit = git(dir, [
		'-c',
		'user.email=bench@codeforge.local',
		'-c',
		'user.name=bench',
		'commit',
		'-qm',
		'baseline',
	]);
	if (commit.status !== 0) die(`git commit failed: ${commit.stderr}`);

	const meta = {
		name,
		task: task.id,
		label,
		dir,
		runtime: taskRuntime(task),
		createdAt: new Date().toISOString(),
	};
	fs.writeFileSync(path.join(RUNS_ROOT, `${name}.meta.json`), JSON.stringify(meta, null, 2));
	fs.writeFileSync(path.join(RUNS_ROOT, `${name}.prompt.txt`), task.prompt, 'utf8');
	if (flags.quiet) return meta;

	console.log(`Run:    ${name}`);
	console.log(`Folder: ${dir}`);
	console.log(`Task:   ${task.title}`);
	console.log(`Runtime:${taskRuntime(task)}`);
	console.log('');
	console.log('1. Open the folder in CodeForge, start a NEW chat and pick the model.');
	console.log('2. Paste this prompt:');
	console.log('');
	console.log(`   ${task.prompt}`);
	console.log('');
	console.log(`3. When the agent stops: node benchmarks/bench.mjs check ${name}`);

	if (flags.open) openInCodeForge(dir);
	return meta;
}

function openInCodeForge(dir) {
	const candidates = [
		process.env.CODEFORGE_EXE,
		path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeForge', 'CodeForge.exe'),
		path.join(HERE, '..', 'VSCode-win32-x64', 'CodeForge.exe'),
	].filter(Boolean);
	const exe = candidates.find(p => fs.existsSync(p));
	if (!exe) {
		console.log('(CodeForge.exe not found — open the folder manually or set CODEFORGE_EXE)');
		return;
	}
	spawn(exe, ['--new-window', dir], { detached: true, stdio: 'ignore' }).unref();
	console.log(`Opened in ${exe}`);
}

// ---------------------------------------------------------------------------
// check

function resolveRun(key) {
	const metas = fs.existsSync(RUNS_ROOT)
		? fs
				.readdirSync(RUNS_ROOT)
				.filter(f => f.endsWith('.meta.json'))
				.map(f => readJson(path.join(RUNS_ROOT, f)))
				.filter(Boolean)
		: [];
	if (!metas.length) die(`No runs in ${RUNS_ROOT}. Use: setup`);
	if (!key || key === 'latest') {
		return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	}
	const k = normPath(key);
	const m = metas.find(m => m.name === key || normPath(m.dir) === k);
	if (!m) die(`Run "${key}" not found in ${RUNS_ROOT}`);
	return m;
}

function runNodeTests(dir, files) {
	if (!files.length) return { pass: 0, fail: 0, output: '(no test files)', skipped: true };
	const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
		cwd: dir,
		encoding: 'utf8',
		timeout: 120_000,
	});
	const out = `${r.stdout || ''}${r.stderr || ''}`;
	const num = re => Number((re.exec(out) || [])[1] || 0);
	const pass = num(/^# pass (\d+)/m);
	let fail = num(/^# fail (\d+)/m);
	if (r.error || (r.status !== 0 && fail === 0)) fail = Math.max(1, fail);
	return { pass, fail, output: out };
}

function runDotnetTests(dir, { filter } = {}) {
	const args = ['test', '-v', 'q', '--nologo'];
	if (filter) args.push('--filter', filter);
	const r = spawnSync('dotnet', args, {
		cwd: dir,
		encoding: 'utf8',
		timeout: 300_000,
		shell: false,
	});
	const out = `${r.stdout || ''}${r.stderr || ''}`;
	const passed = Number((/Passed:\s+(\d+)/.exec(out) || [])[1] || 0);
	const failed = Number((/Failed:\s+(\d+)/.exec(out) || [])[1] || 0);
	const total = Number((/Total:\s+(\d+)/.exec(out) || [])[1] || passed + failed);
	let pass = passed;
	let fail = failed;
	if (r.error) {
		fail = Math.max(1, fail);
		return { pass, fail, output: String(r.error), total };
	}
	if (r.status !== 0 && fail === 0 && pass === 0) {
		// no test host / build failed
		fail = 1;
	}
	return { pass, fail, output: out, total };
}

function failedTestNames(output, runtime) {
	if (runtime === 'dotnet') {
		return [...output.matchAll(/^\s*Error Message:\s*$/gm)].length
			? [...output.matchAll(/Failed \S+ \[([^\]]+)\]/g)].map(m => m[1]).slice(0, 12)
			: [...output.matchAll(/^\s+Failed (\S+)/gm)].map(m => m[1]).slice(0, 12);
	}
	return [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1].trim()).slice(0, 12);
}

function changedFiles(dir) {
	const r = git(dir, ['status', '--porcelain', '-uall']);
	return r.stdout
		.split('\n')
		.filter(Boolean)
		.map(l => ({
			code: l.slice(0, 2).trim(),
			file: l.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'),
		}))
		.filter(
			c =>
				!c.file.startsWith(`${HIDDEN_DIR}/`) &&
				!c.file.startsWith('.CodeForge/') &&
				!c.file.includes('/bin/') &&
				!c.file.includes('/obj/') &&
				!c.file.startsWith('bin/') &&
				!c.file.startsWith('obj/')
		);
}

function runChecks(dir, list, changed) {
	return (list || []).map(c => {
		if (c.type === 'absent') {
			const re = new RegExp(c.pattern);
			const hits = walk(path.join(dir, c.dir))
				.filter(f => re.test(fs.readFileSync(f, 'utf8')))
				.map(f => path.relative(dir, f).replace(/\\/g, '/'));
			return { ...c, ok: hits.length === 0, detail: hits.join(', ') };
		}
		if (c.type === 'unchanged') {
			const hit = changed.some(x => x.file === c.file);
			return { ...c, ok: !hit, detail: hit ? 'modified' : '' };
		}
		if (c.type === 'contains') {
			const file = path.join(dir, c.file);
			const ok = fs.existsSync(file) && new RegExp(c.pattern, 'im').test(fs.readFileSync(file, 'utf8'));
			return { ...c, ok, detail: ok ? '' : 'pattern not found' };
		}
		if (c.type === 'exists') {
			const ok = fs.existsSync(path.join(dir, c.file));
			return { ...c, ok, detail: ok ? '' : 'missing' };
		}
		return { ...c, ok: false, detail: `unknown check type ${c.type}` };
	});
}

/** Mirror of claimsBuildOrTestGreen in extensions/codeforge/src/agent/nudges.ts. */
function claimsGreen(text) {
	const t = String(text || '');
	const negated =
		/\bn[ãa]o\s+(compila|passa|est[áa]\s+verde)|\b(tests?|build)\s+(failed|failing)\b|\b[1-9]\d*\s+(errors?|erros?|failures?|falhas?|failed)\b/i.test(
			t
		);
	if (negated) return false;
	return (
		/\b(all\s+)?(passing|passed|green|verde|0\s+errors?|0\s+erros?|0\s+failures?|0\s+falhas?|build\s+succeeded|build\s+ok|tests?\s+pass)/i.test(t) ||
		/\ball\s+green\b|\btudo\s+verde\b/i.test(t) ||
		/\b(compila|compilou|compilando)\b/i.test(t) ||
		/\bsem\s+(erros?|falhas?)\b/i.test(t) ||
		/\btestes?\s+(passa|passam|passaram|ok|verdes?)\b/i.test(t) ||
		/\b(build|compila[çc][ãa]o)\s+(com\s+sucesso|bem[-\s]sucedid[ao]|ok)\b/i.test(t)
	);
}

function sessionMetrics(runDir) {
	const sessionsRoot = path.join(CF_HOME, 'ai', 'sessions');
	const tracesRoot = path.join(CF_HOME, 'ai', 'traces');
	const target = normPath(runDir);
	const sessions = (fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : [])
		.map(id => readJson(path.join(sessionsRoot, id, 'session.json')))
		.filter(s => s && s.workspaceFolder && normPath(s.workspaceFolder) === target);

	const m = {
		sessions: sessions.length,
		models: [...new Set(sessions.map(s => s.model).filter(Boolean))],
		states: sessions.map(s => s.state),
		userMessages: 0,
		tools: 0,
		toolFails: 0,
		byTool: {},
		reads: 0,
		readUniquePaths: 0,
		readRepeats: 0,
		writes: 0,
		shells: 0,
		shellFails: 0,
		llmCalls: 0,
		tokensIn: 0,
		maxPromptTokens: 0,
		tokensOut: 0,
		compacts: 0,
		llmErrors: 0,
		overflowErrors: 0,
		wallSeconds: 0,
		claimedGreen: false,
		harnessChars: 0,
	};
	const lastSession = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	const lastReply = [...(lastSession?.messages || [])].reverse().find(x => x.role === 'assistant');
	m.claimedGreen = claimsGreen(String(lastReply?.content || ''));
	const readKeys = new Set();
	const readPaths = new Set();
	let first = Infinity;
	let last = 0;
	for (const s of sessions) {
		m.userMessages += (s.messages || []).filter(x => x.role === 'user').length;
		for (const t of s.toolTraces || []) {
			m.tools += 1;
			m.byTool[t.name] = (m.byTool[t.name] || 0) + 1;
			if (!t.success) m.toolFails += 1;
			const args = t.arguments || {};
			if (t.name === 'read') {
				m.reads += 1;
				const p = String(args.path || '')
					.replace(/\\/g, '/')
					.toLowerCase();
				const key = `${p}@${args.startLine ?? args.offset ?? 1}`;
				if (readKeys.has(key)) m.readRepeats += 1;
				readKeys.add(key);
				readPaths.add(p);
			}
			if ((t.name === 'write' || t.name === 'edit') && t.success) m.writes += 1;
			if (t.name === 'shell' || t.name === 'dotnet') {
				m.shells += 1;
				if (!t.success) m.shellFails += 1;
			}
		}
		first = Math.min(first, Date.parse(s.createdAt));
		last = Math.max(last, Date.parse(s.updatedAt));

		const traceFiles = fs.existsSync(tracesRoot)
			? fs.readdirSync(tracesRoot).filter(f => f.startsWith(`${s.id}-`) && f.endsWith('.jsonl'))
			: [];
		for (const f of traceFiles) {
			for (const line of fs.readFileSync(path.join(tracesRoot, f), 'utf8').split('\n')) {
				if (!line.trim()) continue;
				let e;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				if (e.type === 'llm') {
					m.llmCalls += 1;
					m.tokensIn += e.tokensIn || 0;
					m.tokensOut += e.tokensOut || 0;
					m.maxPromptTokens = Math.max(m.maxPromptTokens, e.tokensIn || 0);
				} else if (e.type === 'compact') {
					m.compacts += 1;
				} else if (e.type === 'info' && e.label === 'harness') {
					m.harnessChars += Number(e.detail) || 0;
				} else if (e.type === 'error' && /LLM error/i.test(e.label)) {
					m.llmErrors += 1;
					if (/exceed|context (size|length)|n_ctx/i.test(e.detail || '')) m.overflowErrors += 1;
				}
			}
		}
	}
	m.readUniquePaths = readPaths.size;
	if (Number.isFinite(first) && last > first) m.wallSeconds = Math.round((last - first) / 1000);
	return m;
}

/**
 * Review scoring: `path:line` references in the report vs the planted-bug manifest.
 * A reference hits a bug when the file names match and the line is within the tolerance.
 */
function scoreReview(dir, task) {
	const manifest = readJson(path.join(task.dir, 'bugs.manifest.json'), []);
	const reportFile = path.join(dir, task.report || 'BUGS.md');
	const text = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
	const tol = task.lineTolerance ?? 3;
	const refs = [
		...new Set(
			[...text.matchAll(/([\w./\\-]+\.(?:cs|js|ts|json|md)):(\d+)/g)].map(
				m => `${m[1].replace(/\\/g, '/').toLowerCase()}:${m[2]}`
			)
		),
	].map(k => {
		const i = k.lastIndexOf(':');
		return { file: k.slice(0, i), line: Number(k.slice(i + 1)) };
	});
	const sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.split('/').pop() === b.split('/').pop();
	const hits = r => manifest.filter(b => sameFile(r.file, b.file.toLowerCase()) && Math.abs(r.line - b.line) <= tol);
	const found = manifest.filter(b => refs.some(r => hits(r).includes(b)));
	const truePositives = refs.filter(r => hits(r).length > 0).length;
	const precision = refs.length ? truePositives / refs.length : 0;
	const recall = manifest.length ? found.length / manifest.length : 0;
	const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
	return {
		reported: refs.length,
		found: found.map(b => b.id),
		missed: manifest.filter(b => !found.includes(b)).map(b => b.id),
		falsePositives: refs.length - truePositives,
		precision: Math.round(precision * 100) / 100,
		recall: Math.round(recall * 100) / 100,
		f1: Math.round(f1 * 100) / 100,
	};
}

function runVisibleAndHidden(dir, task) {
	const runtime = taskRuntime(task);
	if (task.category === 'review') {
		const none = { pass: 0, fail: 0, output: '(review task — no tests)', skipped: true };
		return { visible: none, hidden: { ...none }, runtime };
	}
	const hiddenSrc = path.join(task.dir, 'hidden');
	const hasHidden =
		fs.existsSync(hiddenSrc) && walk(hiddenSrc).some(f => /\.(cs|js)$/i.test(f));

	if (runtime === 'dotnet') {
		const hiddenTarget = path.join(dir, task.hiddenTarget || 'tests/Acme.Billing.Tests/BenchHidden');
		if (hasHidden && task.cards?.length) {
			// Per card: only that card's hidden tests are compiled in, so a missing later card
			// does not zero the earlier ones.
			fs.rmSync(hiddenTarget, { recursive: true, force: true });
			const visible = runDotnetTests(dir, { filter: 'FullyQualifiedName!~BenchHidden' });
			const cards = [];
			let output = '';
			for (const card of task.cards) {
				fs.rmSync(hiddenTarget, { recursive: true, force: true });
				copyFixture(path.join(hiddenSrc, card), hiddenTarget);
				const r = runDotnetTests(dir, { filter: 'FullyQualifiedName~BenchHidden' });
				const total = r.pass + r.fail;
				cards.push({ card, pass: r.pass, fail: r.fail, ratio: total ? r.pass / total : 0 });
				output += `\n${r.output}`;
			}
			fs.rmSync(hiddenTarget, { recursive: true, force: true });
			const hidden = {
				pass: cards.reduce((s, c) => s + c.pass, 0),
				fail: cards.reduce((s, c) => s + c.fail, 0),
				output,
				skipped: false,
				cards,
				ratio: cards.reduce((s, c) => s + c.ratio, 0) / cards.length,
			};
			return { visible, hidden, runtime };
		}
		const visible = runDotnetTests(dir, {
			filter: hasHidden ? 'FullyQualifiedName!~BenchHidden' : undefined,
		});
		let hidden = { pass: 0, fail: 0, output: '(no hidden)', skipped: !hasHidden };
		if (hasHidden) {
			fs.rmSync(hiddenTarget, { recursive: true, force: true });
			copyFixture(hiddenSrc, hiddenTarget);
			hidden = runDotnetTests(dir, { filter: 'FullyQualifiedName~BenchHidden' });
			fs.rmSync(hiddenTarget, { recursive: true, force: true });
		} else if (task.category === 'scaffold') {
			// scaffold: whole suite is the acceptance bar
			hidden = { ...visible, skipped: false };
		}
		return { visible, hidden, runtime };
	}

	const visibleFiles = walk(path.join(dir, 'test'))
		.filter(f => f.endsWith('.test.js'))
		.map(f => path.relative(dir, f));
	const visible = runNodeTests(dir, visibleFiles);
	const hiddenTarget = path.join(dir, HIDDEN_DIR);
	fs.rmSync(hiddenTarget, { recursive: true, force: true });
	let hidden = { pass: 0, fail: 0, output: '(no hidden)', skipped: true };
	if (hasHidden) {
		copyFixture(hiddenSrc, hiddenTarget);
		const hiddenFiles = walk(hiddenTarget).map(f => path.relative(dir, f));
		hidden = runNodeTests(dir, hiddenFiles);
		fs.rmSync(hiddenTarget, { recursive: true, force: true });
	}
	return { visible, hidden, runtime };
}

function cmdCheck(key, { save = true, print = true } = {}) {
	const run = resolveRun(key);
	const task = findTask(run.task);
	const dir = run.dir;
	if (!fs.existsSync(dir)) die(`Run folder missing: ${dir}`);

	const changed = changedFiles(dir);
	const protectedHits = changed.filter(c => (task.protected || []).some(p => c.file.startsWith(p)));
	const junk = changed.filter(c => JUNK.test(c.file));

	const { visible, hidden, runtime } = runVisibleAndHidden(dir, task);
	const checks = runChecks(dir, task.checks, changed);
	const bonus = runChecks(dir, task.bonus, changed);
	const session = sessionMetrics(dir);

	const hiddenTotal = hidden.pass + hidden.fail;
	const hiddenRatio =
		hidden.ratio ?? (hidden.skipped ? 1 : hiddenTotal ? hidden.pass / hiddenTotal : 0);
	const visibleOk =
		visible.fail === 0 && (visible.pass > 0 || (task.category === 'scaffold' && checks.every(c => c.ok)));
	const checksOk = checks.every(c => c.ok);
	const review = task.category === 'review' ? scoreReview(dir, task) : null;
	let score;
	let pass;
	if (review) {
		score = Math.round(80 * review.f1 + 10 * (protectedHits.length ? 0 : 1) + 10 * (checksOk ? 1 : 0));
		pass = review.f1 >= 0.8 && !protectedHits.length && checksOk;
	} else {
		score = Math.round(
			60 * hiddenRatio +
				15 * (visibleOk ? 1 : 0) +
				10 * (protectedHits.length ? 0 : 1) +
				10 * (checksOk ? 1 : 0) +
				5 * (junk.length ? 0 : 1)
		);
		pass = hiddenRatio === 1 && visibleOk && !protectedHits.length && checksOk;
	}
	const falseDone = review ? false : session.claimedGreen && !(visible.fail === 0 && hidden.fail === 0);

	const result = {
		run: run.name,
		task: task.id,
		label: run.label,
		runtime,
		model: session.models.join(', ') || null,
		checkedAt: new Date().toISOString(),
		pass,
		score,
		falseDone,
		hidden: {
			pass: hidden.pass,
			fail: hidden.fail,
			failed: failedTestNames(hidden.output, runtime),
			...(hidden.cards ? { cards: hidden.cards } : {}),
		},
		...(review ? { review } : {}),
		visible: {
			pass: visible.pass,
			fail: visible.fail,
			failed: failedTestNames(visible.output, runtime),
		},
		changedFiles: changed.map(c => `${c.code} ${c.file}`),
		protectedTouched: protectedHits.map(c => c.file),
		junkFiles: junk.map(c => c.file),
		checks: checks.map(({ type, ok, why, detail }) => ({ type, ok, why, detail })),
		bonus: bonus.map(({ type, ok, why, detail }) => ({ type, ok, why, detail })),
		session,
	};
	if (save) {
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		fs.writeFileSync(path.join(RESULTS_DIR, `${run.name}.json`), JSON.stringify(result, null, 2));
	}
	if (print) printResult(result);
	return result;
}

// ---------------------------------------------------------------------------
// selftest

function applySolution(dir, taskDir) {
	for (const edit of readJson(path.join(taskDir, 'solution.json'), [])) {
		if (edit.shell) {
			const r = spawnSync(edit.shell[0], edit.shell.slice(1), {
				cwd: dir,
				encoding: 'utf8',
				timeout: 180_000,
			});
			if (r.status !== 0) {
				throw new Error(`solution shell failed: ${edit.shell.join(' ')}\n${r.stdout}\n${r.stderr}`);
			}
			continue;
		}
		if (edit.delete) {
			fs.rmSync(path.join(dir, edit.delete), { force: true });
			continue;
		}
		if (edit.write !== undefined) {
			const file = path.join(dir, edit.file);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, edit.write);
			continue;
		}
		const file = path.join(dir, edit.file);
		const text = fs.readFileSync(file, 'utf8');
		if (!text.includes(edit.replace)) throw new Error(`${edit.file}: "${edit.replace}" not found`);
		fs.writeFileSync(
			file,
			edit.all ? text.split(edit.replace).join(edit.with) : text.replace(edit.replace, edit.with)
		);
	}
}

function cmdRun(taskKey, flags) {
	const label = String(flags.label || 'headless').replace(/[^\w.-]+/g, '_');
	const meta = cmdSetup(taskKey, { ...flags, label, quiet: true });
	const prompt = fs.readFileSync(path.join(RUNS_ROOT, `${meta.name}.prompt.txt`), 'utf8');
	const samplesDir = path.join(RESULTS_DIR, meta.name, 'protocol-samples');
	fs.mkdirSync(samplesDir, { recursive: true });
	const outJson = path.join(RESULTS_DIR, `${meta.name}.headless.json`);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });

	if (!flags.skipBuild && !LAYOUT.packaged) {
		const compile = spawnSync('npm', ['run', 'build:extensions'], {
			cwd: LAYOUT.repoRoot,
			encoding: 'utf8',
			shell: true,
			timeout: 300_000,
		});
		if (compile.status !== 0) {
			die(`build:extensions failed:\n${compile.stdout}\n${compile.stderr}`);
		}
	}

	const args = [
		path.join(HERE, 'headlessAgent.mjs'),
		'--workspace',
		meta.dir,
		'--task',
		prompt,
		'--out',
		outJson,
		'--samplesDir',
		samplesDir,
		'--weak',
		String(flags.weak ?? 'on'),
	];
	if (flags.server) args.push('--server', String(flags.server));
	if (flags.model) args.push('--model', String(flags.model));
	if (flags.maxSteps) args.push('--maxSteps', String(flags.maxSteps));
	if (flags.hardCap) args.push('--hardCap', String(flags.hardCap));
	if (flags.sampling) args.push('--sampling', String(flags.sampling));
	args.push('--profileHome', path.join(os.homedir(), '.CodeForge'));

	console.log(`Headless run ${meta.name}…`);
	const agentEnv = {
		...process.env,
		CODEFORGE_EXT_OUT: LAYOUT.extOut,
		NODE_PATH: [
			path.join(LAYOUT.extRoot, 'node_modules'),
			path.join(LAYOUT.repoRoot, 'node_modules'),
			process.env.NODE_PATH || '',
		]
			.filter(Boolean)
			.join(path.delimiter),
	};
	if (flags.disableHysteresis || flags.calibrate) {
		agentEnv.CODEFORGE_DISABLE_HYSTERESIS = '1';
	}
	if (flags.harnessFile) {
		agentEnv.CODEFORGE_HARNESS_FILE = path.resolve(String(flags.harnessFile));
	}
	const agent = spawnSync(process.execPath, args, {
		cwd: LAYOUT.repoRoot,
		encoding: 'utf8',
		timeout: 3_600_000,
		env: agentEnv,
	});
	if (agent.status === 2) {
		process.stdout.write(agent.stdout || '');
		process.stderr.write(agent.stderr || '');
		if (flags.softFail) {
			return {
				pass: false,
				score: 0,
				infrastructureError: true,
				notRun: true,
				loopExit: 'error',
				task: taskKey,
			};
		}
		process.exit(2);
	}
	if (agent.status !== 0) {
		if (flags.softFail) {
			return {
				pass: false,
				score: 0,
				infrastructureError: true,
				notRun: true,
				loopExit: 'error',
				task: taskKey,
			};
		}
		console.error(agent.stdout);
		console.error(agent.stderr);
		throw new Error(`headless agent exited ${agent.status}`);
	}
	process.stdout.write(agent.stdout || '');

	const headless = readJson(outJson) || {};
	const scored = cmdCheck(meta.name, { save: true, print: true });
	const merged = {
		...scored,
		runtime: 'headless',
		model: headless.model,
		server: headless.server,
		loopExit: headless.loopExit,
		steps: headless.steps,
		refusals: headless.refusals,
		protocol: headless.protocol,
		toolCallMode: headless.toolCallMode,
		elapsedMs: headless.elapsedMs,
		headlessReply: headless.replyPreview,
		replyTail: headless.replyTail,
	};
	const resultPath = path.join(RESULTS_DIR, `${meta.name}.json`);
	fs.writeFileSync(resultPath, JSON.stringify(merged, null, 2));
	console.log(`Merged headless metrics → results/${meta.name}.json`);
	return merged;
}

function cmdSelftest(filter) {
	RUNS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bench-selftest-'));
	let ok = true;
	try {
		const tasks = loadTasks().filter(t => !filter || t.id.toLowerCase().startsWith(String(filter).toLowerCase()));
		for (const task of tasks) {
			if (!fs.existsSync(path.join(task.dir, 'solution.json'))) {
				console.log(`skip ${task.id} (no solution.json)`);
				continue;
			}
			const meta = cmdSetup(task.id, { label: 'selftest', quiet: true });
			const before = cmdCheck(meta.name, { save: false, print: false });
			applySolution(meta.dir, task.dir);
			const after = cmdCheck(meta.name, { save: false, print: false });
			const expectBaselineFail = task.category !== 'scaffold';
			const good =
				(expectBaselineFail ? !before.pass : true) && after.pass && after.score === 100;
			ok &&= good;
			console.log(
				`${good ? 'ok  ' : 'BAD '} ${task.id.padEnd(24)} baseline ${before.pass ? 'PASS' : 'fail'} ${before.hidden.pass}/${before.hidden.pass + before.hidden.fail} · solution ${after.pass ? 'pass' : 'FAIL'} score ${after.score}`
			);
			if (!good) {
				console.log(`     hidden failed: ${after.hidden.failed.join(' | ') || '-'}`);
				console.log(`     visible failed: ${after.visible.failed.join(' | ') || '-'}`);
				console.log(`     checks: ${JSON.stringify(after.checks)} bonus: ${JSON.stringify(after.bonus)}`);
				console.log(`     visible out tail:\n${(after.visible?.failed, '')}`);
			}
		}
	} finally {
		fs.rmSync(RUNS_ROOT, { recursive: true, force: true });
	}
	if (!ok) process.exit(1);
}

/**
 * Classify a failed (or suspicious) run from structured fields — not reply text.
 * A = harness (no writes / stuck / refusals), B = protocol (badArgs/normalize/truncated),
 * C = semantic (wrote + oracle green but hidden red).
 */
function classifyFailure(r) {
	if (r.pass && !r.falseDone) return null;
	const writes = Number(r.session?.writes ?? r.changedFiles?.length ?? 0);
	const exit = String(r.loopExit || '');
	const refusals = r.refusals || {};
	const refusalN = Object.values(refusals).reduce((a, b) => a + Number(b || 0), 0);
	const proto = r.protocol || {};
	const badArgs = Number(proto.badArgs || 0);
	const normalizeErr = Number(proto.normalize_error || proto.normalizeError || 0);
	const truncated = Number(proto.lengthExits || proto.truncated_tool_json || 0);
	const classes = [];
	if (writes === 0 || exit === 'stuck' || refusalN > 0) classes.push('A-harness');
	if (badArgs > 0 || normalizeErr > 0 || truncated > 0 || exit === 'length') classes.push('B-protocol');
	if (
		writes > 0 &&
		(r.falseDone || (Number(r.hidden?.fail || 0) > 0 && !r.falseDone))
	) {
		classes.push('C-semantic');
	}
	if (!classes.length) classes.push(r.pass ? 'ok' : 'unknown');
	return classes.join('+');
}

function printResult(r) {
	const s = r.session;
	const failClass = classifyFailure(r);
	console.log(
		`${r.pass ? 'PASS' : 'FAIL'}  ${r.run}  score ${r.score}/100  (${r.model || 'no session found'}${r.runtime ? ` · ${r.runtime}` : ''}${failClass ? ` · ${failClass}` : ''})`
	);
	if (r.review) {
		const v = r.review;
		console.log(
			`  review        F1 ${v.f1} (precision ${v.precision}, recall ${v.recall}) · found ${v.found.join(', ') || '-'} · missed ${v.missed.join(', ') || '-'} · ${v.falsePositives} false positives`
		);
	}
	if (r.hidden.cards) {
		console.log(
			`  cards         ${r.hidden.cards.map(c => `${c.card} ${c.pass}/${c.pass + c.fail}`).join(' · ')}`
		);
	}
	console.log(
		`  hidden tests  ${r.hidden.pass}/${r.hidden.pass + r.hidden.fail}${r.hidden.failed.length ? `  failed: ${r.hidden.failed.join(' | ')}` : ''}`
	);
	console.log(
		`  visible tests ${r.visible.pass}/${r.visible.pass + r.visible.fail}${r.visible.failed.length ? `  failed: ${r.visible.failed.join(' | ')}` : ''}`
	);
	console.log(`  changed       ${r.changedFiles.join(', ') || '(nothing)'}`);
	if (r.protectedTouched.length) console.log(`  PROTECTED     ${r.protectedTouched.join(', ')}`);
	if (r.junkFiles.length) console.log(`  junk files    ${r.junkFiles.join(', ')}`);
	for (const c of r.checks) console.log(`  check ${c.ok ? 'ok  ' : 'FAIL'}    ${c.why}${c.detail ? ` (${c.detail})` : ''}`);
	for (const c of r.bonus) console.log(`  bonus ${c.ok ? 'ok  ' : 'miss'}    ${c.why}`);
	if (!s.sessions) {
		console.log('  session       none found for this folder (was the chat run in this workspace?)');
		return;
	}
	console.log(
		`  agent         ${s.llmCalls} LLM calls · ${s.tools} tools (${s.toolFails} failed) · ${s.writes} writes · ${s.shells} shells (${s.shellFails} failed)`
	);
	console.log(
		`  reads         ${s.reads} (${s.readUniquePaths} files, ${s.readRepeats} repeated windows) · tools: ${Object.entries(s.byTool)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')}`
	);
	console.log(
		`  context       ${s.tokensIn} tokens in (max prompt ${s.maxPromptTokens}) · ${s.tokensOut} out · ${s.compacts} compacts · ${s.overflowErrors} overflows · ${s.llmErrors} LLM errors`
	);
	console.log(`  time          ${Math.round(s.wallSeconds / 60)} min · ${s.userMessages} user messages · ${s.sessions} session(s)`);
	console.log(
		`  honesty       ${r.falseDone ? 'FALSE DONE (claimed green, tests red)' : s.claimedGreen ? 'claimed green (true)' : 'no green claim'} · harness text ${s.harnessChars ?? 0} chars`
	);
}

function cmdReport() {
	const results = (fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [])
		.filter(f => f.endsWith('.json'))
		.map(f => readJson(path.join(RESULTS_DIR, f)))
		.filter(Boolean)
		.sort((a, b) => a.task.localeCompare(b.task) || a.label.localeCompare(b.label));
	if (!results.length) die('No results yet. Use: check');

	const rows = results.map(r => ({
		task: r.task.split('-')[0],
		label: r.label,
		rt: r.runtime || 'node',
		model: (r.model || '-').slice(0, 18),
		pass: r.pass ? 'PASS' : 'fail',
		score: r.score,
		class: classifyFailure(r) || (r.pass ? '' : '?'),
		exit: r.loopExit || '',
		hidden: r.review ? `F1 ${r.review.f1}` : `${r.hidden.pass}/${r.hidden.pass + r.hidden.fail}`,
		cards: r.hidden.cards ? r.hidden.cards.filter(c => c.ratio === 1).length + `/${r.hidden.cards.length}` : '',
		falseDone: r.falseDone ? 'YES' : '',
		llm: r.session.llmCalls,
		harness: r.session.harnessChars ?? '-',
		tools: r.session.tools,
		writes: r.session.writes,
		min: Math.round(r.session.wallSeconds / 60),
	}));
	console.table(rows);
	const tallies = { 'A-harness': 0, 'B-protocol': 0, 'C-semantic': 0 };
	for (const r of results) {
		const c = classifyFailure(r);
		if (!c) continue;
		if (c.includes('A-harness')) tallies['A-harness'] += 1;
		if (c.includes('B-protocol')) tallies['B-protocol'] += 1;
		if (c.includes('C-semantic')) tallies['C-semantic'] += 1;
	}
	console.log(
		`Failure classes: A-harness=${tallies['A-harness']} B-protocol=${tallies['B-protocol']} C-semantic=${tallies['C-semantic']}`
	);
}

function modelSafe(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/[^\w.-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 120) || 'unknown';
}

/**
 * Calibrate one model (UI / --model) or A/B weak+strong (lab CLI).
 * Classification is from protocol stats, not from the model name.
 */
function cmdCalibrate(flags) {
	const settings = readJson(path.join(os.homedir(), '.CodeForge', 'ai', 'settings.json')) || {};
	const serverId = String(flags.server || settings.activeServerId || 'default');
	const singleModel = String(flags.model || '').trim();
	const weakFlag = String(flags['weak-model'] || flags.weakModel || '').trim();
	const strongFlag = String(flags['strong-model'] || flags.strongModel || '').trim();
	const models = singleModel
		? [singleModel]
		: weakFlag && strongFlag
			? [weakFlag, strongFlag]
			: [
					settings.activeModel || weakFlag || 'qwen3.6-35b',
				].filter(Boolean);
	if (!models.length) die('calibrate needs --model <id> (or --weak-model + --strong-model)');
	const reps = Math.max(1, Number(flags.reps || 3) || 3);
	const suite = ['T2', 'T4', 'CS2', 'CS3'];

	if (!flags.skipBuild && !LAYOUT.packaged) {
		const compile = spawnSync(
			'npx',
			['tsc', '-p', 'extensions/codeforge/tsconfig.json'],
			{
				cwd: LAYOUT.repoRoot,
				encoding: 'utf8',
				shell: true,
				timeout: 300_000,
			}
		);
		if (compile.status !== 0) {
			die(`tsc failed:\n${compile.stdout}\n${compile.stderr}`);
		}
	}

	const require = createRequire(import.meta.url);
	const {
		loadModelProfile,
		saveModelProfile,
		applyCalibrationFromStats,
	} = require(path.join(LAYOUT.extOut, 'agent', 'modelProfile.js'));

	const byModel = {};
	for (const model of models) {
		const results = [];
		const labelBase = `calibrate-${modelSafe(model)}`;
		for (let rep = 1; rep <= reps; rep++) {
			for (const task of suite) {
				console.log(`\n=== calibrate ${model} ${task} rep ${rep}/${reps} ===`);
				try {
					const r = cmdRun(task, {
						...flags,
						label: `${labelBase}-r${rep}`,
						model,
						server: serverId,
						skipBuild: true,
						disableHysteresis: true,
						// Session weak harness on during calibrate so the suite matches product weak path;
						// profile knobs after classify decide long-term cost.
						weak: 'on',
					});
					results.push(r);
				} catch (err) {
					console.error(err);
					results.push({ pass: false, score: 0, protocol: {}, task });
				}
			}
		}
		byModel[model] = results;
	}

	const date = new Date().toISOString().slice(0, 10);
	const lines = [
		`# Calibration — ${date}`,
		'',
		`Models: ${models.map(m => `\`${m}\``).join(', ')} · reps=${reps} · suite=${suite.join(',')}`,
		'',
		'| Model | Class | Pass | Mean score | badArgs/native | lengthExits | Knobs |',
		'|---|---|---:|---:|---:|---:|---|',
	];

	for (const model of models) {
		const results = byModel[model] || [];
		const n = results.length || 1;
		const passes = results.filter(r => r.pass).length;
		const meanScore = results.reduce((s, r) => s + (Number(r.score) || 0), 0) / n;
		let badArgs = 0;
		let native = 0;
		let lengthExits = 0;
		for (const r of results) {
			const p = r.protocol || {};
			badArgs += Number(p.badArgs) || 0;
			native += Number(p.nativeToolCalls) || 0;
			lengthExits += Number(p.lengthExits) || 0;
		}
		const badArgsRate = badArgs / Math.max(1, native);
		const passRate = passes / n;
		let profile = loadModelProfile(serverId, model, { applyHysteresis: false });
		profile.calibration = {
			at: new Date().toISOString(),
			suite: suite.join(','),
			passRate,
			meanScore,
			protocolMeans: {
				badArgs: badArgs / n,
				nativeToolCalls: native / n,
				lengthExits: lengthExits / n,
			},
		};
		const { profile: next, classification } = applyCalibrationFromStats(profile, {
			passRate,
			badArgsRate,
			lengthExits,
			totalRuns: n,
			nativeToolCalls: native,
		});
		profile = next;
		profile.calibration.classification = classification;
		// Prefer text transport when native parse leaks arguments (Qwen XML closers).
		const refusals = results.reduce((s, r) => {
			const ref = r.refusals || {};
			return s + Object.values(ref).reduce((a, b) => a + Number(b || 0), 0);
		}, 0);
		if (badArgsRate >= 0.1 || (native > 0 && refusals / Math.max(1, native) >= 0.1)) {
			profile.toolTransport = 'text';
		} else if (classification === 'strong' && badArgsRate < 0.05) {
			profile.toolTransport = 'native';
		}
		saveModelProfile(profile);
		const knobs =
			classification === 'strong'
				? `strong: writeMax=${profile.mutations.writeMaxContentLines}, massRewrite=${profile.mutations.enforceMassRewriteGate}, weakSkill=${profile.prompt.forcedWeakSkill}, transport=${profile.toolTransport || 'native'}`
				: `weak: defaults, transport=${profile.toolTransport || 'native'}`;
		lines.push(
			`| ${model} | ${classification} | ${passes}/${n} | ${meanScore.toFixed(1)} | ${badArgsRate.toFixed(3)} | ${lengthExits} | ${knobs.replace(/\|/g, '/')} |`
		);
	}

	lines.push('');
	lines.push(
		'Class **strong** when `passRate ≥ 0.5`, `badArgs/native < 0.05`, `lengthExits === 0`, and native tool calls > 0; otherwise **weak**. High badArgs → `toolTransport=text`.'
	);
	lines.push('Profiles: `~/.CodeForge/ai/model-profiles/<serverId>/<model>/profile.json`.');
	const outMd = path.join(RESULTS_DIR, `CALIBRATE-${date}.md`);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.writeFileSync(outMd, lines.join('\n') + '\n', 'utf8');
	console.log(lines.join('\n'));
	console.log(`\nWrote ${outMd}`);
}

function isInfrastructureError(r) {
	return !!(r?.infrastructureError || r?.notRun || r?.loopExit === 'error');
}

function emptyPairedByTask(tasks) {
	return Object.fromEntries(tasks.map(t => [t, { parent: [], candidate: [] }]));
}

async function probeReviseLlm(server, model) {
	try {
		const res = await fetch(`${String(server.baseUrl).replace(/\/$/, '')}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				max_tokens: 1,
				messages: [{ role: 'user', content: 'ping' }],
			}),
			signal: AbortSignal.timeout(15_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function writeReviseDeferredSnapshot(rev, serverId, model, reason) {
	const dir = path.dirname(rev.harnessFilePath(serverId, model));
	fs.mkdirSync(dir, { recursive: true });
	const snap = {
		at: new Date().toISOString(),
		note: 'Harness revise deferred — local LLM was not reachable (same pattern as offline baselines).',
		reason,
	};
	const fp = path.join(dir, 'revise-deferred.json');
	fs.writeFileSync(fp, JSON.stringify(snap, null, 2), 'utf8');
	console.log(`Deferred harness revision (no live LLM). Wrote ${fp}`);
	return fp;
}

/**
 * One test-time harness revision. The same model proposes; T2/T4 score the
 * change (CS2/CS3 stay held out). harness.json updates only when a keep survives
 * holdout checks.
 */
async function cmdRevise(flags) {
	const settings = readJson(path.join(os.homedir(), '.CodeForge', 'ai', 'settings.json')) || {};
	const serverId = String(flags.server || settings.activeServerId || 'default');
	const model = String(
		flags.model ||
			(settings.activeServerId === serverId ? settings.activeModel : '') ||
			''
	).trim();
	if (!model) die('revise needs --model <id> (or an active model in settings)');
	const repsEach = Math.max(1, Number(flags.reps || 3) || 3);
	const suite = String(flags.tasks || 'T2,T4')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
	if (!suite.length) die('revise needs at least one task');

	const server = (settings.servers || []).find(s => s.id === serverId && s.enabled !== false);
	if (!server?.baseUrl?.trim()) die(`no usable server (id=${serverId})`);

	const require = createRequire(import.meta.url);
	// Probe LLM before compile / score-count gates so offline runs defer immediately.
	const revEarly = (() => {
		try {
			return require(path.join(LAYOUT.extOut, 'agent', 'harnessRevision.js'));
		} catch {
			return null;
		}
	})();
	const llmOkEarly = await probeReviseLlm(server, model);
	if (!llmOkEarly) {
		if (revEarly) {
			writeReviseDeferredSnapshot(revEarly, serverId, model, 'LLM probe failed');
			return;
		}
		die('LLM probe failed and harnessRevision.js is not built (run build:extensions)');
	}

	if (repsEach * suite.length < 3) {
		die(
			`revise needs at least 3 scores (tasks × reps). Got ${suite.length}×${repsEach}. One run is noise.`
		);
	}

	if (!flags.skipBuild && !LAYOUT.packaged) {
		const compile = spawnSync('npx', ['tsc', '-p', 'extensions/codeforge/tsconfig.json'], {
			cwd: LAYOUT.repoRoot,
			encoding: 'utf8',
			shell: true,
			timeout: 300_000,
		});
		if (compile.status !== 0) die(`tsc failed:\n${compile.stdout}\n${compile.stderr}`);
	}

	const rev = revEarly || require(path.join(LAYOUT.extOut, 'agent', 'harnessRevision.js'));
	const telemetry = require(path.join(LAYOUT.extOut, 'agent', 'protocolTelemetry.js'));
	const file = rev.harnessFilePath(serverId, model);
	const parent = rev.loadHarnessArtifact(serverId, model, file);
	const report = rev.formatExecutionReport(telemetry.loadModelRollup(serverId, model));
	console.log(`Harness revision for ${model} on ${server.name || serverId}`);
	console.log(`Selection suite: ${suite.join(', ')} × ${repsEach} (held out of this decision: tasks not listed).`);
	console.log(report);

	const parentOutcomes = [];
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-revise-harness-'));
	const taskKeys = suite.map(k => findTask(k).id.split('-')[0]);

	const benchRun = (taskKey, labelSuffix, harnessFile) => {
		const r = cmdRun(taskKey, {
			...flags,
			model,
			server: serverId,
			label: labelSuffix,
			skipBuild: true,
			disableHysteresis: true,
			softFail: true,
			harnessFile,
		});
		if (isInfrastructureError(r)) {
			console.warn(`Skipping infrastructure error for ${taskKey} (${labelSuffix})`);
			return undefined;
		}
		const score = Number(r?.score);
		if (!Number.isFinite(score)) {
			throw new Error(`no score for ${taskKey} (${labelSuffix})`);
		}
		return { score, r, taskKey };
	};

	const harnessFileFor = artifact => {
		if (artifact.revision === parent.revision) return file;
		const fp = path.join(tempDir, `harness-r${artifact.revision}.json`);
		rev.saveHarnessArtifact(artifact, fp);
		return fp;
	};

	const pushOutcome = (taskId, r, score) => {
		parentOutcomes.push({
			task: taskId,
			score,
			loopExit: r.loopExit || undefined,
			steps: typeof r.steps === 'number' ? r.steps : undefined,
			hiddenFailed: r.hidden?.failed ?? [],
			checksFailed: (r.checks ?? [])
				.filter(c => !c.ok)
				.map(c => [c.why || c.type, c.detail].filter(Boolean).join(' ')),
			replyTail:
				typeof r.replyTail === 'string'
					? r.replyTail
					: typeof r.headlessReply === 'string'
						? r.headlessReply.slice(-500)
						: undefined,
		});
	};

	const scorePhase = async input => {
		const byTask = emptyPairedByTask(taskKeys);
		if (input.phase === 'parent') {
			for (const task of suite) {
				const taskId = findTask(task).id;
				const short = taskId.split('-')[0];
				for (let rep = 1; rep <= repsEach; rep++) {
					console.log(`\n=== revise parent ${short} rep ${rep}/${repsEach} ===`);
					const run = benchRun(
						task,
						`revise-parent-${short}-rep${rep}`,
						harnessFileFor(input.artifact)
					);
					if (!run) continue;
					byTask[short].parent.push(run.score);
					pushOutcome(taskId, run.r, run.score);
				}
			}
			const text = rev.formatTaskOutcomes(parentOutcomes);
			if (text) console.log(`\n${text}`);
			return { byTask };
		}

		for (const task of suite) {
			const taskId = findTask(task).id;
			const short = taskId.split('-')[0];
			for (let rep = 1; rep <= repsEach; rep++) {
				console.log(`\n=== revise paired ${short} rep ${rep}/${repsEach} (parent) ===`);
				const parentRun = benchRun(
					task,
					`revise-paired-parent-${short}-rep${rep}`,
					harnessFileFor(input.parent)
				);
				if (!parentRun) continue;
				byTask[short].parent.push(parentRun.score);

				console.log(`\n=== revise paired ${short} rep ${rep}/${repsEach} (candidate r${input.candidate.revision}) ===`);
				const candRun = benchRun(
					task,
					`revise-paired-cand-r${input.candidate.revision}-${short}-rep${rep}`,
					harnessFileFor(input.candidate)
				);
				if (!candRun) continue;
				byTask[short].candidate.push(candRun.score);
			}
		}
		return { byTask };
	};

	const scoreHoldout = async (artifact, holdoutTasks, labelPrefix, side) => {
		const byTask = emptyPairedByTask(holdoutTasks.map(t => findTask(t).id.split('-')[0]));
		for (const task of holdoutTasks) {
			const short = findTask(task).id.split('-')[0];
			for (let rep = 1; rep <= repsEach; rep++) {
				console.log(`\n=== ${labelPrefix} holdout ${short} rep ${rep}/${repsEach} ===`);
				const run = benchRun(
					task,
					`${labelPrefix}-holdout-${short}-rep${rep}`,
					harnessFileFor(artifact)
				);
				if (!run) continue;
				byTask[short][side].push(run.score);
			}
		}
		return byTask;
	};

	try {
		let outcome = await rev.executeHarnessRevision({
			artifact: parent,
			report,
			minRepsPerTask: 3,
			parentOutcomes: () => parentOutcomes,
			propose: async messages => {
				const res = await fetch(`${String(server.baseUrl).replace(/\/$/, '')}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
					},
					body: JSON.stringify({
						model,
						temperature: 0.2,
						max_tokens: 4096,
						enable_thinking: false,
						chat_template_kwargs: { enable_thinking: false },
						messages,
					}),
				});
				const body = await res.text();
				if (!res.ok) throw new Error(`proposer HTTP ${res.status}: ${body.slice(0, 500)}`);
				const data = JSON.parse(body);
				const message = data?.choices?.[0]?.message ?? {};
				const content = [message.content, message.reasoning_content, message.reasoning]
					.filter(part => typeof part === 'string' && part.trim())
					.join('\n');
				if (!content.trim()) throw new Error('proposer returned an empty message');
				console.log(`Proposer reply:\n${content.slice(0, 1500)}`);
				return content;
			},
			score: scorePhase,
		});

		if (outcome.kept) {
			const holdout = ['CS2', 'CS3'];
			console.log(`\nHoldout validation: ${holdout.join(', ')} × ${repsEach}`);
			const parentHold = await scoreHoldout(parent, holdout, 'parent', 'parent');
			const candHold = await scoreHoldout(outcome.artifact, holdout, 'candidate', 'candidate');
			const holdReason = rev.holdoutRegressed(parentHold, candHold);
			if (holdReason) {
				console.log(`Holdout failed: ${holdReason}`);
				const entry = {
					at: new Date().toISOString(),
					decision: 'revert',
					reason: `holdout: ${holdReason}`,
					diagnosis: outcome.diagnosis,
					parentMean: outcome.parentMean,
					candidateMean: outcome.candidateMean,
					parentReps: outcome.artifact.history.at(-1)?.parentReps ?? 0,
					candidateReps: outcome.artifact.history.at(-1)?.candidateReps ?? 0,
				};
				outcome = {
					...outcome,
					kept: false,
					reason: entry.reason,
					artifact: {
						...parent,
						history: [...parent.history, entry].slice(-20),
					},
				};
			}
		}

		if (outcome.kept) {
			rev.saveHarnessArtifact(outcome.artifact, file);
		} else if (outcome.scored || outcome.artifact.history.length > parent.history.length) {
			rev.saveHarnessArtifact(outcome.artifact, file);
		}
		console.log(
			`\n${outcome.kept ? 'KEPT' : 'REVERTED'} revision ${outcome.kept ? outcome.artifact.revision : parent.revision}: ${outcome.reason}`
		);
		if (outcome.diagnosis) console.log(`Diagnosis: ${outcome.diagnosis}`);
		console.log(`Harness file: ${file}`);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------

const { pos, flags } = parseArgs(process.argv.slice(2));
switch (pos[0]) {
	case 'list':
		for (const t of loadTasks()) {
			const rt = taskRuntime(t);
			console.log(
				`${t.id.padEnd(24)} ${(t.category || '').padEnd(11)} ${rt.padEnd(7)} ${t.title}`
			);
		}
		break;
	case 'setup':
		cmdSetup(pos[1], flags);
		break;
	case 'check':
		cmdCheck(pos[1]);
		break;
	case 'report':
		cmdReport();
		break;
	case 'selftest':
		cmdSelftest(pos[1]);
		break;
	case 'run':
		cmdRun(pos[1], flags);
		break;
	case 'calibrate':
		cmdCalibrate(flags);
		break;
	case 'revise':
		cmdRevise(flags).catch(err => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
		break;
	default:
		console.log(
			'Usage: node benchmarks/bench.mjs <list | setup <task> --label <name> [--open] | check [run|latest] | report | selftest [CS] | run <task> --label <name> | calibrate [--model m | --weak-model m --strong-model m] [--reps n] | revise [--model m] [--reps n] [--tasks T2,T4]>'
		);
}
