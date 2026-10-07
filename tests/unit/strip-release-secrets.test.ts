import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const script = path.resolve(process.cwd(), 'scripts/strip-release-secrets.mjs');
const fakeKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';

function run(root: string) {
	return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

function makeTree(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-strip-'));
}

describe('strip-release-secrets', () => {
	it('removes portable user data and git metadata before a clean tree can ship', () => {
		const root = makeTree();
		const settings = path.join(root, 'data', 'User');
		fs.mkdirSync(settings, { recursive: true });
		fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({ 'codeforge.ai.apiKey': fakeKey }));
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });
		fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/example/repo.git\n');
		fs.writeFileSync(path.join(root, 'CodeForge.exe'), '');

		const result = run(root);

		expect(result.status).toBe(0);
		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
		expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
		expect(result.stdout).not.toContain(fakeKey);
		expect(result.stderr).not.toContain(fakeKey);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('refuses to package when an API key is hardcoded outside user data', () => {
		const root = makeTree();
		const ext = path.join(root, 'resources', 'app', 'extensions', 'codeforge');
		fs.mkdirSync(ext, { recursive: true });
		fs.writeFileSync(path.join(ext, 'leak.js'), `const apiKey = "${fakeKey}";\n`);

		const result = run(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('leak.js');
		expect(result.stderr).toContain('api key or token');
		expect(result.stderr).not.toContain(fakeKey);
		expect(fs.existsSync(path.join(ext, 'leak.js'))).toBe(true);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('refuses to package an MCP config file', () => {
		const root = makeTree();
		fs.writeFileSync(path.join(root, 'mcp.json'), '{"mcpServers":{}}\n');

		const result = run(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('mcp.json');
		fs.rmSync(root, { recursive: true, force: true });
	});
});
