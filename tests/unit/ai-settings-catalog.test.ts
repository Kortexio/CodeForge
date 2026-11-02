import {
	resolveSharedCatalog,
	shouldImportProfileCatalogs,
	type AiServer,
	type AiSettingsState,
} from '../../extensions/codeforge/src/settings/aiSettingsStore';

function server(partial: Partial<AiServer> & Pick<AiServer, 'id'>): AiServer {
	return {
		name: partial.name ?? partial.id,
		kind: partial.kind ?? 'openai',
		baseUrl: partial.baseUrl ?? 'https://server.example/v1',
		models: partial.models ?? ['qwen'],
		enabled: partial.enabled ?? true,
		...partial,
	};
}

function state(servers: AiServer[], activeServerId: string | null = servers[0]?.id ?? null): AiSettingsState {
	return {
		servers,
		activeServerId,
		activeModel: 'qwen',
		mcpServers: [],
	};
}

describe('shared AI server catalog', () => {
	it('does not import profile snapshots once the shared file exists', () => {
		const disk = state([server({ id: 'kept', baseUrl: 'http://127.0.0.1:8080/v1', models: [] })]);
		const staleProfile = state([
			server({
				id: 'kept',
				baseUrl: 'https://old.example/v1',
				models: ['qwen', 'ghost-model'],
			}),
			server({ id: 'removed', name: 'Removed', baseUrl: 'https://removed.example/v1' }),
		]);

		expect(shouldImportProfileCatalogs(disk)).toBe(false);
		const resolved = resolveSharedCatalog(disk, [staleProfile]);
		expect(resolved.servers.map(s => s.id)).toEqual(['kept']);
		expect(resolved.servers[0].baseUrl).toBe('http://127.0.0.1:8080/v1');
		expect(resolved.servers[0].models).toEqual([]);
	});

	it('keeps an explicit empty catalog instead of restoring deleted servers', () => {
		const disk = state([]);
		const staleProfile = state([server({ id: 'removed' })]);
		expect(shouldImportProfileCatalogs(disk)).toBe(false);
		expect(resolveSharedCatalog(disk, [staleProfile]).servers).toEqual([]);
	});

	it('imports profile catalogs only when the shared file is missing', () => {
		const profile = state([server({ id: 'from-profile' })]);
		expect(shouldImportProfileCatalogs(undefined)).toBe(true);
		expect(resolveSharedCatalog(undefined, [profile]).servers.map(s => s.id)).toEqual(['from-profile']);
	});
});
