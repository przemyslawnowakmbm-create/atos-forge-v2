# Forge

AI-powered spec-driven development system for Claude Code. Builds a code graph of your project, manages session memory across context resets, orchestrates parallel agents in isolated containers, verifies results with a 9-layer pipeline, and can run autonomously from research to commit.

Works air-gapped. No external services. Runs entirely on your machine.

```
Requirements: Node 20+, Git, Claude Code CLI
Optional:     Docker (for container isolation)
```

---

## Installation

### Automated setup (recommended)

```bash
git clone git@10.48.159.164:other/fdp.git forge
cd forge
./scripts/setup.sh --global
```

The setup script:
1. Checks system requirements (Node 20+, Git, npm, Claude CLI, Docker)
2. Installs graph engine dependencies (tree-sitter, better-sqlite3)
3. Builds hooks
4. Copies everything to `~/.claude/` (commands, agents, workflows, engine modules)
5. Runs 101 verification tests
6. Prints next steps

### Manual setup

```bash
git clone git@10.48.159.164:other/fdp.git forge
cd forge

# Install graph engine dependencies
cd forge-graph && npm install && cd ..

# Build hooks
node scripts/build-hooks.js

# Install to Claude Code (global)
node bin/install.js --claude --global
```

### First use (in your project)

```bash
cd /path/to/your/project
claude

# Initialize Forge (builds code graph, creates .forge/)
/forge-init

# Verify
/forge-doctor

# Start building
/forge-new-project
```

For detailed instructions, troubleshooting, and installation modes see [INSTALLATION.md](INSTALLATION.md).

---

## What this is

Most AI coding tools treat your codebase as a flat bag of files. Forge builds a graph of it: modules, dependencies, interfaces, capabilities, hotspots. Every operation — planning, execution, verification — uses this graph to understand what it's touching, what might break, and what to test.

When a task is too large for a single context window, Forge splits it into sub-plans, creates specialized agents for each, runs them in parallel (containers or worktrees), collects their patches, verifies the result, and auto-fixes failures. The session ledger persists decisions and progress so nothing is lost between restarts.

### What makes it different

| Component | What it does |
|-----------|-------------|
| **Code Graph** | Tree-sitter AST analysis builds a SQLite database of every file, symbol, import, module boundary, and interface. Queries answer "what depends on this?" in milliseconds. |
| **Interactive Dashboard** | Self-contained HTML file with D3.js. Module map, dependency explorer, hotspot heatmap, capability matrix, risk register. Opens in any browser, works offline. |
| **Agent Factory** | Reads a plan file, queries the graph for context, determines archetype (specialist, integrator, careful, general), composes a system prompt, selects which files to load, and defines verification steps. |
| **Container Orchestrator** | Runs agents in Docker containers or git worktrees. Resource-aware scheduling: auto-detects cores and RAM, bin-packs agents into waves respecting memory and CPU limits. |
| **Task Assessment** | Before execution, estimates whether a plan fits in a single context window. If not, splits it by module boundaries, concerns, or individual files with cascading fallback. |
| **6-Layer Verification** | Structural checks, type compilation, interface contract hashes, dependency cycles, graph-identified tests, behavioral verification. Each layer independently toggleable. Auto-fix loop retries failures up to 3 times before escalating. |
| **Session Ledger** | Markdown file at `.forge/session/ledger.md` that records decisions, warnings, errors, user preferences, and rejected approaches. Agents read it on startup so Wave 3 knows what Wave 1 learned. |

### How agents work

When you give Forge a task, it doesn't just send it to Claude. It runs a pipeline:

**1. Assess** — Can this task fit in one context window?

Forge estimates the token cost of every file involved (file size / 4 chars per token), adds overhead for the system prompt, graph context, and session ledger, then checks against the context budget (default 200k tokens with a 20% safety margin). If the total exceeds 80% of the usable budget, the task needs splitting.

**2. Split** — Break oversized tasks into sub-plans

Three strategies, chosen automatically based on file structure:

- **Module split** — groups files by module boundaries (preferred when 2+ modules are affected)
- **Concern split** — orders by type: schema → migration → implementation → test → config
- **File split** — splits within a single large file by exported vs internal symbols

If a sub-plan still overflows, it cascades: module → concern → file → symbol-level splits.

**3. Build agents** — One specialized agent per sub-plan

The factory reads each sub-plan, queries the code graph for dependencies and capabilities, and assigns an archetype:

| Archetype | When | Behavior |
|-----------|------|----------|
| **Specialist** | Single module, strong capabilities | Deep focus, module-specific verification |
| **Integrator** | 3+ modules touched | Cross-module awareness, interface checks |
| **Careful** | High or critical risk score | Extra verification, conservative changes |
| **General** | Everything else | Balanced approach |

Each agent gets a tailored system prompt, a context package (the right files to load, not all of them), and a verification checklist. Built agents are cached in `.forge/agents/` — if the plan and graph state haven't changed, the next run reuses the cached config instantly instead of re-running the full pipeline.

**4. Schedule** — Organize agents into waves

The parallel planner builds a dependency graph (DAG) from the sub-plans. Independent agents run in parallel; dependent ones wait. Agents are bin-packed into waves respecting:

- **max_concurrent** — auto-detected from your CPU and RAM, hard cap of 8
- **max_total_memory** — 70% of system RAM
- **max_total_cpu** — system cores minus 2

Formula for auto-detection:
```
max_concurrent = min(
  floor((cores - 2) / cpu_per_agent),
  floor((ram × 0.7) / memory_per_agent)
)
```

Example on a 16-core, 32GB machine with default 2GB/1CPU per agent: `min(14, 11) = 11`, capped at 8.

**5. Execute** — Run each wave

Per wave, Forge:
1. Creates an isolated git worktree for each agent
2. Launches a Docker container (or Claude Code subprocess if no Docker)
3. Agent executes its sub-plan, produces a `git diff` patch
4. Patches are applied to the main repo via `git apply --3way`
5. Quick verification (layers 1–4) — if it fails, a fix-agent retries (up to 3 times)
6. Agent warnings and discoveries are written to the session ledger

**6. Propagate knowledge** — Wave N informs Wave N+1

After each wave, the factory rebuilds the next wave's agent configs with the updated ledger (bypassing the cache to pick up new warnings). If Wave 1 discovers "this API returns XML, not JSON", Wave 2 agents see that in their system prompt and handle it correctly. No agent repeats a mistake another already made.

**7. Verify** — Full 9-layer check after all waves

All six verification layers run on the combined result. If anything fails, the auto-fix loop retries up to 3 times before escalating to you.

**8. Commit** — One atomic commit with agent metadata

### Can agents spawn sub-agents?

No. Agents do not recursively spawn other agents. The orchestrator controls all parallelism through the wave system. An agent receives a sub-plan, executes it, and returns a patch. Communication between agents happens only through the session ledger — never directly.

The wave structure makes this safe: Wave 1 agents are fully independent (no shared files). Wave 2 agents can depend on Wave 1's output. The dependency graph prevents conflicts.

### Execution modes

Forge degrades gracefully based on what's available:

| Mode | Requires | Parallelism | Isolation |
|------|----------|-------------|-----------|
| **Container** | Docker + Claude CLI | Full (up to 8 concurrent) | Complete (each agent in its own container) |
| **Worktree** | Git + Claude CLI | Full (up to 8 concurrent) | Partial (separate worktrees, shared host) |
| **Sequential** | Claude CLI only | None (one at a time) | None |

Auto-detected at runtime. Override with `execution.container_backend` in config.

---

## Quick start

```bash
# 1. Build the code graph
node forge-graph/builder.js .

# 2. Check everything is working
node atos-forge/bin/forge-tools.cjs doctor

# 3. Explore the codebase visually
node atos-forge/bin/forge-tools.cjs graph visualize --open

# 4. Query the graph
node forge-graph/query.js overview
node forge-graph/query.js impact src/auth/login.ts
node forge-graph/query.js hotspots --top 10

# 5. Run verification on changed files
node forge-verify/engine.js --root . --files src/auth/login.ts
```

---

## Architecture

```
                          .forge/config.json
                                 |
                          +--------------+
                          |    Config    |  ~/.forge/config.json (global)
                          |    System   |  .forge/config.json   (project)
                          +--------------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
  +--------------+      +--------------+      +--------------+
  |  Code Graph  |----->|   Session    |----->|    Agent     |
  |    Engine    |      |   Ledger     |      |   Factory    |
  |              |      |              |      |              |
  | builder.js   |      | ledger.js    |      | factory.js   |
  | query.js     |      |              |      | parallel-    |
  | updater.js   |      | Persists:    |      |  planner.js  |
  | capability-  |      | - decisions  |      |              |
  |  detector.js |      | - warnings   |      | Archetypes:  |
  | snapshot.js  |      | - errors     |      | specialist   |
  | dashboard-   |      | - progress   |      | integrator   |
  |  generator.js|      | - preferences|      | careful      |
  +--------------+      +--------------+      | general      |
         |                       |            +--------------+
         |  context-for-task     |  session        |
         |  impact analysis      |  context        |  agent configs
         |  contract hashes      |                 |
         v                       v                 v
  +--------------+      +--------------+      +--------------+
  |  Assessment  |      |  Container   |<-----|  Execution   |
  |   Pipeline   |      | Orchestrator |      |   Pipeline   |
  |              |      |              |      |              |
  | assessor.js  |      | Docker or    |      | execute-     |
  | splitter.js  |      |  worktree    |      |  phase.md    |
  |              |      |              |      |              |
  | Splits plans |      | Parallel     |      | Waves with   |
  | that exceed  |      | execution    |      | knowledge    |
  | context      |      | with resource|      | propagation  |
  | budget       |      | limits       |      |              |
  +--------------+      +--------------+      +--------------+
                                |
                    patches (git diff)
                                |
                                v
                        +--------------+
                        | Verification |
                        |    Loop      |
                        |              |
                        | engine.js    |  9 layers, fail-fast
                        | loop.js      |  auto-fix up to 3x
                        |              |  escalate if stuck
                        | L1 Structure |
                        | L2 Types     |
                        | L3 Contracts |
                        | L4 Deps      |
                        | L5 Tests     |
                        | L6 Behavioral|
                        +--------------+
                                |
                           PASS | FAIL
                                |
                                v
                        +--------------+
                        |    Commit    |
                        | + Ledger     |
                        |   Update     |
                        +--------------+
```

**Data flow:** The graph provides context for every operation. The ledger carries knowledge forward between waves. The factory uses both to build the right agent for each task. The orchestrator runs agents in isolation. The verification loop checks everything before committing.

---

## Graph commands

The code graph is the foundation. Build it first, then query it.

```bash
# Build from scratch (scans all files, detects modules, extracts symbols)
node forge-graph/builder.js <project-root>

# Incremental update (only changed files since last build)
node forge-graph/updater.js <project-root>
```

### Queries

```bash
# High-level codebase summary
node forge-graph/query.js overview

# What does this file depend on? What depends on it?
node forge-graph/query.js show <file>

# Blast radius: what breaks if this file changes?
node forge-graph/query.js impact <file>

# Which files change the most and have the highest complexity?
node forge-graph/query.js hotspots [--top N]

# Are there circular dependencies?
node forge-graph/query.js cycles

# What can each module do? (typescript, testing, database, etc.)
node forge-graph/query.js capabilities [module-name]

# What context does an agent need to work on these files?
node forge-graph/query.js context-for-task <file1> <file2> ...

# All modules and their dependency relationships
node forge-graph/query.js modules
```

### Via forge-tools

```bash
# Same queries routed through the CLI
node atos-forge/bin/forge-tools.cjs graph init         # Build graph
node atos-forge/bin/forge-tools.cjs graph status       # Health + stats
node atos-forge/bin/forge-tools.cjs graph impact <file>
node atos-forge/bin/forge-tools.cjs graph context <f1> <f2>
node atos-forge/bin/forge-tools.cjs graph visualize    # Generate dashboard
node atos-forge/bin/forge-tools.cjs graph snapshot save
node atos-forge/bin/forge-tools.cjs graph snapshot list
node atos-forge/bin/forge-tools.cjs graph snapshot-diff
```

### Dashboard

```bash
# Generate and open the interactive HTML dashboard
node atos-forge/bin/forge-tools.cjs graph visualize --open
```

The dashboard is a single `.forge/dashboard.html` file (~1MB) with embedded D3.js. Five tabs:

1. **Module Map** — force-directed graph of module dependencies, sized by file count, colored by stability
2. **Dependency Explorer** — pick any file, see its import tree (upstream) and consumer tree (downstream)
3. **Hotspot Heatmap** — treemap grouped by module, colored by change frequency
4. **Capability Matrix** — modules vs capabilities (typescript, testing, api, database, etc.)
5. **Risk Register** — high-consumer interfaces, hotspot files, circular deps, unstable modules

Works offline. Open it in any browser.

---

## Session management

Forge remembers decisions and progress even if your terminal session ends. The session ledger at `.forge/session/ledger.md` persists context across compaction and restarts.

The ledger contains:
- **Current execution state** — phase, wave, what's done, what's running
- **Decisions** — choices made and their rationale (agents won't re-ask)
- **Warnings from agents** — loaded into downstream agents automatically
- **User preferences** — respected by all subsequent agents
- **Rejected approaches** — agents won't retry these
- **Errors and fixes** — what broke, what was tried, what worked

**Knowledge propagation:** When Wave 1 agents discover something ("this API returns XML, not JSON"), they write it to the ledger. Wave 2 agents read it on startup. No agent repeats a mistake another already made.

```bash
# Read current ledger state
node atos-forge/bin/forge-tools.cjs ledger state

# View the full ledger
node atos-forge/bin/forge-tools.cjs ledger read

# Compact (stay under token budget)
node atos-forge/bin/forge-tools.cjs ledger compact

# Archive and reset for a new phase
node atos-forge/bin/forge-tools.cjs ledger archive
```

When agents are instructed via CLAUDE.md, the first thing they do is read the ledger. If the conversation context gets compacted by Claude Code, the ledger is still there on disk with the full picture. Trust the ledger over summarized history when they conflict.

---

## Configuration

Forge uses a unified config system. Settings merge in order:

```
defaults  <-  ~/.forge/config.json (global)  <-  .forge/config.json (project)
```

Global config is optional. Project config overrides everything. If neither exists, defaults apply.

### Schema

```json
{
  "project":       { "name": "", "description": "" },
  "graph":         { "enabled": true, "auto_update": true, "languages": [],
                     "ignore_patterns": ["node_modules", "dist", "build", ".git"],
                     "module_detection": true, "capability_detection": true,
                     "dashboard_auto_regenerate": true, "snapshot_retention": 20 },
  "execution":     { "mode": "interactive", "container_backend": "worktree",
                     "context_budget": 200000, "assessment_threshold": 0.80,
                     "auto_split": true, "max_fix_loops": 3 },
  "containers":    { "max_concurrent": "auto", "max_memory_per_container": "2g",
                     "max_cpu_per_container": 1.0, "timeout_seconds": 600,
                     "network_access": false, "cleanup_on_exit": true,
                     "image_prefix": "forge-agent" },
  "agents":        { "factory_enabled": true, "default_archetype": "general",
                     "model_profiles": { "quality": "opus", "balanced": "sonnet",
                     "budget": "haiku" }, "active_profile": "balanced" },
  "verification":  { "layers": { "structural": true, "type_check": true,
                     "interface_contracts": true, "dependency_analysis": true,
                     "tests": true, "behavioral": true },
                     "auto_fix": true, "max_fix_loops": 3,
                     "test_command": null, "type_check_command": null },
  "session":       { "ledger_enabled": true, "ledger_max_tokens": 8000,
                     "auto_compact": true, "archive_on_phase_complete": true },
  "display":       { "rich_output": true, "inline_graph_context": true,
                     "show_graph_diff": true, "show_agent_learnings": true },
  "git":           { "atomic_commits": true, "commit_prefix": "",
                     "branching_strategy": "none", "sign_commits": false }
}
```

All fields have defaults. You only need to set what you want to change.

`"auto"` values for `max_concurrent`, `max_total_memory`, `max_total_cpu` are resolved at runtime from your system's actual cores and RAM.

### Verification layer names

The config uses lowercase names. The engine maps them internally:

| Config key | Engine layer |
|-----------|-------------|
| `structural` | STRUCTURAL |
| `type_check` | TYPE_COMPILE |
| `interface_contracts` | INTERFACE_CONTRACTS |
| `dependency_analysis` | DEPENDENCY |
| `tests` | TESTS |
| `behavioral` | BEHAVIORAL |

Set any layer to `false` to skip it globally.

---

## System commands

### Doctor

Checks all dependencies, graph health, container readiness, and system resources in one command.

```bash
node atos-forge/bin/forge-tools.cjs doctor
```

```
╔════════════════ FORGE HEALTH CHECK ═════════════════╗
╠══════════════════════════════════════════════════════════╣
║  Dependencies                                            ║
║    ✅ Node.js           v20.20.0                          ║
║    ✅ Git               2.43.0                            ║
║    ✅ Docker            v29.2.1                           ║
║    ✅ Claude CLI        2.1.49                            ║
║    ✅ tree-sitter       available                         ║
║    ✅ better-sqlite3    available                         ║
║    ✅ chalk             available                         ║
║                                                          ║
║  Project Health                                          ║
║    ✅ Configuration     valid (project)                   ║
║    ✅ Code Graph        147 files, 12 modules             ║
║    ✅ Dashboard         2h ago                            ║
║    ✅ Ledger            ~3.2k tokens, Phase 3             ║
║    ✅ Snapshots         12 saved                          ║
║                                                          ║
║  System                                                  ║
║    ✅ Resources         16 cores, 32.0g RAM               ║
║                         → max 6 concurrent agents         ║
║                                                          ║
║  13/13 passed                                            ║
╚══════════════════════════════════════════════════════════╝
```

JSON output: `node atos-forge/bin/forge-tools.cjs doctor --raw`

### Settings

View effective config, detect system capabilities, get recommendations.

```bash
# Show all settings with source attribution
# D = default, G = global (~/.forge/config.json), P = project (.forge/config.json)
node atos-forge/bin/forge-tools.cjs settings

# Get a specific value
node atos-forge/bin/forge-tools.cjs settings get containers.max_concurrent

# Set a value (validates after save)
node atos-forge/bin/forge-tools.cjs settings set containers.max_concurrent 4

# System-aware recommendations
node atos-forge/bin/forge-tools.cjs settings recommend

# Validate config
node atos-forge/bin/forge-tools.cjs settings validate
```

### Init (graph)

```bash
# Build code graph from scratch
node atos-forge/bin/forge-tools.cjs graph init

# Graph health and statistics
node atos-forge/bin/forge-tools.cjs graph status
```

### Impact analysis

```bash
# What breaks if this file changes?
node atos-forge/bin/forge-tools.cjs graph impact src/auth/session.ts

# What context does an agent need for these files?
node atos-forge/bin/forge-tools.cjs graph context src/api/users.ts src/db/models.ts
```

### Verification

```bash
# Run 9-layer verification on specific files
node forge-verify/engine.js --root . --files src/api/users.ts

# Run verification loop with auto-fix (up to 3 attempts)
node forge-verify/loop.js --root . --files src/api/users.ts --max-loops 3

# Via forge-tools
node atos-forge/bin/forge-tools.cjs verify work --files src/api/users.ts --commit
```

### Snapshots

```bash
# Save current graph state
node atos-forge/bin/forge-tools.cjs graph snapshot save

# List saved snapshots
node atos-forge/bin/forge-tools.cjs graph snapshot list

# Compare current graph against last snapshot
node atos-forge/bin/forge-tools.cjs graph snapshot-diff
```

---

## Directory structure

```
atos-forge/
├── atos-forge/              CLI, workflows, templates
│   ├── bin/forge-tools.cjs  Main CLI entry point (6000 lines, 50+ subcommands)
│   ├── workflows/           Execution pipeline definitions
│   └── templates/           Config and scaffold templates
│
├── forge-graph/             Code graph engine
│   ├── builder.js           Full build: scan files, parse AST, detect modules
│   ├── updater.js           Incremental: only changed files since last commit
│   ├── query.js             Query API: impact, hotspots, cycles, context-for-task
│   ├── capability-detector  Per-module capability detection
│   ├── dashboard-generator  Self-contained HTML + D3.js dashboard
│   └── snapshot.js          Graph state snapshots for diffing
│
├── forge-session/           Session persistence
│   └── ledger.js            Markdown ledger: decisions, warnings, state
│
├── forge-agents/            Agent orchestration
│   ├── factory.js           Build agent configs from plans + graph context
│   ├── cache.js             Agent cache (persist + reuse built agents)
│   └── parallel-planner.js  DAG scheduling, bin-packing into waves
│
├── forge-assess/            Task assessment
│   ├── assessor.js          Context overflow detection
│   └── splitter.js          Plan splitting (module/concern/file strategies)
│
├── forge-containers/        Execution isolation
│   ├── orchestrator.js      Docker container lifecycle
│   ├── worktree-orchestrator Docker-free fallback via git worktrees
│   └── config.js            Resource detection and limits
│
├── forge-verify/            Verification pipeline
│   ├── engine.js            9-layer verification engine
│   └── loop.js              Auto-fix loop with escalation
│
├── forge-config/            Configuration system
│   ├── config.js            Unified schema, merge, validation
│   ├── doctor.js            Health check (13 checks)
│   └── settings.js          Display, recommendations
│
├── .forge/                  Runtime state (gitignored)
│   ├── config.json          Project configuration
│   ├── graph.db             SQLite code graph database
│   ├── dashboard.html       Generated interactive dashboard
│   ├── session/ledger.md    Session ledger
│   ├── snapshots/           Graph state snapshots
│   └── agents/              Cached agent configs (registry + per-agent meta)
│
└── CLAUDE.md                Agent instructions (read by Claude Code on startup)
```

---

## Requirements

| Dependency | Version | Required | Notes |
|-----------|---------|----------|-------|
| Node.js | 20+ | Yes | Runtime for all modules |
| Git | 2.x | Yes | Worktree support needed for agent execution |
| Claude Code CLI | Any | Yes | Agent execution (`claude --print`) |
| Docker | 20+ | No | Container isolation (falls back to worktrees) |
| tree-sitter | (npm) | No | Better AST parsing (falls back to regex) |
| better-sqlite3 | (npm) | No | Graph database (graph features disabled without it) |

Run `node atos-forge/bin/forge-tools.cjs doctor` to check your environment.

**Air-gapped operation:** Forge makes no network calls. The graph database, dashboard, ledger, and config are all local files. The only external dependency is Claude Code itself (which handles its own API connection). If you pre-install npm dependencies, everything works fully offline.

---

## Programmatic API

Every module exports functions for use in scripts and workflows.

```javascript
// Unified config
const { loadConfig, resolveEffective, validate } = require('./forge-config/config');
const config = resolveEffective('/path/to/project');

// Graph queries
const { GraphQuery } = require('./forge-graph/query');
const gq = new GraphQuery('.forge/graph.db');
gq.open();
const context = gq.getContextForTask(['src/api/users.ts']);
const impact = gq.impact('src/db/models.ts');

// Verification
const { verify } = require('./forge-verify/engine');
const result = await verify({ cwd: '.', files: ['src/api/users.ts'] });

// Verification loop with auto-fix
const { verifyLoop } = require('./forge-verify/loop');
const loopResult = await verifyLoop({ cwd: '.', files: ['src/api/users.ts'], maxLoops: 3 });

// Agent factory (auto-caches built agents in .forge/agents/)
const { buildAgentConfig } = require('./forge-agents/factory');
const agent = buildAgentConfig('plans/01-PLAN.md', '.');
const fresh = buildAgentConfig('plans/01-PLAN.md', '.', { skipCache: true });

// Agent cache
const { listAgents, showAgent, invalidateStale } = require('./forge-agents/cache');
const agents = listAgents('/path/to/project');  // all cached agents with staleness
const detail = showAgent('/path/to/project', 'task-id');
invalidateStale('/path/to/project');  // remove stale entries

// Session ledger
const ledger = require('./forge-session/ledger');
ledger.logDecision('.', { decision: 'Use JWT', reason: 'Stateless auth needed' });
const state = ledger.readState('.');

// Doctor
const { doctor } = require('./forge-config/doctor');
const health = doctor('.', { json: true });
```
