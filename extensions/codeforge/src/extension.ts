/**
 * CodeForge AI Extension
 *
 * Agent sidebar + Settings + Sessions + MCP + Trace + Tasks.
 */

import * as vscode from 'vscode';
import { ChatViewProvider } from './views/chatView';
import { SessionsTreeProvider } from './views/sessionsTree';
import { TasksTreeProvider } from './views/tasksTree';
import { ApprovalDialog } from './ui/approvalDialog';
import { DiffPreview } from './ui/diffPreview';
import { VSCodeAIBridge } from './bridge/vscodeBridge';
import { TabEngine } from './tab/tabEngine';
import { AiSettingsStore } from './settings/aiSettingsStore';
import { AiSettingsPanel } from './settings/aiSettingsPanel';
import { showModelQuickPick } from './settings/modelQuickPick';
import { initApprovalPolicy, getApprovalPolicy } from './policy/approvalPolicy';
import { SessionStore } from './sessions/sessionStore';
import { initTrace } from './trace/traceService';
import { initMcp } from './mcp/mcpClient';
import { getSkillsRules } from './skills/skillsRulesLoader';
import { initGovernanceStore } from './governance/governanceStore';
import { ensureHomeLayout } from './storage/paths';
import { initProjectWiki } from './memory/projectWiki';
import { setEmbeddingsSettingsStore } from './intelligence/embeddings';
import { startOutboundMcp, stopOutboundMcp } from './mcp/outbound';
import { indexEmbeddings } from './intelligence/workspaceIndex';

let chatViewProvider: ChatViewProvider;
let sessionsTreeProvider: SessionsTreeProvider;
let tasksTreeProvider: TasksTreeProvider;
let bridge: VSCodeAIBridge;
let outputChannel: vscode.OutputChannel;
let settingsStore: AiSettingsStore;
let sessionStore: SessionStore;
let tabEngine: TabEngine;

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('CodeForge AI');
    await ensureHomeLayout();
    await migrateLegacyOpencodeideSettings();
    bridge = new VSCodeAIBridge(outputChannel);
    settingsStore = new AiSettingsStore(context);
    setEmbeddingsSettingsStore(settingsStore);
    await settingsStore.unifyProfiles(line => outputChannel.appendLine(line));
    sessionStore = new SessionStore(context);
    initApprovalPolicy(context);
    const governance = initGovernanceStore(context);
    const trace = initTrace(outputChannel);
    const mcp = initMcp(outputChannel);

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await initProjectWiki(ws);
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            const next = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            await initProjectWiki(next);
        })
    );

    try {
        const status = await startOutboundMcp(3847);
        outputChannel.appendLine(`MCP outbound: ${status.url ?? 'failed'}`);
    } catch (err) {
        outputChannel.appendLine(
            `MCP outbound not started: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    outputChannel.appendLine('CodeForge AI extension activated (Code-OSS bridge ready)');
    outputChannel.appendLine(`Workspace: ${bridge.getWorkspaceRoot() ?? '(none)'}`);
    outputChannel.appendLine(`Sessions loaded: ${sessionStore.list().length}`);

    chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        bridge,
        outputChannel,
        settingsStore,
        sessionStore
    );
    sessionsTreeProvider = new SessionsTreeProvider(sessionStore);
    tasksTreeProvider = new TasksTreeProvider();

    chatViewProvider.setTaskUpdateHandler((update) => {
        tasksTreeProvider.upsertTask({
            id: update.id,
            name: update.name,
            status: update.status,
            model: update.model,
            elapsed: update.elapsed,
            result: update.result,
            subtasks: update.subtasks,
        });
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('codeforge.chat', chatViewProvider)
    );
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('codeforge.sessions', sessionsTreeProvider)
    );
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('codeforge.tasks', tasksTreeProvider)
    );

    tabEngine = new TabEngine();
    tabEngine.setSettingsStore(settingsStore);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, tabEngine)
    );

    // Skills / rules (disk) + governance (editable) + MCP
    const skills = getSkillsRules();
    await skills.reload(context.extensionPath);
    await mcp.refresh(settingsStore.getState().mcpServers);
    outputChannel.appendLine(
      `Governance: ${governance.getState().skills.filter(s => s.enabled).length} skills, ` +
        `${governance.getState().rules.filter(r => r.enabled).length} rules, ` +
        `${governance.getState().guardrails.filter(g => g.enabled).length} guardrails enabled`
    );

    context.subscriptions.push(
        settingsStore.onDidChange(() => {
            chatViewProvider.refreshConfig();
            void mcp.refresh(settingsStore.getState().mcpServers);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.clearCompletedTasks', () => {
            tasksTreeProvider.clearCompleted();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.toggleAutoApproveEdits', async () => {
            const cfg = vscode.workspace.getConfiguration('codeforge.ai');
            const current = cfg.get<boolean>('autoApproveEdits') === true;
            const next = !current;
            await cfg.update('autoApproveEdits', next, vscode.ConfigurationTarget.Global);
            if (next) {
                await getApprovalPolicy().allowAllEdits('always');
                vscode.window.showInformationMessage(
                    'CodeForge: auto-approve file edits ON (write/rename/delete without asking)'
                );
            } else {
                await getApprovalPolicy().revokeAllEditsAlways();
                vscode.window.showInformationMessage(
                    'CodeForge: auto-approve file edits OFF'
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.focusChat', async () => {
            await chatViewProvider.focus();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.newChat', () => chatViewProvider.newChat())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.openSettings', (tab?: string) => {
            const allowed = new Set(['models', 'mcp', 'guardrails', 'agent']);
            const initial = allowed.has(String(tab)) ? (tab as 'models' | 'mcp' | 'guardrails' | 'agent') : 'models';
            AiSettingsPanel.show(context, settingsStore, governance, initial);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.switchModel', async () => {
            await showModelQuickPick(settingsStore);
            chatViewProvider.refreshConfig();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.configureProvider', async () => {
            AiSettingsPanel.show(context, settingsStore, governance);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.resumeSession', async (sessionId: string) => {
            if (!sessionId) return;
            await chatViewProvider.loadSession(sessionId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.deleteSession', async (item?: { id?: string }) => {
            const id = item?.id;
            if (!id) return;
            const confirm = await vscode.window.showWarningMessage(
                'Delete this session?',
                { modal: true },
                'Delete'
            );
            if (confirm === 'Delete') {
                await sessionStore.remove(id);
                if (chatViewProvider.getCurrentSessionId() === id) {
                    chatViewProvider.newChat();
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.clearSessions', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Clear all AI sessions?',
                { modal: true },
                'Clear'
            );
            if (confirm === 'Clear') {
                await sessionStore.clear();
                chatViewProvider.newChat();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.exportSession', async (item?: { id?: string }) => {
            const id = item?.id ?? chatViewProvider.getCurrentSessionId() ?? undefined;
            if (!id) {
                vscode.window.showWarningMessage('No session to export');
                return;
            }
            const out = await sessionStore.exportSession(id);
            if (out) {
                vscode.window.showInformationMessage(`Session exported to ${out}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.importSession', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { JSON: ['json'] },
            });
            if (!picked?.[0]) return;
            const session = await sessionStore.importSession(picked[0].fsPath);
            if (session) {
                await chatViewProvider.loadSession(session.id);
                vscode.window.showInformationMessage('Session imported');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.runTask', async () => {
            const task = await vscode.window.showInputBox({
                prompt: 'Enter task description',
                placeHolder: 'e.g., List files in src/ or Add input validation',
            });
            if (task) {
                await chatViewProvider.runTask(task);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.cancelTask', () => chatViewProvider.cancelTask())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.showTrace', () => {
            trace.showSummary();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.reloadSkills', async () => {
            await skills.reload(context.extensionPath);
            vscode.window.showInformationMessage(
                `Skills: ${skills.listSkills().length}, Rules: ${skills.listRules().length}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.refreshMcp', async () => {
            await mcp.refresh(settingsStore.getState().mcpServers);
            vscode.window.showInformationMessage(`MCP tools: ${mcp.listTools().length}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.showApproval', async (request: ApprovalRequest) => {
            return ApprovalDialog.show(request);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.showDiff', async (changes: FileChange[]) => {
            await DiffPreview.show(changes);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.inspectWorkspace', async () => {
            const root = bridge.getWorkspaceRoot();
            if (!root) {
                vscode.window.showWarningMessage('Open a folder to inspect the workspace');
                return;
            }
            const result = await bridge.execute({
                id: 'inspect',
                name: 'list',
                arguments: { path: '.', recursive: false },
            });
            outputChannel.appendLine(result.output);
            outputChannel.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.indexEmbeddings', async () => {
            try {
                const n = await indexEmbeddings(80);
                vscode.window.showInformationMessage(
                    n ? `Indexed ${n} embedding chunks` : 'No embeddings indexed (check provider /embeddings)'
                );
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Embedding index failed: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeforge.generateInstructions', async () => {
            await chatViewProvider.runGenerateInstructions();
        })
    );

    context.subscriptions.push(outputChannel);
    context.subscriptions.push({
        dispose: () => {
            void mcp.dispose();
            void stopOutboundMcp();
        },
    });

    // Always open the AI secondary sidebar on startup (user layout state can hide it).
    await ensureAiSidebarOpen(outputChannel);
    const retryTimers = [400, 1200, 2500].map(ms =>
        setTimeout(() => {
            void ensureAiSidebarOpen(outputChannel);
        }, ms)
    );
    context.subscriptions.push({
        dispose: () => {
            for (const t of retryTimers) {
                clearTimeout(t);
            }
        },
    });
}

async function ensureAiSidebarOpen(log?: vscode.OutputChannel): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
        await vscode.commands.executeCommand('codeforge.chat.focus');
    } catch (err) {
        log?.appendLine(
            `Could not open AI sidebar: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

export function deactivate() {
    outputChannel?.appendLine('CodeForge AI extension deactivated');
}

/** One-time copy of settings.json keys from opencodeide.ai → codeforge.ai */
async function migrateLegacyOpencodeideSettings(): Promise<void> {
    const legacy = vscode.workspace.getConfiguration('opencodeide.ai');
    const next = vscode.workspace.getConfiguration('codeforge.ai');
    const keys = [
        'provider',
        'apiKey',
        'model',
        'baseUrl',
        'mode',
        'autoApprove',
        'autoApproveEdits',
        'previewEdits',
        'traceLevel',
        'tabCompletion',
        'agentCheckpointSteps',
        'agentHardCap',
        'contextBudget',
    ] as const;
    for (const key of keys) {
        const inspected = next.inspect(key);
        const already =
            inspected?.globalValue !== undefined ||
            inspected?.workspaceValue !== undefined ||
            inspected?.workspaceFolderValue !== undefined;
        if (already) continue;
        const legacyInspected = legacy.inspect(key);
        const value =
            legacyInspected?.globalValue ??
            legacyInspected?.workspaceValue ??
            legacyInspected?.workspaceFolderValue;
        if (value === undefined) continue;
        await next.update(key, value, vscode.ConfigurationTarget.Global);
    }
}

interface ApprovalRequest {
    tool: string;
    arguments: Record<string, unknown>;
    risk: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
}

interface FileChange {
    path: string;
    type: 'create' | 'modify' | 'delete' | 'rename';
    oldContent?: string;
    newContent?: string;
}
