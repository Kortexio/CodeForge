/**
 * OpenCodeIDE - Background Agent Manager
 * 
 * Manages long-running background tasks that don't block the main agent.
 */

import { v4 as uuid } from 'uuid';
import { AgentResult } from '../types.js';

export interface BackgroundTask {
    id: string;
    name: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    result?: AgentResult;
    startedAt?: Date;
    completedAt?: Date;
    workspacePath?: string;
    isolated: boolean;
}

export interface BackgroundTaskConfig {
    name: string;
    description: string;
    task: () => Promise<AgentResult>;
    isolated?: boolean;
    workspacePath?: string;
    onProgress?: (progress: number) => void;
    onComplete?: (result: AgentResult) => void;
}

/**
 * Background Agent Manager
 * 
 * Runs tasks in separate worker processes or threads
 */
export class BackgroundAgentManager {
    private tasks: Map<string, BackgroundTask> = new Map();
    private runningTasks: Map<string, AbortController> = new Map();
    private maxConcurrentTasks = 3;

    /**
     * Start a background task
     */
    async start(config: BackgroundTaskConfig): Promise<string> {
        const taskId = uuid();
        const task: BackgroundTask = {
            id: taskId,
            name: config.name,
            description: config.description,
            status: 'pending',
            progress: 0,
            isolated: config.isolated ?? false,
            workspacePath: config.workspacePath,
        };

        this.tasks.set(taskId, task);

        // Check if we can run immediately
        if (this.runningTasks.size < this.maxConcurrentTasks) {
            this.runTask(taskId, config);
        }

        return taskId;
    }

    /**
     * Cancel a background task
     */
    cancel(taskId: string): boolean {
        const controller = this.runningTasks.get(taskId);
        if (controller) {
            controller.abort();
            this.runningTasks.delete(taskId);
            
            const task = this.tasks.get(taskId);
            if (task) {
                task.status = 'cancelled';
                task.completedAt = new Date();
            }
            return true;
        }
        return false;
    }

    /**
     * Get task status
     */
    getTask(taskId: string): BackgroundTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get all tasks
     */
    getAllTasks(): BackgroundTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get running tasks
     */
    getRunningTasks(): BackgroundTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'running');
    }

    /**
     * Get pending tasks
     */
    getPendingTasks(): BackgroundTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'pending');
    }

    /**
     * Clean up completed tasks
     */
    cleanup(maxAge: number = 24 * 60 * 60 * 1000): void {
        const now = Date.now();
        for (const [id, task] of this.tasks) {
            if (task.completedAt && now - task.completedAt.getTime() > maxAge) {
                this.tasks.delete(id);
            }
        }
    }

    /**
     * Run a task
     */
    private async runTask(taskId: string, config: BackgroundTaskConfig): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) return;

        const controller = new AbortController();
        this.runningTasks.set(taskId, controller);

        task.status = 'running';
        task.startedAt = new Date();

        try {
            const result = await config.task();
            
            if (controller.signal.aborted) return;

            task.status = 'completed';
            task.result = result;
            task.progress = 100;
            task.completedAt = new Date();

            if (config.onComplete) {
                config.onComplete(result);
            }
        } catch (error) {
            if (controller.signal.aborted) return;

            task.status = 'failed';
            task.completedAt = new Date();
            task.result = {
                taskId,
                success: false,
                summary: error instanceof Error ? error.message : String(error),
                changes: [],
                artifacts: [],
                errors: [error instanceof Error ? error.message : String(error)],
                duration: Date.now() - (task.startedAt?.getTime() ?? Date.now()),
                tokensUsed: 0,
            };
        } finally {
            this.runningTasks.delete(taskId);
            
            // Start next pending task if available
            this.startNextPendingTask();
        }
    }

    /**
     * Start the next pending task
     */
    private startNextPendingTask(): void {
        if (this.runningTasks.size >= this.maxConcurrentTasks) return;

        const pending = this.getPendingTasks();
        if (pending.length > 0) {
            // For now, just mark as can start - actual start needs config
            console.log(`Ready to start next pending task: ${pending[0].id}`);
        }
    }
}

/**
 * Notification when background task completes
 */
export interface BackgroundTaskNotification {
    taskId: string;
    taskName: string;
    success: boolean;
    summary: string;
    duration: number;
}

/**
 * Create notification for completed task
 */
export function createNotification(task: BackgroundTask): BackgroundTaskNotification {
    return {
        taskId: task.id,
        taskName: task.name,
        success: task.result?.success ?? false,
        summary: task.result?.summary ?? 'Task completed',
        duration: task.completedAt && task.startedAt
            ? task.completedAt.getTime() - task.startedAt.getTime()
            : 0,
    };
}
