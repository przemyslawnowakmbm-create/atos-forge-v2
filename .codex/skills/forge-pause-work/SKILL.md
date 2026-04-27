---
name: forge-pause-work
description: Create context handoff when pausing work mid-phase
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@.planning/STATE.md
@~/.codex/forge/atos-forge/workflows/pause-work.md
</execution_context>

<objective>
Create `.continue-here.md` handoff file to preserve complete work state across sessions.

Routes to the pause-work workflow which handles:
- Current phase detection from recent files
- Complete state gathering (position, completed work, remaining work, decisions, blockers)
- Handoff file creation with all context sections
- Git commit as WIP
- Resume instructions
</objective>

<process>
**Follow the pause-work workflow** from `@~/.codex/forge/atos-forge/workflows/pause-work.md`.

The workflow handles all logic including:
1. Phase directory detection
2. State gathering with user clarifications
3. Handoff file writing with timestamp
4. Git commit
5. Confirmation with resume instructions
</process>
