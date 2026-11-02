/**
 * Publishes every configured CodeForge server/model as a `vscode.lm` chat model
 * (vendor `codeforge`). The Agents window lists these models in its pickers and
 * attaches the selected one to each chat request; the `codeforge.agent`
 * participant still runs the full harness. Direct `sendRequest` calls on these
 * models go to the configured server (OpenAI-compatible chat completions, or
 * the native Anthropic Messages API), including tool calls.
 */

import * as vscode from 'vscode';
import type { AiServer, AiSettingsStore } from '../settings/aiSettingsStore';
import { CODEFORGE_LM_VENDOR, modelIdFor, parseModelId } from './agentsBridge';

const DEFAULT_MAX_INPUT_TOKENS = 32768;
const MAX_OUTPUT_TOKENS = 4096;
/** `vscode.LanguageModelChatMessageRole.System` is proposed API; its runtime value is 3. */
const SYSTEM_ROLE = 3;

type StoreView = Pick<AiSettingsStore, 'getState' | 'onDidChange'>;
type Emit = (part: vscode.LanguageModelResponsePart) => void;

export interface OpenAiToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface OpenAiMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: OpenAiToolCall[];
	tool_call_id?: string;
}

type AnthropicBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: object }
	| { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: AnthropicBlock[];
}

export interface ChatRequestShape {
	tools?: readonly vscode.LanguageModelChatTool[];
	toolMode?: vscode.LanguageModelChatToolMode;
}

export function modelInformation(store: Pick<AiSettingsStore, 'getState'>): vscode.LanguageModelChatInformation[] {
	const infos: vscode.LanguageModelChatInformation[] = [];
	for (const server of store.getState().servers) {
		if (server.enabled === false) continue;
		for (const model of server.models) {
			infos.push({
				id: modelIdFor(server.id, model),
				name: model,
				family: server.kind,
				detail: server.name,
				tooltip: `${server.name} · ${model}`,
				version: '1',
				maxInputTokens: server.numCtx && server.numCtx > 0 ? server.numCtx : DEFAULT_MAX_INPUT_TOKENS,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				capabilities: { toolCalling: true, imageInput: false },
			});
		}
	}
	return infos;
}

function textOf(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) return part.value;
	if (part instanceof vscode.LanguageModelToolResultPart) return part.content.map(textOf).filter(Boolean).join('\n');
	return '';
}

interface SplitMessage {
	role: 'system' | 'user' | 'assistant';
	text: string;
	calls: vscode.LanguageModelToolCallPart[];
	results: vscode.LanguageModelToolResultPart[];
}

function split(message: vscode.LanguageModelChatRequestMessage): SplitMessage {
	const role =
		message.role === vscode.LanguageModelChatMessageRole.Assistant
			? 'assistant'
			: (message.role as number) === SYSTEM_ROLE
				? 'system'
				: 'user';
	const texts: string[] = [];
	const calls: vscode.LanguageModelToolCallPart[] = [];
	const results: vscode.LanguageModelToolResultPart[] = [];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
		else if (part instanceof vscode.LanguageModelToolResultPart) results.push(part);
		else {
			const text = textOf(part);
			if (text) texts.push(text);
		}
	}
	return { role, text: texts.join('\n'), calls, results };
}

export function toOpenAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
	const out: OpenAiMessage[] = [];
	for (const message of messages) {
		const { role, text, calls, results } = split(message);
		for (const result of results) {
			out.push({ role: 'tool', tool_call_id: result.callId, content: textOf(result) });
		}
		if (role === 'assistant') {
			if (!text && !calls.length) continue;
			out.push({
				role: 'assistant',
				content: text || null,
				...(calls.length
					? {
							tool_calls: calls.map(c => ({
								id: c.callId,
								type: 'function' as const,
								function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
							})),
						}
					: {}),
			});
		} else if (text) {
			out.push({ role, content: text });
		}
	}
	return out;
}

export function toAnthropicRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
	system: string;
	messages: AnthropicMessage[];
} {
	const system: string[] = [];
	const out: AnthropicMessage[] = [];
	for (const message of messages) {
		const { role, text, calls, results } = split(message);
		if (role === 'system') {
			if (text) system.push(text);
			continue;
		}
		const blocks: AnthropicBlock[] = [
			...results.map(r => ({ type: 'tool_result' as const, tool_use_id: r.callId, content: textOf(r) })),
			...(text ? [{ type: 'text' as const, text }] : []),
			...calls.map(c => ({ type: 'tool_use' as const, id: c.callId, name: c.name, input: c.input ?? {} })),
		];
		if (!blocks.length) continue;
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	}
	return { system: system.join('\n\n'), messages: out };
}

function parseArguments(name: string, raw: string): object {
	if (!raw.trim()) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === 'object') return value;
	} catch {
		// fall through
	}
	throw new Error(`Model returned invalid JSON arguments for tool "${name}": ${raw.slice(0, 200)}`);
}

interface PendingCall {
	id: string;
	name: string;
	args: string;
}

/** Reads an OpenAI-compatible SSE body, emitting text deltas and the completed tool calls. */
export async function readOpenAiStream(body: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const pending = new Map<number, PendingCall>();
	let buffer = '';
	let done = false;
	while (!done) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') {
				done = true;
				break;
			}
			let data: {
				choices?: Array<{
					delta?: {
						content?: string;
						tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
					};
				}>;
			};
			try {
				data = JSON.parse(payload);
			} catch {
				continue;
			}
			const delta = data.choices?.[0]?.delta;
			if (delta?.content) emit(new vscode.LanguageModelTextPart(delta.content));
			for (const call of delta?.tool_calls ?? []) {
				const index = call.index ?? 0;
				const entry = pending.get(index) ?? { id: '', name: '', args: '' };
				if (call.id) entry.id = call.id;
				if (call.function?.name) entry.name += call.function.name;
				if (call.function?.arguments) entry.args += call.function.arguments;
				pending.set(index, entry);
			}
		}
	}
	for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
		if (!call.name) continue;
		emit(new vscode.LanguageModelToolCallPart(call.id || `call_${index}`, call.name, parseArguments(call.name, call.args)));
	}
}

function baseUrlOf(server: AiServer): string {
	return server.baseUrl.trim().replace(/\/$/, '');
}

function usesNativeAnthropic(server: AiServer): boolean {
	if (server.kind !== 'anthropic') return false;
	const base = server.baseUrl.toLowerCase();
	return !(base.includes('openrouter') || base.includes('/openai') || base.includes('compatible'));
}

function isRequired(mode: vscode.LanguageModelChatToolMode | undefined): boolean {
	return mode === vscode.LanguageModelChatToolMode.Required;
}

export async function sendChat(
	server: AiServer,
	model: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	request: ChatRequestShape,
	emit: Emit,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	const tools = request.tools ?? [];

	if (usesNativeAnthropic(server)) {
		const { system, messages: anthropicMessages } = toAnthropicRequest(messages);
		const res = await fetchImpl(`${baseUrlOf(server) || 'https://api.anthropic.com/v1'}/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': server.apiKey ?? '',
				'anthropic-version': '2023-06-01',
			},
			signal,
			body: JSON.stringify({
				model,
				max_tokens: MAX_OUTPUT_TOKENS,
				...(system ? { system } : {}),
				messages: anthropicMessages,
				...(tools.length
					? {
							tools: tools.map(t => ({
								name: t.name,
								description: t.description,
								input_schema: t.inputSchema ?? { type: 'object', properties: {} },
							})),
							tool_choice: { type: isRequired(request.toolMode) ? 'any' : 'auto' },
						}
					: {}),
			}),
		});
		if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as {
			content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: object }>;
		};
		for (const block of data.content ?? []) {
			if (block.type === 'text' && block.text) emit(new vscode.LanguageModelTextPart(block.text));
			if (block.type === 'tool_use' && block.id && block.name) {
				emit(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input ?? {}));
			}
		}
		return;
	}

	const base = baseUrlOf(server);
	if (!base) throw new Error(`Server "${server.name}" has no base URL`);
	const res = await fetchImpl(`${base}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
			...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
		},
		signal,
		body: JSON.stringify({
			model,
			messages: toOpenAiMessages(messages),
			stream: true,
			max_tokens: MAX_OUTPUT_TOKENS,
			...(tools.length
				? {
						tools: tools.map(t => ({
							type: 'function',
							function: {
								name: t.name,
								description: t.description,
								parameters: t.inputSchema ?? { type: 'object', properties: {} },
							},
						})),
						tool_choice: isRequired(request.toolMode) ? 'required' : 'auto',
					}
				: {}),
		}),
	});
	if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
	const ctype = (res.headers.get('content-type') || '').toLowerCase();
	if (res.body && !ctype.includes('json')) {
		await readOpenAiStream(res.body as ReadableStream<Uint8Array>, emit);
		return;
	}
	const data = (await res.json()) as {
		choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
	};
	const message = data.choices?.[0]?.message;
	if (message?.content) emit(new vscode.LanguageModelTextPart(message.content));
	for (const call of message?.tool_calls ?? []) {
		emit(new vscode.LanguageModelToolCallPart(call.id, call.function.name, parseArguments(call.function.name, call.function.arguments)));
	}
}

export function createLanguageModelProvider(store: StoreView, fetchImpl: typeof fetch = fetch): vscode.LanguageModelChatProvider {
	const changed = new vscode.EventEmitter<void>();
	store.onDidChange(() => changed.fire());
	return {
		onDidChangeLanguageModelChatInformation: changed.event,
		provideLanguageModelChatInformation: () => modelInformation(store),
		async provideLanguageModelChatResponse(model, messages, options, progress, token) {
			const parsed = parseModelId(model.id);
			const server = parsed && store.getState().servers.find(s => s.id === parsed.serverId);
			if (!parsed || !server || !server.models.includes(parsed.model)) {
				throw new Error(`Unknown CodeForge model: ${model.id}`);
			}
			const controller = new AbortController();
			const sub = token.onCancellationRequested(() => controller.abort());
			try {
				await sendChat(server, parsed.model, messages, options, part => progress.report(part), controller.signal, fetchImpl);
			} finally {
				sub.dispose();
			}
		},
		async provideTokenCount(_model, text) {
			const raw = typeof text === 'string' ? text : text.content.map(textOf).join('\n');
			return Math.ceil(raw.length / 4);
		},
	};
}

export function registerLanguageModelProvider(context: vscode.ExtensionContext, store: StoreView): void {
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(CODEFORGE_LM_VENDOR, createLanguageModelProvider(store))
	);
}
