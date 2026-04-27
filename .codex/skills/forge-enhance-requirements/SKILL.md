---
name: forge-enhance-requirements
description: Enhance requirements through quality audit, domain research, and gap detection
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/enhance-requirements.md
@~/.codex/forge/atos-forge/templates/requirements.md
</execution_context>

<objective>
Improve existing requirements through AI-powered analysis and domain research.

**Enhancement modes:**
- **Full Analysis** — quality audit + domain research + gap detection + suggestions (default)
- **Quality Audit** — check requirements against 5 quality criteria, suggest rewrites
- **Gap Detection** — research domain to find missing requirements
- **Add Requirements** — interactively add new high-quality requirements

**How it works:**
1. Load existing REQUIREMENTS.md and project context
2. Audit quality of each requirement (specific? testable? user-centric? atomic? unambiguous?)
3. Spawn parallel research agents to discover gaps in the domain
4. Present all suggestions interactively — user accepts/rejects each
5. Update REQUIREMENTS.md with accepted changes
6. Warn if roadmap needs updating

**Output:** Updated `.planning/REQUIREMENTS.md` with higher-quality, more complete requirements
</objective>

<context>
Mode: $ARGUMENTS (optional — defaults to Full Analysis)
Supported: --mode full, --mode quality, --mode gaps, --mode add

**Load project state:**
@.planning/REQUIREMENTS.md (required)
@.planning/PROJECT.md (required)

**Load if available:**
@.planning/research/SUMMARY.md
@.planning/ROADMAP.md
@.planning/codebase/ARCHITECTURE.md
</context>

<process>
Execute the enhance-requirements workflow from @~/.codex/forge/atos-forge/workflows/enhance-requirements.md end-to-end.

If --mode flag provided, skip mode selection and jump to the specified mode:
- --mode full → run steps 3, 4, 5, 6, 7, 8, 9, 10
- --mode quality → run steps 3, 6 (rewrites only), 8, 9, 10
- --mode gaps → run steps 4, 5, 6 (new requirements only), 8, 9, 10
- --mode add → run steps 7, 8, 9, 10

Preserve all workflow gates (user approval before writing changes).
</process>

<success_criteria>
- Every requirement in REQUIREMENTS.md meets all 5 quality criteria
- Domain gaps identified through research, not guessing
- User reviewed and approved all changes before they were applied
- REQ-ID numbering is consistent (no gaps, no duplicates)
- Cascade warning shown if roadmap needs updating
- Changes committed to git
</success_criteria>
