/**
 * CodeForge AI - Approval Dialog
 *
 * Cursor-like HITL: Accept once, Allow all file edits (session/always), Deny.
 */

import * as vscode from 'vscode';
import { EDIT_TOOLS, getApprovalPolicy } from '../policy/approvalPolicy';

export interface ApprovalRequest {
	tool: string;
	arguments: Record<string, unknown>;
	risk: 'low' | 'medium' | 'high' | 'critical';
	reason: string;
}

export interface ApprovalResult {
	approved: boolean;
	scope: 'once' | 'session' | 'always' | 'edits-session' | 'edits-always';
}

export class ApprovalDialog {
	static async show(request: ApprovalRequest): Promise<ApprovalResult> {
		const policy = getApprovalPolicy();
		if (policy.isAutoApproved(request.tool)) {
			return { approved: true, scope: 'once' };
		}

		const isEdit = EDIT_TOOLS.has(request.tool.toLowerCase());
		if (isEdit) {
			return ApprovalDialog.showForEdits(request);
		}
		return ApprovalDialog.showGeneric(request);
	}

	/** Cursor-style prompts for write / rename / delete. */
	private static async showForEdits(request: ApprovalRequest): Promise<ApprovalResult> {
		const policy = getApprovalPolicy();
		const path =
			String(request.arguments.path ?? request.arguments.oldPath ?? request.arguments.newPath ?? '');
		const preview =
			typeof request.arguments.contentPreview === 'string'
				? String(request.arguments.contentPreview).slice(0, 200)
				: '';

		const message = [
			request.reason,
			path ? `File: ${path}` : `Tool: ${request.tool}`,
			preview ? `\nPreview:\n${preview}` : '',
			'',
			'Allow this change? You can also allow all file edits so we will not ask again.',
		]
			.filter(Boolean)
			.join('\n');

		const accept: vscode.MessageItem = { title: 'Accept' };
		const allowSession: vscode.MessageItem = { title: 'Allow All Edits (Session)' };
		const allowAlways: vscode.MessageItem = { title: 'Allow All Edits (Always)' };
		const deny: vscode.MessageItem = { title: 'Reject', isCloseAffordance: true };

		const result = await vscode.window.showInformationMessage(
			message,
			{ modal: true },
			accept,
			allowSession,
			allowAlways,
			deny
		);

		if (!result || result === deny || result.title === 'Reject') {
			return { approved: false, scope: 'once' };
		}

		if (result === allowAlways || result.title === 'Allow All Edits (Always)') {
			await policy.allowAllEdits('always');
			void vscode.window.setStatusBarMessage(
				'CodeForge: all file edits allowed (always)',
				4000
			);
			return { approved: true, scope: 'edits-always' };
		}

		if (result === allowSession || result.title === 'Allow All Edits (Session)') {
			await policy.allowAllEdits('session');
			void vscode.window.setStatusBarMessage(
				'CodeForge: all file edits allowed (this session)',
				4000
			);
			return { approved: true, scope: 'edits-session' };
		}

		return { approved: true, scope: 'once' };
	}

	private static async showGeneric(request: ApprovalRequest): Promise<ApprovalResult> {
		const policy = getApprovalPolicy();
		const riskEmoji = {
			low: '🟢',
			medium: '🟡',
			high: '🟠',
			critical: '🔴',
		};

		const message = `${riskEmoji[request.risk]} ${request.reason}\n\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.arguments, null, 2)}`;

		const allowOnce: vscode.MessageItem = { title: 'Allow Once' };
		const allowSession: vscode.MessageItem = { title: 'Allow for Session' };
		const allowAlways: vscode.MessageItem = { title: 'Always Allow' };
		const deny: vscode.MessageItem = { title: 'Deny', isCloseAffordance: true };

		const result = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			allowOnce,
			allowSession,
			allowAlways,
			deny
		);

		if (!result || result === deny || result.title === 'Deny') {
			return { approved: false, scope: 'once' };
		}

		let scope: 'once' | 'session' | 'always' = 'once';
		if (result === allowSession || result.title === 'Allow for Session') {
			scope = 'session';
		} else if (result === allowAlways || result.title === 'Always Allow') {
			scope = 'always';
		}

		if (scope !== 'once') {
			await policy.remember(request.tool, scope);
			const label = scope === 'always' ? 'Always' : 'This session';
			void vscode.window.setStatusBarMessage(
				`CodeForge: ${request.tool} allowed (${label})`,
				4000
			);
		}

		return { approved: true, scope };
	}

	static async showQuick(request: ApprovalRequest): Promise<boolean> {
		const result = await ApprovalDialog.show(request);
		return result.approved;
	}
}
