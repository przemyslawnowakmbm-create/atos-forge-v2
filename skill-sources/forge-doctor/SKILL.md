---
name: forge-doctor
description: Run Forge health checks for dependencies, graph state, hooks, and runtime setup
argument-hint: "[--raw]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Run Forge Doctor and report environment and project health.
</objective>

<context>
Arguments: $ARGUMENTS

If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs doctor $ARGUMENTS
```

If not using `--raw`, present failures and warnings first, then summarize overall status.
</process>
