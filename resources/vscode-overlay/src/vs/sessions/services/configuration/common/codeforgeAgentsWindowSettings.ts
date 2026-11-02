/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Read-only defaults for the Agents window. These settings use
 * `disallowConfigurationDefault`, so a product or extension default is ignored.
 * The sessions configuration service applies this map instead, and treats every
 * key as read-only so a user value cannot turn VS Code discovery back on.
 *
 * Prompt location keys are `false`, not `{}`: an object still adds the default
 * folders. Skills, instructions, hooks and MCP in this window come from CodeForge.
 */
export const CODEFORGE_AGENTS_WINDOW_SETTINGS: Readonly<Record<string, unknown>> = {
	'chat.useAgentSkills': false,
	'chat.useAgentsMdFile': false,
	'chat.useNestedAgentsMdFiles': false,
	'chat.useClaudeMdFile': false,
	'chat.useHooks': false,
	'chat.includeApplyingInstructions': false,
	'chat.includeReferencedInstructions': false,
	'chat.plugins.enabled': false,
	'chat.promptFilesLocations': false,
	'chat.instructionsFilesLocations': false,
	'chat.agentFilesLocations': false,
	'chat.agentSkillsLocations': false,
	'chat.hookFilesLocations': false,
	'chat.experimental.collectInstructionsInExtension': true,
	'chat.mcp.access': 'none',
};

export function codeforgeAgentsWindowSetting(key: string): { readonly value: unknown } | undefined {
	if (Object.prototype.hasOwnProperty.call(CODEFORGE_AGENTS_WINDOW_SETTINGS, key)) {
		return { value: CODEFORGE_AGENTS_WINDOW_SETTINGS[key] };
	}
	return undefined;
}
