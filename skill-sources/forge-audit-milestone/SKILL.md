---
name: forge-audit-milestone
description: Audit milestone completion against original intent before archiving
argument-hint: "[version]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
  - Write
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
@~/.claude/atos-forge/workflows/audit-milestone.md
</execution_context>

<objective>
Verify milestone achieved its definition of done. Check requirements coverage, cross-phase integration, and end-to-end flows.

**This command IS the orchestrator.** Reads existing VERIFICATION.md files (phases already verified during execute-phase), aggregates tech debt and deferred gaps, then spawns integration checker for cross-phase wiring.
</objective>



<context>
Version: $ARGUMENTS (optional — defaults to current milestone)

**Original Intent:**
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md

**Planned Work:**
@.planning/ROADMAP.md
@.planning/config.json (if exists)

**Completed Work:**
Glob: .planning/phases/*/*-SUMMARY.md
Glob: .planning/phases/*/*-VERIFICATION.md
</context>

<process>
Execute the audit-milestone workflow from @~/.claude/atos-forge/workflows/audit-milestone.md end-to-end.
Preserve all workflow gates (scope determination, verification reading, integration check, requirements coverage, routing).
</process>
