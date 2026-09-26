/**
 * Pure tool-protocol history hygiene (OpenAI-compat + Anthropic).
 * Kept free of vscode so unit tests can import it directly.
 */

import { clipData, clipToolOutput } from './clip';

export type ToolHistoryMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; text?: string }>;
	tool_call_id?: string;
	name?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
};

function plainText(content: ToolHistoryMessage['content']): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(p => (typeof p.text === 'string' ? p.text : '')).join(' ');
	}
	return '';
}

function isUsefulOrphanNote(text: string): boolean {
	if (!text || text.length < 40) return false;
	return /exit\s+\d+|error|FAIL|passed|build|test|CS\d+|dotnet/i.test(text);
}

/**
 * Drop tool messages whose tool_call_id is not owned by the preceding assistant tool_calls.
 * Useful orphan bodies (build/test output) become a short user note.
 */
export function dropOrphanToolResults(messages: ToolHistoryMessage[]): number {
	let removed = 0;
	const out: ToolHistoryMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'tool') {
			out.push(m);
			continue;
		}
		const id = m.tool_call_id;
		let owner: ToolHistoryMessage | undefined;
		for (let j = out.length - 1; j >= 0; j--) {
			const prev = out[j];
			if (prev.role === 'assistant') {
				owner = prev;
				break;
			}
			if (prev.role === 'user' || prev.role === 'system') break;
		}
		const owned =
			!!id &&
			!!owner?.tool_calls?.some(tc => tc.id === id);
		if (owned) {
			out.push(m);
			continue;
		}
		removed += 1;
		const text = plainText(m.content).trim();
		if (isUsefulOrphanNote(text)) {
			out.push({
				role: 'user',
				content: `Earlier tool result (kept as text)\n${m.name || 'tool'}: ${clipToolOutput(m.name || '', text, 1500)}`,
			});
		}
	}
	if (removed) {
		messages.splice(0, messages.length, ...out);
	}
	return removed;
}

/** Fill missing tool results for assistant tool_calls. */
export function repairMissingToolResults(messages: ToolHistoryMessage[]): number {
	let repaired = 0;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
		const have = new Set<string>();
		for (let j = i + 1; j < messages.length; j++) {
			const next = messages[j];
			if (next.role === 'assistant') break;
			if (next.role === 'tool' && next.tool_call_id) {
				have.add(next.tool_call_id);
			}
		}
		const missing = m.tool_calls.filter(tc => !have.has(tc.id));
		if (!missing.length) continue;
		const stubs: ToolHistoryMessage[] = missing.map(tc => ({
			role: 'tool' as const,
			tool_call_id: tc.id,
			name: tc.function.name,
			content: 'Skipped: tool result was missing from history (repaired).',
		}));
		messages.splice(i + 1, 0, ...stubs);
		repaired += stubs.length;
		i += stubs.length;
	}
	return repaired;
}

/**
 * 1) Drop orphan tool results
 * 2) Fill missing tool results
 * 3) Reorder tool results contiguously after their assistant turn
 */
export function normalizeToolProtocolHistory(messages: ToolHistoryMessage[]): number {
	let changes = dropOrphanToolResults(messages);
	changes += repairMissingToolResults(messages);
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
		const ids = new Set(m.tool_calls.map(tc => tc.id));
		const tools: ToolHistoryMessage[] = [];
		const others: ToolHistoryMessage[] = [];
		let j = i + 1;
		while (j < messages.length && messages[j].role !== 'assistant') {
			const n = messages[j];
			if (n.role === 'tool' && n.tool_call_id && ids.has(n.tool_call_id)) {
				tools.push(n);
			} else {
				others.push(n);
			}
			j++;
		}
		const byId = new Map(tools.map(t => [t.tool_call_id as string, t]));
		const orderedTools: ToolHistoryMessage[] = [];
		for (const tc of m.tool_calls) {
			const hit = byId.get(tc.id);
			if (hit) orderedTools.push(hit);
		}
		for (const t of tools) {
			if (!orderedTools.includes(t)) orderedTools.push(t);
		}
		const slice = [...orderedTools, ...others];
		const current = messages.slice(i + 1, j);
		const same =
			current.length === slice.length && current.every((c, idx) => c === slice[idx]);
		if (!same) {
			messages.splice(i + 1, j - (i + 1), ...slice);
			changes += 1;
		}
	}
	return changes;
}

/**
 * Mid-compact must not start the kept tail on a lone tool message
 * (orphan tool_result after digest drops the owning assistant).
 */
export function safeMidCompactTailStart(messages: ToolHistoryMessage[], preferFrom: number): number {
	let start = Math.max(1, preferFrom);
	while (start < messages.length && messages[start].role === 'tool') {
		start -= 1;
		if (start < 1) {
			// Fall forward past the orphan tools instead of starting on them.
			start = preferFrom;
			while (start < messages.length && messages[start].role === 'tool') {
				start += 1;
			}
			break;
		}
	}
	// Prefer starting on user/assistant, not mid tool-group.
	while (
		start > 1 &&
		messages[start]?.role === 'tool' &&
		messages[start - 1]?.role === 'assistant' &&
		(messages[start - 1].tool_calls?.length ?? 0) > 0
	) {
		start -= 1;
	}
	return Math.max(1, Math.min(start, messages.length));
}

/** Soft: shrink older tool results in-place. */
export function softCompactToolResults(
	messages: ToolHistoryMessage[],
	maxChars: number,
	keepRecent = 8,
	minReadChars = 1800
): ToolHistoryMessage[] {
	const toolIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') toolIdxs.push(i);
	}
	const keepFull = new Set(keepRecent > 0 ? toolIdxs.slice(-keepRecent) : []);
	return messages.map((m, i) => {
		if (m.role !== 'tool' || keepFull.has(i)) return m;
		const text = typeof m.content === 'string' ? m.content : plainText(m.content);
		const cap = m.name === 'read' ? Math.max(maxChars, minReadChars) : maxChars;
		if (text.length <= cap) return m;
		return {
			...m,
			content: clipToolOutput(m.name || '', text, cap),
		};
	});
}

/** Mid: collapse older turns into one digest user message; keep a safe contiguous tail. */
export function midCompactMessages(
	messages: ToolHistoryMessage[],
	systemContent: string,
	opts?: { readLedger?: string }
): ToolHistoryMessage[] {
	const system = messages.find(m => m.role === 'system') ?? {
		role: 'system' as const,
		content: systemContent,
	};
	const preferFrom = Math.max(1, messages.length - 14);
	const tailStart = safeMidCompactTailStart(messages, preferFrom);
	const head = messages.slice(1, tailStart);
	const tail = messages.slice(tailStart);
	if (head.length < 4) {
		return softCompactToolResults(messages, 1400);
	}
	const digest = head
		.map(m => {
			const role = m.role;
			const text = plainText(m.content);
			if (role === 'tool') {
				const keep = m.name === 'read' || m.name === 'write' || m.name === 'edit' ? 500 : m.name === 'shell' || m.name === 'dotnet' ? 700 : 240;
				return `tool:${m.name || '?'}: ${clipToolOutput(m.name || '', text, keep)}`;
			}
			if (role === 'assistant' && m.tool_calls?.length) {
				return `assistant tools: ${m.tool_calls.map(t => t.function.name).join(', ')}`;
			}
			return `${role}: ${clipData(text, 400)}`;
		})
		.join('\n');

	const ledger = opts?.readLedger?.trim()
		? `\n\n### FILES ALREADY READ\n${opts.readLedger.trim()}`
		: '';

	const next: ToolHistoryMessage[] = [
		{
			role: 'system',
			content: typeof system.content === 'string' ? system.content : systemContent,
		},
		{
			role: 'user',
			content: `Summary of older turns (tool results abbreviated):\n${clipData(digest, 6000)}${ledger}`,
		},
		...tail,
	];
	normalizeToolProtocolHistory(next);
	return next;
}

/**
 * Build a compact ledger of files already read: `path: L1-120, L300-380`.
 * `windows` maps path → list of inclusive [start, end] line ranges.
 */
export function formatReadLedger(
	windows: Map<string, Array<{ start: number; end: number }>> | Record<string, Array<{ start: number; end: number }>>
): string {
	const entries =
		windows instanceof Map ? [...windows.entries()] : Object.entries(windows);
	if (!entries.length) return '';
	return entries
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([p, ranges]) => {
			const merged = mergeRanges(ranges);
			const parts = merged.map(r => `L${r.start}-${r.end}`).join(', ');
			return `${p}: ${parts}`;
		})
		.join('\n');
}

function mergeRanges(
	ranges: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
	const sorted = [...ranges]
		.filter(r => r.end >= r.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Array<{ start: number; end: number }> = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.start <= last.end + 1) {
			last.end = Math.max(last.end, r.end);
		} else {
			out.push({ ...r });
		}
	}
	return out;
}

/**
 * Filter Anthropic tool_result blocks so none reference a tool_use_id
 * that is not in the immediately preceding assistant message.
 */
export function filterAnthropicToolResults(
	converted: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const msg of converted) {
		if (msg.role !== 'user' || !Array.isArray(msg.content)) {
			out.push(msg);
			continue;
		}
		const content = msg.content as Array<Record<string, unknown>>;
		const onlyTools = content.length > 0 && content.every(c => c.type === 'tool_result');
		if (!onlyTools) {
			out.push(msg);
			continue;
		}
		const prev = out[out.length - 1];
		const prevContent = Array.isArray(prev?.content)
			? (prev.content as Array<Record<string, unknown>>)
			: [];
		const liveIds = new Set(
			prev?.role === 'assistant'
				? prevContent.filter(c => c.type === 'tool_use').map(c => String(c.id ?? ''))
				: []
		);
		const kept = content.filter(c => liveIds.has(String(c.tool_use_id ?? '')));
		if (kept.length) {
			out.push({ ...msg, content: kept });
		}
	}
	return out;
}
