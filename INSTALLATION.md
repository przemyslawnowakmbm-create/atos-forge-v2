# Forge — Installation Guide

## Quick Install

```bash
git clone git@10.48.159.164:other/fdp.git forge
cd forge
./scripts/setup.sh --global
```

---

## What the installer does

The setup script performs 7 steps in order. Each step shows progress and can be re-run safely (idempotent).

### Step 1: Check system requirements

| Requirement | Minimum | Check |
|------------|---------|-------|
| Node.js | 20+ | `node --version` |
| Git | 2.x+ | `git --version` |
| npm | 8+ | `npm --version` |
| Claude Code CLI | any | `claude --version` |
| Docker (optional) | 20+ | `docker --version` |

If Node.js or Git is missing, the installer prints instructions for your OS and exits.
If Claude Code CLI is missing, it warns but continues (you can install it later).
Docker is optional — Forge falls back to git worktrees when Docker is unavailable.

### Step 2: Clone or update Forge repository

If run via `curl | bash`: clones the repo to `~/.forge-src/`.
If run from inside the repo: uses the current directory.

On subsequent runs: pulls latest changes instead of re-cloning.

### Step 3: Install graph engine dependencies

```bash
cd forge-graph && npm install && cd ..
```

Installs: `tree-sitter`, `better-sqlite3`, `chalk`.
These are the only npm dependencies — everything else is zero-dependency Node.js.

### Step 4: Build hooks

```bash
node scripts/build-hooks.js
```

Copies hook source files to `hooks/dist/` for installation.

### Step 5: Run Forge installer

```bash
node bin/install.js --claude --global
```

This copies to `~/.claude/`:
- `skills/` — 41 forge skills (from `skill-sources/forge-*/SKILL.md`)
- `agents/` — 11 specialized agent definitions
- `atos-forge/` — workflows, templates, references, CLI (forge-tools.cjs + 21 lib modules)
- `forge-graph/` — code graph engine (builder, query, schema, dashboard, conventions, watcher)
- `forge-config/` — unified configuration and doctor/settings helpers
- `forge-session/` — session memory (ledger, decisions, knowledge, crash-recovery, metrics)
- `forge-verify/` — verification pipeline (9-layer engine, auto-fix loop, cache, test stubs, browser layer)
- `forge-assess/` — task assessment (assessor, splitter with connected_component strategy)
- `forge-agents/` — agent factory, parallel planner, output schema
- `forge-containers/` — Docker/worktree orchestration with 3-tier timeout
- `forge-system/` — multi-repo system graph and interface validation
- `forge-analyze/` — requirement impact analyzer
- `hooks/` — statusline, context monitor, update checker
- `CHANGELOG.md`, `VERSION`, `package.json` (CommonJS mode)

Directive propagation:
- Claude / Gemini / OpenCode main sessions load the directives through installed Forge skill `execution_context`
- Codex main session loads the same directives through installed Codex skill `execution_context`
- Spawned Forge sub-agents receive the directives through `forge-agents/factory.js`
- `CLAUDE.md` mirrors the same directive text when working directly inside the FDP repo

### Step 6: Initialize Forge in your project

```bash
cd /path/to/your/project
claude
/forge-init
```

Creates `.forge/` directory with:
- `graph.db` — SQLite code graph (files, symbols, dependencies, modules, call graph, dead code)
- `config.json` — project configuration
- `session/` — ledger, decisions.db
- `snapshots/` — graph state snapshots
- `knowledge/` — persistent cross-milestone learnings
- `dashboard.html` — interactive D3.js dashboard (8 tabs)
- `interfaces.yaml` — auto-detected API interfaces

### Step 7: Verify installation

```bash
/forge-doctor
```

Runs 18 health checks across dependencies, project health, and system resources.

---

## Installation modes

### Global install (recommended — all projects)

```bash
./scripts/setup.sh
# or
node bin/install.js --claude --global
```

Installs to `~/.claude/`. Available in all Claude Code sessions.

### Local install (single project)

```bash
node bin/install.js --claude --local
```

Installs to `./.claude/` in current directory. Only available in this project.

### Custom directory

```bash
node bin/install.js --claude --global --config-dir /custom/path
```

### Multi-runtime

```bash
node bin/install.js --all --global    # Claude Code + OpenCode + Gemini
node bin/install.js --gemini --global # Gemini only
```

---

## Updating

```bash
cd ~/.forge-src  # or wherever you cloned
git pull
./scripts/setup.sh
```

Or from within Claude Code:
```
/forge-update
```

---

## Uninstalling

```bash
node bin/install.js --claude --global --uninstall
```

Removes all Forge files from `~/.claude/` but preserves your project's `.forge/` and `.planning/` directories.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `node: command not found` | Install Node.js 20+: `brew install node` (macOS) or `nvm install 20` |
| `claude: command not found` | Install Claude Code: `npm install -g @anthropic-ai/claude-code` |
| `better-sqlite3` build fails | Ensure build tools: `xcode-select --install` (macOS) or `apt install build-essential` (Linux) |
| `/forge-*` commands not found | Re-run `./scripts/setup.sh` or restart Claude Code |
| `graph.db` missing | Run `/forge-init` in your project |
| Docker not available | Forge falls back to git worktrees automatically — no action needed |

---

## Directory structure after installation

```
~/.claude/                          Global Claude Code config
├── skills/                         41 Forge skills (forge-*/SKILL.md)
├── agents/                         11 specialized agents
├── atos-forge/                     CLI, workflows, templates
│   ├── bin/forge-tools.cjs         Thin dispatcher (709L)
│   ├── bin/lib/                    21 CLI modules
│   ├── workflows/                  34 workflow definitions
│   └── templates/                  Plan/summary templates
├── forge-config/                   Unified config + settings + doctor
├── forge-graph/                    Code graph engine
├── forge-session/                  Session memory
├── forge-verify/                   Verification pipeline
├── forge-assess/                   Task assessment
├── forge-agents/                   Agent factory
├── forge-containers/               Execution isolation
├── forge-system/                   Multi-repo system graph
├── forge-analyze/                  Requirement impact analyzer
├── hooks/                          Claude Code hooks
└── settings.json                   Updated with Forge hooks

~/.forge-src/                       Forge source (if installed via curl)

/your/project/
├── .forge/                         Created by /forge-init
│   ├── graph.db                    SQLite code graph
│   ├── config.json                 Project config
│   ├── dashboard.html              Interactive dashboard
│   ├── session/                    Ledger, decisions.db, metrics
│   ├── snapshots/                  Graph snapshots
│   └── knowledge/                  Persistent learnings
└── .planning/                      Created by /forge-new-project
    ├── PROJECT.md, ROADMAP.md, STATE.md
    └── phases/                     Phase plans and summaries
```
