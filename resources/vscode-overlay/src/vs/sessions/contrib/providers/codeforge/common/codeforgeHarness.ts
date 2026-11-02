/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kortexio. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';

/** Chat participant that runs every Agents-window turn through the side chat pipeline. */
export const CODEFORGE_PARTICIPANT_ID = 'codeforge.agent';

export const CodeForgeHarnessCommands = {
	GetState: 'codeforge.agents.getState',
	SetModel: 'codeforge.agents.setModel',
	SetMode: 'codeforge.agents.setMode',
	SetPermission: 'codeforge.agents.setPermission',
	SetFullAgentFreedom: 'codeforge.agents.setFullAgentFreedom',
	OpenSettings: 'codeforge.openSettings',
	/** Registered by the core; the extension calls it whenever harness state changes. */
	StateChanged: '_codeforge.agents.stateChanged',
} as const;

export type CodeForgeMode = 'ask' | 'plan' | 'agent';
export type CodeForgePermission = 'default' | 'assisted' | 'allowAll';

export interface ICodeForgeModel {
	readonly id: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly model: string;
}

export interface ICodeForgeHarnessState {
	readonly mode: CodeForgeMode;
	readonly permission: CodeForgePermission;
	readonly fullAgentFreedom: boolean;
	readonly models: readonly ICodeForgeModel[];
	readonly activeModelId: string | undefined;
}

export const CODEFORGE_MODES: readonly { readonly id: CodeForgeMode; readonly label: string; readonly description: string }[] = [
	{ id: 'agent', label: 'Agent', description: 'Edits files and runs tools with the CodeForge loop' },
	{ id: 'plan', label: 'Plan', description: 'Plans the work before changing anything' },
	{ id: 'ask', label: 'Ask', description: 'Answers questions without editing' },
];

export const CODEFORGE_PERMISSIONS: readonly { readonly id: CodeForgePermission; readonly label: string; readonly description: string }[] = [
	{ id: 'default', label: 'Default', description: 'Ask before edits and shell commands' },
	{ id: 'assisted', label: 'Assisted', description: 'Preview edits before they are applied' },
	{ id: 'allowAll', label: 'Allow all', description: 'No approval prompts for this session' },
];

function isMode(value: unknown): value is CodeForgeMode {
	return value === 'ask' || value === 'plan' || value === 'agent';
}

function isPermission(value: unknown): value is CodeForgePermission {
	return value === 'default' || value === 'assisted' || value === 'allowAll';
}

/**
 * Validates the state returned by the extension. Returns `undefined` when the
 * payload is not a harness state, so callers show "not connected" instead of
 * inventing defaults.
 */
export function parseHarnessState(value: unknown): ICodeForgeHarnessState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (!isMode(raw.mode) || !isPermission(raw.permission) || !Array.isArray(raw.models)) {
		return undefined;
	}
	const models: ICodeForgeModel[] = [];
	for (const entry of raw.models) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const m = entry as Record<string, unknown>;
		if (typeof m.id === 'string' && typeof m.serverId === 'string' && typeof m.serverName === 'string' && typeof m.model === 'string') {
			models.push({ id: m.id, serverId: m.serverId, serverName: m.serverName, model: m.model });
		}
	}
	const activeModelId = typeof raw.activeModelId === 'string' && models.some(m => m.id === raw.activeModelId) ? raw.activeModelId : undefined;
	return {
		mode: raw.mode,
		permission: raw.permission,
		fullAgentFreedom: raw.fullAgentFreedom === true,
		models,
		activeModelId,
	};
}

/** Language model vendor the extension registers for its server/model pairs. */
export const CODEFORGE_LM_VENDOR = 'codeforge';

/** `vscode.lm` identifier of a harness model id (`serverId::model`). */
export function languageModelIdentifierOf(harnessModelId: string): string {
	return `${CODEFORGE_LM_VENDOR}/${harnessModelId}`;
}

/** Harness model id of a CodeForge language model identifier, or `undefined` for other vendors. */
export function harnessModelIdOf(identifier: string): string | undefined {
	const prefix = `${CODEFORGE_LM_VENDOR}/`;
	return identifier.startsWith(prefix) ? identifier.slice(prefix.length) : undefined;
}

/** The registered CodeForge models, in the order of the harness server/model list. */
export function codeforgeLanguageModels(
	state: ICodeForgeHarnessState | undefined,
	lookup: (identifier: string) => ILanguageModelChatMetadataAndIdentifier['metadata'] | undefined,
): ILanguageModelChatMetadataAndIdentifier[] {
	if (!state) {
		return [];
	}
	const models: ILanguageModelChatMetadataAndIdentifier[] = [];
	for (const m of state.models) {
		const identifier = languageModelIdentifierOf(m.id);
		const metadata = lookup(identifier);
		if (metadata) {
			models.push({ identifier, metadata });
		}
	}
	return models;
}
