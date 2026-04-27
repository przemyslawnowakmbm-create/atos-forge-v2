#!/usr/bin/env node
'use strict';

/**
 * Unified Configuration System — single source of truth for all Forge config.
 *
 * Merge order: defaults ← ~/.forge/config.json (global) ← .forge/config.json (project)
 *
 * Exports:
 *   loadConfig(cwd)          — merged config + source info
 *   resolveEffective(cwd)    — merged + system detection (resolved container limits)
 *   getDefault()             — fresh copy of defaults
 *   validate(config)         — schema validation
 *   saveProjectConfig(cwd, c) — write .forge/config.json
 *   getVerification(cwd)     — backward-compat shape for engine.js / loop.js
 *   getContainers(cwd)       — backward-compat shape for containers/config.js
 *   getExecution(cwd)        — backward-compat shape for assessor.js
 *   getLegacyToolsConfig(cwd) — backward-compat flat shape for forge-tools.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// Full Default Schema
// ============================================================

const DEFAULTS = {
  project: {
    name: '',
    description: '',
  },
  graph: {
    enabled: true,
    auto_update: true,
    languages: [],
    ignore_patterns: ['node_modules', 'dist', 'build', '.git', 'vendor'],
    module_detection: true,
    capability_detection: true,
    dashboard_auto_regenerate: true,
    snapshot_retention: 20,
    auto_watch: false,
  },
  execution: {
    mode: 'interactive',
    container_backend: 'worktree',
    context_budget: 200000,
    safety_margin: 0.20,
    assessment_threshold: 0.80,
    auto_split: true,
    max_fix_loops: 3,
    overhead_per_subtask: 5000,
    min_action_budget: 15000,
    chars_per_token: 4,
    budget_ceiling_usd: null,
  },
  containers: {
    max_concurrent: 'auto',
    max_memory_per_container: '2g',
    max_cpu_per_container: 1.0,
    max_total_memory: 'auto',
    max_total_cpu: 'auto',
    timeout_seconds: 600,
    network_access: false,
    cleanup_on_exit: true,
    image_prefix: 'forge-agent',
    worktree_base: path.join(os.tmpdir(), 'forge-worktrees'),
    output_base: path.join(os.tmpdir(), 'forge-output'),
    cleanup_on_success: true,
    cleanup_on_failure: false,
  },
  agents: {
    factory_enabled: true,
    default_archetype: 'general',
    capability_templates_dir: '',
    provider: 'auto',
    model_profiles: {
      quality: 'opus',
      balanced: 'sonnet',
      budget: 'haiku',
    },
    provider_model_profiles: {
      codex: {
        quality: 'o3',
        balanced: 'o3',
        budget: 'o3',
      },
    },
    active_profile: 'balanced',
  },
  verification: {
    layers: {
      structural: true,
      type_check: true,
      interface_contracts: true,
      dependency_analysis: true,
      tests: true,
      behavioral: true,
      contract: true,
      architectural: false,
      browser: false,
    },
    auto_fix: true,
    max_fix_loops: 3,
    test_command: null,
    type_check_command: null,
    test_timeout: 300,
  },
  knowledge: {
    enabled: true,
    auto_promote: true,
    max_entries: 200,
    promote_severity_threshold: 'medium',
  },
  decisions: {
    enabled: true,
    dedup_threshold: 0.80,
  },
  impact_analysis: {
    enabled: true,
    auto_detect: true,
    max_depth: 2,
    scope_threshold: 1,
  },
  session: {
    ledger_enabled: true,
    ledger_max_tokens: 8000,
    auto_compact: true,
    archive_on_phase_complete: true,
  },
  display: {
    rich_output: true,
    inline_graph_context: true,
    show_graph_diff: true,
    show_agent_learnings: true,
  },
  git: {
    atomic_commits: true,
    commit_prefix: '',
    branching_strategy: 'none',
    sign_commits: false,
    phase_branch_template: 'forge/phase-{phase}-{slug}',
    milestone_branch_template: 'forge/{milestone}-{slug}',
  },
  system: {
    enabled: true,
    auto_detect_interfaces: true,
    workers: 'auto',
    discovery_depth: 2,
    default_delivery: 'local',
    sync_on_commit: false,
    graph_path: null,
    registry_path: null,
    ignore_repos: [],
  },
  // Legacy compat sections (for .planning/config.json backward compatibility)
  workflow: {
    research: true,
    plan_check: true,
    verifier: true,
    auto_advance: false,
    arch_review: true,
  },
  parallelization: {
    enabled: true,
    plan_level: true,
    task_level: false,
    skip_checkpoints: true,
    max_concurrent_agents: 3,
    min_plans_for_parallel: 2,
  },
  gates: {
    confirm_project: true,
    confirm_phases: true,
    confirm_roadmap: true,
    confirm_breakdown: true,
    confirm_plan: true,
    execute_next_plan: true,
    issues_review: true,
    confirm_transition: true,
  },
  safety: {
    always_confirm_destructive: true,
    always_confirm_external_services: true,
  },
};

// ============================================================
// Helpers
// ============================================================

/**
 * Deep merge source into target. Arrays are replaced, not concatenated.
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    if (source[key] === null || source[key] === undefined) {
      target[key] = source[key];
    } else if (
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseMemoryString(str) {
  if (typeof str === 'number') return str;
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(g|gb|m|mb)?$/i);
  if (!match) return 2 * 1024 * 1024 * 1024;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'g').toLowerCase();
  if (unit.startsWith('m')) return Math.floor(num * 1024 * 1024);
  return Math.floor(num * 1024 * 1024 * 1024);
}

function formatMemory(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}g`;
  return `${Math.floor(bytes / (1024 * 1024))}m`;
}

// ============================================================
// Core Loading
// ============================================================

function getDefault() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function loadGlobalConfig() {
  return readJsonSafe(path.join(os.homedir(), '.forge', 'config.json'));
}

function loadProjectConfig(cwd) {
  const root = cwd || process.cwd();
  const candidates = [
    { path: path.join(root, '.forge', 'config.json'), source: '.forge/config.json' },
    { path: path.join(root, '.planning', 'config.json'), source: '.planning/config.json' },
  ];
  for (const c of candidates) {
    const config = readJsonSafe(c.path);
    if (config && Object.keys(config).length > 0) return { config, source: c.source };
  }
  return { config: null, source: null };
}

/**
 * Load the effective (merged) config: defaults ← global ← project.
 */
function loadConfig(cwd) {
  const result = getDefault();
  const sources = { defaults: true, global: false, project: false };

  const global = loadGlobalConfig();
  if (global) {
    deepMerge(result, global);
    sources.global = true;
  }

  const { config: project, source: projectSource } = loadProjectConfig(cwd);
  if (project) {
    deepMerge(result, project);
    sources.project = true;
  }

  return { config: result, sources, projectSource };
}

/**
 * Resolve effective config with system detection applied to 'auto' fields.
 */
function resolveEffective(cwd) {
  const { config, sources, projectSource } = loadConfig(cwd);

  const totalCores = os.cpus().length;
  const totalMemBytes = os.totalmem();

  const memPerContainer = parseMemoryString(config.containers.max_memory_per_container);
  const cpuPerContainer = config.containers.max_cpu_per_container;

  const maxTotalMemory = config.containers.max_total_memory === 'auto'
    ? Math.floor(totalMemBytes * 0.7)
    : parseMemoryString(config.containers.max_total_memory);
  const maxTotalCpu = config.containers.max_total_cpu === 'auto'
    ? Math.max(1, totalCores - 2)
    : parseFloat(config.containers.max_total_cpu);

  let maxConcurrent;
  if (config.containers.max_concurrent === 'auto') {
    const byMemory = Math.floor(maxTotalMemory / memPerContainer);
    const byCpu = Math.floor(maxTotalCpu / cpuPerContainer);
    maxConcurrent = Math.min(byMemory, byCpu);
    maxConcurrent = Math.max(1, Math.min(8, maxConcurrent));
  } else {
    maxConcurrent = Math.max(1, Math.min(8, parseInt(config.containers.max_concurrent) || 1));
  }

  config.containers._resolved = {
    max_concurrent: maxConcurrent,
    max_memory_per_container_bytes: memPerContainer,
    max_memory_per_container_str: formatMemory(memPerContainer),
    max_total_memory_bytes: maxTotalMemory,
    max_total_memory_str: formatMemory(maxTotalMemory),
    max_total_cpu: maxTotalCpu,
  };

  config._system = {
    total_cores: totalCores,
    total_memory_bytes: totalMemBytes,
    total_memory_str: formatMemory(totalMemBytes),
    node_version: process.version,
    platform: os.platform(),
    arch: os.arch(),
  };

  config._sources = sources;
  config._projectSource = projectSource;

  return config;
}

// ============================================================
// Validation
// ============================================================

function validate(config) {
  const errors = [];

  const numberChecks = [
    ['execution.assessment_threshold', config.execution?.assessment_threshold, v => v >= 0 && v <= 1],
    ['execution.safety_margin', config.execution?.safety_margin, v => v >= 0 && v <= 1],
    ['execution.context_budget', config.execution?.context_budget, v => v > 0],
    ['execution.max_fix_loops', config.execution?.max_fix_loops, v => v >= 0 && v <= 20],
    ['containers.timeout_seconds', config.containers?.timeout_seconds, v => v > 0],
    ['containers.max_cpu_per_container', config.containers?.max_cpu_per_container, v => v > 0],
    ['verification.max_fix_loops', config.verification?.max_fix_loops, v => v >= 0 && v <= 20],
    ['verification.test_timeout', config.verification?.test_timeout, v => v > 0],
    ['session.ledger_max_tokens', config.session?.ledger_max_tokens, v => v > 0],
    ['graph.snapshot_retention', config.graph?.snapshot_retention, v => v > 0],
    ['knowledge.max_entries', config.knowledge?.max_entries, v => v > 0 && v <= 10000],
    ['impact_analysis.max_depth', config.impact_analysis?.max_depth, v => v >= 1 && v <= 10],
    ['impact_analysis.scope_threshold', config.impact_analysis?.scope_threshold, v => v >= 1 && v <= 20],
  ];

  for (const [keyPath, value, rangeFn] of numberChecks) {
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number') {
        errors.push(`${keyPath}: expected number, got ${typeof value}`);
      } else if (!rangeFn(value)) {
        errors.push(`${keyPath}: value ${value} out of valid range`);
      }
    }
  }

  const enumChecks = [
    ['execution.mode', config.execution?.mode, ['interactive', 'autonomous', 'supervised']],
    ['execution.container_backend', config.execution?.container_backend, ['docker', 'worktree']],
    ['agents.provider', config.agents?.provider, ['auto', 'claude', 'codex']],
    ['agents.active_profile', config.agents?.active_profile, ['quality', 'balanced', 'budget']],
    ['agents.default_archetype', config.agents?.default_archetype, ['specialist', 'integrator', 'careful', 'general']],
    ['git.branching_strategy', config.git?.branching_strategy, ['none', 'phase', 'milestone', 'feature']],
    ['knowledge.promote_severity_threshold', config.knowledge?.promote_severity_threshold, ['low', 'medium', 'high', 'critical']],
  ];

  for (const [keyPath, value, allowed] of enumChecks) {
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      errors.push(`${keyPath}: invalid value '${value}', must be one of: ${allowed.join(', ')}`);
    }
  }

  if (config.verification?.layers) {
    for (const [key, val] of Object.entries(config.verification.layers)) {
      if (typeof val !== 'boolean') {
        errors.push(`verification.layers.${key}: expected boolean, got ${typeof val}`);
      }
    }
  }

  if (config.graph?.ignore_patterns && !Array.isArray(config.graph.ignore_patterns)) {
    errors.push('graph.ignore_patterns: expected array');
  }

  // System section validation
  if (config.system) {
    const sw = config.system.workers;
    if (sw !== undefined && sw !== null && sw !== 'auto') {
      if (typeof sw !== 'number' || sw < 1 || !Number.isInteger(sw)) {
        errors.push(`system.workers: must be 'auto' or a positive integer, got ${sw}`);
      }
    }
    const dd = config.system.discovery_depth;
    if (dd !== undefined && dd !== null) {
      if (typeof dd !== 'number' || dd < 1 || dd > 5 || !Number.isInteger(dd)) {
        errors.push(`system.discovery_depth: must be integer 1-5, got ${dd}`);
      }
    }
    const del = config.system.default_delivery;
    if (del !== undefined && del !== null && !['local', 'pr', 'commit', 'dry-run'].includes(del)) {
      errors.push(`system.default_delivery: invalid value '${del}', must be one of: local, pr, commit, dry-run`);
    }
    if (config.system.ignore_repos && !Array.isArray(config.system.ignore_repos)) {
      errors.push('system.ignore_repos: expected array');
    }
  }

  // Validate containers.max_concurrent: must be 'auto' or a positive integer
  const mc = config.containers?.max_concurrent;
  if (mc !== undefined && mc !== null && mc !== 'auto') {
    if (typeof mc !== 'number' || mc < 1 || !Number.isInteger(mc)) {
      errors.push(`containers.max_concurrent: must be 'auto' or a positive integer, got ${mc}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// Save
// ============================================================

function saveProjectConfig(cwd, config) {
  const dir = path.join(cwd, '.forge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { saved: true, path: configPath };
}

// ============================================================
// Section Accessors (backward-compatible return shapes)
// ============================================================

/**
 * Get verification config with UPPERCASE keys for engine.js / loop.js compat.
 */
function getVerification(cwd) {
  const { config } = loadConfig(cwd);
  const layers = config.verification.layers;

  // Handle both old UPPERCASE and new lowercase keys from project configs
  const get = (lower, ...uppers) => {
    if (layers[lower] !== undefined) return layers[lower];
    for (const u of uppers) {
      if (layers[u] !== undefined) return layers[u];
    }
    return true; // default enabled
  };

  return {
    layers: {
      STRUCTURAL: get('structural', 'STRUCTURAL'),
      TYPE_COMPILE: get('type_check', 'TYPE_COMPILE'),
      INTERFACE_CONTRACTS: get('interface_contracts', 'INTERFACE_CONTRACTS'),
      DEPENDENCY: get('dependency_analysis', 'DEPENDENCY'),
      TESTS: get('tests', 'TESTS'),
      BEHAVIORAL: get('behavioral', 'BEHAVIORAL'),
      CONTRACT: get('contract', 'CONTRACT'),
      ARCHITECTURAL: layers.architectural === true,
      BROWSER: layers.browser === true,
    },
    auto_fix: config.verification.auto_fix,
    max_fix_loops: config.verification.max_fix_loops,
    test_command: config.verification.test_command,
    type_check_command: config.verification.type_check_command,
    test_timeout: config.verification.test_timeout,
  };
}

/**
 * Get containers config matching old loadContainerConfig shape.
 */
function getContainers(cwd) {
  const { config } = loadConfig(cwd);
  return { ...config.containers };
}

/**
 * Get execution config matching old loadForgeConfig shape.
 */
function getExecution(cwd) {
  const { config } = loadConfig(cwd);
  return { ...config.execution };
}

/**
 * Get system graph config for forge-system modules.
 */
function getSystem(cwd) {
  const { config } = loadConfig(cwd);
  const sys = config.system || {};
  const workers = sys.workers === 'auto'
    ? Math.max(1, Math.min(16, os.cpus().length - 2))
    : (sys.workers || Math.max(1, Math.min(16, os.cpus().length - 2)));
  return {
    ...sys,
    _resolved_workers: workers,
  };
}

/**
 * Get knowledge config.
 */
function getKnowledge(cwd) {
  const { config } = loadConfig(cwd);
  return { ...(config.knowledge || {}) };
}

/**
 * Get impact analysis config.
 */
function getImpactAnalysis(cwd) {
  const { config } = loadConfig(cwd);
  return { ...(config.impact_analysis || {}) };
}

/**
 * Get legacy flat config shape for forge-tools.cjs loadConfig compat.
 */
function getLegacyToolsConfig(cwd) {
  const { config } = loadConfig(cwd);

  const parallelization = (() => {
    if (typeof config.parallelization === 'boolean') return config.parallelization;
    if (typeof config.parallelization === 'object' && config.parallelization !== null) {
      return config.parallelization.enabled !== false;
    }
    return true;
  })();

  return {
    model_profile: config.agents?.active_profile || 'balanced',
    agent_provider: config.agents?.provider || 'auto',
    commit_docs: config.workflow?.commit_docs ?? config.planning?.commit_docs ?? true,
    search_gitignored: config.workflow?.search_gitignored ?? config.planning?.search_gitignored ?? false,
    branching_strategy: config.git?.branching_strategy || 'none',
    phase_branch_template: config.git?.phase_branch_template || 'forge/phase-{phase}-{slug}',
    milestone_branch_template: config.git?.milestone_branch_template || 'forge/{milestone}-{slug}',
    research: config.workflow?.research ?? true,
    plan_checker: config.workflow?.plan_check ?? true,
    verifier: config.workflow?.verifier ?? true,
    parallelization,
    brave_search: config.brave_search ?? false,
  };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  DEFAULTS,
  loadConfig,
  resolveEffective,
  getDefault,
  validate,
  saveProjectConfig,
  deepMerge,
  getVerification,
  getContainers,
  getExecution,
  getSystem,
  getKnowledge,
  getImpactAnalysis,
  getLegacyToolsConfig,
  loadGlobalConfig,
  loadProjectConfig,
  readJsonSafe,
  parseMemoryString,
  formatMemory,
};
