/**
 * Apply CodeForge patches on top of Code-OSS.
 * Currently:
 * - Allow Visual Studio 2026 (folder "18") in Windows toolchain check
 * - Register codeforge in gulpfile.extensions.ts compilations
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const preinstallPath = path.join(root, 'vscode', 'build', 'npm', 'preinstall.ts');
const gulpExtensionsPath = path.join(root, 'vscode', 'build', 'gulpfile.extensions.ts');

if (!fs.existsSync(preinstallPath)) {
	console.error('vscode/build/npm/preinstall.ts not found. Run vscode setup first.');
	process.exit(1);
}

let source = fs.readFileSync(preinstallPath, 'utf8');

const oldVersions = `const supportedVersions = ['2022', '2019'];`;
const newVersions = `const supportedVersions = ['2022', '2019', '18', '2026'];`;
// Upstream (2026+) uses year/folder objects and already lists VS 2026.
const upstreamObjectForm =
	/const supportedVersions = \[[\s\S]*?\{ year: '2026', folder: '18' \}[\s\S]*?\];/.test(source);

if (source.includes(oldVersions)) {
	source = source.replace(oldVersions, newVersions);
	source = source.replace(
		'set vs2022_install=<path> (or vs2019_install for older versions)',
		'set vs2022_install=<path> (or vs2019_install / vs18_install / vs2026_install)'
	);
	fs.writeFileSync(preinstallPath, source, 'utf8');
	console.log('Patched vscode/build/npm/preinstall.ts to accept Visual Studio 2026 (18)');
} else if (source.includes(newVersions) || upstreamObjectForm) {
	console.log('VS toolchain patch already applied (or upstream includes VS 2026)');
} else {
	console.error('Could not find supportedVersions marker in preinstall.ts — upstream may have changed.');
	process.exit(1);
}

// Register built-in AI extension compilation
if (fs.existsSync(gulpExtensionsPath)) {
	let gulpSrc = fs.readFileSync(gulpExtensionsPath, 'utf8');
	const marker = `'extensions/codeforge/tsconfig.json',`;
	if (gulpSrc.includes(marker)) {
		console.log('codeforge already registered in gulpfile.extensions.ts');
	} else {
		const anchor = `'extensions/npm/tsconfig.json',`;
		if (!gulpSrc.includes(anchor)) {
			console.error('Could not find npm tsconfig anchor in gulpfile.extensions.ts');
			process.exit(1);
		}
		gulpSrc = gulpSrc.replace(anchor, `${anchor}\n\t${marker}`);
		fs.writeFileSync(gulpExtensionsPath, gulpSrc, 'utf8');
		console.log('Registered extensions/codeforge in gulpfile.extensions.ts');
	}
}

// Allow local Windows packaging without Windows SDK signtool.exe
const gulpVscodePath = path.join(root, 'vscode', 'build', 'gulpfile.vscode.ts');
if (fs.existsSync(gulpVscodePath)) {
	let gulpVscode = fs.readFileSync(gulpVscodePath, 'utf8');
	const oldSign = `function hasAuthenticodeSignature(filePath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);
		proc.on('error', reject);
		proc.on('exit', code => resolve(code === 0));
	});
}`;
	const newSign = `function hasAuthenticodeSignature(filePath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);
		proc.on('error', (err: NodeJS.ErrnoException) => {
			// Local builds often lack the Windows SDK signtool on PATH.
			if (err && err.code === 'ENOENT') {
				resolve(false);
				return;
			}
			reject(err);
		});
		proc.on('exit', code => resolve(code === 0));
	});
}`;
	if (gulpVscode.includes('if (err && err.code === \'ENOENT\')')) {
		console.log('signtool ENOENT patch already applied');
	} else if (gulpVscode.includes(oldSign)) {
		gulpVscode = gulpVscode.replace(oldSign, newSign);
		fs.writeFileSync(gulpVscodePath, gulpVscode, 'utf8');
		console.log('Patched gulpfile.vscode.ts to tolerate missing signtool.exe');
	} else {
		console.warn('Could not patch signtool handling — upstream may have changed');
	}
}

// Hide built-in Chat (Auxiliary Bar) — CodeForge ships codeforge ("AI") instead.
const chatParticipantPath = path.join(
	root,
	'vscode',
	'src',
	'vs',
	'workbench',
	'contrib',
	'chat',
	'browser',
	'chatParticipant.contribution.ts'
);
if (fs.existsSync(chatParticipantPath)) {
	let chatSrc = fs.readFileSync(chatParticipantPath, 'utf8');
	const containerMarker = 'CodeForge: do not register Chat view container';
	const strongMarker = 'CodeForge: do not register the built-in Chat view';
	const marker = 'CodeForge: hide built-in Chat';

	if (!chatSrc.includes(containerMarker)) {
		const containerOld = `const chatViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: ChatViewContainerId,
	title: localize2('chat.viewContainer.label', "Chat"),
	icon: chatViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ChatViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: ChatViewContainerId,
	hideIfEmpty: true,
	order: 1,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: false, doNotRegisterOpenCommand: true });`;
		const containerOldDefault = containerOld.replace(
			'{ isDefault: false, doNotRegisterOpenCommand: true }',
			'{ isDefault: true, doNotRegisterOpenCommand: true }'
		);
		const containerNew = `// CodeForge: do not register Chat view container in Auxiliary Bar (codeforge ships "AI").
const chatViewContainer = {
	id: ChatViewContainerId,
	title: localize2('chat.viewContainer.label', "Chat"),
	icon: chatViewIcon,
} as ViewContainer;
// Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
// 	id: ChatViewContainerId,
// 	title: localize2('chat.viewContainer.label', "Chat"),
// 	icon: chatViewIcon,
// 	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ChatViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
// 	storageId: ChatViewContainerId,
// 	hideIfEmpty: true,
// 	order: 1,
// }, ViewContainerLocation.AuxiliaryBar, { isDefault: false, doNotRegisterOpenCommand: true });`;
		if (chatSrc.includes(containerOld)) {
			chatSrc = chatSrc.replace(containerOld, containerNew);
			fs.writeFileSync(chatParticipantPath, chatSrc, 'utf8');
			console.log('Patched chatParticipant: skipped registerViewContainer');
		} else if (chatSrc.includes(containerOldDefault)) {
			chatSrc = chatSrc.replace(containerOldDefault, containerNew);
			fs.writeFileSync(chatParticipantPath, chatSrc, 'utf8');
			console.log('Patched chatParticipant: skipped registerViewContainer (was default)');
		} else {
			console.warn('Could not find Chat registerViewContainer block to patch — upstream may have changed');
		}
		chatSrc = fs.readFileSync(chatParticipantPath, 'utf8');
	} else {
		console.log('Chat registerViewContainer hide already applied');
	}

	if (chatSrc.includes(strongMarker)) {
		console.log('Built-in Chat view hide patch already applied');
	} else if (chatSrc.includes(marker) && chatSrc.includes('registerViews([chatViewDescriptor], chatViewContainer)')) {
		chatSrc = chatSrc.replace(
			'Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], chatViewContainer);',
			`// CodeForge: do not register the built-in Chat view into the Auxiliary Bar.
// Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], chatViewContainer);`
		);
		fs.writeFileSync(chatParticipantPath, chatSrc, 'utf8');
		console.log('Strengthened Chat hide: skipped registerViews');
	} else if (chatSrc.includes(marker)) {
		console.log('Built-in Chat hide patch already applied');
	} else {
		const oldBlock = `}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

const chatViewDescriptor: IViewDescriptor = {
	id: ChatViewId,
	containerIcon: chatViewContainer.icon,
	containerTitle: chatViewContainer.title.value,
	singleViewPaneContainerTitle: chatViewContainer.title.value,
	name: localize2('chat.viewContainer.label', "Chat"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: ChatViewContainerId,
		title: chatViewContainer.title,
		mnemonicTitle: localize({ key: 'miToggleChat', comment: ['&& denotes a mnemonic'] }, "&&Chat"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
			mac: {
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI
			}
		},
		order: 1
	},
	ctorDescriptor: new SyncDescriptor(ChatViewPane),
	when: ContextKeyExpr.and(
		ChatContextKeys.accountPolicyGateActive.negate(),
		ContextKeyExpr.or(
			ContextKeyExpr.and(
				ChatContextKeys.Setup.hidden.negate(),
				ChatContextKeys.Setup.disabledInWorkspace.negate(),
			),
			ChatContextKeys.panelParticipantRegistered,
			ChatContextKeys.extensionInvalid
		)
	)
};
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], chatViewContainer);`;
		const newBlock = `}, ViewContainerLocation.AuxiliaryBar, { isDefault: false, doNotRegisterOpenCommand: true });

const chatViewDescriptor: IViewDescriptor = {
	id: ChatViewId,
	containerIcon: chatViewContainer.icon,
	containerTitle: chatViewContainer.title.value,
	singleViewPaneContainerTitle: chatViewContainer.title.value,
	name: localize2('chat.viewContainer.label', "Chat"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: ChatViewContainerId,
		title: chatViewContainer.title,
		mnemonicTitle: localize({ key: 'miToggleChat', comment: ['&& denotes a mnemonic'] }, "&&Chat"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
			mac: {
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI
			}
		},
		order: 1
	},
	ctorDescriptor: new SyncDescriptor(ChatViewPane),
	// CodeForge: hide built-in Chat; we ship codeforge ("AI") instead.
	when: ContextKeyExpr.false(),
};
// CodeForge: do not register the built-in Chat view into the Auxiliary Bar.
// Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], chatViewContainer);`;
		if (!chatSrc.includes(oldBlock)) {
			console.warn('Could not find Chat view registration block to patch — upstream may have changed');
		} else {
			chatSrc = chatSrc.replace(oldBlock, newBlock);
			fs.writeFileSync(chatParticipantPath, chatSrc, 'utf8');
			console.log('Patched chatParticipant.contribution.ts to hide built-in Chat');
		}
	}
}

// CodeForge: top-level Settings TOC entry "AI" (between Chat and Features).
const settingsLayoutPath = path.join(
	root,
	'vscode',
	'src',
	'vs',
	'workbench',
	'contrib',
	'preferences',
	'browser',
	'settingsLayout.ts'
);
if (fs.existsSync(settingsLayoutPath)) {
	let layoutSrc = fs.readFileSync(settingsLayoutPath, 'utf8');
	const aiTocUnifiedMarker = "id: 'ai/models'";
	const featuresAnchor = `\t\t{
			id: 'features',
			label: localize('features', "Features"),`;
	const aiNode = `\t\t{
			id: 'ai',
			label: localize('ai', "AI"),
			children: [
				{
					id: 'ai/models',
					label: localize('aiModels', "Models"),
					settings: ['codeforge.ai.openModels']
				},
				{
					id: 'ai/mcp',
					label: localize('aiMcp', "MCP"),
					settings: ['codeforge.ai.openMcp']
				},
				{
					id: 'ai/guardrails',
					label: localize('aiGuardrails', "Guardrails"),
					settings: ['codeforge.ai.openGuardrails']
				},
				{
					id: 'ai/agent',
					label: localize('aiAgent', "Agent"),
					settings: [
						'codeforge.ai.enabled',
						'codeforge.ai.mode',
						'codeforge.ai.weakModelMode',
						'codeforge.ai.agent*',
						'codeforge.ai.collapse*',
						'codeforge.ai.traceLevel',
						'codeforge.ai.autoApprove*',
						'codeforge.ai.previewEdits',
						'codeforge.ai.contextBudget',
						'codeforge.ai.tabCompletion'
					]
				}
			]
		},
`;

	if (layoutSrc.includes(aiTocUnifiedMarker) && layoutSrc.includes("localize('ai', \"AI\")")) {
		console.log('AI Settings TOC (Models/MCP/Guardrails/Agent) already present in settingsLayout.ts');
	} else {
		const aiStart = layoutSrc.indexOf("\t\t{\n\t\t\tid: 'ai',");
		const featuresStart = layoutSrc.indexOf(featuresAnchor);
		if (aiStart >= 0 && featuresStart > aiStart) {
			layoutSrc = layoutSrc.slice(0, aiStart) + aiNode + layoutSrc.slice(featuresStart);
			fs.writeFileSync(settingsLayoutPath, layoutSrc, 'utf8');
			console.log('Patched settingsLayout.ts: unified AI TOC with CodeForge Settings sections');
		} else if (featuresStart >= 0) {
			layoutSrc = layoutSrc.replace(featuresAnchor, aiNode + featuresAnchor);
			fs.writeFileSync(settingsLayoutPath, layoutSrc, 'utf8');
			console.log('Patched settingsLayout.ts: inserted AI TOC between Chat and Features');
		} else {
			console.warn('Could not find Features TOC anchor in settingsLayout.ts — upstream may have changed');
		}
	}
}

// CodeForge: promote extension settings into top-level AI TOC (core resolve drops empty AI node).
const settingsEditor2Path = path.join(
	root,
	'vscode',
	'src',
	'vs',
	'workbench',
	'contrib',
	'preferences',
	'browser',
	'settingsEditor2.ts'
);
if (fs.existsSync(settingsEditor2Path)) {
	let editorSrc = fs.readFileSync(settingsEditor2Path, 'utf8');
	const promoteMarker = 'CodeForge: extension settings are not matched by core tocData resolve';
	if (editorSrc.includes(promoteMarker)) {
		console.log('AI TOC promote patch already present in settingsEditor2.ts');
	} else {
		const promoteOld = `		resolvedSettingsRoot.children!.push(await createTocTreeForExtensionSettings(this.extensionService, extensionSettingsGroups, filter));

		resolvedSettingsRoot.children!.unshift(getCommonlyUsedData(groups));`;
		const promoteNew = `		// CodeForge: extension settings are not matched by core tocData resolve, so the AI node
		// would disappear. Promote kortexio.codeforge into the top-level AI TOC (between Chat and Features).
		const codeforgeExtId = 'kortexio.codeforge';
		const codeforgeSettingsGroups = extensionSettingsGroups.filter(g => g.extensionInfo?.id.toLowerCase() === codeforgeExtId);
		const otherExtensionSettingsGroups = extensionSettingsGroups.filter(g => g.extensionInfo?.id.toLowerCase() !== codeforgeExtId);
		const aiTocTemplate = tocData.children?.find(child => child.id === 'ai');
		if (aiTocTemplate && codeforgeSettingsGroups.length) {
			const aiTree = resolveSettingsTree(aiTocTemplate, codeforgeSettingsGroups, filter, this.logService).tree;
			const featuresIdx = resolvedSettingsRoot.children!.findIndex(child => child.id === 'features');
			if (featuresIdx >= 0) {
				resolvedSettingsRoot.children!.splice(featuresIdx, 0, aiTree);
			} else {
				resolvedSettingsRoot.children!.push(aiTree);
			}
		}

		resolvedSettingsRoot.children!.push(await createTocTreeForExtensionSettings(this.extensionService, otherExtensionSettingsGroups, filter));

		resolvedSettingsRoot.children!.unshift(getCommonlyUsedData(groups));`;
		if (editorSrc.includes(promoteOld)) {
			editorSrc = editorSrc.replace(promoteOld, promoteNew);
			fs.writeFileSync(settingsEditor2Path, editorSrc, 'utf8');
			console.log('Patched settingsEditor2.ts: promote CodeForge settings into AI TOC');
		} else {
			console.warn('Could not find settingsEditor2 extension TOC push — upstream may have changed');
		}
	}
}

// CodeForge does not ship built-in Copilot — skip the ripgrep shim when the SDK is absent.
const gulpVscodeWinPath = path.join(root, 'vscode', 'build', 'gulpfile.vscode.ts');
if (fs.existsSync(gulpVscodeWinPath)) {
	let gulpSrc = fs.readFileSync(gulpVscodeWinPath, 'utf8');
	const shimCall =
		'prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);';
	const shimGuard = `if (!fs.existsSync(path.join(builtInCopilotExtensionDir, 'node_modules', '@github', 'copilot', 'sdk'))) {
			console.warn('[prepareCopilotRipgrepShimTask] Skipping Copilot ripgrep shim (SDK not present).');
			return;
		}
		${shimCall}`;
	if (gulpSrc.includes("Skipping Copilot ripgrep shim")) {
		console.log('Copilot ripgrep shim skip already present');
	} else if (gulpSrc.includes(shimCall)) {
		gulpSrc = gulpSrc.replace(shimCall, shimGuard);
		fs.writeFileSync(gulpVscodeWinPath, gulpSrc, 'utf8');
		console.log('Patched gulpfile.vscode.ts to skip Copilot ripgrep shim when SDK is missing');
	} else {
		console.warn('Could not find Copilot ripgrep shim call in gulpfile.vscode.ts');
	}
}

// Skip compiling the built-in Copilot extension: CodeForge strips it after package,
// and its postinstall deletes shims.txt which then breaks packageCopilotExtensionStream.
// Upstream shapes vary (single arrow vs task.series + rimraf) — replace the whole export.
if (fs.existsSync(gulpExtensionsPath)) {
	let extGulp = fs.readFileSync(gulpExtensionsPath, 'utf8');
	const skipMarker = '[CodeForge] Skipping built-in Copilot extension compile';
	const skipTask =
		`export const compileCopilotExtensionBuildTask = task.define('compile-copilot-extension-build', (cb) => {\n` +
		`\tconsole.warn('${skipMarker} (not shipped).');\n` +
		`\tcb();\n` +
		`});`;
	if (extGulp.includes(skipMarker)) {
		console.log('Copilot extension compile skip already present');
	} else {
		const exportRe =
			/export const compileCopilotExtensionBuildTask = task\.define\(\s*['"]compile-copilot-extension-build['"][\s\S]*?\);/;
		if (exportRe.test(extGulp)) {
			extGulp = extGulp.replace(exportRe, skipTask);
			fs.writeFileSync(gulpExtensionsPath, extGulp, 'utf8');
			console.log('Patched gulpfile.extensions.ts to skip Copilot extension compile');
		} else {
			console.warn('Could not find compileCopilotExtensionBuildTask definition to skip');
		}
	}
}

// CodeForge: the Agents window must not demand GitHub / Google / Apple / GHE sign-in.
const sessionsSetUpPath = path.join(
	root,
	'vscode',
	'src',
	'vs',
	'sessions',
	'browser',
	'sessionsSetUpService.ts'
);
/** Reads a source file with LF line endings; `write` restores the file's original endings. */
function readNormalized(file) {
	const raw = fs.readFileSync(file, 'utf8');
	const crlf = raw.includes('\r\n');
	return {
		src: crlf ? raw.replace(/\r\n/g, '\n') : raw,
		write: (next) => fs.writeFileSync(file, crlf ? next.replace(/\n/g, '\r\n') : next, 'utf8'),
	};
}

if (fs.existsSync(sessionsSetUpPath)) {
	const setupFile = readNormalized(sessionsSetUpPath);
	let setupSrc = setupFile.src;
	// _start opens the window; every later sign-in path (_reevaluateSignedOut,
	// _watchSignInState, ...) ends in _showWelcome. _proceedWithoutGitHub also calls
	// _ensureAIFeaturesEnabled, which must not re-enable Copilot. The flag is typed
	// `boolean` so the original bodies stay reachable for the compiler.
	const setupMarker = 'CODEFORGE_SKIP_VENDOR_SIGN_IN';
	if (setupSrc.includes(setupMarker)) {
		console.log('Agents window vendor sign-in skip already applied');
	} else {
		const configAnchor = `const AIDisabledConfig = 'chat.disableAIFeatures';\n`;
		const startHead = '\tprivate _start(): void {\n';
		const welcomeHead = '\tprivate async _showWelcome(isFirstLaunch: boolean): Promise<void> {\n';
		const ensureHead = '\tprivate async _ensureAIFeaturesEnabled(): Promise<void> {\n';
		if (![configAnchor, startHead, welcomeHead, ensureHead].every(anchor => setupSrc.includes(anchor))) {
			console.warn('Could not find SessionsSetUpWidget sign-in anchors — upstream may have changed');
		} else {
			const skip = `		if (${setupMarker}) {
			this.logService.info('[sessions welcome] Skipping vendor sign-in');
			this.dialogRef.clear();
			this.onCompleted();
			return;
		}
`;
			setupSrc = setupSrc.replace(configAnchor, `${configAnchor}
// CodeForge: the Agents window never signs in with GitHub, Google, Apple, or GHE,
// and never turns chat.disableAIFeatures back on.
const ${setupMarker}: boolean = true;
`);
			setupSrc = setupSrc.replace(startHead, `${startHead}${skip}`);
			setupSrc = setupSrc.replace(welcomeHead, `${welcomeHead}${skip}`);
			setupSrc = setupSrc.replace(ensureHead, `${ensureHead}		if (${setupMarker}) {
			return;
		}
`);
			setupFile.write(setupSrc);
			console.log('Patched sessionsSetUpService.ts to skip vendor sign-in');
		}
	}
}

// CodeForge: the Agents window runs on the CodeForge harness. Copy the CodeForge
// sessions provider overlay, register it in place of the Copilot and Agent Host
// providers, and point Customize at the CodeForge settings.
const overlayRoot = path.join(root, 'resources', 'vscode-overlay');
function copyOverlay(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const from = path.join(dir, entry.name);
		const to = path.join(root, 'vscode', path.relative(overlayRoot, from));
		if (entry.isDirectory()) {
			copyOverlay(from);
			continue;
		}
		const next = fs.readFileSync(from);
		if (fs.existsSync(to) && fs.readFileSync(to).equals(next)) {
			continue;
		}
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.writeFileSync(to, next);
		console.log(`Copied overlay ${path.relative(root, to)}`);
	}
}
if (fs.existsSync(overlayRoot)) {
	copyOverlay(overlayRoot);
}

function patchFile(relPath, label, edits) {
	const file = path.join(root, 'vscode', ...relPath.split('/'));
	if (!fs.existsSync(file)) {
		console.warn(`${label}: ${relPath} not found`);
		return;
	}
	const normalized = readNormalized(file);
	let src = normalized.src;
	let changed = false;
	for (const { from, to } of edits) {
		if (src.includes(to)) {
			continue;
		}
		if (!src.includes(from)) {
			console.warn(`${label}: anchor not found in ${relPath} — upstream may have changed: ${from.trim()}`);
			continue;
		}
		src = src.replace(from, to);
		changed = true;
	}
	if (changed) {
		normalized.write(src);
		console.log(`${label}: patched ${relPath}`);
	} else {
		console.log(`${label}: already applied`);
	}
}

const disabledImport = (line) => `// CodeForge: provider disabled in the Agents window.\n// ${line}`;

patchFile('src/vs/sessions/sessions.common.main.ts', 'Agents window providers', [
	{
		from: `import './contrib/providers/copilotChatSessions/browser/copilotChatSessions.contribution.js';`,
		to: `${disabledImport(`import './contrib/providers/copilotChatSessions/browser/copilotChatSessions.contribution.js';`)}\nimport './contrib/providers/codeforge/browser/codeforgeSessions.contribution.js';`,
	},
]);

patchFile('src/vs/sessions/sessions.desktop.main.ts', 'Agents window providers (desktop)', [
	`import './contrib/providers/remoteAgentHost/browser/cloudSandboxAgentHost.contribution.js';`,
	`import './contrib/providers/agentHost/browser/localAgentHost.contribution.js';`,
	`import './contrib/providers/agentHost/electron-browser/localAgentHostLifecycle.contribution.js';`,
].map(line => ({ from: `${line}\n`, to: `${disabledImport(line)}\n` })));

patchFile('src/vs/sessions/sessions.web.main.ts', 'Agents window providers (web)', [
	`import './contrib/providers/remoteAgentHost/browser/cloudSandboxAgentHost.contribution.js';`,
].map(line => ({ from: `${line}\n`, to: `${disabledImport(line)}\n` })));

// Models come from CodeForge servers, so the picker never asks for a Copilot sign-in.
patchFile('src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts', 'Model picker sign-in', [
	{
		from: `\tprivate _requiresSetup(): boolean {\n`,
		to: `\tprivate _requiresSetup(): boolean {\n\t\tif (CODEFORGE_MODELS_WITHOUT_SIGN_IN) {\n\t\t\treturn false;\n\t\t}\n`,
	},
	{
		from: `export class ModelPickerWidget`,
		to: `// CodeForge: models come from CodeForge servers; Copilot sign-in is never required.\nconst CODEFORGE_MODELS_WITHOUT_SIGN_IN: boolean = true;\n\nexport class ModelPickerWidget`,
	},
]);

// CodeForge sessions contribute their own mode and permission chips to the chat input
// (`codeforgeSessions.contribution.ts`). `sessionProviderId` is the Agents window key;
// workbench code cannot import it from vs/sessions.
const NOT_CODEFORGE_SESSION = `ContextKeyExpr.notEquals('sessionProviderId', 'codeforge'),`;
patchFile('src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts', 'Chat input pickers for CodeForge sessions', [
	{
		from: `\t\t\t\t\t\t// Hide the agent picker while a delegation (continue in) target is pending\n\t\t\t\t\t\tChatContextKeys.hasPendingDelegationTarget.negate(),\n`,
		to: `\t\t\t\t\t\t// Hide the agent picker while a delegation (continue in) target is pending\n\t\t\t\t\t\tChatContextKeys.hasPendingDelegationTarget.negate(),\n\t\t\t\t\t\t${NOT_CODEFORGE_SESSION}\n`,
	},
	{
		from: `\t\t\t\t\t\tChatContextKeys.chatModeKind.notEqualsTo(ChatModeKind.Ask),\n\t\t\t\t\t\tChatContextKeys.inQuickChat.negate(),\n`,
		to: `\t\t\t\t\t\tChatContextKeys.chatModeKind.notEqualsTo(ChatModeKind.Ask),\n\t\t\t\t\t\tChatContextKeys.inQuickChat.negate(),\n\t\t\t\t\t\t${NOT_CODEFORGE_SESSION}\n`,
	},
]);

patchFile('src/vs/sessions/contrib/chat/browser/newChatWidget.ts', 'Agents window Customize', [
	{
		from: `import { OPEN_CUSTOMIZATIONS_COMMAND_ID } from '../../../common/customizations.js';\n`,
		to: `// CodeForge: Customize opens codeforge.openSettings, not the customization overview.\n`,
	},
	{
		from: `const run = () => this.commandService.executeCommand(OPEN_CUSTOMIZATIONS_COMMAND_ID).catch(onUnexpectedError);`,
		to: `// CodeForge: Customize opens the CodeForge settings (servers, models, guardrails, agent).
		const run = () => this.commandService.executeCommand('codeforge.openSettings').catch(onUnexpectedError);`,
	},
	{
		from: `content: localize('newSessionCustomizeTooltip', "Open customization overview"),`,
		to: `content: localize('newSessionCustomizeTooltip', "Open CodeForge settings"),`,
	},
]);

// Manage Models, the account Settings entry, and Agent Customizations open CodeForge settings.
patchFile('src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItems.ts', 'Model picker opens CodeForge settings', [
	{
		from: `export function shouldShowManageModelsAction(chatEntitlementService: IChatEntitlementService): boolean {\n\treturn chatEntitlementService.clientByokEnabled ||`,
		to: `// CodeForge: the gear always opens CodeForge settings, for every entitlement.\nconst CODEFORGE_MANAGE_MODELS_OPENS_SETTINGS: boolean = true;\n\nexport function shouldShowManageModelsAction(chatEntitlementService: IChatEntitlementService): boolean {\n\tif (CODEFORGE_MANAGE_MODELS_OPENS_SETTINGS) {\n\t\treturn true;\n\t}\n\treturn chatEntitlementService.clientByokEnabled ||`,
	},
	{
		from: `\t\trun: () => { commandService.executeCommand(MANAGE_CHAT_COMMAND_ID); },`,
		to: `\t\trun: () => {\n\t\t\tif (CODEFORGE_MANAGE_MODELS_OPENS_SETTINGS) {\n\t\t\t\tcommandService.executeCommand('codeforge.openSettings', 'models');\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tcommandService.executeCommand(MANAGE_CHAT_COMMAND_ID);\n\t\t},`,
	},
]);

patchFile('src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts', 'Account settings opens CodeForge settings', [
	{
		from: `\t\tid: 'workbench.action.openSettings',\n\t\ttitle: localize('settings', "Settings"),`,
		to: `\t\tid: 'codeforge.openSettings',\n\t\ttitle: localize('settings', "Settings"),`,
	},
	{
		from: `// Actions registered at module level so Menus.TitleBarRightLayout is non-empty when the\n// toolbar is first constructed. The run() is a no-op — rendering is handled by the custom\n// view items registered in AccountWidgetContribution.\nregisterAction2(class extends Action2 {`,
		to: `// CodeForge: the titlebar account widget only hosts Copilot and Codex sign-in.\nconst CODEFORGE_HIDE_VENDOR_ACCOUNT: boolean = true;\n// Actions registered at module level so Menus.TitleBarRightLayout is non-empty when the\n// toolbar is first constructed. The run() is a no-op — rendering is handled by the custom\n// view items registered in AccountWidgetContribution.\nif (!CODEFORGE_HIDE_VENDOR_ACCOUNT) {\nregisterAction2(class extends Action2 {`,
	},
	{
		from: `\trun(): void { }\n});\n\nclass AccountWidgetContribution`,
		to: `\trun(): void { }\n});\n}\n\nclass AccountWidgetContribution`,
	},
]);

patchFile('src/vs/sessions/browser/parts/mobile/mobileTitlebarPart.ts', 'Mobile settings icon', [
	{
		from: `\t\t\tcase 'workbench.action.openSettings': return Codicon.settingsGear;`,
		to: `\t\t\tcase 'workbench.action.openSettings':\n\t\t\tcase 'codeforge.openSettings': return Codicon.settingsGear;`,
	},
]);

patchFile('src/vs/sessions/contrib/sessions/browser/customizationsToolbar.contribution.ts', 'Customizations open CodeForge settings', [
	{
		from: `import { OPEN_CUSTOMIZATIONS_COMMAND_ID } from '../../../common/customizations.js';\n`,
		to: `import { OPEN_CUSTOMIZATIONS_COMMAND_ID } from '../../../common/customizations.js';\nimport { ICommandService } from '../../../../platform/commands/common/commands.js';\n\n// CodeForge: customization entry points open CodeForge settings, not the VS Code editor.\nconst CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS: boolean = true;\n`,
	},
	{
		from: `\tprivate _readCount(reader: Parameters<Parameters<typeof autorun>[0]>[0]): number {\n\t\tif (this._config.modelSection) {`,
		to: `\tprivate _readCount(reader: Parameters<Parameters<typeof autorun>[0]>[0]): number {\n\t\tif (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS) {\n\t\t\treturn 0;\n\t\t}\n\t\tif (this._config.modelSection) {`,
	},
	{
		from: `\t\t\tasync run(accessor: ServicesAccessor, session?: IActiveSession): Promise<void> {\n\t\t\t\tawait openCustomizationOverviewPage(`,
		to: `\t\t\tasync run(accessor: ServicesAccessor, session?: IActiveSession): Promise<void> {\n\t\t\t\tif (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS) {\n\t\t\t\t\tawait accessor.get(ICommandService).executeCommand('codeforge.openSettings');\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tawait openCustomizationOverviewPage(`,
	},
	{
		from: `\t\tfor (const [index, config] of CUSTOMIZATION_ITEMS.entries()) {\n\t\t\tif (!config.section) {\n\t\t\t\tcontinue;\n\t\t\t}`,
		to: `\t\tfor (const [index, config] of CUSTOMIZATION_ITEMS.entries()) {\n\t\t\tif (!config.section || (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS && config.id === 'sessions.customization.harnessSettings')) {\n\t\t\t\tcontinue;\n\t\t\t}`,
	},
	{
		from: `\t\t\t\tasync run(accessor: ServicesAccessor): Promise<void> {\n\t\t\t\t\tconst editorService = accessor.get(IEditorService);\n\t\t\t\t\tconst harnessService = accessor.get(ICustomizationHarnessService);\n\t\t\t\t\tconst sessionsService = accessor.get(ISessionsService);\n\t\t\t\t\tawait openCustomizationSectionPage(editorService, harnessService, sessionsService, section);`,
		to: `\t\t\t\tasync run(accessor: ServicesAccessor): Promise<void> {\n\t\t\t\t\tif (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS) {\n\t\t\t\t\t\tconst tab = section === AICustomizationManagementSection.McpServers ? 'mcp'\n\t\t\t\t\t\t\t: section === AICustomizationManagementSection.Plugins ? 'plugins'\n\t\t\t\t\t\t\t: section === AICustomizationManagementSection.Tools ? 'agent'\n\t\t\t\t\t\t\t: 'guardrails';\n\t\t\t\t\t\tawait accessor.get(ICommandService).executeCommand('codeforge.openSettings', tab);\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}\n\t\t\t\t\tconst editorService = accessor.get(IEditorService);\n\t\t\t\t\tconst harnessService = accessor.get(ICustomizationHarnessService);\n\t\t\t\t\tconst sessionsService = accessor.get(ISessionsService);\n\t\t\t\t\tawait openCustomizationSectionPage(editorService, harnessService, sessionsService, section);`,
	},
]);

patchFile('src/vs/sessions/contrib/aiCustomizationTreeView/browser/aiCustomizationTreeView.contribution.ts', 'Open Customizations command', [
	{
		from: `import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';\n`,
		to: `import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';\n\n// CodeForge: Open Chat Customizations opens CodeForge settings.\nconst CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS: boolean = true;\n`,
	},
	{
		from: `\tasync run(accessor: ServicesAccessor): Promise<void> {\n\t\tif (accessor.get(IConfigurationService).getValue<boolean>(ChatConfiguration.CustomizationEntryPoints)) {`,
		to: `\tasync run(accessor: ServicesAccessor): Promise<void> {\n\t\tif (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS) {\n\t\t\tawait accessor.get(ICommandService).executeCommand('codeforge.openSettings');\n\t\t\treturn;\n\t\t}\n\t\tif (accessor.get(IConfigurationService).getValue<boolean>(ChatConfiguration.CustomizationEntryPoints)) {`,
	},
]);

patchFile('src/vs/sessions/contrib/chat/browser/sessionCustomizations.ts', 'Session customization pills', [
	{
		from: `import type { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';\n`,
		to: `import type { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';\n\n// CodeForge: session customization pills open CodeForge settings.\nconst CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS: boolean = true;\n`,
	},
	{
		from: `\tprivate _reveal(customization: ISessionChatCustomization): void {\n\t\tvoid this._commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {`,
		to: `\tprivate _reveal(customization: ISessionChatCustomization): void {\n\t\tif (CODEFORGE_CUSTOMIZATIONS_OPEN_SETTINGS) {\n\t\t\tvoid this._commandService.executeCommand('codeforge.openSettings', 'guardrails');\n\t\t\treturn;\n\t\t}\n\t\tvoid this._commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {`,
	},
]);

// The Agents window lists CodeForge participant commands, not the VS Code slash commands or built-in skills.
patchFile('src/vs/workbench/contrib/chat/browser/chatSlashCommands.ts', 'Sessions window skips built-in slash commands', [
	{
		from: `export class ChatSlashCommandsContribution extends Disposable {\n`,
		to: `// CodeForge: the Agents window uses the CodeForge participant's slash commands.\nconst CODEFORGE_SESSIONS_SKIP_BUILTIN_SLASH: boolean = true;\n\nexport class ChatSlashCommandsContribution extends Disposable {\n`,
	},
	{
		from: `\t\tsuper();\n\n\t\tthis._store.add(slashCommandService.registerSlashCommand({\n\t\t\tcommand: 'vscode-pet',`,
		to: `\t\tsuper();\n\n\t\tif (CODEFORGE_SESSIONS_SKIP_BUILTIN_SLASH && this.environmentService.isSessionsWindow) {\n\t\t\treturn;\n\t\t}\n\n\t\tthis._store.add(slashCommandService.registerSlashCommand({\n\t\t\tcommand: 'vscode-pet',`,
	},
]);

patchFile('src/vs/sessions/contrib/chat/browser/btwSlashCommand.contribution.ts', 'Sessions window skips /btw', [
	{
		from: `\t\tif (!environmentService.isSessionsWindow) {\n\t\t\treturn;\n\t\t}\n\n\t\tthis._register(slashCommandService.registerSlashCommand({\n\t\t\tcommand: 'btw',`,
		to: `\t\t// CodeForge: /btw is a VS Code side chat, not a CodeForge command.\n\t\tconst CODEFORGE_SESSIONS_SKIP_BUILTIN_SLASH: boolean = true;\n\t\tif (!environmentService.isSessionsWindow || CODEFORGE_SESSIONS_SKIP_BUILTIN_SLASH) {\n\t\t\treturn;\n\t\t}\n\n\t\tthis._register(slashCommandService.registerSlashCommand({\n\t\t\tcommand: 'btw',`,
	},
]);

patchFile('src/vs/sessions/contrib/chat/browser/slashCommands.ts', 'New session slash commands from CodeForge', [
	{
		from: `import { IChatPetService } from '../../../../workbench/contrib/chat/browser/chatPetService.js';\n`,
		to: `import { IChatPetService } from '../../../../workbench/contrib/chat/browser/chatPetService.js';\nimport { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';\nimport { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';\n\n// CodeForge: the new-session composer lists the default agent's commands (CodeForge).\nconst CODEFORGE_SESSIONS_USE_AGENT_SLASH: boolean = true;\n`,
	},
	{
		from: `\t\t@IChatPetService private readonly chatPetService: IChatPetService,\n\t\t@IChatSubmitRequestHandlerService submitRequestHandlerService: IChatSubmitRequestHandlerService,`,
		to: `\t\t@IChatPetService private readonly chatPetService: IChatPetService,\n\t\t@IChatAgentService private readonly chatAgentService: IChatAgentService,\n\t\t@IChatSubmitRequestHandlerService submitRequestHandlerService: IChatSubmitRequestHandlerService,`,
	},
	{
		from: `\tprivate _registerSlashCommands(): void {\n\t\tconst openSection = (section: AICustomizationManagementSection) =>`,
		to: `\tprivate _registerSlashCommands(): void {\n\t\tif (CODEFORGE_SESSIONS_USE_AGENT_SLASH) {\n\t\t\treturn;\n\t\t}\n\t\tconst openSection = (section: AICustomizationManagementSection) =>`,
	},
	{
		from: `\t\t\t\treturn {\n\t\t\t\t\tsuggestions: this._slashCommands.map((c, i): CompletionItem => {`,
		to: `\t\t\t\tconst commands = CODEFORGE_SESSIONS_USE_AGENT_SLASH\n\t\t\t\t\t? (this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat)?.slashCommands ?? []).map(c => ({ command: c.name, detail: c.description, sortText: undefined as string | undefined, executeImmediately: false as boolean | undefined }))\n\t\t\t\t\t: this._slashCommands;\n\t\t\t\treturn {\n\t\t\t\t\tsuggestions: commands.map((c, i): CompletionItem => {`,
	},
	{
		from: `\t\tconst commandName = match[1];\n\t\tconst slashCommand = this._slashCommands.find(c => c.command === commandName);\n\t\tconst promptCommand = this._cachedPromptCommands.find(c => c.name === commandName);\n\t\tif (!slashCommand && !promptCommand) {`,
		to: `\t\tconst commandName = match[1];\n\t\tconst slashCommand = this._slashCommands.find(c => c.command === commandName);\n\t\tconst agentCommand = CODEFORGE_SESSIONS_USE_AGENT_SLASH\n\t\t\t? this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat)?.slashCommands.find(c => c.name === commandName)\n\t\t\t: undefined;\n\t\tconst promptCommand = this._cachedPromptCommands.find(c => c.name === commandName);\n\t\tif (!slashCommand && !agentCommand && !promptCommand) {`,
	},
	{
		from: `\t\tconst detail = slashCommand?.detail ?? promptCommand?.argumentHint;`,
		to: `\t\tconst detail = slashCommand?.detail ?? agentCommand?.description ?? promptCommand?.argumentHint;`,
	},
]);

patchFile('src/vs/sessions/contrib/chat/browser/promptsService.ts', 'Sessions window skips built-in skills', [
	{
		from: `\tprotected override async getBuiltinPromptFiles(type: PromptsType, token: CancellationToken): Promise<readonly IBuiltinPromptPath[]> {\n\t\tif (type !== PromptsType.skill) {\n\t\t\treturn [];\n\t\t}\n\t\treturn this.getBuiltinSkillPaths();`,
		to: `\tprotected override async getBuiltinPromptFiles(type: PromptsType, token: CancellationToken): Promise<readonly IBuiltinPromptPath[]> {\n\t\t// CodeForge: bundled vs/sessions/skills are not CodeForge skills.\n\t\tconst CODEFORGE_SKIP_BUILTIN_SESSION_SKILLS: boolean = true;\n\t\tif (CODEFORGE_SKIP_BUILTIN_SESSION_SKILLS || type !== PromptsType.skill) {\n\t\t\treturn [];\n\t\t}\n\t\treturn this.getBuiltinSkillPaths();`,
	},
]);

// Agents window defaults that `disallowConfigurationDefault` would otherwise ignore.
patchFile('src/vs/sessions/services/configuration/browser/configurationService.ts', 'CodeForge Agents window settings', [
	{
		from: `import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';\n`,
		to: `import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';\nimport { codeforgeAgentsWindowSetting } from '../common/codeforgeAgentsWindowSettings.js';\n`,
	},
	{
		from: `\tprotected override getDefaultValue(_key: string, propertySchema: IRegisteredConfigurationPropertySchema): unknown {\n\t\tif (propertySchema.agentsWindow && propertySchema.defaultValueSource !== 'experiments') {\n\t\t\treturn deepClone(propertySchema.agentsWindow.default);\n\t\t}\n\t\treturn super.getDefaultValue(_key, propertySchema);\n\t}`,
		to: `\tprotected override getDefaultValue(_key: string, propertySchema: IRegisteredConfigurationPropertySchema): unknown {\n\t\tconst codeforge = codeforgeAgentsWindowSetting(_key);\n\t\tif (codeforge) {\n\t\t\treturn deepClone(codeforge.value);\n\t\t}\n\t\tif (propertySchema.agentsWindow && propertySchema.defaultValueSource !== 'experiments') {\n\t\t\treturn deepClone(propertySchema.agentsWindow.default);\n\t\t}\n\t\treturn super.getDefaultValue(_key, propertySchema);\n\t}`,
	},
	{
		from: `\t\tfor (const key in properties) {\n\t\t\tif (properties[key].agentsWindow?.readOnly) {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.add(key);\n\t\t\t}\n\t\t}`,
		to: `\t\tfor (const key in properties) {\n\t\t\tif (properties[key].agentsWindow?.readOnly || codeforgeAgentsWindowSetting(key)) {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.add(key);\n\t\t\t}\n\t\t}`,
	},
	{
		from: `\t\t\tif (properties[key]?.agentsWindow?.readOnly) {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.add(key);\n\t\t\t} else {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.delete(key);\n\t\t\t}`,
		to: `\t\t\tif (properties[key]?.agentsWindow?.readOnly || codeforgeAgentsWindowSetting(key)) {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.add(key);\n\t\t\t} else {\n\t\t\t\tthis.agentsWindowReadOnlyKeys.delete(key);\n\t\t\t}`,
	},
]);

// Git must not start Copilot Chat setup (commit message / merge conflicts / edit sessions).
const gitRepoPath = path.join(root, 'vscode', 'extensions', 'git', 'src', 'repository.ts');
if (fs.existsSync(gitRepoPath)) {
	let gitRepo = fs.readFileSync(gitRepoPath, 'utf8');
	if (gitRepo.includes('function builtinChatEnabled()')) {
		console.log('Git builtin-chat guard already present');
	} else {
		const helperAnchor = `import { GitQuickDiffProvider, StagedResourceQuickDiffProvider } from './quickDiffProvider';`;
		const helper = `${helperAnchor}

/** True only when the user explicitly turned the built-in Copilot chat back on. */
function builtinChatEnabled(): boolean {
	return workspace.getConfiguration('chat').get<boolean>('disableAIFeatures') === false;
}`;
		if (!gitRepo.includes(helperAnchor)) {
			console.warn('Could not find git repository.ts helper anchor');
		} else {
			gitRepo = gitRepo.replace(helperAnchor, helper);
			gitRepo = gitRepo.replaceAll(
				`commands.executeCommand('_chat.editSessions.accept', resources);`,
				`if (builtinChatEnabled()) {\n\t\t\t\t\tcommands.executeCommand('_chat.editSessions.accept', resources);\n\t\t\t\t}`
			);
			gitRepo = gitRepo.replaceAll(
				`commands.executeCommand('_aiEdits.clearAiContributions', uris);`,
				`if (builtinChatEnabled()) {\n\t\t\t\t\tcommands.executeCommand('_aiEdits.clearAiContributions', uris);\n\t\t\t\t}`
			);
			gitRepo = gitRepo.replaceAll(
				`commands.executeCommand('_aiEdits.clearAiContributions', resources);`,
				`if (builtinChatEnabled()) {\n\t\t\t\t\tcommands.executeCommand('_aiEdits.clearAiContributions', resources);\n\t\t\t\t}`
			);
			fs.writeFileSync(gitRepoPath, gitRepo, 'utf8');
			console.log('Patched git repository.ts to skip the built-in chat');
		}
	}
}
