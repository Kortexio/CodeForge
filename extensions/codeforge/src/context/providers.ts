/**
 * Extension context providers for the context engine (P0-8).
 */

export interface ContextChunk {
	id?: string;
	title?: string;
	content: string;
	tokensEstimate?: number;
}

export interface ContextProvider {
	id: string;
	priority: number;
	budgetShare?: number;
	provide(req: { task: string; openFiles: string[] }): Promise<ContextChunk[]>;
}

export interface Disposable {
	dispose(): void;
}

export class ContextProviderRegistry {
	private readonly providers = new Map<string, ContextProvider>();

	register(provider: ContextProvider): Disposable {
		const id = provider.id.trim();
		if (!id) throw new Error('ContextProvider.id is required');
		this.providers.set(id, provider);
		return {
			dispose: () => {
				this.providers.delete(id);
			},
		};
	}

	list(): ContextProvider[] {
		return [...this.providers.values()].sort((a, b) => b.priority - a.priority);
	}

	async collect(req: { task: string; openFiles: string[] }): Promise<ContextChunk[]> {
		const chunks: ContextChunk[] = [];
		for (const p of this.list()) {
			try {
				const part = await p.provide(req);
				chunks.push(...part);
			} catch {
				/* skip failing providers */
			}
		}
		return chunks;
	}
}

let shared: ContextProviderRegistry | undefined;

export function getContextProviderRegistry(): ContextProviderRegistry {
	if (!shared) shared = new ContextProviderRegistry();
	return shared;
}
