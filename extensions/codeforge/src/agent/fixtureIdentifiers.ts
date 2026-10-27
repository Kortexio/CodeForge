/**
 * Extract camelCase / PascalCase / snake_case symbols and multi-segment paths
 * from fixture and task text. Used to keep learned harness notes from naming
 * benchmark-specific identifiers.
 */

import * as fs from 'fs';
import * as path from 'path';

const IDENT_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z]+(?:_[A-Z0-9]+)+\b/g;
const PATH_RE = /(?:^|[\s"'`(])((?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+)/g;

const STOP = new Set([
	'module',
	'exports',
	'require',
	'function',
	'return',
	'const',
	'import',
	'export',
	'class',
	'string',
	'number',
	'boolean',
	'object',
	'undefined',
	'describe',
	'assert',
	'strict',
	'equal',
	'throws',
	'before',
	'after',
	'test',
	'node',
	'path',
	'join',
	'readFileSync',
	'writeFileSync',
	'JSON',
	'Date',
	'Error',
	'Array',
	'Object',
	'Promise',
]);

export function extractIdentifiersFromText(text: string): string[] {
	const out = new Set<string>();
	const src = String(text ?? '');
	for (const m of src.matchAll(IDENT_RE)) {
		const tok = m[0];
		if (tok.length < 4) continue;
		if (STOP.has(tok)) continue;
		const parts = tok.includes('_')
			? tok.split('_').filter(Boolean)
			: tok.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
		if (parts.length < 2) continue;
		out.add(tok);
	}
	for (const m of src.matchAll(PATH_RE)) {
		const p = m[1];
		if (!p || p.split('/').length < 2) continue;
		if (/\.(md|json|js|ts|cs|py)$/i.test(p) || p.includes('/')) out.add(p);
	}
	return [...out].sort((a, b) => a.localeCompare(b));
}

/** Walk files under roots and collect identifiers. Non-files are skipped. */
export function extractIdentifiersFromFiles(filePaths: string[]): string[] {
	const out = new Set<string>();
	for (const fp of filePaths) {
		try {
			if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) continue;
			const text = fs.readFileSync(fp, 'utf8');
			for (const t of extractIdentifiersFromText(text)) out.add(t);
		} catch {
			/* skip unreadable */
		}
	}
	return [...out].sort((a, b) => a.localeCompare(b));
}

/** Recursively list text-like files under a directory. */
export function listTextFiles(root: string, max = 200): string[] {
	const out: string[] = [];
	if (!fs.existsSync(root)) return out;
	const walk = (dir: string) => {
		if (out.length >= max) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= max) return;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === 'node_modules' || e.name === '.git') continue;
				walk(full);
			} else if (e.isFile() && /\.(md|json|js|ts|cs|txt|mjs|cjs)$/i.test(e.name)) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

/** First token from `tokens` that appears in `text` (case-sensitive whole-token / path). */
export function firstMatchingToken(text: string, tokens: string[]): string | undefined {
	const body = String(text ?? '');
	if (!body || !tokens.length) return undefined;
	for (const tok of tokens) {
		if (!tok) continue;
		if (tok.includes('/') || tok.includes('.')) {
			if (body.includes(tok)) return tok;
			continue;
		}
		const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`);
		if (re.test(body)) return tok;
	}
	return undefined;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
