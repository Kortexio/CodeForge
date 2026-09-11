/**
 * Build an installable Windows CodeForge product from Code-OSS.
 *
 * Steps:
 * 1. Sync AI extension as built-in
 * 2. Apply branding + patches
 * 3. gulp vscode-win32-x64  → portable app folder
 * 4. Strip Microsoft Copilot (CodeForge ships its own AI)
 * 5. Zip portable app
 * 6. Build Inno Setup installer (primary distribution artifact)
 * 7. Copy artifacts into dist/codeforge-win32-x64/
 *
 * Flags:
 *   --skip-setup   only produce portable folder + zip (no .exe installer)
 *   --setup-only   skip gulp package; only zip/setup (requires prior package)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vscodeDir = path.join(root, 'vscode');
const portableOut = path.join(path.dirname(vscodeDir), 'VSCode-win32-x64');
const setupOut = path.join(vscodeDir, '.build', 'win32-x64', 'user-setup');
const distDir = path.join(root, 'dist', 'codeforge-win32-x64');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const skipSetup = process.argv.includes('--skip-setup');
const setupOnly = process.argv.includes('--setup-only');

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		console.log(`\n> ${cmd} ${args.join(' ')}\n`);
		const child = spawn(cmd, args, {
			cwd: opts.cwd ?? root,
			stdio: 'inherit',
			shell: true,
			env: {
				...process.env,
				...opts.env,
			},
		});
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`));
		});
	});
}

function rmrf(target) {
	if (fs.existsSync(target)) {
		fs.rmSync(target, { recursive: true, force: true });
	}
}

function findExe() {
	const preferred = ['CodeForge.exe', 'OpenCodeIDE.exe', 'Code - OSS.exe'];
	for (const name of preferred) {
		const p = path.join(portableOut, name);
		if (fs.existsSync(p)) return p;
	}
	if (!fs.existsSync(portableOut)) return null;
	const hit = fs.readdirSync(portableOut).find((f) => f.endsWith('.exe') && !f.includes('Updater'));
	return hit ? path.join(portableOut, hit) : null;
}

/** Ensure portable launcher is CodeForge.exe (nameShort), even if an older brand leaked through. */
function ensureCodeForgeExecutable() {
	const targetExe = path.join(portableOut, 'CodeForge.exe');
	const legacyNames = ['OpenCodeIDE.exe', 'Code - OSS.exe'];
	for (const legacy of legacyNames) {
		const from = path.join(portableOut, legacy);
		if (!fs.existsSync(from)) continue;
		if (fs.existsSync(targetExe)) {
			fs.rmSync(from, { force: true });
			console.log(`Removed legacy executable ${legacy}`);
		} else {
			fs.renameSync(from, targetExe);
			console.log(`Renamed ${legacy} → CodeForge.exe`);
		}
	}

	const targetManifest = path.join(portableOut, 'CodeForge.VisualElementsManifest.xml');
	for (const legacy of ['OpenCodeIDE.VisualElementsManifest.xml', 'Code - OSS.VisualElementsManifest.xml']) {
		const from = path.join(portableOut, legacy);
		if (!fs.existsSync(from)) continue;
		if (fs.existsSync(targetManifest)) {
			fs.rmSync(from, { force: true });
		} else {
			fs.renameSync(from, targetManifest);
		}
	}
	if (fs.existsSync(targetManifest)) {
		let xml = fs.readFileSync(targetManifest, 'utf8');
		xml = xml.replace(/ShortDisplayName="[^"]*"/, 'ShortDisplayName="CodeForge"');
		fs.writeFileSync(targetManifest, xml, 'utf8');
	}

	const binDir = path.join(portableOut, 'bin');
	if (fs.existsSync(binDir)) {
		const cmd = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\CodeForge.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
`;
		fs.writeFileSync(path.join(binDir, 'codeforge.cmd'), cmd.replace(/\n/g, '\r\n'), 'utf8');
		// Keep old CLI name as alias so existing scripts keep working.
	}
}

if (!fs.existsSync(vscodeDir)) {
	console.error('vscode/ not found. Run: npm run vscode:setup');
	process.exit(1);
}

console.log('=== CodeForge Windows package ===');

await run('node', ['scripts/sync-builtin-extension.mjs']);
await run('node', ['scripts/apply-branding.mjs']);
await run('node', ['scripts/apply-vscode-patches.mjs']);

if (!setupOnly) {
	try {
		await run('npx', ['gulp', 'vscode-win32-x64'], { cwd: vscodeDir });
	} catch (err) {
		if (!findExe()) throw err;
		console.warn('\n⚠ gulp reported an error, but CodeForge.exe exists — continuing.');
		console.warn(String(err.message || err));
	}
}

const exe = findExe();
if (!exe) {
	console.error(`Portable build missing at ${portableOut}`);
	process.exit(1);
}
ensureCodeForgeExecutable();
const finalExe = findExe();
console.log(`Found executable: ${path.basename(finalExe ?? exe)}`);

// CodeForge uses codeforge — drop Microsoft Copilot to shrink package / avoid path issues
const copilotDir = path.join(portableOut, 'resources', 'app', 'extensions', 'copilot');
if (fs.existsSync(copilotDir)) {
	console.log('Removing built-in Microsoft Copilot extension...');
	rmrf(copilotDir);
}

fs.mkdirSync(distDir, { recursive: true });

const zipName = `CodeForge-${pkg.version}-win32-x64.zip`;
const zipPath = path.join(distDir, zipName);
rmrf(zipPath);
console.log(`\nCreating ${zipName} ...`);
await run('powershell', [
	'-NoProfile',
	'-Command',
	`Compress-Archive -Path '${portableOut}\\*' -DestinationPath '${zipPath}' -Force`,
]);

fs.writeFileSync(
	path.join(distDir, 'README.txt'),
	`CodeForge ${pkg.version} (Windows x64)

DISTRIBUTION (recommended):
  CodeForge-Setup-${pkg.version}-win32-x64.exe
  Run the installer for Start Menu, optional PATH, and uninstaller.

Portable folder:
  ${portableOut}
  Run: CodeForge.exe

ZIP:
  ${zipPath}
  Extract anywhere and run CodeForge.exe

AI:
  Activity bar → AI
  Command Palette → "CodeForge AI: Settings"
`,
	'utf8'
);

let installerPath = null;
if (!skipSetup) {
	try {
		// Primary: CodeForge Inno script over the portable folder (reliable branding).
		await run('node', ['scripts/build-installer-windows.mjs', '--source', portableOut]);
		const expected = path.join(distDir, `CodeForge-Setup-${pkg.version}-win32-x64.exe`);
		if (fs.existsSync(expected)) {
			installerPath = expected;
		} else {
			const setups = fs
				.readdirSync(distDir)
				.filter((f) => f.endsWith('.exe') && /setup/i.test(f));
			if (setups[0]) installerPath = path.join(distDir, setups[0]);
		}
	} catch (err) {
		console.warn('\n⚠ CodeForge Inno installer failed — trying upstream gulp user-setup…');
		console.warn(String(err.message || err));
		try {
			await run('npx', ['gulp', 'vscode-win32-x64-inno-updater'], { cwd: vscodeDir });
			await run('npx', ['gulp', 'vscode-win32-x64-user-setup'], { cwd: vscodeDir });
			if (fs.existsSync(setupOut)) {
				const setups = fs.readdirSync(setupOut).filter((f) => f.endsWith('.exe'));
				for (const file of setups) {
					const from = path.join(setupOut, file);
					const to = path.join(distDir, file);
					fs.copyFileSync(from, to);
					installerPath = to;
					console.log(`Installer copied → ${to}`);
				}
			}
		} catch (err2) {
			console.warn('\n⚠ User-setup also failed — ship the ZIP / portable folder.');
			console.warn(String(err2.message || err2));
		}
	}
}

console.log('\n=== Done ===');
console.log(`Portable:  ${portableOut}`);
console.log(`ZIP:       ${zipPath}`);
if (installerPath) console.log(`Installer: ${installerPath}`);
else console.log(`Artifacts: ${distDir}`);
if (!installerPath && !skipSetup) {
	console.log(`
To build the installer later (Inno Setup required):
  winget install JRSoftware.InnoSetup
  npm run installer:win
`);
	process.exitCode = 1;
}