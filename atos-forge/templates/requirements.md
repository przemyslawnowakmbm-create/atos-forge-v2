# Requirements Template

Template for `.planning/REQUIREMENTS.md` — the canonical place for all milestone-scoped requirements.

**Purpose:** Single source of truth for what is being built in this milestone. Every requirement has a unique REQ-ID, is testable, and maps to phases via the traceability table.

**Lifecycle:** Created by `/forge-new-project` or `/forge-new-milestone`. Enhanced by `/forge-enhance-requirements`. Consumed by planner, verifier, roadmapper, and auditor. Archived on milestone completion.

---

## File Template

```markdown
# [Milestone Name] Requirements

## [Category 1]
- [ ] **CAT1-01**: [Specific, testable requirement in user-centric language]
- [ ] **CAT1-02**: [Another requirement]

## [Category 2]
- [ ] **CAT2-01**: [Requirement]
- [ ] **CAT2-02**: [Requirement]

## Future Requirements
- [ ] **CAT1-03**: [Deferred to future milestone — reason]
- [ ] **CAT3-01**: [Not in scope yet — reason]

## Out of Scope
- [Feature X] — [Why excluded, prevents re-adding without discussion]
- [Feature Y] — [Why excluded]

## Traceability

| Requirement | Phase | Plan | Status |
|------------|-------|------|--------|
| CAT1-01 | 1 | 1.1 | Pending |
| CAT1-02 | 1 | 1.2 | Pending |
| CAT2-01 | 2 | 2.1 | Pending |
```

---

## REQ-ID Format

`[CATEGORY]-[NUMBER]` where:
- **CATEGORY**: Short uppercase label derived from the feature domain (AUTH, CONTENT, NOTIF, PAY, ADMIN, etc.)
- **NUMBER**: Two-digit sequential within category (01, 02, 03...)

Examples: `AUTH-01`, `CONTENT-02`, `PAY-03`, `NOTIF-01`

When adding requirements to an existing file, continue numbering from the highest existing number in that category.

---

## Requirement Quality Criteria

Every requirement MUST satisfy all five criteria. Reject and rewrite requirements that fail any criterion.

### 1. Specific and Testable
A requirement is testable if you can write a pass/fail check for it.

- **Good:** "User can reset password via email link that expires after 24 hours"
- **Bad:** "Handle password reset"
- **Test:** Can a QA engineer verify this with a single test scenario?

### 2. User-Centric
Requirements describe what users can do, not what the system does internally.

- **Good:** "User can see their order history sorted by date"
- **Bad:** "System stores order data in PostgreSQL"
- **Test:** Does it start with "User can..." or describe an observable behavior?

### 3. Atomic
One capability per requirement. If it has "and" connecting two distinct features, split it.

- **Good:** "User can log in with email/password" + "User can log in with Google OAuth"
- **Bad:** "User can log in and manage their profile"
- **Test:** Can this be delivered independently of other requirements?

### 4. Independent
Minimal coupling to other requirements. Each should be implementable on its own.

- **Good:** "User can upload a profile photo" (works regardless of other features)
- **Bad:** "User can share their profile" (depends on profile existing, sharing infrastructure, etc.)
- **Test:** Could a developer implement this without needing another requirement first?

### 5. Unambiguous
Only one interpretation is possible. Avoid subjective terms.

- **Good:** "Search results appear within 2 seconds for queries under 100 characters"
- **Bad:** "Search should be fast"
- **Test:** Would two developers implement this the same way?

---

## Common Rewrites

| Vague Requirement | Specific Rewrite |
|-------------------|-----------------|
| "Handle authentication" | "User can log in with email/password and stay logged in across sessions" |
| "Support sharing" | "User can share a post via link that opens in recipient's browser" |
| "Add notifications" | "User receives email notification within 1 minute when someone comments on their post" |
| "Improve performance" | "Page load time is under 1.5 seconds on 3G connection" |
| "Make it responsive" | "All pages render correctly on viewports from 320px to 2560px wide" |
| "Add admin features" | "Admin can view list of all users with search by name or email" |

---

## Sections Explained

### Active Requirements (per category)
Current milestone scope. Checkboxes track completion:
- `[ ]` — Not yet implemented
- `[x]` — Implemented and verified

Group by domain category (Authentication, Content, Payments, etc.). Categories emerge from the project, not a template.

### Future Requirements
Requirements deferred to a later milestone. Include the reason for deferral. These are candidates for the next `/forge-new-milestone`.

### Out of Scope
Explicit exclusions with reasoning. This prevents requirements from being silently re-added. Every exclusion must explain WHY.

### Traceability Table
Maps requirements to phases and plans. Populated by the roadmapper and updated by phase completion:
- **Requirement**: The REQ-ID
- **Phase**: Which phase delivers it
- **Plan**: Which specific plan within the phase
- **Status**: `Pending` → `Complete`

---

## Downstream Consumers

| Consumer | What It Uses | How |
|----------|-------------|-----|
| `forge-roadmapper` | All active requirements | Maps each to exactly one phase |
| `forge-planner` | Phase requirements (from ROADMAP.md `**Requirements:**` field) | Distributes across plans via `requirements: []` frontmatter |
| `forge-plan-checker` | Phase requirements | Validates 100% coverage in plans |
| `forge-verifier` | Plan requirements | Checks satisfaction against evidence |
| `forge-audit-milestone` | All requirements + traceability | Three-point verification across VERIFICATION.md, SUMMARY.md, and traceability table |
| `forge-enhance-requirements` | All requirements | Analyzes quality, researches gaps, suggests improvements |
| `phase complete` (CLI) | Phase requirements | Updates traceability table status |

---

## Evolution Rules

**After each phase completes:**
- Traceability table updated (`Pending` → `Complete`)
- Requirement checkboxes updated (`[ ]` → `[x]`)

**After milestone audit:**
- Unsatisfied requirements flagged
- Gap phases created if needed (via `/forge-plan-milestone-gaps`)

**After milestone completion:**
- File archived to `milestones/v[X.Y]-REQUIREMENTS.md`
- Original deleted (fresh for next milestone)
- Shipped requirements promoted to PROJECT.md Validated section
