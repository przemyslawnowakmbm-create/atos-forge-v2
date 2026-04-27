# Forge — Multi-Repo System Graph Architecture

## Status: Draft — Design Document
## Date: 2026-02-20

---

## 1. Problem Statement

Forge currently operates on a single git repository. The code graph (`forge-graph/`) indexes files, symbols, dependencies, and modules within one repo. This works well for monoliths and single-service projects.

Modern systems consist of hundreds of repositories composing one product — microservices, shared libraries, frontend apps, infrastructure repos. In a 500-repo system:

- Claude cannot scan the entire codebase in one context window
- A change in one repo may break consumers in 10 other repos
- Impact analysis stops at repo boundaries
- Agent spawning (containers/worktrees) is limited to one repo
- There is no system-level risk visibility

**Goal:** Extend Forge with a **system-level graph** that indexes cross-repo interfaces, enabling system-wide impact analysis, cross-repo agent spawning, and a hierarchical dashboard.

---

## 2. Architecture Overview

### Two-Layer Graph Model

```
┌─────────────────────────────────────────────────────┐
│                  SYSTEM GRAPH                        │
│            forge-system/system-graph.db              │
│                                                      │
│  service ──exports──▶ interface                      │
│  service ──imports──▶ interface                      │
│  service ──owns──▶ repo                              │
│  team ──maintains──▶ service                         │
│                                                      │
│  Nodes: services, interfaces, repos, teams           │
│  Edges: exports, imports, owns, maintains            │
│  Source: .forge/interfaces.yaml per repo             │
└──────────────┬──────────────────────────────────────┘
               │ drills down via repo reference
┌──────────────▼──────────────────────────────────────┐
│                  LOCAL GRAPH (per repo)               │
│            .forge/graph.db (existing)                 │
│                                                      │
│  file ──imports──▶ file                              │
│  file ──contains──▶ symbol                           │
│  file ──belongs_to──▶ module                         │
│                                                      │
│  Nodes: files, symbols, modules                      │
│  Edges: imports, contains, belongs_to                 │
│  Source: tree-sitter parsing (existing)               │
└─────────────────────────────────────────────────────┘
```

**Key principle:** The system graph is small (hundreds of services, thousands of interfaces). The local graphs are large (hundreds of files per repo). They reference each other but live separately. Claude queries are always focused — never loading the full graph into context.

### Two Entry Points

Forge supports two initialization modes depending on the project shape:

| Command | Use Case | What It Does |
|---------|----------|-------------|
| `forge-init` | Single repo, greenfield, small project | Unchanged. Builds local graph, creates `.forge/` env, detects interfaces. One repo at a time. |
| `forge-system-init` | Multi-repo brownfield, 10-500+ repos | **Runs full `forge-init` across all repos in parallel**, then builds the system graph on top. One command bootstraps everything. |

The assumption behind `system-init` is that **all developers work with AI agents across all repos**. Every repo is an active repo — agents may land in any of them for cross-repo changes. Therefore every repo gets full Forge capabilities (local graph, session, interfaces) from day one, not just lightweight metadata.

```
forge-system-init --github-org myorg
  │
  ├── Discover all repos (GitHub org / repos.json / filesystem glob)
  │
  ├── For each repo (parallel, 16 workers):
  │   ├── Clone (shallow) if not local
  │   ├── Tree-sitter parse → graph.db          ← same as forge-init
  │   ├── Interface detection → interfaces.yaml  ← same as forge-init
  │   └── Create .forge/ environment             ← same as forge-init
  │
  ├── Build system-graph.db from all interfaces.yaml
  ├── Validate cross-repo contracts
  ├── Generate system dashboard
  └── Print summary: "Initialized 487 repos, 1,204 interfaces, 3,891 dependencies"
```

**Cost at scale:** 500 repos × ~30s per repo ÷ 16 parallel workers = **~15 minutes**. Storage: 500 × ~5MB graph.db = **~2.5GB**. Run once, keep fresh via CI hooks.

### Module Layout

```
atos-forge/          (existing — CLI entry point)
forge-graph/         (existing — per-repo code graph)
forge-system/        (NEW — system-level graph)
  ├── schema.sql           — SQLite schema for system-graph.db
  ├── system-init.js       — Batch orchestrator: discovers repos, runs forge-init in parallel, builds system graph
  ├── builder.js           — Build/rebuild system graph from interfaces.yaml files
  ├── query.js             — Query API (CLI + programmatic)
  ├── sync.js              — Sync one repo's interfaces.yaml into system graph
  ├── detect.js            — Auto-detect interfaces (used by both forge-init and system-init)
  ├── dashboard.js         — System-level dashboard generator
  └── validate.js          — Validate interfaces.yaml + cross-repo contract checks
```

---

## 3. Data Model

### 3.1 `interfaces.yaml` (per repo, in `.forge/`)

This is the bridge between local and system graphs. Created by `forge-init`, maintained by developers, versioned in git.

```yaml
# .forge/interfaces.yaml
service:
  name: payment-service
  repo: org/payment-service          # git remote identifier
  team: payments                      # owning team
  description: "Handles payment processing and billing"
  version: 2.3.0                      # service version (semver)

exports:
  # REST API endpoints
  - type: api
    protocol: rest
    spec: openapi.yaml                # path to spec file (optional)
    base_path: /api/payments
    endpoints:
      - method: POST
        path: /api/payments
        description: "Create a payment"
        request_schema: schemas/create-payment.json
        response_schema: schemas/payment.json
      - method: GET
        path: /api/payments/{id}
        description: "Get payment by ID"
        response_schema: schemas/payment.json

  # Async events published
  - type: event
    protocol: kafka                    # kafka | rabbitmq | redis-pubsub | sqs
    topic: payments.completed
    schema: schemas/payment-completed.avsc
    description: "Emitted when payment succeeds"

  # Shared package/library
  - type: package
    registry: npm                      # npm | pypi | maven | nuget
    name: "@org/payment-types"
    entry: dist/index.d.ts
    description: "TypeScript types for payment domain"

  # gRPC service
  - type: rpc
    protocol: grpc
    proto: proto/payment.proto
    service: PaymentService
    methods: [CreatePayment, GetPayment, RefundPayment]

  # Database (owned by this service)
  - type: database
    name: payments_db
    tables: [payments, refunds, invoices]
    description: "Payment service database — do not query directly"

imports:
  # APIs consumed
  - type: api
    service: user-service
    endpoints:
      - method: GET
        path: /api/users/{id}
    usage: "Fetch user details for payment receipts"

  # Events consumed
  - type: event
    service: order-service
    topic: orders.created
    usage: "Trigger payment processing when order is placed"

  # Packages consumed
  - type: package
    name: "@org/shared-types"
    version: "^2.0.0"

  # Database read (cross-service — should be flagged as coupling)
  - type: database
    service: user-service
    tables: [users]
    access: read-only
    usage: "Direct DB read — migration target: use user-service API instead"
    deprecated: true
```

### 3.2 System Graph SQLite Schema (`system-graph.db`)

```sql
-- Services (one per repo, or multiple if monorepo)
CREATE TABLE services (
  id TEXT PRIMARY KEY,                    -- e.g. "payment-service"
  repo TEXT NOT NULL,                     -- e.g. "org/payment-service"
  team TEXT,
  description TEXT,
  version TEXT,
  local_graph_path TEXT,                  -- path to repo's .forge/graph.db
  interfaces_hash TEXT,                   -- SHA of interfaces.yaml for staleness
  last_synced TEXT,                       -- ISO timestamp
  UNIQUE(repo)
);

-- Interfaces (exported capabilities)
CREATE TABLE interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES services(id),
  type TEXT NOT NULL,                     -- api | event | package | rpc | database
  protocol TEXT,                          -- rest | grpc | kafka | rabbitmq | npm | pypi
  name TEXT NOT NULL,                     -- endpoint path, topic name, package name
  description TEXT,
  spec_path TEXT,                         -- path to spec file within repo
  schema_path TEXT,                       -- path to schema file
  metadata TEXT,                          -- JSON blob for type-specific fields
  UNIQUE(service_id, type, name)
);

-- Dependencies (imports between services)
CREATE TABLE dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_id TEXT NOT NULL REFERENCES services(id),
  provider_id TEXT NOT NULL REFERENCES services(id),
  interface_id INTEGER REFERENCES interfaces(id),
  type TEXT NOT NULL,                     -- api | event | package | rpc | database
  usage TEXT,                             -- human description of why
  deprecated INTEGER DEFAULT 0,          -- flagged for removal
  UNIQUE(consumer_id, provider_id, interface_id)
);

-- Teams
CREATE TABLE teams (
  id TEXT PRIMARY KEY,                    -- e.g. "payments"
  services TEXT                           -- JSON array of service IDs
);

-- Sync log (track what's been imported)
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES services(id),
  synced_at TEXT NOT NULL,
  interfaces_hash TEXT NOT NULL,
  changes_summary TEXT                    -- what changed since last sync
);

-- Indexes
CREATE INDEX idx_deps_consumer ON dependencies(consumer_id);
CREATE INDEX idx_deps_provider ON dependencies(provider_id);
CREATE INDEX idx_interfaces_service ON interfaces(service_id);
CREATE INDEX idx_interfaces_type ON interfaces(type);
```

---

## 4. Interface Detection (`forge-system/detect.js`)

Auto-detect interfaces to generate a draft `interfaces.yaml`. Called by both `forge-init` (single repo) and `forge-system-init` (batch across all repos).

### Detection Rules

| Signal | Interface Type | Detection Method |
|--------|---------------|-----------------|
| `openapi.yaml`, `swagger.json` | api (rest) | Parse spec, extract paths + methods |
| `*.proto` files | rpc (grpc) | Parse proto, extract services + methods |
| Kafka producer imports | event (kafka) | Grep for `producer.send`, `KafkaProducer`, topic strings |
| RabbitMQ publish calls | event (rabbitmq) | Grep for `channel.publish`, `basic_publish` |
| `package.json` with `main`/`exports` | package (npm) | Read package.json, extract public entry |
| `setup.py`/`pyproject.toml` with name | package (pypi) | Read Python package config |
| `docker-compose.yml` with ports | api (rest) | Extract service names + exposed ports |
| SQLAlchemy/Prisma models | database | Extract table names from ORM models |
| `.env` with `*_API_URL` vars | api (import) | Infer consumed services from env config |
| `requirements.txt`/`package.json` deps | package (import) | Extract org-scoped packages as imports |
| Fetch/axios calls to known paths | api (import) | Pattern match HTTP client calls |

### Generation Flow

Detection runs identically whether triggered by `forge-init` (single repo) or `forge-system-init` (batch):

```
Per-repo detection (same in both modes):
  ├── Scan for spec files (openapi, proto, avro)
  ├── Scan for producer/publisher patterns
  ├── Scan for package exports
  ├── Scan for consumed services (env vars, HTTP clients)
  ├── Scan for org-scoped package imports
  ├── Generate .forge/interfaces.yaml (draft)
  └── Print summary: "Detected 3 exports, 5 imports"
```

**In `forge-init`:** Detection runs as a step within the single-repo init pipeline.

**In `forge-system-init`:** Detection runs inside each parallel worker as part of the full per-repo init. The orchestrator collects all generated `interfaces.yaml` files afterward to build the system graph.

The generated file is a **draft** — clearly marked with comments like `# AUTO-DETECTED — verify and adjust`. The developer reviews, corrects, and commits it.

---

## 5. System Graph Build & Sync

### 5.1 Full System Init (`forge-system/system-init.js`)

The primary way to bootstrap a multi-repo system. One command, run from a central point:

```bash
# From GitHub org (clones all repos shallow)
node forge-system/system-init.js --github-org myorg --workspace /code --output system-graph.db

# From a repos registry
node forge-system/system-init.js --repos repos.json --output system-graph.db

# From local filesystem (glob)
node forge-system/system-init.js --path "/code/*" --output system-graph.db
```

`repos.json` — registry of all repos in the system:

```json
{
  "repos": [
    { "name": "org/payment-service", "path": "/code/payment-service" },
    { "name": "org/user-service", "path": "/code/user-service" },
    { "name": "org/order-service", "path": "/code/order-service" }
  ]
}
```

**System-init pipeline:**

```
Phase A — Repo Discovery
  1. Resolve repo list (GitHub API / repos.json / filesystem glob)
  2. Clone shallow (--depth 1) any repos not already local
  3. Report: "Found 487 repos"

Phase B — Parallel Full Init (per repo, 16 workers)
  For each repo (same as forge-init):
  4. Tree-sitter parse → .forge/graph.db
  5. Interface detection → .forge/interfaces.yaml (draft)
  6. Create .forge/ environment (config, session, snapshots)
  7. Generate per-repo dashboard

Phase C — System Graph Assembly
  8. Read all .forge/interfaces.yaml files
  9. Insert services + interfaces into system-graph.db
  10. Resolve imports → match against exports → create dependency edges
  11. Validate: warn on unresolved imports, circular deps, deprecated usage
  12. Compute system metrics: fan-in, fan-out, coupling scores

Phase D — Delivery
  13. Generate system dashboard
  14. Print summary with warnings
  15. Optionally deliver changes back to repos (see delivery modes below)
```

**Delivery modes** — how generated `.forge/` files get back into each repo:

| Flag | Behavior | Use Case |
|------|----------|----------|
| `--local` (default) | Write to cloned repos on disk, user commits | Developer machine |
| `--pr` | Open a PR per repo via `gh` | Org-wide rollout, teams review |
| `--commit --branch forge-init` | Direct commit to a branch | Trusted automation |
| `--dry-run` | Output summary only, no writes | Preview before committing |

### 5.2 System Graph Rebuild (`forge-system/builder.js`)

Rebuild just the system graph from existing `interfaces.yaml` files (repos already initialized):

```bash
# Re-aggregate — no per-repo init, just read existing interfaces.yaml files
node forge-system/builder.js --repos repos.json --output system-graph.db
```

Useful when:
- Repos already have `.forge/` from a previous `system-init` or individual `forge-init`
- You want to rebuild the system graph without re-parsing all source code
- CI pipeline aggregation step

Build pipeline:
1. For each repo, read `.forge/interfaces.yaml`
2. Insert service + interfaces into `services` and `interfaces` tables
3. Resolve imports → match against exports to create `dependencies` edges
4. Validate: warn on unresolved imports (service declares consuming an endpoint that no one exports)
5. Compute system-level metrics: fan-in (how many consumers), fan-out (how many dependencies), coupling score

### 5.3 Incremental Sync (`forge-system/sync.js`)

Update the system graph when a single repo's interfaces change:

```bash
# Run from within a repo after updating interfaces.yaml
node forge-system/sync.js --db /path/to/system-graph.db
```

1. Read local `.forge/interfaces.yaml`
2. Compute hash, compare with `sync_log`
3. If changed: delete old entries for this service, re-insert, re-resolve dependencies
4. Log sync to `sync_log` with changes summary

Can be triggered by:
- `forge-init` or `forge-system-init` (initial registration)
- Git hook (post-commit on `interfaces.yaml`)
- CI pipeline step (recommended — auto-sync on merge to main)
- Manual `forge-system-sync` command

**Recommended CI integration** — generated by `system-init` with `--pr` or `--commit` modes:

```yaml
# .github/workflows/forge-sync.yml (dropped into each repo)
on:
  push:
    branches: [main]
    paths: ['.forge/interfaces.yaml']
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node forge-system/sync.js --db ${{ secrets.SYSTEM_GRAPH_PATH }}
```

### 5.3 Validation (`forge-system/validate.js`)

```bash
node forge-system/validate.js --db system-graph.db
```

Checks:
- **Orphan imports:** Service A imports from service B, but service B doesn't export that interface
- **Version mismatches:** Package consumer pins `^2.0` but provider is at `3.1`
- **Deprecated dependencies:** Flag services still consuming deprecated interfaces
- **Circular service dependencies:** A → B → C → A
- **Schema compatibility:** If schema files are referenced, check backward compatibility (optional, future)
- **Direct DB access:** Flag any `type: database` imports (tight coupling anti-pattern)

---

## 6. Query API (`forge-system/query.js`)

### CLI Commands

```bash
# System overview — services, edges, health
node forge-system/query.js overview --db system-graph.db

# What does this service export?
node forge-system/query.js exports payment-service --db system-graph.db

# What does this service consume?
node forge-system/query.js imports payment-service --db system-graph.db

# Who consumes this service? (fan-in)
node forge-system/query.js consumers payment-service --db system-graph.db

# Full impact analysis — if I change this service, what breaks?
node forge-system/query.js impact payment-service --db system-graph.db
# Returns: direct consumers + transitive consumers (depth-limited)

# Impact analysis for a specific interface
node forge-system/query.js impact payment-service --interface "POST /api/payments" --db system-graph.db

# Cross-repo context for an agent working on a task
node forge-system/query.js context-for-task payment-service --files api/routes.py models/payment.py --db system-graph.db
# Returns: affected interfaces, consuming services, contract constraints

# System-level hotspots (most depended-on, highest coupling)
node forge-system/query.js hotspots --db system-graph.db

# Circular dependencies between services
node forge-system/query.js cycles --db system-graph.db

# Dependency path between two services
node forge-system/query.js path payment-service analytics-service --db system-graph.db

# Team impact — which teams need to coordinate for this change?
node forge-system/query.js team-impact payment-service --db system-graph.db
```

### Programmatic API

```javascript
const { SystemQuery } = require('forge-system/query');
const sq = new SystemQuery('/path/to/system-graph.db');
sq.open();

// Used by agent factory to build cross-repo context
const impact = sq.impact('payment-service', { depth: 2 });
// Returns: { service, direct_consumers: [...], transitive_consumers: [...],
//            affected_interfaces: [...], team_coordination: [...] }

// Used by parallel planner for cross-repo DAG
const deps = sq.serviceDependencies();
// Returns: { nodes: [...services], edges: [...dependencies] }

sq.close();
```

---

## 7. Integration with Existing Forge Modules

### 7.1 Agent Factory (`forge-agents/factory.js`)

**Current:** Builds agent context from local graph only.

**Extended:** If `system-graph.db` is available:

```javascript
// Step 1 (existing): Local graph context
const localContext = graph.getContextForTask(files);

// Step 2 (NEW): Cross-repo context
const systemContext = systemQuery.contextForTask(serviceName, files);
// Returns: { affected_interfaces, consuming_services, contract_constraints }

// Step 3: Compose agent prompt with both
agentConfig.system_prompt += `
## Cross-Repo Constraints
This service exports interfaces consumed by: ${systemContext.consuming_services.join(', ')}
Do NOT change these contracts without coordination:
${systemContext.contract_constraints.map(c => '- ' + c).join('\n')}
`;
```

### 7.2 Parallel Planner (`forge-agents/parallel-planner.js`)

**Current:** Plans waves within one repo based on file dependencies.

**Extended:** Plans waves across repos:

```
Wave 1: Modify API contract in payment-service (repo A)
Wave 2: Update client SDK in checkout-service (repo B) + analytics-service (repo C)
Wave 3: Integration test across all three
```

The DAG is built from `dependencies` table edges, not file-level imports.

### 7.3 Container Orchestrator (`forge-containers/`)

**Current:** Each container gets a worktree of the current repo.

**Extended:** Each container gets:
- Worktree of its target repo
- Read-only copy of system-graph.db
- Interface contracts from neighboring services (spec files)
- Local graph.db of its target repo

```javascript
// Container launch config for cross-repo work
{
  taskId: "update-checkout-client",
  repo: "org/checkout-service",
  agentConfig: { /* ... */ },
  context: {
    system_db: "/shared/system-graph.db",
    neighbor_specs: {
      "payment-service": "openapi.yaml"  // mounted read-only
    }
  }
}
```

### 7.4 Verification Engine (`forge-verify/`)

**New layer 7 — CONTRACT VERIFICATION:**

After modifying a service's exported interfaces, verify:
1. Does the updated `interfaces.yaml` match the actual code?
2. Are exported schemas backward-compatible?
3. Do consuming services' tests still pass against the new contract?

This is the cross-repo ripple verification:
```
verify locally → verify contracts → spawn verification agents in consumer repos
```

### 7.5 `forge-init` (Single Repo — Unchanged + Interface Detection)

`forge-init` remains the entry point for single-repo / greenfield projects. The only addition is interface detection at the end:

```
forge-init (extended)
  ├── [existing] Build local code graph
  ├── [existing] Create .forge/ environment
  ├── [existing] Generate dashboard
  ├── [NEW] Run interface detection → .forge/interfaces.yaml (draft)
  └── [NEW] If system.graph_path configured in .forge/config.json:
      ├── Sync this repo into system graph
      └── Show system-level context (consumers, providers)
```

No changes to existing behavior. Interface detection is additive. If no system graph is configured, the interfaces.yaml is still useful as documentation.

### 7.6 `forge-system-init` (Multi-Repo Batch)

The new command for brownfield multi-repo projects. Orchestrates full `forge-init` across all repos in parallel, then assembles the system graph:

```
forge-system-init --github-org myorg
  ├── Discover all repos (GitHub API / repos.json / filesystem)
  ├── For each repo (parallel workers):
  │   └── Run full forge-init pipeline (graph.db + interfaces.yaml + .forge/ env)
  ├── Build system-graph.db from all interfaces.yaml
  ├── Validate cross-repo contracts
  ├── Generate system dashboard
  └── Deliver changes back (--local / --pr / --commit / --dry-run)
```

Internally, `system-init.js` reuses the exact same init logic as `forge-init` — it just orchestrates it at scale with a parallel worker pool and adds the system graph assembly step on top.

### 7.7 Dashboard

**System-level dashboard** (`forge-system/dashboard.js`):

- **Level 1 — System Map:** Force-directed graph of services as nodes, dependency edges between them. Color by team. Size by fan-in (more consumers = bigger node). Click to drill down.
- **Level 2 — Service Detail:** Panel showing exports, imports, consumers, version, team. Link to open repo's local dashboard.
- **Level 3 — Per-repo dashboard:** Existing `forge-graph/dashboard-generator.js` output.

Same static HTML approach — system-graph.db is small enough to inline as JSON. Generated by:

```bash
node forge-system/dashboard.js --db system-graph.db --output system-dashboard.html
```

Uses the same Forge theme (navy header, light background).

Tabs:
1. **Service Map** — force-directed graph (services as nodes)
2. **Dependency Matrix** — NxN grid, cell = dependency exists (similar to capability matrix)
3. **Interface Registry** — searchable table of all exported interfaces across system
4. **Risk Register** — system-level: highest fan-in, most deprecated deps, circular deps
5. **Team View** — group services by team, show cross-team dependencies

---

## 8. Configuration

### System-level config (in system repo or `~/.forge/system-config.json`)

```json
{
  "system": {
    "name": "Example Platform",
    "repos_source": "github-org",
    "github_org": "example-org",
    "system_graph_path": ".forge/system-graph.db",
    "auto_sync": true,
    "sync_on_commit": true
  },
  "repos_registry": "repos.json",
  "validation": {
    "warn_deprecated": true,
    "fail_on_orphan_imports": false,
    "fail_on_circular_deps": true,
    "schema_compat_check": false
  }
}
```

### Per-repo config addition (`.forge/config.json`)

```json
{
  "system": {
    "graph_path": "/shared/system-graph.db",
    "service_name": "payment-service"
  }
}
```

---

## 9. CLI Commands Summary

### New `forge-tools.cjs` commands

```
forge-system-init                    — Full system bootstrap: init all repos + build system graph
forge-system-rebuild                 — Rebuild system graph from existing interfaces.yaml files
forge-system-sync                    — Sync current repo into system graph
forge-system-status                  — Show system graph health + stats
forge-system-impact <service>        — Cross-repo impact analysis
forge-system-validate                — Check all contracts and flag issues
forge-system-dashboard               — Generate system-level dashboard
```

### New `forge-system/` CLI

```
node forge-system/system-init.js --github-org <org> --workspace <dir> --output <db>  — Full system bootstrap
node forge-system/system-init.js --repos <file> --output <db>                         — Bootstrap from registry
node forge-system/system-init.js --path "<glob>" --output <db>                        — Bootstrap from filesystem
node forge-system/builder.js --repos <file> --output <db>     — Rebuild system graph (no per-repo init)
node forge-system/sync.js --db <db>                            — Incremental sync from current repo
node forge-system/query.js <command> --db <db>                 — Query system graph
node forge-system/validate.js --db <db>                        — Validate contracts
node forge-system/dashboard.js --db <db> --output <html>       — Generate dashboard
node forge-system/detect.js [--root .]                         — Detect interfaces in current repo
```

### Delivery flags (for `system-init`)

```
--local                              — Write to cloned repos on disk (default)
--pr                                 — Open PR per repo via gh CLI
--commit --branch <name>             — Direct commit to branch
--dry-run                            — Preview only, no writes
--workers <N>                        — Parallel worker count (default: auto-detect)
```

---

## 10. Implementation Plan

### Phase 1: Foundation — Interface Detection + Schema (3 new files)

**Files:** `forge-system/detect.js`, `forge-system/schema.sql`, `forge-system/validate.js`

1. Define `interfaces.yaml` schema (the spec in section 3.1)
2. Implement `detect.js` — auto-detect interfaces from codebase signals (see detection rules in section 4)
3. Integrate detection into existing `forge-init` — generate draft `.forge/interfaces.yaml` as a new step
4. Implement basic `validate.js` — schema validation of interfaces.yaml (structural correctness)
5. Create `schema.sql` — SQLite schema for system-graph.db (needed by Phase 2)

**Verification:** Run `forge-init` on L1 project → should detect REST API exports (FastAPI routes), Celery task events, Redis pub/sub, PostgreSQL tables. Run on HEXAI → should detect NestJS controllers, Keycloak auth, Neo4j connections.

### Phase 2: System Graph Core — Build + Query + Sync (3 new files)

**Files:** `forge-system/builder.js`, `forge-system/query.js`, `forge-system/sync.js`

1. Implement `builder.js` — scan repos with existing `interfaces.yaml`, build system-graph.db
2. Implement `query.js` — full CLI + programmatic API: overview, exports, imports, consumers, impact, hotspots, cycles, path, team-impact, context-for-task
3. Implement `sync.js` — incremental update from one repo (hash-based change detection)
4. Test with L1 + HEXAI + a mock service: build graph, run queries, verify dependency edges

**Verification:** Build system graph from L1 + HEXAI → `query.js impact l1-service-desk` shows cross-service dependencies. `query.js cycles` returns clean or flags known circular deps.

### Phase 3: System Init — Batch Orchestrator (1 new file + 1 modified)

**Files:** `forge-system/system-init.js`, modify `forge-config/config.js`

This is the key new capability — one command to bootstrap an entire multi-repo system:

1. Implement `system-init.js` — repo discovery (GitHub org, repos.json, filesystem glob)
2. Parallel worker pool — runs full `forge-init` per repo (reuses existing init logic)
3. After all repos initialized: call `builder.js` to assemble system graph
4. Call `validate.js` for cross-repo contract checks
5. Delivery modes: `--local`, `--pr`, `--commit`, `--dry-run`
6. Progress reporting: per-repo status, overall progress bar, final summary
7. Add `system` section to unified config schema in `forge-config/config.js`
8. Optionally generate CI workflow file (`.github/workflows/forge-sync.yml`) per repo

**Verification:** Run `forge-system-init --path "/code/*"` across L1 + HEXAI → both repos get full `.forge/` environment + system-graph.db built with cross-repo edges. Re-run with `--dry-run` → no changes written, summary printed.

### Phase 4: Agent Integration — Cross-Repo Context (modify 3 existing files)

**Files:** Modify `forge-agents/factory.js`, `forge-agents/parallel-planner.js`, `forge-containers/orchestrator.js`

1. Extend agent factory to pull cross-repo context from system graph (consuming services, contract constraints)
2. Add cross-repo constraints to agent system prompts ("do NOT change these exported interfaces without coordination")
3. Extend parallel planner to build cross-repo DAGs (Wave 1: modify API in repo A → Wave 2: update clients in repos B, C)
4. Extend container/worktree orchestrator to mount system-graph.db + neighbor specs in agent environments

**Verification:** Agent spawned for L1 API route change receives prompt context listing consuming services and contract constraints.

### Phase 5: System Dashboard (1 new file)

**Files:** `forge-system/dashboard.js`

1. Implement system-level dashboard generator (same pattern as `forge-graph/dashboard-generator.js`)
2. Service Map tab — force-directed graph of services (D3, color by team, size by fan-in)
3. Dependency Matrix tab — NxN grid showing service dependencies
4. Interface Registry tab — searchable table of all exported interfaces
5. Risk Register tab — highest fan-in, deprecated deps, circular service deps
6. Team View tab — services grouped by team, cross-team dependency edges
7. Forge theme (reuse existing CSS generator or extract shared theme)

**Verification:** Generate system dashboard for L1 + HEXAI → shows two service nodes with dependency edges. Click a service → shows exports/imports detail panel.

### Phase 6: Verification Extension — Contract Checks (1 new file + 1 modified)

**Files:** New `forge-verify/contract-layer.js`, modify `forge-verify/engine.js`

1. Implement Layer 7 (CONTRACT) in `contract-layer.js`
2. Check: does actual code match declared `interfaces.yaml`? (e.g., route exists in code but missing from interfaces, or interfaces declares endpoint that code deleted)
3. Check: are exported schemas backward-compatible after changes?
4. Cross-repo ripple verification: spawn lightweight verification agents in consumer repos
5. Wire Layer 7 into `engine.js` verification pipeline (after Layer 6 behavioral)

**Verification:** Modify an API route in L1 → verification flags "this endpoint is exported in interfaces.yaml, 2 consumers depend on it — coordinate before deploying."

### Phase 7: CLI + forge-tools Integration (modify 1 existing file)

**Files:** Modify `atos-forge/bin/forge-tools.cjs`

1. Add commands: `system-init`, `system-rebuild`, `system-sync`, `system-status`, `system-impact`, `system-validate`, `system-dashboard`
2. Wire commands to `forge-system/` modules
3. Integrate system graph path into unified config
4. Add system health checks to `forge-doctor` (system-graph.db staleness, orphan imports, contract violations)

**Verification:** `forge-tools.cjs system-status` shows system graph health. `forge-tools.cjs system-init --dry-run --path "/code/*"` previews what would be initialized.

---

## 11. Scaling Considerations

| Dimension | Expected Scale | Approach |
|-----------|---------------|----------|
| Repos | 500+ | SQLite handles thousands of rows trivially |
| Services | 500-1000 (some repos = multiple services) | Service table with repo FK |
| Interfaces | 5-20 per service → 5,000-10,000 | Indexed by service_id and type |
| Dependencies | ~3x interfaces → 15,000-30,000 | Indexed by consumer/provider |
| Local graphs | 500 × ~5MB graph.db = ~2.5GB | Stored per-repo, referenced by system graph |
| Dashboard data | ~500 nodes, ~5,000 edges | Static HTML with inlined JSON works |
| System-init time | 500 repos × ~30s ÷ 16 workers = ~15 min | One-time batch, parallelized |
| Incremental sync | Milliseconds per repo | Hash-based change detection, CI-triggered |
| Claude context | Query results only, not raw DB | Focused responses, ~200-500 tokens per query |

SQLite is the right choice at this scale. Migration to Neo4j only if:
- Need real-time multi-user concurrent writes
- Traversal queries exceed SQLite's recursive CTE performance (unlikely at 500 services)
- Need graph-native algorithms (PageRank, community detection) for large-scale analysis

---

## 12. Open Questions

1. **Monorepo support:** A single repo may contain multiple services (e.g., monorepo with `packages/`). Should `interfaces.yaml` support declaring multiple services per repo?

2. **Versioned interfaces:** Should the system graph track interface versions over time (breaking change history) or just current state?

3. **Schema compatibility checking:** Deep schema validation (e.g., Avro backward compat, OpenAPI breaking change detection) is valuable but complex. Defer to Phase 6 or skip?

4. **System graph storage:** Where does `system-graph.db` live? Options: dedicated "system" repo, shared filesystem, each developer's machine with periodic rebuild. `system-init` produces it locally — how is it shared?

5. **Staleness management:** After `system-init`, local graphs go stale as developers push code. CI-triggered `sync.js` handles `interfaces.yaml` changes, but what about local `graph.db` freshness? Should `system-init` be re-run periodically (nightly CI job)?

6. **Partial re-init:** If 3 out of 500 repos fail during `system-init` (e.g., unsupported language, corrupt repo), should the command continue and report failures, or fail fast? Likely: continue + report.

7. **GitHub rate limits:** `--github-org` with 500 repos means 500 API calls for discovery + 500 shallow clones. May need pagination, throttling, or caching of previously cloned repos.

---

## 13. File Tree After Implementation

```
forge-system/               (NEW MODULE)
  ├── schema.sql             — SQLite schema for system-graph.db
  ├── system-init.js         — Batch orchestrator: discover repos, parallel init, build system graph
  ├── detect.js              — Auto-detect interfaces from codebase signals
  ├── builder.js             — Rebuild system graph from existing interfaces.yaml files
  ├── sync.js                — Incremental sync from one repo
  ├── query.js               — CLI + programmatic query API
  ├── validate.js            — Contract validation (structural + cross-repo)
  ├── dashboard.js           — System-level dashboard generator
  └── package.json           — Module dependencies

New verification file:
  └── forge-verify/contract-layer.js    — Layer 7 contract verification logic

Modified existing files:
  ├── atos-forge/bin/forge-tools.cjs    — New system-* commands
  ├── forge-agents/factory.js           — Cross-repo context in agent prompts
  ├── forge-agents/parallel-planner.js  — Cross-repo DAG planning
  ├── forge-containers/orchestrator.js  — Mount system context in containers
  ├── forge-verify/engine.js            — Wire Layer 7 into verification pipeline
  └── forge-config/config.js            — system section in config schema

New per-repo files (created by forge-init or forge-system-init):
  ├── .forge/interfaces.yaml            — Declared service interfaces
  └── .github/workflows/forge-sync.yml  — CI auto-sync (optional, via --pr/--commit)
```
