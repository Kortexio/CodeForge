# CodeForge Benchmarks

This directory contains benchmark suites for evaluating CodeForge's AI capabilities.

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
