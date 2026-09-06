/**
 * OpenCodeIDE - Session Wiki
 * 
 * Per-session memory with pages, working memory, and rolling summaries.
 * Based on ContextMemory's SessionWikiCompiler architecture.
 */

import { v4 as uuid } from 'uuid';
import {
    SessionWiki,
    WikiPage,
    WorkingMemory,
    MemoryItem,
    MemoryImportance,
    Artifact,
} from '../types.js';

/**
 * Session Wiki Compiler
 * 
 * Compiles session wiki into a budget-constrained string for context
 */
export class SessionWikiCompiler {
    /**
     * Compile wiki into a string respecting budget
     */
    compile(wiki: SessionWiki, query: string, budgetChars: number): string {
        const sections: Array<{ content: string; importance: number; tokens: number }> = [];

        // 1. Working memory (highest priority)
        const workingMemoryContent = this.compileWorkingMemory(wiki.workingMemory);
        sections.push({
            content: workingMemoryContent,
            importance: 1.0,
            tokens: Math.ceil(workingMemoryContent.length / 4),
        });

        // 2. Rolling summary
        if (wiki.rollingSummary) {
            sections.push({
                content: `## Session Summary\n\n${wiki.rollingSummary}`,
                importance: 0.9,
                tokens: Math.ceil(wiki.rollingSummary.length / 4),
            });
        }

        // 3. Relevant pages (ranked by query match and importance)
        const rankedPages = this.rankPages(wiki.pages, query);
        for (const page of rankedPages) {
            sections.push({
                content: `## ${page.title}\n\n${page.content}`,
                importance: this.importanceToScore(page.importance),
                tokens: Math.ceil((page.title.length + page.content.length) / 4),
            });
        }

        // 4. Log (lower priority, truncated)
        if (wiki.log) {
            const logLines = wiki.log.split('\n').slice(-20).join('\n');
            sections.push({
                content: `## Recent Activity\n\n${logLines}`,
                importance: 0.3,
                tokens: Math.ceil(logLines.length / 4),
            });
        }

        // Build output within budget
        let output = '';
        let usedChars = 0;

        // Sort by importance
        sections.sort((a, b) => b.importance - a.importance);

        for (const section of sections) {
            if (usedChars + section.content.length <= budgetChars) {
                output += section.content + '\n\n';
                usedChars += section.content.length;
            }
        }

        return output.trim();
    }

    /**
     * Compile working memory section
     */
    private compileWorkingMemory(wm: WorkingMemory): string {
        const lines: string[] = ['## Working Memory'];

        if (wm.objective) {
            lines.push(`\n**Objective:** ${wm.objective}`);
        }

        if (wm.plan.length > 0) {
            lines.push('\n**Plan:**');
            wm.plan.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
        }

        if (wm.blockers.length > 0) {
            lines.push('\n**Blockers:**');
            wm.blockers.forEach(b => lines.push(`- ⚠️ ${b}`));
        }

        if (wm.items.length > 0) {
            const criticalItems = wm.items.filter(i => i.importance === 'critical' || i.importance === 'high');
            if (criticalItems.length > 0) {
                lines.push('\n**Important Notes:**');
                criticalItems.forEach(item => lines.push(`- [${item.type}] ${item.content}`));
            }
        }

        return lines.join('\n');
    }

    /**
     * Rank pages by relevance to query
     */
    private rankPages(pages: WikiPage[], query: string): WikiPage[] {
        const queryTerms = query.toLowerCase().split(/\s+/);

        return pages
            .map(page => ({
                page,
                score: this.calculateRelevance(page, queryTerms) + this.importanceToScore(page.importance),
            }))
            .sort((a, b) => b.score - a.score)
            .map(item => item.page);
    }

    /**
     * Calculate relevance score for a page
     */
    private calculateRelevance(page: WikiPage, queryTerms: string[]): number {
        const titleLower = page.title.toLowerCase();
        const contentLower = page.content.toLowerCase();
        let score = 0;

        for (const term of queryTerms) {
            if (titleLower.includes(term)) score += 0.3;
            if (contentLower.includes(term)) score += 0.1;
        }

        // Recency bonus
        const ageHours = (Date.now() - page.updatedAt.getTime()) / 3600000;
        if (ageHours < 1) score += 0.2;
        else if (ageHours < 24) score += 0.1;

        return score;
    }

    /**
     * Convert importance to numeric score
     */
    private importanceToScore(importance: MemoryImportance): number {
        switch (importance) {
            case 'critical': return 0.9;
            case 'high': return 0.7;
            case 'medium': return 0.5;
            case 'low': return 0.3;
            default: return 0.5;
        }
    }
}

/**
 * Session Wiki Manager
 * 
 * Manages session wiki CRUD operations
 */
export class SessionWikiManager {
    private wikis: Map<string, SessionWiki> = new Map();

    /**
     * Create a new session wiki
     */
    create(sessionId: string, task: string): SessionWiki {
        const wiki: SessionWiki = {
            id: uuid(),
            sessionId,
            pages: [],
            index: `# Session: ${task}\n\nStarted: ${new Date().toISOString()}`,
            log: '',
            workingMemory: {
                objective: task,
                plan: [],
                recentTools: [],
                blockers: [],
                items: [],
            },
            artifacts: [],
        };

        this.wikis.set(sessionId, wiki);
        return wiki;
    }

    /**
     * Get session wiki
     */
    get(sessionId: string): SessionWiki | undefined {
        return this.wikis.get(sessionId);
    }

    /**
     * Add a page
     */
    addPage(sessionId: string, title: string, content: string, importance: MemoryImportance = 'medium'): WikiPage {
        const wiki = this.wikis.get(sessionId);
        if (!wiki) throw new Error(`Wiki not found for session: ${sessionId}`);

        const page: WikiPage = {
            id: uuid(),
            title,
            content,
            importance,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        wiki.pages.push(page);
        return page;
    }

    /**
     * Update a page
     */
    updatePage(sessionId: string, pageId: string, content: string): void {
        const wiki = this.wikis.get(sessionId);
        if (!wiki) return;

        const page = wiki.pages.find(p => p.id === pageId);
        if (page) {
            page.content = content;
            page.updatedAt = new Date();
        }
    }

    /**
     * Add a memory item
     */
    addMemoryItem(
        sessionId: string,
        content: string,
        type: MemoryItem['type'],
        importance: MemoryImportance = 'medium'
    ): void {
        const wiki = this.wikis.get(sessionId);
        if (!wiki) return;

        wiki.workingMemory.items.push({
            id: uuid(),
            content,
            type,
            importance,
            createdAt: new Date(),
        });

        // Keep only last 50 items
        if (wiki.workingMemory.items.length > 50) {
            wiki.workingMemory.items = wiki.workingMemory.items.slice(-50);
        }
    }

    /**
     * Update plan
     */
    updatePlan(sessionId: string, plan: string[]): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.workingMemory.plan = plan;
        }
    }

    /**
     * Add blocker
     */
    addBlocker(sessionId: string, blocker: string): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.workingMemory.blockers.push(blocker);
        }
    }

    /**
     * Remove blocker
     */
    removeBlocker(sessionId: string, blocker: string): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.workingMemory.blockers = wiki.workingMemory.blockers.filter(b => b !== blocker);
        }
    }

    /**
     * Append to log
     */
    appendLog(sessionId: string, entry: string): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.log += `\n[${new Date().toISOString()}] ${entry}`;
        }
    }

    /**
     * Set rolling summary
     */
    setRollingSummary(sessionId: string, summary: string): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.rollingSummary = summary;
        }
    }

    /**
     * Add artifact reference
     */
    addArtifact(sessionId: string, artifact: Artifact): void {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.artifacts.push(artifact);
        }
    }
}
