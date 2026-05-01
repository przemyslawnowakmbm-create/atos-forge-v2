# Forge V2 — Future Improvement Reference

Last updated: 2026-05-01
Status: 9 of 29 items implemented. 20 remaining.

---

## Category 1: Execution Intelligence

### 1a. Cost Tracking & Budget Control [P1]

Per-plan token consumption tracking (input + output + cache hits). Per-phase cost aggregation. Budget ceiling with auto-pause. Cost-per-requirement metric showing which requirements are expensive to implement.

The `execution.budget_ceiling_usd` config key already exists in DEFAULTS but is not wired to any enforcement logic. The session ledger captures events but does not track token usage per agent invocation.

**Implementation approach:**
- Hook into the Claude CLI invocation in `forge-verify/loop.js` and `forge-agents/provider.js` to capture token counts from response metadata
- Store per-plan metrics in `.forge/cost-report.json`
- Add `forge-tools cost report [--phase N] [--json]` CLI command
- Wire budget ceiling: pause execution when cumulative cost exceeds threshold
- Integration point: `forge-session/metrics.js` already has `snapshotUnitMetrics()` — enhance it

**Research validation:** ChatDev research showed agent communication can exceed $10/task. Cloudflare routes cheaper models for routine tasks. Every enterprise customer asks "what does this cost?"

---

### 1b. Model Routing Per Task [P2]

Route different verification layers and execution tasks to different models. Currently Forge has model profiles (quality/balanced/budget) but uses the same profile for everything.

**Proposed routing:**
- Layer 1-4 (structural, type, interface, dependency) → haiku (fast, cheap, deterministic checks)
- Layer 5 (tests) → balanced (needs to understand test output)
- Layer 8 (semantic verification) → opus (needs judgment)
- Layer 9 (architectural review) → opus
- Test-first stub refinement → balanced
- Plan execution → quality profile
- Plan checking → budget (pattern matching, not creative)

**Implementation approach:**
- Add `model_routing` section to config with per-layer/per-task model overrides
- Modify `forge-agents/provider.js` `resolveProvider()` to accept a task type parameter
- Pass routing config through to each layer invocation in `forge-verify/engine.js`
- Estimated cost reduction: 30-50% with no quality loss on mechanical tasks

---

### 1c. Regression Testing Across Phases ✅ IMPLEMENTED

Module: `forge-verify/regression.js`
CLI: `forge-tools verify regression [--json] [--update-baseline]`
Baseline: `.forge/test-baseline.json`

---

## Category 2: Quality Assurance

### 2a. Mutation Testing ✅ IMPLEMENTED

Module: `forge-verify/mutation.js`
Layer 11 in verification engine (off by default)
CLI: `forge-tools verify mutation [--files X] [--json]`

---

### 2b. Code Coverage Tracking ✅ IMPLEMENTED

Module: `forge-verify/coverage.js`
CLI: `forge-tools verify coverage [--json] [--tool X] [--threshold N]`
Config: `verification.coverage.*`

---

### 2c. Technical Debt Measurement [P3]

Track accumulated complexity per phase: file sizes, function lengths, dependency counts, cyclomatic complexity. If each phase adds more debt than it resolves, the project is heading toward unmaintainability.

**Proposed metrics:**
- Average file size (lines) — trending up = debt accumulating
- Average function length — should stay under 30 lines
- Dependency count per module — high fan-in = fragile
- Cyclomatic complexity — measurable via `eslint --rule complexity` or `radon` (Python)
- Duplicate code detection — percentage of near-duplicate blocks

**Implementation approach:**
- New module: `forge-verify/tech-debt.js`
- Parse AST (reuse tree-sitter from `forge-graph/`) to extract function lengths, complexity
- Store per-phase snapshot in `.forge/debt-report.json`
- Compare against previous phase to detect trend
- Add as sub-metric of drift report (specification drift + technical debt drift)
- CLI: `forge-tools verify debt [--json]`

---

## Category 3: Requirements Intelligence

### 3a. Requirement Conflict Detection ✅ IMPLEMENTED

Module: `atos-forge/bin/lib/req-conflicts.cjs`
CLI: `forge-tools requirements conflicts [--json] [--system <path>] [--include-semantic]`
Detects: dependency cycles (Tarjan's SCC), overlapping scope (Jaccard), technology exclusivity, cross-service entity conflicts.
Agent: `forge-agents/catalog/requirement-analyzer.md` for semantic contradiction detection via `--include-semantic`.

---

### 3b. Requirement Change Impact Analysis ✅ IMPLEMENTED

Module: `atos-forge/bin/lib/req-impact.cjs`
CLI: `forge-tools requirements impact [--json] [--save-baseline]`
Baseline: `.forge/requirements-baseline.json`

---

### 3c. Acceptance Criteria to Test Compiler [P2]

Compile structured acceptance criteria DIRECTLY into executable tests with no LLM involvement. Deterministic test generation for structured criteria.

**Examples of mechanical translation:**
- "Returns 201 with {id, email}" → `expect(response.status).toBe(201); expect(body).toHaveProperty('id'); expect(body).toHaveProperty('email');`
- "Password minimum 8 characters" → `expect(() => validate({password: 'short'})).toThrow();`
- "Pagination returns 20 per page" → `expect(result.length).toBeLessThanOrEqual(20);`

**Implementation approach:**
- Define a structured acceptance criteria format (JSON or YAML) with typed verification specs
- Each type (api_contract, ui_artifact, behavioral, data_validation) has a compiler that produces test code
- Extend `forge-verify/test-stub-generator.js` with `compileAcceptanceCriteria()` function
- Falls back to LLM-based stub refinement for criteria that can't be mechanically compiled
- This would make test-first stubs stronger by default — less reliance on LLM judgment for test quality

**Prerequisite:** Requires the upstream requirements tool to emit structured acceptance criteria, not just prose. The user mentioned this tool exists externally.

---

## Category 4: Developer Experience

### 4a. MCP Server for IDE Integration [P1]

Expose Forge commands as an MCP (Model Context Protocol) server so Claude Code, Cline, Continue.dev, and other MCP-compatible tools can call them natively from within IDEs.

**Commands to expose:**
- `forge.verify.work` — run verification engine
- `forge.verify.regression` — run regression tests
- `forge.verify.coverage` — run coverage
- `forge.drift.report` — compute drift
- `forge.requirements.validate` — validate requirements
- `forge.requirements.impact` — impact analysis
- `forge.graph.status` — code graph health
- `forge.graph.impact` — file impact analysis

**Implementation approach:**
- Create `forge-mcp/server.js` — MCP server following the MCP SDK spec
- Each Forge CLI command becomes an MCP tool with JSON schema for parameters
- Register in `.claude/settings.json` as an MCP server
- Users get Forge commands available in any MCP-compatible IDE agent

**Research validation:** Research identified IDE integration as a High severity gap. MCP is the lowest-effort path — all Forge commands already accept `--json` output and structured input.

---

### 4b. Live Progress Dashboard [P3]

A local web UI showing: current phase progress, plan execution status, verification results, drift report, and cost tracking. Updated in real-time via file watching.

**Implementation approach:**
- Build on the existing graph dashboard pattern (`forge-graph/dashboard-generator.js`)
- Single self-contained HTML file at `.forge/progress-dashboard.html`
- File watcher monitors: `.forge/session/ledger.md`, `.forge/drift-report.json`, `.forge/test-baseline.json`, `.forge/cost-report.json`
- Auto-refresh via polling (read JSON files every 5 seconds)
- Sections: phase timeline, verification status per plan, drift chart, cost accumulation, regression history

---

### 4c. Notification System [P3]

Webhook/Slack/email notification on key events: phase complete, verification failed, drift exceeded threshold, budget exceeded.

**Implementation approach:**
- New config section: `notifications: { enabled, webhook_url, events: ['phase_complete', 'verification_failed', 'drift_red', 'budget_exceeded'] }`
- Hook into session ledger events (logEvent, logError, logWarning)
- Simple HTTP POST to webhook URL with structured JSON payload
- Slack-compatible format (works with Slack incoming webhooks, Discord, Teams)
- No external dependencies — uses Node.js built-in `https.request()`

---

## Category 5: Knowledge & Learning

### 5a. Cross-Project Learning [P3]

Currently knowledge is per-project (`.forge/knowledge/learnings.json`). Learnings from Project A should apply to Project B when they share the same technology stack.

**Implementation approach:**
- Shared knowledge base at `~/.forge/knowledge/global-learnings.json` (user-level, not project-level)
- When `knowledge.promote()` runs on project archive, also write to global if `knowledge.cross_project: true`
- Filter by technology stack: learnings tagged with `[prisma, nextjs]` only inject into projects using those technologies
- Deduplication via Jaccard similarity (already implemented in `forge-session/knowledge.js`)
- Privacy: opt-in per project via config

---

### 5b. Pattern Library [P3]

Capture successful implementation patterns with actual code. Next time a plan mentions a similar problem, inject the proven pattern into the agent context.

**Examples:**
- "Prisma singleton for Next.js hot-reload" — the globalThis pattern
- "JWT refresh token rotation" — the complete token lifecycle
- "Pagination with cursor-based approach" — the implementation pattern
- "Zod validation middleware for route handlers" — the reusable pattern

**Implementation approach:**
- Store patterns in `.forge/patterns/` as individual markdown files with frontmatter (name, tags, framework, language)
- Factory's `composeContextPackage()` queries patterns by plan keywords and injects matching ones into reference context
- Patterns are project-specific but can be promoted to global (`~/.forge/patterns/`) for cross-project reuse
- CLI: `forge-tools patterns add`, `forge-tools patterns list`, `forge-tools patterns search <query>`

---

### 5c. Anti-Pattern Database [P3]

Track what went wrong and build a growing database of anti-patterns feeding into the plan-checker and agent prompts.

**Sources of anti-patterns:**
- Dimension 11 (Security Anti-Patterns) catches in plan-checker
- Verification failures from fix loops (agent tried X, it failed)
- Rejected approaches from session ledger
- Manual additions by the user

**Implementation approach:**
- Store in `.forge/anti-patterns.json` with `{ id, pattern, category, description, caught_by, severity, count }`
- Auto-populate from: verification failures, fix loop escalations, plan-checker blockers
- Inject top anti-patterns (by frequency) into agent system prompts
- CLI: `forge-tools anti-patterns list`, `forge-tools anti-patterns add`
- Integration: plan-checker Dimension 11 reads from this database in addition to its hardcoded list

---

## Category 6: Enterprise Operations

### 6a. Audit Trail Export [P2]

The session ledger already captures decisions, warnings, and errors. Add structured JSON export with timestamps, actor (which agent), action, and outcome for compliance reporting.

**Implementation approach:**
- New function in `forge-session/ledger.js`: `exportAuditTrail(cwd, opts)` → structured JSON
- Format per entry: `{ timestamp, actor, action, decision, rationale, outcome, phase, plan, files_affected }`
- Support date range filtering: `--from 2026-04-01 --to 2026-04-30`
- Export formats: JSON (default), CSV (for spreadsheet tools)
- CLI: `forge-tools audit export [--from DATE] [--to DATE] [--format json|csv]`
- Low effort: ledger data exists, just needs structured parsing and reformatting

---

### 6b. Multi-Team Coordination [P3]

When Team A's API change affects Team B's frontend, the system graph detects it but there's no notification or coordination flow.

**Implementation approach:**
- Extend `forge-system/` with team-aware impact notifications
- When `forge-analyze/analyzer.js` detects MULTI_REPO scope, generate a coordination plan
- Coordination plan includes: affected teams, required execution order, interface contracts to honor
- Notification via webhook (reuse notification system from 4c)
- Approval gate: downstream team must acknowledge before upstream changes execute
- This builds on the existing system graph infrastructure (`forge-system/query.js` already has `team-impact` queries)

---

### 6c. Approval Workflows [P3]

Configurable human gates at the phase level: "Plans for the auth module require security team approval before execution."

**Implementation approach:**
- New config section: `approvals: { rules: [{ module: 'auth', approver: 'security-team', gate: 'pre-execution' }] }`
- When execute-phase starts, check if any plan touches a module with an approval rule
- If yes, pause and write approval request to `.forge/approvals/pending/{id}.json`
- Resume via: `forge-tools approve <id>` (CLI) or via webhook response
- Approval record stored in session ledger for audit trail
- This is more complex than checkpoints (which are per-task, inside the executor) — these are phase-level organizational gates

---

## Category 7: Architecture & Design

### 7a. Architecture Phase Before Planning ✅ IMPLEMENTED

Two-level architecture: `/forge-system-architect` (multi-service) and `/forge-architect` (per-service).
Agents: `forge-agents/catalog/system-architect.md`, `forge-agents/catalog/architect.md`
Produces: `.planning/ARCHITECTURE.md`, `.forge-system/SYSTEM-ARCHITECTURE.md`, `CONTRACT-REGISTRY.md`, glossaries.
Human approval gate required. ADRs become locked decisions for all downstream plans.
Config: `architecture` section in `.forge/config.json`.

---

### 7b. Architecture Decision Records (ADRs) [P2]

Formal, versioned decision records for every significant architectural choice. Each ADR captures context, decision, consequences, and (optionally) an executable enforcement rule.

**Implementation approach:**
- Template: `atos-forge/templates/adr.md` with MADR format (context, decision, consequences, status)
- Storage: `.planning/adrs/NNNN-decision-title.md` (numbered sequentially)
- Created by: architect agent during `/forge-architect` phase, or manually by user
- Consumed by: planner (respects decisions), plan-checker (validates compliance), executor (locked decisions derived from ADRs)
- Enforced by: optional `.rules.ts` companion files (Archgate pattern) wired into verification Layer 9

Research: `research/architecture-and-scale.md`

---

### 7c. Architecture Fitness Functions [P2]

Automated enforcement of architectural rules — layer boundaries, dependency directions, module isolation, naming conventions. These run as part of the verification engine.

**Implementation approach:**
- Integrate ArchUnitTS (TypeScript) or ts-arch for dependency/layer rule enforcement
- Rules derived from ARCHITECTURE.md module boundaries and dependency rules
- New verification sub-layer within Layer 9 (ARCHITECTURAL) that runs rule checks mechanically (not via LLM judgment)
- Example rules: "no import from `features/*` into `core/*`", "all API routes must go through middleware", "database access only via repository pattern"
- Config: `verification.architectural.rules_path` pointing to `.planning/architecture-rules/`

Research: `research/architecture-and-scale.md`

---

## Category 8: Large Codebase Management

### 8a. Code Entropy Metrics ✅ IMPLEMENTED

Module: `forge-verify/entropy.js`
CLI: `forge-tools verify entropy [--module M] [--phase N] [--compare-baseline] [--save-snapshot] [--json]`
Per-module metrics: Ca, Ce, instability, abstractness, distance from main sequence, cohesion, complexity.
Phase snapshots at `.forge/entropy-snapshots/phase-{N}.json`. Trend comparison: >10% warn, >25% block.
Config: `verification.entropy` section in `.forge/config.json`.

---

### 8b. Enhanced Code Graph with Semantic Search [P2]

At 400K+ LOC, the structural code graph (AST-based imports/exports) isn't enough. Agents need semantic search — "find the code that handles user authentication" not just "find imports of auth.ts."

**Implementation approach:**
- Add vector embeddings alongside the existing SQLite graph (GraphRAG pattern)
- Embed function/class descriptions using a small embedding model (local, no API call)
- Store in `.forge/graph-embeddings.db` (separate from structural graph.db)
- New query: `forge-graph/query.js semanticSearch(query, topK)` — returns relevant code snippets by semantic similarity
- Integration: factory's `composeContextPackage()` uses semantic search to find relevant code beyond direct import chains
- Fallback: if embeddings not available, use existing structural graph only

**Research validation:**
- Knowledge graphs reduce token usage by up to 90% vs loading raw files (GitNexus, Graphify research)
- Meta's approach: pre-compute "tribal knowledge" docs about code, cutting agent tool calls by 40%
- Stanford/Berkeley: model correctness drops at ~32K tokens regardless of claimed window — confirming targeted context loading is essential

Research: `research/architecture-and-scale.md`

---

### 8c. Method-Level Impact Analysis [P2]

Current impact analysis is file-level (`forge-graph/query.js impact`). At 400K LOC, a file may have 50 exports — changing one shouldn't flag all 50 consumers. Need method-level precision.

**Implementation approach:**
- Enhance `forge-graph/builder.js` to track symbol-level dependencies (which function calls which function, not just which file imports which file)
- New query: `graph impact-symbol <file> <symbol>` — blast radius for a specific function/class
- Pre-patch simulation: "if I change this function signature, which callers break?"
- Integration: factory's `analyzeTask()` uses symbol-level impact for more precise context loading
- Integration: plan-checker uses symbol-level impact to detect plans that modify high-consumer functions

Research: `research/architecture-and-scale.md`

---

### 8d. Shared Language / Domain Glossary ✅ IMPLEMENTED

Two-level glossary: `.forge-system/glossary.md` (organization-wide) + `.forge/glossary.md` (service-specific).
Format: Markdown table with Term | Definition | Aliases | Used in columns.
Loaded by `forge-agents/factory.js` into every agent's system prompt via `loadGlossary()` + `loadSystemGlossary()`.
Created during `/forge-architect` and `/forge-system-architect` workflows.
Factory searches parent directories (up to 4 levels) for system glossary.

---

### 8e. Cross-Service Contract Governance ✅ IMPLEMENTED

Module: `forge-system/contract-verifier.js`
Validates contracts between services defined in `CONTRACT-REGISTRY.md`.
Detects breaking changes: endpoint removal (blocker), schema field removal (blocker), status code changes (warning).
Communication-pattern agnostic: REST, events, gRPC all supported.
Baseline at `.forge-system/contract-baseline.json`.
Programmatic: require('forge-system/contract-verifier').{verifyContracts, parseContractRegistry, detectBreakingChanges, saveContractBaseline}

---

## Category 9: Patterns & Deterministic Verification

### 9a. Patterns Library + Detector Integration (POC) [P1]

**Hypothesis:** When agents have access to (a) explicit architectural patterns with structured selection criteria, (b) compositional relationships between patterns, and (c) deterministic Semgrep detectors that verify pattern compliance, the resulting architecture is measurably more disciplined than what agents produce from training data alone.

**Scope:** Five patterns, 10-15 detectors, one new engine layer, architect agent retrieval. Run against e2e simulation and compare with/without patterns.

**Five patterns (chosen for layer coverage + known pitfalls):**
1. **Repository** (Fowler PoEAA) — data access abstraction. Detectors: no business logic, no HTTP calls, no raw SQL in repos
2. **Service Layer** (Fowler PoEAA) — business logic isolation. Detectors: routes don't access DB directly, services handle authorization
3. **API Gateway** (microservices.io) — gateway-level concerns. Detectors: services don't implement rate limiting individually, services don't validate JWT when gateway is declared
4. **Database per Service** (microservices.io) — data ownership. Detectors: no cross-service DB imports, no shared connection strings
5. **Transactional Outbox** (microservices.io) — event reliability. Detectors: no publish before commit, no publish in same transaction without outbox table

**Pattern schema:** YAML files at `.forge/patterns/<pattern-id>.yaml` with:
- `id`, `name`, `source` (attribution)
- `applies_to`: workload_types, tech_stacks, scale
- `context`, `problem`, `solution` (abstract + module_layout + per_stack hints)
- `forces` (tradeoffs with severity)
- `related_patterns`: works_with, conflicts_with, often_paired_with
- `detectors`: list of {id, description, type: semgrep, rule_path, severity}

**Detector format:** Semgrep YAML rules at `.forge/patterns/detectors/<pattern-id>/*.yaml`. Each rule includes `metadata.pattern_id` and `metadata.detector_id` linking back to the pattern.

**New engine layer:** `ARCHITECTURE` (Layer 9 — between CONTRACT and SEMANTIC). Reads `applied_patterns` from ARCHITECTURE.md frontmatter, loads pattern YAMLs, runs Semgrep detectors against plan artifacts. Pass if zero violations.

**Architect agent integration:** When `.forge/patterns/` exists, factory injects "## Available Patterns" section into architect prompt (~1500 tokens for 5 patterns). Architect declares `applied_patterns: [...]` in ARCHITECTURE.md frontmatter.

**CLI:** `forge-tools verify architecture [--plan PATH] [--raw]` — standalone pattern compliance check.

**Dependencies:** Semgrep CLI (system dependency, invoked via child_process.spawn).

**POC success criteria:**
- Architect declares 2+ applied_patterns in ARCHITECTURE.md
- Detectors produce non-trivial output (some violations caught OR clean output verifiable as correct)
- With-patterns vs without-patterns comparison shows measurable difference (more deliberate selection, fewer violations, more cited reasoning)

**POC failure criteria:**
- Agent ignores patterns library (same output with/without)
- Detectors find zero violations regardless of code quality (rules too weak)
- Detectors find violations on every plan (rules too aggressive)
- >2x cost increase without quality improvement

**Implementation plan (7 steps):**

1. **Schema + library content** (~2 days)
   - 5 YAML pattern files following the schema
   - Per-stack hints for Python+SQLAlchemy and TypeScript+Prisma
   - Validate YAML parseable

2. **Detector files** (~2 days)
   - 10-15 Semgrep YAML rules
   - Test each against synthetic violating + non-violating fixtures
   - Test fixtures at `tests/fixtures/architecture/`

3. **Engine layer** (~1 day)
   - New file: `forge-verify/architecture-layer.js`
   - Wire into engine.js verify() between CONTRACT and SEMANTIC
   - Config: `verification.layers.architecture: true`
   - Skip conditions: no ARCHITECTURE.md, no applied_patterns, no Semgrep

4. **CLI command** (~0.5 day)
   - `cmdVerifyArchitecture` in verify.cjs
   - Wire into forge-tools.cjs

5. **Architect agent prompt** (~0.5 day)
   - Modify factory.js to load patterns and inject "## Available Patterns" section
   - Architect grilling prompt addition: "cite which forces drove the decision"
   - ARCHITECTURE.md frontmatter: `applied_patterns: [pattern-id, ...]`

6. **Tests** (~1 day)
   - 12-15 tests: layer skip, fail, pass, schema validation, detector loading
   - Test fixtures: violating + correct code samples

7. **Documentation + report** (~0.5 day)
   - `docs/PATTERNS-LIBRARY.md`: schema ref, how to extend, limitations
   - `docs/PATTERNS-POC-REPORT.md`: comparison test results, hypothesis verdict

**Total: ~7-8 days**

**What this POC does NOT include:**
- Full 130+ pattern library
- Embedding/vector RAG retrieval
- Compositional rule enforcement (related_patterns logic)
- Amendment learning loop
- Multi-org publishing
- Cross-language beyond Python/TypeScript
- Cross-cutting concerns (logging, error envelope, observability)
- Coupling to constitution layer

Research: `research/architecture-and-scale.md`, `research/grill-me-skills.md`

**Files to create:**
- `.forge/patterns/*.yaml` (5 pattern files)
- `.forge/patterns/detectors/<pattern-id>/*.yaml` (10-15 detector files)
- `forge-verify/architecture-layer.js`
- `tests/architecture-layer.test.cjs`
- `tests/fixtures/architecture/*` (5-10 fixture files)
- `docs/PATTERNS-LIBRARY.md`

**Files to modify:**
- `forge-verify/engine.js` (add layer invocation)
- `forge-config/config.js` (add ARCHITECTURE to layers)
- `forge-agents/factory.js` (inject patterns into prompt)
- `atos-forge/bin/lib/verify.cjs` (add cmdVerifyArchitecture)
- `atos-forge/bin/forge-tools.cjs` (wire command)

---

### 9b. Full Patterns Library (post-POC) [P3]

Scale from 5 to 130+ patterns if POC validates hypothesis. Includes:
- Embedding/vector RAG for pattern retrieval at scale
- Compositional rule enforcement (related_patterns logic)
- Amendment learning loop (agents suggest pattern modifications)
- Multi-org pattern publishing and sharing
- Cross-language detector coverage (Java, Go, Rust, C#)
- Cross-cutting concern patterns (logging, error handling, observability)

**Prerequisite:** 9a POC must validate hypothesis first.

---

### 9c. Constitutional Enforcement Layer [P2]

Deterministic verification layer that greps for constitution violations. The constitution rules are mostly grep-able:
- No SHA-256/MD5 for passwords → pattern match in auth code
- No localStorage for tokens → pattern match in client code
- No string concatenation in SQL → pattern match in DB code
- No @ts-ignore without documented reason → pattern match

Each constitution rule gets a Semgrep or regex detector. Engine layer fails on match. This is the deterministic enforcement the audit identified as missing — constitution currently lives only in the prompt, not in verification.

**Integration:** Could share infrastructure with 9a (Semgrep-based detectors). Build after POC validates the detector approach.

---

## Priority Summary

| Priority | Items | Status |
|----------|-------|--------|
| P1 | 1a (Cost tracking), 4a (MCP server), **9a (Patterns Library POC)** | Not started |
| P2 | 1b (Model routing), 3c (AC compiler), 6a (Audit trail), 7b (ADRs), 7c (Fitness functions), 8b (Semantic search), 8c (Method-level impact), **9c (Constitutional enforcement)** | Not started |
| P3 | 2c (Tech debt), 4b (Dashboard), 4c (Notifications), 5a (Cross-project), 5b (Patterns), 5c (Anti-patterns), 6b (Multi-team), 6c (Approvals), **9b (Full patterns library)** | Not started |
| Done | 1c (Regression), 2a (Mutation), 2b (Coverage), 3a (Conflict detection), 3b (Req impact), 7a (Architecture phase), 8a (Code entropy), 8d (Shared language), 8e (Contract governance) | ✅ Implemented |

| Priority | Items | Status |
|----------|-------|--------|
| P1 | 1a (Cost tracking), 4a (MCP server) | Not started |
| P2 | 1b (Model routing), 3c (AC compiler), 6a (Audit trail), 7b (ADRs), 7c (Fitness functions), 8b (Semantic search), 8c (Method-level impact) | Not started |
| P3 | 2c (Tech debt), 4b (Dashboard), 4c (Notifications), 5a (Cross-project), 5b (Patterns), 5c (Anti-patterns), 6b (Multi-team), 6c (Approvals) | Not started |
| Done | 1c (Regression), 2a (Mutation), 2b (Coverage), 3a (Conflict detection), 3b (Req impact), 7a (Architecture phase), 8a (Code entropy), 8d (Shared language), 8e (Contract governance) | ✅ Implemented |
