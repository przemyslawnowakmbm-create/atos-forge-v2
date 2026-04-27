#!/usr/bin/env node
'use strict';

/**
 * Forge Settings — display, validate, and recommend configuration.
 *
 * Usage:
 *   node forge-config/settings.js --root . [--section <name>] [--json]
 *   Programmatic: require('./settings').showSettings(cwd, opts)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

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

const BOX_W = 68;

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

// ============================================================
// Core Functions
// ============================================================

/**
 * Show the effective config with source attribution.
 */
function showSettings(cwd, opts = {}) {
  const config = require('./config');
  const effective = config.resolveEffective(cwd);
  const defaults = config.getDefault();
  const globalCfg = config.loadGlobalConfig();
  const { config: projectCfg } = config.loadProjectConfig(cwd);

  if (opts.json) {
    return {
      effective,
      sources: effective._sources,
      validation: config.validate(effective),
    };
  }

  displaySettings(effective, defaults, globalCfg, projectCfg, opts.section);
  return effective;
}

/**
 * Detect system capabilities and recommend optimal settings.
 */
function recommend(cwd, opts = {}) {
  const config = require('./config');
  const effective = config.resolveEffective(cwd);
  const recommendations = [];

  // Docker check
  let dockerAvailable = false;
  try {
    execSync('docker version --format "{{.Server.Version}}"', { stdio: 'pipe', timeout: 5000 });
    dockerAvailable = true;
  } catch { /* not available */ }

  if (dockerAvailable && effective.execution.container_backend !== 'docker') {
    recommendations.push({
      key: 'execution.container_backend',
      current: effective.execution.container_backend,
      recommended: 'docker',
      reason: 'Docker is available; container isolation provides better security and reproducibility',
    });
  }

  if (!dockerAvailable && effective.execution.container_backend !== 'worktree') {
    recommendations.push({
      key: 'execution.container_backend',
      current: effective.execution.container_backend,
      recommended: 'worktree',
      reason: 'Docker not available; worktree mode is the only option',
    });
  }

  // Memory-based
  const totalMem = os.totalmem();
  const totalMemGB = totalMem / (1024 * 1024 * 1024);
  if (totalMemGB > 32) {
    const current = effective.containers.max_memory_per_container;
    if (current === '2g' || config.parseMemoryString(current) <= 2 * 1024 * 1024 * 1024) {
      recommendations.push({
        key: 'containers.max_memory_per_container',
        current,
        recommended: '4g',
        reason: `${totalMemGB.toFixed(0)}GB RAM detected; larger containers enable bigger tasks`,
      });
    }
  }

  // CPU-based
  const cores = os.cpus().length;
  if (cores >= 16) {
    recommendations.push({
      key: 'containers.max_concurrent',
      current: effective.containers.max_concurrent,
      recommended: Math.min(8, Math.floor(cores * 0.5)),
      reason: `${cores} cores detected; can safely run more concurrent agents`,
    });
  }

  // Graph not built
  const dbPath = path.join(cwd, '.forge', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    recommendations.push({
      key: 'graph.enabled',
      current: effective.graph.enabled,
      recommended: true,
      reason: 'Code graph not built yet; run `forge graph init` for full capabilities',
    });
  }

  // Model profile based on available resources
  if (totalMemGB >= 16 && cores >= 8 && effective.agents.active_profile === 'budget') {
    recommendations.push({
      key: 'agents.active_profile',
      current: 'budget',
      recommended: 'balanced',
      reason: 'System has sufficient resources for higher quality model profile',
    });
  }

  if (!opts.json) {
    displayRecommendations(recommendations, effective._system);
  }

  return { recommendations, system: effective._system };
}

// ============================================================
// Display
// ============================================================

function displaySettings(effective, defaults, globalCfg, projectCfg, filterSection) {
  const SECTIONS = ['project', 'graph', 'execution', 'containers', 'agents', 'verification', 'session', 'display', 'git'];

  console.log('');
  boxTop('FORGE SETTINGS');
  boxSep();

  // Source info
  const sources = effective._sources || {};
  const sourceDesc = [];
  if (sources.global) sourceDesc.push(chalk.blue('~/.forge/config.json'));
  if (sources.project) sourceDesc.push(chalk.green(effective._projectSource || '.forge/config.json'));
  if (sourceDesc.length === 0) sourceDesc.push(chalk.dim('defaults only'));
  boxLine(`  ${chalk.bold('Sources:')} ${sourceDesc.join(' \u2192 ')}`);
  boxLine('');

  for (const section of SECTIONS) {
    if (filterSection && filterSection !== section) continue;
    if (!effective[section]) continue;

    boxLine(chalk.bold.white(`  [${section}]`));
    displaySection(effective[section], defaults[section] || {}, globalCfg?.[section], projectCfg?.[section], '    ');
    boxLine('');
  }

  // System info
  if (!filterSection || filterSection === 'system') {
    const sys = effective._system;
    if (sys) {
      boxLine(chalk.bold.white('  [system] (detected)'));
      boxLine(`    cores: ${chalk.cyan(sys.total_cores)}, RAM: ${chalk.cyan(sys.total_memory_str)}, node: ${chalk.cyan(sys.node_version)}`);
      const resolved = effective.containers._resolved;
      if (resolved) {
        boxLine(`    max concurrent: ${chalk.cyan(resolved.max_concurrent)}, mem budget: ${chalk.cyan(resolved.max_total_memory_str)}`);
      }
      boxLine('');
    }
  }

  // Validation
  const { valid, errors } = require('./config').validate(effective);
  if (valid) {
    boxLine(`  ${chalk.green('\u2713')} Configuration valid`);
  } else {
    boxLine(`  ${chalk.red('\u2717')} ${errors.length} validation error(s):`);
    for (const err of errors.slice(0, 5)) {
      boxLine(`    ${chalk.red('-')} ${err}`);
    }
  }

  boxEnd();
  console.log('');
}

function displaySection(current, defaults, global, project, indent) {
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      boxLine(`${indent}${chalk.dim(key + ':')}`);
      displaySection(value, defaults?.[key] || {}, global?.[key], project?.[key], indent + '  ');
      continue;
    }

    const defaultVal = defaults?.[key];
    const isOverridden = JSON.stringify(value) !== JSON.stringify(defaultVal);
    const source = (() => {
      if (project && project[key] !== undefined) return chalk.green('P');
      if (global && global[key] !== undefined) return chalk.blue('G');
      return chalk.dim('D');
    })();

    const displayVal = Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
    const valColor = isOverridden ? chalk.yellow(displayVal) : chalk.dim(displayVal);

    boxLine(`${indent}${source} ${pad(key + ':', 28)} ${valColor}`);
  }
}

function displayRecommendations(recommendations, system) {
  console.log('');
  boxTop('FORGE RECOMMENDATIONS');
  boxSep();

  boxLine(`  ${chalk.bold('System:')} ${system.total_cores} cores, ${system.total_memory_str} RAM, ${system.platform}/${system.arch}`);
  boxLine('');

  if (recommendations.length === 0) {
    boxLine(`  ${chalk.green('\u2713')} No recommendations — configuration looks optimal`);
  } else {
    for (const rec of recommendations) {
      boxLine(`  ${chalk.yellow('\u2192')} ${chalk.bold(rec.key)}`);
      boxLine(`    current: ${chalk.dim(String(rec.current))} \u2192 recommended: ${chalk.green(String(rec.recommended))}`);
      boxLine(`    ${chalk.dim(rec.reason)}`);
      boxLine('');
    }
  }

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
    else if (arg === '--section' && argv[i + 1]) args.section = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === 'recommend') args.action = 'recommend';
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  if (args.action === 'recommend') {
    const result = recommend(cwd, { json: args.json });
    if (args.json) console.log(JSON.stringify(result, null, 2));
  } else {
    const result = showSettings(cwd, { json: args.json, section: args.section });
    if (args.json) console.log(JSON.stringify(result, null, 2));
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  showSettings,
  recommend,
};
