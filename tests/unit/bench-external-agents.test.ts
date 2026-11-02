/**
 * Baseline agents in benchmarks/externalAgents.mjs (ESM, so it runs in a child node process).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODULE = path.resolve(__dirname, '..', '..', 'benchmarks', 'externalAgents.mjs');
const TASKS = path.resolve(__dirname, '..', '..', 'benchmarks', 'tasks');

function runModule(script: string, env: Record<string, string> = {}): unknown {
	const code = `import(${JSON.stringify('file:///' + MODULE.replace(/\\/g, '/'))}).then(async m => {
		const out = await (async () => { ${script} })();
		process.stdout.write(JSON.stringify(out));
	}).catch(err => { process.stderr.write(String(err?.stack || err)); process.exit(1); });`;
	const r = spawnSync(process.execPath, ['-e', code], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
	if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
	return JSON.parse(r.stdout);
}

describe('bench external agents', () => {
	let emptyTools: string;
	let workspace: string;

	beforeAll(() => {
		emptyTools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bench-tools-'));
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bench-ws-'));
	});

	afterAll(() => {
		fs.rmSync(emptyTools, { recursive: true, force: true });
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it('refuses to run an agent that is not installed instead of returning a result', () => {
		const out = runModule(
			`
			const version = m.externalAgentVersion('aider');
			let rejected = null;
			try {
				await m.runExternalAgent('openhands', {
					workspace: ${JSON.stringify(workspace)}, task: {}, prompt: 'x', baseUrl: 'http://127.0.0.1:9/v1',
					apiKey: '', model: 'm', numCtx: 8192, logDir: ${JSON.stringify(path.join(workspace, 'log'))}, timeoutMs: 1000,
				});
			} catch (err) { rejected = err.message; }
			return { version, rejected };
			`,
			{ CODEFORGE_BENCH_TOOLS: emptyTools }
		) as { version: { error?: string }; rejected: string | null };
		expect(out.version.error).toMatch(/not installed/);
		expect(out.rejected).toMatch(/openhands not installed/);
	});

	it('gives OpenHands the task inline so its working directory stays the workspace', () => {
		const args = runModule(`return m.openhandsArgs({ prompt: 'Fix the bug' });`) as string[];
		expect(args).not.toContain('-f');
		expect(args[args.indexOf('-t') + 1]).toBe('Fix the bug');
		expect(args).toContain('--headless');
	});

	it('runs Aider without commits and with the fixture files in the chat', () => {
		const logDir = path.join(workspace, 'aider-log');
		fs.mkdirSync(logDir, { recursive: true });
		const args = runModule(
			`return m.aiderArgs({ model: 'qwen', baseUrl: 'http://h/v1', numCtx: 32768, promptFile: 'p.txt',
				logDir: ${JSON.stringify(logDir)}, verify: 'dotnet test', files: ['src/a.cs', 'docs/b.md'] });`
		) as string[];
		expect(args).toContain('--no-auto-commits');
		expect(args).toContain('--no-dirty-commits');
		expect(args.slice(args.indexOf('--') + 1)).toEqual(['src/a.cs', 'docs/b.md']);
		expect(args[args.indexOf('--test-cmd') + 1]).toBe('dotnet test');
		const metadata = JSON.parse(fs.readFileSync(path.join(logDir, 'aider-model-metadata.json'), 'utf8'));
		expect(metadata['openai/qwen'].max_input_tokens).toBe(32768);
	});

	it('reads the verification command from the task prompt', () => {
		const read = (id: string) => JSON.parse(fs.readFileSync(path.join(TASKS, id, 'task.json'), 'utf8'));
		const out = runModule(
			`return [${['CS6-long-router-cards', 'CS5-review-billing-bugs', 'CS4-scaffold-solution']
				.map(id => `m.taskVerifyCommand(${JSON.stringify(read(id))})`)
				.join(',')}];`
		) as string[];
		expect(out).toEqual(['dotnet test Acme.Router.slnx', '', 'dotnet test']);
	});
});
