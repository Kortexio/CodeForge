/**
 * Slash command registry for the AI composer (P0-7 — registrable).
 */

export interface SlashCommand {
	name: string;
	description: string;
	/** Optional handler for extension-registered commands. */
	run?: (args: string) => void | Promise<void>;
}

export interface Disposable {
	dispose(): void;
}

const BUILTIN: SlashCommand[] = [
	{ name: 'help', description: 'List available slash commands' },
	{ name: 'clear', description: 'Start a new chat' },
	{ name: 'ask', description: 'Switch to Ask mode (no tools)' },
	{ name: 'plan', description: 'Switch to Plan mode (explore + wiki plan only)' },
	{ name: 'agent', description: 'Switch to Agent mode' },
	{ name: 'auto', description: 'Allow all edits + shell this session (Agent mode)' },
	{ name: 'permissions', description: 'Cycle Default → Assisted → Allow all' },
	{ name: 'instructions', description: 'Generate AGENTS.md for this workspace' },
	{ name: 'cards', description: 'Implement docs/C*.md cards one by one (optional: C01-C05)' },
	{ name: 'plan-run', description: 'Plan the request in steps and run each step with a clean context' },
	{ name: 'review', description: 'Find bugs: build/test signals, per-file review, BUGS.md' },
];

const extra = new Map<string, SlashCommand>();

/** @deprecated Prefer listSlashCommands() — kept for callers that read the array. */
export const SLASH_COMMANDS: SlashCommand[] = [...BUILTIN];

function syncExport(): void {
	SLASH_COMMANDS.length = 0;
	SLASH_COMMANDS.push(...listSlashCommands());
}

export function registerSlashCommand(cmd: SlashCommand): Disposable {
	const name = cmd.name.replace(/^\//, '').trim().toLowerCase();
	if (!name) throw new Error('SlashCommand.name is required');
	const entry = { ...cmd, name };
	extra.set(name, entry);
	syncExport();
	return {
		dispose: () => {
			if (extra.get(name) === entry || extra.get(name)?.name === name) {
				extra.delete(name);
				syncExport();
			}
		},
	};
}

export function listSlashCommands(): SlashCommand[] {
	const byName = new Map<string, SlashCommand>();
	for (const c of BUILTIN) byName.set(c.name, c);
	for (const c of extra.values()) byName.set(c.name, c);
	return [...byName.values()];
}

export function getSlashCommand(name: string): SlashCommand | undefined {
	return listSlashCommands().find(c => c.name === name.toLowerCase());
}

export function filterSlashCommands(prefix: string): SlashCommand[] {
	const q = prefix.replace(/^\//, '').toLowerCase();
	const all = listSlashCommands();
	if (!q) return all;
	return all.filter(c => c.name.startsWith(q) || c.name.includes(q));
}

export function parseSlashInput(text: string): { command: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) return null;
	const match = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s.exec(trimmed);
	if (!match) return null;
	return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

export function formatSlashHelp(): string {
	return [
		'Slash commands:',
		...listSlashCommands().map(c => `· /${c.name} — ${c.description}`),
	].join('\n');
}
