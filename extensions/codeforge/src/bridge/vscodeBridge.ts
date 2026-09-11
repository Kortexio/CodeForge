/**
 * CodeForge AI ↔ VS Code Bridge
 *
 * Connects the embedded AI platform tools to real VS Code APIs
 * (workspace FS, editor, terminal, diagnostics).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { pickSandboxLevel, runSandboxed, type SandboxLevel } from '../sandbox/runtime';

export interface BridgeToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    abortSignal?: AbortSignal;
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

    /** Open/create the Agent Terminal so the user sees shell streaming before the first command. */
    async prepareAgentTerminal(): Promise<void> {
        const cwd = this.getWorkspaceRoot() ?? process.cwd();
        const mirror = this.ensureAgentTerminal(cwd);
        await mirror.ready;
        mirror.write('\x1b[90m[agent session ready — command output will stream here]\x1b[0m\r\n');
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
                return this.runInTerminal(
                    String(args.command),
                    toolCall.abortSignal,
                    args.sandbox ? (String(args.sandbox) as SandboxLevel) : undefined
                );
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
        const budget =
            vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget') ?? 32768;
        const maxChars = Math.min(12000, Math.max(4000, Math.floor(budget * 0.45)));
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            if (text.length > maxChars) {
                return text.slice(0, maxChars) + `\n\n... [truncated @ ${maxChars} chars — use symbols/retrieve for more]`;
            }
            return text;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/ENOENT|FileNotFound|no such file/i.test(message)) {
                return [
                    `FILE_NOT_FOUND: ${filePath}`,
                    'This path does not exist. Do NOT read it again.',
                    'If the task needs this file, create it with the write tool (include full content).',
                    'Otherwise continue with files that already exist (use list to discover names).',
                ].join('\n');
            }
            throw err;
        }
    }

    private async writeFile(filePath: string, content: string): Promise<string> {
        const uri = this.resolveUri(filePath);
        const dir = vscode.Uri.joinPath(uri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // parent may already exist
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        } catch {
            // open is best-effort
        }
        return `Wrote ${filePath} (${content.length} chars)`;
    }

    private async listDirectory(dirPath: string, recursive: boolean): Promise<string> {
        const normalized = (dirPath || '.').replace(/\\/g, '/');
        const uri = this.resolveUri(normalized === '' ? '.' : normalized);
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(uri);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Cannot list "${normalized}": ${message}`);
        }

        // Cursor-like: never dump the whole tree. Cap entries; shallow recurse only.
        const MAX_LINES = 80;
        const lines: string[] = [];
        let truncated = false;

        const walk = async (rel: string, depth: number): Promise<void> => {
            const target = this.resolveUri(rel === '' ? '.' : rel);
            let kids: [string, vscode.FileType][];
            try {
                kids = await vscode.workspace.fs.readDirectory(target);
            } catch {
                return;
            }
            for (const [name, type] of kids) {
                if (lines.length >= MAX_LINES) {
                    truncated = true;
                    return;
                }
                const isDir = type === vscode.FileType.Directory;
                const childRel = rel === '.' || rel === '' ? name : `${rel.replace(/\\/g, '/')}/${name}`;
                lines.push(isDir ? `${childRel}/` : childRel);
                if (recursive && isDir && depth < 1) {
                    await walk(childRel, depth + 1);
                }
            }
        };

        // Non-recursive: only immediate children (legacy format with name/ for dirs)
        if (!recursive) {
            for (const [name, type] of entries) {
                if (lines.length >= MAX_LINES) {
                    truncated = true;
                    break;
                }
                const isDir = type === vscode.FileType.Directory;
                lines.push(isDir ? `${name}/` : name);
            }
        } else {
            await walk(normalized === '' ? '.' : normalized, 0);
        }

        if (!lines.length) {
            return '(empty directory)';
        }
        if (truncated || recursive) {
            lines.push(
                recursive
                    ? `…[capped ≤${MAX_LINES} entries, max depth 1 — list a specific subfolder or use retrieve]`
                    : `…[capped ≤${MAX_LINES} entries]`
            );
        }
        return lines.join('\n');
    }

    private async search(pattern: string, searchPath?: string): Promise<string> {
        const matches: string[] = [];
        const include = searchPath
            ? new vscode.RelativePattern(this.resolveUri(searchPath), '**/*')
            : '**/*';
        const exclude = '**/{node_modules,.git,bin,obj,dist,out,.vs}/**';

        const ws = vscode.workspace as typeof vscode.workspace & {
            findTextInFiles?: (
                query: { pattern: string; isCaseSensitive?: boolean; isRegExp?: boolean },
                options: {
                    maxResults?: number;
                    previewOptions?: { matchLines: number; charsPerLine: number };
                    include?: string | vscode.RelativePattern;
                    exclude?: string;
                },
                callback: (result: {
                    uri: vscode.Uri;
                    preview?: { text?: string };
                    ranges?: Array<Array<{ start: { line: number } }>>;
                }) => void
            ) => Thenable<unknown>;
        };

        try {
            if (typeof ws.findTextInFiles === 'function') {
                await ws.findTextInFiles(
                    { pattern, isCaseSensitive: false, isRegExp: true },
                    {
                        maxResults: 60,
                        previewOptions: { matchLines: 1, charsPerLine: 200 },
                        include,
                        exclude,
                    },
                    result => {
                        const line = (result.ranges?.[0]?.[0]?.start.line ?? 0) + 1;
                        const preview = result.preview?.text?.trim() ?? '';
                        matches.push(`${result.uri.fsPath}:${line}: ${preview}`);
                    }
                );
                if (matches.length) {
                    return matches.join('\n');
                }
            }
        } catch {
            // fall through to full scan
        }

        const results = await vscode.workspace.findFiles(include, exclude, 800);
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, 'i');
        } catch {
            regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        for (const uri of results) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                if (bytes.byteLength > 400_000) continue;
                const text = Buffer.from(bytes).toString('utf8');
                const lines = text.split('\n');
                for (let index = 0; index < lines.length; index++) {
                    if (regex.test(lines[index]) && matches.length < 60) {
                        matches.push(`${uri.fsPath}:${index + 1}: ${lines[index].trim()}`);
                    }
                }
            } catch {
                // skip
            }
            if (matches.length >= 60) break;
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

    private agentPty: {
        write: (text: string) => void;
        ready: Promise<void>;
        terminal: vscode.Terminal;
    } | undefined;

    /** Background servers (dotnet run, etc.) kept alive so the PTY keeps streaming. */
    private backgroundChildren: import('child_process').ChildProcess[] = [];
    private activeShellChild: import('child_process').ChildProcess | undefined;

    private ensureAgentTerminal(cwd: string): {
        write: (text: string) => void;
        ready: Promise<void>;
        terminal: vscode.Terminal;
    } {
        if (this.agentPty) {
            try {
                this.agentPty.terminal.show(true);
            } catch {
                this.agentPty = undefined;
            }
            if (this.agentPty) {
                return this.agentPty;
            }
        }

        const writeEmitter = new vscode.EventEmitter<string>();
        const pending: string[] = [];
        let opened = false;

        const fire = (text: string) => {
            // PTY expects \r\n line endings
            const normalized = text.replace(/\r?\n/g, '\r\n');
            if (!opened) {
                pending.push(normalized);
                return;
            }
            writeEmitter.fire(normalized);
        };

        let resolveReady!: () => void;
        const ready = new Promise<void>(resolve => {
            resolveReady = resolve;
        });

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            open: () => {
                opened = true;
                writeEmitter.fire('\x1b[1mCodeForge Agent Terminal\x1b[0m\r\n');
                writeEmitter.fire(`cwd: ${cwd}\r\n`);
                writeEmitter.fire('(shell output streams here while the agent runs commands)\r\n\r\n');
                for (const chunk of pending) {
                    writeEmitter.fire(chunk);
                }
                pending.length = 0;
                resolveReady();
            },
            close: () => {
                this.agentPty = undefined;
                for (const child of this.backgroundChildren) {
                    try {
                        child.kill();
                    } catch {
                        /* ignore */
                    }
                }
                this.backgroundChildren = [];
            },
            handleInput: () => {
                // read-only mirror — ignore keystrokes
            },
        };

        const terminal = vscode.window.createTerminal({
            name: 'CodeForge Agent',
            pty,
        });
        terminal.show(true);
        void vscode.commands.executeCommand('workbench.action.terminal.focus');

        this.agentPty = {
            terminal,
            ready,
            write: fire,
        };

        // If open() is delayed, unblock after a short wait so spawn is not stuck forever.
        setTimeout(() => resolveReady(), 1500);

        return this.agentPty;
    }

    /** Kill foreground + background agent shell processes (Stop). */
    abortRunningShells(): void {
        for (const child of this.backgroundChildren) {
            try {
                child.kill();
            } catch {
                /* ignore */
            }
        }
        this.backgroundChildren = [];
        if (this.activeShellChild) {
            try {
                this.activeShellChild.kill();
            } catch {
                /* ignore */
            }
            this.activeShellChild = undefined;
        }
        try {
            this.agentPty?.write('\r\n\x1b[33m[aborted by user]\x1b[0m\r\n');
        } catch {
            /* ignore */
        }
    }

    private async runInTerminal(
        command: string,
        abortSignal?: AbortSignal,
        sandboxHint?: SandboxLevel
    ): Promise<string> {
        const cwd = this.getWorkspaceRoot();
        if (!cwd) {
            throw new Error('No workspace folder open — open a folder before running shell commands');
        }

        if (abortSignal?.aborted) {
            return 'exit 130\n(aborted before start)';
        }

        const prepared = prepareWindowsCommand(command, cwd);
        const level = pickSandboxLevel(prepared.command, sandboxHint, 'medium');
        this.output.appendLine(`[shell:${level}] $ ${prepared.display}`);
        if (prepared.note) {
            this.output.appendLine(`[shell] ${prepared.note}`);
        }

        const longRunning = isLongRunningCommand(prepared.command);
        const mirror = this.ensureAgentTerminal(prepared.cwd);
        await mirror.ready;
        mirror.write(`\r\n\x1b[36m$ ${prepared.display}\x1b[0m\r\n`);
        mirror.write(`\x1b[90m[sandbox=${level}]\x1b[0m\r\n`);
        if (longRunning) {
            mirror.write(
                '\x1b[33m[long-running — output streams here; agent continues after startup]\x1b[0m\r\n'
            );
        }

        // Long-running servers keep the live spawn + terminal mirror path.
        // Other commands go through the sandbox runtime (env scrub / policy).
        if (!longRunning) {
            const result = await runSandboxed({
                cwd: prepared.cwd,
                command: prepared.command,
                level,
                timeoutMs: 120_000,
                abortSignal,
                onStdout: t => mirror.write(t),
                onStderr: t => mirror.write(t),
            });
            const exit = result.aborted ? 130 : result.timedOut ? 124 : result.exitCode;
            mirror.write(`\x1b[90m[exit ${exit} sandbox=${result.level}]\x1b[0m\r\n`);
            const raw = `${result.stdout}${result.stderr ? '\n' + result.stderr : ''}`;
            const body = summarizeShellOutput(raw, 8000);
            let out = body
                ? `exit ${exit}\ncwd: ${prepared.cwd}\nsandbox: ${result.level}\n\n${body}`
                : `exit ${exit}\ncwd: ${prepared.cwd}\nsandbox: ${result.level}\n(no output)`;
            if (result.aborted) out += '\n\n[Aborted by user — Stop]';
            if (result.timedOut) out += '\n\n[Timeout]';
            this.output.appendLine(out.slice(0, 2500));
            return out;
        }

        const { spawn } = await import('child_process');
        const { scrubEnv } = await import('../sandbox/runtime');
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd.exe' : '/bin/bash';
        const args = isWin ? ['/d', '/s', '/c', prepared.command] : ['-lc', prepared.command];

        return new Promise(resolve => {
            const chunks: string[] = [];
            let settled = false;
            const finish = (
                code: number | null,
                opts?: { background?: boolean; pid?: number; aborted?: boolean }
            ) => {
                if (settled) return;
                settled = true;
                if (this.activeShellChild === child) {
                    this.activeShellChild = undefined;
                }
                abortSignal?.removeEventListener('abort', onAbort);
                const raw = chunks.join('');
                const exit = opts?.aborted ? 130 : code ?? 0;
                if (opts?.aborted) {
                    mirror.write('\x1b[33m[aborted by user]\x1b[0m\r\n');
                } else if (!opts?.background) {
                    mirror.write(`\x1b[90m[exit ${exit}]\x1b[0m\r\n`);
                } else {
                    mirror.write(
                        `\x1b[33m[still running in this terminal — pid ${opts.pid ?? '?'}]\x1b[0m\r\n`
                    );
                }
                const body = summarizeShellOutput(raw, 8000);
                let result = body
                    ? `exit ${exit}\ncwd: ${prepared.cwd}\nsandbox: ${level}\n\n${body}`
                    : `exit ${exit}\ncwd: ${prepared.cwd}\nsandbox: ${level}\n(no output)`;
                if (opts?.aborted) {
                    result += '\n\n[Aborted by user — Stop]';
                } else if (opts?.background) {
                    result +=
                        `\n\n[Process still running in Agent Terminal (pid ${opts.pid ?? '?'}). ` +
                        `Do NOT re-run the same server command. Continue with code edits; tell the user the app is up.]`;
                }
                this.output.appendLine(result.slice(0, 2500));
                resolve(result);
            };

            const child = spawn(shell, args, {
                cwd: prepared.cwd,
                env: scrubEnv(process.env),
                windowsHide: true,
            });
            this.activeShellChild = child;

            const onAbort = () => {
                try {
                    child.kill();
                } catch {
                    /* ignore */
                }
                finish(130, { aborted: true });
            };
            if (abortSignal) {
                if (abortSignal.aborted) {
                    onAbort();
                    return;
                }
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }

            const onChunk = (buf: Buffer) => {
                const text = buf.toString('utf8');
                chunks.push(text);
                mirror.write(text);
                if (
                    longRunning &&
                    !settled &&
                    /now listening|listening on|application started|started server|ready on/i.test(
                        chunks.join('')
                    )
                ) {
                    this.backgroundChildren.push(child);
                    finish(0, { background: true, pid: child.pid });
                }
            };

            child.stdout?.on('data', onChunk);
            child.stderr?.on('data', onChunk);
            child.on('error', err => {
                mirror.write(`\x1b[31m${err.message}\x1b[0m\r\n`);
                chunks.push(err.message);
                finish(1);
            });
            child.on('close', code => {
                if (!settled) {
                    finish(code);
                } else {
                    mirror.write(`\x1b[90m[background exit ${code ?? 0}]\x1b[0m\r\n`);
                }
            });

            const handoffMs = 12_000;
            setTimeout(() => {
                if (settled) return;
                this.backgroundChildren.push(child);
                finish(0, { background: true, pid: child.pid });
            }, handoffMs);
        });
    }
}

const LONG_RUNNING_RE =
    /\b(dotnet\s+run|dotnet\s+watch|npm\s+start|npm\s+run\s+dev|yarn\s+dev|pnpm\s+dev|cargo\s+run|flask\s+run|uvicorn\b|python\s+-m\s+http\.server)\b/i;

function isLongRunningCommand(command: string): boolean {
    return LONG_RUNNING_RE.test(command);
}

/**
 * Keep exit-relevant signal for the model: prefer errors/success lines + head/tail
 * instead of truncating mid-NuGet dump.
 */
export function summarizeShellOutput(raw: string, maxChars = 8000): string {
    const text = raw.replace(/\r\n/g, '\n').trim();
    if (!text) {
        return '';
    }
    if (text.length <= maxChars) {
        return text;
    }

    const lines = text.split('\n');
    const important = lines.filter(l =>
        /error|fail|success|warn|exception|notfound|unable|cannot|listening|now listening|application started|built successfully|packagereference|added package/i.test(
            l
        )
    );
    const headN = 40;
    const tailN = 40;
    const head = lines.slice(0, headN).join('\n');
    const tail = lines.slice(-tailN).join('\n');
    const signal =
        important.length > 0
            ? important.slice(0, 60).join('\n')
            : '(no strong error/success lines detected)';

    return [
        `[output summarized: ${text.length} chars → keep signal for the model]`,
        '--- important ---',
        signal,
        '--- head ---',
        head,
        '--- tail ---',
        tail,
    ].join('\n');
}

/**
 * Prefer running under the right cwd instead of `cd path && …`.
 * Keeps && for cmd.exe chaining on Windows.
 */
function prepareWindowsCommand(
    command: string,
    workspaceRoot: string
): { command: string; cwd: string; display: string; note?: string } {
    const trimmed = command.trim();
    // cd X && rest  |  cd /d X && rest  |  cd X; rest
    const cdMatch = /^(?:cd(?:\s+\/d)?)\s+("([^"]+)"|([^\s&;]+))\s*(?:&&|;)\s*([\s\S]+)$/i.exec(
        trimmed
    );
    if (cdMatch) {
        const target = (cdMatch[2] || cdMatch[3] || '').trim();
        const rest = (cdMatch[4] || '').trim();
        if (target && rest) {
            return {
                command: rest,
                cwd: target,
                display: rest,
                note: `normalized: cwd → ${target}`,
            };
        }
    }

    // If model still uses absolute path under workspace, leave command as-is for cmd.exe
    return {
        command: trimmed,
        cwd: workspaceRoot,
        display: trimmed,
    };
}
