/**
 * OpenCodeIDE - Agent Context Compactor
 * 
 * Mid-turn compaction to manage context window.
 * Based on ContextMemory's AgentContextCompactor architecture.
 */

import { MemoryEngine } from '../memory/engine.js';
import { ModelRouter } from '../models/router.js';
import { ChatMessage } from '../types.js';

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compactor. Your task is to create a concise summary of the conversation so far while preserving all critical information.

Preserve:
- The original objective/task
- All decisions made
- Current state of the work
- Files that have been changed
- Any errors encountered
- Unresolved issues or blockers
- Important discoveries

Format your response as a structured summary that can be used to continue the conversation.`;

/**
 * Agent Context Compactor
 * 
 * Compacts conversation context when it exceeds the budget
 */
export class AgentContextCompactor {
    private memory: MemoryEngine;
    private models: ModelRouter;

    constructor(memory: MemoryEngine, models: ModelRouter) {
        this.memory = memory;
        this.models = models;
    }

    /**
     * Check if compaction is needed
     */
    async needsCompaction(sessionId: string, maxTokens: number): Promise<boolean> {
        const tokenCount = await this.memory.estimateTokenCount(sessionId);
        return tokenCount > maxTokens * 0.8; // Compact at 80% of max
    }

    /**
     * Compact the session context
     */
    async compact(sessionId: string): Promise<void> {
        const messages = await this.memory.getMessages(sessionId);
        
        if (messages.length < 5) {
            // Not enough messages to compact
            return;
        }

        // Keep system message and last few messages
        const systemMessage = messages.find(m => m.role === 'system');
        const recentMessages = messages.slice(-4); // Keep last 4 messages
        const toCompact = messages.filter(m => m.role !== 'system').slice(0, -4);

        if (toCompact.length === 0) {
            return;
        }

        // Generate rolling summary
        const summary = await this.generateSummary(toCompact);

        // Create new compacted message history
        const compactedMessages: ChatMessage[] = [];
        
        if (systemMessage) {
            compactedMessages.push(systemMessage);
        }

        // Add summary as a system message
        compactedMessages.push({
            role: 'system',
            content: `## Session Summary (compacted)\n\n${summary}`,
        });

        // Add recent messages
        compactedMessages.push(...recentMessages);

        // Update session with compacted messages
        await this.memory.setMessages(sessionId, compactedMessages);

        // Store the full history in archive
        await this.memory.archiveMessages(sessionId, toCompact);
    }

    /**
     * Generate a summary of messages
     */
    private async generateSummary(messages: ChatMessage[]): Promise<string> {
        // Format messages for summarization
        const formattedMessages = messages.map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
            return `${role}: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`;
        }).join('\n\n');

        const response = await this.models.chat({
            messages: [
                { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
                { role: 'user', content: `Please summarize the following conversation:\n\n${formattedMessages}` },
            ],
            model: this.models.getSummaryModel(),
            temperature: 0.3,
            maxTokens: 1000,
        });

        return response.choices[0].message.content;
    }
}
