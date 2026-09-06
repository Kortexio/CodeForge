/**
 * OpenCodeIDE - Prose Tool Call Parser
 * 
 * Parses tool calls from prose responses for weak models
 * that don't support native tool calling.
 */

import { v4 as uuid } from 'uuid';
import { ToolCall } from '../types.js';

/**
 * Prose Tool Call Parser
 * 
 * Extracts tool calls from text responses using various formats
 */
export class ProseToolCallParser {
    /**
     * Parse tool calls from a prose response
     */
    parse(content: string): ToolCall[] {
        const toolCalls: ToolCall[] = [];

        // Try different formats
        const xmlCalls = this.parseXmlFormat(content);
        const jsonCalls = this.parseJsonFormat(content);
        const markdownCalls = this.parseMarkdownFormat(content);

        toolCalls.push(...xmlCalls, ...jsonCalls, ...markdownCalls);

        // Deduplicate by name + arguments
        const seen = new Set<string>();
        return toolCalls.filter(tc => {
            const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Parse XML-style tool calls
     * Format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
     */
    private parseXmlFormat(content: string): ToolCall[] {
        const toolCalls: ToolCall[] = [];
        const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
        
        let match;
        while ((match = regex.exec(content)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed.name) {
                    toolCalls.push({
                        id: uuid(),
                        name: parsed.name,
                        arguments: parsed.arguments ?? parsed.params ?? {},
                    });
                }
            } catch {
                // Skip malformed JSON
            }
        }

        return toolCalls;
    }

    /**
     * Parse JSON code block format
     * Format: ```json\n{"tool": "...", "arguments": {...}}\n```
     */
    private parseJsonFormat(content: string): ToolCall[] {
        const toolCalls: ToolCall[] = [];
        const regex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;

        let match;
        while ((match = regex.exec(content)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                
                // Handle various JSON formats
                if (parsed.tool || parsed.name || parsed.function) {
                    toolCalls.push({
                        id: uuid(),
                        name: parsed.tool ?? parsed.name ?? parsed.function,
                        arguments: parsed.arguments ?? parsed.params ?? parsed.input ?? {},
                    });
                } else if (Array.isArray(parsed)) {
                    // Handle array of tool calls
                    for (const item of parsed) {
                        if (item.tool || item.name || item.function) {
                            toolCalls.push({
                                id: uuid(),
                                name: item.tool ?? item.name ?? item.function,
                                arguments: item.arguments ?? item.params ?? item.input ?? {},
                            });
                        }
                    }
                }
            } catch {
                // Skip malformed JSON
            }
        }

        return toolCalls;
    }

    /**
     * Parse markdown-style tool calls
     * Format: **Tool**: `name`\n**Arguments**: {...}
     */
    private parseMarkdownFormat(content: string): ToolCall[] {
        const toolCalls: ToolCall[] = [];
        
        // Pattern: **Tool**: `name` or **Function**: `name`
        const regex = /\*\*(?:Tool|Function|Call)\*\*:\s*`?(\w+)`?\s*\n\*\*(?:Arguments|Parameters|Input)\*\*:\s*([\s\S]*?)(?=\n\n|\n\*\*|$)/gi;

        let match;
        while ((match = regex.exec(content)) !== null) {
            try {
                const name = match[1].trim();
                let argsText = match[2].trim();

                // Remove markdown code block if present
                if (argsText.startsWith('```')) {
                    argsText = argsText.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?```$/g, '');
                }

                const args = JSON.parse(argsText);
                toolCalls.push({
                    id: uuid(),
                    name,
                    arguments: args,
                });
            } catch {
                // Skip malformed entries
            }
        }

        return toolCalls;
    }
}
