/**
 * Registrable guardrail gates (P0-3).
 */

import type { ToolRisk } from '../agent/toolRegistry';

export interface GateSession {
	workspaceRoot?: string | null;
	sessionId?: string;
	task?: string;
	/** Mutable notes gates may set for later gates / UI. */
	notes: string[];
}

export type GateDecision =
	| { action: 'allow' }
	| { action: 'block'; reason: string }
	| { action: 'require-approval'; reason: string };

export interface GuardrailGate {
	id: string;
	title: string;
	description: string;
	defaultEnabled: boolean;
	params?: Record<string, number | boolean | string>;
	beforeTool?(
		call: { name: string; args: unknown; risk: ToolRisk },
		s: GateSession
	): GateDecision | Promise<GateDecision>;
	beforeFinish?(s: GateSession): GateDecision | Promise<GateDecision>;
}

export interface Disposable {
	dispose(): void;
}

export class GateRegistry {
	private readonly gates = new Map<string, GuardrailGate>();

	register(gate: GuardrailGate): Disposable {
		const id = gate.id.trim();
		if (!id) throw new Error('GuardrailGate.id is required');
		this.gates.set(id, { ...gate, id });
		return {
			dispose: () => {
				if (this.gates.get(id)?.id === id) {
					this.gates.delete(id);
				}
			},
		};
	}

	list(): GuardrailGate[] {
		return [...this.gates.values()];
	}

	get(id: string): GuardrailGate | undefined {
		return this.gates.get(id);
	}

	isEnabled(id: string, enabledIds: Set<string> | undefined, fallbackDefault: boolean): boolean {
		if (enabledIds) {
			return enabledIds.has(id);
		}
		return fallbackDefault;
	}
}

export interface GuardrailToggle {
	gateId: string;
	enabled: boolean;
}

/** Gates the loop should run: a settings row wins; otherwise `defaultEnabled`. */
export function enabledGates(gates: GuardrailGate[], guardrails: GuardrailToggle[]): GuardrailGate[] {
	return gates.filter(gate => {
		const row = guardrails.find(g => g.gateId === gate.id);
		if (row) return row.enabled;
		return gate.defaultEnabled;
	});
}

/**
 * First `block` wins. `require-approval` reasons are merged. Missing hooks count as allow.
 * Pass `call` for beforeTool; omit it for beforeFinish.
 */
export async function decideGates(
	gates: GuardrailGate[],
	session: GateSession,
	call?: { name: string; args: unknown; risk: ToolRisk }
): Promise<GateDecision> {
	const approvalReasons: string[] = [];
	for (const gate of gates) {
		const decision = call
			? await gate.beforeTool?.(call, session)
			: await gate.beforeFinish?.(session);
		if (!decision || decision.action === 'allow') continue;
		if (decision.action === 'block') return decision;
		if (decision.reason.trim()) approvalReasons.push(decision.reason.trim());
	}
	if (approvalReasons.length) {
		return { action: 'require-approval', reason: approvalReasons.join(' ') };
	}
	return { action: 'allow' };
}

let shared: GateRegistry | undefined;

export function getGateRegistry(): GateRegistry {
	if (!shared) shared = new GateRegistry();
	return shared;
}

export function setGateRegistryForTests(registry: GateRegistry | undefined): void {
	shared = registry;
}
