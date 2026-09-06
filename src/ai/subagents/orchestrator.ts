/**
 * OpenCodeIDE - Subagent Orchestrator
 * 
 * Manages subagent delegation and parallel execution.
 */

import { v4 as uuid } from 'uuid';
import { ToolCall, ToolResult } from '../types.js';
import { ModelRouter } from '../models/router.js';
import { ToolRuntime } from '../tools/runtime.js';

const MAX_SUBAGENT_DEPTH = 1;

interface SubagentTask {
    id: string;
    task: string;
    context?: string;
    tools?: string[];
    model?: string;
    isolated?: boolean;
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: string;
    startTime?: Date;
    endTime?: Date;
}

/**
 * Subagent Orchestrator
 * 
 * Manages subagent delegation for parallel task execution
 */
export class SubagentOrchestrator {
    private models: ModelRouter;
    private tools: ToolRuntime;
    private tasks: Map<string, SubagentTask> = new Map();

    constructor(models: ModelRouter, tools: ToolRuntime) {
        this.models = models;
        this.tools = tools;
    }

    /**
     * Get available tools for subagent filtering
     */
    getAvailableTools(): string[] {
        return this.tools.getSchemas().map(t => t.name);
    }

    /**
     * Delegate a task to a subagent
     */
    async delegate(toolCall: ToolCall, depth: number): Promise<ToolResult> {
        const startTime = Date.now();

        // Check depth limit
        if (depth >= MAX_SUBAGENT_DEPTH) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: 'Maximum subagent depth reached',
                duration: Date.now() - startTime,
            };
        }

        const args = toolCall.arguments as {
            task: string;
            context?: string;
            tools?: string[];
            model?: string;
            isolated?: boolean;
        };

        const taskId = uuid();
        const task: SubagentTask = {
            id: taskId,
            task: args.task,
            context: args.context,
            tools: args.tools,
            model: args.model,
            isolated: args.isolated,
            status: 'pending',
            startTime: new Date(),
        };

        this.tasks.set(taskId, task);

        try {
            task.status = 'running';

            // Execute subagent task
            // For now, just simulate with a simple LLM call
            const result = await this.executeSubtask(task, depth);

            task.status = 'completed';
            task.result = result;
            task.endTime = new Date();

            return {
                toolCallId: toolCall.id,
                success: true,
                output: result,
                duration: Date.now() - startTime,
            };
        } catch (error) {
            task.status = 'failed';
            task.endTime = new Date();

            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime,
            };
        }
    }

    /**
     * Get all tasks
     */
    getTasks(): SubagentTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get task by ID
     */
    getTask(id: string): SubagentTask | null {
        return this.tasks.get(id) ?? null;
    }

    /**
     * Get running tasks
     */
    getRunningTasks(): SubagentTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'running');
    }

    /**
     * Cancel a task
     */
    async cancelTask(id: string): Promise<void> {
        const task = this.tasks.get(id);
        if (task && task.status === 'running') {
            task.status = 'failed';
            task.endTime = new Date();
        }
    }

    private async executeSubtask(task: SubagentTask, _depth: number): Promise<string> {
        // Build a simple prompt for the subagent
        const systemPrompt = `You are a subagent helping with a specific task. Complete the following task and provide a clear summary of your findings or actions.

${task.context ? `Context:\n${task.context}\n\n` : ''}`;

        const response = await this.models.chat({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: task.task },
            ],
            model: task.model ?? this.models.getDefaultModel(),
            temperature: 0.7,
            maxTokens: 2000,
        });

        return response.choices[0].message.content;
    }
}
