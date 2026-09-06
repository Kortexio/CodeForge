# Contributing to OpenCodeIDE

Thank you for your interest in contributing to OpenCodeIDE! This document provides guidelines for contributing.

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- Git

### Development Setup

```bash
# Clone the repository
git clone https://github.com/Kortexio/OpenCodeIDE.git
cd OpenCodeIDE

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Run linting (`npm run lint`)
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## Code Style

- Use TypeScript for all new code
- Follow the existing code style (enforced by ESLint and Prettier)
- Write meaningful commit messages
- Add tests for new functionality
- Update documentation as needed

## Project Structure

```
src/
├── ai/                    # AI Platform
│   ├── agent/            # Agent runtime
│   ├── context/          # Context engine
│   ├── memory/           # Memory engine
│   ├── tools/            # Native tools
│   ├── mcp/              # MCP runtime
│   ├── skills/           # Skills engine
│   ├── rules/            # Rules engine
│   ├── policy/           # Policy engine
│   ├── sandbox/          # Sandbox runtime
│   ├── artifacts/        # Artifact store
│   ├── subagents/        # Subagent orchestration
│   ├── models/           # Model router
│   └── trace/            # Trace service
├── code-intelligence/    # Code understanding
├── git-intelligence/     # Git integration
├── browser/              # Browser automation
└── terminal/             # Terminal integration
```

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

By contributing to OpenCodeIDE, you agree that your contributions will be licensed under the MIT License.
