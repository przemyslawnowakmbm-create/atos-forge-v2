---
name: forge-execute-phase
description: Execute all plans in a phase with wave-based parallelization
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/execute-phase.md
@~/.codex/forge/atos-forge/references/ui-brand.md
</execution_context>

<objective>
Execute all plans in a phase using wave-based parallel execution.

Orchestrator stays lean: discover plans, analyze dependencies, group into waves, spawn subagents, collect results. Each subagent loads the full execute-plan context and handles its own plan.

Context budget: ~15% orchestrator, 100% fresh per subagent.
</objective>

<context>
Phase: $ARGUMENTS

**Flags:**
- `--gaps-only` — Execute only gap closure plans (plans with `gap_closure: true` in frontmatter). Use after verify-work creates fix plans.

@.planning/ROADMAP.md
@.planning/STATE.md
</context>

<process>
Execute the execute-phase workflow from @~/.codex/forge/atos-forge/workflows/execute-phase.md end-to-end.
Preserve all workflow gates (wave execution, checkpoint handling, verification, state updates, routing).
</process>
