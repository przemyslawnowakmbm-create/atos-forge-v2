#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// System Graph Query Engine
// ============================================================
// Queries system-graph.db for cross-repo impact analysis,
// service dependencies, interface registry, and team coordination.
//
// Follows the same pattern as forge-graph/query.js:
//   - SystemQuery class for programmatic use
//   - CLI dispatcher for shell use
//   - Convenience wrappers for common queries

// Lazy chalk loader
let chalk;
function getChalk() {
  if (chalk) return chalk;
  try {
    chalk = require('chalk');
  } catch {
    const id = s => s;
    chalk = { bold: id, dim: id, green: id, yellow: id, red: id, cyan: id, magenta: id, blue: id, white: id, gray: id };
  }
  return chalk;
}

// ============================================================
// SystemQuery Class
// ============================================================

class SystemQuery {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath, { readonly: true });
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Overview ──────────────────────────────────────────────

  overview() {
    const meta = {};
    for (const row of this.db.prepare('SELECT key, value FROM system_meta').all()) {
      meta[row.key] = row.value;
    }

    const serviceCount = this.db.prepare('SELECT COUNT(*) as c FROM services').get().c;
    const interfaceCount = this.db.prepare('SELECT COUNT(*) as c FROM interfaces').get().c;
    const depCount = this.db.prepare('SELECT COUNT(*) as c FROM dependencies').get().c;
    const teamCount = this.db.prepare('SELECT COUNT(*) as c FROM teams').get().c;

    const typeBreakdown = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM interfaces GROUP BY type ORDER BY count DESC
    `).all();

    const topConsumers = this.db.prepare(`
      SELECT service_id, fan_in, fan_out, coupling_score, risk_level
      FROM service_metrics
      ORDER BY fan_in DESC
      LIMIT 5
    `).all();

    const riskDistribution = this.db.prepare(`
      SELECT risk_level, COUNT(*) as count FROM service_metrics GROUP BY risk_level
    `).all();

    return {
      meta,
      services: serviceCount,
      interfaces: interfaceCount,
      dependencies: depCount,
      teams: teamCount,
      interface_types: typeBreakdown,
      top_consumed_services: topConsumers,
      risk_distribution: riskDistribution,
    };
  }

  // ── Service Detail ────────────────────────────────────────

  service(serviceId) {
    const svc = this.db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    if (!svc) return null;

    const exports_ = this.db.prepare('SELECT * FROM interfaces WHERE service_id = ?').all(serviceId);
    const imports_ = this.db.prepare(`
      SELECT d.*, s.id as provider_name
      FROM dependencies d
      JOIN services s ON s.id = d.provider_id
      WHERE d.consumer_id = ?
    `).all(serviceId);

    const consumers = this.db.prepare(`
      SELECT DISTINCT d.consumer_id, s.team, d.type
      FROM dependencies d
      JOIN services s ON s.id = d.consumer_id
      WHERE d.provider_id = ?
    `).all(serviceId);

    const metrics = this.db.prepare('SELECT * FROM service_metrics WHERE service_id = ?').get(serviceId);

    return {
      service: svc,
      exports: exports_.map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })),
      imports: imports_,
      consumers,
      metrics,
    };
  }

  // ── Exports / Imports ─────────────────────────────────────

  exports(serviceId) {
    return this.db.prepare(`
      SELECT * FROM interfaces WHERE service_id = ? ORDER BY type, name
    `).all(serviceId).map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null }));
  }

  imports(serviceId) {
    return this.db.prepare(`
      SELECT d.*, i.name as interface_name, i.type as interface_type, i.protocol,
             s.repo_path
      FROM dependencies d
      LEFT JOIN interfaces i ON i.id = d.interface_id
      LEFT JOIN services s ON s.id = d.provider_id
      WHERE d.consumer_id = ?
      ORDER BY d.type, d.provider_id
    `).all(serviceId);
  }

  // ── Consumers (fan-in) ────────────────────────────────────

  consumers(serviceId) {
    return this.db.prepare(`
      SELECT d.consumer_id, d.type, d.usage, d.deprecated,
             s.team, s.description as consumer_description,
             s.repo_path, i.name as interface_name
      FROM dependencies d
      JOIN services s ON s.id = d.consumer_id
      LEFT JOIN interfaces i ON i.id = d.interface_id
      WHERE d.provider_id = ?
      ORDER BY d.consumer_id
    `).all(serviceId);
  }

  // ── Find Service by Repo Path ───────────────────────────

  findServiceByRepoPath(repoPath) {
    const absPath = require('path').resolve(repoPath);
    const row = this.db.prepare('SELECT id FROM services WHERE repo_path = ?').get(absPath);
    if (row) return row.id;
    // Fuzzy: try matching by basename
    const basename = require('path').basename(absPath);
    const byName = this.db.prepare('SELECT id FROM services WHERE id = ? OR repo LIKE ?').get(basename, `%${basename}%`);
    return byName ? byName.id : null;
  }

  // ── Impact Analysis ───────────────────────────────────────

  impact(serviceId, opts = {}) {
    const depth = opts.depth || 2;
    const interfaceFilter = opts.interface || null;

    // Direct consumers
    let directConsumers;
    if (interfaceFilter) {
      directConsumers = this.db.prepare(`
        SELECT DISTINCT d.consumer_id, d.type, d.usage, s.team
        FROM dependencies d
        JOIN services s ON s.id = d.consumer_id
        JOIN interfaces i ON i.id = d.interface_id
        WHERE d.provider_id = ? AND i.name LIKE ?
      `).all(serviceId, `%${interfaceFilter}%`);
    } else {
      directConsumers = this.db.prepare(`
        SELECT DISTINCT d.consumer_id, d.type, d.usage, s.team
        FROM dependencies d
        JOIN services s ON s.id = d.consumer_id
        WHERE d.provider_id = ?
      `).all(serviceId);
    }

    // Transitive consumers (BFS)
    const transitiveConsumers = [];
    if (depth > 1) {
      const visited = new Set([serviceId, ...directConsumers.map(c => c.consumer_id)]);
      let frontier = directConsumers.map(c => c.consumer_id);

      for (let d = 2; d <= depth && frontier.length > 0; d++) {
        const nextFrontier = [];
        for (const node of frontier) {
          const consumers = this.db.prepare(`
            SELECT DISTINCT d.consumer_id, d.type, s.team
            FROM dependencies d
            JOIN services s ON s.id = d.consumer_id
            WHERE d.provider_id = ?
          `).all(node);

          for (const c of consumers) {
            if (!visited.has(c.consumer_id)) {
              visited.add(c.consumer_id);
              transitiveConsumers.push({ ...c, depth: d, via: node });
              nextFrontier.push(c.consumer_id);
            }
          }
        }
        frontier = nextFrontier;
      }
    }

    // Affected interfaces
    const affectedInterfaces = this.db.prepare(`
      SELECT * FROM interfaces WHERE service_id = ?
    `).all(serviceId).map(i => ({ ...i, metadata: i.metadata ? JSON.parse(i.metadata) : null }));

    // Team coordination needed
    const teamsAffected = new Set();
    for (const c of [...directConsumers, ...transitiveConsumers]) {
      if (c.team) teamsAffected.add(c.team);
    }

    // Service metrics
    const metrics = this.db.prepare('SELECT * FROM service_metrics WHERE service_id = ?').get(serviceId);

    return {
      service: serviceId,
      direct_consumers: directConsumers,
      transitive_consumers: transitiveConsumers,
      total_affected: directConsumers.length + transitiveConsumers.length,
      affected_interfaces: affectedInterfaces,
      team_coordination: [...teamsAffected],
      metrics,
    };
  }

  // ── Context for Task ──────────────────────────────────────

  contextForTask(serviceId, files = []) {
    const impact = this.impact(serviceId, { depth: 1 });
    const svcDetail = this.service(serviceId);
    if (!svcDetail) return { error: `Service ${serviceId} not found` };

    // Determine which exported interfaces might be affected by the files
    const affectedInterfaces = [];
    if (files.length > 0 && svcDetail.exports) {
      for (const exp of svcDetail.exports) {
        const meta = exp.metadata || {};
        // Check if any endpoint source matches the changed files
        if (meta.endpoints) {
          for (const ep of meta.endpoints) {
            if (ep._source && files.some(f => f.includes(ep._source) || ep._source.includes(f))) {
              affectedInterfaces.push(exp);
              break;
            }
          }
        }
      }
    }

    // If no file-level match, return all exports as potentially affected
    const relevantInterfaces = affectedInterfaces.length > 0 ? affectedInterfaces : svcDetail.exports;

    // Build contract constraints
    const contractConstraints = [];
    for (const iface of relevantInterfaces) {
      const consumerCount = impact.direct_consumers.filter(c =>
        c.type === iface.type
      ).length;
      if (consumerCount > 0) {
        contractConstraints.push(
          `${iface.type}/${iface.protocol || ''} "${iface.name}" — ${consumerCount} consumer(s)`
        );
      }
    }

    return {
      service: serviceId,
      affected_interfaces: relevantInterfaces,
      consuming_services: impact.direct_consumers.map(c => c.consumer_id),
      contract_constraints: contractConstraints,
      team_coordination: impact.team_coordination,
      metrics: impact.metrics,
    };
  }

  // ── Hotspots ──────────────────────────────────────────────

  hotspots(opts = {}) {
    const limit = opts.top || 10;
    return this.db.prepare(`
      SELECT s.id, s.repo, s.team, s.description,
             m.fan_in, m.fan_out, m.interface_count, m.coupling_score, m.risk_level
      FROM service_metrics m
      JOIN services s ON s.id = m.service_id
      ORDER BY m.fan_in DESC, m.coupling_score DESC
      LIMIT ?
    `).all(limit);
  }

  // ── Cycles ────────────────────────────────────────────────

  cycles() {
    const edges = this.db.prepare('SELECT DISTINCT consumer_id, provider_id FROM dependencies').all();
    const graph = new Map();

    for (const edge of edges) {
      if (!graph.has(edge.consumer_id)) graph.set(edge.consumer_id, new Set());
      graph.get(edge.consumer_id).add(edge.provider_id);
    }

    const cycles = [];
    const visited = new Set();
    const stack = new Set();

    function dfs(node, pathArr) {
      if (stack.has(node)) {
        const cycleStart = pathArr.indexOf(node);
        if (cycleStart >= 0) {
          cycles.push([...pathArr.slice(cycleStart), node]);
        }
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      stack.add(node);
      pathArr.push(node);

      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        dfs(neighbor, pathArr);
      }

      pathArr.pop();
      stack.delete(node);
    }

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return { cycles, count: cycles.length };
  }

  // ── Dependency Path ───────────────────────────────────────

  path(fromService, toService) {
    const edges = this.db.prepare('SELECT DISTINCT consumer_id, provider_id FROM dependencies').all();
    const graph = new Map();

    for (const edge of edges) {
      if (!graph.has(edge.consumer_id)) graph.set(edge.consumer_id, []);
      graph.get(edge.consumer_id).push(edge.provider_id);
    }

    // BFS
    const queue = [[fromService]];
    const visited = new Set([fromService]);

    while (queue.length > 0) {
      const currentPath = queue.shift();
      const current = currentPath[currentPath.length - 1];

      if (current === toService) {
        return { found: true, path: currentPath, length: currentPath.length - 1 };
      }

      const neighbors = graph.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...currentPath, neighbor]);
        }
      }
    }

    return { found: false, path: [], length: -1 };
  }

  // ── Team Impact ───────────────────────────────────────────

  teamImpact(serviceId) {
    const impact = this.impact(serviceId, { depth: 2 });

    // Group affected services by team
    const teamMap = new Map();
    for (const c of [...impact.direct_consumers, ...impact.transitive_consumers]) {
      const team = c.team || 'unassigned';
      if (!teamMap.has(team)) teamMap.set(team, []);
      teamMap.get(team).push({
        service: c.consumer_id,
        type: c.type,
        depth: c.depth || 1,
      });
    }

    const serviceTeam = this.db.prepare('SELECT team FROM services WHERE id = ?').get(serviceId);

    return {
      service: serviceId,
      owning_team: serviceTeam ? serviceTeam.team : null,
      affected_teams: [...teamMap.entries()].map(([team, services]) => ({
        team,
        services,
        service_count: services.length,
      })),
      total_teams_affected: teamMap.size,
      coordination_needed: teamMap.size > 1,
    };
  }

  // ── Interface Registry ────────────────────────────────────

  interfaceRegistry(opts = {}) {
    const typeFilter = opts.type || null;
    const search = opts.search || null;

    let query = `
      SELECT i.*, s.team, s.repo
      FROM interfaces i
      JOIN services s ON s.id = i.service_id
    `;
    const params = [];
    const conditions = [];

    if (typeFilter) {
      conditions.push('i.type = ?');
      params.push(typeFilter);
    }
    if (search) {
      conditions.push('(i.name LIKE ? OR i.description LIKE ? OR i.service_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY i.service_id, i.type, i.name';

    return this.db.prepare(query).all(...params).map(i => ({
      ...i,
      metadata: i.metadata ? JSON.parse(i.metadata) : null,
    }));
  }

  // ── Service Dependencies Graph ────────────────────────────

  serviceDependencies() {
    const nodes = this.db.prepare(`
      SELECT s.id, s.repo, s.team, s.description,
             COALESCE(m.fan_in, 0) as fan_in,
             COALESCE(m.fan_out, 0) as fan_out,
             COALESCE(m.risk_level, 'low') as risk_level
      FROM services s
      LEFT JOIN service_metrics m ON m.service_id = s.id
    `).all();

    const edges = this.db.prepare(`
      SELECT DISTINCT consumer_id as source, provider_id as target, type,
             COUNT(*) as weight
      FROM dependencies
      GROUP BY consumer_id, provider_id, type
    `).all();

    return { nodes, edges };
  }
}

// ============================================================
// Convenience Wrappers
// ============================================================

function withQuery(dbPath, fn) {
  const sq = new SystemQuery(dbPath);
  sq.open();
  try {
    return fn(sq);
  } finally {
    sq.close();
  }
}

function getOverview(dbPath) {
  return withQuery(dbPath, sq => sq.overview());
}

function getService(serviceId, dbPath) {
  return withQuery(dbPath, sq => sq.service(serviceId));
}

function getExports(serviceId, dbPath) {
  return withQuery(dbPath, sq => sq.exports(serviceId));
}

function getImports(serviceId, dbPath) {
  return withQuery(dbPath, sq => sq.imports(serviceId));
}

function getConsumers(serviceId, dbPath) {
  return withQuery(dbPath, sq => sq.consumers(serviceId));
}

function findServiceByRepoPath(repoPath, dbPath) {
  return withQuery(dbPath, sq => sq.findServiceByRepoPath(repoPath));
}

function getImpact(serviceId, dbPath, opts) {
  return withQuery(dbPath, sq => sq.impact(serviceId, opts));
}

function getContextForTask(serviceId, files, dbPath) {
  return withQuery(dbPath, sq => sq.contextForTask(serviceId, files));
}

function getHotspots(dbPath, opts) {
  return withQuery(dbPath, sq => sq.hotspots(opts));
}

function getCycles(dbPath) {
  return withQuery(dbPath, sq => sq.cycles());
}

function getPath(from, to, dbPath) {
  return withQuery(dbPath, sq => sq.path(from, to));
}

function getTeamImpact(serviceId, dbPath) {
  return withQuery(dbPath, sq => sq.teamImpact(serviceId));
}

function getInterfaceRegistry(dbPath, opts) {
  return withQuery(dbPath, sq => sq.interfaceRegistry(opts));
}

function getServiceDependencies(dbPath) {
  return withQuery(dbPath, sq => sq.serviceDependencies());
}

// ============================================================
// CLI Rich Output
// ============================================================

function displayOverview(data) {
  const c = getChalk();
  console.log('');
  console.log(c.bold('  System Graph Overview'));
  console.log(c.dim('  ──────────────────────────────'));
  console.log(`  Services:     ${c.cyan(data.services)}`);
  console.log(`  Interfaces:   ${c.cyan(data.interfaces)}`);
  console.log(`  Dependencies: ${c.cyan(data.dependencies)}`);
  console.log(`  Teams:        ${c.cyan(data.teams)}`);

  if (data.meta.build_date) {
    console.log(`  Built:        ${c.dim(data.meta.build_date)}`);
  }

  if (data.interface_types.length > 0) {
    console.log('');
    console.log(c.bold('  Interface Types:'));
    for (const t of data.interface_types) {
      console.log(`    ${t.type.padEnd(12)} ${c.cyan(String(t.count))}`);
    }
  }

  if (data.top_consumed_services.length > 0) {
    console.log('');
    console.log(c.bold('  Most Consumed Services:'));
    for (const s of data.top_consumed_services) {
      const risk = s.risk_level === 'critical' ? c.red(s.risk_level) :
                   s.risk_level === 'high' ? c.yellow(s.risk_level) :
                   c.dim(s.risk_level);
      console.log(`    ${s.service_id.padEnd(30)} fan-in: ${c.cyan(String(s.fan_in).padEnd(4))} risk: ${risk}`);
    }
  }

  if (data.risk_distribution.length > 0) {
    console.log('');
    console.log(c.bold('  Risk Distribution:'));
    for (const r of data.risk_distribution) {
      const label = r.risk_level === 'critical' ? c.red(r.risk_level) :
                    r.risk_level === 'high' ? c.yellow(r.risk_level) :
                    r.risk_level === 'medium' ? c.cyan(r.risk_level) :
                    c.green(r.risk_level);
      console.log(`    ${label.padEnd(20)} ${r.count}`);
    }
  }
  console.log('');
}

function displayImpact(data) {
  const c = getChalk();
  console.log('');
  console.log(c.bold(`  Impact Analysis: ${data.service}`));
  console.log(c.dim('  ──────────────────────────────'));

  if (data.metrics) {
    const risk = data.metrics.risk_level === 'critical' ? c.red('CRITICAL') :
                 data.metrics.risk_level === 'high' ? c.yellow('HIGH') :
                 data.metrics.risk_level === 'medium' ? c.cyan('MEDIUM') :
                 c.green('LOW');
    console.log(`  Risk: ${risk}  |  Fan-in: ${data.metrics.fan_in}  |  Fan-out: ${data.metrics.fan_out}`);
  }

  console.log(`  Total affected: ${c.cyan(data.total_affected)} service(s)`);
  console.log('');

  if (data.direct_consumers.length > 0) {
    console.log(c.bold('  Direct Consumers:'));
    for (const dc of data.direct_consumers) {
      const team = dc.team ? c.dim(` [${dc.team}]`) : '';
      console.log(`    ${c.red('→')} ${dc.consumer_id}${team} (${dc.type})`);
    }
    console.log('');
  }

  if (data.transitive_consumers.length > 0) {
    console.log(c.bold('  Transitive Consumers:'));
    for (const tc of data.transitive_consumers) {
      const team = tc.team ? c.dim(` [${tc.team}]`) : '';
      console.log(`    ${c.yellow('→')} ${tc.consumer_id}${team} (depth ${tc.depth}, via ${tc.via})`);
    }
    console.log('');
  }

  if (data.team_coordination.length > 0) {
    console.log(c.bold('  Teams requiring coordination:'));
    for (const team of data.team_coordination) {
      console.log(`    ${c.magenta('●')} ${team}`);
    }
    console.log('');
  }

  if (data.affected_interfaces.length > 0) {
    console.log(c.bold('  Exported Interfaces:'));
    for (const iface of data.affected_interfaces) {
      console.log(`    ${c.cyan('▸')} ${iface.type}/${iface.protocol || ''} ${iface.name}`);
    }
    console.log('');
  }
}

function displayConsumers(serviceId, data) {
  const c = getChalk();
  console.log('');
  console.log(c.bold(`  Consumers of ${serviceId}`));
  console.log(c.dim('  ──────────────────────────────'));

  if (data.length === 0) {
    console.log(c.dim('  No consumers found.'));
  } else {
    for (const consumer of data) {
      const dep = consumer.deprecated ? c.yellow(' [DEPRECATED]') : '';
      const team = consumer.team ? c.dim(` [${consumer.team}]`) : '';
      console.log(`  ${c.red('→')} ${consumer.consumer_id}${team} — ${consumer.type}${dep}`);
      if (consumer.interface_name) {
        console.log(`    ${c.dim('interface:')} ${consumer.interface_name}`);
      }
      if (consumer.usage) {
        console.log(`    ${c.dim('usage:')} ${consumer.usage}`);
      }
    }
  }
  console.log('');
}

function displayCycles(data) {
  const c = getChalk();
  console.log('');
  console.log(c.bold('  Service Dependency Cycles'));
  console.log(c.dim('  ──────────────────────────────'));

  if (data.count === 0) {
    console.log(`  ${c.green('✓')} No circular dependencies found.`);
  } else {
    console.log(`  ${c.red('✗')} ${data.count} cycle(s) detected:`);
    console.log('');
    for (const cycle of data.cycles) {
      console.log(`    ${c.red('⟳')} ${cycle.join(c.dim(' → '))}`);
    }
  }
  console.log('');
}

function displayHotspots(data) {
  const c = getChalk();
  console.log('');
  console.log(c.bold('  System Hotspots'));
  console.log(c.dim('  ──────────────────────────────'));

  if (data.length === 0) {
    console.log(c.dim('  No services found.'));
  } else {
    for (const s of data) {
      const risk = s.risk_level === 'critical' ? c.red(s.risk_level) :
                   s.risk_level === 'high' ? c.yellow(s.risk_level) :
                   s.risk_level === 'medium' ? c.cyan(s.risk_level) :
                   c.green(s.risk_level);
      const team = s.team ? c.dim(` [${s.team}]`) : '';
      console.log(`  ${s.id.padEnd(30)}${team}`);
      console.log(`    fan-in: ${c.cyan(String(s.fan_in).padEnd(4))} fan-out: ${c.cyan(String(s.fan_out).padEnd(4))} risk: ${risk}`);
    }
  }
  console.log('');
}

function displayPath(data, from, to) {
  const c = getChalk();
  console.log('');
  console.log(c.bold(`  Path: ${from} → ${to}`));
  console.log(c.dim('  ──────────────────────────────'));

  if (data.found) {
    console.log(`  ${c.green('✓')} Path found (length ${data.length}):`);
    console.log(`    ${data.path.join(c.dim(' → '))}`);
  } else {
    console.log(`  ${c.yellow('✗')} No dependency path found.`);
  }
  console.log('');
}

// ============================================================
// DB Path Resolution
// ============================================================

function resolveDbPath(arg) {
  if (arg && fs.existsSync(arg)) return arg;

  // Check common locations
  const candidates = [
    path.join(process.cwd(), '.forge', 'system-graph.db'),
    path.join(process.cwd(), 'system-graph.db'),
  ];

  // Check if FORGE_HOME or home dir has it
  const homeForge = path.join(process.env.HOME || '', '.forge', 'system-graph.db');
  candidates.push(homeForge);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return arg || candidates[0]; // Return first candidate even if missing (let caller handle error)
}

// ============================================================
// CLI Entry Point
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonOutput = args.includes('--json');

  const dbIdx = args.indexOf('--db');
  const dbPath = resolveDbPath(dbIdx !== -1 ? args[dbIdx + 1] : null);

  if (!command) {
    const c = getChalk();
    console.log('');
    console.log(c.bold('  forge-system/query.js — System Graph Query Engine'));
    console.log('');
    console.log('  Usage: node query.js <command> [args] --db <path>');
    console.log('');
    console.log('  Commands:');
    console.log('    overview                       System-wide stats');
    console.log('    service <name>                 Service detail (exports, imports, consumers)');
    console.log('    exports <service>              What does this service export?');
    console.log('    imports <service>              What does this service consume?');
    console.log('    consumers <service>            Who consumes this service? (fan-in)');
    console.log('    impact <service>               Full impact analysis (direct + transitive)');
    console.log('    context-for-task <svc> [files] Cross-repo context for agent work');
    console.log('    hotspots [--top N]             Most depended-on services');
    console.log('    cycles                         Circular service dependencies');
    console.log('    path <from> <to>               Dependency path between services');
    console.log('    team-impact <service>          Which teams need to coordinate?');
    console.log('    registry [--type X] [--search] All exported interfaces');
    console.log('    graph                          Full dependency graph (nodes + edges)');
    console.log('');
    console.log('  Flags:');
    console.log('    --db <path>                    Path to system-graph.db');
    console.log('    --json                         JSON output');
    console.log('    --top <N>                      Limit results (for hotspots)');
    console.log('    --depth <N>                    Traversal depth (for impact, default 2)');
    console.log('    --interface <name>             Filter impact to specific interface');
    console.log('    --type <api|event|...>         Filter registry by type');
    console.log('    --search <term>                Search registry');
    console.log('');
    process.exit(0);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Error: System graph not found at ${dbPath}`);
    console.error('Run builder.js first, or specify --db <path>');
    process.exit(1);
  }

  const sq = new SystemQuery(dbPath);
  sq.open();

  try {
    let result;

    switch (command) {
      case 'overview':
        result = sq.overview();
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayOverview(result);
        break;

      case 'service': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js service <name>'); process.exit(1); }
        result = sq.service(svcId);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else if (result) {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Service: ${result.service.id}`));
          console.log(c.dim('  ──────────────────────────────'));
          console.log(`  Repo:    ${result.service.repo}`);
          if (result.service.team) console.log(`  Team:    ${result.service.team}`);
          if (result.service.version) console.log(`  Version: ${result.service.version}`);
          if (result.service.description) console.log(`  Desc:    ${result.service.description}`);
          console.log(`  Exports: ${c.cyan(result.exports.length)}`);
          console.log(`  Imports: ${c.cyan(result.imports.length)}`);
          console.log(`  Consumers: ${c.cyan(result.consumers.length)}`);
          if (result.metrics) {
            console.log(`  Risk:    ${result.metrics.risk_level} (fan-in ${result.metrics.fan_in}, fan-out ${result.metrics.fan_out})`);
          }
          console.log('');
        } else {
          console.log(`Service "${svcId}" not found.`);
        }
        break;
      }

      case 'exports': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js exports <service>'); process.exit(1); }
        result = sq.exports(svcId);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Exports: ${svcId} (${result.length})`));
          console.log(c.dim('  ──────────────────────────────'));
          for (const e of result) {
            console.log(`  ${c.green('▸')} ${e.type}/${e.protocol || ''} ${c.bold(e.name)}`);
            if (e.description) console.log(`    ${c.dim(e.description)}`);
          }
          console.log('');
        }
        break;
      }

      case 'imports': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js imports <service>'); process.exit(1); }
        result = sq.imports(svcId);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Imports: ${svcId} (${result.length})`));
          console.log(c.dim('  ──────────────────────────────'));
          for (const i of result) {
            const dep = i.deprecated ? c.yellow(' [DEPRECATED]') : '';
            console.log(`  ${c.yellow('◂')} ${i.provider_id} — ${i.type}${dep}`);
            if (i.interface_name) console.log(`    ${c.dim('interface:')} ${i.interface_name}`);
            if (i.usage) console.log(`    ${c.dim('usage:')} ${i.usage}`);
          }
          console.log('');
        }
        break;
      }

      case 'consumers': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js consumers <service>'); process.exit(1); }
        result = sq.consumers(svcId);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayConsumers(svcId, result);
        break;
      }

      case 'impact': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js impact <service>'); process.exit(1); }
        const depthIdx = args.indexOf('--depth');
        const depth = depthIdx !== -1 ? parseInt(args[depthIdx + 1], 10) : 2;
        const ifaceIdx = args.indexOf('--interface');
        const ifaceFilter = ifaceIdx !== -1 ? args[ifaceIdx + 1] : null;
        result = sq.impact(svcId, { depth, interface: ifaceFilter });
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayImpact(result);
        break;
      }

      case 'context-for-task': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js context-for-task <service> [files...]'); process.exit(1); }
        const files = args.slice(2).filter(a => !a.startsWith('--'));
        result = sq.contextForTask(svcId, files);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Cross-Repo Context: ${svcId}`));
          console.log(c.dim('  ──────────────────────────────'));
          if (result.consuming_services.length > 0) {
            console.log(`  Consuming services: ${result.consuming_services.join(', ')}`);
          }
          if (result.contract_constraints.length > 0) {
            console.log('');
            console.log(c.bold('  Contract Constraints:'));
            for (const cc of result.contract_constraints) {
              console.log(`    ${c.red('!')} ${cc}`);
            }
          }
          if (result.team_coordination.length > 0) {
            console.log(`  Teams: ${result.team_coordination.join(', ')}`);
          }
          console.log('');
        }
        break;
      }

      case 'hotspots': {
        const topIdx = args.indexOf('--top');
        const top = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : 10;
        result = sq.hotspots({ top });
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayHotspots(result);
        break;
      }

      case 'cycles':
        result = sq.cycles();
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayCycles(result);
        break;

      case 'path': {
        const from = args[1];
        const to = args[2];
        if (!from || !to || from.startsWith('--') || to.startsWith('--')) {
          console.error('Usage: query.js path <from> <to>');
          process.exit(1);
        }
        result = sq.path(from, to);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else displayPath(result, from, to);
        break;
      }

      case 'team-impact': {
        const svcId = args[1];
        if (!svcId || svcId.startsWith('--')) { console.error('Usage: query.js team-impact <service>'); process.exit(1); }
        result = sq.teamImpact(svcId);
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Team Impact: ${svcId}`));
          console.log(c.dim('  ──────────────────────────────'));
          console.log(`  Owning team: ${result.owning_team || c.dim('unassigned')}`);
          console.log(`  Teams affected: ${c.cyan(result.total_teams_affected)}`);
          console.log(`  Coordination needed: ${result.coordination_needed ? c.yellow('YES') : c.green('NO')}`);
          if (result.affected_teams.length > 0) {
            console.log('');
            for (const t of result.affected_teams) {
              console.log(`    ${c.magenta('●')} ${t.team} (${t.service_count} service(s))`);
              for (const s of t.services) {
                console.log(`      ${c.dim('→')} ${s.service} (${s.type})`);
              }
            }
          }
          console.log('');
        }
        break;
      }

      case 'registry': {
        const typeIdx = args.indexOf('--type');
        const searchIdx = args.indexOf('--search');
        const type = typeIdx !== -1 ? args[typeIdx + 1] : null;
        const search = searchIdx !== -1 ? args[searchIdx + 1] : null;
        result = sq.interfaceRegistry({ type, search });
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Interface Registry (${result.length} entries)`));
          console.log(c.dim('  ──────────────────────────────'));
          for (const i of result) {
            console.log(`  ${c.cyan(i.service_id.padEnd(25))} ${i.type.padEnd(10)} ${c.bold(i.name)}`);
            if (i.description) console.log(`  ${''.padEnd(25)} ${c.dim(i.description)}`);
          }
          console.log('');
        }
        break;
      }

      case 'graph':
        result = sq.serviceDependencies();
        if (jsonOutput) console.log(JSON.stringify(result, null, 2));
        else {
          const c = getChalk();
          console.log('');
          console.log(c.bold(`  Service Dependency Graph`));
          console.log(c.dim('  ──────────────────────────────'));
          console.log(`  Nodes: ${result.nodes.length}  Edges: ${result.edges.length}`);
          console.log('');
          for (const edge of result.edges) {
            console.log(`    ${edge.source} ${c.dim('→')} ${edge.target} (${edge.type}, weight ${edge.weight})`);
          }
          console.log('');
        }
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run without arguments to see available commands.');
        process.exit(1);
    }
  } finally {
    sq.close();
  }
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  SystemQuery,
  // Convenience wrappers
  getOverview,
  getService,
  getExports,
  getImports,
  getConsumers,
  findServiceByRepoPath,
  getImpact,
  getContextForTask,
  getHotspots,
  getCycles,
  getPath,
  getTeamImpact,
  getInterfaceRegistry,
  getServiceDependencies,
  // Utilities
  resolveDbPath,
  withQuery,
};
