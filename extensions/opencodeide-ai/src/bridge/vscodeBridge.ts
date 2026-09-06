/**
 * OpenCodeIDE AI ↔ VS Code Bridge
 *
 * Connects the embedded AI platform tools to real VS Code APIs
 * (workspace FS, editor, terminal, diagnostics).
 */

import * as vscode from 'vscode';
import * as path from 'path';

export interface BridgeToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface BridgeToolResult {
    toolCallId: string;
    success: boolean;
    output: string;
    error?: string;
}

/**
 * Executes agent tools against the live VS Code workspace
 */
export class VSCodeAIBridge {
    private output: vscode.OutputChannel;

    constructor(output: vscode.OutputChannel) {
        this.output = output;
    }

    getWorkspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    async execute(toolCall: BridgeToolCall): Promise<BridgeToolResult> {
        const start = Date.now();
        this.output.appendLine(`[bridge] ${toolCall.name} ${JSON.stringify(toolCall.arguments)}`);

        try {
            const output = await this.dispatch(toolCall);
            return {
                toolCallId: toolCall.id,
                success: true,
                output,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[bridge] error (${Date.now() - start}ms): ${message}`);
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: message,
            };
        }
    }

    private async dispatch(toolCall: BridgeToolCall): Promise<string> {
        const args = toolCall.arguments;

        switch (toolCall.name) {
            case 'read':
                return this.readFile(String(args.path));
            case 'write':
                return this.writeFile(String(args.path), String(args.content ?? ''));
            case 'list':
                return this.listDirectory(String(args.path ?? '.'), Boolean(args.recursive));
            case 'search':
                return this.search(String(args.pattern), args.path ? String(args.path) : undefined);
            case 'delete':
                return this.deleteFile(String(args.path));
            case 'rename':
                return this.renameFile(String(args.oldPath), String(args.newPath));
            case 'open':
                return this.openFile(String(args.path));
            case 'diagnostics':
                return this.getDiagnostics(args.path ? String(args.path) : undefined);
            case 'shell':
                return this.runInTerminal(String(args.command));
            default:
                throw new Error(`Unknown bridge tool: ${toolCall.name}`);
        }
    }

    private resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const root = this.getWorkspaceRoot();
        if (!root) {
            throw new Error('No workspace folder open');
        }
        return vscode.Uri.file(path.join(root, filePath));
    }

    private async readFile(filePath: string): Promise<string> {
        const uri = this.resolveUri(filePath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        if (text.length > 20000) {
            return text.slice(0, 20000) + '\n\n... [truncated]';
        }
        return text;
    }

    private async writeFile(filePath: string, content: string): Promise<string> {
        const uri = this.resolveUri(filePath);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return `Wrote ${filePath}`;
    }

    private async listDirectory(dirPath: string, recursive: boolean): Promise<string> {
        const uri = this.resolveUri(dirPath);
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const lines: string[] = [];

        for (const [name, type] of entries) {
            const isDir = type === vscode.FileType.Directory;
            lines.push(isDir ? `${name}/` : name);
            if (recursive && isDir) {
                const childPath = path.posix.join(dirPath.replace(/\\/g, '/'), name);
                const nested = await this.listDirectory(childPath, true);
                for (const line of nested.split('\n').filter(Boolean)) {
                    lines.push(`${name}/${line}`);
                }
            }
        }

        return lines.join('\n');
    }

    private async search(pattern: string, searchPath?: string): Promise<string> {
        const include = searchPath
            ? new vscode.RelativePattern(this.resolveUri(searchPath), '**/*')
            : undefined;

        const results = await vscode.workspace.findFiles(include ?? '**/*', '**/node_modules/**', 50);
        const matches: string[] = [];
        const regex = new RegExp(pattern, 'i');

        for (const uri of results) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const lines = text.split('\n');
                lines.forEach((line, index) => {
                    if (regex.test(line) && matches.length < 40) {
                        matches.push(`${uri.fsPath}:${index + 1}: ${line.trim()}`);
                    }
                });
            } catch {
                // skip unreadable files
            }
            if (matches.length >= 40) break;
        }

        return matches.length ? matches.join('\n') : 'No matches found';
    }

    private async deleteFile(filePath: string): Promise<string> {
        const uri = this.resolveUri(filePath);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return `Deleted ${filePath}`;
    }

    private async renameFile(oldPath: string, newPath: string): Promise<string> {
        const from = this.resolveUri(oldPath);
        const to = this.resolveUri(newPath);
        await vscode.workspace.fs.rename(from, to, { overwrite: false });
        return `Renamed ${oldPath} -> ${newPath}`;
    }

    private async openFile(filePath: string): Promise<string> {
        const uri = this.resolveUri(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        return `Opened ${filePath}`;
    }

    private getDiagnostics(filePath?: string): string {
        const all = vscode.languages.getDiagnostics();
        const lines: string[] = [];

        for (const [uri, diags] of all) {
            if (filePath && !uri.fsPath.replace(/\\/g, '/').endsWith(filePath.replace(/\\/g, '/'))) {
                continue;
            }
            for (const d of diags.slice(0, 20)) {
                lines.push(`${uri.fsPath}:${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`);
            }
        }

        return lines.length ? lines.join('\n') : 'No diagnostics';
    }

    private async runInTerminal(command: string): Promise<string> {
        const terminal = vscode.window.createTerminal({
            name: 'OpenCodeIDE Agent',
            cwd: this.getWorkspaceRoot(),
        });
        terminal.show(true);
        terminal.sendText(command, true);
        return `Sent to terminal: ${command}`;
    }
}
