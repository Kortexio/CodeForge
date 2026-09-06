/**
 * OpenCodeIDE - Code Indexer
 * 
 * Incremental indexing with Merkle tree for change detection.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Symbol, SymbolExtractor } from './symbols.js';

/**
 * Code Index
 * 
 * In-memory and persistent index of code symbols
 */
export class CodeIndex {
    private dataPath: string;
    private symbols: Map<string, Symbol> = new Map();
    private fileSymbols: Map<string, string[]> = new Map(); // filePath -> symbolIds
    private references: Map<string, Reference[]> = new Map(); // symbolId -> references
    private fileHashes: Map<string, string> = new Map(); // filePath -> hash
    private lastIndexed: Date | null = null;

    constructor(dataPath: string) {
        this.dataPath = path.join(dataPath, 'code-index');
    }

    /**
     * Load index from disk
     */
    async load(): Promise<void> {
        try {
            await fs.mkdir(this.dataPath, { recursive: true });

            const indexPath = path.join(this.dataPath, 'index.json');
            const data = await fs.readFile(indexPath, 'utf-8');
            const parsed = JSON.parse(data);

            this.symbols = new Map(Object.entries(parsed.symbols));
            this.fileSymbols = new Map(Object.entries(parsed.fileSymbols));
            this.references = new Map(Object.entries(parsed.references));
            this.fileHashes = new Map(Object.entries(parsed.fileHashes));
            this.lastIndexed = parsed.lastIndexed ? new Date(parsed.lastIndexed) : null;
        } catch {
            // No existing index
        }
    }

    /**
     * Save index to disk
     */
    async save(): Promise<void> {
        const data = {
            symbols: Object.fromEntries(this.symbols),
            fileSymbols: Object.fromEntries(this.fileSymbols),
            references: Object.fromEntries(this.references),
            fileHashes: Object.fromEntries(this.fileHashes),
            lastIndexed: this.lastIndexed?.toISOString(),
        };

        await fs.writeFile(
            path.join(this.dataPath, 'index.json'),
            JSON.stringify(data, null, 2)
        );
    }

    /**
     * Add symbols for a file
     */
    addFileSymbols(filePath: string, symbols: Symbol[], hash: string): void {
        // Remove old symbols
        this.removeFileSymbols(filePath);

        // Add new symbols
        const symbolIds: string[] = [];
        for (const symbol of symbols) {
            this.symbols.set(symbol.id, symbol);
            symbolIds.push(symbol.id);
        }

        this.fileSymbols.set(filePath, symbolIds);
        this.fileHashes.set(filePath, hash);
    }

    /**
     * Remove symbols for a file
     */
    removeFileSymbols(filePath: string): void {
        const symbolIds = this.fileSymbols.get(filePath) ?? [];
        for (const id of symbolIds) {
            this.symbols.delete(id);
            this.references.delete(id);
        }
        this.fileSymbols.delete(filePath);
        this.fileHashes.delete(filePath);
    }

    /**
     * Get file hash
     */
    getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    /**
     * Find symbols by name
     */
    findSymbolsByName(name: string): Symbol[] {
        const nameLower = name.toLowerCase();
        return Array.from(this.symbols.values())
            .filter(s => s.name.toLowerCase().includes(nameLower));
    }

    /**
     * Get symbols for a file
     */
    getFileSymbols(filePath: string): Symbol[] {
        const symbolIds = this.fileSymbols.get(filePath) ?? [];
        return symbolIds.map(id => this.symbols.get(id)).filter(Boolean) as Symbol[];
    }

    /**
     * Add reference
     */
    addReference(symbolId: string, ref: Reference): void {
        const refs = this.references.get(symbolId) ?? [];
        refs.push(ref);
        this.references.set(symbolId, refs);
    }

    /**
     * Find references
     */
    findReferences(symbolId: string): Reference[] {
        return this.references.get(symbolId) ?? [];
    }

    /**
     * Get all symbols
     */
    getAllSymbols(): Symbol[] {
        return Array.from(this.symbols.values());
    }

    /**
     * Get related files (files that share symbols)
     */
    getRelatedFiles(filePath: string): string[] {
        const fileSymbolIds = new Set(this.fileSymbols.get(filePath) ?? []);
        const relatedFiles = new Set<string>();

        for (const [otherPath, symbolIds] of this.fileSymbols) {
            if (otherPath === filePath) continue;

            for (const id of symbolIds) {
                if (fileSymbolIds.has(id)) {
                    relatedFiles.add(otherPath);
                    break;
                }
            }
        }

        return Array.from(relatedFiles);
    }

    /**
     * Get repository map
     */
    getRepositoryMap(): { directories: DirectoryNode[]; fileCount: number; languageStats: Record<string, number> } {
        const languageStats: Record<string, number> = {};
        const rootDirs = new Map<string, DirectoryNode>();

        for (const filePath of this.fileSymbols.keys()) {
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            const fileName = path.basename(filePath);

            languageStats[ext] = (languageStats[ext] ?? 0) + 1;

            if (!rootDirs.has(dir)) {
                rootDirs.set(dir, {
                    name: path.basename(dir) || dir,
                    path: dir,
                    children: [],
                    files: [],
                });
            }

            rootDirs.get(dir)!.files.push({
                name: fileName,
                path: filePath,
                language: ext.replace('.', '') || 'unknown',
                symbolCount: (this.fileSymbols.get(filePath) ?? []).length,
            });
        }

        return {
            directories: Array.from(rootDirs.values()),
            fileCount: this.fileSymbols.size,
            languageStats,
        };
    }

    /**
     * Check if reindex is needed
     */
    needsReindex(): boolean {
        return !this.lastIndexed || this.symbols.size === 0;
    }

    /**
     * Set last indexed time
     */
    setLastIndexed(date: Date): void {
        this.lastIndexed = date;
    }

    /**
     * Get stats
     */
    getStats(): { totalFiles: number; totalSymbols: number; lastIndexed: Date | null; indexSizeBytes: number } {
        return {
            totalFiles: this.fileSymbols.size,
            totalSymbols: this.symbols.size,
            lastIndexed: this.lastIndexed,
            indexSizeBytes: 0, // TODO: Calculate
        };
    }
}

/**
 * Reference to a symbol
 */
interface Reference {
    filePath: string;
    line: number;
    column: number;
    context: string;
}

/**
 * Directory node for repository map
 */
interface DirectoryNode {
    name: string;
    path: string;
    children: DirectoryNode[];
    files: FileNode[];
}

/**
 * File node for repository map
 */
interface FileNode {
    name: string;
    path: string;
    language: string;
    symbolCount: number;
}

/**
 * Incremental Indexer
 * 
 * Indexes files incrementally using content hashing
 */
export class IncrementalIndexer {
    private index: CodeIndex;
    private workspacePath: string;
    private symbolExtractor: SymbolExtractor;
    private ignorePaths: Set<string>;

    constructor(index: CodeIndex, workspacePath: string) {
        this.index = index;
        this.workspacePath = workspacePath;
        this.symbolExtractor = new SymbolExtractor();
        this.ignorePaths = new Set([
            'node_modules',
            '.git',
            'dist',
            'build',
            'out',
            '.next',
            '__pycache__',
            'venv',
            '.venv',
        ]);
    }

    /**
     * Index entire workspace
     */
    async indexWorkspace(): Promise<{ filesIndexed: number; symbolsFound: number }> {
        const files = await this.findFiles(this.workspacePath);
        let filesIndexed = 0;
        let symbolsFound = 0;

        for (const filePath of files) {
            const result = await this.indexFile(filePath);
            if (result.indexed) {
                filesIndexed++;
                symbolsFound += result.symbolCount;
            }
        }

        this.index.setLastIndexed(new Date());
        await this.index.save();

        return { filesIndexed, symbolsFound };
    }

    /**
     * Update index for changed files
     */
    async updateIncremental(changedFiles: string[]): Promise<void> {
        for (const filePath of changedFiles) {
            const fullPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.workspacePath, filePath);

            try {
                await fs.access(fullPath);
                await this.indexFile(fullPath);
            } catch {
                // File deleted
                this.index.removeFileSymbols(fullPath);
            }
        }

        await this.index.save();
    }

    /**
     * Index a single file
     */
    private async indexFile(filePath: string): Promise<{ indexed: boolean; symbolCount: number }> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const hash = this.hashContent(content);

            // Skip if unchanged
            if (this.index.getFileHash(filePath) === hash) {
                return { indexed: false, symbolCount: 0 };
            }

            // Extract symbols
            const symbols = await this.symbolExtractor.extract(filePath, content);
            this.index.addFileSymbols(filePath, symbols, hash);

            return { indexed: true, symbolCount: symbols.length };
        } catch {
            return { indexed: false, symbolCount: 0 };
        }
    }

    /**
     * Find all indexable files
     */
    private async findFiles(dir: string): Promise<string[]> {
        const files: string[] = [];

        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (this.ignorePaths.has(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                const subFiles = await this.findFiles(fullPath);
                files.push(...subFiles);
            } else if (this.isIndexableFile(entry.name)) {
                files.push(fullPath);
            }
        }

        return files;
    }

    /**
     * Check if file should be indexed
     */
    private isIndexableFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        const indexableExtensions = [
            '.ts', '.tsx', '.js', '.jsx',
            '.py', '.pyw',
            '.java', '.kt', '.scala',
            '.cs', '.fs',
            '.go',
            '.rs',
            '.rb',
            '.php',
            '.c', '.cpp', '.h', '.hpp',
            '.swift',
            '.vue', '.svelte',
        ];
        return indexableExtensions.includes(ext);
    }

    /**
     * Hash file content
     */
    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    }
}
