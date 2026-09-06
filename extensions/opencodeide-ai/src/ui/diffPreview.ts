/**
 * OpenCodeIDE AI - Diff Preview
 * 
 * Shows multi-file diff for AI changes before applying.
 */

import * as vscode from 'vscode';

export interface FileChange {
    path: string;
    type: 'create' | 'modify' | 'delete' | 'rename';
    oldPath?: string;
    oldContent?: string;
    newContent?: string;
}

export class DiffPreview {
    private static panel: vscode.WebviewPanel | undefined;

    /**
     * Show diff preview for changes
     */
    static async show(changes: FileChange[]): Promise<{ accepted: string[]; rejected: string[] }> {
        const panel = vscode.window.createWebviewPanel(
            'opencodeide-diff',
            'AI Changes Preview',
            vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        DiffPreview.panel = panel;

        panel.webview.html = DiffPreview.getHtmlContent(changes);

        return new Promise((resolve) => {
            panel.webview.onDidReceiveMessage((message) => {
                if (message.type === 'accept') {
                    resolve({ accepted: message.files, rejected: [] });
                    panel.dispose();
                } else if (message.type === 'reject') {
                    resolve({ accepted: [], rejected: changes.map(c => c.path) });
                    panel.dispose();
                } else if (message.type === 'partial') {
                    resolve({
                        accepted: message.accepted,
                        rejected: message.rejected
                    });
                    panel.dispose();
                }
            });

            panel.onDidDispose(() => {
                resolve({ accepted: [], rejected: changes.map(c => c.path) });
            });
        });
    }

    /**
     * Show inline diff for a single file
     */
    static async showSingleFileDiff(
        originalUri: vscode.Uri,
        modifiedUri: vscode.Uri,
        title: string
    ): Promise<void> {
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            modifiedUri,
            title
        );
    }

    private static getHtmlContent(changes: FileChange[]): string {
        const changesHtml = changes.map((change, index) => `
            <div class="file-change" data-index="${index}">
                <div class="file-header">
                    <input type="checkbox" id="file-${index}" checked />
                    <label for="file-${index}">
                        <span class="change-type ${change.type}">${change.type}</span>
                        <span class="file-path">${change.path}</span>
                        ${change.oldPath ? `<span class="old-path">(from ${change.oldPath})</span>` : ''}
                    </label>
                </div>
                ${change.newContent ? `
                    <div class="diff-content">
                        <pre><code>${DiffPreview.escapeHtml(change.newContent.substring(0, 1000))}${change.newContent.length > 1000 ? '\n... (truncated)' : ''}</code></pre>
                    </div>
                ` : ''}
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Changes Preview</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        
        h1 {
            font-size: 1.5em;
            margin-bottom: 20px;
        }
        
        .summary {
            margin-bottom: 20px;
            padding: 10px;
            background-color: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }
        
        .file-change {
            margin-bottom: 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        
        .file-header {
            display: flex;
            align-items: center;
            padding: 10px;
            background-color: var(--vscode-sideBar-background);
        }
        
        .file-header input {
            margin-right: 10px;
        }
        
        .change-type {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.8em;
            margin-right: 10px;
        }
        
        .change-type.create { background-color: #28a745; color: white; }
        .change-type.modify { background-color: #ffc107; color: black; }
        .change-type.delete { background-color: #dc3545; color: white; }
        .change-type.rename { background-color: #17a2b8; color: white; }
        
        .diff-content {
            padding: 10px;
            max-height: 300px;
            overflow: auto;
            background-color: var(--vscode-editor-background);
        }
        
        pre {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        
        .actions {
            margin-top: 20px;
            display: flex;
            gap: 10px;
        }
        
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1em;
        }
        
        .accept {
            background-color: #28a745;
            color: white;
        }
        
        .reject {
            background-color: #dc3545;
            color: white;
        }
        
        .partial {
            background-color: #17a2b8;
            color: white;
        }
    </style>
</head>
<body>
    <h1>Review AI Changes</h1>
    
    <div class="summary">
        <strong>${changes.length}</strong> file(s) will be modified
    </div>
    
    <div class="changes">
        ${changesHtml}
    </div>
    
    <div class="actions">
        <button class="accept" onclick="acceptAll()">Accept All</button>
        <button class="partial" onclick="acceptSelected()">Accept Selected</button>
        <button class="reject" onclick="rejectAll()">Reject All</button>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function acceptAll() {
            vscode.postMessage({ type: 'accept', files: getAllFiles() });
        }
        
        function rejectAll() {
            vscode.postMessage({ type: 'reject' });
        }
        
        function acceptSelected() {
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            const accepted = [];
            const rejected = [];
            
            checkboxes.forEach((cb, index) => {
                const path = document.querySelector(\`.file-change[data-index="\${index}"] .file-path\`).textContent;
                if (cb.checked) {
                    accepted.push(path);
                } else {
                    rejected.push(path);
                }
            });
            
            vscode.postMessage({ type: 'partial', accepted, rejected });
        }
        
        function getAllFiles() {
            return Array.from(document.querySelectorAll('.file-path')).map(el => el.textContent);
        }
    </script>
</body>
</html>`;
    }

    private static escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
