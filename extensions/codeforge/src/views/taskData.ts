export interface TaskData {
	id: string;
	name: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	model?: string;
	workspace?: string;
	elapsed?: number;
	result?: string;
	subtasks?: TaskData[];
}

/** `{parentId}-sub-{call}` rows nest under the parent instead of listing as siblings. */
export function nestSubtask(tasks: TaskData[], task: TaskData): boolean {
	const marker = '-sub-';
	const at = task.id.indexOf(marker);
	if (at <= 0) return false;
	const parent = tasks.find(t => t.id === task.id.slice(0, at));
	if (!parent) return false;
	const subs = parent.subtasks ? [...parent.subtasks] : [];
	const i = subs.findIndex(s => s.id === task.id);
	if (i >= 0) subs[i] = { ...subs[i], ...task };
	else subs.unshift(task);
	parent.subtasks = subs;
	return true;
}
