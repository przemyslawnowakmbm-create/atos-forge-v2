#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Chalk — graceful fallback when not installed or rich_output=false
// ============================================================

const NO_COLOR_HANDLER = {
  get(target, prop) {
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === 'level') return 0;
    return new Proxy((...args) => args.join(''), NO_COLOR_HANDLER);
  },
  apply(target, thisArg, args) {
    return args.join('');
  },
};
const noColorChalk = new Proxy((...args) => args.join(''), NO_COLOR_HANDLER);

let chalk;
try {
  chalk = require('chalk');
} catch {
  chalk = noColorChalk;
}

/**
 * Check display.rich_output config and disable chalk if false.
 * Called once at CLI startup with the resolved cwd.
 */
function applyRichOutputConfig(cwd) {
  try {
    const config = require('../forge-config/config');
    const { config: effective } = config.loadConfig(cwd);
    if (effective.display && effective.display.rich_output === false) {
      chalk = noColorChalk;
    }
  } catch { /* config unavailable — keep current chalk */ }
}

// ============================================================
// Theme — consistent color palette
// ============================================================

const theme = {
  heading:   (s) => chalk.bold.cyan(s),
  subhead:   (s) => chalk.bold.white(s),
  label:     (s) => chalk.dim(s),
  value:     (s) => chalk.white(s),
  file:      (s) => chalk.yellow(s),
  module:    (s) => chalk.blue(s),
  symbol:    (s) => chalk.green(s),
  number:    (s) => chalk.cyan(s),
  dim:       (s) => chalk.dim(s),
  success:   (s) => chalk.green(s),
  warn:      (s) => chalk.yellow(s),
  error:     (s) => chalk.red(s),
  risk(level) {
    switch (level) {
      case 'LOW':      return chalk.green(level);
      case 'MEDIUM':   return chalk.yellow(level);
      case 'HIGH':     return chalk.red(level);
      case 'CRITICAL': return chalk.bgRed.white.bold(` ${level} `);
      default:         return level;
    }
  },
  stability(level) {
    switch (level) {
      case 'high':   return chalk.green(level);
      case 'medium': return chalk.yellow(level);
      case 'low':    return chalk.red(level);
      default:       return level;
    }
  },
  bar(ratio, width = 20) {
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    return chalk.cyan('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
  },
  box: {
    tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518',
    h: '\u2500', v: '\u2502', t: '\u251c', r: '\u2524',
  },
};

// ============================================================
// Graph Query Engine
// ============================================================

class GraphQuery {
  /**
   * @param {string} dbPath - Path to the SQLite database.
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Open the database connection.
   */
  open() {
    if (this.db) return this;
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Database not found: ${this.dbPath}. Run 'forge-graph build' first.`);
    }
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath, { readonly: true });
    this.db.pragma('journal_mode = WAL');
    return this;
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============================================================
  // File Queries
  // ============================================================

  /**
   * Get all files, optionally filtered.
   * @param {{ module?: string, language?: string, isTest?: boolean, limit?: number }} opts
   */
  files(opts = {}) {
    this.open();
    let sql = 'SELECT * FROM files WHERE 1=1';
    const params = [];

    if (opts.module) { sql += ' AND module = ?'; params.push(opts.module); }
    if (opts.language) { sql += ' AND language = ?'; params.push(opts.language); }
    if (opts.isTest !== undefined) { sql += ' AND is_test = ?'; params.push(opts.isTest ? 1 : 0); }

    sql += ' ORDER BY loc DESC';
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get a single file by path.
   */
  file(filePath) {
    this.open();
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
  }

  /**
   * Get the most complex files.
   * @param {number} [limit=20]
   */
  hotspots(limit = 20) {
    this.open();
    return this.db.prepare(`
      SELECT f.path, f.module, f.language, f.loc, f.complexity_score,
             COALESCE(cf.changes_30d, 0) as changes_30d,
             f.complexity_score * (1 + COALESCE(cf.changes_30d, 0) * 0.1) as risk_score
      FROM files f
      LEFT JOIN change_frequency cf ON f.path = cf.file
      WHERE f.is_test = 0 AND f.is_config = 0
      ORDER BY risk_score DESC
      LIMIT ?
    `).all(limit);
  }

  // ============================================================
  // Symbol Queries
  // ============================================================

  /**
   * Search for symbols by name (supports SQL LIKE patterns).
   * @param {string} pattern
   * @param {{ kind?: string, exported?: boolean, limit?: number }} opts
   */
  symbols(pattern, opts = {}) {
    this.open();
    let sql = 'SELECT s.*, f.module FROM symbols s JOIN files f ON s.file = f.path WHERE s.name LIKE ?';
    const params = [pattern];

    if (opts.kind) { sql += ' AND s.kind = ?'; params.push(opts.kind); }
    if (opts.exported !== undefined) { sql += ' AND s.exported = ?'; params.push(opts.exported ? 1 : 0); }

    sql += ' ORDER BY s.name';
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get all symbols in a file.
   */
  symbolsInFile(filePath) {
    this.open();
    return this.db.prepare('SELECT * FROM symbols WHERE file = ? ORDER BY line_start').all(filePath);
  }

  /**
   * Find exported symbols (public API) of a module.
   */
  moduleAPI(moduleName) {
    this.open();
    return this.db.prepare(`
      SELECT s.name, s.kind, s.file, s.signature, s.line_start
      FROM symbols s
      JOIN files f ON s.file = f.path
      WHERE f.module = ? AND s.exported = 1
      ORDER BY s.kind, s.name
    `).all(moduleName);
  }

  // ============================================================
  // Dependency Queries
  // ============================================================

  /**
   * Get all imports for a file.
   */
  importsOf(filePath) {
    this.open();
    return this.db.prepare(`
      SELECT target_file, import_name, import_type
      FROM dependencies
      WHERE source_file = ?
      ORDER BY target_file
    `).all(filePath);
  }

  /**
   * Get all files that import a given file (reverse dependencies).
   */
  importedBy(filePath) {
    this.open();
    return this.db.prepare(`
      SELECT source_file, import_name, import_type
      FROM dependencies
      WHERE target_file = ?
      ORDER BY source_file
    `).all(filePath);
  }

  /**
   * Find dependency chains (transitive dependencies) from a file up to a given depth.
   * @param {string} filePath
   * @param {number} [maxDepth=3]
   */
  dependencyChain(filePath, maxDepth = 3) {
    this.open();
    const visited = new Set();
    const chain = [];

    const getImports = this.db.prepare('SELECT target_file FROM dependencies WHERE source_file = ?');

    const walk = (fp, depth) => {
      if (depth > maxDepth || visited.has(fp)) return;
      visited.add(fp);
      const imports = getImports.all(fp);
      for (const imp of imports) {
        chain.push({ from: fp, to: imp.target_file, depth });
        walk(imp.target_file, depth + 1);
      }
    };

    walk(filePath, 1);
    return chain;
  }

  /**
   * Find circular dependencies.
   * @returns {Array<string[]>} - Array of cycles (each cycle is an array of file paths).
   */
  circularDependencies() {
    this.open();
    const deps = this.db.prepare('SELECT source_file, target_file FROM dependencies').all();

    // Build adjacency list
    const graph = new Map();
    for (const dep of deps) {
      if (!graph.has(dep.source_file)) graph.set(dep.source_file, []);
      graph.get(dep.source_file).push(dep.target_file);
    }

    const cycles = [];
    const visited = new Set();
    const recStack = new Set();
    const pathStack = [];

    const dfs = (node) => {
      visited.add(node);
      recStack.add(node);
      pathStack.push(node);

      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          const cycleStart = pathStack.indexOf(neighbor);
          if (cycleStart >= 0) {
            cycles.push(pathStack.slice(cycleStart).concat(neighbor));
          }
        }
      }

      pathStack.pop();
      recStack.delete(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    return cycles;
  }

  // ============================================================
  // Module Queries
  // ============================================================

  /**
   * List all modules with their stats.
   */
  modules() {
    this.open();
    return this.db.prepare(`
      SELECT m.*,
             GROUP_CONCAT(DISTINCT mc.capability) as capabilities
      FROM modules m
      LEFT JOIN module_capabilities mc ON m.name = mc.module_name AND mc.confidence >= 0.3
      GROUP BY m.name
      ORDER BY m.file_count DESC
    `).all();
  }

  /**
   * Get detailed module info with capabilities, dependencies, and files.
   */
  moduleDetail(moduleName) {
    this.open();
    const mod = this.db.prepare('SELECT * FROM modules WHERE name = ?').get(moduleName);
    if (!mod) return null;

    const files = this.db.prepare('SELECT path, language, loc, complexity_score FROM files WHERE module = ? ORDER BY loc DESC').all(moduleName);
    const capabilities = this.db.prepare('SELECT capability, confidence, evidence FROM module_capabilities WHERE module_name = ? ORDER BY confidence DESC').all(moduleName);
    const dependsOn = this.db.prepare('SELECT target_module, edge_count FROM module_dependencies WHERE source_module = ? ORDER BY edge_count DESC').all(moduleName);
    const dependedOnBy = this.db.prepare('SELECT source_module, edge_count FROM module_dependencies WHERE target_module = ? ORDER BY edge_count DESC').all(moduleName);
    const publicAPI = this.db.prepare(`
      SELECT s.name, s.kind, s.file, s.signature, i.consumer_count, i.contract_hash
      FROM symbols s
      JOIN files f ON s.file = f.path
      LEFT JOIN interfaces i ON i.name = s.name AND i.file = s.file
      WHERE f.module = ? AND s.exported = 1
      ORDER BY COALESCE(i.consumer_count, 0) DESC, s.name
    `).all(moduleName);

    return { ...mod, files, capabilities, dependsOn, dependedOnBy, publicAPI };
  }

  /**
   * Get module dependency graph (for visualization).
   */
  moduleDependencyGraph() {
    this.open();
    const nodes = this.db.prepare('SELECT name, file_count, stability FROM modules').all();
    const edges = this.db.prepare('SELECT source_module, target_module, edge_count FROM module_dependencies').all();
    return { nodes, edges };
  }

  // ============================================================
  // Interface & Change Queries
  // ============================================================

  /**
   * Get the public interfaces (exported symbols) most consumed by other files.
   * @param {number} [limit=20]
   */
  mostUsedInterfaces(limit = 20) {
    this.open();
    return this.db.prepare(`
      SELECT i.name, i.kind, i.file, i.consumer_count, i.contract_hash,
             f.module
      FROM interfaces i
      JOIN files f ON i.file = f.path
      ORDER BY i.consumer_count DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Get files with the highest churn (most changes in 30 days).
   * @param {number} [limit=20]
   */
  highChurn(limit = 20) {
    this.open();
    return this.db.prepare(`
      SELECT cf.*, f.module, f.language, f.loc
      FROM change_frequency cf
      JOIN files f ON cf.file = f.path
      ORDER BY cf.changes_30d DESC
      LIMIT ?
    `).all(limit);
  }

  // ============================================================
  // Capability Queries
  // ============================================================

  /**
   * Get all capabilities detected across modules.
   */
  capabilities() {
    this.open();
    return this.db.prepare(`
      SELECT mc.capability, mc.module_name, mc.confidence, mc.evidence
      FROM module_capabilities mc
      WHERE mc.confidence >= 0.2
      ORDER BY mc.capability, mc.confidence DESC
    `).all();
  }

  /**
   * Find modules that provide a specific capability.
   */
  capabilityProviders(capability) {
    this.open();
    return this.db.prepare(`
      SELECT mc.module_name, mc.confidence, mc.evidence
      FROM module_capabilities mc
      WHERE mc.capability = ? AND mc.confidence >= 0.2
      ORDER BY mc.confidence DESC
    `).all(capability);
  }

  // ============================================================
  // Warning & Learning Queries
  // ============================================================

  /**
   * Get warnings, optionally filtered by severity.
   */
  warnings(opts = {}) {
    this.open();
    let sql = 'SELECT * FROM warnings WHERE 1=1';
    const params = [];

    if (opts.module) { sql += ' AND module = ?'; params.push(opts.module); }
    if (opts.severity) { sql += ' AND severity = ?'; params.push(opts.severity); }

    sql += ' ORDER BY created_at DESC';
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get agent learnings.
   */
  learnings(opts = {}) {
    this.open();
    let sql = 'SELECT * FROM agent_learnings WHERE 1=1';
    const params = [];

    if (opts.module) { sql += ' AND module = ?'; params.push(opts.module); }
    if (opts.type) { sql += ' AND learning_type = ?'; params.push(opts.type); }

    sql += ' ORDER BY created_at DESC';
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    return this.db.prepare(sql).all(...params);
  }

  // ============================================================
  // Write Operations (for agents)
  // ============================================================

  /**
   * Record a warning.
   */
  addWarning(module, file, text, severity = 'info', source = 'agent') {
    this.open();
    if (this.db) this.db.close();
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.prepare(`
      INSERT INTO warnings (module, file, warning_text, severity, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(module, file, text, severity, source);
  }

  /**
   * Record an agent learning.
   */
  addLearning(agentId, module, type, content) {
    this.open();
    if (this.db) this.db.close();
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.prepare(`
      INSERT INTO agent_learnings (agent_id, module, learning_type, content)
      VALUES (?, ?, ?, ?)
    `).run(agentId, module, type, content);
  }

  // ============================================================
  // Metadata
  // ============================================================

  /**
   * Get build metadata.
   */
  meta() {
    this.open();
    const rows = this.db.prepare('SELECT key, value FROM graph_meta').all();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ============================================================
  // Summary / Overview
  // ============================================================

  /**
   * Generate a high-level summary of the repository.
   */
  summary() {
    this.open();
    const meta = this.meta();
    const modules = this.modules();
    const langStats = this.db.prepare(`
      SELECT language, COUNT(*) as files, SUM(loc) as total_loc
      FROM files
      GROUP BY language
      ORDER BY total_loc DESC
    `).all();
    const topComplexity = this.hotspots(10);
    const topChurn = this.highChurn(10);
    const capabilities = this.capabilities();

    const capMap = new Map();
    for (const cap of capabilities) {
      if (!capMap.has(cap.capability)) capMap.set(cap.capability, []);
      capMap.get(cap.capability).push(cap.module_name);
    }

    return {
      meta,
      languages: langStats,
      modules: modules.map(m => ({
        name: m.name,
        files: m.file_count,
        stability: m.stability,
        capabilities: m.capabilities ? m.capabilities.split(',') : [],
      })),
      hotspots: topComplexity,
      highChurn: topChurn,
      capabilities: Object.fromEntries(capMap),
    };
  }

  // ============================================================
  // Programmatic API — High-Level Methods
  // ============================================================

  /**
   * Get all files that import from a given file, with import details.
   * @param {string} filePath
   */
  getConsumers(filePath) {
    this.open();
    const fileInfo = this.db.prepare('SELECT path, module, language, loc FROM files WHERE path = ?').get(filePath);
    const consumers = this.db.prepare(`
      SELECT d.source_file, d.import_name, d.import_type, f.module, f.language
      FROM dependencies d
      JOIN files f ON d.source_file = f.path
      WHERE d.target_file = ?
      ORDER BY f.module, d.source_file
    `).all(filePath);

    return { file: filePath, fileInfo: fileInfo || null, consumers };
  }

  /**
   * Get transitive reverse dependency chain with risk assessment.
   * @param {string} filePath
   * @param {{ depth?: number }} opts
   */
  getImpact(filePath, opts = {}) {
    this.open();
    const maxDepth = opts.depth || 2;

    const fileInfo = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
    const moduleRow = fileInfo
      ? this.db.prepare('SELECT * FROM modules WHERE name = ?').get(fileInfo.module)
      : null;

    const exported = this.db.prepare(`
      SELECT s.name, s.kind, s.signature, i.consumer_count, i.contract_hash
      FROM symbols s
      LEFT JOIN interfaces i ON i.name = s.name AND i.file = s.file
      WHERE s.file = ? AND s.exported = 1
      ORDER BY COALESCE(i.consumer_count, 0) DESC
    `).all(filePath);

    const getConsumers = this.db.prepare(`
      SELECT d.source_file, d.import_name, d.import_type, f.module
      FROM dependencies d
      JOIN files f ON d.source_file = f.path
      WHERE d.target_file = ?
      ORDER BY f.module, d.source_file
    `);

    const directConsumers = getConsumers.all(filePath);

    const visited = new Set([filePath]);
    const transitiveImpact = [];
    let currentLevel = directConsumers.map(c => c.source_file);

    for (let depth = 2; depth <= maxDepth; depth++) {
      const nextLevel = [];
      for (const fp of currentLevel) {
        if (visited.has(fp)) continue;
        visited.add(fp);
        const consumers = getConsumers.all(fp);
        for (const c of consumers) {
          if (!visited.has(c.source_file)) {
            transitiveImpact.push({ ...c, depth, via: fp });
            nextLevel.push(c.source_file);
          }
        }
      }
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    const boundarySet = new Set();
    const sourceModule = fileInfo ? fileInfo.module : null;
    for (const c of directConsumers) {
      if (c.module !== sourceModule) {
        boundarySet.add(`${sourceModule} -> ${c.module}`);
      }
    }
    for (const c of transitiveImpact) {
      if (c.module !== sourceModule) {
        boundarySet.add(`${sourceModule} -> ${c.module}`);
      }
    }

    const caps = fileInfo
      ? this.db.prepare(`
          SELECT capability, confidence FROM module_capabilities
          WHERE module_name = ? AND confidence >= 0.2
          ORDER BY confidence DESC
        `).all(fileInfo.module)
      : [];

    const totalAffected = directConsumers.length + transitiveImpact.length;
    const stability = moduleRow ? moduleRow.stability : 'medium';
    const risk = computeRisk({
      consumerCount: directConsumers.length,
      transitiveCount: transitiveImpact.length,
      exportedCount: exported.length,
      stability,
      boundariesCrossed: boundarySet.size,
    });

    return {
      file: filePath,
      fileInfo: fileInfo || null,
      moduleInfo: moduleRow || null,
      exported,
      directConsumers,
      transitiveImpact,
      moduleBoundaries: [...boundarySet],
      capabilities: caps,
      risk,
      totalAffected,
    };
  }

  /**
   * Get module details: files, public API, consumers, capabilities, stability.
   * @param {string} moduleName
   */
  getModule(moduleName) {
    return this.moduleDetail(moduleName);
  }

  /**
   * Get hotspot files ranked by risk (complexity x churn).
   * @param {{ top?: number }} opts
   */
  getHotspots(opts = {}) {
    return this.hotspots(opts.top || 20);
  }

  /**
   * Get detected capabilities for a module.
   * @param {string} moduleName
   */
  getCapabilities(moduleName) {
    this.open();
    return this.db.prepare(`
      SELECT capability, confidence, evidence
      FROM module_capabilities
      WHERE module_name = ?
      ORDER BY confidence DESC
    `).all(moduleName);
  }

  /**
   * Search for a symbol by name across the entire codebase.
   * @param {string} symbolName - Exact or LIKE pattern.
   */
  searchSymbol(symbolName) {
    this.open();
    const isPattern = symbolName.includes('%') || symbolName.includes('_');

    let results;
    if (!isPattern) {
      results = this.db.prepare(`
        SELECT s.name, s.kind, s.file, s.line_start, s.line_end, s.exported, s.signature,
               f.module, f.language
        FROM symbols s
        JOIN files f ON s.file = f.path
        WHERE s.name = ?
        ORDER BY s.exported DESC, f.module, s.file, s.line_start
      `).all(symbolName);

      if (results.length === 0) {
        results = this.db.prepare(`
          SELECT s.name, s.kind, s.file, s.line_start, s.line_end, s.exported, s.signature,
                 f.module, f.language
          FROM symbols s
          JOIN files f ON s.file = f.path
          WHERE s.name LIKE ? ESCAPE '\\'
          ORDER BY s.exported DESC, f.module, s.file, s.line_start
          LIMIT 100
        `).all(`%${symbolName}%`);
      }
    } else {
      results = this.db.prepare(`
        SELECT s.name, s.kind, s.file, s.line_start, s.line_end, s.exported, s.signature,
               f.module, f.language
        FROM symbols s
        JOIN files f ON s.file = f.path
        WHERE s.name LIKE ? ESCAPE '\\'
        ORDER BY s.exported DESC, f.module, s.file, s.line_start
        LIMIT 100
      `).all(symbolName);
    }

    return results;
  }

  /**
   * Get all modules with their inter-module dependency edges.
   */
  getModuleBoundaries() {
    this.open();
    const modules = this.db.prepare(`
      SELECT m.name, m.root_path, m.file_count, m.public_api_count, m.stability,
             GROUP_CONCAT(DISTINCT mc.capability) as capabilities
      FROM modules m
      LEFT JOIN module_capabilities mc ON m.name = mc.module_name AND mc.confidence >= 0.3
      GROUP BY m.name
      ORDER BY m.file_count DESC
    `).all();

    const edges = this.db.prepare(`
      SELECT source_module, target_module, edge_count
      FROM module_dependencies
      ORDER BY edge_count DESC
    `).all();

    return { modules, edges };
  }

  /**
   * Compute risk assessment for a set of files.
   * @param {string[]} filePaths
   */
  getRiskAssessment(filePaths) {
    this.open();
    let totalConsumers = 0;
    let totalTransitive = 0;
    let totalExported = 0;
    const modulesAffected = new Set();
    const boundariesCrossed = new Set();
    let maxStability = 'low';

    const getConsumerCount = this.db.prepare(
      'SELECT COUNT(DISTINCT source_file) as cnt FROM dependencies WHERE target_file = ?'
    );
    const getTransitive = this.db.prepare(`
      SELECT DISTINCT d2.source_file
      FROM dependencies d1
      JOIN dependencies d2 ON d2.target_file = d1.source_file
      WHERE d1.target_file = ?
    `);
    const getExported = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM symbols WHERE file = ? AND exported = 1'
    );
    const getFileModule = this.db.prepare('SELECT module FROM files WHERE path = ?');
    const getModuleStability = this.db.prepare('SELECT stability FROM modules WHERE name = ?');

    for (const fp of filePaths) {
      const cCount = getConsumerCount.get(fp);
      if (cCount) totalConsumers += cCount.cnt;

      const tResults = getTransitive.all(fp);
      totalTransitive += tResults.length;

      const eCount = getExported.get(fp);
      if (eCount) totalExported += eCount.cnt;

      const fileRow = getFileModule.get(fp);
      if (fileRow) {
        modulesAffected.add(fileRow.module);
        const modStab = getModuleStability.get(fileRow.module);
        if (modStab) {
          const stabOrder = { high: 3, medium: 2, low: 1 };
          if (stabOrder[modStab.stability] > (stabOrder[maxStability] || 0)) {
            maxStability = modStab.stability;
          }
        }
      }

      if (fileRow) {
        const consumers = this.db.prepare(`
          SELECT DISTINCT f.module FROM dependencies d
          JOIN files f ON d.source_file = f.path
          WHERE d.target_file = ? AND f.module != ?
        `).all(fp, fileRow.module);
        for (const c of consumers) {
          boundariesCrossed.add(`${fileRow.module} -> ${c.module}`);
        }
      }
    }

    return computeRisk({
      consumerCount: totalConsumers,
      transitiveCount: totalTransitive,
      exportedCount: totalExported,
      stability: maxStability,
      boundariesCrossed: boundariesCrossed.size,
    });
  }

  /**
   * Given a list of files to modify, return full context for agent consumption.
   * @param {string[]} filePaths
   */
  getContextForTask(filePaths) {
    this.open();

    const knownFiles = [];
    const unknownFiles = [];
    for (const fp of filePaths) {
      const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(fp);
      if (row) knownFiles.push(row);
      else unknownFiles.push(fp);
    }

    const directDeps = [];
    const depSet = new Set();
    for (const fp of filePaths) {
      const deps = this.db.prepare(`
        SELECT d.source_file, d.target_file, d.import_name, d.import_type, f.module, f.language
        FROM dependencies d
        JOIN files f ON d.target_file = f.path
        WHERE d.source_file = ?
      `).all(fp);
      for (const d of deps) {
        const key = `${d.source_file}|${d.target_file}|${d.import_name}`;
        if (!depSet.has(key)) {
          depSet.add(key);
          directDeps.push(d);
        }
      }
    }

    const consumers = [];
    const consumerSet = new Set();
    for (const fp of filePaths) {
      const cons = this.db.prepare(`
        SELECT d.source_file, d.target_file, d.import_name, d.import_type, f.module, f.language
        FROM dependencies d
        JOIN files f ON d.source_file = f.path
        WHERE d.target_file = ?
      `).all(fp);
      for (const c of cons) {
        if (!consumerSet.has(c.source_file)) {
          consumerSet.add(c.source_file);
          consumers.push(c);
        }
      }
    }

    const interfaces = [];
    for (const fp of filePaths) {
      const ifaces = this.db.prepare(`
        SELECT i.name, i.kind, i.file, i.consumer_count, i.contract_hash
        FROM interfaces i
        WHERE i.file = ?
        ORDER BY i.consumer_count DESC
      `).all(fp);
      interfaces.push(...ifaces);
    }

    const sourceModules = new Set();
    const targetModules = new Set();
    for (const f of knownFiles) sourceModules.add(f.module);

    const boundaries = [];
    for (const c of consumers) {
      if (!sourceModules.has(c.module)) {
        targetModules.add(c.module);
      }
    }
    for (const d of directDeps) {
      if (!sourceModules.has(d.module)) {
        targetModules.add(d.module);
      }
    }
    for (const src of sourceModules) {
      for (const tgt of targetModules) {
        boundaries.push({ source: src, target: tgt });
      }
    }

    const testFiles = [];
    const testSet = new Set();
    for (const fp of filePaths) {
      const dir = path.dirname(fp);
      const dirTests = this.db.prepare(`
        SELECT path, module FROM files
        WHERE is_test = 1 AND path LIKE ? || '%'
      `).all(dir);
      for (const t of dirTests) {
        if (!testSet.has(t.path)) { testSet.add(t.path); testFiles.push(t); }
      }

      const importingTests = this.db.prepare(`
        SELECT f.path, f.module
        FROM dependencies d
        JOIN files f ON d.source_file = f.path
        WHERE d.target_file = ? AND f.is_test = 1
      `).all(fp);
      for (const t of importingTests) {
        if (!testSet.has(t.path)) { testSet.add(t.path); testFiles.push(t); }
      }
    }

    const allModules = new Set([...sourceModules, ...targetModules]);
    const capabilityMap = {};
    for (const mod of allModules) {
      const caps = this.db.prepare(`
        SELECT capability, confidence FROM module_capabilities
        WHERE module_name = ? AND confidence >= 0.2
        ORDER BY confidence DESC
      `).all(mod);
      if (caps.length > 0) capabilityMap[mod] = caps;
    }

    const risk = this.getRiskAssessment(filePaths);

    return {
      files: knownFiles,
      unknownFiles,
      directDependencies: directDeps,
      consumers,
      interfaces,
      moduleBoundaries: boundaries,
      testFiles,
      capabilities: capabilityMap,
      risk,
      summary: {
        filesAnalyzed: filePaths.length,
        knownFiles: knownFiles.length,
        unknownFiles: unknownFiles.length,
        directDependencyCount: directDeps.length,
        consumerCount: consumers.length,
        interfaceCount: interfaces.length,
        boundariesCrossed: boundaries.length,
        testFileCount: testFiles.length,
        riskLevel: risk.level,
      },
    };
  }

  // ============================================================
  // Call Graph, Class Hierarchy & Dead Code Queries
  // ============================================================

  /**
   * Get all callers of a symbol.
   * @param {string} symbolName
   * @param {string} [file] - Optional file to disambiguate.
   */
  getCallersOf(symbolName, file) {
    this.open();
    let sql = `
      SELECT cg.caller_symbol_id, cg.callee_name, cg.callee_file, cg.call_site_line, cg.call_type, cg.resolved,
             s.name AS caller_name, s.kind AS caller_kind, s.file AS caller_file,
             f.module AS caller_module
      FROM call_graph cg
      JOIN symbols s ON cg.caller_symbol_id = s.id
      JOIN files f ON s.file = f.path
      WHERE cg.callee_name = ?
    `;
    const params = [symbolName];
    if (file) { sql += ' AND cg.callee_file = ?'; params.push(file); }
    sql += ' ORDER BY f.module, s.file, cg.call_site_line';
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get all callees of a symbol.
   * @param {string} symbolName
   * @param {string} [file] - Optional file to disambiguate.
   */
  getCalleesOf(symbolName, file) {
    this.open();
    let sql = `
      SELECT cg.callee_name, cg.callee_file, cg.call_site_line, cg.call_type, cg.resolved,
             s.name AS caller_name, s.kind AS caller_kind, s.file AS caller_file,
             f.module AS caller_module
      FROM call_graph cg
      JOIN symbols s ON cg.caller_symbol_id = s.id
      JOIN files f ON s.file = f.path
      WHERE s.name = ?
    `;
    const params = [symbolName];
    if (file) { sql += ' AND s.file = ?'; params.push(file); }
    sql += ' ORDER BY cg.callee_name, cg.call_site_line';
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get class hierarchy for a symbol (parents and children).
   * @param {string} symbolName
   */
  getClassHierarchy(symbolName) {
    this.open();
    // Find parents (what this class extends/implements)
    const parents = this.db.prepare(`
      SELECT ch.parent_name, ch.parent_file, ch.relation, ch.resolved,
             s.name AS child_name, s.file AS child_file,
             f.module AS child_module
      FROM class_hierarchy ch
      JOIN symbols s ON ch.child_id = s.id
      JOIN files f ON s.file = f.path
      WHERE s.name = ?
      ORDER BY ch.relation, ch.parent_name
    `).all(symbolName);

    // Find children (what extends/implements this class)
    const children = this.db.prepare(`
      SELECT ch.parent_name, ch.parent_file, ch.relation, ch.resolved,
             s.name AS child_name, s.file AS child_file,
             f.module AS child_module
      FROM class_hierarchy ch
      JOIN symbols s ON ch.child_id = s.id
      JOIN files f ON s.file = f.path
      WHERE ch.parent_name = ?
      ORDER BY ch.relation, s.name
    `).all(symbolName);

    return { symbol: symbolName, parents, children };
  }

  /**
   * Get detected dead code, optionally filtered by module.
   * @param {string} [moduleName]
   */
  getDeadCode(moduleName) {
    this.open();
    let sql = `
      SELECT dc.symbol_id, dc.reason, dc.confidence, dc.detected_at,
             s.name, s.kind, s.file, s.line_start, s.line_end,
             f.module
      FROM dead_code dc
      JOIN symbols s ON dc.symbol_id = s.id
      JOIN files f ON s.file = f.path
    `;
    const params = [];
    if (moduleName) { sql += ' WHERE f.module = ?'; params.push(moduleName); }
    sql += ' ORDER BY dc.confidence DESC, f.module, s.file, s.line_start';
    return this.db.prepare(sql).all(...params);
  }

  // ============================================================
  // New Programmatic API — getCycles, getOverview, getGraphDiff
  // ============================================================

  /**
   * Get circular dependencies (convenience wrapper).
   * @returns {{ cycles: Array<string[]>, count: number, byModule: object }}
   */
  getCycles() {
    this.open();
    const cycles = this.circularDependencies();

    // Group cycles by module pairs
    const byModule = {};
    for (const cycle of cycles) {
      const modules = new Set();
      for (const fp of cycle) {
        const row = this.db.prepare('SELECT module FROM files WHERE path = ?').get(fp);
        if (row) modules.add(row.module);
      }
      const key = [...modules].sort().join(' <-> ');
      if (!byModule[key]) byModule[key] = [];
      byModule[key].push(cycle);
    }

    return { cycles, count: cycles.length, byModule };
  }

  /**
   * Get high-level repository overview (convenience wrapper).
   * @returns {object} Full overview with summary stats, languages, modules, hotspots, capabilities
   */
  getOverview() {
    return this.summary();
  }

  /**
   * Compare current graph against a baseline database.
   * @param {string} baseDbPath - Path to the baseline graph.db to compare against.
   * @returns {{ files: object, symbols: object, modules: object, interfaces: object, summary: object }}
   */
  getGraphDiff(baseDbPath) {
    this.open();
    if (!fs.existsSync(baseDbPath)) {
      throw new Error(`Baseline database not found: ${baseDbPath}`);
    }

    const Database = require('better-sqlite3');
    const baseDb = new Database(baseDbPath, { readonly: true });

    try {
      // --- File diff ---
      const currentFiles = new Map();
      for (const f of this.db.prepare('SELECT path, module, language, loc, complexity_score FROM files').all()) {
        currentFiles.set(f.path, f);
      }
      const baseFiles = new Map();
      for (const f of baseDb.prepare('SELECT path, module, language, loc, complexity_score FROM files').all()) {
        baseFiles.set(f.path, f);
      }

      const filesAdded = [];
      const filesRemoved = [];
      const filesModified = [];

      for (const [fp, info] of currentFiles) {
        if (!baseFiles.has(fp)) {
          filesAdded.push(info);
        } else {
          const base = baseFiles.get(fp);
          if (base.loc !== info.loc || base.complexity_score !== info.complexity_score || base.module !== info.module) {
            filesModified.push({
              path: fp,
              module: info.module,
              language: info.language,
              loc: { before: base.loc, after: info.loc, delta: info.loc - base.loc },
              complexity: { before: base.complexity_score, after: info.complexity_score, delta: info.complexity_score - base.complexity_score },
            });
          }
        }
      }
      for (const [fp, info] of baseFiles) {
        if (!currentFiles.has(fp)) {
          filesRemoved.push(info);
        }
      }

      // --- Symbol diff ---
      const currentSymCount = this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt;
      const baseSymCount = baseDb.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt;

      const currentExported = this.db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE exported = 1').get().cnt;
      const baseExported = baseDb.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE exported = 1').get().cnt;

      // Find new/removed exported symbols
      const currentExpSyms = new Set();
      for (const s of this.db.prepare('SELECT name, file FROM symbols WHERE exported = 1').all()) {
        currentExpSyms.add(`${s.file}::${s.name}`);
      }
      const baseExpSyms = new Set();
      for (const s of baseDb.prepare('SELECT name, file FROM symbols WHERE exported = 1').all()) {
        baseExpSyms.add(`${s.file}::${s.name}`);
      }

      const symbolsAdded = [...currentExpSyms].filter(s => !baseExpSyms.has(s)).map(s => {
        const [file, name] = s.split('::');
        return { name, file };
      });
      const symbolsRemoved = [...baseExpSyms].filter(s => !currentExpSyms.has(s)).map(s => {
        const [file, name] = s.split('::');
        return { name, file };
      });

      // --- Module diff ---
      const currentMods = new Map();
      for (const m of this.db.prepare('SELECT name, file_count, stability FROM modules').all()) {
        currentMods.set(m.name, m);
      }
      const baseMods = new Map();
      for (const m of baseDb.prepare('SELECT name, file_count, stability FROM modules').all()) {
        baseMods.set(m.name, m);
      }

      const modulesAdded = [...currentMods.keys()].filter(n => !baseMods.has(n));
      const modulesRemoved = [...baseMods.keys()].filter(n => !currentMods.has(n));
      const modulesChanged = [];
      for (const [name, info] of currentMods) {
        if (baseMods.has(name)) {
          const base = baseMods.get(name);
          if (base.file_count !== info.file_count || base.stability !== info.stability) {
            modulesChanged.push({
              name,
              fileCount: { before: base.file_count, after: info.file_count },
              stability: { before: base.stability, after: info.stability },
            });
          }
        }
      }

      // --- Interface / breaking change diff ---
      const breakingChanges = [];
      const currentIfaces = new Map();
      for (const i of this.db.prepare('SELECT name, file, contract_hash, consumer_count FROM interfaces').all()) {
        currentIfaces.set(`${i.file}::${i.name}`, i);
      }
      for (const i of baseDb.prepare('SELECT name, file, contract_hash, consumer_count FROM interfaces').all()) {
        const key = `${i.file}::${i.name}`;
        const curr = currentIfaces.get(key);
        if (curr && i.contract_hash && curr.contract_hash && i.contract_hash !== curr.contract_hash) {
          breakingChanges.push({
            name: i.name,
            file: i.file,
            hashBefore: i.contract_hash,
            hashAfter: curr.contract_hash,
            consumersBefore: i.consumer_count,
            consumersAfter: curr.consumer_count,
          });
        }
      }

      // --- Metadata ---
      const currentMeta = {};
      for (const r of this.db.prepare('SELECT key, value FROM graph_meta').all()) currentMeta[r.key] = r.value;
      const baseMeta = {};
      for (const r of baseDb.prepare('SELECT key, value FROM graph_meta').all()) baseMeta[r.key] = r.value;

      return {
        files: {
          added: filesAdded,
          removed: filesRemoved,
          modified: filesModified,
          summary: { added: filesAdded.length, removed: filesRemoved.length, modified: filesModified.length },
        },
        symbols: {
          added: symbolsAdded,
          removed: symbolsRemoved,
          totalBefore: baseSymCount,
          totalAfter: currentSymCount,
          exportedBefore: baseExported,
          exportedAfter: currentExported,
        },
        modules: {
          added: modulesAdded,
          removed: modulesRemoved,
          changed: modulesChanged,
        },
        interfaces: {
          breakingChanges,
        },
        meta: {
          current: currentMeta,
          base: baseMeta,
        },
        summary: {
          filesAdded: filesAdded.length,
          filesRemoved: filesRemoved.length,
          filesModified: filesModified.length,
          symbolsAdded: symbolsAdded.length,
          symbolsRemoved: symbolsRemoved.length,
          symbolDelta: currentSymCount - baseSymCount,
          modulesAdded: modulesAdded.length,
          modulesRemoved: modulesRemoved.length,
          breakingChanges: breakingChanges.length,
        },
      };
    } finally {
      baseDb.close();
    }
  }
}

// ============================================================
// Risk Computation (shared helper)
// ============================================================

function computeRisk({ consumerCount, transitiveCount, exportedCount, stability, boundariesCrossed }) {
  let score = 0;
  const reasons = [];

  if (consumerCount > 10) { score += 4; reasons.push(`${consumerCount} direct consumers`); }
  else if (consumerCount > 5) { score += 3; reasons.push(`${consumerCount} direct consumers`); }
  else if (consumerCount > 2) { score += 2; reasons.push(`${consumerCount} direct consumers`); }
  else if (consumerCount > 0) { score += 1; reasons.push(`${consumerCount} direct consumer(s)`); }

  if (transitiveCount > 20) { score += 3; reasons.push(`${transitiveCount} transitive dependents`); }
  else if (transitiveCount > 5) { score += 2; reasons.push(`${transitiveCount} transitive dependents`); }
  else if (transitiveCount > 0) { score += 1; reasons.push(`${transitiveCount} transitive dependent(s)`); }

  if (stability === 'high') { score += 2; reasons.push('stable module (changes cascade widely)'); }
  else if (stability === 'medium') { score += 1; }

  if (boundariesCrossed > 2) { score += 2; reasons.push(`crosses ${boundariesCrossed} module boundaries`); }
  else if (boundariesCrossed > 0) { score += 1; reasons.push(`crosses ${boundariesCrossed} module boundary`); }

  if (exportedCount > 5) { score += 1; reasons.push(`${exportedCount} exported symbols at risk`); }

  let level;
  if (score >= 8) level = 'CRITICAL';
  else if (score >= 5) level = 'HIGH';
  else if (score >= 3) level = 'MEDIUM';
  else level = 'LOW';

  return { level, score, reasons };
}

// ============================================================
// CLI — Formatted Output Helpers
// ============================================================

function drawBox(title, width = 60) {
  const b = theme.box;
  const titleStr = ` ${title} `;
  const pad = Math.max(0, width - titleStr.length - 2);
  console.log(theme.dim(`  ${b.tl}${b.h} `) + theme.heading(title) + theme.dim(` ${b.h.repeat(pad)}${b.tr}`));
}

function drawBoxEnd(width = 60) {
  const b = theme.box;
  console.log(theme.dim(`  ${b.bl}${b.h.repeat(width)}${b.br}`));
}

function drawSection(title) {
  const b = theme.box;
  console.log(theme.dim(`  ${b.t}${b.h} `) + theme.subhead(title));
}

function drawLine(text, indent = 1) {
  const b = theme.box;
  const pad = '  '.repeat(indent);
  console.log(theme.dim(`  ${b.v}`) + `${pad}${text}`);
}

function formatImpactExplain(impact) {
  const lines = [];
  const fileInfo = impact.fileInfo;
  const modInfo = impact.moduleInfo;
  const modLabel = fileInfo ? fileInfo.module : 'unknown';
  const stability = modInfo ? modInfo.stability.toUpperCase() : 'UNKNOWN';

  lines.push(`  ${theme.file(impact.file)} ${theme.dim('(')}${theme.module(modLabel)} module ${theme.dim('\u2014')} ${theme.stability(stability.toLowerCase())} stability${theme.dim(')')}`);

  if (impact.exported.length > 0) {
    const exList = impact.exported.map(e => `${theme.symbol(e.name)} ${theme.dim(`(${e.kind})`)}`).join(', ');
    lines.push(`  \u251c\u2500\u2500 ${theme.subhead('EXPORTED')}: ${exList}`);
  }

  if (impact.directConsumers.length > 0) {
    lines.push(`  \u251c\u2500\u2500 ${theme.subhead('DIRECT CONSUMERS')} ${theme.dim(`(${impact.directConsumers.length} file${impact.directConsumers.length !== 1 ? 's' : ''})`)}`);
    for (let i = 0; i < impact.directConsumers.length; i++) {
      const c = impact.directConsumers[i];
      const connector = (i === impact.directConsumers.length - 1) ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500';
      lines.push(`  \u2502   ${connector} ${theme.file(c.source_file)} ${theme.dim('\u2014 imports')} ${theme.symbol(c.import_name)}`);
    }
  } else {
    lines.push(`  \u251c\u2500\u2500 ${theme.subhead('DIRECT CONSUMERS')}: ${theme.dim('(none)')}`);
  }

  if (impact.transitiveImpact.length > 0) {
    lines.push(`  \u251c\u2500\u2500 ${theme.subhead('TRANSITIVE IMPACT')} ${theme.dim(`(${impact.transitiveImpact.length} file${impact.transitiveImpact.length !== 1 ? 's' : ''})`)}`);
    const byDepth = {};
    for (const t of impact.transitiveImpact) {
      if (!byDepth[t.depth]) byDepth[t.depth] = [];
      byDepth[t.depth].push(t);
    }
    for (const depth of Object.keys(byDepth).sort()) {
      const items = byDepth[depth];
      for (let i = 0; i < Math.min(items.length, 10); i++) {
        const t = items[i];
        const connector = (i === items.length - 1 || i === 9) ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500';
        lines.push(`  \u2502   ${connector} ${theme.file(t.source_file)} ${theme.dim(`(via ${t.via})`)}`);
      }
      if (items.length > 10) {
        lines.push(`  \u2502       ${theme.dim(`... and ${items.length - 10} more at depth ${depth}`)}`);
      }
    }
  }

  if (impact.moduleBoundaries.length > 0) {
    lines.push(`  \u251c\u2500\u2500 ${theme.subhead('BOUNDARIES CROSSED')}: ${impact.moduleBoundaries.map(b => theme.warn(b)).join(', ')}`);
  }

  const risk = impact.risk;
  const riskReasons = risk.reasons.length > 0 ? ` ${theme.dim(`(${risk.reasons.join(', ')})`)}` : '';
  lines.push(`  \u251c\u2500\u2500 ${theme.subhead('RISK')}: ${theme.risk(risk.level)}${riskReasons}`);

  if (impact.capabilities.length > 0) {
    const capList = impact.capabilities.map(c => theme.module(c.capability)).join(', ');
    lines.push(`  \u2514\u2500\u2500 ${theme.subhead('CAPABILITIES')}: [${capList}]`);
  } else {
    lines.push(`  \u2514\u2500\u2500 ${theme.subhead('CAPABILITIES')}: ${theme.dim('(none detected)')}`);
  }

  return lines.join('\n');
}

function formatTable(rows, columns, opts = {}) {
  if (rows.length === 0) {
    console.log(theme.dim('  (no results)'));
    return;
  }

  const widths = {};
  for (const col of columns) {
    widths[col.key] = col.label.length;
    for (const row of rows) {
      const val = String(row[col.key] ?? '');
      widths[col.key] = Math.max(widths[col.key], val.length);
    }
    widths[col.key] = Math.min(widths[col.key], col.maxWidth || 60);
  }

  const header = columns.map(col => chalk.bold(col.label.padEnd(widths[col.key]))).join(theme.dim('  '));
  console.log(`  ${header}`);
  console.log(theme.dim(`  ${columns.map(col => '\u2500'.repeat(widths[col.key])).join('  ')}`));

  for (const row of rows) {
    const line = columns.map(col => {
      let val = String(row[col.key] ?? '');
      if (val.length > (col.maxWidth || 60)) val = val.slice(0, (col.maxWidth || 60) - 3) + '...';
      const padded = val.padEnd(widths[col.key]);

      // Apply color based on column semantics
      if (col.color) return col.color(padded);
      if (col.key === 'path' || col.key === 'file' || col.key === 'source_file' || col.key === 'target_file') return theme.file(padded);
      if (col.key === 'module' || col.key === 'module_name' || col.key === 'source_module' || col.key === 'target_module') return theme.module(padded);
      if (col.key === 'name' && (col.label === 'Symbol' || col.label === 'Name')) return theme.symbol(padded);
      if (col.key === 'stability') return theme.stability(val).padEnd(widths[col.key]);
      if (col.key === 'risk_score' || col.key === 'complexity_score') return theme.warn(padded);
      if (col.key === 'loc' || col.key === 'consumer_count' || col.key === 'edge_count' || col.key === 'line_start') return theme.number(padded);
      if (col.key === 'confidence') {
        const num = parseFloat(val);
        if (num >= 0.7) return chalk.green(padded);
        if (num >= 0.4) return chalk.yellow(padded);
        return chalk.red(padded);
      }
      if (col.key === 'changes_7d' || col.key === 'changes_30d' || col.key === 'changes_90d') return theme.number(padded);
      if (col.key === 'severity') {
        if (val === 'critical') return chalk.red.bold(padded);
        if (val === 'warning') return chalk.yellow(padded);
        return theme.dim(padded);
      }
      if (col.key === 'exported') {
        return val === '1' ? chalk.green(padded) : theme.dim(padded);
      }
      return padded;
    }).join(theme.dim('  '));
    console.log(`  ${line}`);
  }
}

// ============================================================
// CLI Interface
// ============================================================

function printHelp() {
  console.log(`
  ${theme.heading('Forge Graph Engine')} ${theme.dim('\u2014 Query Interface')}

  ${theme.subhead('Usage:')} forge-graph <command> [options]

  ${theme.subhead('Commands:')}
    ${chalk.bold('show')} <path>                    Rich file detail view
    ${chalk.bold('overview')}                       Repository overview with stats
    ${chalk.bold('impact')} <file> [--depth N]      Impact analysis (default depth 2)
    ${chalk.bold('hotspots')} [--top N]             Risk hotspots (complexity x churn)
    ${chalk.bold('cycles')}                         Find circular dependencies
    ${chalk.bold('capabilities')} [module]          Detected capabilities
    ${chalk.bold('diff')} --base <path>             Compare against baseline graph.db
    ${chalk.bold('callers')} <symbol> [file]        Who calls this symbol
    ${chalk.bold('callees')} <symbol> [file]        What does this symbol call
    ${chalk.bold('hierarchy')} <class>              Class extends/implements tree
    ${chalk.bold('dead-code')} [module]             Potentially unused code

    ${chalk.bold('files')} [--module M] [--lang L]  List files
    ${chalk.bold('file')} <path>                    File details with symbols
    ${chalk.bold('symbols')} <pattern>              Search symbols (LIKE pattern)
    ${chalk.bold('module')} <name>                  Module details
    ${chalk.bold('modules')}                        List all modules
    ${chalk.bold('search')} <symbol-name>           Find symbol across codebase
    ${chalk.bold('consumers')} <file>               All consumers of a file
    ${chalk.bold('boundaries')}                     Inter-module dependency map
    ${chalk.bold('churn')} [--limit N]              Highest change frequency
    ${chalk.bold('dep-chain')} <path> [--depth N]   Forward dependency chain
    ${chalk.bold('interfaces')} [--limit N]         Most-consumed interfaces
    ${chalk.bold('context-for-task')} <f1> <f2>...  Full context (JSON)
    ${chalk.bold('warnings')} [--severity S]        List warnings
    ${chalk.bold('meta')}                           Build metadata

  ${theme.subhead('Options:')}
    --db <path>    Path to graph database ${theme.dim('(default: .forge/graph.db)')}
    --json         Output as JSON
    --explain      Tree output ${theme.dim('(for impact command)')}
    --help         Show this help
`);
}

function run() {
  const args = process.argv.slice(2);

  // Apply display.rich_output config
  applyRichOutputConfig(process.cwd());

  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const jsonMode = args.includes('--json');
  const explainMode = args.includes('--explain');
  const dbPath = args.includes('--db')
    ? args[args.indexOf('--db') + 1]
    : path.join(process.cwd(), '.forge', 'graph.db');

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const flagsWithValues = new Set(['--db', '--depth', '--top', '--limit', '--module', '--lang', '--kind', '--severity', '--base']);
  const flagsNoValue = new Set(['--json', '--explain', '--help', '--exported', '--tests', '--no-tests']);
  const positionalArgs = [];
  for (let i = 1; i < args.length; i++) {
    if (flagsWithValues.has(args[i])) { i++; continue; }
    if (flagsNoValue.has(args[i])) continue;
    if (args[i].startsWith('--')) { continue; }
    positionalArgs.push(args[i]);
  }

  const q = new GraphQuery(dbPath);

  try {
    q.open();
  } catch (err) {
    console.error(theme.error(`  Error: ${err.message}`));
    process.exit(1);
  }

  try {
    let result;

    switch (command) {

      // ===== show (rich file detail) =====
      case 'show': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        const fileInfo = q.file(filePath);
        if (!fileInfo) { console.error(theme.error(`  Error: file not found: ${filePath}`)); process.exit(1); }

        const syms = q.symbolsInFile(filePath);
        const imports = q.importsOf(filePath);
        const importers = q.importedBy(filePath);
        const churn = q.db.prepare('SELECT * FROM change_frequency WHERE file = ?').get(filePath);
        const ifaces = q.db.prepare('SELECT * FROM interfaces WHERE file = ? ORDER BY consumer_count DESC').all(filePath);

        result = { ...fileInfo, symbols: syms, imports, importedBy: importers, changeFrequency: churn, interfaces: ifaces };

        if (jsonMode) break;

        console.log('');
        drawBox(filePath);
        drawLine(`${theme.label('Module:')}  ${theme.module(fileInfo.module)}    ${theme.label('Language:')} ${theme.value(fileInfo.language)}    ${theme.label('LOC:')} ${theme.number(fileInfo.loc)}`);
        drawLine(`${theme.label('Complexity:')} ${theme.warn(String(fileInfo.complexity_score))}    ${theme.label('Test:')} ${fileInfo.is_test ? theme.warn('yes') : theme.dim('no')}    ${theme.label('Config:')} ${fileInfo.is_config ? theme.warn('yes') : theme.dim('no')}`);

        if (churn) {
          drawLine(`${theme.label('Churn:')} ${theme.number(churn.changes_7d)}${theme.dim('/7d')}  ${theme.number(churn.changes_30d)}${theme.dim('/30d')}  ${theme.number(churn.changes_90d)}${theme.dim('/90d')}    ${theme.label('Last changed:')} ${theme.dim(churn.last_changed || 'unknown')}`);
        }

        if (syms.length > 0) {
          drawSection(`Symbols (${syms.length})`);
          const exported = syms.filter(s => s.exported);
          const internal = syms.filter(s => !s.exported);

          for (const s of exported) {
            const sig = s.signature ? theme.dim(` ${s.signature}`) : '';
            drawLine(`${chalk.green('\u25cf')} ${theme.symbol(s.name)}  ${theme.dim(s.kind)}  ${theme.dim('L:' + s.line_start)}  ${chalk.green('exported')}${sig}`);
          }
          for (const s of internal) {
            const sig = s.signature ? theme.dim(` ${s.signature}`) : '';
            drawLine(`${theme.dim('\u25cb')} ${theme.value(s.name)}  ${theme.dim(s.kind)}  ${theme.dim('L:' + s.line_start)}${sig}`);
          }
        }

        if (ifaces.length > 0) {
          drawSection(`Interfaces (${ifaces.length})`);
          for (const iface of ifaces) {
            drawLine(`${chalk.green('\u25b6')} ${theme.symbol(iface.name)}  ${theme.dim(iface.kind)}  ${theme.label('consumers:')} ${theme.number(iface.consumer_count)}  ${theme.dim('hash:' + (iface.contract_hash || 'none').slice(0, 8))}`);
          }
        }

        if (imports.length > 0) {
          drawSection(`Imports (${imports.length})`);
          for (const imp of imports) {
            drawLine(`${chalk.cyan('\u2192')} ${theme.file(imp.target_file)}  ${theme.dim(imp.import_type)}  ${theme.symbol(imp.import_name)}`);
          }
        }

        if (importers.length > 0) {
          drawSection(`Imported By (${importers.length})`);
          for (const imp of importers) {
            drawLine(`${chalk.magenta('\u2190')} ${theme.file(imp.source_file)}  ${theme.dim(imp.import_type)}  ${theme.symbol(imp.import_name)}`);
          }
        }

        drawBoxEnd();
        console.log('');
        break;
      }

      // ===== overview (rich repository summary) =====
      case 'overview':
      case 'summary': {
        result = q.summary();
        if (jsonMode) break;

        const s = result;
        const totalLoc = s.languages.reduce((sum, l) => sum + (l.total_loc || 0), 0);
        const maxLoc = s.languages.length > 0 ? s.languages[0].total_loc : 1;

        console.log('');
        drawBox('Forge Code Graph');
        drawLine(`${theme.label('Built:')} ${theme.dim(s.meta.built_at || s.meta.updated_at || 'unknown')}    ${theme.label('Commit:')} ${theme.dim((s.meta.last_build_commit || 'unknown').slice(0, 8))}`);
        drawLine(`${theme.label('Files:')} ${theme.number(s.meta.file_count || 0)}  ${theme.label('Symbols:')} ${theme.number(s.meta.symbol_count || 0)}  ${theme.label('Deps:')} ${theme.number(s.meta.dependency_count || 0)}  ${theme.label('Modules:')} ${theme.number(s.meta.module_count || 0)}`);
        drawLine(`${theme.label('Total LOC:')} ${theme.number(totalLoc)}`);

        if (s.languages.length > 0) {
          drawSection('Languages');
          for (const lang of s.languages) {
            const ratio = maxLoc > 0 ? (lang.total_loc || 0) / maxLoc : 0;
            const pct = totalLoc > 0 ? Math.round(((lang.total_loc || 0) / totalLoc) * 100) : 0;
            drawLine(`${theme.value(String(lang.language).padEnd(15))} ${String(lang.files).padStart(4)} files  ${String(lang.total_loc).padStart(7)} LOC  ${theme.bar(ratio, 16)} ${theme.dim(`${pct}%`)}`);
          }
        }

        if (s.modules.length > 0) {
          drawSection('Modules');
          for (const mod of s.modules) {
            const caps = mod.capabilities.length > 0 ? ` ${theme.dim('[')}${mod.capabilities.map(c => theme.module(c)).join(theme.dim(', '))}${theme.dim(']')}` : '';
            drawLine(`${theme.module(mod.name.padEnd(25))} ${theme.number(String(mod.files).padStart(4))} files  stability=${theme.stability(mod.stability)}${caps}`);
          }
        }

        if (s.hotspots.length > 0) {
          drawSection('Top Risk Hotspots');
          for (const h of s.hotspots.slice(0, 5)) {
            const riskVal = typeof h.risk_score === 'number' ? h.risk_score.toFixed(1) : h.risk_score;
            drawLine(`${theme.file(String(h.path).padEnd(45).slice(0, 45))} LOC:${theme.number(h.loc)}  C:${theme.warn(h.complexity_score)}  Risk:${theme.warn(riskVal)}`);
          }
        }

        if (Object.keys(s.capabilities).length > 0) {
          drawSection('Capabilities');
          for (const [cap, mods] of Object.entries(s.capabilities)) {
            drawLine(`${theme.symbol(cap.padEnd(25))} ${mods.map(m => theme.module(m)).join(theme.dim(', '))}`);
          }
        }

        drawBoxEnd();
        console.log('');
        q.close();
        return;
      }

      // ===== impact =====
      case 'impact': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        const depth = parseInt(getArg('--depth', '2'));
        result = q.getImpact(filePath, { depth });

        if (explainMode) {
          console.log('');
          console.log(formatImpactExplain(result));
          console.log('');
          q.close();
          return;
        }

        if (jsonMode) break;

        console.log('');
        drawBox(`Impact: ${filePath}`);
        if (result.fileInfo) {
          drawLine(`${theme.label('Module:')} ${theme.module(result.fileInfo.module)}    ${theme.label('Stability:')} ${theme.stability(result.moduleInfo ? result.moduleInfo.stability : 'unknown')}`);
        }
        drawLine(`${theme.label('Risk:')} ${theme.risk(result.risk.level)} ${theme.dim(`(score ${result.risk.score})`)}`);
        if (result.risk.reasons.length > 0) {
          drawLine(`${theme.label('Reasons:')} ${result.risk.reasons.map(r => theme.dim(r)).join(theme.dim('; '))}`);
        }
        drawLine(`${theme.label('Total affected:')} ${theme.number(result.totalAffected)} file(s)`);

        if (result.exported.length > 0) {
          drawSection(`Exported Symbols (${result.exported.length})`);
          for (const e of result.exported) {
            const consumers = e.consumer_count != null ? `  ${theme.label('consumers:')} ${theme.number(e.consumer_count)}` : '';
            drawLine(`${chalk.green('\u25cf')} ${theme.symbol(e.name)}  ${theme.dim(e.kind)}${consumers}`);
          }
        }

        if (result.directConsumers.length > 0) {
          drawSection(`Direct Consumers (${result.directConsumers.length})`);
          formatTable(result.directConsumers, [
            { key: 'source_file', label: 'File', maxWidth: 45 },
            { key: 'module', label: 'Module', maxWidth: 20 },
            { key: 'import_name', label: 'Import', maxWidth: 25 },
          ]);
        }

        if (result.transitiveImpact.length > 0) {
          drawSection(`Transitive Impact (${result.transitiveImpact.length})`);
          formatTable(result.transitiveImpact.slice(0, 30), [
            { key: 'source_file', label: 'File', maxWidth: 40 },
            { key: 'module', label: 'Module', maxWidth: 15 },
            { key: 'via', label: 'Via', maxWidth: 25 },
            { key: 'depth', label: 'Depth' },
          ]);
          if (result.transitiveImpact.length > 30) {
            console.log(theme.dim(`    ... and ${result.transitiveImpact.length - 30} more`));
          }
        }

        if (result.moduleBoundaries.length > 0) {
          drawLine(`${theme.label('Boundaries Crossed:')} ${result.moduleBoundaries.map(b => theme.warn(b)).join(', ')}`);
        }
        if (result.capabilities.length > 0) {
          drawLine(`${theme.label('Capabilities:')} ${result.capabilities.map(c => theme.module(c.capability)).join(', ')}`);
        }

        drawBoxEnd();
        console.log('');
        break;
      }

      // ===== hotspots =====
      case 'hotspots': {
        const limit = parseInt(getArg('--top', getArg('--limit', '20')));
        result = q.getHotspots({ top: limit });

        if (jsonMode) break;

        console.log('');
        drawBox('Risk Hotspots');
        drawLine(theme.dim('Ranked by complexity \u00d7 churn'));
        console.log('');
        formatTable(result, [
          { key: 'path', label: 'File', maxWidth: 45 },
          { key: 'module', label: 'Module', maxWidth: 15 },
          { key: 'loc', label: 'LOC' },
          { key: 'complexity_score', label: 'Complexity' },
          { key: 'changes_30d', label: 'Churn(30d)' },
          { key: 'risk_score', label: 'Risk' },
        ]);
        drawBoxEnd();
        console.log('');
        break;
      }

      // ===== cycles / circles =====
      case 'cycles':
      case 'circles': {
        result = q.getCycles();

        if (jsonMode) break;

        console.log('');
        if (result.count === 0) {
          drawBox('Circular Dependencies');
          drawLine(theme.success('No circular dependencies found.'));
          drawBoxEnd();
        } else {
          drawBox(`Circular Dependencies (${result.count})`);

          // Show by module grouping
          const moduleGroups = Object.entries(result.byModule);
          if (moduleGroups.length > 0) {
            for (const [group, cycles] of moduleGroups) {
              drawSection(`${group} (${cycles.length} cycle${cycles.length !== 1 ? 's' : ''})`);
              for (let i = 0; i < Math.min(cycles.length, 5); i++) {
                const cycle = cycles[i];
                const formatted = cycle.map((fp, idx) => {
                  return idx === cycle.length - 1 ? theme.error(fp) : theme.file(fp);
                }).join(theme.dim(' \u2192 '));
                drawLine(formatted);
              }
              if (cycles.length > 5) {
                drawLine(theme.dim(`... and ${cycles.length - 5} more in this group`));
              }
            }
          }

          drawBoxEnd();
        }
        console.log('');
        break;
      }

      // ===== capabilities =====
      case 'capabilities': {
        const modName = positionalArgs[0];

        if (modName) {
          result = q.getCapabilities(modName);
          if (jsonMode) break;

          console.log('');
          drawBox(`Capabilities: ${modName}`);
          if (result.length > 0) {
            for (const cap of result) {
              const conf = parseFloat(cap.confidence);
              const confBar = theme.bar(conf, 10);
              const confPct = `${Math.round(conf * 100)}%`;
              const confColor = conf >= 0.7 ? chalk.green : conf >= 0.4 ? chalk.yellow : chalk.red;
              drawLine(`${theme.symbol(cap.capability.padEnd(25))} ${confBar} ${confColor(confPct.padStart(4))}  ${theme.dim(cap.evidence || '')}`);
            }
          } else {
            drawLine(theme.dim('No capabilities detected.'));
          }
          drawBoxEnd();
        } else {
          result = q.capabilities();
          if (jsonMode) break;

          console.log('');
          drawBox('All Capabilities');

          // Group by capability
          const grouped = new Map();
          for (const cap of result) {
            if (!grouped.has(cap.capability)) grouped.set(cap.capability, []);
            grouped.get(cap.capability).push(cap);
          }

          for (const [capName, entries] of grouped) {
            drawSection(capName);
            for (const entry of entries) {
              const conf = parseFloat(entry.confidence);
              const confPct = `${Math.round(conf * 100)}%`;
              const confColor = conf >= 0.7 ? chalk.green : conf >= 0.4 ? chalk.yellow : chalk.red;
              drawLine(`${theme.module(entry.module_name.padEnd(20))} ${confColor(confPct.padStart(4))}  ${theme.dim(entry.evidence || '')}`);
            }
          }

          if (result.length === 0) {
            drawLine(theme.dim('No capabilities detected.'));
          }
          drawBoxEnd();
        }
        console.log('');
        break;
      }

      // ===== diff =====
      case 'diff': {
        const baseDbPath = getArg('--base');
        if (!baseDbPath) {
          console.error(theme.error('  Error: --base <path> required (path to baseline graph.db)'));
          process.exit(1);
        }

        try {
          result = q.getGraphDiff(baseDbPath);
        } catch (err) {
          console.error(theme.error(`  Error: ${err.message}`));
          process.exit(1);
        }

        if (jsonMode) break;

        const s = result.summary;
        console.log('');
        drawBox('Graph Diff');
        drawLine(`${theme.label('Current:')} ${theme.dim(dbPath)} ${theme.dim(`(${result.meta.current.file_count || '?'} files)`)}`);
        drawLine(`${theme.label('Base:')}    ${theme.dim(baseDbPath)} ${theme.dim(`(${result.meta.base.file_count || '?'} files)`)}`);

        // File summary
        drawSection(`Files  ${chalk.green(`+${s.filesAdded}`)} added  ${chalk.red(`-${s.filesRemoved}`)} removed  ${chalk.yellow(`~${s.filesModified}`)} modified`);

        if (result.files.added.length > 0) {
          for (const f of result.files.added.slice(0, 10)) {
            drawLine(`${chalk.green('+')} ${theme.file(f.path)}  ${theme.dim(`(${f.language}, ${f.loc} LOC)`)}`);
          }
          if (result.files.added.length > 10) drawLine(theme.dim(`... and ${result.files.added.length - 10} more added`));
        }

        if (result.files.removed.length > 0) {
          for (const f of result.files.removed.slice(0, 10)) {
            drawLine(`${chalk.red('-')} ${theme.file(f.path)}  ${theme.dim(`(${f.language}, ${f.loc} LOC)`)}`);
          }
          if (result.files.removed.length > 10) drawLine(theme.dim(`... and ${result.files.removed.length - 10} more removed`));
        }

        if (result.files.modified.length > 0) {
          for (const f of result.files.modified.slice(0, 10)) {
            const delta = f.loc.delta > 0 ? chalk.green(`+${f.loc.delta}`) : f.loc.delta < 0 ? chalk.red(String(f.loc.delta)) : theme.dim('0');
            drawLine(`${chalk.yellow('~')} ${theme.file(f.path)}  LOC: ${theme.dim(f.loc.before)}\u2192${theme.number(f.loc.after)} (${delta})`);
          }
          if (result.files.modified.length > 10) drawLine(theme.dim(`... and ${result.files.modified.length - 10} more modified`));
        }

        // Symbol summary
        const symDelta = s.symbolDelta > 0 ? chalk.green(`+${s.symbolDelta}`) : s.symbolDelta < 0 ? chalk.red(String(s.symbolDelta)) : theme.dim('0');
        drawSection(`Symbols  ${theme.dim(result.symbols.totalBefore)}\u2192${theme.number(result.symbols.totalAfter)} (${symDelta})  exported: ${theme.dim(result.symbols.exportedBefore)}\u2192${theme.number(result.symbols.exportedAfter)}`);

        if (result.symbols.added.length > 0) {
          for (const s of result.symbols.added.slice(0, 5)) {
            drawLine(`${chalk.green('+')} ${theme.symbol(s.name)}  ${theme.dim(s.file)}`);
          }
          if (result.symbols.added.length > 5) drawLine(theme.dim(`... and ${result.symbols.added.length - 5} more`));
        }
        if (result.symbols.removed.length > 0) {
          for (const s of result.symbols.removed.slice(0, 5)) {
            drawLine(`${chalk.red('-')} ${theme.symbol(s.name)}  ${theme.dim(s.file)}`);
          }
          if (result.symbols.removed.length > 5) drawLine(theme.dim(`... and ${result.symbols.removed.length - 5} more`));
        }

        // Module summary
        if (result.modules.added.length > 0 || result.modules.removed.length > 0 || result.modules.changed.length > 0) {
          drawSection(`Modules  ${chalk.green(`+${result.modules.added.length}`)} added  ${chalk.red(`-${result.modules.removed.length}`)} removed  ${chalk.yellow(`~${result.modules.changed.length}`)} changed`);
          for (const m of result.modules.added) drawLine(`${chalk.green('+')} ${theme.module(m)}`);
          for (const m of result.modules.removed) drawLine(`${chalk.red('-')} ${theme.module(m)}`);
          for (const m of result.modules.changed) {
            drawLine(`${chalk.yellow('~')} ${theme.module(m.name)}  files: ${m.fileCount.before}\u2192${m.fileCount.after}  stability: ${theme.stability(m.stability.before)}\u2192${theme.stability(m.stability.after)}`);
          }
        }

        // Breaking changes
        if (result.interfaces.breakingChanges.length > 0) {
          drawSection(`${chalk.red.bold('Breaking Changes')} (${result.interfaces.breakingChanges.length})`);
          for (const bc of result.interfaces.breakingChanges) {
            drawLine(`${chalk.red('\u26a0')} ${theme.symbol(bc.name)}  ${theme.dim(bc.file)}  hash: ${theme.dim(bc.hashBefore.slice(0, 8))}\u2192${theme.warn(bc.hashAfter.slice(0, 8))}  consumers: ${theme.number(bc.consumersAfter)}`);
          }
        }

        drawBoxEnd();
        console.log('');
        break;
      }

      // ===== files =====
      case 'files': {
        result = q.files({
          module: getArg('--module'),
          language: getArg('--lang'),
          isTest: args.includes('--tests') ? true : args.includes('--no-tests') ? false : undefined,
          limit: parseInt(getArg('--limit', '50')),
        });
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'path', label: 'Path', maxWidth: 55 },
            { key: 'module', label: 'Module', maxWidth: 20 },
            { key: 'language', label: 'Lang' },
            { key: 'loc', label: 'LOC' },
            { key: 'complexity_score', label: 'Complexity' },
          ]);
          console.log('');
        }
        break;
      }

      // ===== file =====
      case 'file': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        const fileInfo = q.file(filePath);
        if (!fileInfo) { console.error(theme.error(`  Error: file not found: ${filePath}`)); process.exit(1); }

        const syms = q.symbolsInFile(filePath);
        const imports = q.importsOf(filePath);
        const importers = q.importedBy(filePath);

        result = { ...fileInfo, symbols: syms, imports, importedBy: importers };

        if (!jsonMode) {
          console.log(`\n  ${theme.heading('File:')} ${theme.file(fileInfo.path)}`);
          console.log(`  ${theme.label('Module:')} ${theme.module(fileInfo.module)} ${theme.dim('|')} ${theme.label('Language:')} ${theme.value(fileInfo.language)} ${theme.dim('|')} ${theme.label('LOC:')} ${theme.number(fileInfo.loc)} ${theme.dim('|')} ${theme.label('Complexity:')} ${theme.warn(fileInfo.complexity_score)}`);
          console.log(`  ${theme.label('Test:')} ${fileInfo.is_test ? theme.warn('yes') : theme.dim('no')} ${theme.dim('|')} ${theme.label('Config:')} ${fileInfo.is_config ? theme.warn('yes') : theme.dim('no')}\n`);

          if (syms.length > 0) {
            console.log(`  ${theme.subhead('Symbols:')}`);
            formatTable(syms, [
              { key: 'name', label: 'Name', maxWidth: 30 },
              { key: 'kind', label: 'Kind' },
              { key: 'exported', label: 'Exported' },
              { key: 'line_start', label: 'Line' },
              { key: 'signature', label: 'Signature', maxWidth: 40 },
            ]);
          }

          if (imports.length > 0) {
            console.log(`\n  ${theme.subhead('Imports:')}`);
            formatTable(imports, [
              { key: 'target_file', label: 'Target', maxWidth: 50 },
              { key: 'import_name', label: 'Import' },
              { key: 'import_type', label: 'Type' },
            ]);
          }

          if (importers.length > 0) {
            console.log(`\n  ${theme.subhead('Imported By:')}`);
            formatTable(importers, [
              { key: 'source_file', label: 'Source', maxWidth: 50 },
              { key: 'import_name', label: 'Import' },
            ]);
          }
          console.log('');
        }
        break;
      }

      // ===== symbols =====
      case 'symbols': {
        const pattern = positionalArgs[0] || '%';
        result = q.symbols(pattern, {
          kind: getArg('--kind'),
          exported: args.includes('--exported') ? true : undefined,
          limit: parseInt(getArg('--limit', '50')),
        });
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'name', label: 'Name', maxWidth: 30 },
            { key: 'kind', label: 'Kind' },
            { key: 'module', label: 'Module', maxWidth: 20 },
            { key: 'file', label: 'File', maxWidth: 40 },
            { key: 'line_start', label: 'Line' },
            { key: 'exported', label: 'Exported' },
          ]);
          console.log('');
        }
        break;
      }

      // ===== modules =====
      case 'modules': {
        result = q.modules();
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'name', label: 'Module', maxWidth: 25 },
            { key: 'root_path', label: 'Path', maxWidth: 30 },
            { key: 'file_count', label: 'Files' },
            { key: 'public_api_count', label: 'Public' },
            { key: 'internal_file_count', label: 'Internal' },
            { key: 'stability', label: 'Stability' },
            { key: 'capabilities', label: 'Capabilities', maxWidth: 40 },
          ]);
          console.log('');
        }
        break;
      }

      // ===== module =====
      case 'module': {
        const modName = positionalArgs[0];
        if (!modName) { console.error(theme.error('  Error: module name required')); process.exit(1); }
        result = q.getModule(modName);
        if (!result) { console.error(theme.error(`  Error: module not found: ${modName}`)); process.exit(1); }

        if (!jsonMode) {
          console.log('');
          drawBox(`Module: ${modName}`);
          drawLine(`${theme.label('Root:')} ${theme.dim(result.root_path)}    ${theme.label('Files:')} ${theme.number(result.file_count)}    ${theme.label('Stability:')} ${theme.stability(result.stability)}`);
          drawLine(`${theme.label('Public API:')} ${theme.number(result.public_api_count)}    ${theme.label('Internal:')} ${theme.number(result.internal_file_count)}`);

          if (result.publicAPI && result.publicAPI.length > 0) {
            drawSection(`Public API (${result.publicAPI.length})`);
            formatTable(result.publicAPI.slice(0, 30), [
              { key: 'name', label: 'Name', maxWidth: 30 },
              { key: 'kind', label: 'Kind' },
              { key: 'file', label: 'File', maxWidth: 35 },
              { key: 'consumer_count', label: 'Consumers' },
            ]);
          }

          if (result.capabilities.length > 0) {
            drawSection('Capabilities');
            for (const cap of result.capabilities) {
              const conf = parseFloat(cap.confidence);
              const confPct = `${Math.round(conf * 100)}%`;
              const confColor = conf >= 0.7 ? chalk.green : conf >= 0.4 ? chalk.yellow : chalk.red;
              drawLine(`${theme.symbol(cap.capability.padEnd(25))} ${confColor(confPct)}  ${theme.dim(cap.evidence || '')}`);
            }
          }

          if (result.dependsOn.length > 0) {
            drawSection('Depends On');
            for (const dep of result.dependsOn) {
              drawLine(`${chalk.cyan('\u2192')} ${theme.module(dep.target_module)}  ${theme.dim(`(${dep.edge_count} edges)`)}`);
            }
          }

          if (result.dependedOnBy.length > 0) {
            drawSection('Depended On By');
            for (const dep of result.dependedOnBy) {
              drawLine(`${chalk.magenta('\u2190')} ${theme.module(dep.source_module)}  ${theme.dim(`(${dep.edge_count} edges)`)}`);
            }
          }

          if (result.files.length > 0) {
            drawSection(`Files (${result.files.length})`);
            formatTable(result.files.slice(0, 20), [
              { key: 'path', label: 'Path', maxWidth: 50 },
              { key: 'language', label: 'Lang' },
              { key: 'loc', label: 'LOC' },
              { key: 'complexity_score', label: 'Complexity' },
            ]);
            if (result.files.length > 20) console.log(theme.dim(`    ... and ${result.files.length - 20} more`));
          }

          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== search =====
      case 'search': {
        const symbolName = positionalArgs[0];
        if (!symbolName) { console.error(theme.error('  Error: symbol name required')); process.exit(1); }
        result = q.searchSymbol(symbolName);

        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Search:')} "${theme.symbol(symbolName)}" ${theme.dim(`(${result.length} match${result.length !== 1 ? 'es' : ''})`)}\n`);
          if (result.length > 0) {
            formatTable(result, [
              { key: 'name', label: 'Symbol', maxWidth: 30 },
              { key: 'kind', label: 'Kind' },
              { key: 'file', label: 'File', maxWidth: 40 },
              { key: 'line_start', label: 'Line' },
              { key: 'exported', label: 'Exported' },
              { key: 'module', label: 'Module', maxWidth: 15 },
            ]);
          }
          console.log('');
        }
        break;
      }

      // ===== consumers =====
      case 'consumers': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        result = q.getConsumers(filePath);

        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Consumers of:')} ${theme.file(filePath)}`);
          if (result.fileInfo) {
            console.log(`  ${theme.label('Module:')} ${theme.module(result.fileInfo.module)} ${theme.dim('|')} ${theme.label('Language:')} ${result.fileInfo.language} ${theme.dim('|')} ${theme.label('LOC:')} ${theme.number(result.fileInfo.loc)}`);
          }
          console.log(`  ${theme.label('Total consumers:')} ${theme.number(result.consumers.length)}\n`);

          if (result.consumers.length > 0) {
            formatTable(result.consumers, [
              { key: 'source_file', label: 'Consumer File', maxWidth: 50 },
              { key: 'module', label: 'Module', maxWidth: 20 },
              { key: 'import_name', label: 'Import', maxWidth: 25 },
              { key: 'import_type', label: 'Type' },
            ]);
          }
          console.log('');
        }
        break;
      }

      // ===== boundaries =====
      case 'boundaries': {
        result = q.getModuleBoundaries();

        if (!jsonMode) {
          console.log('');
          drawBox('Module Boundaries');

          if (result.modules.length > 0) {
            drawSection('Modules');
            formatTable(result.modules, [
              { key: 'name', label: 'Module', maxWidth: 25 },
              { key: 'file_count', label: 'Files' },
              { key: 'public_api_count', label: 'Public API' },
              { key: 'stability', label: 'Stability' },
              { key: 'capabilities', label: 'Capabilities', maxWidth: 40 },
            ]);
          }

          if (result.edges.length > 0) {
            drawSection('Inter-Module Dependencies');
            for (const e of result.edges) {
              drawLine(`${theme.module(e.source_module)} ${chalk.cyan('\u2192')} ${theme.module(e.target_module)}  ${theme.dim(`(${e.edge_count} edges)`)}`);
            }
          } else {
            drawLine(theme.dim('No inter-module dependency edges.'));
          }

          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== churn =====
      case 'churn': {
        const limit = parseInt(getArg('--limit', '20'));
        result = q.highChurn(limit);
        if (!jsonMode) {
          console.log('');
          drawBox('Highest Churn Files');
          console.log('');
          formatTable(result, [
            { key: 'file', label: 'File', maxWidth: 45 },
            { key: 'module', label: 'Module', maxWidth: 15 },
            { key: 'changes_7d', label: '7d' },
            { key: 'changes_30d', label: '30d' },
            { key: 'changes_90d', label: '90d' },
            { key: 'last_changed', label: 'Last Changed' },
          ]);
          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== context-for-task =====
      case 'context-for-task': {
        if (positionalArgs.length === 0) {
          console.error(theme.error('  Error: at least one file path required'));
          process.exit(1);
        }
        result = q.getContextForTask(positionalArgs);
        console.log(JSON.stringify(result, null, 2));
        q.close();
        return;
      }

      // ===== imports =====
      case 'imports': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        result = q.importsOf(filePath);
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'target_file', label: 'Target', maxWidth: 50 },
            { key: 'import_name', label: 'Import', maxWidth: 30 },
            { key: 'import_type', label: 'Type' },
          ]);
          console.log('');
        }
        break;
      }

      // ===== imported-by =====
      case 'imported-by': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        result = q.importedBy(filePath);
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'source_file', label: 'Source', maxWidth: 50 },
            { key: 'import_name', label: 'Import', maxWidth: 30 },
            { key: 'import_type', label: 'Type' },
          ]);
          console.log('');
        }
        break;
      }

      // ===== dep-chain =====
      case 'dep-chain': {
        const filePath = positionalArgs[0];
        if (!filePath) { console.error(theme.error('  Error: file path required')); process.exit(1); }
        const depth = parseInt(getArg('--depth', '3'));
        result = q.dependencyChain(filePath, depth);
        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Dependency Chain from:')} ${theme.file(filePath)} ${theme.dim(`(depth=${depth})`)}\n`);
          for (const edge of result) {
            const indent = '  '.repeat(edge.depth);
            console.log(`  ${indent}${theme.file(edge.from)} ${chalk.cyan('\u2192')} ${theme.file(edge.to)}`);
          }
          console.log(`\n  ${theme.label('Total:')} ${theme.number(result.length)} edges\n`);
        }
        break;
      }

      // ===== capability (single) =====
      case 'capability': {
        const capName = positionalArgs[0];
        if (!capName) { console.error(theme.error('  Error: capability name required')); process.exit(1); }
        result = q.capabilityProviders(capName);
        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Modules providing')} "${theme.symbol(capName)}":\n`);
          formatTable(result, [
            { key: 'module_name', label: 'Module', maxWidth: 25 },
            { key: 'confidence', label: 'Confidence' },
            { key: 'evidence', label: 'Evidence', maxWidth: 50 },
          ]);
          console.log('');
        }
        break;
      }

      // ===== interfaces =====
      case 'interfaces': {
        const limit = parseInt(getArg('--limit', '20'));
        result = q.mostUsedInterfaces(limit);
        if (!jsonMode) {
          console.log('');
          drawBox('Most-Used Interfaces');
          console.log('');
          formatTable(result, [
            { key: 'name', label: 'Name', maxWidth: 30 },
            { key: 'kind', label: 'Kind' },
            { key: 'module', label: 'Module', maxWidth: 20 },
            { key: 'file', label: 'File', maxWidth: 35 },
            { key: 'consumer_count', label: 'Consumers' },
          ]);
          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== warnings =====
      case 'warnings': {
        result = q.warnings({
          severity: getArg('--severity'),
          module: getArg('--module'),
          limit: parseInt(getArg('--limit', '50')),
        });
        if (!jsonMode) {
          console.log('');
          formatTable(result, [
            { key: 'severity', label: 'Severity' },
            { key: 'module', label: 'Module', maxWidth: 20 },
            { key: 'file', label: 'File', maxWidth: 30 },
            { key: 'warning_text', label: 'Warning', maxWidth: 50 },
            { key: 'created_at', label: 'Created' },
          ]);
          console.log('');
        }
        break;
      }

      // ===== meta =====
      case 'meta': {
        result = q.meta();
        if (!jsonMode) {
          console.log('');
          drawBox('Graph Metadata');
          for (const [key, value] of Object.entries(result)) {
            drawLine(`${theme.label(key.padEnd(22))} ${theme.value(value)}`);
          }
          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== callers =====
      case 'callers': {
        const symbolName = positionalArgs[0];
        if (!symbolName) { console.error(theme.error('  Error: symbol name required')); process.exit(1); }
        const file = positionalArgs[1] || undefined;
        result = q.getCallersOf(symbolName, file);

        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Callers of:')} ${theme.symbol(symbolName)}${file ? ' ' + theme.dim('in ' + file) : ''}`);
          console.log(`  ${theme.label('Total callers:')} ${theme.number(result.length)}\n`);
          if (result.length > 0) {
            formatTable(result, [
              { key: 'caller_name', label: 'Caller', maxWidth: 30 },
              { key: 'caller_kind', label: 'Kind' },
              { key: 'caller_file', label: 'File', maxWidth: 40 },
              { key: 'caller_module', label: 'Module', maxWidth: 15 },
              { key: 'call_site_line', label: 'Line' },
              { key: 'call_type', label: 'Type' },
            ]);
          }
          console.log('');
        }
        break;
      }

      // ===== callees =====
      case 'callees': {
        const symbolName = positionalArgs[0];
        if (!symbolName) { console.error(theme.error('  Error: symbol name required')); process.exit(1); }
        const file = positionalArgs[1] || undefined;
        result = q.getCalleesOf(symbolName, file);

        if (!jsonMode) {
          console.log(`\n  ${theme.heading('Callees of:')} ${theme.symbol(symbolName)}${file ? ' ' + theme.dim('in ' + file) : ''}`);
          console.log(`  ${theme.label('Total callees:')} ${theme.number(result.length)}\n`);
          if (result.length > 0) {
            formatTable(result, [
              { key: 'callee_name', label: 'Callee', maxWidth: 30 },
              { key: 'callee_file', label: 'File', maxWidth: 40 },
              { key: 'call_site_line', label: 'Line' },
              { key: 'call_type', label: 'Type' },
            ]);
          }
          console.log('');
        }
        break;
      }

      // ===== hierarchy =====
      case 'hierarchy': {
        const symbolName = positionalArgs[0];
        if (!symbolName) { console.error(theme.error('  Error: class/symbol name required')); process.exit(1); }
        result = q.getClassHierarchy(symbolName);

        if (!jsonMode) {
          console.log('');
          drawBox(`Class Hierarchy: ${symbolName}`);
          if (result.parents.length > 0) {
            drawSection(`Parents (${result.parents.length})`);
            for (const p of result.parents) {
              drawLine(`${chalk.cyan('\u25b2')} ${theme.symbol(p.parent_name)}  ${theme.dim(p.relation)}  ${p.parent_file ? theme.file(p.parent_file) : theme.dim('(unresolved)')}`);
            }
          } else {
            drawLine(theme.dim('No parents found.'));
          }
          if (result.children.length > 0) {
            drawSection(`Children (${result.children.length})`);
            for (const c of result.children) {
              drawLine(`${chalk.green('\u25bc')} ${theme.symbol(c.child_name)}  ${theme.dim(c.relation)}  ${theme.file(c.child_file)}  ${theme.dim('(' + c.child_module + ')')}`);
            }
          } else {
            drawLine(theme.dim('No children found.'));
          }
          drawBoxEnd();
          console.log('');
        }
        break;
      }

      // ===== dead-code =====
      case 'dead-code': {
        const modName = positionalArgs[0] || undefined;
        result = q.getDeadCode(modName);

        if (!jsonMode) {
          console.log('');
          drawBox(`Dead Code${modName ? ': ' + modName : ''}`);
          drawLine(`${theme.label('Total suspects:')} ${theme.number(result.length)}`);
          console.log('');
          if (result.length > 0) {
            formatTable(result.slice(0, 50), [
              { key: 'name', label: 'Symbol', maxWidth: 30 },
              { key: 'kind', label: 'Kind' },
              { key: 'file', label: 'File', maxWidth: 40 },
              { key: 'module', label: 'Module', maxWidth: 15 },
              { key: 'confidence', label: 'Confidence' },
              { key: 'reason', label: 'Reason', maxWidth: 25 },
            ]);
            if (result.length > 50) console.log(theme.dim(`    ... and ${result.length - 50} more`));
          }
          drawBoxEnd();
          console.log('');
        }
        break;
      }

      default:
        console.error(theme.error(`  Unknown command: ${command}`));
        printHelp();
        process.exit(1);
    }

    if (jsonMode && result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }

  } finally {
    q.close();
  }
}

// ============================================================
// Convenience Wrappers (Programmatic API)
// ============================================================

function resolveDbPath(pathArg) {
  if (!pathArg) return path.join(process.cwd(), '.forge', 'graph.db');
  if (pathArg.endsWith('.db') || pathArg.includes('graph.db')) return pathArg;
  // Treat as repo root — construct .forge/graph.db path
  return path.join(pathArg, '.forge', 'graph.db');
}

function createQuery(dbPathOrOpts) {
  let raw;
  if (typeof dbPathOrOpts === 'string') {
    raw = dbPathOrOpts;
  } else if (dbPathOrOpts && dbPathOrOpts.db) {
    raw = dbPathOrOpts.db;
  } else {
    raw = null;
  }
  return new GraphQuery(resolveDbPath(raw));
}

function withQuery(dbPath, fn) {
  const q = createQuery(dbPath);
  try {
    q.open();
    return fn(q);
  } finally {
    q.close();
  }
}

/**
 * Get all files that import from a given file.
 * @param {string} filePath
 * @param {string} [dbPath]
 */
function getConsumers(filePath, dbPath) {
  return withQuery(dbPath, q => q.getConsumers(filePath));
}

/**
 * Get transitive impact analysis for a file.
 * @param {string} filePath
 * @param {{ depth?: number, db?: string }} [opts]
 */
function getImpact(filePath, opts = {}) {
  return withQuery(opts.db || opts, q => q.getImpact(filePath, opts));
}

/**
 * Get module details.
 * @param {string} moduleName
 * @param {string} [dbPath]
 */
function getModule(moduleName, dbPath) {
  return withQuery(dbPath, q => q.getModule(moduleName));
}

/**
 * Get hotspot files ranked by risk.
 * @param {{ top?: number, db?: string }} [opts]
 */
function getHotspots(opts = {}) {
  return withQuery(opts.db || opts, q => q.getHotspots(opts));
}

/**
 * Get full context for a task modifying the given files.
 * @param {string[]} filePaths
 * @param {string} [dbPath]
 */
function getContextForTask(filePaths, dbPath) {
  return withQuery(dbPath, q => q.getContextForTask(filePaths));
}

/**
 * Get capabilities for a module.
 * @param {string} moduleName
 * @param {string} [dbPath]
 */
function getCapabilities(moduleName, dbPath) {
  return withQuery(dbPath, q => q.getCapabilities(moduleName));
}

/**
 * Search for a symbol by name.
 * @param {string} symbolName
 * @param {string} [dbPath]
 */
function searchSymbol(symbolName, dbPath) {
  return withQuery(dbPath, q => q.searchSymbol(symbolName));
}

/**
 * Get all module boundaries and inter-module edges.
 * @param {string} [dbPath]
 */
function getModuleBoundaries(dbPath) {
  return withQuery(dbPath, q => q.getModuleBoundaries());
}

/**
 * Get risk assessment for a set of files.
 * @param {string[]} filePaths
 * @param {string} [dbPath]
 */
function getRiskAssessment(filePaths, dbPath) {
  return withQuery(dbPath, q => q.getRiskAssessment(filePaths));
}

/**
 * Get circular dependencies.
 * @param {string} [dbPath]
 */
function getCycles(dbPath) {
  return withQuery(dbPath, q => q.getCycles());
}

/**
 * Get high-level repository overview.
 * @param {string} [dbPath]
 */
function getOverview(dbPath) {
  return withQuery(dbPath, q => q.getOverview());
}

/**
 * Compare current graph against a baseline.
 * @param {string} baseDbPath
 * @param {string} [dbPath]
 */
function getGraphDiff(baseDbPath, dbPath) {
  return withQuery(dbPath, q => q.getGraphDiff(baseDbPath));
}

/**
 * Get callers of a symbol.
 * @param {string} symbolName
 * @param {{ file?: string, db?: string }} [opts]
 */
function getCallersOf(symbolName, opts = {}) {
  return withQuery(opts.db || opts, q => q.getCallersOf(symbolName, opts.file));
}

/**
 * Get callees of a symbol.
 * @param {string} symbolName
 * @param {{ file?: string, db?: string }} [opts]
 */
function getCalleesOf(symbolName, opts = {}) {
  return withQuery(opts.db || opts, q => q.getCalleesOf(symbolName, opts.file));
}

/**
 * Get class hierarchy for a symbol.
 * @param {string} symbolName
 * @param {string} [dbPath]
 */
function getClassHierarchy(symbolName, dbPath) {
  return withQuery(dbPath, q => q.getClassHierarchy(symbolName));
}

/**
 * Get dead code suspects.
 * @param {{ module?: string, db?: string }} [opts]
 */
function getDeadCode(opts = {}) {
  return withQuery(opts.db || opts, q => q.getDeadCode(opts.module));
}

// ============================================================
// Entry Point
// ============================================================

if (require.main === module) {
  run();
}

module.exports = {
  GraphQuery,
  applyRichOutputConfig,
  // Convenience wrappers
  getConsumers,
  getImpact,
  getModule,
  getHotspots,
  getContextForTask,
  getCapabilities,
  searchSymbol,
  getModuleBoundaries,
  getRiskAssessment,
  getCycles,
  getOverview,
  getGraphDiff,
  getCallersOf,
  getCalleesOf,
  getClassHierarchy,
  getDeadCode,
};
