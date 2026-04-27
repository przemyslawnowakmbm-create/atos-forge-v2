<purpose>
Validate built features through conversational testing with persistent state. Creates UAT.md that tracks test progress, survives /clear, and feeds gaps into /forge-plan-phase --gaps.

User tests, Claude records. One test at a time. Plain text responses.
</purpose>

<philosophy>
**Show expected, ask if reality matches.**

Claude presents what SHOULD happen. User confirms or describes what's different.
- "yes" / "y" / "next" / empty → pass
- Anything else → logged as issue, severity inferred

No Pass/Fail buttons. No severity questions. Just: "Here's what should happen. Does it?"
</philosophy>

<template>
@~/.claude/atos-forge/templates/UAT.md
</template>

<required_reading>
@~/.claude/atos-forge/references/json-safety.md
</required_reading>

<process>

<step name="initialize" priority="first">
If $ARGUMENTS contains a phase number, load context:

```bash
INIT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs init verify-work "${PHASE_ARG}")
```

Parse JSON for: `planner_model`, `checker_model`, `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `has_verification`.
</step>

<step name="check_active_session">
**First: Check for active UAT sessions**

```bash
find .planning/phases -name "*-UAT.md" -type f 2>/dev/null | head -5
```

**If active sessions exist AND no $ARGUMENTS provided:**

Read each file's frontmatter (status, phase) and Current Test section.

Display inline:

```
## Active UAT Sessions

| # | Phase | Status | Current Test | Progress |
|---|-------|--------|--------------|----------|
| 1 | 04-comments | testing | 3. Reply to Comment | 2/6 |
| 2 | 05-auth | testing | 1. Login Form | 0/4 |

Reply with a number to resume, or provide a phase number to start new.
```

Wait for user response.

- If user replies with number (1, 2) → Load that file, go to `resume_from_file`
- If user replies with phase number → Treat as new session, go to `create_uat_file`

**If active sessions exist AND $ARGUMENTS provided:**

Check if session exists for that phase. If yes, offer to resume or restart.
If no, continue to `create_uat_file`.

**If no active sessions AND no $ARGUMENTS:**

```
No active UAT sessions.

Provide a phase number to start testing (e.g., /forge-verify-work 4)
```

**If no active sessions AND $ARGUMENTS provided:**

Continue to `create_uat_file`.
</step>

<step name="find_summaries">
**Find what to test:**

Use `phase_dir` from init (or run init if not already done).

```bash
ls "$phase_dir"/*-SUMMARY.md 2>/dev/null
```

Read each SUMMARY.md to extract testable deliverables.
</step>

<step name="classify_phase" depends="find_summaries">
**Classify phase type from SUMMARY.md content:**

For each SUMMARY.md, scan:
1. **Frontmatter** `subsystem:` field (database, api, auth, infra, ui, etc.)
2. **Frontmatter** `tags:` field (jwt, rls, celery, middleware, migration, etc.)
3. **Body** accomplishments for infrastructure keywords

**Infrastructure signal keywords** (in frontmatter tags, subsystem, or accomplishments):
- Database: migration, RLS, row-level security, policy, tenant_id, FK, schema, column, table, constraint, backfill
- Auth/Security: JWT, claim, token, RBAC, role, permission, guard, middleware, authentication, authorization
- API wiring: dependency injection, get_db, get_tenant_db, API sweep, endpoint wiring, route handler
- Task/Worker: Celery, task, worker, queue, async task, tenant context, task dispatch
- Infrastructure: Docker, container, Redis, pub/sub, WebSocket, health check, connector

**Classification output** (stored in memory, not written to file):
- `has_backend_tests: true/false`
- `backend_categories: []` — subset of [database, auth, api, worker, infra]

**Rule:** If ANY SUMMARY.md in the phase has infrastructure signal keywords → `has_backend_tests: true`.
Pure UI phases (all SUMMARYs have subsystem: ui, no infra keywords) → `has_backend_tests: false`.
</step>

<step name="extract_tests">
**Extract testable deliverables from SUMMARY.md files:**

### Pass 1: UI & Observable Tests (existing behavior, unchanged)

Parse for:
1. **Accomplishments** — Features/functionality added
2. **User-facing changes** — UI, workflows, interactions

Focus on USER-OBSERVABLE outcomes, not implementation details.

For each deliverable, create a test:
- type: ui
- name: Brief test name
- expected: What the user should see/experience (specific, observable)

Examples:
- Accomplishment: "Added comment threading with infinite nesting"
  → Test: { type: ui, name: "Reply to a Comment", expected: "Clicking Reply opens inline composer..." }

Skip internal/non-observable items for UI tests.

### Pass 2: Backend & Infrastructure Tests (NEW — only if has_backend_tests)

If `has_backend_tests` is true from classify_phase, parse ALL SUMMARY.md accomplishments
(including items that Pass 1 skipped) and generate verification tests.

For each infrastructure accomplishment, create a test with:
- type: database | api | auth | worker | infra
- name: Brief verification name
- expected: What the correct output looks like
- command: |
    Exact command(s) to verify this.
    Claude will execute these via Bash tool — user reviews output.
    Use project's docker compose service names.

**Backend test generation rules by category:**

**database** — For migration/schema/RLS accomplishments:
- Verify table existence: `docker compose exec db psql -U <user> -d <db> -c "SELECT ..."`
- Verify RLS policies: `... -c "SELECT polname, polcmd FROM pg_policy WHERE ..."`
- Verify column constraints: `... -c "SELECT column_name, is_nullable FROM information_schema.columns WHERE ..."`
- Verify seed data: `... -c "SELECT id, name FROM <table> WHERE ..."`

**auth** — For JWT/RBAC/middleware accomplishments:
- Verify JWT claims: `curl -s -X POST http://localhost:<port>/api/auth/login -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}' | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token'].split('.')[1]; print(json.loads(base64.b64decode(t+'==')))"`
- Verify role guards: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<port>/api/admin/tenants -H 'Authorization: Bearer <non-admin-token>'` → expect 403

**api** — For endpoint wiring/tenant isolation accomplishments:
- Verify tenant-scoped responses: `curl -s http://localhost:<port>/api/<resource> -H 'Authorization: Bearer <token>'` → verify response contains only tenant's data
- Verify cross-tenant isolation: Two curl calls with different tenant tokens, verify non-overlapping results

**worker** — For Celery/task accomplishments:
- Verify task dispatch: `docker compose logs --tail=20 celery-worker | grep tenant_id` or similar log inspection
- Verify queue routing: `docker compose exec redis redis-cli LLEN <queue_name>`

**infra** — For Docker/config/health accomplishments:
- Verify service health: `curl -s http://localhost:<port>/health`
- Verify config applied: `docker compose exec backend python -c "..."`

**Important constraints for command generation:**
- Use the project's actual service names from docker-compose.yml
- Use actual credentials from .env or seeded defaults
- Use actual port mappings (read from CLAUDE.md or docker-compose.yml)
- Commands must work when services are running (`docker compose up`)
- Prefer simple shell commands over complex scripts
- Each command should verify ONE thing clearly

### Test ordering: backend tests FIRST, then UI tests

Backend tests verify the foundation. UI tests verify the surface.
If the database is wrong, UI tests will fail for the wrong reasons.

Numbering: backend tests 1..N, then UI tests N+1..M.
</step>

<step name="create_uat_file">
**Create UAT file with all tests:**

```bash
mkdir -p "$PHASE_DIR"
```

Build test list from extracted deliverables (backend tests first, then UI tests).

Create file:

```markdown
---
status: testing
phase: XX-name
source: [list of SUMMARY.md files]
started: [ISO timestamp]
updated: [ISO timestamp]
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: [first test name]
expected: |
  [what user should observe]
awaiting: user response

## Tests

### 1. [Backend Test Name]
type: database
command: |
  docker compose exec db psql -U l1auto -d l1auto -c "SELECT polname FROM pg_policy WHERE polrelid='tickets'::regclass"
expected: Should show an RLS policy name like `tenant_isolation_tickets`
result: [pending]

### 2. [Backend Test Name]
type: auth
command: |
  curl -s -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"admin@l1auto.local","password":"admin"}' | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token'].split('.')[1]; print(json.loads(base64.b64decode(t+'==')))"
expected: JSON payload containing `tenant_id` field with a UUID value
result: [pending]

...

### 8. [UI Test Name]
type: ui
expected: [observable behavior]
result: [pending]

...

## Summary

total: [N]
passed: 0
issues: 0
pending: [N]
skipped: 0

### By Type
database: 0/[N]
auth: 0/[N]
api: 0/[N]
ui: 0/[N]

## Gaps

[none yet]
```

**Notes:**
- Backend tests (type: database, auth, api, worker, infra) are numbered FIRST
- UI tests (type: ui) follow after all backend tests
- `type` field present on every test; defaults to `ui` if omitted (backward compat)
- Backend tests include `command` field with executable verification command
- By Type summary only shows categories that have tests
- Pure UI phases omit the By Type section entirely

Write to `.planning/phases/XX-name/{phase_num}-UAT.md`

Proceed to `present_test`.
</step>

<step name="present_test">
**Present current test to user:**

Read Current Test section from UAT file.

**If test has type: ui (or no type field — backward compat):**

Display using existing checkpoint box format (unchanged):

```
╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT: Verification Required                           ║
╚══════════════════════════════════════════════════════════════╝

**Test {number}: {name}**

{expected}

──────────────────────────────────────────────────────────────
→ Type "pass" or describe what's wrong
──────────────────────────────────────────────────────────────
```

Wait for user response (plain text, no AskUserQuestion).

**If test has type: database|api|auth|worker|infra:**

**Backend tests are auto-evaluated by a script. Do NOT run the raw command yourself. Do NOT show raw test output. Do NOT ask user to type "pass". Run the evaluator script and check exit code.**

Run this ONE command via Bash tool (substitute {command} and {expected} from the UAT test):

```bash
node "$HOME/.claude/atos-forge/bin/uat-run-and-eval.cjs" --command "{command}" --expected "{expected}"
```

**If exit code is 0** (output starts with `FORGE_UAT_PASS`):
The test passed. Do NOT show anything to user. Do NOT wait for user. Record as `auto_pass` in UAT file with `auto_check` set to the reason from the output. Collect into a batch. After all consecutive auto-passing backend tests finish (or a non-pass test appears, or tests end), display the batch summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BACKEND CHECKS — {N} tests auto-passed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ✓ Test 1: {name} ({reason from FORGE_UAT_PASS line})
 ✓ Test 2: {name} ({reason from FORGE_UAT_PASS line})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Continue to next test automatically. No user interaction.

**If exit code is non-zero** (output starts with `FORGE_UAT_FAIL` or `FORGE_UAT_INCONCLUSIVE`):
Extract the reason from the first line and raw output from between `---RAW_OUTPUT---` and `---END_OUTPUT---` markers. Flush any pending auto-pass batch, then show for manual review:

```
╔══════════════════════════════════════════════════════════════╗
║  BACKEND CHECK [{type}]  ⚠ NEEDS REVIEW                     ║
╚══════════════════════════════════════════════════════════════╝

**Test {number}: {name}**

**Command executed:**
{command}

**Output:**
{raw output from between the markers}

**Expected:** {expected}
**Auto-check:** {FAIL or INCONCLUSIVE} — {reason from first line}

──────────────────────────────────────────────────────────────
→ Type "pass" to override, or describe the issue
──────────────────────────────────────────────────────────────
```

Wait for user response (plain text, no AskUserQuestion).
</step>

<step name="process_response">
**Process user response (or auto-evaluation result) and update file:**

**If test was auto-evaluated as PASS (exit code 0 from uat-run-and-eval.cjs):**
- No user response needed — do NOT wait for user

Update Tests section:
```
### {N}. {name}
type: {type}
command: |
  {command}
expected: {expected}
result: auto_pass
auto_check: "{reason from FORGE_UAT_PASS output}"
```

Count as passed in Summary.

**If response indicates pass (manual confirmation):**
- Empty response, "yes", "y", "ok", "pass", "next", "approved", "✓"

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: pass
```

**If response indicates skip:**
- "skip", "can't test", "n/a"

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: skipped
reason: [user's reason if provided]
```

**If response is anything else:**
- Treat as issue description

Infer severity from description:
- Contains: crash, error, exception, fails, broken, unusable → blocker
- Contains: doesn't work, wrong, missing, can't → major
- Contains: slow, weird, off, minor, small → minor
- Contains: color, font, spacing, alignment, visual → cosmetic
- Default if unclear: major

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: issue
reported: "{verbatim user response}"
severity: {inferred}
```

Append to Gaps section (structured YAML for plan-phase --gaps):
```yaml
- truth: "{expected behavior from test}"
  type: {test type: ui, database, api, auth, worker, or infra}
  command: "{verification command, if backend test — omit for ui tests}"
  status: failed
  reason: "User reported: {verbatim user response}"
  severity: {inferred}
  test: {N}
  artifacts: []  # Filled by diagnosis
  missing: []    # Filled by diagnosis
```

**After any response:**

Update Summary counts.
Update frontmatter.updated timestamp.

**Ledger:** On issue detection, log the warning:
```bash
TOOLS="$HOME/.claude/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger log-warning "UAT issue: ${TEST_NAME} — ${USER_RESPONSE}" --severity "${SEVERITY}" --source "verify-work" 2>/dev/null
```

**Ledger:** On auto-pass, log the decision:
```bash
TOOLS="$HOME/.claude/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger log-decision "UAT auto-pass: ${TEST_NAME} — ${AUTO_CHECK}" --rationale "Backend test auto-evaluated" --source "verify-work" 2>/dev/null
```

If more tests remain → Update Current Test, go to `present_test`
If no more tests → Go to `complete_session`
</step>

<step name="resume_from_file">
**Resume testing from UAT file:**

Read the full UAT file.

Find first test with `result: [pending]`.

Announce:
```
Resuming: Phase {phase} UAT
Progress: {passed + issues + skipped}/{total}
Issues found so far: {issues count}

Continuing from Test {N}...
```

Update Current Test section with the pending test.
Proceed to `present_test`.
</step>

<step name="complete_session">
**Complete testing and commit:**

Update frontmatter:
- status: complete
- updated: [now]

Clear Current Test section:
```
## Current Test

[testing complete]
```

Commit the UAT file:
```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "test({phase_num}): complete UAT - {passed} passed, {issues} issues" --files ".planning/phases/XX-name/{phase_num}-UAT.md"
```

**Ledger:** Log UAT completion:
```bash
TOOLS="$HOME/.claude/atos-forge/atos-forge/bin/forge-tools.cjs"
node "$TOOLS" ledger log-decision "UAT complete: ${PASSED} passed, ${ISSUES} issues, ${SKIPPED} skipped" --rationale "Phase ${PHASE_NUM} verification" 2>/dev/null
```

Present summary:
```
## UAT Complete: Phase {phase}

| Result  | Count |
|---------|-------|
| Passed  | {N}   |
| Issues  | {N}   |
| Skipped | {N}   |
```

**If phase had mixed test types (backend + UI), show per-category breakdown:**

```
| Category | Passed | Issues | Skipped |
|----------|--------|--------|---------|
| database | {N}    | {N}    | {N}     |
| auth     | {N}    | {N}    | {N}     |
| api      | {N}    | {N}    | {N}     |
| ui       | {N}    | {N}    | {N}     |
```

Only show rows for categories that have tests. Pure UI phases show no breakdown table.

```
[If issues > 0:]
### Issues Found

[List from Issues section]
```

**If issues > 0:** Proceed to `diagnose_issues`

**If issues == 0:**
```
All tests passed. Ready to continue.

- `/forge-plan-phase {next}` — Plan next phase
- `/forge-execute-phase {next}` — Execute next phase
```
</step>

<step name="diagnose_issues">
**Diagnose root causes before planning fixes:**

```
---

{N} issues found. Diagnosing root causes...

Spawning parallel debug agents to investigate each issue.
```

- Load diagnose-issues workflow
- Follow @~/.claude/atos-forge/workflows/diagnose-issues.md
- Spawn parallel debug agents for each issue
- Collect root causes
- Update UAT.md with root causes
- Proceed to `plan_gap_closure`

Diagnosis runs automatically - no user prompt. Parallel agents investigate simultaneously, so overhead is minimal and fixes are more accurate.
</step>

<step name="plan_gap_closure">
**Auto-plan fixes from diagnosed gaps:**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► PLANNING FIXES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner for gap closure...
```

Spawn forge-planner in --gaps mode:

```
Task(
  prompt="""
<planning_context>

**Phase:** {phase_number}
**Mode:** gap_closure

**UAT with diagnoses:**
@.planning/phases/{phase_dir}/{phase_num}-UAT.md

**Project State:**
@.planning/STATE.md

**Roadmap:**
@.planning/ROADMAP.md

</planning_context>

<downstream_consumer>
Output consumed by /forge-execute-phase
Plans must be executable prompts.
</downstream_consumer>
""",
  subagent_type="forge-planner",
  model="{planner_model}",
  description="Plan gap fixes for Phase {phase}"
)
```

On return:
- **PLANNING COMPLETE:** Proceed to `verify_gap_plans`
- **PLANNING INCONCLUSIVE:** Report and offer manual intervention
</step>

<step name="verify_gap_plans">
**Verify fix plans with checker:**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► VERIFYING FIX PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

Initialize: `iteration_count = 1`

Spawn forge-plan-checker:

```
Task(
  prompt="""
<verification_context>

**Phase:** {phase_number}
**Phase Goal:** Close diagnosed gaps from UAT

**Plans to verify:**
@.planning/phases/{phase_dir}/*-PLAN.md

</verification_context>

<expected_output>
Return one of:
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
""",
  subagent_type="forge-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} fix plans"
)
```

On return:
- **VERIFICATION PASSED:** Proceed to `present_ready`
- **ISSUES FOUND:** Proceed to `revision_loop`
</step>

<step name="revision_loop">
**Iterate planner ↔ checker until plans pass (max 3):**

**If iteration_count < 3:**

Display: `Sending back to planner for revision... (iteration {N}/3)`

Spawn forge-planner with revision context:

```
Task(
  prompt="""
<revision_context>

**Phase:** {phase_number}
**Mode:** revision

**Existing plans:**
@.planning/phases/{phase_dir}/*-PLAN.md

**Checker issues:**
{structured_issues_from_checker}

</revision_context>

<instructions>
Read existing PLAN.md files. Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
</instructions>
""",
  subagent_type="forge-planner",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

After planner returns → spawn checker again (verify_gap_plans logic)
Increment iteration_count

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain.`

Offer options:
1. Force proceed (execute despite issues)
2. Provide guidance (user gives direction, retry)
3. Abandon (exit, user runs /forge-plan-phase manually)

Wait for user response.
</step>

<step name="present_ready">
**Present completion and next steps:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► FIXES READY ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {X}: {Name}** — {N} gap(s) diagnosed, {M} fix plan(s) created

| Gap | Root Cause | Fix Plan |
|-----|------------|----------|
| {truth 1} | {root_cause} | {phase}-04 |
| {truth 2} | {root_cause} | {phase}-04 |

Plans verified and ready for execution.

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Execute fixes** — run fix plans

`/clear` then `/forge-execute-phase {phase} --gaps-only`

───────────────────────────────────────────────────────────────
```
</step>

</process>

<update_rules>
**Batched writes for efficiency:**

Keep results in memory. Write to file only when:
1. **Issue found** — Preserve the problem immediately
2. **Session complete** — Final write before commit
3. **Checkpoint** — Every 5 passed tests (safety net)

| Section | Rule | When Written |
|---------|------|--------------|
| Frontmatter.status | OVERWRITE | Start, complete |
| Frontmatter.updated | OVERWRITE | On any file write |
| Current Test | OVERWRITE | On any file write |
| Tests.{N}.result | OVERWRITE | On any file write (values: pass, auto_pass, issue, skipped) |
| Tests.{N}.auto_check | WRITE ONCE | When auto_pass result recorded |
| Summary | OVERWRITE | On any file write |
| Gaps | APPEND | When issue found |

On context reset: File shows last checkpoint. Resume from there.
</update_rules>

<severity_inference>
**Infer severity from user's natural language:**

| User says | Infer |
|-----------|-------|
| "crashes", "error", "exception", "fails completely" | blocker |
| "doesn't work", "nothing happens", "wrong behavior" | major |
| "works but...", "slow", "weird", "minor issue" | minor |
| "color", "spacing", "alignment", "looks off" | cosmetic |

Default to **major** if unclear. User can correct if needed.

**Never ask "how severe is this?"** - just infer and move on.
</severity_inference>

<success_criteria>
- [ ] UAT file created with all tests from SUMMARY.md
- [ ] Phase classified for backend test needs (subsystem/tags heuristic)
- [ ] Backend tests generated with verification commands when phase has infra content
- [ ] Backend tests executed by Claude via Bash — auto-evaluated against expected criteria
- [ ] Backend tests that auto-pass shown in compact batch (no user prompt needed)
- [ ] Backend tests that auto-fail or are inconclusive shown to user for manual review
- [ ] Backend tests run BEFORE UI tests (foundation first)
- [ ] Tests presented one at a time with expected behavior (UI tests and manual-review backend tests)
- [ ] User responses processed as pass/issue/skip; auto_pass recorded for auto-evaluated tests
- [ ] Severity inferred from description (never asked)
- [ ] Summary shows per-category breakdown for mixed phases
- [ ] Batched writes: on issue, every 5 passes, or completion
- [ ] Committed on completion
- [ ] If issues: parallel debug agents diagnose root causes
- [ ] If issues: forge-planner creates fix plans (gap_closure mode)
- [ ] If issues: forge-plan-checker verifies fix plans
- [ ] If issues: revision loop until plans pass (max 3 iterations)
- [ ] Ready for `/forge-execute-phase --gaps-only` when complete
</success_criteria>
