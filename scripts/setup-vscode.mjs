/**
 * Setup Code-OSS for OpenCodeIDE development
 *
 * - Clones microsoft/vscode into ./vscode (if missing)
 * - Applies OpenCodeIDE branding
 * - Installs vscode dependencies (npm)
 *
 * Usage: node scripts/setup-vscode.mjs [--skip-install]
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const skipInstall = process.argv.includes('--skip-install');

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

if (!fs.existsSync(vscodeDir)) {
	console.log('Cloning Code-OSS (microsoft/vscode, shallow)...');
	run('git', ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/microsoft/vscode.git', 'vscode'], root);
} else {
	console.log('vscode/ already exists — skipping clone');
}

run('node', [path.join('scripts', 'apply-branding.mjs')], root);
run('node', [path.join('scripts', 'apply-vscode-patches.mjs')], root);

if (!skipInstall) {
	console.log('\nInstalling Code-OSS dependencies (this can take 10–20 minutes)...');
	console.log('Requires: Node matching vscode/.nvmrc, VS C++ tools + Spectre libs');
	run('npm', ['install'], vscodeDir);
} else {
	console.log('\nSkipped npm install (--skip-install)');
}

console.log('\nSetup complete.');
console.log('Next:');
console.log('  npm run vscode:compile   # compile Code-OSS');
console.log('  npm run vscode:dev       # launch with AI extension');
