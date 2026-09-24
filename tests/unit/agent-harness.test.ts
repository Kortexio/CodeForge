/**
 * Unit tests for the agent harness: lexical retrieve, context overflow, stable facts, prior transcript.
 */

import {
	lexicalSearch,
	minTermsRequired,
	queryTerms,
	scoreFileText,
} from '../../extensions/codeforge/src/intelligence/lexicalScore';
import {
	calibratedTokens,
	isContextOverflowError,
	parseOverflowTokens,
	updateTokenCalibration,
} from '../../extensions/codeforge/src/agent/contextOverflow';
import {
	extractFactsFromTool,
	isPlausiblePath,
	normalizeFacts,
} from '../../extensions/codeforge/src/agent/stableFacts';
import { buildPriorAgentTranscript } from '../../extensions/codeforge/src/agent/priorContext';
import type { ToolTraceEntry } from '../../extensions/codeforge/src/sessions/sessionStore';
import {
	dropOrphanToolResults,
	filterAnthropicToolResults,
	midCompactMessages,
	normalizeToolProtocolHistory,
	safeMidCompactTailStart,
} from '../../extensions/codeforge/src/agent/toolHistory';
import {
	buildDiskPromptSection,
	expandBraces,
	matchGlob,
	parseFrontmatter,
	parseGlobs,
	type SkillDoc,
} from '../../extensions/codeforge/src/skills/skillsRulesLoader';
import { buildGovernancePrompt } from '../../extensions/codeforge/src/governance/governanceStore';
import { builtinGovernanceState } from '../../extensions/codeforge/src/governance/builtins';

describe('lexical retrieve', () => {
	const files = [
		{
			path: 'src/Domain/TaskProfile.cs',
			text: [
				'namespace Router.Domain;',
				'',
				'public sealed record TaskProfile(',
				'    TaskType Type,',
				'    IReadOnlyList<string> RequiredCapabilities);',
			].join('\n'),
		},
		{
			path: 'docs/routing.md',
			text: [
				'# Routing',
				'',
				'Tasks are routed by capability.',
				'',
				'## Task profile',
				'A task profile lists the required capabilities of a task type.',
			].join('\n'),
		},
		{
			path: 'src/Other.cs',
			text: 'public class Other { /* nothing about the topic */ }',
		},
	];

	it('splits the query into distinct meaningful terms', () => {
		expect(queryTerms('How does the TaskProfile use RequiredCapabilities?')).toEqual([
			'taskprofile',
			'requiredcapabilities',
		]);
		expect(queryTerms('a an of')).toEqual([]);
	});

	it('scales the required term count with query length', () => {
		expect(minTermsRequired(1)).toBe(1);
		expect(minTermsRequired(2)).toBe(1);
		expect(minTermsRequired(3)).toBe(2);
		expect(minTermsRequired(8)).toBe(3);
	});

	it('finds multi-word queries that are not a literal phrase in any file', () => {
		const hits = lexicalSearch(files, 'TaskProfile RequiredCapabilities record', 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].path).toBe('src/Domain/TaskProfile.cs');
		expect(hits[0].startLine).toBe(2);
		expect(hits[0].text).toContain('RequiredCapabilities');
		expect(hits.some(h => h.path === 'src/Other.cs')).toBe(false);
	});

	it('includes markdown docs and ranks headings', () => {
		const hits = lexicalSearch(files, 'task profile capabilities', 5);
		expect(hits.some(h => h.path === 'docs/routing.md')).toBe(true);
	});

	it('returns several non-overlapping hits from one file', () => {
		const text = Array.from({ length: 60 }, (_, i) =>
			i === 5 || i === 40 ? 'function parseConfig(configPath) {}' : `line ${i}`
		).join('\n');
		const hits = scoreFileText({ path: 'a.ts', text }, queryTerms('parseConfig configPath'), {
			maxHits: 3,
		});
		expect(hits.map(h => h.startLine)).toEqual([5, 40]);
	});

	it('relaxes to single-term matches when nothing clears the threshold', () => {
		const hits = lexicalSearch(files, 'RequiredCapabilities zebra giraffe', 3);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].text).toContain('RequiredCapabilities');
	});

	it('skips binary content', () => {
		expect(scoreFileText({ path: 'x.bin', text: 'task\u0000profile' }, ['task'])).toEqual([]);
	});
});

describe('context overflow', () => {
	const llamaError =
		'{"error":{"code":400,"message":"request (32789 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":32789,"n_ctx":32768}}';

	it('detects llama.cpp and OpenAI-style overflow errors', () => {
		expect(isContextOverflowError(400, llamaError)).toBe(true);
		expect(
			isContextOverflowError(400, "This model's maximum context length is 32768 tokens")
		).toBe(true);
		expect(isContextOverflowError(400, 'invalid tool_call_id')).toBe(false);
		expect(isContextOverflowError(401, llamaError)).toBe(false);
	});

	it('parses prompt and window sizes', () => {
		expect(parseOverflowTokens(llamaError)).toEqual({ prompt: 32789, ctx: 32768 });
		expect(parseOverflowTokens('exceed_context 32789 > 32768')).toEqual({
			prompt: 32789,
			ctx: 32768,
		});
	});

	it('calibrates the chars/4 estimate against real prompt tokens', () => {
		let c = 1;
		c = updateTokenCalibration(c, 20000, 25000);
		expect(c).toBe(1.25);
		expect(calibratedTokens(24000, c)).toBe(30000);
		// no usage reported: unchanged
		expect(updateTokenCalibration(c, 20000, undefined)).toBe(c);
		// drops slowly, rises immediately
		const lower = updateTokenCalibration(c, 20000, 20000);
		expect(lower).toBeLessThan(c);
		expect(lower).toBeGreaterThan(1);
		expect(updateTokenCalibration(1, 1000, 100000)).toBe(2.5);
	});
});

describe('stable facts', () => {
	const advice =
		'### ADVICE\nYou listed this folder 3 times. Prefer retrieve, read a known path, or write.\n(5 explore tools). CONTEXT PACKET + prior transcript already have it.';

	it('ignores advice appended to list output', () => {
		const facts = extractFactsFromTool(
			undefined,
			'list',
			{ path: 'src' },
			`[file] a.ts\n[dir] lib\n\n${advice}`,
			true
		);
		expect(facts.keyPaths).toEqual(expect.arrayContaining(['src', 'src/a.ts', 'src/lib']));
		expect(facts.keyPaths.some(p => /Prefer|ADVICE|explore/.test(p))).toBe(false);
	});

	it('rejects prose and keeps real paths', () => {
		expect(isPlausiblePath('src/Domain/TaskProfile.cs')).toBe(true);
		expect(isPlausiblePath('C:/Program Files/App/app.exe')).toBe(true);
		expect(isPlausiblePath('src/times. Prefer retrieve, read a known path')).toBe(false);
		expect(isPlausiblePath('### ADVICE')).toBe(false);
		expect(isPlausiblePath('src/(5 explore tools). CONTEXT PACKET + prior')).toBe(false);
	});

	it('cleans already-polluted facts on load', () => {
		const facts = normalizeFacts({
			keyPaths: ['src/a.ts', 'src/times. Prefer retrieve, read a known path, or write.'],
		});
		expect(facts.keyPaths).toEqual(['src/a.ts']);
	});
});

describe('buildPriorAgentTranscript', () => {
	let n = 0;
	const trace = (
		name: string,
		args: Record<string, unknown>,
		output = `${name} output`,
		success = true
	): ToolTraceEntry => ({
		id: `t${n++}`,
		name,
		arguments: args,
		output,
		success,
		durationMs: 1,
		timestamp: new Date(0).toISOString(),
	});

	it('returns null without useful traces', () => {
		expect(buildPriorAgentTranscript([], 10000)).toBeNull();
		expect(buildPriorAgentTranscript([trace('read', { path: 'a' }, 'x', false)], 10000)).toBeNull();
	});

	it('indexes everything but only includes the hot set since the last write', () => {
		const traces: ToolTraceEntry[] = [];
		for (let i = 0; i < 100; i++) {
			traces.push(trace('read', { path: `src/old${i}.ts` }, `OLD-BODY-${i}`));
		}
		traces.push(trace('write', { path: 'src/new.ts' }, 'wrote new'));
		traces.push(trace('read', { path: 'src/hot.ts' }, 'HOT-1'));
		traces.push(trace('read', { path: 'src/hot.ts', startLine: 121 }, 'HOT-2'));
		traces.push(trace('shell', { command: 'npm test' }, 'tests failed'));

		const out = buildPriorAgentTranscript(traces, 10000, 32768, 'did stuff')!;
		expect(out).toContain('Rolling summary');
		expect(out).toContain('src/old0.ts');
		expect(out).not.toContain('OLD-BODY');
		expect(out).toContain('#### write src/new.ts');
		expect(out).toContain('HOT-2');
		expect(out).not.toContain('HOT-1');
		expect(out).toContain('startLine=121');
		expect(out).toContain('tests failed');
	});

	it('respects the char budget', () => {
		const big = 'x'.repeat(5000);
		const traces = Array.from({ length: 10 }, (_, i) => trace('read', { path: `f${i}.ts` }, big));
		const out = buildPriorAgentTranscript(traces, 3000, 32768)!;
		expect(out.length).toBeLessThan(3000 + 200);
		expect(out).toContain('hot-set truncated');
	});
});

describe('tool history hygiene', () => {
	type Msg = Parameters<typeof normalizeToolProtocolHistory>[0][number];

	const assistant = (ids: string[]): Msg => ({
		role: 'assistant',
		content: '',
		tool_calls: ids.map(id => ({
			id,
			type: 'function',
			function: { name: 'read', arguments: '{}' },
		})),
	});
	const tool = (id: string, content = 'ok'): Msg => ({
		role: 'tool',
		tool_call_id: id,
		name: 'read',
		content,
	});

	it('drops orphan tool results at the start of history', () => {
		const messages: Msg[] = [
			{ role: 'system', content: 'sys' },
			tool('orphan_1', 'exit 1\ncwd: workspace\n\nerror CS0001: The type or namespace failed to build.'),
			{ role: 'user', content: 'continue' },
			assistant(['a1']),
			tool('a1', 'FILE x'),
		];
		const n = dropOrphanToolResults(messages);
		expect(n).toBeGreaterThan(0);
		expect(messages.some(m => m.role === 'tool' && m.tool_call_id === 'orphan_1')).toBe(false);
		expect(
			messages.some(m => m.role === 'user' && String(m.content).includes('Earlier tool result'))
		).toBe(true);
		expect(messages.some(m => m.role === 'user' && String(m.content).includes('error CS0001'))).toBe(
			true
		);
		normalizeToolProtocolHistory(messages);
		expect(messages.filter(m => m.role === 'tool').every(m => m.tool_call_id === 'a1')).toBe(
			true
		);
	});

	it('keeps mid-compact tail off lone tool messages', () => {
		const messages: Msg[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
			assistant(['old1']),
			tool('old1', 'old body'),
			{ role: 'user', content: 'nudge' },
			assistant(['keep1']),
			tool('keep1', 'keep body'),
		];
		// Force preferFrom onto the tool after keep assistant
		const prefer = messages.length - 1; // tool keep1
		const start = safeMidCompactTailStart(messages, prefer);
		expect(messages[start].role).not.toBe('tool');
		expect(start).toBeLessThanOrEqual(messages.length - 2);

		const compacted = midCompactMessages(messages, 'sys');
		const firstTool = compacted.findIndex(m => m.role === 'tool');
		if (firstTool >= 0) {
			expect(compacted[firstTool - 1]?.role).toBe('assistant');
		}
	});

	it('filters Anthropic tool_result without matching tool_use', () => {
		const converted = [
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }],
			},
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'ok', name: 'read', input: {} }],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'ok', content: 'y' },
					{ type: 'tool_result', tool_use_id: 'ghost', content: 'z' },
				],
			},
		];
		const out = filterAnthropicToolResults(converted);
		expect(out[0].role).toBe('assistant');
		const last = out[out.length - 1].content as Array<{ tool_use_id: string }>;
		expect(last.map(c => c.tool_use_id)).toEqual(['ok']);
	});
});

describe('skills/rules frontmatter', () => {
	it('parses brace globs without splitting inside {}', () => {
		const { meta } = parseFrontmatter(
			[
				'---',
				'globs: ["**/*.{cs,ts,tsx,js,jsx,py}"]',
				'alwaysApply: false',
				'---',
				'body',
			].join('\n')
		);
		const globs = parseGlobs(meta.globs);
		expect(globs).toEqual(['**/*.{cs,ts,tsx,js,jsx,py}']);
		expect(matchGlob(globs[0], 'src/Foo.cs')).toBe(true);
		expect(matchGlob(globs[0], 'src/a.ts')).toBe(true);
		expect(matchGlob(globs[0], 'readme.md')).toBe(false);
	});

	it('parses block paths lists and BOM', () => {
		const raw =
			'\uFEFF---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\nalwaysApply: false\n---\nrule body';
		const { meta, body } = parseFrontmatter(raw);
		expect(body).toBe('rule body');
		const globs = parseGlobs(meta.paths ?? meta.globs);
		expect(globs).toEqual(['**/*.ts', '**/*.tsx']);
		expect(matchGlob(globs[0], 'src/a.ts')).toBe(true);
		expect(matchGlob(globs[0], 'src/a.cs')).toBe(false);
	});

	it('expands braces in globToRegExp via matchGlob', () => {
		expect(expandBraces('**/*.{cs,ts}')).toEqual(['**/*.cs', '**/*.ts']);
		expect(matchGlob('src/**/*.{cshtml,razor}', 'src/Pages/Index.cshtml')).toBe(true);
	});

});

describe('instruction blocks are never cut', () => {
	const longSkill: SkillDoc = {
		id: 'global:big',
		scope: 'global',
		title: 'Big skill',
		description: 'Templates for csproj files.',
		content: '# Big\n\n' + 'Use this template when creating a project. '.repeat(200),
		triggers: ['Big skill', 'csproj'],
		filePath: 'C:/skills/big.md',
	};
	const smallSkill: SkillDoc = {
		id: 'global:small',
		scope: 'global',
		title: 'Small skill',
		content: 'Run dotnet test after edits.',
		triggers: ['Small skill'],
	};

	it('disk skills go in whole or as description + read pointer', () => {
		const out = buildDiskPromptSection([longSkill, smallSkill], [], 800);
		expect(out).toContain('Run dotnet test after edits.');
		expect(out).toContain('Templates for csproj files.');
		expect(out).toContain('read `C:/skills/big.md`');
		expect(out).not.toMatch(/truncated/i);
		expect(out).not.toContain('Use this template when creating a project.');
	});

	it('governance prompt keeps every included block complete', () => {
		const state = builtinGovernanceState();
		const out = buildGovernancePrompt(state, 'fix the dotnet build error CS0246 in razor pages', {
			forceSkillIds: ['skill.harness-weak-models'],
			charBudget: 100000,
		});
		for (const s of state.skills) {
			if (out.includes(`### ${s.title}\n`)) {
				expect(out).toContain(s.content.trim());
			}
		}
		for (const r of state.rules) {
			expect(out).toContain(r.content.trim());
		}
		expect(out).not.toMatch(/Hard guardrails/);
	});

	it('governance prompt falls back to descriptions instead of cutting', () => {
		const state = builtinGovernanceState();
		const out = buildGovernancePrompt(state, 'implement feature', { charBudget: 700 });
		for (const block of out.split(/\n(?=### )/).slice(1)) {
			const title = /^### (.+)\n/.exec(block)?.[1];
			const skill = state.skills.find(s => s.title === title);
			expect(skill).toBeDefined();
			const body = block.slice(block.indexOf('\n') + 1).trim();
			expect([skill!.content.trim(), skill!.description!.trim()]).toContain(body);
		}
	});

	it('builtin texts agree with the tool surface (no stub-then-patch, no plan-first)', () => {
		const state = builtinGovernanceState();
		const all = [...state.skills, ...state.rules].map(x => x.content).join('\n');
		expect(all).not.toMatch(/stub/i);
		expect(all).not.toMatch(/task-plan/);
		expect(all).not.toMatch(/\bDo NOT\b|\bREQUIRED\b|\bNEVER\b/);
	});
});
