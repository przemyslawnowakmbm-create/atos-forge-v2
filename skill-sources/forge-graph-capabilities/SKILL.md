---
name: forge-graph-capabilities
description: Show detected capabilities for the whole codebase or one module
argument-hint: "[module] [--raw]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Show capabilities detected by the Forge graph.
</objective>

<context>
Arguments: $ARGUMENTS

Optional first positional argument: module name.
If `--raw` is present, return the CLI JSON output without extra formatting.
</context>

<process>
Run:

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs graph capabilities $ARGUMENTS
```

If the graph does not exist, tell the user to run `/forge-init`.
</process>
