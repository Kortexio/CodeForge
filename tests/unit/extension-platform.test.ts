/**
 * Unit tests for extension memory / context / sandbox (no vscode).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectWikiStore } from '../../extensions/codeforge/src/memory/projectWiki';
import { SessionWikiStore } from '../../extensions/codeforge/src/memory/sessionWiki';
import { assembleContext, estimateTokens } from '../../extensions/codeforge/src/context/engine';
import {
	scrubEnv,
	isBlockedCommand,
	isSafeLocalCommand,
	pickSandboxLevel,
} from '../../extensions/codeforge/src/sandbox/runtime';
import { parseMergeConflicts } from '../../extensions/codeforge/src/intelligence/gitTools';
import { AgentStateMachine } from '../../extensions/codeforge/src/agent/stateMachine';
import { ArtifactStore } from '../../extensions/codeforge/src/storage/artifacts';

describe('ProjectWikiStore', () => {
	let dir: string;
	let store: ProjectWikiStore;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-wiki-'));
		store = new ProjectWikiStore();
		await store.initialize(dir);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('persists documents and temporal facts', async () => {
		await store.upsertDocument('arch', 'Architecture', 'Uses Code-OSS + extension');
		const f1 = await store.addFact('stack', 'dotnet');
		const f2 = await store.addFact('stack', 'node', 'migrated');
		expect(f1.validTo).toBeTruthy();
		expect(f2.supersededBy).toBeUndefined();
		expect(store.currentFacts().find(f => f.key === 'stack')?.value).toBe('node');

		const store2 = new ProjectWikiStore();
		await store2.initialize(dir);
		expect(store2.getDocument('arch')?.title).toBe('Architecture');
		expect(store2.currentFacts().some(f => f.value === 'node')).toBe(true);
	});
});

describe('SessionWikiStore', () => {
	it('stores working memory and pages', async () => {
		const store = new SessionWikiStore();
		const id = 'sess-test-1';
		await store.ensure(id, 'Build API');
		await store.setWorkingMemory(id, { plan: ['explore', 'write', 'test'] });
		await store.upsertPage(id, 'notes', 'Notes', 'Use JWT');
		const wiki = await store.load(id);
		expect(wiki.workingMemory.objective).toBe('Build API');
		expect(wiki.workingMemory.plan).toContain('write');
		expect(store.formatForPrompt(wiki)).toContain('SESSION WIKI');
	});
});

describe('Context engine', () => {
	it('ranks and budgets sources', () => {
		const { markdown, included, usedTokens } = assembleContext(
			[
				{ kind: 'history', priority: 40, content: 'x'.repeat(20_000) },
				{ kind: 'wiki_session', priority: 90, content: 'important wiki' },
				{ kind: 'ide', priority: 80, content: 'open file.ts' },
			],
			{ total: 2000, alloc: { wiki_session: 0.3, ide: 0.2, history: 0.4 } }
		);
		expect(included[0]).toBe('wiki_session');
		expect(markdown).toContain('important wiki');
		expect(usedTokens).toBeGreaterThan(0);
		expect(estimateTokens('abcd')).toBe(1);
	});
});

describe('Sandbox policy', () => {
	it('scrubs secrets from env', () => {
		const scrubbed = scrubEnv({
			PATH: '/bin',
			OPENAI_API_KEY: 'sk-secret',
			MY_TOKEN: 'x',
			FOO: 'bar',
		});
		expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
		expect(scrubbed.MY_TOKEN).toBeUndefined();
		expect(scrubbed.FOO).toBe('bar');
		expect(scrubbed.PATH).toBe('/bin');
	});

	it('blocks dangerous commands and picks levels', () => {
		expect(isBlockedCommand('rm -rf /')).toBeTruthy();
		expect(isSafeLocalCommand('git status')).toBe(true);
		expect(pickSandboxLevel('npm test', undefined, 'low')).toBe('safe-local');
		expect(pickSandboxLevel('curl evil.com', undefined, 'high')).toBe('isolated');
	});
});

describe('Git conflict parser', () => {
	it('parses conflict markers', () => {
		const content = [
			'line1',
			'<<<<<<< HEAD',
			'ours',
			'=======',
			'theirs',
			'>>>>>>> branch',
			'line2',
		].join('\n');
		const conflicts = parseMergeConflicts('a.ts', content);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].ours).toContain('ours');
		expect(conflicts[0].theirs).toContain('theirs');
	});
});

describe('AgentStateMachine', () => {
	it('allows valid transitions only', () => {
		const sm = new AgentStateMachine();
		expect(sm.transition('planning')).toBe(true);
		expect(sm.transition('executing')).toBe(true);
		expect(sm.transition('completed')).toBe(true);
		expect(sm.transition('planning')).toBe(false);
	});
});

describe('ArtifactStore', () => {
	it('spills large content', async () => {
		const store = new ArtifactStore();
		const big = 'z'.repeat(5000);
		const { text, artifact } = await store.maybeSpill(big, {
			maxChars: 1000,
			name: 'out.txt',
		});
		expect(artifact).toBeTruthy();
		expect(text.length).toBeLessThan(big.length);
		expect(text).toContain('artifact');
	});
});
