/**
 * Checkpoint progress review — ask user when agent is blocked.
 */

import * as vscode from 'vscode';

export interface ProgressProposal {
	id: string;
	title: string;
	detail: string;
}

export interface ProgressEval {
	verdict: 'positive' | 'negative' | 'blocked' | 'done';
	cause: string;
	path: string;
	summary: string;
	proposals?: ProgressProposal[];
}

export class ProgressReviewDialog {
	/**
	 * Present blocker proposals; returns chosen proposal id, or null if stop.
	 */
	static async chooseProposal(
		evalResult: ProgressEval
	): Promise<{ action: 'continue'; proposal: ProgressProposal } | { action: 'stop' } | { action: 'replan' }> {
		const proposals = evalResult.proposals?.length
			? evalResult.proposals
			: [
					{
						id: 'retry',
						title: 'Tentar outra abordagem automaticamente',
						detail: 'O agent reanalisa e continua',
					},
					{
						id: 'ask',
						title: 'Parar e explicar o bloqueio',
						detail: 'Termina a tarefa e devolve o diagnóstico',
					},
				];

		const items: Array<vscode.QuickPickItem & { _id: string }> = [
			...proposals.map(p => ({
				label: `$(lightbulb) ${p.title}`,
				description: p.detail.slice(0, 80),
				detail: p.detail,
				_id: p.id,
			})),
			{
				label: '$(debug-restart) Reanalisar e continuar',
				description: 'Forçar replan sem escolher proposta específica',
				_id: 'replan',
			},
			{
				label: '$(close) Parar aqui',
				description: 'Cancelar a tarefa',
				_id: 'stop',
			},
		];

		await vscode.window.showInformationMessage(
			`Agent bloqueado\n\nCausa: ${evalResult.cause}\n\nCaminho até agora: ${evalResult.path}`,
			{ modal: true }
		);

		const picked = await vscode.window.showQuickPick(items, {
			title: 'CodeForge — como resolver?',
			placeHolder: 'Escolhe uma opção de resolução',
			ignoreFocusOut: true,
		});

		if (!picked || picked._id === 'stop') {
			return { action: 'stop' };
		}
		if (picked._id === 'replan') {
			return { action: 'replan' };
		}
		const proposal = proposals.find(p => p.id === picked._id) ?? {
			id: picked._id,
			title: picked.label,
			detail: picked.detail ?? '',
		};
		return { action: 'continue', proposal };
	}
}
