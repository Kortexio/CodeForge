/**
 * OpenCodeIDE - Symbol Extractor
 * 
 * Extracts symbols from source code files.
 */

import * as path from 'path';
import { v4 as uuid } from 'uuid';

export interface Symbol {
    id: string;
    name: string;
    kind: SymbolKind;
    filePath: string;
    line: number;
    column: number;
    endLine?: number;
    signature?: string;
    documentation?: string;
    parent?: string;
    children?: string[];
}

export type SymbolKind =
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'function'
    | 'method'
    | 'property'
    | 'variable'
    | 'constant'
    | 'module'
    | 'namespace';

/**
 * Symbol Extractor
 * 
 * Extracts symbols from source code using regex patterns
 * (For production, would use Tree-sitter or LSP)
 */
export class SymbolExtractor {
    /**
     * Extract symbols from file content
     */
    async extract(filePath: string, content: string): Promise<Symbol[]> {
        const ext = path.extname(filePath).toLowerCase();

        switch (ext) {
            case '.ts':
            case '.tsx':
                return this.extractTypeScript(filePath, content);
            case '.js':
            case '.jsx':
                return this.extractJavaScript(filePath, content);
            case '.py':
                return this.extractPython(filePath, content);
            case '.go':
                return this.extractGo(filePath, content);
            case '.rs':
                return this.extractRust(filePath, content);
            default:
                return this.extractGeneric(filePath, content);
        }
    }

    /**
     * Extract TypeScript symbols
     */
    private extractTypeScript(filePath: string, content: string): Symbol[] {
        const symbols: Symbol[] = [];
        const lines = content.split('\n');

        // Patterns
        const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
            // Classes
            { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 'class' },
            // Interfaces
            { regex: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 'interface' },
            // Types
            { regex: /^(?:export\s+)?type\s+(\w+)/gm, kind: 'type' },
            // Functions
            { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
            // Arrow functions assigned to const
            { regex: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/gm, kind: 'function' },
            // Enums
            { regex: /^(?:export\s+)?enum\s+(\w+)/gm, kind: 'enum' },
        ];

        for (const { regex, kind } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const line = content.substring(0, match.index).split('\n').length;
                const lineContent = lines[line - 1] ?? '';

                symbols.push({
                    id: uuid(),
                    name: match[1],
                    kind,
                    filePath,
                    line,
                    column: match.index - content.lastIndexOf('\n', match.index - 1),
                    signature: lineContent.trim(),
                });
            }
        }

        return symbols;
    }

    /**
     * Extract JavaScript symbols
     */
    private extractJavaScript(filePath: string, content: string): Symbol[] {
        // Similar to TypeScript but without type annotations
        return this.extractTypeScript(filePath, content);
    }

    /**
     * Extract Python symbols
     */
    private extractPython(filePath: string, content: string): Symbol[] {
        const symbols: Symbol[] = [];
        const lines = content.split('\n');

        const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
            // Classes
            { regex: /^class\s+(\w+)/gm, kind: 'class' },
            // Functions
            { regex: /^(?:async\s+)?def\s+(\w+)/gm, kind: 'function' },
            // Methods (indented def)
            { regex: /^\s+(?:async\s+)?def\s+(\w+)/gm, kind: 'method' },
        ];

        for (const { regex, kind } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const line = content.substring(0, match.index).split('\n').length;
                const lineContent = lines[line - 1] ?? '';

                symbols.push({
                    id: uuid(),
                    name: match[1],
                    kind,
                    filePath,
                    line,
                    column: match.index - content.lastIndexOf('\n', match.index - 1),
                    signature: lineContent.trim(),
                });
            }
        }

        return symbols;
    }

    /**
     * Extract Go symbols
     */
    private extractGo(filePath: string, content: string): Symbol[] {
        const symbols: Symbol[] = [];
        const lines = content.split('\n');

        const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
            // Functions
            { regex: /^func\s+(\w+)/gm, kind: 'function' },
            // Methods
            { regex: /^func\s+\([^)]+\)\s+(\w+)/gm, kind: 'method' },
            // Types
            { regex: /^type\s+(\w+)\s+(?:struct|interface)/gm, kind: 'type' },
        ];

        for (const { regex, kind } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const line = content.substring(0, match.index).split('\n').length;
                const lineContent = lines[line - 1] ?? '';

                symbols.push({
                    id: uuid(),
                    name: match[1],
                    kind,
                    filePath,
                    line,
                    column: match.index - content.lastIndexOf('\n', match.index - 1),
                    signature: lineContent.trim(),
                });
            }
        }

        return symbols;
    }

    /**
     * Extract Rust symbols
     */
    private extractRust(filePath: string, content: string): Symbol[] {
        const symbols: Symbol[] = [];
        const lines = content.split('\n');

        const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
            // Functions
            { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
            // Structs
            { regex: /^(?:pub\s+)?struct\s+(\w+)/gm, kind: 'class' },
            // Enums
            { regex: /^(?:pub\s+)?enum\s+(\w+)/gm, kind: 'enum' },
            // Traits
            { regex: /^(?:pub\s+)?trait\s+(\w+)/gm, kind: 'interface' },
            // Impl blocks
            { regex: /^impl(?:<[^>]+>)?\s+(\w+)/gm, kind: 'class' },
        ];

        for (const { regex, kind } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const line = content.substring(0, match.index).split('\n').length;
                const lineContent = lines[line - 1] ?? '';

                symbols.push({
                    id: uuid(),
                    name: match[1],
                    kind,
                    filePath,
                    line,
                    column: match.index - content.lastIndexOf('\n', match.index - 1),
                    signature: lineContent.trim(),
                });
            }
        }

        return symbols;
    }

    /**
     * Generic extraction for unknown languages
     */
    private extractGeneric(filePath: string, content: string): Symbol[] {
        const symbols: Symbol[] = [];
        const lines = content.split('\n');

        // Look for common patterns
        const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
            { regex: /\bclass\s+(\w+)/gm, kind: 'class' },
            { regex: /\bfunction\s+(\w+)/gm, kind: 'function' },
            { regex: /\bdef\s+(\w+)/gm, kind: 'function' },
            { regex: /\bfn\s+(\w+)/gm, kind: 'function' },
            { regex: /\bfunc\s+(\w+)/gm, kind: 'function' },
        ];

        for (const { regex, kind } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const line = content.substring(0, match.index).split('\n').length;
                const lineContent = lines[line - 1] ?? '';

                symbols.push({
                    id: uuid(),
                    name: match[1],
                    kind,
                    filePath,
                    line,
                    column: match.index - content.lastIndexOf('\n', match.index - 1),
                    signature: lineContent.trim(),
                });
            }
        }

        return symbols;
    }
}
