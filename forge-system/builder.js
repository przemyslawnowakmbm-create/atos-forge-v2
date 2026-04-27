#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// System Graph Builder
// ============================================================
// Builds system-graph.db from interfaces.yaml files across repos.
// Two modes:
//   1. From repos registry (repos.json or --path glob)
//   2. Rebuild from existing .forge/interfaces.yaml files

// ============================================================
// Main Build API
// ============================================================

/**
 * Build a system graph from a list of repo paths.
 * @param {object[]} repos - Array of { name, path } objects
 * @param {string} outputPath - Path for system-graph.db
 * @param {object} opts - Build options
 * @returns {{ services: number, interfaces: number, dependencies: number, warnings: string[] }}
 */
function build(repos, outputPath, opts = {}) {
  const Database = require('better-sqlite3');
  const yaml = require('js-yaml');

  // Create/recreate database
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(outputPath) && !opts.append) fs.unlinkSync(outputPath);

  const db = new Database(outputPath);
  const schemaPath = path.join(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));

  const warnings = [];
  let serviceCount = 0;
  let interfaceCount = 0;

  // Phase 1: Insert all services and their interfaces
  const allServices = [];
  const allExports = new Map(); // key: "service:type:name" → interface row

  const insertService = db.prepare(`
    INSERT OR REPLACE INTO services (id, repo, team, description, version, local_graph_path, repo_path, interfaces_hash, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertInterface = db.prepare(`
    INSERT OR REPLACE INTO interfaces (service_id, type, protocol, name, description, spec_path, schema_path, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTeam = db.prepare(`
    INSERT OR REPLACE INTO teams (id, description, services)
    VALUES (?, ?, ?)
  `);

  const insertSyncLog = db.prepare(`
    INSERT INTO sync_log (service_id, synced_at, interfaces_hash, changes_summary)
    VALUES (?, ?, ?, ?)
  `);

  const teamServices = new Map(); // team → [service_ids]

  const insertAll = db.transaction(() => {
    for (const repo of repos) {
      const repoPath = path.resolve(repo.path);
      const interfacesPath = path.join(repoPath, '.forge', 'interfaces.yaml');

      if (!fs.existsSync(interfacesPath)) {
        warnings.push(`No .forge/interfaces.yaml in ${repo.name} (${repoPath})`);
        continue;
      }

      let data;
      try {
        data = yaml.load(fs.readFileSync(interfacesPath, 'utf8'));
      } catch (e) {
        warnings.push(`Failed to parse ${interfacesPath}: ${e.message}`);
        continue;
      }

      if (!data || !data.service || !data.service.name) {
        warnings.push(`Invalid interfaces.yaml in ${repo.name}: missing service.name`);
        continue;
      }

      const svc = data.service;
      const serviceId = svc.name;
      const content = fs.readFileSync(interfacesPath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      const now = new Date().toISOString();

      // Check for graph.db
      const graphDbPath = path.join(repoPath, '.forge', 'graph.db');
      const localGraphPath = fs.existsSync(graphDbPath) ? graphDbPath : null;

      insertService.run(
        serviceId,
        svc.repo || repo.name,
        svc.team || null,
        svc.description || null,
        svc.version || null,
        localGraphPath,
        repoPath,
        hash,
        now
      );
      serviceCount++;
      allServices.push(serviceId);

      // Track teams
      if (svc.team) {
        if (!teamServices.has(svc.team)) teamServices.set(svc.team, []);
        teamServices.get(svc.team).push(serviceId);
      }

      // Insert exports
      if (Array.isArray(data.exports)) {
        for (const exp of data.exports) {
          const ifaceName = exp.name || exp.topic || exp.service_name || `${exp.type}:${serviceId}`;
          insertInterface.run(
            serviceId,
            exp.type || 'unknown',
            exp.protocol || null,
            ifaceName,
            exp.description || null,
            exp.spec || exp.spec_path || null,
            exp.schema || exp.schema_path || null,
            JSON.stringify(sanitizeMetadata(exp))
          );
          interfaceCount++;

          // Index for dependency resolution
          const key = normalizeInterfaceKey(serviceId, exp);
          allExports.set(key, { serviceId, ifaceName, type: exp.type });

          // Also index by name alone for fuzzy matching
          if (ifaceName) {
            allExports.set(`name:${ifaceName}`, { serviceId, ifaceName, type: exp.type });
          }
          if (exp.topic) {
            allExports.set(`topic:${exp.topic}`, { serviceId, ifaceName: exp.topic, type: exp.type });
          }
        }
      }

      // Log sync
      insertSyncLog.run(serviceId, now, hash, 'Initial build');
    }

    // Insert teams
    for (const [teamId, services] of teamServices) {
      insertTeam.run(teamId, null, JSON.stringify(services));
    }
  });

  insertAll();

  // Phase 2: Resolve imports → dependencies
  const insertDep = db.prepare(`
    INSERT OR IGNORE INTO dependencies (consumer_id, provider_id, interface_id, type, usage, deprecated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const findInterface = db.prepare(`
    SELECT id FROM interfaces WHERE service_id = ? AND type = ? AND name = ?
  `);

  let depCount = 0;

  const resolveImports = db.transaction(() => {
    for (const repo of repos) {
      const repoPath = path.resolve(repo.path);
      const interfacesPath = path.join(repoPath, '.forge', 'interfaces.yaml');
      if (!fs.existsSync(interfacesPath)) continue;

      let data;
      try {
        data = yaml.load(fs.readFileSync(interfacesPath, 'utf8'));
      } catch { continue; }

      if (!data || !data.service || !Array.isArray(data.imports)) continue;

      const consumerId = data.service.name;

      for (const imp of data.imports) {
        const providerId = imp.service || null;
        const type = imp.type || 'unknown';
        const usage = imp.usage || null;
        const deprecated = imp.deprecated ? 1 : 0;

        // Try to resolve the provider
        let resolvedProvider = providerId;
        let interfaceId = null;

        if (providerId) {
          // Direct match: service name
          const providerExists = allServices.includes(providerId);
          if (!providerExists) {
            // Try fuzzy: strip -service suffix, add it, etc.
            const fuzzy = fuzzyMatchService(providerId, allServices);
            if (fuzzy) {
              resolvedProvider = fuzzy;
            } else {
              warnings.push(`Unresolved import: ${consumerId} → ${providerId} (${type}). Provider not found in system.`);
              // Still insert with the declared name — it may be an external service
              resolvedProvider = providerId;
            }
          }

          // Try to find the specific interface
          if (imp.topic) {
            const iface = findInterface.get(resolvedProvider, type, imp.topic);
            if (iface) interfaceId = iface.id;
          } else if (imp.name) {
            const iface = findInterface.get(resolvedProvider, type, imp.name);
            if (iface) interfaceId = iface.id;
          }
        } else if (imp.topic) {
          // No explicit service — try to find who exports this topic
          const match = allExports.get(`topic:${imp.topic}`);
          if (match) {
            resolvedProvider = match.serviceId;
            const iface = findInterface.get(match.serviceId, type, imp.topic);
            if (iface) interfaceId = iface.id;
          }
        } else if (imp.name) {
          // Try to find by name
          const match = allExports.get(`name:${imp.name}`);
          if (match) {
            resolvedProvider = match.serviceId;
          }
        }

        if (resolvedProvider && resolvedProvider !== consumerId) {
          // Ensure provider exists as a service (may be external)
          const svcExists = db.prepare('SELECT id FROM services WHERE id = ?').get(resolvedProvider);
          if (!svcExists) {
            // Insert placeholder for external service
            insertService.run(resolvedProvider, resolvedProvider, null, `External service (auto-created)`, null, null, null, null, new Date().toISOString());
          }

          insertDep.run(consumerId, resolvedProvider, interfaceId, type, usage, deprecated);
          depCount++;
        }
      }
    }
  });

  resolveImports();

  // Phase 3: Compute metrics
  computeMetrics(db);

  // Phase 4: Set metadata
  const insertMeta = db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)');
  insertMeta.run('build_date', new Date().toISOString());
  insertMeta.run('schema_version', '1.0');
  insertMeta.run('service_count', String(serviceCount));
  insertMeta.run('interface_count', String(interfaceCount));
  insertMeta.run('dependency_count', String(depCount));
  insertMeta.run('warning_count', String(warnings.length));

  db.close();

  return {
    services: serviceCount,
    interfaces: interfaceCount,
    dependencies: depCount,
    warnings,
    output: outputPath,
  };
}

/**
 * Build from a repos.json file.
 * @param {string} registryPath - Path to repos.json
 * @param {string} outputPath - Path for system-graph.db
 * @param {object} opts - Build options
 */
function buildFromRegistry(registryPath, outputPath, opts = {}) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const repos = registry.repos || registry;
  if (!Array.isArray(repos)) {
    throw new Error(`Invalid repos registry: expected "repos" array in ${registryPath}`);
  }
  return build(repos, outputPath, opts);
}

/**
 * Build from a filesystem glob pattern.
 * @param {string} pattern - Glob pattern or directory containing repos
 * @param {string} outputPath - Path for system-graph.db
 * @param {object} opts - Build options
 */
function buildFromPath(pattern, outputPath, opts = {}) {
  const resolvedPattern = path.resolve(pattern);

  let repoDirs;
  if (fs.existsSync(resolvedPattern) && fs.statSync(resolvedPattern).isDirectory()) {
    // It's a directory — scan subdirectories for repos
    repoDirs = fs.readdirSync(resolvedPattern)
      .map(name => path.join(resolvedPattern, name))
      .filter(p => {
        try {
          return fs.statSync(p).isDirectory() &&
            (fs.existsSync(path.join(p, '.forge', 'interfaces.yaml')) ||
             fs.existsSync(path.join(p, '.git')));
        } catch { return false; }
      });
  } else {
    // Treat as a single repo path
    repoDirs = [resolvedPattern];
  }

  const repos = repoDirs.map(p => ({
    name: path.basename(p),
    path: p,
  }));

  return build(repos, outputPath, opts);
}

// ============================================================
// Metrics Computation
// ============================================================

function computeMetrics(db) {
  const services = db.prepare('SELECT id FROM services').all();

  const insertMetric = db.prepare(`
    INSERT OR REPLACE INTO service_metrics (service_id, fan_in, fan_out, interface_count, coupling_score, risk_level)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getFanIn = db.prepare('SELECT COUNT(DISTINCT consumer_id) as count FROM dependencies WHERE provider_id = ?');
  const getFanOut = db.prepare('SELECT COUNT(DISTINCT provider_id) as count FROM dependencies WHERE consumer_id = ?');
  const getInterfaceCount = db.prepare('SELECT COUNT(*) as count FROM interfaces WHERE service_id = ?');

  const updateMetrics = db.transaction(() => {
    let maxCoupling = 0;
    const couplingScores = [];

    for (const svc of services) {
      const fanIn = getFanIn.get(svc.id).count;
      const fanOut = getFanOut.get(svc.id).count;
      const ifaceCount = getInterfaceCount.get(svc.id).count;
      const rawCoupling = fanIn * fanOut;
      couplingScores.push({ id: svc.id, fanIn, fanOut, ifaceCount, rawCoupling });
      if (rawCoupling > maxCoupling) maxCoupling = rawCoupling;
    }

    for (const s of couplingScores) {
      const normalizedCoupling = maxCoupling > 0 ? s.rawCoupling / maxCoupling : 0;
      const riskLevel = calculateRiskLevel(s.fanIn, s.fanOut, normalizedCoupling);
      insertMetric.run(s.id, s.fanIn, s.fanOut, s.ifaceCount, normalizedCoupling, riskLevel);
    }
  });

  updateMetrics();
}

function calculateRiskLevel(fanIn, fanOut, coupling) {
  // High fan-in + any fan-out = critical (many consumers, change is dangerous)
  if (fanIn >= 10) return 'critical';
  if (fanIn >= 5 && fanOut >= 3) return 'high';
  if (fanIn >= 3 || coupling > 0.5) return 'medium';
  return 'low';
}

// ============================================================
// Helper Functions
// ============================================================

function normalizeInterfaceKey(serviceId, exp) {
  const type = exp.type || 'unknown';
  const name = exp.name || exp.topic || exp.service_name || '';
  return `${serviceId}:${type}:${name}`;
}

function sanitizeMetadata(exp) {
  // Extract type-specific metadata, excluding standard fields
  const standard = new Set(['type', 'protocol', 'name', 'description', 'spec', 'spec_path', 'schema', 'schema_path', '_detector']);
  const meta = {};
  for (const [key, value] of Object.entries(exp)) {
    if (!standard.has(key)) {
      meta[key] = value;
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function fuzzyMatchService(name, services) {
  // Try exact match first
  if (services.includes(name)) return name;

  // Try with/without -service suffix
  const withSuffix = name.endsWith('-service') ? name : `${name}-service`;
  const withoutSuffix = name.endsWith('-service') ? name.replace(/-service$/, '') : name;

  if (services.includes(withSuffix)) return withSuffix;
  if (services.includes(withoutSuffix)) return withoutSuffix;

  // Try lowercase
  const lower = name.toLowerCase();
  const match = services.find(s => s.toLowerCase() === lower);
  if (match) return match;

  return null;
}

// ============================================================
// CLI Entry Point
// ============================================================

function printResult(result) {
  let chalk;
  try { chalk = require('chalk'); } catch {
    chalk = { bold: s => s, green: s => s, yellow: s => s, red: s => s, dim: s => s, cyan: s => s };
  }

  console.log('');
  console.log(chalk.bold('  System Graph Build Results'));
  console.log(chalk.dim('  ──────────────────────────────'));
  console.log(`  Services:     ${chalk.cyan(result.services)}`);
  console.log(`  Interfaces:   ${chalk.cyan(result.interfaces)}`);
  console.log(`  Dependencies: ${chalk.cyan(result.dependencies)}`);
  console.log(`  Output:       ${chalk.dim(result.output)}`);
  console.log('');

  if (result.warnings.length > 0) {
    console.log(chalk.yellow(`  Warnings (${result.warnings.length}):`));
    for (const w of result.warnings) {
      console.log(`    ${chalk.yellow('⚠')} ${w}`);
    }
    console.log('');
  }

  console.log(`  ${chalk.green('✓')} System graph built successfully`);
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const reposIdx = args.indexOf('--repos');
  const pathIdx = args.indexOf('--path');
  const outputIdx = args.indexOf('--output');

  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : path.join(process.cwd(), '.forge', 'system-graph.db');

  let result;

  if (reposIdx !== -1) {
    result = buildFromRegistry(args[reposIdx + 1], outputPath);
  } else if (pathIdx !== -1) {
    result = buildFromPath(args[pathIdx + 1], outputPath);
  } else {
    // Default: scan current directory for repos
    result = buildFromPath(process.cwd(), outputPath);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  process.exit(result.warnings.length > 0 ? 0 : 0); // Warnings don't fail the build
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  build,
  buildFromRegistry,
  buildFromPath,
  computeMetrics,
  fuzzyMatchService,
};
