/**
 * Unit checks for OpenCode-style tool permission filtering (no test runner wired — run via node).
 */
import {
	CORE,
	TOOL_GROUPS,
	disabled,
	filterToolsByProfile,
	merge,
	rulesetForProfile,
	toolsForGroups,
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
	'diagnostics',
	'apply_patch',
	'dotnet',
	'delete',
	'rename',
	'open',
	'symbols',
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

const buildCore = filterToolsByProfile(ALL, 'build', {});
assert(buildCore.has('write') && buildCore.has('shell'), 'build keeps write/shell');
assert(buildCore.has('todo_write') && buildCore.has('await_shell'), 'build keeps todo/await');
assert(buildCore.has('delegate_task'), 'delegate always in build');
assert(!buildCore.has('mcp_call'), 'build omits mcp by default');
assert(!buildCore.has('web_search'), 'build CORE omits web by default');
assert(!buildCore.has('browser_navigate'), 'build CORE omits browser by default');
assert(!buildCore.has('git_commit'), 'build CORE omits git by default');
for (const name of CORE) {
	if (ALL.includes(name)) assert(buildCore.has(name), `CORE includes ${name}`);
}

const buildGit = filterToolsByProfile(ALL, 'build', { toolGroups: ['git'] });
assert(buildGit.has('git_commit') && buildGit.has('gh_pr_create'), 'git group enables git tools');
assert(!buildGit.has('web_search'), 'git group does not enable web');

const buildWeb = filterToolsByProfile(ALL, 'build', { toolGroups: ['web', 'browser'] });
assert(buildWeb.has('web_search') && buildWeb.has('browser_navigate'), 'web+browser groups');

assert(toolsForGroups(['git']).includes('git_status'), 'toolsForGroups git');
assert(TOOL_GROUPS.files.includes('delete'), 'files group');

const buildMcp = filterToolsByProfile(ALL, 'build', { mcpAvailable: true });
assert(buildMcp.has('mcp_call'), 'build extras when mcp on');

const plan = filterToolsByProfile(ALL, 'plan');
assert(plan.has('read') && plan.has('wiki_fact'), 'plan allows wiki_fact');
assert(plan.has('write') && plan.has('edit'), 'plan allows write/edit for checks (path-gated)');
assert(plan.has('web_search'), 'plan allows web_search');
assert(!plan.has('shell'), 'plan denies shell');

const ask = filterToolsByProfile(ALL, 'ask');
assert(ask.has('read') && ask.has('web_fetch'), 'ask keeps read/web');
assert(!ask.has('write') && !ask.has('shell'), 'ask denies write/shell');

// Coach is JSON-reply-only (habits.json + SKILL.md are written by the harness, not the coach).
const coach = filterToolsByProfile(ALL, 'coach');
assert(coach.has('update_status'), 'coach keeps update_status');
assert(
	!coach.has('read') && !coach.has('skill') && !coach.has('write'),
	'coach denies read/skill/write — JSON reply only'
);
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
