/**
 * Drop local user data from a packaged CodeForge tree and refuse to ship
 * if Git metadata, MCP config, or API keys are still present.
 *
 * Usage:
 *   node scripts/strip-release-secrets.mjs --root path/to/VSCode-win32-x64
 *   node scripts/strip-release-secrets.mjs --root path/to/VSCode-win32-x64 --check
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SECRET_FILE_NAMES = new Set([
	'mcp.json',
	'.mcp.json',
	'.gitconfig',
	'.git-credentials',
	'.netrc',
	'id_rsa',
	'id_ed25519',
	'.env',
	'.env.local',
]);

const TEXT_EXT = new Set([
	'.js',
	'.cjs',
	'.mjs',
	'.json',
	'.txt',
	'.md',
	'.xml',
	'.html',
	'.yml',
	'.yaml',
	'.config',
	'.env',
	'.ps1',
	'.sh',
	'.cmd',
]);

const TOKEN_RE =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;

const PRIVATE_KEY_RE =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{40,}/;

const CREDENTIAL_URL_RE = /https?:\/\/([^/\s:@]+):([^/\s@]{8,})@/gi;

const PLACEHOLDER_RE = /^(user(name)?|password|pass|token|secret|example|changeme|xxx+|your[-_]?token)$/i;

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

export function stripReleaseTree(root) {
	const removed = [];
	const dataDir = path.join(root, 'data');
	if (fs.existsSync(dataDir)) {
		fs.rmSync(dataDir, { recursive: true, force: true });
		removed.push('data');
	}
	removeNamedDirs(root, root, '.git', removed);
	removeNamedDirs(root, root, '.CodeForge', removed);
	removeNamedDirs(root, root, '.codeforge', removed);
	return removed;
}

function removeNamedDirs(root, dir, name, removed) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = path.join(dir, entry.name);
		if (entry.name === name) {
			fs.rmSync(full, { recursive: true, force: true });
			removed.push(rel(root, full));
			continue;
		}
		removeNamedDirs(root, full, name, removed);
	}
}

export function findReleaseSecretHits(root) {
	const hits = [];
	walk(root, root, hits);
	return hits;
}

function walk(root, dir, hits) {
	if (!fs.existsSync(dir)) return;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'locales') continue;
			if (entry.name === '.git' || entry.name === '.CodeForge' || entry.name === '.codeforge') {
				hits.push({ path: rel(root, full), kind: `directory ${entry.name}` });
			}
			walk(root, full, hits);
			continue;
		}
		if (!entry.isFile()) continue;
		const base = entry.name.toLowerCase();
		if (SECRET_FILE_NAMES.has(base) || base.endsWith('.pem') || base.endsWith('.key')) {
			hits.push({ path: rel(root, full), kind: `file ${entry.name}` });
			continue;
		}
		const ext = path.extname(base);
		if (!TEXT_EXT.has(ext) && base !== 'config' && base !== 'credentials') continue;
		let stat;
		try {
			stat = fs.statSync(full);
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCAN_BYTES) continue;
		let text;
		try {
			text = fs.readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		if (TOKEN_RE.test(text)) {
			hits.push({ path: rel(root, full), kind: 'api key or token' });
		} else if (PRIVATE_KEY_RE.test(text)) {
			hits.push({ path: rel(root, full), kind: 'private key' });
		} else if (hasEmbeddedCredentialUrl(text)) {
			hits.push({ path: rel(root, full), kind: 'url with embedded credentials' });
		}
	}
}

function rel(root, full) {
	return path.relative(root, full).replace(/\\/g, '/');
}

function hasEmbeddedCredentialUrl(text) {
	CREDENTIAL_URL_RE.lastIndex = 0;
	let match;
	while ((match = CREDENTIAL_URL_RE.exec(text))) {
		const user = match[1];
		const pass = match[2];
		if (PLACEHOLDER_RE.test(user) || PLACEHOLDER_RE.test(pass)) continue;
		if (/password|username|example|placeholder|your_token/i.test(user + pass)) continue;
		return true;
	}
	return false;
}

function main() {
	const root = argValue('--root');
	const checkOnly = process.argv.includes('--check');
	if (!root) {
		console.error('Usage: node scripts/strip-release-secrets.mjs --root <portable-dir> [--check]');
		process.exit(1);
	}
	const abs = path.resolve(root);
	if (!fs.existsSync(abs)) {
		console.error(`Portable tree not found: ${abs}`);
		process.exit(1);
	}

	if (!checkOnly) {
		const removed = stripReleaseTree(abs);
		if (removed.length) {
			console.log(`Removed before packaging: ${removed.join(', ')}`);
		} else {
			console.log('No portable user-data or .git directories to remove.');
		}
	}

	const hits = findReleaseSecretHits(abs);
	if (hits.length) {
		console.error('Refusing to package. Secrets or local config are still in the tree:');
		for (const hit of hits) {
			console.error(`  - ${hit.kind}: ${hit.path}`);
		}
		process.exit(1);
	}
	console.log(`Release tree is clear of Git metadata, MCP config, and API keys: ${abs}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
