# UAT Template

Template for `.planning/phases/XX-name/{phase_num}-UAT.md` — persistent UAT session tracking.

---

## File Template

```markdown
---
status: testing | complete | diagnosed
phase: XX-name
source: [list of SUMMARY.md files tested]
started: [ISO timestamp]
updated: [ISO timestamp]
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: [N]
name: [test name]
expected: |
  [what user should observe]
awaiting: user response

## Tests

### 1. [Backend Test Name]
type: database
command: |
  docker compose exec db psql -U l1auto -d l1auto -c "SELECT polname FROM pg_policy WHERE polrelid='tickets'::regclass"
expected: Should show an RLS policy name like `tenant_isolation_tickets`
result: auto_pass
auto_check: "exit code 0, output contains 'tenant_isolation_tickets'"

### 2. [Backend Test Name]
type: auth
command: |
  curl -s -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"admin@l1auto.local","password":"admin"}' | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token'].split('.')[1]; print(json.loads(base64.b64decode(t+'==')))"
expected: JSON payload containing `tenant_id` field with a UUID value
result: issue
reported: "auto-check failed: expected pattern 'tenant_id' not found in output"
severity: blocker

### 3. [UI Test Name]
type: ui
expected: [observable behavior - what user should see]
result: pass

### 4. [UI Test Name]
type: ui
expected: [observable behavior]
result: issue
reported: "[verbatim user response]"
severity: major

### 5. [Test Name]
type: ui
expected: [observable behavior]
result: skipped
reason: [why skipped]

...

## Summary

total: [N]
passed: [N]
issues: [N]
pending: [N]
skipped: [N]

### By Type
database: [passed]/[total]
auth: [passed]/[total]
api: [passed]/[total]
ui: [passed]/[total]

## Gaps

<!-- YAML format for plan-phase --gaps consumption -->
- truth: "[expected behavior from test]"
  type: ui | database | api | auth | worker | infra
  command: "[verification command that was run, if backend test]"
  status: failed
  reason: "User reported: [verbatim response]"
  severity: blocker | major | minor | cosmetic
  test: [N]
  root_cause: ""     # Filled by diagnosis
  artifacts: []      # Filled by diagnosis
  missing: []        # Filled by diagnosis
  debug_session: ""  # Filled by diagnosis
```

---

<section_rules>

**Frontmatter:**
- `status`: OVERWRITE - "testing" or "complete"
- `phase`: IMMUTABLE - set on creation
- `source`: IMMUTABLE - SUMMARY files being tested
- `started`: IMMUTABLE - set on creation
- `updated`: OVERWRITE - update on every change

**Current Test:**
- OVERWRITE entirely on each test transition
- Shows which test is active and what's awaited
- On completion: "[testing complete]"

**Tests:**
- Each test: OVERWRITE result field when user responds
- `type` values: ui (default), database, api, auth, worker, infra
- If type is NOT ui: `command` field is REQUIRED (executable verification command)
- Backend tests (non-ui types) always ordered before UI tests
- `result` values: [pending], pass, auto_pass, issue, skipped
- If auto_pass: add `auto_check` field with evaluation reason (e.g. "exit code 0, output matches expected")
- If issue: add `reported` (verbatim) and `severity` (inferred)
- If skipped: add `reason` if provided
- `auto_pass` counts as passed in Summary totals and By Type breakdown

**Summary:**
- OVERWRITE counts after each response
- Tracks: total, passed, issues, pending, skipped
- **By Type** subsection: `[category]: [passed]/[total]` for each category with tests
- Pure UI phases omit the By Type subsection

**Gaps:**
- APPEND only when issue found (YAML format)
- Include `type` field matching the test type (ui, database, auth, api, worker, infra)
- Include `command` field for backend tests (helps diagnose-issues agents understand verification method)
- After diagnosis: fill `root_cause`, `artifacts`, `missing`, `debug_session`
- This section feeds directly into /forge-plan-phase --gaps

</section_rules>

<diagnosis_lifecycle>

**After testing complete (status: complete), if gaps exist:**

1. User runs diagnosis (from verify-work offer or manually)
2. diagnose-issues workflow spawns parallel debug agents
3. Each agent investigates one gap, returns root cause
4. UAT.md Gaps section updated with diagnosis:
   - Each gap gets `root_cause`, `artifacts`, `missing`, `debug_session` filled
5. status → "diagnosed"
6. Ready for /forge-plan-phase --gaps with root causes

**After diagnosis:**
```yaml
## Gaps

- truth: "Comment appears immediately after submission"
  status: failed
  reason: "User reported: works but doesn't show until I refresh the page"
  severity: major
  test: 2
  root_cause: "useEffect in CommentList.tsx missing commentCount dependency"
  artifacts:
    - path: "src/components/CommentList.tsx"
      issue: "useEffect missing dependency"
  missing:
    - "Add commentCount to useEffect dependency array"
  debug_session: ".planning/debug/comment-not-refreshing.md"
```

</diagnosis_lifecycle>

<lifecycle>

**Creation:** When /forge-verify-work starts new session
- Extract tests from SUMMARY.md files
- Set status to "testing"
- Current Test points to test 1
- All tests have result: [pending]

**During testing:**
- Present test from Current Test section
- User responds with pass confirmation or issue description
- Update test result (pass/issue/skipped)
- Update Summary counts
- If issue: append to Gaps section (YAML format), infer severity
- Move Current Test to next pending test

**On completion:**
- status → "complete"
- Current Test → "[testing complete]"
- Commit file
- Present summary with next steps

**Resume after /clear:**
1. Read frontmatter → know phase and status
2. Read Current Test → know where we are
3. Find first [pending] result → continue from there
4. Summary shows progress so far

</lifecycle>

<severity_guide>

Severity is INFERRED from user's natural language, never asked.

| User describes | Infer |
|----------------|-------|
| Crash, error, exception, fails completely, unusable | blocker |
| Doesn't work, nothing happens, wrong behavior, missing | major |
| Works but..., slow, weird, minor, small issue | minor |
| Color, font, spacing, alignment, visual, looks off | cosmetic |

Default: **major** (safe default, user can clarify if wrong)

</severity_guide>

<good_example>
**Pure UI phase example:**
```markdown
---
status: diagnosed
phase: 04-comments
source: 04-01-SUMMARY.md, 04-02-SUMMARY.md
started: 2025-01-15T10:30:00Z
updated: 2025-01-15T10:45:00Z
---

## Current Test

[testing complete]

## Tests

### 1. View Comments on Post
type: ui
expected: Comments section expands, shows count and comment list
result: pass

### 2. Create Top-Level Comment
type: ui
expected: Submit comment via rich text editor, appears in list with author info
result: issue
reported: "works but doesn't show until I refresh the page"
severity: major

### 3. Reply to a Comment
type: ui
expected: Click Reply, inline composer appears, submit shows nested reply
result: pass

### 4. Visual Nesting
type: ui
expected: 3+ level thread shows indentation, left borders, caps at reasonable depth
result: pass

### 5. Delete Own Comment
type: ui
expected: Click delete on own comment, removed or shows [deleted] if has replies
result: pass

### 6. Comment Count
type: ui
expected: Post shows accurate count, increments when adding comment
result: pass

## Summary

total: 6
passed: 5
issues: 1
pending: 0
skipped: 0

## Gaps

- truth: "Comment appears immediately after submission in list"
  type: ui
  status: failed
  reason: "User reported: works but doesn't show until I refresh the page"
  severity: major
  test: 2
  root_cause: "useEffect in CommentList.tsx missing commentCount dependency"
  artifacts:
    - path: "src/components/CommentList.tsx"
      issue: "useEffect missing dependency"
  missing:
    - "Add commentCount to useEffect dependency array"
  debug_session: ".planning/debug/comment-not-refreshing.md"
```

**Mixed phase example (infra + UI):**
```markdown
---
status: diagnosed
phase: 02-multi-tenancy
source: 02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md
started: 2025-01-20T14:00:00Z
updated: 2025-01-20T15:30:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Tenants Table Exists
type: database
command: |
  docker compose exec db psql -U l1auto -d l1auto -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='tenants' ORDER BY ordinal_position"
expected: Should show columns: id (uuid), name (varchar), slug (varchar), created_at (timestamp)
result: auto_pass
auto_check: "exit code 0, output contains 'uuid', 'varchar', 'timestamp'"

### 2. RLS Policies on Tickets
type: database
command: |
  docker compose exec db psql -U l1auto -d l1auto -c "SELECT polname, polcmd FROM pg_policy WHERE polrelid='tickets'::regclass"
expected: Should show tenant_isolation policy with polcmd='*' (all commands)
result: auto_pass
auto_check: "exit code 0, output contains 'tenant_isolation'"

### 3. JWT Contains tenant_id
type: auth
command: |
  curl -s -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","password":"admin"}' | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token'].split('.')[1]; print(json.loads(base64.b64decode(t+'==')))"
expected: JSON with tenant_id field containing a UUID
result: issue
reported: "token decodes but no tenant_id field present"
severity: blocker

### 4. Tenant Switcher in Header
type: ui
expected: Admin user sees tenant dropdown in header, can switch between tenants
result: pass

## Summary

total: 4
passed: 3
issues: 1
pending: 0
skipped: 0

### By Type
database: 2/2
auth: 0/1
ui: 1/1

## Gaps

- truth: "JWT token contains tenant_id claim"
  type: auth
  command: "curl -s -X POST http://localhost:8001/api/auth/login ... | python3 -c ..."
  status: failed
  reason: "User reported: token decodes but no tenant_id field present"
  severity: blocker
  test: 3
  root_cause: "create_access_token() in auth/jwt.py not including tenant_id in payload"
  artifacts:
    - path: "backend/app/auth/jwt.py"
      issue: "tenant_id not added to JWT claims"
  missing:
    - "Add tenant_id to JWT payload in create_access_token()"
  debug_session: ".planning/debug/jwt-missing-tenant-id.md"
```
</good_example>
