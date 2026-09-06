/**
 * OpenCodeIDE - Embedded AI Platform
 * 
 * Main entry point for the AI platform. This module orchestrates all AI
 * capabilities within the IDE without requiring external services.
 */

import { AgentRuntime } from './agent/runtime.js';
import { ContextEngine } from './context/engine.js';
import { MemoryEngine } from './memory/engine.js';
import { ToolRuntime } from './tools/runtime.js';
import { ModelRouter } from './models/router.js';
import { PolicyEngine } from './policy/engine.js';
import { TraceService } from './trace/service.js';
import { McpRuntime } from './mcp/runtime.js';
import { SkillsEngine } from './skills/engine.js';
import { RulesEngine } from './rules/engine.js';
import { SandboxRuntime } from './sandbox/runtime.js';
import { ArtifactStore } from './artifacts/store.js';
import { SubagentOrchestrator } from './subagents/orchestrator.js';

export interface PlatformHealth {
    overall: 'ready' | 'degraded' | 'unavailable';
    agent: boolean;
    memory: boolean;
    index: boolean;
    mcp: boolean;
    sandbox: boolean;
    models: boolean;
}

export interface PlatformConfig {
    dataPath: string;
    workspacePath?: string;
    modelProvider?: string;
    apiKey?: string;
}

/**
 * Main AI Platform class - orchestrates all AI capabilities
 */
export class AIPlatform {
    private agent: AgentRuntime;
    private context: ContextEngine;
    private memory: MemoryEngine;
    private tools: ToolRuntime;
    private models: ModelRouter;
    private policy: PolicyEngine;
    private trace: TraceService;
    private mcp: McpRuntime;
    private skills: SkillsEngine;
    private rules: RulesEngine;
    private sandbox: SandboxRuntime;
    private artifacts: ArtifactStore;
    private subagents: SubagentOrchestrator;

    private initialized = false;
    private config: PlatformConfig;

    constructor(config: PlatformConfig) {
        this.config = config;

        // Initialize components (lazy initialization)
        this.trace = new TraceService(config.dataPath);
        this.artifacts = new ArtifactStore(config.dataPath);
        this.models = new ModelRouter(config);
        this.policy = new PolicyEngine(config.dataPath);
        this.rules = new RulesEngine(config.dataPath);
        this.skills = new SkillsEngine(config.dataPath);
        this.sandbox = new SandboxRuntime();
        this.mcp = new McpRuntime(config.dataPath);
        this.memory = new MemoryEngine(config.dataPath);
        this.tools = new ToolRuntime(this.sandbox, this.artifacts);
        this.context = new ContextEngine(this.memory, this.skills, this.rules);
        this.subagents = new SubagentOrchestrator(this.models, this.tools);
        this.agent = new AgentRuntime({
            context: this.context,
            memory: this.memory,
            tools: this.tools,
            models: this.models,
            policy: this.policy,
            trace: this.trace,
            mcp: this.mcp,
            subagents: this.subagents,
        });
    }

    /**
     * Initialize the AI platform
     * No external services required
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        this.trace.log('platform', 'Initializing AI Platform...', {
            dataPath: this.config.dataPath,
            workspace: this.config.workspacePath,
        });

        try {
            // Initialize in dependency order
            await this.artifacts.initialize();
            await this.memory.initialize();
            await this.models.initialize();
            await this.policy.initialize();
            await this.rules.initialize();
            await this.skills.initialize();
            await this.sandbox.initialize();
            await this.mcp.initialize();
            await this.tools.initialize();
            await this.context.initialize();
            await this.agent.initialize();

            if (this.config.workspacePath) {
                this.tools.setWorkspace(this.config.workspacePath);
            }

            this.initialized = true;
            this.trace.log('platform', 'AI Platform initialized successfully');
        } catch (error) {
            this.trace.error('platform', 'Failed to initialize AI Platform', error);
            throw error;
        }
    }

    /**
     * Shutdown the AI platform gracefully
     */
    async shutdown(): Promise<void> {
        this.trace.log('platform', 'Shutting down AI Platform...');

        await this.agent.shutdown();
        await this.mcp.shutdown();
        await this.sandbox.shutdown();
        await this.memory.shutdown();

        this.initialized = false;
        this.trace.log('platform', 'AI Platform shut down');
    }

    /**
     * Get platform health status
     * User sees only "AI is ready" - internal details are for debugging
     */
    getHealth(): PlatformHealth {
        const agent = this.agent.isReady();
        const memory = this.memory.isReady();
        const index = true; // Code intelligence - placeholder
        const mcp = this.mcp.isReady();
        const sandbox = this.sandbox.isReady();
        const models = this.models.isReady();

        const allReady = agent && memory && index && mcp && sandbox && models;
        const anyReady = agent || memory || index || mcp || sandbox || models;

        return {
            overall: allReady ? 'ready' : anyReady ? 'degraded' : 'unavailable',
            agent,
            memory,
            index,
            mcp,
            sandbox,
            models,
        };
    }

    /**
     * Get the agent runtime for executing tasks
     */
    getAgent(): AgentRuntime {
        return this.agent;
    }

    /**
     * Get the model router for configuration
     */
    getModels(): ModelRouter {
        return this.models;
    }

    /**
     * Get the MCP runtime for managing integrations
     */
    getMcp(): McpRuntime {
        return this.mcp;
    }

    /**
     * Get the memory engine for session/project memory
     */
    getMemory(): MemoryEngine {
        return this.memory;
    }

    /**
     * Get the trace service for observability
     */
    getTrace(): TraceService {
        return this.trace;
    }

    /**
     * Get the policy engine for permissions
     */
    getPolicy(): PolicyEngine {
        return this.policy;
    }

    /**
     * Get the skills engine
     */
    getSkills(): SkillsEngine {
        return this.skills;
    }

    /**
     * Get the rules engine
     */
    getRules(): RulesEngine {
        return this.rules;
    }
}

// Singleton instance
let platformInstance: AIPlatform | null = null;

export function getPlatform(): AIPlatform | null {
    return platformInstance;
}

export function createPlatform(config: PlatformConfig): AIPlatform {
    if (platformInstance) {
        throw new Error('AI Platform already created. Use getPlatform() instead.');
    }
    platformInstance = new AIPlatform(config);
    return platformInstance;
}

export async function destroyPlatform(): Promise<void> {
    if (platformInstance) {
        await platformInstance.shutdown();
        platformInstance = null;
    }
}
