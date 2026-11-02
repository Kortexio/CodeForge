/**
 * Ajv-based validate → repair → revalidate loop for tool-call arguments, modeled on
 * pi-tool-repair's rule set (github.com/monotykamary/pi-tool-repair, MIT). Complements
 * `toolCallNormalizer.ts` (which handles alias resolution and the Qwen leaked-parameter case)
 * rather than duplicating it: this module works directly off Ajv's error list against the
 * tool's *real* JSON Schema (not the small `JsonSchemaLike` shape), so it can repair nested
 * object/array properties too.
 *
 * Rules implemented: `dropNullOrUndefined`, `dropEmptyObjectPlaceholder`,
 * `parseJsonStringifiedArray`/object, `wrapBareStringAsArray`, `wrapRootStringAsObject`,
 * `coerceNumericString`, `recoverMangledToolName`, and anchor-bleed stripping (a leaked
 * regex-anchor `^…$` wrapping a plain string value, seen from Kimi/GLM/MiniMax).
 *
 * Compiled schemas are cached by a hash of the schema JSON (callers pass tool schemas fresh
 * per request; nothing here is persisted across requests).
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

export type JsonSchemaObject = Record<string, unknown>;

export interface SchemaRepairInput {
	toolName: string;
	args: unknown;
	/** JSON Schema for the tool's parameters (the real schema sent to the provider, not a summary). */
	schema: JsonSchemaObject | undefined;
	/** Tool names actually offered this turn, for `recoverMangledToolName`. */
	activeToolNames: ReadonlySet<string>;
}

export interface SchemaRepairResult {
	/** Possibly corrected via `recoverMangledToolName` (fuzzy match against `activeToolNames`). */
	name: string;
	nameRecovered: boolean;
	args: Record<string, unknown>;
	valid: boolean;
	/** Ajv error messages still present after the repair loop, when `valid` is false. */
	errors?: string[];
	/** Which repair rules fired, for telemetry (`FamilyRepairEvent`-adjacent, but schema-level). */
	appliedRules: string[];
	notes: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const compiledCache = new Map<string, ValidateFunction>();

function hashSchema(schema: JsonSchemaObject): string {
	// Schemas are small and compared by content, not identity — a plain JSON string is a
	// sufficient, dependency-free cache key here (no crypto needed for a non-security cache).
	return JSON.stringify(schema);
}

function getValidator(schema: JsonSchemaObject): ValidateFunction {
	const key = hashSchema(schema);
	const cached = compiledCache.get(key);
	if (cached) return cached;
	const compiled = ajv.compile(schema);
	compiledCache.set(key, compiled);
	return compiled;
}

// --- JSON-pointer helpers (Ajv's instancePath is a JSON pointer: "/a/b/0") ---

function pointerSegments(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.slice(1)
		.split('/')
		.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAtPointer(root: unknown, pointer: string): unknown {
	const segs = pointerSegments(pointer);
	let cur: unknown = root;
	for (const s of segs) {
		if (cur == null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[s];
	}
	return cur;
}

function setAtPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
	const segs = pointerSegments(pointer);
	if (!segs.length) return;
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < segs.length - 1; i++) {
		const next = cur[segs[i]];
		if (next == null || typeof next !== 'object') return;
		cur = next as Record<string, unknown>;
	}
	cur[segs[segs.length - 1]] = value;
}

function deleteAtPointer(root: Record<string, unknown>, pointer: string): void {
	const segs = pointerSegments(pointer);
	if (!segs.length) return;
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < segs.length - 1; i++) {
		const next = cur[segs[i]];
		if (next == null || typeof next !== 'object') return;
		cur = next as Record<string, unknown>;
	}
	delete cur[segs[segs.length - 1]];
}

function schemaAtPointer(rootSchema: JsonSchemaObject, pointer: string): JsonSchemaObject | undefined {
	const segs = pointerSegments(pointer);
	let cur: JsonSchemaObject | undefined = rootSchema;
	for (const s of segs) {
		if (!cur) return undefined;
		const props = cur.properties as Record<string, JsonSchemaObject> | undefined;
		if (props && props[s]) {
			cur = props[s];
			continue;
		}
		const items = cur.items as JsonSchemaObject | undefined;
		if (items && /^\d+$/.test(s)) {
			cur = items;
			continue;
		}
		return undefined;
	}
	return cur;
}

function isRequiredAtParent(rootSchema: JsonSchemaObject, pointer: string): boolean {
	const segs = pointerSegments(pointer);
	if (!segs.length) return true;
	const key = segs[segs.length - 1];
	const parentPointer = '/' + segs.slice(0, -1).join('/');
	const parentSchema = segs.length === 1 ? rootSchema : schemaAtPointer(rootSchema, parentPointer);
	const required = (parentSchema?.required as string[] | undefined) ?? [];
	return required.includes(key);
}

function expectedType(err: ErrorObject): string | undefined {
	if (err.keyword !== 'type') return undefined;
	const t = (err.params as { type?: string | string[] }).type;
	return Array.isArray(t) ? t[0] : t;
}

/** Anchor-bleed: a regex anchor pair leaking into a plain string value (Kimi/GLM/MiniMax). */
function stripAnchorBleed(schema: JsonSchemaObject | undefined, value: unknown): unknown {
	if (typeof value !== 'string' || value.length < 2) return value;
	if (!value.startsWith('^') || !value.endsWith('$')) return value;
	const schemaExpectsAnchors = typeof schema?.pattern === 'string' && /[\^$]/.test(schema.pattern);
	if (schemaExpectsAnchors) return value;
	return value.slice(1, -1);
}

function preprocessAnchorBleed(args: unknown, schema: JsonSchemaObject | undefined, applied: Set<string>): unknown {
	if (args == null || typeof args !== 'object') return args;
	if (Array.isArray(args)) {
		const itemSchema = schema?.items as JsonSchemaObject | undefined;
		return args.map((v) => preprocessAnchorBleed(v, itemSchema, applied));
	}
	const props = (schema?.properties as Record<string, JsonSchemaObject> | undefined) ?? {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		const propSchema = props[k];
		if (typeof v === 'string') {
			const stripped = stripAnchorBleed(propSchema, v);
			if (stripped !== v) applied.add('stripAnchorBleed');
			out[k] = stripped;
		} else if (v && typeof v === 'object') {
			out[k] = preprocessAnchorBleed(v, propSchema, applied);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** One repair attempt for a single Ajv error. Returns true if it changed `args` in place. */
function repairOneError(root: Record<string, unknown>, rootSchema: JsonSchemaObject, err: ErrorObject, applied: Set<string>): boolean {
	const pointer = err.instancePath;
	const value = getAtPointer(root, pointer);
	const propSchema = pointer ? schemaAtPointer(rootSchema, pointer) : rootSchema;
	const required = isRequiredAtParent(rootSchema, pointer);

	if (err.keyword === 'required') {
		return false; // can't invent missing data here — that's the normal "missing argument" error
	}

	const want = expectedType(err);
	if (!want) return false;

	// Optional field holding null/undefined with a type mismatch → drop it.
	if (!required && (value === null || value === undefined)) {
		deleteAtPointer(root, pointer);
		applied.add('dropNullOrUndefined');
		return true;
	}

	// Optional field holding an empty-object placeholder where a scalar/array was expected.
	if (!required && want !== 'object' && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
		deleteAtPointer(root, pointer);
		applied.add('dropEmptyObjectPlaceholder');
		return true;
	}

	if (want === 'array' && typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('[')) {
			try {
				setAtPointer(root, pointer, JSON.parse(trimmed));
				applied.add('parseJsonStringifiedArray');
				return true;
			} catch {
				/* fall through to bare-string wrap */
			}
		}
		setAtPointer(root, pointer, [value]);
		applied.add('wrapBareStringAsArray');
		return true;
	}

	if ((want === 'object' || want === 'array') && typeof value === 'string') {
		const trimmed = value.trim();
		try {
			setAtPointer(root, pointer, JSON.parse(trimmed));
			applied.add('parseJsonStringifiedArray');
			return true;
		} catch {
			if (want === 'object' && pointer === '' && propSchema?.properties) {
				const props = Object.keys(propSchema.properties as Record<string, unknown>);
				const requiredProps = (propSchema.required as string[] | undefined) ?? [];
				if (props.length === 1 && requiredProps.length <= 1) {
					root[props[0]] = value;
					applied.add('wrapRootStringAsObject');
					return true;
				}
			}
			return false;
		}
	}

	if ((want === 'number' || want === 'integer') && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
		setAtPointer(root, pointer, Number(value.trim()));
		applied.add('coerceNumericString');
		return true;
	}

	if (want === 'boolean' && typeof value === 'string') {
		const s = value.trim().toLowerCase();
		if (s === 'true' || s === 'false') {
			setAtPointer(root, pointer, s === 'true');
			applied.add('coerceNumericString');
			return true;
		}
	}

	if (want === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
		setAtPointer(root, pointer, String(value));
		applied.add('coerceNumericString');
		return true;
	}

	return false;
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[n];
}

/** Fuzzy-match a mangled tool name against the active list. Only returns a single, unambiguous best match. */
function recoverMangledToolName(name: string, activeToolNames: ReadonlySet<string>): string | undefined {
	if (activeToolNames.has(name)) return undefined; // nothing to recover
	const threshold = Math.max(1, Math.floor(name.length * 0.25));
	let best: string | undefined;
	let bestDist = Infinity;
	let tie = false;
	for (const candidate of activeToolNames) {
		const dist = levenshtein(name, candidate);
		if (dist > threshold) continue;
		if (dist < bestDist) {
			best = candidate;
			bestDist = dist;
			tie = false;
		} else if (dist === bestDist) {
			tie = true;
		}
	}
	return tie ? undefined : best;
}

const MAX_ITERATIONS = 8;

export function repairToolCallAgainstSchema(input: SchemaRepairInput): SchemaRepairResult {
	const notes: string[] = [];
	const appliedRules = new Set<string>();

	let name = input.toolName;
	const recoveredName = recoverMangledToolName(name, input.activeToolNames);
	const nameRecovered = !!recoveredName;
	if (recoveredName) {
		notes.push(`(tool name "${input.toolName}" looked mangled; matched to "${recoveredName}")`);
		name = recoveredName;
	}

	let args: unknown = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? { ...(input.args as Record<string, unknown>) } : input.args;

	if (!input.schema) {
		return {
			name,
			nameRecovered,
			args: (args as Record<string, unknown>) ?? {},
			valid: true,
			appliedRules: [],
			notes,
		};
	}

	args = preprocessAnchorBleed(args, input.schema, appliedRules);
	if (args == null || typeof args !== 'object' || Array.isArray(args)) {
		// A root-level non-object will only be fixable by wrapRootStringAsObject below, driven
		// by Ajv's own "must be object" error — give it a mutable home to repair into.
		args = typeof args === 'string' ? args : {};
	}

	const validate = getValidator(input.schema);
	let current: Record<string, unknown> | string = args as Record<string, unknown> | string;

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		const target = typeof current === 'string' ? ({} as Record<string, unknown>) : current;
		// When `current` is still a bare string at the root, validate the string directly so
		// Ajv reports the root "must be object" error that drives `wrapRootStringAsObject`.
		const toValidate = typeof current === 'string' ? current : current;
		const ok = validate(toValidate);
		if (ok) {
			return { name, nameRecovered, args: typeof current === 'string' ? {} : current, valid: true, appliedRules: [...appliedRules], notes };
		}

		const errors = validate.errors ?? [];
		if (typeof current === 'string') {
			// Try the root string→object wrap directly (no instancePath to key off of).
			const rootErr = errors.find((e) => e.instancePath === '' && e.keyword === 'type');
			if (rootErr) {
				const props = Object.keys((input.schema.properties as Record<string, unknown>) ?? {});
				const required = (input.schema.required as string[] | undefined) ?? [];
				if (props.length === 1 && required.length <= 1) {
					target[props[0]] = current;
					appliedRules.add('wrapRootStringAsObject');
					current = target;
					continue;
				}
			}
			break;
		}

		let changedAny = false;
		for (const err of errors) {
			if (repairOneError(current, input.schema, err, appliedRules)) changedAny = true;
		}
		if (!changedAny) {
			return {
				name,
				nameRecovered,
				args: current,
				valid: false,
				errors: errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()),
				appliedRules: [...appliedRules],
				notes,
			};
		}
	}

	return {
		name,
		nameRecovered,
		args: typeof current === 'string' ? {} : current,
		valid: false,
		errors: ['Gave up after the maximum number of repair passes.'],
		appliedRules: [...appliedRules],
		notes,
	};
}
