# CodeForge Architecture

## Overview

CodeForge is an AI-native code editor built on Code-OSS with a fully embedded AI platform. The architecture follows the principle of **one product, one installation** — all AI capabilities live in the built-in extension `extensions/codeforge/`.

> **Source of truth:** the shipped IDE runs only `extensions/codeforge/`. The legacy `src/` tree is frozen and scheduled for removal; do not add features there.

## Core Principles

1. **Single Application**: Everything runs within the IDE process or managed child processes
2. **No External Dependencies**: No Docker required by default, no separate ContextMemory service
3. **Model Independence**: Works with any LLM provider
4. **Local-First**: Full functionality without cloud services
5. **Extension-native**: Packaging syncs one built-in extension into Code-OSS

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      CodeForge                              │
│                      Code-OSS Base                          │
├─────────────────────────────────────────────────────────────┤
│  Editor │ Explorer │ Git │ Terminal │ Debug │ Extensions   │
├─────────────────────────────────────────────────────────────┤
│         Embedded AI Platform (codeforge)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │  Agent   │ │ Context  │ │  Memory  │ │  Tools   │      │
│  │ Runtime  │ │  Engine  │ │  Engine  │ │ Runtime  │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │   MCP    │ │  Skills  │ │  Rules   │ │  Policy  │      │
│  │ Runtime  │ │  Engine  │ │  Engine  │ │  Engine  │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ Sandbox  │ │Artifacts │ │Subagents │ │  Models  │      │
│  │ Runtime  │ │  Store   │ │Orchestr. │ │  Router  │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
├─────────────────────────────────────────────────────────────┤
│              Code Intelligence │ Git Intelligence           │
│              Browser Agent                                  │
├─────────────────────────────────────────────────────────────┤
│                    Model Providers                          │
│     Cloud (OpenAI/Anthropic) │ Local (Ollama) │ Custom     │
└─────────────────────────────────────────────────────────────┘
```

## Component Overview

### Agent Runtime

Iterative tool-calling loop with checkpoints and recovery:

- Lifecycle states (created → planning → executing → completed / failed)
- Native + MCP tools
- Rolling compaction + session wiki facts that survive compaction
- Progress review / budget extension

### Context Engine

Builds enriched context for LLM requests:

- Budget allocation across wiki, IDE, retrieve, git, MCP, history
- Source ranking (active wiki / open file first)
- Compression via rolling summary + wiki

### Memory Engine

Persistent memory across sessions:

- **Session Wiki**: Per-session Markdown pages + working memory
- **Project Wiki**: Cross-session project knowledge under `{workspace}/.CodeForge/memory/`
- **Temporal Facts**: `validFrom` / `validTo` with supersede

### Tool Runtime

Native tools for workspace operations:

- File operations (read, write, delete, rename)
- Search (ripgrep-based) + hybrid retrieve
- Shell execution (sandboxed levels)
- Editor / LSP / Git / Browser / Wiki

### Model Router

Routes requests to LLM providers:

- Strong (native tool calls) vs Weak (prose parsing)
- OpenAI, Anthropic, Google, xAI, OpenRouter, Ollama, vLLM, LM Studio, custom

### Policy Engine

Security and permissions:

- Guardrails, HITL approvals, auto-approve modes
- Risk-aware sandbox level selection
- Secret scrubbing from child process env

### MCP Runtime

- **Inbound**: IDE consumes external MCP tools (stdio env is allowlisted — not full `process.env`; `@latest` package tags are refused)
- **Outbound**: Opt-in (`codeforge.ai.outboundMcp.enabled`, default off). When enabled, loopback HTTP requires `Authorization: Bearer` from SecretStorage
- Transport: HTTP and stdio

### Sandbox Runtime

- Levels: `safe-local`, `restricted`, `isolated`, `container` (Docker optional), `unrestricted`
- **isolated** (Windows): Job Object via `koffi` with `KILL_ON_JOB_CLOSE` — fails visibly if unavailable (no silent downgrade to restricted)
- **container**: Docker with `--network=none` and non-root user when Docker is present
- Default: `restricted` (env scrub + dangerous-command blocklist). No general egress firewall outside container / `web_fetch` SSRF checks

### Artifacts / Traces

Large tool/LLM outputs and execution traces under `~/.CodeForge/ai/`. Trace details are redacted for common API-key / Bearer patterns before OutputChannel + JSONL.

## Data Flow

1. **User Request** → Agent Runtime
2. **Context Assembly** → Context Engine + Memory Engine
3. **LLM Request** → Model Router → Provider
4. **Tool Calls** → Tool Runtime / MCP Runtime / Sandbox
5. **Validation** → Policy Engine
6. **Memory Update** → Memory Engine
7. **Response** → User

## Storage

```
~/.CodeForge/
├── skills/                 # User skills
├── rules/                  # User rules
├── ai/
│   ├── sessions/{id}/      # Chat + session wiki
│   ├── memory/{wsHash}/    # Fallback project memory
│   ├── artifacts/          # Large outputs
│   ├── traces/             # Execution logs
│   └── policies/           # Custom policies
├── code-index/{wsHash}/    # Repository index
└── model-cache/            # Cached embeddings / models

{workspace}/.CodeForge/
└── memory/                 # Project wiki + temporal facts
```

## Security Model

1. **Policy Evaluation**: Before each tool call
2. **Approval Flow**: For dangerous operations (Python Run confirm defaults on)
3. **Sandbox Execution**: For shell commands (Job Object on Windows `isolated`)
4. **Secret Protection**: API keys in SecretStorage; scrubbed from shell/MCP host env; deleted on server remove
5. **Fetch SSRF**: `web_fetch` blocks loopback / private / link-local / cloud-metadata hosts (including redirects)
6. **Workspace Trust**: Enabled in branded product defaults (`security.workspace.trust.enabled`)
7. **Extension signature verify**: Still off for Code-OSS (`extensions.verifySignature: false`) until Marketplace signing exists — documented, not claimed as verified
