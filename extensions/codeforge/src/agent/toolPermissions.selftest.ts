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

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const ALL = [
	'read',
	'write',
	'edit',
	'shell',
	'browser_navigate',
	'browser_click',
	'mcp_call',
	'delegate_task',
	'update_status',
	'wiki_fact',
	'git_blame',
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
assert(!explore.has('write') && !explore.has('shell'), 'explore denies write/shell');
assert(!explore.has('browser_navigate'), 'explore denies browser');

const build = filterToolsByProfile(ALL, 'build', { mcpAvailable: true, exploreSubagent: true });
assert(build.has('write') && build.has('shell'), 'build keeps write/shell');
assert(build.has('mcp_call') && build.has('delegate_task'), 'build extras when flags on');
assert(!build.has('browser_navigate') && !build.has('wiki_fact'), 'build denies browser/wiki_fact');

const buildLean = filterToolsByProfile(ALL, 'build', {});
assert(!buildLean.has('mcp_call') && !buildLean.has('delegate_task'), 'build omits extras by default');

const plan = filterToolsByProfile(ALL, 'plan');
assert(plan.has('read') && plan.has('wiki_fact'), 'plan allows wiki_fact');
assert(!plan.has('shell') && !plan.has('write'), 'plan denies shell/write');

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
