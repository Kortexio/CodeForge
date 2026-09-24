/**
 * Review pipeline core: signals → per-file findings → confirmed, deduplicated BUGS.md.
 * Pure — no vscode, no fs.
 */

export interface Finding {
	file: string;
	line: number;
	kind: string;
	evidence: string;
	description: string;
	confidence: number;
	confirmed?: boolean;
}

export interface FileSignal {
	line: number;
	code: string;
	msg: string;
	source: 'build' | 'format' | 'test' | 'lsp';
}

export const REVIEW_CHECKLIST = [
	'null / missing values',
	'boundaries and off-by-one (loops, ranges, >= vs >)',
	'money and rounding (decimal, rounding mode, order of operations)',
	'exceptions (swallowed, wrong type, wrong message)',
	'async (missing await, fire-and-forget)',
	'contract vs docs/ (rates, formulas, rules, names)',
	'configuration binding (case, keys, defaults)',
];

const SOURCE_EXT = /\.(cs|ts|tsx|js|jsx|py|go|java|kt|rs)$/i;
const SKIP_PATH = /(^|\/)(bin|obj|node_modules|\.git|\.vs|\.CodeForge|TestResults|dist|out)(\/|$)/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(tests?|spec)\.\w+$|Tests?\.cs$/i;

export function isReviewableSource(rel: string): boolean {
	const p = rel.replace(/\\/g, '/');
	return SOURCE_EXT.test(p) && !SKIP_PATH.test(p) && !TEST_PATH.test(p);
}

/** `path(12,5): warning CS8602: ... [proj]` lines grouped by relative file. */
export function parseCompilerSignals(output: string, root: string, source: FileSignal['source']): Map<string, FileSignal[]> {
	const byFile = new Map<string, FileSignal[]>();
	const rootNorm = root.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
	for (const raw of String(output || '').split(/\r?\n/)) {
		const m = /^\s*(.+?)\((\d+)(?:,\d+)?\):\s*(warning|error)\s+([A-Z]+\d*|[A-Z]+):\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(raw);
		if (!m) continue;
		let file = m[1].replace(/\\/g, '/');
		if (file.toLowerCase().startsWith(`${rootNorm}/`)) file = file.slice(rootNorm.length + 1);
		const list = byFile.get(file) ?? [];
		if (!list.some(s => s.line === Number(m[2]) && s.code === m[4])) {
			list.push({ line: Number(m[2]), code: m[4], msg: m[5].trim(), source });
		}
		byFile.set(file, list);
	}
	return byFile;
}

/**
 * Files to review: those with signals first, then the most referenced by other files
 * (by basename), up to `max`.
 */
export function pickCandidateFiles(
	files: Array<{ rel: string; text: string }>,
	signals: Map<string, FileSignal[]>,
	max = 8
): string[] {
	const sources = files.filter(f => isReviewableSource(f.rel));
	const refs = new Map<string, number>();
	for (const f of sources) {
		const name = f.rel.split('/').pop()!.replace(/\.\w+$/, '');
		if (name.length < 3) continue;
		const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
		let n = 0;
		for (const other of files) if (other.rel !== f.rel) n += (other.text.match(re) ?? []).length;
		refs.set(f.rel, n);
	}
	const signalCount = (rel: string) => {
		const key = [...signals.keys()].find(k => k.toLowerCase() === rel.toLowerCase() || k.toLowerCase().endsWith(`/${rel.toLowerCase()}`));
		return key ? (signals.get(key)?.length ?? 0) : 0;
	};
	return sources
		.map(f => ({ rel: f.rel, s: signalCount(f.rel), r: refs.get(f.rel) ?? 0 }))
		.sort((a, b) => b.s - a.s || b.r - a.r || a.rel.localeCompare(b.rel))
		.slice(0, max)
		.map(x => x.rel);
}

export function numberLines(text: string): string {
	return text
		.split(/\r?\n/)
		.map((l, i) => `${String(i + 1).padStart(4, ' ')}|${l}`)
		.join('\n');
}

export function mapPrompt(opts: {
	file: string;
	numbered: string;
	totalLines: number;
	signals: FileSignal[];
	docs: string[];
}): string {
	const parts = [
		`Review \`${opts.file}\` for bugs (${opts.totalLines} lines, shown below with line numbers).`,
		'',
		'Checklist:',
		...REVIEW_CHECKLIST.map(c => `- ${c}`),
	];
	if (opts.docs.length) {
		parts.push('', `Specs to compare against (read them): ${opts.docs.map(d => `\`${d}\``).join(', ')}`);
	}
	if (opts.signals.length) {
		parts.push('', 'Compiler/test signals for this file:', ...opts.signals.map(s => `- L${s.line} ${s.code} ${s.msg} (${s.source})`));
	}
	parts.push(
		'',
		'```',
		opts.numbered,
		'```',
		'',
		'Report only real defects (wrong behavior), not style. For each, quote the exact code of that line as evidence.',
		'Reply with JSON only:',
		'{"findings":[{"file":"<path>","line":<n>,"kind":"<checklist item>","evidence":"<exact code>","description":"<what is wrong and what is expected>","confidence":<0..1>}]}',
		'Use {"findings":[]} when the file has no defects.'
	);
	return parts.join('\n');
}

function toFinding(o: Record<string, unknown>, defaultFile: string): Finding | undefined {
	const line = Number(o.line ?? o.lineNumber ?? 0);
	if (!Number.isFinite(line) || line <= 0) return undefined;
	const conf = Number(o.confidence ?? 0.5);
	return {
		file: String(o.file ?? o.path ?? defaultFile).replace(/\\/g, '/') || defaultFile,
		line: Math.round(line),
		kind: String(o.kind ?? o.type ?? 'bug'),
		evidence: String(o.evidence ?? o.code ?? '').trim(),
		description: String(o.description ?? o.message ?? o.why ?? '').trim(),
		confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
	};
}

/** Findings from a map reply: JSON (object or array), else `path:line — text` lines. */
export function parseFindings(reply: string, defaultFile: string): Finding[] {
	const t = String(reply || '');
	for (const c of [/```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1], /\{[\s\S]*\}/.exec(t)?.[0], /\[[\s\S]*\]/.exec(t)?.[0]]) {
		if (!c) continue;
		try {
			const parsed = JSON.parse(c) as unknown;
			const arr = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown }).findings;
			if (Array.isArray(arr)) {
				return arr
					.map(x => (x && typeof x === 'object' ? toFinding(x as Record<string, unknown>, defaultFile) : undefined))
					.filter((x): x is Finding => !!x);
			}
		} catch {
			/* next candidate */
		}
	}
	const out: Finding[] = [];
	for (const m of t.matchAll(/([\w./\\-]+\.\w+):(\d+)\s*[—–:-]\s*(.+)/g)) {
		out.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), kind: 'bug', evidence: '', description: m[3].trim(), confidence: 0.5 });
	}
	return out;
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * Confirm a finding against the file: the quoted evidence must exist near the claimed line
 * (the line is corrected to where it is). Without evidence, the claimed line must exist.
 */
export function confirmFinding(f: Finding, fileText: string, window = 8): Finding | undefined {
	const lines = fileText.split(/\r?\n/);
	const ev = squash(f.evidence.replace(/^\s*\d+\|/, ''));
	if (ev.length >= 6) {
		const matches = lines.map((l, i) => (squash(l).includes(ev) || (ev.includes(squash(l)) && squash(l).length >= 8) ? i + 1 : 0)).filter(Boolean);
		if (matches.length) {
			const nearest = matches.sort((a, b) => Math.abs(a - f.line) - Math.abs(b - f.line))[0];
			if (Math.abs(nearest - f.line) <= window || matches.length === 1) {
				return { ...f, line: nearest, confirmed: true };
			}
		}
		return f.confidence >= 0.8 && f.line <= lines.length ? { ...f, confirmed: false } : undefined;
	}
	if (f.line > lines.length || !lines[f.line - 1]?.trim()) return undefined;
	return f.confidence >= 0.6 ? { ...f, confirmed: false } : undefined;
}

/** One finding per file+line neighbourhood (highest confidence wins). */
export function dedupeFindings(findings: Finding[], tolerance = 2): Finding[] {
	const sorted = [...findings].sort((a, b) => Number(b.confirmed ?? false) - Number(a.confirmed ?? false) || b.confidence - a.confidence);
	const out: Finding[] = [];
	for (const f of sorted) {
		if (out.some(o => o.file.toLowerCase() === f.file.toLowerCase() && Math.abs(o.line - f.line) <= tolerance)) continue;
		out.push(f);
	}
	return out;
}

export function formatBugsMd(findings: Finding[], meta: { files: string[]; signals: number }): string {
	const lines = ['# Bugs', ''];
	if (!findings.length) {
		lines.push('No confirmed bugs.');
	}
	for (const f of findings) {
		const tag = f.confirmed === false ? ' (unconfirmed)' : '';
		const desc = f.description || f.kind;
		lines.push(`- ${f.file}:${f.line} — ${desc}${tag}`);
		if (f.evidence) lines.push(`  \`${f.evidence.replace(/`/g, "'").slice(0, 160)}\``);
	}
	lines.push('', `_Files reviewed: ${meta.files.join(', ') || '-'} · build/test signals: ${meta.signals}_`, '');
	return lines.join('\n');
}
