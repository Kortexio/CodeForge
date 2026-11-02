/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kortexio. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../../../base/browser/touch.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../base/common/actions.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { Menus } from '../../../../browser/menus.js';
import { SessionProviderIdContext } from '../../../../common/contextkeys.js';
import { ISessionContext } from '../../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import type { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { CODEFORGE_MODES, CODEFORGE_PERMISSIONS, CodeForgeMode, CodeForgePermission } from '../common/codeforgeHarness.js';
import { CODEFORGE_PROVIDER_ID, CodeForgeSessionsProvider, registerHarnessStateChangedCommand } from './codeforgeSessionsProvider.js';

const IsCodeForgeSession = ContextKeyExpr.equals(SessionProviderIdContext.key, CODEFORGE_PROVIDER_ID);
const IsCodeForgeChatInput = ContextKeyExpr.and(IsCodeForgeSession, IsSessionsWindowContext, ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat));
const MODE_PICKER_ID = 'sessions.codeforge.modePicker';
const PERMISSION_PICKER_ID = 'sessions.codeforge.permissionPicker';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: MODE_PICKER_ID,
			title: localize2('codeforgeModePicker', "CodeForge Mode"),
			f1: false,
			menu: [
				{ id: Menus.NewSessionConfig, group: 'navigation', order: 0, when: IsCodeForgeSession },
				{ id: MenuId.ChatInput, group: 'navigation', order: 1, when: IsCodeForgeChatInput },
			],
		});
	}
	override async run(): Promise<void> { /* rendered by the action view item */ }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PERMISSION_PICKER_ID,
			title: localize2('codeforgePermissionPicker', "CodeForge Permissions"),
			f1: false,
			menu: [
				{ id: Menus.NewSessionControl, group: 'navigation', order: 1, when: IsCodeForgeSession },
				{ id: MenuId.ChatInputSecondary, group: 'navigation', order: 1, when: IsCodeForgeChatInput },
			],
		});
	}
	override async run(): Promise<void> { /* rendered by the action view item */ }
});

interface IChipItem {
	readonly id: string;
}

interface IChipSpec {
	readonly widgetId: string;
	readonly ariaLabel: string;
	readonly trigger: () => { readonly icon: ThemeIcon; readonly label: string };
	readonly items: () => IActionListItem<IChipItem>[];
	readonly select: (id: string) => void;
}

/** A composer chip that opens an action list, styled like the native session pickers. */
class CodeForgeChip extends Disposable {

	private _trigger: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly _spec: IChipSpec,
		private readonly _changes: IObservable<unknown>,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
	) {
		super();
		this._register(autorun(reader => {
			this._changes.read(reader);
			this._updateLabel();
		}));
	}

	render(container: HTMLElement): void {
		this._renderDisposables.clear();
		const slot = dom.append(container, dom.$('.sessions-chat-picker-slot'));
		this._renderDisposables.add({ dispose: () => slot.remove() });
		const trigger = dom.append(slot, dom.$('a.action-label'));
		trigger.tabIndex = 0;
		trigger.role = 'button';
		this._trigger = trigger;
		this._updateLabel();

		this._renderDisposables.add(Gesture.addTarget(trigger));
		for (const eventType of [dom.EventType.CLICK, TouchEventType.Tap]) {
			this._renderDisposables.add(dom.addDisposableListener(trigger, eventType, e => {
				dom.EventHelper.stop(e, true);
				this._show();
			}));
		}
		this._renderDisposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this._show();
			}
		}));
	}

	private _show(): void {
		const trigger = this._trigger;
		if (!trigger || this.actionWidgetService.isVisible) {
			return;
		}
		const delegate: IActionListDelegate<IChipItem> = {
			onSelect: item => {
				this.actionWidgetService.hide();
				this._spec.select(item.id);
			},
			onHide: () => trigger.focus(),
		};
		this.actionWidgetService.show<IChipItem>(this._spec.widgetId, false, this._spec.items(), delegate, trigger, undefined, [], {
			getAriaLabel: item => item.label ?? '',
			getWidgetAriaLabel: () => this._spec.ariaLabel,
		});
	}

	private _updateLabel(): void {
		const trigger = this._trigger;
		if (!trigger) {
			return;
		}
		dom.clearNode(trigger);
		const { icon, label } = this._spec.trigger();
		dom.append(trigger, renderIcon(icon));
		dom.append(trigger, dom.$('span.sessions-chat-dropdown-label')).textContent = label;
		trigger.ariaLabel = `${this._spec.ariaLabel}, ${label}`;
	}
}

class ChipActionViewItem extends BaseActionViewItem {
	constructor(private readonly _chip: CodeForgeChip) {
		super(undefined, { id: '', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
	}

	override render(container: HTMLElement): void {
		container.classList.add('chat-input-picker-item');
		this._chip.render(container);
	}

	override dispose(): void {
		this._chip.dispose();
		super.dispose();
	}
}

function check(selected: boolean): ThemeIcon {
	return selected ? Codicon.check : Codicon.blank;
}

const MODE_ICONS: Record<CodeForgeMode, ThemeIcon> = { agent: Codicon.flame, plan: Codicon.checklist, ask: Codicon.comment };
const PERMISSION_ICONS: Record<CodeForgePermission, ThemeIcon> = { default: Codicon.shield, assisted: Codicon.eye, allowAll: Codicon.unlock };

class CodeForgeSessionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.codeforgeSessionsProvider';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();

		const provider = this._register(instantiationService.createInstance(CodeForgeSessionsProvider));
		this._register(sessionsProvidersService.registerProvider(provider));
		this._register(registerHarnessStateChangedCommand(() => provider));

		const sessionModeOf = (session: IActiveSession | undefined): CodeForgeMode | undefined => {
			const id = session?.mode.get()?.id;
			return id === 'ask' || id === 'plan' || id === 'agent' ? id : undefined;
		};

		const modeChip = (_action: IAction, _options: IActionViewItemOptions, scoped: IInstantiationService) => {
			const { session } = scoped.invokeFunction(accessor => accessor.get(ISessionContext));
			const currentMode = (): CodeForgeMode => sessionModeOf(session.get()) ?? provider.harness.get()?.mode ?? 'agent';
			const chip = scoped.createInstance(CodeForgeChip, {
				widgetId: 'codeforgeModePicker',
				ariaLabel: localize('codeforgeModePicker.aria', "CodeForge mode"),
				trigger: () => {
					const mode = currentMode();
					return { icon: MODE_ICONS[mode], label: CODEFORGE_MODES.find(m => m.id === mode)?.label ?? mode };
				},
				items: () => CODEFORGE_MODES.map(m => ({
					kind: ActionListItemKind.Action,
					label: m.label,
					description: m.description,
					group: { title: '', icon: check(m.id === currentMode()) },
					item: { id: m.id },
				})),
				select: id => {
					const active = session.get();
					if (active && (id === 'ask' || id === 'plan' || id === 'agent')) {
						provider.setMode(active.sessionId, id);
					}
				},
			}, derived(reader => {
				provider.harness.read(reader);
				return session.read(reader)?.mode.read(reader);
			}));
			return new ChipActionViewItem(chip);
		};

		const permissionChip = (_action: IAction, _options: IActionViewItemOptions, scoped: IInstantiationService) => {
			const { session } = scoped.invokeFunction(accessor => accessor.get(ISessionContext));
			const FULL_FREEDOM_ID = 'fullAgentFreedom';
			const chip = scoped.createInstance(CodeForgeChip, {
				widgetId: 'codeforgePermissionPicker',
				ariaLabel: localize('codeforgePermissionPicker.aria', "CodeForge permissions"),
				trigger: () => {
					const harness = provider.harness.get();
					if (!harness) {
						return { icon: Codicon.debugDisconnect, label: localize('codeforgeNotConnected', "CodeForge not connected") };
					}
					const level = CODEFORGE_PERMISSIONS.find(p => p.id === harness.permission);
					const label = harness.fullAgentFreedom
						? localize('codeforgePermissionWithFreedom', "{0} · Full agent freedom", level?.label ?? harness.permission)
						: level?.label ?? harness.permission;
					return { icon: PERMISSION_ICONS[harness.permission], label };
				},
				items: () => {
					const harness = provider.harness.get();
					const items: IActionListItem<IChipItem>[] = CODEFORGE_PERMISSIONS.map(p => ({
						kind: ActionListItemKind.Action,
						label: p.label,
						description: p.description,
						group: { title: '', icon: check(p.id === harness?.permission) },
						item: { id: p.id },
					}));
					items.push({ kind: ActionListItemKind.Separator, label: '' });
					items.push({
						kind: ActionListItemKind.Action,
						label: localize('codeforgeFullAgentFreedom', "Full agent freedom"),
						description: localize('codeforgeFullAgentFreedomDescription', "Run shell commands without the sandbox"),
						group: { title: '', icon: check(harness?.fullAgentFreedom === true) },
						item: { id: FULL_FREEDOM_ID },
					});
					return items;
				},
				select: id => {
					if (id === FULL_FREEDOM_ID) {
						provider.setFullAgentFreedom(provider.harness.get()?.fullAgentFreedom !== true).catch(onUnexpectedError);
						return;
					}
					const active = session.get();
					if (active && (id === 'default' || id === 'assisted' || id === 'allowAll')) {
						provider.setPermissionLevel(active.sessionId, id);
					}
				},
			}, provider.harness);
			return new ChipActionViewItem(chip);
		};

		this._register(actionViewItemService.register(Menus.NewSessionConfig, MODE_PICKER_ID, modeChip));
		this._register(actionViewItemService.register(MenuId.ChatInput, MODE_PICKER_ID, modeChip));
		this._register(actionViewItemService.register(Menus.NewSessionControl, PERMISSION_PICKER_ID, permissionChip));
		this._register(actionViewItemService.register(MenuId.ChatInputSecondary, PERMISSION_PICKER_ID, permissionChip));
	}
}

registerWorkbenchContribution2(CodeForgeSessionsContribution.ID, CodeForgeSessionsContribution, WorkbenchPhase.AfterRestored);
