/**
 * Thin agent state machine for Tasks UI / traces.
 */

export type AgentLifecycleState =
	| 'created'
	| 'planning'
	| 'executing'
	| 'waitingForApproval'
	| 'compacting'
	| 'recovering'
	| 'delegating'
	| 'completed'
	| 'failed'
	| 'cancelled';

const ALLOWED: Record<AgentLifecycleState, AgentLifecycleState[]> = {
	created: ['planning', 'cancelled'],
	planning: ['executing', 'cancelled', 'failed'],
	executing: [
		'waitingForApproval',
		'compacting',
		'delegating',
		'recovering',
		'completed',
		'failed',
		'cancelled',
	],
	waitingForApproval: ['executing', 'cancelled', 'failed'],
	compacting: ['executing', 'failed', 'cancelled'],
	recovering: ['executing', 'failed', 'cancelled'],
	delegating: ['executing', 'failed', 'cancelled'],
	completed: [],
	failed: [],
	cancelled: [],
};

export class AgentStateMachine {
	private state: AgentLifecycleState = 'created';
	private history: Array<{ from: AgentLifecycleState; to: AgentLifecycleState; at: string }> = [];

	getState(): AgentLifecycleState {
		return this.state;
	}

	getHistory(): typeof this.history {
		return [...this.history];
	}

	transition(to: AgentLifecycleState): boolean {
		const allowed = ALLOWED[this.state] ?? [];
		if (!allowed.includes(to)) {
			return false;
		}
		this.history.push({ from: this.state, to, at: new Date().toISOString() });
		this.state = to;
		return true;
	}

	force(to: AgentLifecycleState): void {
		this.history.push({ from: this.state, to, at: new Date().toISOString() });
		this.state = to;
	}
}
