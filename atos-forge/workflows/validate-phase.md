<purpose>
Validate all plans in a phase before execution. Check completeness, dependency integrity,
context feasibility, and code graph alignment. Produce a per-plan PASS/WARN/FAIL report
so the user can fix issues before committing to execution.
</purpose>

<constants>
BANNER_PREFIX = "Forge ►"
REQUIRED_FRONTMATTER = ["title", "wave", "depends_on", "verify"]
CONTEXT_BUDGET_DEFAULT = 200000
SAFETY_MARGIN = 0.20
</constants>

<process>

<step name="parse_phase">
## Step 1 — Parse Phase Number

Parse the phase number from $ARGUMENTS.

1. Read `.planning/ROADMAP.md` to resolve the phase number to a directory name.
2. Glob for `.planning/phases/{NN}-*` where NN matches the zero-padded phase number.
3. If no matching directory exists, output:
   ```
   Forge ► Phase {N} not found. No matching directory in .planning/phases/.
   ```
   and STOP.
4. Store the resolved phase directory path for subsequent steps.

Output: `Forge ► Validating phase {N}: {phase-name}`
</step>

<step name="discover_plans">
## Step 2 — Discover Plans

1. Glob for `*-PLAN.md` files inside the phase directory.
2. For each plan file, extract YAML frontmatter (between `---` delimiters).
3. Parse frontmatter fields: title, wave, depends_on, verify, files, modules.
4. If zero plans found, output:
   ```
   Forge ► No plans found in {phase-dir}. Run /forge-plan-phase {N} first.
   ```
   and STOP.

Output: `Forge ► Found {count} plan(s) in phase {N}`
</step>

<step name="check_completeness">
## Step 3 — Check Completeness

For each plan, verify required frontmatter fields are present and non-empty:

- **title** — must be a non-empty string
- **wave** — must be a positive integer
- **depends_on** — must be present (can be empty array `[]`)
- **verify** — must be a non-empty string or list describing verification criteria

Also check:
- Plan body contains at least one task heading (## or ### with actionable content)
- Plan body is not suspiciously short (< 20 lines suggests incomplete generation)

Record per-plan result:
- PASS: all required fields present and body is substantive
- WARN: optional fields missing or body is short but has required fields
- FAIL: required frontmatter field missing or body is empty
</step>

<step name="check_dependencies">
## Step 4 — Check Dependency Integrity

1. Collect all plan IDs (derived from filenames, e.g., `01-02` from `01-02-PLAN.md`).
2. For each plan with `depends_on` entries:
   a. Verify each dependency references a valid plan ID within this phase or a prior phase.
   b. Use fuzzy matching: `depends_on: [PLAN-auth-service]` should resolve to `01-02-PLAN-auth-service.md`.
3. Build a dependency DAG from all plans.
4. Run cycle detection (Kahn's algorithm or DFS):
   - If cycles found → FAIL with cycle path.
5. Check for orphaned dependencies (referencing plans that don't exist) → FAIL.
6. Check wave ordering consistency: if plan A depends on plan B, A.wave must be > B.wave → WARN if violated.

Record per-plan result:
- PASS: all dependencies valid, no cycles, wave ordering consistent
- WARN: wave ordering inconsistent but no hard errors
- FAIL: missing dependency reference or cycle detected
</step>

<step name="check_feasibility">
## Step 5 — Check Context Feasibility

For each plan:

1. Estimate token cost:
   - Plan file size (chars / 4 as rough token estimate)
   - Referenced files from frontmatter `files:` field (estimate each file ~500-2000 tokens)
   - Graph context overhead (~5000 tokens)
   - Session context overhead (~3000 tokens)
2. Load context_budget from `.forge/config.json` → `execution.context_budget` (default 200000).
3. Apply safety margin (20%): effective budget = context_budget * (1 - SAFETY_MARGIN).
4. Compare estimated cost to effective budget.

Record per-plan result:
- PASS: estimated cost < 60% of effective budget (comfortable)
- WARN: estimated cost between 60%-90% of effective budget (tight)
- FAIL: estimated cost > 90% of effective budget (likely overflow — recommend splitting)
</step>

<step name="check_code_graph">
## Step 6 — Check Code Graph Alignment

If `.forge/graph.db` exists:

1. For each plan, extract referenced files from frontmatter `files:` field and plan body.
2. Verify each referenced file exists on disk.
3. If the code graph is available, run:
   ```bash
   node forge-graph/query.js show {file}
   ```
   to confirm files are tracked in the graph.
4. Check for files mentioned in plans but not present on disk → WARN.
5. Optionally run impact analysis on modified files to flag unexpected blast radius → WARN if high.

If `.forge/graph.db` does NOT exist:
- Output: `Forge ► Code graph not available — skipping graph alignment checks.`
- Mark this check as SKIP for all plans.

Record per-plan result:
- PASS: all referenced files exist and are tracked
- WARN: some files not found or not tracked in graph, or high blast radius detected
- FAIL: majority of referenced files do not exist
- SKIP: no code graph available
</step>

<step name="summary_report">
## Step 7 — Summary Report

Compile results from steps 3-6 into a consolidated report.

Output format:
```
Forge ► Phase {N} Validation Report
══════════════════════════════════════

Plan                      Completeness  Dependencies  Feasibility  Graph    Overall
─────────────────────────────────────────────────────────────────────────────────────
{plan-id}: {title}        PASS          PASS          WARN         PASS     WARN
{plan-id}: {title}        PASS          PASS          PASS         SKIP     PASS
{plan-id}: {title}        FAIL          PASS          PASS         PASS     FAIL
─────────────────────────────────────────────────────────────────────────────────────

Summary: {pass_count} PASS | {warn_count} WARN | {fail_count} FAIL

{If any FAIL or WARN, list specific issues with fix suggestions:}

Issues:
  FAIL  {plan-id} — Missing frontmatter field: verify
        Fix: Add `verify:` field to plan frontmatter with test/check criteria.

  WARN  {plan-id} — Estimated token cost 175k exceeds 60% of budget (160k effective)
        Fix: Consider splitting via `node forge-assess/splitter.js {plan-file} --root .`

  WARN  {plan-id} — File src/api/routes.ts not found on disk
        Fix: Verify file path or update plan references.
```

Final verdict:
- If all PASS → `Forge ► Phase {N} is ready for execution.`
- If any WARN (no FAIL) → `Forge ► Phase {N} has warnings. Review before executing.`
- If any FAIL → `Forge ► Phase {N} has failures. Fix issues before running /forge-execute-phase {N}.`
</step>

</process>

<success_criteria>
- All plans in the phase are discovered and validated
- Each plan receives a clear PASS/WARN/FAIL per check category
- Dependency cycles are detected and reported
- Context feasibility is estimated against configured budget
- Summary report is actionable with specific fix suggestions
- User knows whether the phase is safe to execute
</success_criteria>
