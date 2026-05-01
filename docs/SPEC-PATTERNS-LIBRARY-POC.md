# Implementation Spec — Patterns Library + Detector Integration (POC)

**Status:** Not started
**Estimated effort:** 7-8 days
**Parent roadmap item:** `docs/FUTURE-IMPROVEMENTS.md` → Category 9a
**Prerequisite:** V2 foundation validated (audit Phases A+B+G complete)

---

## Goal

Build a minimum viable patterns library with linked Semgrep detectors that proves whether structured architectural patterns + deterministic verification actually changes what AI agents produce versus naked prompting. This is a proof of concept — small scope, observable outcome, decision-making evidence.

## Hypothesis

When the agent has access to (a) explicit patterns with structured selection, (b) compositional relationships between patterns, and (c) deterministic detectors that verify pattern application, the resulting architecture is measurably more disciplined than what the agent produces from training data alone.

## Falsifiable Outcome

If the e2e simulation runs with this POC and produces architecture/code that the detectors find clean (no violations), and the architecture makes deliberate pattern choices with cited reasoning, the hypothesis is supported. If the detectors find no more violations than they would on naked-agent output, or if the agent ignores the pattern library and produces the same output regardless, the hypothesis is weakened and the patterns library investment should be rethought before scaling up.

---

## Scope

Five patterns. ~10-15 detectors. One new engine layer. Integration with the existing architect agent for retrieval. Run against the e2e simulation and produce diagnostic output.

## Non-Goals

- Full patterns library (130+ patterns)
- RAG/embedding retrieval at scale
- Organizational extension mechanism
- Amendment learning loop
- Compositional rule enforcement
- Multi-language beyond Python/TypeScript
- Cross-cutting concerns (logging, error envelope, observability)
- Coupling to constitution layer

All come later if the POC validates the hypothesis.

---

## Deliverables

### 1. Pattern Library Schema and Content

**Location:** `.forge/patterns/` directory in the Forge repo.

**Schema:** YAML files, one pattern per file. Required fields:

```yaml
id: repository-pattern
name: Repository
source: "Patterns of Enterprise Application Architecture (Fowler), microservices.io"
applies_to:
  workload_types: [api-service, web-app, internal-tool]
  tech_stacks: [python-sqlalchemy, typescript-prisma, java-jpa]
  scale: any
context: |
  When you have multiple aggregates in your domain and need to abstract
  data access from business logic.
problem: |
  Direct database access scattered through business logic creates tight
  coupling between domain code and persistence.
solution:
  abstract: |
    Create a Repository interface per aggregate that mediates between
    domain and data mapping layers.
  module_layout:
    - module: repository
      role: data_access
      depends_on: [domain_model, db_session]
      forbidden: [http, validation_logic, business_rules, external_apis]
    - module: service
      role: business_logic
      depends_on: [repository, domain_model]
      forbidden: [direct_db_access, raw_sql]
  per_stack:
    python-sqlalchemy:
      example_path: "examples/repository/python-sqlalchemy.py"
      hints:
        - "Class with CRUD-shaped methods over a single aggregate"
        - "Use SQLAlchemy 2.0 select() syntax exclusively"
        - "Session injected via constructor or method parameter"
    typescript-prisma:
      example_path: "examples/repository/ts-prisma.ts"
      hints:
        - "Class with CRUD methods over a single Prisma model"
        - "Prisma client injected via constructor"
forces:
  - description: "Adds a layer of indirection — slower for trivial cases"
    severity: minor
  - description: "Requires discipline to keep business logic out of repositories"
    severity: medium
related_patterns:
  works_with: [unit-of-work, service-layer, domain-model]
  conflicts_with: [active-record]
  often_paired_with: [data-mapper]
detectors:
  - id: repo-no-business-logic
    description: "Repository methods must not contain business logic"
    type: semgrep
    rule_path: detectors/repository-pattern/no-business-logic.yaml
    severity: error
  - id: repo-no-http-calls
    description: "Repository methods must not make HTTP calls"
    type: semgrep
    rule_path: detectors/repository-pattern/no-http.yaml
    severity: error
  - id: repo-uses-orm-not-raw-sql
    description: "Repository must use ORM, not raw SQL strings"
    type: semgrep
    rule_path: detectors/repository-pattern/no-raw-sql.yaml
    severity: error
```

**Five patterns for the POC:**

| # | Pattern | Source | Layer | Key pitfall tested |
|---|---------|--------|-------|-------------------|
| 1 | Repository | Fowler PoEAA | Data | Business logic leaking into data access |
| 2 | Service Layer | Fowler PoEAA | Service | Business logic in route handlers vs services |
| 3 | API Gateway | microservices.io | Integration | Gateway concerns (auth, rate limiting) in individual services |
| 4 | Database per Service | microservices.io | Data | Shared databases across service boundaries |
| 5 | Transactional Outbox | microservices.io | Integration | Publishing events before/without DB commit (most LLMs get this wrong) |

Chosen because they cover different layers, have well-known pitfalls, and at least three (Service Layer, Database per Service, Transactional Outbox) are commonly violated even by experienced engineers.

### 2. Detector Library

**Location:** `.forge/patterns/detectors/<pattern-id>/*.yaml`

**Format:** Semgrep rule files. Each rule standalone with one rule per file.

**Target:** 10-15 detectors total:

| Pattern | Detectors | What they check |
|---------|-----------|-----------------|
| Repository | 3 | No business logic, no HTTP calls, no raw SQL in repos |
| Service Layer | 2 | Routes don't access DB directly, services handle authorization |
| API Gateway | 2 | Services don't implement rate limiting individually, services don't validate JWT when gateway declared |
| Database per Service | 2 | No cross-service DB imports, no shared connection strings |
| Transactional Outbox | 3 | No publish before commit, no publish in same transaction without outbox table, outbox reads must be transactional |

Each detector includes `metadata.pattern_id` and `metadata.detector_id` linking back to the pattern.

**Example detector — no-business-logic.yaml:**

```yaml
rules:
  - id: repository-no-business-logic
    message: |
      Repository methods should not contain business logic. Conditional
      branching on domain rules, calculations, or workflow decisions
      belong in the service layer.
    severity: ERROR
    languages: [python]
    paths:
      include:
        - "**/repositories/**"
        - "**/repository/**"
    pattern-either:
      - pattern: |
          if $X.status == "active":
              ...
      - pattern: |
          if $USER.role in [...]:
              ...
      - pattern: |
          $TOTAL = $X * $Y * $Z
    metadata:
      pattern_id: repository-pattern
      detector_id: repo-no-business-logic
      severity_rationale: "Business logic in repositories couples persistence to domain rules"
```

### 3. New Engine Verification Layer

**Location:** `forge-verify/architecture-layer.js` (new file)

**Layer:** `ARCHITECTURE`, index 9 (between CONTRACT and SEMANTIC)

**Logic:**
1. Read `.planning/ARCHITECTURE.md` frontmatter → find `applied_patterns: [...]`
2. For each declared pattern, load YAML from `.forge/patterns/<pattern-id>.yaml`
3. For each detector in the pattern, run Semgrep against plan's `must_haves.artifacts`
4. Aggregate violations: pass if zero, fail if any
5. Output: `{layer: "ARCHITECTURE", passed: bool, applied_patterns: [...], violations_by_detector: {...}}`

**Skip conditions:**
- ARCHITECTURE.md doesn't exist or has no `applied_patterns` → skipped
- Semgrep not installed → fail with installation hint
- Pattern YAML missing → fail with reference

**Configuration:** `verification.layers.architecture: true` (default on)

### 4. Architect Agent Retrieval (Minimal)

**No RAG for POC.** Load all 5 patterns as condensed text into architect prompt (~1500 tokens). The architect reads them all and decides which to apply.

**Factory modification:** `composeSystemPrompt()` appends "## Available Patterns" section when `.forge/patterns/` exists.

**Architect grilling addition:**
```
When proposing architecture, consider the available patterns above.
For each pattern that applies:
- State whether you're applying it and why
- Cite which forces in the requirements/NFRs drove the decision
- List patterns you considered but rejected, and why

Declare applied patterns in ARCHITECTURE.md frontmatter:
applied_patterns: [pattern-id, ...]
```

**ARCHITECTURE.md frontmatter extension:**
```yaml
---
status: approved
applied_patterns: [repository-pattern, service-layer, database-per-service]
---
```

### 5. CLI Command

**Command:** `forge-tools verify architecture [--plan PATH] [--raw]`

Run the ARCHITECTURE layer standalone for diagnostics. Output JSON with `applied_patterns`, `violations`, `pass/fail` per detector. Exit code 1 if violations.

### 6. Tests

**Location:** `tests/architecture-layer.test.cjs`

**12-15 tests:**
1. Layer skips when no ARCHITECTURE.md
2. Layer skips when no applied_patterns
3. Layer fails with error when Semgrep not installed
4. Layer fails when referenced pattern doesn't exist
5. Layer passes when code complies with all detectors
6. Layer fails when code violates any detector
7. Per-detector violation counts correct
8. Pattern YAML files validate against schema
9. All 5 pattern YAMLs load without error
10. All 10-15 detector YAMLs load as valid Semgrep rules
11. CLI produces valid JSON
12. Factory includes patterns in prompt when library exists

**Test fixtures:** `tests/fixtures/architecture/` — violating + correct code samples.

### 7. Documentation

**Location:** `docs/PATTERNS-LIBRARY.md`

**Sections:**
1. Why patterns are first-class in Forge
2. Pattern YAML schema reference
3. Detector YAML schema reference
4. How the architect declares patterns
5. How the engine verifies compliance
6. How to add a new pattern
7. How to add a detector to existing pattern
8. POC limitations

---

## Implementation Order

| Step | Deliverable | Effort |
|------|-------------|--------|
| 1 | Schema + 5 pattern YAML files | ~2 days |
| 2 | 10-15 detector YAML files + test fixtures | ~2 days |
| 3 | Engine layer (`architecture-layer.js` + wiring) | ~1 day |
| 4 | CLI command (`verify architecture`) | ~0.5 day |
| 5 | Architect agent prompt injection | ~0.5 day |
| 6 | Tests (12-15) | ~1 day |
| 7 | Documentation + POC report | ~0.5 day |
| **Total** | | **~7-8 days** |

---

## Acceptance Criteria

The POC is **complete** when:
1. All 5 pattern YAMLs validate and load
2. All 10-15 detector YAMLs are valid Semgrep rules
3. ARCHITECTURE engine layer runs, passes all tests
4. Architect prompt includes patterns section
5. CLI `verify architecture` runs end-to-end
6. Full test suite passes (167+ existing + new, no regressions)
7. Documentation explains schema and extension

The POC is a **success** when:
8. Architect declares 2+ applied_patterns in ARCHITECTURE.md
9. Detectors produce non-trivial output on generated code
10. With-patterns vs without-patterns comparison shows measurable difference

The POC is a **failure** when:
- Agent ignores patterns library (same output with/without)
- Detectors find zero violations regardless of code quality
- Detectors find violations on every plan (too aggressive)
- Cost increase >2x without quality improvement

---

## Verification Approach

1. **Self-test:** run test suite, 167+ pass
2. **Smoke test:** architect produces ARCHITECTURE.md with applied_patterns
3. **Detector test:** deliberately violating code → violation surfaced
4. **Integration test:** full plan through engine, ARCHITECTURE layer produces output
5. **Comparison test (the actual hypothesis test):** run e2e simulation twice — with patterns vs without. Diff outputs. Document differences.

**Report:** `docs/PATTERNS-POC-REPORT.md` with: what was built, test output, comparison results, honest hypothesis assessment, recommended next step.

---

## Files

### New (20-25 files)
- `.forge/patterns/*.yaml` (5)
- `.forge/patterns/detectors/<pattern-id>/*.yaml` (10-15)
- `forge-verify/architecture-layer.js`
- `tests/architecture-layer.test.cjs`
- `tests/fixtures/architecture/*` (5-10)
- `docs/PATTERNS-LIBRARY.md`

### Modified (5 files)
- `forge-verify/engine.js`
- `forge-config/config.js`
- `forge-agents/factory.js`
- `atos-forge/bin/lib/verify.cjs`
- `atos-forge/bin/forge-tools.cjs`

### Dependencies
- Semgrep CLI (system dependency, not npm)
