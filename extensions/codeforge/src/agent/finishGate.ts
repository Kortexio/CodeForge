/**
 * Structural finish gate: exploration-only runs cannot close as "done"
 * (weak models otherwise stop at a bug list). Not intent sniffing on user text.
 */

/** Tools that change the workspace, run mutating commands, or act on the browser UI. */
export const EFFECTFUL_TOOLS = new Set([
	'edit',
	'write',
	'apply_patch',
	'delete',
	'rename',
	'shell',
	'dotnet',
	'browser_navigate',
	'browser_click',
	'browser_type',
]);

/** Shell/dotnet commands that only inspect — not effectful for the finish gate. */
const READ_ONLY_SHELL_RE =
	/^\s*(?:(?:cd|chdir|pushd|popd)\s+[^\|&;]+(?:\s*&&\s*)?)*(?:dir|ls|ll|type|cat|Get-Content|Get-ChildItem|gc|gl|pwd|echo|where|which|git\s+(?:status|log|diff|show|branch|remote|rev-parse)|rg|grep|findstr|find)\b/i;

export function isReadOnlyShellCommand(command: string): boolean {
	const c = String(command || '').trim();
	if (!c) return false;
	if (/[|;&]/.test(c.replace(/&&/g, ''))) {
		// Allow only && chains of read-only parts
		const parts = c.split(/\s*&&\s*/);
		return parts.every(p => READ_ONLY_SHELL_RE.test(p.trim()) && !/[|;&]/.test(p));
	}
	return READ_ONLY_SHELL_RE.test(c);
}

export function isEffectfulTool(name: string, command?: string): boolean {
	if (name === 'shell' || name === 'dotnet') {
		if (command !== undefined && isReadOnlyShellCommand(command)) return false;
		return true;
	}
	return EFFECTFUL_TOOLS.has(name);
}

export type DiagFinishGateInput = {
	planMode?: boolean;
	askMode?: boolean;
	coachMode?: boolean;
	statusQuestion?: boolean;
	/** Model claimed blocked: <reason>. */
	blocked?: boolean;
	/** Successful effectful tools this runAgentWithTools invocation. */
	effectfulCount: number;
	/** Any tool executed this run (including explore-only). */
	anyToolCount: number;
	/** How many times we already refused diagnose-only finish this run. */
	diagFinishNudges: number;
	/** Max refuses before accepting prose finish. */
	maxDiagFinishNudges?: number;
};

/**
 * True when the harness should refuse prose finish and demand an effectful tool
 * (or blocked:) instead of accepting a diagnosis-only wrap-up.
 */
export function shouldRefuseDiagFinish(input: DiagFinishGateInput): boolean {
	if (input.planMode || input.askMode || input.coachMode || input.statusQuestion) return false;
	if (input.blocked) return false;
	if (input.effectfulCount > 0) return false;
	if (input.anyToolCount < 1) return false;
	const max = input.maxDiagFinishNudges ?? 2;
	if (input.diagFinishNudges >= max) return false;
	return true;
}

export type SpecSelfCheckInput = {
	planMode?: boolean;
	askMode?: boolean;
	coachMode?: boolean;
	statusQuestion?: boolean;
	blocked?: boolean;
	/** Build/test verified green this run (oracle or test command). */
	verifiedGreen: boolean;
	/** Production source files written/edited. */
	writtenSourceCount: number;
	/** Spec/docs paths read this run. */
	readSpecCount: number;
	/** Test files written/edited. */
	writtenTestCount: number;
	/** How many times this one-shot already fired. */
	specCheckNudges: number;
	/** From ModelProfile.finish (default true). */
	specSelfCheckEnabled?: boolean;
	/** From ModelProfile.finish (default 1). */
	specSelfCheckMaxNudges?: number;
};

/**
 * One-shot structural reminder after production edits when a spec was read
 * or no tests were touched. Path/oracle state only — not reply-text sniffing.
 */
export function shouldRequestSpecSelfCheck(input: SpecSelfCheckInput): boolean {
	if (input.planMode || input.askMode || input.coachMode || input.statusQuestion) return false;
	if (input.blocked) return false;
	if (input.specSelfCheckEnabled === false) return false;
	if (!input.verifiedGreen) return false;
	const max = input.specSelfCheckMaxNudges ?? 1;
	if (input.specCheckNudges >= max) return false;
	if (input.writtenSourceCount < 1) return false;
	// Require a read spec AND no test-file edits — avoids speculative "fixes" on scaffold/card runs
	// that never touched docs, while still catching T2-style "src only after reading docs".
	return input.readSpecCount > 0 && input.writtenTestCount === 0;
}

/** Browser observe / act tools that prove the UI was exercised. */
export const RUNTIME_OBSERVE_TOOLS = new Set([
	'browser_navigate',
	'browser_snapshot',
	'browser_screenshot',
	'browser_click',
	'browser_type',
]);

export function isRuntimeObserveTool(name: string): boolean {
	return RUNTIME_OBSERVE_TOOLS.has(name);
}

/**
 * True when a shell/dotnet command is an oracle-style build/test (does not count
 * as runtime launch/observe). Matches known patterns + optional oracle command list.
 */
export function isOracleBuildOrTestCommand(
	command: string,
	oracleCommands?: string[]
): boolean {
	const c = String(command || '').trim();
	if (!c) return false;
	const norm = c.replace(/\s+/g, ' ');
	if (oracleCommands?.length) {
		for (const oc of oracleCommands) {
			const o = String(oc || '').replace(/\s+/g, ' ').trim();
			if (!o) continue;
			// Require the full oracle command as the whole command (or with trailing args only).
			if (norm === o || norm.startsWith(`${o} `)) {
				return true;
			}
		}
	}
	// npm / yarn / pnpm / dotnet as the command itself (not mentioned in an echo/string).
	if (/(?:^|[;&|]\s*)(?:npm|yarn|pnpm)\s+(?:test|run\s+(?:test|build))\b/i.test(norm)) return true;
	if (/(?:^|[;&|]\s*)dotnet\s+(?:test|build)\b/i.test(norm)) return true;
	return false;
}

/**
 * Whether a successful tool call counts toward runtime verification.
 * Browser observe tools always count; shell/dotnet only when not build/test.
 */
export function countsAsRuntimeObserve(
	name: string,
	command?: string,
	oracleCommands?: string[]
): boolean {
	if (isRuntimeObserveTool(name)) return true;
	if (name === 'shell' || name === 'dotnet') {
		const cmd = String(command || '');
		if (isReadOnlyShellCommand(cmd)) return false;
		return !isOracleBuildOrTestCommand(cmd, oracleCommands);
	}
	return false;
}

export type RuntimeVerifyInput = {
	planMode?: boolean;
	askMode?: boolean;
	coachMode?: boolean;
	statusQuestion?: boolean;
	blocked?: boolean;
	/**
	 * True when build/test is green, or there is no oracle for this workspace
	 * (same idea as requiring green before other finish extras).
	 */
	verifiedGreen: boolean;
	writtenSourceCount: number;
	/** Successful runtime observe tools (browser or non-oracle shell) this run. */
	runtimeObserveCount: number;
	runtimeVerifyNudges: number;
	/** Default 1 (one-shot). */
	runtimeVerifyMaxNudges?: number;
	/** Default true. */
	runtimeVerifyEnabled?: boolean;
};

/**
 * One-shot: after source edits, refuse prose finish until the model launches/observes
 * the running app (browser or non-oracle shell). Path/tool counts only.
 */
export function shouldRequestRuntimeVerify(input: RuntimeVerifyInput): boolean {
	if (input.planMode || input.askMode || input.coachMode || input.statusQuestion) return false;
	if (input.blocked) return false;
	if (input.runtimeVerifyEnabled === false) return false;
	if (!input.verifiedGreen) return false;
	if (input.writtenSourceCount < 1) return false;
	if (input.runtimeObserveCount > 0) return false;
	const max = input.runtimeVerifyMaxNudges ?? 1;
	if (input.runtimeVerifyNudges >= max) return false;
	return true;
}
