#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Persistent Decision Store (SQLite-backed)
// ============================================================
// Structured decisions.db at .forge/decisions.db.
// Dual-write target from ledger.js (logDecision, logUserPreference).
// Queryable by scope, module, tags, phase.
// ============================================================

// Lazy-load better-sqlite3
let _Database;
function getDatabase() {
  if (!_Database) _Database = require('better-sqlite3');
  return _Database;
}

// ============================================================
// Schema
// ============================================================

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    rationale TEXT,
    scope TEXT DEFAULT 'global',
    source TEXT DEFAULT 'user',
    module TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by TEXT,
    active BOOLEAN DEFAULT 1
);
CREATE TABLE IF NOT EXISTS decision_tags (
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (decision_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_decisions_scope ON decisions(scope);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_active ON decisions(active);
CREATE INDEX IF NOT EXISTS idx_decision_tags_tag ON decision_tags(tag);
`;

// ============================================================
// Configuration
// ============================================================

function loadDecisionsConfig(cwd) {
  try {
    const config = require('../forge-config/config');
    const { config: effective } = config.loadConfig(cwd);
    return effective.decisions || {};
  } catch {
    return {};
  }
}

// ============================================================
// Paths & Helpers
// ============================================================

function dbPath(cwd) {
  return path.join(cwd, '.forge', 'decisions.db');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateId(text) {
  return crypto.createHash('sha256').update(text + Date.now()).digest('hex').slice(0, 12);
}

// ============================================================
// Similarity (Jaccard on word sets, from knowledge.js)
// ============================================================

function wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
}

function similarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// Database Open (with auto-schema init)
// ============================================================

function open(cwd) {
  const p = dbPath(cwd);
  ensureDir(path.dirname(p));
  const Database = getDatabase();
  const db = new Database(p);
  db.exec(SCHEMA_SQL);
  return db;
}

// ============================================================
// Core Operations
// ============================================================

/**
 * Add a decision to the database.
 * @param {string} cwd - Project root
 * @param {object} opts
 * @param {string} opts.type - decision|preference|convention|warning|pitfall
 * @param {string} opts.text - Decision text
 * @param {string} [opts.rationale] - Why this decision was made
 * @param {string} [opts.scope] - global|phase|module
 * @param {string} [opts.source] - user|agent|ledger
 * @param {string} [opts.module] - Related module name
 * @param {string[]} [opts.tags] - Tags for categorization
 * @returns {{ added: boolean, id: string, reason?: string }}
 */
function add(cwd, opts) {
  const cfg = loadDecisionsConfig(cwd);
  if (cfg.enabled === false) return { added: false, id: '', reason: 'decisions disabled' };

  const threshold = cfg.dedup_threshold || 0.80;
  const db = open(cwd);

  try {
    // Dedup: check existing active decisions of the same type
    const existing = db.prepare('SELECT id, text FROM decisions WHERE active = 1 AND type = ?').all(opts.type || 'decision');
    for (const row of existing) {
      if (similarity(row.text, opts.text) >= threshold) {
        return { added: false, id: row.id, reason: 'duplicate (>' + Math.round(threshold * 100) + '% similar)' };
      }
    }

    const id = generateId(opts.text);
    db.prepare(
      'INSERT INTO decisions (id, type, text, rationale, scope, source, module, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(id, opts.type || 'decision', opts.text, opts.rationale || null, opts.scope || 'global', opts.source || 'user', opts.module || null);

    // Insert tags
    if (opts.tags && opts.tags.length > 0) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO decision_tags (decision_id, tag) VALUES (?, ?)');
      for (const tag of opts.tags) {
        insertTag.run(id, tag);
      }
    }

    return { added: true, id };
  } finally {
    db.close();
  }
}

/**
 * Supersede an existing decision with a new one.
 * @param {string} cwd
 * @param {string} oldId - ID of the decision to supersede
 * @param {object} newDecision - Same shape as add() opts
 * @returns {{ added: boolean, id: string, superseded: string }}
 */
function supersede(cwd, oldId, newDecision) {
  const db = open(cwd);
  try {
    const old = db.prepare('SELECT id FROM decisions WHERE id = ? AND active = 1').get(oldId);
    if (!old) return { added: false, id: '', superseded: oldId, reason: 'original not found or already inactive' };

    const id = generateId(newDecision.text);
    db.prepare(
      'INSERT INTO decisions (id, type, text, rationale, scope, source, module, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(id, newDecision.type || 'decision', newDecision.text, newDecision.rationale || null, newDecision.scope || 'global', newDecision.source || 'user', newDecision.module || null);

    db.prepare('UPDATE decisions SET active = 0, superseded_by = ? WHERE id = ?').run(id, oldId);

    if (newDecision.tags && newDecision.tags.length > 0) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO decision_tags (decision_id, tag) VALUES (?, ?)');
      for (const tag of newDecision.tags) {
        insertTag.run(id, tag);
      }
    }

    return { added: true, id, superseded: oldId };
  } finally {
    db.close();
  }
}

/**
 * Query decisions with optional filters.
 * @param {string} cwd
 * @param {object} [filters]
 * @param {string} [filters.type]
 * @param {string} [filters.scope]
 * @param {string} [filters.module]
 * @param {string} [filters.tag]
 * @param {boolean} [filters.active] - default true
 * @returns {Array<object>}
 */
function query(cwd, filters = {}) {
  const p = dbPath(cwd);
  if (!fs.existsSync(p)) return [];

  const db = open(cwd);
  try {
    const conditions = [];
    const params = [];

    const active = filters.active !== undefined ? filters.active : true;
    conditions.push('d.active = ?');
    params.push(active ? 1 : 0);

    if (filters.type) { conditions.push('d.type = ?'); params.push(filters.type); }
    if (filters.scope) { conditions.push('d.scope = ?'); params.push(filters.scope); }
    if (filters.module) { conditions.push('d.module = ?'); params.push(filters.module); }

    let sql = 'SELECT DISTINCT d.* FROM decisions d';
    if (filters.tag) {
      sql += ' JOIN decision_tags t ON t.decision_id = d.id';
      conditions.push('t.tag = ?');
      params.push(filters.tag);
    }

    sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY d.created_at DESC';

    const rows = db.prepare(sql).all(...params);

    // Attach tags to each row
    const tagStmt = db.prepare('SELECT tag FROM decision_tags WHERE decision_id = ?');
    return rows.map(row => ({
      ...row,
      active: !!row.active,
      tags: tagStmt.all(row.id).map(t => t.tag),
    }));
  } finally {
    db.close();
  }
}

/**
 * Get decisions relevant for an agent context.
 * @param {string} cwd
 * @param {string|number} [phase] - Current phase
 * @param {string[]} [modules] - Modules the agent is working on
 * @param {string[]} [files] - Files being modified
 * @returns {Array<object>}
 */
function forAgent(cwd, phase, modules = [], files = []) {
  const p = dbPath(cwd);
  if (!fs.existsSync(p)) return [];

  const all = query(cwd, { active: true });

  // Score each decision for relevance
  return all.filter(d => {
    // Global scope always relevant
    if (d.scope === 'global') return true;

    // Module match
    if (d.module && modules.length > 0) {
      const lower = d.module.toLowerCase();
      if (modules.some(m => m.toLowerCase() === lower)) return true;
    }

    // Tag match against module names or file basenames
    if (d.tags && d.tags.length > 0) {
      const fileTerms = files.map(f => path.basename(f, path.extname(f)).toLowerCase());
      const allTerms = [...modules.map(m => m.toLowerCase()), ...fileTerms];
      if (d.tags.some(tag => allTerms.includes(tag.toLowerCase()))) return true;
    }

    // Phase scope
    if (d.scope === 'phase' && phase) {
      if (d.tags && d.tags.includes(String(phase))) return true;
    }

    return false;
  });
}

/**
 * Promote decisions from ledger markdown content into the database.
 * @param {string} cwd
 * @returns {{ promoted: number, skipped: number }}
 */
function promoteFromLedger(cwd) {
  let content;
  try {
    const ledger = require('./ledger');
    content = ledger.read(cwd);
  } catch {
    return { promoted: 0, skipped: 0 };
  }
  if (!content) return { promoted: 0, skipped: 0 };

  let promoted = 0;
  let skipped = 0;

  // Parse Decisions section
  const decisionMatch = content.match(/## Decisions\n([\s\S]*?)(?=\n## |$)/);
  if (decisionMatch) {
    const entries = decisionMatch[1].trim().split(/\n(?=\[)/).filter(Boolean);
    for (const entry of entries) {
      const text = entry.replace(/^\[\d{4}-\d{2}-\d{2}\s[\d:]+\]\s*/, '').split('\n')[0].trim();
      const rationaleMatch = entry.match(/Rationale:\s*(.+)/);
      if (text) {
        const result = add(cwd, {
          type: 'decision',
          text,
          rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
          source: 'ledger',
        });
        if (result.added) promoted++; else skipped++;
      }
    }
  }

  // Parse User Preferences section
  const prefMatch = content.match(/## User Preferences\n([\s\S]*?)(?=\n## |$)/);
  if (prefMatch) {
    const lines = prefMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const text = line.replace(/^\s*-\s*/, '').trim();
      if (text) {
        const result = add(cwd, {
          type: 'preference',
          text,
          source: 'ledger',
        });
        if (result.added) promoted++; else skipped++;
      }
    }
  }

  return { promoted, skipped };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  add,
  supersede,
  query,
  forAgent,
  promoteFromLedger,
};
