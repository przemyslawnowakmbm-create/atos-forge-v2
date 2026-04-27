---
name: forge-quick
description: Execute a quick task with Forge guarantees (atomic commits, state tracking) but skip optional agents
argument-hint: "[--full]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - AskUserQuestion
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
@~/.claude/atos-forge/workflows/quick.md
</execution_context>

<objective>
Execute small, ad-hoc tasks with Forge guarantees (atomic commits, STATE.md tracking).

Quick mode is the same system with a shorter path:
- Spawns forge-planner (quick mode) + forge-executor(s)
- Quick tasks live in `.planning/quick/` separate from planned phases
- Updates STATE.md "Quick Tasks Completed" table (NOT ROADMAP.md)

**Default:** Skips research, plan-checker, verifier. Use when you know exactly what to do.

**`--full` flag:** Enables plan-checking (max 2 iterations) and post-execution verification. Use when you want quality guarantees without full milestone ceremony.
</objective>



<context>
@.planning/STATE.md
$ARGUMENTS
</context>

<process>
Execute the quick workflow from @~/.claude/atos-forge/workflows/quick.md end-to-end.
Preserve all workflow gates (validation, task description, planning, execution, state updates, commits).
</process>
