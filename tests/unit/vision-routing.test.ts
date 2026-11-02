import type { AiServer, AiSettingsState } from '../../extensions/codeforge/src/settings/aiSettingsStore';
import {
	anyVisionModelAvailable,
	candidateVisionRoutes,
	isServerReachable,
	modelLikelySupportsVision,
	resolveReachableVisionRoute,
	resolveVisionRoute,
	serverSupportsVision,
	visionModelsForServer,
} from '../../extensions/codeforge/src/agent/visionRouting';

function server(partial: Partial<AiServer> & { id: string; models: string[] }): AiServer {
	return {
		id: partial.id,
		name: partial.name ?? partial.id,
		kind: partial.kind ?? 'custom',
		baseUrl: partial.baseUrl ?? 'http://localhost:11435/v1',
		models: partial.models,
		visionModels: partial.visionModels,
		enabled: partial.enabled ?? true,
	};
}

function state(servers: AiServer[], activeServerId: string | null = null): AiSettingsState {
	return { servers, activeServerId, activeModel: null, mcpServers: [] };
}

describe('modelLikelySupportsVision', () => {
	it('recognizes local vision-language model families by name', () => {
		expect(modelLikelySupportsVision('custom', 'qwen3-vl-4b')).toBe(true);
		expect(modelLikelySupportsVision('custom', 'llava-1.6-13b')).toBe(true);
		expect(modelLikelySupportsVision('custom', 'moondream2')).toBe(true);
		expect(modelLikelySupportsVision('custom', 'qwen3.6-35b')).toBe(false);
		expect(modelLikelySupportsVision('custom', 'llama-3.1-8b-instruct')).toBe(false);
	});

	it('treats current-gen cloud chat models as vision-capable, but not text-only variants', () => {
		expect(modelLikelySupportsVision('openai', 'gpt-4o')).toBe(true);
		expect(modelLikelySupportsVision('anthropic', 'claude-3-5-sonnet')).toBe(true);
		expect(modelLikelySupportsVision('google', 'gemini-1.5-pro')).toBe(true);
		expect(modelLikelySupportsVision('openai', 'text-embedding-3-large')).toBe(false);
		expect(modelLikelySupportsVision('openai', 'gpt-3.5-turbo-instruct')).toBe(false);
	});

	it('has no heuristic support for an unknown name', () => {
		expect(modelLikelySupportsVision('custom', 'acme-coder-30b')).toBe(false);
		expect(modelLikelySupportsVision('custom', '')).toBe(false);
	});
});

describe('visionModelsForServer', () => {
	it('prefers measured visionModels over the name heuristic', () => {
		const s = server({
			id: 'a',
			models: ['custom-weird-name', 'other'],
			visionModels: ['custom-weird-name'],
		});
		expect(visionModelsForServer(s)).toEqual(['custom-weird-name']);
	});

	it('drops measured vision ids that are no longer in the model list', () => {
		const s = server({ id: 'a', models: ['llava-7b'], visionModels: ['stale-removed-model'] });
		// Falls back to the name heuristic since the measured list is now empty.
		expect(visionModelsForServer(s)).toEqual(['llava-7b']);
	});

	it('falls back to the name heuristic when nothing was measured', () => {
		const s = server({ id: 'a', models: ['qwen3-vl-4b', 'qwen3.6-35b'] });
		expect(visionModelsForServer(s)).toEqual(['qwen3-vl-4b']);
	});

	it('reports no vision support when neither signal has one', () => {
		const s = server({ id: 'a', models: ['qwen3.6-35b', 'llama-3.1-8b'] });
		expect(serverSupportsVision(s)).toBe(false);
	});
});

describe('resolveVisionRoute', () => {
	it('stays on the active server+model when it already supports vision — no switch', () => {
		const vision = server({ id: 'vision-srv', models: ['qwen3-vl-4b'] });
		const st = state([vision]);
		const route = resolveVisionRoute(st, 'vision-srv', 'qwen3-vl-4b');
		expect(route).toEqual({ serverId: 'vision-srv', model: 'qwen3-vl-4b', sameAsActive: true });
	});

	it('switches to a vision model on a different configured server automatically', () => {
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b'] });
		const vision = server({ id: 'vision-srv', models: ['qwen3-vl-4b'] });
		const st = state([textOnly, vision]);
		const route = resolveVisionRoute(st, 'text-srv', 'qwen3.6-35b');
		expect(route).toEqual({ serverId: 'vision-srv', model: 'qwen3-vl-4b', sameAsActive: false });
	});

	it('prefers another vision-capable model on the SAME server over switching servers', () => {
		const mixed = server({ id: 'mixed-srv', models: ['qwen3.6-35b', 'qwen3-vl-4b'] });
		const otherVision = server({ id: 'other-srv', models: ['llava-7b'] });
		const st = state([mixed, otherVision]);
		const route = resolveVisionRoute(st, 'mixed-srv', 'qwen3.6-35b');
		expect(route).toEqual({ serverId: 'mixed-srv', model: 'qwen3-vl-4b', sameAsActive: false });
	});

	it('returns null when no configured, enabled server has a vision-capable model', () => {
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b', 'llama-3.1-8b'] });
		const st = state([textOnly]);
		expect(resolveVisionRoute(st, 'text-srv', 'qwen3.6-35b')).toBeNull();
	});

	it('ignores a disabled server even if it has a vision model', () => {
		const vision = server({ id: 'vision-srv', models: ['qwen3-vl-4b'], enabled: false });
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b'] });
		const st = state([textOnly, vision]);
		expect(resolveVisionRoute(st, 'text-srv', 'qwen3.6-35b')).toBeNull();
	});
});

describe('candidateVisionRoutes', () => {
	it('orders active model, then other models on the active server, then other servers', () => {
		const mixed = server({ id: 'mixed-srv', models: ['qwen3.6-35b', 'qwen3-vl-4b'] });
		const other = server({ id: 'other-srv', models: ['llava-7b'] });
		const st = state([mixed, other]);
		const candidates = candidateVisionRoutes(st, 'mixed-srv', 'qwen3.6-35b');
		expect(candidates).toEqual([
			{ serverId: 'mixed-srv', model: 'qwen3-vl-4b', sameAsActive: false },
			{ serverId: 'other-srv', model: 'llava-7b', sameAsActive: false },
		]);
	});

	it('is empty when nothing anywhere supports vision', () => {
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b'] });
		expect(candidateVisionRoutes(state([textOnly]), 'text-srv', 'qwen3.6-35b')).toEqual([]);
	});
});

describe('isServerReachable', () => {
	const realFetch = global.fetch;
	afterEach(() => {
		global.fetch = realFetch;
	});

	it('is true when the server answers, even with an error status', async () => {
		global.fetch = jest.fn().mockResolvedValue({ status: 404 }) as unknown as typeof fetch;
		const s = server({ id: 'a', models: ['m'], baseUrl: 'http://127.0.0.1:11435/v1' });
		expect(await isServerReachable(s)).toBe(true);
	});

	it('is false when the request throws (connection refused, timeout, ...)', async () => {
		global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
		const s = server({ id: 'a', models: ['m'], baseUrl: 'http://127.0.0.1:11435/v1' });
		expect(await isServerReachable(s)).toBe(false);
	});

	it('is false with no base URL configured', async () => {
		const s = server({ id: 'a', models: ['m'], baseUrl: '' });
		expect(await isServerReachable(s)).toBe(false);
	});
});

describe('resolveReachableVisionRoute', () => {
	const realFetch = global.fetch;
	afterEach(() => {
		global.fetch = realFetch;
	});

	it('returns the active route without probing it', async () => {
		global.fetch = jest.fn() as unknown as typeof fetch;
		const vision = server({ id: 'vision-srv', models: ['qwen3-vl-4b'] });
		const st = state([vision]);
		const route = await resolveReachableVisionRoute(st, 'vision-srv', 'qwen3-vl-4b');
		expect(route).toEqual({ serverId: 'vision-srv', model: 'qwen3-vl-4b', sameAsActive: true });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('skips a configured vision server that is enabled but not actually running (one-model-at-a-time setup)', async () => {
		global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b'] });
		const vision = server({ id: 'vision-srv', models: ['qwen3-vl-4b'] });
		const st = state([textOnly, vision]);
		const route = await resolveReachableVisionRoute(st, 'text-srv', 'qwen3.6-35b');
		expect(route).toBeNull();
	});

	it('falls through to the next candidate when the first vision server is down', async () => {
		global.fetch = jest.fn().mockImplementation((url: string) => {
			if (String(url).includes('11435')) return Promise.reject(new Error('ECONNREFUSED'));
			return Promise.resolve({ status: 200 });
		}) as unknown as typeof fetch;
		const textOnly = server({ id: 'text-srv', models: ['qwen3.6-35b'] });
		const down = server({ id: 'down-srv', models: ['llava-7b'], baseUrl: 'http://127.0.0.1:11435/v1' });
		const up = server({ id: 'up-srv', models: ['qwen3-vl-4b'], baseUrl: 'http://127.0.0.1:11436/v1' });
		const st = state([textOnly, down, up]);
		const route = await resolveReachableVisionRoute(st, 'text-srv', 'qwen3.6-35b');
		expect(route).toEqual({ serverId: 'up-srv', model: 'qwen3-vl-4b', sameAsActive: false });
	});
});

describe('anyVisionModelAvailable', () => {
	it('is true when any enabled server has a vision-capable model', () => {
		const st = state([server({ id: 'a', models: ['qwen3.6-35b'] }), server({ id: 'b', models: ['qwen3-vl-4b'] })]);
		expect(anyVisionModelAvailable(st)).toBe(true);
	});

	it('is false when no server, anywhere, has one', () => {
		const st = state([server({ id: 'a', models: ['qwen3.6-35b'] }), server({ id: 'b', models: ['llama-3.1-8b'] })]);
		expect(anyVisionModelAvailable(st)).toBe(false);
	});

	it('is false when the only vision server is disabled', () => {
		const st = state([server({ id: 'a', models: ['qwen3-vl-4b'], enabled: false })]);
		expect(anyVisionModelAvailable(st)).toBe(false);
	});
});
