/**
 * Extensible agent tool registry (P0-1).
 * Native tools register at startup; extensions add tools via CodeForgeApi.tools.register.
 */

export type ToolRisk = 'read' | 'local-write' | 'remote-write' | 'remote-prod-write' | 'shell';

/** Minimal JSON Schema subset used for OpenAI function parameters. */
export type JSONSchema7 = Record<string, unknown>;

export interface ApprovalRequest {
	tool: string;
	arguments: Record<string, unknown>;
	risk: 'low' | 'medium' | 'high' | 'critical';
	reason: string;
}

export interface ToolTrace {
	record(partial: {
		type: string;
		label: string;
		detail?: string;
		durationMs?: number;
	}): void;
	tool?(opts: {
		name: string;
		durationMs: number;
		success: boolean;
		detail?: string;
	}): void;
}

export interface ToolContext {
	workspaceRoot?: string | null;
	sessionId?: string;
	signal: AbortSignal;
	trace: ToolTrace;
	approve(req: ApprovalRequest): Promise<boolean>;
	progress(msg: string): void;
	/** Host extras for native builtins (agent loop opts, call id, depth, …). */
	extras?: Record<string, unknown>;
}

export interface ToolDefinition<A = any> {
	name: string;
	description: string;
	parameters: JSONSchema7;
	risk: ToolRisk;
	namespace?: string;
	/** Override HITL gate; default = risk !== 'read'. */
	requiresApproval?: boolean;
	isEnabled?(ctx: ToolContext): boolean;
	execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
	content: string;
	artifactRef?: string;
	data?: unknown;
	isError?: boolean;
}

export interface OpenAiTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: JSONSchema7;
	};
}

export interface Disposable {
	dispose(): void;
}

export type ToolListFilter = { namespace?: string };

/** HITL approval risk level derived from ToolRisk. */
export function approvalLevelForRisk(risk: ToolRisk): ApprovalRequest['risk'] {
	switch (risk) {
		case 'read':
			return 'low';
		case 'local-write':
			return 'medium';
		case 'shell':
		case 'remote-write':
			return 'high';
		case 'remote-prod-write':
			return 'critical';
		default:
			return 'medium';
	}
}

/** Whether this risk class needs user approval (before auto-approve policy). */
export function riskRequiresApproval(risk: ToolRisk): boolean {
	return risk !== 'read';
}

/** Whether this tool needs user approval (before auto-approve policy). */
export function toolNeedsApproval(def: Pick<ToolDefinition, 'risk' | 'requiresApproval'>): boolean {
	if (typeof def.requiresApproval === 'boolean') {
		return def.requiresApproval;
	}
	return riskRequiresApproval(def.risk);
}

export class ToolRegistry {
	private readonly tools = new Map<string, ToolDefinition>();
	private readonly changeListeners = new Set<() => void>();

	onDidChange(listener: () => void): Disposable {
		this.changeListeners.add(listener);
		return {
			dispose: () => {
				this.changeListeners.delete(listener);
			},
		};
	}

	private emitChange(): void {
		for (const l of this.changeListeners) {
			try {
				l();
			} catch {
				/* ignore listener errors */
			}
		}
	}

	register(def: ToolDefinition): Disposable {
		const name = def.name.trim();
		if (!name) {
			throw new Error('ToolDefinition.name is required');
		}
		this.tools.set(name, { ...def, name });
		this.emitChange();
		return {
			dispose: () => {
				const cur = this.tools.get(name);
				if (cur === def || cur?.name === name) {
					this.tools.delete(name);
					this.emitChange();
				}
			},
		};
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	list(filter?: ToolListFilter): ToolDefinition[] {
		let list = [...this.tools.values()];
		if (filter?.namespace !== undefined) {
			list = list.filter(t => t.namespace === filter.namespace);
		}
		return list;
	}

	toOpenAiTools(filter?: ToolListFilter): OpenAiTool[] {
		return this.list(filter).map(t => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			},
		}));
	}

	async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
		const def = this.tools.get(name);
		if (!def) {
			return { content: `Error: unknown tool "${name}"`, isError: true };
		}
		if (def.isEnabled && !def.isEnabled(ctx)) {
			return { content: `Error: tool "${name}" is disabled in this context`, isError: true };
		}
		try {
			return await def.execute(args as never, ctx);
		} catch (err) {
			return {
				content: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}
}

let shared: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
	if (!shared) {
		shared = new ToolRegistry();
	}
	return shared;
}

/** Test helper — replace the shared registry. */
export function setToolRegistryForTests(registry: ToolRegistry | undefined): void {
	shared = registry;
}
