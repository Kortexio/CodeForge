/**
 * Edit Jupyter .ipynb cells (EditNotebook parity).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

type NbCell = {
	cell_type: string;
	source: string | string[];
	metadata?: Record<string, unknown>;
	outputs?: unknown[];
	execution_count?: number | null;
};

type Notebook = {
	cells: NbCell[];
	metadata?: Record<string, unknown>;
	nbformat?: number;
	nbformat_minor?: number;
};

function cellSource(cell: NbCell): string {
	return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

function setCellSource(cell: NbCell, text: string): void {
	cell.source = text.endsWith('\n') ? text : text + '\n';
}

export async function editNotebook(opts: {
	workspaceRoot?: string;
	path: string;
	cellIndex: number;
	newSource: string;
	cellLanguage?: string;
	isNewCell?: boolean;
}): Promise<string> {
	const rel = opts.path.replace(/\\/g, '/');
	const abs = path.isAbsolute(rel)
		? rel
		: path.join(opts.workspaceRoot || process.cwd(), rel);
	let nb: Notebook;
	try {
		nb = JSON.parse(await fs.readFile(abs, 'utf8')) as Notebook;
	} catch (err) {
		if (opts.isNewCell) {
			nb = {
				nbformat: 4,
				nbformat_minor: 5,
				metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
				cells: [],
			};
		} else {
			return `Error: cannot read notebook: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	if (!Array.isArray(nb.cells)) nb.cells = [];

	const idx = Math.max(0, Math.floor(opts.cellIndex));
	const lang = (opts.cellLanguage || 'python').toLowerCase();
	const cellType = lang === 'markdown' || lang === 'md' ? 'markdown' : 'code';

	if (opts.isNewCell || idx >= nb.cells.length) {
		const insertAt = Math.min(idx, nb.cells.length);
		const cell: NbCell = {
			cell_type: cellType,
			metadata: {},
			source: '',
			...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
		};
		setCellSource(cell, opts.newSource);
		nb.cells.splice(insertAt, 0, cell);
		await fs.writeFile(abs, JSON.stringify(nb, null, 1), 'utf8');
		return `Inserted ${cellType} cell at index ${insertAt} in ${rel}`;
	}

	const cell = nb.cells[idx];
	const before = cellSource(cell).slice(0, 200);
	if (opts.cellLanguage) {
		cell.cell_type = cellType;
		if (cellType === 'code' && !cell.outputs) {
			cell.outputs = [];
			cell.execution_count = null;
		}
	}
	setCellSource(cell, opts.newSource);
	await fs.writeFile(abs, JSON.stringify(nb, null, 1), 'utf8');
	return [
		`Updated cell ${idx} (${cell.cell_type}) in ${rel}`,
		`Previous preview: ${before.replace(/\n/g, ' ').slice(0, 120)}`,
	].join('\n');
}
