/**
 * OpenCodeIDE - Rules Engine
 * 
 * Manages rule hierarchy and application.
 */

import { Rule, RuleScope } from '../types.js';

/**
 * Rules Engine
 * 
 * Manages hierarchical rules for agent behavior
 */
export class RulesEngine {
    private dataPath: string;
    private rules: Map<string, Rule> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        // Load rules from disk
        // TODO: Load from dataPath
        
        this.initialized = true;
    }

    /**
     * Get all applicable rules (merged hierarchy)
     */
    async getApplicableRules(): Promise<Rule[]> {
        // Rules are merged in order: system -> user -> workspace -> folder -> task
        const scopeOrder: RuleScope[] = ['system', 'user', 'workspace', 'folder', 'task'];
        
        const allRules = Array.from(this.rules.values());
        return allRules.sort((a, b) => {
            const aIndex = scopeOrder.indexOf(a.scope);
            const bIndex = scopeOrder.indexOf(b.scope);
            if (aIndex !== bIndex) return aIndex - bIndex;
            return b.priority - a.priority;
        });
    }

    /**
     * Get all rules
     */
    async getAllRules(): Promise<Rule[]> {
        return Array.from(this.rules.values());
    }

    /**
     * Get rule by ID
     */
    async getRule(id: string): Promise<Rule | null> {
        return this.rules.get(id) ?? null;
    }

    /**
     * Add a rule
     */
    async addRule(rule: Rule): Promise<void> {
        this.rules.set(rule.id, rule);
        // TODO: Persist to disk
    }

    /**
     * Remove a rule
     */
    async removeRule(id: string): Promise<void> {
        this.rules.delete(id);
        // TODO: Remove from disk
    }

    /**
     * Update a rule
     */
    async updateRule(id: string, updates: Partial<Rule>): Promise<void> {
        const rule = this.rules.get(id);
        if (rule) {
            Object.assign(rule, updates);
        }
    }

    /**
     * Get rules by scope
     */
    async getRulesByScope(scope: RuleScope): Promise<Rule[]> {
        return Array.from(this.rules.values()).filter(r => r.scope === scope);
    }

    /**
     * Explain why a rule is applied
     */
    async explainRule(id: string): Promise<string> {
        const rule = this.rules.get(id);
        if (!rule) return 'Rule not found';

        return `Rule "${rule.name}" (${rule.scope} scope, priority ${rule.priority}):\n${rule.description}\n\nContent:\n${rule.content}`;
    }
}
