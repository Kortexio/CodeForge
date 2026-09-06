/**
 * OpenCodeIDE - Git Intelligence Engine
 * 
 * Main engine for Git understanding and AI operations.
 */

import { spawn } from 'child_process';
import { CommitAnalyzer, Commit, BlameInfo } from './commits.js';
import { ConflictResolver, Conflict, Resolution } from './conflicts.js';

export interface GitIntelligenceConfig {
    workspacePath: string;
    modelCallback: (prompt: string) => Promise<string>;
}

/**
 * Git Intelligence Engine
 * 
 * Provides AI-powered Git operations
 */
export class GitIntelligenceEngine {
    private config: GitIntelligenceConfig;
    private commitAnalyzer: CommitAnalyzer;
    private conflictResolver: ConflictResolver;

    constructor(config: GitIntelligenceConfig) {
        this.config = config;
        this.commitAnalyzer = new CommitAnalyzer(config.modelCallback);
        this.conflictResolver = new ConflictResolver(config.modelCallback);
    }

    /**
     * Generate commit message from staged changes
     */
    async generateCommitMessage(): Promise<string> {
        const diff = await this.git(['diff', '--cached']);
        return this.commitAnalyzer.generateMessage(diff);
    }

    /**
     * Generate PR description
     */
    async generatePRDescription(baseBranch: string = 'main'): Promise<string> {
        const currentBranch = await this.git(['branch', '--show-current']);
        const commits = await this.getCommitsBetween(baseBranch, currentBranch.trim());
        const diff = await this.git(['diff', `${baseBranch}...${currentBranch.trim()}`]);

        return this.commitAnalyzer.generatePRDescription(commits, diff);
    }

    /**
     * Explain a diff
     */
    async explainDiff(diff: string): Promise<string> {
        return this.commitAnalyzer.explainDiff(diff);
    }

    /**
     * Summarize branch changes
     */
    async summarizeBranch(branch?: string): Promise<string> {
        const currentBranch = branch ?? (await this.git(['branch', '--show-current'])).trim();
        const commits = await this.getRecentCommits(currentBranch, 10);
        return this.commitAnalyzer.summarizeBranch(commits);
    }

    /**
     * Analyze blame for a file
     */
    async analyzeBlame(filePath: string, line: number): Promise<BlameInfo> {
        const blame = await this.git(['blame', '-L', `${line},${line}`, '--porcelain', filePath]);
        return this.commitAnalyzer.parseBlame(blame, line);
    }

    /**
     * Find conflicts in current merge/rebase
     */
    async findConflicts(): Promise<Conflict[]> {
        const status = await this.git(['status', '--porcelain']);
        const conflictFiles = status.split('\n')
            .filter(line => line.startsWith('UU') || line.startsWith('AA'))
            .map(line => line.substring(3));

        const conflicts: Conflict[] = [];

        for (const file of conflictFiles) {
            const content = await this.readFile(file);
            const fileConflicts = this.conflictResolver.parseConflicts(file, content);
            conflicts.push(...fileConflicts);
        }

        return conflicts;
    }

    /**
     * Suggest resolution for a conflict
     */
    async suggestResolution(conflict: Conflict): Promise<Resolution> {
        return this.conflictResolver.suggest(conflict);
    }

    /**
     * Apply a resolution
     */
    async applyResolution(resolution: Resolution): Promise<void> {
        await this.conflictResolver.apply(resolution, this.config.workspacePath);
    }

    /**
     * Find regression commit using bisect
     */
    async findRegressionCommit(testCommand: string, goodCommit: string): Promise<Commit | null> {
        // Start bisect
        await this.git(['bisect', 'start']);
        await this.git(['bisect', 'bad']);
        await this.git(['bisect', 'good', goodCommit]);

        // Run bisect
        const result = await this.git(['bisect', 'run', testCommand]);

        // Parse result to find commit
        const match = result.match(/([a-f0-9]{40}) is the first bad commit/);
        if (match) {
            const commitInfo = await this.git(['show', '--format=%H%n%s%n%an%n%ae%n%aI', '-s', match[1]]);
            const [hash, subject, authorName, authorEmail, date] = commitInfo.trim().split('\n');
            
            await this.git(['bisect', 'reset']);
            
            return {
                hash,
                subject,
                author: { name: authorName, email: authorEmail },
                date: new Date(date),
            };
        }

        await this.git(['bisect', 'reset']);
        return null;
    }

    /**
     * Get recent commits
     */
    async getRecentCommits(branch: string, count: number): Promise<Commit[]> {
        const log = await this.git([
            'log',
            branch,
            `-${count}`,
            '--format=%H|%s|%an|%ae|%aI'
        ]);

        return log.trim().split('\n')
            .filter(line => line)
            .map(line => {
                const [hash, subject, authorName, authorEmail, date] = line.split('|');
                return {
                    hash,
                    subject,
                    author: { name: authorName, email: authorEmail },
                    date: new Date(date),
                };
            });
    }

    /**
     * Get commits between two refs
     */
    async getCommitsBetween(base: string, head: string): Promise<Commit[]> {
        const log = await this.git([
            'log',
            `${base}..${head}`,
            '--format=%H|%s|%an|%ae|%aI'
        ]);

        return log.trim().split('\n')
            .filter(line => line)
            .map(line => {
                const [hash, subject, authorName, authorEmail, date] = line.split('|');
                return {
                    hash,
                    subject,
                    author: { name: authorName, email: authorEmail },
                    date: new Date(date),
                };
            });
    }

    /**
     * Execute git command
     */
    private git(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', args, { cwd: this.config.workspacePath });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Git error: ${stderr}`));
                }
            });
        });
    }

    /**
     * Read file content
     */
    private async readFile(filePath: string): Promise<string> {
        const { promises: fs } = await import('fs');
        const path = await import('path');
        return fs.readFile(path.join(this.config.workspacePath, filePath), 'utf-8');
    }
}
