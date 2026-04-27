---
name: forge-graph-cycles
description: Detect circular dependencies from the Forge graph
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Check the Forge code graph for circular dependencies.
</objective>

<context>
Arguments: $ARGUMENTS

If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.codex/forge/atos-forge/bin/forge-tools.cjs graph cycles $ARGUMENTS
```

If the graph does not exist, tell the user to run `$forge-init`.
</process>
