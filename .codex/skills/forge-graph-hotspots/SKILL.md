---
name: forge-graph-hotspots
description: Show the highest-risk Forge graph hotspots
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
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
node ~/.codex/forge/atos-forge/bin/forge-tools.cjs graph hotspots $ARGUMENTS
```

If the graph does not exist, tell the user to run `$forge-init`.
</process>
