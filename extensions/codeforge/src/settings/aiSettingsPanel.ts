/**
 * CodeForge AI Settings — Cursor-like editor panel
 *
 * Tabs: Models · MCP
 * - Models: manage servers (API / local), model lists, pick active model
 * - MCP: add/enable MCP servers
 *
 * Quick model switch while coding stays on QuickPick (separate command).
 */

import * as vscode from 'vscode';
import {
	AiSettingsStore,
	AiSettingsState,
	AiServer,
	McpServerConfig,
	ServerKind,
	kindLabel,
	defaultBaseUrlFor,
	defaultModelsFor,
} from './aiSettingsStore';
import { GovernanceStore } from '../governance/governanceStore';
import { GovernanceKind, GovernanceItem } from '../governance/types';

export class AiSettingsPanel {
	public static readonly viewType = 'codeforge.settings';
	private static current: AiSettingsPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];

	static show(
		context: vscode.ExtensionContext,
		store: AiSettingsStore,
		governance: GovernanceStore
	) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (AiSettingsPanel.current) {
			AiSettingsPanel.current.panel.reveal(column);
			AiSettingsPanel.current.postState();
			return AiSettingsPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(
			AiSettingsPanel.viewType,
			'CodeForge Settings',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri],
			}
		);

		AiSettingsPanel.current = new AiSettingsPanel(panel, store, governance);
		return AiSettingsPanel.current;
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly store: AiSettingsStore,
		private readonly governance: GovernanceStore
	) {
		this.panel = panel;
		this.panel.iconPath = undefined;
		this.panel.webview.html = this.html();
		this.postState();

		this.disposables.push(
			this.panel.webview.onDidReceiveMessage(async msg => {
				await this.onMessage(msg);
			}),
			this.store.onDidChange(() => this.postState()),
			this.governance.onDidChange(() => this.postState()),
			this.panel.onDidDispose(() => this.dispose())
		);
	}

	private postState() {
		const state = this.store.getState();
		this.panel.webview.postMessage({
			type: 'state',
			state: sanitizeForWebview(state),
			governance: this.governance.getState(),
		});
	}

	private async onMessage(msg: { type: string; [k: string]: unknown }) {
		const state = this.store.getState();

		switch (msg.type) {
			case 'ready':
				this.postState();
				return;

			case 'addServer': {
				const kind = (msg.kind as ServerKind) || 'openai';
				const server = this.store.createServerDraft(kind);
				state.servers.push(server);
				if (!state.activeServerId) {
					state.activeServerId = server.id;
					state.activeModel = server.models[0] ?? null;
				}
				await this.store.save(state);
				return;
			}

			case 'updateServer': {
				const server = msg.server as AiServer;
				const idx = state.servers.findIndex(s => s.id === server.id);
				if (idx < 0) return;
				// Preserve apiKey if webview sent masked placeholder
				const prev = state.servers[idx];
				if (server.apiKey === '••••••••' || server.apiKey === undefined) {
					server.apiKey = prev.apiKey;
				}
				state.servers[idx] = server;
				await this.store.save(state);
				if (msg.notify) {
					vscode.window.showInformationMessage(`Saved "${server.name}"`);
				}
				return;
			}

			case 'deleteServer': {
				const id = String(msg.id);
				const target = state.servers.find(s => s.id === id);
				const ok = await vscode.window.showWarningMessage(
					`Remove server "${target?.name ?? id}"?`,
					{ modal: true },
					'Remove'
				);
				if (ok !== 'Remove') return;
				state.servers = state.servers.filter(s => s.id !== id);
				if (state.activeServerId === id) {
					state.activeServerId = state.servers[0]?.id ?? null;
					state.activeModel = state.servers[0]?.models[0] ?? null;
				}
				await this.store.save(state);
				return;
			}

			case 'setActive': {
				await this.store.setActiveModel(String(msg.serverId), String(msg.model));
				vscode.window.showInformationMessage(`Active model: ${msg.model}`);
				return;
			}

			case 'fetchModels': {
				const serverId = String(msg.serverId);
				const server = state.servers.find(s => s.id === serverId);
				if (!server) return;
				try {
					const models = await fetchRemoteModels(server);
					if (models.length) {
						server.models = Array.from(new Set([...models, ...server.models]));
						await this.store.save(state);
						vscode.window.showInformationMessage(`Loaded ${models.length} models from ${server.name}`);
					} else {
						vscode.window.showWarningMessage('No models returned. Check base URL / API key.');
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					vscode.window.showErrorMessage(`Fetch models failed: ${message}`);
				}
				return;
			}

			case 'addMcp': {
				state.mcpServers.push(this.store.createMcpDraft());
				await this.store.save(state);
				return;
			}

			case 'updateMcp': {
				const mcp = msg.server as McpServerConfig;
				const idx = state.mcpServers.findIndex(s => s.id === mcp.id);
				if (idx < 0) return;
				state.mcpServers[idx] = mcp;
				await this.store.save(state);
				if (msg.notify) {
					vscode.window.showInformationMessage(`Saved "${mcp.name}"`);
				}
				return;
			}

			case 'deleteMcp': {
				const id = String(msg.id);
				const target = state.mcpServers.find(s => s.id === id);
				const ok = await vscode.window.showWarningMessage(
					`Remove MCP "${target?.name ?? id}"?`,
					{ modal: true },
					'Remove'
				);
				if (ok !== 'Remove') return;
				state.mcpServers = state.mcpServers.filter(s => s.id !== id);
				await this.store.save(state);
				return;
			}

			case 'govAdd': {
				const draft = this.governance.createDraft(msg.kind as GovernanceKind);
				await this.governance.upsert(draft);
				return;
			}
			case 'govUpsert': {
				await this.governance.upsert(msg.item as GovernanceItem);
				return;
			}
			case 'govToggle': {
				await this.governance.setEnabled(
					msg.kind as GovernanceKind,
					String(msg.id),
					Boolean(msg.enabled)
				);
				return;
			}
			case 'govDelete': {
				const kind = msg.kind as GovernanceKind;
				const id = String(msg.id);
				const gov = this.governance.getState();
				const list =
					kind === 'skill'
						? gov.skills
						: kind === 'rule'
							? gov.rules
							: kind === 'policy'
								? gov.policies
								: gov.guardrails;
				const item = list.find(x => x.id === id);
				const ok = await vscode.window.showWarningMessage(
					`Delete "${item?.title ?? id}"?`,
					{ modal: true },
					'Delete'
				);
				if (ok !== 'Delete') return;
				try {
					await this.governance.remove(kind, id);
				} catch (err) {
					vscode.window.showWarningMessage(
						err instanceof Error ? err.message : String(err)
					);
				}
				return;
			}
			case 'govReset': {
				await this.governance.resetBuiltin(msg.kind as GovernanceKind, String(msg.id));
				vscode.window.showInformationMessage('Reset to built-in defaults');
				return;
			}
		}
	}

	private dispose() {
		AiSettingsPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private html(): string {
		const kinds = (
			['openai', 'anthropic', 'google', 'xai', 'openrouter', 'ollama', 'vllm', 'lmstudio', 'custom'] as ServerKind[]
		)
			.map(k => `<option value="${k}">${kindLabel(k)}</option>`)
			.join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CodeForge Settings</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --input: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--vscode-panel-border));
    --btn: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn2: var(--vscode-button-secondaryBackground);
    --btn2-fg: var(--vscode-button-secondaryForeground);
    --focus: var(--vscode-focusBorder);
    --list-hover: var(--vscode-list-hoverBackground);
    --list-active: var(--vscode-list-activeSelectionBackground);
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg); background: var(--bg);
  }
  .shell { display: grid; grid-template-columns: 220px 1fr; height: 100%; }
  .nav {
    border-right: 1px solid var(--border);
    padding: 20px 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .brand {
    font-weight: 600; font-size: 13px; padding: 4px 10px 16px;
    letter-spacing: 0.02em;
  }
  .nav button {
    text-align: left; border: 0; background: transparent; color: var(--fg);
    padding: 8px 10px; border-radius: 6px; cursor: pointer; font: inherit;
  }
  .nav button.active, .nav button:hover { background: var(--list-hover); }
  .nav button.active { background: var(--list-active); }
  .main { overflow: auto; padding: 28px 36px 48px; max-width: 920px; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 6px; }
  .subtitle { color: var(--muted); margin: 0 0 24px; line-height: 1.45; }
  h2 { font-size: 0.95rem; margin: 28px 0 10px; font-weight: 600; }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: transparent;
    margin-bottom: 12px;
    overflow: hidden;
  }
  .card-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .card-head .title { font-weight: 600; flex: 1; }
  .badge {
    font-size: 0.75em; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px;
  }
  .badge.on { color: var(--btn-fg); background: var(--btn); border-color: transparent; }
  .card-body { padding: 14px; display: grid; gap: 12px; }
  .row { display: grid; grid-template-columns: 140px 1fr; gap: 10px; align-items: center; }
  .row label { color: var(--muted); font-size: 0.9em; }
  input, select, textarea {
    width: 100%; border: 1px solid var(--input-border); background: var(--input);
    color: var(--input-fg); border-radius: 6px; padding: 7px 10px; font: inherit;
  }
  textarea { min-height: 64px; resize: vertical; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button.primary, button.secondary, button.danger {
    border: 0; border-radius: 6px; padding: 7px 12px; font: inherit; cursor: pointer;
  }
  button.primary { background: var(--btn); color: var(--btn-fg); }
  button.secondary { background: var(--btn2); color: var(--btn2-fg); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--border); }
  .models {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .chip {
    border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px;
    cursor: pointer; background: transparent; color: var(--fg); font: inherit;
  }
  .chip:hover { border-color: var(--btn); }
  .chip.active {
    background: var(--btn); color: var(--btn-fg); border-color: transparent;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--btn) 60%, transparent);
  }
  .chip .x { margin-left: 6px; opacity: 0.7; }
  .chip.active .x { opacity: 0.85; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
  .toolbar .spacer { flex: 1; }
  .empty {
    border: 1px dashed var(--border); border-radius: var(--radius);
    padding: 28px; text-align: center; color: var(--muted);
  }
  .hint { color: var(--muted); font-size: 0.85em; margin-top: 4px; }
  .split { display: none; }
  .split.active { display: block; }
  .subtabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
  .subtabs button {
    border: 1px solid var(--border); background: transparent; color: var(--fg);
    border-radius: 999px; padding: 5px 12px; cursor: pointer; font: inherit;
  }
  .subtabs button.active { background: var(--btn); color: var(--btn-fg); border-color: transparent; }
  .params { display: grid; gap: 6px; }
  .params .param-row { display: grid; grid-template-columns: 1fr 120px; gap: 8px; align-items: center; }
</style>
</head>
<body>
<div class="shell">
  <aside class="nav">
    <div class="brand">CodeForge</div>
    <button class="active" data-tab="models">Models</button>
    <button data-tab="mcp">MCP</button>
    <button data-tab="guardrails">Guardrails</button>
  </aside>
  <main class="main">
    <section id="tab-models" class="split active">
      <h1>Models</h1>
      <p class="subtitle">Add API or local servers, manage their models, and choose what’s active. While coding, use the model QuickPick to switch quickly.</p>

      <div class="toolbar">
        <select id="newKind">${kinds}</select>
        <button class="primary" id="addServer">Add server</button>
        <div class="spacer"></div>
        <span class="hint" id="activeLabel">No active model</span>
      </div>
      <div id="servers"></div>
      <div class="empty" id="serversEmpty">No servers yet. Click <strong>Add server</strong> above, enter your API key or local URL, then fetch models.</div>
    </section>

    <section id="tab-mcp" class="split">
      <h1>MCP</h1>
      <p class="subtitle">Model Context Protocol servers give the agent extra tools (docs, browsers, databases…).</p>
      <div class="toolbar">
        <button class="primary" id="addMcp">Add MCP server</button>
      </div>
      <div id="mcpList"></div>
      <div class="empty" id="mcpEmpty">No MCP servers configured.</div>
    </section>

    <section id="tab-guardrails" class="split">
      <h1>Skills · Rules · Policies · Guardrails</h1>
      <p class="subtitle">Soft guidance plus hard IDE enforcement. Toggle, edit, or add custom items. Built-ins can be disabled or reset, not deleted.</p>
      <div class="subtabs">
        <button class="active" data-gov="skills">Skills</button>
        <button data-gov="rules">Rules</button>
        <button data-gov="policies">Policies</button>
        <button data-gov="guardrails">Guardrails</button>
      </div>
      <div class="toolbar">
        <button class="primary" id="govAdd">Add</button>
        <span class="hint" id="govHint"></span>
      </div>
      <div id="govList"></div>
    </section>
  </main>
</div>
<script>
  const vscode = acquireVsCodeApi();
  let state = { servers: [], activeServerId: null, activeModel: null, mcpServers: [] };
  let governance = { skills: [], rules: [], policies: [], guardrails: [] };
  let govKind = 'skills';

  document.querySelectorAll('.nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.split').forEach(s => s.classList.remove('active'));
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.querySelectorAll('.subtabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subtabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      govKind = btn.dataset.gov;
      renderGov();
    });
  });

  document.getElementById('addServer').addEventListener('click', () => {
    vscode.postMessage({ type: 'addServer', kind: document.getElementById('newKind').value });
  });

  document.getElementById('addMcp').addEventListener('click', () => {
    vscode.postMessage({ type: 'addMcp' });
  });

  document.getElementById('govAdd').addEventListener('click', () => {
    const kind = govKind === 'skills' ? 'skill' : govKind === 'rules' ? 'rule' : govKind === 'policies' ? 'policy' : 'guardrail';
    vscode.postMessage({ type: 'govAdd', kind });
  });

  window.addEventListener('message', (e) => {
    if (e.data.type === 'state') {
      state = e.data.state;
      governance = e.data.governance || governance;
      withPreservedScroll(() => {
        render();
        renderGov();
      });
    }
  });

  function getScrollMain() {
    return document.querySelector('.main');
  }

  function withPreservedScroll(fn) {
    const main = getScrollMain();
    const top = main ? main.scrollTop : 0;
    const left = main ? main.scrollLeft : 0;
    fn();
    const restore = () => {
      const el = getScrollMain();
      if (!el) return;
      el.scrollTop = top;
      el.scrollLeft = left;
    };
    restore();
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  }

  function renderGov() {
    const hints = {
      skills: 'Skills = playbooks when the task matches triggers.',
      rules: 'Rules = always-on soft constraints in the system prompt.',
      policies: 'Policies = approval / write-budget intent (params feed guardrails).',
      guardrails: 'Guardrails = hard enforcement in the agent loop (can block tools).',
    };
    document.getElementById('govHint').textContent = hints[govKind] || '';
    const root = document.getElementById('govList');
    root.innerHTML = '';
    const items = governance[govKind] || [];
    if (!items.length) {
      root.innerHTML = '<div class="empty">No items yet.</div>';
      return;
    }
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'card';
      const params = item.params || {};
      const paramKeys = Object.keys(params);
      card.innerHTML =
        '<div class="card-head"><div class="title"></div>' +
        (item.builtin ? '<span class="badge">built-in</span>' : '<span class="badge">custom</span>') +
        '<span class="badge ' + (item.enabled ? 'on' : '') + '">' + (item.enabled ? 'On' : 'Off') + '</span></div>' +
        '<div class="card-body">' +
        '<div class="row"><label>Title</label><input data-f="title" /></div>' +
        '<div class="row"><label>Description</label><input data-f="description" /></div>' +
        (item.kind === 'skill' ? '<div class="row"><label>Triggers</label><input data-f="triggers" /></div>' : '') +
        (item.kind === 'guardrail' ? '<div class="row"><label>gateId</label><input data-f="gateId" /></div>' : '') +
        '<div class="row"><label>Content</label><textarea data-f="content"></textarea></div>' +
        (paramKeys.length ? '<div class="row"><label>Params</label><div class="params" data-params></div></div>' : '') +
        '<div class="actions">' +
        '<button class="primary" data-act="save">Save</button>' +
        '<button class="secondary" data-act="toggle">' + (item.enabled ? 'Disable' : 'Enable') + '</button>' +
        (item.builtin
          ? '<button class="secondary" data-act="reset">Reset default</button>'
          : '<button class="danger" data-act="delete">Delete</button>') +
        '</div></div>';
      card.querySelector('.title').textContent = item.title;
      card.querySelector('[data-f="title"]').value = item.title || '';
      card.querySelector('[data-f="description"]').value = item.description || '';
      card.querySelector('[data-f="content"]').value = item.content || '';
      if (item.kind === 'skill') {
        card.querySelector('[data-f="triggers"]').value = (item.triggers || []).join(', ');
      }
      if (item.kind === 'guardrail') {
        const g = card.querySelector('[data-f="gateId"]');
        g.value = item.gateId || '';
        g.disabled = !!item.builtin;
      }
      const paramsEl = card.querySelector('[data-params]');
      if (paramsEl) {
        paramKeys.forEach(k => {
          const row = document.createElement('div');
          row.className = 'param-row';
          const val = params[k];
          if (typeof val === 'boolean') {
            row.innerHTML = '<label></label><select data-param="' + k + '"><option value="true">true</option><option value="false">false</option></select>';
            row.querySelector('label').textContent = k;
            row.querySelector('select').value = String(val);
          } else {
            row.innerHTML = '<label></label><input data-param="' + k + '" type="number" />';
            row.querySelector('label').textContent = k;
            row.querySelector('input').value = String(val);
          }
          paramsEl.appendChild(row);
        });
      }
      card.querySelector('[data-act="save"]').addEventListener('click', () => {
        const next = Object.assign({}, item);
        next.title = card.querySelector('[data-f="title"]').value.trim() || item.title;
        next.description = card.querySelector('[data-f="description"]').value.trim();
        next.content = card.querySelector('[data-f="content"]').value;
        if (item.kind === 'skill') {
          next.triggers = card.querySelector('[data-f="triggers"]').value.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (item.kind === 'guardrail' && !item.builtin) {
          next.gateId = card.querySelector('[data-f="gateId"]').value.trim() || item.gateId;
        }
        if (item.params) {
          const p = Object.assign({}, item.params);
          card.querySelectorAll('[data-param]').forEach(el => {
            const key = el.getAttribute('data-param');
            if (typeof item.params[key] === 'boolean') p[key] = el.value === 'true';
            else {
              const n = Number(el.value);
              p[key] = Number.isFinite(n) ? n : item.params[key];
            }
          });
          next.params = p;
        }
        vscode.postMessage({ type: 'govUpsert', item: next });
      });
      card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'govToggle', kind: item.kind, id: item.id, enabled: !item.enabled });
      });
      const resetBtn = card.querySelector('[data-act="reset"]');
      if (resetBtn) resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'govReset', kind: item.kind, id: item.id }));
      const delBtn = card.querySelector('[data-act="delete"]');
      if (delBtn) delBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'govDelete', kind: item.kind, id: item.id });
      });
      root.appendChild(card);
    });
  }

  function focusedCardIdIn(root) {
    const el = document.activeElement;
    if (!el || !root.contains(el)) return null;
    // Only preserve the card while editing fields — not when focus is on a chip/button
    // (otherwise setActive never repaints .chip.active).
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return null;
    const card = el.closest && el.closest('.card[data-id]');
    return card ? card.getAttribute('data-id') : null;
  }

  function syncCardActiveState(card, server) {
    const isActive = server.id === state.activeServerId;
    const head = card.querySelector('.card-head');
    if (head) {
      head.querySelectorAll('.badge').forEach(b => {
        if (b.textContent === 'Active') b.remove();
      });
      const enabled = head.querySelector('.badge');
      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'badge on';
        badge.textContent = 'Active';
        head.appendChild(badge);
      }
      void enabled;
    }
    card.querySelectorAll('[data-models] .chip').forEach(chip => {
      const label = chip.dataset.model || (chip.textContent || '').replace(/×\\s*$/, '').trim();
      const on = isActive && state.activeModel === label;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function clearChildrenExcept(root, keep) {
    Array.from(root.children).forEach(child => {
      if (child !== keep) child.remove();
    });
  }

  function bindAutoSave(card, saveFn) {
    card.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.getAttribute('data-f') === 'newModel') return;
      el.addEventListener('change', saveFn);
    });
  }

  function render() {
    const active = state.servers.find(s => s.id === state.activeServerId);
    document.getElementById('activeLabel').textContent = active && state.activeModel
      ? ('Active: ' + active.name + ' · ' + state.activeModel)
      : 'No active model';

    const root = document.getElementById('servers');
    const focusedServerId = focusedCardIdIn(root);
    const keepServerId = focusedServerId && state.servers.some(s => s.id === focusedServerId)
      ? focusedServerId
      : null;
    const keepServerCard = keepServerId
      ? root.querySelector('.card[data-id="' + keepServerId + '"]')
      : null;
    clearChildrenExcept(root, keepServerCard);
    document.getElementById('serversEmpty').style.display = state.servers.length ? 'none' : 'block';

    state.servers.forEach(server => {
      if (keepServerCard && server.id === keepServerId) {
        root.appendChild(keepServerCard);
        syncCardActiveState(keepServerCard, server);
        return;
      }

      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-id', server.id);
      const isActive = server.id === state.activeServerId;
      card.innerHTML = \`
        <div class="card-head">
          <div class="title"></div>
          <span class="badge \${server.enabled ? 'on' : ''}">\${server.enabled ? 'Enabled' : 'Disabled'}</span>
          \${isActive ? '<span class="badge on">Active</span>' : ''}
        </div>
        <div class="card-body">
          <div class="row"><label>Name</label><input data-f="name" /></div>
          <div class="row"><label>Provider</label><select data-f="kind">${kinds}</select></div>
          <div class="row"><label>Base URL</label><input data-f="baseUrl" placeholder="https://api… or http://localhost:11434/v1" /></div>
          <div class="row"><label>API key</label><input data-f="apiKey" type="password" placeholder="Optional for local servers" /></div>
          <div class="row"><label>num_ctx</label>
            <div>
              <input data-f="numCtx" type="number" min="2048" step="1024" placeholder="32768" />
              <div class="hint">Context window (tokens). Align with Ollama/server num_ctx. Drives compact/caps; sent as options.num_ctx when supported.</div>
            </div>
          </div>
          <div class="row"><label>Force JSON</label>
            <div>
              <label style="display:flex;align-items:center;gap:8px;color:var(--fg);padding-top:0">
                <input data-f="forceJson" type="checkbox" />
                Require JSON responses (response_format)
              </label>
              <div class="hint">Useful for local Tabby/exllama that put tool_calls in content as JSON. Some clouds ignore this.</div>
            </div>
          </div>
          <div class="row"><label>Models</label>
            <div>
              <div class="models" data-models></div>
              <div class="actions" style="margin-top:8px">
                <input data-f="newModel" placeholder="Add model id" style="flex:1" />
                <button class="secondary" data-act="addModel">Add</button>
                <button class="secondary" data-act="fetch">Refresh from API</button>
              </div>
              <div class="hint">Click a model to make it active. Use QuickPick in the editor to switch while working.</div>
            </div>
          </div>
          <div class="actions">
            <button class="primary" data-act="save">Save</button>
            <button class="secondary" data-act="toggle">\${server.enabled ? 'Disable' : 'Enable'}</button>
            <button class="danger" data-act="delete">Remove</button>
          </div>
        </div>\`;

      card.querySelector('.title').textContent = server.name;
      card.querySelector('[data-f="name"]').value = server.name;
      card.querySelector('[data-f="kind"]').value = server.kind;
      card.querySelector('[data-f="baseUrl"]').value = server.baseUrl || '';
      card.querySelector('[data-f="apiKey"]').value = server.apiKey || '';
      card.querySelector('[data-f="numCtx"]').value = String(server.numCtx || 32768);
      card.querySelector('[data-f="forceJson"]').checked = !!server.forceJson;

      const modelsEl = card.querySelector('[data-models]');
      (server.models || []).forEach(m => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.model = m;
        chip.className = 'chip' + (isActive && state.activeModel === m ? ' active' : '');
        chip.setAttribute('aria-pressed', isActive && state.activeModel === m ? 'true' : 'false');
        chip.innerHTML = m + '<span class="x" title="Remove">×</span>';
        chip.addEventListener('click', (ev) => {
          if (ev.target.classList.contains('x')) {
            const next = readServer(card, server);
            next.models = (next.models || []).filter(x => x !== m);
            vscode.postMessage({ type: 'updateServer', server: next });
            return;
          }
          vscode.postMessage({ type: 'setActive', serverId: server.id, model: m });
        });
        modelsEl.appendChild(chip);
      });

      const persistServer = () => {
        vscode.postMessage({ type: 'updateServer', server: readServer(card, server) });
      };
      bindAutoSave(card, persistServer);

      card.querySelector('[data-act="addModel"]').addEventListener('click', () => {
        const input = card.querySelector('[data-f="newModel"]');
        const val = (input.value || '').trim();
        if (!val) return;
        server.models = Array.from(new Set([...(server.models || []), val]));
        input.value = '';
        vscode.postMessage({ type: 'updateServer', server: readServer(card, server) });
      });

      card.querySelector('[data-act="fetch"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'updateServer', server: readServer(card, server) });
        vscode.postMessage({ type: 'fetchModels', serverId: server.id });
      });

      card.querySelector('[data-act="save"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'updateServer', server: readServer(card, server), notify: true });
      });

      card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        const next = readServer(card, server);
        next.enabled = !next.enabled;
        vscode.postMessage({ type: 'updateServer', server: next });
      });

      card.querySelector('[data-act="delete"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'deleteServer', id: server.id });
      });

      root.appendChild(card);
    });

    // MCP
    const mcpRoot = document.getElementById('mcpList');
    const focusedMcpId = focusedCardIdIn(mcpRoot);
    const keepMcpId = focusedMcpId && state.mcpServers.some(s => s.id === focusedMcpId)
      ? focusedMcpId
      : null;
    const keepMcpCard = keepMcpId
      ? mcpRoot.querySelector('.card[data-id="' + keepMcpId + '"]')
      : null;
    clearChildrenExcept(mcpRoot, keepMcpCard);
    document.getElementById('mcpEmpty').style.display = state.mcpServers.length ? 'none' : 'block';
    state.mcpServers.forEach(mcp => {
      if (keepMcpCard && mcp.id === keepMcpId) {
        mcpRoot.appendChild(keepMcpCard);
        return;
      }

      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-id', mcp.id);
      card.innerHTML = \`
        <div class="card-head">
          <div class="title"></div>
          <span class="badge \${mcp.enabled ? 'on' : ''}">\${mcp.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="card-body">
          <div class="row"><label>Name</label><input data-f="name" /></div>
          <div class="row"><label>Transport</label>
            <select data-f="transport">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          <div class="row"><label>Command</label><input data-f="command" placeholder="npx / node / uvx" /></div>
          <div class="row"><label>Args</label><input data-f="args" placeholder="-y package ..." /></div>
          <div class="row"><label>URL</label><input data-f="url" placeholder="http://127.0.0.1:3000/mcp" /></div>
          <div class="row"><label>API key</label><input data-f="apiKey" type="password" placeholder="Optional for HTTP" /></div>
          <div class="row"><label>Env</label><input data-f="env" placeholder="KEY=value KEY2=value2" /></div>
          <div class="actions">
            <button class="primary" data-act="save">Save</button>
            <button class="secondary" data-act="toggle">\${mcp.enabled ? 'Disable' : 'Enable'}</button>
            <button class="danger" data-act="delete">Remove</button>
          </div>
        </div>\`;
      card.querySelector('.title').textContent = mcp.name;
      card.querySelector('[data-f="name"]').value = mcp.name || '';
      card.querySelector('[data-f="transport"]').value = mcp.transport || (mcp.url ? 'http' : 'stdio');
      card.querySelector('[data-f="command"]').value = mcp.command || '';
      card.querySelector('[data-f="args"]').value = (mcp.args || []).join(' ');
      card.querySelector('[data-f="url"]').value = mcp.url || '';
      card.querySelector('[data-f="apiKey"]').value = mcp.apiKey || '';
      card.querySelector('[data-f="env"]').value = envToString(mcp.env);

      const persistMcp = () => {
        vscode.postMessage({ type: 'updateMcp', server: readMcp(card, mcp) });
      };
      bindAutoSave(card, persistMcp);

      card.querySelector('[data-act="save"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'updateMcp', server: readMcp(card, mcp), notify: true });
      });
      card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        const next = readMcp(card, mcp);
        next.enabled = !next.enabled;
        vscode.postMessage({ type: 'updateMcp', server: next });
      });
      card.querySelector('[data-act="delete"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'deleteMcp', id: mcp.id });
      });
      mcpRoot.appendChild(card);
    });
  }

  function readServer(card, prev) {
    const rawCtx = Number(card.querySelector('[data-f="numCtx"]').value);
    const numCtx = Number.isFinite(rawCtx) && rawCtx >= 2048 ? Math.floor(rawCtx) : (prev.numCtx || 32768);
    return {
      ...prev,
      name: card.querySelector('[data-f="name"]').value.trim() || prev.name,
      kind: card.querySelector('[data-f="kind"]').value,
      baseUrl: card.querySelector('[data-f="baseUrl"]').value.trim(),
      apiKey: card.querySelector('[data-f="apiKey"]').value,
      numCtx,
      forceJson: !!card.querySelector('[data-f="forceJson"]').checked,
      models: prev.models || [],
      enabled: prev.enabled,
    };
  }

  function readMcp(card, prev) {
    const transport = card.querySelector('[data-f="transport"]').value || 'stdio';
    return {
      ...prev,
      name: card.querySelector('[data-f="name"]').value.trim() || prev.name,
      transport,
      command: card.querySelector('[data-f="command"]').value.trim(),
      args: card.querySelector('[data-f="args"]').value.trim().split(/\\s+/).filter(Boolean),
      url: card.querySelector('[data-f="url"]').value.trim(),
      apiKey: card.querySelector('[data-f="apiKey"]').value,
      env: parseEnvClient(card.querySelector('[data-f="env"]').value.trim()),
      enabled: prev.enabled,
    };
  }

  function parseEnvClient(text) {
    const env = {};
    text.split(/\\s+/).filter(Boolean).forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return env;
  }

  function envToString(env) {
    if (!env) return '';
    return Object.entries(env).map(([k, v]) => k + '=' + v).join(' ');
  }

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}

function sanitizeForWebview(state: AiSettingsState): AiSettingsState {
	return {
		...state,
		servers: state.servers.map(s => ({
			...s,
			// Keep key editable in password field; don't strip so users can see length via dots.
			apiKey: s.apiKey ? s.apiKey : '',
		})),
	};
}

async function fetchRemoteModels(server: AiServer): Promise<string[]> {
	const rawBase = (server.baseUrl || defaultBaseUrlFor(server.kind)).replace(/\/$/, '');
	if (!rawBase) {
		throw new Error('Base URL is empty');
	}

	if (server.kind === 'anthropic') {
		return defaultModelsFor('anthropic');
	}

	const headers: Record<string, string> = {
		...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
	};

	// Try common OpenAI-compatible + Ollama native endpoints
	const candidates = [
		`${rawBase}/models`,
		rawBase.endsWith('/v1') ? '' : `${rawBase}/v1/models`,
		`${rawBase}/api/tags`,
	].filter(Boolean);

	const errors: string[] = [];

	for (const url of candidates) {
		try {
			const res = await fetch(url, { headers });
			if (!res.ok) {
				errors.push(`${url} → ${res.status}`);
				continue;
			}
			const data = (await res.json()) as {
				data?: Array<{ id?: string }>;
				models?: Array<{ name?: string; model?: string }>;
			};
			if (Array.isArray(data.data)) {
				const ids = data.data.map(m => m.id).filter((x): x is string => Boolean(x));
				if (ids.length) return ids;
			}
			if (Array.isArray(data.models)) {
				const ids = data.models
					.map(m => m.name || m.model)
					.filter((x): x is string => Boolean(x));
				if (ids.length) return ids;
			}
			errors.push(`${url} → empty list`);
		} catch (err) {
			errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(
		`No models endpoint found. Tried:\n${errors.join('\n')}\n\nTip: use a base URL like https://host/v1 (OpenAI-compatible) or http://localhost:11434 for Ollama.`
	);
}
