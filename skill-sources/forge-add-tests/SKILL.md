---
name: forge-add-tests
description: Generate tests for a completed phase based on implementation and verification criteria
argument-hint: "<phase> [additional instructions]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Task
  - AskUserQuestion
argument-instructions: |
  Parse the argument as a phase number (integer, decimal, or letter-suffix), plus optional free-text instructions.
  Example: /forge-add-tests 12
  Example: /forge-add-tests 12 focus on edge cases in the pricing module
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

$ARGUMENTS: phase number and optional instructions

Load and follow @atos-forge/workflows/add-tests.md
