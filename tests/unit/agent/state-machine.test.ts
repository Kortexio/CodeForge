/**
 * Agent State Machine Tests
 */

import { AgentStateMachine } from '../../../src/ai/agent/state-machine';

describe('AgentStateMachine', () => {
    let stateMachine: AgentStateMachine;

    beforeEach(() => {
        stateMachine = new AgentStateMachine();
    });

    describe('initial state', () => {
        it('should start in created state', () => {
            expect(stateMachine.getState()).toBe('created');
        });

        it('should have empty history', () => {
            expect(stateMachine.getHistory()).toHaveLength(0);
        });
    });

    describe('transitions', () => {
        it('should transition from created to planning on start', () => {
            const result = stateMachine.transition('start');
            expect(result).toBe(true);
            expect(stateMachine.getState()).toBe('planning');
        });

        it('should record transition in history', () => {
            stateMachine.transition('start');
            const history = stateMachine.getHistory();
            expect(history).toHaveLength(1);
            expect(history[0].from).toBe('created');
            expect(history[0].to).toBe('planning');
            expect(history[0].event).toBe('start');
        });

        it('should reject invalid transitions', () => {
            // Can't go directly from created to executing
            const result = stateMachine.transition('toolCall');
            expect(result).toBe(false);
            expect(stateMachine.getState()).toBe('created');
        });

        it('should handle complete workflow', () => {
            stateMachine.transition('start');
            expect(stateMachine.getState()).toBe('planning');

            stateMachine.transition('plan');
            expect(stateMachine.getState()).toBe('retrievingContext');

            stateMachine.transition('llmRequest');
            expect(stateMachine.getState()).toBe('executing');

            stateMachine.transition('complete');
            expect(stateMachine.getState()).toBe('completed');
        });
    });

    describe('canTransition', () => {
        it('should return true for valid transitions', () => {
            expect(stateMachine.canTransition('start')).toBe(true);
        });

        it('should return false for invalid transitions', () => {
            expect(stateMachine.canTransition('complete')).toBe(false);
        });
    });

    describe('terminal states', () => {
        it('should recognize completed as terminal', () => {
            stateMachine.transition('start');
            stateMachine.transition('plan');
            stateMachine.transition('llmRequest');
            stateMachine.transition('complete');
            expect(stateMachine.isTerminal()).toBe(true);
        });

        it('should recognize failed as terminal', () => {
            stateMachine.transition('fail');
            expect(stateMachine.isTerminal()).toBe(true);
        });

        it('should recognize cancelled as terminal', () => {
            stateMachine.transition('cancel');
            expect(stateMachine.isTerminal()).toBe(true);
        });
    });

    describe('reset', () => {
        it('should reset to initial state', () => {
            stateMachine.transition('start');
            stateMachine.transition('plan');
            stateMachine.reset();
            expect(stateMachine.getState()).toBe('created');
            expect(stateMachine.getHistory()).toHaveLength(0);
        });
    });

    describe('status messages', () => {
        it('should return appropriate status message', () => {
            expect(stateMachine.getStatusMessage()).toBe('Ready to start');
            
            stateMachine.transition('start');
            expect(stateMachine.getStatusMessage()).toBe('Planning task...');
        });
    });
});
