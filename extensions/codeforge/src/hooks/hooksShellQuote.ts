/** Quote one argument for shell:true spawn (Windows-safe). */
export function quoteShellArg(arg: string): string {
	if (!/[\s"&|<>^()]/.test(arg)) return arg;
	if (process.platform === 'win32') {
		return `"${arg.replace(/"/g, '""')}"`;
	}
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}
