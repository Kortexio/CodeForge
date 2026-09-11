/**
 * Package CodeForge for macOS via Code-OSS gulp.
 * Usage: node scripts/package-macos.mjs [--skip-setup]
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const skipSetup = process.argv.includes('--skip-setup');

function run(cmd, args, cwd = root) {
	return new Promise((resolve, reject) => {
		console.log(`> ${cmd} ${args.join(' ')}`);
		const child = spawn(cmd, args, {
			cwd,
			stdio: 'inherit',
			shell: true,
			env: process.env,
		});
		child.on('exit', code => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited ${code}`));
		});
	});
}

async function main() {
	if (process.platform !== 'darwin') {
		console.warn('Warning: macOS packaging is intended to run on macOS (darwin).');
	}
	if (!fs.existsSync(vscodeDir)) {
		throw new Error('vscode/ missing — run npm run vscode:setup first');
	}

	if (!skipSetup) {
		await run('node', ['scripts/sync-builtin-extension.mjs']);
		await run('node', ['scripts/apply-branding.mjs']);
		await run('node', ['scripts/apply-vscode-patches.mjs']);
	}

	await run('npx', ['gulp', 'vscode-darwin-x64'], vscodeDir);
	await run('npx', ['gulp', 'vscode-darwin-arm64'], vscodeDir).catch(err => {
		console.warn('arm64 gulp target failed (optional):', err.message);
	});

	const dist = path.join(root, 'dist', 'codeforge-darwin');
	fs.mkdirSync(dist, { recursive: true });
	console.log('macOS packaging finished. Look for VSCode-darwin-* folders and copy into', dist);
	console.log('Tip: create a .dmg with create-dmg or hdiutil after verifying the .app');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
