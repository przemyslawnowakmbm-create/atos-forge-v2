---
name: forge-graph-status
description: Show code graph health, stats, modules, capabilities, and hotspots
argument-hint: "[--raw]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Show the current health of the Forge code graph for this repository.
</objective>

<context>
Arguments: $ARGUMENTS

If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs graph status $ARGUMENTS
```

If the graph does not exist, tell the user to run `/forge-init`.

Otherwise summarize the key status:
- Graph freshness / existence
- File, symbol, module, and dependency stats
- Detected capabilities
- Top hotspots
</process>
