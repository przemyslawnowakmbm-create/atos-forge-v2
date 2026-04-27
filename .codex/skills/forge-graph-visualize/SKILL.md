---
name: forge-graph-visualize
description: Generate the Forge HTML dashboard for the current code graph
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Generate the graph dashboard HTML from the current Forge code graph.
</objective>

<context>
Arguments: $ARGUMENTS

If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.codex/forge/atos-forge/bin/forge-tools.cjs graph visualize $ARGUMENTS
```

If the graph does not exist, tell the user to run `$forge-init`.
If not using `--raw`, report the dashboard path and whether it was opened.
</process>
