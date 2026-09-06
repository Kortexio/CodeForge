/**
 * OpenCodeIDE AI - Chat View
 *
 * Chat UI wired to VS Code bridge for real workspace actions.
 */

import * as vscode from 'vscode';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _messages: ChatMessage[] = [];
    private _bridge: VSCodeAIBridge;
    private _cancelled = false;

    constructor(extensionUri: vscode.Uri, bridge: VSCodeAIBridge, _output: vscode.OutputChannel) {
        this._extensionUri = extensionUri;
        this._bridge = bridge;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text);
                    break;
                case 'cancel':
                    await this.cancelTask();
                    break;
            }
        });
    }

    newChat() {
        this._messages = [];
        this._cancelled = false;
        this.updateView();
    }

    async runTask(task: string) {
        this._cancelled = false;
        this.addMessage('user', task);
        this.addMessage('assistant', 'Working...', 'pending');

        try {
            const reply = await this.executeLocalAgent(task);
            if (!this._cancelled) {
                this.updateLastMessage('assistant', reply);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateLastMessage('assistant', `Error: ${message}`);
        }
    }

    async cancelTask() {
        this._cancelled = true;
        vscode.window.showInformationMessage('Task cancelled');
        this.updateLastMessage('assistant', 'Cancelled.');
    }

    private async executeLocalAgent(task: string): Promise<string> {
        const root = this._bridge.getWorkspaceRoot();
        const config = vscode.workspace.getConfiguration('opencodeide.ai');
        const apiKey = config.get<string>('apiKey') ?? '';
        const provider = config.get<string>('provider') ?? 'openai';

        const lower = task.toLowerCase();
        if (lower.includes('list') && (lower.includes('file') || lower.includes('dir') || lower.includes('pasta'))) {
            const result = await this._bridge.execute({
                id: '1',
                name: 'list',
                arguments: { path: '.', recursive: false },
            });
            return `Workspace: ${root ?? '(none)'}\n\n${result.output}`;
        }

        if (lower.startsWith('read ') || lower.startsWith('abrir ') || lower.startsWith('open ')) {
            const filePath = task.split(/\s+/).slice(1).join(' ').trim().replace(/^["']|["']$/g, '');
            const result = await this._bridge.execute({
                id: '2',
                name: 'read',
                arguments: { path: filePath },
            });
            if (!result.success) {
                return `Could not read ${filePath}: ${result.error}`;
            }
            return `Contents of ${filePath}:\n\n\`\`\`\n${result.output}\n\`\`\``;
        }

        if (lower.startsWith('search ') || lower.startsWith('buscar ') || lower.startsWith('find ')) {
            const pattern = task.split(/\s+/).slice(1).join(' ').trim();
            const result = await this._bridge.execute({
                id: '3',
                name: 'search',
                arguments: { pattern },
            });
            return result.output;
        }

        if (!apiKey && provider !== 'ollama') {
            return [
                `OpenCodeIDE AI is running inside Code-OSS.`,
                `Workspace: ${root ?? '(none — open a folder)'}`,
                ``,
                `Configure a model provider to run full agent tasks:`,
                `Command Palette → "OpenCodeIDE AI: Configure AI Provider"`,
                ``,
                `Meanwhile you can try:`,
                `- "list files"`,
                `- "read README.md"`,
                `- "search TODO"`,
            ].join('\n');
        }

        return this.callLlm(task, provider, apiKey, root);
    }

    private async callLlm(task: string, provider: string, apiKey: string, root?: string): Promise<string> {
        const model = vscode.workspace.getConfiguration('opencodeide.ai').get<string>('model') ?? 'gpt-4o-mini';
        const baseUrl =
            vscode.workspace.getConfiguration('opencodeide.ai').get<string>('baseUrl') ||
            (provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : 'https://api.openai.com/v1');

        if (provider === 'anthropic') {
            return this.callAnthropic(task, apiKey, model, root);
        }

        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: provider === 'ollama' ? model || 'llama3.2' : model,
                messages: [
                    {
                        role: 'system',
                        content: `You are OpenCodeIDE Agent inside a Code-OSS based IDE. Workspace: ${root ?? 'none'}. Be concise and actionable.`,
                    },
                    { role: 'user', content: task },
                ],
                temperature: 0.2,
            }),
        });

        if (!response.ok) {
            throw new Error(`LLM error ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? '(empty response)';
    }

    private async callAnthropic(task: string, apiKey: string, model: string, root?: string): Promise<string> {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: model.includes('claude') ? model : 'claude-3-5-sonnet-20241022',
                max_tokens: 1024,
                system: `You are OpenCodeIDE Agent. Workspace: ${root ?? 'none'}`,
                messages: [{ role: 'user', content: task }],
            }),
        });

        if (!response.ok) {
            throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as {
            content?: Array<{ type: string; text?: string }>;
        };
        return data.content?.find(c => c.type === 'text')?.text ?? '(empty response)';
    }

    private async handleUserMessage(text: string) {
        await this.runTask(text);
    }

    private addMessage(role: 'user' | 'assistant', content: string, status?: string) {
        this._messages.push({ role, content, status, timestamp: new Date() });
        this.updateView();
    }

    private updateLastMessage(role: 'user' | 'assistant', content: string, status?: string) {
        const lastIndex = this._messages.length - 1;
        if (lastIndex >= 0 && this._messages[lastIndex].role === role) {
            this._messages[lastIndex].content = content;
            this._messages[lastIndex].status = status;
        }
        this.updateView();
    }

    private updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateMessages',
                messages: this._messages,
            });
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenCodeIDE AI</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            margin: 0; padding: 10px; display: flex; flex-direction: column;
            height: 100vh; box-sizing: border-box;
        }
        .messages { flex: 1; overflow-y: auto; margin-bottom: 10px; }
        .message { margin-bottom: 10px; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; }
        .message.user { background-color: var(--vscode-input-background); margin-left: 20px; }
        .message.assistant {
            background-color: var(--vscode-editor-background);
            margin-right: 20px; border: 1px solid var(--vscode-panel-border);
        }
        .message.pending { opacity: 0.7; }
        .input-container { display: flex; gap: 5px; }
        #messageInput {
            flex: 1; padding: 8px; border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border-radius: 4px;
        }
        button {
            padding: 8px 16px; background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer;
        }
        .empty-state { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
        .role-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    </style>
</head>
<body>
    <div class="messages" id="messages">
        <div class="empty-state">
            <p><strong>OpenCodeIDE AI</strong></p>
            <p>Running on Code-OSS</p>
            <p>Try: list files · read README.md · search TODO</p>
        </div>
    </div>
    <div class="input-container">
        <input type="text" id="messageInput" placeholder="Ask the agent..." />
        <button id="sendButton">Send</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        function sendMessage() {
            const text = messageInput.value.trim();
            if (text) { vscode.postMessage({ type: 'sendMessage', text }); messageInput.value = ''; }
        }
        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
        window.addEventListener('message', (event) => {
            if (event.data.type === 'updateMessages') renderMessages(event.data.messages);
        });
        function renderMessages(messages) {
            if (!messages.length) {
                messagesContainer.innerHTML = '<div class="empty-state"><p><strong>OpenCodeIDE AI</strong></p><p>Running on Code-OSS</p></div>';
                return;
            }
            messagesContainer.innerHTML = messages.map(m =>
                '<div class="message ' + m.role + ' ' + (m.status || '') + '">' +
                '<div class="role-label">' + (m.role === 'user' ? 'You' : 'AI Agent') + '</div>' +
                '<div>' + escapeHtml(m.content) + '</div></div>'
            ).join('');
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        function escapeHtml(text) {
            return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }
    </script>
</body>
</html>`;
    }
}

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    status?: string;
    timestamp: Date;
}
