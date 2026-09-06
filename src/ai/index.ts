/**
 * OpenCodeIDE - AI Platform
 * 
 * Main entry point for the embedded AI platform.
 */

// Platform
export { AIPlatform, PlatformConfig, PlatformHealth, createPlatform, getPlatform, destroyPlatform } from './platform.js';

// Types
export * from './types.js';

// Agent
export { AgentRuntime, AgentStateMachine, AgentContextCompactor } from './agent/index.js';

// Models
export { ModelRouter, ProseToolCallParser } from './models/index.js';

// Memory
export { MemoryEngine } from './memory/index.js';

// Context
export { ContextEngine } from './context/index.js';

// Tools
export { ToolRuntime } from './tools/index.js';

// Policy
export { PolicyEngine } from './policy/index.js';

// Trace
export { TraceService } from './trace/index.js';

// MCP
export { McpRuntime } from './mcp/index.js';

// Skills
export { SkillsEngine } from './skills/index.js';

// Rules
export { RulesEngine } from './rules/index.js';

// Sandbox
export { SandboxRuntime } from './sandbox/index.js';

// Artifacts
export { ArtifactStore } from './artifacts/index.js';

// Subagents
export { SubagentOrchestrator } from './subagents/index.js';
