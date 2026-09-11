/**
 * CodeForge - Tab Completion Engine (LLM FIM + local heuristics)
 */

import * as vscode from 'vscode';
import { AiSettingsStore } from '../settings/aiSettingsStore';

export interface TabContext {
    prefix: string;
    suffix: string;
    language: string;
    filePath: string;
    imports: string[];
    recentEdits: string[];
    diagnostics: vscode.Diagnostic[];
}

export interface Completion {
    text: string;
    displayText?: string;
    range?: vscode.Range;
    score: number;
}

export class TabEngine implements vscode.InlineCompletionItemProvider {
    private enabled = true;
    private minPrefixLength = 2;
    private maxLatencyMs = 200;
    private cache: Map<string, CacheEntry> = new Map();
    private cacheMaxSize = 100;
    private store?: AiSettingsStore;
    private inflight?: AbortController;

    setSettingsStore(store: AiSettingsStore): void {
        this.store = store;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {
        if (!this.enabled) return null;

        const cfg = vscode.workspace.getConfiguration('codeforge.ai');
        if (cfg.get<boolean>('tabCompletion') === false) {
            return null;
        }

        const startTime = Date.now();

        try {
            const tabContext = this.buildContext(document, position);
            const cacheKey = this.getCacheKey(tabContext);
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < 5000) {
                return this.toCompletionList(cached.completions, position);
            }

            if (tabContext.prefix.trim().length < this.minPrefixLength) {
                return null;
            }

            const completions = await this.getCompletions(tabContext, token);
            if (token.isCancellationRequested) return null;

            const elapsed = Date.now() - startTime;
            if (elapsed > this.maxLatencyMs * 3) {
                console.warn(`Tab completion slow: ${elapsed}ms`);
            }

            this.updateCache(cacheKey, completions);
            return this.toCompletionList(completions, position);
        } catch (error) {
            console.error('Tab completion error:', error);
            return this.toCompletionList(this.getLocalCompletions(this.buildContext(document, position)), position);
        }
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    private buildContext(document: vscode.TextDocument, position: vscode.Position): TabContext {
        const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
        const prefixLines = this.getPreviousLines(document, position, 20);
        const prefix = prefixLines + linePrefix;
        const lineSuffix = document.lineAt(position.line).text.substring(position.character);
        const suffixLines = this.getNextLines(document, position, 10);
        const suffix = lineSuffix + suffixLines;
        const imports = this.extractImports(document);
        const diagnostics = vscode.languages
            .getDiagnostics(document.uri)
            .filter(
                d =>
                    d.range.contains(position) ||
                    (d.range.start.line >= position.line - 5 && d.range.end.line <= position.line + 5)
            );

        return {
            prefix,
            suffix,
            language: document.languageId,
            filePath: document.uri.fsPath,
            imports,
            recentEdits: [],
            diagnostics,
        };
    }

    private async getCompletions(
        context: TabContext,
        token: vscode.CancellationToken
    ): Promise<Completion[]> {
        const local = this.getLocalCompletions(context);
        const llm = await this.getLlmCompletion(context, token);
        if (llm) {
            return [{ text: llm, score: 0.95 }, ...local];
        }
        return local;
    }

    private async getLlmCompletion(
        context: TabContext,
        token: vscode.CancellationToken
    ): Promise<string | null> {
        if (!this.store) return null;
        const { server, model } = this.store.getActiveSelection();
        if (!server || !model) return null;

        const provider = server.kind;
        const apiKey = server.apiKey ?? '';
        const baseUrl =
            server.baseUrl ||
            (provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : provider === 'lmstudio'
                  ? 'http://localhost:1234/v1'
                  : 'https://api.openai.com/v1');

        if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
            return null;
        }

        this.inflight?.abort();
        this.inflight = new AbortController();
        token.onCancellationRequested(() => this.inflight?.abort());

        const prompt = this.buildFIMPrompt(context);
        const url = `${baseUrl.replace(/\/$/, '')}/completions`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                signal: this.inflight.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model,
                    prompt,
                    max_tokens: 64,
                    temperature: 0.1,
                    stop: ['\n\n', '<|fim_suffix|>', '<|endoftext|>'],
                }),
            });

            if (!res.ok) {
                // Fallback: chat completions with instruction
                return this.getLlmChatFallback(baseUrl, apiKey, model, context, this.inflight.signal);
            }

            const data = (await res.json()) as {
                choices?: Array<{ text?: string; message?: { content?: string } }>;
            };
            const text = (data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? '')
                .replace(/\r/g, '')
                .split('\n')[0]
                ?.trim();
            return text || null;
        } catch {
            return null;
        }
    }

    private async getLlmChatFallback(
        baseUrl: string,
        apiKey: string,
        model: string,
        context: TabContext,
        signal: AbortSignal
    ): Promise<string | null> {
        try {
            const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model,
                    temperature: 0.1,
                    max_tokens: 48,
                    messages: [
                        {
                            role: 'system',
                            content:
                                'You are a code completion engine. Reply with ONLY the code to insert at the cursor. No markdown.',
                        },
                        {
                            role: 'user',
                            content: `Language: ${context.language}\nPREFIX:\n${context.prefix.slice(-1200)}\nSUFFIX:\n${context.suffix.slice(0, 400)}\nComplete the next tokens.`,
                        },
                    ],
                }),
            });
            if (!res.ok) return null;
            const data = (await res.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
            };
            const text = (data.choices?.[0]?.message?.content ?? '')
                .replace(/^```\w*\n?|\n?```$/g, '')
                .split('\n')[0]
                ?.trim();
            return text || null;
        } catch {
            return null;
        }
    }

    private getLocalCompletions(context: TabContext): Completion[] {
        const completions: Completion[] = [];
        const prefix = context.prefix.trim();
        const lastLine = prefix.split('\n').pop() ?? '';

        const patterns: Array<{ match: RegExp; completion: string }> = [
            { match: /^(\s*)function\s+(\w+)\s*\($/, completion: ')' },
            { match: /^(\s*)const\s+(\w+)\s*=\s*\($/, completion: ') => ' },
            { match: /^(\s*)const\s+(\w+)\s*=\s*async\s*\($/, completion: ') => ' },
            { match: /^(\s*)if\s*\($/, completion: ')' },
            { match: /^(\s*)for\s*\($/, completion: ')' },
            { match: /^(\s*)while\s*\($/, completion: ')' },
            { match: /\.map\s*\($/, completion: '(item) => ' },
            { match: /\.filter\s*\($/, completion: '(item) => ' },
            { match: /\.forEach\s*\($/, completion: '(item) => ' },
            { match: /\.reduce\s*\($/, completion: '(acc, item) => ' },
            { match: /^(\s*)interface\s+(\w+)\s*$/, completion: ' {\n}' },
            { match: /^(\s*)class\s+(\w+)\s*$/, completion: ' {\n}' },
            { match: /^import\s+\{\s*$/, completion: ' } from ' },
        ];

        for (const { match, completion } of patterns) {
            if (match.test(lastLine)) {
                completions.push({ text: completion, score: 0.8 });
            }
        }
        return completions;
    }

    private buildFIMPrompt(context: TabContext): string {
        return `<|fim_prefix|>${context.prefix.slice(-2000)}<|fim_suffix|>${context.suffix.slice(0, 500)}<|fim_middle|>`;
    }

    private toCompletionList(
        completions: Completion[],
        position: vscode.Position
    ): vscode.InlineCompletionList {
        const items = completions
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(c => new vscode.InlineCompletionItem(c.text, c.range ?? new vscode.Range(position, position)));
        return new vscode.InlineCompletionList(items);
    }

    private getPreviousLines(
        document: vscode.TextDocument,
        position: vscode.Position,
        count: number
    ): string {
        const startLine = Math.max(0, position.line - count);
        const lines: string[] = [];
        for (let i = startLine; i < position.line; i++) {
            lines.push(document.lineAt(i).text);
        }
        return lines.join('\n') + (lines.length ? '\n' : '');
    }

    private getNextLines(
        document: vscode.TextDocument,
        position: vscode.Position,
        count: number
    ): string {
        const endLine = Math.min(document.lineCount - 1, position.line + count);
        const lines: string[] = [];
        for (let i = position.line + 1; i <= endLine; i++) {
            lines.push(document.lineAt(i).text);
        }
        return lines.length ? '\n' + lines.join('\n') : '';
    }

    private extractImports(document: vscode.TextDocument): string[] {
        const imports: string[] = [];
        const maxLines = Math.min(30, document.lineCount);
        for (let i = 0; i < maxLines; i++) {
            const line = document.lineAt(i).text;
            if (line.match(/^import\s+|^from\s+|^require\s*\(/)) {
                imports.push(line);
            }
        }
        return imports;
    }

    private getCacheKey(context: TabContext): string {
        return `${context.filePath}:${context.prefix.slice(-50)}`;
    }

    private updateCache(key: string, completions: Completion[]): void {
        if (this.cache.size >= this.cacheMaxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }
        this.cache.set(key, { completions, timestamp: Date.now() });
    }
}

interface CacheEntry {
    completions: Completion[];
    timestamp: number;
}
