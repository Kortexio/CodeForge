/**
 * Baseline agents for the bench: the same task, model and server, driven by another
 * open-source agent instead of CodeForge. Scoring stays in bench.mjs (`cmdCheck`).
 *
 * Tools live outside the repo (override with CODEFORGE_BENCH_TOOLS):
 *   <tools>/aider/Scripts/aider.exe          pip install aider-chat
 *   <tools>/openhands/Scripts/openhands.exe  pip install openhands==1.16.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const TOOLS_ROOT =
	process.env.CODEFORGE_BENCH_TOOLS?.trim() || path.join(os.homedir(), 'codeforge-bench-tools');

const IS_WIN = process.platform === 'win32';

function venvExe(venv, name) {
	return IS_WIN
		? path.join(TOOLS_ROOT, venv, 'Scripts', `${name}.exe`)
		: path.join(TOOLS_ROOT, venv, 'bin', name);
}

export const EXTERNAL_AGENTS = {
	aider: { exe: () => venvExe('aider', 'aider'), versionArgs: ['--version'] },
	openhands: { exe: () => venvExe('openhands', 'openhands'), versionArgs: ['--version'] },
};

export function externalAgentVersion(agent) {
	const spec = EXTERNAL_AGENTS[agent];
	if (!spec) return { error: `unknown agent "${agent}"` };
	const exe = spec.exe();
	if (!fs.existsSync(exe)) return { error: `${agent} not installed at ${exe}` };
	const r = spawnSync(exe, spec.versionArgs, {
		encoding: 'utf8',
		timeout: 120_000,
		env: { ...process.env, OPENHANDS_SUPPRESS_BANNER: '1', PYTHONIOENCODING: 'utf-8' },
	});
	const out = `${r.stdout || ''}\n${r.stderr || ''}`;
	const line = out
		.split(/\r?\n/)
		.map(l => l.trim())
		.find(l => /^(aider|openhands cli)\s+v?\d/i.test(l));
	if (!line) return { error: `${agent} --version printed no version: ${out.trim().slice(0, 300)}` };
	return { exe, version: line };
}

/** `Confirm with \`cmd\`` in the task prompt is the verification command the task asks for. */
export function taskVerifyCommand(task) {
	if (task.verify) return String(task.verify);
	const m = /confirm with `([^`]+)`/i.exec(String(task.prompt || ''));
	return m ? m[1] : '';
}

function killTree(pid) {
	if (!pid) return;
	if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
	else {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}
}

function runProcess(exe, args, { cwd, env, timeoutMs, logFile }) {
	return new Promise(resolve => {
		const started = Date.now();
		const log = fs.createWriteStream(logFile, { flags: 'w' });
		log.write(`$ ${exe} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n\n`);
		let tail = '';
		const keep = chunk => {
			const text = chunk.toString('utf8');
			log.write(text);
			tail = (tail + text).slice(-20_000);
		};
		const child = spawn(exe, args, { cwd, env, detached: !IS_WIN, windowsHide: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, timeoutMs);
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		child.on('error', err => {
			clearTimeout(timer);
			log.end(`\n[spawn error] ${err.message}\n`);
			resolve({ exitCode: null, timedOut, spawnError: err.message, elapsedMs: Date.now() - started, tail });
		});
		child.on('close', code => {
			clearTimeout(timer);
			log.end(`\n[exit ${code}${timedOut ? ' · killed on timeout' : ''}]\n`);
			resolve({ exitCode: code, timedOut, elapsedMs: Date.now() - started, tail });
		});
	});
}

export function aiderArgs({ model, baseUrl, numCtx, promptFile, logDir, verify, files }) {
	const metadata = path.join(logDir, 'aider-model-metadata.json');
	fs.writeFileSync(
		metadata,
		JSON.stringify(
			{
				[`openai/${model}`]: {
					max_input_tokens: numCtx,
					max_tokens: Math.min(16384, Math.floor(numCtx / 4)),
					input_cost_per_token: 0,
					output_cost_per_token: 0,
					litellm_provider: 'openai',
					mode: 'chat',
				},
			},
			null,
			2
		)
	);
	const args = [
		'--model',
		`openai/${model}`,
		'--openai-api-base',
		baseUrl,
		'--model-metadata-file',
		metadata,
		'--message-file',
		promptFile,
		'--yes-always',
		'--no-auto-commits',
		'--no-dirty-commits',
		'--no-gitignore',
		'--no-check-update',
		'--no-show-model-warnings',
		'--no-show-release-notes',
		'--no-pretty',
		'--no-stream',
		'--no-fancy-input',
		'--analytics-disable',
		'--input-history-file',
		path.join(logDir, 'aider.input.history'),
		'--chat-history-file',
		path.join(logDir, 'aider.chat.history.md'),
		'--llm-history-file',
		path.join(logDir, 'aider.llm.history'),
	];
	if (verify) args.push('--test-cmd', verify, '--auto-test');
	args.push('--', ...files);
	return args;
}

/**
 * Aider only edits files that are in its chat; with `--message` nobody is there to `/add` them,
 * so the model sees only the repo map and guesses. Its own benchmark passes the files up front,
 * which is what we do: every tracked file of the fixture (the fixtures are small).
 */
function trackedFiles(workspace) {
	const r = spawnSync('git', ['-C', workspace, 'ls-files'], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ls-files failed in ${workspace}: ${r.stderr}`);
	return r.stdout
		.split(/\r?\n/)
		.map(s => s.trim())
		.filter(Boolean)
		.filter(f => !/\.(png|jpe?g|gif|ico|dll|exe|zip|pdb)$/i.test(f));
}

/** `-f <file>` makes the file's folder the agent's working directory, so the task goes in `-t`. */
export function openhandsArgs({ prompt }) {
	return ['--headless', '--override-with-envs', '--json', '--exit-without-confirmation', '-t', prompt];
}

/**
 * Run one baseline agent in `workspace` until it exits or `timeoutMs` passes.
 * The agent decides when it is done; the caller scores the folder afterwards.
 */
export async function runExternalAgent(agent, { workspace, task, prompt, baseUrl, apiKey, model, numCtx, logDir, timeoutMs }) {
	const spec = EXTERNAL_AGENTS[agent];
	if (!spec) throw new Error(`unknown external agent "${agent}"`);
	const version = externalAgentVersion(agent);
	if (version.error) throw new Error(version.error);
	fs.mkdirSync(logDir, { recursive: true });
	const promptFile = path.join(logDir, 'prompt.txt');
	fs.writeFileSync(promptFile, prompt, 'utf8');
	const verify = taskVerifyCommand(task);
	const env = {
		...process.env,
		PYTHONIOENCODING: 'utf-8',
		PYTHONUTF8: '1',
		PYTHONUNBUFFERED: '1',
		NO_COLOR: '1',
		OPENHANDS_SUPPRESS_BANNER: '1',
	};
	let args;
	let preloadedFiles = 0;
	if (agent === 'aider') {
		env.OPENAI_API_KEY = apiKey || 'none';
		const files = trackedFiles(workspace);
		preloadedFiles = files.length;
		args = aiderArgs({ model, baseUrl, numCtx, promptFile, logDir, verify, files });
	} else {
		env.LLM_MODEL = `openai/${model}`;
		env.LLM_BASE_URL = baseUrl;
		env.LLM_API_KEY = apiKey || 'none';
		args = openhandsArgs({ prompt });
	}
	const logFile = path.join(logDir, `${agent}.log`);
	const r = await runProcess(version.exe, args, { cwd: workspace, env, timeoutMs, logFile });
	const loopExit = r.spawnError ? 'error' : r.timedOut ? 'timeout' : r.exitCode === 0 ? 'done' : 'error';
	return {
		agent,
		agentVersion: version.version,
		loopExit,
		exitCode: r.exitCode,
		elapsedMs: r.elapsedMs,
		verifyCommand: verify || null,
		preloadedFiles,
		log: logFile,
		replyTail: r.tail.slice(-4000),
		...(r.spawnError ? { spawnError: r.spawnError } : {}),
	};
}
