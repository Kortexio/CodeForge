/**
 * OpenCodeIDE - Code Intelligence Engine
 * 
 * Main engine for repository understanding and code search.
 */

import { CodeIndex, IncrementalIndexer } from './indexer.js';
import { HybridSearch, SearchResult } from './search.js';
import { SymbolExtractor, Symbol } from './symbols.js';

export interface CodeIntelligenceConfig {
    workspacePath: string;
    dataPath: string;
    ignorePaths?: string[];
}

/**
 * Code Intelligence Engine
 * 
 * Provides repository understanding capabilities
 */
export class CodeIntelligenceEngine {
    private config: CodeIntelligenceConfig;
    private index: CodeIndex;
    private indexer: IncrementalIndexer;
    private search: HybridSearch;
    private symbolExtractor: SymbolExtractor;
    private initialized = false;

    constructor(config: CodeIntelligenceConfig) {
        this.config = config;
        this.index = new CodeIndex(config.dataPath);
        this.indexer = new IncrementalIndexer(this.index, config.workspacePath);
        this.search = new HybridSearch(this.index);
        this.symbolExtractor = new SymbolExtractor();
    }

    /**
     * Initialize the engine
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await this.index.load();
        this.initialized = true;
    }

    /**
     * Index the workspace
     */
    async indexWorkspace(): Promise<{ filesIndexed: number; symbolsFound: number }> {
        return this.indexer.indexWorkspace();
    }

    /**
     * Update index for changed files
     */
    async updateFiles(changedFiles: string[]): Promise<void> {
        await this.indexer.updateIncremental(changedFiles);
    }

    /**
     * Search for code
     */
    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        return this.search.search(query, options);
    }

    /**
     * Find symbol by name
     */
    async findSymbol(name: string): Promise<Symbol[]> {
        return this.index.findSymbolsByName(name);
    }

    /**
     * Find references to a symbol
     */
    async findReferences(symbolId: string): Promise<Reference[]> {
        return this.index.findReferences(symbolId);
    }

    /**
     * Get file symbols
     */
    async getFileSymbols(filePath: string): Promise<Symbol[]> {
        return this.index.getFileSymbols(filePath);
    }

    /**
     * Get repository structure
     */
    async getRepositoryMap(): Promise<RepositoryMap> {
        return this.index.getRepositoryMap();
    }

    /**
     * Get related files
     */
    async getRelatedFiles(filePath: string): Promise<string[]> {
        return this.index.getRelatedFiles(filePath);
    }

    /**
     * Check if indexing is needed
     */
    async needsReindex(): Promise<boolean> {
        return this.index.needsReindex();
    }

    /**
     * Get index stats
     */
    getStats(): IndexStats {
        return this.index.getStats();
    }
}

export interface SearchOptions {
    maxResults?: number;
    filePattern?: string;
    symbolTypes?: string[];
    includeContent?: boolean;
}

export interface Reference {
    filePath: string;
    line: number;
    column: number;
    context: string;
}

export interface RepositoryMap {
    directories: DirectoryNode[];
    fileCount: number;
    languageStats: Record<string, number>;
}

export interface DirectoryNode {
    name: string;
    path: string;
    children: DirectoryNode[];
    files: FileNode[];
}

export interface FileNode {
    name: string;
    path: string;
    language: string;
    symbolCount: number;
}

export interface IndexStats {
    totalFiles: number;
    totalSymbols: number;
    lastIndexed: Date | null;
    indexSizeBytes: number;
}
