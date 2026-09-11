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
