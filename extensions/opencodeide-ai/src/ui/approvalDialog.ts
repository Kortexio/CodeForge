/**
 * OpenCodeIDE AI - Approval Dialog
 * 
 * HITL approval UI for dangerous operations.
 */

import * as vscode from 'vscode';

export interface ApprovalRequest {
    tool: string;
    arguments: Record<string, unknown>;
    risk: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
}

export interface ApprovalResult {
    approved: boolean;
    scope: 'once' | 'session' | 'always';
}

export class ApprovalDialog {
    /**
     * Show approval dialog and return result
     */
    static async show(request: ApprovalRequest): Promise<ApprovalResult> {
        const riskEmoji = {
            low: '🟢',
            medium: '🟡',
            high: '🟠',
            critical: '🔴'
        };

        const message = `${riskEmoji[request.risk]} ${request.reason}\n\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.arguments, null, 2)}`;

        const options: vscode.MessageItem[] = [
            { title: 'Allow Once' },
            { title: 'Allow for Session' },
            { title: 'Always Allow' },
            { title: 'Deny', isCloseAffordance: true }
        ];

        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            ...options
        );

        if (!result || result.title === 'Deny') {
            return { approved: false, scope: 'once' };
        }

        const scopeMap: Record<string, 'once' | 'session' | 'always'> = {
            'Allow Once': 'once',
            'Allow for Session': 'session',
            'Always Allow': 'always'
        };

        return {
            approved: true,
            scope: scopeMap[result.title] ?? 'once'
        };
    }

    /**
     * Show quick approval for lower-risk operations
     */
    static async showQuick(request: ApprovalRequest): Promise<boolean> {
        const result = await vscode.window.showInformationMessage(
            `AI wants to execute: ${request.tool}`,
            'Allow',
            'Deny'
        );

        return result === 'Allow';
    }
}
