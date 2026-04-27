'use strict';
const fs = require('fs');
const path = require('path');

let _Database;
function getDatabase() { if (!_Database) _Database = require('better-sqlite3'); return _Database; }

/**
 * Detect project conventions from the code graph database.
 * Results are saved to graph_meta for use by the agent factory.
 *
 * @param {string} cwd - Project root directory
 * @returns {object|null} Detected conventions or null if graph unavailable
 */
function detectConventions(cwd) {
  const dbPath = path.join(cwd, '.forge', 'graph.db');
  if (!fs.existsSync(dbPath)) return null;

  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });

  const conventions = {
    naming: detectNaming(db),
    importStyle: detectImports(db),
    exportStyle: detectExports(db),
    testFramework: detectTestFramework(cwd),
    semicolons: 'unknown',
    quotes: 'unknown',
  };

  db.close();

  // Save to graph_meta
  try {
    const dbW = new Database(dbPath);
    dbW.prepare('INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)').run('conventions', JSON.stringify(conventions));
    dbW.close();
  } catch {}

  return conventions;
}

/**
 * Detect predominant naming convention from exported symbols.
 */
function detectNaming(db) {
  let symbols;
  try {
    symbols = db.prepare('SELECT name, kind FROM symbols WHERE exported = 1 LIMIT 200').all();
  } catch { return 'unknown'; }

  let camel = 0, snake = 0, pascal = 0;
  for (const s of symbols) {
    // Skip type-like kinds — they should always be PascalCase
    if (['class', 'type', 'interface', 'enum'].includes(s.kind)) continue;
    if (/^[a-z][a-zA-Z0-9]*$/.test(s.name) && /[A-Z]/.test(s.name)) camel++;
    else if (/^[a-z][a-z0-9_]*$/.test(s.name) && s.name.includes('_')) snake++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(s.name)) pascal++;
  }
  const total = camel + snake + pascal;
  if (total === 0) return 'unknown';
  if (camel / total > 0.6) return 'camelCase';
  if (snake / total > 0.6) return 'snake_case';
  if (pascal / total > 0.6) return 'PascalCase';
  return 'mixed';
}

/**
 * Detect whether the project prefers barrel imports (via index files) or direct imports.
 */
function detectImports(db) {
  try {
    const indexImports = db.prepare("SELECT COUNT(*) as cnt FROM dependencies WHERE target_file LIKE '%index%'").get();
    const totalDeps = db.prepare('SELECT COUNT(*) as cnt FROM dependencies').get();
    if (totalDeps.cnt === 0) return 'unknown';
    return (indexImports.cnt / totalDeps.cnt > 0.3) ? 'barrel' : 'direct';
  } catch { return 'unknown'; }
}

/**
 * Detect whether the project prefers named exports or default exports.
 */
function detectExports(db) {
  try {
    const defaultExports = db.prepare("SELECT COUNT(*) as cnt FROM dependencies WHERE import_type = 'default'").get();
    const namedExports = db.prepare("SELECT COUNT(*) as cnt FROM dependencies WHERE import_type = 'named'").get();
    const total = defaultExports.cnt + namedExports.cnt;
    if (total === 0) return 'unknown';
    return (namedExports.cnt / total > 0.7) ? 'named' : (defaultExports.cnt / total > 0.7) ? 'default' : 'mixed';
  } catch { return 'unknown'; }
}

/**
 * Detect the test framework from package.json.
 */
function detectTestFramework(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.jest) return 'jest';
    if (deps.vitest) return 'vitest';
    if (deps.mocha) return 'mocha';
    const testScript = pkg.scripts?.test || '';
    if (testScript.includes('node --test')) return 'node:test';
    return 'unknown';
  } catch { return 'unknown'; }
}

module.exports = { detectConventions };
