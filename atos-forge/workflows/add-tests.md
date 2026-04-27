<purpose>
Generate unit and E2E tests for a completed phase based on its SUMMARY.md, CONTEXT.md, and implementation. Classifies each changed file into TDD (unit), E2E (browser), or Skip categories, presents a test plan for user approval, then generates tests following RED-GREEN conventions.

Integrates with the Forge code graph for dependency context and capability detection.

Output: Test files committed with message `test(phase-{N}): add unit and E2E tests from add-tests command`
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="parse_arguments">
Parse `$ARGUMENTS` for:
- Phase number (integer, decimal, or letter-suffix) → store as `$PHASE_ARG`
- Remaining text after phase number → store as `$EXTRA_INSTRUCTIONS` (optional)

If no phase argument provided:
```
ERROR: Phase number required
Usage: /forge-add-tests <phase> [additional instructions]
```
Exit.
</step>

<step name="init_context">
Load phase operation context:

1. Find the phase directory in `.planning/phases/` matching the phase number.
2. Read phase artifacts (in order of priority):
   - `${phase_dir}/*-SUMMARY.md` — what was implemented, files changed
   - `${phase_dir}/CONTEXT.md` — acceptance criteria, decisions
   - `${phase_dir}/*-VERIFICATION.md` — user-verified scenarios (if UAT was done)

If no SUMMARY.md exists:
```
ERROR: No SUMMARY.md found for phase ${PHASE_ARG}
This command works on completed phases. Run /forge-execute-phase first.
```
Exit.

3. If `.forge/graph.db` exists, query the code graph for additional context:
```bash
node forge-graph/query.js context-for-task <changed-files...>
```

Present banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► ADD TESTS — Phase ${phase_number}: ${phase_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
</step>

<step name="analyze_implementation">
Extract the list of files modified by the phase from SUMMARY.md.

For each file, read it and classify into one of three categories:

| Category | Criteria | Test Type |
|----------|----------|-----------|
| **TDD** | Pure functions, business logic, validators, parsers, state machines, utilities | Unit tests |
| **E2E** | UI interactions, navigation, forms, drag-drop, modals, keyboard shortcuts | Playwright/E2E |
| **Skip** | CSS/styling, config, migrations, type defs, simple CRUD, glue code | None |

If code graph is available, also check module capabilities:
```bash
node forge-graph/query.js capabilities <module-name>
```
Use `testing` capability to determine existing test patterns.
</step>

<step name="present_classification">
Present the classification to the user for confirmation:

## Files classified for testing

### TDD (Unit Tests) — {N} files
{list of files with brief reason}

### E2E (Browser Tests) — {M} files
{list of files with brief reason}

### Skip — {K} files
{list of files with brief reason}

{if $EXTRA_INSTRUCTIONS: "Additional instructions: ${EXTRA_INSTRUCTIONS}"}

Ask: "How would you like to proceed?"
Options: Approve and generate test plan / Adjust classification / Cancel

If "Adjust": apply changes and re-present.
If "Cancel": exit.
</step>

<step name="discover_test_structure">
Discover the project's existing test structure:

```bash
find . -type d -name "*test*" -o -name "*spec*" -o -name "*__tests__*" 2>/dev/null | head -20
find . -type f \( -name "*.test.*" -o -name "*.spec.*" \) 2>/dev/null | head -20
```

Identify:
- Test directory structure
- Naming conventions (.test.ts, .spec.ts, etc.)
- Test runner from package.json (jest, vitest, mocha, node:test)
- Test framework

If ambiguous, ask the user.
</step>

<step name="generate_test_plan">
For each approved file, create a detailed test plan:

**TDD files**: identify testable functions, input scenarios, expected outputs, edge cases
**E2E files**: identify user scenarios from CONTEXT.md/VERIFICATION.md

Present the complete plan for approval.
Options: Generate all / Cherry-pick / Adjust plan
</step>

<step name="execute_tdd_generation">
For each approved TDD test:

1. Create test file following project conventions
2. Write tests with arrange/act/assert structure
3. Run the test
4. Evaluate: pass = good, assertion fail = flag as potential bug (do NOT fix implementation), error = fix test and re-run
</step>

<step name="execute_e2e_generation">
For each approved E2E test:

1. Check for existing tests covering same scenario
2. Create test file targeting user scenarios
3. Run the E2E test
4. Evaluate: pass = record, fail = determine if test or app bug, cannot run = report blocker

No-skip rule: never mark success without actually running the test.
</step>

<step name="summary_and_commit">
Present test coverage report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► TEST GENERATION COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Results

| Category | Generated | Passing | Failing | Blocked |
|----------|-----------|---------|---------|---------|
| Unit     | {N}       | {n1}    | {n2}    | {n3}    |
| E2E      | {M}       | {m1}    | {m2}    | {m3}    |

## Files Created/Modified
{list}

## Coverage Gaps
{areas that couldn't be tested and why}

## Bugs Discovered
{assertion failures indicating implementation bugs}
```

If passing tests exist, commit:
```bash
git add {test files}
git commit -m "test(phase-${phase_number}): add unit and E2E tests from add-tests command"
```

Present next steps with Next Up block.
</step>

</process>

<success_criteria>
- [ ] Phase artifacts loaded (SUMMARY.md, CONTEXT.md, optionally VERIFICATION.md)
- [ ] All changed files classified into TDD/E2E/Skip categories
- [ ] Classification presented to user and approved
- [ ] Project test structure discovered
- [ ] Test plan presented to user and approved
- [ ] TDD tests generated with arrange/act/assert structure
- [ ] E2E tests generated targeting user scenarios
- [ ] All tests executed — no untested tests marked as passing
- [ ] Bugs discovered by tests flagged (not fixed)
- [ ] Test files committed with proper message
- [ ] Coverage gaps documented
- [ ] Next steps presented to user
</success_criteria>
