/**
 * OpenCodeIDE AI - Sessions Tree View
 * 
 * Displays previous AI sessions for resuming.
 */

import * as vscode from 'vscode';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sessions: SessionData[] = [];

    constructor() {
        // Load sessions from storage
        this.loadSessions();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SessionItem): Thenable<SessionItem[]> {
        if (!element) {
            // Root level - return sessions grouped by date
            return Promise.resolve(this.getSessionItems());
        }
        return Promise.resolve([]);
    }

    private getSessionItems(): SessionItem[] {
        return this.sessions.map(session => new SessionItem(
            session.task,
            session.state,
            session.id,
            session.updatedAt
        ));
    }

    private loadSessions(): void {
        // TODO: Load from storage
        // For now, use mock data
        this.sessions = [
            {
                id: '1',
                task: 'Add user authentication',
                state: 'completed',
                createdAt: new Date(Date.now() - 86400000),
                updatedAt: new Date(Date.now() - 86400000),
            },
            {
                id: '2',
                task: 'Fix login bug',
                state: 'completed',
                createdAt: new Date(Date.now() - 172800000),
                updatedAt: new Date(Date.now() - 172800000),
            },
        ];
    }

    addSession(session: SessionData): void {
        this.sessions.unshift(session);
        this.refresh();
    }

    removeSession(id: string): void {
        this.sessions = this.sessions.filter(s => s.id !== id);
        this.refresh();
    }
}

class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly task: string,
        public readonly state: string,
        public readonly sessionId: string,
        public readonly updatedAt: Date
    ) {
        super(task, vscode.TreeItemCollapsibleState.None);

        this.description = this.formatDate(updatedAt);
        this.contextValue = 'session';
        this.tooltip = `${task}\nStatus: ${state}\nLast updated: ${updatedAt.toLocaleString()}`;

        // Set icon based on state
        this.iconPath = new vscode.ThemeIcon(
            state === 'completed' ? 'check' :
            state === 'failed' ? 'error' :
            state === 'paused' ? 'debug-pause' :
            'clock'
        );

        // Command to resume session
        this.command = {
            command: 'opencodeide-ai.resumeSession',
            title: 'Resume Session',
            arguments: [sessionId]
        };
    }

    private formatDate(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const days = Math.floor(diff / 86400000);

        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7) return `${days} days ago`;
        return date.toLocaleDateString();
    }
}

interface SessionData {
    id: string;
    task: string;
    state: string;
    createdAt: Date;
    updatedAt: Date;
}
