/**
 * Multi-step checklist for the agent (TodoWrite parity).
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface AgentTodo {
	id: string;
	content: string;
	status: TodoStatus;
}

const bySession = new Map<string, AgentTodo[]>();

function key(sessionId?: string | null): string {
	return sessionId?.trim() || 'default';
}

export function getTodos(sessionId?: string | null): AgentTodo[] {
	return [...(bySession.get(key(sessionId)) ?? [])];
}

export function formatTodos(sessionId?: string | null): string {
	const todos = getTodos(sessionId);
	if (!todos.length) return '(no todos)';
	return todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n');
}

/**
 * Merge/replace todos. When `merge` is false, replaces the whole list.
 */
export function writeTodos(
	sessionId: string | null | undefined,
	todos: Array<{ id?: string; content: string; status?: TodoStatus }>,
	opts?: { merge?: boolean }
): AgentTodo[] {
	const sid = key(sessionId);
	const merge = opts?.merge !== false;
	const prev = merge ? [...(bySession.get(sid) ?? [])] : [];
	const byId = new Map(prev.map(t => [t.id, t]));
	let i = 0;
	for (const raw of todos) {
		const content = String(raw.content ?? '').trim();
		if (!content) continue;
		const id = String(raw.id ?? '').trim() || `t${++i}`;
		const status = (raw.status ?? byId.get(id)?.status ?? 'pending') as TodoStatus;
		byId.set(id, { id, content, status });
	}
	const next = [...byId.values()];
	bySession.set(sid, next);
	return next;
}
