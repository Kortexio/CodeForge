/**
 * sign-windows.mjs dry behavior without a cert: writes UNSIGNED.txt and exits 0.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'sign-windows.mjs');

describe('sign-windows.mjs', () => {
	it('writes UNSIGNED.txt when CODEFORGE_SIGN_PFX is missing', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-sign-'));
		const exe = path.join(dir, 'CodeForge-Setup-test.exe');
		fs.writeFileSync(exe, 'fake');
		const env = { ...process.env };
		delete env.CODEFORGE_SIGN_PFX;
		delete env.CODEFORGE_SIGN_PASSWORD;
		delete env.CODEFORGE_SIGN_REQUIRED;
		const r = spawnSync(process.execPath, [script, '--dir', dir], {
			encoding: 'utf8',
			env,
		});
		expect(r.status).toBe(0);
		const marker = path.join(dir, 'UNSIGNED.txt');
		expect(fs.existsSync(marker)).toBe(true);
		const body = fs.readFileSync(marker, 'utf8');
		expect(body).toMatch(/NOT Authenticode-signed/);
		expect(body).toMatch(/CODEFORGE_SIGN_PFX/);
	});

	it('fails when signing is required and cert is missing', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-sign-req-'));
		fs.writeFileSync(path.join(dir, 'CodeForge.exe'), 'fake');
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEFORGE_SIGN_REQUIRED: 'true',
		};
		delete env.CODEFORGE_SIGN_PFX;
		const r = spawnSync(process.execPath, [script, '--dir', dir], {
			encoding: 'utf8',
			env,
		});
		expect(r.status).toBe(1);
	});
});
