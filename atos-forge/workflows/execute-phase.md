<purpose>
Execute all plans in a phase sequentially: for each plan, build agent, execute via Claude CLI, verify, commit, propagate learnings to the next plan.
</purpose>

<core_principle>
Sequential execution with verification gates. Each plan completes and verifies before the next begins. Knowledge propagates through the ledger: Plan N learnings flow to Plan N+1's agent via session_context.
</core_principle>

<required_reading>
Read STATE.md before any operation to load project context.
If `.forge/session/ledger.md` exists, read it to restore session context (decisions, warnings, preferences).

@~/.claude/atos-forge/references/json-safety.md
</required_reading>

<process>

<step name="initialize" priority="first">
Load all context in one call:

```bash
INIT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs init execute-phase "${PHASE_ARG}")
```

Parse JSON for: `executor_model`, `verifier_model`, `commit_docs`, `branching_strategy`, `branch_name`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `plans`, `incomplete_plans`, `plan_count`, `incomplete_count`, `state_exists`, `roadmap_exists`.

**If `phase_found` is false:** Error -- phase directory not found.
**If `plan_count` is 0:** Error -- no plans found in phase.
**If `state_exists` is false but `.planning/` exists:** Offer reconstruct or continue.

```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger update-state '{"active_command":"execute-phase","active_phase":"'"${PHASE_NUMBER}"'"}' 2>/dev/null
```
</step>

<step name="handle_branching">
Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.
**"phase" or "milestone":** Use pre-computed `branch_name`:
```bash
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
```
</step>

<step name="validate_phase">
From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

```bash
GRAPH_EXISTS=false
[ -f ".forge/graph.db" ] && GRAPH_EXISTS=true
```

Report: "Phase {X}: {Name} -- {plan_count} plans, {incomplete_count} incomplete, graph: {yes/no}, mode: sequential"
</step>

<step name="load_plans">
Load plan inventory and build execution order:

```bash
PLAN_INDEX=$(node ~/.claude/atos-forge/bin/forge-tools.cjs phase-plan-index "${PHASE_NUMBER}")
```

Parse JSON for: `phase`, `plans[]` (each with `id`, `wave`, `autonomous`, `objective`, `files_modified`, `task_count`, `has_summary`), `waves`, `incomplete`, `has_checkpoints`.

**Filtering:** Skip plans where `has_summary: true`. If `--gaps-only`: also skip non-gap_closure plans. If all filtered: exit.

**Build execution order:**
1. Sort by wave number (lower wave = earlier execution)
2. Within the same wave, respect `depends_on` via topological sort
3. Plans with no dependencies within a wave execute in file-name order

```bash
PLAN_PATHS=()
for PLAN in ${INCOMPLETE_PLANS[@]}; do
  PLAN_PATHS+=("${PHASE_DIR}/${PLAN}")
done
```

Display numbered execution order with wave and dependency info.

```bash
node "$TOOLS" ledger log-decision "Execution order: ${#PLAN_PATHS[@]} plans, sequential" 2>/dev/null
```
</step>

<step name="confirm_execution">
```bash
MODE=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get mode 2>/dev/null || echo "interactive")
```

If interactive mode, ask user: "Proceed with sequential execution of {plan_count} plans?" with options: Execute, Review plans, Abort.

**Graph pre-execution snapshot:**
```bash
[ "$GRAPH_EXISTS" = "true" ] && node "$TOOLS" graph snapshot save > /dev/null 2>&1
```

**Crash lock:**
```bash
node -e "require('$HOME/.claude/forge-session/crash-recovery').writeLock('$(pwd)', { phase: '${PHASE_NUMBER}', agentId: 'execute-phase', totalPlans: ${#PLAN_PATHS[@]} })"
```
</step>

<step name="execute_plans">
**Execute each plan sequentially with verification gates between them.**

```bash
FACTORY="$HOME/.claude/forge-agents/factory.js"
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
MAX_FIX=$(node "$TOOLS" config-get execution.max_fix_loops 2>/dev/null || echo "3")
COMPLETED=0
FAILED=0
```

**For each plan in execution order:**

**6a. Build agent config via factory:**

```bash
AGENT_CONFIG=$(node "$FACTORY" build "${PLAN_PATH}" --root "$(pwd)" 2>/dev/null)
```

Factory checks `.forge/agents/` cache first. Cache hit = instant reuse. Cache miss = full build + auto-save.

Result contains: `agentConfig` (system prompt, task prompt, catalog agent name, context package, verification steps, session context) and `analysis` (agent selection rationale, risk level, modules, capabilities).

Display: Plan index, plan_id, agent name, risk level, objective.

**6b. Log plan start:**

```bash
node "$TOOLS" ledger update-state '{"current_plan":"'"${PLAN_ID}"'","plan_index":'"${PLAN_INDEX}"',"plans_complete":'"${COMPLETED}"'}' 2>/dev/null
```

**6c. Execute plan via Claude CLI:**

```bash
claude --print \
  --system-prompt "${AGENT_CONFIG_SYSTEM_PROMPT}" \
  --prompt "${AGENT_CONFIG_TASK_PROMPT}" \
  --model "${EXECUTOR_MODEL}"
```

The system prompt includes session context (decisions, warnings, knowledge base) from the ledger. Agent works directly in the repo.

**Checkpoint handling:** Plans with `autonomous: false` require user interaction.
- **human-verify** with auto_advance=true -> auto-approve
- **decision** with auto_advance=true -> auto-select first option
- **human-action** -> always present to user (cannot be automated)

**6d. Quick verify (layers 1-4):**

```bash
VERIFY_ENGINE="$HOME/.claude/forge-verify/engine.js"
QUICK_RESULT=$(node "$VERIFY_ENGINE" --root "$(pwd)" --layer 1-4 --json 2>/dev/null)
QUICK_OK=$(echo "$QUICK_RESULT" | jq -r '.overall')
```

**6e. If verify fails -> fix loop (max 3 attempts):**

```bash
if [ "$QUICK_OK" != "passed" ]; then
  VERIFY_LOOP="$HOME/.claude/forge-verify/loop.js"
  FIX_RESULT=$(node "$VERIFY_LOOP" --root "$(pwd)" --max-loops "$MAX_FIX" --json 2>/dev/null)
  FIX_OK=$(echo "$FIX_RESULT" | jq -r '.overall')

  if [ "$FIX_OK" != "passed" ]; then
    REASON=$(echo "$FIX_RESULT" | jq -r '.escalation_reason // "unknown"')
    node "$TOOLS" ledger log-error "Plan ${PLAN_ID} failed verification: ${REASON}" 2>/dev/null
    FAILED=$((FAILED + 1))
    continue  # skip to next plan
  fi
fi
```

Fix loop escalation triggers: same patch hash twice (stuck), fix introduces new failures (revert), max loops exceeded.

**6f. Update graph incrementally:**

```bash
if [ "$GRAPH_EXISTS" = "true" ]; then
  UPDATER_PATH="$HOME/.claude/forge-graph/updater.js"
  [ -f "$UPDATER_PATH" ] && node "$UPDATER_PATH" "$(pwd)" > /dev/null 2>&1
  node "$TOOLS" graph snapshot save > /dev/null 2>&1
fi
```

**6g. Write learnings to ledger (CRITICAL KNOWLEDGE PROPAGATION POINT):**

```bash
node "$TOOLS" ledger log-warning "${WARNING_TEXT}" --severity medium --source "agent:${PLAN_ID}" 2>/dev/null
node "$TOOLS" ledger log-discovery "${DISCOVERY_TEXT}" --source "agent:${PLAN_ID}" 2>/dev/null
node "$TOOLS" ledger log-decision "Plan ${PLAN_ID} complete: verification passed" 2>/dev/null
```

Warnings and discoveries written here flow to the next plan's agent. The factory's `extractSessionContext()` reads the updated ledger and injects them into the next agent's system prompt.

**6h. Commit plan changes:**

```bash
git add -A
git commit -m "$(cat <<EOF
feat(phase-${PHASE_NUMBER}): ${PLAN_OBJECTIVE}

Plan: ${PLAN_ID}
Agent: ${AGENT_NAME}
Verification: passed (layers 1-4)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

**6i. Prepare next plan's context:**

The next iteration's `factory.build()` uses `--skip-cache` to ensure fresh session context from the updated ledger.

**6j. Update crash lock and display completion:**

```bash
node -e "require('$HOME/.claude/forge-session/crash-recovery').updateLock('$(pwd)', { completedPlans: ${COMPLETED} })" 2>/dev/null
```

Display: plan_id, status, duration, learnings count, graph changes. Increment COMPLETED, proceed to next plan.
</step>

<step name="full_verification">
**Run all 8 verification layers on the complete phase.**

```bash
VERIFY_ENGINE="$HOME/.claude/forge-verify/engine.js"
FULL_RESULT=$(node "$VERIFY_ENGINE" --root "$(pwd)" --json 2>/dev/null)
FULL_OK=$(echo "$FULL_RESULT" | jq -r '.overall')
```

Layers: 1-STRUCTURAL, 2-TYPE/COMPILE, 3-INTERFACE CONTRACTS, 4-DEPENDENCY, 5-TESTS, 6-BEHAVIORAL, 7-CONTRACT, 8-ARCHITECTURAL.

**If fails -> fix loop:**

```bash
if [ "$FULL_OK" != "passed" ]; then
  FIX_RESULT=$(node "$HOME/.claude/forge-verify/loop.js" --root "$(pwd)" --max-loops "$MAX_FIX" --json 2>/dev/null)
  FIX_OK=$(echo "$FIX_RESULT" | jq -r '.overall')
  [ "$FIX_OK" != "passed" ] && node "$TOOLS" ledger log-error "Phase ${PHASE_NUMBER} full verification failed" 2>/dev/null
fi
```

**Phase goal verification:**

```
Task(
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Check must_haves against actual codebase.
Create VERIFICATION.md.",
  subagent_type="forge-verifier",
  model="{verifier_model}"
)
```

```bash
VERIFICATION_STATUS=$(grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' ')
```

| Status | Action |
|--------|--------|
| `passed` | -> commit_and_report |
| `human_needed` | Present items for human testing, get approval |
| `gaps_found` | Present gap summary, offer `/forge-plan-phase {phase} --gaps` |

```bash
node "$TOOLS" ledger log-decision "Phase ${PHASE_NUMBER} verification: ${VERIFICATION_STATUS}" 2>/dev/null
```
</step>

<step name="commit_and_report">
**Commit any remaining changes from fix loops or verification:**

```bash
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$(cat <<EOF
fix(phase-${PHASE_NUMBER}): post-verification fixes

Phase: ${PHASE_NUMBER} - ${PHASE_NAME}
Verification: ${VERIFICATION_STATUS}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
  )"
fi
```

**Display final report:** Plans passed/failed, total duration, per-layer verification results, per-plan results (status, duration), learnings captured, graph diff (files/symbols/dependencies/modules).

**Graph diff:**
```bash
if [ "$GRAPH_EXISTS" = "true" ]; then
  FULL_DIFF=$(node "$TOOLS" graph snapshot-diff 2>/dev/null || echo "")
  node "$TOOLS" graph snapshot save > /dev/null 2>&1
fi
```
</step>

<step name="cleanup">
```bash
node -e "require('$HOME/.claude/forge-session/crash-recovery').clearLock('$(pwd)')" 2>/dev/null

if [ "$GRAPH_EXISTS" = "true" ]; then
  UPDATER_PATH="$HOME/.claude/forge-graph/updater.js"
  [ -f "$UPDATER_PATH" ] && node "$UPDATER_PATH" "$(pwd)" > /dev/null 2>&1
fi
```
</step>

<step name="log_completion">
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"

node "$TOOLS" ledger update-state '{"active_command":null,"current_plan":null,"phase_'"${PHASE_NUMBER}"'_status":"complete"}' 2>/dev/null
node "$TOOLS" ledger log-decision "Phase ${PHASE_NUMBER} execution complete: ${COMPLETED}/${TOTAL_PLANS} plans passed" --rationale "Verification: ${VERIFICATION_STATUS}, Duration: ${TOTAL_DURATION}" 2>/dev/null

# Archive ledger if phase complete
[ "$VERIFICATION_STATUS" = "passed" ] && node "$TOOLS" ledger archive "phase-${PHASE_NUMBER}" 2>/dev/null
```
</step>

<step name="close_parent_artifacts">
**For decimal/polish phases only (X.Y pattern).** Skip if phase number has no decimal.

```bash
if [[ "$PHASE_NUMBER" == *.* ]]; then
  PARENT_PHASE="${PHASE_NUMBER%%.*}"
fi
```

1. Find parent UAT file, update `status: failed` to `status: resolved` in Gaps section
2. If all gaps resolved: update UAT frontmatter `status: diagnosed` to `status: resolved`
3. Resolve referenced debug sessions: update status, move to `.planning/debug/resolved/`
4. Commit:
```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "docs(phase-${PARENT_PHASE}): resolve UAT gaps after ${PHASE_NUMBER} gap closure" --files .planning/phases/*${PARENT_PHASE}*/*-UAT.md .planning/debug/resolved/*.md
```
</step>

<step name="update_roadmap">
```bash
COMPLETION=$(node ~/.claude/atos-forge/bin/forge-tools.cjs phase complete "${PHASE_NUMBER}")
```

The CLI handles: marking phase checkbox, updating Progress table, advancing STATE.md, updating REQUIREMENTS.md traceability.

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "docs(phase-${PHASE_NUMBER}): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md .planning/phases/{phase_dir}/*-VERIFICATION.md

node "$TOOLS" ledger update-state '{"active_phase":"'"${NEXT_PHASE}"'","status":"phase '"${PHASE_NUMBER}"' complete"}' 2>/dev/null
```
</step>

<step name="offer_next">
**If `gaps_found`:** The `full_verification` step already presents gap-closure path. Skip auto-advance.

**Auto-advance:**
```bash
AUTO_CFG=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "false")
```

If `--auto` flag or `AUTO_CFG` is true (AND verification passed): execute transition workflow inline.
Otherwise: workflow ends, user runs `/forge-progress` or transition manually.
</step>

</process>

<knowledge_propagation>
The feedback loop that makes sequential execution intelligent:

```
Plan 1 executes
  -> warnings + discoveries
    |
Step 6g: Write to ledger (logWarning, logDiscovery)
    |
Step 6i: Next factory.build() uses --skip-cache
  -> extractSessionContext() reads updated ledger
  -> warnings injected into session_context
    |
Step 6a (next plan): composeSystemPrompt()
  -> "Warnings from prior work: ..."
    |
Plan 2 sees warnings -> avoids pitfalls, builds on discoveries
```

Propagation survives context compaction because it flows through the ledger file, not conversation history.
</knowledge_propagation>

<failure_handling>
- **Verification failure (layers 1-4):** Fix loop up to max_fix_loops (default 3), then escalate
- **Fix loop stuck:** Same patch hash twice -> escalate to user
- **Fix introduces new failures:** Revert changes, escalate to user
- **Behavioral failure (layer 6):** Cannot auto-fix, escalate to user
- **Agent timeout/crash:** Log error, mark plan as failed, continue to next plan
- **All plans fail:** Stop execution, full report for investigation
- **classifyHandoffIfNeeded false failure:** Claude Code bug. Spot-check (changes present, code compiles) -> treat as success if checks pass
</failure_handling>

<resumption>
Re-run `/forge-execute-phase {phase}` -> load_plans finds completed plans (by SUMMARY.md) -> skips them -> resumes from first incomplete plan. The ledger preserves: current plan, completed count, warnings, decisions.
</resumption>

<context_efficiency>
The execute-phase workflow uses ~10-15% context. Each agent gets a fresh Claude CLI invocation with its own context window. Knowledge propagates through the ledger file, not conversation context.
</context_efficiency>
