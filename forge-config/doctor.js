#!/usr/bin/env node
'use strict';

/**
 * Forge Doctor — comprehensive health check for the Forge environment.
 *
 * Checks: external deps, graph health, dashboard freshness, ledger status,
 * snapshot count, container readiness, system resources, config validity.
 *
 * Usage:
 *   node forge-config/doctor.js --root . [--json]
 *   Programmatic: require('./doctor').doctor(cwd, { json })
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { checkProvider } = require('../forge-agents/provider');

// ============================================================
// Chalk — graceful fallback
// ============================================================

let chalk;
try {
  chalk = require('chalk');
} catch {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'level') return 0;
      return new Proxy((...args) => args.join(''), handler);
    },
    apply(target, thisArg, args) { return args.join(''); },
  };
  chalk = new Proxy((...args) => args.join(''), handler);
}

// ============================================================
// Display Helpers
// ============================================================

const BOX_W = 60;

function pad(str, w) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  const need = Math.max(0, w - visible.length);
  return str + ' '.repeat(need);
}

function boxTop(title) {
  const inner = BOX_W - 2;
  const titleStr = ` ${title} `;
  const leftPad = Math.floor((inner - titleStr.length) / 2);
  const rightPad = inner - leftPad - titleStr.length;
  console.log(chalk.cyan('\u2554' + '\u2550'.repeat(leftPad) + chalk.bold.white(titleStr) + '\u2550'.repeat(rightPad) + '\u2557'));
}

function boxLine(text) {
  const inner = BOX_W - 2;
  console.log(chalk.cyan('\u2551') + ' ' + pad(text || '', inner - 1) + chalk.cyan('\u2551'));
}

function boxSep() {
  console.log(chalk.cyan('\u2560' + '\u2550'.repeat(BOX_W - 2) + '\u2563'));
}

function boxEnd() {
  console.log(chalk.cyan('\u255A' + '\u2550'.repeat(BOX_W - 2) + '\u255D'));
}

function boxSection(title) {
  boxLine(chalk.bold.white(title));
}

// ============================================================
// Check Functions
// ============================================================

function checkTool(name, cmd, required) {
  try {
    const version = execSync(cmd, { stdio: 'pipe', timeout: 10000, encoding: 'utf8' }).trim();
    return { name, status: 'ok', detail: version };
  } catch {
    return { name, status: required ? 'fail' : 'warn', detail: required ? 'NOT FOUND (required)' : 'not found (optional)' };
  }
}

function checkNode() {
  return { name: 'Node.js', status: 'ok', detail: process.version };
}

function checkGit() {
  try {
    const v = execSync('git --version', { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
    const match = v.match(/(\d+\.\d+\.\d+)/);
    return { name: 'Git', status: 'ok', detail: match ? match[1] : v };
  } catch {
    return { name: 'Git', status: 'fail', detail: 'NOT FOUND (required)' };
  }
}

function checkDocker() {
  try {
    const v = execSync('docker version --format "{{.Server.Version}}"', { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
    return { name: 'Docker', status: 'ok', detail: `v${v}` };
  } catch {
    return { name: 'Docker', status: 'warn', detail: 'not found (optional, worktree fallback)' };
  }
}

function checkClaude() {
  const claude = checkProvider('claude');
  return {
    name: 'Claude CLI',
    status: claude.available ? 'ok' : 'fail',
    detail: claude.available ? (claude.version || claude.path) : 'NOT FOUND',
  };
}

function checkCodex() {
  const codex = checkProvider('codex');
  return {
    name: 'Codex CLI',
    status: codex.available ? 'ok' : 'warn',
    detail: codex.available ? (codex.version || codex.path) : 'NOT FOUND (optional)',
  };
}

function checkTreeSitter(cwd) {
  const candidates = [
    path.join(cwd, 'forge-graph', 'node_modules', 'tree-sitter'),
    path.join(cwd, 'node_modules', 'tree-sitter'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { name: 'tree-sitter', status: 'ok', detail: 'available' };
  }
  return { name: 'tree-sitter', status: 'warn', detail: 'not installed (graph features limited)' };
}

function checkBetterSqlite3(cwd) {
  const candidates = [
    path.join(cwd, 'forge-graph', 'node_modules', 'better-sqlite3'),
    path.join(cwd, 'node_modules', 'better-sqlite3'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { name: 'better-sqlite3', status: 'ok', detail: 'available' };
  }
  return { name: 'better-sqlite3', status: 'warn', detail: 'not installed (graph unavailable)' };
}

function checkChalk(cwd) {
  const candidates = [
    path.join(cwd, 'forge-graph', 'node_modules', 'chalk'),
    path.join(cwd, 'node_modules', 'chalk'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { name: 'chalk', status: 'ok', detail: 'available' };
  }
  return { name: 'chalk', status: 'warn', detail: 'not installed (no color output)' };
}

function checkConfig(cwd) {
  try {
    const config = require('./config');
    const { config: effective, sources } = config.loadConfig(cwd);
    const { valid, errors } = config.validate(effective);
    const parts = [];
    if (sources.global) parts.push('global');
    if (sources.project) parts.push('project');
    if (parts.length === 0) parts.push('defaults only');
    if (!valid) return { name: 'Configuration', status: 'fail', detail: `${errors.length} error(s): ${errors[0]}` };
    return { name: 'Configuration', status: 'ok', detail: `valid (${parts.join(' + ')})` };
  } catch (e) {
    return { name: 'Configuration', status: 'fail', detail: `error: ${e.message}` };
  }
}

function checkGraph(cwd) {
  const dbPath = path.join(cwd, '.forge', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    return { name: 'Code Graph', status: 'warn', detail: 'not built (run forge graph init)' };
  }
  try {
    const { GraphQuery } = require(path.join(cwd, 'forge-graph', 'query'));
    const gq = new GraphQuery(dbPath);
    gq.open();
    const meta = gq.meta();
    const moduleCount = (() => {
      try { return gq.modules().length; } catch { return '?'; }
    })();
    try { gq.db.close(); } catch { /* ignore */ }

    const fileCount = meta.file_count || meta.total_files || '?';
    const builtAt = meta.built_at || meta.last_build_time || null;
    let freshness = '';
    let stale = false;
    if (builtAt) {
      const ageMs = Date.now() - new Date(builtAt).getTime();
      const ageH = Math.floor(ageMs / 3600000);
      freshness = ageH < 1 ? 'just now' : ageH < 24 ? `${ageH}h ago` : `${Math.floor(ageH / 24)}d ago`;
      stale = ageH >= 24;
    }
    const status = stale ? 'warn' : 'ok';
    const detail = `${fileCount} files, ${moduleCount} modules${freshness ? ` (${freshness})` : ''}`;
    const extra = stale ? 'graph is stale — run forge-init or commit to trigger auto-update' : undefined;
    return { name: 'Code Graph', status, detail, extra };
  } catch (e) {
    return { name: 'Code Graph', status: 'fail', detail: `error: ${e.message.slice(0, 60)}` };
  }
}

function checkDashboard(cwd) {
  const dashPath = path.join(cwd, '.forge', 'dashboard.html');
  if (!fs.existsSync(dashPath)) {
    return { name: 'Dashboard', status: 'warn', detail: 'not generated (run forge graph visualize)' };
  }
  try {
    const stat = fs.statSync(dashPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageH = Math.floor(ageMs / 3600000);
    const freshness = ageH < 1 ? 'fresh' : ageH < 24 ? `${ageH}h ago` : `${Math.floor(ageH / 24)}d ago`;
    const sizeKB = Math.round(stat.size / 1024);
    return { name: 'Dashboard', status: ageH > 48 ? 'warn' : 'ok', detail: `${freshness} (${sizeKB}KB)` };
  } catch {
    return { name: 'Dashboard', status: 'warn', detail: 'cannot stat' };
  }
}

function checkLedger(cwd) {
  try {
    const ledger = require(path.join(cwd, 'forge-session', 'ledger'));
    const state = ledger.readState(cwd);
    if (!state.exists) return { name: 'Session Ledger', status: 'skip', detail: 'no active session' };
    const tokens = state.token_estimate || 0;
    const tokensK = (tokens / 1000).toFixed(1);
    const phase = state.active_phase !== '-' ? state.active_phase : '';
    const status = tokens > 8000 ? 'warn' : 'ok';
    const parts = [`~${tokensK}k tokens`];
    if (phase) parts.push(phase);
    if (state.decision_count > 0) parts.push(`${state.decision_count} decisions`);
    return { name: 'Session Ledger', status, detail: parts.join(', ') };
  } catch {
    return { name: 'Session Ledger', status: 'skip', detail: 'module unavailable' };
  }
}

function checkSnapshots(cwd) {
  try {
    const { listSnapshots } = require(path.join(cwd, 'forge-graph', 'snapshot'));
    const snaps = listSnapshots(cwd);
    if (snaps.length === 0) return { name: 'Snapshots', status: 'skip', detail: 'none saved' };
    return { name: 'Snapshots', status: 'ok', detail: `${snaps.length} saved` };
  } catch {
    return { name: 'Snapshots', status: 'skip', detail: 'module unavailable' };
  }
}

function checkGitHooks(cwd) {
  const hookPath = path.join(cwd, '.git', 'hooks', 'post-commit');
  if (!fs.existsSync(hookPath)) {
    return { name: 'Git Hooks', status: 'fail', detail: 'post-commit hook not installed' };
  }
  try {
    const content = fs.readFileSync(hookPath, 'utf8');
    if (content.includes('forge-graph') || content.includes('builder') || content.includes('forge')) {
      return { name: 'Git Hooks', status: 'ok', detail: 'post-commit hook installed (forge updater)' };
    }
    return { name: 'Git Hooks', status: 'warn', detail: 'post-commit exists but no forge updater found' };
  } catch {
    return { name: 'Git Hooks', status: 'warn', detail: 'post-commit exists but unreadable' };
  }
}

function checkDockerImages() {
  // First check if Docker is available
  try {
    execSync('docker version --format "{{.Server.Version}}"', { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { name: 'Docker Images', status: 'skip', detail: 'Docker not available' };
  }
  try {
    const images = execSync('docker images --format "{{.Repository}}" 2>/dev/null', { stdio: 'pipe', timeout: 10000, encoding: 'utf8' });
    const forgeImages = images.split('\n').filter(l => l.includes('forge'));
    if (forgeImages.length === 0) {
      return { name: 'Docker Images', status: 'warn', detail: 'no forge images built (run forge container build)' };
    }
    return { name: 'Docker Images', status: 'ok', detail: `${forgeImages.length} forge image(s) built` };
  } catch {
    return { name: 'Docker Images', status: 'warn', detail: 'could not list images' };
  }
}

function checkSystem(cwd) {
  try {
    const config = require('./config');
    const effective = config.resolveEffective(cwd);
    const sys = effective._system;
    const resolved = effective.containers._resolved;
    return {
      name: 'System',
      status: 'ok',
      detail: `${sys.total_cores} cores, ${sys.total_memory_str} RAM`,
      extra: `max ${resolved.max_concurrent} concurrent agents`,
    };
  } catch (e) {
    return { name: 'System', status: 'warn', detail: `detection error: ${e.message}` };
  }
}

function checkSystemGraph(cwd) {
  // Search for system-graph.db
  const candidates = [
    path.join(cwd, '.forge', 'system-graph.db'),
    path.join(path.dirname(cwd), '.forge', 'system-graph.db'),
    path.join(path.dirname(cwd), 'system-graph.db'),
  ];
  const home = os.homedir();
  if (home) candidates.push(path.join(home, '.forge', 'system-graph.db'));

  const dbPath = candidates.find(c => fs.existsSync(c));
  if (!dbPath) {
    return { name: 'System Graph', status: 'skip', detail: 'not found (run system-init to create)' };
  }

  try {
    const stat = fs.statSync(dbPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageH = Math.floor(ageMs / 3600000);
    const freshness = ageH < 1 ? 'fresh' : ageH < 24 ? `${ageH}h ago` : `${Math.floor(ageH / 24)}d ago`;
    const sizeKB = Math.round(stat.size / 1024);
    const stale = ageH >= 24;

    // Try to query for stats
    let detail = `${sizeKB}KB, built ${freshness}`;
    let extra;
    try {
      const systemQueryPath = path.join(cwd, 'forge-system', 'query');
      const { SystemQuery } = require(systemQueryPath);
      const sq = new SystemQuery(dbPath);
      sq.open();
      const overview = sq.overview();
      const cycles = sq.cycles();
      sq.close();
      detail = `${overview.services} services, ${overview.interfaces} interfaces, ${overview.dependencies} deps (${freshness})`;
      if (cycles.count > 0) {
        extra = `${cycles.count} cycle(s) detected — review with system impact`;
      }
    } catch { /* query failed, use basic info */ }

    const status = stale ? 'warn' : 'ok';
    return { name: 'System Graph', status, detail, extra: extra || (stale ? 'graph is stale — run system-init or system-sync' : undefined) };
  } catch (e) {
    return { name: 'System Graph', status: 'fail', detail: `error: ${e.message.slice(0, 60)}` };
  }
}

function checkInterfaces(cwd) {
  const interfacesPath = path.join(cwd, '.forge', 'interfaces.yaml');
  if (!fs.existsSync(interfacesPath)) {
    return { name: 'Interfaces', status: 'skip', detail: 'no interfaces.yaml (run forge-init)' };
  }

  try {
    const stat = fs.statSync(interfacesPath);
    const sizeKB = (stat.size / 1024).toFixed(1);

    // Try validation
    let validationDetail = '';
    try {
      const validatePath = path.join(cwd, 'forge-system', 'validate');
      const validate = require(validatePath);
      const result = validate.validateFile(interfacesPath);
      if (result.valid) {
        validationDetail = ', valid';
      } else {
        return {
          name: 'Interfaces',
          status: 'warn',
          detail: `${sizeKB}KB, ${result.errors.length} error(s)`,
          extra: result.errors[0]?.message,
        };
      }
    } catch { /* validate module not available */ }

    return { name: 'Interfaces', status: 'ok', detail: `${sizeKB}KB${validationDetail}` };
  } catch (e) {
    return { name: 'Interfaces', status: 'warn', detail: `error: ${e.message.slice(0, 60)}` };
  }
}

// ============================================================
// Main Doctor
// ============================================================

function doctor(cwd, opts = {}) {
  const root = cwd || process.cwd();
  const checks = [];

  // Section 1: Dependencies (indices 0-6)
  checks.push(checkNode());
  checks.push(checkGit());
  checks.push(checkDocker());
  checks.push(checkClaude());
  checks.push(checkCodex());
  checks.push(checkTreeSitter(root));
  checks.push(checkBetterSqlite3(root));
  checks.push(checkChalk(root));

  // Section 2: Project Health (indices 7-15)
  checks.push(checkConfig(root));
  checks.push(checkGraph(root));
  checks.push(checkDashboard(root));
  checks.push(checkLedger(root));
  checks.push(checkSnapshots(root));
  checks.push(checkGitHooks(root));
  checks.push(checkDockerImages());
  checks.push(checkSystemGraph(root));
  checks.push(checkInterfaces(root));

  // Crash lock check
  try {
    const crashRecovery = require('../forge-session/crash-recovery');
    const lock = crashRecovery.readCrashLock(root);
    if (lock && !lock.processAlive) {
      checks.push({ name: 'Crash Lock', status: 'warn', message: `Stale lock from ${lock.startedAt} — run /forge-resume-work` });
    } else {
      checks.push({ name: 'Crash Lock', status: 'ok', message: lock ? 'Active session' : 'No crash detected' });
    }
  } catch { checks.push({ name: 'Crash Lock', status: 'skip', message: 'Module not available' }); }

  // Section 3: System (last index)
  checks.push(checkSystem(root));

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;

  if (!opts.json) {
    displayDoctor(checks, summary);
  }

  return { checks, summary };
}

// ============================================================
// Display
// ============================================================

function displayDoctor(checks, summary) {
  const ICON = {
    ok:   chalk.green('\u2705'),
    warn: chalk.yellow('\u26A0\uFE0F '),
    fail: chalk.red('\u274C'),
    skip: chalk.dim('\u23ED\uFE0F '),
  };

  console.log('');
  boxTop('FORGE HEALTH CHECK');
  boxSep();

  // Dependencies (indices 0-6)
  boxSection('  Dependencies');
  for (let i = 0; i < 7; i++) {
    const c = checks[i];
    boxLine(`  ${ICON[c.status]}  ${pad(c.name, 18)} ${chalk.dim(c.detail)}`);
  }
  boxLine('');

  // Project Health (indices 7 through second-to-last)
  boxSection('  Project Health');
  for (let i = 7; i < checks.length - 1; i++) {
    const c = checks[i];
    boxLine(`  ${ICON[c.status]}  ${pad(c.name, 18)} ${chalk.dim(c.detail)}`);
    if (c.extra) {
      boxLine(`${' '.repeat(26)}\u2192 ${chalk.dim(c.extra)}`);
    }
  }
  boxLine('');

  // System (last index)
  boxSection('  System');
  const sys = checks[checks.length - 1];
  boxLine(`  ${ICON[sys.status]}  ${pad(sys.name, 18)} ${chalk.dim(sys.detail)}`);
  if (sys.extra) {
    boxLine(`${' '.repeat(26)}\u2192 ${chalk.dim(sys.extra)}`);
  }
  boxLine('');

  // Summary
  const total = checks.length;
  const parts = [];
  if (summary.ok > 0) parts.push(chalk.green(`${summary.ok} passed`));
  if (summary.warn > 0) parts.push(chalk.yellow(`${summary.warn} warnings`));
  if (summary.fail > 0) parts.push(chalk.red(`${summary.fail} failed`));
  if (summary.skip > 0) parts.push(chalk.dim(`${summary.skip} skipped`));
  boxLine(`  ${parts.join(', ')}  (${total} checks)`);
  boxEnd();
  console.log('');
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) args.cwd = path.resolve(argv[++i]);
    else if (arg === '--json') args.json = true;
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = doctor(args.cwd || process.cwd(), { json: args.json });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.summary.fail > 0 ? 1 : 0);
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  doctor,
  checkNode,
  checkGit,
  checkDocker,
  checkClaude,
  checkTreeSitter,
  checkBetterSqlite3,
  checkChalk,
  checkConfig,
  checkGraph,
  checkDashboard,
  checkLedger,
  checkSnapshots,
  checkGitHooks,
  checkDockerImages,
  checkSystemGraph,
  checkInterfaces,
  checkSystem,
};
