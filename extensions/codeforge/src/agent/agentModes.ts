/**
 * Registrable agent modes (P0-7) — e.g. "Zuora Workflow".
 */

export interface AgentModeDefinition {
	id: string;
	title: string;
	description?: string;
	/** Extra system prompt appended when this mode is active. */
	systemPrompt?: string;
	/** Tool namespaces to enable (undefined = all). */
	toolNamespaces?: string[];
	/** Skill ids / trigger hints preferred in this mode. */
	skillHints?: string[];
}

export interface Disposable {
	dispose(): void;
}

export class AgentModeRegistry {
	private readonly modes = new Map<string, AgentModeDefinition>();
	private activeId: string | undefined;

	register(mode: AgentModeDefinition): Disposable {
		const id = mode.id.trim();
		if (!id) throw new Error('AgentModeDefinition.id is required');
		this.modes.set(id, { ...mode, id });
		return {
			dispose: () => {
				this.modes.delete(id);
				if (this.activeId === id) this.activeId = undefined;
			},
		};
	}

	/** `null` clears the active mode. Unknown ids throw. */
	activate(id: string | null): AgentModeDefinition | undefined {
		if (!id) {
			this.activeId = undefined;
			return undefined;
		}
		const mode = this.modes.get(id);
		if (!mode) throw new Error(`Unknown agent mode "${id}"`);
		this.activeId = id;
		return mode;
	}

	active(): AgentModeDefinition | undefined {
		if (!this.activeId) return undefined;
		return this.modes.get(this.activeId);
	}

	list(): AgentModeDefinition[] {
		return [...this.modes.values()];
	}

	get(id: string): AgentModeDefinition | undefined {
		return this.modes.get(id);
	}
}

let shared: AgentModeRegistry | undefined;

export function getAgentModeRegistry(): AgentModeRegistry {
	if (!shared) shared = new AgentModeRegistry();
	return shared;
}

export function setAgentModeRegistryForTests(registry: AgentModeRegistry | undefined): void {
	shared = registry;
}

/**
 * Extension tools with a namespace are hidden unless that namespace is listed.
 * Tools with no namespace stay available. `undefined` namespaces means every tool.
 */
export function toolVisibleInMode(
	tool: { namespace?: string },
	mode: AgentModeDefinition | undefined
): boolean {
	const namespaces = mode?.toolNamespaces;
	if (!namespaces) return true;
	if (!tool.namespace) return true;
	return namespaces.includes(tool.namespace);
}
