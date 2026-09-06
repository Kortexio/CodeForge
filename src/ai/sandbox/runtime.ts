/**
 * OpenCodeIDE - Sandbox Runtime
 * 
 * Secure execution environment for shell commands.
 * Native implementation without Docker dependency.
 */

import { spawn } from 'child_process';
import { SandboxOptions, SandboxResult } from '../types.js';

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024; // 512MB

// Safe commands that can run directly
const SAFE_COMMANDS = [
    'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'fd',
    'git status', 'git log', 'git diff', 'git branch',
    'pwd', 'echo', 'whoami', 'date', 'wc',
    'node --version', 'npm --version', 'python --version',
];

/**
 * Sandbox Runtime
 * 
 * Executes commands with varying levels of isolation
 */
export class SandboxRuntime {
    private initialized = false;
    private platform: NodeJS.Platform;

    constructor() {
        this.platform = process.platform;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }

    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Execute a command in sandbox
     */
    async execute(command: string, options: SandboxOptions): Promise<SandboxResult> {
        const timeout = options.timeout ?? DEFAULT_TIMEOUT;
        const level = options.level ?? 'restricted';

        // Determine execution strategy based on level
        switch (level) {
            case 'safe-local':
                return this.executeSafeLocal(command, options, timeout);
            case 'restricted':
                return this.executeRestricted(command, options, timeout);
            case 'isolated':
                return this.executeIsolated(command, options, timeout);
            case 'container':
                return this.executeContainer(command, options, timeout);
            default:
                return this.executeRestricted(command, options, timeout);
        }
    }

    /**
     * Execute a safe command directly
     */
    private async executeSafeLocal(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // Check if command is in safe list
        const isSafe = SAFE_COMMANDS.some(safe => command.startsWith(safe));
        
        if (!isSafe) {
            // Fall back to restricted mode
            return this.executeRestricted(command, options, timeout);
        }

        return this.spawnCommand(command, options, timeout);
    }

    /**
     * Execute with restricted permissions
     */
    private async executeRestricted(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // Platform-specific restrictions
        if (this.platform === 'win32') {
            return this.executeRestrictedWindows(command, options, timeout);
        } else if (this.platform === 'darwin') {
            return this.executeRestrictedMac(command, options, timeout);
        } else {
            return this.executeRestrictedLinux(command, options, timeout);
        }
    }

    /**
     * Execute in isolated worker process
     */
    private async executeIsolated(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // For now, use restricted mode
        // TODO: Implement proper isolation with worker processes
        return this.executeRestricted(command, options, timeout);
    }

    /**
     * Execute in Docker container (optional)
     */
    private async executeContainer(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // Check if Docker is available
        try {
            await this.spawnCommand('docker --version', { ...options, level: 'safe-local' }, 5000);
        } catch {
            // Docker not available, fall back to isolated
            console.warn('Docker not available, falling back to isolated mode');
            return this.executeIsolated(command, options, timeout);
        }

        // Run in Docker
        const dockerCommand = `docker run --rm -v "${options.workingDirectory ?? process.cwd()}:/workspace" -w /workspace --memory=${options.memoryLimit ?? DEFAULT_MEMORY_LIMIT} ubuntu:latest sh -c "${command.replace(/"/g, '\\"')}"`;
        
        return this.spawnCommand(dockerCommand, { ...options, level: 'safe-local' }, timeout);
    }

    /**
     * Windows restricted execution
     */
    private async executeRestrictedWindows(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // Windows: Use Job Objects for resource limiting
        // For now, just run with timeout
        return this.spawnCommand(command, options, timeout);
    }

    /**
     * macOS restricted execution
     */
    private async executeRestrictedMac(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // macOS: Use sandbox-exec for sandboxing
        // For now, just run with timeout
        return this.spawnCommand(command, options, timeout);
    }

    /**
     * Linux restricted execution
     */
    private async executeRestrictedLinux(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        // Linux: Use seccomp + namespaces
        // For now, just run with timeout
        return this.spawnCommand(command, options, timeout);
    }

    /**
     * Spawn a command and return result
     */
    private spawnCommand(command: string, options: SandboxOptions, timeout: number): Promise<SandboxResult> {
        return new Promise((resolve) => {
            const startTime = Date.now();
            let stdout = '';
            let stderr = '';
            let killed = false;

            const shell = this.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
            const shellArgs = this.platform === 'win32' ? ['-Command', command] : ['-c', command];

            const proc = spawn(shell, shellArgs, {
                cwd: options.workingDirectory ?? process.cwd(),
                env: {
                    ...process.env,
                    // Limit some environment variables
                },
                timeout,
            });

            const timer = setTimeout(() => {
                killed = true;
                proc.kill('SIGKILL');
            }, timeout);

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                clearTimeout(timer);
                resolve({
                    exitCode: code ?? (killed ? 137 : -1),
                    stdout,
                    stderr,
                    duration: Date.now() - startTime,
                    killed,
                });
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                resolve({
                    exitCode: -1,
                    stdout: '',
                    stderr: err.message,
                    duration: Date.now() - startTime,
                    killed: false,
                });
            });
        });
    }
}
