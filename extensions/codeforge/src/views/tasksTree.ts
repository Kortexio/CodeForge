/**
 * CodeForge AI - Tasks Tree View
 * 
 * Displays current and recent AI tasks with subagents.
 */

import * as vscode from 'vscode';

export class TasksTreeProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private tasks: TaskData[] = [];

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TaskItem): Thenable<TaskItem[]> {
        if (!element) {
            // Root level - return main tasks
            return Promise.resolve(this.tasks.map(t => new TaskItem(t)));
        }

        // Return subtasks
        const task = this.tasks.find(t => t.id === element.taskId);
        if (task?.subtasks) {
            return Promise.resolve(task.subtasks.map(st => new TaskItem(st, true)));
        }

        return Promise.resolve([]);
    }

    addTask(task: TaskData): void {
        this.tasks.unshift(task);
        if (this.tasks.length > 50) {
            this.tasks = this.tasks.slice(0, 50);
        }
        this.refresh();
    }

    upsertTask(task: TaskData): void {
        const idx = this.tasks.findIndex(t => t.id === task.id);
        if (idx >= 0) {
            this.tasks[idx] = { ...this.tasks[idx], ...task };
        } else {
            this.tasks.unshift(task);
            if (this.tasks.length > 50) {
                this.tasks = this.tasks.slice(0, 50);
            }
        }
        this.refresh();
    }

    updateTask(id: string, updates: Partial<TaskData>): void {
        const task = this.tasks.find(t => t.id === id);
        if (task) {
            Object.assign(task, updates);
            this.refresh();
        }
    }

    removeTask(id: string): void {
        this.tasks = this.tasks.filter(t => t.id !== id);
        this.refresh();
    }

    clearCompleted(): void {
        this.tasks = this.tasks.filter(t => t.status !== 'completed');
        this.refresh();
    }
}

class TaskItem extends vscode.TreeItem {
    public readonly taskId: string;

    constructor(
        public readonly task: TaskData,
        isSubtask: boolean = false
    ) {
        super(
            task.name,
            task.subtasks?.length
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None
        );

        this.taskId = task.id;
        this.description = this.getDescription();
        this.contextValue = isSubtask ? 'subtask' : 'task';
        this.tooltip = this.getTooltip();

        // Set icon based on status
        this.iconPath = new vscode.ThemeIcon(
            task.status === 'completed' ? 'check' :
            task.status === 'failed' ? 'error' :
            task.status === 'cancelled' ? 'circle-slash' :
            task.status === 'running' ? 'sync~spin' :
            'circle-outline'
        );
    }

    private getDescription(): string {
        const parts: string[] = [];

        if (this.task.status === 'running' && this.task.elapsed) {
            parts.push(this.formatDuration(this.task.elapsed));
        }

        if (this.task.model) {
            parts.push(this.task.model);
        }

        if (this.task.workspace) {
            parts.push('isolated');
        }

        return parts.join(' • ');
    }

    private getTooltip(): string {
        const lines = [this.task.name];

        if (this.task.status) {
            lines.push(`Status: ${this.task.status}`);
        }

        if (this.task.model) {
            lines.push(`Model: ${this.task.model}`);
        }

        if (this.task.workspace) {
            lines.push(`Workspace: ${this.task.workspace}`);
        }

        if (this.task.result) {
            lines.push(`Result: ${this.task.result}`);
        }

        return lines.join('\n');
    }

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        return `${minutes}m ${seconds % 60}s`;
    }
}

export interface TaskData {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    model?: string;
    workspace?: string;
    elapsed?: number;
    result?: string;
    subtasks?: TaskData[];
}
