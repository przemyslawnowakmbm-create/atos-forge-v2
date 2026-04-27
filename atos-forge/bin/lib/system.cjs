/**
 * System graph commands — extracted from forge-tools.cjs
 *
 * runSystemModule, cmdSystemInit, cmdSystemRebuild, cmdSystemSync,
 * cmdSystemStatus, cmdSystemImpact, cmdSystemValidate, cmdSystemDashboard,
 * resolveSystemDbPath
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { output, error, getForgeRoot, getForgeSystemDir, graphDbPath } = require('./core.cjs');

/**
 * Run a forge-system module via child process, streaming output.
 */
function runSystemModule(cwd, moduleName, cliArgs, raw) {
  const systemDir = getForgeSystemDir();
  const modulePath = path.join(systemDir, moduleName);
  if (!fs.existsSync(modulePath)) {
    error(`Module not found: ${modulePath}`);
  }
  const jsonFlag = raw ? ' --json' : '';
  const cmd = `node "${modulePath}" ${cliArgs.join(' ')}${jsonFlag}`;
  try {
    const result = execSync(cmd, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min for system-init
      maxBuffer: 10 * 1024 * 1024,
    });
    if (raw) {
      try { output(JSON.parse(result), raw); }
      catch { process.stdout.write(result); }
    } else {
      process.stdout.write(result);
    }
  } catch (e) {
    const stderr = e.stderr ? e.stderr.trim() : '';
    const stdout = e.stdout ? e.stdout.trim() : '';
    if (stdout) process.stdout.write(stdout + '\n');
    if (stderr) process.stderr.write(stderr + '\n');
    if (!stdout && !stderr) error(`system command failed: ${e.message}`);
  }
}

function cmdSystemInit(cwd, args, raw) {
  const cliArgs = [];
  // Pass through known flags
  const pathIdx = args.indexOf('--path');
  if (pathIdx !== -1 && args[pathIdx + 1]) cliArgs.push('--path', args[pathIdx + 1]);
  const reposIdx = args.indexOf('--repos');
  if (reposIdx !== -1 && args[reposIdx + 1]) cliArgs.push('--repos', args[reposIdx + 1]);
  const orgIdx = args.indexOf('--github-org');
  if (orgIdx !== -1 && args[orgIdx + 1]) cliArgs.push('--github-org', args[orgIdx + 1]);
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) cliArgs.push('--output', args[outputIdx + 1]);
  const workersIdx = args.indexOf('--workers');
  if (workersIdx !== -1 && args[workersIdx + 1]) cliArgs.push('--workers', args[workersIdx + 1]);
  if (args.includes('--force')) cliArgs.push('--force');
  if (args.includes('--dry-run')) cliArgs.push('--dry-run');
  if (args.includes('--workspace')) cliArgs.push('--workspace');

  // Default: use cwd parent as discovery path if no source specified
  if (!cliArgs.some(a => a === '--path' || a === '--repos' || a === '--github-org')) {
    cliArgs.push('--path', path.dirname(cwd));
  }

  runSystemModule(cwd, 'system-init.js', cliArgs, raw);
}

function cmdSystemRebuild(cwd, args, raw) {
  // Rebuild = force re-init
  cmdSystemInit(cwd, [...args, '--force'], raw);
}

function cmdSystemSync(cwd, args, raw) {
  const cliArgs = [];
  // Resolve system DB
  const dbIdx = args.indexOf('--db');
  if (dbIdx !== -1 && args[dbIdx + 1]) {
    cliArgs.push('--db', args[dbIdx + 1]);
  } else {
    // Auto-resolve system DB
    const candidates = [
      path.join(cwd, '.forge', 'system-graph.db'),
      path.join(path.dirname(cwd), '.forge', 'system-graph.db'),
      path.join(path.dirname(cwd), 'system-graph.db'),
    ];
    const home = process.env.HOME || '';
    if (home) candidates.push(path.join(home, '.forge', 'system-graph.db'));
    const found = candidates.find(c => fs.existsSync(c));
    if (found) cliArgs.push('--db', found);
    else error('System graph not found. Run system-init first, or specify --db <path>.');
  }
  const repoIdx = args.indexOf('--repo');
  if (repoIdx !== -1 && args[repoIdx + 1]) cliArgs.push('--repo', args[repoIdx + 1]);
  else cliArgs.push('--repo', cwd);

  runSystemModule(cwd, 'sync.js', cliArgs, raw);
}

function cmdSystemStatus(cwd, args, raw) {
  // Resolve system DB
  const dbPath = resolveSystemDbPath(cwd, args);
  if (!dbPath) {
    if (raw) {
      output({ found: false, message: 'No system graph found. Run system-init first.' }, raw);
    } else {
      console.log('No system graph found. Run `forge-tools system init` first.');
    }
    return;
  }

  const systemDir = getForgeSystemDir();
  try {
    const SQ = require(path.join(systemDir, 'query')).SystemQuery;
    const sq = new SQ(dbPath);
    sq.open();
    const overview = sq.overview();
    const cycles = sq.cycles();
    sq.close();

    // Add file info
    const stat = fs.statSync(dbPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageH = Math.floor(ageMs / 3600000);
    const freshness = ageH < 1 ? 'just now' : ageH < 24 ? `${ageH}h ago` : `${Math.floor(ageH / 24)}d ago`;
    const sizeKB = Math.round(stat.size / 1024);

    const result = {
      found: true,
      db_path: dbPath,
      size_kb: sizeKB,
      freshness,
      stale: ageH >= 24,
      ...overview,
      cycles: cycles.count,
    };

    if (raw) {
      output(result, raw);
    } else {
      console.log('');
      console.log('  System Graph Status');
      console.log('  ──────────────────────────────');
      console.log(`  DB:           ${dbPath}`);
      console.log(`  Size:         ${sizeKB} KB`);
      console.log(`  Built:        ${freshness}${result.stale ? ' (STALE)' : ''}`);
      console.log(`  Services:     ${result.services}`);
      console.log(`  Interfaces:   ${result.interfaces}`);
      console.log(`  Dependencies: ${result.dependencies}`);
      console.log(`  Teams:        ${result.teams}`);
      console.log(`  Cycles:       ${result.cycles === 0 ? '0 (clean)' : `${result.cycles} (WARNING)`}`);
      if (result.interface_types && result.interface_types.length > 0) {
        console.log('');
        console.log('  Interface Types:');
        for (const t of result.interface_types) {
          console.log(`    ${t.type.padEnd(12)} ${t.count}`);
        }
      }
      if (result.risk_distribution && result.risk_distribution.length > 0) {
        console.log('');
        console.log('  Risk Distribution:');
        for (const r of result.risk_distribution) {
          console.log(`    ${r.risk_level.padEnd(12)} ${r.count}`);
        }
      }
      console.log('');
    }
  } catch (e) {
    error(`Failed to read system graph: ${e.message}`);
  }
}

function cmdSystemImpact(cwd, args, raw) {
  const service = args.find(a => !a.startsWith('--'));
  if (!service) {
    error('Usage: system impact <service-id> [--depth N] [--interface name] [--db path]');
  }
  const cliArgs = ['impact', service];
  const depthIdx = args.indexOf('--depth');
  if (depthIdx !== -1 && args[depthIdx + 1]) cliArgs.push('--depth', args[depthIdx + 1]);
  const ifaceIdx = args.indexOf('--interface');
  if (ifaceIdx !== -1 && args[ifaceIdx + 1]) cliArgs.push('--interface', args[ifaceIdx + 1]);

  const dbPath = resolveSystemDbPath(cwd, args);
  if (dbPath) cliArgs.push('--db', dbPath);

  runSystemModule(cwd, 'query.js', cliArgs, raw);
}

function cmdSystemValidate(cwd, args, raw) {
  // Validate interfaces.yaml in cwd
  const interfacesPath = path.join(cwd, '.forge', 'interfaces.yaml');
  if (!fs.existsSync(interfacesPath)) {
    if (raw) {
      output({ valid: false, error: 'No interfaces.yaml found' }, raw);
    } else {
      console.log('No .forge/interfaces.yaml found. Run forge-init first.');
    }
    return;
  }
  const cliArgs = [interfacesPath];
  if (args.includes('--strict')) cliArgs.push('--strict');

  // If system DB exists, also run cross-repo validation
  const dbPath = resolveSystemDbPath(cwd, args);
  if (dbPath) cliArgs.push('--db', dbPath);

  runSystemModule(cwd, 'validate.js', cliArgs, raw);
}

function cmdSystemDashboard(cwd, args, raw) {
  const dbPath = resolveSystemDbPath(cwd, args);
  if (!dbPath) {
    error('No system graph found. Run system-init first, or specify --db <path>.');
  }
  const cliArgs = ['--db', dbPath];
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) cliArgs.push('--output', args[outputIdx + 1]);
  if (args.includes('--no-open')) cliArgs.push('--no-open');

  runSystemModule(cwd, 'dashboard.js', cliArgs, raw);
}

/**
 * Resolve system-graph.db path from args or common locations.
 */
function resolveSystemDbPath(cwd, args) {
  const dbIdx = (args || []).indexOf('--db');
  if (dbIdx !== -1 && args[dbIdx + 1] && fs.existsSync(args[dbIdx + 1])) {
    return args[dbIdx + 1];
  }
  const candidates = [
    path.join(cwd, '.forge', 'system-graph.db'),
    path.join(path.dirname(cwd), '.forge', 'system-graph.db'),
    path.join(path.dirname(cwd), 'system-graph.db'),
  ];
  const home = process.env.HOME || '';
  if (home) candidates.push(path.join(home, '.forge', 'system-graph.db'));
  if (process.env.FORGE_SYSTEM_GRAPH_PATH && fs.existsSync(process.env.FORGE_SYSTEM_GRAPH_PATH)) {
    return process.env.FORGE_SYSTEM_GRAPH_PATH;
  }
  return candidates.find(c => fs.existsSync(c)) || null;
}

module.exports = {
  runSystemModule,
  cmdSystemInit,
  cmdSystemRebuild,
  cmdSystemSync,
  cmdSystemStatus,
  cmdSystemImpact,
  cmdSystemValidate,
  cmdSystemDashboard,
  resolveSystemDbPath,
};
