/**
 * OpenCodeIDE - Trace Service
 * 
 * Provides observability for agent execution.
 */

import { TraceEntry, TraceLevel, TraceMetrics } from '../types.js';

/**
 * Trace Service
 * 
 * Logs and tracks agent execution for debugging and observability
 */
export class TraceService {
    private readonly dataPath: string;
    private entries: TraceEntry[] = [];
    private metrics: TraceMetrics = {
        totalTokens: 0,
        totalDuration: 0,
        toolCalls: 0,
        llmCalls: 0,
        errors: 0,
    };

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    /**
     * Get path used for persisting traces
     */
    getDataPath(): string {
        return this.dataPath;
    }

    /**
     * Log a message
     */
    log(component: string, message: string, data?: unknown): void {
        this.addEntry('info', component, message, data);
    }

    /**
     * Log a warning
     */
    warn(component: string, message: string, data?: unknown): void {
        this.addEntry('warn', component, message, data);
    }

    /**
     * Log an error
     */
    error(component: string, message: string, data?: unknown): void {
        this.addEntry('error', component, message, data);
        this.metrics.errors++;
    }

    /**
     * Log a debug message
     */
    debug(component: string, message: string, data?: unknown): void {
        this.addEntry('debug', component, message, data);
    }

    /**
     * Track token usage
     */
    trackTokens(tokens: number): void {
        this.metrics.totalTokens += tokens;
    }

    /**
     * Track duration
     */
    trackDuration(duration: number): void {
        this.metrics.totalDuration += duration;
    }

    /**
     * Track a tool call
     */
    trackToolCall(): void {
        this.metrics.toolCalls++;
    }

    /**
     * Track an LLM call
     */
    trackLlmCall(): void {
        this.metrics.llmCalls++;
    }

    /**
     * Get current metrics
     */
    getMetrics(): TraceMetrics {
        return { ...this.metrics };
    }

    /**
     * Get recent entries
     */
    getEntries(count?: number): TraceEntry[] {
        if (count) {
            return this.entries.slice(-count);
        }
        return [...this.entries];
    }

    /**
     * Get entries for a specific component
     */
    getEntriesForComponent(component: string): TraceEntry[] {
        return this.entries.filter(e => e.component === component);
    }

    /**
     * Clear all entries and reset metrics
     */
    clear(): void {
        this.entries = [];
        this.metrics = {
            totalTokens: 0,
            totalDuration: 0,
            toolCalls: 0,
            llmCalls: 0,
            errors: 0,
        };
    }

    /**
     * Export trace to JSON
     */
    export(): string {
        return JSON.stringify({
            entries: this.entries,
            metrics: this.metrics,
        }, null, 2);
    }

    private addEntry(level: TraceLevel, component: string, message: string, data?: unknown): void {
        const entry: TraceEntry = {
            timestamp: new Date(),
            level,
            component,
            message,
            data,
        };

        this.entries.push(entry);

        // Keep last 1000 entries
        if (this.entries.length > 1000) {
            this.entries = this.entries.slice(-1000);
        }

        // Console output for development
        const prefix = `[${level.toUpperCase()}] [${component}]`;
        if (level === 'error') {
            console.error(prefix, message, data ?? '');
        } else if (level === 'warn') {
            console.warn(prefix, message, data ?? '');
        } else {
            console.log(prefix, message, data ?? '');
        }
    }
}
