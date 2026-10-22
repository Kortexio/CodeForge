/**
 * Persist HITL approvals: once / session / always.
 * Cursor-like "Allow all file edits" for write/rename/delete.
 */

import * as vscode from 'vscode';

const GLOBAL_KEY = 'codeforge.ai.approvals.always';
const EDITS_ALWAYS_KEY = 'codeforge.ai.approvals.editsAlways';
const MIGRATED_KEY = 'codeforge.ai.approvals.migratedToSettings';

/** File-modification tools that share "Allow all edits". */
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'rename', 'delete']);

export type PermissionLevel = 'default' | 'assisted' | 'allowAll';

export class ApprovalPolicy {
	private readonly sessionAllowed = new Set<string>();
	private sessionAllowAllEdits = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private cfg() {
		return vscode.workspace.getConfiguration('codeforge.ai');
	}

	globalAllowAllEnabled(): boolean {
		if (this.cfg().get<boolean>('allowAll') === true) return true;
		if (this.cfg().get<boolean>('fullAgentFreedom') === true) return true;
		return false;
	}

	private alwaysAllowed(): Set<string> {
		const fromConfig = this.cfg().get<string[]>('autoApprove') ?? [];
		return new Set(fromConfig.map(normalizeTool));
	}

	/** Setting or persisted "always allow all file edits". */
	autoApproveEditsEnabled(): boolean {
		if (this.cfg().get<boolean>('autoApproveEdits') === true) {
			return true;
		}
		return false;
	}

	isAutoApproved(tool: string): boolean {
		if (this.globalAllowAllEnabled()) {
			return true;
		}
		const key = normalizeTool(tool);
		if (EDIT_TOOLS.has(key) && (this.sessionAllowAllEdits || this.autoApproveEditsEnabled())) {
			return true;
		}
		return this.sessionAllowed.has(key) || this.alwaysAllowed().has(key);
	}

	async remember(tool: string, scope: 'once' | 'session' | 'always'): Promise<void> {
		const key = normalizeTool(tool);
		if (scope === 'once') {
			return;
		}
		if (scope === 'session') {
			this.sessionAllowed.add(key);
			return;
		}

		this.sessionAllowed.add(key);
		const cfg = this.cfg();
		const current = cfg.get<string[]>('autoApprove') ?? [];
		if (!current.map(normalizeTool).includes(key)) {
			await cfg.update('autoApprove', [...current, key], vscode.ConfigurationTarget.Global);
		}
	}

	async setGlobalAllowAll(enabled: boolean): Promise<void> {
		await this.cfg().update('allowAll', enabled, vscode.ConfigurationTarget.Global);
		if (enabled) {
			await this.allowAutoSession();
		} else {
			this.clearSession();
		}
	}

	/** Cursor-like: allow all file edits for session or forever. */
	async allowAllEdits(scope: 'session' | 'always'): Promise<void> {
		this.sessionAllowAllEdits = true;
		for (const t of EDIT_TOOLS) {
			this.sessionAllowed.add(t);
		}
		if (scope === 'always') {
			await this.cfg().update('autoApproveEdits', true, vscode.ConfigurationTarget.Global);
			const next = Array.from(new Set([...this.alwaysAllowed(), ...EDIT_TOOLS]));
			await this.cfg().update('autoApprove', Array.from(next), vscode.ConfigurationTarget.Global);
		}
	}

	/** Auto mode: edits + shell for this session (no HITL prompts). */
	async allowAutoSession(): Promise<void> {
		await this.allowAllEdits('session');
		this.sessionAllowed.add('shell');
	}

	clearSession(): void {
		this.sessionAllowed.clear();
		this.sessionAllowAllEdits = false;
	}

	/** Composer permission chip level (does not replace Ask mode). */
	getPermissionLevel(_mode?: string): PermissionLevel {
		if (this.globalAllowAllEnabled()) return 'allowAll';
		const preview = this.cfg().get<boolean>('previewEdits') === true;
		if (preview) return 'assisted';
		return 'default';
	}

	/**
	 * Apply permission chip. Returns the agent mode to keep (always agent for
	 * Default/Assisted/Allow all — Auto is no longer a mode).
	 */
	async applyPermissionLevel(level: PermissionLevel): Promise<'agent'> {
		const cfg = this.cfg();
		if (level === 'allowAll') {
			await cfg.update('allowAll', true, vscode.ConfigurationTarget.Global);
			await cfg.update('previewEdits', false, vscode.ConfigurationTarget.Global);
			await this.allowAutoSession();
			return 'agent';
		}
		await cfg.update('allowAll', false, vscode.ConfigurationTarget.Global);
		this.clearSession();
		if (level === 'assisted') {
			await cfg.update('previewEdits', true, vscode.ConfigurationTarget.Global);
		} else {
			await cfg.update('previewEdits', false, vscode.ConfigurationTarget.Global);
		}
		return 'agent';
	}

	cyclePermissionLevel(current: PermissionLevel): PermissionLevel {
		if (current === 'default') return 'assisted';
		if (current === 'assisted') return 'allowAll';
		return 'default';
	}

	async revokeAlways(tool: string): Promise<void> {
		const key = normalizeTool(tool);
		this.sessionAllowed.delete(key);
		const next = Array.from(this.alwaysAllowed()).filter(t => t !== key);
		await this.cfg().update('autoApprove', next, vscode.ConfigurationTarget.Global);
	}

	async revokeAllEditsAlways(): Promise<void> {
		this.sessionAllowAllEdits = false;
		await this.cfg().update('autoApproveEdits', false, vscode.ConfigurationTarget.Global);
		for (const t of EDIT_TOOLS) {
			await this.revokeAlways(t);
		}
	}

	async revokeAllPermissions(): Promise<void> {
		await this.cfg().update('allowAll', false, vscode.ConfigurationTarget.Global);
		await this.revokeAllEditsAlways();
		this.clearSession();
		await this.cfg().update('autoApprove', [], vscode.ConfigurationTarget.Global);
	}

	/** Move legacy globalState approval lists into workspace settings once. */
	async migrateLegacyGlobalState(): Promise<void> {
		if (this.context.globalState.get<boolean>(MIGRATED_KEY)) return;

		const fromState = this.context.globalState.get<string[]>(GLOBAL_KEY) ?? [];
		const editsAlways = this.context.globalState.get<boolean>(EDITS_ALWAYS_KEY) === true;
		const cfg = this.cfg();
		const current = cfg.get<string[]>('autoApprove') ?? [];
		const merged = Array.from(new Set([...current, ...fromState].map(normalizeTool)));
		if (merged.length) {
			await cfg.update('autoApprove', merged, vscode.ConfigurationTarget.Global);
		}
		if (editsAlways) {
			await cfg.update('autoApproveEdits', true, vscode.ConfigurationTarget.Global);
		}
		await this.context.globalState.update(GLOBAL_KEY, undefined);
		await this.context.globalState.update(EDITS_ALWAYS_KEY, undefined);
		await this.context.globalState.update(MIGRATED_KEY, true);
	}
}

function normalizeTool(tool: string): string {
	return tool.trim().toLowerCase();
}

let shared: ApprovalPolicy | undefined;

export function initApprovalPolicy(context: vscode.ExtensionContext): ApprovalPolicy {
	shared = new ApprovalPolicy(context);
	void shared.migrateLegacyGlobalState();
	return shared;
}

export function getApprovalPolicy(): ApprovalPolicy {
	if (!shared) {
		throw new Error('ApprovalPolicy not initialized');
	}
	return shared;
}
