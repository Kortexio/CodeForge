#!/usr/bin/env node
/**
 * Aggregate CodeForge agent traces (~/.CodeForge/ai/traces/*.jsonl).
 *
 * Usage:
 *   node scripts/traceStats.mjs
 *   node scripts/traceStats.mjs --since 2026-09-20
 *   node scripts/traceStats.mjs --session <sessionId>
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const EXPLORE = new Set([
	'list',
	'search',
	'read',
	'glob',
	'grep',
	'find',
	'symbols',
	'semantic_search',
	'codebase_search',
	'read_memory',
	'retrieve',
]);
const WRITE = new Set(['write', 'edit', 'apply_patch', 'multi_edit']);

function parseArgs(argv) {
	const out = { since: null, session: null, dir: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--since') out.since = argv[++i];
		else if (a === '--session') out.session = argv[++i];
		else if (a === '--dir') out.dir = argv[++i];
		else if (a === '--help' || a === '-h') {
			console.log(`Usage: node scripts/traceStats.mjs [--since YYYY-MM-DD] [--session id] [--dir path]`);
			process.exit(0);
		}
	}
	return out;
}

function median(arr) {
	if (!arr.length) return null;
	const a = [...arr].sort((x, y) => x - y);
	return a[Math.floor(a.length / 2)];
}

function mean(arr) {
	if (!arr.length) return null;
	return arr.reduce((s, n) => s + n, 0) / arr.length;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const dir =
		args.dir ||
		path.join(os.homedir(), '.CodeForge', 'ai', 'traces');
	if (!fs.existsSync(dir)) {
		console.error(`No traces dir: ${dir}`);
		process.exit(1);
	}

	const sinceMs = args.since ? Date.parse(args.since) : null;
	const files = fs
		.readdirSync(dir)
		.filter(f => f.endsWith('.jsonl') && !f.startsWith('session-'))
		.filter(f => {
			if (args.session && !f.startsWith(args.session)) return false;
			if (sinceMs != null) {
				const st = fs.statSync(path.join(dir, f));
				if (st.mtimeMs < sinceMs) return false;
			}
			return true;
		});

	let runs = 0;
	let steps = 0;
	let tools = 0;
	let explore = 0;
	let fails = 0;
	let reads = 0;
	let lists = 0;
	let retrieves = 0;
	const byLabel = {};
	const failBy = {};
	const perStep = {};
	const exploreBeforeWrite = [];
	const stepsBeforeWrite = [];

	for (const f of files) {
		const ev = fs
			.readFileSync(path.join(dir, f), 'utf8')
			.split('\n')
			.filter(Boolean)
			.map(l => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		const st = ev.filter(e => e.type === 'llm').length;
		if (st < 3) continue;
		runs += 1;
		steps += st;

		let e0 = 0;
		let s0 = 0;
		let wrote = false;
		let cur = 0;
		for (const e of ev) {
			if (e.type === 'llm') {
				if (!wrote) s0 += 1;
				perStep[cur] = (perStep[cur] || 0) + 1;
				cur = 0;
			}
			if (e.type !== 'tool') continue;
			tools += 1;
			cur += 1;
			byLabel[e.label] = (byLabel[e.label] || 0) + 1;
			const fl =
				String(e.detail || '').startsWith('FAILED') ||
				/^error/i.test(String(e.detail || '').slice(0, 40));
			if (fl) {
				fails += 1;
				failBy[e.label] = (failBy[e.label] || 0) + 1;
			}
			if (e.label === 'read') reads += 1;
			if (e.label === 'list') lists += 1;
			if (e.label === 'retrieve') retrieves += 1;
			if (EXPLORE.has(e.label)) {
				explore += 1;
				if (!wrote) e0 += 1;
			}
			if (WRITE.has(e.label) && !wrote) {
				wrote = true;
				exploreBeforeWrite.push(e0);
				stepsBeforeWrite.push(s0);
			}
		}
	}

	const summary = {
		dir,
		files: files.length,
		runs,
		steps,
		tools,
		toolsPerStep: steps ? +(tools / steps).toFixed(2) : null,
		exploreShare: tools ? +(explore / tools).toFixed(2) : null,
		fails,
		failRate: tools ? +(fails / tools).toFixed(2) : null,
		reads,
		lists,
		retrieves,
		readListPerRun: runs ? +((reads + lists) / runs).toFixed(2) : null,
		retrievePerRun: runs ? +(retrieves / runs).toFixed(2) : null,
		runsWithWrite: exploreBeforeWrite.length,
		medExploreBeforeFirstWrite: median(exploreBeforeWrite),
		medStepsBeforeFirstWrite: median(stepsBeforeWrite),
		meanStepsBeforeFirstWrite: mean(stepsBeforeWrite)
			? +mean(stepsBeforeWrite).toFixed(2)
			: null,
	};

	console.log(JSON.stringify(summary, null, 2));
	console.log('\n# tools per llm step (histogram)');
	console.log(perStep);
	console.log('\n# by label (top)');
	console.log(
		Object.entries(byLabel)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
	);
	console.log('\n# fails by label');
	console.log(failBy);
}

main();
