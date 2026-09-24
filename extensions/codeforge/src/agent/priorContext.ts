import type { ToolTraceEntry } from '../sessions/sessionStore';
import { clipData, clipToolOutput } from './clip';

/**
 * Cursor-style continuity on "continua":
 * - Full path index (names only) so the model knows what was already explored
 * - Optional rolling summary
 * - Full bodies only for a small hot set (since last write, or last few tools) — never dump 100+ tours
 */
export function buildPriorAgentTranscript(
	traces: ToolTraceEntry[],
	budgetChars: number,
	contextBudget = 32768,
	rollingSummary?: string
): string | null {
	const useful = traces.filter(
		t =>
			t.success &&
			['read', 'list', 'retrieve', 'search', 'shell', 'dotnet', 'write', 'edit', 'wiki_read'].includes(t.name)
	);
	const isWrite = (t: ToolTraceEntry) => t.name === 'write' || t.name === 'edit';
	const pathOf = (t: ToolTraceEntry) => String(t.arguments.path ?? '').replace(/\\/g, '/').toLowerCase();
	const lastWriteAt = new Map<string, number>();
	useful.forEach((t, i) => {
		if (isWrite(t) && pathOf(t)) lastWriteAt.set(pathOf(t), i);
	});
	if (!useful.length) {
		return null;
	}

	const listed = new Set<string>();
	const readFiles = new Set<string>();
	for (const t of useful) {
		const p = typeof t.arguments.path === 'string' ? String(t.arguments.path).replace(/\\/g, '/') : '';
		if (t.name === 'list' && p) listed.add(p);
		if (t.name === 'read' && p) readFiles.add(p);
	}

	const parts: string[] = [
		'### Prior context from this chat',
		'Paths explored earlier and the most recent tool results.',
	];
	if (rollingSummary?.trim()) {
		parts.push('', '### Rolling summary', clipData(rollingSummary.trim(), 1500));
	}
	if (listed.size) {
		parts.push('', `Folders listed: ${[...listed].join(', ')}`);
	}
	if (readFiles.size) {
		parts.push(`Files read: ${[...readFiles].join(', ')}`);
	}

	// Hot set: tools since last write, else last few — dedupe reads by path (latest wins).
	let hotStart = useful.length;
	for (let i = useful.length - 1; i >= 0; i--) {
		if (isWrite(useful[i])) {
			hotStart = i;
			break;
		}
	}
	const sinceWrite = useful.slice(hotStart);
	const poolStart = sinceWrite.length > 0 && sinceWrite.length <= 14 ? hotStart : Math.max(0, useful.length - 8);
	const hotPool = useful
		.map((t, i) => ({ t, i }))
		.slice(poolStart)
		// A read followed by a write to the same file shows content that no longer exists.
		.filter(({ t, i }) => !(t.name === 'read' && (lastWriteAt.get(pathOf(t)) ?? -1) > i))
		.map(({ t }) => t)
		.slice(-(contextBudget >= 32000 ? 10 : 7));

	const hot: ToolTraceEntry[] = [];
	const seenRead = new Set<string>();
	let lists = 0;
	let shells = 0;
	let searches = 0;
	for (let i = hotPool.length - 1; i >= 0; i--) {
		const t = hotPool[i];
		if (t.name === 'read') {
			const p = String(t.arguments.path ?? '').toLowerCase();
			if (!p || seenRead.has(p)) continue;
			seenRead.add(p);
			hot.unshift(t);
		} else if (t.name === 'list') {
			if (lists >= 1) continue;
			lists += 1;
			hot.unshift(t);
		} else if (t.name === 'shell' || t.name === 'dotnet') {
			if (shells >= 2) continue;
			shells += 1;
			hot.unshift(t);
		} else if (t.name === 'search' || t.name === 'retrieve') {
			if (searches >= 1) continue;
			searches += 1;
			hot.unshift(t);
		} else if (isWrite(t) || t.name === 'wiki_read') {
			hot.unshift(t);
		}
	}

	const readBodyCap = contextBudget >= 32000 ? 1800 : contextBudget >= 16000 ? 1200 : 900;
	parts.push('', '### Recent tool bodies (hot set only)');
	let used = parts.join('\n').length;
	for (const t of hot) {
		const target = String(
			t.arguments.path ??
				t.arguments.query ??
				t.arguments.pattern ??
				t.arguments.command ??
				t.arguments.id ??
				''
		).slice(0, 100);
		const start =
			t.arguments.startLine !== undefined || t.arguments.offset !== undefined
				? ` startLine=${t.arguments.startLine ?? t.arguments.offset}`
				: '';
		const bodyCap =
			t.name === 'read'
				? readBodyCap
				: isWrite(t)
					? 800
					: t.name === 'shell' || t.name === 'dotnet'
						? 600
						: 350;
		const body = clipToolOutput(t.name, String(t.output ?? '').replace(/\r/g, ''), bodyCap);
		const block = `#### ${t.name} ${target}${start}\n${body}\n`;
		if (used + block.length > budgetChars) {
			parts.push(`…(hot-set truncated to fit prior-context budget: ${hot.length - hot.indexOf(t)} results omitted)`);
			break;
		}
		parts.push(block);
		used += block.length;
	}
	return parts.join('\n');
}
