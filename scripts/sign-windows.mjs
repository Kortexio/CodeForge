/**
 * Authenticode signing for Windows CodeForge artifacts.
 *
 * Env:
 *   CODEFORGE_SIGN_PFX       — path to .pfx OR base64-encoded PFX bytes
 *   CODEFORGE_SIGN_PASSWORD  — PFX password (may be empty for some certs)
 *   CODEFORGE_SIGN_REQUIRED  — if "1"/"true", missing cert or signtool failure exits 1
 *   CODEFORGE_SIGN_TIMESTAMP — optional RFC3161 URL (default DigiCert)
 *
 * Usage:
 *   node scripts/sign-windows.mjs <file.exe> [more.exe...]
 *   node scripts/sign-windows.mjs --dir dist/codeforge-win32-x64
 *
 * Without cert env: writes UNSIGNED.txt next to each target (or --dir) and exits 0
 * unless CODEFORGE_SIGN_REQUIRED is set.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const REQUIRED =
	process.env.CODEFORGE_SIGN_REQUIRED === '1' ||
	process.env.CODEFORGE_SIGN_REQUIRED === 'true';
const TIMESTAMP =
	process.env.CODEFORGE_SIGN_TIMESTAMP ||
	'http://timestamp.digicert.com';

function findSigntool() {
	const fromEnv = process.env.SIGNTOOL_PATH;
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
	const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
	if (fs.existsSync(kits)) {
		const versions = fs
			.readdirSync(kits)
			.filter(v => /^\d+\./.test(v))
			.sort()
			.reverse();
		for (const v of versions) {
			for (const arch of ['x64', 'x86']) {
				const candidate = path.join(kits, v, arch, 'signtool.exe');
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	const which = spawnSync('where', ['signtool.exe'], { encoding: 'utf8', shell: true });
	if (which.status === 0) {
		const line = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		if (line && fs.existsSync(line)) return line;
	}
	return null;
}

function resolvePfx() {
	const raw = (process.env.CODEFORGE_SIGN_PFX || '').trim();
	if (!raw) return null;
	if (fs.existsSync(raw)) {
		return { path: path.resolve(raw), cleanup: null };
	}
	// Treat as base64
	try {
		const buf = Buffer.from(raw, 'base64');
		if (buf.length < 64) return null;
		const tmp = path.join(os.tmpdir(), `codeforge-sign-${process.pid}.pfx`);
		fs.writeFileSync(tmp, buf);
		return {
			path: tmp,
			cleanup: () => {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* ignore */
				}
			},
		};
	} catch {
		return null;
	}
}

function collectTargets(argv) {
	const files = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dir') {
			const dir = argv[++i];
			if (!dir || !fs.existsSync(dir)) continue;
			for (const name of fs.readdirSync(dir)) {
				if (name.toLowerCase().endsWith('.exe')) {
					files.push(path.join(dir, name));
				}
			}
		} else if (!a.startsWith('-') && a.toLowerCase().endsWith('.exe') && fs.existsSync(a)) {
			files.push(path.resolve(a));
		}
	}
	return [...new Set(files)];
}

function writeUnsignedMarker(dirOrFile, reason) {
	const dir = fs.statSync(dirOrFile).isDirectory() ? dirOrFile : path.dirname(dirOrFile);
	const marker = path.join(dir, 'UNSIGNED.txt');
	const body = `CodeForge Windows build is NOT Authenticode-signed.

Reason: ${reason}

To sign releases, set GitHub Actions secrets:
  CODEFORGE_SIGN_PFX       — base64 of the .pfx (or path in local builds)
  CODEFORGE_SIGN_PASSWORD  — PFX password
  CODEFORGE_SIGN_REQUIRED=true on release jobs once the cert is available

Local:
  set CODEFORGE_SIGN_PFX=C:\\path\\to\\cert.pfx
  set CODEFORGE_SIGN_PASSWORD=...
  node scripts/sign-windows.mjs --dir dist/codeforge-win32-x64
`;
	fs.writeFileSync(marker, body, 'utf8');
	console.log(`Wrote ${marker}`);
	return marker;
}

function signFile(signtool, pfxPath, password, file) {
	const args = [
		'sign',
		'/fd',
		'SHA256',
		'/td',
		'SHA256',
		'/tr',
		TIMESTAMP,
		'/f',
		pfxPath,
	];
	if (password !== undefined && password !== null) {
		args.push('/p', String(password));
	}
	args.push(file);
	console.log(`> signtool sign … ${path.basename(file)}`);
	const r = spawnSync(signtool, args, { encoding: 'utf8', shell: false });
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.stderr) process.stderr.write(r.stderr);
	if (r.status !== 0) {
		throw new Error(`signtool failed for ${file} (exit ${r.status})`);
	}
}

function main() {
	const argv = process.argv.slice(2);
	const targets = collectTargets(argv);
	const dirArgIdx = argv.indexOf('--dir');
	const markerBase =
		dirArgIdx >= 0 && argv[dirArgIdx + 1]
			? path.resolve(argv[dirArgIdx + 1])
			: targets[0]
				? path.dirname(targets[0])
				: path.join(root, 'dist', 'codeforge-win32-x64');

	if (!targets.length) {
		const reason = 'No .exe targets provided';
		if (REQUIRED) {
			console.error(reason);
			process.exit(1);
		}
		fs.mkdirSync(markerBase, { recursive: true });
		writeUnsignedMarker(markerBase, reason);
		process.exit(0);
	}

	const pfx = resolvePfx();
	if (!pfx) {
		const reason = 'CODEFORGE_SIGN_PFX not set or invalid';
		writeUnsignedMarker(markerBase, reason);
		if (REQUIRED) {
			console.error(reason);
			process.exit(1);
		}
		console.warn(`Signing skipped: ${reason}`);
		process.exit(0);
	}

	const signtool = findSigntool();
	if (!signtool) {
		pfx.cleanup?.();
		const reason = 'signtool.exe not found (install Windows SDK)';
		writeUnsignedMarker(markerBase, reason);
		if (REQUIRED) {
			console.error(reason);
			process.exit(1);
		}
		console.warn(`Signing skipped: ${reason}`);
		process.exit(0);
	}

	const password = process.env.CODEFORGE_SIGN_PASSWORD ?? '';
	try {
		for (const file of targets) {
			signFile(signtool, pfx.path, password, file);
		}
		const unsigned = path.join(markerBase, 'UNSIGNED.txt');
		if (fs.existsSync(unsigned)) fs.rmSync(unsigned);
		console.log(`Signed ${targets.length} file(s)`);
	} catch (err) {
		writeUnsignedMarker(markerBase, err instanceof Error ? err.message : String(err));
		if (REQUIRED) {
			console.error(err);
			process.exit(1);
		}
		console.warn(String(err));
		process.exit(0);
	} finally {
		pfx.cleanup?.();
	}
}

main();
