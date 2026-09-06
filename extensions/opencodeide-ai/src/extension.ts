/**
 * OpenCodeIDE AI Extension
 * 
 * Agent sidebar and approval UI for the embedded AI platform.
 */

import * as vscode from 'vscode';
import { ChatViewProvider } from './views/chatView';
import { SessionsTreeProvider } from './views/sessionsTree';
import { TasksTreeProvider } from './views/tasksTree';
import { ApprovalDialog } from './ui/approvalDialog';
import { DiffPreview } from './ui/diffPreview';

let chatViewProvider: ChatViewProvider;
let sessionsTreeProvider: SessionsTreeProvider;
let tasksTreeProvider: TasksTreeProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('OpenCodeIDE AI extension activated');

    // Initialize view providers
    chatViewProvider = new ChatViewProvider(context.extensionUri);
    sessionsTreeProvider = new SessionsTreeProvider();
    tasksTreeProvider = new TasksTreeProvider();

    // Register views
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('opencodeide-ai.chat', chatViewProvider)
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('opencodeide-ai.sessions', sessionsTreeProvider)
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('opencodeide-ai.tasks', tasksTreeProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.newChat', () => {
            chatViewProvider.newChat();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.runTask', async () => {
            const task = await vscode.window.showInputBox({
                prompt: 'Enter task description',
                placeHolder: 'e.g., Add input validation to the login form'
            });

            if (task) {
                await chatViewProvider.runTask(task);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.cancelTask', () => {
            chatViewProvider.cancelTask();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.configureProvider', async () => {
            const providers = ['openai', 'anthropic', 'google', 'ollama', 'custom'];
            const provider = await vscode.window.showQuickPick(providers, {
                placeHolder: 'Select AI provider'
            });

            if (provider) {
                const apiKey = await vscode.window.showInputBox({
                    prompt: 'Enter API key',
                    password: true
                });

                if (apiKey) {
                    const config = vscode.workspace.getConfiguration('opencodeide.ai');
                    await config.update('provider', provider, vscode.ConfigurationTarget.Global);
                    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Configured ${provider} as AI provider`);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showTrace', () => {
            // Show trace output panel
            const outputChannel = vscode.window.createOutputChannel('OpenCodeIDE AI Trace');
            outputChannel.show();
        })
    );

    // Register approval dialog command
    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showApproval', async (request: ApprovalRequest) => {
            return ApprovalDialog.show(request);
        })
    );

    // Register diff preview command
    context.subscriptions.push(
        vscode.commands.registerCommand('opencodeide-ai.showDiff', async (changes: FileChange[]) => {
            await DiffPreview.show(changes);
        })
    );
}

export function deactivate() {
    console.log('OpenCodeIDE AI extension deactivated');
}

// Types
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
