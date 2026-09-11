/**
 * CodeForge AI - Sessions Tree View (persisted)
 */

import * as vscode from 'vscode';
import { SessionStore, ChatSession } from '../sessions/sessionStore';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly store: SessionStore) {
		store.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: SessionItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: SessionItem): Thenable<SessionItem[]> {
		if (element) {
			return Promise.resolve([]);
		}
		const sessions = this.store.list({ workspaceOnly: true });
		if (!sessions.length) {
			return Promise.resolve([SessionItem.emptyPlaceholder()]);
		}
		return Promise.resolve(sessions.map(s => SessionItem.fromSession(s)));
	}
}

class SessionItem extends vscode.TreeItem {
	static emptyPlaceholder(): SessionItem {
		const item = new SessionItem();
		item.label = 'No sessions yet';
		item.description = 'Chats will appear here';
		item.contextValue = 'sessionEmpty';
		return item;
	}

	static fromSession(session: ChatSession): SessionItem {
		const item = new SessionItem();
		item.label = session.title || session.task;
		item.id = session.id;
		item.description = formatRelative(new Date(session.updatedAt));
		item.contextValue = 'session';
		item.tooltip = [
			session.task,
			`Status: ${session.state}`,
			session.serverName ? `Server: ${session.serverName}` : undefined,
			session.model ? `Model: ${session.model}` : undefined,
			`Updated: ${new Date(session.updatedAt).toLocaleString()}`,
			`${session.messages.length} messages`,
		]
			.filter(Boolean)
			.join('\n');

		item.iconPath = new vscode.ThemeIcon(
			session.state === 'completed'
				? 'check'
				: session.state === 'failed'
					? 'error'
					: session.state === 'paused'
						? 'debug-pause'
						: session.state === 'cancelled'
							? 'circle-slash'
							: 'comment-discussion'
		);

		item.command = {
			command: 'codeforge.resumeSession',
			title: 'Open Session',
			arguments: [session.id],
		};
		return item;
	}

	private constructor() {
		super('', vscode.TreeItemCollapsibleState.None);
	}
}

function formatRelative(date: Date): string {
	const now = new Date();
	const diff = now.getTime() - date.getTime();
	const days = Math.floor(diff / 86400000);
	if (days === 0) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
	if (days === 1) return 'Yesterday';
	if (days < 7) return `${days}d ago`;
	return date.toLocaleDateString();
}
