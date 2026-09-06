/**
 * OpenCodeIDE - Tool Runtime
 * 
 * Executes native tools for the agent.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import {
    ToolSchema,
    ToolCall,
    ToolResult,
    Artifact,
} from '../types.js';
import { SandboxRuntime } from '../sandbox/runtime.js';
import { ArtifactStore } from '../artifacts/store.js';

// Native tool definitions
const NATIVE_TOOLS: ToolSchema[] = [
    {
        name: 'read',
        description: 'Read the contents of a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The file path to read' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write',
        description: 'Write content to a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The file path to write' },
                content: { type: 'string', description: 'The content to write' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'list',
        description: 'List files in a directory',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The directory path to list' },
                recursive: { type: 'boolean', description: 'Whether to list recursively' },
            },
            required: ['path'],
        },
    },
    {
        name: 'search',
        description: 'Search for text in files using grep-like syntax',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The search pattern (regex)' },
                path: { type: 'string', description: 'The path to search in' },
                glob: { type: 'string', description: 'File glob pattern to filter' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'shell',
        description: 'Execute a shell command',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to execute' },
                cwd: { type: 'string', description: 'Working directory' },
            },
            required: ['command'],
        },
    },
    {
        name: 'delete',
        description: 'Delete a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The file path to delete' },
            },
            required: ['path'],
        },
    },
    {
        name: 'rename',
        description: 'Rename or move a file',
        parameters: {
            type: 'object',
            properties: {
                oldPath: { type: 'string', description: 'The current file path' },
                newPath: { type: 'string', description: 'The new file path' },
            },
            required: ['oldPath', 'newPath'],
        },
    },
    {
        name: 'tool_describe',
        description: 'Get detailed schema for a tool',
        parameters: {
            type: 'object',
            properties: {
                toolName: { type: 'string', description: 'The tool name to describe' },
            },
            required: ['toolName'],
        },
    },
];

/**
 * Tool Runtime
 * 
 * Executes native tools for filesystem, terminal, and editor operations
 */
export class ToolRuntime {
    private sandbox: SandboxRuntime;
    private artifacts: ArtifactStore;
    private workspacePath: string = process.cwd();
    private initialized = false;

    constructor(sandbox: SandboxRuntime, artifacts: ArtifactStore) {
        this.sandbox = sandbox;
        this.artifacts = artifacts;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
    }

    setWorkspace(workspacePath: string): void {
        this.workspacePath = workspacePath;
    }

    /**
     * Get basic schemas for all tools (for prompt)
     */
    getSchemas(): ToolSchema[] {
        return NATIVE_TOOLS.map(t => ({
            ...t,
            description: t.description.substring(0, 100), // Truncate for prompt
        }));
    }

    /**
     * Get full schema for a specific tool
     */
    getFullSchema(toolName: string): ToolSchema | null {
        return NATIVE_TOOLS.find(t => t.name === toolName) ?? null;
    }

    /**
     * Execute a tool call
     */
    async execute(toolCall: ToolCall): Promise<ToolResult> {
        const startTime = Date.now();

        try {
            const result = await this.executeInternal(toolCall);
            return {
                toolCallId: toolCall.id,
                success: true,
                output: result.output,
                artifact: result.artifact,
                duration: Date.now() - startTime,
            };
        } catch (error) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime,
            };
        }
    }

    private async executeInternal(toolCall: ToolCall): Promise<{ output: string; artifact?: Artifact }> {
        const args = toolCall.arguments as Record<string, unknown>;

        switch (toolCall.name) {
            case 'read':
                return this.readFile(args.path as string);

            case 'write':
                return this.writeFile(args.path as string, args.content as string);

            case 'list':
                return this.listDirectory(args.path as string, args.recursive as boolean);

            case 'search':
                return this.searchFiles(args.pattern as string, args.path as string, args.glob as string);

            case 'shell':
                return this.executeShell(args.command as string, args.cwd as string);

            case 'delete':
                return this.deleteFile(args.path as string);

            case 'rename':
                return this.renameFile(args.oldPath as string, args.newPath as string);

            case 'tool_describe':
                return this.describeTools(args.toolName as string);

            default:
                throw new Error(`Unknown tool: ${toolCall.name}`);
        }
    }

    private resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) return filePath;
        return path.join(this.workspacePath, filePath);
    }

    private async readFile(filePath: string): Promise<{ output: string }> {
        const resolved = this.resolvePath(filePath);
        const content = await fs.readFile(resolved, 'utf-8');
        
        // If file is too large, create artifact
        if (content.length > 10000) {
            const preview = content.substring(0, 2000) + '\n\n... [truncated]';
            return { output: preview };
        }

        return { output: content };
    }

    private async writeFile(filePath: string, content: string): Promise<{ output: string }> {
        const resolved = this.resolvePath(filePath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf-8');
        return { output: `File written: ${filePath}` };
    }

    private async listDirectory(dirPath: string, recursive?: boolean): Promise<{ output: string }> {
        const resolved = this.resolvePath(dirPath);
        
        const listRecursive = async (dir: string, prefix: string = ''): Promise<string[]> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const results: string[] = [];

            for (const entry of entries) {
                const fullPath = path.join(prefix, entry.name);
                if (entry.isDirectory()) {
                    results.push(`${fullPath}/`);
                    if (recursive) {
                        const subEntries = await listRecursive(path.join(dir, entry.name), fullPath);
                        results.push(...subEntries);
                    }
                } else {
                    results.push(fullPath);
                }
            }

            return results;
        };

        const files = await listRecursive(resolved);
        return { output: files.join('\n') };
    }

    private async searchFiles(pattern: string, searchPath?: string, glob?: string): Promise<{ output: string }> {
        // Use sandbox for ripgrep search
        const cwd = searchPath ? this.resolvePath(searchPath) : this.workspacePath;
        let command = `rg --line-number "${pattern}"`;
        if (glob) {
            command += ` --glob "${glob}"`;
        }

        const result = await this.sandbox.execute(command, { level: 'safe-local', workingDirectory: cwd });
        return { output: result.stdout || 'No matches found' };
    }

    private async executeShell(command: string, cwd?: string): Promise<{ output: string; artifact?: Artifact }> {
        const workDir = cwd ? this.resolvePath(cwd) : this.workspacePath;
        const result = await this.sandbox.execute(command, { 
            level: 'restricted',
            workingDirectory: workDir,
            timeout: 30000,
        });

        const output = result.stdout + (result.stderr ? `\nSTDERR:\n${result.stderr}` : '');

        // If output is large, create artifact
        if (output.length > 5000) {
            const artifact = await this.artifacts.create('build-log', `shell-${uuid()}`, output);
            return {
                output: `Command completed. Exit code: ${result.exitCode}\n\nOutput (truncated):\n${output.substring(0, 1000)}...\n\nFull output saved to artifact.`,
                artifact,
            };
        }

        return { output: `Exit code: ${result.exitCode}\n\n${output}` };
    }

    private async deleteFile(filePath: string): Promise<{ output: string }> {
        const resolved = this.resolvePath(filePath);
        await fs.unlink(resolved);
        return { output: `File deleted: ${filePath}` };
    }

    private async renameFile(oldPath: string, newPath: string): Promise<{ output: string }> {
        const resolvedOld = this.resolvePath(oldPath);
        const resolvedNew = this.resolvePath(newPath);
        await fs.mkdir(path.dirname(resolvedNew), { recursive: true });
        await fs.rename(resolvedOld, resolvedNew);
        return { output: `File renamed: ${oldPath} -> ${newPath}` };
    }

    private async describeTools(toolName: string): Promise<{ output: string }> {
        const tool = NATIVE_TOOLS.find(t => t.name === toolName);
        if (!tool) {
            return { output: `Tool not found: ${toolName}` };
        }

        return {
            output: JSON.stringify(tool, null, 2),
        };
    }
}
