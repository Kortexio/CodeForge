/**
 * OpenCodeIDE - Skills Engine
 * 
 * Manages skill discovery and execution.
 */

import { Skill, SkillScope } from '../types.js';

/**
 * Skills Engine
 * 
 * Manages skills catalog and execution
 */
export class SkillsEngine {
    private readonly dataPath: string;
    private skills: Map<string, Skill> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        void this.dataPath;
        this.initialized = true;
    }

    /**
     * Get all active skills (alwaysOn)
     */
    async getActiveSkills(): Promise<Skill[]> {
        return Array.from(this.skills.values()).filter(s => s.alwaysOn);
    }

    /**
     * Get all available skills
     */
    async getAllSkills(): Promise<Skill[]> {
        return Array.from(this.skills.values());
    }

    /**
     * Get skill by ID
     */
    async getSkill(id: string): Promise<Skill | null> {
        return this.skills.get(id) ?? null;
    }

    /**
     * Search skills
     */
    async search(query: string): Promise<Skill[]> {
        const queryLower = query.toLowerCase();
        return Array.from(this.skills.values()).filter(s => 
            s.name.toLowerCase().includes(queryLower) ||
            s.description.toLowerCase().includes(queryLower) ||
            s.triggers?.some(t => t.toLowerCase().includes(queryLower))
        );
    }

    /**
     * Add a skill
     */
    async addSkill(skill: Skill): Promise<void> {
        this.skills.set(skill.id, skill);
        // TODO: Persist to disk
    }

    /**
     * Remove a skill
     */
    async removeSkill(id: string): Promise<void> {
        this.skills.delete(id);
        // TODO: Remove from disk
    }

    /**
     * Enable a skill
     */
    async enableSkill(id: string, alwaysOn: boolean = false): Promise<void> {
        const skill = this.skills.get(id);
        if (skill) {
            skill.alwaysOn = alwaysOn;
        }
    }

    /**
     * Disable a skill
     */
    async disableSkill(id: string): Promise<void> {
        const skill = this.skills.get(id);
        if (skill) {
            skill.alwaysOn = false;
        }
    }

    /**
     * Get skills by scope
     */
    async getSkillsByScope(scope: SkillScope): Promise<Skill[]> {
        return Array.from(this.skills.values()).filter(s => s.scope === scope);
    }
}
