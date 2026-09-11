/**
 * Build CodeForge Windows installer (Inno Setup) from the portable app folder.
 *
 * Prerequisites:
 *   - Portable build at ../VSCode-win32-x64/CodeForge.exe
 *     (npm run vscode:package:win:portable  OR full vscode:package:win)
 *   - Inno Setup 6+ (ISCC.exe) — installs via winget if missing:
 *     winget install JRSoftware.InnoSetup
 *
 * Usage:
 *   node scripts/build-installer-windows.mjs
 *   node scripts/build-installer-windows.mjs --source path/to/VSCode-win32-x64
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const issPath = path.join(root, 'build', 'windows', 'codeforge.iss');
const defaultSource = path.join(path.dirname(path.join(root, 'vscode')), 'VSCode-win32-x64');
// portable sits next to vscode/: CodeForge/VSCode-win32-x64
const portableOut = path.join(root, '..', 'VSCode-win32-x64');
const portableSibling = path.join(root, 'VSCode-win32-x64');
const distDir = path.join(root, 'dist', 'codeforge-win32-x64');

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function findIscc() {
	const candidates = [
		process.env.INNO_SETUP_ISCC,
		path.join(process.env.LocalAppData || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
		path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
		path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
		path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 7', 'ISCC.exe'),
		path.join(process.env.ProgramFiles || '', 'Inno Setup 7', 'ISCC.exe'),
	].filter(Boolean);
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	return null;
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		console.log(`\n> ${cmd} ${args.join(' ')}\n`);
		const child = spawn(cmd, args, {
			cwd: opts.cwd ?? root,
			stdio: 'inherit',
			shell: opts.shell ?? false,
			env: { ...process.env, ...opts.env },
		});
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with ${code}`));
		});
	});
}

async function ensureInnoSetup() {
	let iscc = findIscc();
	if (iscc) return iscc;

	console.log('Inno Setup not found. Installing via winget (JRSoftware.InnoSetup)...');
	try {
		await run(
			'winget',
			[
				'install',
				'-e',
				'--id',
				'JRSoftware.InnoSetup',
				'--accept-package-agreements',
				'--accept-source-agreements',
			],
			{ shell: true }
		);
	} catch (err) {
		console.error(String(err.message || err));
		console.error(`
Install Inno Setup manually, then re-run:
  winget install JRSoftware.InnoSetup
  https://jrsoftware.org/isdl.php
`);
		process.exit(1);
	}

	iscc = findIscc();
	if (!iscc) {
		console.error('Inno Setup installed but ISCC.exe not found on PATH. Restart the shell and retry.');
		process.exit(1);
	}
	return iscc;
}

function resolveSource() {
	const fromArg = argValue('--source');
	const candidates = [fromArg, portableSibling, portableOut, defaultSource].filter(Boolean);
	for (const dir of candidates) {
		const exe = path.join(dir, 'CodeForge.exe');
		if (fs.existsSync(exe)) return path.resolve(dir);
	}
	console.error(`Portable app not found (CodeForge.exe).
Run first:
  npm run vscode:package:win:portable
Expected folder: ${portableSibling}`);
	process.exit(1);
}

const sourceDir = resolveSource();
const iscc = await ensureInnoSetup();
fs.mkdirSync(distDir, { recursive: true });

const icon = path.join(sourceDir, 'resources', 'app', 'resources', 'win32', 'code.ico');
if (!fs.existsSync(icon)) {
	console.warn(`Warning: setup icon missing at ${icon} — Inno may fail; ensure portable build is complete.`);
}

const defines = [
	`/DAppVersion=${pkg.version}`,
	`/DSourceDir=${sourceDir}`,
	`/DOutputDir=${distDir}`,
];

console.log('=== CodeForge Windows installer ===');
console.log(`  Source:  ${sourceDir}`);
console.log(`  Version: ${pkg.version}`);
console.log(`  ISCC:    ${iscc}`);
console.log(`  Output:  ${distDir}`);

await run(iscc, [...defines, issPath]);

const expected = path.join(distDir, `CodeForge-Setup-${pkg.version}-win32-x64.exe`);
if (!fs.existsSync(expected)) {
	const found = fs.readdirSync(distDir).filter((f) => f.endsWith('.exe') && f.includes('Setup'));
	if (!found.length) {
		console.error('Installer EXE not produced.');
		process.exit(1);
	}
	console.log(`\nInstaller: ${path.join(distDir, found[0])}`);
} else {
	const sizeMb = (fs.statSync(expected).size / (1024 * 1024)).toFixed(1);
	console.log(`\n=== Done ===`);
	console.log(`Installer: ${expected} (${sizeMb} MB)`);
}

fs.writeFileSync(
	path.join(distDir, 'DISTRIBUTION.txt'),
	`CodeForge ${pkg.version} — Windows distribution

Primary (recommended):
  CodeForge-Setup-${pkg.version}-win32-x64.exe
  - Per-user install (no admin by default)
  - Start Menu shortcut
  - Optional desktop icon + PATH (codeforge)
  - URL protocol codeforge://
  - Uninstaller via Windows Settings

Also available:
  CodeForge-${pkg.version}-win32-x64.zip  (portable, if packaged)
  Portable folder: VSCode-win32-x64\\CodeForge.exe

Build commands:
  npm run vscode:package:win           # portable + zip + installer
  npm run vscode:package:win:portable  # portable + zip only
  npm run installer:win                # installer from existing portable folder
`,
	'utf8'
);
