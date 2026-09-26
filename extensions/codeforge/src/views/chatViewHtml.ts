/**
 * Webview HTML/CSS/JS for the Agent chat panel (Cursor-like composer).
 * All user-facing strings are English.
 */

export function getChatViewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CodeForge AI</title>
<style>
  :root { --gap: 8px; --radius: 8px; }
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  body { display: flex; flex-direction: column; padding: 0; }
  .messages {
    flex: 1; overflow-y: auto; padding: 12px 10px 8px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .empty {
    margin: auto; text-align: center; color: var(--vscode-descriptionForeground);
    max-width: 300px; line-height: 1.45;
  }
  .empty h1 { font-size: 1.15rem; font-weight: 600; color: var(--vscode-foreground); margin: 0 0 8px; }
  .empty .sparkle { font-size: 1.6rem; margin-bottom: 6px; opacity: 0.9; }
  .empty .cta-row { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
  .empty .cta {
    border: 0; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .empty .cta.secondary {
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border);
  }
  .empty .disclaimer { font-size: 0.78em; margin-top: 10px; opacity: 0.85; }
  .empty kbd {
    font-family: var(--vscode-editor-font-family); font-size: 0.85em;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 1px 5px;
    background: var(--vscode-input-background);
  }
  .msg { padding: 0; line-height: 1.45; max-width: 100%; }
  .msg.user {
    align-self: flex-end; max-width: min(92%, 520px); margin: 2px 0 4px;
    position: relative;
  }
  .msg.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 14px; padding: 10px 14px;
  }
  .msg.user .restore-row {
    display: flex; justify-content: flex-end; margin-top: 4px;
  }
  .msg.user .restore-btn {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    font: inherit; font-size: 0.72em; cursor: pointer; padding: 0 2px;
  }
  .msg.user .restore-btn:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .msg.assistant {
    align-self: stretch; background: transparent; border: 0;
    padding: 4px 2px 8px; max-width: 100%;
  }
  .msg.pending { opacity: 0.85; }
  .role {
    font-size: 0.72em; color: var(--vscode-descriptionForeground);
    margin-bottom: 4px; letter-spacing: 0.02em;
  }
  .msg.user .role { display: none; }
  .msg-body { word-wrap: break-word; overflow-wrap: anywhere; }
  .msg.user .msg-body { white-space: pre-wrap; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0.55em 0; }
  .md h1, .md h2, .md h3, .md h4 {
    margin: 0.85em 0 0.35em; font-weight: 600; line-height: 1.3;
  }
  .md h1 { font-size: 1.2em; }
  .md h2 { font-size: 1.1em; }
  .md h3, .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 0.4em 0; padding-left: 1.35em; }
  .md li { margin: 0.15em 0; }
  .md li::marker { color: var(--vscode-descriptionForeground); }
  .md blockquote {
    margin: 0.5em 0; padding: 0.15em 0 0.15em 0.75em;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .md hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 0.75em 0; }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .md a:hover { text-decoration: underline; }
  .md code {
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 0.05em 0.35em;
  }
  .md pre {
    margin: 0.55em 0; padding: 8px 10px; overflow: auto; max-height: 280px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  }
  .md pre code { border: 0; background: transparent; padding: 0; font-size: 0.85em; white-space: pre; }
  .md strong { font-weight: 600; }

  .turn-tools { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 8px; align-self: stretch; }
  .step-row {
    font-size: 0.8em; color: var(--vscode-descriptionForeground);
    padding: 2px 2px; line-height: 1.4;
  }
  .step-row summary {
    list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 6px;
  }
  .step-row summary::-webkit-details-marker { display: none; }
  .step-row .chev { opacity: 0.55; flex-shrink: 0; width: 0.9em; text-align: center; }
  .step-row .body {
    margin: 2px 0 4px 1.4em; white-space: pre-wrap; max-height: 120px; overflow: auto;
    font-size: 0.95em; opacity: 0.9;
  }
  .step-row.failed { color: var(--vscode-errorForeground, #f48771); }
  .step-row.failed .chev { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .step-row.running { color: var(--vscode-foreground); }
  .step-row.running .chev { color: var(--vscode-charts-blue, #3794ff); }

  .changes-bar {
    display: none; flex-shrink: 0; align-items: center; gap: 8px;
    margin: 0 10px 6px; padding: 6px 10px;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    background: var(--vscode-input-background); font-size: 0.8em;
  }
  .changes-bar.visible { display: flex; }
  .changes-bar .summary { flex: 1; color: var(--vscode-descriptionForeground); }
  .changes-bar .plus { color: var(--vscode-testing-iconPassed, #73c991); }
  .changes-bar .minus { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .changes-bar button {
    border: 1px solid var(--vscode-panel-border); background: transparent;
    color: var(--vscode-foreground); border-radius: 6px; padding: 3px 10px;
    font: inherit; font-size: 0.95em; cursor: pointer;
  }
  .changes-bar button.primary {
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
  }

  .composer {
    flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border);
    padding: 10px; display: flex; flex-direction: column; gap: 8px;
    background: var(--vscode-sideBar-background);
  }
  .composer-box {
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background); border-radius: 10px; padding: 8px 10px 6px;
    position: relative;
  }
  .composer-box.drag-over {
    outline: 2px dashed var(--vscode-focusBorder); outline-offset: 2px;
  }
  .drop-hint {
    display: none; position: absolute; inset: 0; border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    align-items: center; justify-content: center; font-size: 0.85em;
    color: var(--vscode-foreground); pointer-events: none; z-index: 2;
  }
  .composer-box.drag-over .drop-hint { display: flex; }
  textarea {
    width: 100%; min-height: 56px; max-height: 160px; resize: vertical; border: 0;
    outline: none; background: transparent; color: var(--vscode-input-foreground);
    font: inherit; line-height: 1.4;
  }
  .attach-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .attach-chip {
    font-size: 0.72em; border: 1px solid var(--vscode-panel-border);
    border-radius: 999px; padding: 2px 8px; color: var(--vscode-descriptionForeground);
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  }
  .attach-chip .kind { opacity: 0.7; }
  .attach-chip button {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    padding: 0 2px; font: inherit; line-height: 1;
  }
  .composer-actions {
    display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap;
  }
  .chip, .icon-btn, .perm-chip, .mode-chip, .model-chip {
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background);
    color: var(--vscode-foreground); border-radius: 999px; padding: 3px 10px;
    font: inherit; font-size: 0.78em; cursor: pointer; max-width: 160px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .icon-btn {
    width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border-radius: 6px;
  }
  .mode-menu {
    display: none; position: absolute; left: 8px; bottom: 100%;
    margin-bottom: 4px; min-width: 220px; z-index: 6;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25); padding: 4px 0;
  }
  .mode-menu.open { display: block; }
  .mode-item {
    display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; cursor: pointer;
  }
  .mode-item:hover, .mode-item.active { background: var(--vscode-list-hoverBackground); }
  .mode-item .name { font-weight: 600; font-size: 0.85em; }
  .mode-item .desc { font-size: 0.75em; color: var(--vscode-descriptionForeground); }
  .mode-menu .hint {
    padding: 6px 12px; font-size: 0.7em; color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-panel-border); margin-top: 2px;
  }
  .slash-menu {
    display: none; position: absolute; left: 8px; right: 8px; bottom: 100%;
    margin-bottom: 4px; max-height: 180px; overflow: auto; z-index: 5;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }
  .slash-menu.open { display: block; }
  .slash-item {
    display: flex; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 0.85em;
  }
  .slash-item:hover, .slash-item.active { background: var(--vscode-list-hoverBackground); }
  .slash-item .name { font-weight: 600; min-width: 100px; }
  .slash-item .desc { color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; min-width: 4px; }
  .ctx-ring {
    width: 28px; height: 28px; border-radius: 50%; position: relative;
    display: none; align-items: center; justify-content: center;
    font-size: 0.62em; color: var(--vscode-descriptionForeground); cursor: default;
  }
  .ctx-ring.visible { display: inline-flex; }
  .ctx-ring svg { position: absolute; inset: 0; }
  .send, .stop {
    border: 0; border-radius: 50%; width: 32px; height: 32px; font: inherit; cursor: pointer;
    display: grid; place-items: center; padding: 0;
  }
  .send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f48771); }
  .send:disabled { opacity: 0.5; cursor: default; }
  .queue-panel {
    display: none; flex-direction: column; gap: 6px;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 8px; background: var(--vscode-input-background);
  }
  .queue-panel.visible { display: flex; }
  .queue-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.78em; color: var(--vscode-descriptionForeground);
  }
  .queue-head strong { color: var(--vscode-foreground); font-weight: 600; }
  .queue-head .spacer { flex: 1; }
  .queue-head button {
    border: 0; background: transparent; color: var(--vscode-textLink-foreground);
    cursor: pointer; font: inherit; font-size: 0.95em; padding: 0;
  }
  .queue-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 6px 8px; border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    border: 1px solid var(--vscode-panel-border);
    font-size: 0.82em; line-height: 1.35;
  }
  .queue-item .idx { color: var(--vscode-descriptionForeground); min-width: 1.2em; flex-shrink: 0; }
  .queue-item .qtext {
    flex: 1; white-space: pre-wrap; word-break: break-word;
    max-height: 3.6em; overflow: hidden;
  }
  .queue-item button {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    cursor: pointer; font: inherit; line-height: 1; padding: 0 2px; flex-shrink: 0;
  }
  .queue-item button:hover { color: var(--vscode-errorForeground, #f48771); }
</style>
</head>
<body>
  <div class="messages" id="messages">
    <div class="empty" id="emptyState">
      <div class="sparkle">✦</div>
      <h1>Build with Agent</h1>
      <p>Plan, edit, and verify across your workspace.</p>
      <div class="cta-row">
        <button type="button" class="cta" id="ctaStart">Start building</button>
        <button type="button" class="cta secondary" id="ctaInstructions">Generate Agent Instructions</button>
      </div>
      <p class="disclaimer">AI responses may be inaccurate. Press <kbd>Ctrl</kbd>+<kbd>L</kbd> to focus.</p>
    </div>
  </div>

  <div class="changes-bar" id="changesBar" title="Tracks write/edit/delete tools only — shell edits are not recorded">
    <span class="summary" id="changesSummary">0 files changed</span>
    <button type="button" id="undoAllBtn">Undo All</button>
    <button type="button" class="primary" id="reviewBtn">Review</button>
  </div>

  <div class="composer">
    <div class="queue-panel" id="queuePanel" aria-live="polite">
      <div class="queue-head">
        <strong>Queue</strong>
        <span id="queueCount">0</span>
        <span class="spacer"></span>
        <button type="button" id="clearQueueBtn">Clear</button>
      </div>
      <div id="queueList"></div>
    </div>
    <div class="composer-box" id="composerBox">
      <div class="drop-hint">Drop files, images, or links</div>
      <div class="slash-menu" id="slashMenu"></div>
      <div class="mode-menu" id="modeMenu" role="menu">
        <div class="mode-item active" data-mode="agent">
          <span class="name">✓ Agent</span>
          <span class="desc">Edits and runs tools</span>
        </div>
        <div class="mode-item" data-mode="plan">
          <span class="name">Plan</span>
          <span class="desc">Explore and write a plan (no code writes)</span>
        </div>
        <div class="mode-item" data-mode="ask">
          <span class="name">Ask</span>
          <span class="desc">Answer without tools</span>
        </div>
        <div class="hint">Shift+Tab to switch</div>
      </div>
      <div class="attach-row" id="attachRow"></div>
      <textarea id="messageInput" placeholder="Plan, @ for context, / for commands"></textarea>
      <div class="composer-actions">
        <button type="button" class="icon-btn" id="attachBtn" title="Attach files">📎</button>
        <button type="button" class="mode-chip" id="modeChip" title="Switch mode (Shift+Tab)">Agent ▾</button>
        <button type="button" class="model-chip" id="modelChip" title="Switch model">model</button>
        <button type="button" class="perm-chip" id="permChip" title="Permissions">Default</button>
        <span class="spacer"></span>
        <span class="ctx-ring" id="ctxRing" title="Context usage">
          <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
            <circle cx="14" cy="14" r="11" fill="none" stroke="var(--vscode-panel-border)" stroke-width="2.5"/>
            <circle id="ctxArc" cx="14" cy="14" r="11" fill="none"
              stroke="var(--vscode-charts-blue, #3794ff)" stroke-width="2.5"
              stroke-linecap="round" stroke-dasharray="69.1" stroke-dashoffset="69.1"
              transform="rotate(-90 14 14)"/>
          </svg>
          <span id="ctxPct">0%</span>
        </span>
        <button class="send" id="sendButton" type="button" title="Send">↑</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let mode = 'agent';
  let permissions = 'default';
  let busy = false;
  let timeline = [];
  let slashCommands = [];
  let hasAgentsMd = false;
  let slashOpen = false;
  let slashIndex = 0;
  let slashFiltered = [];
  let modeMenuOpen = false;
  let attachmentCount = 0;
  let queuedItems = [];
  let contextUsage = null;
  let contextBadge = { indexed: 0, inContext: 0 };
  let editSummary = null;

  const MODES = [
    { id: 'agent', label: 'Agent', desc: 'Edits and runs tools' },
    { id: 'plan', label: 'Plan', desc: 'Explore and write a plan' },
    { id: 'ask', label: 'Ask', desc: 'Answer without tools' },
  ];

  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendButton');
  const modelChip = document.getElementById('modelChip');
  const modeChip = document.getElementById('modeChip');
  const modeMenu = document.getElementById('modeMenu');
  const permChip = document.getElementById('permChip');
  const attachRow = document.getElementById('attachRow');
  const composerBox = document.getElementById('composerBox');
  const slashMenu = document.getElementById('slashMenu');
  const queuePanel = document.getElementById('queuePanel');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const changesBar = document.getElementById('changesBar');
  const changesSummary = document.getElementById('changesSummary');
  const ctxRing = document.getElementById('ctxRing');
  const ctxArc = document.getElementById('ctxArc');
  const ctxPct = document.getElementById('ctxPct');

  function syncSendButton() {
    sendButton.disabled = false;
    if (busy) {
      sendButton.className = 'stop';
      sendButton.textContent = '■';
      sendButton.title = 'Stop';
      input.placeholder = 'Add to queue… Enter queues while Agent is working';
    } else {
      sendButton.className = 'send';
      sendButton.textContent = '↑';
      sendButton.title = 'Send';
      input.placeholder = mode === 'ask'
        ? 'Ask about the codebase… Type / for commands'
        : 'Plan, @ for context, / for commands';
    }
  }

  function renderQueue(items) {
    queuedItems = Array.isArray(items) ? items : [];
    queueCount.textContent = String(queuedItems.length);
    queuePanel.classList.toggle('visible', queuedItems.length > 0);
    queueList.innerHTML = queuedItems.map(function (item, i) {
      return '<div class="queue-item" data-id="' + escapeHtml(item.id) + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="qtext">' + escapeHtml(item.text) + '</span>' +
        '<button type="button" title="Remove from queue">×</button>' +
        '</div>';
    }).join('');
    queueList.querySelectorAll('.queue-item button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const row = btn.closest('.queue-item');
        const id = row && row.getAttribute('data-id');
        if (id) vscode.postMessage({ type: 'removeQueued', id: id });
      });
    });
  }

  function permLabel(p) {
    return p === 'allowAll' ? 'Allow all' : p === 'assisted' ? 'Assisted' : 'Default';
  }

  function syncPermChip() {
    permChip.textContent = permLabel(permissions);
  }

  function syncModeChip() {
    const m = MODES.find(function (x) { return x.id === mode; }) || MODES[0];
    modeChip.textContent = m.label + ' ▾';
    modeMenu.querySelectorAll('.mode-item').forEach(function (el) {
      const id = el.getAttribute('data-mode');
      const active = id === mode;
      el.classList.toggle('active', active);
      const name = el.querySelector('.name');
      if (name) {
        const base = MODES.find(function (x) { return x.id === id; });
        name.textContent = (active ? '✓ ' : '') + (base ? base.label : id);
      }
    });
  }

  function setMode(next) {
    mode = next === 'ask' ? 'ask' : next === 'plan' ? 'plan' : 'agent';
    syncModeChip();
    syncSendButton();
    closeModeMenu();
    vscode.postMessage({ type: 'setMode', mode: mode });
  }

  function cycleMode() {
    const order = ['agent', 'plan', 'ask'];
    const i = order.indexOf(mode);
    setMode(order[(i + 1) % order.length]);
  }

  function openModeMenu() {
    modeMenuOpen = true;
    modeMenu.classList.add('open');
    hideSlash();
  }

  function closeModeMenu() {
    modeMenuOpen = false;
    modeMenu.classList.remove('open');
  }

  function syncCtxRing() {
    if (!contextUsage || !contextUsage.limit) {
      ctxRing.classList.remove('visible');
      return;
    }
    const pct = Math.min(100, Math.round((contextUsage.used / contextUsage.limit) * 100));
    const circ = 2 * Math.PI * 11;
    ctxArc.setAttribute('stroke-dasharray', String(circ));
    ctxArc.setAttribute('stroke-dashoffset', String(circ * (1 - pct / 100)));
    ctxPct.textContent = pct + '%';
    ctxRing.title = contextUsage.used + ' / ' + contextUsage.limit + ' tokens · ' +
      (contextBadge.indexed || 0) + ' indexed · ' + (contextBadge.inContext || 0) + ' in context';
    ctxRing.classList.add('visible');
  }

  function syncChangesBar() {
    if (!editSummary || !editSummary.files) {
      changesBar.classList.remove('visible');
      return;
    }
    changesSummary.innerHTML =
      editSummary.files + ' file' + (editSummary.files === 1 ? '' : 's') + ' changed ' +
      '<span class="plus">+' + editSummary.added + '</span> ' +
      '<span class="minus">−' + editSummary.removed + '</span>';
    changesBar.classList.add('visible');
  }

  function sendOrStop() {
    if (busy) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    sendMessage();
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text && attachmentCount === 0) return;
    input.value = '';
    hideSlash();
    closeModeMenu();
    vscode.postMessage({ type: 'sendMessage', text: text || 'Analyze the attached items.', mode: mode });
  }

  function filterSlash(prefix) {
    const q = prefix.replace(/^\\//, '').toLowerCase();
    if (!q) return slashCommands.slice();
    return slashCommands.filter(function (c) {
      return c.name.startsWith(q) || c.name.indexOf(q) >= 0;
    });
  }

  function renderSlash() {
    if (!slashOpen || !slashFiltered.length) {
      slashMenu.classList.remove('open');
      return;
    }
    slashMenu.innerHTML = slashFiltered.map(function (c, i) {
      return '<div class="slash-item' + (i === slashIndex ? ' active' : '') + '" data-i="' + i + '">' +
        '<span class="name">/' + escapeHtml(c.name) + '</span>' +
        '<span class="desc">' + escapeHtml(c.description || '') + '</span></div>';
    }).join('');
    slashMenu.classList.add('open');
    slashMenu.querySelectorAll('.slash-item').forEach(function (el) {
      el.addEventListener('click', function () {
        applySlash(Number(el.getAttribute('data-i')));
      });
    });
  }

  function applySlash(i) {
    const c = slashFiltered[i];
    if (!c) return;
    input.value = '/' + c.name + (c.name === 'help' || c.name === 'clear' ? '' : ' ');
    hideSlash();
    input.focus();
  }

  function hideSlash() {
    slashOpen = false;
    slashMenu.classList.remove('open');
  }

  function updateSlashFromInput() {
    const v = input.value;
    const m = /^\\/([a-zA-Z0-9_-]*)$/.exec(v);
    if (!m) { hideSlash(); return; }
    slashFiltered = filterSlash(m[1]);
    slashIndex = 0;
    slashOpen = slashFiltered.length > 0;
    renderSlash();
  }

  function collectUriList(dt) {
    return dt.getData('text/uri-list') || '';
  }

  function readFilesAsBlobs(fileList) {
    const files = Array.from(fileList || []).slice(0, 8);
    return Promise.all(files.map(function (f) {
      return new Promise(function (resolve) {
        const reader = new FileReader();
        reader.onload = function () {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          const base64 = comma >= 0 ? result.slice(comma + 1) : result;
          resolve({ name: f.name, mime: f.type || 'application/octet-stream', base64: base64 });
        };
        reader.onerror = function () { resolve(null); };
        reader.readAsDataURL(f);
      });
    })).then(function (rows) { return rows.filter(Boolean); });
  }

  modeChip.addEventListener('click', function (e) {
    e.stopPropagation();
    if (modeMenuOpen) closeModeMenu(); else openModeMenu();
  });
  modeMenu.querySelectorAll('.mode-item').forEach(function (el) {
    el.addEventListener('click', function () {
      setMode(el.getAttribute('data-mode'));
    });
  });
  document.addEventListener('click', function (e) {
    if (!modeMenu.contains(e.target) && e.target !== modeChip) closeModeMenu();
  });

  modelChip.addEventListener('click', function () {
    vscode.postMessage({ type: 'configure' });
  });
  document.getElementById('attachBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'attachFiles' });
  });
  sendButton.addEventListener('click', sendOrStop);
  permChip.addEventListener('click', function () {
    const order = ['default', 'assisted', 'allowAll'];
    const i = order.indexOf(permissions);
    const next = order[(i + 1) % order.length];
    vscode.postMessage({ type: 'setPermissions', level: next });
  });
  document.getElementById('undoAllBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'undoAll' });
  });
  document.getElementById('reviewBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'reviewChanges' });
  });
  document.getElementById('ctaStart').addEventListener('click', function () {
    vscode.postMessage({ type: 'emptyCta', action: 'start' });
  });
  document.getElementById('ctaInstructions').addEventListener('click', function () {
    vscode.postMessage({ type: 'emptyCta', action: 'instructions' });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = Math.min(slashIndex + 1, slashFiltered.length - 1); renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = Math.max(slashIndex - 1, 0); renderSlash(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySlash(slashIndex); return; }
      if (e.key === 'Escape') { hideSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', updateSlashFromInput);

  ['dragenter', 'dragover'].forEach(function (ev) {
    composerBox.addEventListener(ev, function (e) {
      e.preventDefault();
      composerBox.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    composerBox.addEventListener(ev, function (e) {
      e.preventDefault();
      composerBox.classList.remove('drag-over');
    });
  });
  composerBox.addEventListener('drop', function (e) {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const uriList = collectUriList(dt);
    if (uriList) vscode.postMessage({ type: 'attachUris', uriList: uriList });
    if (dt.files && dt.files.length) {
      readFilesAsBlobs(dt.files).then(function (blobs) {
        if (blobs.length) vscode.postMessage({ type: 'attachBlobs', blobs: blobs });
      });
    }
    const text = dt.getData('text/plain');
    if (text && /^https?:\\/\\//i.test(text.trim())) {
      vscode.postMessage({ type: 'attachUrl', url: text.trim() });
    }
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'config') {
      mode = msg.mode === 'ask' ? 'ask' : msg.mode === 'plan' ? 'plan' : 'agent';
      permissions = msg.permissions === 'allowAll' ? 'allowAll' : msg.permissions === 'assisted' ? 'assisted' : 'default';
      busy = !!msg.running;
      if (msg.slashCommands) slashCommands = msg.slashCommands;
      if (typeof msg.hasAgentsMd === 'boolean') hasAgentsMd = msg.hasAgentsMd;
      if (msg.badge) contextBadge = msg.badge;
      contextUsage = msg.contextUsage || null;
      editSummary = msg.editSummary || null;
      const label = msg.serverName && msg.model
        ? (msg.model.length > 18 ? msg.model.slice(0, 16) + '…' : msg.model)
        : (msg.configured ? 'pick model' : 'configure');
      modelChip.textContent = label;
      modelChip.title = (msg.serverName || '') + (msg.model ? ' · ' + msg.model : '');
      attachmentCount = (msg.attachments || []).length;
      attachRow.innerHTML = (msg.attachments || []).map(function (a) {
        return '<span class="attach-chip"><span class="kind">' + escapeHtml(a.kind) + '</span> ' +
          escapeHtml(a.label) +
          '<button type="button" data-id="' + escapeHtml(a.id) + '" title="Remove">×</button></span>';
      }).join('');
      attachRow.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          vscode.postMessage({ type: 'removeAttachment', id: btn.getAttribute('data-id') });
        });
      });
      syncModeChip();
      syncPermChip();
      syncSendButton();
      syncCtxRing();
      syncChangesBar();
    }
    if (msg.type === 'queue') {
      busy = !!msg.running;
      renderQueue(msg.items);
      syncSendButton();
    }
    if (msg.type === 'updateMessages') {
      if (msg.timeline) timeline = msg.timeline;
      renderMessages(msg.messages || []);
    }
    if (msg.type === 'focusInput') {
      input.focus();
    }
    if (msg.type === 'restorePrompt') {
      input.value = msg.text || '';
      input.focus();
    }
  });

  function emptyHtml() {
    return '<div class="empty" id="emptyState">' +
      '<div class="sparkle">✦</div>' +
      '<h1>Build with Agent</h1>' +
      '<p>Plan, edit, and verify across your workspace.</p>' +
      '<div class="cta-row">' +
      '<button type="button" class="cta" id="ctaStart">Start building</button>' +
      '<button type="button" class="cta secondary" id="ctaInstructions">Generate Agent Instructions</button>' +
      '</div>' +
      '<p class="disclaimer">AI responses may be inaccurate. Press <kbd>Ctrl</kbd>+<kbd>L</kbd> to focus.</p>' +
      '</div>';
  }

  function bindEmptyCtas() {
    const start = document.getElementById('ctaStart');
    const instr = document.getElementById('ctaInstructions');
    if (start) start.addEventListener('click', function () { vscode.postMessage({ type: 'emptyCta', action: 'start' }); });
    if (instr) instr.addEventListener('click', function () { vscode.postMessage({ type: 'emptyCta', action: 'instructions' }); });
  }

  function userTurnIndex(messages, msgIndex) {
    var n = 0;
    for (var i = 0; i <= msgIndex; i++) {
      if (messages[i].role === 'user') n++;
    }
    return n - 1;
  }

  function cleanDetail(raw) {
    if (!raw) return '';
    var text = String(raw).replace(/\\n*\\(lesson —[\\s\\S]*$/i, '').trim();
    var lines = text.split(/\\r?\\n/).filter(function (line) {
      var t = line.trim();
      if (!t) return false;
      if (/^cwd:\\s/i.test(t)) return false;
      if (/^sandbox:\\s/i.test(t)) return false;
      if (/^exit\\s+\\d+\\s*$/i.test(t)) return false;
      if (/^\\(no output\\)$/i.test(t)) return false;
      if (/^\\(failed — cwd:/i.test(t)) return false;
      return true;
    });
    return lines.slice(0, 6).join('\\n').trim();
  }

  function prettyToolLabel(t) {
    var label = String(t.label || t.tool || 'Tool').replace(/\\s+/g, ' ').trim();
    label = label.replace(/\\s+(ok|failed)$/i, '');
    label = label.replace(/^Running\\s+/i, '');
    if (/^(shell|read|write|edit|list|search)\\b/i.test(label) && label === label.toLowerCase()) {
      label = label.charAt(0).toUpperCase() + label.slice(1);
    }
    return label;
  }

  function groupTurnItems(items) {
    var rows = [];
    var exploreBuf = [];
    var shellOkBuf = [];
    function flushExplore() {
      if (!exploreBuf.length) return;
      var files = 0, searches = 0;
      exploreBuf.forEach(function (t) {
        if (t.tool === 'search' || t.tool === 'retrieve') searches++;
        else files++;
      });
      var parts = [];
      if (files) parts.push(files + ' file' + (files === 1 ? '' : 's'));
      if (searches) parts.push(searches + ' search' + (searches === 1 ? '' : 'es'));
      rows.push({
        kind: 'explore',
        label: 'Explored ' + parts.join(', '),
        detail: exploreBuf.map(function (t) { return prettyToolLabel(t); }).join('\\n'),
        open: false,
        status: 'ok',
      });
      exploreBuf = [];
    }
    function flushShellOk() {
      if (!shellOkBuf.length) return;
      if (shellOkBuf.length === 1) {
        rows.push({
          kind: 'tool',
          label: prettyToolLabel(shellOkBuf[0]),
          detail: cleanDetail(shellOkBuf[0].detail),
          open: false,
          status: 'ok',
        });
      } else {
        rows.push({
          kind: 'explore',
          label: 'Ran ' + shellOkBuf.length + ' commands',
          detail: shellOkBuf.map(function (t) { return prettyToolLabel(t); }).join('\\n'),
          open: false,
          status: 'ok',
        });
      }
      shellOkBuf = [];
    }
    items.forEach(function (t) {
      var st = t.toolStatus || (t.success === false ? 'failed' : t.success ? 'ok' : 'running');
      if (t.kind === 'thought') {
        flushExplore();
        flushShellOk();
        rows.push({ kind: 'thought', label: 'Thought', detail: t.detail, open: false, status: 'ok' });
        return;
      }
      if (t.kind === 'tool' && st === 'ok' && (t.tool === 'read' || t.tool === 'list' || t.tool === 'search' || t.tool === 'retrieve' || t.tool === 'outline')) {
        flushShellOk();
        exploreBuf.push(t);
        return;
      }
      if (t.kind === 'tool' && st === 'ok' && (t.tool === 'shell' || t.tool === 'dotnet')) {
        flushExplore();
        shellOkBuf.push(t);
        return;
      }
      flushExplore();
      flushShellOk();
      if (t.kind === 'tool') {
        var detail = cleanDetail(t.detail);
        var label = prettyToolLabel(t);
        // Failures stay collapsed: one quiet line; expand for the short error.
        rows.push({
          kind: 'tool',
          label: label,
          detail: detail,
          open: st === 'running',
          status: st,
          failed: st === 'failed',
        });
        return;
      }
      if (t.kind === 'checkpoint' || t.kind === 'compact' || t.kind === 'context' || t.kind === 'thinking') {
        // Hide noisy harness/log checkpoints from the user-facing stream.
        if (/^(hook|Lesson|Oracle|LLM |Repaired|Retry|Nuked|Switched|Parsed|Truncated|Build-fix|context )/i.test(String(t.label || ''))) {
          return;
        }
        rows.push({ kind: 'activity', label: t.label, detail: cleanDetail(t.detail), open: false, status: 'ok' });
      }
    });
    flushExplore();
    flushShellOk();
    return rows;
  }

  function renderStepRows(items) {
    var rows = groupTurnItems(items);
    if (!rows.length) return '';
    return '<div class="turn-tools">' + rows.map(function (r) {
      var cls = 'step-row' + (r.failed ? ' failed' : '') + (r.status === 'running' ? ' running' : '');
      var mark = r.status === 'failed' ? '✕' : r.status === 'running' ? '●' : '›';
      var detail = r.detail
        ? '<div class="body">' + escapeHtml(r.detail) + '</div>'
        : '';
      // No body → plain row (not a disclosure)
      if (!r.detail && r.status !== 'running') {
        return '<div class="' + cls + '"><span class="chev">' + mark + '</span><span>' +
          escapeHtml(r.label) + '</span></div>';
      }
      return '<details class="' + cls + '"' + (r.open ? ' open' : '') + '>' +
        '<summary><span class="chev">' + mark + '</span><span>' + escapeHtml(r.label) + '</span></summary>' +
        detail + '</details>';
    }).join('') + '</div>';
  }

  function renderMessages(messages) {
    if (!messages.length) {
      messagesEl.innerHTML = emptyHtml();
      bindEmptyCtas();
      return;
    }
    var roleLabel = mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Plan' : 'Agent';
    var lastTurn = -1;
    messages.forEach(function (m, idx) {
      if (m.role === 'user') lastTurn = userTurnIndex(messages, idx);
    });
    var html = '';
    messages.forEach(function (m, idx) {
      if (m.role === 'user') {
        var turn = userTurnIndex(messages, idx);
        var canRestore = !busy;
        html += '<div class="msg user" data-idx="' + idx + '">' +
          '<div class="bubble"><div class="msg-body">' + escapeHtml(m.content) + '</div></div>' +
          (canRestore
            ? '<div class="restore-row"><button type="button" class="restore-btn" data-idx="' + idx + '">Restore checkpoint</button></div>'
            : '') +
          '</div>';
        var turnItems = timeline.filter(function (t) {
          var tt = t.turn;
          if (tt === undefined || tt === null) return turn === lastTurn;
          return tt === turn;
        });
        html += renderStepRows(turnItems);
        return;
      }
      var inner = renderAssistantBody(m.content);
      html += '<div class="msg assistant ' + (m.status || '') + '">' +
        '<div class="role">' + roleLabel + '</div>' + inner + '</div>';
    });
    messagesEl.innerHTML = html;
    messagesEl.querySelectorAll('.restore-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var idx = Number(btn.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: idx });
      });
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeAssistantContent(raw) {
    var text = String(raw || '');
    text = text.replace(/\\n\\n---\\n[\\s\\S]*$/m, '').trim();
    return text;
  }

  function renderAssistantBody(raw) {
    return '<div class="msg-body md">' + renderMarkdown(normalizeAssistantContent(raw)) + '</div>';
  }

  function renderMarkdown(src) {
    var text = escapeHtml(src);
    text = text.replace(/\`\`\`([\\w-]*)\\n([\\s\\S]*?)\`\`\`/g, function (_m, lang, code) {
      return '<pre><code class="lang-' + escapeHtml(lang) + '">' + code + '</code></pre>';
    });
    text = text.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g, '<a href="$2">$1</a>');
    text = text.replace(/^(#{1,4})\\s+(.+)$/gm, function (_m, hashes, title) {
      var n = hashes.length;
      return '<h' + n + '>' + title + '</h' + n + '>';
    });
    text = text.replace(/^(?:- |\\* )(.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>');
    text = text.replace(/\\n\\n/g, '</p><p>');
    text = '<p>' + text + '</p>';
    text = text.replace(/<p><\\/p>/g, '');
    text = text.replace(/<p>(<h[1-4]>)/g, '$1');
    text = text.replace(/(<\\/h[1-4]>)<\\/p>/g, '$1');
    text = text.replace(/<p>(<ul>)/g, '$1');
    text = text.replace(/(<\\/ul>)<\\/p>/g, '$1');
    text = text.replace(/<p>(<pre>)/g, '$1');
    text = text.replace(/(<\\/pre>)<\\/p>/g, '$1');
    return text;
  }

  messagesEl.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (a && a.href) {
      e.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: a.href });
    }
  });

  var clearBtn = document.getElementById('clearQueueBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'clearQueue' });
    });
  }

  bindEmptyCtas();
  syncModeChip();
  syncPermChip();
  syncSendButton();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
