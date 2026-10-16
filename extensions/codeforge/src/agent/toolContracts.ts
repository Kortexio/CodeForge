/**
 * Tool + system contracts sent to the model (English).
 * Behavior comes from these schemas/prompts — not from chat-phrase crutches.
 */

/** Compact system block: how tools relate to finishing work. */
export const TOOL_SYSTEM_CONTRACT = [
	'### Tool contract',
	'Call tools to inspect and change the workspace. Chat text alone never updates files.',
	'Mutations: edit (surgical), write (create/full replace), apply_patch (gpt-* only when exposed).',
	'Before edit/apply_patch: read the target span this turn; copy old_string from that result (omit "  N|" prefixes). Never invent old_string from memory.',
	'If a mutate tool reports already applied / identical / nothing to change — stop retrying that change and continue elsewhere or summarize.',
	'Exploration: list, search, retrieve, read, symbols/definition/references, diagnostics.',
	'Commands: shell (cmd.exe) or dotnet for .NET; web_search/web_fetch for HTTP; await_shell for background jobs.',
	'Prefer dedicated tools over shell for file and git operations.',
	'Issue independent read/search calls together when useful. Prefer update_status before a final wrap-up.',
	'Final reply: short summary of what tools changed (or that nothing was needed) — not an unapplied patch pasted as the answer.',
].join('\n');

/** Per-tool OpenAI function descriptions (and key parameter notes). */
export const TOOL_DESCRIPTIONS = {
	read:
		'Read a file slice (numbered lines). Use before edit so old_string matches disk. path required; startLine/limit optional (default ~120 lines, max 400).',
	write:
		'Create a new file or replace an entire file body. For small changes to an existing file use edit instead. Requires path and full content.',
	edit: [
		'Surgical replace in an existing file (old_string → new_string).',
		'Contract: (1) read that path this turn around the change, (2) copy a short unique old_string from the read output without line-number prefixes, (3) set new_string to the replacement.',
		'Do not invent old_string. If the tool returns already applied, do not retry the same edit.',
	].join(' '),
	apply_patch:
		'Apply a *** Begin Patch *** … *** End Patch *** block (exposed only for gpt-* non-OSS models). Prefer for multi-hunk updates; keep patches focused. Requires patch (or patchText); optional path if the body omits Update File.',
	dotnet:
		'.NET CLI structured actions: new | sln_add | add_reference | add_package | build | test. Prefer this over raw shell for dotnet commands. Requires action; other fields depend on action.',
	list: 'List one directory (non-recursive by default). path required. Set recursive true only for shallow trees; prefer a subfolder over the workspace root.',
	search:
		'Regex/text search across workspace files. pattern required; optional path to scope. Prefer search/retrieve before reading many files blindly.',
	retrieve:
		'Semantic/lexical top-k code snippets for a natural-language query. Prefer for “where is X?” over dumping whole files. query required; optional k (default 6).',
	delete: 'Delete a file at path. Irreversible in the workspace — use only when the task requires removal.',
	rename: 'Rename or move a file (oldPath → newPath). Both paths required.',
	open: 'Reveal/open a file in the editor UI. Does not modify contents. path required.',
	shell: [
		'Run a cmd.exe command in the workspace (&& chaining OK; no PowerShell/Unix pipes).',
		'Use for builds/tests/dev servers. Prefer web_search/web_fetch for HTTP and dedicated tools for file/git ops.',
		'Long jobs: background=true then await_shell. command required.',
	].join(' '),
	await_shell:
		'Wait/poll a background shell job. id required (from shell background). Optional pattern regex on output; optional block_until_ms.',
	web_search:
		'Search the public web (no API key). Prefer over shell curl for discovery. query required; optional max_results.',
	web_fetch:
		'Fetch a URL over HTTPS and return text/markdown-ish content. url required; optional max_chars.',
	todo_write:
		'Create or update a multi-step checklist for this session. todos array required (content; optional id/status). merge defaults true.',
	git_add: 'Stage files (git add). Optional paths array; omit to stage all relevant changes.',
	git_commit: 'Create a git commit. message required. Prefer after git_add when staging is needed.',
	git_push:
		'Push the current branch (git push). Optional set_upstream, remote, branch.',
	gh_pr_create:
		'Create a GitHub pull request via gh. title and body required; optional base, draft.',
	edit_notebook:
		'Edit or insert a Jupyter .ipynb cell. path, cell_index, new_source required; optional cell_language, is_new_cell.',
	generate_image:
		'Generate an image from a prompt (local SVG or images API). Saves under .CodeForge/artifacts/images/. prompt required; optional filename.',
	canvas_write:
		'Write a canvas doc under .CodeForge/canvas/ (md or html). id, title, and content required; optional format (md|html).',
	voice_status: 'Report whether voice input is available (status only; does not record audio).',
	diagnostics:
		'Language-server errors/warnings for a file or the workspace. Optional path; omit for workspace-wide.',
	symbols:
		'List document symbols (path) or search workspace symbols (query). Provide path and/or query.',
	references:
		'Find references at a 1-based line (and character) in a file. path and line required.',
	definition:
		'Go to definition at a 1-based line (and character) in a file. path and line required.',
	git_status: 'Show working-tree status (git status). No arguments.',
	git_diff: 'Show git diff. Optional path to scope to one file.',
	git_log: 'Show recent commits. Optional limit.',
	git_commit_msg: 'Suggest a commit message from current changes. No required args.',
	git_blame: 'Git blame for a file. path required; optional start/end line.',
	git_conflicts: 'List merge conflict paths in the workspace. No arguments.',
	wiki_read: 'Read a project wiki doc by id, or list ids if omitted.',
	wiki_write: 'Create/update a project wiki document. id and content (or fields) as required by the schema.',
	wiki_search: 'Search project wiki documents. query required.',
	wiki_fact: 'Add or supersede a project fact (key/value). key and value required; optional reason.',
	wiki_facts: 'List current project facts. No arguments.',
	update_status:
		'Save a handoff checkpoint before wrapping up: objective, stoppedAt, next (required); optional blockers, files.',
	browser_navigate: 'Open a URL in the embedded browser agent. url required.',
	browser_snapshot: 'Text accessibility snapshot of the current browser page. No arguments.',
	browser_click: 'Click a CSS selector in the browser. selector required.',
	browser_type: 'Type into a CSS selector. selector and text required.',
	browser_screenshot: 'Full-page screenshot saved as an artifact. No arguments.',
	delegate_task: [
		'Run a focused subagent and return its result.',
		'mode: explore (read-only), general (full tools), or plan. task required; optional context.',
	].join(' '),
	mcp_call:
		'Call an MCP tool by full name (server__tool). tool required; optional arguments object.',
	skill:
		'Load a playbook/skill by id or title when you need domain conventions or a workflow. name required. Catalog is injected at runtime.',
} as const;

export type ToolDescriptionName = keyof typeof TOOL_DESCRIPTIONS;

export function toolDescription(name: ToolDescriptionName): string {
	return TOOL_DESCRIPTIONS[name];
}
