/**
 * Windows desktop control (virtual screen, all monitors).
 * Screenshots stay in the artifact store and the vision handoff — not the wiki.
 * Other platforms return Not run (no fake success).
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { stashVision } from '../browser/session';
import { getArtifactStore } from '../storage/artifacts';

const execFileAsync = promisify(execFile);

export function computerPlatformReason(): string | null {
	if (process.platform === 'win32') return null;
	return 'Not run: computer use is implemented on Windows only.';
}

function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShell(script: string): Promise<string> {
	const file = path.join(os.tmpdir(), `cf-computer-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
	await fs.writeFile(file, script, 'utf8');
	try {
		const { stdout } = await execFileAsync(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
			{ timeout: 20_000, windowsHide: true, maxBuffer: 2_000_000 }
		);
		return String(stdout ?? '');
	} finally {
		await fs.unlink(file).catch(() => undefined);
	}
}

const INPUT_TYPE = `
if (-not ('CfInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CfInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
}
'@
}
`;

export async function computerScreenshot(sessionId?: string): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	const out = path.join(os.tmpdir(), `cf-screen-${Date.now()}.png`);
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap([Math]::Max(1, $vs.Width), [Math]::Max(1, $vs.Height))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(out)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("virtual " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)
`;
	const info = (await runPowerShell(script)).trim();
	const buf = await fs.readFile(out);
	await fs.unlink(out).catch(() => undefined);
	stashVision(buf);
	const artifact = await getArtifactStore().create('screenshot', `desktop-${Date.now()}.png`, buf, sessionId);
	return [
		`Desktop screenshot saved as artifact ${artifact.id} (${artifact.bytes} bytes) at ${artifact.path}`,
		info ? `Bounds: ${info}` : 'Bounds: virtual screen',
		'Coordinates for click/move are virtual-screen pixels (all monitors).',
	].join('\n');
}

export async function computerMove(x: number, y: number): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y must be numbers';
	await runPowerShell(`
${INPUT_TYPE}
[CfInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Write-Output 'moved'
`);
	return `Moved pointer to ${Math.round(x)},${Math.round(y)} (virtual screen).`;
}

export async function computerClick(x: number, y: number): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y must be numbers';
	await runPowerShell(`
${INPUT_TYPE}
[CfInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
[CfInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[CfInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'clicked'
`);
	return `Clicked ${Math.round(x)},${Math.round(y)} (virtual screen).`;
}

function sendKeysLiteral(text: string): string {
	return text.replace(/[+^%~(){}]/g, ch => `{${ch}}`);
}

export async function computerType(text: string): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	if (!text) return 'Error: text is required';
	await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeysLiteral(text))})
Write-Output 'typed'
`);
	return `Typed ${text.length} characters into the focused window.`;
}

export async function computerKey(key: string): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	const token = key.trim();
	if (!/^[A-Za-z0-9+^{}%()]+$/.test(token)) return 'Error: key must be a SendKeys token such as {ENTER}';
	await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(token.startsWith('{') ? token : `{${token}}`)})
Write-Output 'key'
`);
	return `Pressed ${token}.`;
}

export async function computerScroll(dy: number): Promise<string> {
	const blocked = computerPlatformReason();
	if (blocked) return blocked;
	if (!Number.isFinite(dy)) return 'Error: dy must be a number';
	const delta = Math.max(-10, Math.min(10, Math.round(dy))) * 120;
	await runPowerShell(`
${INPUT_TYPE}
[CfInput]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)
Write-Output 'scrolled'
`);
	return `Scrolled wheel by ${delta}.`;
}
