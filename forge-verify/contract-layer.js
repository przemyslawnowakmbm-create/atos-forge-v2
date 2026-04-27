#!/usr/bin/env node
'use strict';

/**
 * Layer 7 — CONTRACT VERIFICATION
 *
 * Cross-repo contract checks for the system graph. After modifying a
 * service's exported interfaces, verify:
 *
 *   1. Code-vs-YAML drift — does the actual code match the declared
 *      interfaces.yaml? (routes missing, stale endpoints, phantom exports)
 *   2. Backward compatibility — are exported schemas compatible after changes?
 *      (removed endpoints, narrowed types, dropped event channels)
 *   3. Cross-repo ripple — which consuming services are at risk? Flag
 *      high-fan-in contract breaks that need coordinated rollout.
 *
 * Depends on:
 *   forge-system/query.js   — SystemQuery for cross-repo data
 *   forge-system/detect.js  — re-detect interfaces from code
 *   forge-system/validate.js — validate interface contracts
 *
 * Output shape matches other layers:
 *   { passed: boolean, ..., duration_ms: number }
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// Lazy Dependencies
// ============================================================

let _SystemQuery, _detect, _validate, _yaml;

function SystemQuery() {
  if (!_SystemQuery) {
    try { _SystemQuery = require('../forge-system/query').SystemQuery; }
    catch { _SystemQuery = null; }
  }
  return _SystemQuery;
}

function detect() {
  if (!_detect) {
    try { _detect = require('../forge-system/detect'); }
    catch { _detect = null; }
  }
  return _detect;
}

function validateMod() {
  if (!_validate) {
    try { _validate = require('../forge-system/validate'); }
    catch { _validate = null; }
  }
  return _validate;
}

function yaml() {
  if (!_yaml) {
    // Try multiple locations — forge-system/node_modules has js-yaml
    const candidates = [
      'js-yaml',
      'yaml',
      path.join(__dirname, '..', 'forge-system', 'node_modules', 'js-yaml'),
    ];
    for (const mod of candidates) {
      try { _yaml = require(mod); break; }
      catch { /* try next */ }
    }
    if (!_yaml) {
      // Minimal fallback: parse simple YAML key-value + arrays
      _yaml = { load: parseSimpleYaml };
    }
  }
  return _yaml;
}

/**
 * Minimal YAML parser for interfaces.yaml structure.
 * Handles comments, basic scalars, arrays, and simple nested objects.
 * NOT a full YAML parser — only covers interfaces.yaml patterns.
 */
function parseSimpleYaml(str) {
  const lines = str.split('\n');
  const result = {};
  let currentKey = null;
  let currentArray = null;
  let currentObj = null;
  let arrayItemObj = null;

  for (let line of lines) {
    // Strip comments
    const commentIdx = line.indexOf('#');
    if (commentIdx >= 0 && (commentIdx === 0 || line[commentIdx - 1] === ' ')) {
      line = line.slice(0, commentIdx);
    }
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Top-level key
    if (indent === 0 && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      currentKey = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (val) {
        result[currentKey] = val;
      } else {
        result[currentKey] = null; // Will be filled by children
      }
      currentArray = null;
      currentObj = null;
      arrayItemObj = null;
      continue;
    }

    // Array item
    if (trimmed.startsWith('- ')) {
      const itemContent = trimmed.slice(2).trim();
      if (!result[currentKey]) result[currentKey] = [];
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];

      if (itemContent.includes(':')) {
        // Object in array
        const colonIdx = itemContent.indexOf(':');
        const k = itemContent.slice(0, colonIdx).trim();
        const v = itemContent.slice(colonIdx + 1).trim();
        arrayItemObj = { [k]: v };
        result[currentKey].push(arrayItemObj);
      } else {
        arrayItemObj = null;
        result[currentKey].push(itemContent);
      }
      continue;
    }

    // Nested key in array item or object
    if (indent > 0 && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      if (arrayItemObj) {
        arrayItemObj[k] = v || null;
      } else if (currentKey && result[currentKey] === null) {
        result[currentKey] = {};
        result[currentKey][k] = v || null;
      } else if (currentKey && typeof result[currentKey] === 'object' && !Array.isArray(result[currentKey])) {
        result[currentKey][k] = v || null;
      }
    }
  }

  return result;
}

// ============================================================
// Layer 7 — CONTRACT
// ============================================================

/**
 * Run contract verification checks.
 *
 * @param {object} opts
 * @param {string}   opts.cwd              - Project root
 * @param {string[]} opts.files            - Changed files (relative paths)
 * @param {string}   [opts.systemDbPath]   - Path to system-graph.db
 * @param {string}   [opts.interfacesPath] - Path to interfaces.yaml (auto-resolved if absent)
 * @param {object}   [opts.config]         - Verification config
 * @returns {{ passed: boolean, drift: object[], compatibility: object[], ripple: object[], duration_ms: number }}
 */
function layerContract(opts) {
  const start = Date.now();
  const cwd = opts.cwd || process.cwd();

  const drift = [];         // Code ↔ YAML mismatches
  const compatibility = []; // Backward-incompatible changes
  const ripple = [];        // Cross-repo consumer risk

  // Resolve interfaces.yaml
  const interfacesPath = opts.interfacesPath
    || path.join(cwd, '.forge', 'interfaces.yaml');

  if (!fs.existsSync(interfacesPath)) {
    return {
      passed: true,
      drift: [],
      compatibility: [],
      ripple: [],
      duration_ms: Date.now() - start,
      skipped: true,
      reason: 'No interfaces.yaml found',
    };
  }

  // Parse existing interfaces.yaml
  let declared;
  try {
    const raw = fs.readFileSync(interfacesPath, 'utf8');
    declared = yaml().load(raw);
  } catch (err) {
    return {
      passed: false,
      drift: [{ type: 'parse_error', message: `Failed to parse interfaces.yaml: ${err.message}` }],
      compatibility: [],
      ripple: [],
      duration_ms: Date.now() - start,
    };
  }

  if (!declared || !declared.exports) {
    return {
      passed: true,
      drift: [],
      compatibility: [],
      ripple: [],
      duration_ms: Date.now() - start,
      skipped: true,
      reason: 'No exports declared in interfaces.yaml',
    };
  }

  // ── CHECK 1: Code-vs-YAML Drift ─────────────────────────

  const driftResult = checkCodeDrift(cwd, declared, opts.files || []);
  drift.push(...driftResult);

  // ── CHECK 2: Backward Compatibility ──────────────────────

  const compatResult = checkBackwardCompatibility(cwd, declared, opts.files || []);
  compatibility.push(...compatResult);

  // ── CHECK 3: Cross-Repo Ripple ───────────────────────────

  const systemDbPath = opts.systemDbPath || resolveSystemDb(cwd);
  if (systemDbPath && fs.existsSync(systemDbPath)) {
    const rippleResult = checkCrossRepoRipple(cwd, declared, systemDbPath, drift, compatibility);
    ripple.push(...rippleResult);
  }

  // ── Structural validation of interfaces.yaml ─────────────

  const val = validateMod();
  if (val) {
    const valResult = val.validate(declared);
    if (!valResult.valid) {
      for (const err of valResult.errors) {
        drift.push({
          type: 'schema_error',
          path: err.path,
          message: err.message,
          severity: 'error',
        });
      }
    }
  }

  const hasErrors = drift.some(d => d.severity === 'error')
    || compatibility.some(c => c.severity === 'error')
    || ripple.some(r => r.severity === 'error');

  return {
    passed: !hasErrors,
    drift,
    compatibility,
    ripple,
    duration_ms: Date.now() - start,
  };
}

// ============================================================
// Check 1: Code ↔ YAML Drift
// ============================================================

/**
 * Compare declared interfaces against actual code signals.
 * Detects:
 *   - Phantom exports: declared in YAML but not found in code
 *   - Undeclared exports: found in code but missing from YAML
 *   - Stale endpoints: route declared but method/path changed
 */
function checkCodeDrift(cwd, declared, changedFiles) {
  const issues = [];
  const det = detect();

  // If detect module isn't available, skip drift check
  if (!det || !det.detectInterfaces) {
    return issues;
  }

  // Re-detect interfaces from current code
  let actual;
  try {
    actual = det.detectInterfaces(cwd);
  } catch {
    // Detection failed — non-fatal, skip drift check
    return issues;
  }

  if (!actual || !actual.exports) return issues;

  const declaredExports = declared.exports || [];
  const actualExports = actual.exports || [];

  // Build lookup maps by type + name
  const declaredMap = new Map();
  for (const exp of declaredExports) {
    const key = `${exp.type}:${exp.name}`;
    declaredMap.set(key, exp);
  }

  const actualMap = new Map();
  for (const exp of actualExports) {
    const key = `${exp.type}:${exp.name}`;
    actualMap.set(key, exp);
  }

  // Phantom exports: declared but not in code
  for (const [key, decl] of declaredMap) {
    if (!actualMap.has(key)) {
      issues.push({
        type: 'phantom_export',
        interface_key: key,
        name: decl.name,
        interface_type: decl.type,
        message: `Declared interface "${decl.name}" (${decl.type}) not found in code`,
        severity: 'warning',
        suggestion: 'Remove from interfaces.yaml or restore the code implementing it',
      });
    }
  }

  // Undeclared exports: in code but not declared
  for (const [key, act] of actualMap) {
    if (!declaredMap.has(key)) {
      // Only flag if the undeclared export touches changed files
      const source = act._source || '';
      const touchesChanged = changedFiles.length === 0
        || changedFiles.some(f => source.includes(f) || f.includes(source));

      if (touchesChanged) {
        issues.push({
          type: 'undeclared_export',
          interface_key: key,
          name: act.name,
          interface_type: act.type,
          message: `Code exports "${act.name}" (${act.type}) not declared in interfaces.yaml`,
          severity: 'warning',
          suggestion: 'Add to interfaces.yaml or mark as internal',
        });
      }
    }
  }

  // Endpoint drift: declared API endpoints vs actual routes
  for (const [key, decl] of declaredMap) {
    const act = actualMap.get(key);
    if (!act) continue; // Already flagged as phantom
    if (decl.type !== 'api') continue; // Only check API endpoints

    const declEndpoints = (decl.metadata?.endpoints || []);
    const actEndpoints = (act.metadata?.endpoints || act.endpoints || []);

    if (declEndpoints.length === 0 || actEndpoints.length === 0) continue;

    // Build route signatures
    const actRoutes = new Set(actEndpoints.map(ep =>
      `${(ep.method || 'GET').toUpperCase()} ${ep.path}`
    ));
    const declRoutes = new Set(declEndpoints.map(ep =>
      `${(ep.method || 'GET').toUpperCase()} ${ep.path}`
    ));

    // Declared routes missing from code
    for (const route of declRoutes) {
      if (!actRoutes.has(route)) {
        issues.push({
          type: 'stale_endpoint',
          interface_key: key,
          name: decl.name,
          route,
          message: `Declared endpoint ${route} in "${decl.name}" not found in code`,
          severity: 'warning',
          suggestion: 'Remove from interfaces.yaml or implement the endpoint',
        });
      }
    }

    // Code routes not declared
    for (const route of actRoutes) {
      if (!declRoutes.has(route)) {
        // Only warn if this touches changed files
        const matchesChanged = changedFiles.length === 0
          || actEndpoints.some(ep => {
            const sig = `${(ep.method || 'GET').toUpperCase()} ${ep.path}`;
            return sig === route && ep._source && changedFiles.some(f => ep._source.includes(f));
          });

        if (matchesChanged) {
          issues.push({
            type: 'undeclared_endpoint',
            interface_key: key,
            name: decl.name,
            route,
            message: `Code endpoint ${route} in "${decl.name}" not declared in interfaces.yaml`,
            severity: 'warning',
            suggestion: 'Add to interfaces.yaml exports',
          });
        }
      }
    }
  }

  return issues;
}

// ============================================================
// Check 2: Backward Compatibility
// ============================================================

/**
 * Check if changes to exported interfaces break backward compatibility.
 * Detects:
 *   - Removed endpoints (route existed before, gone now)
 *   - Narrowed methods (e.g., removed PUT from existing endpoint)
 *   - Removed event channels
 *   - Removed package exports
 */
function checkBackwardCompatibility(cwd, declared, changedFiles) {
  const issues = [];

  // We need a baseline to compare against. Look for:
  //   1. .forge/interfaces.yaml.baseline (saved by system-init or pre-commit)
  //   2. Git previous version of interfaces.yaml
  const baselinePath = path.join(cwd, '.forge', 'interfaces.yaml.baseline');
  let baseline = null;

  if (fs.existsSync(baselinePath)) {
    try {
      baseline = yaml().load(fs.readFileSync(baselinePath, 'utf8'));
    } catch { /* ignore */ }
  }

  // Fallback: try git show HEAD:interfaces.yaml
  if (!baseline) {
    try {
      const { execSync } = require('child_process');
      const gitYaml = execSync(
        'git show HEAD:.forge/interfaces.yaml 2>/dev/null',
        { cwd, encoding: 'utf8', timeout: 5000 }
      );
      if (gitYaml.trim()) {
        baseline = yaml().load(gitYaml);
      }
    } catch { /* no git baseline */ }
  }

  if (!baseline || !baseline.exports) return issues;

  const baseExports = baseline.exports || [];
  const currentExports = declared.exports || [];

  // Build current export map
  const currentMap = new Map();
  for (const exp of currentExports) {
    currentMap.set(`${exp.type}:${exp.name}`, exp);
  }

  for (const baseExp of baseExports) {
    const key = `${baseExp.type}:${baseExp.name}`;
    const current = currentMap.get(key);

    // Entire interface removed
    if (!current) {
      issues.push({
        type: 'removed_interface',
        interface_key: key,
        name: baseExp.name,
        interface_type: baseExp.type,
        message: `Exported interface "${baseExp.name}" (${baseExp.type}) was removed`,
        severity: 'error',
        suggestion: 'Mark as deprecated instead of removing, or coordinate with consumers first',
      });
      continue;
    }

    // API endpoint removal
    if (baseExp.type === 'api') {
      const baseEndpoints = baseExp.metadata?.endpoints || [];
      const currentEndpoints = current.metadata?.endpoints || [];
      const currentRoutes = new Set(currentEndpoints.map(ep =>
        `${(ep.method || 'GET').toUpperCase()} ${ep.path}`
      ));

      for (const ep of baseEndpoints) {
        const sig = `${(ep.method || 'GET').toUpperCase()} ${ep.path}`;
        if (!currentRoutes.has(sig)) {
          issues.push({
            type: 'removed_endpoint',
            interface_key: key,
            name: baseExp.name,
            endpoint: sig,
            message: `Endpoint ${sig} was removed from "${baseExp.name}"`,
            severity: 'error',
            suggestion: 'Keep the endpoint and mark as deprecated, or version the API',
          });
        }
      }
    }

    // Event channel removal
    if (baseExp.type === 'event') {
      const baseChannels = baseExp.metadata?.channels || baseExp.metadata?.topics || [];
      const currentChannels = current.metadata?.channels || current.metadata?.topics || [];
      const currentSet = new Set(currentChannels.map(c => typeof c === 'string' ? c : c.name));

      for (const ch of baseChannels) {
        const name = typeof ch === 'string' ? ch : ch.name;
        if (!currentSet.has(name)) {
          issues.push({
            type: 'removed_channel',
            interface_key: key,
            name: baseExp.name,
            channel: name,
            message: `Event channel "${name}" was removed from "${baseExp.name}"`,
            severity: 'error',
            suggestion: 'Keep the channel or coordinate migration with consumers',
          });
        }
      }
    }

    // Protocol change (always breaking)
    if (baseExp.protocol && current.protocol && baseExp.protocol !== current.protocol) {
      issues.push({
        type: 'protocol_change',
        interface_key: key,
        name: baseExp.name,
        from_protocol: baseExp.protocol,
        to_protocol: current.protocol,
        message: `Protocol changed from "${baseExp.protocol}" to "${current.protocol}" in "${baseExp.name}"`,
        severity: 'error',
        suggestion: 'Provide both protocols during migration period',
      });
    }
  }

  return issues;
}

// ============================================================
// Check 3: Cross-Repo Ripple
// ============================================================

/**
 * Query the system graph to find consumers at risk from contract changes.
 * Flags:
 *   - High-fan-in services where breaking changes affect many consumers
 *   - Cross-team dependencies that need coordination
 *   - Deprecated dependencies that are still in use
 */
function checkCrossRepoRipple(cwd, declared, systemDbPath, driftIssues, compatIssues) {
  const issues = [];
  const SQ = SystemQuery();

  if (!SQ) return issues;

  let sq;
  try {
    sq = new SQ(systemDbPath);
    sq.open();
  } catch {
    return issues;
  }

  try {
    // Find this service in the system graph
    const serviceId = sq.findServiceByRepoPath(cwd);
    if (!serviceId) return issues;

    // Get consumers of this service
    const consumers = sq.consumers(serviceId);
    if (consumers.length === 0) return issues;

    // Get metrics for risk assessment
    const metrics = sq.db.prepare(
      'SELECT * FROM service_metrics WHERE service_id = ?'
    ).get(serviceId);

    const fanIn = metrics ? metrics.fan_in : consumers.length;

    // If there are breaking compatibility issues and we have consumers → high risk
    const breakingChanges = compatIssues.filter(c => c.severity === 'error');

    if (breakingChanges.length > 0) {
      // Group consumers by team for coordination reporting
      const teamMap = new Map();
      for (const c of consumers) {
        const team = c.team || 'unassigned';
        if (!teamMap.has(team)) teamMap.set(team, []);
        teamMap.get(team).push(c.consumer_id);
      }

      for (const bc of breakingChanges) {
        // Find which consumers are specifically affected by this interface
        const affectedConsumers = consumers.filter(c =>
          !bc.interface_type || c.type === bc.interface_type
          || (c.interface_name && bc.name && c.interface_name === bc.name)
        );

        if (affectedConsumers.length === 0) continue;

        const risk = affectedConsumers.length >= 5 ? 'critical'
          : affectedConsumers.length >= 3 ? 'high'
          : affectedConsumers.length >= 1 ? 'medium'
          : 'low';

        issues.push({
          type: 'breaking_ripple',
          name: bc.name,
          interface_type: bc.interface_type || bc.type,
          change: bc.type,
          affected_consumers: affectedConsumers.map(c => ({
            id: c.consumer_id,
            team: c.team,
            usage: c.usage,
          })),
          affected_count: affectedConsumers.length,
          teams_affected: [...new Set(affectedConsumers.map(c => c.team).filter(Boolean))],
          risk,
          severity: risk === 'critical' || risk === 'high' ? 'error' : 'warning',
          message: `Breaking change "${bc.name}" (${bc.type}) affects ${affectedConsumers.length} consumer(s)${
            risk === 'critical' ? ' — CRITICAL: coordinate rollout' : ''
          }`,
          suggestion: `Coordinate with: ${[...new Set(affectedConsumers.map(c => c.team).filter(Boolean))].join(', ') || 'unassigned teams'}`,
        });
      }
    }

    // Flag drift issues that affect interfaces with consumers
    const significantDrift = driftIssues.filter(d =>
      d.type === 'phantom_export' || d.type === 'stale_endpoint'
    );

    for (const dr of significantDrift) {
      const affectedConsumers = consumers.filter(c =>
        c.interface_name === dr.name || c.type === dr.interface_type
      );

      if (affectedConsumers.length > 0) {
        issues.push({
          type: 'drift_risk',
          name: dr.name,
          drift_type: dr.type,
          affected_count: affectedConsumers.length,
          severity: 'warning',
          message: `Drift in "${dr.name}" (${dr.type}) may affect ${affectedConsumers.length} consumer(s)`,
          suggestion: 'Verify the interface still works for consumers or update interfaces.yaml',
        });
      }
    }

    // Check for deprecated dependencies still in use
    const deprecatedDeps = consumers.filter(c => c.deprecated);
    for (const dep of deprecatedDeps) {
      issues.push({
        type: 'deprecated_still_used',
        consumer: dep.consumer_id,
        interface_name: dep.interface_name,
        team: dep.team,
        severity: 'warning',
        message: `Deprecated dependency still used by "${dep.consumer_id}"${dep.team ? ` [${dep.team}]` : ''}`,
        suggestion: 'Plan migration or remove deprecated marking if still needed',
      });
    }

    // High fan-in warning (even without breaking changes)
    if (fanIn >= 5 && (driftIssues.length > 0 || compatIssues.length > 0)) {
      issues.push({
        type: 'high_fan_in_warning',
        service: serviceId,
        fan_in: fanIn,
        severity: fanIn >= 10 ? 'error' : 'warning',
        message: `Service "${serviceId}" has ${fanIn} consumers — contract changes need extra care`,
        suggestion: 'Consider versioned API, feature flags, or phased rollout',
      });
    }
  } finally {
    try { sq.close(); } catch { /* ignore */ }
  }

  return issues;
}

// ============================================================
// System DB Resolution
// ============================================================

function resolveSystemDb(cwd) {
  const candidates = [
    path.join(cwd, '.forge', 'system-graph.db'),
    process.env.FORGE_SYSTEM_GRAPH_PATH,
    process.env.FORGE_SYSTEM_GRAPH,
  ];

  // Check parent directory (if this is one repo in a multi-repo setup)
  const parent = path.dirname(cwd);
  candidates.push(path.join(parent, '.forge', 'system-graph.db'));
  candidates.push(path.join(parent, 'system-graph.db'));

  // Home directory
  const home = process.env.HOME || '';
  if (home) {
    candidates.push(path.join(home, '.forge', 'system-graph.db'));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  layerContract,
  checkCodeDrift,
  checkBackwardCompatibility,
  checkCrossRepoRipple,
  resolveSystemDb,
};
