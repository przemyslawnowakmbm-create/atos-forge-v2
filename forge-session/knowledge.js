#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Persistent Knowledge Base
// ============================================================
// Curated knowledge store at .forge/knowledge/learnings.json.
// Accumulates across milestones (never wiped on archive/reset).
// Fed by ledger archiving (auto-promotes key learnings).
// Read by agent factory (injected into session_context).
// ============================================================

// ============================================================
// Configuration
// ============================================================

function loadKnowledgeConfig(cwd) {
  try {
    const config = require('../forge-config/config');
    const { config: effective } = config.loadConfig(cwd);
    return effective.knowledge || {};
  } catch {
    return {};
  }
}

// ============================================================
// Paths
// ============================================================

function knowledgeDir(cwd) {
  return path.join(cwd, '.forge', 'knowledge');
}

function knowledgePath(cwd) {
  return path.join(knowledgeDir(cwd), 'learnings.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// ID Generation
// ============================================================

function generateId(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// ============================================================
// Similarity Check (simple Jaccard on words)
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

const DEDUP_THRESHOLD = 0.80;

// ============================================================
// Core Operations
// ============================================================

/**
 * Load the knowledge base.
 * @param {string} cwd - Project root
 * @returns {{ learnings: Array }}
 */
function load(cwd) {
  const p = knowledgePath(cwd);
  if (!fs.existsSync(p)) {
    return { learnings: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { learnings: Array.isArray(data.learnings) ? data.learnings : [] };
  } catch {
    return { learnings: [] };
  }
}

/**
 * Save the knowledge base.
 * @param {string} cwd
 * @param {{ learnings: Array }} data
 */
function save(cwd, data) {
  ensureDir(knowledgeDir(cwd));
  const cfg = loadKnowledgeConfig(cwd);
  const maxEntries = cfg.max_entries || 200;

  // Enforce max entries (keep most recent)
  if (data.learnings.length > maxEntries) {
    data.learnings = data.learnings.slice(-maxEntries);
  }

  fs.writeFileSync(knowledgePath(cwd), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Add a single learning entry.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.text
 * @param {string} [entry.type] - warning|decision|pitfall|convention|preference
 * @param {string[]} [entry.modules]
 * @param {string} [entry.source_milestone]
 * @param {number|string} [entry.source_phase]
 * @param {string} [entry.relevance] - high|medium|low
 * @returns {{ added: boolean, id: string, reason?: string }}
 */
function add(cwd, entry) {
  const data = load(cwd);

  // Dedup check
  for (const existing of data.learnings) {
    if (similarity(existing.text, entry.text) >= DEDUP_THRESHOLD) {
      return { added: false, id: existing.id, reason: 'duplicate (>80% similar to existing entry)' };
    }
  }

  const learning = {
    id: generateId(entry.text + Date.now()),
    type: entry.type || 'convention',
    text: entry.text,
    source_milestone: entry.source_milestone || null,
    source_phase: entry.source_phase != null ? Number(entry.source_phase) : null,
    modules: entry.modules || [],
    created: new Date().toISOString(),
    relevance: entry.relevance || 'medium',
  };

  data.learnings.push(learning);
  save(cwd, data);

  return { added: true, id: learning.id };
}

/**
 * Remove learnings by ID(s).
 * @param {string} cwd
 * @param {string[]} ids
 * @returns {{ removed: number, remaining: number }}
 */
function prune(cwd, ids) {
  const data = load(cwd);
  const idSet = new Set(ids);
  const before = data.learnings.length;
  data.learnings = data.learnings.filter(l => !idSet.has(l.id));
  const removed = before - data.learnings.length;
  if (removed > 0) {
    save(cwd, data);
  }
  return { removed, remaining: data.learnings.length };
}

// ============================================================
// Promotion from Ledger
// ============================================================

/**
 * Severity level ordering for threshold comparison.
 */
const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function severityMeetsThreshold(severity, threshold) {
  const sev = (severity || 'medium').toLowerCase();
  const thr = (threshold || 'medium').toLowerCase();
  return (SEVERITY_ORDER[sev] || 0) >= (SEVERITY_ORDER[thr] || 0);
}

/**
 * Extract the current milestone label from ledger or config.
 */
function detectMilestone(cwd) {
  try {
    const projectPath = path.join(cwd, '.planning', 'PROJECT.md');
    if (fs.existsSync(projectPath)) {
      const content = fs.readFileSync(projectPath, 'utf-8');
      const match = content.match(/##\s*Current\s+Milestone[:\s]*([^\n]+)/i)
        || content.match(/milestone[:\s]*([^\n]+)/i);
      if (match) return match[1].trim();
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Extract the active phase from ledger content.
 */
function detectPhase(ledgerContent) {
  const match = ledgerContent.match(/Active\s+phase:\s*(\S+)/i);
  if (match && match[1] !== '-') return match[1];
  return null;
}

/**
 * Promote key learnings from archived ledger content into the knowledge base.
 *
 * Extracts:
 * - Decisions → type "decision"
 * - Warnings with severity >= threshold → type "warning"
 * - Rejected Approaches → type "pitfall"
 * - User Preferences → type "preference"
 *
 * @param {string} cwd
 * @param {string} ledgerContent - The full markdown content of the archived ledger
 * @returns {{ promoted: number, skipped: number, entries: Array }}
 */
function promote(cwd, ledgerContent) {
  if (!ledgerContent) return { promoted: 0, skipped: 0, entries: [] };

  const cfg = loadKnowledgeConfig(cwd);
  if (cfg.enabled === false || cfg.auto_promote === false) {
    return { promoted: 0, skipped: 0, entries: [] };
  }

  const threshold = cfg.promote_severity_threshold || 'medium';
  const milestone = detectMilestone(cwd);
  const phase = detectPhase(ledgerContent);

  const candidates = [];

  // Parse sections from ledger
  const sectionRegex = /## ([^\n]+)\n([\s\S]*?)(?=\n## |$)/g;
  let match;
  while ((match = sectionRegex.exec(ledgerContent)) !== null) {
    const heading = match[1].trim().toLowerCase();
    const body = match[2].trim();
    if (!body) continue;

    if (heading.includes('decision')) {
      // Each timestamped entry is a decision
      const entries = body.split(/\n(?=\[)/).filter(Boolean);
      for (const entry of entries) {
        const text = entry.replace(/^\[\d{4}-\d{2}-\d{2}\s[\d:]+\]\s*/, '').trim();
        if (text) {
          candidates.push({
            text,
            type: 'decision',
            relevance: 'high',
          });
        }
      }
    } else if (heading.includes('warning') || heading.includes('discover')) {
      // Extract warnings with severity
      const entries = body.split(/\n(?=\[)/).filter(Boolean);
      for (const entry of entries) {
        const sevMatch = entry.match(/⚠️\s*(LOW|MEDIUM|HIGH|CRITICAL)\s*—\s*/i);
        const severity = sevMatch ? sevMatch[1].toLowerCase() : 'medium';
        if (!severityMeetsThreshold(severity, threshold)) continue;
        const text = entry.replace(/^\[\d{4}-\d{2}-\d{2}\s[\d:]+\]\s*/, '')
          .replace(/⚠️\s*(LOW|MEDIUM|HIGH|CRITICAL)\s*—\s*/i, '')
          .trim();
        if (text) {
          candidates.push({
            text,
            type: 'warning',
            relevance: severity === 'critical' || severity === 'high' ? 'high' : 'medium',
          });
        }
      }
      // Also extract discoveries (💡 markers)
      const discoveries = body.split('\n').filter(l => l.includes('💡'));
      for (const d of discoveries) {
        const text = d.replace(/^\[\d{4}-\d{2}-\d{2}\s[\d:]+\]\s*/, '')
          .replace(/💡\s*/, '').trim();
        if (text) {
          candidates.push({ text, type: 'convention', relevance: 'medium' });
        }
      }
    } else if (heading.includes('rejected')) {
      const entries = body.split(/\n(?=\[)/).filter(Boolean);
      for (const entry of entries) {
        const text = entry.replace(/^\[\d{4}-\d{2}-\d{2}\s[\d:]+\]\s*/, '')
          .replace(/✗\s*/, '').trim();
        if (text) {
          candidates.push({ text, type: 'pitfall', relevance: 'high' });
        }
      }
    } else if (heading.includes('preference')) {
      const lines = body.split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of lines) {
        const text = line.replace(/^\s*-\s*/, '').trim();
        if (text) {
          candidates.push({ text, type: 'preference', relevance: 'high' });
        }
      }
    }
  }

  // Detect modules from candidate text (heuristic: look for common module names)
  const moduleHints = detectModuleHints(cwd);

  let promoted = 0;
  let skipped = 0;
  const addedEntries = [];

  for (const candidate of candidates) {
    // Detect modules mentioned in text
    const modules = [];
    for (const hint of moduleHints) {
      if (candidate.text.toLowerCase().includes(hint.toLowerCase())) {
        modules.push(hint);
      }
    }

    const result = add(cwd, {
      text: candidate.text,
      type: candidate.type,
      modules,
      source_milestone: milestone,
      source_phase: phase,
      relevance: candidate.relevance,
    });

    if (result.added) {
      promoted++;
      addedEntries.push({ id: result.id, text: candidate.text, type: candidate.type });
    } else {
      skipped++;
    }
  }

  return { promoted, skipped, entries: addedEntries };
}

/**
 * Detect module names from the code graph or directory structure.
 */
function detectModuleHints(cwd) {
  const hints = [];
  try {
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    if (fs.existsSync(dbPath)) {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare('SELECT name FROM modules').all();
        for (const r of rows) hints.push(r.name);
      } finally {
        db.close();
      }
    }
  } catch { /* graph not available */ }

  // Fallback: common directory names
  if (hints.length === 0) {
    const common = ['frontend', 'backend', 'api', 'database', 'worker', 'shared', 'lib', 'core'];
    for (const d of common) {
      if (fs.existsSync(path.join(cwd, d)) || fs.existsSync(path.join(cwd, 'src', d))) {
        hints.push(d);
      }
    }
  }

  return hints;
}

// ============================================================
// Filtering for Agent Context
// ============================================================

/**
 * Get learnings relevant to specific modules and files.
 *
 * @param {string} cwd
 * @param {string[]} modules - Affected module names
 * @param {string[]} files - Affected file paths
 * @returns {Array} Filtered learnings
 */
function relevantFor(cwd, modules = [], files = []) {
  const data = load(cwd);
  if (data.learnings.length === 0) return [];

  const moduleSet = new Set(modules.map(m => m.toLowerCase()));
  const fileTerms = files.map(f => path.basename(f, path.extname(f)).toLowerCase());

  return data.learnings.filter(learning => {
    // Always include high relevance
    if (learning.relevance === 'high') return true;

    // Check module overlap
    if (learning.modules && learning.modules.length > 0) {
      for (const m of learning.modules) {
        if (moduleSet.has(m.toLowerCase())) return true;
      }
    }

    // Check if learning text mentions any file terms
    const lowerText = learning.text.toLowerCase();
    for (const term of fileTerms) {
      if (term.length >= 3 && lowerText.includes(term)) return true;
    }

    // Include entries with no module restriction (generic)
    if (!learning.modules || learning.modules.length === 0) return true;

    return false;
  });
}

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const cwd = args.includes('--root')
    ? args[args.indexOf('--root') + 1]
    : process.cwd();

  const action = args[0];

  if (action === 'list') {
    const data = load(cwd);
    if (data.learnings.length === 0) {
      console.log('No learnings in knowledge base.');
    } else {
      console.log(`Knowledge base: ${data.learnings.length} entries\n`);
      for (const l of data.learnings) {
        const mods = l.modules.length > 0 ? ` [${l.modules.join(', ')}]` : '';
        const src = l.source_milestone ? ` (${l.source_milestone}${l.source_phase ? ', phase ' + l.source_phase : ''})` : '';
        console.log(`  ${l.id}  [${l.type}] ${l.relevance.toUpperCase()}${mods}${src}`);
        console.log(`         ${l.text}`);
        console.log('');
      }
    }
  } else if (action === 'add') {
    const text = args[1];
    if (!text) {
      console.error('Usage: knowledge.js add <text> [--type <type>] [--modules <m1,m2>] [--relevance <level>]');
      process.exit(1);
    }
    const typeIdx = args.indexOf('--type');
    const modIdx = args.indexOf('--modules');
    const relIdx = args.indexOf('--relevance');
    const type = typeIdx >= 0 ? args[typeIdx + 1] : 'convention';
    const modules = modIdx >= 0 ? args[modIdx + 1].split(',') : [];
    const relevance = relIdx >= 0 ? args[relIdx + 1] : 'medium';
    const result = add(cwd, { text, type, modules, relevance });
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'prune') {
    const ids = args.slice(1).filter(a => !a.startsWith('--'));
    if (ids.length === 0) {
      console.error('Usage: knowledge.js prune <id1> [id2 ...]');
      process.exit(1);
    }
    const result = prune(cwd, ids);
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'promote') {
    // Manual promotion from current ledger
    const ledgerMod = require('./ledger');
    const content = ledgerMod.read(cwd);
    if (!content) {
      console.error('No ledger found');
      process.exit(1);
    }
    const result = promote(cwd, content);
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'relevant') {
    const modules = (args[1] || '').split(',').filter(Boolean);
    const files = (args[2] || '').split(',').filter(Boolean);
    const results = relevantFor(cwd, modules, files);
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.error('Usage: knowledge.js <list|add|prune|promote|relevant> [options] [--root path]');
    process.exit(1);
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  load,
  save,
  add,
  prune,
  promote,
  relevantFor,
  knowledgePath,
  knowledgeDir,
  generateId,
  similarity,
  DEDUP_THRESHOLD,
};
