<purpose>
Verify milestone achieved its definition of done by aggregating phase verifications, checking cross-phase integration, and assessing requirements coverage. Reads existing VERIFICATION.md files (phases already verified during execute-phase), aggregates tech debt and deferred gaps, then spawns integration checker for cross-phase wiring.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

## 0. Initialize Milestone Context

```bash
INIT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs init milestone-op)
```

Extract from init JSON: `milestone_version`, `milestone_name`, `phase_count`, `completed_phases`, `commit_docs`.

Resolve integration checker model:
```bash
CHECKER_MODEL=$(node ~/.claude/atos-forge/bin/forge-tools.cjs resolve-model forge-integration-checker --raw)
```

## 1. Determine Milestone Scope

```bash
# Get phases in milestone (sorted numerically, handles decimals)
node ~/.claude/atos-forge/bin/forge-tools.cjs phases list
```

- Parse version from arguments or detect current from ROADMAP.md
- Identify all phase directories in scope
- Extract milestone definition of done from ROADMAP.md
- Extract requirements mapped to this milestone from REQUIREMENTS.md

## 2. Read All Phase Verifications

For each phase directory, read the VERIFICATION.md:

```bash
# For each phase, use find-phase to resolve the directory (handles archived phases)
PHASE_INFO=$(node ~/.claude/atos-forge/bin/forge-tools.cjs find-phase 01 --raw)
# Extract directory from JSON, then read VERIFICATION.md from that directory
# Repeat for each phase number from ROADMAP.md
```

From each VERIFICATION.md, extract:
- **Status:** passed | gaps_found
- **Critical gaps:** (if any — these are blockers)
- **Non-critical gaps:** tech debt, deferred items, warnings
- **Anti-patterns found:** TODOs, stubs, placeholders
- **Requirements coverage:** which requirements satisfied/blocked
- **Test coverage:** `test_coverage` frontmatter (testable_files, files_with_tests, tests_passed/failed/skipped, missing_tests)

If a phase is missing VERIFICATION.md, flag it as "unverified phase" — this is a blocker.

## 3. Spawn Integration Checker

With phase context collected:

Extract `MILESTONE_REQ_IDS` from REQUIREMENTS.md traceability table — all REQ-IDs assigned to phases in this milestone.

```
Task(
  prompt="Check cross-phase integration and E2E flows.

Phases: {phase_dirs}
Phase exports: {from SUMMARYs}
API routes: {routes created}

Milestone Requirements:
{MILESTONE_REQ_IDS — list each REQ-ID with description and assigned phase}

MUST map each integration finding to affected requirement IDs where applicable.

Verify cross-phase wiring and E2E user flows.",
  subagent_type="forge-integration-checker",
  model="{integration_checker_model}"
)
```

## 4. Collect Results

Combine:
- Phase-level gaps and tech debt (from step 2)
- Integration checker's report (wiring gaps, broken flows)

## 5. Check Requirements Coverage (4-Source Cross-Reference)

MUST cross-reference four independent sources for each requirement:

### 5a. Parse REQUIREMENTS.md Traceability Table

Extract all REQ-IDs mapped to milestone phases from the traceability table:
- Requirement ID, description, assigned phase, current status, checked-off state (`[x]` vs `[ ]`)

### 5b. Parse Phase VERIFICATION.md Requirements Tables

For each phase's VERIFICATION.md, extract the expanded requirements table:
- Requirement | Source Plan | Description | Status | Evidence
- Map each entry back to its REQ-ID

### 5c. Extract SUMMARY.md Frontmatter Cross-Check

For each phase's SUMMARY.md, extract `requirements-completed` from YAML frontmatter:
```bash
for summary in .planning/phases/*-*/*-SUMMARY.md; do
  node ~/.claude/atos-forge/bin/forge-tools.cjs summary-extract "$summary" --fields requirements_completed | jq -r '.requirements_completed'
done
```

### 5d. Extract UAT Results Cross-Check

For each phase directory, check for UAT files:
```bash
find .planning/phases -name "*-UAT.md" -type f 2>/dev/null
```

For each UAT.md found:
1. Read frontmatter: `status`, `phase`, `started`, `updated`
2. Parse `## Summary` section: `total`, `passed`, `issues`, `skipped`
3. Parse `## Gaps` section: count entries with `status: failed` vs `status: resolved`
4. If VERIFICATION.md for the same phase has `uat_cross_reference` in frontmatter, use those aggregated numbers instead of re-parsing

**Build UAT coverage map:**
```
uat_coverage:
  phase_XX:
    status: complete | resolved | diagnosed
    total: N
    passed: N
    issues: N
    skipped: N
    unresolved_issues: N  # gaps with status: failed (not resolved)
```

**Flag phases missing UAT:**
Phases that have VERIFICATION.md with `human_needed` or `human_verification` items but NO UAT.md should be flagged — these have unconfirmed human verification items.

### 5e. Status Determination Matrix

For each REQ-ID, determine status using all four sources:

| VERIFICATION.md Status | SUMMARY Frontmatter | REQUIREMENTS.md | UAT Status | → Final Status |
|------------------------|---------------------|-----------------|------------|----------------|
| passed                 | listed              | `[x]`           | passed     | **satisfied** (full confidence) |
| passed                 | listed              | `[x]`           | missing    | **satisfied** (no UAT confirmation) |
| passed                 | listed              | `[ ]`           | any        | **satisfied** (update checkbox) |
| passed                 | missing             | any             | passed     | **satisfied** (UAT confirms) |
| passed                 | missing             | any             | missing    | **partial** (verify manually) |
| human_needed           | listed              | any             | passed     | **satisfied** (UAT confirms human items) |
| human_needed           | listed              | any             | missing    | **partial** (needs UAT) |
| human_needed           | any                 | any             | issues     | **unsatisfied** (UAT found problems) |
| gaps_found             | any                 | any             | any        | **unsatisfied** |
| missing                | listed              | any             | passed     | **partial** (verification gap, but UAT confirms) |
| missing                | listed              | any             | missing    | **partial** (verification gap) |
| missing                | missing             | any             | any        | **unsatisfied** |

**Key addition:** `human_needed` + UAT `passed` = **satisfied**. This is the critical path that was previously broken — user-confirmed test results now resolve `human_needed` status.

### 5f. FAIL Gate and Orphan Detection

**REQUIRED:** Any `unsatisfied` requirement MUST force `gaps_found` status on the milestone audit.

**Orphan detection:** Requirements present in REQUIREMENTS.md traceability table but absent from ALL phase VERIFICATION.md files MUST be flagged as orphaned. Orphaned requirements are treated as `unsatisfied` — they were assigned but never verified by any phase.

## 6. Aggregate into v{version}-MILESTONE-AUDIT.md

Create `.planning/v{version}-v{version}-MILESTONE-AUDIT.md` with:

```yaml
---
milestone: {version}
audited: {timestamp}
status: passed | gaps_found | tech_debt
scores:
  requirements: N/M
  phases: N/M
  integration: N/M
  flows: N/M
gaps:  # Critical blockers
  requirements:
    - id: "{REQ-ID}"
      status: "unsatisfied | partial | orphaned"
      phase: "{assigned phase}"
      claimed_by_plans: ["{plan files that reference this requirement}"]
      completed_by_plans: ["{plan files whose SUMMARY marks it complete}"]
      verification_status: "passed | gaps_found | missing | orphaned"
      evidence: "{specific evidence or lack thereof}"
  integration: [...]
  flows: [...]
tech_debt:  # Non-critical, deferred
  - phase: 01-auth
    items:
      - "TODO: add rate limiting"
      - "Warning: no password strength validation"
  - phase: 03-dashboard
    items:
      - "Deferred: mobile responsive layout"
uat_coverage:  # User acceptance testing aggregation
  phases_with_uat: N/M  # phases that have UAT.md files
  total_tests: N
  passed: N
  issues: N
  skipped: N
  unresolved_issues: N  # UAT gaps with status: failed (not yet fixed)
  phases_missing_uat:  # Phases with human_needed items but no UAT
    - phase: "{phase_name}"
      human_items: N
      reason: "No UAT session conducted"
test_coverage:  # Aggregated test coverage across all phases
  total_testable_files: N  # Sum of testable files across all phases
  total_files_with_tests: N  # Sum of files that have test coverage
  coverage_percentage: "N%"  # files_with_tests / testable_files
  total_tests_passed: N
  total_tests_failed: N
  total_tests_skipped: N
  phases_with_zero_tests:  # Phases with testable code but no tests
    - phase: "{phase_name}"
      testable_files: N
      missing_tests: ["{file_paths}"]
  phases_with_failing_tests:  # Phases where tests exist but fail
    - phase: "{phase_name}"
      failing: N
      details: "{test names or summary}"
---
```

Plus full markdown report with tables for requirements, phases, integration, tech debt.

**Status values:**
- `passed` — all requirements met, no critical gaps, minimal tech debt
- `gaps_found` — critical blockers exist
- `tech_debt` — no blockers but accumulated deferred items need review

## 7. Present Results

Route by status (see `<offer_next>`).

</process>

<offer_next>
Output this markdown directly (not as a code block). Route based on status:

---

**If passed:**

## ✓ Milestone {version} — Audit Passed

**Score:** {N}/{M} requirements satisfied
**Report:** .planning/v{version}-MILESTONE-AUDIT.md

All requirements covered. Cross-phase integration verified. E2E flows complete.

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Complete milestone** — archive and tag

/forge-complete-milestone {version}

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────

---

**If gaps_found:**

## ⚠ Milestone {version} — Gaps Found

**Score:** {N}/{M} requirements satisfied
**Report:** .planning/v{version}-MILESTONE-AUDIT.md

### Unsatisfied Requirements

{For each unsatisfied requirement:}
- **{REQ-ID}: {description}** (Phase {X})
  - {reason}

### Cross-Phase Issues

{For each integration gap:}
- **{from} → {to}:** {issue}

### Broken Flows

{For each flow gap:}
- **{flow name}:** breaks at {step}

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Plan gap closure** — create phases to complete milestone

/forge-plan-milestone-gaps

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────

**Also available:**
- cat .planning/v{version}-MILESTONE-AUDIT.md — see full report
- /forge-complete-milestone {version} — proceed anyway (accept tech debt)

───────────────────────────────────────────────────────────────

---

**If tech_debt (no blockers but accumulated debt):**

## ⚡ Milestone {version} — Tech Debt Review

**Score:** {N}/{M} requirements satisfied
**Report:** .planning/v{version}-MILESTONE-AUDIT.md

All requirements met. No critical blockers. Accumulated tech debt needs review.

### Tech Debt by Phase

{For each phase with debt:}
**Phase {X}: {name}**
- {item 1}
- {item 2}

### Total: {N} items across {M} phases

───────────────────────────────────────────────────────────────

## ▶ Options

**A. Complete milestone** — accept debt, track in backlog

/forge-complete-milestone {version}

**B. Plan cleanup phase** — address debt before completing

/forge-plan-milestone-gaps

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────
</offer_next>

<success_criteria>
- [ ] Milestone scope identified
- [ ] All phase VERIFICATION.md files read
- [ ] All phase UAT.md files read (where they exist)
- [ ] SUMMARY.md `requirements-completed` frontmatter extracted for each phase
- [ ] REQUIREMENTS.md traceability table parsed for all milestone REQ-IDs
- [ ] 4-source cross-reference completed (VERIFICATION + SUMMARY + traceability + UAT)
- [ ] UAT coverage map built (phases_with_uat, aggregated test counts)
- [ ] Phases with human_needed but no UAT flagged in phases_missing_uat
- [ ] human_needed requirements resolved to satisfied when UAT confirms
- [ ] Orphaned requirements detected (in traceability but absent from all VERIFICATIONs)
- [ ] Test coverage aggregated from VERIFICATION.md test_coverage frontmatter across all phases
- [ ] Phases with zero tests on testable code flagged in phases_with_zero_tests
- [ ] Phases with failing tests flagged in phases_with_failing_tests
- [ ] Tech debt and deferred gaps aggregated
- [ ] Integration checker spawned with milestone requirement IDs
- [ ] v{version}-MILESTONE-AUDIT.md created with structured requirement gap objects and uat_coverage
- [ ] FAIL gate enforced — any unsatisfied requirement forces gaps_found status
- [ ] Results presented with actionable next steps
</success_criteria>
