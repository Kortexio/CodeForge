/**
 * Policy Engine Tests
 */

import { PolicyEngine } from '../../../src/ai/policy/engine';

describe('PolicyEngine', () => {
    let policy: PolicyEngine;

    beforeEach(async () => {
        policy = new PolicyEngine('/tmp/opencodeide-test');
        await policy.initialize();
    });

    it('allows read operations', async () => {
        const result = await policy.checkToolCall({
            id: '1',
            name: 'read',
            arguments: { path: 'src/index.ts' },
        });
        expect(result.decision).toBe('allow');
    });

    it('requires approval for delete', async () => {
        const result = await policy.checkToolCall({
            id: '2',
            name: 'delete',
            arguments: { path: 'src/old.ts' },
        });
        expect(result.decision).toBe('approval');
    });

    it('requires approval for git push', async () => {
        const result = await policy.checkToolCall({
            id: '3',
            name: 'shell',
            arguments: { command: 'git push origin main' },
        });
        expect(result.decision).toBe('approval');
    });

    it('assesses critical risk for rm -rf', () => {
        const risk = policy.assessRisk({
            id: '4',
            name: 'shell',
            arguments: { command: 'rm -rf /' },
        });
        expect(risk).toBe('critical');
    });

    it('records session approval', async () => {
        const toolCall = {
            id: '5',
            name: 'shell',
            arguments: { command: 'npm install lodash' },
        };

        policy.recordApproval(toolCall, 'session');
        const result = await policy.checkToolCall(toolCall);
        expect(result.decision).toBe('allow');
    });
});
