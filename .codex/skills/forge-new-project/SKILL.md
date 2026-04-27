---
name: forge-new-project
description: Initialize a new project with deep context gathering and PROJECT.md
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/new-project.md
@~/.codex/forge/atos-forge/references/questioning.md
@~/.codex/forge/atos-forge/references/ui-brand.md
@~/.codex/forge/atos-forge/templates/project.md
@~/.codex/forge/atos-forge/templates/requirements.md
</execution_context>

<context>
**Flags:**
- `--auto` — Automatic mode. After config questions, runs research → requirements → roadmap without further interaction. Expects idea document via @ reference.
</context>

<objective>
Initialize a new project through unified flow: questioning → research (optional) → requirements → roadmap.

**Creates:**
- `.planning/PROJECT.md` — project context
- `.planning/config.json` — workflow preferences
- `.planning/research/` — domain research (optional)
- `.planning/REQUIREMENTS.md` — scoped requirements
- `.planning/ROADMAP.md` — phase structure
- `.planning/STATE.md` — project memory

**After this command:** Run `$forge-plan-phase 1` to start execution.
</objective>

<process>
Execute the new-project workflow from @~/.codex/forge/atos-forge/workflows/new-project.md end-to-end.
Preserve all workflow gates (validation, approvals, commits, routing).
</process>
