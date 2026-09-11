/**
 * Launch Code-OSS with CodeForge AI extension in development mode
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const extensionPath = path.join(root, 'extensions', 'codeforge');

if (!fs.existsSync(vscodeDir)) {
	console.error('vscode/ not found. Run: npm run vscode:setup');
	process.exit(1);
}

const isWin = process.platform === 'win32';
const script = path.join(vscodeDir, 'scripts', isWin ? 'code.bat' : 'code.sh');

if (!fs.existsSync(script)) {
	console.error(`Launch script not found: ${script}`);
	process.exit(1);
}

// Ensure extension is compiled
const extensionOut = path.join(extensionPath, 'out', 'extension.js');
if (!fs.existsSync(extensionOut)) {
	console.log('Compiling AI extension...');
	const compile = spawn('npm', ['run', 'compile'], {
		cwd: extensionPath,
		stdio: 'inherit',
		shell: true,
	});
	await new Promise((resolve, reject) => {
		compile.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('extension compile failed'))));
	});
}

const args = [
	`--extensionDevelopmentPath=${extensionPath}`,
	'--disable-workspace-trust',
	...process.argv.slice(2),
];

console.log(`Launching CodeForge (Code-OSS + AI extension)...`);
console.log(`  ${script} ${args.join(' ')}`);

const child = spawn(script, args, {
	cwd: vscodeDir,
	stdio: 'inherit',
	shell: true,
	env: {
		...process.env,
		VSCODE_DEV: '1',
	},
});

child.on('exit', (code) => process.exit(code ?? 0));
