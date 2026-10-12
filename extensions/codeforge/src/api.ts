/**
 * Public CodeForge extension API — consumed by TriageHub Studio and other verticals.
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
import type {
	AiSettingsState,
	AiSettingsStore,
	McpServerConfig,
	SettingsProfile,
} from './settings/aiSettingsStore';
import { getAiSettingsStore } from './settings/aiSettingsStore';
import { getMcp } from './mcp/mcpClient';

export type { ToolDefinition, GuardrailGate, ContextProvider, MemoryScope, IMemoryProvider };
export type { SettingsProfile as AiSettingsProfile, AiSettingsState, McpServerConfig };
export type { SlashCommand, AttachmentKindDefinition as AttachmentKind, AgentModeDefinition };
export type { PendingAttachment as Attachment };

/** Minimal external-session handle (TriageHub ticket mirror). */
export interface ExternalChatSession {
	id: string;
	title: string;
	banner?: string;
	role?: string;
	empty?: string;
	modelLabel?: string;
	onUserMessage(text: string): void | Promise<void>;
	onCancel?(): void | Promise<void>;
	onLink?(url: string): void | Promise<void>;
	onDetach?(): void;
}

export interface ExternalChatHandle {
	readonly id: string;
	readonly attached: boolean;
	setMessages(
		messages: Array<{ role: 'user' | 'assistant'; content: string; status?: string }>,
		timeline: Array<{
			id: string;
			kind: 'tool' | 'thought' | 'checkpoint';
			label: string;
			detail?: string;
			tool?: string;
			toolStatus?: 'running' | 'ok' | 'failed';
			turn?: number;
		}>
	): void;
	setRunning(running: boolean): void;
	update(patch: { title?: string; banner?: string; modelLabel?: string; empty?: string }): void;
	dispose(): void;
}

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
		attachExternalSession(session: ExternalChatSession): ExternalChatHandle;
	};
	settings: {
		applyProfile(profile: SettingsProfile | undefined): void;
		activeProfile(): { id: string; label: string } | undefined;
		onDidChange: vscode.Event<AiSettingsState>;
	};
	modes: {
		registerAgentMode(m: AgentModeDefinition): Disposable;
		activateAgentMode(id: string | null): void;
	};
	mcp: {
		setContribution(owner: string, servers: McpServerConfig[]): Promise<void>;
	};
}

export interface CodeForgeApiHost {
	store: AiSettingsStore;
	attachExternal(session: ExternalChatSession): ExternalChatHandle;
}

let apiHost: CodeForgeApiHost | undefined;

export function setApiHost(host: CodeForgeApiHost): void {
	apiHost = host;
}

function requireHost(): CodeForgeApiHost {
	if (!apiHost) throw new Error('CodeForge is still starting');
	return apiHost;
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
			attachExternalSession: session => requireHost().attachExternal(session),
		},
		settings: {
			applyProfile: profile => {
				const store = apiHost?.store ?? getAiSettingsStore();
				store?.applyProfile(profile);
			},
			activeProfile: () => {
				const store = apiHost?.store ?? getAiSettingsStore();
				return store?.activeProfile();
			},
			onDidChange: (listener, thisArgs, disposables) => {
				const store = apiHost?.store ?? getAiSettingsStore();
				if (!store) {
					return { dispose() {} };
				}
				return store.onDidChange(listener, thisArgs, disposables);
			},
		},
		modes: {
			registerAgentMode: (m: AgentModeDefinition) => getAgentModeRegistry().register(m),
			activateAgentMode: (id: string | null) => {
				getAgentModeRegistry().activate(id);
			},
		},
		mcp: {
			setContribution: async (owner, servers) => {
				const mcp = getMcp();
				if (!mcp) return;
				await mcp.setContribution(owner, servers);
			},
		},
	};
}
