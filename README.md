# Agent Skill Composer

Dynamic tool chaining system for AI agents to build complex workflows from atomic skills.

## Overview

Agent Skill Composer is a powerful framework designed to enable AI agents to compose multiple specialized "skills" into complex, multi-step workflows. It handles input/output validation, data mapping between steps, conditional execution, retries, and state persistence.

## Key Features

- **Atomic Skills**: Define skills with strongly-typed Zod schemas for inputs and outputs.
- **Dynamic Chaining**: Map outputs from one step to inputs of another using simple JSON paths.
- **Validation**: Automatic runtime validation of all inputs and outputs using Zod.
- **Conditional Logic**: Branching workflows based on variable states.
- **Resilience**: Configurable retry logic for individual steps.
- **Persistence**: Built-in state management to track and recover workflow progress.
- **CLI Interface**: Easy-to-use command-line interface for listing skills and running workflows.

## Installation

```bash
bun install
```

## Usage

### List Available Skills

```bash
bun src/index.ts list
```

### Run Example Workflow

```bash
bun src/index.ts run-example --text "AI agents are changing the world of automation."
```

## Architecture

The system is composed of several core modules:

1.  **SkillRegistry**: Stores and manages `SkillDefinition` objects.
2.  **ExecutionEngine**: The heart of the system that orchestrates workflow execution.
3.  **StatePersister**: Manages the persistence of workflow state to disk.
4.  **WorkflowDefinition**: A structured representation of a multi-step process.

## Example Skill Definition

```typescript
registry.register({
  name: "text-transformer",
  description: "Transforms text to uppercase or lowercase",
  inputSchema: z.object({
    text: z.string(),
    mode: z.enum(["uppercase", "lowercase"])
  }),
  outputSchema: z.object({
    result: z.string()
  }),
  execute: async (input) => {
    return {
      result: input.mode === "uppercase" ? input.text.toUpperCase() : input.text.toLowerCase()
    };
  }
});
```

## License

MIT
