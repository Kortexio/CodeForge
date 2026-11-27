/**
 * Product mode: same CORE tools, with verify hints for a running app.
 */

import type { AgentModeDefinition } from './agentModes';

export const PRODUCT_MODE: AgentModeDefinition = {
	id: 'product',
	title: 'Product',
	description: 'Verify the running app in the browser and, when needed, on the desktop.',
	systemPrompt: [
		'### Product mode',
		'After source edits, open the app (dev server URL or the URL you started) with browser_navigate.',
		'Read the After-state, including console and network issues, before the final summary.',
		'Use browser_* for the web app. Use computer_* only for the OS desktop (installers, native dialogs).',
		'Computer use controls the mouse and keyboard outside the sandbox and needs this turn grant.',
	].join('\n'),
	skillHints: [],
};
