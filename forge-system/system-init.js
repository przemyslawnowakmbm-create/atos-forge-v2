#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');
const os = require('os');

// ============================================================
// System Init — Multi-Repo Batch Orchestrator
// ============================================================
// One command to bootstrap an entire multi-repo system:
//   1. Discover repos (GitHub org / repos.json / filesystem)
//   2. Run full forge-init per repo in parallel
//   3. Build system-graph.db from all interfaces.yaml
//   4. Validate cross-repo contracts
//   5. Generate summary

// ============================================================
// Main API
// ============================================================

/**
 * Run system-wide initialization.
 * @param {object} opts
 * @param {string} opts.source - 'registry' | 'path' | 'github-org'
 * @param {string} opts.value - Path to repos.json, directory path, or GitHub org name
 * @param {string} opts.output - Path for system-graph.db
 * @param {string} opts.workspace - Directory for cloned repos (github-org mode)
 * @param {number} opts.workers - Number of parallel workers
 * @param {string} opts.delivery - 'local' | 'pr' | 'commit' | 'dry-run'
 * @param {string} opts.branch - Branch name for commit delivery mode
 * @param {boolean} opts.force - Force re-init even if .forge exists
 * @returns {Promise<object>} Results summary
 */
async function systemInit(opts) {
  const startTime = Date.now();

  // Load config defaults from forge-config if available
  let systemConfig = {};
  try {
    const configMod = require(path.join(__dirname, '..', 'forge-config', 'config'));
    systemConfig = configMod.getSystem(process.cwd());
  } catch { /* forge-config not available — use inline defaults */ }

  const workers = opts.workers || systemConfig._resolved_workers || Math.max(1, Math.min(16, os.cpus().length - 2));
  const delivery = opts.delivery || systemConfig.default_delivery || 'local';
  const output = opts.output || systemConfig.graph_path || path.join(process.cwd(), '.forge', 'system-graph.db');

  // Phase A: Discover repos
  logPhase('A', 'Repo Discovery');
  let repos;
  try {
    repos = await discoverRepos(opts);
  } catch (e) {
    return { success: false, phase: 'discovery', error: e.message };
  }
  // Apply ignore_repos filter
  const ignoreRepos = systemConfig.ignore_repos || [];
  if (ignoreRepos.length > 0) {
    const ignoreSet = new Set(ignoreRepos);
    repos = repos.filter(r => !ignoreSet.has(r.name));
  }

  logInfo(`Found ${repos.length} repos`);

  if (repos.length === 0) {
    return { success: false, phase: 'discovery', error: 'No repos found' };
  }

  if (delivery === 'dry-run') {
    return dryRun(repos, output);
  }

  // Phase B: Parallel full init
  logPhase('B', `Parallel Init (${workers} workers)`);
  const initResults = await parallelInit(repos, workers, opts);

  const succeeded = initResults.filter(r => r.success);
  const failed = initResults.filter(r => !r.success);
  logInfo(`Initialized: ${succeeded.length}/${repos.length} (${failed.length} failed)`);

  // Phase C: Build system graph
  logPhase('C', 'System Graph Assembly');
  const successRepos = succeeded.map(r => ({ name: r.name, path: r.path }));
  let buildResult;
  try {
    const builder = require('./builder');
    buildResult = builder.build(successRepos, output);
  } catch (e) {
    return {
      success: false,
      phase: 'build',
      error: e.message,
      init_results: summarizeInitResults(initResults),
    };
  }

  // Phase C.2: Validate
  let validationResult = null;
  try {
    const validator = require('./validate');
    validationResult = validator.validateSystem(output);
  } catch { /* non-fatal */ }

  // Phase D: Summary
  logPhase('D', 'Complete');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result = {
    success: true,
    elapsed: `${elapsed}s`,
    repos_found: repos.length,
    repos_initialized: succeeded.length,
    repos_failed: failed.length,
    services: buildResult.services,
    interfaces: buildResult.interfaces,
    dependencies: buildResult.dependencies,
    build_warnings: buildResult.warnings,
    validation: validationResult,
    output: buildResult.output,
    failures: failed.map(f => ({ name: f.name, error: f.error })),
    delivery,
    workers,
  };

  return result;
}

// ============================================================
// Phase A: Repo Discovery
// ============================================================

async function discoverRepos(opts) {
  switch (opts.source) {
    case 'registry':
      return discoverFromRegistry(opts.value);
    case 'path':
      return discoverFromPath(opts.value);
    case 'github-org':
      return discoverFromGitHub(opts.value, opts.workspace);
    default:
      throw new Error(`Unknown source: ${opts.source}. Use 'registry', 'path', or 'github-org'.`);
  }
}

function discoverFromRegistry(registryPath) {
  const absPath = path.resolve(registryPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Registry file not found: ${absPath}`);
  }
  const registry = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const repos = registry.repos || registry;
  if (!Array.isArray(repos)) {
    throw new Error('Invalid registry: expected "repos" array');
  }
  return repos.map(r => ({
    name: r.name || path.basename(r.path),
    path: path.resolve(r.path),
  }));
}

function discoverFromPath(dirPath) {
  const absPath = path.resolve(dirPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Path not found: ${absPath}`);
  }

  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) {
    // Single repo
    return [{ name: path.basename(absPath), path: absPath }];
  }

  // Scan subdirectories for git repos (up to 2 levels deep)
  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const repos = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const repoDir = path.join(absPath, entry.name);

    if (isRepoDir(repoDir)) {
      repos.push({ name: entry.name, path: repoDir });
    } else {
      // Not a repo — check one level deeper (handles org-style grouping dirs like "L1 Support/l1-service-desk-automation")
      try {
        const subEntries = fs.readdirSync(repoDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          if (sub.name.startsWith('.')) continue;
          const subDir = path.join(repoDir, sub.name);
          if (isRepoDir(subDir)) {
            repos.push({ name: sub.name, path: subDir });
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }

  return repos;
}

function isRepoDir(dir) {
  return (
    fs.existsSync(path.join(dir, '.git')) ||
    fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, 'pyproject.toml')) ||
    fs.existsSync(path.join(dir, 'setup.py'))
  );
}

async function discoverFromGitHub(orgName, workspace) {
  if (!workspace) {
    workspace = path.join(os.tmpdir(), `forge-system-${orgName}`);
  }
  const absWorkspace = path.resolve(workspace);
  if (!fs.existsSync(absWorkspace)) {
    fs.mkdirSync(absWorkspace, { recursive: true });
  }

  // Use gh CLI to list repos
  let repoList;
  try {
    const ghOutput = execSync(
      `gh repo list ${orgName} --json name,sshUrl --limit 1000`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    repoList = JSON.parse(ghOutput);
  } catch (e) {
    throw new Error(`GitHub discovery failed. Ensure 'gh' CLI is installed and authenticated.\n${e.message}`);
  }

  logInfo(`GitHub org "${orgName}": ${repoList.length} repos`);

  // Clone repos that aren't already local
  const repos = [];
  for (const repo of repoList) {
    const repoDir = path.join(absWorkspace, repo.name);
    if (fs.existsSync(repoDir)) {
      // Already cloned — pull latest
      try {
        execSync('git pull --ff-only', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
      } catch { /* non-fatal */ }
    } else {
      // Shallow clone
      try {
        execSync(`git clone --depth 1 "${repo.sshUrl}" "${repoDir}"`, {
          encoding: 'utf-8', stdio: 'pipe', timeout: 120000,
        });
      } catch (e) {
        logWarn(`Failed to clone ${repo.name}: ${e.message}`);
        continue;
      }
    }
    repos.push({ name: repo.name, path: repoDir });
  }

  return repos;
}

// ============================================================
// Phase B: Parallel Init
// ============================================================

async function parallelInit(repos, maxWorkers, opts) {
  const results = [];
  let active = 0;
  let index = 0;
  const total = repos.length;

  return new Promise((resolve) => {
    function startNext() {
      while (active < maxWorkers && index < total) {
        const repo = repos[index++];
        active++;
        const repoNum = index;

        initOneRepo(repo, opts)
          .then(result => {
            results.push(result);
            const icon = result.success ? '✓' : '✗';
            logProgress(icon, repoNum, total, repo.name, result.success ? null : result.error);
            active--;
            startNext();
          });
      }

      if (active === 0 && index >= total) {
        resolve(results);
      }
    }

    startNext();
  });
}

async function initOneRepo(repo, opts) {
  const repoPath = repo.path;
  const result = { name: repo.name, path: repoPath, success: false };

  if (!fs.existsSync(repoPath)) {
    result.error = 'Path not found';
    return result;
  }

  // Skip if already initialized and not forced
  if (!opts.force && fs.existsSync(path.join(repoPath, '.forge', 'graph.db'))) {
    // Still run detection in case it's new
    try {
      const detect = require('./detect');
      const detection = detect.detectInterfaces(repoPath);
      if (detection.exports.length > 0 || detection.imports.length > 0) {
        const yaml = detect.generateYAML(detection);
        detect.writeInterfacesYAML(repoPath, yaml);
      }
      result.success = true;
      result.skipped_graph = true;
      result.interfaces = detection.exports.length + detection.imports.length;
      return result;
    } catch (e) {
      result.error = `Detection failed: ${e.message}`;
      return result;
    }
  }

  // Run full forge-init via forge-tools.cjs
  const forgeToolsPath = resolveForgeTools();

  try {
    const initOutput = execSync(
      `node "${forgeToolsPath}" graph init --root "${repoPath}" --raw`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300000, // 5 min per repo
        cwd: repoPath,
      }
    );

    const initResult = JSON.parse(initOutput);
    result.success = initResult.success;
    result.files = initResult.total_files;
    result.symbols = initResult.total_symbols;
    result.interfaces = initResult.interfaces_detected || 0;
    result.build_time = initResult.build_time;
  } catch (e) {
    // forge-init failed — try lightweight detection only
    try {
      const detect = require('./detect');
      const detection = detect.detectInterfaces(repoPath);
      if (detection.exports.length > 0 || detection.imports.length > 0) {
        const yaml = detect.generateYAML(detection);
        detect.writeInterfacesYAML(repoPath, yaml);
      }
      result.success = true;
      result.graph_failed = true;
      result.interfaces = detection.exports.length + detection.imports.length;
      result.error_note = `Graph build failed (${e.message.slice(0, 100)}), but interface detection succeeded`;
    } catch (e2) {
      result.error = `Init failed: ${e.message.slice(0, 200)}`;
    }
  }

  return result;
}

// ============================================================
// Dry Run
// ============================================================

function dryRun(repos, output) {
  let chalk;
  try { chalk = require('chalk'); } catch {
    chalk = { bold: s => s, dim: s => s, cyan: s => s, green: s => s, yellow: s => s };
  }

  console.log('');
  console.log(chalk.bold('  System Init — Dry Run'));
  console.log(chalk.dim('  ──────────────────────────────'));
  console.log(`  Repos found: ${chalk.cyan(repos.length)}`);
  console.log(`  Output:      ${chalk.dim(output)}`);
  console.log('');

  const hasForge = [];
  const noForge = [];

  for (const repo of repos) {
    const hasGraph = fs.existsSync(path.join(repo.path, '.forge', 'graph.db'));
    const hasInterfaces = fs.existsSync(path.join(repo.path, '.forge', 'interfaces.yaml'));

    if (hasGraph || hasInterfaces) {
      hasForge.push({ ...repo, hasGraph, hasInterfaces });
    } else {
      noForge.push(repo);
    }
  }

  if (hasForge.length > 0) {
    console.log(chalk.bold(`  Already initialized (${hasForge.length}):`));
    for (const r of hasForge) {
      const graph = r.hasGraph ? chalk.green('graph') : chalk.dim('no graph');
      const ifaces = r.hasInterfaces ? chalk.green('interfaces') : chalk.dim('no interfaces');
      console.log(`    ${chalk.dim('●')} ${r.name} [${graph}, ${ifaces}]`);
    }
    console.log('');
  }

  if (noForge.length > 0) {
    console.log(chalk.bold(`  Will initialize (${noForge.length}):`));
    for (const r of noForge) {
      console.log(`    ${chalk.yellow('○')} ${r.name}`);
    }
    console.log('');
  }

  console.log(chalk.dim('  Run without --dry-run to execute.'));
  console.log('');

  return {
    success: true,
    dry_run: true,
    repos_found: repos.length,
    already_initialized: hasForge.length,
    will_initialize: noForge.length,
    repos: repos.map(r => ({
      name: r.name,
      path: r.path,
      has_graph: fs.existsSync(path.join(r.path, '.forge', 'graph.db')),
      has_interfaces: fs.existsSync(path.join(r.path, '.forge', 'interfaces.yaml')),
    })),
  };
}

// ============================================================
// Helpers
// ============================================================

function resolveForgeTools() {
  // Find forge-tools.cjs relative to this module
  const candidates = [
    path.join(__dirname, '..', 'atos-forge', 'bin', 'forge-tools.cjs'),
    path.join(__dirname, '..', 'bin', 'forge-tools.cjs'),
  ];

  // Also try FORGE_HOME
  if (process.env.FORGE_HOME) {
    candidates.unshift(path.join(process.env.FORGE_HOME, 'atos-forge', 'bin', 'forge-tools.cjs'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: try to find via require resolution
  throw new Error('Cannot find forge-tools.cjs. Set FORGE_HOME or ensure atos-forge/ is a sibling of forge-system/.');
}

function summarizeInitResults(results) {
  return {
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    graph_builds: results.filter(r => r.success && !r.skipped_graph && !r.graph_failed).length,
    detection_only: results.filter(r => r.success && (r.skipped_graph || r.graph_failed)).length,
  };
}

// ============================================================
// Logging
// ============================================================

let _chalk;
function c() {
  if (_chalk) return _chalk;
  try { _chalk = require('chalk'); } catch {
    const id = s => s;
    _chalk = { bold: id, dim: id, cyan: id, green: id, yellow: id, red: id, magenta: id };
  }
  return _chalk;
}

function logPhase(letter, name) {
  console.log('');
  console.log(c().bold(`  Phase ${letter}: ${name}`));
  console.log(c().dim('  ──────────────────────────────'));
}

function logInfo(msg) {
  console.log(`  ${c().cyan('ℹ')} ${msg}`);
}

function logWarn(msg) {
  console.log(`  ${c().yellow('⚠')} ${msg}`);
}

function logProgress(icon, current, total, name, error) {
  const pct = Math.round((current / total) * 100);
  const status = error ? c().red(icon) : c().green(icon);
  const suffix = error ? c().dim(` — ${error.slice(0, 80)}`) : '';
  console.log(`  ${status} [${String(current).padStart(3)}/${total}] ${pct}% ${name}${suffix}`);
}

// ============================================================
// CLI Entry Point
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  // Parse arguments
  const githubOrgIdx = args.indexOf('--github-org');
  const reposIdx = args.indexOf('--repos');
  const pathIdx = args.indexOf('--path');
  const outputIdx = args.indexOf('--output');
  const workspaceIdx = args.indexOf('--workspace');
  const workersIdx = args.indexOf('--workers');
  const branchIdx = args.indexOf('--branch');
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const pr = args.includes('--pr');
  const commit = args.includes('--commit');

  let source, value;
  if (githubOrgIdx !== -1) {
    source = 'github-org';
    value = args[githubOrgIdx + 1];
  } else if (reposIdx !== -1) {
    source = 'registry';
    value = args[reposIdx + 1];
  } else if (pathIdx !== -1) {
    source = 'path';
    value = args[pathIdx + 1];
  } else {
    // No source specified — show help
    const ck = c();
    console.log('');
    console.log(ck.bold('  forge-system/system-init.js — Multi-Repo Batch Orchestrator'));
    console.log('');
    console.log('  Usage:');
    console.log('    node system-init.js --github-org <org> [--workspace <dir>]');
    console.log('    node system-init.js --repos <repos.json>');
    console.log('    node system-init.js --path <directory>');
    console.log('');
    console.log('  Options:');
    console.log('    --output <path>       Path for system-graph.db (default: .forge/system-graph.db)');
    console.log('    --workspace <dir>     Directory for cloned repos (github-org mode)');
    console.log('    --workers <N>         Parallel worker count (default: auto-detect)');
    console.log('    --force               Re-init repos that already have .forge/');
    console.log('    --dry-run             Preview only, no writes');
    console.log('    --json                JSON output');
    console.log('');
    console.log('  Examples:');
    console.log('    node system-init.js --path /code/microservices');
    console.log('    node system-init.js --repos repos.json --output system-graph.db');
    console.log('    node system-init.js --github-org myorg --workspace /code --workers 8');
    console.log('    node system-init.js --path /code --dry-run');
    console.log('');
    process.exit(0);
  }

  let delivery = 'local';
  if (dryRun) delivery = 'dry-run';
  else if (pr) delivery = 'pr';
  else if (commit) delivery = 'commit';

  const opts = {
    source,
    value,
    output: outputIdx !== -1 ? args[outputIdx + 1] : undefined,
    workspace: workspaceIdx !== -1 ? args[workspaceIdx + 1] : undefined,
    workers: workersIdx !== -1 ? parseInt(args[workersIdx + 1], 10) : undefined,
    delivery,
    branch: branchIdx !== -1 ? args[branchIdx + 1] : 'forge-init',
    force,
  };

  const result = await systemInit(opts);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.dry_run) {
    printSummary(result);
  }

  process.exit(result.success ? 0 : 1);
}

function printSummary(result) {
  const ck = c();
  console.log('');
  console.log(ck.bold('  System Init — Summary'));
  console.log(ck.dim('  ──────────────────────────────'));
  console.log(`  Time:         ${ck.cyan(result.elapsed)}`);
  console.log(`  Repos:        ${result.repos_initialized}/${result.repos_found} initialized`);
  console.log(`  Services:     ${ck.cyan(result.services)}`);
  console.log(`  Interfaces:   ${ck.cyan(result.interfaces)}`);
  console.log(`  Dependencies: ${ck.cyan(result.dependencies)}`);
  console.log(`  Output:       ${ck.dim(result.output)}`);

  if (result.repos_failed > 0) {
    console.log('');
    console.log(ck.yellow(`  Failures (${result.repos_failed}):`));
    for (const f of result.failures) {
      console.log(`    ${ck.red('✗')} ${f.name}: ${f.error}`);
    }
  }

  if (result.build_warnings && result.build_warnings.length > 0) {
    console.log('');
    console.log(ck.yellow(`  Build Warnings (${result.build_warnings.length}):`));
    for (const w of result.build_warnings.slice(0, 10)) {
      console.log(`    ${ck.yellow('⚠')} ${w}`);
    }
    if (result.build_warnings.length > 10) {
      console.log(ck.dim(`    ... and ${result.build_warnings.length - 10} more`));
    }
  }

  if (result.validation) {
    const v = result.validation;
    if (v.valid) {
      console.log(`  Validation:   ${ck.green('✓ Passed')}`);
    } else {
      console.log(`  Validation:   ${ck.red(`✗ ${v.errors.length} error(s)`)}, ${ck.yellow(`${v.warnings.length} warning(s)`)}`);
    }
  }

  console.log('');
  if (result.success) {
    console.log(`  ${ck.green('✓')} System initialized successfully`);
  } else {
    console.log(`  ${ck.red('✗')} System initialization completed with errors`);
  }
  console.log('');
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  systemInit,
  discoverRepos,
  discoverFromRegistry,
  discoverFromPath,
  discoverFromGitHub,
  parallelInit,
  initOneRepo,
  dryRun,
  resolveForgeTools,
};

// ============================================================
// Run CLI
// ============================================================

if (require.main === module) {
  main().catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
