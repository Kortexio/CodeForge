/**
 * Tool + system contracts sent to the model (English).
 * Behavior comes from these schemas/prompts — not from chat-phrase crutches.
 */

export type ToolContractPromptKnobs = {
	renameSearchRule?: boolean;
	shellCmdExeHints?: boolean;
};

/** @deprecated Prefer buildToolSystemContract(activeNames). Kept for callers that need the full text. */
export const TOOL_SYSTEM_CONTRACT = buildToolSystemContract(undefined);

/**
 * System tool contract mentioning only tools that are active this run.
 * Pass undefined/empty to include every optional section (legacy full surface).
 */
export function buildToolSystemContract(
	activeNames?: Iterable<string>,
	prompt?: ToolContractPromptKnobs
): string {
	const active = activeNames ? new Set(activeNames) : undefined;
	const has = (...names: string[]) => !active || names.some(n => active.has(n));
	const renameRule = prompt?.renameSearchRule !== false;
	const shellHints = prompt?.shellCmdExeHints !== false;

	const lines: string[] = [
		'### Tool contract',
		'Call tools to inspect and change the workspace. Chat text alone never updates files.',
	];

	const mutations: string[] = [];
	if (has('edit')) mutations.push('edit (surgical)');
	if (has('write')) mutations.push('write (create/full replace)');
	if (has('apply_patch')) mutations.push('apply_patch (gpt-* only when exposed)');
	if (mutations.length) {
		lines.push(`Mutations: ${mutations.join(', ')}.`);
	}
	if (has('edit') || has('apply_patch')) {
		lines.push(
			'Before edit/apply_patch: read the target span this turn; copy old_string from that result (omit "  N|" prefixes). Never invent old_string from memory.'
		);
	}
	if (has('edit') || has('write') || has('apply_patch')) {
		lines.push(
			'If a mutate tool reports already applied / identical / nothing to change — stop retrying that change and continue elsewhere or summarize.'
		);
	}

	const explore: string[] = [];
	if (has('list')) explore.push('list');
	if (has('search')) explore.push('search');
	if (has('retrieve')) explore.push('retrieve');
	if (has('read')) explore.push('read');
	if (has('symbols') || has('definition') || has('references')) {
		explore.push('symbols/definition/references');
	}
	if (has('diagnostics')) explore.push('diagnostics');
	if (explore.length) {
		lines.push(`Exploration: ${explore.join(', ')}.`);
	}

	const commands: string[] = [];
	if (has('shell')) commands.push('shell (cmd.exe)');
	if (has('dotnet')) commands.push('dotnet for .NET');
	if (has('web_search') || has('web_fetch')) {
		commands.push('web_search/web_fetch for HTTP');
	}
	if (has('await_shell')) commands.push('await_shell for background jobs');
	if (commands.length) {
		lines.push(`Commands: ${commands.join('; ')}.`);
	}

	if (has('browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type')) {
		lines.push(
			'Browser: snapshot is the source of truth. Loop observe → act (click/type) → read the After page state in the tool result. Click success alone is not the goal — UI must match the expected outcome. If UI UNCHANGED, do not repeat the same selector.'
		);
	}

	lines.push('Prefer dedicated tools over shell for file and git operations.');
	if (has('read') || has('search')) {
		lines.push('Issue independent read/search calls together when useful.');
	}
	if (has('update_status')) {
		lines.push('Prefer update_status before a final wrap-up.');
	}

	const effectful: string[] = [];
	if (has('edit')) effectful.push('edit');
	if (has('write')) effectful.push('write');
	if (has('shell')) effectful.push('shell');
	if (has('browser_click', 'browser_type', 'browser_navigate')) effectful.push('browser act');
	const effectPhrase = effectful.length
		? effectful.join('/')
		: 'an effectful tool';
	lines.push(
		`Implementation finish: exploration-only (read/search/list/…) is not done. After a short look, call ${effectPhrase} or reply \`blocked: <reason>\`. A bug list or plan is not a substitute for applying the change.`
	);
	lines.push(
		'Runnable UI/apps: build/test green is not done — launch the app (shell start/dev or browser_navigate) and observe (snapshot/screenshot/After-state or process output) before the final summary. Opening a window that still fails at runtime is not done.'
	);
	if (
		renameRule &&
		has('search') &&
		(has('edit') || has('write') || has('apply_patch'))
	) {
		lines.push(
			'Renaming or removing an identifier is done only when a search for the old name in the requested scope returns no hits — definitions, imports, call sites and object/export keys (`oldName: x.newName` still exposes oldName). Passing tests do not prove a rename. Keep the old name only if the task asks for an alias.'
		);
	}
	lines.push(
		'Final reply: short summary of what tools changed (or that nothing was needed) — not an unapplied patch pasted as the answer.'
	);

	return lines.join('\n');
}

/** Per-tool OpenAI function descriptions (and key parameter notes). */
export const TOOL_DESCRIPTIONS = {
	read:
		'Read a file slice (numbered lines). Use before edit so old_string matches disk. Do not re-read the same span after it is already in tool results — call edit/shell/browser instead. path required; startLine/limit optional (default ~120 lines, max 400).',
	write:
		'Create a new file or replace an entire file body. Prefer a short body: for large new files write a minimal skeleton (<60 lines) then grow with edit; for .NET projects prefer the dotnet tool. For small changes to an existing file use edit instead. After a short diagnosis, call write/edit to apply — do not stop at a bug list. Requires path and full content.',
	edit: [
		'Surgical replace in an existing file (old_string → new_string).',
		'Contract: (1) read that path this turn around the change, (2) copy a short unique old_string from the read output without line-number prefixes, (3) set new_string to the replacement.',
		'After diagnosing a fix, call edit in this turn. Do not invent old_string. If the tool returns already applied, do not retry the same edit.',
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
	rename:
		'Rename or move a file (oldPath → newPath). Both paths required. Files only — to rename a symbol, edit each occurrence, then search the old name until no hits remain.',
	open: 'Reveal/open a file in the editor UI. Does not modify contents. path required.',
	shell: [
		'Run a cmd.exe command in the workspace (&& chaining OK; no PowerShell/Unix pipes).',
		'Use for builds/tests/dev servers. Prefer web_search/web_fetch for HTTP and dedicated tools for file/git ops.',
		'Long jobs: background=true then await_shell. command required.',
	].join(' '),
	shellUnixHints:
		'cmd.exe has no Unix tools or heredocs: use del (not rm), type (not cat), findstr (not grep/tail/head), %TEMP% (not /tmp); create files with write, not `cat > file << EOF`; PowerShell cmdlets (Set-Content, Out-File) do not run here.',
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
	browser_navigate: [
		'Open a URL in the embedded browser agent. url required.',
		'Result includes After page state (URL/title/text) — that state is the source of truth.',
	].join(' '),
	browser_snapshot: [
		'Text snapshot of the current page (URL, title, body text). Source of truth before deciding a click/type target.',
		'Prefer a fresh snapshot when the page may have changed. No arguments.',
	].join(' '),
	browser_click: [
		'Click a CSS selector. selector required.',
		'Result is not only “Clicked”: it includes whether the UI changed and the After page state.',
		'If UI UNCHANGED, do not repeat the same selector — fix the app or choose another action. Expected outcome = action + After state.',
	].join(' '),
	browser_type: [
		'Type into a CSS selector. selector and text required.',
		'Result includes UI change verdict and After page state (same observe-after-act contract as browser_click).',
	].join(' '),
	browser_screenshot: [
		'Full-page screenshot saved as an artifact, plus a short After text state.',
		'Use when a visual check helps; for automation logic prefer browser_snapshot / After state from click.',
	].join(' '),
	delegate_task: [
		'Run a focused subagent and return its result.',
		'mode: explore (read-only), general (full tools), or plan. task required; optional context.',
	].join(' '),
	mcp_call:
		'Call an MCP tool by full name (server__tool). tool required; optional arguments object.',
	skill:
		'Load a playbook/skill by id or title when you need domain conventions or a workflow. name required. Catalog is injected at runtime.',
} as const;

export type ToolDescriptionName = Exclude<keyof typeof TOOL_DESCRIPTIONS, 'shellUnixHints'>;

export function toolDescription(
	name: ToolDescriptionName,
	prompt?: ToolContractPromptKnobs
): string {
	if (name === 'shell' && prompt?.shellCmdExeHints !== false) {
		return `${TOOL_DESCRIPTIONS.shell} ${TOOL_DESCRIPTIONS.shellUnixHints}`;
	}
	return TOOL_DESCRIPTIONS[name];
}
