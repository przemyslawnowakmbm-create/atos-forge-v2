<purpose>
Execute all plans in a phase using the full pipeline: Assessment → Splitting → Agent Factory → Parallel Planner → Container Orchestration → Verification.
</purpose>

<core_principle>
Orchestrator coordinates, not executes. Knowledge propagates between waves: Wave N agents produce warnings → written to ledger → Wave N+1 agents receive those warnings in session_context → they avoid known pitfalls.
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

Parse JSON for: `executor_model`, `verifier_model`, `commit_docs`, `parallelization`, `branching_strategy`, `branch_name`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `plans`, `incomplete_plans`, `plan_count`, `incomplete_count`, `state_exists`, `roadmap_exists`.

**If `phase_found` is false:** Error — phase directory not found.
**If `plan_count` is 0:** Error — no plans found in phase.
**If `state_exists` is false but `.planning/` exists:** Offer reconstruct or continue.

```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger update-state '{"active_command":"execute-phase","active_phase":"'"${PHASE_NUMBER}"'"}' 2>/dev/null
```
</step>

<step name="handle_branching">
Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.

**"phase" or "milestone":** Use pre-computed `branch_name` from init:
```bash
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
```

All subsequent commits go to this branch. User handles merging.
</step>

<step name="validate_phase">
From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

Report: "Found {plan_count} plans in {phase_dir} ({incomplete_count} incomplete)"
</step>

<step name="detect_capabilities">
**Check system capabilities for execution mode selection.**

```bash
# Docker availability
ORCH="$HOME/.claude/forge-containers/orchestrator.js"
DOCKER_CHECK=$(node "$ORCH" check-docker)
DOCKER_AVAILABLE=$(echo "$DOCKER_CHECK" | jq -r '.available')
DOCKER_VERSION=$(echo "$DOCKER_CHECK" | jq -r '.version // "none"')

# Resource detection
RESOURCES=$(node "$ORCH" resources --root "$(pwd)")
CORES=$(echo "$RESOURCES" | jq -r '.cores')
MEMORY=$(echo "$RESOURCES" | jq -r '.memory')
MAX_CONCURRENT=$(echo "$RESOURCES" | jq -r '.max_concurrent')

# Graph availability
GRAPH_EXISTS=false
if [ -f ".forge/graph.db" ]; then
  GRAPH_EXISTS=true
fi
```

**Select execution mode:**

| Docker | Resources | Mode |
|--------|-----------|------|
| Yes | >= 8GB, 4+ cores | **Container mode** — full parallel orchestration |
| Yes | 4-8GB, 2-3 cores | **Container mode** — max_concurrent=1, sequential within waves |
| No | any | **Worktree mode** — fallback: Task subagents in git worktrees, no isolation |

```bash
# Read configured backend preference
CONFIGURED_BACKEND=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get execution.container_backend 2>/dev/null || echo "worktree")

# Select execution mode based on config + Docker availability
if [ "$CONFIGURED_BACKEND" = "docker" ] && [ "$DOCKER_AVAILABLE" = "true" ]; then
  EXECUTION_MODE="container"
elif [ "$CONFIGURED_BACKEND" = "docker" ] && [ "$DOCKER_AVAILABLE" != "true" ]; then
  EXECUTION_MODE="worktree"
  echo "⚠ container_backend=docker configured but Docker not available — falling back to worktree"
else
  EXECUTION_MODE="worktree"
fi
```

Display:
```
◆ Execution environment:
  Docker: {DOCKER_VERSION or "not available"}
  System: {MEMORY} RAM, {CORES} cores
  Mode: {EXECUTION_MODE} (max {MAX_CONCURRENT} concurrent agents)
  Graph: {available or "not found — run /forge-init"}
```

**If worktree mode:**
```
⚠ Using worktree fallback mode (reason: {DOCKER_AVAILABLE != true ? "Docker not available" : "container_backend not set to 'docker'"})
  Agents will execute via Task subagents (no container isolation)
  Patches applied directly to working tree (sequential only)
  To enable containers: set execution.container_backend = "docker" in .forge/config.json
```

**Ledger:** Log execution mode:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger log-decision "Execution mode: ${EXECUTION_MODE} (docker=${DOCKER_AVAILABLE}, cores=${CORES}, mem=${MEMORY}, concurrent=${MAX_CONCURRENT})" 2>/dev/null
```
</step>

<step name="load_plans">
Load plan inventory with wave grouping:

```bash
PLAN_INDEX=$(node ~/.claude/atos-forge/bin/forge-tools.cjs phase-plan-index "${PHASE_NUMBER}")
```

Parse JSON for: `phase`, `plans[]` (each with `id`, `wave`, `autonomous`, `objective`, `files_modified`, `task_count`, `has_summary`), `waves` (map of wave number → plan IDs), `incomplete`, `has_checkpoints`.

**Filtering:** Skip plans where `has_summary: true`. If `--gaps-only`: also skip non-gap_closure plans. If all filtered: "No matching incomplete plans" → exit.

Collect all incomplete plan paths:
```bash
PLAN_PATHS=()
for PLAN in ${INCOMPLETE_PLANS[@]}; do
  PLAN_PATHS+=("${PHASE_DIR}/${PLAN}")
done
```
</step>

<step name="assess_and_split">
**Step 2: ASSESS each plan → split if needed → display assessment summary.**

```bash
ASSESSOR="$HOME/.claude/forge-assess/assessor.js"
SPLITTER="$HOME/.claude/forge-assess/splitter.js"
```

**If assessor available:** For each incomplete plan:

```bash
ASSESSMENT=$(node "$ASSESSOR" "${PLAN_PATH}" --root "$(pwd)" 2>/dev/null)
```

Parse each assessment for: `needs_split`, `strategy`, `metrics.overflow_ratio`, `metrics.total_estimated`, `metrics.context_limit`.

**If `needs_split` is true:**

```bash
SPLIT_RESULT=$(node "$SPLITTER" "${PLAN_PATH}" --root "$(pwd)" --format json 2>/dev/null)
```

Parse split result for `sub_plans[]`. Write each sub-plan to a temp directory:

```bash
SUB_PLAN_DIR=$(mktemp -d /tmp/forge-subplans-XXXXXX)
# For each sub_plan, write its formatted content as a .md file
# Sub-plans inherit parent's wave but add internal depends_on ordering
```

Replace the original plan path with the sub-plan paths in the execution list.

**Rebuild final plan list:**

- Plans that fit → keep original path
- Split plans → replaced by sub-plan paths (ordered by depends_on)

**Display assessment summary:**

```
╔═══════════════════════════════════════════════════════════╗
║           ASSESSMENT — Phase {X}: {Name}                  ║
╠═══════════════════════════════════════════════════════════╣
║  Plan 01: {objective}                                     ║
║    ✓ OK — 67% context utilization                         ║
║                                                           ║
║  Plan 02: {objective}                                     ║
║    ⚠ SPLIT — 187% context (strategy: concern)             ║
║    → 02a: Schema types (23%)                              ║
║    → 02b: Implementation (45%)                            ║
║    → 02c: Tests + config (31%)                            ║
║                                                           ║
║  Plan 03: {objective}                                     ║
║    ✓ OK — 42% context utilization                         ║
╠═══════════════════════════════════════════════════════════╣
║  Total: {N} execution units ({M} original, {K} from splits)║
╚═══════════════════════════════════════════════════════════╝
```

**Ledger:** Log each assessment:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger log-decision "Plan ${PLAN_ID} assessed: ${STATUS} (${UTILIZATION}% context)" --rationale "${REASON}" 2>/dev/null
```

**If assessor not available:** Skip assessment, use original plans:
```
◇ No assessor available — executing plans without context assessment
```
</step>

<step name="create_agents">
**Step 3: CREATE AGENTS via Dynamic Agent Factory.**

Build specialized agent configurations for all execution units:

```bash
FACTORY="$HOME/.claude/forge-agents/factory.js"
```

For each plan/sub-plan in the final execution list:

```bash
AGENT_CONFIG=$(node "$FACTORY" build "${PLAN_PATH}" --root "$(pwd)" 2>/dev/null)
# Factory checks .forge/agents/ cache first. If inputs unchanged → cache HIT (instant).
# If plan/graph/ledger changed → cache MISS → full 7-step build → saves to cache.
```

Each factory result contains:
- `agentConfig` — system prompt, task prompt, archetype, context package, verification steps, session context
- `containerParams` — image selection, resource config
- `analysis` — archetype decision, risk level, affected modules, capabilities

Collect all factory results into an array.

**Display agent decisions:**

```
┌─ AGENT FACTORY ──────────────────────────────────────────┐
│                                                          │
│  schema-agent     SPECIALIST  forge-graph  LOW risk      │
│    → JWT, database_sql capabilities detected             │
│    → 3 verification steps, 45% context budget            │
│    → Session: 2 decisions, 1 warning injected            │
│                                                          │
│  stripe-agent     CAREFUL     billing      HIGH risk     │
│    → stripe, authentication capabilities detected        │
│    → 5 verification steps, 62% context budget            │
│    → Session: 2 decisions, 3 warnings injected           │
│                                                          │
│  consumer-agents  INTEGRATOR  3 modules    MEDIUM risk   │
│    → react_advanced, api_server capabilities             │
│    → 4 verification steps, 51% context budget            │
│    → Session: 2 decisions, 4 warnings injected           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

For each agent, show: task_id, archetype, affected modules, risk level, top capabilities, verification step count, context budget utilization, session context items injected.

**If factory not available:** Fall back to raw plan execution (legacy Task subagent mode from previous workflow version). Display warning:
```
⚠ Agent factory not available — using legacy executor mode
```
</step>

<step name="plan_parallel">
**Step 4: PLAN PARALLEL execution using the Parallel Planner.**

```bash
PLANNER="$HOME/.claude/forge-agents/parallel-planner.js"
```

The planner receives all factory results and produces resource-aware execution waves:

```bash
# Write factory results to temp file for planner input
CONFIGS_PATH=$(mktemp /tmp/forge-configs-XXXXXX.json)
# ... write JSON array of factory results to CONFIGS_PATH

PLAN_RESULT=$(node "$PLANNER" plan-configs "$CONFIGS_PATH" --root "$(pwd)" --json 2>/dev/null)
```

Parse the plan for: `waves[]` (each with `agents[]`, `resource_allocation`, `time_estimate`), `summary`, `resources`, `dependencies`.

**Display execution plan (the planner's formatPlan output):**

```
╔══════════════════════════════════════════════════════════╗
║          PARALLEL EXECUTION PLAN                         ║
╠══════════════════════════════════════════════════════════╣
║  System: 16GB RAM, 8 cores                               ║
║  Container limits: max 3 concurrent, 2GB each            ║
║                                                          ║
║  Wave 1 ─── [schema-agent] ─── [types-agent]            ║
║              2GB / 1 CPU       2GB / 1 CPU               ║
║                    │                │                     ║
║  Wave 2 ─── [stripe-specialist] ◄──┘                    ║
║              2GB / 1 CPU                                 ║
║                    │                                     ║
║  Wave 3 ─── [consumer-1] [consumer-2] [tests]           ║
║              2GB/1CPU    2GB/1CPU     2GB/1CPU           ║
║                                                          ║
║  Total: 6 agents, ~15 min, peak 6GB RAM                 ║
╚══════════════════════════════════════════════════════════╝
```

**Interactive mode confirmation:**

```bash
MODE=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get mode 2>/dev/null || echo "interactive")
```

If `MODE` is "interactive": Use AskUserQuestion:
- header: "Execute"
- question: "Proceed with {wave_count}-wave execution plan? ({agent_count} agents, ~{estimated_duration}, peak {peak_memory} RAM)"
- options:
  - "Execute" — Run all waves as planned
  - "Review agents" — Show full agent config details before proceeding
  - "Abort" — Cancel execution

If "Review agents": Display each agent's full analysis (factory analyze output), then re-ask execute/abort.
If "Abort": Exit workflow.

**If YOLO mode or "Execute" selected:** Continue to `execute_waves`.

**Graph impact pre-check (if graph exists):**

```bash
if [ "$GRAPH_EXISTS" = "true" ]; then
  TOOLS_PATH="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
  # Save pre-execution snapshot for later full diff
  node "$TOOLS_PATH" graph snapshot save > /dev/null 2>&1
fi
```
</step>

<step name="execute_waves">
**Step 5: EXECUTE WAVES.**

**Crash lock:** Before launching any wave, write a crash lock so interrupted sessions can be recovered:
```bash
node -e "require('$HOME/.claude/forge-session/crash-recovery').writeLock('$(pwd)', { taskId: '${PLAN_ID}', waveN: ${WAVE_NUM}, phase: '${PHASE_NUMBER}', agentId: 'execute-phase' })"
```
Update the lock after each wave completes (`updateLock` with `completedUnits`). Clear it in the `cleanup` step with `clearLock`.

Execute each wave sequentially. Within a wave: parallel via containers (or sequential in worktree mode).

**For each wave:**

**5a. Log wave start:**

```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger update-state '{"current_wave":"'"${WAVE_NUM} of ${TOTAL_WAVES}"'","agents_running":'"${WAVE_AGENT_COUNT}"',"agents_complete":'"${COMPLETED_AGENTS}"'}' 2>/dev/null
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Wave {N}/{total} — {agent_count} agent(s)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{For each agent: task_id (archetype) — objective}
Launching...
```

**5b. Launch containers → monitor → collect patches → apply:**

**Container mode (Docker available):**

The orchestrator handles the full lifecycle: acquire slot → git worktree → build spec → run container → collect patches.

```bash
ORCH="$HOME/.claude/forge-containers/orchestrator.js"

# Build Docker image if not cached
IMAGE_RESULT=$(node "$ORCH" ensure-image --root "$(pwd)")
IMAGE_OK=$(echo "$IMAGE_RESULT" | jq -r '.success')
if [ "$IMAGE_OK" != "true" ]; then
  IMAGE_ERR=$(echo "$IMAGE_RESULT" | jq -r '.error // "unknown"')
  echo "⚠ Docker image build failed: $IMAGE_ERR — falling back to worktree mode for this wave"
  # Fall through to worktree mode below
  EXECUTION_MODE="worktree"
fi

# Write wave tasks to temp file for orchestrator input
WAVE_CONFIG=$(mktemp /tmp/forge-wave-XXXXXX.json)
# ... write JSON: { "tasks": [{ "taskId": "...", "agentConfig": {...} }], "applyPatches": true }
echo "$WAVE_TASKS_JSON" > "$WAVE_CONFIG"

# Launch all agents in this wave via CLI
if [ "$EXECUTION_MODE" = "container" ]; then
  WAVE_RESULTS=$(node "$ORCH" launch-wave "$WAVE_CONFIG" --root "$(pwd)")
  WAVE_OK=$(echo "$WAVE_RESULTS" | jq -r '.success')
  WAVE_PASSED=$(echo "$WAVE_RESULTS" | jq -r '.passed')
  WAVE_FAILED=$(echo "$WAVE_RESULTS" | jq -r '.failed')

  if [ "$WAVE_OK" != "true" ]; then
    WAVE_ERR=$(echo "$WAVE_RESULTS" | jq -r '.error // "unknown"')
    echo "⚠ Container wave failed: $WAVE_ERR"
    echo "  Falling back to worktree mode for remaining agents in this wave"
    # Set EXECUTION_MODE to worktree and fall through to worktree block below
    EXECUTION_MODE="worktree"
  else
    echo "✓ Wave $WAVE_NUM: $WAVE_PASSED passed, $WAVE_FAILED failed (container mode)"
  fi

  rm -f "$WAVE_CONFIG"
fi
```

Each result from `launchAll` contains:
```json
{
  "taskId": "...",
  "status": "success|error|timeout",
  "exitCode": 0,
  "duration_ms": 45000,
  "timedOut": false,
  "patches": { "applied": [], "failed": [], "skipped": [] },
  "agentResult": { "task_id": "...", "warnings": [], "discoveries": [] },
  "learnings": { "warnings": [], "discoveries": [] },
  "errors": []
}
```

Apply collected patches to main working tree:
```bash
# Orchestrator already applies patches via patch-collector
# Results include applied/failed/skipped patch status
```

**Worktree mode (no Docker):**

Fall back to Task subagents. Execute sequentially within each wave:

```
Task(
  subagent_type="forge-executor",
  model="{executor_model}",
  prompt="
    <objective>
    Execute plan {plan_path} of phase {phase_number}-{phase_name}.
    Commit each task atomically. Create SUMMARY.md. Update STATE.md.
    </objective>

    <agent_config>
    System prompt: {agentConfig.system_prompt}
    Archetype: {agentConfig.archetype}
    Verification: {agentConfig.verification_steps}
    </agent_config>

    <execution_context>
    @~/.claude/atos-forge/workflows/execute-plan.md
    @~/.claude/atos-forge/templates/summary.md
    @~/.claude/atos-forge/references/checkpoints.md
    </execution_context>

    <files_to_read>
    Plan: {plan_path}
    State: .planning/STATE.md
    Ledger: .forge/session/ledger.md (if exists)
    </files_to_read>

    <session_context>
    {agentConfig.session_context — decisions, warnings, preferences, rejected}
    </session_context>

    <success_criteria>
    - [ ] All tasks executed
    - [ ] Each task committed individually
    - [ ] SUMMARY.md created
    - [ ] STATE.md updated
    </success_criteria>
  "
)
```

**5c. Quick verify (syntax + type check):**

After patches are applied, run quick verification:

```bash
# TypeScript check (if tsconfig exists)
if [ -f "tsconfig.json" ]; then
  TSC_RESULT=$(npx tsc --noEmit 2>&1 || true)
  TSC_EXIT=$?
fi

# ESLint check (if eslintrc exists)
LINT_RESULT=""
if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ] || [ -f "eslint.config.js" ]; then
  LINT_RESULT=$(npx eslint --quiet --no-error-on-unmatched-pattern . 2>&1 | tail -5 || true)
fi
```

**5d. If verification failed: revert bad patch, create fix-agent, re-run:**

```bash
if [ $TSC_EXIT -ne 0 ]; then
  # Identify which agent's patch caused the failure
  # Revert that agent's changes:
  git checkout -- ${FAILED_FILES}

  # Create a fix-agent using the factory with the error context
  # The fix-agent gets the TypeScript errors in its task prompt
  # plus the original agent's objective and files
  FIX_CONFIG=$(node "$FACTORY" build "${FAILED_PLAN_PATH}" --root "$(pwd)" --task-id "${TASK_ID}-fix" 2>/dev/null)
  # Re-run through orchestrator (single agent, container or worktree)
fi
```

**Max fix loops:** Controlled by config (`max_fix_loops`, default 3). If exceeded, mark the agent as failed and continue.

```bash
FIX_LOOPS=0
MAX_FIX=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get execution.max_fix_loops 2>/dev/null || echo "3")
```

**5e. Update graph incrementally:**

```bash
if [ "$GRAPH_EXISTS" = "true" ]; then
  UPDATER_PATH="$HOME/.claude/forge-graph/updater.js"
  TOOLS_PATH="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"

  if [ -f "$UPDATER_PATH" ]; then
    node "$UPDATER_PATH" "$(pwd)" > /dev/null 2>&1
  fi

  # Save snapshot after wave
  if [ -f "$TOOLS_PATH" ]; then
    node "$TOOLS_PATH" graph snapshot save > /dev/null 2>&1
  fi
fi
```

**5f. Collect agent learnings → write to ledger:**

For each agent result in the wave:

```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"

# For each warning from agent result.learnings.warnings:
node "$TOOLS" ledger log-warning "${WARNING_TEXT}" --severity medium --source "container:${TASK_ID}" 2>/dev/null

# For each discovery from agent result.learnings.discoveries:
node "$TOOLS" ledger log-discovery "${DISCOVERY_TEXT}" --source "container:${TASK_ID}" 2>/dev/null

# Wave completion log with full results:
node "$TOOLS" ledger log-wave-complete "${WAVE_NUM}" '{"agents":'"${WAVE_AGENT_COUNT}"',"passed":'"${PASSED}"',"failed":'"${FAILED}"',"patches_applied":'"${PATCHES_APPLIED}"'}' 2>/dev/null
```

**This is the critical knowledge propagation point:** Warnings written here are available to Wave N+1 agents via their session_context. The factory's `extractSessionContext()` reads the updated ledger and injects these warnings into subsequent agents' system prompts.

**5g. Show wave completion + graph diff:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Wave {N} Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Agent | Archetype | Status | Duration | Patches |
|-------|-----------|--------|----------|---------|
| schema-agent | specialist | ✓ pass | 2m 34s | 3 applied |
| types-agent | specialist | ✓ pass | 1m 48s | 2 applied |

Learnings: 1 warning, 2 discoveries captured → ledger

{If graph exists:}
◆ Graph changes:
  +2 files, +5 symbols, +3 dependencies
  Module stability: forge-graph HIGH → HIGH (no change)
```

If graph diff available:
```bash
DIFF_OUTPUT=$(node "$TOOLS_PATH" graph snapshot-diff 2>/dev/null || echo "")
```

**5h. Re-assess remaining tasks if more waves:**

If there are remaining waves AND any plans were split:

```bash
if [ "$HAS_SPLITS" = "true" ] && [ $WAVE_NUM -lt $TOTAL_WAVES ]; then
  # Re-build factory configs for remaining agents with --skip-cache
  # The factory re-reads the ledger, picking up new warnings from this wave
  # This is how Wave N+1 agents get UPDATED session context
  # --skip-cache ensures fresh build (ledger changed) and saves new version to cache

  for REMAINING_PLAN in "${REMAINING_PLANS[@]}"; do
    UPDATED_CONFIG=$(node "$FACTORY" build "${REMAINING_PLAN}" --root "$(pwd)" --skip-cache 2>/dev/null)
    # Replace the old config in the execution list
    # The new config includes updated session_context with this wave's warnings
  done

  # Re-assess context fit (graph AND ledger may have changed)
  ASSESSOR="$HOME/.claude/forge-assess/assessor.js"
  if [ -f "$ASSESSOR" ]; then
    for REMAINING_PLAN in "${REMAINING_PLANS[@]}"; do
      REASSESS=$(node "$ASSESSOR" "$REMAINING_PLAN" --root "$(pwd)" 2>/dev/null)
      NEW_RATIO=$(echo "$REASSESS" | jq -r '.metrics.overflow_ratio')
      # If previously OK plan now overflows, warn
      # If split plan now fits in fewer chunks, note
    done
  fi
fi
```

The key: **remaining agents get re-factored with fresh session context.** The factory calls `extractSessionContext()` which reads the updated ledger, pulling in warnings just written in step 5f. This ensures knowledge propagates without relying on conversation context.

**Checkpoint handling within waves:**

Plans with `autonomous: false` require user interaction. Handle identically to the legacy checkpoint flow:

1. Agent pauses at checkpoint → returns structured state
2. Present checkpoint to user
3. User responds → spawn continuation agent
4. Continuation completes → collect results normally

Auto-advance config (`workflow.auto_advance`) applies to `human-verify` and `decision` checkpoints.
`human-action` checkpoints always require user interaction.

**Handle failures:**

For each failed agent in a wave:

| Failure Type | Action |
|---|---|
| Patch fails to apply | Revert, create fix-agent, retry (up to max_fix_loops) |
| Type check fails | Revert failed file(s), fix-agent with error context |
| Agent timeout | Log warning, skip agent, continue wave |
| Agent crash | Log error, skip agent, continue wave |
| All agents in wave fail | Stop execution, report for investigation |

**classifyHandoffIfNeeded false failure:** Agent reports "failed" with error `classifyHandoffIfNeeded is not defined` → Claude Code runtime bug. Spot-check (patches exist, commits present) → if pass, treat as success.

**Ledger:** Log failures:
```bash
node "$TOOLS" ledger log-error "${FAILURE_DESCRIPTION}" --fix "${FIX_IF_ANY}" 2>/dev/null
```

Proceed to next wave.
</step>

<step name="full_verification">
**Step 6: FULL VERIFICATION.**

After all waves complete, run comprehensive verification.

**Quick verification (always runs):**

```bash
VERIFY_RESULTS=""

# 1. TypeScript
if [ -f "tsconfig.json" ]; then
  TSC_OUT=$(npx tsc --noEmit 2>&1)
  TSC_OK=$?
  VERIFY_RESULTS="${VERIFY_RESULTS}TypeScript: $([ $TSC_OK -eq 0 ] && echo 'PASS' || echo 'FAIL')\n"
fi

# 2. Tests (if test script exists)
if [ -f "package.json" ] && node -e "const p=require('./package.json'); process.exit(p.scripts?.test ? 0 : 1)" 2>/dev/null; then
  TEST_OUT=$(npm test 2>&1 | tail -20)
  TEST_OK=$?
  VERIFY_RESULTS="${VERIFY_RESULTS}Tests: $([ $TEST_OK -eq 0 ] && echo 'PASS' || echo 'FAIL')\n"
fi

# 3. Lint
if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ] || [ -f "eslint.config.js" ]; then
  LINT_OUT=$(npx eslint --quiet . 2>&1 | tail -10)
  LINT_OK=$?
  VERIFY_RESULTS="${VERIFY_RESULTS}Lint: $([ $LINT_OK -eq 0 ] && echo 'PASS' || echo 'FAIL')\n"
fi

# 4. Build (if build script exists)
if [ -f "package.json" ] && node -e "const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)" 2>/dev/null; then
  BUILD_OUT=$(npm run build 2>&1 | tail -20)
  BUILD_OK=$?
  VERIFY_RESULTS="${VERIFY_RESULTS}Build: $([ $BUILD_OK -eq 0 ] && echo 'PASS' || echo 'FAIL')\n"
fi
```

**Phase goal verification (if verifier available):**

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

Read status:
```bash
VERIFICATION_STATUS=$(grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' ')
```

| Status | Action |
|--------|--------|
| `passed` | → commit_and_report |
| `human_needed` | Present items for human testing, get approval |
| `gaps_found` | Present gap summary, offer `/forge-plan-phase {phase} --gaps` |

**Ledger:**
```bash
node "$TOOLS" ledger log-decision "Phase ${PHASE_NUMBER} verification: ${VERIFICATION_STATUS}" 2>/dev/null
```
</step>

<step name="commit_and_report">
**Step 7: COMMIT with agent metadata.**

Commit message format includes agent archetype tags:

```bash
# Collect agent summaries for commit message
AGENT_TAGS=""
for AGENT in ${COMPLETED_AGENTS[@]}; do
  AGENT_TAGS="${AGENT_TAGS} [forge:${AGENT_ARCHETYPE}]"
done

# Commit format: "feat(module): description [forge:archetype]"
# Example: "feat(billing): add checkout flow [forge:stripe-specialist]"
# Example: "feat(auth,api): integrate OAuth providers [forge:integrator]"

git add -A
git commit -m "$(cat <<EOF
feat(phase-${PHASE_NUMBER}): ${PHASE_NAME}

Executed via forge pipeline:
- ${TOTAL_AGENTS} agents across ${TOTAL_WAVES} waves
- Archetypes: ${ARCHETYPE_SUMMARY}
- Duration: ${TOTAL_DURATION}
${AGENT_TAGS}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

For per-plan commits (if plans committed individually by agents in container mode), the commit metadata is embedded in each agent's patches. For worktree mode, agents commit directly.

**Step 8: FINAL REPORT.**

```
╔═══════════════════════════════════════════════════════════════╗
║              EXECUTION COMPLETE — Phase {X}: {Name}           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Waves: {N} | Agents: {M} | Duration: {total_time}           ║
║                                                               ║
║  Verification:                                                ║
║    TypeScript:  ✓ PASS                                        ║
║    Tests:       ✓ PASS (42 passed, 0 failed)                  ║
║    Lint:        ✓ PASS                                        ║
║    Build:       ✓ PASS                                        ║
║                                                               ║
║  Agent Results:                                               ║
║    schema-agent     specialist  ✓ 2m 34s  3 patches           ║
║    types-agent      specialist  ✓ 1m 48s  2 patches           ║
║    stripe-agent     careful     ✓ 5m 12s  4 patches           ║
║    consumer-1       integrator  ✓ 3m 01s  3 patches           ║
║    consumer-2       general     ✓ 2m 55s  2 patches           ║
║    tests-agent      general     ✓ 4m 22s  5 patches           ║
║                                                               ║
║  Learnings Captured:                                          ║
║    3 warnings, 5 discoveries → session ledger                 ║
║                                                               ║
║  Graph Diff (full phase):                                     ║
║    +12 files, +45 symbols, +23 dependencies                   ║
║    Modules affected: billing, auth, api                       ║
║    New capabilities detected: stripe, authentication          ║
║    Stability: billing LOW→MEDIUM, auth HIGH→HIGH              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

**Graph diff:** Compare final snapshot vs pre-execution snapshot:
```bash
if [ "$GRAPH_EXISTS" = "true" ]; then
  FULL_DIFF=$(node "$TOOLS_PATH" graph snapshot-diff 2>/dev/null || echo "")
fi
```

**Save final snapshot:**
```bash
node "$TOOLS_PATH" graph snapshot save > /dev/null 2>&1
```
</step>

<step name="cleanup">
**Step 9: CLEANUP.**

```bash
# Container cleanup (stopped containers, dangling images)
if [ "$DOCKER_AVAILABLE" = "true" ]; then
  ORCH="$HOME/.claude/forge-containers/orchestrator.js"
  node "$ORCH" cleanup
fi

# Clear crash lock
node -e "require('$HOME/.claude/forge-session/crash-recovery').clearLock('$(pwd)')" 2>/dev/null

# Temp file cleanup
rm -rf /tmp/forge-subplans-* /tmp/forge-configs-* /tmp/forge-wave-* 2>/dev/null

# Final graph update (ensure completeness)
if [ "$GRAPH_EXISTS" = "true" ]; then
  UPDATER_PATH="$HOME/.claude/forge-graph/updater.js"
  if [ -f "$UPDATER_PATH" ]; then
    node "$UPDATER_PATH" "$(pwd)" > /dev/null 2>&1
  fi
fi
```
</step>

<step name="log_completion">
**Step 10: LOG COMPLETION to ledger.**

```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"

# Final ledger state
node "$TOOLS" ledger update-state '{"active_command":null,"current_wave":null,"agents_running":0,"phase_'"${PHASE_NUMBER}"'_status":"complete"}' 2>/dev/null

# Log completion event
node "$TOOLS" ledger log-decision "Phase ${PHASE_NUMBER} execution complete: ${PASSED_AGENTS}/${TOTAL_AGENTS} agents passed, ${TOTAL_WAVES} waves" --rationale "Verification: ${VERIFICATION_STATUS}, Duration: ${TOTAL_DURATION}" 2>/dev/null

# Archive ledger if phase complete
if [ "$VERIFICATION_STATUS" = "passed" ]; then
  node "$TOOLS" ledger archive "phase-${PHASE_NUMBER}" 2>/dev/null
fi
```
</step>

<step name="close_parent_artifacts">
**For decimal/polish phases only (X.Y pattern):** Close the feedback loop by resolving parent UAT and debug artifacts.

**Skip if** phase number has no decimal (e.g., `3`, `04`) — only applies to gap-closure phases like `4.1`, `03.1`.

**1. Detect decimal phase and derive parent:**
```bash
if [[ "$PHASE_NUMBER" == *.* ]]; then
  PARENT_PHASE="${PHASE_NUMBER%%.*}"
fi
```

**2. Find parent UAT file and update gap statuses:**

Read the parent UAT file's `## Gaps` section. Update `status: failed` → `status: resolved`.
If all gaps resolved: update UAT frontmatter `status: diagnosed` → `status: resolved`.

**3. Resolve referenced debug sessions:**

For each gap with `debug_session:`: update status → resolved, move to `.planning/debug/resolved/`.

**4. Commit updated artifacts:**
```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "docs(phase-${PARENT_PHASE}): resolve UAT gaps after ${PHASE_NUMBER} gap closure" --files .planning/phases/*${PARENT_PHASE}*/*-UAT.md .planning/debug/resolved/*.md
```
</step>

<step name="update_roadmap">
**Mark phase complete and update tracking files:**

```bash
COMPLETION=$(node ~/.claude/atos-forge/bin/forge-tools.cjs phase complete "${PHASE_NUMBER}")
```

The CLI handles: marking phase checkbox, updating Progress table, advancing STATE.md, updating REQUIREMENTS.md traceability.

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "docs(phase-${PHASE_NUMBER}): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md .planning/phases/{phase_dir}/*-VERIFICATION.md
```

**Ledger:**
```bash
node "$TOOLS" ledger update-state '{"active_phase":"'"${NEXT_PHASE}"'","status":"phase '"${PHASE_NUMBER}"' complete"}' 2>/dev/null
```
</step>

<step name="offer_next">

**If `gaps_found`:** The `full_verification` step already presents gap-closure path. Skip auto-advance.

**Auto-advance detection:**

1. Parse `--auto` flag from $ARGUMENTS
2. Read `workflow.auto_advance` from config:
   ```bash
   AUTO_CFG=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "false")
   ```

**If `--auto` or `AUTO_CFG` is true (AND verification passed):**

```
╔══════════════════════════════════════════╗
║  AUTO-ADVANCING → TRANSITION             ║
║  Phase {X} verified, continuing chain    ║
╚══════════════════════════════════════════╝
```

Execute transition workflow inline, passing `--auto` flag.

**Otherwise:** Workflow ends. User runs `/forge-progress` or transition manually.
</step>

</process>

<execution_modes>

**Container Mode (Docker available):**
Full parallel orchestration. Each agent runs in an isolated Docker container with:
- Read-only repo mount
- Writable output directory (patches, result.json)
- No network access (--network=none)
- Memory + CPU limits from config
- Non-root user
Patches collected and applied to main working tree via `git apply --3way`.

**Worktree Mode (no Docker):**
Fallback using Task subagents. Sequential execution within each wave.
Agents get the factory's system prompt and session context injected into the Task prompt.
No container isolation — agents work directly in the repo.
Still benefits from: assessment, splitting, factory specialization, parallel planning, ledger propagation.

**Weak Machine Mode (4GB RAM / 2 cores):**
Automatically detected: max_concurrent=1, sequential execution.
All waves execute one agent at a time. Same pipeline, just no parallelism.
System still works — knowledge propagation between waves still applies.

</execution_modes>

<knowledge_propagation>
The critical feedback loop that makes multi-wave execution intelligent:

```
Wave 1 agents execute
  → produce warnings (e.g., "API endpoint /billing requires auth token")
  → produce discoveries (e.g., "billing module uses Stripe v3 not v4")
    ↓
Step 5f: Write to ledger
  → ledger.logWarning("API endpoint /billing requires auth token")
  → ledger.logDiscovery("billing module uses Stripe v3 not v4")
    ↓
Step 5h: Re-build Wave 2 agent configs via factory
  → factory.extractSessionContext() reads updated ledger
  → new warnings appear in session_context.warnings
    ↓
Step 3 (for Wave 2): factory.composeSystemPrompt()
  → injects warnings into system prompt:
    "Warnings from prior work (account for these):
     - API endpoint /billing requires auth token
     - billing module uses Stripe v3 not v4"
    ↓
Wave 2 agents see these warnings in their prompt
  → avoid known pitfalls
  → build on previous discoveries
```

This propagation survives context compaction because it flows through the ledger file, not conversation history.
</knowledge_propagation>

<checkpoint_handling>
Plans with `autonomous: false` require user interaction.

**Auto-mode checkpoint handling:**

Read auto-advance config:
```bash
AUTO_CFG=$(node ~/.claude/atos-forge/bin/forge-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "false")
```

When agent returns a checkpoint AND `AUTO_CFG` is true:
- **human-verify** → Auto-approve. Log `Auto-approved checkpoint`.
- **decision** → Auto-select first option. Log `Auto-selected: [option]`.
- **human-action** → Present to user (cannot be automated).

**Standard flow (not auto-mode, or human-action type):**

1. Agent pauses at checkpoint → returns structured state
2. Present checkpoint details to user
3. User responds
4. Spawn continuation agent (NOT resume — fresh agent with explicit state)
5. Continuation completes → collect results normally

**Ledger:** Log checkpoint events:
```bash
node "$TOOLS" ledger log-decision "Checkpoint: ${TYPE} in ${TASK_ID}" --rationale "${DETAILS}" 2>/dev/null
```
</checkpoint_handling>

<failure_handling>
- **classifyHandoffIfNeeded false failure:** Agent "failed" with `classifyHandoffIfNeeded is not defined` → Claude Code bug. Spot-check (patches, commits) → treat as success if checks pass
- **Patch application failure:** Revert → create fix-agent → retry (max 3 loops)
- **Type check failure after patch:** Revert affected files → fix-agent with error context → retry
- **Agent timeout:** Log warning, skip, continue
- **Agent crash:** Log error, skip, continue
- **Dependency chain break:** Wave N fails → Wave N+1 dependents warned → user chooses attempt or skip
- **All agents in wave fail:** Stop execution, full report for investigation
</failure_handling>

<resumption>
Re-run `/forge-execute-phase {phase}` → load_plans finds completed agents (by SUMMARY.md or result.json) → skips them → resumes from first incomplete wave.

The ledger preserves: current wave, completed agents, warnings, decisions. Re-run picks up where it left off.
</resumption>

<context_efficiency>
Orchestrator: ~10-15% context. Agents: fresh context each (200k in containers, separate Task context in worktree mode). Knowledge propagates through ledger, not conversation context.
</context_efficiency>
