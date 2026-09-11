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

if (source.includes(oldVersions)) {
	source = source.replace(oldVersions, newVersions);
	source = source.replace(
		'set vs2022_install=<path> (or vs2019_install for older versions)',
		'set vs2022_install=<path> (or vs2019_install / vs18_install / vs2026_install)'
	);
	fs.writeFileSync(preinstallPath, source, 'utf8');
	console.log('Patched vscode/build/npm/preinstall.ts to accept Visual Studio 2026 (18)');
} else if (source.includes(newVersions)) {
	console.log('VS toolchain patch already applied');
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
