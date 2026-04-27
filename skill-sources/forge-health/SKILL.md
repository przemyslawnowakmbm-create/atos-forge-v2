---
name: forge-health
description: Diagnose planning directory health and optionally repair issues
argument-hint: [--repair]
allowed-tools:
  - Read
  - Bash
  - Write
  - AskUserQuestion
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
@~/.claude/atos-forge/workflows/health.md
</execution_context>

<objective>
Validate `.planning/` directory integrity and report actionable issues. Checks for missing files, invalid configurations, inconsistent state, and orphaned plans.
Use --repair to auto-fix detected issues (creates missing directories and config files).
</objective>



<process>
Execute the health workflow from @~/.claude/atos-forge/workflows/health.md end-to-end.
Parse --repair flag from arguments and pass to workflow.
</process>
