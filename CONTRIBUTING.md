# Contributing to CodeForge

Thank you for your interest in contributing to CodeForge! This document provides guidelines for contributing.

## Getting Started

### Prerequisites

- Node.js matching `vscode/.nvmrc` for full IDE builds (Node 20+ for extension-only work)
- npm
- Git
- On Windows (full IDE): Visual Studio C++ workload + Spectre-mitigated libs

### Development Setup

```bash
git clone https://github.com/Kortexio/CodeForge.git
cd CodeForge
npm install
npm run build:extensions
npm test
```

Full IDE:

```bash
npm run vscode:setup
npm run vscode:compile
npm run vscode:dev
```

## Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes **in `extensions/codeforge/`** (source of truth)
4. Run tests (`npm test`)
5. Run linting (`npm run lint`)
6. Commit your changes
7. Push and open a Pull Request

## Code Style

- Use TypeScript for all new code
- Follow the existing code style (enforced by ESLint and Prettier)
- Write meaningful commit messages
- Add tests for new functionality
- Update documentation as needed

## Project Structure

```
extensions/codeforge/   # Shipped AI platform (ONLY product surface)
├── src/agent/               # Agent loop, context packet, state machine
├── src/memory/              # Session + project wiki + temporal facts
├── src/storage/             # ~/.CodeForge paths, sessions, artifacts, traces
├── src/context/             # Context budget / ranking
├── src/sandbox/             # Shell isolation
├── src/intelligence/        # Index, embeddings, LSP, git
├── src/browser/             # Browser agent (Playwright optional)
├── src/mcp/                 # Inbound + outbound MCP
└── src/governance/          # Skills, rules, guardrails, HITL
docs/
tests/
scripts/                     # Code-OSS setup / package
```

Do **not** add features under a legacy `src/` tree — it was removed.

## Testing

- **Unit Tests**: `npm run test:unit`
- **Integration Tests**: `npm run test:integration`
- **E2E Tests**: `npm run test:e2e`

## Reporting Issues

Please use the GitHub issue tracker to report bugs or request features. Include:

- A clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version)

## License

By contributing to CodeForge, you agree that your contributions will be licensed under the MIT License.
