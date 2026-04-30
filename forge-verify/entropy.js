#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Code Entropy Metrics — measures structural health from the code graph.
 *
 * Per-module metrics (Robert Martin's package metrics):
 *   Ca — Afferent coupling (who depends on me)
 *   Ce — Efferent coupling (who I depend on)
 *   I  — Instability = Ce / (Ca + Ce)  [0 = stable, 1 = unstable]
 *   A  — Abstractness = abstract_types / total_types  [0 = concrete, 1 = abstract]
 *   D  — Distance from main sequence = |A + I - 1|  [0 = balanced, 1 = worst]
 *   Cohesion — internal_deps / (internal_deps + external_deps)
 *
 * Usage:
 *   node forge-verify/entropy.js --root . [--phase N] [--compare-baseline] [--json]
 *   Programmatic:
 *     const { computeEntropy, compareSnapshots } = require('./entropy');
 */

// ============================================================
// Pure Computation Functions (no I/O, testable)
// ============================================================

function computeInstability(ca, ce) {
  if (ca + ce === 0) return 0;
  return parseFloat((ce / (ca + ce)).toFixed(4));
}

function computeDistance(abstractness, instability) {
  return parseFloat(Math.abs(abstractness + instability - 1).toFixed(4));
}

function computeCohesion(internalDeps, externalDeps) {
  if (internalDeps + externalDeps === 0) return 1;
  return parseFloat((internalDeps / (internalDeps + externalDeps)).toFixed(4));
}

function classifyHealth(avgDistance) {
  if (avgDistance < 0.3) return 'green';
  if (avgDistance < 0.5) return 'yellow';
  return 'red';
}

// ============================================================
// Graph-Based Computation
// ============================================================

function computeEntropy(cwd, opts = {}) {
  const dbPath = opts.dbPath || path.join(cwd, '.forge', 'graph.db');

  if (!fs.existsSync(dbPath)) {
    return {
      timestamp: new Date().toISOString(),
      phase: opts.phase || null,
      skipped: true,
      reason: 'No code graph found at ' + dbPath,
      aggregate: { totalFiles: 0, totalModules: 0, avgInstability: 0, avgDistance: 0, avgCohesion: 1, totalLargeFiles: 0, health: 'green' },
      modules: [],
    };
  }

  let db;
  try {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      try {
        Database = require(path.join(__dirname, '..', 'forge-graph', 'node_modules', 'better-sqlite3'));
      } catch {
        return {
          timestamp: new Date().toISOString(),
          phase: opts.phase || null,
          skipped: true,
          reason: 'better-sqlite3 not available',
          aggregate: { totalFiles: 0, totalModules: 0, avgInstability: 0, avgDistance: 0, avgCohesion: 1, totalLargeFiles: 0, health: 'green' },
          modules: [],
        };
      }
    }
    db = new Database(dbPath, { readonly: true });
  } catch {
    return {
      timestamp: new Date().toISOString(),
      phase: opts.phase || null,
      skipped: true,
      reason: 'better-sqlite3 not available',
      aggregate: { totalFiles: 0, totalModules: 0, avgInstability: 0, avgDistance: 0, avgCohesion: 1, totalLargeFiles: 0, health: 'green' },
      modules: [],
    };
  }

  try {
    const modules = [];
    const largeLoc = opts.largeFileLoc || 500;

    // Get all modules
    const moduleRows = db.prepare('SELECT name, root_path, file_count FROM modules').all();

    for (const mod of moduleRows) {
      if (opts.module && mod.name !== opts.module) continue;

      // Afferent coupling (Ca): how many other modules depend on this one
      let ca = 0;
      try {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM module_dependencies WHERE target_module = ?').get(mod.name);
        ca = row ? row.cnt : 0;
      } catch {}

      // Efferent coupling (Ce): how many modules this one depends on
      let ce = 0;
      try {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM module_dependencies WHERE source_module = ?').get(mod.name);
        ce = row ? row.cnt : 0;
      } catch {}

      // Abstractness: ratio of interfaces/types to total exported symbols
      let abstractTypes = 0;
      let totalTypes = 0;
      try {
        const absRow = db.prepare(`
          SELECT COUNT(*) as cnt FROM symbols s
          JOIN files f ON s.file = f.path
          WHERE f.module = ? AND s.exported = 1 AND s.kind IN ('interface', 'type')
        `).get(mod.name);
        abstractTypes = absRow ? absRow.cnt : 0;

        const totRow = db.prepare(`
          SELECT COUNT(*) as cnt FROM symbols s
          JOIN files f ON s.file = f.path
          WHERE f.module = ? AND s.exported = 1
        `).get(mod.name);
        totalTypes = totRow ? totRow.cnt : 0;
      } catch {}

      const abstractness = totalTypes > 0 ? parseFloat((abstractTypes / totalTypes).toFixed(4)) : 0;
      const instability = computeInstability(ca, ce);
      const distance = computeDistance(abstractness, instability);

      // Cohesion: internal deps vs external deps
      let internalDeps = 0;
      let externalDeps = 0;
      try {
        const intRow = db.prepare(`
          SELECT COUNT(*) as cnt FROM dependencies d
          JOIN files f1 ON d.source_file = f1.path
          JOIN files f2 ON d.target_file = f2.path
          WHERE f1.module = ? AND f2.module = ?
        `).get(mod.name, mod.name);
        internalDeps = intRow ? intRow.cnt : 0;

        const extRow = db.prepare(`
          SELECT COUNT(*) as cnt FROM dependencies d
          JOIN files f1 ON d.source_file = f1.path
          JOIN files f2 ON d.target_file = f2.path
          WHERE f1.module = ? AND f2.module != ?
        `).get(mod.name, mod.name);
        externalDeps = extRow ? extRow.cnt : 0;
      } catch {}

      const cohesion = computeCohesion(internalDeps, externalDeps);

      // Complexity and file size
      let avgComplexity = 0;
      let maxComplexity = 0;
      let avgLoc = 0;
      let largeFileCount = 0;
      let fileCount = mod.file_count || 0;
      try {
        const statsRow = db.prepare(`
          SELECT AVG(complexity_score) as avg_c, MAX(complexity_score) as max_c,
                 AVG(loc) as avg_loc, COUNT(CASE WHEN loc > ? THEN 1 END) as large_files,
                 COUNT(*) as file_cnt
          FROM files WHERE module = ?
        `).get(largeLoc, mod.name);
        if (statsRow) {
          avgComplexity = parseFloat((statsRow.avg_c || 0).toFixed(2));
          maxComplexity = statsRow.max_c || 0;
          avgLoc = parseFloat((statsRow.avg_loc || 0).toFixed(0));
          largeFileCount = statsRow.large_files || 0;
          fileCount = statsRow.file_cnt || fileCount;
        }
      } catch {}

      modules.push({
        name: mod.name,
        ca, ce, instability, abstractness, distance, cohesion,
        avgComplexity, maxComplexity, avgLoc, largeFileCount, fileCount,
      });
    }

    // Aggregate
    const totalFiles = modules.reduce((s, m) => s + m.fileCount, 0);
    const totalModules = modules.length;
    const avgInstability = totalModules > 0
      ? parseFloat((modules.reduce((s, m) => s + m.instability, 0) / totalModules).toFixed(4)) : 0;
    const avgDistance = totalModules > 0
      ? parseFloat((modules.reduce((s, m) => s + m.distance, 0) / totalModules).toFixed(4)) : 0;
    const avgCohesion = totalModules > 0
      ? parseFloat((modules.reduce((s, m) => s + m.cohesion, 0) / totalModules).toFixed(4)) : 1;
    const totalLargeFiles = modules.reduce((s, m) => s + m.largeFileCount, 0);

    return {
      timestamp: new Date().toISOString(),
      phase: opts.phase || null,
      skipped: false,
      aggregate: {
        totalFiles, totalModules, avgInstability, avgDistance, avgCohesion, totalLargeFiles,
        health: classifyHealth(avgDistance),
      },
      modules,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

// ============================================================
// Snapshot Management
// ============================================================

function saveSnapshot(cwd, phaseNumber, report) {
  const dir = path.join(cwd, '.forge', 'entropy-snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `phase-${phaseNumber}.json`),
    JSON.stringify(report, null, 2) + '\n'
  );
}

function loadSnapshot(cwd, phaseNumber) {
  const snapshotPath = path.join(cwd, '.forge', 'entropy-snapshots', `phase-${phaseNumber}.json`);
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch { return null; }
}

// ============================================================
// Comparison
// ============================================================

function compareSnapshots(current, baseline) {
  const moduleComparisons = [];

  for (const mod of current.modules) {
    const baseMod = baseline.modules.find(m => m.name === mod.name);
    if (!baseMod) {
      moduleComparisons.push({ name: mod.name, status: 'new', current: mod });
      continue;
    }
    const delta = {
      instability: (mod.instability || 0) - (baseMod.instability || 0),
      distance: (mod.distance || 0) - (baseMod.distance || 0),
      cohesion: (mod.cohesion || 0) - (baseMod.cohesion || 0),
    };
    const degradedCount = Object.values(delta).filter(d => Math.abs(d) > 0.05 && d > 0).length;
    const status = degradedCount >= 2 ? 'degraded' : degradedCount >= 1 ? 'mixed' : 'improved';
    moduleComparisons.push({ name: mod.name, status, delta, current: mod, baseline: baseMod });
  }

  const baseAvgDist = baseline.aggregate?.avgDistance || 0;
  const currAvgDist = current.aggregate?.avgDistance || 0;
  const aggDelta = currAvgDist - baseAvgDist;
  const changePercent = baseAvgDist > 0 ? (aggDelta / baseAvgDist) * 100 : 0;

  return {
    moduleComparisons,
    aggregateChange: {
      delta: parseFloat(aggDelta.toFixed(4)),
      changePercent: parseFloat(changePercent.toFixed(1)),
      verdict: changePercent > 25 ? 'block' : changePercent > 10 ? 'warn' : 'ok',
    },
  };
}

// ============================================================
// Formatting
// ============================================================

function formatEntropyReport(report) {
  const lines = [];
  const icon = { green: '🟢', yellow: '🟡', red: '🔴' };

  lines.push('## Entropy Report');
  lines.push('');
  lines.push(`**Health:** ${icon[report.aggregate.health] || '⚪'} ${(report.aggregate.health || 'unknown').toUpperCase()}`);
  lines.push(`**Modules:** ${report.aggregate.totalModules} | **Files:** ${report.aggregate.totalFiles} | **Large files (>500 LOC):** ${report.aggregate.totalLargeFiles}`);
  lines.push(`**Avg instability:** ${report.aggregate.avgInstability} | **Avg distance:** ${report.aggregate.avgDistance} | **Avg cohesion:** ${report.aggregate.avgCohesion}`);
  lines.push('');

  if (report.modules.length > 0) {
    lines.push('| Module | I (instab) | A (abstract) | D (distance) | Cohesion | Complexity | Files |');
    lines.push('|--------|-----------|-------------|-------------|---------|-----------|-------|');
    for (const m of report.modules) {
      lines.push(`| ${m.name} | ${m.instability} | ${m.abstractness || '-'} | ${m.distance} | ${m.cohesion} | ${m.avgComplexity} | ${m.fileCount} |`);
    }
  }

  return lines.join('\n');
}

function formatComparison(comparison) {
  const lines = [];
  const icon = { ok: '✅', warn: '⚠️', block: '🛑' };

  lines.push('');
  lines.push(`**Trend:** ${icon[comparison.aggregateChange.verdict] || '?'} ${comparison.aggregateChange.verdict.toUpperCase()} (${comparison.aggregateChange.changePercent > 0 ? '+' : ''}${comparison.aggregateChange.changePercent}% distance change)`);

  if (comparison.moduleComparisons.some(m => m.status === 'degraded' || m.status === 'new')) {
    lines.push('');
    for (const m of comparison.moduleComparisons.filter(mc => mc.status !== 'improved')) {
      lines.push(`  ${m.name}: ${m.status}${m.delta ? ` (instability ${m.delta.instability > 0 ? '+' : ''}${m.delta.instability.toFixed(3)})` : ''}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  computeInstability,
  computeDistance,
  computeCohesion,
  classifyHealth,
  computeEntropy,
  compareSnapshots,
  saveSnapshot,
  loadSnapshot,
  formatEntropyReport,
  formatComparison,
};
