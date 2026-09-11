/**
 * Slash command registry for the AI composer.
 */

export interface SlashCommand {
	name: string;
	description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: 'help', description: 'List available slash commands' },
	{ name: 'clear', description: 'Start a new chat' },
	{ name: 'ask', description: 'Switch to Ask mode (no tools)' },
	{ name: 'plan', description: 'Switch to Plan mode (explore + wiki plan only)' },
	{ name: 'agent', description: 'Switch to Agent mode' },
	{ name: 'auto', description: 'Switch to Auto mode (allow all this session)' },
	{ name: 'permissions', description: 'Cycle Default → Assisted → Allow all' },
	{ name: 'instructions', description: 'Generate AGENTS.md for this workspace' },
];

export function filterSlashCommands(prefix: string): SlashCommand[] {
	const q = prefix.replace(/^\//, '').toLowerCase();
	if (!q) return SLASH_COMMANDS;
	return SLASH_COMMANDS.filter(c => c.name.startsWith(q) || c.name.includes(q));
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
		...SLASH_COMMANDS.map(c => `· /${c.name} — ${c.description}`),
	].join('\n');
}
