/**
 * Structural tool-call normalization at the model↔harness boundary.
 * Fixed alias tables + schema coercion — not intent sniffing.
 */

export type JsonSchemaLike = {
	type?: string | string[];
	properties?: Record<string, JsonSchemaLike>;
	required?: string[];
};

export type NormalizeToolCallInput = {
	name: string;
	args: Record<string, unknown>;
	activeToolNames: Iterable<string>;
	workspaceRoot?: string;
	toolSchemas?: Record<string, JsonSchemaLike>;
};

export type NormalizeToolCallResult = {
	name: string;
	args: Record<string, unknown>;
	notes: string[];
	error?: string;
	/** Argument keys that carried a leaked XML parameter marker (repaired or refused). */
	leakedArgs?: string[];
};

/** Fold case / `_` / `-` for alias lookup. */
export function foldToolToken(s: string): string {
	return String(s ?? '')
		.trim()
		.toLowerCase()
		.replace(/[-_]+/g, '');
}

const TOOL_NAME_ALIASES: Record<string, string> = {
	readfile: 'read',
	view: 'read',
	cat: 'read',
	strreplace: 'edit',
	strreplaceeditor: 'edit',
	editfile: 'edit',
	replaceinfile: 'edit',
	writefile: 'write',
	createfile: 'write',
	bash: 'shell',
	runterminalcmd: 'shell',
	executecommand: 'shell',
	terminal: 'shell',
	grep: 'search',
	grepsearch: 'search',
	searchfiles: 'search',
	ls: 'list',
	listdir: 'list',
	listfiles: 'list',
};

/** Canonical arg ← aliases (applied only when canonical is missing). */
const ARG_ALIASES: Record<string, string[]> = {
	path: ['file_path', 'filepath', 'file', 'filename', 'target_file'],
	old_string: ['old_str', 'oldText', 'search'],
	new_string: ['new_str', 'newText', 'replace', 'replacement'],
	content: ['contents', 'text', 'file_text', 'code'],
	command: ['cmd', 'script'],
	startLine: ['start_line', 'offset', 'line'],
	limit: ['lines', 'count'],
	patch: ['patchText', 'patch_text'],
};

const PATH_ARG_KEYS = new Set([
	'path',
	'oldPath',
	'newPath',
	'project',
	'solution',
	'reference',
	'output',
]);

function compactSignature(schema: JsonSchemaLike | undefined): string {
	if (!schema?.properties) return '{}';
	const req = new Set(schema.required ?? []);
	const parts = Object.keys(schema.properties).map(k => (req.has(k) ? `${k}*` : k));
	return `{ ${parts.join(', ')} }`;
}

function applyArgAliases(
	args: Record<string, unknown>,
	toolName: string,
	notes: string[],
	schema?: JsonSchemaLike
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	const props = schema?.properties ?? undefined;

	for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
		// Only remap when the tool schema has the canonical name and not the alias
		// (avoids browser_type.text → content, references.line → startLine, etc.).
		if (props) {
			if (!(canonical in props)) continue;
		}
		if (out[canonical] !== undefined && out[canonical] !== null && out[canonical] !== '') {
			continue;
		}
		for (const alias of aliases) {
			if (out[alias] === undefined || out[alias] === null || out[alias] === '') continue;
			if (props && alias in props) continue;
			out[canonical] = out[alias];
			delete out[alias];
			notes.push(`(argument ${alias} read as ${canonical})`);
			break;
		}
	}

	// search: pattern ← regex | query
	if (toolName === 'search') {
		if (
			(out.pattern === undefined || out.pattern === null || out.pattern === '') &&
			out.regex !== undefined &&
			out.regex !== null &&
			out.regex !== ''
		) {
			out.pattern = out.regex;
			delete out.regex;
			notes.push('(argument regex read as pattern)');
		}
		if (
			(out.pattern === undefined || out.pattern === null || out.pattern === '') &&
			out.query !== undefined &&
			out.query !== null &&
			out.query !== ''
		) {
			out.pattern = out.query;
			delete out.query;
			notes.push('(argument query read as pattern)');
		}
	}

	return out;
}

function schemaType(schema: JsonSchemaLike | undefined): string | undefined {
	if (!schema?.type) return undefined;
	return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}

function coerceValue(value: unknown, schema: JsonSchemaLike | undefined): unknown {
	if (value === undefined || value === null || !schema) return value;
	const t = schemaType(schema);
	if (t === 'number' || t === 'integer') {
		if (typeof value === 'number') return value;
		if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
			return Number(value.trim());
		}
	}
	if (t === 'boolean') {
		if (typeof value === 'boolean') return value;
		if (typeof value === 'string') {
			const s = value.trim().toLowerCase();
			if (s === 'true') return true;
			if (s === 'false') return false;
		}
	}
	if ((t === 'object' || t === 'array') && typeof value === 'string') {
		const trimmed = value.trim();
		if (
			(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
			(trimmed.startsWith('[') && trimmed.endsWith(']'))
		) {
			try {
				return JSON.parse(trimmed) as unknown;
			} catch {
				/* keep string */
			}
		}
	}
	return value;
}

function coerceArgsBySchema(
	args: Record<string, unknown>,
	schema: JsonSchemaLike | undefined
): Record<string, unknown> {
	if (!schema?.properties) return args;
	const out: Record<string, unknown> = { ...args };
	for (const [key, propSchema] of Object.entries(schema.properties)) {
		if (out[key] === undefined) continue;
		out[key] = coerceValue(out[key], propSchema);
	}
	return out;
}

/**
 * Qwen XML tool format (`<parameter=k>\nv\n</parameter>`): when the model closes a value with
 * `</k>` instead of `</parameter>`, the server keeps reading and the next parameters end up
 * inside this value. Marker = close tag + `<parameter=name>` with both names known to the schema.
 */
const LEAKED_PARAM_MARKER = /\n?<\/([A-Za-z_][\w-]*)>[ \t]*\r?\n?[ \t]*<parameter=([A-Za-z_][\w-]*)>\r?\n?/;

function stripWrapNewlines(value: string): string {
	return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

type LeakSplit = { head: string; recovered: Array<{ key: string; value: string }> };

function splitLeakedParams(value: string, known: Set<string>): LeakSplit | undefined {
	const first = LEAKED_PARAM_MARKER.exec(value);
	if (!first) return undefined;
	const isKnownClose = (tag: string) => tag === 'parameter' || known.has(tag);
	if (!isKnownClose(first[1]) || !known.has(first[2])) return undefined;

	const head = value.slice(0, first.index);
	const recovered: Array<{ key: string; value: string }> = [];
	let key = first[2];
	let rest = value.slice(first.index + first[0].length);
	for (;;) {
		const next = LEAKED_PARAM_MARKER.exec(rest);
		if (next && isKnownClose(next[1]) && known.has(next[2])) {
			recovered.push({ key, value: rest.slice(0, next.index) });
			key = next[2];
			rest = rest.slice(next.index + next[0].length);
			continue;
		}
		const tail = /\r?\n?<\/([A-Za-z_][\w-]*)>\s*(?:<\/function>\s*)?(?:<\/tool_call>\s*)?$/.exec(rest);
		const body = tail && isKnownClose(tail[1]) ? rest.slice(0, tail.index) : rest;
		recovered.push({ key, value: stripWrapNewlines(body) });
		break;
	}
	return { head, recovered };
}

function repairLeakedParams(
	args: Record<string, unknown>,
	schema: JsonSchemaLike | undefined,
	notes: string[]
): { args: Record<string, unknown>; leaked: string[]; error?: string } {
	const known = new Set(Object.keys(schema?.properties ?? {}));
	if (!known.size) return { args, leaked: [] };
	const out: Record<string, unknown> = { ...args };
	const leaked: string[] = [];
	for (const [key, raw] of Object.entries(args)) {
		if (typeof raw !== 'string' || !known.has(key)) continue;
		const split = splitLeakedParams(raw, known);
		if (!split) continue;
		leaked.push(key);
		const names = split.recovered.map(r => r.key);
		for (const r of split.recovered) {
			if (r.key === key) {
				if (r.value === split.head) continue;
			} else {
				const existing = out[r.key];
				// A separate value equal to this argument's own head is the model echoing the
				// previous parameter; the leaked value is the one it meant.
				if (
					existing === undefined ||
					existing === null ||
					existing === '' ||
					existing === r.value ||
					existing === split.head
				) {
					out[r.key] = r.value;
					continue;
				}
			}
			const conflict =
				r.key === key
					? `and the repeated ${key} inside it has a different value`
					: `and ${r.key} was also sent separately with a different value`;
			return {
				args,
				leaked,
				error:
					`Not run: argument ${key} contains the start of another parameter (<parameter=${r.key}>), ` +
					`${conflict}. ` +
					'Close every parameter value with </parameter> (not a closing tag named after the parameter, such as </old_string>) and call the tool again.',
			};
		}
		out[key] = split.head;
		notes.push(
			`(argument ${key} contained </…><parameter=${names.join('>, <parameter=')}>; ` +
				'split into separate arguments — close every value with </parameter>)'
		);
	}
	return { args: out, leaked };
}

/** Normalize a path-like string for the workspace. */
export function normalizeWorkspacePath(raw: unknown, workspaceRoot?: string): string {
	let s = String(raw ?? '')
		.trim()
		.replace(/^["']+|["']+$/g, '');
	s = s.replace(/\\/g, '/');
	while (s.startsWith('./')) s = s.slice(2);
	if (workspaceRoot) {
		const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
		const rootLower = root.toLowerCase();
		const sLower = s.toLowerCase();
		if (sLower === rootLower || sLower.startsWith(rootLower + '/')) {
			s = s.slice(root.length).replace(/^\//, '');
		}
	}
	return s;
}

function normalizePathArgs(
	args: Record<string, unknown>,
	workspaceRoot: string | undefined,
	notes: string[]
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	for (const key of Object.keys(out)) {
		if (!PATH_ARG_KEYS.has(key)) continue;
		if (typeof out[key] !== 'string') continue;
		const before = out[key];
		const after = normalizeWorkspacePath(before, workspaceRoot);
		if (after !== before) {
			out[key] = after;
			notes.push(`(path ${key} normalized)`);
		} else {
			out[key] = after;
		}
	}
	return out;
}

/**
 * Resolve a model-emitted tool name to an active canonical tool, or leave as-is.
 */
export function resolveToolName(
	rawName: string,
	activeToolNames: Iterable<string>
): { name: string; aliasedFrom?: string } {
	const active = new Set([...activeToolNames]);
	const exact = String(rawName ?? '').trim();
	if (active.has(exact)) return { name: exact };

	const folded = foldToolToken(exact);
	for (const a of active) {
		if (foldToolToken(a) === folded) return { name: a };
	}

	const mapped = TOOL_NAME_ALIASES[folded];
	if (mapped && active.has(mapped)) {
		return { name: mapped, aliasedFrom: exact };
	}
	return { name: exact };
}

export function normalizeToolCall(input: NormalizeToolCallInput): NormalizeToolCallResult {
	const notes: string[] = [];
	const activeList = [...input.activeToolNames].sort();
	const resolved = resolveToolName(input.name, input.activeToolNames);

	if (resolved.aliasedFrom) {
		notes.push(`(called as ${resolved.aliasedFrom}; the tool is ${resolved.name})`);
	}

	if (!activeList.includes(resolved.name) && !new Set(input.activeToolNames).has(resolved.name)) {
		return {
			name: resolved.name,
			args: { ...input.args },
			notes,
			error: `Not run: there is no tool named ${input.name}. Available tools: ${activeList.join(', ') || '(none)'}.`,
		};
	}

	const schema = input.toolSchemas?.[resolved.name];
	let args = applyArgAliases({ ...input.args }, resolved.name, notes, schema);
	const repaired = repairLeakedParams(args, schema, notes);
	const leakedArgs = repaired.leaked.length ? repaired.leaked : undefined;
	if (repaired.error) {
		return { name: resolved.name, args, notes, error: repaired.error, leakedArgs };
	}
	args = repaired.args;
	args = coerceArgsBySchema(args, schema);
	args = normalizePathArgs(args, input.workspaceRoot, notes);

	const required = schema?.required ?? [];
	const missing = required.filter(r => {
		const v = args[r];
		return v === undefined || v === null || v === '';
	});
	if (missing.length) {
		const keys = Object.keys(args).join(', ') || '(none)';
		const first = missing[0];
		return {
			name: resolved.name,
			args,
			notes,
			error: `Not run: ${resolved.name} requires ${first}. Received arguments: ${keys}. Expected: ${compactSignature(schema)}.`,
			leakedArgs,
		};
	}

	return { name: resolved.name, args, notes, leakedArgs };
}
