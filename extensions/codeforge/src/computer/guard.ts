/**
 * Computer-use availability and the per-turn grant.
 * allowAll / fullAgentFreedom do not grant this (see ApprovalPolicy).
 */

import * as vscode from 'vscode';
import { isApprovalDialogOpen } from '../ui/approvalDialog';

let grantedTurnId: string | undefined;

export function isComputerTool(name: string): boolean {
	return name.trim().toLowerCase().startsWith('computer_');
}

export function isComputerInput(name: string): boolean {
	const key = name.trim().toLowerCase();
	return key.startsWith('computer_') && key !== 'computer_screenshot';
}

export function computerChannelOpen(): boolean {
	if (process.platform !== 'win32') return false;
	if (
		process.env.CODEFORGE_HEADLESS === '1' ||
		process.env.CODEFORGE_BENCH === '1' ||
		process.env.CI === 'true'
	) {
		return false;
	}
	try {
		if (vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('computerInteractive') === false) {
			return false;
		}
	} catch {
		return false;
	}
	return true;
}

export function computerUnavailableReason(): string | null {
	if (process.platform !== 'win32') return 'Not run: computer use is implemented on Windows only.';
	if (!computerChannelOpen()) {
		return 'Not run: computer use needs an interactive Windows desktop (disabled in headless/bench).';
	}
	return null;
}

export function computerInputBlockedReason(name: string): string | null {
	if (!isComputerInput(name)) return null;
	if (isApprovalDialogOpen()) {
		return 'Not run: computer input is paused while an approval dialog is open.';
	}
	return null;
}

export function computerTurnGranted(turnId: string): boolean {
	return grantedTurnId === turnId;
}

export function grantComputerTurn(turnId: string): void {
	grantedTurnId = turnId;
}

export function clearComputerGrant(turnId?: string): void {
	if (!turnId || grantedTurnId === turnId) grantedTurnId = undefined;
}

/** Test hook. */
export function setComputerGrantForTests(turnId: string | undefined): void {
	grantedTurnId = turnId;
}
