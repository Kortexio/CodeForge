# Blueprint 02 — Open Source AI Coding IDE
## Revised Direction: Code - OSS + Embedded AI Platform

## 1. Executive Decision

This blueprint supersedes the previous Blueprint 02.

### New strategic decision

The new IDE must be a **single installable application**.

The user must NOT be required to:
- install ContextMemory separately;
- run ContextMemory in Docker;
- configure a second repository;
- start a local ContextMemory server manually;
- understand internal service topology;
- manage multiple processes during normal use.

The complete AI experience must live inside the IDE.

The prior ContextMemory project will serve as a **source of architecture, concepts, components and proven implementation ideas**, but the IDE will own the user-facing AI platform.

The resulting product is:

> **One IDE, one installation, one AI platform, one configuration surface.**

Internally, the IDE may still use strong modular boundaries and even separate worker processes for isolation or performance, but those components are shipped, managed and upgraded as part of the IDE.

---

# 2. Why the Direction Changes

The previous architecture was:

```text
IDE
  |
  v
ContextMemory service
  |
  +-- Docker
  +-- database
  +-- runtime
  +-- configuration
```

This creates friction:

- installation complexity;
- Docker dependency;
- port management;
- process lifecycle;
- version compatibility;
- configuration duplication;
- security concerns;
- support burden;
- poor experience for non-technical users;
- difficult onboarding.

For an end-user IDE, this is the wrong abstraction.

The user should experience:

```text
Download IDE
   |
   v
Install
   |
   v
Open project
   |
   v
Use AI
```

Everything else is internal.

---

# 3. New Product Architecture

The architecture becomes:

```text
+----------------------------------------------------------------+
|                        OPEN AI IDE                             |
|                        Code - OSS                             |
|                                                                |
|  Editor | Explorer | Git | Terminal | Debug | Extensions       |
|                                                                |
|  +----------------------------------------------------------+  |
|  |                  Embedded AI Platform                    |  |
|  |                                                          |  |
|  | Agent Runtime                                            |  |
|  | Context Engine                                           |  |
|  | Memory Engine                                            |  |
|  | Code Intelligence                                       |  |
|  | Model Router                                             |  |
|  | Tool Runtime                                             |  |
|  | MCP                                                      |  |
|  | Skills / Rules                                           |  |
|  | Guardrails / HITL                                        |  |
|  | Sandbox / Browser                                        |  |
|  | Artifacts                                                |  |
|  | Subagents                                                |  |
|  | Git Intelligence                                         |  |
|  +----------------------------------------------------------+  |
|                                                                |
+-----------------------------+----------------------------------+
                              |
                       Model Providers
                              |
            +-----------------+------------------+
            |                 |                  |
            v                 v                  v
          Cloud             Local            Self-hosted
```

The key change is:

> **ContextMemory capabilities become internal platform capabilities of the IDE.**

There is no required external ContextMemory runtime.

---

# 4. Architectural Principle

We should NOT copy the entire ContextMemory application into one giant IDE module.

Instead, we preserve the architectural concepts and modularize them internally:

```text
OpenIDE
|
+-- Workbench
|
+-- AI Platform
|   |
|   +-- Agent
|   +-- Context
|   +-- Memory
|   +-- Tools
|   +-- MCP
|   +-- Skills
|   +-- Rules
|   +-- Policies
|   +-- Sandbox
|   +-- Artifacts
|   +-- Subagents
|   +-- Model Router
|   +-- Evaluation
|
+-- Code Intelligence
|
+-- Git Intelligence
|
+-- Browser
|
+-- Terminal
|
+-- Extensions
|
+-- Storage
```

This provides the usability of a monolithic product while retaining the engineering discipline of separate subsystems.

---

# 5. ContextMemory Reuse Strategy

ContextMemory should be treated as the architectural and implementation reference for the AI Platform.

Three reuse strategies are possible:

## Strategy A — Port selected modules

Take proven concepts/components from ContextMemory and adapt them into the IDE.

Preferred for:
- memory;
- session wiki;
- compaction;
- artifacts;
- MCP;
- skills;
- guardrails;
- HITL;
- agent loop.

## Strategy B — Extract reusable internal libraries

Where appropriate, move stable concepts into packages/libraries consumed by IDE services.

Example conceptual boundaries:

```text
ai-agent-core
ai-context
ai-memory
ai-tools
ai-mcp
ai-policy
ai-sandbox
ai-artifacts
```

## Strategy C — Run internal workers

For operations needing stronger isolation or platform compatibility, use bundled worker processes.

Examples:
- sandbox;
- browser;
- heavy indexing;
- local model runtime.

These remain implementation details invisible to the user.

---

# 6. User Experience Goal

The user should never be asked:

> "Is ContextMemory running?"

The user should only see:

> "AI is ready."

Health should be managed internally:

```text
IDE
 |
 +-- AI Platform
       |
       +-- Agent: Ready
       +-- Memory: Ready
       +-- Index: Ready
       +-- MCP: Ready
       +-- Sandbox: Ready
```

The IDE itself owns lifecycle management.

---

# 7. Single Application Lifecycle

On startup:

```text
IDE startup
   |
   +--> initialize AI platform
   |
   +--> load configuration
   |
   +--> initialize memory store
   |
   +--> initialize repository index
   |
   +--> initialize MCP
   |
   +--> initialize policy engine
   |
   +--> initialize model providers
   |
   +--> ready
```

If a component fails, the IDE should degrade gracefully.

Example:

```text
Browser unavailable
     |
     v
AI coding remains available
```

or:

```text
Semantic index rebuilding
     |
     v
Lexical search remains available
```

---

# 8. Embedded AI Platform

The new AI platform inside the IDE should have the following layers.

## 8.1 Agent Runtime

Responsibilities:
- task execution;
- planning;
- tool selection;
- tool execution;
- observation;
- retry;
- validation;
- cancellation;
- compaction;
- delegation.

## 8.2 Context Engine

Responsibilities:
- assemble context;
- rank context;
- retrieve context;
- enforce token budget;
- manage context lifecycle;
- invoke memory/code retrieval.

## 8.3 Memory Engine

Responsibilities:
- session memory;
- project memory;
- long-term memory;
- temporal memory;
- rolling summaries;
- facts;
- decisions;
- artifacts.

## 8.4 Code Intelligence

Responsibilities:
- AST;
- LSP;
- symbols;
- references;
- semantic search;
- repository graph;
- tests;
- diagnostics;
- Git history.

## 8.5 Tool Runtime

Responsibilities:
- native tools;
- filesystem;
- terminal;
- editor;
- Git;
- browser;
- MCP;
- external integrations.

## 8.6 Policy Engine

Responsibilities:
- permission;
- approval;
- sandbox policy;
- network policy;
- secret policy;
- data access;
- tool access.

---

# 9. Local Storage Architecture

The IDE should store AI state locally by default.

Conceptual structure:

```text
IDE User Data
|
+-- settings
|
+-- ai
|   |
|   +-- sessions
|   +-- memory
|   +-- artifacts
|   +-- traces
|   +-- policies
|   +-- skills
|
+-- code-index
|
+-- cache
|
+-- model-cache
```

Sensitive information should be encrypted at rest where appropriate.

Project-local knowledge can additionally be stored in a project metadata directory when enabled.

---

# 10. Project Memory

The IDE should provide persistent project knowledge.

Examples:

```text
Project Brain
|
+-- Architecture
+-- Conventions
+-- Decisions
+-- Business Rules
+-- Known Issues
+-- Integrations
+-- Deployment
+-- Testing
```

The underlying representation can continue to use human-readable Markdown/wiki principles.

The user should be able to inspect and edit project memory.

---

# 11. Session Memory

Each Agent task becomes a persistent session.

A session contains:

- task;
- plan;
- important context;
- discoveries;
- tool calls;
- changes;
- validations;
- outcomes;
- artifacts;
- final summary.

The user must be able to:
- reopen;
- rename;
- search;
- inspect;
- resume;
- delete;
- export.

---

# 12. Memory Lifecycle

Memory must have lifecycle states:

```text
Captured
   |
   v
Temporary
   |
   v
Relevant
   |
   v
Persisted
   |
   v
Validated
   |
   v
Archived
```

Not everything discovered by an Agent should become permanent memory.

The platform should distinguish:

- observation;
- hypothesis;
- fact;
- decision;
- preference;
- historical event.

---

# 13. Context Architecture

Context should be dynamic.

Priority order:

```text
1. Current task
2. Current editor state
3. Relevant code
4. Relevant project memory
5. Relevant Git state
6. Relevant external information
7. Historical context
```

Do not inject everything.

Use:

```text
Discover
  |
  v
Retrieve
  |
  v
Rank
  |
  v
Compress
  |
  v
Use
```

---

# 14. Context Budget

The IDE must expose a context budget internally.

Each context item has:
- source;
- relevance;
- size;
- importance;
- freshness;
- confidence.

The platform should be capable of explaining:

```text
Context used

Current file          4%
Related symbols      18%
Repository search    21%
Project memory       12%
Git history            5%
MCP                    7%
Conversation           20%
System                 13%
```

The exact UI can evolve, but observability should exist from the beginning.

---

# 15. Context Compression

Reuse and evolve the ContextMemory approach:

- rolling summary;
- session compaction;
- artifact references;
- recoverable history.

Compression must retain:
- objective;
- decisions;
- current state;
- changed files;
- errors;
- unresolved issues;
- important discoveries.

---

# 16. Artifacts

All large outputs should be handled as artifacts.

Examples:
- test output;
- build logs;
- browser screenshots;
- large MCP responses;
- generated reports;
- patches;
- analysis files.

The context receives metadata and preview, not entire payloads.

This prevents context-window pollution.

---

# 17. Code Intelligence

This is the main subsystem that does NOT come from the old ContextMemory and must be built specifically for the IDE.

It should provide:

### Structural intelligence
- AST;
- symbols;
- definitions;
- references;
- implementations;
- imports;
- inheritance;
- calls.

### Semantic intelligence
- embeddings;
- semantic retrieval;
- concept similarity.

### Text intelligence
- grep;
- regex;
- exact search.

### Historical intelligence
- Git commits;
- blame;
- branches;
- changes;
- PR metadata.

### Runtime intelligence
- diagnostics;
- test failures;
- build output;
- debugger state.

---

# 18. Hybrid Code Retrieval

The retrieval engine should combine:

```text
Lexical
   +
Structural
   +
Semantic
   +
Relational
   +
Historical
```

Example:

User:

> "Where is the authentication flow implemented?"

The system may retrieve:

```text
1. AuthenticationController
2. AuthService
3. AuthMiddleware
4. Login tests
5. Relevant interface
6. Project rule
```

Not simply the nearest embedding chunks.

---

# 19. Repository Indexing

Indexing should be:

- incremental;
- background;
- cancellable;
- language-aware;
- workspace-aware.

On file change:

```text
file changed
   |
   +--> parse
   +--> update symbols
   +--> update references
   +--> update text index
   +--> update semantic index
```

No full repository rebuild should be required for normal editing.

---

# 20. Agent Tools

Native tools should be first-class.

## Filesystem
- read;
- write;
- patch;
- rename;
- delete.

## Editor
- open;
- select;
- navigate;
- inspect;
- modify.

## Code Intelligence
- search;
- symbol;
- references;
- diagnostics;
- test discovery.

## Terminal
- execute;
- inspect;
- manage process.

## Git
- status;
- diff;
- commit;
- branch;
- worktree;
- history.

## Browser
- navigate;
- click;
- type;
- screenshot;
- console;
- network.

## MCP
- discover;
- invoke;
- access resources.

---

# 21. MCP Architecture

MCP becomes an internal capability of the IDE.

The user configures MCP from the IDE:

```text
Settings
  |
  +-- MCP Servers
       |
       +-- GitHub
       +-- Jira
       +-- PostgreSQL
       +-- Custom Server
```

The MCP runtime is managed by the IDE.

The user does not need to install another application.

For stdio servers, the IDE manages process lifecycle.

For HTTP servers, the IDE manages connection/security.

---

# 22. Skills

Skills become part of the IDE platform.

Locations may include:

```text
Global Skills
Workspace Skills
Folder Skills
Extension Skills
```

Skills should support progressive loading.

A skill should not consume the full context unless selected/relevant.

---

# 23. Rules

Rules hierarchy:

```text
System
 |
 +-- User Rules
 |
 +-- Workspace Rules
 |
 +-- Folder Rules
 |
 +-- Task Rules
```

The UI should show effective rules.

The user should be able to answer:

> "Why is the Agent following this rule?"

---

# 24. Guardrails

Policies should be evaluated before and after important actions.

Examples:

```text
read file       -> allowed
edit source     -> allowed
install package -> approval
git commit      -> approval
git push        -> approval
delete many     -> approval
network call    -> policy
secret access   -> deny/restricted
```

Guardrails are platform-level and cannot be bypassed by an Agent prompt.

---

# 25. HITL

The IDE owns approval UX.

Example:

```text
AI wants to execute

git push origin feature/new-auth

[Allow Once]
[Allow for This Session]
[Deny]
```

Approval should include:
- tool;
- arguments;
- target;
- risk;
- reason.

---

# 26. Sandbox

Sandbox execution should be transparent to the user.

Possible levels:

```text
Safe Local
Restricted
Isolated
Full Host
```

Default for Agent execution should be a safe/restricted mode.

Heavy or risky workloads may run in a bundled worker process or optional container backend.

Docker must NOT be required for the normal product.

---

# 27. Model Router

The IDE should own model configuration.

Providers:

- OpenAI;
- Anthropic;
- Google;
- xAI;
- OpenRouter;
- Ollama;
- vLLM;
- LM Studio;
- custom OpenAI-compatible endpoint.

Model selection can be task-specific:

```text
Agent       -> powerful reasoning model
Tab         -> low-latency model
Embeddings  -> embedding model
Vision      -> vision model
Review      -> review model
```

The user must be able to configure API keys without exposing them to Agent tools.

---

# 28. Model Independence

No feature should assume:
- a specific provider;
- a specific context window;
- a specific tool-calling syntax;
- a specific reasoning format.

The IDE should normalize model capability differences.

---

# 29. Agent State Machine

The embedded Agent runtime should use an explicit lifecycle:

```text
Created
  |
Planning
  |
RetrievingContext
  |
Executing
  |
Observing
  |
Validating
  |
+-----> Recovering
|
+-----> WaitingForApproval
|
+-----> Delegating
|
Compacting
  |
Completed / Failed / Cancelled
```

This is necessary for:
- resume;
- observability;
- cancellation;
- debugging;
- background tasks.

---

# 30. Agent Sessions

The user should see sessions as first-class objects.

```text
AI Sessions

Today
  Fix authentication bug
  Add invoice validation

Yesterday
  Refactor payment service
  Upgrade .NET dependencies
```

Each session is resumable.

---

# 31. Composer / Multi-file Tasks

The main development experience should support task-level requests.

Example:

> "Migrate authentication to OAuth."

The platform should:

```text
Understand
   |
Plan
   |
Discover
   |
Modify
   |
Build
   |
Test
   |
Fix
   |
Review
```

The final result should provide:
- summary;
- files changed;
- tests;
- warnings;
- unresolved items.

---

# 32. Tab

Tab is independent from the heavyweight Agent.

Requirements:
- very low latency;
- local editor context;
- recent edits;
- imports;
- diagnostics;
- relevant symbols;
- multi-line prediction.

The Tab engine should never start a full agent loop for normal completion.

---

# 33. Smart Editing

Inline AI editing should support:
- rewrite;
- explain;
- optimize;
- refactor;
- generate;
- test;
- migrate.

Changes are proposed as diffs.

---

# 34. Background Agents

Later phases should support:

```text
Background Task
   |
   +--> isolated workspace
   |
   +--> Agent
   |
   +--> tests
   |
   +--> result
   |
   +--> review
```

The user should continue coding while the task runs.

---

# 35. Subagents

Subagents run within the embedded Agent Platform.

Examples:

```text
Main Agent
 |
 +-- Researcher
 |
 +-- Coder
 |
 +-- Tester
 |
 +-- Reviewer
```

Each can have:
- different tools;
- different model;
- separate context;
- optional isolated worktree.

---

# 36. Git Worktrees

Use worktrees as an internal isolation mechanism for multi-agent or high-risk tasks.

The UI abstracts away the Git complexity.

The user sees:

```text
Task: OAuth migration
Status: Working
Workspace: Isolated
```

rather than manually managing directories.

---

# 37. Browser Agent

The IDE should include browser automation as a built-in AI capability.

Use cases:
- test local web application;
- verify UI;
- inspect console;
- inspect network;
- capture screenshot;
- reproduce bug.

Browser output should use artifacts and selective retrieval.

---

# 38. Project Brain UI

A dedicated view should expose project knowledge.

Sections:

```text
Project Brain
|
+-- Overview
+-- Architecture
+-- Rules
+-- Decisions
+-- Dependencies
+-- Integrations
+-- Known Problems
+-- Agent Knowledge
+-- History
```

All important persistent knowledge should have provenance.

---

# 39. AI Trace UI

Every significant Agent execution should have a trace.

```text
Task
|
+-- Context retrieval
+-- Tool calls
+-- Model calls
+-- Approvals
+-- Edits
+-- Tests
+-- Errors
+-- Recovery
+-- Result
```

Advanced mode may expose:
- token usage;
- latency;
- context size;
- tool duration;
- model;
- cost estimate.

---

# 40. Privacy

The application must be usable without sending source code to the project maintainers.

Modes:

### Local
Models and memory remain local when technically possible.

### Bring Your Own Key
Requests go directly to the selected provider where possible.

### Self-hosted
Enterprise users can point to their own model infrastructure.

### Managed Cloud
Optional future service.

---

# 41. Offline Mode

A future goal should be useful offline operation:

```text
IDE
+
Local memory
+
Local code index
+
Local embeddings
+
Local model
+
Local tools
```

Cloud features should degrade gracefully.

---

# 42. Repository Structure

Recommended product repository:

```text
OpenCodeIDE/
|
+-- vscode/
|
+-- src/ai/
|   |
|   +-- agent/
|   +-- context/
|   +-- memory/
|   +-- tools/
|   +-- mcp/
|   +-- skills/
|   +-- rules/
|   +-- policy/
|   +-- sandbox/
|   +-- artifacts/
|   +-- subagents/
|   +-- models/
|   +-- trace/
|
+-- src/code-intelligence/
|
+-- src/git-intelligence/
|
+-- src/browser/
|
+-- src/terminal/
|
+-- docs/
|
+-- tests/
|
+-- benchmarks/
```

The exact physical package structure may evolve, but ownership remains inside the IDE repository.

---

# 43. ContextMemory Project Relationship

The new IDE must NOT have ContextMemory as a runtime prerequisite.

There are three acceptable relationships:

### Option 1 — Conceptual heritage
Use ContextMemory as the reference architecture and implement the required features directly.

### Option 2 — Internal code extraction
Reuse selected ContextMemory modules where licensing permits and where doing so improves quality.

### Option 3 — Shared libraries
Where useful, extract generic libraries shared between products.

The user-facing IDE remains independent.

---

# 44. What should remain in ContextMemory

The standalone ContextMemory project can continue as an independent product.

It can serve:
- agent applications;
- APIs;
- automation;
- enterprise agents;
- CLI agents;
- external IDE integrations.

But the IDE should not require it.

This creates:

```text
                Common Technology
                      |
          +-----------+------------+
          |                        |
          v                        v
   ContextMemory               OpenCodeIDE
   standalone                  integrated AI
```

Shared concepts are encouraged.

Mandatory runtime dependency is not.

---

# 45. Development Phases

## Phase IDE-0 — Code - OSS Foundation

Goal:
create a stable independent distribution.

Deliver:
- branding;
- packaging;
- updates;
- CI/CD;
- installer;
- extension infrastructure.

## Phase IDE-1 — Embedded AI Foundation

Deliver:
- AI platform shell;
- provider configuration;
- Agent UI;
- session store;
- basic tools;
- approvals;
- trace.

Exit criteria:
no external ContextMemory installation required.

## Phase IDE-2 — Agent

Deliver:
- planning;
- read/search/edit;
- terminal;
- validation;
- multi-file changes;
- session persistence;
- compaction.

## Phase IDE-3 — Memory + Context

Deliver:
- Session Memory;
- Project Memory;
- Project Brain;
- context planner;
- dynamic retrieval;
- artifacts.

## Phase IDE-4 — Code Intelligence

Deliver:
- AST;
- LSP integration;
- symbols;
- references;
- hybrid search;
- repository index;
- code graph.

## Phase IDE-5 — MCP / Skills / Rules / Policies

Deliver:
- MCP manager;
- Skills;
- Rules;
- guardrails;
- HITL;
- permission UI.

## Phase IDE-6 — Tab / Inline AI

Deliver:
- autocomplete;
- Smart Tab;
- inline edit.

## Phase IDE-7 — Browser + Git Intelligence

Deliver:
- browser agent;
- Git reasoning;
- test automation;
- visual verification.

## Phase IDE-8 — Subagents

Deliver:
- subagents;
- parallel tasks;
- worktree isolation;
- task dashboard.

## Phase IDE-9 — Background Agents

Deliver:
- non-blocking tasks;
- persistent runs;
- optional remote execution.

## Phase IDE-10 — Cloud / Self-hosted

Deliver:
- remote worker;
- enterprise execution;
- cloud agents;
- centralized policy.

---

# 46. MVP Definition

The MVP must be:

**one installer, one IDE, zero mandatory Docker.**

A new user should be able to:

1. install IDE;
2. open a repository;
3. configure an LLM provider;
4. ask the Agent to inspect the repository;
5. make changes;
6. execute tests;
7. review diff;
8. approve/reject operations;
9. close IDE;
10. reopen the session later.

No separate ContextMemory application should be required.

---

# 47. V1 Definition

V1 should include:

- Agent;
- dynamic context;
- persistent memory;
- Project Brain;
- hybrid code search;
- multi-file editing;
- terminal;
- Git;
- MCP;
- Skills;
- Rules;
- HITL;
- guardrails;
- sandbox;
- Tab;
- browser;
- artifacts;
- subagents;
- worktrees;
- model routing.

---

# 48. Non-functional Requirements

## Startup
AI services should initialize without visible infrastructure setup.

## Resilience
AI failures must not crash the editor.

## Upgradeability
AI platform versions must track IDE version safely.

## Performance
Editor operations cannot be blocked by indexing or Agent execution.

## Security
Agent capabilities must be isolated from editor UI permissions.

## Privacy
No source telemetry by default.

## Extensibility
Third-party integrations should use stable APIs/MCP.

---

# 49. Core Design Decision

The most important decision is:

> **We are building one product, not two products that happen to work together.**

The user sees:

```text
OpenCodeIDE
```

Internally:

```text
OpenCodeIDE
|
+-- Editor
+-- Code Intelligence
+-- AI Platform
+-- Memory
+-- Agent
+-- MCP
+-- Sandbox
+-- Models
+-- Git
+-- Browser
```

The technical separation exists for maintainability, not as an installation boundary.

---

# 50. Strategic Positioning

The product should not be presented as:

> "Cursor clone with ContextMemory."

A stronger positioning is:

> **An open-source, model-independent, memory-native, agentic coding IDE.**

Key differentiators:

- single install;
- no mandatory Docker;
- model independence;
- local-first;
- persistent project memory;
- transparent context;
- open MCP ecosystem;
- agentic workflows;
- multi-agent support;
- self-hosting;
- open architecture.

---

# 51. Final Architecture

```text
                         USER
                          |
                          v
                 +------------------+
                 |   OpenCodeIDE    |
                 +--------+---------+
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
       Editor        Code Intelligence   Git/Terminal
          |               |                |
          +---------------+----------------+
                          |
                    Embedded AI
                       Platform
                          |
       +------------------+-------------------+
       |        |         |        |          |
       v        v         v        v          v
     Agent   Context    Memory    Tools     Policy
       |        |         |        |          |
       |        |         |        +----+-----+
       |        |         |             |
       |        |         |        MCP/Browser
       |        |         |
       |        |       Project Brain
       |        |
       |      Code/Git retrieval
       |
       +------------+-------------+
                    |
               Model Router
                    |
        +-----------+------------+
        |           |            |
      Cloud       Local       Self-hosted
```

The product is therefore **one IDE application**, with the complete AI platform embedded inside it.

---

# 52. Implementation Priority

The implementation should prioritize, in this order:

1. Agent runtime;
2. Context engine;
3. Memory engine;
4. native tools;
5. security/policies;
6. model abstraction;
7. Code Intelligence;
8. MCP;
9. Skills/Rules;
10. multi-file editing;
11. Tab;
12. browser;
13. subagents;
14. background agents;
15. cloud.

The old ContextMemory capabilities provide a major acceleration specifically for items 1–9, but those capabilities should become first-class internal components of the IDE rather than a mandatory external service.

---

# 53. Final Success Criterion

A user with zero knowledge of ContextMemory, Docker or AI infrastructure must be able to download the IDE, open a project and use the full AI experience immediately after configuring a model provider.

The underlying architecture may contain multiple modules or isolated worker processes.

The product must still behave as:

> **one application.**