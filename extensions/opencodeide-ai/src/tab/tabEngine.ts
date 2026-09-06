/**
 * OpenCodeIDE - Tab Completion Engine
 * 
 * Low-latency inline code completion.
 * Separate from the heavy agent loop for fast responses.
 */

import * as vscode from 'vscode';

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

/**
 * Tab Completion Engine
 * 
 * Provides fast inline completions without triggering the full agent
 */
export class TabEngine implements vscode.InlineCompletionItemProvider {
    private enabled = true;
    private minPrefixLength = 2;
    private maxLatencyMs = 100;
    private cache: Map<string, CacheEntry> = new Map();
    private cacheMaxSize = 100;

    /**
     * Provide inline completions
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {
        if (!this.enabled) return null;

        const startTime = Date.now();

        try {
            // Build context
            const tabContext = this.buildContext(document, position);

            // Check cache
            const cacheKey = this.getCacheKey(tabContext);
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < 5000) {
                return this.toCompletionList(cached.completions, position);
            }

            // Check prefix length
            if (tabContext.prefix.trim().length < this.minPrefixLength) {
                return null;
            }

            // Get completions from local model or API
            const completions = await this.getCompletions(tabContext, token);

            if (token.isCancellationRequested) return null;

            // Check latency
            const elapsed = Date.now() - startTime;
            if (elapsed > this.maxLatencyMs * 2) {
                console.warn(`Tab completion too slow: ${elapsed}ms`);
            }

            // Cache results
            this.updateCache(cacheKey, completions);

            return this.toCompletionList(completions, position);
        } catch (error) {
            console.error('Tab completion error:', error);
            return null;
        }
    }

    /**
     * Enable/disable tab completion
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Build context for completion
     */
    private buildContext(document: vscode.TextDocument, position: vscode.Position): TabContext {
        // Get prefix (text before cursor on current line + some context)
        const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
        const prefixLines = this.getPreviousLines(document, position, 5);
        const prefix = prefixLines + linePrefix;

        // Get suffix (text after cursor)
        const lineSuffix = document.lineAt(position.line).text.substring(position.character);
        const suffixLines = this.getNextLines(document, position, 3);
        const suffix = lineSuffix + suffixLines;

        // Get imports (first 20 lines usually contain imports)
        const imports = this.extractImports(document);

        // Get recent edits (placeholder - would track actual edits)
        const recentEdits: string[] = [];

        // Get diagnostics
        const diagnostics = vscode.languages.getDiagnostics(document.uri)
            .filter(d => d.range.contains(position) || 
                        d.range.start.line >= position.line - 5 && 
                        d.range.end.line <= position.line + 5);

        return {
            prefix,
            suffix,
            language: document.languageId,
            filePath: document.uri.fsPath,
            imports,
            recentEdits,
            diagnostics,
        };
    }

    /**
     * Get completions from model
     */
    private async getCompletions(context: TabContext, _token: vscode.CancellationToken): Promise<Completion[]> {
        // Build FIM (fill-in-middle) prompt
        const prompt = this.buildFIMPrompt(context);

        // For now, return placeholder completions
        // In production, this would call a local model or API
        return this.getLocalCompletions(context);
    }

    /**
     * Get local completions based on context patterns
     */
    private getLocalCompletions(context: TabContext): Completion[] {
        const completions: Completion[] = [];
        const prefix = context.prefix.trim();
        const lastLine = prefix.split('\n').pop() ?? '';

        // Common patterns
        const patterns: Array<{ match: RegExp; completion: string }> = [
            // Function definition
            { match: /^(\s*)function\s+(\w+)\s*\($/, completion: ')' },
            { match: /^(\s*)const\s+(\w+)\s*=\s*\($/, completion: ') => ' },
            { match: /^(\s*)const\s+(\w+)\s*=\s*async\s*\($/, completion: ') => ' },

            // Control flow
            { match: /^(\s*)if\s*\($/, completion: ')' },
            { match: /^(\s*)for\s*\($/, completion: ')' },
            { match: /^(\s*)while\s*\($/, completion: ')' },

            // Common methods
            { match: /\.map\s*\($/, completion: '(item) => ' },
            { match: /\.filter\s*\($/, completion: '(item) => ' },
            { match: /\.forEach\s*\($/, completion: '(item) => ' },
            { match: /\.reduce\s*\($/, completion: '(acc, item) => ' },

            // TypeScript
            { match: /^(\s*)interface\s+(\w+)\s*$/, completion: ' {\n}' },
            { match: /^(\s*)type\s+(\w+)\s*=\s*$/, completion: '' },
            { match: /^(\s*)class\s+(\w+)\s*$/, completion: ' {\n}' },

            // Imports
            { match: /^import\s+\{\s*$/, completion: ' } from ' },
            { match: /^import\s+(\w+)\s+from\s+$/, completion: '\'' },
        ];

        for (const { match, completion } of patterns) {
            if (match.test(lastLine)) {
                completions.push({
                    text: completion,
                    score: 0.8,
                });
            }
        }

        // Variable name completions based on context
        const varMatches = prefix.match(/\b(const|let|var)\s+(\w*)$/);
        if (varMatches) {
            const partialName = varMatches[2];
            // Suggest common names
            const suggestions = ['result', 'data', 'items', 'value', 'response', 'error'];
            for (const name of suggestions) {
                if (name.startsWith(partialName)) {
                    completions.push({
                        text: name.substring(partialName.length),
                        displayText: name,
                        score: 0.5,
                    });
                }
            }
        }

        return completions;
    }

    /**
     * Build FIM (fill-in-middle) prompt
     */
    private buildFIMPrompt(context: TabContext): string {
        return `<|fim_prefix|>${context.prefix}<|fim_suffix|>${context.suffix}<|fim_middle|>`;
    }

    /**
     * Convert completions to VS Code format
     */
    private toCompletionList(completions: Completion[], position: vscode.Position): vscode.InlineCompletionList {
        const items = completions
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(c => new vscode.InlineCompletionItem(
                c.text,
                c.range ?? new vscode.Range(position, position)
            ));

        return new vscode.InlineCompletionList(items);
    }

    /**
     * Get previous lines for context
     */
    private getPreviousLines(document: vscode.TextDocument, position: vscode.Position, count: number): string {
        const startLine = Math.max(0, position.line - count);
        const lines: string[] = [];

        for (let i = startLine; i < position.line; i++) {
            lines.push(document.lineAt(i).text);
        }

        return lines.join('\n') + '\n';
    }

    /**
     * Get next lines for context
     */
    private getNextLines(document: vscode.TextDocument, position: vscode.Position, count: number): string {
        const endLine = Math.min(document.lineCount - 1, position.line + count);
        const lines: string[] = [];

        for (let i = position.line + 1; i <= endLine; i++) {
            lines.push(document.lineAt(i).text);
        }

        return '\n' + lines.join('\n');
    }

    /**
     * Extract imports from document
     */
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

    /**
     * Get cache key
     */
    private getCacheKey(context: TabContext): string {
        return `${context.filePath}:${context.prefix.slice(-50)}`;
    }

    /**
     * Update cache
     */
    private updateCache(key: string, completions: Completion[]): void {
        // Limit cache size
        if (this.cache.size >= this.cacheMaxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            completions,
            timestamp: Date.now(),
        });
    }
}

interface CacheEntry {
    completions: Completion[];
    timestamp: number;
}
