<purpose>
Create executable phase prompts (PLAN.md files) for a roadmap phase with integrated research and verification. Default flow: Research (if needed) -> Plan -> Verify -> Done. Orchestrates forge-phase-researcher, forge-planner, and forge-plan-checker agents with a revision loop (max 3 iterations).
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@~/.claude/atos-forge/references/ui-brand.md
@~/.claude/atos-forge/references/session-continuity.md
@~/.claude/atos-forge/references/json-safety.md
</required_reading>

<process>

## 1. Initialize

Load all context in one call (include file contents to avoid redundant reads):

```bash
INIT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs init plan-phase "$PHASE" --include state,roadmap,requirements,context,research,verification,uat)
```

Parse JSON for: `researcher_model`, `planner_model`, `checker_model`, `research_enabled`, `plan_checker_enabled`, `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_plans`, `plan_count`, `planning_exists`, `roadmap_exists`.

**File contents (from --include):** `state_content`, `roadmap_content`, `requirements_content`, `context_content`, `research_content`, `verification_content`, `uat_content`. These are null if files don't exist.

**If `planning_exists` is false:** Error — run `/forge-new-project` first.

## 2. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number (integer or decimal like `2.1`), flags (`--research`, `--skip-research`, `--gaps`, `--skip-verify`).

**If no phase number:** Detect next unplanned phase from roadmap.

**If `phase_found` is false:** Validate phase exists in ROADMAP.md. If valid, create the directory using `phase_slug` and `padded_phase` from init:
```bash
mkdir -p ".planning/phases/${padded_phase}-${phase_slug}"
```

**Existing artifacts from init:** `has_research`, `has_plans`, `plan_count`.

## 3. Validate Phase

```bash
PHASE_INFO=$(node ~/.claude/atos-forge/bin/forge-tools.cjs roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. **If `found` is true:** Extract `phase_number`, `phase_name`, `goal` from JSON.

## 4. Load CONTEXT.md

Use `context_content` from init JSON (already loaded via `--include context`).

**CRITICAL:** Use `context_content` from INIT — pass to researcher, planner, checker, and revision agents.

If `context_content` is not null, display: `Using phase context from: ${PHASE_DIR}/*-CONTEXT.md`

**If `context_content` is null (no CONTEXT.md exists):**

Use AskUserQuestion:
- header: "No context"
- question: "No CONTEXT.md found for Phase {X}. Plans will use research and requirements only — your design preferences won't be included. Continue or capture context first?"
- options:
  - "Continue without context" — Plan using research + requirements only
  - "Run discuss-phase first" — Capture design decisions before planning

If "Continue without context": Proceed to step 5.
If "Run discuss-phase first": Display `/forge-discuss-phase {X}` and exit workflow.

## 5. Handle Research

**Skip if:** `--gaps` flag, `--skip-research` flag, or `research_enabled` is false (from init) without `--research` override.

**If `has_research` is true (from init) AND no `--research` flag:** Use existing, skip to step 6.

**If RESEARCH.md missing OR `--research` flag:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► RESEARCHING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning researcher...
```

### Spawn forge-phase-researcher

```bash
PHASE_DESC=$(node ~/.claude/atos-forge/bin/forge-tools.cjs roadmap get-phase "${PHASE}" | jq -r '.section')
# Use requirements_content from INIT (already loaded via --include requirements)
REQUIREMENTS=$(echo "$INIT" | jq -r '.requirements_content // empty' | grep -A100 "## Requirements" | head -50)
PHASE_REQ_IDS=$(echo "$INIT" | jq -r '.roadmap_content // empty' | grep -i "Requirements:" | head -1 | sed 's/.*Requirements:\*\*\s*//' | sed 's/[\[\]]//g' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
STATE_SNAP=$(node ~/.claude/atos-forge/bin/forge-tools.cjs state-snapshot)
# Extract decisions from state-snapshot JSON: jq '.decisions[] | "\(.phase): \(.summary) - \(.rationale)"'
```

Research prompt:

```markdown
<objective>
Research how to implement Phase {phase_number}: {phase_name}
Answer: "What do I need to know to PLAN this phase well?"
</objective>

<phase_context>
IMPORTANT: If CONTEXT.md exists below, it contains user decisions from /forge-discuss-phase.
- **Phase Boundary** = SCOPE — research WITHIN this boundary only
- **Upstream Decisions** = LOCKED — research THESE as locked, same weight as Decisions
- **Decisions** = Locked — research THESE deeply, no alternatives
- **Claude's Discretion** = Freedom areas — research options, recommend
- **Specific Ideas** = GUIDANCE — use legacy references as design anchors, preserve names
- **Deferred Ideas** = Out of scope — ignore

{context_content}
</phase_context>

<additional_context>
**Phase description:** {phase_description}
**Phase requirement IDs (MUST address):** {phase_req_ids}
**Requirements:** {requirements}
**Prior decisions:** {decisions}
</additional_context>

<output>
Write to: {phase_dir}/{phase_num}-RESEARCH.md
</output>
```

```
Task(
  prompt="First, read ~/.claude/agents/forge-phase-researcher.md for your role and instructions.\n\n" + research_prompt,
  subagent_type="general-purpose",
  model="{researcher_model}",
  description="Research Phase {phase}"
)
```

### Handle Researcher Return

- **`## RESEARCH COMPLETE`:** Display confirmation, continue to step 6
- **`## RESEARCH BLOCKED`:** Display blocker, offer: 1) Provide context, 2) Skip research, 3) Abort

## 6. Check Existing Plans

```bash
ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null
```

**If exists:** Offer: 1) Add more plans, 2) View existing, 3) Replan from scratch.

## 7. Use Context Files from INIT

All file contents are already loaded via `--include` in step 1 (`@` syntax doesn't work across Task() boundaries):

```bash
# Extract from INIT JSON (no need to re-read files)
STATE_CONTENT=$(echo "$INIT" | jq -r '.state_content // empty')
ROADMAP_CONTENT=$(echo "$INIT" | jq -r '.roadmap_content // empty')
REQUIREMENTS_CONTENT=$(echo "$INIT" | jq -r '.requirements_content // empty')
RESEARCH_CONTENT=$(echo "$INIT" | jq -r '.research_content // empty')
VERIFICATION_CONTENT=$(echo "$INIT" | jq -r '.verification_content // empty')
UAT_CONTENT=$(echo "$INIT" | jq -r '.uat_content // empty')
CONTEXT_CONTENT=$(echo "$INIT" | jq -r '.context_content // empty')
```

## 7.5. Load Code Graph Context (if available)

Check `graph_available` from INIT JSON. If true:

```bash
GRAPH_AVAILABLE=$(echo "$INIT" | jq -r '.graph_available // false')
```

**If `graph_available` is true:**

Load graph context for files in this phase's plans (if plans exist already — e.g., re-planning):

```bash
GRAPH_CONTEXT=""
if [ "$GRAPH_AVAILABLE" = "true" ]; then
  # Get risk assessment and module boundaries for files this phase will touch
  GRAPH_RAW=$(node ~/.claude/atos-forge/bin/forge-tools.cjs graph status 2>/dev/null || echo "{}")
  GRAPH_RISK=$(echo "$INIT" | jq -r '.graph_risk // empty')
  GRAPH_BOUNDARIES=$(echo "$INIT" | jq -r '.graph_boundaries // empty')
  GRAPH_CAPS=$(echo "$INIT" | jq -r '.graph_capabilities // empty')
  GRAPH_CONSUMERS=$(echo "$INIT" | jq -r '.graph_consumer_count // 0')

  if [ -n "$GRAPH_RISK" ] || [ -n "$GRAPH_BOUNDARIES" ]; then
    GRAPH_CONTEXT="<code_graph_intelligence>
Risk Level: ${GRAPH_RISK}
Consumer Count: ${GRAPH_CONSUMERS}
Module Boundaries Crossed: ${GRAPH_BOUNDARIES}
Capability Requirements: ${GRAPH_CAPS}

CONSTRAINTS from code graph:
- If risk is HIGH/CRITICAL: plan smaller incremental changes, add rollback steps
- If module boundaries are crossed: document the cross-module contract in the plan
- Required capabilities indicate domain expertise needed for execution
</code_graph_intelligence>"
  fi
fi
```

**If `graph_available` is false:** Display a one-line note:
```
◇ No code graph — run /forge-init for dependency-aware planning
```

## 7.6. Requirement Impact Analysis (if system-graph.db exists)

Check if system-graph.db is available (resolve from `.forge/system-graph.db`, parent dirs, `~/.forge/system-graph.db`, or `FORGE_SYSTEM_GRAPH_PATH` env).

**If system graph exists AND `impact_analysis.enabled` is true:**

```bash
IMPACT_RESULT=$(node "$FORGE_ROOT/forge-analyze/analyzer.js" analyze \
  --phase "$PHASE_NUMBER" \
  --goal "$PHASE_NAME" \
  --root "$PROJECT_ROOT" \
  --json --write 2>/dev/null || echo '{"scope":"SINGLE_REPO","reason":"analyzer_error"}')

IMPACT_SCOPE=$(echo "$IMPACT_RESULT" | jq -r '.scope // "SINGLE_REPO"')
IMPACT_COUNT=$(echo "$IMPACT_RESULT" | jq -r '.affected_services | length // 0')
```

**If `IMPACT_SCOPE` is `MULTI_REPO`:**

Display impact summary and ask user:
```
⚠ Cross-Repo Impact Detected

This phase affects {IMPACT_COUNT} services:
{list affected services with roles}

Options:
  1. Plan across all repos (recommended)
  2. Plan single-repo only (consumer repos need separate planning)
```

If user chooses multi-repo: Load `{PADDED}-IMPACT.md` content as `IMPACT_CONTEXT` and include it in planner prompt.

**If `IMPACT_SCOPE` is `SINGLE_REPO`:** Proceed normally, log to ledger:
```
◇ Impact analysis: single-repo scope confirmed
```

**If system graph not available:** Skip silently — this step is opt-in for multi-repo projects.

## 8. Spawn forge-planner Agent

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► PLANNING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner...
```

Planner prompt:

```markdown
<planning_context>
**Phase:** {phase_number}
**Mode:** {standard | gap_closure}

**Project State:** {state_content}
**Roadmap:** {roadmap_content}
**Phase requirement IDs (every ID MUST appear in a plan's `requirements` field):** {phase_req_ids}
**Requirements:** {requirements_content}

**Phase Context:**
IMPORTANT: If context exists below, it contains USER DECISIONS from /forge-discuss-phase.
- **Phase Boundary** = SCOPE — do not exceed
- **Upstream Decisions** = LOCKED — honor exactly, same weight as Decisions
- **Decisions** = LOCKED — honor exactly, do not revisit
- **Claude's Discretion** = Freedom — make implementation choices
- **Specific Ideas** = GUIDANCE — use legacy references as design anchors, preserve names
- **Deferred Ideas** = Out of scope — do NOT include

{context_content}

**Research:** {research_content}
**Gap Closure (if --gaps):** {verification_content} {uat_content}

{graph_context}

{impact_context — if IMPACT_SCOPE is MULTI_REPO, include the full IMPACT.md content here wrapped in <cross_repo_impact> tags; otherwise omit}
</planning_context>

<downstream_consumer>
Output consumed by /forge-execute-phase. Plans need:
- Frontmatter (wave, depends_on, files_modified, autonomous)
- Tasks in XML format
- Verification criteria
- must_haves for goal-backward verification
- locked_decisions for enforced technical decisions (optional)
- verification_must_check for automated code verification (optional)

Plans should include `locked_decisions` (3-5 key technical decisions that agents cannot deviate from) and `verification_must_check` (items the verification engine checks in changed files). Example:
```yaml
locked_decisions:
  - "Use JWT for auth, not sessions"
verification_must_check:
  - "JWT token generation"
```
</downstream_consumer>

<quality_gate>
- [ ] PLAN.md files created in phase directory
- [ ] Each plan has valid frontmatter
- [ ] Tasks are specific and actionable
- [ ] Dependencies correctly identified
- [ ] Waves assigned for parallel execution
- [ ] must_haves derived from phase goal
</quality_gate>
```

```
Task(
  prompt="First, read ~/.claude/agents/forge-planner.md for your role and instructions.\n\n" + filled_prompt,
  subagent_type="general-purpose",
  model="{planner_model}",
  description="Plan Phase {phase}"
)
```

## 9. Handle Planner Return

- **`## PLANNING COMPLETE`:** Display plan count. If `--skip-verify` or `plan_checker_enabled` is false (from init): skip to step 13. Otherwise: step 10.
- **`## CHECKPOINT REACHED`:** Present to user, get response, spawn continuation (step 12)
- **`## PLANNING INCONCLUSIVE`:** Show attempts, offer: Add context / Retry / Manual

**Ledger:** After handling planner return, log the outcome:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
# On PLANNING COMPLETE:
node "$TOOLS" ledger log-decision "Plans created for phase ${PHASE_NUMBER}" --rationale "${PLAN_COUNT} plans across ${WAVE_COUNT} waves" 2>/dev/null
# On INCONCLUSIVE:
node "$TOOLS" ledger log-warning "Planning inconclusive for phase ${PHASE_NUMBER}" --severity medium 2>/dev/null
```

## 10. Spawn forge-plan-checker Agent

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► VERIFYING PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

```bash
PLANS_CONTENT=$(cat "${PHASE_DIR}"/*-PLAN.md 2>/dev/null)
```

Checker prompt:

```markdown
<verification_context>
**Phase:** {phase_number}
**Phase Goal:** {goal from ROADMAP}

**Plans to verify:** {plans_content}
**Phase requirement IDs (MUST ALL be covered):** {phase_req_ids}
**Requirements:** {requirements_content}

**Phase Context:**
IMPORTANT: Plans MUST honor user decisions. Flag as issue if plans contradict.
- **Phase Boundary** = SCOPE — plans must not exceed
- **Upstream Decisions** = LOCKED — same weight as Decisions
- **Decisions** = LOCKED — plans must implement exactly
- **Claude's Discretion** = Freedom areas — plans can choose approach
- **Specific Ideas** = GUIDANCE — legacy references must be reflected in plan design
- **Deferred Ideas** = Out of scope — plans must NOT include

{context_content}
</verification_context>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Task(
  prompt=checker_prompt,
  subagent_type="forge-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} plans"
)
```

## 11. Handle Checker Return

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 13.
- **`## ISSUES FOUND`:** Display issues, check iteration count, proceed to step 12.

**Ledger:** Log verification result:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
# On VERIFICATION PASSED:
node "$TOOLS" ledger log-decision "Plan verification passed for phase ${PHASE_NUMBER}" --rationale "All plans meet quality criteria" 2>/dev/null
# On ISSUES FOUND:
node "$TOOLS" ledger log-warning "Plan verification found issues — entering revision loop" --severity medium 2>/dev/null
```

## 12. Revision Loop (Max 3 Iterations)

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 3:**

Display: `Sending back to planner for revision... (iteration {N}/3)`

```bash
PLANS_CONTENT=$(cat "${PHASE_DIR}"/*-PLAN.md 2>/dev/null)
```

Revision prompt:

```markdown
<revision_context>
**Phase:** {phase_number}
**Mode:** revision

**Existing plans:** {plans_content}
**Checker issues:** {structured_issues_from_checker}

**Phase Context:**
Revisions MUST still honor ALL user decisions (Phase Boundary, Upstream Decisions, Locked Decisions, Specific Ideas). Deferred Ideas must remain excluded.
{context_content}
</revision_context>

<instructions>
Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Task(
  prompt="First, read ~/.claude/agents/forge-planner.md for your role and instructions.\n\n" + revision_prompt,
  subagent_type="general-purpose",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

After planner returns -> spawn checker again (step 10), increment iteration_count.

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Provide guidance and retry, 3) Abandon

**Ledger:** Log the user's choice at max iterations:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
# If force proceed:
node "$TOOLS" ledger log-decision "Force proceeded past ${ISSUE_COUNT} plan issues (max iterations)" --rationale "User chose to continue" 2>/dev/null
# If abandon:
node "$TOOLS" ledger log-rejected "Plan revision loop for phase ${PHASE_NUMBER}" --reason "Max iterations reached with ${ISSUE_COUNT} unresolved issues" 2>/dev/null
```

## 13. Present Final Status

Route to `<offer_next>` OR `auto_advance` depending on flags/config.

## 14. Auto-Advance Check

Check for auto-advance trigger:

1. Parse `--auto` flag from $ARGUMENTS
2. Read `workflow.auto_advance` from config:
   ```bash
   AUTO_CFG=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "false")
   ```

**If `--auto` flag present OR `AUTO_CFG` is true:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► AUTO-ADVANCING TO EXECUTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plans ready. Spawning execute-phase...
```

Spawn execute-phase as Task:
```
Task(
  prompt="Run /forge-execute-phase ${PHASE} --auto",
  subagent_type="general-purpose",
  description="Execute Phase ${PHASE}"
)
```

**Handle execute-phase return:**
- **PHASE COMPLETE** → Display final summary:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Forge ► PHASE ${PHASE} COMPLETE ✓
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Auto-advance pipeline finished.

  Next: /forge-discuss-phase ${NEXT_PHASE} --auto
  ```
- **GAPS FOUND / VERIFICATION FAILED** → Display result, stop chain:
  ```
  Auto-advance stopped: Execution needs review.

  Review the output above and continue manually:
  /forge-execute-phase ${PHASE}
  ```

**If neither `--auto` nor config enabled:**
Route to `<offer_next>` (existing behavior).

</process>

<offer_next>
Output this markdown directly (not as a code block):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► PHASE {X} PLANNED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {X}: {Name}** — {N} plan(s) in {M} wave(s)

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1    | 01, 02 | [objectives] |
| 2    | 03     | [objective]  |

Research: {Completed | Used existing | Skipped}
Verification: {Passed | Passed with override | Skipped}

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Execute Phase {X}** — run all {N} plans

/forge-execute-phase {X}

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────

**Also available:**
- cat .planning/phases/{phase-dir}/*-PLAN.md — review plans
- /forge-plan-phase {X} --research — re-research first

───────────────────────────────────────────────────────────────
</offer_next>

<success_criteria>
- [ ] .planning/ directory validated
- [ ] Phase validated against roadmap
- [ ] Phase directory created if needed
- [ ] CONTEXT.md loaded early (step 4) and passed to ALL agents
- [ ] Research completed (unless --skip-research or --gaps or exists)
- [ ] forge-phase-researcher spawned with CONTEXT.md
- [ ] Existing plans checked
- [ ] forge-planner spawned with CONTEXT.md + RESEARCH.md
- [ ] Plans created (PLANNING COMPLETE or CHECKPOINT handled)
- [ ] forge-plan-checker spawned with CONTEXT.md
- [ ] Verification passed OR user override OR max iterations with user decision
- [ ] User sees status between agent spawns
- [ ] User knows next steps
</success_criteria>
