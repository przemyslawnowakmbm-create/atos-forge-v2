---
name: forge-add-phase
description: Add phase to end of current milestone in roadmap
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@.planning/ROADMAP.md
@.planning/STATE.md
@~/.codex/forge/atos-forge/workflows/add-phase.md
</execution_context>

<objective>
Add a new integer phase to the end of the current milestone in the roadmap.

Routes to the add-phase workflow which handles:
- Phase number calculation (next sequential integer)
- Directory creation with slug generation
- Roadmap structure updates
- STATE.md roadmap evolution tracking
</objective>

<process>
**Follow the add-phase workflow** from `@~/.codex/forge/atos-forge/workflows/add-phase.md`.

The workflow handles all logic including:
1. Argument parsing and validation
2. Roadmap existence checking
3. Current milestone identification
4. Next phase number calculation (ignoring decimals)
5. Slug generation from description
6. Phase directory creation
7. Roadmap entry insertion
8. STATE.md updates
</process>
