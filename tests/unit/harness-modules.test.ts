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
	mentionsErrorFile,
	toolNamesFor,
} from '../../extensions/codeforge/src/agent/toolsets';
import { claimsBuildOrTestGreen, parseBlockedClaim } from '../../extensions/codeforge/src/agent/nudges';
import { extractBuildErrorLines } from '../../extensions/codeforge/src/governance/guardrailEngine';
import * as fs from 'fs';
import { buildPriorAgentTranscript } from '../../extensions/codeforge/src/agent/priorContext';
import {
	cookbookLines,
	matchSkills,
	parseFrontmatter,
	type SkillDoc,
} from '../../extensions/codeforge/src/skills/skillsRulesLoader';

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

	it('limits tools in the weak profile and adds extras only when asked', () => {
		const explore = toolNamesFor('explore', 'o que faz?', { weakProfile: true, allNames: all });
		expect(explore.has('write')).toBe(false);
		expect(explore.has('git_status')).toBe(false);
		const withGit = toolNamesFor('implement', 'faz commit no git', { weakProfile: true, allNames: all });
		expect(withGit.has('git_status')).toBe(true);
		expect(withGit.has('mcp_call')).toBe(false);
		expect(toolNamesFor('explore', 'x', { weakProfile: false, allNames: all }).size).toBe(all.length);
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
