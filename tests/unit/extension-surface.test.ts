import {
	AgentModeRegistry,
	toolVisibleInMode,
} from '../../extensions/codeforge/src/agent/agentModes';
import {
	GateRegistry,
	decideGates,
	enabledGates,
	type GateSession,
	type GuardrailGate,
} from '../../extensions/codeforge/src/governance/gateRegistry';
import { skillsMatchingHints } from '../../extensions/codeforge/src/skills/skillsRulesLoader';

function session(): GateSession {
	return { notes: [] };
}

describe('extension gates', () => {
	it('uses the settings row when present, otherwise defaultEnabled', () => {
		const gates: GuardrailGate[] = [
			{ id: 'on-by-default', title: 'A', description: 'a', defaultEnabled: true },
			{ id: 'off-by-default', title: 'B', description: 'b', defaultEnabled: false },
			{ id: 'forced-off', title: 'C', description: 'c', defaultEnabled: true },
		];
		const active = enabledGates(gates, [{ gateId: 'forced-off', enabled: false }]);
		expect(active.map(g => g.id)).toEqual(['on-by-default']);
	});

	it('blocks on the first block and merges approval reasons', async () => {
		const gates: GuardrailGate[] = [
			{
				id: 'ask',
				title: 'Ask',
				description: '',
				defaultEnabled: true,
				beforeTool: () => ({ action: 'require-approval', reason: 'confirm write' }),
			},
			{
				id: 'stop',
				title: 'Stop',
				description: '',
				defaultEnabled: true,
				beforeTool: () => ({ action: 'block', reason: 'prod is closed' }),
			},
			{
				id: 'later',
				title: 'Later',
				description: '',
				defaultEnabled: true,
				beforeTool: () => {
					throw new Error('should not run');
				},
			},
		];
		const blocked = await decideGates(gates, session(), {
			name: 'write',
			args: {},
			risk: 'local-write',
		});
		expect(blocked).toEqual({ action: 'block', reason: 'prod is closed' });

		const askOnly = await decideGates(
			[
				{
					id: 'a',
					title: 'A',
					description: '',
					defaultEnabled: true,
					beforeTool: () => ({ action: 'require-approval', reason: 'one' }),
				},
				{
					id: 'b',
					title: 'B',
					description: '',
					defaultEnabled: true,
					beforeTool: () => ({ action: 'require-approval', reason: 'two' }),
				},
			],
			session(),
			{ name: 'shell', args: {}, risk: 'shell' }
		);
		expect(askOnly).toEqual({ action: 'require-approval', reason: 'one two' });
	});

	it('runs beforeFinish when no tool call is passed', async () => {
		const s = session();
		const decision = await decideGates(
			[
				{
					id: 'finish',
					title: 'Finish',
					description: '',
					defaultEnabled: true,
					beforeFinish: sess => {
						sess.notes.push('checked');
						return { action: 'block', reason: 'tests are red' };
					},
				},
			],
			s
		);
		expect(decision).toEqual({ action: 'block', reason: 'tests are red' });
		expect(s.notes).toEqual(['checked']);
	});

	it('registers and disposes on the registry', () => {
		const reg = new GateRegistry();
		const d = reg.register({
			id: 'ext.sample',
			title: 'Sample',
			description: '',
			defaultEnabled: true,
		});
		expect(reg.get('ext.sample')?.title).toBe('Sample');
		d.dispose();
		expect(reg.get('ext.sample')).toBeUndefined();
	});
});

describe('agent modes', () => {
	it('activates a registered mode and clears it on dispose', () => {
		const reg = new AgentModeRegistry();
		const d = reg.register({
			id: 'zuora',
			title: 'Zuora Workflow',
			systemPrompt: 'Use Zuora tools.',
			toolNamespaces: ['zuora'],
			skillHints: ['zuora-billing'],
		});
		expect(reg.activate('zuora')?.title).toBe('Zuora Workflow');
		expect(reg.active()?.systemPrompt).toBe('Use Zuora tools.');
		expect(() => reg.activate('missing')).toThrow(/Unknown agent mode/);
		d.dispose();
		expect(reg.active()).toBeUndefined();
		reg.activate(null);
		expect(reg.active()).toBeUndefined();
	});

	it('filters namespaced tools and keeps unscoped ones', () => {
		const mode = { id: 'zuora', title: 'Zuora', toolNamespaces: ['zuora'] };
		expect(toolVisibleInMode({ namespace: 'zuora' }, mode)).toBe(true);
		expect(toolVisibleInMode({ namespace: 'github' }, mode)).toBe(false);
		expect(toolVisibleInMode({}, mode)).toBe(true);
		expect(toolVisibleInMode({ namespace: 'github' }, undefined)).toBe(true);
	});
});

describe('skill hints', () => {
	const skills = [
		{ id: 'skill.billing', title: 'Billing', triggers: ['zuora invoice'] },
		{ id: 'skill.other', title: 'Other', triggers: ['unrelated'] },
	];

	it('matches id, title, or trigger and ignores short hints', () => {
		expect(skillsMatchingHints(skills, ['zuora invoice']).map(s => s.id)).toEqual(['skill.billing']);
		expect(skillsMatchingHints(skills, ['Billing']).map(s => s.id)).toEqual(['skill.billing']);
		expect(skillsMatchingHints(skills, ['x', ''])).toEqual([]);
	});
});
