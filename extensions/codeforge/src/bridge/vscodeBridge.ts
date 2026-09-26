/**
 * CodeForge AI ↔ VS Code Bridge
 *
 * Connects the embedded AI platform tools to real VS Code APIs
 * (workspace FS, editor, terminal, diagnostics).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveSandboxLevel, runSandboxed, type SandboxLevel } from '../sandbox/runtime';
import { clipBuildOutput, clipData } from '../agent/clip';
import { applyEdit, excerptAround } from '../agent/editTool';
import { documentSymbolRanges, formatOutlineBlock } from '../intelligence/lspBridge';
import { getEditJournal } from '../agent/editJournal';

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
        return (
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.fallbackWorkspaceRoot
        );
    }

    /** Used when the Extension Development Host opens with no folder. */
    setFallbackWorkspaceRoot(root: string | undefined): void {
        this.fallbackWorkspaceRoot = root?.trim() || undefined;
    }

    private fallbackWorkspaceRoot: string | undefined;

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
                return this.readFile(String(args.path), {
					startLine:
						args.startLine !== undefined
							? Number(args.startLine)
							: args.offset !== undefined
								? Number(args.offset)
								: undefined,
					limit:
						args.limit !== undefined
							? Number(args.limit)
							: args.endLine !== undefined && args.startLine !== undefined
								? Math.max(1, Number(args.endLine) - Number(args.startLine) + 1)
								: undefined,
				});
            case 'write':
                return this.writeFile(String(args.path), String(args.content ?? ''));
            case 'edit':
                return this.editFile(
                    String(args.path),
                    String(args.old_string ?? ''),
                    String(args.new_string ?? ''),
                    args.replace_all === true || args.replace_all === 'true'
                );
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

    private async readFile(
		filePath: string,
		opts?: { startLine?: number; limit?: number }
	): Promise<string> {
        const uri = this.resolveUri(filePath);
        const budget =
            vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget') ?? 32768;
		// Default window ~ Cursor-style: prefer a slice, not the whole file.
		const defaultLineLimit = 120;
		const outlineMinLines = 200;
		const maxChars = Math.min(8000, Math.max(2500, Math.floor(budget * 0.2)));
        try {
			try {
				const st = await vscode.workspace.fs.stat(uri);
				if (st.type === vscode.FileType.Directory) {
					const listing = await this.listDirectory(filePath, false);
					return [
						`DIRECTORY ${filePath} — use list for folders; read is for files.`,
						listing,
					].join('\n');
				}
			} catch {
				/* fall through to read / FILE_NOT_FOUND */
			}
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
			const lines = text.split(/\r?\n/);
			const totalLines = lines.length;
			const start = Math.max(1, Math.floor(opts?.startLine ?? 1));
			const limit = Math.max(1, Math.min(400, Math.floor(opts?.limit ?? defaultLineLimit)));
			const hasWindow =
				(opts?.startLine !== undefined && Number.isFinite(opts.startLine)) ||
				(opts?.limit !== undefined && Number.isFinite(opts.limit));
			const from = start - 1;
			const slice = lines.slice(from, from + limit);
			let shown = slice;
			let body = shown.map((l, i) => `${String(from + i + 1).padStart(4, ' ')}|${l}`).join('\n');
			if (body.length > maxChars) {
				// Keep whole lines and report the real end line so a follow-up read continues exactly.
				let used = 0;
				let n = 0;
				while (n < slice.length && used + slice[n].length + 6 <= maxChars) {
					used += slice[n].length + 6;
					n++;
				}
				shown = slice.slice(0, Math.max(1, n));
				body = shown.map((l, i) => `${String(from + i + 1).padStart(4, ' ')}|${l}`).join('\n');
			}
			const shownEnd = from + shown.length;
			const tail =
				shownEnd < totalLines
					? `\n\n(lines ${start}-${shownEnd} of ${totalLines}; more: startLine=${shownEnd + 1})`
					: hasWindow || totalLines > defaultLineLimit
						? `\n\n(end of file — ${totalLines} lines)`
						: '';
			let outline = '';
			if (!hasWindow && totalLines > outlineMinLines) {
				try {
					const ranges = await documentSymbolRanges(filePath);
					outline = formatOutlineBlock(ranges, 40);
					if (outline) outline = `\n\n${outline}`;
				} catch {
					/* LSP unavailable */
				}
			}
			return `FILE ${filePath} lines ${start}-${shownEnd}/${totalLines}\n${body}${tail}${outline}`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/ENOENT|FileNotFound|no such file/i.test(message)) {
                // Bare filenames often mean docs/<name> in card-driven workspaces.
                const bare = !/[\\/]/.test(filePath) && !filePath.toLowerCase().startsWith('docs/');
                if (bare) {
                    try {
                        const docsPath = `docs/${filePath}`;
                        const docsUri = this.resolveUri(docsPath);
                        await vscode.workspace.fs.stat(docsUri);
                        const redirected = await this.readFile(docsPath, opts);
                        return [
                            `("${filePath}" is not at the workspace root — showing docs/${filePath})`,
                            redirected,
                        ].join('\n');
                    } catch {
                        /* fall through */
                    }
                }
                return [
                    `FILE_NOT_FOUND: ${filePath}`,
                    'This path does not exist yet. Create it with write if the task needs it; list/retrieve show existing names.',
                ].join('\n');
            }
            throw err;
        }
    }

    private async writeFile(filePath: string, content: string): Promise<string> {
        try {
            await getEditJournal().recordBeforeWrite(filePath, p => this.readRaw(p));
        } catch {
            /* journal is best-effort */
        }
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

    /** Current text of a workspace file, or undefined when it does not exist. */
    async readRaw(filePath: string): Promise<string | undefined> {
        try {
            const bytes = await vscode.workspace.fs.readFile(this.resolveUri(filePath));
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return undefined;
        }
    }

    private async editFile(
        filePath: string,
        oldString: string,
        newString: string,
        replaceAll: boolean
    ): Promise<string> {
        try {
            await getEditJournal().recordBeforeWrite(filePath, p => this.readRaw(p));
        } catch {
            /* journal is best-effort */
        }
        const current = await this.readRaw(filePath);
        if (current === undefined) {
            throw new Error(`FILE_NOT_FOUND: ${filePath} — use write to create a new file.`);
        }
        const result = applyEdit(current, oldString, newString, replaceAll);
        if (!result.ok) {
            throw new Error(`edit ${filePath}: ${result.error}`);
        }
        await vscode.workspace.fs.writeFile(this.resolveUri(filePath), Buffer.from(result.text, 'utf8'));
        const excerpt = clipData(excerptAround(result.text, result.firstLine, newString), 4000);
        const total = result.text.split(/\r?\n/).length;
        return `Edited ${filePath} (${result.count} replacement${result.count > 1 ? 's' : ''}; file now ${total} lines)\n${excerpt}`;
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
        const root = this.getWorkspaceRoot();
        const fs = await import('fs/promises');
        const pathMod = await import('path');

        // If searchPath is a single file, grep it in-process (no ripgrep).
        if (searchPath && root) {
            const abs = path.isAbsolute(searchPath)
                ? searchPath
                : pathMod.join(root, searchPath);
            try {
                const st = await fs.stat(abs);
                if (st.isFile()) {
                    const text = await fs.readFile(abs, 'utf8');
                    let regex: RegExp;
                    try {
                        regex = new RegExp(pattern, 'i');
                    } catch {
                        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    }
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length && matches.length < 60; i++) {
                        if (regex.test(lines[i])) {
                            matches.push(`${abs}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                        }
                    }
                    return matches.length
                        ? matches.join('\n')
                        : `No matches for ${pattern} in ${searchPath}`;
                }
            } catch {
                /* not a readable file — fall through */
            }
        }

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
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/ENOENT|ripgrep|spawn/i.test(msg)) {
                // unexpected — still try node scan
            }
        }

        // Node fallback (no ripgrep): limited workspace scan.
        try {
            const results = await vscode.workspace.findFiles(include, exclude, 400);
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, 'i');
            } catch {
                regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            }
            for (const uri of results) {
                if (matches.length >= 60) break;
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(bytes).toString('utf8');
                    if (text.includes('\u0000')) continue;
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length && matches.length < 60; i++) {
                        if (regex.test(lines[i])) {
                            matches.push(`${uri.fsPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                        }
                    }
                } catch {
                    /* skip unreadable */
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error: search failed (${msg}). Prefer retrieve or read a known path.`;
        }

        return matches.length ? matches.join('\n') : `No matches for ${pattern}`;
    }

    private async deleteFile(filePath: string): Promise<string> {
        try {
            await getEditJournal().recordBeforeWrite(filePath, p => this.readRaw(p), { deleting: true });
        } catch {
            /* journal is best-effort */
        }
        const uri = this.resolveUri(filePath);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return `Deleted ${filePath}`;
    }

    private async renameFile(oldPath: string, newPath: string): Promise<string> {
        try {
            await getEditJournal().recordBeforeWrite(oldPath, p => this.readRaw(p), { deleting: true });
            await getEditJournal().recordBeforeWrite(newPath, p => this.readRaw(p));
        } catch {
            /* journal is best-effort */
        }
        const from = this.resolveUri(oldPath);
        const to = this.resolveUri(newPath);
        await vscode.workspace.fs.rename(from, to, { overwrite: false });
        return `Renamed ${oldPath} -> ${newPath}`;
    }

    /** Write raw bytes without journaling (used by Undo / Restore). */
    async writeRaw(filePath: string, content: string): Promise<void> {
        const uri = this.resolveUri(filePath);
        const dir = vscode.Uri.joinPath(uri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            /* parent may exist */
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }

    /** Delete without journaling (used by Undo / Restore). */
    async deleteRaw(filePath: string): Promise<void> {
        await vscode.workspace.fs.delete(this.resolveUri(filePath), { useTrash: false });
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
        const cfg = vscode.workspace.getConfiguration('codeforge.ai');
        const level = resolveSandboxLevel(prepared.command, {
            requested: sandboxHint,
            risk: 'medium',
            configured: cfg.get<string>('shellSandbox'),
            fullFreedom: cfg.get<boolean>('fullAgentFreedom') === true,
        });
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
        const childEnv =
            level === 'unrestricted' || level === 'safe-local'
                ? { ...process.env }
                : scrubEnv(process.env);

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
                        `It keeps running; starting it again would conflict with this instance.]`;
                }
                this.output.appendLine(result.slice(0, 2500));
                resolve(result);
            };

            const child = spawn(shell, args, {
                cwd: prepared.cwd,
                env: childEnv,
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
    return text ? clipBuildOutput(text, maxChars) : '';
}

/**
 * Prefer running under the right cwd instead of `cd path && …`.
 * Keeps && for cmd.exe chaining on Windows.
 */
function prepareWindowsCommand(
    command: string,
    workspaceRoot: string
): { command: string; cwd: string; display: string; note?: string } {
    // Strip Unix pipes that fail on cmd.exe before any normalization.
    const pipeStripped = command
        .replace(/\s*\|\s*(tail|head|grep)\b[^|&;]*/gi, '')
        .trim();
    const pipeNote =
        pipeStripped !== command.trim()
            ? 'Removed Unix pipe (tail/head/grep) — shell is cmd.exe.'
            : undefined;
    const trimmed = pipeStripped;
    // cd X && rest  |  cd /d X && rest  |  cd X; rest
    const cdMatch = /^(?:cd(?:\s+\/d)?)\s+("([^"]+)"|([^\s&;]+))\s*(?:&&|;)\s*([\s\S]+)$/i.exec(
        trimmed
    );
    if (cdMatch) {
        const target = (cdMatch[2] || cdMatch[3] || '').trim();
        const rest = (cdMatch[4] || '').trim();
        if (target && rest) {
            const abs = path.isAbsolute(target)
                ? target
                : path.resolve(workspaceRoot, target);
            if (fs.existsSync(abs)) {
                return {
                    command: rest,
                    cwd: abs,
                    display: rest,
                    note: [pipeNote, `normalized: cwd → ${abs}`].filter(Boolean).join(' | '),
                };
            }
            return {
                command: rest,
                cwd: workspaceRoot,
                display: rest,
                note: [
                    pipeNote,
                    `cwd "${target}" does not exist — using workspace root`,
                ]
                    .filter(Boolean)
                    .join(' | '),
            };
        }
    }

    return {
        command: trimmed,
        cwd: workspaceRoot,
        display: trimmed,
        note: pipeNote,
    };
}
