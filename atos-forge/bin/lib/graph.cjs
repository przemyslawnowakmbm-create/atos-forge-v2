/**
 * Graph commands — extracted from forge-tools.cjs
 *
 * cmdGraphInit, cmdGraphStatus, cmdGraphImpact, cmdGraphContext,
 * cmdGraphVisualize, cmdGraphSnapshot, cmdGraphSnapshotDiff, cmdGraphQuery
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeReadFile, output, error, getForgeRoot, getForgeGraphDir, getForgeSystemDir,
        graphDbExists, graphDbPath, getGraphStatus, getGraphContextForFiles, getGraphImpact,
        loadConfig, pathExistsInternal, collectPhaseFiles } = require('./core.cjs');

/**
 * graph init — build full graph + install hooks.
 */
function cmdGraphInit(cwd, args, raw) {
  const graphDir = getForgeGraphDir();
  const builderPath = path.join(graphDir, 'builder.js');
  const hooksPath = path.join(graphDir, 'install-hooks.js');
  const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : cwd;

  // Ensure .forge directory exists
  const forgeDir = path.join(cwd, '.forge');
  if (!fs.existsSync(forgeDir)) {
    fs.mkdirSync(forgeDir, { recursive: true });
  }

  const startTime = Date.now();
  let buildOutput;
  try {
    buildOutput = execSync(`node "${builderPath}" "${rootArg}" --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000,
    });
  } catch (e) {
    error(`Graph build failed: ${e.stderr || e.message}`);
  }

  // Install git hooks
  let hooksInstalled = false;
  try {
    execSync(`node "${hooksPath}" "${cwd}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    hooksInstalled = true;
  } catch {
    // Non-fatal — hooks are optional
  }

  // Run capability detection
  let capabilitiesDetected = 0;
  try {
    const capPath = path.join(graphDir, 'capability-detector.js');
    execSync(`node "${capPath}" detect --root "${rootArg}" --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
    });
    capabilitiesDetected = 1; // success flag
  } catch {}

  // Run interface detection (forge-system)
  let interfacesDetected = 0;
  let interfacesPath = null;
  try {
    const detectMod = require(path.join(getForgeSystemDir(), 'detect'));
    const detection = detectMod.detectInterfaces(rootArg);
    if (detection.exports.length > 0 || detection.imports.length > 0) {
      const yaml = detectMod.generateYAML(detection);
      interfacesPath = detectMod.writeInterfacesYAML(rootArg, yaml);
      interfacesDetected = detection.exports.length + detection.imports.length;
    }
  } catch { /* non-fatal — forge-system may not be installed */ }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Read stats from the freshly built graph
  const meta = getGraphStatus(cwd) || {};

  // === Full .forge/ environment setup ===

  // Create .forge/config.json from template if missing
  let configCreated = false;
  const configPath = path.join(forgeDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    try {
      const templatePath = path.join(path.dirname(path.dirname(path.dirname(__filename))), 'templates', 'config.json');
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, configPath);
      } else {
        // Write minimal config
        fs.writeFileSync(configPath, JSON.stringify({ project: { name: path.basename(cwd) } }, null, 2) + '\n');
      }
      configCreated = true;
    } catch { /* non-fatal */ }
  }

  // Create .forge/session/ directory
  const sessionDir = path.join(forgeDir, 'session');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // Create .forge/snapshots/ directory
  const snapshotsDir = path.join(forgeDir, 'snapshots');
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

  // Create .forge/knowledge/ directory
  const knowledgeDir = path.join(forgeDir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });

  // Ensure .forge/ is in .gitignore (runtime data, not project code)
  let gitignoreUpdated = false;
  try {
    const gitignorePath = path.join(cwd, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    const hasForgeEntry = existing.split('\n').some(line => /^\/?\.forge\/?$/.test(line.trim()));
    if (!hasForgeEntry) {
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const block = `${separator}\n# Forge (FDP) — runtime data, not project code\n.forge/\n`;
      fs.appendFileSync(gitignorePath, block);
      gitignoreUpdated = true;
    }
  } catch { /* non-fatal */ }

  // Take initial graph snapshot
  let snapshotSaved = false;
  try {
    const snapshotMod = require(path.join(getForgeGraphDir(), 'snapshot'));
    snapshotMod.saveSnapshot(cwd, graphDbPath(cwd));
    snapshotSaved = true;
  } catch { /* non-fatal */ }

  // Generate dashboard if auto-regeneration is enabled (or if no config to check)
  let dashboardGenerated = false;
  try {
    let autoRegen = true;
    try {
      const { shouldAutoRegenerate } = require(path.join(getForgeGraphDir(), 'dashboard-generator'));
      autoRegen = shouldAutoRegenerate(cwd);
    } catch { /* default to true */ }
    if (autoRegen) {
      const dashGenPath = path.join(getForgeGraphDir(), 'dashboard-generator.js');
      execSync(`node "${dashGenPath}" "${graphDbPath(cwd)}"`, {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
      });
      dashboardGenerated = true;
    }
  } catch { /* non-fatal */ }

  const result = {
    success: true,
    build_time: `${elapsed}s`,
    total_files: meta.file_count || meta.total_files || '0',
    total_symbols: meta.symbol_count || meta.total_symbols || '0',
    module_count: meta.module_count || '0',
    dependency_count: meta.dependency_count || '0',
    hooks_installed: hooksInstalled,
    capabilities_detected: capabilitiesDetected > 0,
    config_created: configCreated,
    snapshot_saved: snapshotSaved,
    dashboard_generated: dashboardGenerated,
    gitignore_updated: gitignoreUpdated,
    interfaces_detected: interfacesDetected,
    interfaces_path: interfacesPath,
    directories_created: ['session', 'snapshots', 'knowledge'],
    db_path: graphDbPath(cwd),
  };

  output(result, raw);
}

/**
 * graph status — show graph freshness and key stats.
 */
function cmdGraphStatus(cwd, raw) {
  if (!graphDbExists(cwd)) {
    output({
      graph_exists: false,
      message: 'No code graph found. Run /forge-init to build one.',
    }, raw);
    return;
  }

  const graphDir = getForgeGraphDir();
  const queryPath = path.join(graphDir, 'query.js');

  let meta = null, hotspots = null, modules = null, capabilities = null;

  try {
    const metaOut = execSync(`node "${queryPath}" meta --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    meta = JSON.parse(metaOut);
  } catch {}

  try {
    const hotspotsOut = execSync(`node "${queryPath}" hotspots --top 5 --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    hotspots = JSON.parse(hotspotsOut);
  } catch {}

  try {
    const modsOut = execSync(`node "${queryPath}" modules --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    modules = JSON.parse(modsOut);
  } catch {}

  try {
    const capsOut = execSync(`node "${queryPath}" capabilities --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    capabilities = JSON.parse(capsOut);
  } catch {}

  output({
    graph_exists: true,
    meta,
    hotspots: hotspots || [],
    modules: modules || [],
    capabilities: capabilities || [],
  }, raw);
}

/**
 * graph impact — impact analysis for a file or a phase.
 */
function cmdGraphImpact(cwd, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }

  const graphDir = getForgeGraphDir();
  const queryPath = path.join(graphDir, 'query.js');
  const depthArg = args.includes('--depth') ? args[args.indexOf('--depth') + 1] : '2';

  // Check if targeting a phase
  const phaseIdx = args.indexOf('--phase');
  if (phaseIdx !== -1) {
    const phaseNum = args[phaseIdx + 1];
    const files = collectPhaseFiles(cwd, phaseNum);
    if (files.length === 0) {
      error(`No files found in phase ${phaseNum} plans.`);
    }

    // Get context-for-task which includes aggregate risk
    const context = getGraphContextForFiles(cwd, files);
    output(context || { error: 'Failed to analyze phase files' }, raw);
    return;
  }

  // Single file impact
  const file = args.find(a => !a.startsWith('--') && a !== 'impact');
  if (!file) {
    error('Usage: graph impact <file> [--depth N] or graph impact --phase <N>');
  }

  const impact = getGraphImpact(cwd, file, parseInt(depthArg));
  if (!impact) {
    error(`Impact analysis failed for: ${file}`);
  }
  output(impact, raw);
}

/**
 * graph context — get task context for files.
 */
function cmdGraphContext(cwd, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }

  const files = args.filter(a => !a.startsWith('--') && a !== 'context');
  if (files.length === 0) {
    error('Usage: graph context <file1> [file2] ...');
  }

  const context = getGraphContextForFiles(cwd, files);
  if (!context) {
    error('Context generation failed.');
  }
  output(context, raw);
}

/**
 * graph visualize — generate interactive HTML dashboard.
 */
function cmdGraphVisualize(cwd, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }

  const graphDir = getForgeGraphDir();
  const dashboardScript = path.join(graphDir, 'dashboard-generator.js');

  if (!pathExistsInternal(path.dirname(dashboardScript), path.basename(dashboardScript))) {
    error('Dashboard generator not found at: ' + dashboardScript);
  }

  // Parse args
  let outputArg = '';
  const outputIdx = args.indexOf('--output');
  if (outputIdx >= 0 && args[outputIdx + 1]) {
    outputArg = '--output "' + args[outputIdx + 1] + '"';
  } else {
    outputArg = '--output "' + path.join(cwd, '.forge', 'dashboard.html') + '"';
  }

  const openArg = args.includes('--open') ? '--open' : '';
  const noOpen = args.includes('--no-open');

  try {
    const cmdLine = 'node "' + dashboardScript + '" --root "' + cwd + '" --db "' + graphDbPath(cwd) + '" ' + outputArg + (!noOpen && !openArg ? '' : ' ' + openArg);
    execSync(cmdLine, { cwd, encoding: 'utf-8', stdio: 'inherit', timeout: 60000 });

    const dashFile = (outputIdx >= 0 && args[outputIdx + 1])
      ? args[outputIdx + 1]
      : path.join(cwd, '.forge', 'dashboard.html');

    output({
      success: true,
      dashboard_path: dashFile,
      opened: args.includes('--open'),
    }, raw);
  } catch (e) {
    error('Dashboard generation failed: ' + (e.message || ''));
  }
}

/**
 * graph snapshot — save or list snapshots.
 */
function cmdGraphSnapshot(cwd, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }

  const graphDir = getForgeGraphDir();
  const { saveSnapshot, listSnapshots } = require(path.join(graphDir, 'snapshot'));

  const subAction = args[0]; // 'save', 'list', or undefined (default: save)

  if (subAction === 'list') {
    const snapshots = listSnapshots(cwd);
    output({ count: snapshots.length, snapshots }, raw);
  } else {
    // Default: save
    const result = saveSnapshot(cwd, graphDbPath(cwd));
    output({
      success: true,
      snapshot_path: result.path,
      timestamp: result.timestamp,
      commit: result.commit,
    }, raw);
  }
}

/**
 * graph snapshot-diff — diff current state against latest snapshot.
 */
function cmdGraphSnapshotDiff(cwd, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }

  const graphDir = getForgeGraphDir();
  const { diffAgainstLatest } = require(path.join(graphDir, 'snapshot'));

  const diff = diffAgainstLatest(cwd, graphDbPath(cwd));
  output(diff, raw);
}

/**
 * graph query passthrough — delegates to forge-graph/query.js CLI for
 * subcommands not implemented natively: overview, show, hotspots, cycles, capabilities.
 */
function cmdGraphQuery(cwd, command, args, raw) {
  if (!graphDbExists(cwd)) {
    error('No code graph found. Run /forge-init first.');
  }
  const graphDir = getForgeGraphDir();
  const queryPath = path.join(graphDir, 'query.js');
  const extraArgs = args.filter(a => a !== command).join(' ');
  const jsonFlag = raw ? ' --json' : '';
  try {
    const result = execSync(
      `node "${queryPath}" ${command} ${extraArgs}${jsonFlag} --db "${graphDbPath(cwd)}"`,
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
    );
    if (raw) {
      try {
        output(JSON.parse(result), raw);
      } catch {
        process.stdout.write(result);
      }
    } else {
      process.stdout.write(result);
    }
  } catch (e) {
    const stderr = e.stderr ? e.stderr.trim() : '';
    const stdout = e.stdout ? e.stdout.trim() : '';
    if (stdout) process.stdout.write(stdout + '\n');
    if (stderr) process.stderr.write(stderr + '\n');
    if (!stdout && !stderr) error(`graph ${command} failed: ${e.message}`);
  }
}

module.exports = {
  cmdGraphInit,
  cmdGraphStatus,
  cmdGraphImpact,
  cmdGraphContext,
  cmdGraphVisualize,
  cmdGraphSnapshot,
  cmdGraphSnapshotDiff,
  cmdGraphQuery,
};
