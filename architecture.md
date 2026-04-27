# Forge — Architecture

> Permanentny dokument architektury. Aktualizowany z każdą zmianą.
> Ostatnia aktualizacja: 2026-03-11 (po: rebrand, modularyzacja CLI, intelligence upgrade, architecture roadmap, installer)

---

## 1. Przegląd systemu

Forge to AI-powered spec-driven development system działający wewnątrz Claude Code, Codex, OpenCode i Gemini. Buduje graf kodu (SQLite), zarządza pamięcią sesji, orkiestruje agentów w izolowanych kontenerach/worktree, weryfikuje wyniki 9-warstwowym pipeline, i może działać autonomicznie (auto mode).

```
┌─────────────────────────────────────────────────────────────┐
│                 Runtime Skill Entry Points                   │
│  /forge-* (Claude) | $forge-* (Codex) → workflows → agents  │
├─────────────┬──────────────┬────────────────┬───────────────┤
│ forge-graph │ forge-session│ forge-agents   │ forge-verify  │
│ (SQLite DB, │ (ledger,     │ (factory,      │ (9 layers,    │
│  call graph,│  decisions,  │  parallel-     │  auto-fix,    │
│  dead code, │  knowledge,  │  planner,      │  cache,       │
│  watcher)   │  metrics,    │  output-schema)│  test-stubs,  │
│             │  crash-      │                │  browser)     │
│             │  recovery)   │                │               │
├─────────────┼──────────────┼────────────────┼───────────────┤
│ forge-assess│ forge-config │ forge-containers│ forge-system │
│ (assessor,  │ (config,     │ (Docker,       │ (multi-repo,  │
│  splitter)  │  doctor,     │  worktree,     │  interfaces,  │
│             │  settings)   │  resource-mgr, │  dashboard)   │
│             │              │  3-tier timeout)│              │
├─────────────┼──────────────┼────────────────┼───────────────┤
│ forge-auto  │ forge-       │ atos-forge/bin │ hooks/        │
│ (state      │  analyze     │ (forge-tools   │ (statusline,  │
│  machine,   │ (impact      │  + 21 lib/     │  context-     │
│  dispatcher,│  analyzer)   │  modules)      │  monitor,     │
│  auto mode) │              │                │  check-update)│
└─────────────┴──────────────┴────────────────┴───────────────┘
```

**Runtime:** Node.js 20+ | **Database:** SQLite (better-sqlite3) | **Air-gapped:** TAK

---

## 2. Moduły — aktualny stan

### 2.1 forge-graph/ — Code Graph Engine (SQLite)

Serce systemu. Tree-sitter AST parsing → SQLite z 15 tabel + 18 indeksów.

| Plik | Opis |
|------|------|
| `builder.js` | Full build: scan → parse AST → detect modules → extract calls/inheritance → detect dead code → write DB + conventions |
| `query.js` | GraphQuery class: impact, hotspots, cycles, context-for-task, callers, callees, hierarchy, dead-code |
| `updater.js` | Incremental: only changed files since last build |
| `schema.sql` | 15 tables, 18 indexes (incl. call_graph, class_hierarchy, dead_code) |
| `capability-detector.js` | Per-module capability detection |
| `convention-detector.js` | Auto-detect naming, imports, exports, test framework |
| `module-detector.js` | Module boundary detection |
| `dashboard-generator.js` | Self-contained HTML + D3.js (8 tabs incl. Cost, Call Graph, Dead Code) |
| `snapshot.js` | Graph state snapshots for diffing |
| `watcher.js` | Live file watching with debounced incremental rebuild |
| `install-hooks.js` | Git hooks installation |

**Schema (graph.db) — 15 tabel:**
```
files, symbols, dependencies              — core AST data
modules, module_dependencies, module_capabilities  — module structure
interfaces, change_frequency               — contracts & git history
warnings, agent_learnings                  — agent intelligence
graph_meta                                 — key/value (conventions, build timestamp)
call_graph                                 — function→function calls (caller_symbol_id, callee_name, call_type)
class_hierarchy                            — extends/implements (child_id, parent_name, relation)
dead_code                                  — symbols with 0 callers (symbol_id, reason, confidence)
```

**Query capabilities:**
- File-level: impact, hotspots, cycles, context-for-task, modules, capabilities
- Function-level: getCallersOf, getCalleesOf, getCallChain
- Class-level: getClassHierarchy (parents + children)
- Analysis: getDeadCode, getComplexSymbols
- CLI: `callers <symbol>`, `callees <symbol>`, `hierarchy <symbol>`, `dead-code [module]`

### 2.2 forge-session/ — Session Memory

| Plik | Opis |
|------|------|
| `ledger.js` | Markdown ledger: decisions, warnings, errors, state + dual-write to decisions.db |
| `decisions.js` | SQLite decisions.db: queryable by scope/type/module, survives archival, Jaccard dedup |
| `knowledge.js` | Persistent cross-milestone learnings (JSON), auto-promoted from ledger |
| `crash-recovery.js` | Lock files (.forge/session/auto.lock) + PID liveness detection + git-log recovery briefing |
| `metrics.js` | Per-unit token/cost tracking (.forge/session/metrics.json), budget ceiling, phase/model breakdown |

### 2.3 forge-agents/ — Agent Orchestration

| Plik | Opis |
|------|------|
| `factory.js` | 7-step pipeline: analyze → archetype → prompt (grounding, directives, conventions, locked decisions, previous findings) → context (3-level compression) → verify → container → session |
| `cache.js` | Agent cache: persist built configs to `.forge/agents/`, SHA-256 keyed, staleness detection, registry |
| `parallel-planner.js` | DAG scheduling, bin-packing into waves |
| `agent-output-schema.js` | Structured JSON output: findings, decisions, confidence |

**Factory intelligence (all implemented):**
- Decision Registry integration (decisions.db → agent prompt)
- Mechanical directives injection (`agent-directives.md` → system prompt)
- Fact-Grounding (graph exports/signatures → "Grounded Facts" section)
- Context Compression (3-level: FULL/INTERFACE/SUMMARY)
- Convention injection (naming, imports, test fw → prompt)
- Plan-Lock (locked_decisions → "LOCKED DECISIONS" section)
- Agent Memory Chain (previous findings → "Previous Agent Findings" section)
- Structured output instruction (json:agent-output block)
- Test stub inclusion (always_load test stubs for RED→GREEN)
- Agent Cache (SHA-256 keyed, auto-save/load, staleness detection, `--skip-cache` for wave-to-wave)

### 2.4 forge-verify/ — Verification Pipeline

| Plik | Opis |
|------|------|
| `engine.js` | 9-layer fail-fast verification + incremental mode + cache |
| `loop.js` | Auto-fix loop with stuck detection + escalation |
| `contract-layer.js` | Cross-repo contract verification |
| `cache.js` | Content-addressed SHA-256 cache, TTL 2min |
| `test-stub-generator.js` | RED→GREEN test stubs from plan verification criteria |
| `browser-layer.js` | Optional Layer 9: Playwright-based e2e testing |

**9 warstw weryfikacji:**
1. STRUCTURAL (<5s) — syntax, debugger/console.log, merge conflicts
2. TYPE/COMPILE (10-30s) — tsc --noEmit, mypy, go build
3. INTERFACE CONTRACTS (5-15s) — contract_hash, breaking changes
4. DEPENDENCY (<5s) — circular deps, orphaned imports
5. TESTS (30s-5min) — graph-identified tests + test stubs
6. BEHAVIORAL (varies) — plan must_haves + locked_decisions + verification_must_check
7. CONTRACT (5-30s) — cross-repo code↔YAML drift, backward compat
8. ARCHITECTURAL (optional) — LLM-based architecture review
9. BROWSER (optional, disabled by default) — Playwright e2e tests

### 2.5 forge-assess/ — Task Assessment & Splitting

| Plik | Opis |
|------|------|
| `assessor.js` | Context overflow detection (INTERFACE-level token estimation) |
| `splitter.js` | 4 strategies: connected_component → module → concern → file |

### 2.6 forge-containers/ — Execution Isolation

| Plik | Opis |
|------|------|
| `orchestrator.js` | Docker lifecycle + agent output parsing + 3-tier timeout supervision |
| `worktree-orchestrator.js` | Docker-free fallback via git worktrees + 3-tier timeout |
| `config.js` | Resource detection (CPU, RAM, max_concurrent) |
| `resource-manager.js` | Semaphore + slot management |
| `container-spec.js` | Image selection (node/python/full) |
| `agent-entrypoint.js` | Container entrypoint |
| `agent-verifier.js` | Lightweight container verifier |
| `patch-collector.js` | git apply --3way |

**Timeout supervision (3-tier):**
- Soft: warning at 70% of hard timeout
- Idle: kill if no git changes for 5 minutes
- Hard: existing kill mechanism

### 2.7 forge-auto/ — Auto Mode

| Plik | Opis |
|------|------|
| `auto.js` | Main loop: read disk state → determine next → dispatch → repeat. Crash-safe, stuck detection. |
| `state-machine.js` | Phase transitions: IDLE → RESEARCH → PLAN → EXECUTE → VERIFY → COMPLETE → REASSESS |
| `dispatcher.js` | Fresh session dispatch via `claude --print` with pre-inlined context |

**Auto mode features:**
- Fresh context per unit (zero context rot)
- Disk-driven (reads .forge/ + .planning/ — zero in-memory state)
- Crash-safe (writeLock per unit, clearLock after)
- Cost tracking (metrics.js per unit)
- Stuck detection (same unit 2x → retry once → stop)
- Command: `/forge-auto`

### 2.8 forge-system/ — Multi-Repo System Graph

builder.js, query.js, schema.sql, detect.js, validate.js, sync.js, system-init.js, dashboard.js.
System-level SQLite (system-graph.db): services, interfaces, dependencies, teams, sync_log, service_metrics.

### 2.9 forge-config/ — Configuration

config.js (unified, 13 schema sections), doctor.js (18 health checks incl. crash lock), settings.js.

### 2.10 forge-analyze/ — Requirement Impact Analyzer

analyzer.js: keyword extraction → interface search → impact analysis → scope detection.

### 2.11 atos-forge/ — CLI & Workflows

- `bin/forge-tools.cjs` — 709L thin dispatcher
- `bin/lib/` — 22 modułów CJS
- `workflows/` — 34 workflow definitions
- `templates/` — plan/summary/config templates
- `references/` — 11 reference docs (incl. `agent-directives.md` — shared directive text for installed skills and spawned agents; mirrored in `CLAUDE.md` when working inside the FDP repo)

### 2.12 hooks/

- `forge-statusline.js` — model, task, context bar + bridge file for monitor
- `forge-context-monitor.js` — PostToolUse: WARNING at 35%, CRITICAL at 25%
- `forge-check-update.js` — background update check

### 2.13 skills/

41 Forge skills, including project workflows (`forge-new-project`, `forge-plan-phase`, `forge-execute-phase`), graph utilities (`forge-graph-status`, `forge-graph-overview`, `forge-graph-show`, `forge-graph-hotspots`, `forge-graph-cycles`, `forge-graph-capabilities`, `forge-graph-visualize`), and health/config helpers (`forge-doctor`, `forge-health`, `forge-settings`).

### 2.14 agents/

11 agents: executor, planner, verifier, debugger, plan-checker, codebase-mapper, research-synthesizer, phase-researcher, project-researcher, roadmapper, integration-checker.

### 2.15 tests/

5 test files (helpers.cjs, core.test.cjs, frontmatter.test.cjs, misc.test.cjs, agent-cache.test.cjs) + 1 CLI test (forge-tools.test.cjs). Total: 112 testów.

---

## 3. Intelligence Layer — zaimplementowane

| # | Feature | Plik | Status |
|---|---------|------|--------|
| 1 | Decision Registry (SQLite) | forge-session/decisions.js | DONE |
| 2 | Fact-Grounding (graph→prompt) | forge-agents/factory.js | DONE |
| 3 | Plan-Lock (locked_decisions) | factory.js + engine.js + planner + frontmatter | DONE |
| 4 | Test-First Pipeline (RED→GREEN) | forge-verify/test-stub-generator.js | DONE |
| 5 | Context Compression (3-level) | forge-agents/factory.js + assessor.js | DONE |
| 6 | Incremental Verification | forge-verify/engine.js + loop.js | DONE |
| 7 | Agent Memory Chain (structured JSON) | agent-output-schema.js + orchestrators | DONE |
| 8 | Smart Splitting (connected components) | forge-assess/splitter.js | DONE |
| 9 | Execution Cache | forge-verify/cache.js | DONE |
| 10 | Convention Detector | forge-graph/convention-detector.js | DONE |
| 11 | Agent Cache (persist + reuse) | forge-agents/cache.js + factory.js | DONE |

---

## 4. GSD-2 Features — zaimplementowane

| # | Feature | Plik | Status |
|---|---------|------|--------|
| 4.1 | Crash Recovery | forge-session/crash-recovery.js + doctor.js + workflows | DONE |
| 4.2 | Auto Mode (state machine) | forge-auto/ (3 pliki) + command + workflow | DONE |
| 4.3 | Timeout Supervision (3-tier) | orchestrator.js + worktree-orchestrator.js | DONE |
| 4.4 | Cost/Token Tracking | forge-session/metrics.js + dashboard Cost tab | DONE |
| 4.5 | Roadmap Reassessment | atos-forge/workflows/reassess-roadmap.md + command | DONE |
| 4.6 | Browser Layer 9 (Playwright) | forge-verify/browser-layer.js + engine.js | DONE |

---

## 5. Graph Extensions (z CGC) — zaimplementowane

| # | Feature | Plik | Status |
|---|---------|------|--------|
| 5.1 | Function-level call_graph | schema.sql + builder.js | DONE |
| 5.2 | Class hierarchy tracking | schema.sql + builder.js | DONE |
| 5.3 | Dead code detection | schema.sql + builder.js + query.js | DONE |
| 5.4 | New query methods (callers/callees/hierarchy/dead-code) | query.js | DONE |
| 5.5 | File watcher | forge-graph/watcher.js | DONE |
| 5.6 | Dashboard tabs (Cost, Call Graph, Dead Code) | dashboard-generator.js | DONE |

---

## 6. Decyzje architektoniczne

| Decyzja | Wybór | Rationale |
|---------|-------|-----------|
| Database | SQLite (better-sqlite3) | Zero config, single file, sync queries <1ms, air-gapped |
| Runtime | Node.js CJS | Ten sam runtime co Claude Code, zero Python dependency |
| Graph model | Relacyjny (SQL) + custom BFS/DFS | Prostsze niż Cypher, wystarczające dla import/call graphs |
| Parser | Tree-sitter (JS bindings) | Multi-language, AST-level accuracy |
| Agent isolation | Docker / git worktree | Full filesystem isolation, parallel execution |
| Session memory | Markdown ledger + SQLite decisions | Ledger for readability, SQLite for queryability |
| Verification | 9-layer fail-fast | Independent layers, toggleable, auto-fix loop |
| Context injection | Pre-inline (3-level) | FULL/INTERFACE/SUMMARY — 40-60% token savings |
| Anti-hallucination | Fact-grounding from graph | Verified exports/signatures in prompt |
| Air-gapped | TAK | Only Claude Code itself needs network |
| CGC integration | NIE (SQLite + own extensions) | Avoids Python dep, preserves sync queries, custom tables |
| GSD-2 integration | Selective feature port | Auto mode, crash recovery, cost tracking, timeouts, browser |
| Auto mode | claude --print per unit | Fresh context, disk-driven state, crash-safe |

---

## 7. Roadmap rozwoju

### Zrobione
- [x] 1-FDP: EUROCONTROL cleanup, URLs→TBD, context-monitor hook, /forge-add-tests
- [x] 2-FDP: Monolith split (6554→709L, 21 modules), tests (101), /forge-validate-phase, --repair
- [x] 3-FDP: Rebrand "Atos"→"Forge" (~70 files), Exo font→system fonts, dead code cleanup (16 files)
- [x] Intelligence Upgrade: 11 optimization points (decisions.db, grounding, plan-lock, test-first, compression, incremental verify, memory chain, smart split, cache, conventions, agent cache)
- [x] Architecture Roadmap: GSD-2 features (crash recovery, auto mode, timeouts, metrics, reassessment, browser L9) + graph extensions (call_graph, class_hierarchy, dead_code, watcher, dashboard tabs)

### Przyszłe możliwości
- [ ] Enhanced auto mode: integration z factory.js agent configs (grounding, conventions w dispatched sessions)
- [ ] Enhanced complexity analysis: cyclomatic per function (not just file-level)
- [ ] Skill discovery system: auto-detect domain → load domain-specific skills
- [ ] Multi-provider support: abstract claude --print za provider interface (OpenAI, Gemini, local)
- [ ] Real-time TUI dashboard: terminal overlay zamiast HTML file (jak GSD-2 Ctrl+Alt+G)
- [ ] Enhanced dead code: confidence scoring z static analysis + usage tracking
- [ ] Graph visualization: interactive call graph explorer w dashboard (zoom to function level)

---

## 8. Installation System

### scripts/setup.sh — Full automated setup

7-step bash script that handles the complete installation:

| Step | What it does |
|------|-------------|
| 1. Check requirements | Node 20+, Git, npm, Claude CLI (optional), Docker (optional), build tools |
| 2. Ensure source | Clone repo or use current dir; pull updates on re-run |
| 3. Install graph deps | `npm install` in forge-graph/ (tree-sitter, better-sqlite3, chalk) |
| 4. Build hooks | Copy hooks to dist/ for installation |
| 5. Run installer | `node bin/install.js --claude --global` (copies everything to ~/.claude/) |
| 6. Run tests | 101 tests as post-install verification |
| 7. Summary | Next steps: /forge-init → /forge-doctor → /forge-new-project |

**Usage:**
```bash
./scripts/setup.sh              # interactive (prompts for global/local)
./scripts/setup.sh --global     # global install, no prompt
./scripts/setup.sh --local      # local install, no prompt
curl -sSL <url>/setup.sh | bash # clone + install (when repo is public)
```

**Idempotent:** safe to re-run. Updates instead of re-cloning. Preserves local patches.

### bin/install.js — Multi-runtime component installer

Copies Forge components into the selected runtime configuration directory. Called by setup.sh or directly.

**What it installs:**
- Claude Code / Gemini: `skill-sources/` — 41 forge skills (`skill-sources/forge-*/SKILL.md`) with path templating
- Codex: `~/.codex/skills/` from `.codex/skills/` plus runtime-adapted `~/.codex/agents/` and hooks
- OpenCode: flattened `command/forge-*.md` commands generated from the same skill sources
- `atos-forge/` — CLI, workflows, templates, references
- `forge-graph/`, `forge-config/`, `forge-session/`, `forge-verify/`, `forge-assess/`, `forge-agents/`, `forge-containers/`, `forge-system/`, `forge-analyze/` — engine modules
- `hooks/` — statusline, context-monitor, check-update (with PostToolUse/SessionStart config)
- Runtime settings / hooks config — updated with hook registrations where supported

**Directive propagation paths:**
- Installed main-session skills: Claude / Gemini / OpenCode skills and Codex skills load `atos-forge/references/agent-directives.md` via `execution_context`
- FDP repo development: `CLAUDE.md` mirrors the directive block for Claude Code auto-load
- Spawned agents: `forge-agents/factory.js` injects the same directive text into every composed system prompt

### INSTALLATION.md — User documentation

Step-by-step guide covering: quick install, what each step does, installation modes (global/local/custom/multi-runtime), updating, uninstalling, troubleshooting, directory structure.

---

## 9. Inwentarz plików

```
FDP Root (59 JS/CJS modules | 41 skills | 34 workflows | 11 agents | 3 hooks | 112 tests)
├── atos-forge/                    CLI entry point
│   ├── bin/forge-tools.cjs        709L thin dispatcher
│   ├── bin/lib/                   21 CJS modules
│   ├── workflows/                 34 workflow definitions
│   ├── templates/                 ~10 templates
│   └── references/                11 reference docs (incl. agent-directives.md)
├── forge-graph/                   Code Graph Engine
│   ├── builder.js                 Build + call extraction + dead code detection
│   ├── query.js                   GraphQuery: impact, callers, callees, hierarchy, dead-code
│   ├── schema.sql                 15 tables + 18 indexes
│   ├── convention-detector.js     Auto-detect project conventions
│   ├── dashboard-generator.js     HTML D3.js (8 tabs incl. Cost, Call Graph, Dead Code)
│   ├── watcher.js                 Live file watching + incremental rebuild
│   ├── updater.js, snapshot.js    Incremental + snapshots
│   └── capability-detector.js, module-detector.js, install-hooks.js
├── forge-session/                 Session Memory
│   ├── ledger.js                  Markdown ledger + dual-write to decisions.db
│   ├── decisions.js               SQLite decisions.db (queryable, survives archival)
│   ├── knowledge.js               Persistent cross-milestone learnings
│   ├── crash-recovery.js          Lock files + PID detection + recovery briefing
│   └── metrics.js                 Per-unit token/cost tracking + budget ceiling
├── forge-agents/                  Agent Orchestration
│   ├── factory.js                 Agent builder (grounding, conventions, compression, plan-lock)
│   ├── cache.js                   Agent cache (SHA-256 keyed, .forge/agents/, registry)
│   ├── parallel-planner.js        DAG scheduling + bin-packing
│   └── agent-output-schema.js     Structured JSON output parsing
├── forge-verify/                  Verification Pipeline
│   ├── engine.js                  9-layer fail-fast + incremental + cache
│   ├── loop.js                    Auto-fix loop + escalation
│   ├── contract-layer.js          Cross-repo contracts
│   ├── cache.js                   Content-addressed verification cache
│   ├── test-stub-generator.js     RED→GREEN test stubs from plan
│   └── browser-layer.js           Optional Layer 9: Playwright e2e
├── forge-assess/                  Task Assessment
│   ├── assessor.js                Context overflow detection
│   └── splitter.js                4-strategy splitting (connected_component first)
├── forge-containers/              Execution Isolation
│   ├── orchestrator.js            Docker lifecycle + 3-tier timeout
│   ├── worktree-orchestrator.js   Git worktree fallback + 3-tier timeout
│   └── config.js, resource-manager.js, container-spec.js, agent-*.js, patch-collector.js
├── forge-auto/                    Auto Mode
│   ├── auto.js                    Main loop (crash-safe, stuck detection)
│   ├── state-machine.js           Phase transitions (IDLE→RESEARCH→PLAN→EXECUTE→VERIFY→COMPLETE)
│   └── dispatcher.js              Fresh session dispatch via claude --print
├── forge-system/                  Multi-Repo System Graph
│   └── builder.js, query.js, schema.sql, detect.js, validate.js, sync.js, system-init.js, dashboard.js
├── forge-config/                  Configuration
│   └── config.js (13 sections), doctor.js (18 checks), settings.js
├── forge-analyze/                 Impact Analyzer
│   └── analyzer.js
├── skills/                       41 forge skills (forge-*/SKILL.md)
├── .codex/                       Codex-specific skills, agents, and hooks
├── agents/                        11 specialized agents
├── hooks/                         3 hooks (statusline, context-monitor, check-update)
├── tests/                         5 test files (112 total tests)
├── bin/install.js                 Component installer (copies to ~/.claude/)
├── scripts/
│   ├── setup.sh                   Full automated setup (7 steps: deps, clone, npm, hooks, install, test, summary)
│   └── build-hooks.js             Hook bundler
├── INSTALLATION.md                Step-by-step installation guide
└── docs/                          USER-GUIDE, SYSTEM-GRAPH-ARCHITECTURE
```
