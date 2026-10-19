/**
 * One-shot: replace AGENT_TOOLS description strings with toolDescription('name').
 */
import fs from 'fs';

const path = new URL('../src/agent/agentLoop.ts', import.meta.url);
let s = fs.readFileSync(path, 'utf8');

const names = [
	'read',
	'write',
	'edit',
	'apply_patch',
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
];

for (const name of names) {
	const re = new RegExp(
		`(name:\\s*'${name}',\\s*\\n\\s*description:\\s*)(?:'(?:\\\\'|[^'])*'|"(?:\\\\"|[^"])*"|\\[[\\s\\S]*?\\]\\.join\\(\\s*' '\\s*\\))`,
		'm'
	);
	if (!re.test(s)) {
		console.error('miss', name);
		process.exit(1);
	}
	s = s.replace(re, `$1toolDescription('${name}')`);
}

fs.writeFileSync(path, s);
console.log('wired', names.length, 'descriptions');
