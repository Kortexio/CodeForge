/**
 * OpenCodeIDE - Policy Engine
 * 
 * Manages permissions and guardrails for tool execution.
 */

import {
    PolicyRule,
    PolicyAction,
    PolicyDecision,
    PolicyScope,
    ToolCall,
    RiskLevel,
} from '../types.js';

// Default policy rules
const DEFAULT_POLICIES: PolicyRule[] = [
    // Allow read operations
    { id: 'allow-read', action: 'read', target: '.*', decision: 'allow', scope: 'system' },
    
    // Allow edit in workspace
    { id: 'allow-edit-workspace', action: 'edit', target: '.*', decision: 'allow', scope: 'workspace' },
    
    // Require approval for destructive operations
    { id: 'approve-delete', action: 'edit', target: 'delete|rm|remove', decision: 'approval', reason: 'Destructive operation', scope: 'system' },
    
    // Require approval for git push
    { id: 'approve-git-push', action: 'execute', target: 'git\\s+push', decision: 'approval', reason: 'Pushing to remote', scope: 'system' },
    
    // Require approval for package install
    { id: 'approve-install', action: 'execute', target: 'npm\\s+install|yarn\\s+add|pip\\s+install', decision: 'approval', reason: 'Installing packages', scope: 'system' },
    
    // Deny access to secrets
    { id: 'deny-secrets', action: 'secret', target: '.*', decision: 'deny', reason: 'Secret access denied', scope: 'system' },
];

// Tool to action mapping
const TOOL_ACTIONS: Record<string, PolicyAction> = {
    read: 'read',
    write: 'edit',
    delete: 'edit',
    rename: 'edit',
    shell: 'execute',
    search: 'read',
    list: 'read',
};

// Risk assessment patterns
const HIGH_RISK_PATTERNS = [
    /rm\s+-rf/i,
    /git\s+push\s+--force/i,
    /drop\s+database/i,
    /truncate\s+table/i,
    /delete\s+from/i,
    /format\s+c:/i,
];

const MEDIUM_RISK_PATTERNS = [
    /git\s+push/i,
    /npm\s+publish/i,
    /docker\s+push/i,
    /deploy/i,
];

interface PolicyCheckResult {
    decision: PolicyDecision;
    reason?: string;
    matchedRule?: PolicyRule;
}

/**
 * Policy Engine
 * 
 * Evaluates permissions for tool calls
 */
export class PolicyEngine {
    private dataPath: string;
    private rules: PolicyRule[] = [];
    private sessionAllowances: Set<string> = new Set();
    private permanentAllowances: Set<string> = new Set();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        // Load default rules
        this.rules = [...DEFAULT_POLICIES];
        
        // Load custom rules from disk
        // TODO: Load from dataPath
        
        this.initialized = true;
    }

    /**
     * Check if a tool call is allowed
     */
    async checkToolCall(toolCall: ToolCall): Promise<PolicyCheckResult> {
        const toolName = toolCall.name;
        const args = toolCall.arguments as Record<string, unknown>;

        // Generate a signature for this tool call
        const signature = this.getToolSignature(toolCall);

        // Check if already allowed
        if (this.permanentAllowances.has(signature) || this.sessionAllowances.has(signature)) {
            return { decision: 'allow' };
        }

        // Determine the action type
        const action = TOOL_ACTIONS[toolName] ?? 'execute';

        // Get the target (command or path)
        const target = this.getTarget(toolCall);

        // Check against rules
        for (const rule of this.rules) {
            if (rule.action !== action) continue;

            const targetRegex = new RegExp(rule.target, 'i');
            if (targetRegex.test(target)) {
                return {
                    decision: rule.decision,
                    reason: rule.reason,
                    matchedRule: rule,
                };
            }
        }

        // Default: allow with risk assessment
        const risk = this.assessRisk(toolCall);
        if (risk === 'critical' || risk === 'high') {
            return {
                decision: 'approval',
                reason: `High-risk operation: ${toolName}`,
            };
        }

        return { decision: 'allow' };
    }

    /**
     * Record an approval
     */
    recordApproval(toolCall: ToolCall, scope: 'once' | 'session' | 'always'): void {
        const signature = this.getToolSignature(toolCall);

        if (scope === 'session') {
            this.sessionAllowances.add(signature);
        } else if (scope === 'always') {
            this.permanentAllowances.add(signature);
            // TODO: Persist to disk
        }
    }

    /**
     * Clear session allowances
     */
    clearSessionAllowances(): void {
        this.sessionAllowances.clear();
    }

    /**
     * Assess risk level of a tool call
     */
    assessRisk(toolCall: ToolCall): RiskLevel {
        const target = this.getTarget(toolCall);

        // Check high risk patterns
        for (const pattern of HIGH_RISK_PATTERNS) {
            if (pattern.test(target)) {
                return 'critical';
            }
        }

        // Check medium risk patterns
        for (const pattern of MEDIUM_RISK_PATTERNS) {
            if (pattern.test(target)) {
                return 'high';
            }
        }

        // Destructive operations
        if (['delete', 'rename'].includes(toolCall.name)) {
            return 'medium';
        }

        // Shell commands
        if (toolCall.name === 'shell') {
            return 'medium';
        }

        return 'low';
    }

    /**
     * Add a custom rule
     */
    addRule(rule: PolicyRule): void {
        this.rules.push(rule);
    }

    /**
     * Get all rules
     */
    getRules(): PolicyRule[] {
        return [...this.rules];
    }

    private getToolSignature(toolCall: ToolCall): string {
        const args = toolCall.arguments as Record<string, unknown>;
        
        // Create a signature based on tool name and key arguments
        if (toolCall.name === 'shell') {
            return `shell:${args.command}`;
        }
        
        return `${toolCall.name}:${JSON.stringify(args)}`;
    }

    private getTarget(toolCall: ToolCall): string {
        const args = toolCall.arguments as Record<string, unknown>;

        switch (toolCall.name) {
            case 'shell':
                return args.command as string;
            case 'read':
            case 'write':
            case 'delete':
            case 'list':
                return args.path as string;
            case 'rename':
                return `${args.oldPath} -> ${args.newPath}`;
            case 'search':
                return args.pattern as string;
            default:
                return JSON.stringify(args);
        }
    }
}
