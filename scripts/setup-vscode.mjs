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
 *   VSCODE_REF  Branch or tag to clone (default: main). Example: main, release/1.105
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const skipInstall = process.argv.includes('--skip-install');
const vscodeRef = (process.env.VSCODE_REF || 'main').trim() || 'main';

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

/**
 * Upstream `main` no longer ships vscode/.npmrc. Without legacy-peer-deps, npm 10+
 * fails ERESOLVE on `@anthropic-ai/sdk` vs `@anthropic-ai/claude-agent-sdk` peers
 * (Release CI failure on v0.3.0).
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

if (!fs.existsSync(vscodeDir)) {
	console.log(`Cloning Code-OSS (microsoft/vscode @ ${vscodeRef}, shallow)...`);
	run(
		'git',
		['clone', '--depth', '1', '--branch', vscodeRef, 'https://github.com/microsoft/vscode.git', 'vscode'],
		root,
	);
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
