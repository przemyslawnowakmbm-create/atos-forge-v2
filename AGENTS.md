# Forge — Agent Instructions

## Module Layout & Path Resolution
Forge consists of `atos-forge/` (CLI entry point) and 6 sibling engine modules:
  forge-graph/, forge-config/, forge-session/, forge-verify/,
  forge-agents/, forge-system/, forge-analyze/

All modules must be siblings under the same parent directory (the "forge root").
`forge-tools.cjs` resolves the forge root via `getForgeRoot()`:
1. `FORGE_HOME` env var (if set)
2. Default: 2 levels up from `atos-forge/bin/forge-tools.cjs`

The installer (`bin/install.js`) copies all 7 directories to the target config dir.

## Code Graph
Before modifying any file, query the code graph for context:
  node forge-graph/query.js context-for-task <file1> <file2> ...

Before cross-module changes, check impact:
  node forge-graph/query.js impact <file>

After changes, verify no new circular dependencies:
  node forge-graph/query.js cycles

Available graph commands:
  node forge-graph/query.js overview          — Codebase summary
  node forge-graph/query.js show <file>       — File dependencies
  node forge-graph/query.js impact <file>     — Blast radius
  node forge-graph/query.js hotspots          — High-churn files
  node forge-graph/query.js cycles            — Circular deps
  node forge-graph/query.js capabilities <m>  — Module capabilities

## System Graph (Multi-Repo)
`forge-system/` enables cross-repo interface detection, system-level dependency tracking, and multi-repo impact analysis.

Two entry points:
- `forge-init` (single repo) — unchanged, now also runs interface detection → `.forge/interfaces.yaml`
- `forge-system-init` (multi-repo) — runs full `forge-init` across all repos in parallel, then builds `system-graph.db`

Key files:
  forge-system/detect.js        — Auto-detect interfaces (API, events, packages, databases)
  forge-system/validate.js      — Validate interfaces.yaml (structural + cross-repo contracts)
  forge-system/schema.sql       — SQLite schema for system-graph.db
  forge-system/builder.js       — Build system graph from interfaces.yaml files
  forge-system/query.js         — Query system graph: overview, impact, consumers, cycles, hotspots, registry, path, team-impact, context-for-task
  forge-system/sync.js          — Incremental sync from one repo (hash-based change detection)
  forge-system/system-init.js   — Batch orchestrator for multi-repo init (Phase 3)
  forge-system/dashboard.js     — System-level dashboard generator (HTML, D3 force graph, 5 tabs)

System Init CLI:
  node forge-system/system-init.js --path <dir>                     — Discover repos from directory (2-level scan)
  node forge-system/system-init.js --repos <repos.json>             — Discover repos from registry file
  node forge-system/system-init.js --github-org <org> [--workspace] — Clone + init from GitHub org
  Options: --output <db>, --workers <N>, --force, --dry-run, --json

System Init Pipeline:
  A. Discovery — find repos via path/registry/GitHub (respects system.ignore_repos config)
  B. Parallel Init — run forge-init per repo (workers = system.workers or auto-detect)
  C. Assembly — build system-graph.db via builder.js + validate via validate.js
  D. Summary — report services, interfaces, dependencies, failures

Programmatic: require('forge-system/system-init').systemInit({ source, value, output, workers, delivery, force })

System Dashboard CLI:
  node forge-system/dashboard.js --db <system-graph.db> [--output <path>] [--no-open] [--json]
  Generates self-contained HTML with 5 tabs:
    Service Map (D3 force-directed, color by team, size by fan-in, click for detail panel)
    Dependency Matrix (NxN grid, click cell to inspect)
    Interface Registry (searchable table of all exports)
    Risk Register (sorted by risk level, deprecated deps, cycles)
    Team View (services grouped by team, grid cards)
  Forge theme (#003366/#2990EA/#008dbb palette).
  Default output: .forge/system-dashboard.html next to system-graph.db.

Interface detection runs automatically during `forge-init`. It scans for:
  OpenAPI/Swagger specs, FastAPI/Express/NestJS routes, .proto files,
  Kafka/RabbitMQ/Celery producers/consumers, Redis pub/sub, npm/PyPI packages,
  SQLAlchemy/Prisma/TypeORM models, env vars (*_API_URL), HTTP client calls.

Design doc: docs/SYSTEM-GRAPH-ARCHITECTURE.md

## Session Continuity
If .forge/session/ledger.md exists, ALWAYS read it at the start of your first response in a new context or after compaction. It contains:
- Current execution state (phase, wave, what's done)
- Decisions made and rationale (don't re-ask these questions)
- Warnings from agents (load into context for downstream work)
- User preferences for this session (respect these)
- Rejected approaches (don't retry these)

Trust the ledger over summarized conversation history when they conflict.

## Persistent Knowledge Base
Cross-milestone learning retention at `.forge/knowledge/learnings.json`.
Learnings survive ledger archive/reset — Milestone 2 agents inherit Milestone 1 pitfalls.

Schema: `{ id, type, text, source_milestone, source_phase, modules[], created, relevance }`
Types: `warning`, `decision`, `pitfall`, `convention`, `preference`

Auto-promotion: `archiveAndReset()` → `knowledge.promote()` extracts decisions, HIGH warnings,
rejected approaches, and user preferences. Deduplication via >80% word-similarity Jaccard.

Agent integration: `factory.js extractSessionContext()` → `knowledge.relevantFor(cwd, modules, files)`
→ filtered learnings injected as `knowledge_base[]` in session_context → "Persistent Knowledge"
section in agent system prompts.

CLI commands:
  node atos-forge/bin/forge-tools.cjs knowledge list              — Show all learnings
  node atos-forge/bin/forge-tools.cjs knowledge add <text>        — Manual entry
    [--type <type>] [--modules <m1,m2>] [--relevance <level>]
  node atos-forge/bin/forge-tools.cjs knowledge prune <id>        — Remove stale learning
  node atos-forge/bin/forge-tools.cjs knowledge promote           — Manual promotion from ledger

Configuration in .forge/config.json (knowledge section):
  enabled (default true), auto_promote (default true), max_entries (default 200),
  promote_severity_threshold (default "medium").

Programmatic: require('forge-session/knowledge').{load, save, add, prune, promote, relevantFor}

## Requirement Impact Analyzer
Automatic multi-repo detection before planning. Queries system-graph.db to determine if a
phase requirement touches multiple services, then feeds cross-repo context to the planner.

Process:
1. Extract domain keywords from phase goal + requirements
2. Search interface registry across all services for keyword matches
3. Run impact analysis on matched services (direct + transitive consumers)
4. Determine scope: SINGLE_REPO vs MULTI_REPO
5. Build execution order (providers before consumers)
6. Write IMPACT.md + IMPACT.json to .planning/phases/{N}/

Integration:
- plan-phase.md Step 7.6 — runs analyzer before spawning planner, asks user about multi-repo scope
- forge-planner.md — if MULTI_REPO, creates per-service plans with cross-plan dependencies
- factory.js — injects impact_analysis into agent session_context + "Cross-Repo Impact" prompt section

CLI commands:
  node atos-forge/bin/forge-tools.cjs impact analyze [--phase N] [--goal <text>] [--json] [--write]
  node atos-forge/bin/forge-tools.cjs impact show --phase N

Configuration in .forge/config.json (impact_analysis section):
  enabled (default true), auto_detect (default true), max_depth (default 2), scope_threshold (default 1).

Programmatic: require('forge-analyze/analyzer').{analyzeRequirement, extractKeywords, resolveSystemDb, generateImpactMarkdown, writeImpact, findImpactFile}

## Task Assessment
When a plan overflows context, use the plan assessor:
  node forge-agents/plan-assessment.js <plan-file> --root .    — Detect overflow, recommend strategy

Context overflow detection uses INTERFACE-level token estimation.

Configuration in .forge/config.json or .planning/config.json (execution section):
  context_budget (default 200000), assessment_threshold (default 0.80),
  safety_margin (default 0.20), auto_split, max_fix_loops, overhead_per_subtask.

## Execution Pipeline
The execute-phase workflow (atos-forge/workflows/execute-phase.md) runs the sequential pipeline:

1. **Load plans** — discover incomplete plans, order by dependencies
2. **Assess** — plan-assessment checks context fit
3. **Create agents** — factory selects specialist from catalog, injects context
4. **Execute sequentially** — for each plan:
   a. Build agent config via catalog-based factory
   b. Execute plan
   c. Quick verify (tsc, lint) → fix if failed (up to max_fix_loops)
   d. Update graph incrementally, save snapshot
   e. Write agent learnings to ledger (logWarning, logDiscovery)
5. **Full verification** — TypeScript, tests, lint, build, phase goal check
6. **Commit** with agent metadata
7. **Cleanup** — temp files, final graph update
8. **Log completion** — ledger update, archive on phase complete

Knowledge propagation: Plan N warnings → ledger → Plan N+1 session_context → agents avoid pitfalls.

## Dynamic Agent Factory (Catalog-Based)
Selects specialist agents from the catalog and injects context:
  node forge-agents/factory.js analyze <plan-file> --root .  — Show selected agent, risk, context, verification
  node forge-agents/factory.js build <plan-file> --root .    — Output full agent config as JSON
  node forge-agents/factory.js build-all <dir> --root .      — Build configs for all .md plans in directory

The factory uses a catalog of 15 specialist agents (`forge-agents/catalog/`) instead of the
old archetype system. It analyzes each plan, selects the best-matching specialist, and injects
graph context, session context, and verification steps.

Pipeline:
1. Analyze task — graph context (getContextForTask), capabilities, risk, ledger state,
   **system graph context** (cross-repo exports, consumers, imports via FORGE_SYSTEM_GRAPH_PATH or FORGE_SYSTEM_GRAPH env or .forge/system-graph.db)
   For multi-repo plans with `service:` in frontmatter, uses frontmatter service (not CWD) for system graph lookup
2. Select specialist — match plan to best catalog agent (15 specialists available)
3. Compose system prompt — specialist prompt + capability agent_context + session context
   + **Cross-Repo Context section** (exported interfaces, consumer warnings, imported dependencies)
4. Compose context package — always_load (plan + task files), task_specific (deps, consumers, tests),
   reference (interfaces, **neighbor interfaces.yaml**). Token budget: 70% of context window.
5. Define verification — plan verify fields + capability-mapped checks (typescript, npm_test, etc.)
6. Extract session context — decisions, warnings, preferences, rejected approaches from ledger
   + **persistent knowledge_base** from knowledge.js (filtered by module relevance)

Cross-repo agent awareness:
- Agents receive system_context in config: service_id, exports, consumers, imports, system_db_path
- System prompt includes "Do NOT change exported interfaces without coordination" when consumers exist
- Neighbor interfaces.yaml files loaded as reference context

Agent Cache — built agents persist to `.forge/agents/` for reuse:
  node atos-forge/bin/forge-tools.cjs agents list              — List cached agents with staleness
  node atos-forge/bin/forge-tools.cjs agents show <task-id>    — Detailed agent info
  node atos-forge/bin/forge-tools.cjs agents invalidate        — Remove stale agents
  node atos-forge/bin/forge-tools.cjs agents invalidate --all  — Clear entire cache
  node atos-forge/bin/forge-tools.cjs agents rebuild <task-id> — Force rebuild from plan

Cache key: SHA-256 of plan content + graph.db mtime + system-graph.db mtime + knowledge hash + ledger mtime.
Cache hit → instant reuse. Cache miss → full 7-step build → auto-saves to cache.
Wave-to-wave rebuilds (knowledge propagation) use `--skip-cache` to ensure fresh ledger context.

Storage: `.forge/agents/{task-id}/agent-config.json` + `meta.json`, registry at `.forge/agents/registry.json`.

Programmatic: require('forge-agents/cache').{loadCached, saveToCache, listAgents, showAgent, invalidateStale, clearAll}
Factory: require('forge-agents/factory').buildAgentConfig(planPath, cwd, opts)
  opts.skipCache = true → bypass cache (used for wave-to-wave rebuilds)
Returns: { agentConfig, containerParams, analysis, _fromCache? }

## 8-Layer Verification Engine
Graph-aware, fail-fast verification pipeline:
  node forge-verify/engine.js --root . [--files f1,f2] [--plan plan.md] [--layer 1-8] [--json]

Layers (fail-fast order, each toggleable via config):
1. STRUCTURAL (<5s) — syntax errors, stray console.log/debugger, merge conflict markers, bracket balance
2. TYPE/COMPILE (10-30s) — tsc --noEmit, mypy, go build (auto-detected from file extensions + graph capabilities)
   - Broad tsconfig.json discovery: cwd → parent dirs → src/ → packages/* (monorepo)
   - Fallback: `tsc --noEmit --strict` on changed .ts files directly when no tsconfig found
   - Override: `verification.type_check_command` in config
3. INTERFACE CONTRACTS (5-15s) — graph contract_hash comparison, breaking change detection, consumer risk
4. DEPENDENCY (<5s) — graph.getCycles() for new circular deps, orphaned imports
5. TESTS (30s-5min) — graph-identified test files for changed code (getContextForTask → testFiles)
   - Override: `verification.test_command` in config
6. BEHAVIORAL (varies) — plan's custom verify steps from frontmatter
7. CONTRACT (5-30s) — cross-repo contract verification via system-graph.db
   - Code↔YAML drift: detects phantom exports, undeclared exports, stale/undeclared endpoints
   - Backward compatibility: removed interfaces, removed endpoints, protocol changes
   - Cross-repo ripple: consumer risk from breaking changes, high-fan-in warnings, team coordination
   - Requires: .forge/interfaces.yaml (skip if absent), system-graph.db (optional for ripple)
   - Baseline comparison: .forge/interfaces.yaml.baseline or git show HEAD:.forge/interfaces.yaml
8. ARCHITECTURAL (optional, off by default) — agent-based architectural fitness review
   - Reads .planning/codebase/ARCHITECTURE.md and CONVENTIONS.md
   - Spawns LLM CLI to review changed files against documented conventions
   - Output: { pass, issues: [{file, issue, severity, suggestion}] }
   - Enable via: verification.layers.architectural = true
   - Expensive (LLM call per verification) — use deliberately

Output: { overall, layers[], fix_suggestions[], auto_fixable, graph_diff }
Rich terminal display with pass/fail/skip per layer, duration, specific error details.
Fix suggestions with auto_fixable flags for debugger/console.log removal.

Ledger integration: logError() for each failure, updateState({ verification: "passed" }) on full pass.

Configuration in .forge/config.json or .planning/config.json (verification section):
  layers (per-layer boolean toggles including `contract`, `architectural`), auto_fix (true/false), max_fix_loops,
  type_check_command (override tsc), test_command (override test runner), test_timeout.

Programmatic: require('forge-verify/engine').verify({ cwd, files, planPath, dbPath, ... })
Additional exports: findTsConfig(cwd), loadVerificationConfig(cwd), layerContract (lazy), layerArchitectural
CLI flags: --root, --files, --plan, --db, --baseline, --system-db, --layer, --fail-fast, --json, --silent, --no-ledger

Contract layer module: require('forge-verify/contract-layer')
  layerContract(opts) — full contract check (drift + compat + ripple)
  checkCodeDrift(cwd, declared, files) — code vs interfaces.yaml
  checkBackwardCompatibility(cwd, declared, files) — baseline comparison
  checkCrossRepoRipple(cwd, declared, systemDbPath, drift, compat) — consumer impact via system graph
  resolveSystemDb(cwd) — find system-graph.db from common locations

## Verification Loop (Auto-Fix)
Verify → fix → re-verify loop with loop detection and escalation:
  node forge-verify/loop.js --root . [--files f1,f2] [--plan plan.md] [--max-loops 3] [--commit] [--json]
  node atos-forge/bin/forge-tools.cjs verify work [--files f1,f2] [--max-loops 3] [--commit] [--no-agent]

Flow: verify → PASS? done : analyze fixability → build fix agent → run via worktree → re-verify → max N loops → escalate.
Auto-fixable: type errors (L2), missing imports (L4), assertion mismatches (L5), interface breaks (L3), syntax issues (L1), contract drift (L7).
Not auto-fixable: behavioral failures (L6) → escalate to human.

Loop prevention:
- Same patch hash twice → stuck, escalate
- Fix introduces NEW layer failures → revert changes, escalate
- Max loops (default 3) exceeded → escalate

Fix agents receive session_context from ledger (warnings, decisions, rejected approaches).
Each fix attempt logged: ledger.logError({ error, fix_applied, auto_fixed: true, fix_loop: N }).

Programmatic: require('forge-verify/loop').verifyLoop({ cwd, files, maxLoops, commit, ... })
Returns: { overall, loops[], fix_summary[], graph_diff, learnings[], escalated, escalation_reason }

## Unified Configuration System
Single source of truth for all Forge configuration:
  node forge-config/config.js (module, no CLI)

Merge order: defaults ← ~/.forge/config.json (global) ← .forge/config.json (project).
Deep merge: objects merged recursively, arrays replaced, nulls preserved.

Schema sections (11 primary + 4 legacy):
- project: { name, description }
- graph: { enabled, auto_update, languages, ignore_patterns, module_detection, capability_detection, dashboard_auto_regenerate, snapshot_retention }
- execution: { mode, context_budget, assessment_threshold, auto_split, max_fix_loops, ... }
- agents: { factory_enabled, model_profiles: { quality, balanced, budget }, active_profile }
- verification: { layers: { structural, type_check, interface_contracts, dependency_analysis, tests, behavioral, contract, architectural }, auto_fix, test_command, type_check_command }
- knowledge: { enabled, auto_promote, max_entries, promote_severity_threshold }
- impact_analysis: { enabled, auto_detect, max_depth, scope_threshold }
- session: { ledger_enabled, ledger_max_tokens, auto_compact, archive_on_phase_complete }
- display: { rich_output, inline_graph_context, show_graph_diff, show_agent_learnings }
- git: { atomic_commits, commit_prefix, branching_strategy, sign_commits }
- system: { enabled, auto_detect_interfaces, workers, discovery_depth, default_delivery, sync_on_commit, graph_path, registry_path, ignore_repos }
- Legacy: workflow (incl. arch_review), parallelization, gates, safety (backward compat with .planning/config.json)

Key functions:
  loadConfig(cwd) → { config, sources: { defaults, global, project }, projectSource }
  resolveEffective(cwd) → config + _system (cores, RAM)
  validate(config) → { valid, errors[] }
  saveProjectConfig(cwd, config) → writes .forge/config.json

Section accessors (backward-compatible return shapes):
  getVerification(cwd) — maps lowercase→UPPERCASE for engine.js/loop.js
  getExecution(cwd) — matches old loadForgeConfig shape
  getSystem(cwd) — system graph config with _resolved_workers
  getKnowledge(cwd) — knowledge base config
  getImpactAnalysis(cwd) — impact analysis config
  getLegacyToolsConfig(cwd) — flat shape for forge-tools.cjs

All existing consumers delegate to unified config with try/catch fallback to original inline logic.

## Forge Settings
  node atos-forge/bin/forge-tools.cjs settings [show|recommend|validate|get|set]

Subcommands:
- (none) or show — display effective config with source attribution (D=default, G=global, P=project)
- recommend — detect system capabilities, suggest optimal settings
- validate — run schema validation on merged config
- get <key.path> — read a specific config value (dot notation)
- set <key.path> <value> — update project config, validates after save

## Forge Doctor
  node atos-forge/bin/forge-tools.cjs doctor [--raw for JSON]
  node forge-config/doctor.js --root . [--json]

Health checks across 3 categories:
1. Dependencies: Node.js, Git, Claude CLI, Codex CLI, tree-sitter, better-sqlite3, chalk
2. Project Health: Configuration, Code Graph (with staleness warning >24h), Dashboard, Session Ledger, Snapshots, Git Hooks (post-commit forge updater), System Graph (existence + staleness + stats), Interfaces (existence + validation)
3. System: Resources (cores, RAM)

Box-drawing terminal output with status icons. Returns { checks[], summary: { ok, warn, fail, skip } }.

## System CLI Commands
  node atos-forge/bin/forge-tools.cjs system <subcommand> [options]

Subcommands:
- init — Discover repos, run forge-init on each, build system-graph.db
  Options: --path <dir>, --repos <file>, --github-org <org>, --output <db>, --workers <N>, --force, --dry-run, --workspace
- rebuild — Force re-init (shortcut for init --force)
- sync — Incremental sync of a single repo into the system graph
  Options: --repo <path>, --db <path>
- status — Show system graph health: services, interfaces, deps, cycles, freshness
  Options: --db <path>
- impact <service> — Cross-repo impact analysis for a service
  Options: --db <path>
- validate — Validate local interfaces.yaml, optionally cross-repo
  Options: --cross-repo, --db <path>
- dashboard — Generate system-level HTML dashboard
  Options: --db <path>, --output <path>, --no-open

DB resolution order: --db flag → FORGE_SYSTEM_GRAPH_PATH env → .forge/system-graph.db → parent/.forge/system-graph.db → ~/.forge/system-graph.db

## Forge Skills (invoke with $skill-name in Codex)
- $forge-init — Build code graph, detect interfaces, create full .forge/ environment (config, session, snapshots, knowledge, dashboard, hooks, interfaces.yaml)
- $forge-graph-status — Show code graph health, stats, hotspots
- $forge-graph-overview — Codebase summary
- $forge-graph-show <file> — File details with symbols
- $forge-graph-hotspots [--top N] — Risk hotspots
- $forge-graph-cycles — Circular dependencies
- $forge-graph-capabilities [module] — Module capabilities
- $forge-impact <file-or-phase> — Impact analysis shortcut
- $forge-graph-visualize — Generate and open HTML dashboard
- $forge-settings — Show config, interactive edit, validate, recommend (validates before saving)
- $forge-doctor — Check all deps, graph health, system graph, interfaces
