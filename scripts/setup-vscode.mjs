/**
 * Setup Code-OSS for CodeForge development
 *
 * - Clones microsoft/vscode into ./vscode (if missing)
 * - Applies CodeForge branding
 * - Installs vscode dependencies (npm)
 *
 * Usage: node scripts/setup-vscode.mjs [--skip-install]
 *
 * Env:
 *   VSCODE_REF  Branch, tag, or full commit SHA (default: pinned npm-era SHA).
 *               Upstream `main` is pnpm-only; CodeForge packaging still uses npm.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const skipInstall = process.argv.includes('--skip-install');
/** Last known microsoft/vscode tip that still installs with npm (pre pnpm-lock migration). */
const DEFAULT_VSCODE_REF = '3d7cfab6d77dce362755ac573a7a350e8f64528f';
const vscodeRef = (process.env.VSCODE_REF || DEFAULT_VSCODE_REF).trim() || DEFAULT_VSCODE_REF;
const vscodeRepo = 'https://github.com/microsoft/vscode.git';

function run(cmd, args, cwd) {
	console.log(`\n> ${cmd} ${args.join(' ')}`);
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function isCommitSha(ref) {
	return /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * Upstream `main` no longer ships vscode/.npmrc. Without legacy-peer-deps, npm 10+
 * can still fail peer resolution on unrelated packages. CodeForge also strips
 * Copilot/Anthropic/Codex deps in apply-vscode-patches before install.
 */
function ensureLegacyPeerDeps() {
	const npmrcPath = path.join(vscodeDir, '.npmrc');
	const flag = 'legacy-peer-deps=true';
	if (!fs.existsSync(npmrcPath)) {
		fs.writeFileSync(npmrcPath, `${flag}\n`, 'utf8');
		console.log('Wrote vscode/.npmrc with legacy-peer-deps=true');
		return;
	}
	const cur = fs.readFileSync(npmrcPath, 'utf8');
	if (/^\s*legacy-peer-deps\s*=\s*true\s*$/m.test(cur)) {
		return;
	}
	const next = cur.endsWith('\n') ? `${cur}${flag}\n` : `${cur}\n${flag}\n`;
	fs.writeFileSync(npmrcPath, next, 'utf8');
	console.log('Appended legacy-peer-deps=true to vscode/.npmrc');
}

function cloneVscode() {
	console.log(`Cloning Code-OSS (microsoft/vscode @ ${vscodeRef}, shallow)...`);
	if (isCommitSha(vscodeRef)) {
		fs.mkdirSync(vscodeDir, { recursive: true });
		run('git', ['init'], vscodeDir);
		run('git', ['remote', 'add', 'origin', vscodeRepo], vscodeDir);
		run('git', ['fetch', '--depth', '1', 'origin', vscodeRef], vscodeDir);
		run('git', ['checkout', '--force', 'FETCH_HEAD'], vscodeDir);
		return;
	}
	run('git', ['clone', '--depth', '1', '--branch', vscodeRef, vscodeRepo, 'vscode'], root);
}

if (!fs.existsSync(vscodeDir)) {
	cloneVscode();
} else {
	console.log('vscode/ already exists — skipping clone');
}

ensureLegacyPeerDeps();

run('node', [path.join('scripts', 'apply-branding.mjs')], root);
run('node', [path.join('scripts', 'apply-vscode-patches.mjs')], root);
run('node', [path.join('scripts', 'sync-builtin-extension.mjs')], root);

if (!skipInstall) {
	console.log('\nInstalling Code-OSS dependencies (this can take 10–20 minutes)...');
	console.log('Requires: Node matching vscode/.nvmrc, VS C++ tools + Spectre libs');
	// Explicit flag in case .npmrc is ignored by a future npm default change.
	run('npm', ['install', '--legacy-peer-deps'], vscodeDir);
} else {
	console.log('\nSkipped npm install (--skip-install)');
}

console.log('\nSetup complete.');
console.log('Next:');
console.log('  npm run vscode:compile      # compile Code-OSS');
console.log('  npm run vscode:dev          # launch with AI extension (dev)');
console.log('  npm run vscode:package:win  # build installable Windows product');
