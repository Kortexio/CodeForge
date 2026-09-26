/**
 * Memory scopes + provider interface (P0-6).
 * Native project/session wiki remains the default provider.
 */

export interface ScopeContext {
	workspaceRoot?: string;
	sessionId?: string;
	task?: string;
	extras?: Record<string, unknown>;
}

export interface MemoryScope {
	id: string;
	title: string;
	resolveKey(ctx: ScopeContext): string | undefined;
	storagePath(key: string): string;
	injectPolicy: 'always' | 'when-relevant' | 'on-demand';
}

export interface TemporalFactInput {
	key: string;
	value: string;
	reason?: string;
	validFrom?: string;
	validTo?: string;
}

export interface MemoryHit {
	scope: string;
	key: string;
	page?: string;
	title?: string;
	snippet: string;
	score?: number;
}

export interface IMemoryProvider {
	read(scope: string, key: string, page?: string): Promise<string | undefined>;
	write(scope: string, key: string, page: string, content: string): Promise<void>;
	search(query: string, scopes?: string[]): Promise<MemoryHit[]>;
	fact(scope: string, key: string, fact: TemporalFactInput): Promise<void>;
	forget(scope: string, key: string, page?: string): Promise<void>;
}

export interface Disposable {
	dispose(): void;
}

export class MemoryScopeRegistry {
	private readonly scopes = new Map<string, MemoryScope>();

	register(scope: MemoryScope): Disposable {
		const id = scope.id.trim();
		if (!id) throw new Error('MemoryScope.id is required');
		this.scopes.set(id, scope);
		return {
			dispose: () => {
				this.scopes.delete(id);
			},
		};
	}

	list(): MemoryScope[] {
		return [...this.scopes.values()];
	}

	get(id: string): MemoryScope | undefined {
		return this.scopes.get(id);
	}
}

let scopeRegistry: MemoryScopeRegistry | undefined;
let activeProvider: IMemoryProvider | undefined;

export function getMemoryScopeRegistry(): MemoryScopeRegistry {
	if (!scopeRegistry) scopeRegistry = new MemoryScopeRegistry();
	return scopeRegistry;
}

export function setMemoryProvider(provider: IMemoryProvider): void {
	activeProvider = provider;
}

export function getMemoryProvider(): IMemoryProvider {
	if (!activeProvider) {
		throw new Error('Memory provider not initialized');
	}
	return activeProvider;
}

/** Prefer active provider; if unset, return undefined (caller may use wiki directly). */
export function tryGetMemoryProvider(): IMemoryProvider | undefined {
	return activeProvider;
}
