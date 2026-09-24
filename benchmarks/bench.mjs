#!/usr/bin/env node
/**
 * CodeForge harness benchmark — semi-automatic (the agent runs inside the IDE).
 *
 *   node benchmarks/bench.mjs list
 *   node benchmarks/bench.mjs setup CS1 --label bonsai [--open]
 *   node benchmarks/bench.mjs check latest
 *   node benchmarks/bench.mjs report
 *   node benchmarks/bench.mjs selftest
 *
 * Runs live in %USERPROFILE%/codeforge-bench (override with CODEFORGE_BENCH_DIR).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = {
	shop: path.join(HERE, 'fixtures', 'shop'),
	billing: path.join(HERE, 'fixtures', 'billing'),
	scaffold: path.join(HERE, 'fixtures', 'scaffold'),
	'billing-bugs': path.join(HERE, 'fixtures', 'billing-bugs'),
	'router-cards': path.join(HERE, 'fixtures', 'router-cards'),
};
const TASKS_DIR = path.join(HERE, 'tasks');
const RESULTS_DIR = path.join(HERE, 'results');
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
		if (hasHidden) {
			fs.rmSync(hiddenTarget, { recursive: true, force: true });
			copyFixture(hiddenSrc, hiddenTarget);
		}
		const visible = runDotnetTests(dir, {
			filter: hasHidden ? 'FullyQualifiedName!~BenchHidden' : undefined,
		});
		let hidden = { pass: 0, fail: 0, output: '(no hidden)', skipped: !hasHidden };
		if (hasHidden) {
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

function printResult(r) {
	const s = r.session;
	console.log(
		`${r.pass ? 'PASS' : 'FAIL'}  ${r.run}  score ${r.score}/100  (${r.model || 'no session found'}${r.runtime ? ` · ${r.runtime}` : ''})`
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
	default:
		console.log(
			'Usage: node benchmarks/bench.mjs <list | setup <task> --label <name> [--open] | check [run|latest] | report | selftest [CS]>'
		);
}
