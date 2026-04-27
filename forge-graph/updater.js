#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const {
  GraphBuilder, discoverFiles, resolveImport, estimateComplexity,
  ParserManager, extractFromAST, extractWithRegex,
  LANGUAGE_EXTENSIONS, TEST_PATTERNS, CONFIG_PATTERNS,
} = require('./builder');
const { detectModules, classifyFile } = require('./module-detector');
const { detectCapabilities } = require('./capability-detector');

// ============================================================
// Incremental Updater
// ============================================================

class GraphUpdater {
  constructor(repoRoot, dbPath) {
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = dbPath || path.join(this.repoRoot, '.forge', 'graph.db');
    this.db = null;
    this.parserMgr = new ParserManager();
    this.stats = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  }

  /**
   * Run an incremental update. If the database doesn't exist, falls back to a full build.
   * @param {string} [since] - Git ref or commit to diff against (default: last build commit).
   * @returns {{ stats: object, rebuildRequired: boolean }}
   */
  update(since) {
    const startTime = Date.now();
    console.log(`\n  Forge Graph Engine — Incremental Update`);
    console.log(`  Repository: ${this.repoRoot}\n`);

    // Check if database exists
    if (!fs.existsSync(this.dbPath)) {
      console.log('  No existing database found. Running full build...\n');
      const builder = new GraphBuilder(this.repoRoot, this.dbPath);
      builder.build();
      return { stats: this.stats, rebuildRequired: true };
    }

    // Open existing database with WAL and busy timeout
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Initialize tree-sitter parsers
    this.parserMgr.init();

    // Determine what changed
    const lastBuildCommit = this.getMetaValue('last_commit') || this.getMetaValue('last_build_commit');
    const diffBase = since || lastBuildCommit;

    if (!diffBase) {
      console.log('  No previous build reference found. Running full rebuild...\n');
      this.db.close();
      const builder = new GraphBuilder(this.repoRoot, this.dbPath);
      builder.build();
      return { stats: this.stats, rebuildRequired: true };
    }

    console.log(`  Diffing against: ${diffBase.slice(0, 12)}`);

    const changes = this.getChangedFiles(diffBase);
    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;

    if (totalChanges === 0) {
      console.log('  No changes detected. Database is up to date.\n');
      this.updateMeta();
      this.db.close();
      return { stats: this.stats, rebuildRequired: false };
    }

    console.log(`  Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`);

    // Check if too many changes warrant a full rebuild (>30% of files AND >50 total)
    const existingFileCount = this.db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt;
    if (totalChanges > existingFileCount * 0.3 && totalChanges > 50) {
      console.log(`  Large changeset (${totalChanges} files, ${Math.round(totalChanges / Math.max(existingFileCount, 1) * 100)}%). Running full rebuild...\n`);
      this.db.close();
      const builder = new GraphBuilder(this.repoRoot, this.dbPath);
      builder.build();
      return { stats: this.stats, rebuildRequired: true };
    }

    // Capture deleted files' module names before deleting
    const deletedModules = new Set();
    for (const fp of changes.deleted) {
      const row = this.db.prepare('SELECT module FROM files WHERE path = ?').get(fp);
      if (row) deletedModules.add(row.module);
    }

    // Process changes incrementally
    const allChanged = [...changes.added, ...changes.modified, ...changes.deleted];
    this.processDeleted(changes.deleted);
    this.processAddedOrModified([...changes.added, ...changes.modified]);

    // Cascade consumer_count updates for affected interfaces
    this.cascadeConsumerUpdates([...changes.added, ...changes.modified, ...changes.deleted]);

    // Targeted change_frequency updates for changed files
    this.updateChangeFrequency([...changes.added, ...changes.modified]);

    // Refresh module stats for affected modules
    this.refreshModuleStats(changes, deletedModules);

    // Update metadata
    this.updateMeta();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n  Update complete in ${elapsed}s`);
    console.log(`  Added: ${this.stats.added} | Modified: ${this.stats.modified} | Deleted: ${this.stats.deleted}`);
    console.log(`  Database: ${this.dbPath}\n`);

    this.db.close();
    return { stats: this.stats, rebuildRequired: false };
  }

  // ============================================================
  // Git Diff
  // ============================================================

  /**
   * Get lists of added, modified, and deleted files since a given ref.
   */
  getChangedFiles(sinceRef) {
    const result = { added: [], modified: [], deleted: [] };

    try {
      const output = execSync(
        `git diff --name-status --diff-filter=ACDMR ${sinceRef}..HEAD -- .`,
        { cwd: this.repoRoot, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      for (const line of output.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        const status = parts[0][0]; // A, M, D, R, C
        const filePath = parts[parts.length - 1]; // Use last part for renames/copies
        const ext = path.extname(filePath).toLowerCase();

        // Only track source files
        if (!LANGUAGE_EXTENSIONS[ext]) continue;

        switch (status) {
          case 'A':
          case 'C': // Copy: treat new copy as added
            result.added.push(filePath);
            break;
          case 'M':
            result.modified.push(filePath);
            break;
          case 'D':
            result.deleted.push(filePath);
            break;
          case 'R': {
            // Rename: old path deleted, new path added
            const oldPath = parts[1];
            const oldExt = path.extname(oldPath).toLowerCase();
            if (LANGUAGE_EXTENSIONS[oldExt]) {
              result.deleted.push(oldPath);
            }
            result.added.push(filePath);
            break;
          }
        }
      }
    } catch (err) {
      console.warn(`  [warn] Could not get git diff: ${err.message}`);
      return this.getChangedByMtime();
    }

    return result;
  }

  /**
   * Fallback: detect changes by comparing file modification times against database.
   */
  getChangedByMtime() {
    const result = { added: [], modified: [], deleted: [] };
    const currentFiles = new Set(discoverFiles(this.repoRoot));

    const dbFiles = new Map();
    for (const row of this.db.prepare('SELECT path, last_modified FROM files').all()) {
      dbFiles.set(row.path, row.last_modified);
    }

    for (const fp of currentFiles) {
      if (!dbFiles.has(fp)) {
        result.added.push(fp);
      } else {
        try {
          const fullPath = path.join(this.repoRoot, fp);
          const stat = fs.statSync(fullPath);
          const mtime = stat.mtime.toISOString().split('T')[0];
          if (mtime !== dbFiles.get(fp)) {
            result.modified.push(fp);
          }
        } catch {
          // File might have been deleted between discovery and stat
        }
      }
    }

    for (const fp of dbFiles.keys()) {
      if (!currentFiles.has(fp)) {
        result.deleted.push(fp);
      }
    }

    return result;
  }

  // ============================================================
  // Process Deleted Files
  // ============================================================

  processDeleted(deletedFiles) {
    if (deletedFiles.length === 0) return;

    const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
    const deleteSymbols = this.db.prepare('DELETE FROM symbols WHERE file = ?');
    const deleteDepsSource = this.db.prepare('DELETE FROM dependencies WHERE source_file = ?');
    const deleteDepsTarget = this.db.prepare('DELETE FROM dependencies WHERE target_file = ?');
    const deleteInterfaces = this.db.prepare('DELETE FROM interfaces WHERE file = ?');
    const deleteChangeFreq = this.db.prepare('DELETE FROM change_frequency WHERE file = ?');

    const deleteAll = this.db.transaction((files) => {
      for (const fp of files) {
        deleteSymbols.run(fp);
        deleteDepsSource.run(fp);
        deleteDepsTarget.run(fp);
        deleteInterfaces.run(fp);
        deleteChangeFreq.run(fp);
        deleteFile.run(fp);
      }
    });

    deleteAll(deletedFiles);
    this.stats.deleted = deletedFiles.length;
    console.log(`  Deleted ${deletedFiles.length} file(s) from graph`);
  }

  // ============================================================
  // Process Added / Modified Files
  // ============================================================

  processAddedOrModified(filePaths) {
    if (filePaths.length === 0) return;

    // Get all current file paths for import resolution
    const allFilePaths = this.db.prepare('SELECT path FROM files').all().map(r => r.path);
    const allFileSet = new Set([...allFilePaths, ...filePaths]);
    const allFiles = [...allFileSet];

    // Detect modules for file assignment
    const { modules, fileModuleMap } = detectModules(this.repoRoot, allFiles);

    // Prepare statements
    const insertFile = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, module, language, loc, complexity_score, last_modified, is_test, is_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteSymbols = this.db.prepare('DELETE FROM symbols WHERE file = ?');
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (name, kind, file, line_start, line_end, exported, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteDeps = this.db.prepare('DELETE FROM dependencies WHERE source_file = ?');
    const insertDep = this.db.prepare(`
      INSERT OR IGNORE INTO dependencies (source_file, target_file, import_name, import_type)
      VALUES (?, ?, ?, ?)
    `);
    const deleteInterfaces = this.db.prepare('DELETE FROM interfaces WHERE file = ?');
    const insertInterface = this.db.prepare(`
      INSERT INTO interfaces (name, file, kind, consumer_count, contract_hash)
      VALUES (?, ?, ?, ?, ?)
    `);

    const existingPaths = new Set(allFilePaths);

    // Parse all files first (outside transaction) to collect data
    const parsed = [];
    for (const filePath of filePaths) {
      const ext = path.extname(filePath).toLowerCase();
      const language = LANGUAGE_EXTENSIONS[ext];
      if (!language) continue;

      const fullPath = path.join(this.repoRoot, filePath);
      let source;
      try {
        source = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      const loc = source.split('\n').length;
      const complexity = estimateComplexity(source, language);
      const isTest = TEST_PATTERNS.some(p => p.test(filePath));
      const isConfig = CONFIG_PATTERNS.some(p => p.test(filePath));
      const moduleName = fileModuleMap.get(filePath) || '<root>';
      const lastModified = this.getFileLastModified(filePath);

      // Parse symbols and imports — prefer tree-sitter, fall back to regex
      let extracted;
      const parser = this.parserMgr.getParser(language, filePath);
      if (parser) {
        try {
          const tree = parser.parse(source);
          extracted = extractFromAST(tree, language, source);
          if (extracted.symbols.length === 0 && source.trim().length > 0) {
            extracted = extractWithRegex(source, language);
          }
        } catch {
          extracted = extractWithRegex(source, language);
        }
      } else {
        extracted = extractWithRegex(source, language);
      }

      parsed.push({
        filePath, language, loc, complexity, isTest, isConfig,
        moduleName, lastModified, symbols: extracted.symbols, imports: extracted.imports,
      });
    }

    // Two-pass transaction: file records first, then symbols/deps/interfaces
    const updateAll = this.db.transaction(() => {
      // Pass 1: Insert all file records so FK targets exist
      for (const p of parsed) {
        insertFile.run(p.filePath, p.moduleName, p.language, p.loc, p.complexity, p.lastModified, p.isTest ? 1 : 0, p.isConfig ? 1 : 0);
      }

      // Pass 2: Symbols, interfaces, and dependencies
      for (const p of parsed) {
        // Clear and rewrite symbols
        deleteSymbols.run(p.filePath);
        for (const sym of p.symbols) {
          insertSymbol.run(sym.name, sym.kind, p.filePath, sym.line_start, sym.line_end, sym.exported ? 1 : 0, sym.signature);
        }

        // Clear and rewrite interfaces for exported symbols
        deleteInterfaces.run(p.filePath);
        for (const sym of p.symbols) {
          if (sym.exported) {
            const kindMap = {
              function: 'export_function', class: 'export_class',
              type: 'export_type', interface: 'export_type',
              component: 'export_component', const: 'export_function',
              enum: 'export_type',
            };
            const interfaceKind = kindMap[sym.kind] || 'export_function';
            const hash = crypto.createHash('sha256').update(sym.signature || sym.name).digest('hex').slice(0, 16);
            insertInterface.run(sym.name, p.filePath, interfaceKind, 0, hash);
          }
        }

        // Clear and rewrite dependencies — only insert if target exists in DB
        deleteDeps.run(p.filePath);
        for (const imp of p.imports) {
          const resolved = resolveImport(imp.name, p.filePath, allFiles);
          if (resolved && resolved !== p.filePath) {
            // Check target exists in files table (may be outside the changed set)
            const targetExists = this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(resolved);
            if (targetExists) {
              insertDep.run(p.filePath, resolved, imp.name, imp.type);
            }
          }
        }

        // Track stats
        if (existingPaths.has(p.filePath)) this.stats.modified++;
        else this.stats.added++;
      }
    });

    updateAll();
    console.log(`  Processed ${filePaths.length} file(s) (${this.stats.added} new, ${this.stats.modified} updated)`);
  }

  // ============================================================
  // Consumer Cascade
  // ============================================================

  /**
   * Recompute consumer_count for interfaces affected by changed files.
   * Affected = interfaces in changed files + interfaces in files they import + interfaces in files that import them.
   */
  cascadeConsumerUpdates(changedFiles) {
    if (changedFiles.length === 0) return;

    const affectedFiles = new Set(changedFiles);

    // Files that changed files import (target_file from deps where source is changed)
    const importedByChanged = this.db.prepare(
      `SELECT DISTINCT target_file FROM dependencies WHERE source_file IN (${changedFiles.map(() => '?').join(',')})`
    );
    for (const row of importedByChanged.all(...changedFiles)) {
      affectedFiles.add(row.target_file);
    }

    // Files that import changed files (source_file from deps where target is changed)
    const importersOfChanged = this.db.prepare(
      `SELECT DISTINCT source_file FROM dependencies WHERE target_file IN (${changedFiles.map(() => '?').join(',')})`
    );
    for (const row of importersOfChanged.all(...changedFiles)) {
      affectedFiles.add(row.source_file);
    }

    // For each affected file, recompute consumer_count on all its interfaces
    const getInterfaces = this.db.prepare('SELECT id, name, file FROM interfaces WHERE file = ?');
    const countConsumers = this.db.prepare(
      'SELECT COUNT(DISTINCT source_file) as cnt FROM dependencies WHERE target_file = ?'
    );
    const updateConsumerCount = this.db.prepare('UPDATE interfaces SET consumer_count = ? WHERE id = ?');

    const cascade = this.db.transaction(() => {
      let updated = 0;
      for (const fp of affectedFiles) {
        const consumerCount = countConsumers.get(fp);
        if (!consumerCount) continue;
        const ifaces = getInterfaces.all(fp);
        for (const iface of ifaces) {
          updateConsumerCount.run(consumerCount.cnt, iface.id);
          updated++;
        }
      }
      if (updated > 0) {
        console.log(`  Cascaded consumer_count for ${updated} interface(s) across ${affectedFiles.size} file(s)`);
      }
    });

    cascade();
  }

  // ============================================================
  // Targeted Change Frequency
  // ============================================================

  /**
   * Update change_frequency for specific files (not the whole repo).
   * Per file: git log --since for 7d/30d/90d + last_changed + top_changers.
   */
  updateChangeFrequency(changedFiles) {
    if (changedFiles.length === 0) return;

    const insertFreq = this.db.prepare(`
      INSERT OR REPLACE INTO change_frequency (file, changes_7d, changes_30d, changes_90d, last_changed, top_changers)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = new Date();
    const periods = [
      { key: 'changes_7d', days: 7 },
      { key: 'changes_30d', days: 30 },
      { key: 'changes_90d', days: 90 },
    ];

    const updateFreq = this.db.transaction(() => {
      for (const filePath of changedFiles) {
        const freq = { changes_7d: 0, changes_30d: 0, changes_90d: 0, last_changed: null, top_changers: [] };

        // Count changes per period
        for (const { key, days } of periods) {
          const since = new Date(now - days * 86400000).toISOString().split('T')[0];
          try {
            const output = execSync(
              `git log --since="${since}" --oneline -- "${filePath}"`,
              { cwd: this.repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            freq[key] = output.split('\n').filter(Boolean).length;
          } catch {
            // git not available or file not tracked
          }
        }

        // Get last_changed and top_changers
        try {
          const output = execSync(
            `git log --pretty=format:"%an|||%ai" -20 -- "${filePath}"`,
            { cwd: this.repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          const lines = output.split('\n').filter(Boolean);
          const authorCounts = {};
          for (const line of lines) {
            const parts = line.split('|||');
            if (parts.length < 2) continue;
            const author = parts[0];
            const date = parts[1].split(' ')[0];
            if (!freq.last_changed) freq.last_changed = date;
            authorCounts[author] = (authorCounts[author] || 0) + 1;
          }
          // Sort authors by commit count descending, take top 5
          freq.top_changers = Object.entries(authorCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(e => e[0]);
        } catch {
          // git not available or file not tracked
        }

        insertFreq.run(
          filePath,
          freq.changes_7d,
          freq.changes_30d,
          freq.changes_90d,
          freq.last_changed,
          JSON.stringify(freq.top_changers)
        );
      }
    });

    updateFreq();
    console.log(`  Updated change_frequency for ${changedFiles.length} file(s)`);
  }

  // ============================================================
  // Module Stats Refresh
  // ============================================================

  refreshModuleStats(changes, deletedModules) {
    // Find affected modules
    const affectedModules = new Set(deletedModules || []);
    const allAffected = [...changes.added, ...changes.modified, ...changes.deleted];

    for (const fp of allAffected) {
      const row = this.db.prepare('SELECT module FROM files WHERE path = ?').get(fp);
      if (row) affectedModules.add(row.module);
    }

    if (affectedModules.size === 0) return;

    console.log(`  Refreshing ${affectedModules.size} module(s)...`);

    const updateModule = this.db.prepare(`
      INSERT OR REPLACE INTO modules (name, root_path, file_count, public_api_count, internal_file_count, stability)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteModCaps = this.db.prepare('DELETE FROM module_capabilities WHERE module_name = ?');
    const insertCap = this.db.prepare(`
      INSERT OR REPLACE INTO module_capabilities (module_name, capability, confidence, evidence)
      VALUES (?, ?, ?, ?)
    `);
    const deleteModDeps = this.db.prepare('DELETE FROM module_dependencies WHERE source_module = ?');
    const insertModDep = this.db.prepare(`
      INSERT OR REPLACE INTO module_dependencies (source_module, target_module, edge_count)
      VALUES (?, ?, ?)
    `);

    const refresh = this.db.transaction(() => {
      for (const modName of affectedModules) {
        const modRow = this.db.prepare('SELECT root_path FROM modules WHERE name = ?').get(modName);
        if (!modRow) continue;

        const rootPath = modRow.root_path;

        // Count files
        const files = this.db.prepare('SELECT path FROM files WHERE module = ?').all(modName).map(r => r.path);
        const fileCount = files.length;

        let publicApiCount = 0;
        let internalCount = 0;
        for (const fp of files) {
          const cls = classifyFile(fp, rootPath);
          if (cls === 'public') publicApiCount++;
          else internalCount++;
        }

        // Stability from change frequency
        let totalChanges = 0;
        for (const fp of files) {
          const cfRow = this.db.prepare('SELECT changes_30d FROM change_frequency WHERE file = ?').get(fp);
          if (cfRow) totalChanges += cfRow.changes_30d;
        }
        const avgChanges = fileCount > 0 ? totalChanges / fileCount : 0;
        const stability = avgChanges <= 1 ? 'high' : avgChanges <= 5 ? 'medium' : 'low';

        updateModule.run(modName, rootPath, fileCount, publicApiCount, internalCount, stability);

        // Refresh capabilities
        deleteModCaps.run(modName);
        const modSymbols = this.db.prepare('SELECT name, file FROM symbols WHERE file IN (SELECT path FROM files WHERE module = ?) AND exported = 1').all(modName);
        const modImports = this.db.prepare('SELECT source_file, import_name FROM dependencies WHERE source_file IN (SELECT path FROM files WHERE module = ?)').all(modName);
        const caps = detectCapabilities(modName, files, modSymbols, modImports, { repoRoot: this.repoRoot });
        for (const cap of caps) {
          insertCap.run(modName, cap.capability, cap.confidence, cap.evidence);
        }

        // Refresh module-level dependencies
        deleteModDeps.run(modName);
        const deps = this.db.prepare(`
          SELECT d.target_file, f.module as target_module, COUNT(*) as cnt
          FROM dependencies d
          JOIN files f ON d.target_file = f.path
          WHERE d.source_file IN (SELECT path FROM files WHERE module = ?)
          AND f.module != ?
          GROUP BY f.module
        `).all(modName, modName);

        for (const dep of deps) {
          if (dep.target_module) {
            insertModDep.run(modName, dep.target_module, dep.cnt);
          }
        }
      }
    });

    refresh();
  }

  // ============================================================
  // Metadata
  // ============================================================

  getMetaValue(key) {
    try {
      const row = this.db.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  getCurrentCommit() {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.repoRoot, encoding: 'utf8', timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  }

  getFileLastModified(filePath) {
    try {
      const output = execSync(
        `git log -1 --format=%aI -- "${filePath}"`,
        { cwd: this.repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return output.trim().split('T')[0] || null;
    } catch {
      return null;
    }
  }

  updateMeta() {
    const currentCommit = this.getCurrentCommit();
    const insertMeta = this.db.prepare('INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)');

    const updateMetaTx = this.db.transaction(() => {
      insertMeta.run('last_build_time', new Date().toISOString());
      insertMeta.run('updated_at', new Date().toISOString());
      if (currentCommit) {
        insertMeta.run('last_commit', currentCommit);
        insertMeta.run('last_build_commit', currentCommit);
      }
      // Update counts
      const fileCount = this.db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt;
      const symbolCount = this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt;
      const depCount = this.db.prepare('SELECT COUNT(*) as cnt FROM dependencies').get().cnt;
      const modCount = this.db.prepare('SELECT COUNT(*) as cnt FROM modules').get().cnt;
      insertMeta.run('total_files', String(fileCount));
      insertMeta.run('total_symbols', String(symbolCount));
      insertMeta.run('file_count', String(fileCount));
      insertMeta.run('symbol_count', String(symbolCount));
      insertMeta.run('dependency_count', String(depCount));
      insertMeta.run('module_count', String(modCount));
    });

    updateMetaTx();
  }
}

// ============================================================
// CLI Entry Point
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoRoot = args[0] || process.cwd();
  const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : undefined;
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : undefined;

  const updater = new GraphUpdater(repoRoot, dbPath);
  updater.update(since);
}

module.exports = { GraphUpdater };
