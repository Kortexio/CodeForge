/**
 * Public CodeForge extension API (P0-2) — consumed by vertical extensions (e.g. Zuora).
 */

import type { Disposable } from './agent/toolRegistry';
import { getToolRegistry, type ToolDefinition } from './agent/toolRegistry';
import {
	getContextProviderRegistry,
	type ContextProvider,
} from './context/providers';
import {
	getGateRegistry,
	type GuardrailGate,
} from './governance/gateRegistry';
import type { PolicyItem } from './governance/types';
import { getGovernanceStore } from './governance/governanceStore';
import { getSkillsRules } from './skills/skillsRulesLoader';
import {
	getMemoryProvider,
	getMemoryScopeRegistry,
	type MemoryScope,
	type IMemoryProvider,
} from './memory/scopes';
import {
	registerSlashCommand,
	type SlashCommand,
} from './views/slashCommands';
import {
	registerAttachmentKind,
	type AttachmentKindDefinition,
	type PendingAttachment,
} from './views/attachments';
import {
	getAgentModeRegistry,
	type AgentModeDefinition,
} from './agent/agentModes';
import * as vscode from 'vscode';

export type { ToolDefinition, GuardrailGate, ContextProvider, MemoryScope, IMemoryProvider };
export type { SlashCommand, AttachmentKindDefinition as AttachmentKind, AgentModeDefinition };
export type { PendingAttachment as Attachment };

export interface CodeForgeApi {
	version: '1';
	tools: Pick<ReturnType<typeof getToolRegistry>, 'register'>;
	context: { registerProvider(p: ContextProvider): Disposable };
	governance: {
		registerGate(g: GuardrailGate): Disposable;
		registerSkillsDir(dir: string, scope: 'extension'): Disposable;
		registerRulesDir(dir: string, scope: 'extension'): Disposable;
		registerPolicy(p: PolicyItem): Disposable;
	};
	memory: {
		registerScope(s: MemoryScope): Disposable;
		provider(): IMemoryProvider;
	};
	chat: {
		registerSlashCommand(c: SlashCommand): Disposable;
		registerAttachmentKind(k: AttachmentKindDefinition): Disposable;
		openWithPrompt(prompt: string, attachments?: PendingAttachment[]): Promise<void>;
	};
	modes: {
		registerAgentMode(m: AgentModeDefinition): Disposable;
		/** `null` clears the mode used by the next agent run. */
		activateAgentMode(id: string | null): void;
	};
}

export type OpenWithPromptHandler = (
	prompt: string,
	attachments?: PendingAttachment[]
) => Promise<void>;

let openWithPromptHandler: OpenWithPromptHandler | undefined;

export function setOpenWithPromptHandler(handler: OpenWithPromptHandler | undefined): void {
	openWithPromptHandler = handler;
}

function registerGateWithSettings(gate: GuardrailGate): Disposable {
	const gateDisp = getGateRegistry().register(gate);
	const store = getGovernanceStore();
	const id = `ext.gate.${gate.id}`;
	void store.upsert({
		id,
		kind: 'guardrail',
		title: gate.title,
		description: gate.description,
		content: gate.description,
		enabled: gate.defaultEnabled,
		builtin: false,
		gateId: gate.id,
		params: gate.params ?? {},
	});
	return {
		dispose: () => {
			gateDisp.dispose();
			void store.remove('guardrail', id).catch(() => undefined);
		},
	};
}

export function createCodeForgeApi(): CodeForgeApi {
	const tools = getToolRegistry();
	const skills = getSkillsRules();

	return {
		version: '1',
		tools: {
			register: (def: ToolDefinition) => tools.register(def),
		},
		context: {
			registerProvider: (p: ContextProvider) => getContextProviderRegistry().register(p),
		},
		governance: {
			registerGate: (g: GuardrailGate) => registerGateWithSettings(g),
			registerSkillsDir: (dir: string, scope: 'extension') => {
				const d = skills.registerSkillsDir(dir, scope);
				void skills.reload(vscode.extensions.getExtension('kortexio.codeforge')?.extensionPath);
				return d;
			},
			registerRulesDir: (dir: string, scope: 'extension') => {
				const d = skills.registerRulesDir(dir, scope);
				void skills.reload(vscode.extensions.getExtension('kortexio.codeforge')?.extensionPath);
				return d;
			},
			registerPolicy: (p: PolicyItem) => {
				void getGovernanceStore().upsert(p);
				return {
					dispose: () => {
						void getGovernanceStore().remove('policy', p.id).catch(() => undefined);
					},
				};
			},
		},
		memory: {
			registerScope: (s: MemoryScope) => getMemoryScopeRegistry().register(s),
			provider: () => getMemoryProvider(),
		},
		chat: {
			registerSlashCommand: (c: SlashCommand) => registerSlashCommand(c),
			registerAttachmentKind: (k: AttachmentKindDefinition) => registerAttachmentKind(k),
			openWithPrompt: async (prompt, attachments) => {
				if (!openWithPromptHandler) {
					await vscode.commands.executeCommand('codeforge.focusChat');
					throw new Error('CodeForge chat is not ready');
				}
				await openWithPromptHandler(prompt, attachments);
			},
		},
		modes: {
			registerAgentMode: (m: AgentModeDefinition) => getAgentModeRegistry().register(m),
			activateAgentMode: (id: string | null) => {
				getAgentModeRegistry().activate(id);
			},
		},
	};
}
