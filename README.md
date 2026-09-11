# CodeForge

[![GitHub release](https://img.shields.io/github/v/release/Kortexio/CodeForge?include_prereleases&sort=semver)](https://github.com/Kortexio/CodeForge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Kortexio/CodeForge/ci.yml?branch=master&label=CI)](https://github.com/Kortexio/CodeForge/actions)

**An open-source, model-independent, memory-native, agentic coding IDE.**

CodeForge is an AI-native code editor built on [Code-OSS](https://github.com/microsoft/vscode). One Windows install, your own models (cloud or local), no Docker required.

> **Download:** [Latest Windows installer](https://github.com/Kortexio/CodeForge/releases/latest) · **Source of truth:** [`extensions/codeforge/`](extensions/codeforge/)

## Why CodeForge?

| | CodeForge |
|---|---|
| Models | OpenAI, Anthropic, Gemini, xAI, OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible API |
| Agent | Multi-file agent with approvals, Plan / Ask / Agent / Auto modes |
| Weak local models | Auto harness for ~≤34B models (plan-first, TDD gate, build-after-write) |
| Memory | Session wiki, project wiki, stable facts on disk (`~/.CodeForge/`) |
| Governance | Editable skills, rules, policies, hard guardrails |
| MCP | Inbound tools + outbound wiki server |

## Install (Windows)

1. Open **[Releases](https://github.com/Kortexio/CodeForge/releases/latest)**
2. Download `CodeForge-Setup-*-win32-x64.exe`
3. Run the installer (per-user under `%LOCALAPPDATA%\Programs\CodeForge`)

Or build from source (below).

## Quick Start (development)

```bash
git clone https://github.com/Kortexio/CodeForge.git
cd CodeForge
npm install
npm run vscode:setup      # clone Code-OSS, brand, install deps
npm run build:extensions # compile AI extension
npm run vscode:compile   # compile editor (first time is slow)
npm run vscode:dev       # launch CodeForge with AI sidebar
```

See [docs/code-oss-integration.md](docs/code-oss-integration.md) for details.

## Features

- **Embedded AI Platform** — agent, chat, settings, and tools inside the IDE
- **Model Independence** — bring your own API keys or local servers
- **Plan mode** — explore + write a wiki plan without mutating source
- **Weak-model harness** — automatic tighter guardrails for small/local LLMs
- **Persistent Memory** — session/project wiki and temporal facts
- **Code Intelligence** — hybrid search (lexical + semantic embeddings)
- **MCP Support** — inbound tools + outbound wiki server
- **Tab Completion** — inline completions with your model
- **Browser Agent** — visual checks (Playwright optional)
- **Git Intelligence** — status, diff, blame, conflicts, commit messages

## Architecture

```
CodeForge/
├── extensions/codeforge/   # Shipped AI platform (source of truth)
│   ├── src/agent/               # Agent loop, context, weak-model harness
│   ├── src/memory/              # Session + project wiki + temporal facts
│   ├── src/storage/             # ~/.CodeForge paths, sessions, artifacts, traces
│   ├── src/context/             # Context budget / ranking
│   ├── src/sandbox/             # Shell isolation levels
│   ├── src/intelligence/        # Index, LSP, git, embeddings
│   ├── src/browser/             # Browser agent
│   ├── src/mcp/                 # Inbound + outbound MCP
│   └── src/governance/          # Skills, rules, guardrails, HITL
├── docs/                        # Documentation
├── tests/                       # Test suites
└── scripts/                     # Code-OSS setup / package
```

See [docs/architecture.md](docs/architecture.md) for the full component model.

## Configuration

Prefer **CodeForge Settings** (Models / MCP / Guardrails / Agent) in the app.

Legacy mirrors (active server only):

```json
{
  "codeforge.ai.mode": "agent",
  "codeforge.ai.weakModelMode": "auto"
}
```

Supported providers: OpenAI, Anthropic, Google (Gemini), xAI, OpenRouter, Ollama, vLLM, LM Studio, custom OpenAI-compatible endpoints.

## Development

### Prerequisites

- Node.js matching `vscode/.nvmrc` (for full IDE builds)
- npm, Git
- On Windows: Visual Studio C++ workload + Spectre-mitigated libs

### Building & tests

```bash
npm install
npm run build:extensions
npm test
```

### Packaging (Windows)

```bash
# Installer + portable + zip (recommended for distribution)
npm run vscode:package:win

# Installer only (from existing portable build)
npm run installer:win
```

Requires Inno Setup: `winget install JRSoftware.InnoSetup`

Artifact: `dist/codeforge-win32-x64/CodeForge-Setup-<version>-win32-x64.exe`

## Discoverability

Search on GitHub for **CodeForge**, **AI coding IDE**, or topics below.

- Repo: [github.com/Kortexio/CodeForge](https://github.com/Kortexio/CodeForge)
- Releases: [github.com/Kortexio/CodeForge/releases](https://github.com/Kortexio/CodeForge/releases)
- Topics: `ide` · `ai` · `vscode` · `code-oss` · `openai` · `ollama` · `agent` · `mcp` · `electron` · `typescript`

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a Pull Request.

## Acknowledgments

- Built on [Code-OSS](https://github.com/microsoft/vscode), the open-source foundation of Visual Studio Code
- Inspired by modern AI coding assistants
- Powered by open AI research and models
