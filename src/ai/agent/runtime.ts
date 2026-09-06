/**
 * OpenCodeIDE - Agent Runtime
 * 
 * Core agent execution engine with state machine and recovery capabilities.
 * Based on ContextMemory's AgentOrchestrator architecture.
 */

import { v4 as uuid } from 'uuid';
import {
    AgentState,
    AgentTask,
    AgentResult,
    ToolCall,
    ToolResult,
    FileChange,
} from '../types.js';
import { ContextEngine } from '../context/engine.js';
import { MemoryEngine } from '../memory/engine.js';
import { ToolRuntime } from '../tools/runtime.js';
import { ModelRouter } from '../models/router.js';
import { PolicyEngine } from '../policy/engine.js';
import { TraceService } from '../trace/service.js';
import { McpRuntime } from '../mcp/runtime.js';
import { SubagentOrchestrator } from '../subagents/orchestrator.js';
import { AgentStateMachine } from './state-machine.js';
import { AgentContextCompactor } from './compactor.js';

export interface AgentRuntimeConfig {
    context: ContextEngine;
    memory: MemoryEngine;
    tools: ToolRuntime;
    models: ModelRouter;
    policy: PolicyEngine;
    trace: TraceService;
    mcp: McpRuntime;
    subagents: SubagentOrchestrator;
}

export interface RunOptions {
    maxIterations?: number;
    maxTokens?: number;
    timeout?: number;
    model?: string;
    isolated?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 100000;
const DEFAULT_TIMEOUT = 300000; // 5 minutes

/**
 * Agent Runtime - executes tasks using an iterative agent loop
 */
export class AgentRuntime {
    private context: ContextEngine;
    private memory: MemoryEngine;
    private tools: ToolRuntime;
    private models: ModelRouter;
    private policy: PolicyEngine;
    private trace: TraceService;
    private mcp: McpRuntime;
    private subagents: SubagentOrchestrator;

    private stateMachine: AgentStateMachine;
    private compactor: AgentContextCompactor;
    private initialized = false;
    private currentTask: AgentTask | null = null;

    constructor(config: AgentRuntimeConfig) {
        this.context = config.context;
        this.memory = config.memory;
        this.tools = config.tools;
        this.models = config.models;
        this.policy = config.policy;
        this.trace = config.trace;
        this.mcp = config.mcp;
        this.subagents = config.subagents;

        this.stateMachine = new AgentStateMachine();
        this.compactor = new AgentContextCompactor(this.memory, this.models);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.trace.log('agent', 'Agent Runtime initialized');
        this.initialized = true;
    }

    async shutdown(): Promise<void> {
        if (this.currentTask) {
            await this.cancel();
        }
        this.initialized = false;
    }

    isReady(): boolean {
        return this.initialized && this.models.isReady();
    }

    /**
     * Run an agent task
     */
    async run(taskDescription: string, options: RunOptions = {}): Promise<AgentResult> {
        const task: AgentTask = {
            id: uuid(),
            task: taskDescription,
            model: options.model,
            isolated: options.isolated,
            createdAt: new Date(),
        };

        this.currentTask = task;
        this.stateMachine.reset();

        const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        const timeout = options.timeout ?? DEFAULT_TIMEOUT;

        const startTime = Date.now();
        const changes: FileChange[] = [];
        let totalTokens = 0;
        let iteration = 0;

        this.trace.log('agent', `Starting task: ${task.id}`, { task: taskDescription });
        this.stateMachine.transition('start');

        try {
            // Create session for this task
            const session = await this.memory.createSession(task.id, taskDescription);

            // Main agent loop
            while (iteration < maxIterations) {
                // Check timeout
                if (Date.now() - startTime > timeout) {
                    throw new Error(`Task timeout after ${timeout}ms`);
                }

                // Check token budget
                if (totalTokens > maxTokens) {
                    this.stateMachine.transition('compact');
                    await this.compactor.compact(session.id);
                }

                iteration++;
                this.trace.log('agent', `Iteration ${iteration}`, { state: this.stateMachine.getState() });

                // Build context
                this.stateMachine.transition('plan');
                const enrichedContext = await this.context.buildContext(session.id, taskDescription);

                // Get available tools
                const nativeTools = this.tools.getSchemas();
                const mcpTools = await this.mcp.getToolSchemas();
                const allTools = [...nativeTools, ...mcpTools];

                // Make LLM request
                this.stateMachine.transition('llmRequest');
                const response = await this.models.chat({
                    messages: enrichedContext.messages,
                    model: options.model ?? this.models.getDefaultModel(),
                    tools: allTools,
                });

                totalTokens += response.usage.totalTokens;

                const choice = response.choices[0];
                const message = choice.message;

                // Check if we're done
                if (choice.finishReason === 'stop' && !message.toolCalls?.length) {
                    this.stateMachine.transition('complete');
                    
                    // Save final response to memory
                    await this.memory.addMessage(session.id, message);
                    
                    return {
                        taskId: task.id,
                        success: true,
                        summary: message.content,
                        changes,
                        artifacts: [],
                        duration: Date.now() - startTime,
                        tokensUsed: totalTokens,
                    };
                }

                // Process tool calls
                if (message.toolCalls?.length) {
                    this.stateMachine.transition('toolCall');

                    for (const toolCall of message.toolCalls) {
                        // Check policy
                        const approval = await this.policy.checkToolCall(toolCall);
                        
                        if (approval.decision === 'deny') {
                            this.trace.warn('agent', `Tool call denied: ${toolCall.name}`, { reason: approval.reason });
                            continue;
                        }

                        if (approval.decision === 'approval') {
                            this.stateMachine.transition('awaitHuman');
                            // Create checkpoint before waiting
                            await this.memory.createCheckpoint(session.id);
                            
                            const approved = await this.requestApproval(toolCall, approval.reason);
                            if (!approved) {
                                this.trace.log('agent', `Tool call rejected by user: ${toolCall.name}`);
                                continue;
                            }
                        }

                        // Execute tool
                        this.stateMachine.transition('toolResult');
                        let result: ToolResult;

                        try {
                            if (toolCall.name === 'delegate_task') {
                                // Handle subagent delegation
                                this.stateMachine.transition('delegate');
                                result = await this.subagents.delegate(toolCall, 0);
                            } else if (toolCall.name.includes('__')) {
                                // MCP tool (format: server__tool)
                                result = await this.mcp.executeTool(toolCall);
                            } else {
                                // Native tool
                                result = await this.tools.execute(toolCall);
                            }

                            // Track file changes
                            if (result.success && this.isFileChangeTool(toolCall.name)) {
                                changes.push(this.extractFileChange(toolCall, result));
                            }
                        } catch (error) {
                            this.stateMachine.transition('recover');
                            result = {
                                toolCallId: toolCall.id,
                                success: false,
                                output: '',
                                error: error instanceof Error ? error.message : String(error),
                                duration: 0,
                            };
                        }

                        // Add tool result to context (toolResult already moved us to observing)
                        await this.memory.addToolResult(session.id, toolCall, result);
                    }
                }

                // Validate if needed
                this.stateMachine.transition('validate');
                // Validation logic here
            }

            // Max iterations reached
            this.stateMachine.transition('fail');
            return {
                taskId: task.id,
                success: false,
                summary: `Task did not complete within ${maxIterations} iterations`,
                changes,
                artifacts: [],
                errors: ['Max iterations reached'],
                duration: Date.now() - startTime,
                tokensUsed: totalTokens,
            };

        } catch (error) {
            this.stateMachine.transition('fail');
            this.trace.error('agent', 'Task failed', error);

            return {
                taskId: task.id,
                success: false,
                summary: error instanceof Error ? error.message : String(error),
                changes,
                artifacts: [],
                errors: [error instanceof Error ? error.message : String(error)],
                duration: Date.now() - startTime,
                tokensUsed: totalTokens,
            };
        } finally {
            this.currentTask = null;
        }
    }

    /**
     * Cancel the current task
     */
    async cancel(): Promise<void> {
        if (this.currentTask) {
            this.stateMachine.transition('cancel');
            this.trace.log('agent', `Task cancelled: ${this.currentTask.id}`);
            this.currentTask = null;
        }
    }

    /**
     * Resume a paused task
     */
    async resume(sessionId: string): Promise<AgentResult> {
        const session = await this.memory.getSession(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        return this.run(session.task, { model: undefined });
    }

    /**
     * Get current state
     */
    getState(): AgentState {
        return this.stateMachine.getState();
    }

    /**
     * Request human approval for a tool call
     */
    private async requestApproval(toolCall: ToolCall, reason?: string): Promise<boolean> {
        // This will be implemented by the UI layer
        // For now, auto-approve in development
        this.trace.warn('agent', 'Auto-approving tool call (HITL not implemented)', {
            tool: toolCall.name,
            reason,
        });
        return true;
    }

    private isFileChangeTool(toolName: string): boolean {
        return ['write', 'patch', 'delete', 'rename'].includes(toolName);
    }

    private extractFileChange(toolCall: ToolCall, _result: ToolResult): FileChange {
        const args = toolCall.arguments as Record<string, string>;
        
        switch (toolCall.name) {
            case 'write':
                return {
                    path: args.path,
                    type: 'modify',
                    content: args.content,
                };
            case 'delete':
                return {
                    path: args.path,
                    type: 'delete',
                };
            case 'rename':
                return {
                    path: args.newPath,
                    oldPath: args.oldPath,
                    type: 'rename',
                };
            default:
                return {
                    path: args.path,
                    type: 'modify',
                };
        }
    }
}
