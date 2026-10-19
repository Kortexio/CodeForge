/**
 * Runs an orchestrator plan with the agent loop: one isolated sub-run per item,
 * accepted by the project oracle.
 */

import * as path from 'path';
import { oracleNote, runAgentWithTools, type AgentLoopOptions } from './agentLoop';
import { detectOracle, nodeOracleFs, runOracle } from './oracle';
import { parseBlockedClaim } from './nudges';
import {
	findCards,
	formatPlanReport,
	itemPrompt,
	loadPlan,
	orderCards,
	parsePlanJson,
	planFromCards,
	planFromItems,
	PLANNING_PROMPT,
	resumablePlan,
	runPlan,
	savePlan,
	selectCards,
	shouldOrchestrateCards,
	wantsNewApp,
	type Plan,
} from './orchestrator';

const ITEM_MAX_STEPS = 25;
const ITEM_HARD_CAP = 40;

export interface OrchestrateOptions {
	/** `/cards` or `/plan-run`: run even when the automatic trigger would not. */
	forced?: boolean;
}

function conventionsPath(root: string): string | undefined {
	const docs = nodeOracleFs.list(path.join(root, 'docs'));
	const name = docs.find(n => /^0+[-_ ]?conven/i.test(n) || /^conven[çc][õo]es\.md$/i.test(n) || /^conventions\.md$/i.test(n));
	return name ? `docs/${name}` : undefined;
}

/** Build the plan for this request, or undefined when a single run fits better. */
async function buildPlan(opts: AgentLoopOptions, root: string, forced: boolean, hasOracle: boolean): Promise<Plan | undefined> {
	const cards = orderCards(selectCards(opts.task, findCards(root, nodeOracleFs)));
	if (cards.length >= 2 || (forced && cards.length >= 1)) {
		const fresh = planFromCards(opts.task, cards, hasOracle);
		return resumablePlan(loadPlan(root), fresh) ?? fresh;
	}
	if (!wantsNewApp(opts.task) && !forced) return undefined;
	opts.onStatus?.('Planning steps…');
	const reply = await runAgentWithTools({
		...opts,
		task: PLANNING_PROMPT(opts.task),
		history: [],
		isolated: true,
		planMode: true,
		basePhase: 'explore',
		depth: 1,
		maxSteps: 10,
		hardCap: 14,
	});
	const items = parsePlanJson(reply);
	if (!items || items.length < 2) return undefined;
	return planFromItems(opts.task, items.slice(0, 8), hasOracle);
}

/**
 * Orchestrated run. Returns undefined when the request is not a multi-item job
 * (the caller then runs the normal single loop).
 */
export async function runOrchestrated(
	opts: AgentLoopOptions,
	o: OrchestrateOptions = {}
): Promise<string | undefined> {
	const root = opts.workspaceRoot;
	if (!root) return undefined;
	const forced = o.forced === true;
	const cards = orderCards(selectCards(opts.task, findCards(root, nodeOracleFs)));
	// Cards: auto when the task names them and ≥2 exist; slash forces even a single card.
	// New-app multi-item planning still goes through buildPlan (forced or wantsNewApp).
	const cardJob = shouldOrchestrateCards(opts.task, cards.length, forced);
	if (!cardJob && !forced && !wantsNewApp(opts.task)) return undefined;

	const oracleCfg = detectOracle(root, nodeOracleFs);
	const plan = await buildPlan(opts, root, forced || cardJob, !!oracleCfg);
	if (!plan) return undefined;

	const conventions = conventionsPath(root);
	const planTaskId = `plan-${plan.createdAt}`;
	const total = plan.items.length;
	const publish = (p: Plan) => {
		const done = p.items.filter(i => i.status === 'done').length;
		const current = p.items.find(i => i.status === 'running');
		const label = current
			? `${done + 1} of ${p.items.length} — ${current.title}`
			: done === p.items.length
				? `Done — ${done} of ${p.items.length}`
				: `${done} of ${p.items.length} complete`;
		opts.onTaskUpdate?.({
			id: planTaskId,
			name: label,
			status: p.items.every(i => i.status === 'done')
				? 'completed'
				: p.items.some(i => i.status === 'blocked')
					? 'failed'
					: 'running',
			subtasks: p.items.map(i => ({
				id: i.id,
				name: i.title,
				status:
					i.status === 'done' ? 'completed' : i.status === 'blocked' ? 'failed' : i.status === 'running' ? 'running' : 'pending',
			})),
		});
	};
	publish(plan);
	opts.onStatus?.(`Working through ${total} parts…`);
	opts.onActivity?.({
		kind: 'thinking',
		label: `Working through ${total} parts…`,
	});

	const verify = async (): Promise<{ ok: boolean; text: string }> => {
		if (!oracleCfg) return { ok: true, text: '' };
		const result = await runOracle(oracleCfg, async command => {
			const r = await opts.bridge.execute({
				id: `oracle-${Date.now()}`,
				name: 'shell',
				arguments: { command },
				abortSignal: opts.abortSignal,
			});
			return r.success ? r.output : `exit 1\n${r.error ?? 'oracle command failed'}`;
		});
		return { ok: result.ok, text: oracleNote(result, 'item check') };
	};

	await runPlan(plan, {
		cancelled: opts.cancelled,
		save: p => savePlan(root, p),
		onUpdate: publish,
		runItem: async (item, p) => {
			const idx = p.items.indexOf(item) + 1;
			const card = item.source ? nodeOracleFs.readText(path.join(root, item.source)) : undefined;
			const progress = `${idx} of ${total}`;
			const retry = item.attempts > 1 ? ' — retrying' : '';
			// Live status only — no "Plan:/attempt/sub-run" jargon in the stream.
			opts.onStatus?.(`Working on ${item.title} (${progress})${retry}…`);
			opts.onActivity?.({
				kind: 'thinking',
				label: `Working on ${item.title} (${progress})${retry}…`,
			});
			const reply = await runAgentWithTools({
				...opts,
				task: itemPrompt(p, item, {
					cardContent: card,
					conventionsPath: conventions,
					oracleCommands: oracleCfg?.commands,
				}),
				history: [],
				isolated: true,
				basePhase: 'implement',
				maxSteps: ITEM_MAX_STEPS,
				hardCap: ITEM_HARD_CAP,
			});
			const blocked = parseBlockedClaim(reply);
			if (blocked) return { ok: false, reply, blocked };
			const check = await verify();
			if (check.ok) {
				opts.onStatus?.(`Finished ${item.title} (${progress})…`);
				opts.onActivity?.({
					kind: 'thinking',
					label: `Finished ${item.title} (${progress})…`,
				});
			}
			return check.ok ? { ok: true, reply } : { ok: false, reply, error: check.text };
		},
	});

	return formatPlanReport(plan);
}
