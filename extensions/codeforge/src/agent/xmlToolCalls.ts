/**
 * Lift Qwen/Hermes-style XML tool markup into OpenAI tool_calls.
 * Structural protocol recovery — not intent sniffing on user chat.
 */

export type LiftedToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

function coerceParamValue(raw: string): unknown {
	const v = raw.replace(/^\s+|\s+$/g, '');
	if (!v) return '';
	if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if (
		(v.startsWith('{') && v.endsWith('}')) ||
		(v.startsWith('[') && v.endsWith(']')) ||
		(v.startsWith('"') && v.endsWith('"'))
	) {
		try {
			return JSON.parse(v) as unknown;
		} catch {
			/* keep string */
		}
	}
	return v;
}

function toolCall(name: string, args: Record<string, unknown>, index: number): LiftedToolCall {
	return {
		id: `xml_${index}`,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	};
}

function parseFunctionBlocks(body: string, startIndex: number): LiftedToolCall[] {
	const out: LiftedToolCall[] = [];
	const fnRe =
		/<function\s*=\s*([A-Za-z0-9_]+)\s*>([\s\S]*?)(?:<\/function>|(?=<function\s*=)|$)/gi;
	let m: RegExpExecArray | null;
	let i = startIndex;
	while ((m = fnRe.exec(body))) {
		const name = m[1];
		const inner = m[2] ?? '';
		const args: Record<string, unknown> = {};
		const paramRe =
			/<parameter\s*=\s*([A-Za-z0-9_]+)\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter\s*=)|$)/gi;
		let pm: RegExpExecArray | null;
		while ((pm = paramRe.exec(inner))) {
			args[pm[1]] = coerceParamValue(pm[2] ?? '');
		}
		// Alternate: <parameter name="x">...</parameter>
		const namedRe =
			/<parameter\s+name\s*=\s*["']([A-Za-z0-9_]+)["']\s*>([\s\S]*?)<\/parameter>/gi;
		while ((pm = namedRe.exec(inner))) {
			args[pm[1]] = coerceParamValue(pm[2] ?? '');
		}
		out.push(toolCall(name, args, i++));
	}
	return out;
}

function tryJsonToolCall(body: string, index: number): LiftedToolCall | null {
	const trimmed = body.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const obj = JSON.parse(trimmed) as Record<string, unknown>;
		const fn = obj.function as Record<string, unknown> | undefined;
		if (fn && typeof fn.name === 'string') {
			const args = fn.arguments;
			const argsObj =
				typeof args === 'string'
					? (JSON.parse(args) as Record<string, unknown>)
					: ((args as Record<string, unknown>) ?? {});
			return toolCall(fn.name, argsObj, index);
		}
		if (typeof obj.name === 'string') {
			const args = (obj.arguments ?? obj.args ?? {}) as Record<string, unknown>;
			return toolCall(obj.name, typeof args === 'object' && args ? args : {}, index);
		}
	} catch {
		return null;
	}
	return null;
}

/** True when content looks like XML tool markup (Qwen/Hermes). */
export function looksLikeXmlToolMarkup(text: string): boolean {
	return /<tool_call\b/i.test(text) || /<function\s*=/i.test(text) || /<parameter\s*=/i.test(text);
}

/**
 * Parse `<tool_call>…</tool_call>` / `<function=name><parameter=k>v</parameter>` into tool_calls.
 */
export function parseXmlToolCalls(text: string): LiftedToolCall[] {
	if (!text || !looksLikeXmlToolMarkup(text)) return [];

	const blocks: string[] = [];
	const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(text))) {
		blocks.push(m[1] ?? '');
	}
	// Unclosed trailing <tool_call> (model cut off)
	if (!blocks.length) {
		const open = /<tool_call\b[^>]*>([\s\S]*)$/i.exec(text);
		if (open) blocks.push(open[1] ?? '');
	}
	if (!blocks.length && /<function\s*=/i.test(text)) {
		blocks.push(text);
	}

	const out: LiftedToolCall[] = [];
	for (const body of blocks) {
		const asJson = tryJsonToolCall(body, out.length);
		if (asJson) {
			out.push(asJson);
			continue;
		}
		out.push(...parseFunctionBlocks(body, out.length));
	}
	return out.filter(c => !!c.function.name);
}
