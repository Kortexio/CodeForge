# CodeForge Benchmarks

## Harness benchmark (available now)

Semi-automatic suite: the agent runs inside CodeForge; `check` scores with hidden tests + session metrics.

### JavaScript (`fixtures/shop`) — T1–T4
Quick harness smoke (node). Good for catching retrieve/read loops; **not** your real C# workload.

### C# / .NET 10 (`fixtures/billing` + `scaffold`) — CS1–CS4
Closer to ContextRouter: `dotnet test`, classlibs, docs-driven features, VIP navigation, and a **scaffold** task (create solution from a C01 card).

```bash
npm run bench -- list
npm run bench -- setup CS1 --label bonsai --open   # or CS2 / CS3 / CS4
# New Chat in that folder → bonsai → paste the printed prompt
npm run bench -- check latest
npm run bench -- report
npm run bench -- selftest CS                       # validates fixtures + solutions
```

Score (0–100): hidden 60 · visible 15 · protected untouched 10 · checks 10 · no junk files 5.

### Long and review (`fixtures/router-cards`, `fixtures/billing-bugs`) — CS5–CS6

- **CS5 (review)**: 6 bugs planted in `billing-bugs` (visible tests still pass). The agent writes
  `BUGS.md` with `path:line` references; the manifest lives in `tasks/CS5-review-billing-bugs/bugs.manifest.json`
  (outside the fixture). Score: F1 × 80 · protected 10 · `BUGS.md` exists 10 (±3 line tolerance).
- **CS6 (long)**: cards C01–C05 with "Depends on:" lines. Hidden tests run **per card** (only that
  card's tests are compiled in); the hidden ratio is the average over cards.

Every result also reports `falseDone` (the agent claimed green while tests were red) and
`harness` (chars of harness text injected into the conversation).

## Planned suites

## Categories

### Navigation Tasks (50)
Tasks that test the ability to find and understand code:
- "Where is X defined?"
- "Who calls function Y?"
- "Show me all implementations of interface Z"

### Bug Fix Tasks (50)
Tasks that test the ability to identify and fix bugs:
- Error message diagnosis
- Logic error correction
- Type error fixes

### Feature Tasks (50)
Tasks that test the ability to implement new functionality:
- Add new API endpoint
- Create new component
- Implement business logic

### Refactoring Tasks (25)
Tasks that test the ability to improve code structure:
- Extract function/class
- Rename with all references
- Move code between files

### Test Generation Tasks (25)
Tasks that test the ability to create tests:
- Unit test generation
- Integration test generation
- Edge case identification

### Architecture Questions (25)
Tasks that test code understanding:
- "How does X work?"
- "What is the data flow?"
- "Explain the architecture of Y"

### Git Reasoning Tasks (25)
Tasks that test Git intelligence:
- "What changed recently?"
- "Who broke this test?"
- "Summarize PR changes"

## Metrics

- **Success Rate**: Percentage of tasks completed correctly
- **Time to Success**: Average time to complete tasks
- **Edit Acceptance Rate**: Percentage of AI edits accepted by user
- **Test Pass Rate**: Percentage of generated tests that pass
- **Correction Count**: Number of corrections needed per task
- **Tokens Consumed**: Total tokens used per task
- **Latency**: Response time measurements
- **Context Retrieval Precision**: Quality of retrieved context
- **Security Violations**: Number of policy violations

## Running Benchmarks

```bash
# Run all benchmarks
npm run benchmark

# Run specific category
npm run benchmark -- --category=bugfix

# Run with specific model
npm run benchmark -- --model=gpt-4o
```

## Adding Benchmarks

1. Create a new JSON file in the appropriate category folder
2. Follow the schema:

```json
{
  "id": "unique-id",
  "category": "bugfix",
  "difficulty": "medium",
  "description": "Fix the null pointer exception",
  "setup": {
    "files": {
      "src/example.ts": "..."
    }
  },
  "expected": {
    "files_modified": ["src/example.ts"],
    "test_command": "npm test",
    "validation": "..."
  }
}
```
