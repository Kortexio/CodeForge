/**
 * Hard guardrail enforcement helpers for the agent loop.
 */

import { GuardrailRuntimeConfig } from './types';
import { getGovernanceStore } from './governanceStore';

const EXPLORE = new Set(['list', 'read', 'retrieve', 'search', 'grep', 'glob']);

export function isBuildOrTestCommand(command: unknown): boolean {
	const c = String(command ?? '').toLowerCase();
	return (
		/\bdotnet\s+build\b/.test(c) ||
		/\bdotnet\s+test\b/.test(c) ||
		/\bnpm\s+run\s+build\b/.test(c) ||
		/\bmvn\s+(-B\s+)?(package|test|verify)\b/.test(c) ||
		/\bgradlew?\s+build\b/.test(c) ||
		/\bcargo\s+(build|test)\b/.test(c)
	);
}

export function extractBuildErrorLines(output: string, limit = 20): string[] {
	return output
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => /error\s+(CS|RZ|MSB)\d+/i.test(l) || /: error /i.test(l))
		.slice(0, limit);
}

export class GuardrailSession {
	buildRed = false;
	lastBuildErrors: string[] = [];
	writesSinceBuild = 0;
	consecutiveFileWrites = 0;
	lastWritePath: string | null = null;

	constructor(public cfg: GuardrailRuntimeConfig) {}

	refreshConfig(): void {
		this.cfg = getGovernanceStore().runtimeConfig();
	}

	onShellResult(command: unknown, success: boolean, output: string): string | null {
		if (!isBuildOrTestCommand(command)) {
			return null;
		}
		if (success) {
			this.buildRed = false;
			this.lastBuildErrors = [];
			this.writesSinceBuild = 0;
			this.consecutiveFileWrites = 0;
			return null;
		}
		this.buildRed = true;
		this.lastBuildErrors = extractBuildErrorLines(output);
		if (!this.cfg.buildFixGate) {
			return null;
		}
		const errs =
			this.lastBuildErrors.length > 0
				? this.lastBuildErrors.map(e => `· ${e}`).join('\n')
				: '· (see shell output)';
		return [
			'### GUARDRAIL: BUILD-FIX MODE',
			'The last build/test failed. Do NOT explore the whole repo or rewrite unrelated files.',
			'Fix ONLY the reported errors, one cluster at a time, then run the same build again.',
			'Errors:',
			errs,
		].join('\n');
	}

	onSuccessfulWrite(path: unknown): void {
		const p = String(path ?? '');
		this.writesSinceBuild += 1;
		if (this.lastWritePath && this.lastWritePath !== p) {
			this.consecutiveFileWrites += 1;
		} else if (!this.lastWritePath) {
			this.consecutiveFileWrites = 1;
		}
		this.lastWritePath = p || this.lastWritePath;
	}

	/** Returns a block message if the tool call must be rejected. */
	blockReason(tool: string, args: Record<string, unknown>): string | null {
		this.refreshConfig();

		if (
			this.cfg.buildFixGate &&
			this.cfg.blockExploreWhileBuildRed &&
			this.buildRed &&
			EXPLORE.has(tool)
		) {
			return (
				`Blocked by guardrail build_fix_gate: build is still failing. ` +
				`Read/fix the error files or run build — do not ${tool} for broad exploration.\n` +
				(this.lastBuildErrors.slice(0, 8).join('\n') || '')
			);
		}

		if (tool === 'write') {
			if (
				this.cfg.requireBuildAfterWrites &&
				this.writesSinceBuild >= this.cfg.maxWritesWithoutBuild
			) {
				return (
					`Blocked by guardrail require_build_after_writes: ` +
					`${this.writesSinceBuild} writes without a successful build. ` +
					`Run \`dotnet build\` (or project build) before more writes.`
				);
			}
			if (
				this.cfg.blockMassRewrite &&
				this.consecutiveFileWrites >= this.cfg.maxConsecutiveFileWrites
			) {
				return (
					`Blocked by guardrail block_mass_rewrite: too many consecutive writes to different files ` +
					`(${this.consecutiveFileWrites}). Run build/diagnostics and fix errors before continuing.`
				);
			}
			if (this.cfg.oneStackDotnet) {
				const path = String(args.path ?? '').replace(/\\/g, '/');
				const content = String(args.content ?? '');
				if (/\/Views\//i.test(path) && /(^|\n)\s*@page\b/.test(content)) {
					return (
						`Blocked by guardrail one_stack_dotnet: refusing to write @page into Views/ (${path}). ` +
						`Use Pages/ for Razor Pages, or remove @page for MVC Views.`
					);
				}
			}
		}

		return null;
	}

	compactStickyExtra(): string {
		if (!this.cfg.preserveBuildErrorsOnCompact || !this.buildRed) {
			return '';
		}
		return [
			'### BUILD STILL RED (preserved across compact)',
			...this.lastBuildErrors.slice(0, 15).map(e => `· ${e}`),
			'Continue fixing these errors; do not restart exploration from scratch.',
		].join('\n');
	}

	antiExploreEnabled(): boolean {
		return this.cfg.antiExploreLoop;
	}
}
