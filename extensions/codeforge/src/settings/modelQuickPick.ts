/**
 * QuickPick to switch the active model while working (Cursor-like).
 * Full server/MCP configuration lives in AiSettingsPanel.
 */

import * as vscode from 'vscode';
import { AiSettingsStore } from './aiSettingsStore';

export async function showModelQuickPick(store: AiSettingsStore): Promise<void> {
	const state = store.getState();
	const enabled = state.servers.filter(s => s.enabled);

	if (!enabled.length) {
		const open = 'Open Settings';
		const pick = await vscode.window.showInformationMessage(
			'No AI servers configured yet.',
			open
		);
		if (pick === open) {
			await vscode.commands.executeCommand('codeforge.openSettings');
		}
		return;
	}

	type Item = vscode.QuickPickItem & { serverId: string; model: string };
	const items: Item[] = [];

	for (const server of enabled) {
		for (const model of server.models) {
			const active = state.activeServerId === server.id && state.activeModel === model;
			items.push({
				label: active ? `$(check) ${model}` : model,
				description: server.name,
				detail: `${server.kind}${server.baseUrl ? ` · ${server.baseUrl}` : ''}`,
				serverId: server.id,
				model,
			});
		}
	}

	items.push({
		label: '$(gear) Manage servers & models…',
		description: 'Open Settings',
		detail: 'Add API keys, local servers, MCP',
		serverId: '',
		model: '',
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Switch model',
		placeHolder: 'Select the model to use for Agent / Ask',
		matchOnDescription: true,
		matchOnDetail: true,
	});

	if (!picked) return;

	if (!picked.serverId) {
		await vscode.commands.executeCommand('codeforge.openSettings');
		return;
	}

	await store.setActiveModel(picked.serverId, picked.model);
	vscode.window.setStatusBarMessage(`CodeForge: ${picked.description} · ${picked.model}`, 3000);
}
