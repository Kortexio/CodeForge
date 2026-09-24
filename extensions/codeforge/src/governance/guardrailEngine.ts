/**
 * Guardrail guidance helpers for the agent loop (advice-only — does not ban tools).
 */

import { GuardrailRuntimeConfig } from './types';
import { getGovernanceStore } from './governanceStore';
import { getProjectWikiStore } from '../memory/projectWiki';

const BROAD_EXPLORE = new Set(['list', 'glob']);
const MUTATING_FILE = new Set(['write', 'delete', 'rename']);

export function isBuildOrTestCommand(command: unknown): boolean {
	const c = String(command ?? '').toLowerCase();
	return (
		/\bdotnet\s+build\b/.test(c) ||
		/\bdotnet\s+test\b/.test(c) ||
		/\bnpm\s+run\s+build\b/.test(c) ||
		/\bnpm\s+(test|run\s+test)\b/.test(c) ||
		/\bpytest\b/.test(c) ||
		/\bmvn\s+(-B\s+)?(package|test|verify)\b/.test(c) ||
		/\bgradlew?\s+(build|test)\b/.test(c) ||
		/\bcargo\s+(build|test)\b/.test(c) ||
		/\bgo\s+test\b/.test(c) ||
		/\byarn\s+(build|test)\b/.test(c) ||
		/\bpnpm\s+(run\s+)?(build|test)\b/.test(c)
	);
}

export function isTestCommand(command: unknown): boolean {
	const c = String(command ?? '').toLowerCase();
	return (
		/\bdotnet\s+test\b/.test(c) ||
		/\bnpm\s+(test|run\s+test)\b/.test(c) ||
		/\bpytest\b/.test(c) ||
		/\bmvn\s+(-B\s+)?test\b/.test(c) ||
		/\bgradlew?\s+test\b/.test(c) ||
		/\bcargo\s+test\b/.test(c) ||
		/\bgo\s+test\b/.test(c) ||
		/\byarn\s+test\b/.test(c) ||
		/\bpnpm\s+(run\s+)?test\b/.test(c)
	);
}

export function isTestFilePath(pathArg: unknown): boolean {
	const p = String(pathArg ?? '').replace(/\\/g, '/');
	return (
		/\/tests?\//i.test(p) ||
		/\.(tests?|spec)\.[^.]+$/i.test(p) ||
		/[\\/][^/]*Tests?[\\/]/i.test(p) ||
		/[\\/][^/]*Test\.[^/]+$/i.test(p)
	);
}

export function extractBuildErrorLines(output: string, limit = 20): string[] {
	const lines = output
		.split(/\r?\n/)
		.map(l => l.trim().replace(/\s+\[[^\]]+\.(cs|fs|vb)proj\]$/i, ''))
		.filter(
			l =>
				/error\s+(CS|RZ|MSB|NU|NETSDK)\d+/i.test(l) ||
				/: error /i.test(l) ||
				/^Failed\s+\S+\s*\[/.test(l) ||
				/^not ok \d+/.test(l)
		);
	const generic = lines.length
		? []
		: output
				.split(/\r?\n/)
				.map(l => l.trim())
				.filter(l => /\berror\b/i.test(l));
	return [...new Set([...lines, ...generic])].slice(0, limit);
}

function hasTaskPlan(): boolean {
	try {
		const wiki = getProjectWikiStore();
		if (!wiki.isReady()) return false;
		const doc = wiki.getDocument('task-plan');
		if (doc && doc.content.trim().length >= 40) return true;
		const facts = wiki.currentFacts();
		return facts.some(
			f =>
				f.key === 'plan.ready' &&
				/^(true|yes|1|ready)$/i.test(String(f.value).trim())
		);
	} catch {
		return false;
	}
}

export class GuardrailSession {
	buildRed = false;
	lastBuildErrors: string[] = [];
	writesSinceBuild = 0;
	consecutiveFileWrites = 0;
	lastWritePath: string | null = null;
	testRedSeen = false;
	implWritesAfterRed = 0;
	/** Last build/test command exited 0 and no write happened since. */
	private greenAfterWrites = false;
	private mutatingWriteSeen = false;

	constructor(public cfg: GuardrailRuntimeConfig) {}

	refreshConfig(): void {
		const weak = this.cfg.weakProfile;
		const next = getGovernanceStore().runtimeConfig({ weakProfile: weak });
		this.cfg = { ...next, weakProfile: weak };
	}

	/** True when write-first nudges should wait (plan / TDD still pending). */
	shouldDeferAntiExplore(planMode = false): boolean {
		if (planMode) return true;
		if (this.cfg.requirePlanBeforeWrites && !hasTaskPlan()) return true;
		if (this.cfg.requireFailingTestBeforeImpl && !this.testRedSeen) return true;
		return false;
	}

	onShellResult(command: unknown, success: boolean, output: string): string | null {
		if (isTestCommand(command)) {
			if (!success) {
				this.testRedSeen = true;
				this.implWritesAfterRed = 0;
			} else if (this.testRedSeen) {
				this.testRedSeen = false;
				this.implWritesAfterRed = 0;
			}
		}

		if (!isBuildOrTestCommand(command)) {
			return null;
		}
		if (success) {
			this.buildRed = false;
			this.lastBuildErrors = [];
			this.writesSinceBuild = 0;
			this.consecutiveFileWrites = 0;
			this.greenAfterWrites = true;
			return null;
		}
		this.greenAfterWrites = false;
		this.buildRed = true;
		this.lastBuildErrors = extractBuildErrorLines(output);
		if (!this.cfg.buildFixGate) {
			return null;
		}
		return this.lastBuildErrors.length ? this.lastBuildErrors.join('\n') : 'build/test failed';
	}

	onSuccessfulWrite(path: unknown): void {
		const p = String(path ?? '');
		this.writesSinceBuild += 1;
		this.greenAfterWrites = false;
		if (this.lastWritePath && this.lastWritePath !== p) {
			this.consecutiveFileWrites += 1;
		} else if (!this.lastWritePath) {
			this.consecutiveFileWrites = 1;
		}
		this.lastWritePath = p || this.lastWritePath;
		if (this.cfg.requireFailingTestBeforeImpl && this.testRedSeen && !isTestFilePath(p)) {
			this.implWritesAfterRed += 1;
		}
	}

	/**
	 * Advice-only: never rejects a tool. Call before/after execution and append to tool output or nudges.
	 */
	adviceFor(tool: string, args: Record<string, unknown>): string | null {
		this.refreshConfig();
		const tips: string[] = [];

		if (
			!this.cfg.weakProfile &&
			this.cfg.buildFixGate &&
			this.cfg.blockExploreWhileBuildRed &&
			this.buildRed &&
			BROAD_EXPLORE.has(tool)
		) {
			tips.push(`Build is red: ${this.lastBuildErrors.slice(0, 4).join(' | ') || 'see the last build output'}`);
		}

		if (MUTATING_FILE.has(tool)) {
			if (this.cfg.requirePlanBeforeWrites && !this.mutatingWriteSeen && !hasTaskPlan()) {
				tips.push(
					'No wiki task-plan yet. Consider wiki_write id=task-plan with checklist + Definition of Done (especially under weak harness).'
				);
			}

			if (tool === 'write' || tool === 'delete' || tool === 'rename') {
				const pathArg = tool === 'rename' ? args.to ?? args.path : args.path;
				if (this.cfg.requireFailingTestBeforeImpl && !isTestFilePath(pathArg)) {
					if (!this.testRedSeen) {
						tips.push(
							'TDD gate is on: prefer a failing test (then run tests) before more production writes. Test files are fine anytime.'
						);
					} else if (this.implWritesAfterRed >= this.cfg.maxImplWritesAfterRed) {
						tips.push(
							`${this.implWritesAfterRed} production writes since the last red test — re-run tests before continuing.`
						);
					}
				}
			}
		}

		// Build-after-writes and mass-rewrite are enforced by the oracle and the large-file gate, not by text.
		if (tool === 'write') {
			if (this.cfg.oneStackDotnet) {
				const path = String(args.path ?? '').replace(/\\/g, '/');
				const content = String(args.content ?? '');
				if (/\/Views\//i.test(path) && /(^|\n)\s*@page\b/.test(content)) {
					tips.push(
						`Stack warning: @page inside Views/ (${path}). Prefer Pages/ for Razor Pages, or remove @page for MVC Views.`
					);
				}
			}
		}

		if (!tips.length) return null;
		return tips.map(t => `(note: ${t})`).join('\n');
	}

	/** @deprecated Always null — tools are no longer hard-blocked by guardrails. */
	blockReason(_tool: string, _args: Record<string, unknown>): string | null {
		return null;
	}

	/** A build/test command exited 0 after the last write (the only valid basis for a green claim). */
	hasVerifiedGreen(): boolean {
		return this.greenAfterWrites && !this.buildRed && this.writesSinceBuild === 0;
	}

	markMutatingWriteAllowed(): void {
		this.mutatingWriteSeen = true;
	}

	compactStickyExtra(): string {
		if (!this.cfg.preserveBuildErrorsOnCompact || !this.buildRed) {
			return '';
		}
		return [
			'### Build still red (errors kept across compact)',
			...this.lastBuildErrors.slice(0, 15).map(e => `· ${e}`),
		].join('\n');
	}

	antiExploreEnabled(planMode = false): boolean {
		if (!this.cfg.antiExploreLoop) return false;
		if (this.shouldDeferAntiExplore(planMode)) return false;
		return true;
	}
}
