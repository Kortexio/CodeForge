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
	opts.onStatus?.('A planear os passos…');
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
	// Orchestrate only when explicitly forced (slash / multi-item). No auto-trigger from model size.
	if (!forced) return undefined;

	const oracleCfg = detectOracle(root, nodeOracleFs);
	const plan = await buildPlan(opts, root, forced, !!oracleCfg);
	if (!plan) return undefined;

	const conventions = conventionsPath(root);
	const planTaskId = `plan-${plan.createdAt}`;
	const publish = (p: Plan) => {
		opts.onTaskUpdate?.({
			id: planTaskId,
			name: `Plan: ${p.items.length} items`,
			status: p.items.every(i => i.status === 'done')
				? 'completed'
				: p.items.some(i => i.status === 'blocked')
					? 'failed'
					: 'running',
			subtasks: p.items.map(i => ({
				id: i.id,
				name: `${i.id} ${i.title}`,
				status:
					i.status === 'done' ? 'completed' : i.status === 'blocked' ? 'failed' : i.status === 'running' ? 'running' : 'pending',
			})),
		});
	};
	publish(plan);

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
			const card = item.source ? nodeOracleFs.readText(path.join(root, item.source)) : undefined;
			opts.onStatus?.(`${item.id} — ${item.title} (attempt ${item.attempts})`);
			opts.onActivity?.({ kind: 'checkpoint', label: `Plan: ${item.id}`, detail: item.title });
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
			return check.ok ? { ok: true, reply } : { ok: false, reply, error: check.text };
		},
	});

	return formatPlanReport(plan);
}
