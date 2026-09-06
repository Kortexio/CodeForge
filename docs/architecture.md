# OpenCodeIDE Architecture

## Overview

OpenCodeIDE is an AI-native code editor built on Code-OSS with a fully embedded AI platform. The architecture follows the principle of **one product, one installation** - all AI capabilities are built into the IDE without requiring external services.

## Core Principles

1. **Single Application**: Everything runs within the IDE process or managed child processes
2. **No External Dependencies**: No Docker, no separate ContextMemory service
3. **Model Independence**: Works with any LLM provider
4. **Local-First**: Full functionality without cloud services

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenCodeIDE                            │
│                      Code-OSS Base                          │
├─────────────────────────────────────────────────────────────┤
│  Editor │ Explorer │ Git │ Terminal │ Debug │ Extensions   │
├─────────────────────────────────────────────────────────────┤
│                  Embedded AI Platform                       │
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
├─────────────────────────────────────────────────────────────┤
│                    Model Providers                          │
│     Cloud (OpenAI/Anthropic) │ Local (Ollama) │ Custom     │
└─────────────────────────────────────────────────────────────┘
```

## Component Overview

### Agent Runtime

The agent runtime executes tasks using an iterative loop with a formal state machine:

- **State Machine**: Manages lifecycle (created → planning → executing → completed)
- **Tool Execution**: Runs native and MCP tools
- **Compaction**: Manages context window through rolling summaries
- **Recovery**: Handles errors and retries

### Context Engine

Builds enriched context for LLM requests:

- **Budget Allocation**: Distributes tokens across context sources
- **Source Ranking**: Prioritizes relevant information
- **Compression**: Summarizes long histories

### Memory Engine

Persistent memory across sessions:

- **Session Wiki**: Per-task memory with pages and working memory
- **Project Wiki**: Cross-session project knowledge
- **Temporal Facts**: Track changes over time

### Tool Runtime

Native tools for workspace operations:

- File operations (read, write, delete, rename)
- Search (ripgrep-based)
- Shell execution (sandboxed)
- Editor integration

### Model Router

Routes requests to LLM providers:

- **Harness Modes**: Strong (native tool calls) vs Weak (prose parsing)
- **Capability Normalization**: Handles provider differences
- **Multiple Providers**: OpenAI, Anthropic, Ollama, custom

### Policy Engine

Security and permissions:

- **Guardrails**: Prevent dangerous operations
- **HITL**: Human-in-the-loop approvals
- **Risk Assessment**: Evaluate tool call safety

### MCP Runtime

Model Context Protocol integration:

- **Inbound**: IDE consumes external MCP tools
- **Outbound**: IDE exposes wiki to external clients
- **Transport**: HTTP and stdio support

### Sandbox Runtime

Secure command execution:

- **Levels**: safe-local, restricted, isolated, container
- **Platform-specific**: Windows Job Objects, Linux seccomp, macOS sandbox-exec
- **No Docker Required**: Native isolation by default

## Data Flow

1. **User Request** → Agent Runtime
2. **Context Assembly** → Context Engine + Memory Engine
3. **LLM Request** → Model Router → Provider
4. **Tool Calls** → Tool Runtime / MCP Runtime
5. **Validation** → Policy Engine
6. **Memory Update** → Memory Engine
7. **Response** → User

## Storage

```
~/.opencodeide/
├── settings/           # User preferences
├── ai/
│   ├── sessions/      # Session data
│   ├── memory/        # Project memory
│   ├── artifacts/     # Large outputs
│   ├── traces/        # Execution logs
│   ├── policies/      # Custom policies
│   └── skills/        # Installed skills
├── code-index/        # Repository index
└── model-cache/       # Cached models
```

## Security Model

1. **Policy Evaluation**: Before each tool call
2. **Approval Flow**: For dangerous operations
3. **Sandbox Execution**: For shell commands
4. **Secret Protection**: API keys isolated from agent
5. **Network Control**: Configurable egress rules
