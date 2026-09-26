/**
 * Read-only explore agent mode — broad codebase questions only.
 */

import type { AgentModeDefinition } from './agentModes';

export const EXPLORE_MODE: AgentModeDefinition = {
	id: 'explore',
	title: 'Explore',
	description: 'Read-only exploration subagent for broad “where is X” questions.',
	systemPrompt: [
		'### Explore mode (read-only)',
		'You only use read, list, search, retrieve, symbols, and wiki_read.',
		'Do not write, edit, delete, or run shell/dotnet.',
		'Return a short findings summary and cite paths as path:startLine-endLine.',
		'Example:',
		'findings: Cart totals are computed in Services/Cart.cs',
		'- Services/Cart.cs:40-88',
	].join('\n'),
	toolNamespaces: undefined,
	skillHints: [],
};

/** Tool names allowed for the explore subagent. */
export const EXPLORE_TOOL_NAMES = new Set([
	'read',
	'list',
	'search',
	'retrieve',
	'symbols',
	'wiki_read',
	'wiki_search',
	'wiki_facts',
	'references',
	'definition',
]);
