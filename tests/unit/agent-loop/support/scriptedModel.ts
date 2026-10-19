/**
 * Scripted OpenAI-compatible /chat/completions for agent-loop unit tests.
 * Replaces global.fetch; non-completions URLs return 404.
 */

export type ScriptedToolCall = {
	id?: string;
	name: string;
	arguments: Record<string, unknown> | string;
};

export type ScriptedStepResult = {
	content?: string;
	tool_calls?: ScriptedToolCall[];
	finish_reason?: string;
	prompt_tokens?: number;
	completion_tokens?: number;
};

export type ScriptedRequestBody = {
	model?: string;
	messages?: unknown[];
	tools?: unknown[];
	tool_choice?: unknown;
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	[key: string]: unknown;
};

export type ScriptedStep = (requestBody: ScriptedRequestBody) => ScriptedStepResult;

export type RecordedRequest = {
	url: string;
	body: ScriptedRequestBody;
};

let steps: ScriptedStep[] = [];
let recorded: RecordedRequest[] = [];
let originalFetch: typeof fetch | undefined;
let stepIndex = 0;

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function buildMessage(step: ScriptedStepResult) {
	const tool_calls = (step.tool_calls ?? []).map((tc, i) => ({
		id: tc.id ?? `call_${stepIndex}_${i}`,
		type: 'function' as const,
		function: {
			name: tc.name,
			arguments:
				typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
		},
	}));
	return {
		role: 'assistant',
		content: step.content ?? (tool_calls.length ? '' : ''),
		...(tool_calls.length ? { tool_calls } : {}),
	};
}

async function scriptedFetch(input: string | URL | { url: string }, init?: RequestInit): Promise<Response> {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if (!/\/chat\/completions\/?$/i.test(url.replace(/\?.*$/, ''))) {
		return jsonResponse({ error: 'not found' }, 404);
	}
	let body: ScriptedRequestBody = {};
	try {
		body = JSON.parse(String(init?.body ?? '{}')) as ScriptedRequestBody;
	} catch {
		body = {};
	}
	recorded.push({ url, body });
	let step: ScriptedStepResult;
	if (stepIndex >= steps.length) {
		// Harness may inject oracle / diag / budget wraps after the scripted finale.
		step = {
			content: 'blocked: scripted model exhausted — stopping.',
			finish_reason: 'stop',
		};
	} else {
		step = steps[stepIndex++]!(body);
	}
	const message = buildMessage(step);
	return jsonResponse({
		id: `scripted-${stepIndex}`,
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message,
				finish_reason: step.finish_reason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
			},
		],
		usage: {
			prompt_tokens: step.prompt_tokens ?? 100,
			completion_tokens: step.completion_tokens ?? 50,
			total_tokens: (step.prompt_tokens ?? 100) + (step.completion_tokens ?? 50),
		},
	});
}

export function installScriptedModel(script: ScriptedStep[]): void {
	steps = [...script];
	recorded = [];
	stepIndex = 0;
	if (!originalFetch) {
		originalFetch = globalThis.fetch;
	}
	globalThis.fetch = scriptedFetch as typeof fetch;
}

export function uninstallScriptedModel(): void {
	if (originalFetch) {
		globalThis.fetch = originalFetch;
		originalFetch = undefined;
	}
	steps = [];
	recorded = [];
	stepIndex = 0;
}

export function getRecordedRequests(): RecordedRequest[] {
	return recorded;
}

/** Convenience: fixed reply with optional tool calls. */
export function reply(result: ScriptedStepResult): ScriptedStep {
	return () => result;
}

/** Convenience: one tool call. */
export function callTool(
	name: string,
	args: Record<string, unknown>,
	opts?: { content?: string }
): ScriptedStep {
	return () => ({
		content: opts?.content ?? '',
		tool_calls: [{ name, arguments: args }],
	});
}
