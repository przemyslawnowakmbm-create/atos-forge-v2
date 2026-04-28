# Forge V2 — Future Improvement Reference

Last updated: 2026-04-28
Status: 4 of 18 items implemented. 14 remaining.

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

### 3a. Requirement Conflict Detection [P2]

Two requirements that contradict each other: "User can delete their account permanently" vs "System retains user data for 7 years for compliance." The validator checks individual requirements but not cross-requirement consistency.

**Conflict types to detect:**
- Direct contradiction (delete vs retain, allow vs deny)
- Resource conflict (two requirements claim the same UI space or API endpoint)
- Temporal conflict (requirement A needs feature before requirement B provides it, circular dependency)
- Scope conflict (requirement A says "all users" but requirement B restricts to "admin only")

**Implementation approach:**
- Semantic analysis of the full requirement set — likely needs LLM judgment (not deterministic)
- New agent: `forge-agents/catalog/requirement-analyzer.md` that reads all requirements and identifies conflicts
- Add as optional step in `/forge-enhance-requirements` workflow
- CLI: `forge-tools requirements conflicts [--json]`
- Output: `{ conflicts: [{ req_a, req_b, conflict_type, description, severity }] }`

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

## Priority Summary

| Priority | Items | Status |
|----------|-------|--------|
| P1 | 1a (Cost tracking), 4a (MCP server) | Not started |
| P2 | 1b (Model routing), 3a (Conflict detection), 3c (AC compiler), 6a (Audit trail) | Not started |
| P3 | 2c (Tech debt), 4b (Dashboard), 4c (Notifications), 5a (Cross-project), 5b (Patterns), 5c (Anti-patterns), 6b (Multi-team), 6c (Approvals) | Not started |
| Done | 1c (Regression), 2a (Mutation), 2b (Coverage), 3b (Req impact) | ✅ Implemented |
