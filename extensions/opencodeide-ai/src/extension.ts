/**
 * OpenCodeIDE AI Extension
 *
 * Agent sidebar + approval UI, wired into Code-OSS via VSCodeAIBridge.
 */

import * as vscode from 'vscode';
import { ChatViewProvider } from './views/chatView';
import { SessionsTreeProvider } from './views/sessionsTree';
import { TasksTreeProvider } from './views/tasksTree';
import { ApprovalDialog } from './ui/approvalDialog';
import { DiffPreview } from './ui/diffPreview';
import { VSCodeAIBridge } from './bridge/vscodeBridge';
import { TabEngine } from './tab/tabEngine';

let chatViewProvider: ChatViewProvider;
let sessionsTreeProvider: SessionsTreeProvider;
let tasksTreeProvider: TasksTreeProvider;
let bridge: VSCodeAIBridge;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('OpenCodeIDE AI');
    bridge = new VSCodeAIBridge(outputChannel);

    outputChannel.appendLine('OpenCodeIDE AI extension activated (Code-OSS bridge ready)');
    outputChannel.appendLine(`Workspace: ${bridge.getWorkspaceRoot() ?? '(none)'}`);

    chatViewProvider = new ChatViewProvider(context.extensionUri, bridge, outputChannel);
    sessionsTreeProvider = new SessionsTreeProvider();
    tasksTreeProvider = new TasksTreeProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('opencodeide-ai.chat', chatViewProvider)
    );
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('opencodeide-ai.sessions', sessionsTreeProvider)
    );
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('opencodeide-ai.tasks', tasksTreeProvider)
    );

    // Tab completion
    const tabEngine = new TabEngine();
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, tabEngine)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.newChat', () => chatViewProvider.newChat())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.runTask', async () => {
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
        vscode.commands.registerCommand('opencodeide-ai.cancelTask', () => chatViewProvider.cancelTask())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.configureProvider', async () => {
            const providers = ['openai', 'anthropic', 'google', 'ollama', 'custom'];
            const provider = await vscode.window.showQuickPick(providers, {
                placeHolder: 'Select AI provider',
            });
            if (!provider) return;

            const apiKey = await vscode.window.showInputBox({
                prompt: provider === 'ollama' ? 'API key (optional for Ollama)' : 'Enter API key',
                password: true,
            });

            const config = vscode.workspace.getConfiguration('opencodeide.ai');
            await config.update('provider', provider, vscode.ConfigurationTarget.Global);
            if (apiKey) {
                await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
            }
            vscode.window.showInformationMessage(`Configured ${provider} as AI provider`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showTrace', () => {
            outputChannel.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showApproval', async (request: ApprovalRequest) => {
            return ApprovalDialog.show(request);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showDiff', async (changes: FileChange[]) => {
            await DiffPreview.show(changes);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.inspectWorkspace', async () => {
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

    context.subscriptions.push(outputChannel);
}

export function deactivate() {
    outputChannel?.appendLine('OpenCodeIDE AI extension deactivated');
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
