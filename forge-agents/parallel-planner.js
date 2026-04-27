#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Parallel Execution Planner
// ============================================================
// Combines task dependency DAG + resource limits + agent container
// specs + system capacity to produce execution waves.
//
// Input:  Array of factory results ({ agentConfig, containerParams, analysis })
// Output: Ordered waves with parallelism limits and resource allocation
// ============================================================

// Lazy-loaded dependencies
let _containerConfig, _ledger, _systemQuery;

function containerConfig() {
  if (!_containerConfig) _containerConfig = require('../forge-containers/config');
  return _containerConfig;
}
function ledger() {
  if (!_ledger) _ledger = require('../forge-session/ledger');
  return _ledger;
}
function systemQuery() {
  if (!_systemQuery) _systemQuery = require('../forge-system/query');
  return _systemQuery;
}

// ============================================================
// Constants
// ============================================================

// Time estimates per archetype (minutes)
const ARCHETYPE_TIME_ESTIMATES = {
  specialist: { min: 2, max: 5 },
  integrator: { min: 4, max: 8 },
  careful: { min: 5, max: 10 },
  general: { min: 3, max: 6 },
};

const DEFAULT_TIME_ESTIMATE = { min: 3, max: 6 };

// ============================================================
// Step 1: Build Dependency DAG
// ============================================================

/**
 * Resolve a dependency name to a task_id, supporting fuzzy matching.
 *
 * Plans may reference deps as "PLAN-auth-service" while the actual task_id
 * is "04-PLAN-auth-service" (prefixed with phase number from filename).
 * This resolves by: exact match → suffix match → service-id match.
 */
function resolveDepName(dep, nodes) {
  // Exact match
  if (nodes.has(dep)) return dep;

  // Suffix match: "PLAN-auth-service" matches "04-PLAN-auth-service"
  for (const id of nodes.keys()) {
    if (id.endsWith(dep) || id.endsWith('-' + dep)) return id;
  }

  // Service-id match: "auth-service" matches any task with that service in frontmatter
  const depLower = dep.replace(/^PLAN-/i, '').toLowerCase();
  for (const [id, result] of nodes) {
    const svc = result.agentConfig?.plan_meta?.frontmatter?.service;
    if (svc && svc.toLowerCase() === depLower) return id;
  }

  return null;
}

/**
 * Build a dependency graph from an array of factory results.
 *
 * Each result has:
 *   result.agentConfig.task_id          — unique node ID
 *   result.agentConfig.plan_meta.frontmatter.depends_on — array of task_ids
 *
 * @param {object[]} factoryResults — from factory.buildAgentConfig() or factory.buildAll()
 * @returns {{ nodes: Map<string, object>, edges: Map<string, string[]>, reverseEdges: Map<string, string[]> }}
 */
function buildDAG(factoryResults) {
  const nodes = new Map();   // taskId → factoryResult
  const edges = new Map();   // taskId → [dependency taskIds]  (this task depends on these)
  const reverseEdges = new Map(); // taskId → [dependent taskIds]  (these depend on this task)

  // Index all nodes
  for (const result of factoryResults) {
    const id = result.agentConfig.task_id;
    nodes.set(id, result);
    edges.set(id, []);
    reverseEdges.set(id, []);
  }

  // Build edges from depends_on (with fuzzy matching for cross-repo plans)
  for (const result of factoryResults) {
    const id = result.agentConfig.task_id;
    const deps = result.agentConfig.plan_meta?.frontmatter?.depends_on || [];
    for (const dep of deps) {
      const resolvedDep = resolveDepName(dep, nodes);
      if (resolvedDep) {
        edges.get(id).push(resolvedDep);
        reverseEdges.get(resolvedDep).push(id);
      }
      // Silently ignore unknown deps (may reference tasks outside this batch)
    }
  }

  // Cross-repo ordering: provider changes before consumer changes
  // If task A modifies a service that task B's service imports from,
  // task A must run first (B depends_on A).
  addCrossRepoDependencies(factoryResults, nodes, edges, reverseEdges);

  return { nodes, edges, reverseEdges };
}

/**
 * Add implicit cross-repo dependency edges based on system graph.
 *
 * Rule: If task A touches a provider service and task B touches a consumer
 * of that service, then B depends on A (provider changes first).
 *
 * Only applies when tasks have system_context from the agent factory.
 */
function addCrossRepoDependencies(factoryResults, nodes, edges, reverseEdges) {
  // Build service → taskId mapping
  const serviceToTask = new Map(); // serviceId → taskId
  const taskToService = new Map(); // taskId → serviceId

  for (const result of factoryResults) {
    const id = result.agentConfig.task_id;
    const serviceId = result.agentConfig.system_context?.service_id;
    if (serviceId) {
      serviceToTask.set(serviceId, id);
      taskToService.set(id, serviceId);
    }
  }

  // Skip if less than 2 services (no cross-repo to order)
  if (serviceToTask.size < 2) return;

  // For each task, check if its service is consumed by another task's service
  for (const result of factoryResults) {
    const id = result.agentConfig.task_id;
    const sc = result.agentConfig.system_context;
    if (!sc || !sc.consumers) continue;

    // This task's service is a provider — find consumer tasks
    for (const consumer of sc.consumers) {
      const consumerTaskId = serviceToTask.get(consumer.consumer_id);
      if (consumerTaskId && consumerTaskId !== id) {
        // Consumer task depends on this provider task
        const existingDeps = edges.get(consumerTaskId);
        if (existingDeps && !existingDeps.includes(id)) {
          existingDeps.push(id);
          reverseEdges.get(id).push(consumerTaskId);
        }
      }
    }
  }
}

// ============================================================
// Step 2: Topological Sort → Waves
// ============================================================

/**
 * Topological sort using Kahn's algorithm, producing parallel waves.
 * Each wave contains tasks whose dependencies have all been satisfied
 * by previous waves.
 *
 * @param {{ nodes, edges, reverseEdges }} dag
 * @returns {{ waves: string[][], hasCycle: boolean, cycleNodes: string[] }}
 */
function topoSortWaves(dag) {
  const { nodes, edges } = dag;
  const inDegree = new Map();

  // Calculate in-degree for each node
  for (const [id] of nodes) {
    inDegree.set(id, edges.get(id).length);
  }

  const waves = [];
  const processed = new Set();

  while (processed.size < nodes.size) {
    // Find all nodes with in-degree 0 (no unprocessed deps)
    const wave = [];
    for (const [id] of nodes) {
      if (!processed.has(id) && inDegree.get(id) === 0) {
        wave.push(id);
      }
    }

    // Cycle detection: no nodes ready but still unprocessed
    if (wave.length === 0) {
      const cycleNodes = [...nodes.keys()].filter(id => !processed.has(id));
      return { waves, hasCycle: true, cycleNodes };
    }

    waves.push(wave);

    // Mark processed and reduce in-degree of dependents
    for (const id of wave) {
      processed.add(id);
      // Find all nodes that depend on this one
      for (const [otherId, deps] of edges) {
        if (deps.includes(id)) {
          inDegree.set(otherId, inDegree.get(otherId) - 1);
        }
      }
    }
  }

  return { waves, hasCycle: false, cycleNodes: [] };
}

// ============================================================
// Step 3: Resource-Aware Wave Splitting
// ============================================================

/**
 * Split waves that exceed resource limits into sub-waves.
 *
 * @param {string[][]} waves — task IDs grouped by topological wave
 * @param {Map<string, object>} nodes — taskId → factoryResult
 * @param {object} resources — resolved container config
 * @returns {object[]} Array of wave objects with resource allocation
 */
function splitWavesForResources(waves, nodes, resources) {
  const memPerContainer = resources.max_memory_per_container;
  const cpuPerContainer = resources.max_cpu_per_container;
  const maxConcurrent = resources.max_concurrent;
  const maxTotalMemory = resources.max_total_memory;
  const maxTotalCpu = resources.max_total_cpu;

  const result = [];
  let waveIndex = 0;

  for (const wave of waves) {
    // Sort tasks within wave: careful/integrator first (heavier), then by file count desc
    const sorted = [...wave].sort((a, b) => {
      const ra = nodes.get(a);
      const rb = nodes.get(b);
      const archOrder = { careful: 0, integrator: 1, specialist: 2, general: 3 };
      const aOrder = archOrder[ra?.agentConfig?.archetype] ?? 3;
      const bOrder = archOrder[rb?.agentConfig?.archetype] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      // Secondary: more files first
      const aFiles = ra?.agentConfig?.plan_meta?.files_modified?.length || 0;
      const bFiles = rb?.agentConfig?.plan_meta?.files_modified?.length || 0;
      return bFiles - aFiles;
    });

    // Bin-pack into sub-waves respecting limits
    let currentSubWave = [];
    let currentMem = 0;
    let currentCpu = 0;

    for (const taskId of sorted) {
      const taskMem = memPerContainer;
      const taskCpu = cpuPerContainer;

      const wouldExceedConcurrency = currentSubWave.length >= maxConcurrent;
      const wouldExceedMemory = currentMem + taskMem > maxTotalMemory;
      const wouldExceedCpu = currentCpu + taskCpu > maxTotalCpu;

      if (currentSubWave.length > 0 && (wouldExceedConcurrency || wouldExceedMemory || wouldExceedCpu)) {
        // Flush current sub-wave
        result.push(buildWaveObject(waveIndex, currentSubWave, nodes, resources));
        waveIndex++;
        currentSubWave = [];
        currentMem = 0;
        currentCpu = 0;
      }

      currentSubWave.push(taskId);
      currentMem += taskMem;
      currentCpu += taskCpu;
    }

    // Flush remaining
    if (currentSubWave.length > 0) {
      result.push(buildWaveObject(waveIndex, currentSubWave, nodes, resources));
      waveIndex++;
    }
  }

  return result;
}

/**
 * Build a wave object with resource allocation details.
 */
function buildWaveObject(index, taskIds, nodes, resources) {
  const agents = taskIds.map(id => {
    const r = nodes.get(id);
    const archetype = r?.agentConfig?.archetype || 'general';
    const timeEst = ARCHETYPE_TIME_ESTIMATES[archetype] || DEFAULT_TIME_ESTIMATE;
    return {
      task_id: id,
      archetype,
      memory: resources.max_memory_per_container_str,
      cpu: resources.max_cpu_per_container,
      timeout: resources.timeout_seconds,
      objective: r?.agentConfig?.plan_meta?.objective || '',
      files_modified: r?.agentConfig?.plan_meta?.files_modified || [],
      depends_on: r?.agentConfig?.plan_meta?.frontmatter?.depends_on || [],
      time_estimate: timeEst,
    };
  });

  const totalMem = taskIds.length * resources.max_memory_per_container;
  const totalCpu = taskIds.length * resources.max_cpu_per_container;

  // Wave time estimate: max of individual agent estimates (parallel execution)
  const maxMin = Math.max(...agents.map(a => a.time_estimate.min));
  const maxMax = Math.max(...agents.map(a => a.time_estimate.max));

  return {
    wave: index + 1,
    agents,
    resource_allocation: {
      agent_count: taskIds.length,
      total_memory: containerConfig().formatMemory(totalMem),
      total_memory_bytes: totalMem,
      total_cpu: totalCpu,
      max_concurrent: resources.max_concurrent,
    },
    time_estimate: { min: maxMin, max: maxMax },
  };
}

// ============================================================
// Main: planExecution
// ============================================================

/**
 * Plan parallel execution for a set of factory results.
 *
 * @param {object[]} factoryResults — from factory.buildAgentConfig() or factory.buildAll()
 * @param {string} cwd — project root
 * @param {object} [opts]
 * @param {object} [opts.resources] — override resolved resource config
 * @param {boolean} [opts.logToLedger] — write plan to session ledger (default: true)
 * @returns {object} execution plan
 */
function planExecution(factoryResults, cwd, opts = {}) {
  if (!factoryResults || factoryResults.length === 0) {
    return {
      waves: [],
      summary: { total_agents: 0, total_waves: 0, has_cycle: false },
      resources: {},
    };
  }

  // Resolve resources
  let resources;
  if (opts.resources) {
    resources = opts.resources;
  } else {
    try {
      resources = containerConfig().resolveConfig(cwd);
    } catch {
      // Fallback when config module unavailable
      resources = {
        max_concurrent: 3,
        max_memory_per_container: 2 * 1024 * 1024 * 1024,
        max_memory_per_container_str: '2.0g',
        max_cpu_per_container: 1.0,
        max_total_memory: 12 * 1024 * 1024 * 1024,
        max_total_memory_str: '12.0g',
        max_total_cpu: 6,
        timeout_seconds: 600,
        system: { total_cores: 8, total_memory: 16 * 1024 * 1024 * 1024, total_memory_str: '16.0g' },
      };
    }
  }

  // Step 1: Build DAG
  const dag = buildDAG(factoryResults);

  // Step 2: Topological sort → waves
  const { waves: rawWaves, hasCycle, cycleNodes } = topoSortWaves(dag);

  // Step 3: Resource-aware wave splitting
  const waves = splitWavesForResources(rawWaves, dag.nodes, resources);

  // Summary
  const totalAgents = factoryResults.length;
  const totalMinTime = waves.reduce((sum, w) => sum + w.time_estimate.min, 0);
  const totalMaxTime = waves.reduce((sum, w) => sum + w.time_estimate.max, 0);
  const peakMemory = Math.max(...waves.map(w => w.resource_allocation.total_memory_bytes), 0);

  const summary = {
    total_agents: totalAgents,
    total_waves: waves.length,
    has_cycle: hasCycle,
    cycle_nodes: cycleNodes,
    estimated_duration: `${totalMinTime}-${totalMaxTime} min`,
    peak_memory: containerConfig().formatMemory(peakMemory),
    peak_memory_bytes: peakMemory,
  };

  // Build dependency map for display
  const dependencyMap = {};
  for (const [id, deps] of dag.edges) {
    if (deps.length > 0) {
      dependencyMap[id] = deps;
    }
  }

  const plan = {
    waves,
    summary,
    resources: {
      system_memory: resources.system?.total_memory_str || 'unknown',
      system_cores: resources.system?.total_cores || 0,
      max_concurrent: resources.max_concurrent,
      memory_per_container: resources.max_memory_per_container_str,
      cpu_per_container: resources.max_cpu_per_container,
      max_total_memory: resources.max_total_memory_str,
      timeout: resources.timeout_seconds,
    },
    dependencies: dependencyMap,
  };

  // Log to ledger
  if (opts.logToLedger !== false) {
    logPlanToLedger(cwd, plan);
  }

  return plan;
}

// ============================================================
// Ledger Integration
// ============================================================

/**
 * Log execution plan to session ledger.
 */
function logPlanToLedger(cwd, plan) {
  try {
    const L = ledger();
    L.updateState(cwd, {
      waves_planned: plan.summary.total_waves,
      total_agents: plan.summary.total_agents,
      estimated_duration: plan.summary.estimated_duration,
    });

    const waveDetails = plan.waves.map(w =>
      `Wave ${w.wave}: ${w.agents.map(a => a.task_id).join(', ')} (${w.resource_allocation.total_memory}, ${w.time_estimate.min}-${w.time_estimate.max}min)`
    ).join('\n  ');

    L.logEvent(cwd, 'Parallel execution plan created', {
      agents: plan.summary.total_agents,
      waves: plan.summary.total_waves,
      duration: plan.summary.estimated_duration,
      peak_memory: plan.summary.peak_memory,
      plan: waveDetails,
    });
  } catch { /* ledger may not exist */ }
}

// ============================================================
// Display
// ============================================================

/**
 * Format execution plan as a visual box display.
 *
 * @param {object} plan — from planExecution()
 * @returns {string}
 */
function formatPlan(plan) {
  const lines = [];
  const W = 60; // inner width

  function pad(str, width) { return str.substring(0, width).padEnd(width); }
  function hline(ch) { return ch.repeat(W); }
  function boxLine(content) { return `  ║  ${pad(content, W - 2)}║`; }

  lines.push(`  ╔═${hline('═')}╗`);
  lines.push(`  ║ ${pad('PARALLEL EXECUTION PLAN', W - 1)}║`);
  lines.push(`  ╠═${hline('═')}╣`);

  // System info
  lines.push(boxLine(`System: ${plan.resources.system_memory} RAM, ${plan.resources.system_cores} cores`));
  lines.push(boxLine(`Container limits: max ${plan.resources.max_concurrent} concurrent, ${plan.resources.memory_per_container} each`));
  lines.push(boxLine(''));

  if (plan.summary.has_cycle) {
    lines.push(boxLine(`WARNING: Dependency cycle detected!`));
    lines.push(boxLine(`Cycle nodes: ${plan.summary.cycle_nodes.join(', ')}`));
    lines.push(boxLine(''));
  }

  // Waves
  for (let i = 0; i < plan.waves.length; i++) {
    const wave = plan.waves[i];
    const agents = wave.agents;

    // Wave header with agent boxes
    const agentLabels = agents.map(a => `[${a.task_id}]`);
    const agentResources = agents.map(a => `${a.memory} / ${a.cpu} CPU`);

    // First line: wave label + agents
    const agentLine = agentLabels.join('  ');
    lines.push(boxLine(`Wave ${wave.wave} ─── ${agentLine}`));

    // Resource line for each agent
    const resLine = agentResources.map((r, j) => {
      const label = agentLabels[j];
      const spacing = ' '.repeat(Math.max(0, label.length - r.length));
      return r + spacing;
    }).join('  ');
    lines.push(boxLine(`         ${resLine}`));

    // Archetype annotations
    const archLine = agents.map(a => {
      const label = agentLabels[agents.indexOf(a)];
      const tag = a.archetype.charAt(0).toUpperCase();
      const padding = ' '.repeat(Math.max(0, label.length - tag.length));
      return tag + padding;
    }).join('  ');
    lines.push(boxLine(`         ${archLine}`));

    // Connection lines between waves
    if (i < plan.waves.length - 1) {
      // Find dependencies from next wave to this wave
      const nextWave = plan.waves[i + 1];
      const hasConnection = nextWave.agents.some(a =>
        a.depends_on.some(d => agents.some(ca => ca.task_id === d))
      );
      if (hasConnection) {
        lines.push(boxLine(`              │`));
        lines.push(boxLine(`              ▼`));
      } else {
        lines.push(boxLine(''));
      }
    }
  }

  lines.push(boxLine(''));

  // Summary
  const summaryLine = `Total: ${plan.summary.total_agents} agents, ${plan.waves.length} waves, ~${plan.summary.estimated_duration}, peak ${plan.summary.peak_memory} RAM`;
  lines.push(boxLine(summaryLine));
  lines.push(`  ╚═${hline('═')}╝`);

  return lines.join('\n');
}

/**
 * Format plan as compact table for JSON-averse users.
 */
function formatTable(plan) {
  const lines = [];
  lines.push('Wave  Agents                                      Memory   Time');
  lines.push('────  ──────────────────────────────────────────  ───────  ────────');
  for (const wave of plan.waves) {
    const ids = wave.agents.map(a => a.task_id).join(', ');
    const mem = wave.resource_allocation.total_memory;
    const time = `${wave.time_estimate.min}-${wave.time_estimate.max}m`;
    lines.push(`  ${String(wave.wave).padEnd(4)}${ids.padEnd(44)}${mem.padEnd(9)}${time}`);
  }
  lines.push('');
  lines.push(`Total: ${plan.summary.total_agents} agents, ~${plan.summary.estimated_duration}, peak ${plan.summary.peak_memory}`);
  return lines.join('\n');
}

// ============================================================
// CLI
// ============================================================

function printUsage() {
  console.log(`
Usage: node forge-agents/parallel-planner.js <command> [options]

Commands:
  plan <dir>             Plan execution for all .md plans in directory
  plan-configs <json>    Plan from a JSON array of factory results
  dry-run <dir>          Analyze plans and show execution plan (no ledger write)

Options:
  --root <path>          Project root (default: cwd)
  --json                 Output raw JSON
  --table                Output compact table format
  --max-concurrent <n>   Override max concurrent agents
  --memory <str>         Override memory per container (e.g., "4g")
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const target = args[1];

  // Parse flags
  const flags = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) { flags.root = args[++i]; }
    else if (args[i] === '--json') { flags.json = true; }
    else if (args[i] === '--table') { flags.table = true; }
    else if (args[i] === '--max-concurrent' && args[i + 1]) { flags.maxConcurrent = parseInt(args[++i], 10); }
    else if (args[i] === '--memory' && args[i + 1]) { flags.memory = args[++i]; }
  }

  const cwd = path.resolve(flags.root || process.cwd());
  const logToLedger = command !== 'dry-run';

  // Resource overrides
  let resourceOverrides;
  if (flags.maxConcurrent || flags.memory) {
    try {
      resourceOverrides = containerConfig().resolveConfig(cwd);
    } catch {
      resourceOverrides = null;
    }
    if (resourceOverrides) {
      if (flags.maxConcurrent) resourceOverrides.max_concurrent = flags.maxConcurrent;
      if (flags.memory) {
        resourceOverrides.max_memory_per_container = containerConfig().parseMemoryString(flags.memory);
        resourceOverrides.max_memory_per_container_str = flags.memory;
      }
    }
  }

  if (command === 'plan' || command === 'dry-run') {
    if (!target) {
      console.error('Error: plan directory or file path required');
      process.exit(1);
    }

    const targetPath = path.resolve(target);

    // Load factory results
    let factoryResults;
    if (targetPath.endsWith('.json')) {
      // Load pre-built factory results from JSON
      factoryResults = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      if (!Array.isArray(factoryResults)) factoryResults = [factoryResults];
    } else {
      // Build factory results from plan directory
      const factory = require('./factory');
      const planDir = targetPath;
      if (!fs.existsSync(planDir)) {
        console.error(`Error: directory not found: ${planDir}`);
        process.exit(1);
      }

      const planFiles = fs.readdirSync(planDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .map(f => path.join(planDir, f));

      if (planFiles.length === 0) {
        console.error('No .md plan files found in directory');
        process.exit(1);
      }

      factoryResults = factory.buildAll(planFiles, cwd);
    }

    const plan = planExecution(factoryResults, cwd, {
      resources: resourceOverrides,
      logToLedger,
    });

    if (flags.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else if (flags.table) {
      console.log(formatTable(plan));
    } else {
      console.log(formatPlan(plan));
    }

  } else if (command === 'plan-configs') {
    if (!target) {
      console.error('Error: JSON file path required');
      process.exit(1);
    }

    const configPath = path.resolve(target);
    const factoryResults = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const plan = planExecution(
      Array.isArray(factoryResults) ? factoryResults : [factoryResults],
      cwd,
      { resources: resourceOverrides, logToLedger }
    );

    if (flags.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else if (flags.table) {
      console.log(formatTable(plan));
    } else {
      console.log(formatPlan(plan));
    }

  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Core pipeline
  buildDAG,
  topoSortWaves,
  splitWavesForResources,
  planExecution,

  // Display
  formatPlan,
  formatTable,

  // Internals (for testing)
  buildWaveObject,
  logPlanToLedger,

  // Constants
  ARCHETYPE_TIME_ESTIMATES,
};

// Run CLI if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
