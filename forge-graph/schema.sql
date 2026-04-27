-- Atos Forge Code Graph Engine — SQLite Schema
-- Stores a queryable representation of repository structure, symbols, and dependencies.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ============================================================
-- Core Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS files (
    path            TEXT PRIMARY KEY,
    module          TEXT,
    language        TEXT,
    loc             INTEGER DEFAULT 0,
    complexity_score REAL DEFAULT 0.0,
    last_modified   TEXT,
    is_test         BOOLEAN DEFAULT 0,
    is_config       BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS symbols (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL, -- function|class|type|interface|const|enum|component
    file            TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    line_start      INTEGER,
    line_end        INTEGER,
    exported        BOOLEAN DEFAULT 0,
    signature       TEXT    -- for functions: params + return type
);

CREATE TABLE IF NOT EXISTS dependencies (
    source_file     TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    target_file     TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    import_name     TEXT NOT NULL,
    import_type     TEXT NOT NULL, -- named|default|namespace|dynamic|require
    PRIMARY KEY (source_file, target_file, import_name)
);

-- ============================================================
-- Module Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS modules (
    name                TEXT PRIMARY KEY,
    root_path           TEXT NOT NULL,
    file_count          INTEGER DEFAULT 0,
    public_api_count    INTEGER DEFAULT 0,
    internal_file_count INTEGER DEFAULT 0,
    stability           TEXT DEFAULT 'medium' -- high|medium|low
);

CREATE TABLE IF NOT EXISTS module_dependencies (
    source_module   TEXT NOT NULL REFERENCES modules(name) ON DELETE CASCADE,
    target_module   TEXT NOT NULL REFERENCES modules(name) ON DELETE CASCADE,
    edge_count      INTEGER DEFAULT 1,
    PRIMARY KEY (source_module, target_module)
);

CREATE TABLE IF NOT EXISTS module_capabilities (
    module_name     TEXT NOT NULL REFERENCES modules(name) ON DELETE CASCADE,
    capability      TEXT NOT NULL,
    confidence      REAL DEFAULT 0.0,
    evidence        TEXT,
    PRIMARY KEY (module_name, capability)
);

-- ============================================================
-- Interface & Change Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS interfaces (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    file            TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    kind            TEXT NOT NULL, -- export_function|export_class|export_type|export_component
    consumer_count  INTEGER DEFAULT 0,
    contract_hash   TEXT    -- hash of signature — detects breaking changes
);

CREATE TABLE IF NOT EXISTS change_frequency (
    file            TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
    changes_7d      INTEGER DEFAULT 0,
    changes_30d     INTEGER DEFAULT 0,
    changes_90d     INTEGER DEFAULT 0,
    last_changed    TEXT,
    top_changers    TEXT    -- JSON array of git authors
);

-- ============================================================
-- Agent Intelligence Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS warnings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    module          TEXT,
    file            TEXT,
    warning_text    TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'info', -- info|warning|critical
    source          TEXT NOT NULL DEFAULT 'auto-detected', -- human|agent|auto-detected
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_learnings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT,
    module          TEXT,
    learning_type   TEXT NOT NULL, -- discovery|warning|decision|pattern
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Metadata
-- ============================================================

CREATE TABLE IF NOT EXISTS graph_meta (
    key             TEXT PRIMARY KEY,
    value           TEXT
);

-- ============================================================
-- Indexes for Performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(exported);
CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file);
CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file);
CREATE INDEX IF NOT EXISTS idx_files_module ON files(module);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_interfaces_file ON interfaces(file);
CREATE INDEX IF NOT EXISTS idx_warnings_module ON warnings(module);
CREATE INDEX IF NOT EXISTS idx_warnings_severity ON warnings(severity);
CREATE INDEX IF NOT EXISTS idx_agent_learnings_module ON agent_learnings(module);
CREATE INDEX IF NOT EXISTS idx_change_freq_changes ON change_frequency(changes_30d DESC);

-- ============================================================
-- Call Graph & Hierarchy
-- ============================================================

CREATE TABLE IF NOT EXISTS call_graph (
    caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    callee_name      TEXT NOT NULL,
    callee_file      TEXT,
    call_site_line   INTEGER,
    call_type        TEXT NOT NULL DEFAULT 'direct',
    resolved         BOOLEAN DEFAULT 0,
    PRIMARY KEY (caller_symbol_id, callee_name, call_site_line)
);

CREATE TABLE IF NOT EXISTS class_hierarchy (
    child_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    parent_name TEXT NOT NULL,
    parent_file TEXT,
    relation    TEXT NOT NULL DEFAULT 'extends',
    resolved    BOOLEAN DEFAULT 0,
    PRIMARY KEY (child_id, parent_name)
);

CREATE TABLE IF NOT EXISTS dead_code (
    symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    confidence  REAL DEFAULT 0.0,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_call_graph_caller ON call_graph(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_call_graph_callee ON call_graph(callee_name);
CREATE INDEX IF NOT EXISTS idx_class_hierarchy_child ON class_hierarchy(child_id);
CREATE INDEX IF NOT EXISTS idx_class_hierarchy_parent ON class_hierarchy(parent_name);
