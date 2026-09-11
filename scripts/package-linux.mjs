/**
 * Package CodeForge for Linux via Code-OSS gulp.
 * Usage: node scripts/package-linux.mjs [--skip-setup]
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
	if (process.platform !== 'linux') {
		console.warn('Warning: Linux packaging is intended to run on Linux.');
	}
	if (!fs.existsSync(vscodeDir)) {
		throw new Error('vscode/ missing — run npm run vscode:setup first');
	}

	if (!skipSetup) {
		await run('node', ['scripts/sync-builtin-extension.mjs']);
		await run('node', ['scripts/apply-branding.mjs']);
		await run('node', ['scripts/apply-vscode-patches.mjs']);
	}

	await run('npx', ['gulp', 'vscode-linux-x64'], vscodeDir);

	const dist = path.join(root, 'dist', 'codeforge-linux-x64');
	fs.mkdirSync(dist, { recursive: true });
	console.log('Linux packaging finished. Artifacts under VSCode-linux-x64 /', dist);
	console.log('Optional next steps: build .deb / .rpm / AppImage from the portable folder.');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
