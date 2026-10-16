/**
 * Ensures every agent tool has a non-empty contract description.
 */
import { TOOL_DESCRIPTIONS, TOOL_SYSTEM_CONTRACT, toolDescription } from './toolContracts';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(TOOL_SYSTEM_CONTRACT.includes('### Tool contract'), 'system contract header');
assert(/edit/i.test(TOOL_SYSTEM_CONTRACT), 'system mentions edit');
assert(/read/i.test(TOOL_SYSTEM_CONTRACT), 'system mentions read');
assert(/already applied/i.test(TOOL_SYSTEM_CONTRACT), 'system mentions already applied');

const expected = [
	'read',
	'write',
	'edit',
	'apply_patch',
	'dotnet',
	'list',
	'search',
	'retrieve',
	'delete',
	'rename',
	'open',
	'shell',
	'await_shell',
	'web_search',
	'web_fetch',
	'todo_write',
	'git_add',
	'git_commit',
	'git_push',
	'gh_pr_create',
	'edit_notebook',
	'generate_image',
	'canvas_write',
	'voice_status',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'git_commit_msg',
	'git_blame',
	'git_conflicts',
	'wiki_read',
	'wiki_write',
	'wiki_search',
	'wiki_fact',
	'wiki_facts',
	'update_status',
	'browser_navigate',
	'browser_snapshot',
	'browser_click',
	'browser_type',
	'browser_screenshot',
	'delegate_task',
	'mcp_call',
	'skill',
] as const;

const keys = Object.keys(TOOL_DESCRIPTIONS).sort();
assert(keys.length === expected.length, `description count ${keys.length} !== ${expected.length}`);
for (const name of expected) {
	const d = toolDescription(name);
	assert(typeof d === 'string' && d.trim().length > 20, `thin description: ${name}`);
}
assert(/old_string/i.test(toolDescription('edit')), 'edit contract mentions old_string');
assert(/read/i.test(toolDescription('edit')), 'edit contract requires read');

console.log('toolContracts.selftest: ok');
