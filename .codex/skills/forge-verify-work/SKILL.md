---
name: forge-verify-work
description: Validate built features through conversational UAT
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/verify-work.md
@~/.codex/forge/atos-forge/templates/UAT.md
</execution_context>

<objective>
Validate built features through conversational testing with persistent state.

Purpose: Confirm what Codex built actually works from user's perspective. One test at a time, plain text responses, no interrogation. When issues are found, automatically diagnose, plan fixes, and prepare for execution.

Output: {phase_num}-UAT.md tracking all test results. If issues found: diagnosed gaps, verified fix plans ready for $forge-execute-phase
</objective>

<context>
Phase: $ARGUMENTS (optional)
- If provided: Test specific phase (e.g., "4")
- If not provided: Check for active sessions or prompt for phase

@.planning/STATE.md
@.planning/ROADMAP.md
</context>

<process>
Execute the verify-work workflow from @~/.codex/forge/atos-forge/workflows/verify-work.md end-to-end.
Preserve all workflow gates (session management, test presentation, diagnosis, fix planning, routing).
</process>
