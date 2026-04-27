---
name: forge-graph-show
description: Show dependency and symbol details for one file from the Forge graph
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Show graph details for a specific file.
</objective>

<context>
Arguments: $ARGUMENTS

The first positional argument must be the target file path.
If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.codex/forge/atos-forge/bin/forge-tools.cjs graph show $ARGUMENTS
```

If no file was provided, ask for one concise file path.
If the graph does not exist, tell the user to run `$forge-init`.
</process>
