/**
 * OpenCodeIDE - Commit Analyzer
 * 
 * AI-powered commit analysis and message generation.
 */

export interface Commit {
    hash: string;
    subject: string;
    body?: string;
    author: {
        name: string;
        email: string;
    };
    date: Date;
    files?: string[];
}

export interface BlameInfo {
    line: number;
    commit: Commit;
    lineContent: string;
}

/**
 * Commit Analyzer
 * 
 * Analyzes commits and generates messages
 */
export class CommitAnalyzer {
    private modelCallback: (prompt: string) => Promise<string>;

    constructor(modelCallback: (prompt: string) => Promise<string>) {
        this.modelCallback = modelCallback;
    }

    /**
     * Generate commit message from diff
     */
    async generateMessage(diff: string): Promise<string> {
        if (!diff.trim()) {
            return '';
        }

        const prompt = `Generate a concise, conventional commit message for the following diff.
Follow the format: <type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build

Rules:
- First line: max 72 characters
- Add body if changes are complex
- Be specific about what changed

Diff:
\`\`\`
${diff.substring(0, 3000)}${diff.length > 3000 ? '\n... (truncated)' : ''}
\`\`\`

Commit message:`;

        const response = await this.modelCallback(prompt);
        return this.cleanCommitMessage(response);
    }

    /**
     * Generate PR description
     */
    async generatePRDescription(commits: Commit[], diff: string): Promise<string> {
        const commitSummary = commits.map(c => `- ${c.subject}`).join('\n');

        const prompt = `Generate a pull request description for these changes.

Commits:
${commitSummary}

Diff summary:
\`\`\`
${diff.substring(0, 2000)}${diff.length > 2000 ? '\n... (truncated)' : ''}
\`\`\`

Format:
## Summary
<brief description of changes>

## Changes
<list of specific changes>

## Testing
<how to test the changes>

PR description:`;

        return this.modelCallback(prompt);
    }

    /**
     * Explain a diff
     */
    async explainDiff(diff: string): Promise<string> {
        const prompt = `Explain the following code changes in plain English:

\`\`\`diff
${diff.substring(0, 3000)}${diff.length > 3000 ? '\n... (truncated)' : ''}
\`\`\`

Explain:
1. What files were changed
2. What the changes do
3. Why these changes might have been made

Explanation:`;

        return this.modelCallback(prompt);
    }

    /**
     * Summarize branch changes
     */
    async summarizeBranch(commits: Commit[]): Promise<string> {
        const commitList = commits.map(c => 
            `- [${c.hash.substring(0, 7)}] ${c.subject} (${c.author.name}, ${this.formatDate(c.date)})`
        ).join('\n');

        const prompt = `Summarize the development activity in this branch:

Commits:
${commitList}

Provide:
1. Overview of what was accomplished
2. Main features or fixes
3. Any patterns or themes in the changes

Summary:`;

        return this.modelCallback(prompt);
    }

    /**
     * Parse blame output
     */
    parseBlame(blameOutput: string, line: number): BlameInfo {
        const lines = blameOutput.split('\n');
        let hash = '';
        let authorName = '';
        let authorEmail = '';
        let summary = '';
        let time = 0;
        let lineContent = '';

        for (const l of lines) {
            if (l.match(/^[a-f0-9]{40}/)) {
                hash = l.split(' ')[0];
            } else if (l.startsWith('author ')) {
                authorName = l.substring(7);
            } else if (l.startsWith('author-mail ')) {
                authorEmail = l.substring(12).replace(/[<>]/g, '');
            } else if (l.startsWith('author-time ')) {
                time = parseInt(l.substring(12)) * 1000;
            } else if (l.startsWith('summary ')) {
                summary = l.substring(8);
            } else if (l.startsWith('\t')) {
                lineContent = l.substring(1);
            }
        }

        return {
            line,
            commit: {
                hash,
                subject: summary,
                author: { name: authorName, email: authorEmail },
                date: new Date(time),
            },
            lineContent,
        };
    }

    /**
     * Clean up generated commit message
     */
    private cleanCommitMessage(message: string): string {
        return message
            .replace(/^(Here's|Here is|The commit message is|Commit message:)/i, '')
            .replace(/```/g, '')
            .trim();
    }

    /**
     * Format date for display
     */
    private formatDate(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const days = Math.floor(diff / 86400000);

        if (days === 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 7) return `${days} days ago`;
        return date.toLocaleDateString();
    }
}
