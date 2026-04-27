---
name: forge-graph-overview
description: Show a high-level codebase summary from the Forge graph
argument-hint: "[--raw]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Display a high-level overview of the repository from the Forge code graph.
</objective>

<context>
Arguments: $ARGUMENTS

If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs graph overview $ARGUMENTS
```

If the graph does not exist, tell the user to run `/forge-init`.
</process>
