/**
 * Provider embeddings (OpenAI-compatible /embeddings).
 */

import { AiSettingsStore } from '../settings/aiSettingsStore';

let settingsStore: AiSettingsStore | undefined;

export function setEmbeddingsSettingsStore(store: AiSettingsStore): void {
	settingsStore = store;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
	if (!texts.length) return [];
	const cfg = resolveEndpoint();
	if (!cfg) return texts.map(() => []);

	const res = await fetch(`${cfg.base}/embeddings`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: cfg.model,
			input: texts,
		}),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => '');
		throw new Error(`embeddings failed: ${res.status} ${err.slice(0, 200)}`);
	}
	const json = (await res.json()) as {
		data?: Array<{ embedding: number[]; index: number }>;
	};
	const data = json.data ?? [];
	const ordered = [...data].sort((a, b) => a.index - b.index);
	return texts.map((_, i) => ordered[i]?.embedding ?? []);
}

function resolveEndpoint(): { base: string; apiKey: string; model: string } | null {
	const state = settingsStore?.getState();
	const active = state?.servers?.find(s => s.id === state.activeServerId) ?? state?.servers?.[0];
	if (active) {
		const base = (active.baseUrl || defaultBase(active.kind)).replace(/\/$/, '');
		const model = active.embeddingModel || guessEmbeddingModel(active.kind);
		return { base, apiKey: active.apiKey || '', model };
	}
	// Fallback to VS Code config without importing vscode at module top for tests
	try {
		const vscode = require('vscode') as typeof import('vscode');
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		const provider = cfg.get<string>('provider') || 'openai';
		const apiKey = cfg.get<string>('apiKey') || '';
		const baseUrl = cfg.get<string>('baseUrl') || defaultBase(provider);
		return {
			base: baseUrl.replace(/\/$/, ''),
			apiKey,
			model: guessEmbeddingModel(provider),
		};
	} catch {
		return null;
	}
}

function defaultBase(provider: string): string {
	switch (provider) {
		case 'anthropic':
			return 'https://api.anthropic.com/v1';
		case 'ollama':
			return 'http://127.0.0.1:11434/v1';
		case 'lmstudio':
			return 'http://127.0.0.1:1234/v1';
		case 'openrouter':
			return 'https://openrouter.ai/api/v1';
		default:
			return 'https://api.openai.com/v1';
	}
}

function guessEmbeddingModel(provider: string): string {
	if (provider === 'ollama') return 'nomic-embed-text';
	return 'text-embedding-3-small';
}
