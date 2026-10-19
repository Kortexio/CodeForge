/**
 * A plain-chat bug-hunt request runs the review pipeline (one sub-run per file in scope).
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import type { ScriptedStep } from './support/scriptedModel';
import { callTool } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

const FILES = {
	'docs/pricing.md': '# Pricing\n\nES VAT is 21%.\n',
	'src/billing/tax.js': "const RATES = { ES: 0.12, PT: 0.23 };\nexports.vat = c => RATES[c];\n",
	'src/billing/money.js': 'exports.round2 = n => Math.round(n * 100) / 100;\n',
	'src/billing/coupons.js': "// reads config/coupons.json\nexports.load = j => JSON.parse(j).map(c => c.Code);\n",
	'config/coupons.json': '[{"code":"SAVE10","value":10}]\n',
	'lib/unrelated.js': 'exports.noop = () => undefined;\n',
	'tests/tax.test.js': "require('../src/billing/tax');\n",
};

function lastUserText(body: { messages?: unknown[] }): string {
	const msgs = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
	const user = [...msgs].reverse().find(m => m.role === 'user');
	return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
}

const reviewer: ScriptedStep = body => {
	const text = lastUserText(body);
	if (/Review `src\/billing\/tax\.js`/.test(text)) {
		return {
			content: JSON.stringify({
				findings: [
					{
						file: 'src/billing/tax.js',
						line: 1,
						kind: 'contract vs docs/',
						evidence: 'const RATES = { ES: 0.12, PT: 0.23 };',
						description: 'ES VAT is 12% instead of 21% (docs/pricing.md)',
						confidence: 0.9,
					},
				],
			}),
		};
	}
	return { content: '{"findings":[]}' };
};

describe('review routing', () => {
	it('runs the review pipeline for a bug-hunt request, scoped to the named folder', async () => {
		const result = await runLoop({
			files: FILES,
			task: 'Review the code in `src/billing` against `docs/pricing.md` and find the bugs. Write BUGS.md at the root.',
			routed: true,
			script: Array.from({ length: 8 }, () => reviewer),
			maxSteps: 8,
			isolated: true,
		});

		const prompts = new Map<string, string>();
		for (const r of result.requests) {
			const text = lastUserText(r.body);
			const file = /Review `([^`]+)` for bugs/.exec(text)?.[1];
			if (file && !prompts.has(file)) prompts.set(file, text);
		}
		expect(new Set(prompts.keys())).toEqual(new Set(['src/billing/tax.js', 'src/billing/money.js', 'src/billing/coupons.js']));
		expect(prompts.get('src/billing/coupons.js')).toMatch(/config\/coupons\.json[\s\S]*"code":"SAVE10"/);
		expect(prompts.get('src/billing/money.js')).not.toMatch(/Data files this code reads/);
		expect(prompts.get('src/billing/tax.js')).toMatch(/node -e/);

		const firstTools = (result.requests[0]?.body.tools ?? []) as Array<{ function?: { name?: string } }>;
		const toolNames = new Set(firstTools.map(t => t.function?.name).filter(Boolean));
		expect(toolNames.has('shell')).toBe(true);
		expect(toolNames.has('write')).toBe(false);
		expect(toolNames.has('edit')).toBe(false);

		const bugs = result.files.get('BUGS.md') ?? '';
		expect(bugs).toMatch(/src\/billing\/tax\.js:1 — ES VAT is 12% instead of 21%/);
		expect(bugs).not.toMatch(/unconfirmed/);
		expect(result.reply).toMatch(/^Review done: 1 bug\(s\) in 3 file\(s\)/);
	}, 60_000);

	it('lets a review sub-run execute a boundary check via shell before reporting', async () => {
		const files = {
			'docs/rates.md': '# Rates\n\nBulk: 10+ → 5%, 25+ → 8%, 50+ → 12% (highest applicable).\n',
			'src/bulk.js': [
				'function bulkRate(units) {',
				'  const tiers = [[10, 0.05], [25, 0.08], [50, 0.12]];',
				'  for (const [min, rate] of tiers) if (units >= min) return rate;',
				'  return 0;',
				'}',
				'module.exports = { bulkRate };',
				'',
			].join('\n'),
		};
		const result = await runLoop({
			files,
			task: 'Review `src/bulk.js` against `docs/rates.md` and find the bugs. Write BUGS.md.',
			routed: true,
			script: [
				body => {
					const text = lastUserText(body);
					expect(text).toMatch(/Review `src\/bulk\.js`/);
					return callTool('shell', {
						command: 'node -e "const {bulkRate}=require(\'./src/bulk.js\'); console.log(bulkRate(60))"',
					})(body);
				},
				() => ({
					content: JSON.stringify({
						findings: [
							{
								file: 'src/bulk.js',
								line: 3,
								kind: 'boundaries and off-by-one',
								evidence: 'if (units >= min) return rate;',
								description:
									'60 units returns 0.05 (5%) instead of 0.12 (12%); tiers are checked ascending and return the first match',
								confidence: 0.95,
							},
						],
					}),
				}),
			],
			maxSteps: 8,
			isolated: true,
		});
		expect(result.activities.some(a => a.tool === 'shell')).toBe(true);
		expect(result.files.get('BUGS.md') ?? '').toMatch(/src\/bulk\.js:3 — 60 units returns 0\.05/);
		expect(result.reply).toMatch(/^Review done: 1 bug/);
	}, 60_000);

	it('keeps a fix request on the normal loop', async () => {
		const result = await runLoop({
			files: FILES,
			task: 'Find the bugs in `src/billing` and fix them.',
			routed: true,
			script: [() => ({ content: 'No change needed.' })],
			maxSteps: 4,
			isolated: true,
		});
		expect(result.requests.some(r => /Review `[^`]+` for bugs/.test(lastUserText(r.body)))).toBe(false);
		expect(result.files.has('BUGS.md')).toBe(false);
	}, 60_000);
});
