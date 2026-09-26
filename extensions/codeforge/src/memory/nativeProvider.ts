/**
 * Native wiki-backed memory provider (default for P0-6).
 */

import * as path from 'path';
import {
	IMemoryProvider,
	MemoryHit,
	TemporalFactInput,
	getMemoryScopeRegistry,
} from './scopes';
import { getProjectWikiStore, ensureProjectWiki } from './projectWiki';

const PROJECT_SCOPE = 'codeforge.project';
const SESSION_SCOPE = 'codeforge.session';

export function registerNativeMemoryScopes(workspaceRoot?: string): void {
	const reg = getMemoryScopeRegistry();
	if (!reg.get(PROJECT_SCOPE)) {
		reg.register({
			id: PROJECT_SCOPE,
			title: 'Project wiki',
			resolveKey: ctx => ctx.workspaceRoot ?? workspaceRoot ?? 'default',
			storagePath: key => path.join(key, '.CodeForge', 'memory'),
			injectPolicy: 'always',
		});
	}
	if (!reg.get(SESSION_SCOPE)) {
		reg.register({
			id: SESSION_SCOPE,
			title: 'Session wiki',
			resolveKey: ctx => ctx.sessionId ?? 'session',
			storagePath: key => path.join('sessions', key),
			injectPolicy: 'when-relevant',
		});
	}
}

export class NativeWikiMemoryProvider implements IMemoryProvider {
	constructor(private readonly workspaceRoot?: string) {}

	async read(scope: string, key: string, page?: string): Promise<string | undefined> {
		if (scope === PROJECT_SCOPE || scope.startsWith('codeforge.')) {
			if (this.workspaceRoot) {
				await ensureProjectWiki(this.workspaceRoot);
			}
			const wiki = getProjectWikiStore();
			if (!wiki.isReady()) return undefined;
			const id = page ?? key;
			if (!id) {
				return wiki
					.listDocuments()
					.map(d => `- ${d.id}: ${d.title}`)
					.join('\n');
			}
			const doc = wiki.getDocument(id);
			return doc ? `# ${doc.title}\n\n${doc.content}` : undefined;
		}
		return undefined;
	}

	async write(scope: string, key: string, page: string, content: string): Promise<void> {
		if (this.workspaceRoot) {
			await ensureProjectWiki(this.workspaceRoot);
		}
		const wiki = getProjectWikiStore();
		await wiki.upsertDocument(page || key, page || key, content, scope);
	}

	async search(query: string, _scopes?: string[]): Promise<MemoryHit[]> {
		try {
			const wiki = getProjectWikiStore();
			if (!wiki.isReady()) return [];
			return wiki.search(query, 8).map(d => ({
				scope: PROJECT_SCOPE,
				key: d.id,
				page: d.id,
				title: d.title,
				snippet: d.summary || d.content.slice(0, 300),
			}));
		} catch {
			return [];
		}
	}

	async fact(scope: string, _key: string, fact: TemporalFactInput): Promise<void> {
		if (this.workspaceRoot) {
			await ensureProjectWiki(this.workspaceRoot);
		}
		await getProjectWikiStore().addFact(fact.key, fact.value, fact.reason);
	}

	async forget(_scope: string, _key: string, _page?: string): Promise<void> {
		// Project wiki has no delete API yet — no-op to satisfy IMemoryProvider.
	}
}
