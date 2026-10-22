/**
 * Internal model-only plans under `{workspace}/.CodeForge/plans/`.
 * Not shown in the chat UI — harness injects the current item into context.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export const PLANS_DIR_REL = '.CodeForge/plans';
export const CURRENT_POINTER = 'current.json';

export type InternalPlanItemStatus = 'pending' | 'done' | 'skipped';

export interface InternalPlanItem {
	id: string;
	title: string;
	status: InternalPlanItemStatus;
	paths?: string[];
}

export interface InternalPlan {
	version: 1;
	id: string;
	task: string;
	/** Hash of the original task text (first 500 chars, normalized). */
	taskHash: string;
	/** Session that created / owns this plan. */
	sessionId?: string;
	createdAt: string;
	updatedAt: string;
	items: InternalPlanItem[];
}

/** Heuristic: user asked for a full project / many files in one go. */
export function looksLikeScaffoldTask(task: string): boolean {
	const t = String(task || '');
	if (t.length < 80) return false;
	return (
		/\b(projeto completo|complete project|scaffold|gera(r)? um projeto|generate (a |the )?project|all files|todos os ficheiros|estrutura de pastas|folder structure)\b/i.test(
			t
		) ||
		(/\b(package\.json|tsconfig|vite\.config)\b/i.test(t) &&
			/\b(completo|complete|full|inteiro|from scratch|do zero)\b/i.test(t))
	);
}

/** Bare continue / resume phrases (EN + PT matchers). */
export function looksLikeBareContinue(task: string): boolean {
	const t = String(task || '').trim();
	return /^(continue|continua(r)?|segue|keep going|go on|prossegue|continua\s+por\s+favor)[\s.!?]*$/i.test(
		t
	);
}

export function hashTask(task: string): string {
	const normalized = String(task || '')
		.trim()
		.slice(0, 500)
		.toLowerCase()
		.replace(/\s+/g, ' ');
	return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function plansDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.CodeForge', 'plans');
}

async function ensurePlansDir(workspaceRoot: string): Promise<string> {
	const dir = plansDir(workspaceRoot);
	await fs.mkdir(dir, { recursive: true });
	await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
	const gitignore = path.join(dir, '.gitignore');
	try {
		await fs.access(gitignore);
	} catch {
		await fs.writeFile(gitignore, '*\n!.gitignore\n', 'utf8');
	}
	return dir;
}

export async function readCurrentPlan(workspaceRoot: string): Promise<InternalPlan | undefined> {
	try {
		const dir = plansDir(workspaceRoot);
		const pointerRaw = await fs.readFile(path.join(dir, CURRENT_POINTER), 'utf8');
		const pointer = JSON.parse(pointerRaw) as { id?: string };
		if (!pointer.id) return undefined;
		const raw = await fs.readFile(path.join(dir, `${pointer.id}.json`), 'utf8');
		const plan = JSON.parse(raw) as InternalPlan;
		if (!plan.taskHash && plan.task) plan.taskHash = hashTask(plan.task);
		return plan;
	} catch {
		return undefined;
	}
}

export async function writeInternalPlan(
	workspaceRoot: string,
	plan: InternalPlan
): Promise<void> {
	const dir = await ensurePlansDir(workspaceRoot);
	const next: InternalPlan = {
		...plan,
		taskHash: plan.taskHash || hashTask(plan.task),
		updatedAt: new Date().toISOString(),
	};
	await fs.writeFile(path.join(dir, `${next.id}.json`), JSON.stringify(next, null, 2), 'utf8');
	await fs.writeFile(
		path.join(dir, CURRENT_POINTER),
		JSON.stringify({ id: next.id }, null, 2),
		'utf8'
	);
}

/** Move current plan to archive/ and clear the pointer. */
export async function archiveCurrentPlan(workspaceRoot: string): Promise<void> {
	try {
		const dir = await ensurePlansDir(workspaceRoot);
		const pointerPath = path.join(dir, CURRENT_POINTER);
		const pointerRaw = await fs.readFile(pointerPath, 'utf8');
		const pointer = JSON.parse(pointerRaw) as { id?: string };
		if (!pointer.id) {
			await fs.writeFile(pointerPath, JSON.stringify({ id: null }, null, 2), 'utf8');
			return;
		}
		const src = path.join(dir, `${pointer.id}.json`);
		const dest = path.join(dir, 'archive', `${pointer.id}.json`);
		try {
			await fs.rename(src, dest);
		} catch {
			try {
				const raw = await fs.readFile(src, 'utf8');
				await fs.writeFile(dest, raw, 'utf8');
				await fs.unlink(src);
			} catch {
				/* already gone */
			}
		}
		await fs.writeFile(pointerPath, JSON.stringify({ id: null }, null, 2), 'utf8');
	} catch {
		/* best-effort */
	}
}

export type PlanResolveOpts = {
	task: string;
	sessionId?: string | null;
};

/**
 * Return the current plan only when it belongs to this session/task.
 * Archives stale plans that belong to another task (unless this is a bare continue
 * in the same session with pending items).
 */
export async function resolveCurrentPlan(
	workspaceRoot: string,
	opts: PlanResolveOpts
): Promise<InternalPlan | undefined> {
	const plan = await readCurrentPlan(workspaceRoot);
	if (!plan) return undefined;

	const pending = plan.items.some(i => i.status === 'pending');
	const bare = looksLikeBareContinue(opts.task);
	const sameSession =
		!opts.sessionId || !plan.sessionId || opts.sessionId === plan.sessionId;
	const sameTask = plan.taskHash === hashTask(opts.task);

	if (!sameSession && !bare) {
		await archiveCurrentPlan(workspaceRoot);
		return undefined;
	}
	if (bare && pending && sameSession) return plan;
	if (sameTask && pending) return plan;
	if (!pending) {
		await archiveCurrentPlan(workspaceRoot);
		return undefined;
	}
	// Unrelated new task: archive stale plan so it does not leak into context.
	if (!bare && !sameTask) {
		await archiveCurrentPlan(workspaceRoot);
		return undefined;
	}
	return plan;
}

/** Create a plan from model-generated or harness items (no hard-coded stack seed). */
export async function createInternalPlan(
	workspaceRoot: string,
	opts: {
		task: string;
		sessionId?: string | null;
		items: Array<{ title: string; paths?: string[] }>;
	}
): Promise<InternalPlan> {
	const items: InternalPlanItem[] = opts.items.slice(0, 8).map((item, i) => ({
		id: String(i + 1),
		title: item.title.slice(0, 200),
		status: 'pending' as const,
		paths: item.paths?.map(p => p.replace(/\\/g, '/')).filter(Boolean),
	}));
	if (!items.length) {
		items.push({ id: '1', title: 'Implement the requested scaffold', status: 'pending' });
	}
	const plan: InternalPlan = {
		version: 1,
		id: randomUUID().slice(0, 8),
		task: opts.task.slice(0, 500),
		taskHash: hashTask(opts.task),
		sessionId: opts.sessionId ?? undefined,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		items,
	};
	await writeInternalPlan(workspaceRoot, plan);
	return plan;
}

/**
 * Ensure a scaffold plan exists for this task/session.
 * Does not inject a hard-coded TS/Vite path list — callers should generate items
 * via a no-tools LLM call when paths are needed. Falls back to title-only items.
 */
export async function ensureScaffoldPlan(
	workspaceRoot: string,
	task: string,
	sessionId?: string | null,
	items?: Array<{ title: string; paths?: string[] }>
): Promise<InternalPlan | undefined> {
	if (!looksLikeScaffoldTask(task) && !items?.length) return undefined;
	const existing = await resolveCurrentPlan(workspaceRoot, { task, sessionId });
	if (existing && existing.items.some(i => i.status === 'pending')) {
		return existing;
	}
	if (!looksLikeScaffoldTask(task) && !items?.length) return undefined;
	return createInternalPlan(workspaceRoot, {
		task,
		sessionId,
		items: items?.length
			? items
			: [
					{ title: 'Identify project layout and create core config/entry files' },
					{ title: 'Implement remaining modules' },
					{ title: 'Verify build / install deps' },
				],
	});
}

export function formatPlanForPrompt(plan: InternalPlan): string {
	const current = plan.items.find(i => i.status === 'pending') ?? plan.items[plan.items.length - 1];
	const upcoming = plan.items.filter(i => i.status === 'pending').slice(0, 3);
	const lines = [
		'### Internal build plan (model-only; do not narrate this file to the user)',
		`Plan id: ${plan.id}`,
		`Focus now: [${current?.id}] ${current?.title ?? '(done)'}`,
		current?.paths?.length ? `Preferred paths: ${current.paths.join(', ')}` : '',
		'Upcoming:',
		...upcoming.map(i => `- [${i.id}] ${i.title}${i.paths?.length ? ` (${i.paths.join(', ')})` : ''}`),
		'Mark progress by finishing the focused item before starting the next. Prefer write/edit on the listed paths.',
	];
	return lines.filter(Boolean).join('\n');
}

export function currentPlanItem(plan: InternalPlan): InternalPlanItem | undefined {
	return plan.items.find(i => i.status === 'pending');
}

/** True when mutate path is allowed by the current item's path gate (or gate is off). */
export function pathAllowedByPlan(plan: InternalPlan | undefined, filePath: string): boolean {
	if (!plan) return true;
	const item = currentPlanItem(plan);
	if (!item?.paths?.length) return true;
	const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
	if (norm.includes('.codeforge/plans')) return false;
	return item.paths.some(t => {
		const target = t.replace(/\\/g, '/').toLowerCase();
		return norm === target || norm.endsWith('/' + target) || norm.endsWith(target);
	});
}

/** Mark pending item done when all listed paths were written (or any write if no paths). */
export async function advancePlanAfterWrites(
	workspaceRoot: string,
	writtenPaths: Iterable<string>,
	opts?: PlanResolveOpts
): Promise<InternalPlan | undefined> {
	const plan = opts
		? await resolveCurrentPlan(workspaceRoot, opts)
		: await readCurrentPlan(workspaceRoot);
	if (!plan) return undefined;
	const pending = plan.items.find(i => i.status === 'pending');
	if (!pending) {
		await archiveCurrentPlan(workspaceRoot);
		return plan;
	}
	const written = new Set(
		[...writtenPaths].map(p => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
	);
	const targets = (pending.paths ?? []).map(p => p.replace(/\\/g, '/').toLowerCase());
	const hit =
		targets.length === 0
			? written.size > 0
			: targets.every(t =>
					[...written].some(w => w === t || w.endsWith('/' + t) || w.endsWith(t))
				);
	if (!hit) return plan;
	pending.status = 'done';
	const stillPending = plan.items.some(i => i.status === 'pending');
	if (!stillPending) {
		await writeInternalPlan(workspaceRoot, plan);
		await archiveCurrentPlan(workspaceRoot);
		return plan;
	}
	await writeInternalPlan(workspaceRoot, plan);
	return plan;
}

/** Parse model JSON for scaffold items. Returns undefined on invalid shape. */
export function parseScaffoldPlanJson(raw: string): Array<{ title: string; paths?: string[] }> | undefined {
	const text = String(raw || '').trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return undefined;
	try {
		const obj = JSON.parse(text.slice(start, end + 1)) as {
			items?: Array<{ title?: string; paths?: string[] }>;
		};
		if (!Array.isArray(obj.items) || !obj.items.length) return undefined;
		const items = obj.items
			.filter(i => typeof i?.title === 'string' && i.title.trim())
			.slice(0, 8)
			.map(i => ({
				title: String(i.title).trim(),
				paths: Array.isArray(i.paths)
					? i.paths.filter((p): p is string => typeof p === 'string' && !!p.trim())
					: undefined,
			}));
		return items.length ? items : undefined;
	} catch {
		return undefined;
	}
}
