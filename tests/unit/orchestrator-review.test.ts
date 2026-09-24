/**
 * Orchestrator (cards → plan → items) and review core (findings → BUGS.md).
 */

import * as path from 'path';
import {
	findCards,
	formatPlanReport,
	itemPrompt,
	nextItem,
	orderCards,
	parseDependsOn,
	parsePlanJson,
	planFromCards,
	planFromItems,
	resumablePlan,
	runPlan,
	selectCards,
	summarizeReply,
	wantsNewApp,
	type CardDoc,
	type OrchestratorFs,
	type Plan,
} from '../../extensions/codeforge/src/agent/orchestrator';
import {
	confirmFinding,
	dedupeFindings,
	formatBugsMd,
	isReviewableSource,
	parseCompilerSignals,
	parseFindings,
	pickCandidateFiles,
} from '../../extensions/codeforge/src/agent/reviewCore';

const card = (id: string, deps: string): CardDoc => ({
	id,
	path: `docs/${id}.md`,
	content: `# ${id} — Title ${id}\n\nDepende de: ${deps}\n\n- criterion`,
});

describe('orchestrator: cards', () => {
	it('parses Depende de / Depends on', () => {
		expect(parseDependsOn('# C05\n\nDepende de: C03, C04\n')).toEqual(['C03', 'C04']);
		expect(parseDependsOn('**Depends on:** c01')).toEqual(['C01']);
		expect(parseDependsOn('Depende de: —')).toEqual([]);
	});

	it('orders by dependencies, then by number', () => {
		const cards = [card('C03', 'C02'), card('C01', '—'), card('C02', 'C04'), card('C04', 'C01')];
		expect(orderCards(cards).map(c => c.id)).toEqual(['C01', 'C04', 'C02', 'C03']);
	});

	it('does not loop on cycles', () => {
		const cards = [card('C01', 'C02'), card('C02', 'C01')];
		expect(orderCards(cards).map(c => c.id)).toEqual(['C01', 'C02']);
	});

	it('selects ranges and explicit cards from the request', () => {
		const cards = ['C01', 'C02', 'C03', 'C04', 'C05'].map(id => card(id, '—'));
		expect(selectCards('implementa os cards C02 a C04', cards).map(c => c.id)).toEqual(['C02', 'C03', 'C04']);
		expect(selectCards('faz o C05 e o C01', cards).map(c => c.id)).toEqual(['C01', 'C05']);
		expect(selectCards('implementa os cards', cards)).toHaveLength(5);
	});

	it('finds cards in docs/ with an injected fs', () => {
		const root = '/ws';
		const files: Record<string, string> = {
			'/ws/docs/C01-solution.md': '# C01 Solution\nDepende de: —',
			'/ws/docs/C02.md': '# C02 Domain\nDepende de: C01',
			'/ws/docs/pricing.md': '# not a card',
		};
		const norm = (p: string) => p.replace(/\\/g, '/');
		const fsx: OrchestratorFs = {
			isDir: p => ['/ws', '/ws/docs'].includes(norm(p)),
			list: p => {
				const base = norm(p).replace(/\/$/, '');
				return Object.keys(files)
					.filter(f => path.posix.dirname(f) === base)
					.map(f => path.posix.basename(f));
			},
			readText: p => files[norm(p)],
		};
		const found = findCards(root, fsx);
		expect(found.map(c => [c.id, c.path])).toEqual([
			['C01', 'docs/C01-solution.md'],
			['C02', 'docs/C02.md'],
		]);
	});

	it('recognises new-application requests', () => {
		expect(wantsNewApp('Cria uma aplicação ASP.NET para gerir tarefas')).toBe(true);
		expect(wantsNewApp('create a REST api for orders')).toBe(true);
		expect(wantsNewApp('corrige o bug no Cart.cs')).toBe(false);
	});
});

describe('orchestrator: plan', () => {
	const cards = orderCards([card('C01', '—'), card('C02', 'C01'), card('C03', 'C01')]);

	it('builds items with dependencies and oracle acceptance', () => {
		const plan = planFromCards('implementa os cards', cards, true);
		expect(plan.items.map(i => [i.id, i.dependsOn, i.acceptance])).toEqual([
			['C01', [], 'oracle'],
			['C02', ['C01'], 'oracle'],
			['C03', ['C01'], 'oracle'],
		]);
		expect(plan.items[0].title).toBe('C01 — Title C01');
	});

	it('next item waits for dependencies', () => {
		const plan = planFromCards('x', cards, true);
		expect(nextItem(plan)?.id).toBe('C01');
		plan.items[0].status = 'blocked';
		expect(nextItem(plan)).toBeUndefined();
		plan.items[0].status = 'done';
		expect(nextItem(plan)?.id).toBe('C02');
	});

	it('item prompt carries the whole card, finished items and the previous error', () => {
		const plan = planFromCards('implementa os cards', cards, true);
		plan.items[0].status = 'done';
		plan.items[0].summary = 'Criada a solution';
		const item = plan.items[1];
		item.lastError = '### Oracle (item check): RED';
		const text = itemPrompt(plan, item, { cardContent: cards[1].content, oracleCommands: ['dotnet build x.slnx'] });
		expect(text).toContain('Item 2 of 3: C02');
		expect(text).toContain('Depende de: C01');
		expect(text).toContain('- C01 C01 — Title C01: Criada a solution');
		expect(text).toContain('Oracle (item check): RED');
		expect(text).toContain('dotnet build x.slnx');
		expect(text).toContain('blocked: <reason>');
	});

	it('runs items, retries once, then blocks and stops', async () => {
		const plan = planFromCards('x', cards, true);
		const calls: string[] = [];
		const saved: Plan[] = [];
		await runPlan(plan, {
			cancelled: () => false,
			save: p => {
				saved.push(JSON.parse(JSON.stringify(p)));
			},
			runItem: async item => {
				calls.push(`${item.id}#${item.attempts}`);
				if (item.id === 'C02') return { ok: false, reply: 'tentei', error: 'RED: CS0246' };
				return { ok: true, reply: `feito ${item.id}\nlinha 2` };
			},
		});
		expect(calls).toEqual(['C01#1', 'C02#1', 'C02#2']);
		expect(plan.items.map(i => i.status)).toEqual(['done', 'blocked', 'pending']);
		expect(plan.items[1].lastError).toBe('RED: CS0246');
		expect(saved.length).toBeGreaterThan(3);
		const report = formatPlanReport(plan);
		expect(report).toContain('1/3 done');
		expect(report).toContain('C02 is blocked');
	});

	it('blocked claim stops without a retry', async () => {
		const plan = planFromCards('x', cards, true);
		const calls: string[] = [];
		await runPlan(plan, {
			cancelled: () => false,
			save: () => undefined,
			runItem: async item => {
				calls.push(item.id);
				return { ok: false, reply: 'blocked: falta o SDK', blocked: 'falta o SDK' };
			},
		});
		expect(calls).toEqual(['C01']);
		expect(plan.items[0].lastError).toBe('blocked: falta o SDK');
	});

	it('resumes an unfinished plan and gives blocked items another try', () => {
		const old = planFromCards('x', cards, true);
		old.items[0].status = 'done';
		old.items[1].status = 'blocked';
		old.items[1].attempts = 2;
		const resumed = resumablePlan(old, planFromCards('x', cards, true))!;
		expect(resumed.items.map(i => i.status)).toEqual(['done', 'pending', 'pending']);
		expect(resumed.items[1].attempts).toBe(0);
		old.items.forEach(i => (i.status = 'done'));
		expect(resumablePlan(old, planFromCards('x', cards, true))).toBeUndefined();
	});

	it('parses planning JSON and chains planned items', () => {
		const items = parsePlanJson('Aqui está:\n```json\n{"items":[{"title":"Solution","acceptance":"build ok"},{"title":"Domain"}]}\n```');
		expect(items).toEqual([
			{ title: 'Solution', criteria: 'build ok' },
			{ title: 'Domain', criteria: '' },
		]);
		const plan = planFromItems('cria app', items!, false);
		expect(plan.items.map(i => [i.id, i.dependsOn, i.acceptance])).toEqual([
			['P01', [], 'checks'],
			['P02', ['P01'], 'checks'],
		]);
		expect(parsePlanJson('sem json')).toBeUndefined();
	});

	it('summarizes replies to 5 lines with a marker', () => {
		const s = summarizeReply(['a', 'b', '', 'c', 'd', 'e', 'f', 'g'].join('\n'));
		expect(s.split('\n')).toEqual(['a', 'b', 'c', 'd', 'e', '…[+2 lines]']);
	});
});

describe('review core', () => {
	const file = [
		'namespace Acme;',
		'public static class Tax',
		'{',
		'    private static readonly Dictionary<string, decimal> Rates = new()',
		'    {',
		'        ["PT"] = 0.23m,',
		'        ["ES"] = 0.12m,',
		'    };',
		'}',
	].join('\n');

	it('filters reviewable sources', () => {
		expect(isReviewableSource('src/Acme/Tax.cs')).toBe(true);
		expect(isReviewableSource('tests/Acme.Tests/TaxTests.cs')).toBe(false);
		expect(isReviewableSource('src/Acme/obj/Debug/X.cs')).toBe(false);
		expect(isReviewableSource('docs/pricing.md')).toBe(false);
	});

	it('parses compiler warnings per file relative to root', () => {
		const m = parseCompilerSignals(
			'C:\\ws\\src\\Tax.cs(7,9): warning CS8602: Dereference of a possibly null reference. [C:\\ws\\src\\A.csproj]',
			'C:\\ws',
			'build'
		);
		expect([...m.keys()]).toEqual(['src/Tax.cs']);
		expect(m.get('src/Tax.cs')![0]).toMatchObject({ line: 7, code: 'CS8602', source: 'build' });
	});

	it('prefers files with signals, then the most referenced', () => {
		const files = [
			{ rel: 'src/Money.cs', text: 'class Money {}' },
			{ rel: 'src/Tax.cs', text: 'Money.Round2(x)' },
			{ rel: 'src/Cart.cs', text: 'Money Money Tax' },
			{ rel: 'tests/CartTests.cs', text: 'Cart Cart Cart' },
		];
		const signals = new Map([['src/Cart.cs', [{ line: 1, code: 'CS8602', msg: 'null', source: 'build' as const }]]]);
		expect(pickCandidateFiles(files, signals, 3)).toEqual(['src/Cart.cs', 'src/Money.cs', 'src/Tax.cs']);
	});

	it('parses JSON findings and the path:line fallback', () => {
		const json = parseFindings(
			'{"findings":[{"file":"src/Tax.cs","line":7,"kind":"contract","evidence":"[\\"ES\\"] = 0.12m","description":"ES VAT is 21%","confidence":0.9}]}',
			'src/Tax.cs'
		);
		expect(json).toHaveLength(1);
		expect(json[0]).toMatchObject({ line: 7, confidence: 0.9 });
		const lines = parseFindings('- src/Tax.cs:7 — IVA errado', 'src/Tax.cs');
		expect(lines[0]).toMatchObject({ file: 'src/Tax.cs', line: 7, description: 'IVA errado' });
	});

	it('confirms evidence near the claimed line and corrects the line', () => {
		const f = { file: 'src/Tax.cs', line: 5, kind: 'contract', evidence: '["ES"] = 0.12m', description: 'x', confidence: 0.7 };
		expect(confirmFinding(f, file)).toMatchObject({ line: 7, confirmed: true });
		expect(confirmFinding({ ...f, evidence: 'return total * 2;', confidence: 0.5 }, file)).toBeUndefined();
		expect(confirmFinding({ ...f, evidence: '', line: 99 }, file)).toBeUndefined();
	});

	it('dedupes nearby findings and formats BUGS.md with path:line', () => {
		const a = { file: 'src/Tax.cs', line: 7, kind: 'k', evidence: 'e', description: 'ES VAT', confidence: 0.9, confirmed: true };
		const b = { ...a, line: 8, confidence: 0.5 };
		const c = { ...a, file: 'src/Money.cs', line: 6, description: 'rounding' };
		const out = dedupeFindings([b, a, c]);
		expect(out).toHaveLength(2);
		const md = formatBugsMd(out, { files: ['src/Tax.cs', 'src/Money.cs'], signals: 0 });
		expect(md).toContain('- src/Tax.cs:7 — ES VAT');
		expect(md).toContain('- src/Money.cs:6 — rounding');
	});
});
