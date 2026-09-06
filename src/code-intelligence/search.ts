/**
 * OpenCodeIDE - Hybrid Search
 * 
 * Combines lexical, structural, and semantic search.
 */

import { CodeIndex } from './indexer.js';
import { Symbol } from './symbols.js';

export interface SearchResult {
    type: 'symbol' | 'content' | 'file';
    path: string;
    name?: string;
    line?: number;
    content?: string;
    score: number;
    matchType: 'exact' | 'fuzzy' | 'semantic';
}

export interface SearchOptions {
    maxResults?: number;
    filePattern?: string;
    symbolTypes?: string[];
    includeContent?: boolean;
    searchTypes?: Array<'lexical' | 'structural' | 'semantic'>;
}

/**
 * Hybrid Search
 * 
 * Combines multiple search strategies for best results
 */
export class HybridSearch {
    private index: CodeIndex;

    constructor(index: CodeIndex) {
        this.index = index;
    }

    /**
     * Search using hybrid approach
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const maxResults = options.maxResults ?? 20;
        const searchTypes = options.searchTypes ?? ['lexical', 'structural'];

        const results: SearchResult[] = [];

        // 1. Structural search (symbol names)
        if (searchTypes.includes('structural')) {
            const symbolResults = await this.searchSymbols(query, options);
            results.push(...symbolResults);
        }

        // 2. Lexical search (content)
        if (searchTypes.includes('lexical')) {
            const contentResults = await this.searchContent(query, options);
            results.push(...contentResults);
        }

        // 3. Semantic search (embeddings) - placeholder
        if (searchTypes.includes('semantic')) {
            // TODO: Implement semantic search with embeddings
        }

        // Deduplicate and sort by score
        const deduped = this.deduplicateResults(results);
        return deduped.slice(0, maxResults);
    }

    /**
     * Search symbol names
     */
    private async searchSymbols(query: string, options: SearchOptions): Promise<SearchResult[]> {
        const symbols = this.index.findSymbolsByName(query);
        const results: SearchResult[] = [];

        for (const symbol of symbols) {
            // Filter by type if specified
            if (options.symbolTypes && !options.symbolTypes.includes(symbol.kind)) {
                continue;
            }

            // Filter by file pattern if specified
            if (options.filePattern && !this.matchPattern(symbol.filePath, options.filePattern)) {
                continue;
            }

            results.push({
                type: 'symbol',
                path: symbol.filePath,
                name: symbol.name,
                line: symbol.line,
                content: symbol.signature,
                score: this.calculateSymbolScore(symbol, query),
                matchType: symbol.name.toLowerCase() === query.toLowerCase() ? 'exact' : 'fuzzy',
            });
        }

        return results;
    }

    /**
     * Search content (lexical)
     */
    private async searchContent(query: string, _options: SearchOptions): Promise<SearchResult[]> {
        // For content search, we'd normally use ripgrep or similar
        // This is a placeholder that searches indexed symbols' signatures
        const symbols = this.index.getAllSymbols();
        const results: SearchResult[] = [];
        const queryLower = query.toLowerCase();

        for (const symbol of symbols) {
            if (symbol.signature?.toLowerCase().includes(queryLower)) {
                results.push({
                    type: 'content',
                    path: symbol.filePath,
                    line: symbol.line,
                    content: symbol.signature,
                    score: 0.5,
                    matchType: 'fuzzy',
                });
            }
        }

        return results;
    }

    /**
     * Calculate score for symbol match
     */
    private calculateSymbolScore(symbol: Symbol, query: string): number {
        const nameLower = symbol.name.toLowerCase();
        const queryLower = query.toLowerCase();
        let score = 0;

        // Exact match
        if (nameLower === queryLower) {
            score = 1.0;
        }
        // Starts with query
        else if (nameLower.startsWith(queryLower)) {
            score = 0.9;
        }
        // Contains query
        else if (nameLower.includes(queryLower)) {
            score = 0.7;
        }
        // Fuzzy match
        else {
            score = this.fuzzyScore(nameLower, queryLower);
        }

        // Boost by symbol type
        const typeBoosts: Record<string, number> = {
            'class': 0.1,
            'function': 0.08,
            'method': 0.07,
            'interface': 0.09,
            'type': 0.08,
        };
        score += typeBoosts[symbol.kind] ?? 0;

        return Math.min(score, 1.0);
    }

    /**
     * Calculate fuzzy match score
     */
    private fuzzyScore(text: string, query: string): number {
        let queryIndex = 0;
        let score = 0;
        let consecutiveMatches = 0;

        for (let i = 0; i < text.length && queryIndex < query.length; i++) {
            if (text[i] === query[queryIndex]) {
                queryIndex++;
                consecutiveMatches++;
                score += 0.1 + (consecutiveMatches * 0.05);
            } else {
                consecutiveMatches = 0;
            }
        }

        // Return 0 if not all query chars found
        if (queryIndex < query.length) return 0;

        return Math.min(score / query.length, 0.6);
    }

    /**
     * Match file path against pattern
     */
    private matchPattern(filePath: string, pattern: string): boolean {
        // Simple glob matching
        const regex = new RegExp(
            pattern
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.'),
            'i'
        );
        return regex.test(filePath);
    }

    /**
     * Deduplicate results
     */
    private deduplicateResults(results: SearchResult[]): SearchResult[] {
        const seen = new Set<string>();
        const deduped: SearchResult[] = [];

        // Sort by score first
        results.sort((a, b) => b.score - a.score);

        for (const result of results) {
            const key = `${result.path}:${result.line ?? 0}:${result.name ?? ''}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(result);
            }
        }

        return deduped;
    }
}
