/**
 * OpenCodeIDE - Agent State Machine
 * 
 * Formal state machine for agent lifecycle management.
 * Based on ContextMemory's AgentStateMachine architecture.
 */

import { AgentState, AgentEvent } from '../types.js';

interface StateTransition {
    from: AgentState[];
    to: AgentState;
}

const STATE_TRANSITIONS: Record<AgentEvent, StateTransition> = {
    start: {
        from: ['created'],
        to: 'planning',
    },
    plan: {
        from: ['planning', 'observing', 'recovering', 'compacting'],
        to: 'retrievingContext',
    },
    compact: {
        from: ['executing', 'observing'],
        to: 'compacting',
    },
    llmRequest: {
        from: ['retrievingContext', 'planning'],
        to: 'executing',
    },
    toolCall: {
        from: ['executing'],
        to: 'waitingForTool',
    },
    toolResult: {
        from: ['waitingForTool', 'waitingForApproval'],
        to: 'observing',
    },
    validate: {
        from: ['observing'],
        to: 'validating',
    },
    awaitHuman: {
        from: ['waitingForTool', 'executing'],
        to: 'waitingForApproval',
    },
    delegate: {
        from: ['executing', 'waitingForTool'],
        to: 'delegating',
    },
    recover: {
        from: ['executing', 'waitingForTool', 'validating', 'delegating'],
        to: 'recovering',
    },
    complete: {
        from: ['executing', 'validating', 'observing'],
        to: 'completed',
    },
    fail: {
        from: ['created', 'planning', 'retrievingContext', 'executing', 'waitingForTool', 'observing', 'validating', 'recovering', 'waitingForApproval', 'delegating', 'compacting'],
        to: 'failed',
    },
    cancel: {
        from: ['created', 'planning', 'retrievingContext', 'executing', 'waitingForTool', 'observing', 'validating', 'recovering', 'waitingForApproval', 'delegating', 'compacting'],
        to: 'cancelled',
    },
};

/**
 * Agent State Machine
 * 
 * Manages formal state transitions for the agent lifecycle
 */
export class AgentStateMachine {
    private state: AgentState = 'created';
    private history: Array<{ from: AgentState; to: AgentState; event: AgentEvent; timestamp: Date }> = [];

    /**
     * Get current state
     */
    getState(): AgentState {
        return this.state;
    }

    /**
     * Get state history
     */
    getHistory(): Array<{ from: AgentState; to: AgentState; event: AgentEvent; timestamp: Date }> {
        return [...this.history];
    }

    /**
     * Check if a transition is valid
     */
    canTransition(event: AgentEvent): boolean {
        const transition = STATE_TRANSITIONS[event];
        if (!transition) return false;
        return transition.from.includes(this.state);
    }

    /**
     * Attempt to transition to a new state
     */
    transition(event: AgentEvent): boolean {
        const transition = STATE_TRANSITIONS[event];
        
        if (!transition) {
            console.warn(`Unknown event: ${event}`);
            return false;
        }

        if (!transition.from.includes(this.state)) {
            console.warn(`Invalid transition: ${this.state} -> ${event}`);
            return false;
        }

        const from = this.state;
        this.state = transition.to;

        this.history.push({
            from,
            to: this.state,
            event,
            timestamp: new Date(),
        });

        return true;
    }

    /**
     * Reset to initial state
     */
    reset(): void {
        this.state = 'created';
        this.history = [];
    }

    /**
     * Check if the agent is in a terminal state
     */
    isTerminal(): boolean {
        return ['completed', 'failed', 'cancelled'].includes(this.state);
    }

    /**
     * Check if the agent is waiting for external input
     */
    isWaiting(): boolean {
        return ['waitingForTool', 'waitingForApproval'].includes(this.state);
    }

    /**
     * Check if the agent is actively executing
     */
    isExecuting(): boolean {
        return ['planning', 'retrievingContext', 'executing', 'observing', 'validating', 'delegating', 'compacting', 'recovering'].includes(this.state);
    }

    /**
     * Get a human-readable status
     */
    getStatusMessage(): string {
        const messages: Record<AgentState, string> = {
            created: 'Ready to start',
            planning: 'Planning task...',
            retrievingContext: 'Gathering context...',
            executing: 'Executing...',
            waitingForTool: 'Running tool...',
            observing: 'Analyzing results...',
            validating: 'Validating changes...',
            recovering: 'Recovering from error...',
            waitingForApproval: 'Waiting for approval...',
            delegating: 'Delegating to subagent...',
            compacting: 'Compacting context...',
            completed: 'Completed',
            failed: 'Failed',
            cancelled: 'Cancelled',
        };

        return messages[this.state] ?? 'Unknown state';
    }
}
