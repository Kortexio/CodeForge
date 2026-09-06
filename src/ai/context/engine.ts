/**
 * OpenCodeIDE - Context Engine
 * 
 * Builds enriched context for agent requests with budget management.
 */

import {
    ChatMessage,
    ContextBudget,
    EnrichedContext,
    ContextSource,
} from '../types.js';
import { MemoryEngine } from '../memory/engine.js';
import { SkillsEngine } from '../skills/engine.js';
import { RulesEngine } from '../rules/engine.js';

const DEFAULT_BUDGET: ContextBudget = {
    total: 100000,
    currentFile: 4,
    relatedSymbols: 18,
    repositorySearch: 21,
    projectMemory: 12,
    gitHistory: 5,
    mcp: 7,
    conversation: 20,
    system: 13,
};

/**
 * Context Engine
 * 
 * Assembles and ranks context for agent requests
 */
export class ContextEngine {
    private memory: MemoryEngine;
    private skills: SkillsEngine;
    private rules: RulesEngine;
    private initialized = false;

    constructor(memory: MemoryEngine, skills: SkillsEngine, rules: RulesEngine) {
        this.memory = memory;
        this.skills = skills;
        this.rules = rules;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
    }

    /**
     * Build enriched context for a request
     */
    async buildContext(sessionId: string, query: string): Promise<EnrichedContext> {
        const sources: ContextSource[] = [];
        const budget = { ...DEFAULT_BUDGET };

        // 1. Get session messages
        const messages = await this.memory.getMessages(sessionId);
        
        // 2. Get session wiki
        const wiki = await this.memory.getWiki(sessionId);

        // 3. Get active skills
        const skills = await this.skills.getActiveSkills();

        // 4. Get applicable rules
        const rules = await this.rules.getApplicableRules();

        // 5. Build system prompt
        const systemPrompt = this.buildSystemPrompt(wiki, skills, rules, query);

        // 6. Add system message
        const enrichedMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
        ];

        // 7. Add rolling summary if exists
        if (wiki?.rollingSummary) {
            enrichedMessages.push({
                role: 'system',
                content: `## Session Summary\n\n${wiki.rollingSummary}`,
            });
            sources.push({
                type: 'memory',
                name: 'Rolling Summary',
                content: wiki.rollingSummary,
                relevance: 0.9,
                tokens: Math.ceil(wiki.rollingSummary.length / 4),
            });
        }

        // 8. Add conversation history
        enrichedMessages.push(...messages.filter(m => m.role !== 'system'));

        // Calculate budget usage
        const totalTokens = this.estimateTokens(enrichedMessages);
        
        return {
            systemPrompt,
            messages: enrichedMessages,
            budget: {
                ...budget,
                total: totalTokens,
            },
            sources,
        };
    }

    /**
     * Build the system prompt
     */
    private buildSystemPrompt(
        wiki: { workingMemory: { objective: string; plan: string[]; blockers: string[] } } | null,
        skills: Array<{ name: string; content: string }>,
        rules: Array<{ name: string; content: string }>,
        query: string
    ): string {
        const parts: string[] = [];

        // Base persona
        parts.push(`You are OpenCodeIDE Agent, an AI coding assistant embedded in an IDE. Your task is to help the user with their coding tasks.`);

        // Current objective
        if (wiki?.workingMemory.objective) {
            parts.push(`\n## Current Objective\n\n${wiki.workingMemory.objective}`);
        }

        // Current plan
        if (wiki?.workingMemory.plan.length) {
            parts.push(`\n## Current Plan\n\n${wiki.workingMemory.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
        }

        // Blockers
        if (wiki?.workingMemory.blockers.length) {
            parts.push(`\n## Known Blockers\n\n${wiki.workingMemory.blockers.map(b => `- ${b}`).join('\n')}`);
        }

        // Active skills
        if (skills.length > 0) {
            const skillDescriptions = skills.map(s => `- **${s.name}**: Available for use`).join('\n');
            parts.push(`\n## Available Skills\n\n${skillDescriptions}`);
        }

        // Active rules
        if (rules.length > 0) {
            const ruleDescriptions = rules.map(r => `- ${r.name}: ${r.content.substring(0, 100)}...`).join('\n');
            parts.push(`\n## Active Rules\n\n${ruleDescriptions}`);
        }

        // Guidelines
        parts.push(`\n## Guidelines

- Always explain your reasoning before taking action
- Use tools to inspect the codebase before making changes
- Validate changes by running tests when available
- Ask for clarification if the request is ambiguous
- Preserve existing code style and conventions
- Make minimal, focused changes`);

        return parts.join('\n');
    }

    /**
     * Estimate token count for messages
     */
    private estimateTokens(messages: ChatMessage[]): number {
        let chars = 0;
        for (const msg of messages) {
            chars += msg.content.length;
        }
        return Math.ceil(chars / 4);
    }

    /**
     * Get context budget allocation
     */
    getBudget(): ContextBudget {
        return { ...DEFAULT_BUDGET };
    }
}
