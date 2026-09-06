/**
 * OpenCodeIDE - Memory Engine
 * 
 * Manages session and project memory with persistence.
 */

import { v4 as uuid } from 'uuid';
import {
    Session,
    SessionState,
    SessionWiki,
    WikiPage,
    WorkingMemory,
    ChatMessage,
    ToolCall,
    ToolResult,
    Artifact,
} from '../types.js';

/**
 * Memory Engine
 * 
 * Manages persistent memory for sessions and projects
 */
export class MemoryEngine {
    private dataPath: string;
    private sessions: Map<string, Session> = new Map();
    private wikis: Map<string, SessionWiki> = new Map();
    private messages: Map<string, ChatMessage[]> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        // Load persisted sessions from disk
        // For now, using in-memory storage
        this.initialized = true;
    }

    async shutdown(): Promise<void> {
        // Persist all sessions to disk
        this.initialized = false;
    }

    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Create a new session
     */
    async createSession(id: string, task: string): Promise<Session> {
        const session: Session = {
            id,
            task,
            state: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        this.sessions.set(id, session);
        
        // Initialize wiki for session
        const wiki: SessionWiki = {
            id: uuid(),
            sessionId: id,
            pages: [],
            index: `# Session: ${task}\n\nStarted at ${session.createdAt.toISOString()}`,
            log: '',
            workingMemory: {
                objective: task,
                plan: [],
                recentTools: [],
                blockers: [],
                items: [],
            },
            artifacts: [],
        };
        this.wikis.set(id, wiki);
        
        // Initialize messages
        this.messages.set(id, []);

        return session;
    }

    /**
     * Get a session by ID
     */
    async getSession(sessionId: string): Promise<Session | null> {
        return this.sessions.get(sessionId) ?? null;
    }

    /**
     * Update session state
     */
    async updateSessionState(sessionId: string, state: SessionState): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.state = state;
            session.updatedAt = new Date();
            if (state === 'completed' || state === 'failed' || state === 'cancelled') {
                session.completedAt = new Date();
            }
        }
    }

    /**
     * Get session wiki
     */
    async getWiki(sessionId: string): Promise<SessionWiki | null> {
        return this.wikis.get(sessionId) ?? null;
    }

    /**
     * Add a page to session wiki
     */
    async addWikiPage(sessionId: string, title: string, content: string): Promise<WikiPage> {
        const wiki = this.wikis.get(sessionId);
        if (!wiki) throw new Error(`Session not found: ${sessionId}`);

        const page: WikiPage = {
            id: uuid(),
            title,
            content,
            importance: 'medium',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        wiki.pages.push(page);
        return page;
    }

    /**
     * Update working memory
     */
    async updateWorkingMemory(sessionId: string, updates: Partial<WorkingMemory>): Promise<void> {
        const wiki = this.wikis.get(sessionId);
        if (!wiki) throw new Error(`Session not found: ${sessionId}`);

        wiki.workingMemory = { ...wiki.workingMemory, ...updates };
    }

    /**
     * Get messages for a session
     */
    async getMessages(sessionId: string): Promise<ChatMessage[]> {
        return this.messages.get(sessionId) ?? [];
    }

    /**
     * Set messages for a session (used by compactor)
     */
    async setMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
        this.messages.set(sessionId, messages);
    }

    /**
     * Add a message to session
     */
    async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
        const messages = this.messages.get(sessionId) ?? [];
        messages.push(message);
        this.messages.set(sessionId, messages);
    }

    /**
     * Add tool result to session
     */
    async addToolResult(sessionId: string, toolCall: ToolCall, result: ToolResult): Promise<void> {
        // Add to working memory
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.workingMemory.recentTools = [
                toolCall,
                ...wiki.workingMemory.recentTools.slice(0, 9), // Keep last 10
            ];

            // Log the tool call
            wiki.log += `\n[${new Date().toISOString()}] ${toolCall.name}: ${result.success ? 'success' : 'failed'}`;
        }

        // Add tool message
        await this.addMessage(sessionId, {
            role: 'tool',
            content: result.success ? result.output : `Error: ${result.error}`,
            toolCallId: toolCall.id,
        });
    }

    /**
     * Add artifact to session
     */
    async addArtifact(sessionId: string, artifact: Artifact): Promise<void> {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.artifacts.push(artifact);
        }
    }

    /**
     * Create a checkpoint for HITL
     */
    async createCheckpoint(sessionId: string): Promise<string> {
        const checkpointId = uuid();
        // Store current state for later resume
        // For now, just return the checkpoint ID
        return checkpointId;
    }

    /**
     * Archive old messages (for compaction)
     */
    async archiveMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
        // Store in archive (would be persisted to disk)
        // For now, just log
        console.log(`Archived ${messages.length} messages for session ${sessionId}`);
    }

    /**
     * Estimate token count for session
     */
    async estimateTokenCount(sessionId: string): Promise<number> {
        const messages = await this.getMessages(sessionId);
        const wiki = await this.getWiki(sessionId);

        let charCount = 0;
        for (const msg of messages) {
            charCount += msg.content.length;
        }
        if (wiki) {
            charCount += wiki.index.length;
            charCount += wiki.log.length;
            for (const page of wiki.pages) {
                charCount += page.content.length;
            }
        }

        // Rough estimate: 4 chars per token
        return Math.ceil(charCount / 4);
    }

    /**
     * Set rolling summary
     */
    async setRollingSummary(sessionId: string, summary: string): Promise<void> {
        const wiki = this.wikis.get(sessionId);
        if (wiki) {
            wiki.rollingSummary = summary;
        }
    }

    /**
     * List all sessions
     */
    async listSessions(): Promise<Session[]> {
        return Array.from(this.sessions.values());
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId);
        this.wikis.delete(sessionId);
        this.messages.delete(sessionId);
    }
}
