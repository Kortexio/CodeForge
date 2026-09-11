/**
 * Disk-backed execution traces under ~/.CodeForge/ai/traces/
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, tracesDir } from './paths';

export type TraceLevel = 'none' | 'basic' | 'detailed';

export interface TraceEvent {
	id: string;
	type: 'llm' | 'tool' | 'approval' | 'compact' | 'error' | 'info' | 'state';
	label: string;
	detail?: string;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	costEstimate?: number;
	timestamp: string;
	sessionId?: string;
}

export class TraceService {
	private events: TraceEvent[] = [];
	private sequence = 0;
	private sessionId?: string;
	private runFile?: string;

	constructor(private readonly output: vscode.OutputChannel) {}

	setSession(sessionId?: string): void {
		this.sessionId = sessionId;
		if (sessionId) {
			this.runFile = path.join(tracesDir(), `${sessionId}-${Date.now()}.jsonl`);
		}
	}

	getLevel(): TraceLevel {
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		return (cfg.get<string>('traceLevel') as TraceLevel) || 'basic';
	}

	clear(): void {
		this.events = [];
	}

	getEvents(): TraceEvent[] {
		return [...this.events];
	}

	record(partial: Omit<TraceEvent, 'id' | 'timestamp'>): void {
		const level = this.getLevel();
		if (level === 'none') return;

		const event: TraceEvent = {
			...partial,
			id: `t${++this.sequence}`,
			timestamp: new Date().toISOString(),
			sessionId: partial.sessionId ?? this.sessionId,
		};
		this.events.push(event);
		if (this.events.length > 500) {
			this.events.shift();
		}

		const line = this.format(event, level === 'detailed');
		this.output.appendLine(line);
		void this.appendDisk(event);
	}

	private async appendDisk(event: TraceEvent): Promise<void> {
		try {
			await ensureDir(tracesDir());
			const file =
				this.runFile ??
				path.join(tracesDir(), `session-${new Date().toISOString().slice(0, 10)}.jsonl`);
			await fs.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
		} catch {
			/* ignore disk errors */
		}
	}

	llm(opts: {
		label: string;
		durationMs: number;
		tokensIn?: number;
		tokensOut?: number;
		detail?: string;
	}): void {
		const cost =
			opts.tokensIn !== undefined && opts.tokensOut !== undefined
				? opts.tokensIn * 0.000001 + opts.tokensOut * 0.000003
				: undefined;
		this.record({
			type: 'llm',
			label: opts.label,
			durationMs: opts.durationMs,
			tokensIn: opts.tokensIn,
			tokensOut: opts.tokensOut,
			costEstimate: cost,
			detail: opts.detail,
		});
	}

	tool(opts: {
		name: string;
		durationMs: number;
		success: boolean;
		detail?: string;
	}): void {
		this.record({
			type: 'tool',
			label: opts.name,
			durationMs: opts.durationMs,
			detail: opts.success ? opts.detail : `FAILED: ${opts.detail ?? ''}`,
		});
	}

	state(label: string, detail?: string): void {
		this.record({ type: 'state', label, detail });
	}

	info(label: string, detail?: string): void {
		this.record({ type: 'info', label, detail });
	}

	error(label: string, detail?: string): void {
		this.record({ type: 'error', label, detail });
	}

	showSummary(): void {
		const level = this.getLevel();
		if (level === 'none') {
			this.output.appendLine('[trace] Trace level is none');
			this.output.show();
			return;
		}

		const llms = this.events.filter(e => e.type === 'llm');
		const tools = this.events.filter(e => e.type === 'tool');
		const tokensIn = llms.reduce((s, e) => s + (e.tokensIn ?? 0), 0);
		const tokensOut = llms.reduce((s, e) => s + (e.tokensOut ?? 0), 0);
		const cost = llms.reduce((s, e) => s + (e.costEstimate ?? 0), 0);
		const llmMs = llms.reduce((s, e) => s + (e.durationMs ?? 0), 0);
		const toolMs = tools.reduce((s, e) => s + (e.durationMs ?? 0), 0);

		this.output.appendLine('─── CodeForge AI Trace Summary ───');
		this.output.appendLine(
			`Events: ${this.events.length} | LLM calls: ${llms.length} | Tools: ${tools.length}`
		);
		this.output.appendLine(
			`Tokens in/out: ${tokensIn}/${tokensOut} | Est. cost: $${cost.toFixed(4)}`
		);
		this.output.appendLine(`LLM time: ${llmMs}ms | Tool time: ${toolMs}ms`);
		if (this.runFile) {
			this.output.appendLine(`Disk: ${this.runFile}`);
		}
		if (level === 'detailed') {
			for (const e of this.events.slice(-40)) {
				this.output.appendLine(this.format(e, true));
			}
		}
		this.output.appendLine('────────────────────────────────────');
		this.output.show();
	}

	private format(event: TraceEvent, detailed: boolean): string {
		const parts = [
			`[${event.type}]`,
			event.label,
			event.durationMs !== undefined ? `${event.durationMs}ms` : undefined,
			event.tokensIn !== undefined ? `in=${event.tokensIn}` : undefined,
			event.tokensOut !== undefined ? `out=${event.tokensOut}` : undefined,
			event.costEstimate !== undefined ? `$${event.costEstimate.toFixed(4)}` : undefined,
		].filter(Boolean);
		let line = parts.join(' ');
		if (detailed && event.detail) {
			line += ` | ${event.detail.slice(0, 200)}`;
		}
		return line;
	}
}

let sharedTrace: TraceService | undefined;

export function initTrace(output: vscode.OutputChannel): TraceService {
	sharedTrace = new TraceService(output);
	return sharedTrace;
}

export function getTrace(): TraceService | undefined {
	return sharedTrace;
}
