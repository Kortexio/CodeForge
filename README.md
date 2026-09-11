# CodeForge

**An open-source, model-independent, memory-native, agentic coding IDE.**

CodeForge is an AI-native code editor built on Code-OSS with a fully embedded AI platform. One installation, no Docker required.

> **Shipped surface:** `extensions/codeforge/` (built into `CodeForge.exe`). The legacy `src/` tree is frozen reference code and will be removed.

## Features

- **Embedded AI Platform**: Complete AI capabilities built into the IDE
- **Model Independence**: Use OpenAI, Anthropic, Google, Ollama, or any OpenAI-compatible provider
- **Persistent Memory**: Session wiki, project wiki, and temporal facts on disk
- **Multi-file Agent**: AI agent that can plan, edit, and validate changes across your codebase
- **Code Intelligence**: Hybrid search (lexical + semantic embeddings)
- **MCP Support**: Inbound tools + outbound wiki server
- **Tab Completion**: Low-latency inline completions with your model
- **Browser Agent**: Visual testing and web automation (Playwright optional)
- **Git Intelligence**: Status, diff, blame, conflicts, commit messages
- **Sandbox**: safe-local / restricted / isolated shell levels

## Quick Start

### Full IDE (Code-OSS + AI extension)

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

## Architecture

```
CodeForge/
├── extensions/codeforge/   # Shipped AI platform (source of truth)
│   ├── src/agent/               # Agent loop, context, wiki hooks
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

### Model Providers

Configure your preferred AI model provider in **CodeForge AI Settings** (or Settings JSON):

```json
{
  "codeforge.ai.provider": "anthropic",
  "codeforge.ai.apiKey": "your-api-key",
  "codeforge.ai.model": "claude-3-sonnet-20240229"
}
```

Supported providers:
- OpenAI
- Anthropic
- Google (Gemini)
- xAI (Grok)
- OpenRouter
- Ollama (local)
- vLLM (self-hosted)
- LM Studio (local)
- Any OpenAI-compatible endpoint

### MCP Servers

```json
{
  "CodeForge.mcp.servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"]
    }
  ]
}
```

## Development

### Prerequisites

- Node.js matching `vscode/.nvmrc` (for full IDE builds)
- npm
- Git
- On Windows: Visual Studio C++ workload + Spectre-mitigated libs

### Building

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

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a Pull Request.

## Acknowledgments

- Built on [Code-OSS](https://github.com/microsoft/vscode), the open-source foundation of Visual Studio Code
- Inspired by modern AI coding assistants
- Powered by open AI research and models
