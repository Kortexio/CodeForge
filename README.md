# OpenCodeIDE

**An open-source, model-independent, memory-native, agentic coding IDE.**

OpenCodeIDE is an AI-native code editor built on Code-OSS with a fully embedded AI platform. One installation, no external dependencies, no Docker required.

## Features

- **Embedded AI Platform**: Complete AI capabilities built into the IDE
- **Model Independence**: Use OpenAI, Anthropic, Google, Ollama, or any OpenAI-compatible provider
- **Persistent Memory**: Project Brain and session memory that persists across sessions
- **Multi-file Agent**: AI agent that can plan, edit, and validate changes across your codebase
- **Code Intelligence**: Hybrid search combining lexical, structural, and semantic retrieval
- **MCP Support**: Model Context Protocol for extensibility
- **Tab Completion**: Low-latency inline completions
- **Browser Agent**: Visual testing and web automation
- **Git Intelligence**: AI-powered commit messages, PR descriptions, and conflict resolution

## Quick Start

### AI Platform only (library + Electron shell)

```bash
git clone https://github.com/Kortexio/OpenCodeIDE.git
cd OpenCodeIDE
npm install
npm run verify
npm start
```

### Full IDE (Code-OSS + AI extension)

```bash
npm run vscode:setup      # clone Code-OSS, brand, install deps
npm run vscode:compile    # compile editor (first time is slow)
npm run vscode:dev        # launch OpenCodeIDE with AI sidebar
```

See [docs/code-oss-integration.md](docs/code-oss-integration.md) for details.

## Architecture

```
OpenCodeIDE/
├── src/
│   ├── ai/                    # Embedded AI Platform
│   │   ├── agent/             # Agent Runtime + State Machine
│   │   ├── context/           # Context Engine + Budget
│   │   ├── memory/            # Session + Project Memory
│   │   ├── tools/             # Native Tools
│   │   ├── mcp/               # MCP Runtime
│   │   ├── skills/            # Skills Engine
│   │   ├── rules/             # Rules Engine
│   │   ├── policy/            # Guardrails + HITL
│   │   ├── sandbox/           # Execution Sandbox
│   │   ├── artifacts/         # Artifact Management
│   │   ├── subagents/         # Subagent Orchestration
│   │   ├── models/            # Model Router + Providers
│   │   └── trace/             # Execution Tracing
│   ├── code-intelligence/     # AST, LSP, Semantic Search
│   ├── git-intelligence/      # Git Reasoning
│   ├── browser/               # Browser Automation
│   └── terminal/              # Terminal Integration
├── extensions/                # VS Code compatible extensions
├── docs/                      # Documentation
├── tests/                     # Test suites
└── benchmarks/                # Performance benchmarks
```

## Configuration

### Model Providers

Configure your preferred AI model provider in Settings:

```json
{
  "opencodeide.ai.provider": "anthropic",
  "opencodeide.ai.apiKey": "your-api-key",
  "opencodeide.ai.model": "claude-3-sonnet-20240229"
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

Configure MCP servers for extended capabilities:

```json
{
  "opencodeide.mcp.servers": [
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

- Node.js >= 20.0.0
- npm >= 10.0.0
- Git

### Building

```bash
# Install dependencies
npm install

# Build all components
npm run build

# Watch mode for development
npm run watch
```

### Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Run E2E tests
npm run test:e2e
```

### Packaging

```bash
# Package for current platform
npm run package

# Package for Windows
npm run package:win

# Package for macOS
npm run package:mac

# Package for Linux
npm run package:linux
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a Pull Request.

## Acknowledgments

- Built on [Code-OSS](https://github.com/microsoft/vscode), the open-source foundation of Visual Studio Code
- Inspired by modern AI coding assistants
- Powered by open AI research and models
