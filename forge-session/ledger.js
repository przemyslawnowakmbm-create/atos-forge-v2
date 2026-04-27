#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration (unified config with hardcoded fallbacks)
// ============================================================

function loadSessionConfig(cwd) {
  try {
    const config = require('../forge-config/config');
    const { config: effective } = config.loadConfig(cwd);
    return effective.session || {};
  } catch {
    return {};
  }
}

const DEFAULT_MAX_TOKENS_SOFT = 8000;
const DEFAULT_MAX_TOKENS_HARD = 10000;
const CHARS_PER_TOKEN = 4;
const MAX_ARCHIVE_KEEP = 50;

// Resolve limits from config, falling back to hardcoded defaults
function getTokenLimits(cwd) {
  const cfg = loadSessionConfig(cwd);
  const soft = (typeof cfg.ledger_max_tokens === 'number' && cfg.ledger_max_tokens > 0)
    ? cfg.ledger_max_tokens : DEFAULT_MAX_TOKENS_SOFT;
  const hard = Math.ceil(soft * 1.25); // hard cap is 125% of soft limit
  return { soft, hard };
}

// Keep legacy constants for exported backward compat
const MAX_TOKENS_SOFT = DEFAULT_MAX_TOKENS_SOFT;
const MAX_TOKENS_HARD = DEFAULT_MAX_TOKENS_HARD;

// ============================================================
// Paths
// ============================================================

function ledgerDir(cwd) {
  return path.join(cwd, '.forge', 'session');
}

function ledgerPath(cwd) {
  return path.join(ledgerDir(cwd), 'ledger.md');
}

function archiveDir(cwd) {
  return path.join(ledgerDir(cwd), 'archive');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Timestamp
// ============================================================

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function isoNow() {
  return new Date().toISOString();
}

// ============================================================
// Token estimation
// ============================================================

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ============================================================
// Section Parsing
// ============================================================

const SECTIONS = [
  'Current State',
  'Decisions',
  'Warnings & Discoveries',
  'User Preferences',
  'Completed Work',
  'Rejected Approaches',
  'Errors & Fixes',
];

function parseLedger(content) {
  const sections = {};
  const header = {};

  // Parse header
  const headerMatch = content.match(/^# Forge Session Ledger\n([\s\S]*?)(?=\n## )/);
  if (headerMatch) {
    const hLines = headerMatch[1].trim().split('\n');
    for (const line of hLines) {
      const m = line.match(/^(.+?):\s*(.+)$/);
      if (m) header[m[1].trim()] = m[2].trim();
    }
  }

  // Parse sections
  for (const name of SECTIONS) {
    const regex = new RegExp(`## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = content.match(regex);
    sections[name] = match ? match[1].trim() : '';
  }

  return { header, sections };
}

function buildLedger(header, sections) {
  let md = '# Forge Session Ledger\n';
  for (const [k, v] of Object.entries(header)) {
    md += `${k}: ${v}\n`;
  }
  md += '\n';

  for (const name of SECTIONS) {
    md += `## ${name}\n`;
    const content = sections[name] || '';
    if (content) {
      md += content + '\n';
    }
    md += '\n';
  }

  return md;
}

// ============================================================
// Core Read/Write
// ============================================================

function readRaw(cwd) {
  const p = ledgerPath(cwd);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function writeRaw(cwd, content) {
  ensureDir(ledgerDir(cwd));
  fs.writeFileSync(ledgerPath(cwd), content, 'utf-8');
}

function ensureLedger(cwd) {
  const content = readRaw(cwd);
  if (content) return parseLedger(content);

  const header = {
    'Last updated': isoNow(),
    'Active phase': '-',
    'Active command': '-',
  };
  const sections = {};
  for (const name of SECTIONS) {
    sections[name] = '';
  }
  return { header, sections };
}

function save(cwd, header, sections) {
  header['Last updated'] = isoNow();
  const md = buildLedger(header, sections);

  // Auto-compact if too large (uses config limits with fallbacks)
  const limits = getTokenLimits(cwd);
  const cfg = loadSessionConfig(cwd);
  if (cfg.auto_compact !== false && estimateTokens(md) > limits.hard) {
    const compacted = compactSections(header, sections);
    writeRaw(cwd, buildLedger(header, compacted));
  } else {
    writeRaw(cwd, md);
  }
}

function appendToSection(cwd, sectionName, line) {
  const { header, sections } = ensureLedger(cwd);
  const existing = sections[sectionName] || '';
  sections[sectionName] = existing ? existing + '\n' + line : line;
  save(cwd, header, sections);
}

// ============================================================
// State Tracking
// ============================================================

/**
 * Update the current execution state.
 * @param {string} cwd - Project root
 * @param {object} state
 * @param {number} [state.active_phase]
 * @param {string} [state.active_command]
 * @param {string} [state.current_wave]
 * @param {number} [state.agents_complete]
 * @param {number} [state.agents_running]
 * @param {number} [state.agents_queued]
 * @param {string} [state.phase_name]
 * @param {string} [state.status]
 */
function updateState(cwd, state) {
  const { header, sections } = ensureLedger(cwd);

  if (state.active_phase != null) header['Active phase'] = String(state.active_phase);
  if (state.active_command) header['Active command'] = state.active_command;

  const lines = [];
  if (state.phase_name) lines.push(`- Executing Phase ${state.active_phase || header['Active phase']}: "${state.phase_name}"`);
  if (state.current_wave) lines.push(`- Wave ${state.current_wave} in progress`);
  if (state.agents_complete != null || state.agents_running != null || state.agents_queued != null) {
    const parts = [];
    if (state.agents_complete != null) parts.push(`${state.agents_complete} completed`);
    if (state.agents_running != null) parts.push(`${state.agents_running} running`);
    if (state.agents_queued != null) parts.push(`${state.agents_queued} queued`);
    lines.push(`- Agents: ${parts.join(', ')}`);
  }
  if (state.status) lines.push(`- Status: ${state.status}`);

  if (lines.length > 0) {
    sections['Current State'] = lines.join('\n');
  }

  save(cwd, header, sections);
}

// ============================================================
// Decision Logging
// ============================================================

/**
 * Log a decision with rationale.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.decision
 * @param {string} [entry.rationale]
 * @param {string[]} [entry.rejected_alternatives]
 */
function logDecision(cwd, entry) {
  let line = `[${ts()}] ${entry.decision}`;
  if (entry.rationale) line += `\n  Rationale: ${entry.rationale}`;
  if (entry.rejected_alternatives && entry.rejected_alternatives.length) {
    for (const alt of entry.rejected_alternatives) {
      line += `\n  Rejected: ${alt}`;
    }
  }
  appendToSection(cwd, 'Decisions', line);

  // Dual-write to decisions.db
  try {
    const decisions = require('./decisions');
    decisions.add(cwd, { type: 'decision', text: entry.decision, rationale: entry.rationale || '', scope: entry.scope || 'global', source: entry.source || 'user', module: entry.module || null, tags: entry.tags || [] });
  } catch { /* decisions module not available */ }
}

// ============================================================
// Warning Logging
// ============================================================

/**
 * Log a warning from an agent or manual inspection.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.warning
 * @param {string} [entry.source]
 * @param {string} [entry.severity] - low, medium, high, critical
 * @param {string} [entry.resolution]
 */
function logWarning(cwd, entry) {
  const sev = (entry.severity || 'medium').toUpperCase();
  let line = `[${ts()}] \u26A0\uFE0F ${sev} \u2014 ${entry.warning}`;
  if (entry.source) line += ` (${entry.source})`;
  if (entry.resolution) line += `\n  Resolution: ${entry.resolution}`;
  appendToSection(cwd, 'Warnings & Discoveries', line);
}

// ============================================================
// Discovery Logging
// ============================================================

/**
 * Log a discovery from an agent.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.discovery
 * @param {string} [entry.source]
 */
function logDiscovery(cwd, entry) {
  let line = `[${ts()}] \uD83D\uDCA1 ${entry.discovery}`;
  if (entry.source) line += ` (${entry.source})`;
  appendToSection(cwd, 'Warnings & Discoveries', line);
}

// ============================================================
// User Preference Logging
// ============================================================

/**
 * Log a user preference.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.preference
 */
function logUserPreference(cwd, entry) {
  const { header, sections } = ensureLedger(cwd);
  const existing = sections['User Preferences'] || '';

  // Check for duplicate
  if (existing.includes(entry.preference)) return;

  const line = `- ${entry.preference}`;
  sections['User Preferences'] = existing ? existing + '\n' + line : line;
  save(cwd, header, sections);

  // Dual-write to decisions.db
  try {
    const decisions = require('./decisions');
    decisions.add(cwd, { type: 'preference', text: entry.preference, rationale: '', scope: 'global', source: entry.source || 'user', module: entry.module || null, tags: entry.tags || [] });
  } catch { /* decisions module not available */ }
}

// ============================================================
// Wave Completion Logging
// ============================================================

/**
 * Log wave completion with agent results.
 * @param {string} cwd
 * @param {object} entry
 * @param {number} entry.wave
 * @param {Array<{id, status, files_modified, patch, learnings, warnings}>} [entry.agents]
 * @param {string} [entry.verification]
 * @param {string} [entry.graph_snapshot]
 */
function logWaveComplete(cwd, entry) {
  const agentSummaries = (entry.agents || []).map(a => {
    const icon = a.status === 'success' ? '\u2705' : a.status === 'running' ? '\uD83D\uDD04' : '\u274C';
    let s = `${a.id}: ${icon}`;
    if (a.files_modified && a.files_modified.length) {
      s += ` (${a.files_modified.length} files)`;
    }
    if (a.learnings && a.learnings.length) {
      for (const l of a.learnings) {
        s += `\n    Learning: ${l}`;
      }
    }
    if (a.warnings && a.warnings.length) {
      for (const w of a.warnings) {
        s += `\n    Warning: ${w}`;
      }
    }
    return s;
  });

  const verifyIcon = entry.verification === 'passed' ? '\u2705' :
    entry.verification === 'failed' ? '\u274C' : '\uD83D\uDD04';

  let line = `[${ts()}] Wave ${entry.wave} ${verifyIcon}`;
  if (agentSummaries.length) {
    line += ' \u2014 ' + agentSummaries.join(', ');
  }
  if (entry.graph_snapshot) {
    line += `\n  Snapshot: ${entry.graph_snapshot}`;
  }

  appendToSection(cwd, 'Completed Work', line);
}

// ============================================================
// Error Logging
// ============================================================

/**
 * Log an error and its resolution.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} [entry.phase]
 * @param {string} entry.error
 * @param {string} [entry.fix_applied]
 * @param {boolean} [entry.auto_fixed]
 * @param {number} [entry.fix_loop]
 */
function logError(cwd, entry) {
  let line = `[${ts()}] ${entry.error}`;
  if (entry.phase) line = `[${ts()}] [${entry.phase}] ${entry.error}`;
  if (entry.fix_applied) {
    line += `\n  Fix: ${entry.fix_applied}`;
    if (entry.auto_fixed) line += ` (auto-fixed, loop ${entry.fix_loop || 1})`;
  }
  appendToSection(cwd, 'Errors & Fixes', line);
}

// ============================================================
// Rejected Approach Logging
// ============================================================

/**
 * Log a rejected approach.
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.approach
 * @param {string} entry.reason
 * @param {string} [entry.better_alternative]
 */
function logRejected(cwd, entry) {
  let line = `[${ts()}] \u2717 ${entry.approach} \u2014 ${entry.reason}`;
  if (entry.better_alternative) line += `\n  Better: ${entry.better_alternative}`;
  appendToSection(cwd, 'Rejected Approaches', line);
}

// ============================================================
// Generic Event Logging
// ============================================================

/**
 * Log a generic event to the completed work section.
 * @param {string} cwd
 * @param {string} event
 * @param {object} [details]
 */
function logEvent(cwd, event, details) {
  let line = `[${ts()}] ${event}`;
  if (details) {
    for (const [k, v] of Object.entries(details)) {
      if (v != null && v !== '') line += `\n  ${k}: ${v}`;
    }
  }
  appendToSection(cwd, 'Completed Work', line);
}

// ============================================================
// Read Operations
// ============================================================

/**
 * Read the full ledger content.
 * @param {string} cwd
 * @returns {string|null}
 */
function read(cwd) {
  return readRaw(cwd);
}

/**
 * Read just the current state as an object.
 * @param {string} cwd
 * @returns {object}
 */
function readState(cwd) {
  const content = readRaw(cwd);
  if (!content) return { exists: false };

  const { header, sections } = parseLedger(content);
  return {
    exists: true,
    active_phase: header['Active phase'] || '-',
    active_command: header['Active command'] || '-',
    last_updated: header['Last updated'] || null,
    current_state: sections['Current State'] || '',
    decision_count: (sections['Decisions'] || '').split('\n').filter(l => l.startsWith('[')).length,
    warning_count: (sections['Warnings & Discoveries'] || '').split('\n').filter(l => l.startsWith('[')).length,
    preference_count: (sections['User Preferences'] || '').split('\n').filter(l => l.startsWith('-')).length,
    error_count: (sections['Errors & Fixes'] || '').split('\n').filter(l => l.startsWith('[')).length,
    token_estimate: estimateTokens(content),
  };
}

// ============================================================
// Compaction
// ============================================================

/**
 * Compact the ledger to stay under the token budget.
 * Strategy:
 * - Decisions, warnings, user preferences: NEVER deleted (highest value)
 * - Completed work from previous phases: one-line summaries
 * - Auto-fixed errors: summarized
 * - Current state: kept as-is
 * - Rejected approaches: kept in full
 *
 * @param {string} cwd
 * @returns {{ before_tokens: number, after_tokens: number, compacted: boolean }}
 */
function compact(cwd) {
  const content = readRaw(cwd);
  if (!content) return { before_tokens: 0, after_tokens: 0, compacted: false };

  const beforeTokens = estimateTokens(content);
  const limits = getTokenLimits(cwd);
  if (beforeTokens <= limits.soft) {
    return { before_tokens: beforeTokens, after_tokens: beforeTokens, compacted: false };
  }

  const { header, sections } = parseLedger(content);
  const compacted = compactSections(header, sections);

  const result = buildLedger(header, compacted);
  writeRaw(cwd, result);

  return {
    before_tokens: beforeTokens,
    after_tokens: estimateTokens(result),
    compacted: true,
  };
}

function compactSections(header, sections) {
  const result = { ...sections };

  // Compact completed work: summarize lines not from the active phase
  const activePhase = header['Active phase'] || '-';
  const completedLines = (result['Completed Work'] || '').split('\n').filter(Boolean);
  const kept = [];
  const summarized = [];

  for (const line of completedLines) {
    // Keep lines from active phase or recent (last 10)
    if (kept.length < 10) {
      kept.push(line);
    } else {
      // Summarize: extract just the timestamp and first 60 chars
      const trimmed = line.replace(/\n\s+.*/g, '').slice(0, 80);
      summarized.push(trimmed);
    }
  }

  if (summarized.length > 0) {
    const summary = `[Compacted ${summarized.length} older entries at ${ts()}]`;
    result['Completed Work'] = summary + '\n' + kept.join('\n');
  }

  // Compact errors: summarize auto-fixed ones
  const errorLines = (result['Errors & Fixes'] || '').split('\n');
  const keptErrors = [];
  let autoFixCount = 0;

  for (let i = 0; i < errorLines.length; i++) {
    const line = errorLines[i];
    if (line.includes('auto-fixed')) {
      autoFixCount++;
    } else if (line.trim()) {
      keptErrors.push(line);
    }
  }

  if (autoFixCount > 0) {
    keptErrors.unshift(`[${autoFixCount} auto-fixed errors compacted at ${ts()}]`);
  }
  result['Errors & Fixes'] = keptErrors.join('\n');

  // Never touch: Decisions, Warnings & Discoveries, User Preferences, Rejected Approaches

  return result;
}

// ============================================================
// Archival
// ============================================================

/**
 * Archive the current ledger (e.g., on phase completion).
 * @param {string} cwd
 * @param {string} [label] - e.g., "phase-3"
 * @returns {{ archived_to: string }|null}
 */
function archive(cwd, label) {
  const content = readRaw(cwd);
  if (!content) return null;

  const dir = archiveDir(cwd);
  ensureDir(dir);

  const tag = label || ('session-' + Date.now());
  const filename = `${tag}-ledger.md`;
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, content, 'utf-8');

  // Prune old archives
  const archives = fs.readdirSync(dir).filter(f => f.endsWith('-ledger.md')).sort().reverse();
  for (const old of archives.slice(MAX_ARCHIVE_KEEP)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
  }

  return { archived_to: dest };
}

/**
 * Archive and reset: archive current ledger, then create a fresh one.
 * Used when starting a new project or new major session.
 * @param {string} cwd
 * @param {string} [label]
 */
function archiveAndReset(cwd, label) {
  // Capture content before archiving for knowledge promotion
  const contentBeforeReset = readRaw(cwd);

  const result = archive(cwd, label);

  // Auto-promote learnings to persistent knowledge base
  if (contentBeforeReset) {
    try {
      const knowledge = require('./knowledge');
      const promoteResult = knowledge.promote(cwd, contentBeforeReset);
      if (promoteResult.promoted > 0) {
        result.knowledge_promoted = promoteResult.promoted;
        result.knowledge_skipped = promoteResult.skipped;
      }
    } catch { /* knowledge module not available or promotion failed */ }

    // Promote decisions to decisions.db
    try {
      require('./decisions').promoteFromLedger(cwd);
    } catch { /* decisions module not available */ }
  }

  // Create fresh ledger
  const header = {
    'Last updated': isoNow(),
    'Active phase': '-',
    'Active command': '-',
  };
  const sections = {};
  for (const name of SECTIONS) {
    sections[name] = '';
  }

  // Carry forward user preferences from old ledger
  if (contentBeforeReset) {
    const parsed = parseLedger(contentBeforeReset);
    if (parsed.sections['User Preferences']) {
      sections['User Preferences'] = parsed.sections['User Preferences'];
    }
  }

  save(cwd, header, sections);
  return result;
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

  if (action === 'read') {
    const content = read(cwd);
    if (content) {
      console.log(content);
    } else {
      console.log('No ledger found at ' + ledgerPath(cwd));
    }
  } else if (action === 'state') {
    console.log(JSON.stringify(readState(cwd), null, 2));
  } else if (action === 'compact') {
    const result = compact(cwd);
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'archive') {
    const label = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const result = archive(cwd, label);
    console.log(JSON.stringify(result || { message: 'No ledger to archive' }, null, 2));
  } else if (action === 'reset') {
    const label = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const result = archiveAndReset(cwd, label);
    console.log(JSON.stringify({ archived: result, message: 'Ledger reset' }, null, 2));
  } else if (action === 'test') {
    // Quick self-test
    const testCwd = cwd;
    updateState(testCwd, { active_phase: 3, active_command: 'forge-execute-phase 3', phase_name: 'Add multi-tenancy', current_wave: '1 of 3' });
    logDecision(testCwd, { decision: 'Use optional tenantId field', rationale: '47 consumers would break', rejected_alternatives: ['Required field with migration'] });
    logWarning(testCwd, { source: 'agent-001', warning: 'Webhook handler has no tenant context', severity: 'high', resolution: 'Extract from Stripe metadata' });
    logDiscovery(testCwd, { source: 'agent-002', discovery: 'getCurrentTenant() returns null for cron jobs' });
    logUserPreference(testCwd, { preference: "Don't touch src/legacy/" });
    logWaveComplete(testCwd, { wave: 1, agents: [{ id: 'schema-001', status: 'success', files_modified: ['migration.ts', 'types.ts'], learnings: ['tenantId added as optional'] }], verification: 'passed' });
    logError(testCwd, { phase: 'verification', error: 'Type error at checkout.ts:45', fix_applied: 'Added tenantId to User type', auto_fixed: true, fix_loop: 1 });
    logRejected(testCwd, { approach: 'Middleware-based tenant injection', reason: 'WebSocket incompatible', better_alternative: 'Context-based injection' });
    console.log('Test entries written. Run: node ledger.js read --root ' + testCwd);
  } else {
    console.error('Usage: node ledger.js <read|state|compact|archive|reset|test> [--root path]');
    process.exit(1);
  }
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  // State
  updateState,

  // Logging
  logDecision,
  logWarning,
  logDiscovery,
  logUserPreference,
  logWaveComplete,
  logError,
  logRejected,
  logEvent,

  // Read
  read,
  readState,

  // Maintenance
  compact,
  archive,
  archiveAndReset,

  // Paths (for external use)
  ledgerPath,
  ledgerDir,
  archiveDir,

  // Constants
  MAX_TOKENS_SOFT,
  MAX_TOKENS_HARD,
};
