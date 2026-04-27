#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Interfaces.yaml Validator
// ============================================================
// Validates the structural correctness of an interfaces.yaml file.
// Two modes:
//   1. Structural: schema validation of a single interfaces.yaml
//   2. Cross-repo: validate dependencies resolve across system graph (Phase 2+)

// ============================================================
// Schema Definitions
// ============================================================

const VALID_INTERFACE_TYPES = new Set(['api', 'event', 'package', 'rpc', 'database']);
const VALID_PROTOCOLS = new Set([
  'rest', 'grpc', 'graphql',
  'kafka', 'rabbitmq', 'redis-pubsub', 'sqs', 'celery',
  'npm', 'pypi', 'maven', 'nuget',
  null, undefined,
]);
const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

// ============================================================
// Main Validation API
// ============================================================

/**
 * Validate an interfaces.yaml file (parsed as object).
 * @param {object} data - Parsed YAML content
 * @param {object} opts - Options
 * @param {boolean} opts.strict - Fail on warnings too
 * @returns {{ valid: boolean, errors: object[], warnings: object[] }}
 */
function validate(data, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    errors.push({ path: '', message: 'interfaces.yaml must be a YAML object', severity: 'error' });
    return { valid: false, errors, warnings };
  }

  // Validate service section
  validateService(data.service, errors, warnings);

  // Validate exports
  if (data.exports !== undefined) {
    if (!Array.isArray(data.exports)) {
      errors.push({ path: 'exports', message: 'exports must be an array', severity: 'error' });
    } else {
      for (let i = 0; i < data.exports.length; i++) {
        validateExport(data.exports[i], `exports[${i}]`, errors, warnings);
      }
    }
  }

  // Validate imports
  if (data.imports !== undefined) {
    if (!Array.isArray(data.imports)) {
      errors.push({ path: 'imports', message: 'imports must be an array', severity: 'error' });
    } else {
      for (let i = 0; i < data.imports.length; i++) {
        validateImport(data.imports[i], `imports[${i}]`, errors, warnings);
      }
    }
  }

  // Check for unknown top-level keys
  const KNOWN_KEYS = new Set(['service', 'exports', 'imports']);
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push({ path: key, message: `Unknown top-level key: ${key}`, severity: 'warning' });
    }
  }

  const valid = errors.length === 0 && (!opts.strict || warnings.length === 0);
  return { valid, errors, warnings };
}

/**
 * Validate an interfaces.yaml file from disk.
 * @param {string} filePath - Path to interfaces.yaml
 * @param {object} opts - Validation options
 * @returns {{ valid: boolean, errors: object[], warnings: object[], data: object|null }}
 */
function validateFile(filePath, opts = {}) {
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    return {
      valid: false,
      errors: [{ path: '', message: `File not found: ${absPath}`, severity: 'error' }],
      warnings: [],
      data: null,
    };
  }

  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    // Fallback: try basic YAML parsing
    return {
      valid: false,
      errors: [{ path: '', message: 'js-yaml module not available — run npm install in forge-system/', severity: 'error' }],
      warnings: [],
      data: null,
    };
  }

  let data;
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    data = yaml.load(content);
  } catch (e) {
    return {
      valid: false,
      errors: [{ path: '', message: `YAML parse error: ${e.message}`, severity: 'error' }],
      warnings: [],
      data: null,
    };
  }

  const result = validate(data, opts);
  result.data = data;
  return result;
}

// ============================================================
// Section Validators
// ============================================================

function validateService(service, errors, warnings) {
  if (!service) {
    errors.push({ path: 'service', message: 'service section is required', severity: 'error' });
    return;
  }

  if (typeof service !== 'object') {
    errors.push({ path: 'service', message: 'service must be an object', severity: 'error' });
    return;
  }

  if (!service.name || typeof service.name !== 'string') {
    errors.push({ path: 'service.name', message: 'service.name is required and must be a string', severity: 'error' });
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(service.name)) {
    warnings.push({ path: 'service.name', message: `service.name "${service.name}" should be lowercase kebab-case`, severity: 'warning' });
  }

  if (!service.repo || typeof service.repo !== 'string') {
    errors.push({ path: 'service.repo', message: 'service.repo is required and must be a string', severity: 'error' });
  }

  if (service.team && typeof service.team !== 'string') {
    errors.push({ path: 'service.team', message: 'service.team must be a string', severity: 'error' });
  }

  if (service.version && typeof service.version !== 'string') {
    errors.push({ path: 'service.version', message: 'service.version must be a string', severity: 'error' });
  }

  if (service.description && typeof service.description !== 'string') {
    errors.push({ path: 'service.description', message: 'service.description must be a string', severity: 'error' });
  }
}

function validateExport(exp, pathPrefix, errors, warnings) {
  if (!exp || typeof exp !== 'object') {
    errors.push({ path: pathPrefix, message: 'export entry must be an object', severity: 'error' });
    return;
  }

  // Required: type
  if (!exp.type) {
    errors.push({ path: `${pathPrefix}.type`, message: 'type is required', severity: 'error' });
  } else if (!VALID_INTERFACE_TYPES.has(exp.type)) {
    errors.push({
      path: `${pathPrefix}.type`,
      message: `Invalid type "${exp.type}". Must be one of: ${[...VALID_INTERFACE_TYPES].join(', ')}`,
      severity: 'error',
    });
  }

  // Validate protocol if present
  if (exp.protocol && !VALID_PROTOCOLS.has(exp.protocol)) {
    warnings.push({
      path: `${pathPrefix}.protocol`,
      message: `Unknown protocol "${exp.protocol}". Known protocols: ${[...VALID_PROTOCOLS].filter(Boolean).join(', ')}`,
      severity: 'warning',
    });
  }

  // Type-specific validations
  if (exp.type === 'api') {
    validateAPIExport(exp, pathPrefix, errors, warnings);
  } else if (exp.type === 'event') {
    validateEventExport(exp, pathPrefix, errors, warnings);
  } else if (exp.type === 'rpc') {
    validateRPCExport(exp, pathPrefix, errors, warnings);
  } else if (exp.type === 'package') {
    validatePackageExport(exp, pathPrefix, errors, warnings);
  } else if (exp.type === 'database') {
    validateDatabaseExport(exp, pathPrefix, errors, warnings);
  }
}

function validateAPIExport(exp, pathPrefix, errors, warnings) {
  if (exp.endpoints) {
    if (!Array.isArray(exp.endpoints)) {
      errors.push({ path: `${pathPrefix}.endpoints`, message: 'endpoints must be an array', severity: 'error' });
    } else {
      for (let i = 0; i < exp.endpoints.length; i++) {
        const ep = exp.endpoints[i];
        const epPath = `${pathPrefix}.endpoints[${i}]`;

        if (!ep.method) {
          errors.push({ path: `${epPath}.method`, message: 'endpoint method is required', severity: 'error' });
        } else if (!VALID_HTTP_METHODS.has(ep.method.toUpperCase())) {
          errors.push({ path: `${epPath}.method`, message: `Invalid HTTP method: ${ep.method}`, severity: 'error' });
        }

        if (!ep.path) {
          errors.push({ path: `${epPath}.path`, message: 'endpoint path is required', severity: 'error' });
        } else if (!ep.path.startsWith('/')) {
          warnings.push({ path: `${epPath}.path`, message: 'endpoint path should start with /', severity: 'warning' });
        }
      }
    }
  }
}

function validateEventExport(exp, pathPrefix, errors, warnings) {
  if (!exp.topic && !exp.name) {
    warnings.push({ path: pathPrefix, message: 'event export should have a topic or name', severity: 'warning' });
  }
}

function validateRPCExport(exp, pathPrefix, errors, warnings) {
  if (!exp.service && !exp.name) {
    warnings.push({ path: pathPrefix, message: 'rpc export should have a service name', severity: 'warning' });
  }
  if (exp.methods && !Array.isArray(exp.methods)) {
    errors.push({ path: `${pathPrefix}.methods`, message: 'methods must be an array', severity: 'error' });
  }
}

function validatePackageExport(exp, pathPrefix, errors, warnings) {
  if (!exp.name) {
    errors.push({ path: `${pathPrefix}.name`, message: 'package name is required', severity: 'error' });
  }
}

function validateDatabaseExport(exp, pathPrefix, errors, warnings) {
  if (exp.tables && !Array.isArray(exp.tables)) {
    errors.push({ path: `${pathPrefix}.tables`, message: 'tables must be an array', severity: 'error' });
  }
  if (!exp.name && !exp.tables) {
    warnings.push({ path: pathPrefix, message: 'database export should have a name or tables list', severity: 'warning' });
  }
}

function validateImport(imp, pathPrefix, errors, warnings) {
  if (!imp || typeof imp !== 'object') {
    errors.push({ path: pathPrefix, message: 'import entry must be an object', severity: 'error' });
    return;
  }

  // Required: type
  if (!imp.type) {
    errors.push({ path: `${pathPrefix}.type`, message: 'type is required', severity: 'error' });
  } else if (!VALID_INTERFACE_TYPES.has(imp.type)) {
    errors.push({
      path: `${pathPrefix}.type`,
      message: `Invalid type "${imp.type}". Must be one of: ${[...VALID_INTERFACE_TYPES].join(', ')}`,
      severity: 'error',
    });
  }

  // Imports should reference a service or package name
  if (!imp.service && !imp.name) {
    warnings.push({
      path: pathPrefix,
      message: 'import should reference a service or package name',
      severity: 'warning',
    });
  }

  // Deprecated flag
  if (imp.deprecated === true) {
    warnings.push({
      path: pathPrefix,
      message: `Deprecated import: ${imp.service || imp.name || 'unknown'} — consider removing`,
      severity: 'warning',
    });
  }

  // Direct database access is a coupling anti-pattern
  if (imp.type === 'database') {
    warnings.push({
      path: pathPrefix,
      message: `Direct database import from ${imp.service || 'unknown'} — tight coupling anti-pattern. Consider using an API instead.`,
      severity: 'warning',
    });
  }
}

// ============================================================
// Cross-Repo Validation (Phase 2+)
// ============================================================

/**
 * Validate cross-repo contracts using the system graph.
 * Requires system-graph.db to be built (Phase 2).
 * @param {string} dbPath - Path to system-graph.db
 * @returns {{ valid: boolean, errors: object[], warnings: object[] }}
 */
function validateSystem(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return {
      valid: false,
      errors: [{ path: '', message: 'better-sqlite3 not available', severity: 'error' }],
      warnings: [],
    };
  }

  if (!fs.existsSync(dbPath)) {
    return {
      valid: false,
      errors: [{ path: '', message: `System graph not found: ${dbPath}`, severity: 'error' }],
      warnings: [],
    };
  }

  const db = new Database(dbPath, { readonly: true });
  const errors = [];
  const warnings = [];

  try {
    // Check 1: Orphan imports — service imports from provider that doesn't exist
    const orphanImports = db.prepare(`
      SELECT d.consumer_id, d.provider_id, d.type
      FROM dependencies d
      WHERE d.provider_id NOT IN (SELECT id FROM services)
    `).all();

    for (const dep of orphanImports) {
      errors.push({
        path: `dependencies`,
        message: `Service "${dep.consumer_id}" imports from unknown service "${dep.provider_id}" (type: ${dep.type})`,
        severity: 'error',
      });
    }

    // Check 2: Unresolved interface references
    const unresolvedRefs = db.prepare(`
      SELECT d.consumer_id, d.provider_id, d.interface_id, d.type
      FROM dependencies d
      WHERE d.interface_id IS NOT NULL
        AND d.interface_id NOT IN (SELECT id FROM interfaces)
    `).all();

    for (const dep of unresolvedRefs) {
      errors.push({
        path: 'dependencies',
        message: `Dependency from "${dep.consumer_id}" to "${dep.provider_id}" references non-existent interface ID ${dep.interface_id}`,
        severity: 'error',
      });
    }

    // Check 3: Deprecated dependencies still in use
    const deprecatedDeps = db.prepare(`
      SELECT d.consumer_id, d.provider_id, d.type, d.usage
      FROM dependencies d
      WHERE d.deprecated = 1
    `).all();

    for (const dep of deprecatedDeps) {
      warnings.push({
        path: 'dependencies',
        message: `Deprecated dependency: "${dep.consumer_id}" → "${dep.provider_id}" (${dep.type}). ${dep.usage || ''}`,
        severity: 'warning',
      });
    }

    // Check 4: Circular service dependencies
    const cycles = detectServiceCycles(db);
    for (const cycle of cycles) {
      errors.push({
        path: 'dependencies',
        message: `Circular dependency detected: ${cycle.join(' → ')}`,
        severity: 'error',
      });
    }

    // Check 5: Direct database access (tight coupling)
    const dbAccess = db.prepare(`
      SELECT d.consumer_id, d.provider_id, d.usage
      FROM dependencies d
      WHERE d.type = 'database'
    `).all();

    for (const dep of dbAccess) {
      warnings.push({
        path: 'dependencies',
        message: `Direct database access: "${dep.consumer_id}" reads from "${dep.provider_id}" database — tight coupling. ${dep.usage || ''}`,
        severity: 'warning',
      });
    }

    // Check 6: Stale services (not synced recently)
    const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const staleServices = db.prepare(`
      SELECT id, last_synced
      FROM services
      WHERE last_synced < ? OR last_synced IS NULL
    `).all(staleThreshold);

    for (const svc of staleServices) {
      warnings.push({
        path: 'services',
        message: `Service "${svc.id}" last synced ${svc.last_synced || 'never'} — may be stale`,
        severity: 'warning',
      });
    }

  } finally {
    db.close();
  }

  const valid = errors.length === 0;
  return { valid, errors, warnings };
}

function detectServiceCycles(db) {
  const edges = db.prepare('SELECT DISTINCT consumer_id, provider_id FROM dependencies').all();
  const graph = new Map();

  for (const edge of edges) {
    if (!graph.has(edge.consumer_id)) graph.set(edge.consumer_id, new Set());
    graph.get(edge.consumer_id).add(edge.provider_id);
  }

  const cycles = [];
  const visited = new Set();
  const stack = new Set();

  function dfs(node, path) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    const neighbors = graph.get(node) || new Set();
    for (const neighbor of neighbors) {
      dfs(neighbor, path);
    }

    path.pop();
    stack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

// ============================================================
// CLI Entry Point
// ============================================================

function printResults(result) {
  let chalk;
  try {
    chalk = require('chalk');
  } catch {
    chalk = { bold: s => s, green: s => s, yellow: s => s, red: s => s, dim: s => s };
  }

  console.log('');
  console.log(chalk.bold('  Validation Results'));
  console.log(chalk.dim('  ─────────────────────'));

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log(`  ${chalk.green('✓')} All checks passed`);
  }

  for (const err of result.errors) {
    console.log(`  ${chalk.red('✗')} ${chalk.bold(err.path || 'root')}: ${err.message}`);
  }

  for (const warn of result.warnings) {
    console.log(`  ${chalk.yellow('⚠')} ${chalk.bold(warn.path || 'root')}: ${warn.message}`);
  }

  console.log('');
  console.log(chalk.dim(`  Errors: ${result.errors.length}  Warnings: ${result.warnings.length}`));
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const strict = args.includes('--strict');

  // Determine mode: file validation or system validation
  const dbArg = args.find((a, i) => args[i - 1] === '--db');
  const fileArg = args.find(a => !a.startsWith('--') && a !== dbArg);

  let result;

  if (dbArg) {
    // Cross-repo system validation
    result = validateSystem(dbArg);
  } else {
    // Single file validation
    const filePath = fileArg || path.join(process.cwd(), '.forge', 'interfaces.yaml');
    result = validateFile(filePath, { strict });
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResults(result);
  }

  process.exit(result.valid ? 0 : 1);
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  validate,
  validateFile,
  validateSystem,
  detectServiceCycles,
  printResults,
  VALID_INTERFACE_TYPES,
  VALID_PROTOCOLS,
  VALID_HTTP_METHODS,
};
