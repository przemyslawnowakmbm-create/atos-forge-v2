---
name: forge-auto
description: Run autonomous mode — researches, plans, executes, verifies, commits, and advances through phases automatically
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Task
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

$ARGUMENTS: [--verbose] [--timeout <seconds>]

Load and follow @atos-forge/workflows/auto.md
