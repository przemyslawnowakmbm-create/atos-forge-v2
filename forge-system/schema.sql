-- Atos Forge System Graph Engine — SQLite Schema
-- Stores cross-repo service interfaces, dependencies, and team ownership.
-- Companion to per-repo graph.db — this is the system-wide view.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ============================================================
-- Core Tables
-- ============================================================

-- Services (one per repo, or multiple if monorepo)
CREATE TABLE IF NOT EXISTS services (
    id                TEXT PRIMARY KEY,          -- e.g. "payment-service"
    repo              TEXT NOT NULL,             -- e.g. "org/payment-service"
    team              TEXT,                      -- owning team
    description       TEXT,
    version           TEXT,                      -- semver
    local_graph_path  TEXT,                      -- path to repo's .forge/graph.db
    repo_path         TEXT,                      -- local filesystem path to repo root
    interfaces_hash   TEXT,                      -- SHA-256 of interfaces.yaml for staleness
    last_synced       TEXT,                      -- ISO timestamp
    UNIQUE(repo)
);

-- Interfaces (exported capabilities of a service)
CREATE TABLE IF NOT EXISTS interfaces (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id        TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    type              TEXT NOT NULL,             -- api | event | package | rpc | database
    protocol          TEXT,                      -- rest | grpc | kafka | rabbitmq | npm | pypi
    name              TEXT NOT NULL,             -- endpoint path, topic name, package name
    description       TEXT,
    spec_path         TEXT,                      -- path to spec file within repo
    schema_path       TEXT,                      -- path to schema file
    metadata          TEXT,                      -- JSON blob for type-specific fields
    UNIQUE(service_id, type, name)
);

-- Dependencies (imports between services)
CREATE TABLE IF NOT EXISTS dependencies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    consumer_id       TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    provider_id       TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    interface_id      INTEGER REFERENCES interfaces(id) ON DELETE SET NULL,
    type              TEXT NOT NULL,             -- api | event | package | rpc | database
    usage             TEXT,                      -- human description of why
    deprecated        INTEGER DEFAULT 0,        -- flagged for removal
    UNIQUE(consumer_id, provider_id, interface_id)
);

-- ============================================================
-- Team & Organization
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
    id                TEXT PRIMARY KEY,          -- e.g. "payments"
    description       TEXT,
    services          TEXT                       -- JSON array of service IDs
);

-- ============================================================
-- Sync Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id        TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    synced_at         TEXT NOT NULL,             -- ISO timestamp
    interfaces_hash   TEXT NOT NULL,
    changes_summary   TEXT                       -- what changed since last sync
);

-- ============================================================
-- System Metrics (computed during build)
-- ============================================================

CREATE TABLE IF NOT EXISTS service_metrics (
    service_id        TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
    fan_in            INTEGER DEFAULT 0,        -- how many services consume this
    fan_out           INTEGER DEFAULT 0,        -- how many services this depends on
    interface_count   INTEGER DEFAULT 0,        -- exported interfaces
    coupling_score    REAL DEFAULT 0.0,         -- fan_in * fan_out normalized
    risk_level        TEXT DEFAULT 'low'        -- low | medium | high | critical
);

-- ============================================================
-- Metadata
-- ============================================================

CREATE TABLE IF NOT EXISTS system_meta (
    key               TEXT PRIMARY KEY,
    value             TEXT
);

-- ============================================================
-- Indexes for Performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_interfaces_service ON interfaces(service_id);
CREATE INDEX IF NOT EXISTS idx_interfaces_type ON interfaces(type);
CREATE INDEX IF NOT EXISTS idx_interfaces_name ON interfaces(name);
CREATE INDEX IF NOT EXISTS idx_deps_consumer ON dependencies(consumer_id);
CREATE INDEX IF NOT EXISTS idx_deps_provider ON dependencies(provider_id);
CREATE INDEX IF NOT EXISTS idx_deps_type ON dependencies(type);
CREATE INDEX IF NOT EXISTS idx_sync_log_service ON sync_log(service_id);
CREATE INDEX IF NOT EXISTS idx_services_repo ON services(repo);
CREATE INDEX IF NOT EXISTS idx_services_team ON services(team);
CREATE INDEX IF NOT EXISTS idx_service_metrics_risk ON service_metrics(risk_level);
CREATE INDEX IF NOT EXISTS idx_service_metrics_fan_in ON service_metrics(fan_in DESC);
