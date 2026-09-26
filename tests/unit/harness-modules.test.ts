/**
 * Unit tests for the pure harness modules: clip, read memory, edit, oracle, toolsets, nudges.
 */

import * as path from 'path';
import { clipBuildOutput, clipData, clipToolOutput } from '../../extensions/codeforge/src/agent/clip';
import {
	invalidatePaths,
	readAliasesFor,
	rememberedReadWindow,
} from '../../extensions/codeforge/src/agent/readMemory';
import { applyEdit, excerptAround } from '../../extensions/codeforge/src/agent/editTool';
import {
	detectOracle,
	formatOracleResult,
	parseDotnetErrors,
	parseFailedTests,
	runOracle,
	type OracleFs,
} from '../../extensions/codeforge/src/agent/oracle';
import {
	buildDotnetCommand,
	currentPhase,
	isPartialRewrite,
	isStatusQuestion,
	mentionsErrorFile,
	toolNamesFor,
} from '../../extensions/codeforge/src/agent/toolsets';
import { claimsBuildOrTestGreen, parseBlockedClaim, STATUS_UPDATE_NOTE } from '../../extensions/codeforge/src/agent/nudges';
import {
	appendProjectStatus,
	buildDigest,
	buildHarnessEntry,
	finishTurn,
	formatStatusForPrompt,
	formatStatusMarkdown,
	HISTORY_MAX,
	loadProjectStatus,
	normalizeStatusFile,
	parseRepoSnapshot,
	saveProjectStatus,
	salvageSessionProgress,
	shouldRequireStatusUpdate,
	stalenessLine,
} from '../../extensions/codeforge/src/agent/projectStatus';
import { assembleContext, DEFAULT_BUDGET } from '../../extensions/codeforge/src/context/engine';
import { chunkFile } from '../../extensions/codeforge/src/intelligence/chunker';
import { buildRerankPrompt, parseKeepIndices } from '../../extensions/codeforge/src/intelligence/rerank';
import { formatOutlineBlock } from '../../extensions/codeforge/src/intelligence/lspBridge';
import { pathsNeedingReindex } from '../../extensions/codeforge/src/intelligence/workspaceIndex';
import {
	formatReadLedger,
	midCompactMessages,
} from '../../extensions/codeforge/src/agent/toolHistory';
import { EXPLORE_MODE } from '../../extensions/codeforge/src/agent/exploreMode';
import { extractBuildErrorLines } from '../../extensions/codeforge/src/governance/guardrailEngine';
import { buildPriorAgentTranscript } from '../../extensions/codeforge/src/agent/priorContext';
import {
	cookbookLines,
	matchSkills,
	parseFrontmatter,
	type SkillDoc,
} from '../../extensions/codeforge/src/skills/skillsRulesLoader';
import { projectMemoryDir } from '../../extensions/codeforge/src/storage/paths';
import * as os from 'os';
import * as fs from 'fs';

const SKILLS_DIR = path.join(__dirname, '..', '..', 'extensions', 'codeforge', 'resources', 'skills');

function diskSkills(): SkillDoc[] {
	return fs.readdirSync(SKILLS_DIR).map(name => {
		const parsed = parseFrontmatter(fs.readFileSync(path.join(SKILLS_DIR, name), 'utf8'));
		const title = String(parsed.meta.name ?? name);
		return {
			id: `global:${title}`,
			scope: 'global' as const,
			title,
			content: parsed.body,
			description: String(parsed.meta.description ?? ''),
			triggers: [title, ...((parsed.meta.triggers as string[]) ?? [])],
		};
	});
}

describe('disk skills', () => {
	const skills = diskSkills();

	it('every skill has a name, description, triggers and fits a prompt block whole', () => {
		expect(skills.length).toBeGreaterThanOrEqual(4);
		for (const s of skills) {
			expect(s.description).toBeTruthy();
			expect(s.triggers.length).toBeGreaterThan(2);
			expect(s.content.length).toBeLessThan(2600);
		}
	});

	it('matches on whole trigger phrases only', () => {
		const names = (q: string) => matchSkills(skills, q).map(s => s.title).sort();
		expect(names('cria um value object Sku com guard clause')).toEqual(['.NET value object']);
		expect(names('adiciona testes de arquitetura com xunit')).toEqual(['xUnit tests']);
		expect(names('cria a solution e o classlib Domain')).toEqual(['.NET project setup']);
		expect(names('muda a cor do botão na página')).toEqual([]);
		// "solution" must not match "solutions" / "resolution"
		expect(names('the resolution of the image')).toEqual([]);
	});

	it('cookbook returns one fix line per error code present', () => {
		const lines = cookbookLines(skills, ['CS0246', 'NU1101', 'CS0246', 'CS9999']);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^CS0246 /);
		expect(lines[1]).toMatch(/^NU1101 /);
	});
});

describe('clip', () => {
	it('clipData keeps short text and marks cuts on line boundaries', () => {
		expect(clipData('abc', 10)).toBe('abc');
		const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
		const out = clipData(text, 60);
		expect(out).toMatch(/…\[clipped: showing lines 1-\d+ of 50; \d+ chars omitted\]$/);
		expect(out.split('\n').slice(0, -1).every(l => /^line \d+$/.test(l))).toBe(true);
	});

	it('clipBuildOutput never drops compiler errors or the summary', () => {
		const noise = Array.from({ length: 400 }, (_, i) => `  Restoring package ${i} ...`);
		const text = [
			'exit 1',
			...noise.slice(0, 200),
			'src/A/Foo.cs(12,5): error CS0246: The type or namespace name Bar could not be found',
			...noise.slice(200),
			'Build FAILED.',
			'    1 Error(s)',
		].join('\n');
		const out = clipBuildOutput(text, 1500);
		expect(out.length).toBeLessThan(2000);
		expect(out).toContain('error CS0246');
		expect(out).toContain('Build FAILED.');
		expect(out).toContain('1 Error(s)');
		expect(out).toMatch(/…\[\d+ lines omitted\]/);
	});

	it('clipToolOutput uses build clipping for shell output', () => {
		const text = ['exit 1', ...Array.from({ length: 300 }, () => 'x'.repeat(30)), 'error CS1002: ; expected'].join('\n');
		expect(clipToolOutput('shell', text, 800)).toContain('error CS1002');
		expect(clipToolOutput('read', 'y'.repeat(50) + '\n' + 'z'.repeat(50), 60)).toContain('…[clipped');
	});
});

describe('read memory', () => {
	const cache = new Map<string, string>();
	cache.set(
		'readwin:src/a.cs@1@3',
		'FILE src/a.cs lines 1-3/5\n   1|one\n   2|two\n   3|three\n(more: startLine=4)'
	);
	cache.set('readwin:src/a.cs@4@2', 'FILE src/a.cs lines 4-5/5\n   4|four\n   5|five\n(end of file — 5 lines)');

	it('rebuilds a window from earlier reads', () => {
		const out = rememberedReadWindow(cache, ['src/a.cs'], 2, 4);
		expect(out).toContain('lines 2-5/5');
		expect(out).toContain('   2|two');
		expect(out).toContain('   5|five');
		expect(out).toContain('end of file');
	});

	it('returns undefined when a line is missing', () => {
		expect(rememberedReadWindow(cache, ['src/b.cs'], 1, 3)).toBeUndefined();
	});

	it('invalidates a path after it changes', () => {
		const c = new Map(cache);
		const seen = new Set(['src/a.cs']);
		const maxEnd = new Map([['src/a.cs', 5]]);
		invalidatePaths(c, seen, maxEnd, ['src/a.cs']);
		expect([...c.keys()].some(k => k.includes('src/a.cs'))).toBe(false);
		expect(seen.size).toBe(0);
	});

	it('aliases docs/ cards', () => {
		expect(readAliasesFor('c01.md')).toEqual(['c01.md', 'docs/c01.md']);
		expect(readAliasesFor('docs/c01.md')).toEqual(['docs/c01.md', 'c01.md']);
	});
});

describe('edit tool', () => {
	const file = 'class A\n{\n    int X = 1;   \n    int Y = 2;\n}\n';

	it('replaces a unique match', () => {
		const r = applyEdit(file, 'int Y = 2;', 'int Y = 3;');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.text).toContain('int Y = 3;');
			expect(r.firstLine).toBe(4);
		}
	});

	it('strips read line-number prefixes and tolerates trailing whitespace', () => {
		const r = applyEdit(file, '   3|    int X = 1;', '    int X = 5;');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.text).toContain('int X = 5;');
	});

	it('keeps CRLF files CRLF', () => {
		const crlf = file.replace(/\n/g, '\r\n');
		const r = applyEdit(crlf, 'int X = 1;   \n    int Y = 2;', 'int X = 1;\n    int Y = 9;');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.text).toContain('int X = 1;\r\n    int Y = 9;');
	});

	it('reports closest lines when not found', () => {
		const r = applyEdit(file, 'int Z = 2;', 'int Z = 3;');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('not found');
			expect(r.error).toMatch(/\d+\|\s+int [XY]/);
		}
	});

	it('asks for replace_all on multiple matches', () => {
		const r = applyEdit('a\nb\na\n', 'a', 'c');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('lines 1, 3');
		const all = applyEdit('a\nb\na\n', 'a', 'c', true);
		expect(all.ok && all.text).toBe('c\nb\nc\n');
		expect(all.ok && all.count).toBe(2);
	});

	it('excerpt caps long spans', () => {
		const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n');
		const ex = excerptAround(text, 10, Array.from({ length: 60 }, () => 'n').join('\n'));
		expect(ex.split('\n').length).toBeLessThanOrEqual(31);
		expect(ex).toContain('lines omitted');
	});
});

describe('oracle', () => {
	function memFs(files: Record<string, string>, dirs: string[] = []): OracleFs {
		const norm = (p: string) => p.replace(/\\/g, '/');
		const root = '/ws';
		const abs = (rel: string) => norm(path.join(root, rel));
		const fileMap = new Map(Object.entries(files).map(([k, v]) => [abs(k), v]));
		const dirSet = new Set([norm(root), ...dirs.map(abs)]);
		for (const f of Object.keys(files)) {
			let d = path.posix.dirname(f);
			while (d && d !== '.') {
				dirSet.add(abs(d));
				d = path.posix.dirname(d);
			}
		}
		return {
			exists: p => fileMap.has(norm(p)) || dirSet.has(norm(p)),
			readText: p => fileMap.get(norm(p)),
			isDir: p => dirSet.has(norm(p)),
			list: p => {
				const base = norm(p).replace(/\/$/, '');
				const names = new Set<string>();
				for (const k of [...fileMap.keys(), ...dirSet]) {
					if (k.startsWith(base + '/')) names.add(k.slice(base.length + 1).split('/')[0]);
				}
				return [...names];
			},
		};
	}

	it('prefers .CodeForge/oracle.json', () => {
		const fsx = memFs({ '.CodeForge/oracle.json': '{"command":"make check"}', 'App.slnx': '' });
		expect(detectOracle('/ws', fsx)).toEqual({ commands: ['make check'], source: 'oracle.json' });
	});

	it('uses the root solution', () => {
		const cfg = detectOracle('/ws', memFs({ 'Acme.slnx': '' }));
		expect(cfg?.commands[0]).toBe('dotnet build Acme.slnx -nologo -v q');
		expect(cfg?.commands[1]).toContain('dotnet test Acme.slnx --no-build');
	});

	it('falls back to csproj files and tests only test projects', () => {
		const cfg = detectOracle(
			'/ws',
			memFs({
				'src/Lib/Lib.csproj': '<Project/>',
				'tests/Lib.Tests/Lib.Tests.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk"/>',
				'src/Lib/bin/Debug/Other.csproj': '',
			})
		);
		expect(cfg?.commands).toEqual([
			'dotnet build src/Lib/Lib.csproj -nologo -v q',
			'dotnet build tests/Lib.Tests/Lib.Tests.csproj -nologo -v q',
			'dotnet test tests/Lib.Tests/Lib.Tests.csproj --no-build -nologo -v q',
		]);
	});

	it('uses package.json scripts and ignores the npm placeholder test', () => {
		const cfg = detectOracle(
			'/ws',
			memFs({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'echo "Error: no test specified"' } }) })
		);
		expect(cfg).toEqual({ source: 'npm', commands: ['npm run build --silent'] });
		expect(detectOracle('/ws', memFs({ 'README.md': '' }))).toBeUndefined();
	});

	it('parses dotnet errors and failed tests', () => {
		const out = [
			'C:\\ws\\src\\Foo.cs(12,5): error CS0246: Type Bar not found [C:\\ws\\src\\Lib.csproj]',
			'C:\\ws\\src\\Foo.cs(12,5): error CS0246: Type Bar not found [C:\\ws\\src\\Lib.csproj]',
			'error NU1101: Unable to find package Foo.Bar',
			'  Failed Acme.Tests.CartTests.Total_IncludesTax [12 ms]',
			'not ok 3 - totals round half up',
		].join('\n');
		const errors = parseDotnetErrors(out);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toEqual({ file: 'C:/ws/src/Foo.cs', line: 12, code: 'CS0246', msg: 'Type Bar not found' });
		expect(errors[1].code).toBe('NU1101');
		expect(parseFailedTests(out)).toEqual(['Acme.Tests.CartTests.Total_IncludesTax', 'totals round half up']);
	});

	it('runOracle stops at the first failing command', async () => {
		const ran: string[] = [];
		const r = await runOracle({ source: 'dotnet', commands: ['build', 'test'] }, async c => {
			ran.push(c);
			return 'exit 1\nsrc/A.cs(3,1): error CS1002: ; expected';
		});
		expect(ran).toEqual(['build']);
		expect(r.ok).toBe(false);
		const text = formatOracleResult(r, 'finish');
		expect(text).toContain('RED');
		expect(text).toContain('src/A.cs:3 CS1002');
		const green = await runOracle({ source: 'dotnet', commands: ['build'] }, async () => 'exit 0\nok');
		expect(formatOracleResult(green, 'finish')).toContain('GREEN');
	});
});

describe('toolsets', () => {
	const all = ['read', 'retrieve', 'list', 'search', 'edit', 'write', 'dotnet', 'shell', 'git_status', 'wiki_read', 'mcp_call', 'diagnostics'];

	it('picks the phase from task and build state', () => {
		expect(currentPhase('Encontre os bugs em Cart.cs', { buildRed: false })).toBe('review');
		expect(currentPhase('Implementa o card C01', { buildRed: true })).toBe('fix');
		expect(currentPhase('Implementa o card C01', { buildRed: false })).toBe('implement');
		expect(currentPhase('o que faz este projeto?', { buildRed: false })).toBe('explore');
	});

	it('returns the full tool surface; status questions only get update_status', () => {
		const explore = toolNamesFor('explore', 'o que faz?', { weakProfile: true, allNames: all });
		expect(explore.size).toBe(all.length);
		expect(explore.has('write')).toBe(true);
		expect(toolNamesFor('explore', 'x', { weakProfile: false, allNames: all }).size).toBe(all.length);
		const withGit = toolNamesFor('implement', 'faz commit no git', { weakProfile: true, allNames: all });
		expect(withGit.has('git_status')).toBe(true);
		expect(withGit.has('mcp_call')).toBe(true);
		const statusOnly = toolNamesFor('explore', 'onde paramos no projeto?', {
			weakProfile: false,
			allNames: [...all, 'update_status', 'shell', 'git_status'],
		});
		expect([...statusOnly]).toEqual(['update_status']);
		expect(isStatusQuestion('onde paramos?')).toBe(true);
		expect(isStatusQuestion('continua de onde paramos')).toBe(false);
	});
	it('detects partial rewrites', () => {
		const old = Array.from({ length: 20 }, (_, i) => `var line${i} = ${i};`).join('\n');
		const partial = old.split('\n').slice(0, 15).join('\n') + '\nvar extra = 1;';
		expect(isPartialRewrite(old, partial)).toBe(true);
		expect(isPartialRewrite(old, 'totally\nnew\ncontent here')).toBe(false);
	});

	it('recognises reads of files named in errors', () => {
		const errs = ['src/Acme/Cart.cs(3,1): error CS1002: ; expected'];
		expect(mentionsErrorFile('src\\Acme\\Cart.cs', errs)).toBe(true);
		expect(mentionsErrorFile('Cart.cs', errs)).toBe(true);
		expect(mentionsErrorFile('src/Other.cs', errs)).toBe(false);
	});

	it('builds dotnet commands and rejects invalid input', () => {
		expect(buildDotnetCommand({ action: 'new', template: 'classlib', name: 'Acme.Core', output: 'src/Acme Core' })).toEqual({
			command: 'dotnet new classlib -n Acme.Core -o "src/Acme Core"',
		});
		expect(buildDotnetCommand({ action: 'test', project: 'Acme.slnx', filter: 'Cart' })).toEqual({
			command: 'dotnet test Acme.slnx -nologo -v q --filter Cart',
		});
		expect('error' in buildDotnetCommand({ action: 'new' })).toBe(true);
		expect('error' in buildDotnetCommand({ action: 'publish' })).toBe(true);
	});
});

describe('nudges', () => {
	it('detects green claims in PT and EN, but not negations', () => {
		expect(claimsBuildOrTestGreen('Build succeeded, all tests pass.')).toBe(true);
		expect(claimsBuildOrTestGreen('Tudo verde, compila sem erros.')).toBe(true);
		expect(claimsBuildOrTestGreen('Ainda não compila: 3 errors.')).toBe(false);
		expect(claimsBuildOrTestGreen('Tests failed in CartTests.')).toBe(false);
		expect(claimsBuildOrTestGreen('Criei o ficheiro Cart.cs.')).toBe(false);
	});

	it('parses blocked claims', () => {
		expect(parseBlockedClaim('Resumo...\nblocked: falta o SDK .NET 9')).toBe('falta o SDK .NET 9');
		expect(parseBlockedClaim('bloqueado: sem acesso à rede')).toBe('sem acesso à rede');
		expect(parseBlockedClaim('not blocked here')).toBeUndefined();
	});
});

describe('prior context after writes', () => {
	const t = (name: string, args: Record<string, unknown>, output: string) => ({
		id: `${name}-${Math.random()}`,
		name,
		arguments: args,
		output,
		success: true,
		durationMs: 1,
		timestamp: new Date().toISOString(),
	});

	it('does not show a read body for a file that was edited afterwards', () => {
		const traces = [
			t('read', { path: 'src/Cart.cs' }, 'FILE src/Cart.cs lines 1-1/1\n   1|OLD BODY'),
			t('edit', { path: 'src/Cart.cs', old_string: 'OLD', new_string: 'NEW' }, 'Edited src/Cart.cs'),
			t('list', { path: 'src' }, 'Cart.cs'),
		];
		const text = buildPriorAgentTranscript(traces, 20000, 32000) ?? '';
		expect(text).not.toContain('OLD BODY');
		expect(text).toContain('Edited src/Cart.cs');
	});
});

describe('guardrail error lines', () => {
	it('keeps compiler errors and failed tests, deduplicated', () => {
		const out = [
			'src/A.cs(1,1): error CS1002: ; expected [src/A.csproj]',
			'src/A.cs(1,1): error CS1002: ; expected [src/A.csproj]',
			'  Failed Acme.Tests.X [3 ms]',
			'some error text in a log line',
		].join('\n');
		expect(extractBuildErrorLines(out)).toEqual(['src/A.cs(1,1): error CS1002: ; expected', 'Failed Acme.Tests.X [3 ms]']);
	});
});

describe('project status', () => {
	it('formats the standing note and requires one update before the final reply', () => {
		const file = normalizeStatusFile({
			version: 2,
			current: {
				updatedAt: '2026-09-25T00:00:00.000Z',
				source: 'model',
				objective: 'Ship the cart',
				stoppedAt: 'Cart total is implemented; tests not run',
				next: 'Run the cart tests',
				blockers: '',
				files: ['src/Cart.cs'],
				outcome: 'done',
			},
			history: [],
			digest: 'Cart work in progress',
		});
		expect(file).not.toBeNull();
		const block = formatStatusForPrompt(file!);
		expect(block).toContain('Stopped at: Cart total is implemented');
		expect(block).toContain('src/Cart.cs');
		expect(block).toContain('Digest');
		expect(STATUS_UPDATE_NOTE).toContain('update_status');
		expect(shouldRequireStatusUpdate({ alreadyUpdated: false, nudges: 0 })).toBe(true);
		expect(shouldRequireStatusUpdate({ alreadyUpdated: true, nudges: 0 })).toBe(false);
		expect(shouldRequireStatusUpdate({ isolated: true, alreadyUpdated: false, nudges: 0 })).toBe(false);
		expect(shouldRequireStatusUpdate({ alreadyUpdated: false, nudges: 1 })).toBe(false);
	});

	it('promotes flat v1 on disk to v2 current and appends history', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		const mem = projectMemoryDir(root);
		fs.mkdirSync(mem, { recursive: true });
		fs.writeFileSync(
			path.join(mem, 'status.json'),
			JSON.stringify({
				updatedAt: '2026-01-01T00:00:00.000Z',
				objective: 'v1',
				stoppedAt: 'legacy stop',
				next: '',
				blockers: '',
				files: [],
			}),
			'utf8'
		);
		const loaded = await loadProjectStatus(root);
		expect(loaded?.version).toBe(2);
		expect(loaded?.current.stoppedAt).toBe('legacy stop');
		await saveProjectStatus(root, {
			objective: 'v2',
			stoppedAt: 'new stop',
			next: 'continue',
		});
		const next = await loadProjectStatus(root);
		expect(next?.current.stoppedAt).toBe('new stop');
		expect(next?.history[0]?.stoppedAt).toBe('legacy stop');
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('caps history and prefers rolling summary for the digest', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		for (let i = 0; i < HISTORY_MAX + 5; i++) {
			await appendProjectStatus(root, {
				source: 'harness',
				outcome: 'done',
				objective: `t${i}`,
				stoppedAt: `stop-${i}`,
			});
		}
		const file = await loadProjectStatus(root);
		expect(file?.history.length).toBeLessThanOrEqual(HISTORY_MAX);
		expect(buildDigest({ rollingSummary: 'Rolling story of the cart.', entries: file!.history })).toContain(
			'Rolling story'
		);
		expect(buildDigest({ entries: [{ stoppedAt: 'a' }, { stoppedAt: 'b' }] as never })).toContain('a');
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('builds a mechanical harness entry and finishTurn writes once per turn', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		const entry = buildHarnessEntry({
			task: 'Ship cart',
			actionsSummary: 'Progress: writes=1',
			files: ['src/Cart.cs'],
			openErrors: ['CS1002'],
			outcome: 'max-steps',
		});
		expect(entry.source).toBe('harness');
		expect(entry.files).toContain('src/Cart.cs');
		expect(entry.outcome).toBe('max-steps');

		expect(
			await finishTurn({
				workspaceRoot: root,
				task: 'Ship cart',
				modelUpdated: false,
				actionsSummary: 'Progress: writes=1',
				files: ['src/Cart.cs'],
				outcome: 'max-steps',
			})
		).toBe('written');
		expect(
			await finishTurn({
				workspaceRoot: root,
				isolated: true,
				task: 'ignored',
				modelUpdated: false,
				actionsSummary: 'x',
				files: [],
				outcome: 'done',
			})
		).toBe('skipped');
		expect(
			await finishTurn({
				workspaceRoot: root,
				depth: 1,
				task: 'ignored',
				modelUpdated: false,
				actionsSummary: 'x',
				files: [],
				outcome: 'done',
			})
		).toBe('skipped');

		await saveProjectStatus(root, {
			objective: 'model wrote',
			stoppedAt: 'model stop',
			next: 'n',
			files: ['a.cs'],
		});
		expect(
			await finishTurn({
				workspaceRoot: root,
				task: 'Ship cart',
				modelUpdated: true,
				actionsSummary: 'Progress: writes=2',
				files: ['b.cs'],
				outcome: 'done',
			})
		).toBe('merged');
		const after = await loadProjectStatus(root);
		expect(after?.current.stoppedAt).toBe('model stop');
		expect(after?.current.files).toEqual(expect.arrayContaining(['a.cs', 'b.cs']));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('serialises concurrent appends without dropping entries', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		await Promise.all(
			[1, 2, 3, 4, 5].map(i =>
				appendProjectStatus(root, {
					source: 'harness',
					outcome: 'done',
					objective: `o${i}`,
					stoppedAt: `s${i}`,
				})
			)
		);
		const file = await loadProjectStatus(root);
		expect(file?.current.stoppedAt).toMatch(/^s\d$/);
		expect((file?.history.length ?? 0) + 1).toBe(5);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('marks staleness when HEAD differs and writes status.md', async () => {
		const saved = parseRepoSnapshot({
			head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			statusShort: '## main\n M src/A.cs',
		})!;
		const live = parseRepoSnapshot({
			head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			statusShort: '## main\n M src/B.cs',
		})!;
		expect(stalenessLine(saved, live)).toContain('status is from');
		expect(stalenessLine(saved, saved)).toBe('');

		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		await saveProjectStatus(root, {
			objective: 'Cart',
			stoppedAt: 'Totals are in',
			next: 'Tests',
		});
		const md = fs.readFileSync(path.join(projectMemoryDir(root), 'status.md'), 'utf8');
		expect(md).toContain('Totals are in');
		expect(formatStatusMarkdown((await loadProjectStatus(root))!)).toContain('Totals are in');
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('includes status in assembleContext budget', () => {
		expect(DEFAULT_BUDGET.alloc.status).toBeGreaterThan(0);
		const assembled = assembleContext(
			[{ kind: 'status', priority: 96, content: '## PROJECT STATUS\nStopped at: here' }],
			DEFAULT_BUDGET
		);
		expect(assembled.included).toContain('status');
		expect(assembled.markdown).toContain('Stopped at: here');
	});

	it('keeps a project stop point when the session text would replace it, and writes one when the file is empty', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		await saveProjectStatus(root, {
			objective: 'Cart',
			stoppedAt: 'Totals are in',
			next: 'Tests',
		});
		expect(
			await salvageSessionProgress({
				workspaceFolder: root,
				task: 'other chat',
				rollingSummary: 'session-only note',
			})
		).toBe('kept');
		expect((await loadProjectStatus(root))?.current.stoppedAt).toBe('Totals are in');

		const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-'));
		expect(
			await salvageSessionProgress({
				workspaceFolder: empty,
				task: 'Cart',
				lastAssistant: 'Stopped after the total method.',
			})
		).toBe('written');
		expect((await loadProjectStatus(empty))?.current.stoppedAt).toBe('Stopped after the total method.');
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(empty, { recursive: true, force: true });
	});
});

describe('chunker', () => {
	it('chunks by symbols when provided', () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		const text = lines.join('\n');
		const chunks = chunkFile('Src/Cart.cs', text, [
			{ name: 'Cart', startLine: 1, endLine: 40 },
			{ name: 'Total', startLine: 10, endLine: 25, parents: ['Cart'] },
		]);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.some(c => c.symbol === 'Cart.Total' || c.header.includes('Cart.Total'))).toBe(true);
		expect(chunks[0].text).toContain('Src/Cart.cs');
	});

	it('falls back to blank-line blocks without symbols', () => {
		const blockA = Array.from({ length: 25 }, (_, i) => `a${i}`).join('\n');
		const blockB = Array.from({ length: 25 }, (_, i) => `b${i}`).join('\n');
		const text = `${blockA}\n\n${blockB}`;
		const chunks = chunkFile('a.ts', text);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		expect(chunks.every(c => c.endLine >= c.startLine)).toBe(true);
	});
});

describe('index incremental', () => {
	it('skips paths whose hash is unchanged', () => {
		expect(
			pathsNeedingReindex(
				[
					{ path: 'a.ts', hash: 'aaa' },
					{ path: 'b.ts', hash: 'bbb' },
				],
				[
					{ path: 'a.ts', hash: 'aaa' },
					{ path: 'b.ts', hash: 'BBB' },
					{ path: 'c.ts', hash: 'ccc' },
				]
			)
		).toEqual(['b.ts', 'c.ts']);
	});
});

describe('rerank', () => {
	it('builds a prompt and parses keep indices', () => {
		const prompt = buildRerankPrompt(
			'cart total',
			[
				{ path: 'a.ts', startLine: 1, endLine: 10, text: 'function total() {}' },
				{ path: 'b.ts', startLine: 5, endLine: 20, text: 'unrelated' },
			],
			2
		);
		expect(prompt).toContain('cart total');
		expect(prompt).toContain('[0]');
		expect(parseKeepIndices('{"keep":[1,0]}', 2)).toEqual([1, 0]);
		expect(parseKeepIndices('not json', 2)).toEqual([]);
		expect(parseKeepIndices('{"keep":[9]}', 2)).toEqual([]);
	});
});

describe('outline format', () => {
	it('formats symbol ranges for read tool', () => {
		const block = formatOutlineBlock(
			[
				{ name: 'Cart', kind: 'Class', startLine: 1, endLine: 80, depth: 0 },
				{ name: 'Total', kind: 'Method', startLine: 10, endLine: 25, depth: 1 },
			],
			40
		);
		expect(block).toContain('OUTLINE');
		expect(block).toContain('Cart (Class) L1-80');
		expect(block).toContain('Total (Method) L10-25');
	});
});

describe('assembleContext items', () => {
	it('drops low-priority items instead of truncating mid-item', () => {
		const assembled = assembleContext(
			[
				{
					kind: 'retrieve',
					priority: 70,
					content: '### RETRIEVE',
					items: [
						{ text: '### RETRIEVE', priority: 200 },
						{ text: 'HIT_HIGH ' + 'x'.repeat(200), priority: 90 },
						{ text: 'HIT_LOW ' + 'y'.repeat(200), priority: 10 },
					],
				},
			],
			{ total: 200, alloc: { retrieve: 0.5 } }
		);
		expect(assembled.markdown).toContain('HIT_HIGH');
		// With a tiny budget, the low-priority hit may be omitted entirely.
		expect(assembled.included).toContain('retrieve');
	});

	it('does not truncate status when noTruncate is set', () => {
		const long = 'STATUS ' + 'z'.repeat(5000);
		const assembled = assembleContext(
			[{ kind: 'status', priority: 96, content: long, noTruncate: true }],
			{ total: 100, alloc: { status: 0.01 } }
		);
		expect(assembled.markdown).toBe(long);
		expect(assembled.markdown).not.toContain('truncated');
	});
});

describe('FILES ALREADY READ ledger', () => {
	it('merges overlapping ranges', () => {
		const ledger = formatReadLedger(
			new Map([
				[
					'src/a.ts',
					[
						{ start: 1, end: 120 },
						{ start: 100, end: 200 },
						{ start: 300, end: 380 },
					],
				],
			])
		);
		expect(ledger).toContain('src/a.ts: L1-200, L300-380');
	});

	it('embeds ledger in mid compact digest', () => {
		const messages: Array<{
			role: 'system' | 'user' | 'assistant' | 'tool';
			content: string;
			tool_call_id?: string;
			name?: string;
			tool_calls?: Array<{
				id: string;
				type: 'function';
				function: { name: string; arguments: string };
			}>;
		}> = [{ role: 'system', content: 'sys' }];
		for (let i = 0; i < 10; i++) {
			const id = `c${i}`;
			messages.push({
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id,
						type: 'function',
						function: { name: 'read', arguments: `{"path":"f${i}.ts"}` },
					},
				],
			});
			messages.push({
				role: 'tool',
				tool_call_id: id,
				name: 'read',
				content: `FILE f${i}.ts lines 1-10/10\n1|x`,
			});
		}
		messages.push({ role: 'assistant', content: 'done' });
		const next = midCompactMessages(messages, 'sys', {
			readLedger: 'src/a.ts: L1-120',
		});
		const user = next.find(m => m.role === 'user');
		expect(String(user?.content)).toContain('FILES ALREADY READ');
		expect(String(user?.content)).toContain('src/a.ts: L1-120');
	});
});

describe('explore mode', () => {
	it('registers as a read-oriented mode definition', () => {
		expect(EXPLORE_MODE.id).toBe('explore');
		expect(EXPLORE_MODE.systemPrompt).toMatch(/read-only/i);
		expect(EXPLORE_MODE.systemPrompt).toMatch(/path:startLine-endLine/);
	});
});
