/**
 * Orchestrator: the plan is harness state, not model memory.
 * One item per card (dependency order) or per planned step; each item runs as a clean sub-run
 * and is accepted by the oracle. Pure — fs is injected, no vscode.
 */

import * as fs from 'fs';
import * as path from 'path';

export type PlanItemStatus = 'pending' | 'running' | 'done' | 'blocked';

export interface PlanItem {
	id: string;
	title: string;
	/** Card path relative to the workspace root (cards only). */
	source?: string;
	/** Acceptance: project oracle green, or the item's own criteria when there is no oracle. */
	acceptance: 'oracle' | 'checks';
	criteria?: string;
	dependsOn: string[];
	status: PlanItemStatus;
	attempts: number;
	summary?: string;
	lastError?: string;
}

export interface Plan {
	version: 1;
	task: string;
	origin: 'cards' | 'planned';
	createdAt: string;
	updatedAt: string;
	items: PlanItem[];
}

export interface CardDoc {
	id: string;
	path: string;
	content: string;
}

export interface OrchestratorFs {
	list(p: string): string[];
	readText(p: string): string | undefined;
	isDir(p: string): boolean;
}

export const PLAN_FILE = '.CodeForge/memory/plan.json';
export const MAX_ITEM_ATTEMPTS = 2;

const CARD_FILE = /^(C\d+)[\w .-]*\.md$/i;

function cardNum(id: string): number {
	return Number(/\d+/.exec(id)?.[0] ?? 0);
}

/** `Depende de: C01, C02` / `Depends on: C01` → ['C01', 'C02']. */
export function parseDependsOn(md: string): string[] {
	const line = /^[\s>*_-]*(?:depende(?:s)?\s+de|depends\s+on|dependencies)\s*[:：]?\**\s*(.*)$/im.exec(md)?.[1] ?? '';
	return [...new Set([...line.matchAll(/\bC\d+\b/gi)].map(m => m[0].toUpperCase()))];
}

export function cardTitle(md: string, id: string): string {
	const h = /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
	return h || id;
}

/** Cards in `docs/`, `docs/cards/` and the workspace root, named `C<n>...md`. */
export function findCards(root: string, fsx: OrchestratorFs): CardDoc[] {
	const found = new Map<string, CardDoc>();
	for (const dir of ['docs', 'docs/cards', 'cards', '']) {
		const abs = dir ? path.join(root, dir) : root;
		if (dir && !fsx.isDir(abs)) continue;
		for (const name of fsx.list(abs)) {
			const m = CARD_FILE.exec(name);
			if (!m) continue;
			const id = m[1].toUpperCase();
			if (found.has(id)) continue;
			const rel = dir ? `${dir}/${name}` : name;
			const content = fsx.readText(path.join(root, rel));
			if (content !== undefined) found.set(id, { id, path: rel, content });
		}
	}
	return [...found.values()].sort((a, b) => cardNum(a.id) - cardNum(b.id));
}

/** Topological order by "Depends on:"; ties and cycles fall back to card number. */
export function orderCards(cards: CardDoc[]): CardDoc[] {
	const byId = new Map(cards.map(c => [c.id, c]));
	const deps = new Map(cards.map(c => [c.id, parseDependsOn(c.content).filter(d => byId.has(d) && d !== c.id)]));
	const done = new Set<string>();
	const out: CardDoc[] = [];
	const pending = [...cards].sort((a, b) => cardNum(a.id) - cardNum(b.id));
	while (pending.length) {
		const idx = pending.findIndex(c => (deps.get(c.id) ?? []).every(d => done.has(d)));
		const next = pending.splice(idx >= 0 ? idx : 0, 1)[0];
		done.add(next.id);
		out.push(next);
	}
	return out;
}

/** Cards named in the request (`C03`, `C01 a C05`, `C02-C04`); all cards when none are named. */
export function selectCards(task: string, cards: CardDoc[]): CardDoc[] {
	const wanted = new Set<number>();
	for (const m of task.matchAll(/\bC(\d+)\s*(?:a|-|–|to|até|ate|\.\.)\s*C?(\d+)\b/gi)) {
		const [from, to] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
		for (let n = from; n <= to; n++) wanted.add(n);
	}
	for (const m of task.matchAll(/\bC(\d+)\b/gi)) wanted.add(Number(m[1]));
	if (!wanted.size) return cards;
	return cards.filter(c => wanted.has(cardNum(c.id)));
}

export function mentionsCards(task: string): boolean {
	return /\bcards?\b|\bC\d{2,}\b|docs\/C\d/i.test(task);
}

export function wantsNewApp(task: string): boolean {
	return /\b(cria|criar|crie|create|build|scaffold|gera|gerar|desenvolv\w*)\b[\s\S]{0,60}\b(aplica[çc][ãa]o|app|application|api|solution|projeto|project|sistema|system)\b/i.test(
		task
	);
}

export function planFromCards(task: string, cards: CardDoc[], hasOracle: boolean, now = new Date()): Plan {
	const ids = new Set(cards.map(c => c.id));
	return {
		version: 1,
		task,
		origin: 'cards',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		items: cards.map(c => ({
			id: c.id,
			title: cardTitle(c.content, c.id),
			source: c.path,
			acceptance: hasOracle ? 'oracle' : 'checks',
			dependsOn: parseDependsOn(c.content).filter(d => ids.has(d)),
			status: 'pending',
			attempts: 0,
		})),
	};
}

/** Items from the planning step: `{"items":[{"title","acceptance"}]}` or a bare array. */
export function parsePlanJson(text: string): Array<{ title: string; criteria: string }> | undefined {
	const t = String(text || '');
	const candidates = [/```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1], /\{[\s\S]*\}/.exec(t)?.[0], /\[[\s\S]*\]/.exec(t)?.[0]];
	for (const c of candidates) {
		if (!c) continue;
		try {
			const parsed = JSON.parse(c) as unknown;
			const arr = Array.isArray(parsed)
				? parsed
				: Array.isArray((parsed as { items?: unknown }).items)
					? (parsed as { items: unknown[] }).items
					: undefined;
			if (!arr) continue;
			const items = arr
				.map(x => {
					const o = (typeof x === 'string' ? { title: x } : x) as Record<string, unknown>;
					const title = String(o.title ?? o.name ?? '').trim();
					const criteria = String(o.acceptance ?? o.criteria ?? o.done ?? '').trim();
					return { title, criteria };
				})
				.filter(x => x.title);
			if (items.length) return items;
		} catch {
			/* try next candidate */
		}
	}
	return undefined;
}

export function planFromItems(
	task: string,
	items: Array<{ title: string; criteria: string }>,
	hasOracle: boolean,
	now = new Date()
): Plan {
	return {
		version: 1,
		task,
		origin: 'planned',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		items: items.map((x, i) => ({
			id: `P${String(i + 1).padStart(2, '0')}`,
			title: x.title,
			acceptance: hasOracle ? 'oracle' : 'checks',
			criteria: x.criteria || undefined,
			dependsOn: i > 0 ? [`P${String(i).padStart(2, '0')}`] : [],
			status: 'pending',
			attempts: 0,
		})),
	};
}

export const PLANNING_PROMPT = (task: string) =>
	[
		'Break this request into 3–8 implementation steps, each small enough to finish and verify on its own.',
		'Explore the workspace as needed, then reply with JSON only:',
		'{"items":[{"title":"<what to build>","acceptance":"<how to tell it is done>"}]}',
		'',
		`Request: ${task}`,
	].join('\n');

/** Next runnable item: pending, every dependency done. Undefined when finished or stuck. */
export function nextItem(plan: Plan): PlanItem | undefined {
	const status = new Map(plan.items.map(i => [i.id, i.status]));
	return plan.items.find(
		i => (i.status === 'pending' || i.status === 'running') && i.dependsOn.every(d => (status.get(d) ?? 'done') === 'done')
	);
}

export function summarizeReply(reply: string, maxLines = 5): string {
	const lines = String(reply || '')
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => l && !/^#{1,6}\s*$/.test(l) && !/^```/.test(l));
	const head = lines.slice(0, maxLines).map(l => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
	if (lines.length > maxLines) head.push(`…[+${lines.length - maxLines} lines]`);
	return head.join('\n');
}

/** Clean-context prompt for one item: the card (whole), finished items, acceptance. */
export function itemPrompt(
	plan: Plan,
	item: PlanItem,
	opts: { cardContent?: string; conventionsPath?: string; oracleCommands?: string[] }
): string {
	const idx = plan.items.indexOf(item) + 1;
	const done = plan.items.filter(i => i.status === 'done');
	const parts = [
		`Item ${idx} of ${plan.items.length}: ${item.id} — ${item.title}`,
		`Overall request: ${plan.task}`,
	];
	if (item.source) parts.push('', `Card \`${item.source}\`:`, '', (opts.cardContent ?? '').trim());
	if (item.criteria) parts.push('', `Acceptance: ${item.criteria}`);
	if (opts.conventionsPath) parts.push('', `Project conventions: \`${opts.conventionsPath}\`.`);
	if (done.length) {
		parts.push('', 'Already done (code is in the workspace):');
		for (const d of done) parts.push(`- ${d.id} ${d.title}${d.summary ? `: ${d.summary.split('\n')[0]}` : ''}`);
	}
	if (item.lastError) parts.push('', 'The previous attempt ended with:', item.lastError);
	parts.push(
		'',
		item.acceptance === 'oracle'
			? `Scope: only this item. It is done when the build/test is green${opts.oracleCommands?.length ? ` (${opts.oracleCommands.join(' → ')})` : ''} and the criteria above hold.`
			: 'Scope: only this item. It is done when the criteria above hold.',
		'Finish with a summary of up to 5 lines, or `blocked: <reason>` if it cannot be done.'
	);
	return parts.join('\n');
}

export interface ItemOutcome {
	ok: boolean;
	reply: string;
	blocked?: string;
	/** Oracle/verification text when not ok. */
	error?: string;
}

export interface RunPlanDeps {
	runItem(item: PlanItem, plan: Plan): Promise<ItemOutcome>;
	save(plan: Plan): void | Promise<void>;
	onUpdate?(plan: Plan): void;
	cancelled(): boolean;
	maxAttempts?: number;
}

/** Run items until done, blocked or cancelled. Stops at the first blocked item. */
export async function runPlan(plan: Plan, deps: RunPlanDeps): Promise<Plan> {
	const maxAttempts = deps.maxAttempts ?? MAX_ITEM_ATTEMPTS;
	const touch = async () => {
		plan.updatedAt = new Date().toISOString();
		await deps.save(plan);
		deps.onUpdate?.(plan);
	};
	for (;;) {
		if (deps.cancelled()) break;
		const item = nextItem(plan);
		if (!item) break;
		item.status = 'running';
		item.attempts += 1;
		await touch();
		let outcome: ItemOutcome;
		try {
			outcome = await deps.runItem(item, plan);
		} catch (e) {
			outcome = { ok: false, reply: '', error: e instanceof Error ? e.message : String(e) };
		}
		item.summary = summarizeReply(outcome.reply);
		if (outcome.ok) {
			item.status = 'done';
			item.lastError = undefined;
		} else if (outcome.blocked || item.attempts >= maxAttempts || deps.cancelled()) {
			item.status = deps.cancelled() && !outcome.blocked ? 'pending' : 'blocked';
			item.lastError = outcome.blocked ? `blocked: ${outcome.blocked}` : outcome.error;
			await touch();
			break;
		} else {
			item.status = 'pending';
			item.lastError = outcome.error;
		}
		await touch();
	}
	return plan;
}

export function formatPlanReport(plan: Plan): string {
	const icon: Record<PlanItemStatus, string> = { done: '✓', blocked: '✗', running: '…', pending: '·' };
	const lines = [`Plan (${plan.items.filter(i => i.status === 'done').length}/${plan.items.length} done):`];
	for (const i of plan.items) {
		lines.push(`${icon[i.status]} ${i.id} ${i.title}${i.attempts > 1 ? ` (${i.attempts} attempts)` : ''}`);
		if (i.summary && i.status === 'done') lines.push(...i.summary.split('\n').slice(0, 2).map(l => `    ${l}`));
	}
	const blocked = plan.items.find(i => i.status === 'blocked');
	if (blocked) {
		lines.push(
			'',
			`${blocked.id} is blocked${blocked.lastError ? `:\n${blocked.lastError}` : '.'}`,
			'',
			'How do you want to proceed: fix and retry with `/cards`, adjust the card, or continue manually?'
		);
	} else if (plan.items.some(i => i.status !== 'done')) {
		lines.push('', 'Plan interrupted — `/cards` resumes from the pending item.');
	}
	return lines.join('\n');
}

// --- persistence -----------------------------------------------------------

export function loadPlan(root: string): Plan | undefined {
	try {
		const p = JSON.parse(fs.readFileSync(path.join(root, PLAN_FILE), 'utf8')) as Plan;
		return p?.version === 1 && Array.isArray(p.items) ? p : undefined;
	} catch {
		return undefined;
	}
}

export function savePlan(root: string, plan: Plan): void {
	const file = path.join(root, PLAN_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');
}

/** Resume an unfinished plan over the same items; blocked items get another try. */
export function resumablePlan(existing: Plan | undefined, fresh: Plan): Plan | undefined {
	if (!existing || existing.origin !== fresh.origin) return undefined;
	const a = existing.items.map(i => i.id).join(',');
	const b = fresh.items.map(i => i.id).join(',');
	if (a !== b || existing.items.every(i => i.status === 'done')) return undefined;
	for (const i of existing.items) {
		if (i.status === 'blocked' || i.status === 'running') {
			i.status = 'pending';
			i.attempts = 0;
		}
	}
	return existing;
}
