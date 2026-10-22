/**
 * Protocol telemetry aggregator + per-model rollup persistence.
 * Only consumes kind==='protocol' events from the agent loop (structural).
 */

import * as fs from 'fs';
import * as path from 'path';
import { modelProfileDir, modelSafeName } from '../storage/paths';

export const PROTOCOL_COUNTER_KEYS = [
	'nativeToolCalls',
	'contentToolCalls',
	'badArgs',
	'unknownTools',
	'lengthExits',
	'emptyReplies',
	'systemChars',
	'toolsChars',
] as const;

export type ProtocolCounterKey = (typeof PROTOCOL_COUNTER_KEYS)[number];

export type ProtocolCounters = Record<ProtocolCounterKey, number>;

export type ProtocolSample = {
	at: string;
	reason?: string;
	tool?: string;
	[key: string]: unknown;
};

export type ProtocolActivity = {
	kind?: string;
	label?: string;
	detail?: string;
};

const SAMPLE_CAP = 20;
const ROLLUP_WINDOW = 50;

export function emptyProtocolCounters(): ProtocolCounters {
	return {
		nativeToolCalls: 0,
		contentToolCalls: 0,
		badArgs: 0,
		unknownTools: 0,
		lengthExits: 0,
		emptyReplies: 0,
		systemChars: 0,
		toolsChars: 0,
	};
}

export type ProtocolAggregator = {
	observe(ev: ProtocolActivity): void;
	snapshot(): { protocol: ProtocolCounters; samples: ProtocolSample[]; sampleCount: number };
};

export function createProtocolAggregator(opts?: { sampleCap?: number }): ProtocolAggregator {
	const protocol = emptyProtocolCounters();
	const samples: ProtocolSample[] = [];
	const sampleCap = opts?.sampleCap ?? SAMPLE_CAP;

	return {
		observe(ev: ProtocolActivity): void {
			if (ev.kind !== 'protocol') return;
			const label = String(ev.label || '');
			if (label === 'sample') {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = JSON.parse(String(ev.detail || '{}')) as Record<string, unknown>;
				} catch {
					parsed = { reason: 'unparsed_sample', preview: String(ev.detail || '').slice(0, 500) };
				}
				if (samples.length < sampleCap) {
					samples.push({ at: new Date().toISOString(), ...parsed });
				}
				return;
			}
			if (label === 'systemChars' || label === 'toolsChars') {
				protocol[label] = Number(ev.detail || 0) || 0;
				return;
			}
			if ((PROTOCOL_COUNTER_KEYS as readonly string[]).includes(label)) {
				const key = label as ProtocolCounterKey;
				protocol[key] += Number(ev.detail || 1) || 1;
			}
		},
		snapshot() {
			return {
				protocol: { ...protocol },
				samples: samples.slice(),
				sampleCount: samples.length,
			};
		},
	};
}

export type FlushRunTelemetryInput = {
	serverId: string;
	model: string;
	source: 'chat' | 'bench';
	sessionId?: string;
	loopExit?: string;
	elapsedMs?: number;
	aggregator: ProtocolAggregator;
	/** Override profile root (tests). */
	profileDir?: string;
};

export type RunTelemetryRecord = {
	at: string;
	serverId: string;
	model: string;
	source: 'chat' | 'bench';
	sessionId?: string;
	loopExit?: string;
	elapsedMs?: number;
	protocol: ProtocolCounters;
	sampleCount: number;
	sampleReasons: string[];
};

export type ProtocolRollup = {
	serverId: string;
	model: string;
	updatedAt: string;
	runCount: number;
	sums: ProtocolCounters;
	/** Last N runs (newest last). */
	recent: RunTelemetryRecord[];
};

function ensureDirSync(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function flushRunTelemetry(input: FlushRunTelemetryInput): RunTelemetryRecord {
	const snap = input.aggregator.snapshot();
	const record: RunTelemetryRecord = {
		at: new Date().toISOString(),
		serverId: input.serverId,
		model: input.model,
		source: input.source,
		sessionId: input.sessionId,
		loopExit: input.loopExit,
		elapsedMs: input.elapsedMs,
		protocol: snap.protocol,
		sampleCount: snap.sampleCount,
		sampleReasons: snap.samples
			.map(s => String(s.reason || ''))
			.filter(Boolean)
			.slice(0, SAMPLE_CAP),
	};

	const dir = input.profileDir ?? modelProfileDir(input.serverId, input.model);
	ensureDirSync(dir);
	const runsPath = path.join(dir, 'runs.jsonl');
	fs.appendFileSync(runsPath, `${JSON.stringify(record)}\n`, 'utf8');

	const rollupPath = path.join(dir, 'rollup.json');
	const rollup = readRollup(rollupPath) ?? {
		serverId: input.serverId,
		model: input.model,
		updatedAt: record.at,
		runCount: 0,
		sums: emptyProtocolCounters(),
		recent: [],
	};
	rollup.runCount += 1;
	rollup.updatedAt = record.at;
	for (const key of PROTOCOL_COUNTER_KEYS) {
		rollup.sums[key] += record.protocol[key];
	}
	rollup.recent.push(record);
	if (rollup.recent.length > ROLLUP_WINDOW) {
		rollup.recent = rollup.recent.slice(-ROLLUP_WINDOW);
	}
	fs.writeFileSync(rollupPath, JSON.stringify(rollup, null, 2), 'utf8');
	return record;
}

export function readRollup(rollupPath: string): ProtocolRollup | undefined {
	try {
		if (!fs.existsSync(rollupPath)) return undefined;
		return JSON.parse(fs.readFileSync(rollupPath, 'utf8')) as ProtocolRollup;
	} catch {
		return undefined;
	}
}

export function loadModelRollup(serverId: string, model: string, profileDir?: string): ProtocolRollup | undefined {
	const dir = profileDir ?? modelProfileDir(serverId, model);
	return readRollup(path.join(dir, 'rollup.json'));
}

export function truncatedToolJsonRate(rollup: ProtocolRollup): number {
	const runs = rollup.recent;
	if (!runs.length) return 0;
	let hits = 0;
	for (const r of runs) {
		if (r.sampleReasons.some(x => x === 'truncated_tool_json')) hits += 1;
	}
	return hits / runs.length;
}

export function leakedParamRate(rollup: ProtocolRollup): number {
	const runs = rollup.recent;
	if (!runs.length) return 0;
	let hits = 0;
	for (const r of runs) {
		if (r.sampleReasons.some(x => /leaked_param/.test(x))) hits += 1;
	}
	return hits / runs.length;
}

export function lengthExitRate(rollup: ProtocolRollup): number {
	const runs = rollup.recent;
	if (!runs.length) return 0;
	let hits = 0;
	for (const r of runs) {
		if ((r.protocol.lengthExits ?? 0) > 0 || r.loopExit === 'length') hits += 1;
	}
	return hits / runs.length;
}

export { modelSafeName, ROLLUP_WINDOW };
