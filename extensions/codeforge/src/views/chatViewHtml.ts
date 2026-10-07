/**
 * Webview HTML/CSS/JS for the Agent chat panel (Llama-UI inspired).
 * All user-facing strings are English.
 */

export interface ChatViewAssets {
	cspSource: string;
	markedJs: string;
	hljsJs: string;
	hljsCss: string;
	katexJs: string;
	katexCss: string;
	katexAutoRenderJs: string;
	mermaidJs: string;
}

export function getChatViewHtml(assets: ChatViewAssets): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${assets.cspSource} https: data:; style-src ${assets.cspSource} 'unsafe-inline'; script-src ${assets.cspSource} 'unsafe-inline'; font-src ${assets.cspSource} data:;">
<title>CodeForge AI</title>
<link rel="stylesheet" href="${assets.hljsCss}" />
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
  .tab-strip {
    flex-shrink: 0; display: flex; align-items: stretch; gap: 2px;
    padding: 4px 6px 0; border-bottom: 1px solid var(--vscode-panel-border);
    overflow-x: auto; background: var(--vscode-sideBar-background);
  }
  .tab {
    display: inline-flex; align-items: center; gap: 4px; max-width: 140px;
    padding: 5px 8px; border: 1px solid transparent; border-bottom: 0;
    border-radius: 6px 6px 0 0; background: transparent; color: var(--vscode-descriptionForeground);
    font: inherit; font-size: 0.78em; cursor: pointer; white-space: nowrap;
  }
  .tab.active {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background, var(--vscode-input-background));
    border-color: var(--vscode-panel-border);
  }
  .tab .title { overflow: hidden; text-overflow: ellipsis; }
  .tab .close {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    padding: 0 2px; line-height: 1; opacity: 0.6; font: inherit;
  }
  .tab .close:hover { opacity: 1; color: var(--vscode-errorForeground, #f48771); }
  .tab-add {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    cursor: pointer; padding: 4px 8px; font: inherit; font-size: 1em;
  }
  .tab-add:hover { color: var(--vscode-foreground); }
  .messages {
    flex: 1; overflow-y: auto; padding: 12px 10px 8px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .messages.hidden { display: none; }
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
  .msg-meta { font-size: 0.72em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .msg-meta .model { font-weight: 600; color: var(--vscode-foreground); margin-right: 6px; }
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
  .md strong { font-weight: 600; }
  .md table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .md .table-wrap { overflow-x: auto; margin: 0.55em 0; }
  .code-block {
    margin: 0.55em 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    overflow: hidden;
  }
  .code-toolbar {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.72em;
    color: var(--vscode-descriptionForeground);
  }
  .code-toolbar .lang { flex: 1; text-transform: lowercase; }
  .code-toolbar button {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font: inherit; padding: 2px 6px; border-radius: 4px;
  }
  .code-toolbar button:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .code-block pre {
    margin: 0; padding: 8px 10px; overflow: auto; max-height: 320px;
  }
  .code-block pre code { border: 0; background: transparent; padding: 0; font-size: 0.85em; white-space: pre; }
  .mermaid-wrap {
    margin: 0.55em 0; padding: 8px; overflow: auto;
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-editor-background, var(--vscode-input-background));
  }
  .thinking {
    margin: 0 0 8px; border-radius: 8px; overflow: hidden;
  }
  .thinking > summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 8px; font-size: 0.85em;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground);
  }
  .thinking > summary::-webkit-details-marker { display: none; }
  .thinking .spin { display: inline-block; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .thinking .body {
    margin: 6px 0 4px; padding: 2px 0 2px 12px;
    border-left: 2px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
    color: var(--vscode-descriptionForeground); font-size: 0.9em;
  }
  .msg-actions {
    display: flex; align-items: center; gap: 2px; margin-top: 4px; opacity: 0.55;
  }
  .msg.assistant:hover .msg-actions, .msg-actions:focus-within { opacity: 1; }
  .msg-actions button {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    cursor: pointer; width: 26px; height: 26px; border-radius: 4px;
    display: grid; place-items: center; font: inherit; font-size: 0.85em; padding: 0;
    position: relative;
  }
  .msg-actions button:hover {
    background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground);
  }
  .gauge-pop {
    display: none; position: absolute; bottom: 110%; left: 0; z-index: 8;
    min-width: 160px; padding: 8px 10px; text-align: left;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3); font-size: 0.78em; color: var(--vscode-foreground);
    white-space: normal;
  }
  .msg-actions button:hover .gauge-pop, .msg-actions button:focus .gauge-pop { display: block; }
  .gauge-pop b { display: block; margin-bottom: 2px; }
  .gauge-pop ul { margin: 0 0 6px; padding-left: 1.1em; color: var(--vscode-descriptionForeground); }

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

  .canvas-panel {
    display: none; flex: 1; flex-direction: column; min-height: 0;
    padding: 8px 10px; gap: 8px;
  }
  .canvas-panel.visible { display: flex; }
  .canvas-head {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  }
  .canvas-head strong { flex: 1; font-size: 0.9em; }
  .canvas-head button {
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background);
    color: var(--vscode-foreground); border-radius: 6px; padding: 3px 10px;
    font: inherit; font-size: 0.8em; cursor: pointer;
  }
  .canvas-code, .canvas-out {
    width: 100%; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family); font-size: 0.85em; padding: 8px;
    resize: vertical;
  }
  .canvas-code { flex: 1; min-height: 120px; }
  .canvas-out { flex: 1; min-height: 80px; white-space: pre-wrap; overflow: auto; }

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
  textarea#messageInput {
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
  .toast-busy {
    display: none; margin: 4px 10px 0; padding: 4px 8px; font-size: 0.75em;
    color: var(--vscode-descriptionForeground);
  }
  .toast-busy.visible { display: block; }
</style>
</head>
<body>
  <div class="tab-strip" id="tabStrip" role="tablist"></div>
  <div class="toast-busy" id="busyToast">Agent is running — stop it before switching or branching.</div>

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

  <div class="canvas-panel" id="canvasPanel">
    <div class="canvas-head">
      <strong>Python</strong>
      <button type="button" id="canvasRunBtn">Run</button>
      <button type="button" id="canvasStopBtn">Stop</button>
      <button type="button" id="canvasCloseBtn">Close</button>
    </div>
    <textarea class="canvas-code" id="canvasCode" spellcheck="false"></textarea>
    <pre class="canvas-out" id="canvasOut"></pre>
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

<script src="${assets.markedJs}"></script>
<script src="${assets.hljsJs}"></script>
<script>
  const vscode = acquireVsCodeApi();
  const LAZY = {
    katexCss: ${JSON.stringify(assets.katexCss)},
    katexJs: ${JSON.stringify(assets.katexJs)},
    katexAutoRenderJs: ${JSON.stringify(assets.katexAutoRenderJs)},
    mermaidJs: ${JSON.stringify(assets.mermaidJs)},
  };
  let katexPromise = null;
  let mermaidPromise = null;
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
  let openTabs = [];
  let activeTabId = null;
  let canvasOpen = false;
  let pythonRunning = false;
  let ttsUtterance = null;
  const ttsSupported = typeof speechSynthesis !== 'undefined';

  const MODES = [
    { id: 'agent', label: 'Agent', desc: 'Edits and runs tools' },
    { id: 'plan', label: 'Plan', desc: 'Explore and write a plan' },
    { id: 'ask', label: 'Ask', desc: 'Read/search/web — no edits' },
  ];

  const messagesEl = document.getElementById('messages');
  const tabStrip = document.getElementById('tabStrip');
  const busyToast = document.getElementById('busyToast');
  const canvasPanel = document.getElementById('canvasPanel');
  const canvasCode = document.getElementById('canvasCode');
  const canvasOut = document.getElementById('canvasOut');
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

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-lazy="' + src + '"]');
      if (existing && existing.getAttribute('data-loaded') === '1') { resolve(); return; }
      if (existing && existing.getAttribute('data-failed') === '1') {
        existing.remove();
      } else if (existing) {
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error(src)); });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.setAttribute('data-lazy', src);
      s.onload = function () { s.setAttribute('data-loaded', '1'); resolve(); };
      s.onerror = function () { s.setAttribute('data-failed', '1'); reject(new Error(src)); };
      document.body.appendChild(s);
    });
  }

  function ensureStylesheet(href) {
    if (document.querySelector('link[data-lazy="' + href + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-lazy', href);
    document.head.appendChild(link);
  }

  function ensureKatex() {
    if (window.renderMathInElement) return Promise.resolve();
    if (!katexPromise) {
      ensureStylesheet(LAZY.katexCss);
      katexPromise = loadScript(LAZY.katexJs).then(function () {
        return loadScript(LAZY.katexAutoRenderJs);
      }).catch(function (err) {
        katexPromise = null;
        throw err;
      });
    }
    return katexPromise;
  }

  function ensureMermaid() {
    if (window.mermaid) return Promise.resolve();
    if (!mermaidPromise) {
      mermaidPromise = loadScript(LAZY.mermaidJs).then(function () {
        try { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' }); } catch (e) {}
      }).catch(function (err) {
        mermaidPromise = null;
        throw err;
      });
    }
    return mermaidPromise;
  }

  function looksLikeMath(text) {
    return /\\$\\$[\\s\\S]+\\$\\$|\\$[^$\\n]+\\$|\\\\\\(|\\\\\\[/.test(String(text || ''));
  }

  function syncSendButton() {
    sendButton.disabled = false;
    if (busy) {
      sendButton.className = 'stop';
      sendButton.textContent = '■';
      sendButton.title = 'Stop';
    } else {
      sendButton.className = 'send';
      sendButton.textContent = '↑';
      sendButton.title = 'Send';
    }
    busyToast.classList.toggle('visible', !!busy);
  }

  function renderQueue(items) {
    queuedItems = items || [];
    queuePanel.classList.toggle('visible', queuedItems.length > 0);
    queueCount.textContent = String(queuedItems.length);
    queueList.innerHTML = queuedItems.map(function (item, i) {
      return '<div class="queue-item"><span class="idx">' + (i + 1) + '</span>' +
        '<span class="qtext">' + escapeHtml(item.text) + '</span>' +
        '<button type="button" data-id="' + escapeHtml(item.id) + '" title="Remove">×</button></div>';
    }).join('');
    queueList.querySelectorAll('.queue-item button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'removeQueued', id: btn.getAttribute('data-id') });
      });
    });
  }

  function permLabel(p) {
    return p === 'allowAll' ? 'Allow all' : p === 'assisted' ? 'Assisted' : 'Default';
  }
  function syncPermChip() { permChip.textContent = permLabel(permissions); }
  function syncModeChip() {
    const m = MODES.find(function (x) { return x.id === mode; }) || MODES[0];
    modeChip.textContent = m.label + ' ▾';
    modeMenu.querySelectorAll('.mode-item').forEach(function (el) {
      const id = el.getAttribute('data-mode');
      const active = id === mode;
      el.classList.toggle('active', active);
      const base = MODES.find(function (x) { return x.id === id; });
      if (base) {
        el.querySelector('.name').textContent = (active ? '✓ ' : '') + base.label;
      }
    });
  }
  function setMode(next) {
    mode = next;
    syncModeChip();
    vscode.postMessage({ type: 'setMode', mode: next });
    closeModeMenu();
  }
  function cycleMode() {
    const order = ['agent', 'plan', 'ask'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
  }
  function openModeMenu() { modeMenuOpen = true; modeMenu.classList.add('open'); }
  function closeModeMenu() { modeMenuOpen = false; modeMenu.classList.remove('open'); }

  function syncCtxRing() {
    const used = contextUsage && contextUsage.used ? contextUsage.used : 0;
    const limit = contextUsage && contextUsage.limit ? contextUsage.limit : 0;
    if (!limit || used <= 0) {
      ctxRing.classList.remove('visible');
      return;
    }
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const circ = 69.1;
    ctxArc.setAttribute('stroke-dashoffset', String(circ - (circ * pct) / 100));
    ctxPct.textContent = pct + '%';
    ctxRing.title = used + ' / ' + limit + ' tokens';
    ctxRing.classList.add('visible');
  }

  function syncChangesBar() {
    if (!editSummary || !editSummary.fileCount) {
      changesBar.classList.remove('visible');
      return;
    }
    changesBar.classList.add('visible');
    changesSummary.innerHTML =
      editSummary.fileCount + ' file' + (editSummary.fileCount === 1 ? '' : 's') + ' · ' +
      '<span class="plus">+' + (editSummary.added || 0) + '</span> ' +
      '<span class="minus">−' + (editSummary.removed || 0) + '</span>';
  }

  function sendOrStop() {
    if (busy) { vscode.postMessage({ type: 'cancel' }); return; }
    sendMessage();
  }
  function sendMessage() {
    const text = input.value.trim();
    if (!text && attachmentCount === 0) return;
    vscode.postMessage({ type: 'sendMessage', text: text, mode: mode });
    input.value = '';
    hideSlash();
  }

  function filterSlash(prefix) {
    const p = (prefix || '').toLowerCase();
    return slashCommands.filter(function (c) {
      return !p || c.name.toLowerCase().indexOf(p) === 0 || (c.description || '').toLowerCase().indexOf(p) >= 0;
    }).slice(0, 12);
  }
  function renderSlash() {
    if (!slashFiltered.length) { hideSlash(); return; }
    slashOpen = true;
    slashMenu.classList.add('open');
    slashMenu.innerHTML = slashFiltered.map(function (c, i) {
      return '<div class="slash-item' + (i === slashIndex ? ' active' : '') + '" data-i="' + i + '">' +
        '<span class="name">/' + escapeHtml(c.name) + '</span>' +
        '<span class="desc">' + escapeHtml(c.description || '') + '</span></div>';
    }).join('');
    slashMenu.querySelectorAll('.slash-item').forEach(function (el) {
      el.addEventListener('click', function () { applySlash(Number(el.getAttribute('data-i'))); });
    });
  }
  function applySlash(i) {
    const c = slashFiltered[i];
    if (!c) return;
    input.value = '/' + c.name + (c.insertSpace === false ? '' : ' ');
    hideSlash();
    input.focus();
  }
  function hideSlash() { slashOpen = false; slashMenu.classList.remove('open'); }
  function updateSlashFromInput() {
    const v = input.value;
    const m = /^\\/([\\w-]*)$/.exec(v);
    if (!m) { hideSlash(); return; }
    slashFiltered = filterSlash(m[1]);
    slashIndex = 0;
    renderSlash();
  }

  function renderTabs() {
    var html = openTabs.map(function (t) {
      var active = t.id === activeTabId;
      return '<button type="button" class="tab' + (active ? ' active' : '') + '" data-id="' + escapeHtml(t.id) + '" role="tab" aria-selected="' + active + '">' +
        '<span class="title">' + escapeHtml(t.title || 'Chat') + '</span>' +
        '<span class="close" data-close="' + escapeHtml(t.id) + '" title="Close">×</span></button>';
    }).join('');
    html += '<button type="button" class="tab-add" id="tabAdd" title="New chat">+</button>';
    tabStrip.innerHTML = html;
    tabStrip.querySelectorAll('.tab').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) return;
        vscode.postMessage({ type: 'switchTab', id: el.getAttribute('data-id') });
      });
    });
    tabStrip.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'closeTab', id: el.getAttribute('data-close') });
      });
    });
    var add = document.getElementById('tabAdd');
    if (add) add.addEventListener('click', function () { vscode.postMessage({ type: 'newChat' }); });
  }

  function showCanvas(code) {
    canvasOpen = true;
    canvasPanel.classList.add('visible');
    messagesEl.classList.add('hidden');
    canvasCode.value = code || '';
    canvasOut.textContent = '';
  }
  function hideCanvas() {
    canvasOpen = false;
    canvasPanel.classList.remove('visible');
    messagesEl.classList.remove('hidden');
    if (pythonRunning) vscode.postMessage({ type: 'stopPython' });
  }

  modeChip.addEventListener('click', function (e) {
    e.stopPropagation();
    if (modeMenuOpen) closeModeMenu(); else openModeMenu();
  });
  modeMenu.querySelectorAll('.mode-item').forEach(function (el) {
    el.addEventListener('click', function () { setMode(el.getAttribute('data-mode')); });
  });
  document.addEventListener('click', function (e) {
    if (!composerBox.contains(e.target)) closeModeMenu();
  });
  modelChip.addEventListener('click', function () { vscode.postMessage({ type: 'configure' }); });
  document.getElementById('attachBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'attachFiles' });
  });
  permChip.addEventListener('click', function () {
    var order = ['default', 'assisted', 'allowAll'];
    var next = order[(order.indexOf(permissions) + 1) % order.length];
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
  document.getElementById('canvasRunBtn').addEventListener('click', function () {
    canvasOut.textContent = '';
    vscode.postMessage({ type: 'runPython', code: canvasCode.value });
  });
  document.getElementById('canvasStopBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'stopPython' });
  });
  document.getElementById('canvasCloseBtn').addEventListener('click', hideCanvas);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = Math.min(slashIndex + 1, slashFiltered.length - 1); renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = Math.max(slashIndex - 1, 0); renderSlash(); return; }
      if (e.key === 'Enter') { e.preventDefault(); applySlash(slashIndex); return; }
      if (e.key === 'Escape') { hideSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendOrStop();
    }
  });
  input.addEventListener('input', updateSlashFromInput);
  sendButton.addEventListener('click', sendOrStop);

  ['dragenter', 'dragover'].forEach(function (ev) {
    composerBox.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation(); composerBox.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    composerBox.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave') composerBox.classList.remove('drag-over');
    });
  });
  composerBox.addEventListener('drop', function (e) {
    composerBox.classList.remove('drag-over');
    var dt = e.dataTransfer;
    if (!dt) return;
    var uriList = collectUriList(dt);
    if (uriList) vscode.postMessage({ type: 'attachUris', uriList: uriList });
    if (dt.files && dt.files.length) {
      readFilesAsBlobs(dt.files).then(function (blobs) {
        if (blobs.length) vscode.postMessage({ type: 'attachBlobs', blobs: blobs });
      });
    }
  });

  function collectUriList(dt) {
    try { return dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) { return ''; }
  }
  function readFilesAsBlobs(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(function (f) {
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || '');
          var base64 = result.indexOf(',') >= 0 ? result.split(',')[1] : result;
          resolve({ name: f.name, mime: f.type || 'application/octet-stream', base64: base64 });
        };
        reader.onerror = function () { resolve(null); };
        reader.readAsDataURL(f);
      });
    })).then(function (rows) { return rows.filter(Boolean); });
  }

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
    if (msg.type === 'tabs') {
      openTabs = msg.open || [];
      activeTabId = msg.active || null;
      if (typeof msg.busy === 'boolean') busy = msg.busy;
      renderTabs();
      syncSendButton();
    }
    if (msg.type === 'updateMessages') {
      if (msg.timeline) timeline = msg.timeline;
      if (typeof msg.busy === 'boolean') busy = msg.busy;
      renderMessages(msg.messages || []);
      syncSendButton();
    }
    if (msg.type === 'focusInput') { input.focus(); }
    if (msg.type === 'restorePrompt') {
      input.value = msg.text || '';
      input.focus();
    }
    if (msg.type === 'pythonStatus') {
      pythonRunning = !!msg.running;
    }
    if (msg.type === 'pythonChunk') {
      canvasOut.textContent += msg.text || '';
      canvasOut.scrollTop = canvasOut.scrollHeight;
    }
    if (msg.type === 'pythonResult') {
      pythonRunning = false;
      if (msg.output != null) canvasOut.textContent = msg.output;
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
      if (t.kind === 'thought' || t.kind === 'context' || t.kind === 'thinking' || t.kind === 'compact') {
        return;
      }
      var st = t.toolStatus || (t.success === false ? 'failed' : t.success ? 'ok' : 'running');
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
        rows.push({
          kind: 'tool',
          label: prettyToolLabel(t),
          detail: cleanDetail(t.detail),
          open: st === 'running',
          status: st,
          failed: st === 'failed',
        });
        return;
      }
      if (t.kind === 'checkpoint') {
        if (/^(hook|Lesson|Oracle|LLM |Repaired|Retry|Nuked|Switched|Parsed|Truncated|Build-fix|context |Phase:|Prior context|Turn summary|Stopped)/i.test(String(t.label || '')) ||
            /\\bindexed\\b/i.test(String(t.label || '')) ||
            /^contextBudget\\b/i.test(String(t.label || '')) ||
            /^Thinking/i.test(String(t.label || ''))) {
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
      if (!r.detail && r.status !== 'running') {
        return '<div class="' + cls + '"><span class="chev">' + mark + '</span><span>' +
          escapeHtml(r.label) + '</span></div>';
      }
      return '<details class="' + cls + '"' + (r.open ? ' open' : '') + '>' +
        '<summary><span class="chev">' + mark + '</span><span>' + escapeHtml(r.label) + '</span></summary>' +
        detail + '</details>';
    }).join('') + '</div>';
  }

  function splitThink(content) {
    var text = String(content || '');
    var openRe = /<think>|<\\|channel\\|>analysis<\\|message\\|>/;
    var closeRe = /<\\/think>|<\\|start\\|>assistant<\\|channel\\|>final<\\|message\\|>/;
    if (!openRe.test(text)) return { content: text, reasoning: '' };
    var actual = '';
    var thought = '';
    var parts = text.split(openRe);
    actual += parts[0] || '';
    for (var i = 1; i < parts.length; i++) {
      var chunk = parts[i].split(closeRe);
      thought += chunk[0] || '';
      actual += chunk.slice(1).join('') || '';
    }
    return { content: actual.trim(), reasoning: thought.trim() };
  }

  function formatTime(ts) {
    try {
      var d = ts instanceof Date ? ts : new Date(ts);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function renderThinking(reasoning, isPending) {
    if (!reasoning) return '';
    var label = isPending ? '<span class="spin">⚛</span> Thinking' : '🤖 Reasoning';
    return '<details class="thinking"' + (isPending ? ' open' : '') + '>' +
      '<summary>' + label + '</summary>' +
      '<div class="body md">' + renderMarkdown(reasoning) + '</div></details>';
  }

  function renderGauge(timings) {
    if (!timings) return '';
    var has =
      timings.promptTokens || timings.completionTokens || timings.durationMs || timings.tokensPerSecond;
    if (!has) return '';
    var html = '<button type="button" class="gauge-btn" title="Performance" aria-label="Performance">⏱' +
      '<div class="gauge-pop">';
    if (timings.promptTokens) {
      html += '<b>Prompt</b><ul><li>Tokens: ' + Math.round(timings.promptTokens) + '</li></ul>';
    }
    if (timings.completionTokens || timings.durationMs || timings.tokensPerSecond) {
      html += '<b>Generation</b><ul>';
      if (timings.completionTokens) html += '<li>Tokens: ' + Math.round(timings.completionTokens) + '</li>';
      if (timings.durationMs) html += '<li>Time: ' + Math.round(timings.durationMs) + ' ms</li>';
      if (timings.tokensPerSecond) html += '<li>Speed: ' + Number(timings.tokensPerSecond).toFixed(1) + ' t/s</li>';
      html += '</ul>';
    }
    html += '</div></button>';
    return html;
  }

  function renderActions(m, idx, isPending) {
    if (isPending || m.role !== 'assistant') return '';
    var html = '<div class="msg-actions">';
    html += '<button type="button" data-act="copy" data-idx="' + idx + '" title="Copy">⧉</button>';
    html += renderGauge(m.timings);
    if (ttsSupported) {
      html += '<button type="button" data-act="tts" data-idx="' + idx + '" title="Play">🔊</button>';
    }
    if (!busy) {
      html += '<button type="button" data-act="regen" data-idx="' + idx + '" title="Regenerate">↻</button>';
      html += '<button type="button" data-act="branch" data-idx="' + idx + '" title="Branch chat">⑂</button>';
    }
    html += '</div>';
    return html;
  }

  function renderMessages(messages) {
    if (canvasOpen) return;
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
        // Tool/harness activity stays off the chat surface (Llama-style replies only).
        return;
      }
      var split = splitThink(m.content);
      var reasoning = m.reasoning || split.reasoning;
      var body = split.content;
      var isPending = m.status === 'pending';
      var time = formatTime(m.timestamp);
      html += '<div class="msg assistant ' + (m.status || '') + '" data-idx="' + idx + '">' +
        '<div class="msg-meta">' +
          (m.model ? '<span class="model">' + escapeHtml(m.model) + '</span>' : '<span class="model">' + roleLabel + '</span>') +
          (time ? '<span>' + escapeHtml(time) + '</span>' : '') +
        '</div>' +
        renderThinking(reasoning, isPending && !body) +
        '<div class="msg-body md">' + renderMarkdown(normalizeAssistantContent(body)) + '</div>' +
        renderActions(m, idx, isPending) +
        '</div>';
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
    messagesEl.querySelectorAll('.msg-actions button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var act = btn.getAttribute('data-act');
        var idx = Number(btn.getAttribute('data-idx'));
        var m = messages[idx];
        if (!m) return;
        if (act === 'copy') {
          copyText(m.content || '');
          return;
        }
        if (act === 'tts') {
          toggleTts(m.content || '', btn);
          return;
        }
        if (act === 'regen') {
          vscode.postMessage({ type: 'regenerate', messageIndex: idx });
          return;
        }
        if (act === 'branch') {
          vscode.postMessage({ type: 'branchAt', messageIndex: idx });
        }
      });
    });
    messagesEl.querySelectorAll('button[data-copy-code]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.getAttribute('data-copy-code') || '');
      });
    });
    messagesEl.querySelectorAll('button[data-run-python]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showCanvas(btn.getAttribute('data-run-python') || '');
      });
    });
    enhanceMathAndMermaid(messagesEl, messages);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function toggleTts(text, btn) {
    if (!ttsSupported) return;
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      btn.textContent = '🔊';
      btn.title = 'Play';
      return;
    }
    var plain = String(text || '').replace(/[#*_\\\`\\[\\]()]/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!plain) return;
    ttsUtterance = new SpeechSynthesisUtterance(plain);
    ttsUtterance.rate = 1;
    ttsUtterance.onend = function () { btn.textContent = '🔊'; btn.title = 'Play'; };
    btn.textContent = '⏹';
    btn.title = 'Stop';
    speechSynthesis.speak(ttsUtterance);
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

  function preprocessLatex(content) {
    var codeBlocks = [];
    var text = String(content || '').replace(/(\`\`\`[\\s\\S]*?\`\`\`|\`[^\`\\n]*\`)/g, function (m) {
      var i = codeBlocks.length;
      codeBlocks.push(m);
      return '<<CODE_BLOCK_' + i + '>>';
    });
    text = text.replace(/\\\\\\[([\\s\\S]*?)\\\\\\]/g, function (_m, inner) {
      return '\\n$$' + inner + '$$\\n';
    });
    text = text.replace(/\\\\\\(([\\s\\S]*?)\\\\\\)/g, function (_m, inner) {
      return '$' + inner + '$';
    });
    text = text.replace(/<<CODE_BLOCK_(\\d+)>>/g, function (_m, i) { return codeBlocks[Number(i)] || ''; });
    return text;
  }

  function renderMarkdown(src) {
    var text = preprocessLatex(src);
    if (window.marked) {
      try {
        marked.setOptions({
          gfm: true,
          breaks: true,
          highlight: function (code, lang) {
            if (window.hljs) {
              try {
                if (lang && hljs.getLanguage(lang)) {
                  return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlightAuto(code).value;
              } catch (e) {}
            }
            return escapeHtml(code);
          },
        });
        var rendered = marked.parse(text);
        return postProcessMarkdownHtml(rendered);
      } catch (e) {
        /* fall through */
      }
    }
    return legacyMarkdown(text);
  }

  function postProcessMarkdownHtml(html) {
    var div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('pre').forEach(function (pre) {
      var code = pre.querySelector('code');
      var cls = (code && code.className) || '';
      var langMatch = /language-([\\w-]+)/.exec(cls);
      var lang = langMatch ? langMatch[1] : '';
      var raw = code ? code.textContent || '' : pre.textContent || '';
      if (lang.toLowerCase() === 'mermaid') {
        var wrap = document.createElement('div');
        wrap.className = 'mermaid-wrap';
        wrap.setAttribute('data-mermaid', raw);
        wrap.textContent = 'Rendering diagram…';
        pre.parentNode.replaceChild(wrap, pre);
        return;
      }
      var block = document.createElement('div');
      block.className = 'code-block';
      var toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.innerHTML = '<span class="lang">' + escapeHtml(lang || 'code') + '</span>' +
        (lang.toLowerCase() === 'python'
          ? '<button type="button" data-run-python="' + escapeHtml(raw).replace(/"/g, '&quot;') + '">Run</button>'
          : '') +
        '<button type="button" data-copy-code="' + escapeHtml(raw).replace(/"/g, '&quot;') + '">Copy</button>';
      // data attributes with full code can break on quotes — set after
      block.appendChild(toolbar);
      block.appendChild(pre.cloneNode(true));
      pre.parentNode.replaceChild(block, pre);
      var copyBtn = toolbar.querySelector('[data-copy-code]');
      if (copyBtn) {
        copyBtn.removeAttribute('data-copy-code');
        copyBtn.setAttribute('data-copy-code', '1');
        copyBtn._code = raw;
      }
      var runBtn = toolbar.querySelector('[data-run-python]');
      if (runBtn) {
        runBtn.removeAttribute('data-run-python');
        runBtn.setAttribute('data-run-python', '1');
        runBtn._code = raw;
      }
    });
    div.querySelectorAll('table').forEach(function (table) {
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    // Fix buttons: use stored _code via query after insert — handled in renderMessages via rebind
    // Rebuild toolbar buttons properly without broken attributes
    div.querySelectorAll('.code-toolbar').forEach(function (toolbar) {
      var block = toolbar.parentElement;
      var pre = block && block.querySelector('pre');
      var codeEl = pre && pre.querySelector('code');
      var raw = codeEl ? codeEl.textContent || '' : '';
      var langEl = toolbar.querySelector('.lang');
      var lang = langEl ? langEl.textContent : '';
      toolbar.innerHTML = '<span class="lang">' + escapeHtml(lang || 'code') + '</span>' +
        (String(lang).toLowerCase() === 'python'
          ? '<button type="button" class="run-py">Run</button>' : '') +
        '<button type="button" class="copy-code">Copy</button>';
      var copy = toolbar.querySelector('.copy-code');
      if (copy) copy.addEventListener('click', function () { copyText(raw); });
      var run = toolbar.querySelector('.run-py');
      if (run) run.addEventListener('click', function () { showCanvas(raw); });
    });
    return div.innerHTML;
  }

  function renderMath(root) {
    if (!window.renderMathInElement) return;
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: '$$$$', right: '$$$$', display: true },
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\\\(', right: '\\\\)', display: false },
          { left: '\\\\[', right: '\\\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch (e) {}
  }

  function renderMermaidNodes(nodes) {
    nodes.forEach(function (el, i) {
      var code = el.getAttribute('data-mermaid') || '';
      var id = 'mmd-' + Date.now() + '-' + i;
      mermaid.render(id, code).then(function (res) {
        el.innerHTML = res.svg;
      }).catch(function () {
        el.innerHTML = '<pre><code>' + escapeHtml(code) + '</code></pre>';
      });
    });
  }

  function enhanceMathAndMermaid(root, messages) {
    var mermaidNodes = Array.prototype.slice.call(root.querySelectorAll('[data-mermaid]'));
    var needsMath = looksLikeMath(root.textContent) || (messages || []).some(function (m) {
      return looksLikeMath(m && (m.content || m.reasoning));
    });
    if (!mermaidNodes.length && !needsMath) return;
    if (needsMath) {
      ensureKatex().then(function () { renderMath(root); }).catch(function () {});
    }
    if (mermaidNodes.length) {
      ensureMermaid().then(function () { renderMermaidNodes(mermaidNodes); }).catch(function () {
        mermaidNodes.forEach(function (el) {
          var code = el.getAttribute('data-mermaid') || '';
          el.innerHTML = '<pre><code>' + escapeHtml(code) + '</code></pre>';
        });
      });
    }
  }

  function legacyMarkdown(src) {
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
  renderTabs();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
