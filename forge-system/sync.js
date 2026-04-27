#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// System Graph Incremental Sync
// ============================================================
// Updates the system graph when a single repo's interfaces.yaml changes.
// Hash-based change detection: skip sync if nothing changed.
// Triggered by: forge-init, git hooks, CI pipeline, manual command.

// ============================================================
// Main Sync API
// ============================================================

/**
 * Sync a single repo's interfaces.yaml into the system graph.
 * @param {string} repoPath - Path to the repository root
 * @param {string} dbPath - Path to system-graph.db
 * @param {object} opts - Options
 * @param {boolean} opts.force - Skip hash check, always re-sync
 * @returns {{ synced: boolean, changes: string|null, service: string|null }}
 */
function sync(repoPath, dbPath, opts = {}) {
  const Database = require('better-sqlite3');
  const yaml = require('js-yaml');

  const absRepo = path.resolve(repoPath);
  const interfacesPath = path.join(absRepo, '.forge', 'interfaces.yaml');

  if (!fs.existsSync(interfacesPath)) {
    return { synced: false, changes: null, service: null, reason: 'No .forge/interfaces.yaml found' };
  }

  if (!fs.existsSync(dbPath)) {
    return { synced: false, changes: null, service: null, reason: `System graph not found: ${dbPath}` };
  }

  // Read and parse interfaces.yaml
  const content = fs.readFileSync(interfacesPath, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

  let data;
  try {
    data = yaml.load(content);
  } catch (e) {
    return { synced: false, changes: null, service: null, reason: `YAML parse error: ${e.message}` };
  }

  if (!data || !data.service || !data.service.name) {
    return { synced: false, changes: null, service: null, reason: 'Invalid interfaces.yaml: missing service.name' };
  }

  const serviceId = data.service.name;
  const now = new Date().toISOString();

  const db = new Database(dbPath);

  try {
    // Check if already synced with same hash
    if (!opts.force) {
      const existing = db.prepare('SELECT interfaces_hash FROM services WHERE id = ?').get(serviceId);
      if (existing && existing.interfaces_hash === hash) {
        return { synced: false, changes: null, service: serviceId, reason: 'No changes (hash match)' };
      }
    }

    // Determine what changed
    const changes = describeChanges(db, serviceId, data);

    // Transaction: delete old data, re-insert
    const syncTransaction = db.transaction(() => {
      // Delete old data for this service
      db.prepare('DELETE FROM dependencies WHERE consumer_id = ? OR provider_id = ?').run(serviceId, serviceId);
      db.prepare('DELETE FROM interfaces WHERE service_id = ?').run(serviceId);
      db.prepare('DELETE FROM service_metrics WHERE service_id = ?').run(serviceId);

      // Check for graph.db
      const graphDbPath = path.join(absRepo, '.forge', 'graph.db');
      const localGraphPath = fs.existsSync(graphDbPath) ? graphDbPath : null;

      // Re-insert service
      db.prepare(`
        INSERT OR REPLACE INTO services (id, repo, team, description, version, local_graph_path, repo_path, interfaces_hash, last_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        serviceId,
        data.service.repo || serviceId,
        data.service.team || null,
        data.service.description || null,
        data.service.version || null,
        localGraphPath,
        absRepo,
        hash,
        now
      );

      // Re-insert interfaces
      if (Array.isArray(data.exports)) {
        const insertInterface = db.prepare(`
          INSERT OR REPLACE INTO interfaces (service_id, type, protocol, name, description, spec_path, schema_path, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

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
        }
      }

      // Re-resolve this service's imports
      if (Array.isArray(data.imports)) {
        const insertDep = db.prepare(`
          INSERT OR IGNORE INTO dependencies (consumer_id, provider_id, interface_id, type, usage, deprecated)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const findInterface = db.prepare('SELECT id FROM interfaces WHERE service_id = ? AND type = ? AND name = ?');
        const serviceExists = db.prepare('SELECT id FROM services WHERE id = ?');

        for (const imp of data.imports) {
          const providerId = imp.service || null;
          if (!providerId) continue;

          // Check if provider exists
          const providerName = resolveProvider(db, providerId);
          if (!providerName) continue;

          let interfaceId = null;
          if (imp.topic) {
            const iface = findInterface.get(providerName, imp.type || 'unknown', imp.topic);
            if (iface) interfaceId = iface.id;
          } else if (imp.name) {
            const iface = findInterface.get(providerName, imp.type || 'unknown', imp.name);
            if (iface) interfaceId = iface.id;
          }

          insertDep.run(
            serviceId,
            providerName,
            interfaceId,
            imp.type || 'unknown',
            imp.usage || null,
            imp.deprecated ? 1 : 0
          );
        }
      }

      // Re-resolve other services that import from this one
      const otherConsumers = db.prepare(`
        SELECT DISTINCT s.id
        FROM services s
        WHERE s.id != ? AND s.repo_path IS NOT NULL
      `).all(serviceId);

      for (const consumer of otherConsumers) {
        // Check if this consumer has imports referencing our service
        const existingDeps = db.prepare(`
          SELECT id FROM dependencies WHERE consumer_id = ? AND provider_id = ?
        `).all(consumer.id, serviceId);

        // If there were dependencies, they were already deleted above
        // Try to re-resolve from the consumer's interfaces.yaml
        const consumerInterfacesPath = db.prepare('SELECT repo_path FROM services WHERE id = ?').get(consumer.id);
        if (consumerInterfacesPath && consumerInterfacesPath.repo_path) {
          const consumerYamlPath = path.join(consumerInterfacesPath.repo_path, '.forge', 'interfaces.yaml');
          if (fs.existsSync(consumerYamlPath)) {
            try {
              const consumerData = yaml.load(fs.readFileSync(consumerYamlPath, 'utf8'));
              if (consumerData && Array.isArray(consumerData.imports)) {
                for (const imp of consumerData.imports) {
                  if (imp.service === serviceId || resolveProvider(db, imp.service) === serviceId) {
                    let interfaceId = null;
                    if (imp.topic) {
                      const iface = db.prepare('SELECT id FROM interfaces WHERE service_id = ? AND name = ?').get(serviceId, imp.topic);
                      if (iface) interfaceId = iface.id;
                    }
                    db.prepare(`
                      INSERT OR IGNORE INTO dependencies (consumer_id, provider_id, interface_id, type, usage, deprecated)
                      VALUES (?, ?, ?, ?, ?, ?)
                    `).run(consumer.id, serviceId, interfaceId, imp.type || 'unknown', imp.usage || null, imp.deprecated ? 1 : 0);
                  }
                }
              }
            } catch { /* skip consumers with bad YAML */ }
          }
        }
      }

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (service_id, synced_at, interfaces_hash, changes_summary)
        VALUES (?, ?, ?, ?)
      `).run(serviceId, now, hash, changes);
    });

    syncTransaction();

    // Recompute metrics for affected services
    recomputeAffectedMetrics(db, serviceId);

    // Update system meta
    const svcCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
    const ifaceCount = db.prepare('SELECT COUNT(*) as c FROM interfaces').get().c;
    const depCount = db.prepare('SELECT COUNT(*) as c FROM dependencies').get().c;
    db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)').run('service_count', String(svcCount));
    db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)').run('interface_count', String(ifaceCount));
    db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)').run('dependency_count', String(depCount));
    db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)').run('last_sync', now);

    return { synced: true, changes, service: serviceId };
  } finally {
    db.close();
  }
}

// ============================================================
// Helpers
// ============================================================

function describeChanges(db, serviceId, newData) {
  const oldExports = db.prepare('SELECT type, name FROM interfaces WHERE service_id = ?').all(serviceId);
  const oldExportSet = new Set(oldExports.map(e => `${e.type}:${e.name}`));

  const newExports = (newData.exports || []).map(e => {
    const name = e.name || e.topic || e.service_name || `${e.type}:${serviceId}`;
    return `${e.type}:${name}`;
  });
  const newExportSet = new Set(newExports);

  const added = newExports.filter(e => !oldExportSet.has(e));
  const removed = [...oldExportSet].filter(e => !newExportSet.has(e));

  const parts = [];
  if (added.length > 0) parts.push(`+${added.length} exports`);
  if (removed.length > 0) parts.push(`-${removed.length} exports`);
  if (parts.length === 0) {
    if (oldExports.length === 0 && newExports.length > 0) return `Initial sync: ${newExports.length} exports`;
    return 'Metadata update (no export changes)';
  }
  return parts.join(', ');
}

function resolveProvider(db, providerId) {
  if (!providerId) return null;
  const exists = db.prepare('SELECT id FROM services WHERE id = ?').get(providerId);
  if (exists) return exists.id;

  // Fuzzy match
  const withSuffix = providerId.endsWith('-service') ? providerId : `${providerId}-service`;
  const withoutSuffix = providerId.endsWith('-service') ? providerId.replace(/-service$/, '') : providerId;

  const match1 = db.prepare('SELECT id FROM services WHERE id = ?').get(withSuffix);
  if (match1) return match1.id;
  const match2 = db.prepare('SELECT id FROM services WHERE id = ?').get(withoutSuffix);
  if (match2) return match2.id;

  return null;
}

function recomputeAffectedMetrics(db, serviceId) {
  // Recompute metrics for this service and all its direct neighbors
  const affected = new Set([serviceId]);

  const neighbors = db.prepare(`
    SELECT consumer_id FROM dependencies WHERE provider_id = ?
    UNION
    SELECT provider_id FROM dependencies WHERE consumer_id = ?
  `).all(serviceId, serviceId);

  for (const n of neighbors) {
    affected.add(n.consumer_id || n.provider_id);
  }

  const getFanIn = db.prepare('SELECT COUNT(DISTINCT consumer_id) as count FROM dependencies WHERE provider_id = ?');
  const getFanOut = db.prepare('SELECT COUNT(DISTINCT provider_id) as count FROM dependencies WHERE consumer_id = ?');
  const getInterfaceCount = db.prepare('SELECT COUNT(*) as count FROM interfaces WHERE service_id = ?');

  const insertMetric = db.prepare(`
    INSERT OR REPLACE INTO service_metrics (service_id, fan_in, fan_out, interface_count, coupling_score, risk_level)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Get max coupling for normalization
  const allMetrics = db.prepare('SELECT fan_in, fan_out FROM service_metrics').all();
  let maxCoupling = 1;
  for (const m of allMetrics) {
    const c = m.fan_in * m.fan_out;
    if (c > maxCoupling) maxCoupling = c;
  }

  for (const svcId of affected) {
    const fanIn = getFanIn.get(svcId).count;
    const fanOut = getFanOut.get(svcId).count;
    const ifaceCount = getInterfaceCount.get(svcId).count;
    const rawCoupling = fanIn * fanOut;
    const normalizedCoupling = rawCoupling / maxCoupling;
    const riskLevel = calculateRiskLevel(fanIn, fanOut, normalizedCoupling);
    insertMetric.run(svcId, fanIn, fanOut, ifaceCount, normalizedCoupling, riskLevel);
  }
}

function calculateRiskLevel(fanIn, fanOut, coupling) {
  if (fanIn >= 10) return 'critical';
  if (fanIn >= 5 && fanOut >= 3) return 'high';
  if (fanIn >= 3 || coupling > 0.5) return 'medium';
  return 'low';
}

function sanitizeMetadata(exp) {
  const standard = new Set(['type', 'protocol', 'name', 'description', 'spec', 'spec_path', 'schema', 'schema_path', '_detector']);
  const meta = {};
  for (const [key, value] of Object.entries(exp)) {
    if (!standard.has(key)) {
      meta[key] = value;
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

// ============================================================
// CLI Entry Point
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const force = args.includes('--force');

  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : null;

  const repoPath = args.find(a => !a.startsWith('--') && a !== dbPath) || process.cwd();

  if (!dbPath) {
    // Try to find system-graph.db
    const candidates = [
      path.join(process.cwd(), '.forge', 'system-graph.db'),
      path.join(process.env.HOME || '', '.forge', 'system-graph.db'),
    ];
    const found = candidates.find(c => fs.existsSync(c));
    if (!found) {
      console.error('Error: --db <path> required (no system-graph.db found in default locations)');
      process.exit(1);
    }
    var resolvedDbPath = found;
  } else {
    var resolvedDbPath = dbPath;
  }

  const result = sync(repoPath, resolvedDbPath, { force });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    let chalk;
    try { chalk = require('chalk'); } catch {
      chalk = { bold: s => s, green: s => s, yellow: s => s, dim: s => s, cyan: s => s };
    }

    console.log('');
    if (result.synced) {
      console.log(`  ${chalk.green('✓')} Synced ${chalk.cyan(result.service)} into system graph`);
      if (result.changes) console.log(`    Changes: ${result.changes}`);
    } else {
      console.log(`  ${chalk.dim('–')} ${result.reason || 'Not synced'}`);
      if (result.service) console.log(`    Service: ${result.service}`);
    }
    console.log('');
  }

  process.exit(result.synced ? 0 : 0); // Not syncing isn't an error
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  sync,
};
