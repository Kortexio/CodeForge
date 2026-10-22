/**
 * Allow-all policy helpers (no VS Code — run via node after compile).
 */
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function globalAllowAll(cfg: { allowAll?: boolean; fullAgentFreedom?: boolean }): boolean {
	return cfg.allowAll === true || cfg.fullAgentFreedom === true;
}

assert(!globalAllowAll({}), 'default off');
assert(globalAllowAll({ allowAll: true }), 'allowAll setting');
assert(globalAllowAll({ fullAgentFreedom: true }), 'full freedom implies allowAll');
const editTools = new Set(['edit', 'write', 'apply_patch', 'rename', 'delete']);
assert(editTools.has('write') && editTools.has('apply_patch'), 'edit tools set');

console.log('approvalPolicy ok');
