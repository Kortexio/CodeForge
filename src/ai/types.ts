/**
 * OpenCodeIDE - Core Types
 * 
 * Shared type definitions used across the AI platform
 */

// ============================================================================
// Agent Types
// ============================================================================

export type AgentState =
    | 'created'
    | 'planning'
    | 'retrievingContext'
    | 'executing'
    | 'waitingForTool'
    | 'observing'
    | 'validating'
    | 'recovering'
    | 'waitingForApproval'
    | 'delegating'
    | 'compacting'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type AgentEvent =
    | 'start'
    | 'plan'
    | 'compact'
    | 'llmRequest'
    | 'toolCall'
    | 'toolResult'
    | 'validate'
    | 'awaitHuman'
    | 'delegate'
    | 'recover'
    | 'complete'
    | 'fail'
    | 'cancel';

export interface AgentTask {
    id: string;
    task: string;
    context?: string;
    tools?: string[];
    model?: string;
    isolated?: boolean;
    createdAt: Date;
}

export interface AgentResult {
    taskId: string;
    success: boolean;
    summary: string;
    changes: FileChange[];
    artifacts: Artifact[];
    errors?: string[];
    duration: number;
    tokensUsed: number;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolSchema {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, ParameterSchema>;
        required?: string[];
    };
}

export interface ParameterSchema {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description?: string;
    enum?: string[];
    items?: ParameterSchema;
    properties?: Record<string, ParameterSchema>;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolResult {
    toolCallId: string;
    success: boolean;
    output: string;
    error?: string;
    artifact?: Artifact;
    duration: number;
}

// ============================================================================
// Model Types
// ============================================================================

export type ModelProvider =
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'xai'
    | 'openrouter'
    | 'ollama'
    | 'vllm'
    | 'lmstudio'
    | 'custom';

export type HarnessMode = 'strong' | 'weak';

export interface ModelHarness {
    mode: HarnessMode;
    supportsNativeToolCalls: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    maxContextTokens: number;
    promptProfile: PromptProfile;
}

export interface PromptProfile {
    systemPromptStyle: 'xml' | 'markdown' | 'plain';
    toolCallFormat: 'native' | 'prose' | 'json';
    responseFormat: 'native' | 'structured';
}

export interface ModelConfig {
    provider: ModelProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    harness?: ModelHarness;
    temperature?: number;
    maxTokens?: number;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
}

export interface ChatCompletionRequest {
    messages: ChatMessage[];
    model: string;
    tools?: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
}

export interface ChatCompletionResponse {
    id: string;
    choices: ChatChoice[];
    usage: TokenUsage;
    model: string;
}

export interface ChatChoice {
    index: number;
    message: ChatMessage;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

// ============================================================================
// Memory Types
// ============================================================================

export interface Session {
    id: string;
    task: string;
    plan?: string[];
    state: SessionState;
    createdAt: Date;
    updatedAt: Date;
    completedAt?: Date;
}

export type SessionState = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SessionWiki {
    id: string;
    sessionId: string;
    pages: WikiPage[];
    index: string;
    log: string;
    workingMemory: WorkingMemory;
    artifacts: Artifact[];
    rollingSummary?: string;
}

export interface WikiPage {
    id: string;
    title: string;
    content: string;
    importance: MemoryImportance;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkingMemory {
    objective: string;
    plan: string[];
    recentTools: ToolCall[];
    blockers: string[];
    items: MemoryItem[];
}

export interface MemoryItem {
    id: string;
    content: string;
    type: 'fact' | 'decision' | 'observation' | 'hypothesis';
    importance: MemoryImportance;
    createdAt: Date;
}

export type MemoryImportance = 'critical' | 'high' | 'medium' | 'low';

export interface WikiFact {
    id: string;
    content: string;
    validFrom: Date;
    validTo?: Date;
    supersededBy?: string;
}

// ============================================================================
// Context Types
// ============================================================================

export interface ContextBudget {
    total: number;
    currentFile: number;
    relatedSymbols: number;
    repositorySearch: number;
    projectMemory: number;
    gitHistory: number;
    mcp: number;
    conversation: number;
    system: number;
}

export interface EnrichedContext {
    systemPrompt: string;
    messages: ChatMessage[];
    budget: ContextBudget;
    sources: ContextSource[];
}

export interface ContextSource {
    type: 'file' | 'symbol' | 'search' | 'memory' | 'git' | 'mcp' | 'web';
    name: string;
    content: string;
    relevance: number;
    tokens: number;
}

// ============================================================================
// Artifact Types
// ============================================================================

export interface Artifact {
    id: string;
    type: ArtifactType;
    name: string;
    preview: string;
    fullPath: string;
    size: number;
    createdAt: Date;
}

export type ArtifactType =
    | 'test-output'
    | 'build-log'
    | 'screenshot'
    | 'mcp-response'
    | 'patch'
    | 'diff'
    | 'report'
    | 'data';

// ============================================================================
// File Types
// ============================================================================

export interface FileChange {
    path: string;
    type: 'create' | 'modify' | 'delete' | 'rename';
    oldPath?: string;
    content?: string;
    diff?: string;
}

export interface FileDiff {
    path: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    content: string;
}

// ============================================================================
// Policy Types
// ============================================================================

export interface PolicyRule {
    id: string;
    action: PolicyAction;
    target: string | RegExp;
    decision: PolicyDecision;
    reason?: string;
    scope: PolicyScope;
}

export type PolicyAction = 'read' | 'edit' | 'execute' | 'network' | 'secret';
export type PolicyDecision = 'allow' | 'deny' | 'approval';
export type PolicyScope = 'system' | 'user' | 'workspace' | 'folder' | 'task';

export interface ApprovalRequest {
    id: string;
    toolCall: ToolCall;
    risk: RiskLevel;
    reason: string;
    context: string;
    checkpoint?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalResult {
    approved: boolean;
    scope: 'once' | 'session' | 'always';
    timestamp: Date;
}

// ============================================================================
// MCP Types
// ============================================================================

export interface McpServer {
    name: string;
    transport: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    auth?: McpAuth;
    allowedTools?: string[];
    deniedTools?: string[];
    enabled: boolean;
}

export interface McpAuth {
    type: 'bearer' | 'api-key' | 'oauth';
    credentials?: string;
}

export interface McpTool {
    server: string;
    name: string;
    fullName: string;
    description: string;
    schema: ToolSchema;
}

// ============================================================================
// Skill Types
// ============================================================================

export interface Skill {
    id: string;
    version: string;
    name: string;
    description: string;
    scope: SkillScope;
    alwaysOn: boolean;
    requestable: boolean;
    content: string;
    triggers?: string[];
}

export type SkillScope = 'global' | 'workspace' | 'folder';

// ============================================================================
// Rule Types
// ============================================================================

export interface Rule {
    id: string;
    name: string;
    description: string;
    scope: RuleScope;
    content: string;
    priority: number;
}

export type RuleScope = 'system' | 'user' | 'workspace' | 'folder' | 'task';

// ============================================================================
// Trace Types
// ============================================================================

export interface TraceEntry {
    timestamp: Date;
    component: string;
    level: TraceLevel;
    message: string;
    data?: unknown;
    duration?: number;
    tokens?: number;
}

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceMetrics {
    totalTokens: number;
    totalDuration: number;
    toolCalls: number;
    llmCalls: number;
    errors: number;
}

// ============================================================================
// Sandbox Types
// ============================================================================

export type SandboxLevel = 'safe-local' | 'restricted' | 'isolated' | 'container';

export interface SandboxOptions {
    level: SandboxLevel;
    timeout?: number;
    memoryLimit?: number;
    networkAccess?: boolean;
    fileSystemAccess?: 'none' | 'read' | 'write';
    workingDirectory?: string;
}

export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
    killed: boolean;
}
