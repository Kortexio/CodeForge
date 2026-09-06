/**
 * OpenCodeIDE - Conflict Resolver
 * 
 * AI-powered merge conflict resolution.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface Conflict {
    filePath: string;
    startLine: number;
    endLine: number;
    ours: string;
    theirs: string;
    base?: string;
    context: ConflictContext;
}

export interface ConflictContext {
    before: string;
    after: string;
    fileName: string;
    language: string;
}

export interface Resolution {
    conflict: Conflict;
    resolution: string;
    explanation: string;
    confidence: number;
}

/**
 * Conflict Resolver
 * 
 * Parses and suggests resolutions for merge conflicts
 */
export class ConflictResolver {
    private modelCallback: (prompt: string) => Promise<string>;

    constructor(modelCallback: (prompt: string) => Promise<string>) {
        this.modelCallback = modelCallback;
    }

    /**
     * Parse conflicts from file content
     */
    parseConflicts(filePath: string, content: string): Conflict[] {
        const conflicts: Conflict[] = [];
        const lines = content.split('\n');
        const ext = path.extname(filePath);
        const language = this.getLanguage(ext);

        let i = 0;
        while (i < lines.length) {
            if (lines[i].startsWith('<<<<<<<')) {
                const startLine = i;
                let ours = '';
                let theirs = '';
                let base: string | undefined;
                let inOurs = true;
                let inBase = false;

                i++;
                while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
                    if (lines[i].startsWith('|||||||')) {
                        inOurs = false;
                        inBase = true;
                    } else if (lines[i].startsWith('=======')) {
                        inBase = false;
                        inOurs = false;
                    } else {
                        if (inOurs) {
                            ours += lines[i] + '\n';
                        } else if (inBase) {
                            base = (base ?? '') + lines[i] + '\n';
                        } else {
                            theirs += lines[i] + '\n';
                        }
                    }
                    i++;
                }

                const endLine = i;

                // Get context
                const beforeStart = Math.max(0, startLine - 5);
                const afterEnd = Math.min(lines.length - 1, endLine + 5);
                const before = lines.slice(beforeStart, startLine).join('\n');
                const after = lines.slice(endLine + 1, afterEnd + 1).join('\n');

                conflicts.push({
                    filePath,
                    startLine,
                    endLine,
                    ours: ours.trim(),
                    theirs: theirs.trim(),
                    base: base?.trim(),
                    context: {
                        before,
                        after,
                        fileName: path.basename(filePath),
                        language,
                    },
                });
            }
            i++;
        }

        return conflicts;
    }

    /**
     * Suggest a resolution for a conflict
     */
    async suggest(conflict: Conflict): Promise<Resolution> {
        const prompt = `You are helping resolve a merge conflict in ${conflict.context.fileName} (${conflict.context.language}).

Context before conflict:
\`\`\`
${conflict.context.before}
\`\`\`

OURS (current branch):
\`\`\`
${conflict.ours}
\`\`\`

${conflict.base ? `BASE (common ancestor):
\`\`\`
${conflict.base}
\`\`\`

` : ''}THEIRS (incoming changes):
\`\`\`
${conflict.theirs}
\`\`\`

Context after conflict:
\`\`\`
${conflict.context.after}
\`\`\`

Analyze the conflict and provide:
1. The best resolution (combining both changes if possible)
2. Explanation of why this resolution is correct
3. Confidence level (0-1)

Format your response as:
RESOLUTION:
<the resolved code>
EXPLANATION:
<why this resolution is correct>
CONFIDENCE:
<number between 0 and 1>`;

        const response = await this.modelCallback(prompt);
        return this.parseResolutionResponse(conflict, response);
    }

    /**
     * Apply a resolution to the file
     */
    async apply(resolution: Resolution, workspacePath: string): Promise<void> {
        const filePath = path.join(workspacePath, resolution.conflict.filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        // Find and replace the conflict
        let startIndex = -1;
        let endIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('<<<<<<<') && startIndex === -1) {
                startIndex = i;
            }
            if (lines[i].startsWith('>>>>>>>') && startIndex !== -1) {
                endIndex = i;
                break;
            }
        }

        if (startIndex !== -1 && endIndex !== -1) {
            const newLines = [
                ...lines.slice(0, startIndex),
                ...resolution.resolution.split('\n'),
                ...lines.slice(endIndex + 1),
            ];

            await fs.writeFile(filePath, newLines.join('\n'), 'utf-8');
        }
    }

    /**
     * Parse the model's response into a Resolution
     */
    private parseResolutionResponse(conflict: Conflict, response: string): Resolution {
        const resolutionMatch = response.match(/RESOLUTION:\s*([\s\S]*?)(?=EXPLANATION:|$)/i);
        const explanationMatch = response.match(/EXPLANATION:\s*([\s\S]*?)(?=CONFIDENCE:|$)/i);
        const confidenceMatch = response.match(/CONFIDENCE:\s*([0-9.]+)/i);

        return {
            conflict,
            resolution: resolutionMatch?.[1]?.trim() ?? conflict.ours,
            explanation: explanationMatch?.[1]?.trim() ?? 'No explanation provided',
            confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
        };
    }

    /**
     * Get language from file extension
     */
    private getLanguage(ext: string): string {
        const langMap: Record<string, string> = {
            '.ts': 'TypeScript',
            '.tsx': 'TypeScript React',
            '.js': 'JavaScript',
            '.jsx': 'JavaScript React',
            '.py': 'Python',
            '.go': 'Go',
            '.rs': 'Rust',
            '.java': 'Java',
            '.cs': 'C#',
            '.cpp': 'C++',
            '.c': 'C',
            '.rb': 'Ruby',
            '.php': 'PHP',
        };
        return langMap[ext.toLowerCase()] ?? 'Unknown';
    }
}
