/**
 * Persist HITL approvals: once / session / always.
 * Cursor-like "Allow all file edits" for write/rename/delete.
 */

import * as vscode from 'vscode';

const GLOBAL_KEY = 'codeforge.ai.approvals.always';
const EDITS_ALWAYS_KEY = 'codeforge.ai.approvals.editsAlways';

/** File-modification tools that share "Allow all edits". */
export const EDIT_TOOLS = new Set(['write', 'rename', 'delete']);

export type PermissionLevel = 'default' | 'assisted' | 'allowAll';

export class ApprovalPolicy {
	private readonly sessionAllowed = new Set<string>();
	private sessionAllowAllEdits = false;
	private sessionAllowAll = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private alwaysAllowed(): Set<string> {
		const fromState = this.context.globalState.get<string[]>(GLOBAL_KEY) ?? [];
		const fromConfig =
			vscode.workspace.getConfiguration('codeforge.ai').get<string[]>('autoApprove') ?? [];
		return new Set([...fromState, ...fromConfig].map(normalizeTool));
	}

	/** Setting or persisted "always allow all file edits". */
	autoApproveEditsEnabled(): boolean {
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		if (cfg.get<boolean>('autoApproveEdits') === true) {
			return true;
		}
		return this.context.globalState.get<boolean>(EDITS_ALWAYS_KEY) === true;
	}

	isAutoApproved(tool: string): boolean {
		const key = normalizeTool(tool);
		if (this.sessionAllowAll) {
			return true;
		}
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
		const next = Array.from(new Set([...this.alwaysAllowed(), key]));
		await this.context.globalState.update(GLOBAL_KEY, next);

		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		const current = cfg.get<string[]>('autoApprove') ?? [];
		if (!current.map(normalizeTool).includes(key)) {
			await cfg.update('autoApprove', [...current, key], vscode.ConfigurationTarget.Global);
		}
	}

	/** Cursor-like: allow all file edits for session or forever. */
	async allowAllEdits(scope: 'session' | 'always'): Promise<void> {
		this.sessionAllowAllEdits = true;
		for (const t of EDIT_TOOLS) {
			this.sessionAllowed.add(t);
		}
		if (scope === 'always') {
			await this.context.globalState.update(EDITS_ALWAYS_KEY, true);
			await vscode.workspace
				.getConfiguration('codeforge.ai')
				.update('autoApproveEdits', true, vscode.ConfigurationTarget.Global);
			const next = Array.from(new Set([...this.alwaysAllowed(), ...EDIT_TOOLS]));
			await this.context.globalState.update(GLOBAL_KEY, Array.from(next));
			await vscode.workspace
				.getConfiguration('codeforge.ai')
				.update('autoApprove', Array.from(next), vscode.ConfigurationTarget.Global);
		}
	}

	/** Auto mode: edits + shell for this session (no HITL prompts). */
	async allowAutoSession(): Promise<void> {
		await this.allowAllEdits('session');
		this.sessionAllowed.add('shell');
		this.sessionAllowAll = true;
	}

	clearSession(): void {
		this.sessionAllowed.clear();
		this.sessionAllowAllEdits = false;
		this.sessionAllowAll = false;
	}

	/** Composer permission chip level (does not replace Ask mode). */
	getPermissionLevel(mode: string): PermissionLevel {
		if (mode === 'auto' || this.sessionAllowAll) return 'allowAll';
		const preview =
			vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('previewEdits') === true;
		if (preview) return 'assisted';
		return 'default';
	}

	async applyPermissionLevel(level: PermissionLevel): Promise<'ask' | 'agent' | 'auto'> {
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		if (level === 'allowAll') {
			await this.allowAutoSession();
			await cfg.update('previewEdits', false, vscode.ConfigurationTarget.Global);
			return 'auto';
		}
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
		await this.context.globalState.update(GLOBAL_KEY, next);
		await vscode.workspace
			.getConfiguration('codeforge.ai')
			.update('autoApprove', next, vscode.ConfigurationTarget.Global);
	}

	async revokeAllEditsAlways(): Promise<void> {
		this.sessionAllowAllEdits = false;
		await this.context.globalState.update(EDITS_ALWAYS_KEY, false);
		await vscode.workspace
			.getConfiguration('codeforge.ai')
			.update('autoApproveEdits', false, vscode.ConfigurationTarget.Global);
		for (const t of EDIT_TOOLS) {
			await this.revokeAlways(t);
		}
	}
}

function normalizeTool(tool: string): string {
	return tool.trim().toLowerCase();
}

let shared: ApprovalPolicy | undefined;

export function initApprovalPolicy(context: vscode.ExtensionContext): ApprovalPolicy {
	shared = new ApprovalPolicy(context);
	return shared;
}

export function getApprovalPolicy(): ApprovalPolicy {
	if (!shared) {
		throw new Error('ApprovalPolicy not initialized');
	}
	return shared;
}
