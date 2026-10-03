/**
 * Unit checks for OpenCode-style tool permission filtering (no test runner wired — run via node).
 */
import {
	disabled,
	filterToolsByProfile,
	merge,
	rulesetForProfile,
	type PermissionRuleset,
} from './toolPermissions';
import { profileForTurn } from './toolsets';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const ALL = [
	'read',
	'write',
	'edit',
	'shell',
	'await_shell',
	'web_search',
	'web_fetch',
	'todo_write',
	'browser_navigate',
	'browser_click',
	'mcp_call',
	'delegate_task',
	'update_status',
	'wiki_fact',
	'git_blame',
	'git_commit',
	'gh_pr_create',
	'edit_notebook',
	'generate_image',
	'canvas_write',
	'skill',
	'list',
	'search',
	'retrieve',
];

const denyWrite: PermissionRuleset = [
	{ permission: 'edit', pattern: '*', action: 'deny' },
];
assert(disabled(['write', 'edit', 'read'], denyWrite).has('write'), 'write disabled via edit key');
assert(disabled(['write', 'edit', 'read'], denyWrite).has('edit'), 'edit disabled');
assert(!disabled(['write', 'edit', 'read'], denyWrite).has('read'), 'read not disabled');

const explore = filterToolsByProfile(ALL, 'explore');
assert(explore.has('read') && explore.has('search'), 'explore keeps read/search');
assert(explore.has('web_search'), 'explore keeps web_search');
assert(!explore.has('write') && !explore.has('shell'), 'explore profile still denies write/shell');
assert(!explore.has('browser_navigate'), 'explore denies browser');

assert(
	profileForTurn('explore', 'lista os models em https://server.example/v1/models', {}) === 'build',
	'Agent keeps build/shell for API listing prompts'
);
assert(
	profileForTurn('explore', 'where is Cart total?', { planMode: true }) === 'plan',
	'Plan mode still uses plan profile'
);
assert(
	profileForTurn('explore', 'what does this repo do?', { askMode: true }) === 'ask',
	'Ask mode profile'
);

const build = filterToolsByProfile(ALL, 'build', { mcpAvailable: true });
assert(build.has('write') && build.has('shell'), 'build keeps write/shell');
assert(build.has('web_search') && build.has('web_fetch'), 'build keeps web tools');
assert(build.has('todo_write') && build.has('await_shell'), 'build keeps todo/await');
assert(build.has('delegate_task') && build.has('git_commit'), 'build keeps delegate/git write');
assert(build.has('mcp_call'), 'build extras when mcp on');
assert(build.has('browser_navigate'), 'build exposes browser');

const buildLean = filterToolsByProfile(ALL, 'build', {});
assert(!buildLean.has('mcp_call'), 'build omits mcp by default');
assert(buildLean.has('delegate_task'), 'delegate always in build');

const plan = filterToolsByProfile(ALL, 'plan');
assert(plan.has('read') && plan.has('wiki_fact'), 'plan allows wiki_fact');
assert(plan.has('write') && plan.has('edit'), 'plan allows write/edit for checks (path-gated)');
assert(plan.has('web_search'), 'plan allows web_search');
assert(!plan.has('shell'), 'plan denies shell');

const ask = filterToolsByProfile(ALL, 'ask');
assert(ask.has('read') && ask.has('web_fetch'), 'ask keeps read/web');
assert(!ask.has('write') && !ask.has('shell'), 'ask denies write/shell');

const coach = filterToolsByProfile(ALL, 'coach');
assert(coach.has('read') && coach.has('skill') && coach.has('write'), 'coach keeps read/skill/write');
assert(!coach.has('shell') && !coach.has('delete'), 'coach denies shell/delete');

const status = filterToolsByProfile(ALL, 'status');
assert(status.size === 1 && status.has('update_status'), 'status only update_status');

const merged = merge(rulesetForProfile('explore'), [
	{ permission: 'shell', pattern: '*', action: 'allow' },
]);
assert(
	!disabled(['shell', 'read'], merged).has('shell'),
	'later allow overrides earlier deny for shell'
);

console.log('toolPermissions ok');
