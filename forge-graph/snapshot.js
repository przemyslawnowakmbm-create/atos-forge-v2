#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAX_SNAPSHOTS = 20;

// ============================================================
// Helpers
// ============================================================

function getHeadCommit(cwd) {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function snapshotDir(cwd) {
  return path.join(cwd, '.forge', 'snapshots');
}

// ============================================================
// Data Collection
// ============================================================

/**
 * Collect all snapshot-worthy data from the graph database.
 * @param {string} dbPath - Path to graph.db
 * @returns {object} Snapshot data
 */
function collectSnapshotData(dbPath) {
  const { GraphQuery } = require('./query');
  const q = new GraphQuery(dbPath);
  try {
    q.open();

    const meta = q.meta();
    const mods = q.modules();
    const depGraph = q.moduleDependencyGraph();
    const interfaces = q.mostUsedInterfaces(200);
    const caps = q.capabilities();
    const hotspots = q.hotspots(100);
    const cycles = q.getCycles();

    // Language stats via raw SQL
    const langStats = q.db.prepare(`
      SELECT language, COUNT(*) as files, COALESCE(SUM(loc), 0) as total_loc
      FROM files WHERE language IS NOT NULL
      GROUP BY language ORDER BY total_loc DESC
    `).all();

    const cwd = path.dirname(path.dirname(dbPath));
    const commit = getHeadCommit(cwd);

    return {
      version: 1,
      timestamp: new Date().toISOString(),
      commit,
      meta: {
        file_count: meta.total_files || meta.file_count || '0',
        symbol_count: meta.total_symbols || meta.symbol_count || '0',
        module_count: meta.module_count || String(mods.length),
        dependency_count: meta.dependency_count || '0',
        last_build_time: meta.last_build_time || null,
        last_build_commit: meta.last_build_commit || null,
      },
      modules: mods.map(m => ({
        name: m.name,
        root_path: m.root_path,
        file_count: m.file_count || 0,
        public_api_count: m.public_api_count || 0,
        stability: m.stability || 'medium',
        capabilities: m.capabilities ? m.capabilities.split(',').map(s => s.trim()).filter(Boolean) : [],
      })),
      moduleDependencies: depGraph.edges.map(e => ({
        source_module: e.source_module,
        target_module: e.target_module,
        edge_count: e.edge_count || 0,
      })),
      interfaces: interfaces.map(i => ({
        name: i.name,
        file: i.file,
        kind: i.kind,
        consumer_count: i.consumer_count || 0,
        contract_hash: i.contract_hash || null,
        module: i.module || null,
      })),
      capabilities: caps.map(c => ({
        module_name: c.module_name,
        capability: c.capability,
        confidence: c.confidence || 0,
        evidence: c.evidence || '',
      })),
      hotspots: hotspots.map(h => ({
        path: h.path,
        module: h.module,
        loc: h.loc || 0,
        complexity_score: h.complexity_score || 0,
        changes_30d: h.changes_30d || 0,
        risk_score: h.risk_score || 0,
      })),
      cycles: {
        count: cycles.count || 0,
        byModule: cycles.byModule || {},
      },
      languages: langStats,
    };
  } finally {
    q.close();
  }
}

// ============================================================
// Save / Load / List / Prune
// ============================================================

/**
 * Save a snapshot to .forge/snapshots/<timestamp>-<commit>.json
 * @param {string} cwd - Project root
 * @param {string} [dbPath] - Optional explicit DB path
 * @returns {{ path: string, timestamp: string, commit: string }}
 */
function saveSnapshot(cwd, dbPath) {
  const db = dbPath || path.join(cwd, '.forge', 'graph.db');
  if (!fs.existsSync(db)) {
    throw new Error(`Database not found: ${db}`);
  }

  const data = collectSnapshotData(db);
  const dir = snapshotDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ts = data.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `${ts}-${data.commit}.json`;
  const snapshotPath = path.join(dir, filename);

  fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
  pruneSnapshots(cwd);

  return { path: snapshotPath, timestamp: data.timestamp, commit: data.commit };
}

/**
 * List all snapshots sorted newest-first.
 * @param {string} cwd
 * @returns {Array<{ path: string, filename: string, timestamp: string }>}
 */
function listSnapshots(cwd) {
  const dir = snapshotDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => ({
      path: path.join(dir, f),
      filename: f,
      timestamp: f.replace(/_/g, 'T').replace(/-(\d{2})-(\d{2})-(\d{2})-/, '-$1:$2:$3-').slice(0, 19),
    }));
}

/**
 * Load the most recent snapshot.
 * @param {string} cwd
 * @returns {object|null}
 */
function loadLatestSnapshot(cwd) {
  const snapshots = listSnapshots(cwd);
  if (snapshots.length === 0) return null;

  try {
    return JSON.parse(fs.readFileSync(snapshots[0].path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Prune snapshots to keep only the latest MAX_SNAPSHOTS.
 * @param {string} cwd
 * @returns {number} Number of snapshots deleted
 */
function pruneSnapshots(cwd) {
  const snapshots = listSnapshots(cwd);
  let deleted = 0;
  if (snapshots.length > MAX_SNAPSHOTS) {
    for (const snap of snapshots.slice(MAX_SNAPSHOTS)) {
      try {
        fs.unlinkSync(snap.path);
        deleted++;
      } catch { /* ignore */ }
    }
  }
  return deleted;
}

// ============================================================
// Diff
// ============================================================

/**
 * Diff current graph state against the latest snapshot.
 * @param {string} cwd
 * @param {string} [dbPath]
 * @returns {object} Diff result
 */
function diffAgainstLatest(cwd, dbPath) {
  const latest = loadLatestSnapshot(cwd);
  if (!latest) {
    return { hasBaseline: false, message: 'No previous snapshot found. Run graph snapshot save first.' };
  }

  const db = dbPath || path.join(cwd, '.forge', 'graph.db');
  const current = collectSnapshotData(db);

  // Module diff
  const prevModNames = new Set(latest.modules.map(m => m.name));
  const currModNames = new Set(current.modules.map(m => m.name));
  const modulesAdded = [...currModNames].filter(n => !prevModNames.has(n));
  const modulesRemoved = [...prevModNames].filter(n => !currModNames.has(n));

  // Stability changes
  const prevStab = new Map(latest.modules.map(m => [m.name, m.stability]));
  const stabilityChanges = current.modules
    .filter(m => prevStab.has(m.name) && prevStab.get(m.name) !== m.stability)
    .map(m => ({ module: m.name, before: prevStab.get(m.name), after: m.stability }));

  // Interface changes — contract_hash diff
  const prevIfaces = new Map(latest.interfaces.map(i => [i.name + ':' + i.file, i]));
  const breakingChanges = [];
  const newInterfaces = [];
  const removedInterfaces = [];
  const consumerDeltas = [];

  const currIfaceKeys = new Set();
  for (const iface of current.interfaces) {
    const key = iface.name + ':' + iface.file;
    currIfaceKeys.add(key);
    const prev = prevIfaces.get(key);
    if (!prev) {
      newInterfaces.push(iface);
    } else {
      if (prev.contract_hash && iface.contract_hash && prev.contract_hash !== iface.contract_hash) {
        breakingChanges.push({ name: iface.name, file: iface.file, oldHash: prev.contract_hash, newHash: iface.contract_hash });
      }
      const delta = (iface.consumer_count || 0) - (prev.consumer_count || 0);
      if (delta !== 0) {
        consumerDeltas.push({ name: iface.name, file: iface.file, before: prev.consumer_count, after: iface.consumer_count, delta });
      }
    }
  }
  for (const [key, iface] of prevIfaces) {
    if (!currIfaceKeys.has(key)) {
      removedInterfaces.push(iface);
    }
  }

  // Capability changes
  const prevCaps = new Set(latest.capabilities.map(c => `${c.module_name}:${c.capability}`));
  const currCaps = new Set(current.capabilities.map(c => `${c.module_name}:${c.capability}`));
  const capsAdded = [...currCaps].filter(c => !prevCaps.has(c)).map(c => {
    const [mod, cap] = c.split(':');
    return { module: mod, capability: cap };
  });
  const capsRemoved = [...prevCaps].filter(c => !currCaps.has(c)).map(c => {
    const [mod, cap] = c.split(':');
    return { module: mod, capability: cap };
  });

  // Metrics
  const fileCountDelta = parseInt(current.meta.file_count || 0) - parseInt(latest.meta.file_count || 0);
  const symbolCountDelta = parseInt(current.meta.symbol_count || 0) - parseInt(latest.meta.symbol_count || 0);
  const cycleCountDelta = (current.cycles.count || 0) - (latest.cycles.count || 0);
  const moduleCountDelta = current.modules.length - latest.modules.length;

  return {
    hasBaseline: true,
    baseline: {
      timestamp: latest.timestamp,
      commit: latest.commit,
    },
    current: {
      timestamp: current.timestamp,
      commit: current.commit,
    },
    metrics: {
      fileCountDelta,
      symbolCountDelta,
      moduleCountDelta,
      cycleCountDelta,
    },
    modules: {
      added: modulesAdded,
      removed: modulesRemoved,
      stabilityChanges,
    },
    interfaces: {
      new: newInterfaces.map(i => ({ name: i.name, file: i.file })),
      removed: removedInterfaces.map(i => ({ name: i.name, file: i.file })),
      breaking: breakingChanges,
      consumerDeltas: consumerDeltas.slice(0, 20),
    },
    capabilities: {
      added: capsAdded,
      removed: capsRemoved,
    },
    summary: {
      totalChanges: Math.abs(fileCountDelta) + Math.abs(symbolCountDelta) +
        modulesAdded.length + modulesRemoved.length +
        breakingChanges.length + newInterfaces.length + removedInterfaces.length,
      hasBreakingChanges: breakingChanges.length > 0,
      riskIndicators: [
        ...(breakingChanges.length > 0 ? [`${breakingChanges.length} breaking interface change(s)`] : []),
        ...(modulesRemoved.length > 0 ? [`${modulesRemoved.length} module(s) removed`] : []),
        ...(cycleCountDelta > 0 ? [`${cycleCountDelta} new circular dependency cycle(s)`] : []),
        ...(stabilityChanges.filter(s => s.after === 'low').length > 0 ? ['Module stability degraded'] : []),
      ],
    },
  };
}

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const cwd = args.includes('--root')
    ? args[args.indexOf('--root') + 1]
    : process.cwd();
  const dbPath = args.includes('--db')
    ? args[args.indexOf('--db') + 1]
    : path.join(cwd, '.forge', 'graph.db');

  const action = args[0];

  if (action === 'save') {
    const result = saveSnapshot(cwd, dbPath);
    console.log(JSON.stringify(result));
  } else if (action === 'list') {
    const snapshots = listSnapshots(cwd);
    console.log(JSON.stringify({ count: snapshots.length, snapshots }));
  } else if (action === 'diff') {
    const diff = diffAgainstLatest(cwd, dbPath);
    console.log(JSON.stringify(diff, null, 2));
  } else if (action === 'prune') {
    const deleted = pruneSnapshots(cwd);
    console.log(JSON.stringify({ pruned: deleted }));
  } else {
    console.error('Usage: node snapshot.js <save|list|diff|prune> [--root path] [--db path]');
    process.exit(1);
  }
}

module.exports = {
  collectSnapshotData,
  saveSnapshot,
  loadLatestSnapshot,
  listSnapshots,
  pruneSnapshots,
  diffAgainstLatest,
  MAX_SNAPSHOTS,
};
