## Prerequisites

**Required files:**
- `.planning/REQUIREMENTS.md` — existing requirements to enhance
- `.planning/PROJECT.md` — project context

**Optional files (loaded if they exist):**
- `.planning/research/SUMMARY.md` — domain research
- `.planning/research/FEATURES.md` — feature analysis
- `.planning/ROADMAP.md` — phase structure (for cascade warnings)
- `.planning/codebase/ARCHITECTURE.md` — existing codebase context

If `.planning/REQUIREMENTS.md` does not exist, display error:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► ERROR: No requirements found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Run /forge-new-project or /forge-new-milestone first to create requirements.
```

Stop execution.

## 1. Load Context

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► ENHANCING REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Read:
- `.planning/REQUIREMENTS.md` — parse all REQ-IDs, categories, statuses
- `.planning/PROJECT.md` — extract Core Value, Context, Constraints
- `.planning/research/SUMMARY.md` (if exists)
- `.planning/codebase/ARCHITECTURE.md` (if exists)

Count existing requirements:
- Total active (unchecked `[ ]`)
- Total completed (`[x]`)
- Total future/deferred
- Categories present

Display summary:

```
Current requirements:
  Active: {N} across {M} categories
  Completed: {K}
  Future: {F}
  Categories: {list}
```

## 2. Choose Enhancement Mode

Use AskUserQuestion:

```
AskUserQuestion([
  {
    header: "Enhancement",
    question: "How would you like to enhance your requirements?",
    multiSelect: false,
    options: [
      { label: "Full Analysis", description: "Quality audit + domain research + gap detection + suggestions (most thorough)" },
      { label: "Quality Audit", description: "Check existing requirements against quality criteria — rewrite vague ones" },
      { label: "Gap Detection", description: "Research the domain to find missing requirements you haven't thought of" },
      { label: "Add Requirements", description: "I know what's missing — help me write high-quality requirements" }
    ]
  }
])
```

## 3. Quality Audit

**Runs in:** Full Analysis, Quality Audit modes.

Evaluate EVERY active requirement against the 5 quality criteria from the requirements template:
1. **Specific and Testable** — can a QA engineer write a pass/fail test?
2. **User-Centric** — does it describe observable user behavior?
3. **Atomic** — one capability per requirement?
4. **Independent** — minimal coupling?
5. **Unambiguous** — only one interpretation possible?

For each requirement, produce a score:

- **PASS** — meets all 5 criteria
- **IMPROVE** — meets 3-4 criteria, can be made better
- **REWRITE** — meets 0-2 criteria, too vague to implement

Present audit results:

```
## Quality Audit Results

### PASS ({N} requirements)
- **AUTH-01**: User can create account with email/password ✓

### IMPROVE ({N} requirements)
- **CONTENT-02**: User can edit posts
  Issues: Not specific enough — edit what? Title? Body? Both? What about published vs draft?
  Suggested rewrite: "User can edit the title and body of their own draft or published posts"

### REWRITE ({N} requirements)
- **PAY-01**: Handle payments
  Issues: Not user-centric, not specific, not testable, ambiguous
  Suggested rewrite: "User can purchase a subscription via credit card with immediate access"
```

## 4. Domain Research (Gap Detection)

**Runs in:** Full Analysis, Gap Detection modes.

Spawn parallel research agents to investigate what the requirements might be missing.

**Determine research dimensions from project context:**

Analyze PROJECT.md Core Value + existing requirement categories to determine which research dimensions are relevant. Choose 2-4 from:

| Dimension | When Relevant | What It Finds |
|-----------|---------------|---------------|
| Industry Standards | Always | What competitors/standards expect (table stakes the user may have missed) |
| Edge Cases | Always | Error states, boundary conditions, empty states, concurrent access |
| Security & Compliance | When auth/payments/PII exists | OWASP, GDPR, CCPA, accessibility (WCAG), rate limiting |
| User Journey Gaps | When UI/UX exists | Onboarding, error recovery, settings, notifications, help |
| Integration Surface | When external APIs/services exist | Webhooks, rate limits, retry logic, fallback behavior |
| Data Lifecycle | When data storage exists | Backup, export, deletion, retention, migration |

For each selected dimension, spawn a research agent:

```
Task(prompt="
<research_context>

**Project:**
@.planning/PROJECT.md

**Current Requirements:**
@.planning/REQUIREMENTS.md

**Domain Research (if exists):**
@.planning/research/SUMMARY.md

**Codebase (if exists):**
@.planning/codebase/ARCHITECTURE.md

</research_context>

<instructions>
You are researching MISSING REQUIREMENTS for a {project_domain} project.

**Research dimension:** {DIMENSION}
**Research question:** {QUESTION}

Investigate:
1. What do similar products/standards in this domain typically require?
2. What would users expect that isn't in the current requirements?
3. What edge cases or failure modes are not covered?

For each finding, write it as a SPECIFIC, TESTABLE requirement following this format:
- **[CATEGORY]-[NN]**: [User-centric, specific, testable requirement]

Categorize findings:
- **Critical gaps** — missing requirements that would cause user-facing failures
- **Important gaps** — missing requirements that degrade experience
- **Nice-to-have gaps** — improvements that could be deferred

Return findings as structured markdown. Be specific — no vague suggestions.
Do NOT suggest requirements that duplicate existing ones.
</instructions>
", subagent_type="forge-requirement-enhancer", model="{researcher_model}", description="{DIMENSION} research")
```

## 5. Synthesize Research

Collect results from all research agents. Deduplicate findings (same capability phrased differently). Merge with quality audit results if both ran.

Build enhancement report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► ENHANCEMENT REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Section A: Requirement Rewrites (from quality audit)

Show each requirement that needs improvement with before/after:

```
## Requirement Rewrites

| # | Current | Suggested Rewrite | Issue |
|---|---------|-------------------|-------|
| 1 | **CONTENT-02**: User can edit posts | **CONTENT-02**: User can edit title and body of own draft or published posts | Not specific |
| 2 | **PAY-01**: Handle payments | **PAY-01**: User can purchase subscription via credit card | Not user-centric |
```

### Section B: Missing Requirements (from gap detection)

Show discovered gaps organized by priority:

```
## Missing Requirements

### Critical Gaps
- **AUTH-04**: User receives error message when login fails with wrong password
- **CONTENT-05**: User sees loading state while content is being fetched

### Important Gaps
- **AUTH-05**: User session expires after 30 days of inactivity
- **SEC-01**: API rate-limits requests to 100/minute per user

### Nice-to-Have
- **UX-01**: User can undo accidental post deletion within 30 seconds
```

## 6. Interactive Review

Present ALL suggestions to user for acceptance/rejection. Use AskUserQuestion for each section:

**Rewrites (if any):**

```
AskUserQuestion([
  {
    header: "Rewrites",
    question: "Which requirement rewrites do you accept?",
    multiSelect: true,
    options: [
      { label: "#1 CONTENT-02", description: "\"User can edit posts\" → \"User can edit title and body of own draft or published posts\"" },
      { label: "#2 PAY-01", description: "\"Handle payments\" → \"User can purchase subscription via credit card\"" },
      { label: "Accept all", description: "Apply all suggested rewrites" },
      { label: "Reject all", description: "Keep current wording" }
    ]
  }
])
```

**New requirements (per priority tier):**

```
AskUserQuestion([
  {
    header: "Critical",
    question: "Which critical gap requirements should be added?",
    multiSelect: true,
    options: [
      { label: "AUTH-04", description: "User receives error message when login fails with wrong password" },
      { label: "CONTENT-05", description: "User sees loading state while content is being fetched" },
      { label: "Add all critical", description: "Add all critical gap requirements" },
      { label: "Skip critical", description: "Don't add any" }
    ]
  }
])
```

Repeat for Important and Nice-to-Have tiers.

**Scope decision for nice-to-haves:**

For each accepted nice-to-have, ask:

```
AskUserQuestion([
  {
    header: "Scope",
    question: "Add accepted nice-to-haves to which section?",
    multiSelect: false,
    options: [
      { label: "Active (this milestone)", description: "Build these now" },
      { label: "Future", description: "Defer to next milestone" }
    ]
  }
])
```

## 7. Add Requirements Mode

**Runs in:** Full Analysis (after review), Add Requirements mode.

If user chose "Add Requirements" or wants to add more after review:

Ask: "What capabilities are you missing? Describe what users should be able to do."

For each capability the user describes:
1. Rewrite to meet all 5 quality criteria
2. Assign appropriate category and REQ-ID (continue numbering from existing)
3. Present rewrite for confirmation

```
You said: "users need to share stuff"

Suggested requirements:
- **SHARE-01**: User can share a post via a unique URL that is publicly accessible
- **SHARE-02**: User can copy share link to clipboard with one click

Accept? (yes / adjust / skip)
```

Repeat until user says they're done.

## 8. Apply Changes

Write updated `.planning/REQUIREMENTS.md`:

1. Apply accepted rewrites (replace old requirement text with new)
2. Add accepted new requirements to appropriate sections:
   - Active requirements → add under existing or new category heading
   - Future requirements → add to Future Requirements section
3. Preserve existing checkboxes, traceability table, and completed requirements
4. Maintain REQ-ID numbering continuity (no gaps, no duplicates)

**CRITICAL:** Do NOT modify completed requirements (`[x]`). Do NOT modify the traceability table structure (only add new rows for new requirements with `Pending` status).

## 9. Cascade Check

If `.planning/ROADMAP.md` exists:

Check if any changes require roadmap updates:
- **New active requirements** → need phase mapping
- **Rewritten requirements** → may change phase scope
- **Removed requirements** → phase may lose scope

If new requirements were added to Active:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► CASCADE WARNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{N} new active requirements need phase mapping.
Run /forge-reassess-roadmap to update the roadmap.

New requirements without phases:
- {REQ-ID}: {description}
- {REQ-ID}: {description}
```

## 10. Commit

```bash
node ~/.claude/atos-forge/bin/forge-tools.cjs commit "docs: enhance requirements" --files .planning/REQUIREMENTS.md
```

Display summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► REQUIREMENTS ENHANCED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Changes:
  Rewrites applied: {N}
  Requirements added: {M}
  Requirements deferred: {F}
  Total active: {T} (was {T_old})

Next steps:
  /forge-reassess-roadmap  — Update roadmap for new requirements
  /forge-plan-phase {N}    — Plan next unplanned phase
  /forge-progress          — Check overall status
```
