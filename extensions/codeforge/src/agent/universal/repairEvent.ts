/**
 * Flattens the two internal repair-outcome shapes (`families/registry.ts`'s `FamilyRepairEvent`
 * and `schemaRepair.ts`'s `SchemaRepairResult`) into the single `{ family; rule; tool; outcome }`
 * shape the harness's telemetry stream expects. Wired into `@msf/plugin-agent`'s `agentRun.ts`
 * (Fase 2's `a-telemetry`): flattened here, emitted there as `AgentRunEvent`'s `harness.repair`.
 */

import type { FamilyRepairEvent } from './families/types';
import type { SchemaRepairResult } from './schemaRepair';

export interface RepairEvent {
	family: string;
	rule: string;
	tool: string;
	outcome: 'recovered' | 'stripped' | 'failed';
}

/** One event per tool name recovered (or not) by a family-grammar match for this turn. */
export function repairEventsFromFamilyMatch(event: FamilyRepairEvent, toolNames: readonly string[]): RepairEvent[] {
	const outcome: RepairEvent['outcome'] = event.mode === 'strip' ? 'stripped' : event.recoveredCalls > 0 ? 'recovered' : 'failed';
	const names = toolNames.length ? toolNames : ['(unknown)'];
	return names.map((tool) => ({ family: event.family, rule: 'grammar-parse', tool, outcome }));
}

/** One event per Ajv repair rule that fired while validating a single tool call's arguments. */
export function repairEventsFromSchemaRepair(result: SchemaRepairResult, family: string | undefined): RepairEvent[] {
	const outcome: RepairEvent['outcome'] = result.valid ? 'recovered' : 'failed';
	const events: RepairEvent[] = result.appliedRules.map((rule) => ({ family: family ?? '(none)', rule, tool: result.name, outcome }));
	if (result.nameRecovered) {
		events.push({ family: family ?? '(none)', rule: 'recoverMangledToolName', tool: result.name, outcome });
	}
	return events;
}
