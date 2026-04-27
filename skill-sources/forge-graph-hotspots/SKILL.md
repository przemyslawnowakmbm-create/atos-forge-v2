---
name: forge-graph-hotspots
description: Show the highest-risk Forge graph hotspots
argument-hint: "[--top N] [--raw]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Display the most important hotspots from the Forge code graph.
</objective>

<context>
Arguments: $ARGUMENTS

Supports `--top N`.
If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs graph hotspots $ARGUMENTS
```

If the graph does not exist, tell the user to run `/forge-init`.
</process>
