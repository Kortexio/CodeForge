/**
 * OpenCodeIDE AI - Chat View
 * 
 * Main chat interface for interacting with the AI agent.
 */

import * as vscode from 'vscode';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _messages: ChatMessage[] = [];

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        // Handle messages from webview
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

    /**
     * Start a new chat
     */
    newChat() {
        this._messages = [];
        this.updateView();
    }

    /**
     * Run a task
     */
    async runTask(task: string) {
        this.addMessage('user', task);
        this.addMessage('assistant', 'Processing task...', 'pending');
        
        // TODO: Connect to AI Platform
        // For now, simulate response
        setTimeout(() => {
            this.updateLastMessage('assistant', 'Task completed. I made the following changes:\n\n- Modified file1.ts\n- Created file2.ts');
        }, 2000);
    }

    /**
     * Cancel current task
     */
    async cancelTask() {
        // TODO: Implement cancellation
        vscode.window.showInformationMessage('Task cancelled');
    }

    private async handleUserMessage(text: string) {
        this.addMessage('user', text);
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
                messages: this._messages
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
            margin: 0;
            padding: 10px;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        
        .messages {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 10px;
        }
        
        .message {
            margin-bottom: 10px;
            padding: 8px 12px;
            border-radius: 6px;
        }
        
        .message.user {
            background-color: var(--vscode-input-background);
            margin-left: 20px;
        }
        
        .message.assistant {
            background-color: var(--vscode-editor-background);
            margin-right: 20px;
            border: 1px solid var(--vscode-panel-border);
        }
        
        .message.pending {
            opacity: 0.7;
        }
        
        .input-container {
            display: flex;
            gap: 5px;
        }
        
        #messageInput {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
        }
        
        button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .role-label {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
    </style>
</head>
<body>
    <div class="messages" id="messages">
        <div class="empty-state">
            <p>Start a conversation with the AI agent</p>
            <p>Ask questions, request changes, or describe tasks</p>
        </div>
    </div>
    
    <div class="input-container">
        <input type="text" id="messageInput" placeholder="Ask anything..." />
        <button id="sendButton">Send</button>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        
        function sendMessage() {
            const text = messageInput.value.trim();
            if (text) {
                vscode.postMessage({ type: 'sendMessage', text });
                messageInput.value = '';
            }
        }
        
        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
        
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'updateMessages') {
                renderMessages(message.messages);
            }
        });
        
        function renderMessages(messages) {
            if (messages.length === 0) {
                messagesContainer.innerHTML = \`
                    <div class="empty-state">
                        <p>Start a conversation with the AI agent</p>
                        <p>Ask questions, request changes, or describe tasks</p>
                    </div>
                \`;
                return;
            }
            
            messagesContainer.innerHTML = messages.map(m => \`
                <div class="message \${m.role} \${m.status || ''}">
                    <div class="role-label">\${m.role === 'user' ? 'You' : 'AI Agent'}</div>
                    <div>\${m.content.replace(/\\n/g, '<br>')}</div>
                </div>
            \`).join('');
            
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
