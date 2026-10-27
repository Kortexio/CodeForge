/**
 * Compaction builds a context packet. The headless editor mock has no tab API;
 * that read must not throw, or the bench records loopExit error and drops the score.
 */
jest.mock('vscode', () => {
	const base = require('../support/vscodeFsMock');
	return {
		...base,
		window: {
			...base.window,
			tabGroups: undefined,
		},
		workspace: new Proxy(base.workspace, {
			get(target, prop, receiver) {
				if (prop === 'textDocuments') return undefined;
				return Reflect.get(target, prop, receiver);
			},
		}),
	};
});

import { buildContextPacket } from '../../extensions/codeforge/src/agent/contextPacket';

describe('context packet without editor tabs', () => {
	it('builds a packet when tabGroups and textDocuments are missing', async () => {
		const packet = await buildContextPacket({
			task: 'Apply the coupon rules from the pricing doc.',
			workspaceRoot: process.cwd(),
			includeRetrieve: false,
			includePrefetch: false,
		});
		expect(packet.markdown).toContain('IDE STATE');
		expect(packet.markdown).toContain('Open: (none)');
	}, 30_000);
});
