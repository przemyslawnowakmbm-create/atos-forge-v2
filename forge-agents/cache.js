#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Agent Cache
// ============================================================
// Persists agent configs built by the factory to .forge/agents/
// so they can be reused without re-running the full 7-step pipeline.
//
// Cache key: SHA-256 of plan content + graph.db mtime + knowledge hash
// Cache is invalidated when any input changes.
// ============================================================

const CACHE_DIR = '.forge/agents';
const REGISTRY_FILE = 'registry.json';
const AGENT_CONFIG_FILE = 'agent-config.json';
const META_FILE = 'meta.json';

// ============================================================
// Hashing
// ============================================================

/**
 * Compute a cache key hash from the inputs that determine an agent's identity.
 * If any of these change, the cached agent is stale.
 */
function computeInputHash(planPath, cwd) {
  const hash = crypto.createHash('sha256');

  // 1. Plan file content
  try {
    const planContent = fs.readFileSync(planPath, 'utf-8');
    hash.update('plan:' + planContent);
  } catch {
    return null; // Can't hash without plan
  }

  // 2. Graph DB modification time (proxy for graph state)
  const graphDb = path.join(cwd, '.forge', 'graph.db');
  try {
    const stat = fs.statSync(graphDb);
    hash.update('graph_mtime:' + stat.mtimeMs.toString());
  } catch {
    hash.update('graph_mtime:none');
  }

  // 3. System graph DB modification time
  const systemDb = path.join(cwd, '.forge', 'system-graph.db');
  try {
    const stat = fs.statSync(systemDb);
    hash.update('system_mtime:' + stat.mtimeMs.toString());
  } catch {
    hash.update('system_mtime:none');
  }

  // 4. Knowledge base content hash
  const knowledgePath = path.join(cwd, '.forge', 'knowledge', 'learnings.json');
  try {
    const content = fs.readFileSync(knowledgePath, 'utf-8');
    hash.update('knowledge:' + content);
  } catch {
    hash.update('knowledge:none');
  }

  // 5. Ledger modification time (session state changes between waves)
  const ledgerPath = path.join(cwd, '.forge', 'session', 'ledger.md');
  try {
    const stat = fs.statSync(ledgerPath);
    hash.update('ledger_mtime:' + stat.mtimeMs.toString());
  } catch {
    hash.update('ledger_mtime:none');
  }

  return hash.digest('hex');
}

// ============================================================
// Cache Directory Management
// ============================================================

function getCacheDir(cwd) {
  return path.join(cwd, CACHE_DIR);
}

function getRegistryPath(cwd) {
  return path.join(getCacheDir(cwd), REGISTRY_FILE);
}

function getAgentDir(cwd, taskId) {
  // Sanitize taskId for filesystem
  const safe = taskId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return path.join(getCacheDir(cwd), safe);
}

function ensureCacheDir(cwd) {
  const dir = getCacheDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============================================================
// Registry
// ============================================================

function loadRegistry(cwd) {
  const regPath = getRegistryPath(cwd);
  try {
    const content = fs.readFileSync(regPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { version: 1, agents: {} };
  }
}

function saveRegistry(cwd, registry) {
  ensureCacheDir(cwd);
  const regPath = getRegistryPath(cwd);
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2) + '\n');
}

// ============================================================
// Core Operations
// ============================================================

/**
 * Try to load a cached agent config.
 * Returns { hit: true, result } or { hit: false }.
 */
function loadCached(planPath, cwd, taskId) {
  const inputHash = computeInputHash(planPath, cwd);
  if (!inputHash) return { hit: false };

  const agentDir = getAgentDir(cwd, taskId);
  const metaPath = path.join(agentDir, META_FILE);
  const configPath = path.join(agentDir, AGENT_CONFIG_FILE);

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    // Hash mismatch → stale
    if (meta.input_hash !== inputHash) return { hit: false };

    // Load cached config
    const result = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { hit: true, result, meta };
  } catch {
    return { hit: false };
  }
}

/**
 * Save a factory result to cache.
 */
function saveToCache(planPath, cwd, taskId, factoryResult) {
  const inputHash = computeInputHash(planPath, cwd);
  if (!inputHash) return;

  const agentDir = getAgentDir(cwd, taskId);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  const { agentConfig, analysis } = factoryResult;
  const now = new Date().toISOString();

  // Save full factory result
  const configPath = path.join(agentDir, AGENT_CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(factoryResult, null, 2) + '\n');

  // Save metadata
  const meta = {
    task_id: taskId,
    input_hash: inputHash,
    plan_path: agentConfig.plan_meta?.path || planPath,
    archetype: agentConfig.archetype,
    archetype_reason: agentConfig.archetype_reason,
    phase: agentConfig.plan_meta?.frontmatter?.phase || null,
    modules: analysis?.affectedModules || [],
    risk: analysis?.risk?.level || 'UNKNOWN',
    verification_steps: agentConfig.verification_steps || [],
    capabilities: Object.entries(agentConfig.capabilities || {}).reduce((acc, [mod, caps]) => {
      acc[mod] = caps.map(c => c.capability);
      return acc;
    }, {}),
    files_modified: agentConfig.plan_meta?.files_modified || [],
    created: now,
    last_used: now,
  };

  const metaPath = path.join(agentDir, META_FILE);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  // Update registry
  const registry = loadRegistry(cwd);
  registry.agents[taskId] = {
    archetype: meta.archetype,
    plan_path: meta.plan_path,
    phase: meta.phase,
    modules: meta.modules,
    risk: meta.risk,
    created: meta.created,
    input_hash: meta.input_hash,
    stale: false,
  };
  saveRegistry(cwd, registry);
}

/**
 * Mark a cached agent as used (update last_used timestamp).
 */
function touchCached(cwd, taskId) {
  const agentDir = getAgentDir(cwd, taskId);
  const metaPath = path.join(agentDir, META_FILE);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.last_used = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch { /* non-fatal */ }
}

/**
 * List all cached agents with their metadata.
 */
function listAgents(cwd) {
  const registry = loadRegistry(cwd);
  const agents = [];

  for (const [taskId, entry] of Object.entries(registry.agents)) {
    const agentDir = getAgentDir(cwd, taskId);
    const metaPath = path.join(agentDir, META_FILE);
    let meta = null;
    let stale = true;

    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      // Recompute hash to check staleness
      const currentHash = computeInputHash(
        path.isAbsolute(meta.plan_path) ? meta.plan_path : path.join(cwd, meta.plan_path),
        cwd
      );
      stale = !currentHash || currentHash !== meta.input_hash;
    } catch {
      stale = true;
    }

    agents.push({
      task_id: taskId,
      ...entry,
      stale,
      last_used: meta?.last_used || entry.created,
    });
  }

  return agents;
}

/**
 * Get detailed info for a single cached agent.
 */
function showAgent(cwd, taskId) {
  const agentDir = getAgentDir(cwd, taskId);
  const metaPath = path.join(agentDir, META_FILE);
  const configPath = path.join(agentDir, AGENT_CONFIG_FILE);

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Check staleness
    const currentHash = computeInputHash(
      path.isAbsolute(meta.plan_path) ? meta.plan_path : path.join(cwd, meta.plan_path),
      cwd
    );
    const stale = !currentHash || currentHash !== meta.input_hash;

    return {
      found: true,
      meta: { ...meta, stale },
      config,
    };
  } catch {
    return { found: false };
  }
}

/**
 * Invalidate (remove) stale cached agents.
 * Returns count of removed entries.
 */
function invalidateStale(cwd) {
  const registry = loadRegistry(cwd);
  let removed = 0;

  for (const [taskId, entry] of Object.entries(registry.agents)) {
    const agentDir = getAgentDir(cwd, taskId);
    const metaPath = path.join(agentDir, META_FILE);
    let stale = true;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const currentHash = computeInputHash(
        path.isAbsolute(meta.plan_path) ? meta.plan_path : path.join(cwd, meta.plan_path),
        cwd
      );
      stale = !currentHash || currentHash !== meta.input_hash;
    } catch {
      stale = true;
    }

    if (stale) {
      // Remove directory
      try {
        fs.rmSync(agentDir, { recursive: true, force: true });
      } catch { /* may not exist */ }
      delete registry.agents[taskId];
      removed++;
    }
  }

  saveRegistry(cwd, registry);
  return removed;
}

/**
 * Invalidate a specific agent by taskId.
 */
function invalidateOne(cwd, taskId) {
  const registry = loadRegistry(cwd);
  const agentDir = getAgentDir(cwd, taskId);

  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
  } catch { /* may not exist */ }

  const existed = !!registry.agents[taskId];
  delete registry.agents[taskId];
  saveRegistry(cwd, registry);
  return existed;
}

/**
 * Clear entire agent cache.
 */
function clearAll(cwd) {
  const cacheDir = getCacheDir(cwd);
  const registry = loadRegistry(cwd);
  const count = Object.keys(registry.agents).length;

  // Remove all agent subdirectories but keep the cache dir itself
  try {
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(cacheDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* cache dir may not exist */ }

  saveRegistry(cwd, { version: 1, agents: {} });
  return count;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  computeInputHash,
  loadCached,
  saveToCache,
  touchCached,
  listAgents,
  showAgent,
  invalidateStale,
  invalidateOne,
  clearAll,
  loadRegistry,
};
