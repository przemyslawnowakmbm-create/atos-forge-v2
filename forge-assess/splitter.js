#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Dependencies
// ============================================================

const assessorPath = path.join(__dirname, 'assessor');
const { parsePlan, estimateTokens, estimateFileTokens, classifyFile, buildDependencyOrder,
        loadForgeConfig, USABLE_CONTEXT, OVERHEAD_PER_SUBTASK, MIN_ACTION_BUDGET } = require(assessorPath);

// ============================================================
// Constants
// ============================================================

const CONCERN_ORDER = ['schema', 'migration', 'implementation', 'test', 'config'];
const INTERFACE_PATTERNS = /\.(types?|schema|interfaces?|models?|d)\.(ts|js)$|\.graphql$|\.proto$/;
const BUDGET_ALLOCATION = {
  files: 0.50,          // 50% of budget for file contents
  graph_context: 0.15,  // 15% for graph context
  session_context: 0.05, // 5% for ledger entries
  action: 0.25,         // 25% for agent thinking + action
  overhead: 0.05,       // 5% system prompt overhead
};

// ============================================================
// Graph Integration
// ============================================================

function getGraphQuery(cwd) {
  try {
    const graphDir = path.join(path.dirname(__dirname), 'forge-graph');
    const { GraphQuery } = require(path.join(graphDir, 'query'));
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    if (!fs.existsSync(dbPath)) return null;
    const gq = new GraphQuery(dbPath);
    gq.open();
    return gq;
  } catch { return null; }
}

function safeClose(gq) {
  try { if (gq) gq.close(); } catch { /* ignore */ }
}

/**
 * Get dependency edges between files (within the given set).
 * Returns adjacency map: file → [files it imports from the set]
 */
function getInternalDependencies(gq, files) {
  const fileSet = new Set(files);
  const deps = new Map();
  for (const f of files) {
    deps.set(f, []);
    try {
      const imports = gq.importsOf(f);
      for (const imp of imports) {
        if (fileSet.has(imp.target_file)) {
          deps.get(f).push(imp.target_file);
        }
      }
    } catch { /* file may not be in graph */ }
  }
  return deps;
}

/**
 * Get consumers of a file from the graph.
 */
function getFileConsumers(gq, filePath) {
  try {
    const result = gq.getConsumers(filePath);
    return result.consumers || [];
  } catch { return []; }
}

/**
 * Get the module a file belongs to.
 */
function getFileModule(gq, filePath) {
  try {
    const row = gq.db.prepare('SELECT module FROM files WHERE path = ?').get(filePath);
    return row ? row.module : null;
  } catch { return null; }
}

/**
 * Check if a file exports interfaces consumed by other files in the plan.
 */
function isInterfaceProducer(gq, filePath, allPlanFiles) {
  const consumers = getFileConsumers(gq, filePath);
  const planSet = new Set(allPlanFiles);
  return consumers.some(c => planSet.has(c.source_file));
}

// ============================================================
// Ledger Integration
// ============================================================

function getLedger(cwd) {
  try {
    const sessionDir = path.join(path.dirname(__dirname), 'forge-session');
    return require(path.join(sessionDir, 'ledger'));
  } catch { return null; }
}

/**
 * Infer which session_context entries a sub-plan's agent should load.
 * Returns structured instructions (not the data itself — agents load at runtime).
 */
function inferSessionContext(files, modules, cwd) {
  const instructions = [];
  const ledger = getLedger(cwd);

  // Always load user preferences
  instructions.push('Load: user preferences from .forge/session/ledger.md');

  if (!ledger) return instructions;

  try {
    const state = ledger.readState(cwd);
    if (!state.exists) return instructions;

    // Load decisions relevant to current phase
    if (state.decision_count > 0) {
      instructions.push('Load: decisions from ledger relevant to target files');
    }

    // Load warnings — especially if they mention target modules
    if (state.warning_count > 0) {
      instructions.push(`Load: ${state.warning_count} warning(s) from ledger — check for relevance to ${modules.join(', ') || 'target modules'}`);
    }

    // Load rejected approaches to avoid repeating mistakes
    const content = ledger.read(cwd);
    if (content && content.includes('## Rejected Approaches') && !content.includes('## Rejected Approaches\n\n## ')) {
      instructions.push('Load: rejected approaches — do not retry these');
    }
  } catch { /* degrade gracefully */ }

  return instructions;
}

// ============================================================
// Graph Context Inference
// ============================================================

/**
 * Determine what graph data an agent should load for its sub-plan files.
 */
function inferGraphContext(gq, files, allPlanFiles) {
  const instructions = [];

  if (!gq) {
    instructions.push('Graph not available — rely on file contents and plan context');
    return instructions;
  }

  const modules = new Set();
  const hasExports = [];

  for (const f of files) {
    const mod = getFileModule(gq, f);
    if (mod) modules.add(mod);

    // Check if file has exports consumed by files outside this sub-plan
    try {
      const consumers = getFileConsumers(gq, f);
      const outsideConsumers = consumers.filter(c => !files.includes(c.source_file));
      if (outsideConsumers.length > 0) {
        hasExports.push({ file: f, consumerCount: outsideConsumers.length });
      }
    } catch { /* ignore */ }
  }

  // Module public API — if touching module internals, load the public surface
  for (const mod of modules) {
    if (mod !== '<root>' && mod !== '<unknown>') {
      instructions.push(`Load: module public API for ${mod}`);
    }
  }

  // Consumer lists for interface files
  for (const { file, consumerCount } of hasExports) {
    instructions.push(`Load: consumers of ${path.basename(file)} (${consumerCount} consumer(s) — list only, not full files)`);
  }

  // Cross-module dependency info
  if (modules.size > 1) {
    instructions.push(`Load: module dependency graph for ${[...modules].join(', ')}`);
  }

  // If modifying interfaces, load the interface table
  const interfaceFiles = files.filter(f => INTERFACE_PATTERNS.test(f));
  if (interfaceFiles.length > 0) {
    instructions.push(`Load: interface contracts for ${interfaceFiles.map(f => path.basename(f)).join(', ')} — verify no breaking changes`);
  }

  if (instructions.length === 0) {
    instructions.push('Load: basic file metadata from graph (LOC, complexity, module)');
  }

  return instructions;
}

// ============================================================
// Topological Sort
// ============================================================

/**
 * Topological sort of sub-plan groups based on inter-group dependencies.
 * Returns sorted groups with depends_on fields populated.
 */
function topoSortGroups(groups, gq, allPlanFiles) {
  if (!gq || groups.length <= 1) return groups;

  // Build group adjacency: group A depends on group B if any file in A imports from B
  const groupFiles = groups.map(g => new Set(g.files));
  const adjacency = new Map(); // groupIndex → Set of groupIndices it depends on

  for (let i = 0; i < groups.length; i++) {
    adjacency.set(i, new Set());
    for (const f of groups[i].files) {
      try {
        const imports = gq.importsOf(f);
        for (const imp of imports) {
          for (let j = 0; j < groups.length; j++) {
            if (j !== i && groupFiles[j].has(imp.target_file)) {
              adjacency.get(i).add(j);
            }
          }
        }
      } catch { /* file not in graph */ }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map();
  for (let i = 0; i < groups.length; i++) inDegree.set(i, 0);
  for (const [, deps] of adjacency) {
    for (const d of deps) inDegree.set(d, (inDegree.get(d) || 0) + 1);
  }

  const queue = [];
  for (let i = 0; i < groups.length; i++) {
    if (inDegree.get(i) === 0) queue.push(i);
  }

  const sorted = [];
  while (queue.length > 0) {
    const idx = queue.shift();
    sorted.push(idx);
    for (const dep of (adjacency.get(idx) || new Set())) {
      const newDeg = inDegree.get(dep) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  // Add remaining (cycles) at end
  for (let i = 0; i < groups.length; i++) {
    if (!sorted.includes(i)) sorted.push(i);
  }

  // Reorder groups and set depends_on
  const result = sorted.map((origIdx, newIdx) => {
    const group = { ...groups[origIdx] };
    const deps = adjacency.get(origIdx) || new Set();
    // Map original dependency indices to new indices
    group._depends_on_indices = [...deps].map(d => sorted.indexOf(d)).filter(d => d >= 0 && d < newIdx);
    return group;
  });

  return result;
}

/**
 * Detect groups that have no dependencies on each other → parallelizable.
 */
function detectParallelizable(groups) {
  const parallel = [];
  const noDeps = groups.filter((g, i) => !g._depends_on_indices || g._depends_on_indices.length === 0);
  if (noDeps.length > 1) {
    parallel.push(noDeps.map((_, i) => i));
  }
  return parallel;
}

// ============================================================
// Split Strategies
// ============================================================

/**
 * CONNECTED_COMPONENT SPLIT: Use code graph edges (imports + consumers)
 * to discover connected components among plan files. If the file set
 * decomposes into 2+ disjoint sub-graphs, each component becomes one group.
 * Returns null when the graph is unavailable or all files are connected.
 */
function splitByConnectedComponents(plan, recommendation, cwd) {
  const gq = getGraphQuery(cwd);
  if (!gq) return null;

  try {
    const files = plan.all_files;
    if (files.length <= 1) return null;

    const fileSet = new Set(files);
    const adjacency = new Map();

    for (const f of files) {
      const neighbors = new Set();
      // Forward edges: files this file imports
      try {
        const imports = gq.importsOf(f);
        for (const imp of imports) {
          const p = imp.target_file || imp;
          if (fileSet.has(p)) neighbors.add(p);
        }
      } catch { /* file may not be in graph */ }
      // Reverse edges: files that consume this file
      try {
        const result = gq.getConsumers(f);
        const consumers = result.consumers || [];
        for (const c of consumers) {
          const p = c.source_file || c;
          if (fileSet.has(p)) neighbors.add(p);
        }
      } catch { /* ignore */ }
      adjacency.set(f, neighbors);
    }

    // BFS to discover connected components
    const visited = new Set();
    const components = [];
    for (const f of files) {
      if (visited.has(f)) continue;
      const component = [];
      const queue = [f];
      while (queue.length > 0) {
        const node = queue.shift();
        if (visited.has(node)) continue;
        visited.add(node);
        component.push(node);
        for (const neighbor of (adjacency.get(node) || new Set())) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      if (component.length > 0) components.push(component);
    }

    // Only useful when there are multiple disjoint components
    if (components.length <= 1) return null;

    // Build groups from components, reusing module/concern metadata
    const groups = components.map((comp, idx) => {
      const modules = new Set();
      const concerns = new Set();
      let hasInterface = false;
      for (const f of comp) {
        const mod = getFileModule(gq, f);
        if (mod) modules.add(mod);
        concerns.add(classifyFile(f));
        if (INTERFACE_PATTERNS.test(f)) hasInterface = true;
        if (!hasInterface) hasInterface = isInterfaceProducer(gq, f, plan.all_files);
      }

      const modLabel = modules.size > 0
        ? [...modules].filter(m => m !== '<root>' && m !== '<unknown>').join('+') || `component-${idx + 1}`
        : `component-${idx + 1}`;

      return {
        label: `cc:${modLabel}`,
        files: comp,
        module: modules.size === 1 ? [...modules][0] : null,
        concern: concerns.size === 1 ? [...concerns][0] : 'implementation',
        is_interface_producer: hasInterface,
      };
    });

    // Sort: interface producers first, then topological
    groups.sort((a, b) => (b.is_interface_producer ? 1 : 0) - (a.is_interface_producer ? 1 : 0));
    return topoSortGroups(groups, gq, plan.all_files);
  } catch { return null; }
  finally { safeClose(gq); }
}

/**
 * MODULE SPLIT: Group files by module boundaries.
 * Interface-producing modules come first. Consumer modules after.
 */
function splitByModule(plan, recommendation, cwd) {
  const gq = getGraphQuery(cwd);
  const groups = [];

  try {
    const moduleGroups = {};
    for (const fg of recommendation.file_groups) {
      if (fg.module) {
        if (!moduleGroups[fg.module]) moduleGroups[fg.module] = [];
        moduleGroups[fg.module].push(...fg.files);
      }
    }

    // Fallback: group by directory prefix if no module data
    if (Object.keys(moduleGroups).length === 0) {
      for (const f of plan.all_files) {
        const dir = path.dirname(f).split('/').slice(0, 2).join('/') || '<root>';
        if (!moduleGroups[dir]) moduleGroups[dir] = [];
        moduleGroups[dir].push(f);
      }
    }

    // Within each module: interfaces first, then implementations
    for (const [mod, files] of Object.entries(moduleGroups)) {
      const interfaces = files.filter(f => INTERFACE_PATTERNS.test(f));
      const nonInterfaces = files.filter(f => !INTERFACE_PATTERNS.test(f));

      // If module has both, create 2 groups (interface → consumer)
      if (interfaces.length > 0 && nonInterfaces.length > 0) {
        groups.push({
          label: `${mod} — interfaces`,
          files: interfaces,
          module: mod,
          concern: 'schema',
          is_interface_producer: true,
        });
        groups.push({
          label: `${mod} — implementation`,
          files: nonInterfaces,
          module: mod,
          concern: 'implementation',
          is_interface_producer: false,
        });
      } else {
        const isInterface = interfaces.length > 0;
        groups.push({
          label: mod,
          files,
          module: mod,
          concern: isInterface ? 'schema' : 'implementation',
          is_interface_producer: isInterface || (gq ? files.some(f => isInterfaceProducer(gq, f, plan.all_files)) : false),
        });
      }
    }

    // Sort: interface producers first
    groups.sort((a, b) => (b.is_interface_producer ? 1 : 0) - (a.is_interface_producer ? 1 : 0));

    // Topological sort for correct dependency ordering
    const sorted = topoSortGroups(groups, gq, plan.all_files);
    return sorted;
  } finally {
    safeClose(gq);
  }
}

/**
 * CONCERN SPLIT: Schema/types → implementation → tests → config.
 * Schema always goes first to establish contracts.
 */
function splitByConcern(plan, recommendation, cwd) {
  const gq = getGraphQuery(cwd);

  try {
    const concernBuckets = {};
    for (const f of plan.all_files) {
      const concern = classifyFile(f);
      if (!concernBuckets[concern]) concernBuckets[concern] = [];
      concernBuckets[concern].push(f);
    }

    const groups = [];
    for (const concern of CONCERN_ORDER) {
      const files = concernBuckets[concern];
      if (!files || files.length === 0) continue;

      // Within each concern, order by dependency
      const ordered = gq ? buildDependencyOrder(files, cwd) : files;

      groups.push({
        label: concern,
        files: ordered,
        module: null,
        concern,
        is_interface_producer: concern === 'schema',
      });
    }

    // Schema always first — explicit dependency
    const sorted = topoSortGroups(groups, gq, plan.all_files);
    return sorted;
  } finally {
    safeClose(gq);
  }
}

/**
 * FILE SPLIT: Split within large files by symbol sections.
 * Riskiest strategy — adds verification between sub-plans.
 */
function splitByFile(plan, recommendation, cwd) {
  const gq = getGraphQuery(cwd);

  try {
    const groups = [];

    for (const f of plan.all_files) {
      // Try to get symbols for logical sections
      let symbols = [];
      if (gq) {
        try { symbols = gq.symbolsInFile(f); } catch { /* not in graph */ }
      }

      if (symbols.length > 30) {
        // Split into logical sections by exported vs internal, or by kind
        const exported = symbols.filter(s => s.exported);
        const internal = symbols.filter(s => !s.exported);

        if (exported.length > 0 && internal.length > 0) {
          groups.push({
            label: `${path.basename(f)} — exports (${exported.length} symbols)`,
            files: [f],
            module: getFileModule(gq, f),
            concern: 'schema',
            is_interface_producer: true,
            symbol_scope: {
              type: 'exported',
              symbols: exported.map(s => s.name),
              line_range: [Math.min(...exported.map(s => s.line_start)), Math.max(...exported.map(s => s.line_end || s.line_start))],
            },
            needs_verification: true,
          });
          groups.push({
            label: `${path.basename(f)} — internals (${internal.length} symbols)`,
            files: [f],
            module: getFileModule(gq, f),
            concern: 'implementation',
            is_interface_producer: false,
            symbol_scope: {
              type: 'internal',
              symbols: internal.map(s => s.name),
              line_range: [Math.min(...internal.map(s => s.line_start)), Math.max(...internal.map(s => s.line_end || s.line_start))],
            },
            needs_verification: true,
          });
        } else {
          // Split by blocks of ~25 symbols
          const chunkSize = 25;
          for (let i = 0; i < symbols.length; i += chunkSize) {
            const chunk = symbols.slice(i, i + chunkSize);
            groups.push({
              label: `${path.basename(f)} — section ${Math.floor(i / chunkSize) + 1}`,
              files: [f],
              module: getFileModule(gq, f),
              concern: 'implementation',
              is_interface_producer: false,
              symbol_scope: {
                type: 'range',
                symbols: chunk.map(s => s.name),
                line_range: [chunk[0].line_start, chunk[chunk.length - 1].line_end || chunk[chunk.length - 1].line_start],
              },
              needs_verification: true,
            });
          }
        }
      } else {
        // File is small enough to keep as one group
        groups.push({
          label: path.basename(f),
          files: [f],
          module: gq ? getFileModule(gq, f) : null,
          concern: classifyFile(f),
          is_interface_producer: INTERFACE_PATTERNS.test(f),
        });
      }
    }

    const sorted = topoSortGroups(groups, gq, plan.all_files);
    return sorted;
  } finally {
    safeClose(gq);
  }
}

// ============================================================
// Context Budget Calculation
// ============================================================

/**
 * Calculate token budget for a sub-plan based on its files and context needs.
 */
function calculateBudget(group, totalBudget) {
  const fileBudget = Math.floor(totalBudget * BUDGET_ALLOCATION.files);
  const graphBudget = Math.floor(totalBudget * BUDGET_ALLOCATION.graph_context);
  const sessionBudget = Math.floor(totalBudget * BUDGET_ALLOCATION.session_context);
  const actionBudget = Math.floor(totalBudget * BUDGET_ALLOCATION.action);
  const overhead = Math.floor(totalBudget * BUDGET_ALLOCATION.overhead);

  return {
    total: totalBudget,
    files: fileBudget,
    graph_context: graphBudget,
    session_context: sessionBudget,
    action: actionBudget,
    overhead,
  };
}

// ============================================================
// Sub-Plan Builder
// ============================================================

/**
 * Extract a meaningful name for a sub-task from the plan and group.
 */
function deriveSubtaskName(plan, group, index) {
  const objective = plan.objective || plan.tasks[0]?.done || 'Implement changes';

  if (group.concern === 'schema') {
    return `Update types/interfaces: ${objective}`;
  }
  if (group.concern === 'test') {
    return `Update tests: ${objective}`;
  }
  if (group.concern === 'config') {
    return `Update configuration: ${objective}`;
  }
  if (group.module && group.module !== '<root>' && group.module !== '<unknown>') {
    return `${group.label}: ${objective}`;
  }
  if (group.symbol_scope) {
    return `${group.label}: ${objective}`;
  }
  return `Part ${index + 1}: ${objective}`;
}

/**
 * Extract the relevant action text for a file group from the plan's tasks.
 */
function extractAction(plan, group) {
  const groupFileSet = new Set(group.files);
  const relevantTasks = plan.tasks.filter(t => t.files.some(f => groupFileSet.has(f)));

  if (relevantTasks.length > 0) {
    return relevantTasks.map(t => t.action).join('\n\n');
  }

  // Fallback: the whole plan action, annotated with scope
  if (plan.tasks.length > 0) {
    const scope = group.symbol_scope
      ? `Focus on ${group.symbol_scope.type} symbols (lines ${group.symbol_scope.line_range.join('-')})`
      : `Focus on: ${group.files.join(', ')}`;
    return `${scope}\n\n${plan.tasks[0].action}`;
  }

  return `Implement changes for: ${group.files.join(', ')}`;
}

/**
 * Extract verification criteria for a sub-plan.
 */
function extractVerify(plan, group) {
  const base = [];

  // Get verify from matching tasks
  const groupFileSet = new Set(group.files);
  const relevantTasks = plan.tasks.filter(t => t.files.some(f => groupFileSet.has(f)));
  for (const t of relevantTasks) {
    if (t.verify) base.push(t.verify);
  }

  // Add file-split verification
  if (group.needs_verification) {
    base.push('Run full build to verify no regressions from partial file edit');
    base.push('Verify exported symbols still match expected signatures');
  }

  // Default
  if (base.length === 0) {
    base.push('Code compiles without errors');
    base.push('Existing tests pass');
  }

  return base.join('\n');
}

/**
 * Extract done criteria.
 */
function extractDone(plan, group) {
  const groupFileSet = new Set(group.files);
  const relevantTasks = plan.tasks.filter(t => t.files.some(f => groupFileSet.has(f)));
  if (relevantTasks.length > 0) {
    return relevantTasks.map(t => t.done).filter(Boolean).join('; ');
  }
  return plan.tasks[0]?.done || 'Changes implemented and verified';
}

/**
 * Build a single sub-plan in the output format.
 */
function buildSubPlan(group, plan, index, total, dependsOn, cwd, contextBudget) {
  const gq = getGraphQuery(cwd);

  try {
    const modules = [...new Set(group.files.map(f => gq ? getFileModule(gq, f) : null).filter(Boolean))];
    const graphContext = inferGraphContext(gq, group.files, plan.all_files);
    const sessionContext = inferSessionContext(group.files, modules, cwd);
    const budget = calculateBudget(group, contextBudget || USABLE_CONTEXT);
    const parentPlan = path.basename(plan.path, '.md');

    return {
      type: 'auto',
      parent_plan: parentPlan,
      subtask: `${index + 1}/${total}`,
      depends_on: dependsOn,
      name: deriveSubtaskName(plan, group, index),
      context_budget: budget.total,
      files: group.files,
      graph_context: graphContext,
      session_context: sessionContext,
      action: extractAction(plan, group),
      verify: extractVerify(plan, group),
      done: extractDone(plan, group),
      // Metadata for downstream consumers
      _meta: {
        strategy_label: group.label,
        module: group.module,
        concern: group.concern,
        is_interface_producer: group.is_interface_producer || false,
        needs_verification: group.needs_verification || false,
        symbol_scope: group.symbol_scope || null,
        budget_breakdown: budget,
        parallelizable: !dependsOn || dependsOn.length === 0,
      },
    };
  } finally {
    safeClose(gq);
  }
}

// ============================================================
// Output Formatting
// ============================================================

function formatSubPlanXML(subPlan) {
  const dependsStr = Array.isArray(subPlan.depends_on) ? subPlan.depends_on.join(', ') : (subPlan.depends_on || '');
  const filesStr = subPlan.files.join(', ');
  const graphLines = subPlan.graph_context.map(l => `    - ${l}`).join('\n');
  const sessionLines = subPlan.session_context.map(l => `    - ${l}`).join('\n');

  return `<task type="${subPlan.type}" parent_plan="${subPlan.parent_plan}" subtask="${subPlan.subtask}" depends_on="${dependsStr}">
  <n>${subPlan.name}</n>
  <context_budget>${subPlan.context_budget} tokens</context_budget>
  <files>${filesStr}</files>
  <graph_context>
${graphLines}
  </graph_context>
  <session_context>
${sessionLines}
  </session_context>
  <action>${subPlan.action}</action>
  <verify>${subPlan.verify}</verify>
  <done>${subPlan.done}</done>
</task>`;
}

function formatSubPlanJSON(subPlan) {
  return {
    type: subPlan.type,
    parent_plan: subPlan.parent_plan,
    subtask: subPlan.subtask,
    depends_on: subPlan.depends_on,
    name: subPlan.name,
    context_budget: subPlan.context_budget,
    files: subPlan.files,
    graph_context: subPlan.graph_context,
    session_context: subPlan.session_context,
    action: subPlan.action,
    verify: subPlan.verify,
    done: subPlan.done,
    meta: subPlan._meta,
  };
}

// ============================================================
// Cascading Split — Subdivide Oversized Groups
// ============================================================

/**
 * Estimate total tokens a group would consume in context.
 */
function estimateGroupTokens(group, cwd) {
  let tokens = 0;
  for (const f of group.files) {
    const absPath = path.isAbsolute(f) ? f : path.join(cwd, f);
    tokens += estimateFileTokens(absPath);
  }
  tokens += group.files.length * 1500; // graph context per file
  tokens += OVERHEAD_PER_SUBTASK;
  return tokens;
}

/**
 * Subdivide an oversized group into smaller groups that fit in context.
 * Cascade: multi-file group → individual files → symbol-level (via splitByFile).
 */
function subdivideGroup(group, plan, recommendation, cwd, usableContext) {
  // Single file: try symbol-level split via splitByFile
  if (group.files.length <= 1) {
    const miniPlan = { ...plan, all_files: group.files };
    const miniRec = { ...recommendation, file_groups: [group] };
    const symbolGroups = splitByFile(miniPlan, miniRec, cwd);
    // If splitByFile produced multiple groups, use them; otherwise keep as-is with warning
    if (symbolGroups.length > 1) return symbolGroups;
    group._overflow_warning = `Single file ${group.files[0]} exceeds context budget — cannot subdivide further`;
    return [group];
  }

  // Multiple files: split each file into its own group
  const fileGroups = group.files.map(f => ({
    label: path.basename(f),
    files: [f],
    module: group.module,
    concern: group.concern || classifyFile(f),
    is_interface_producer: INTERFACE_PATTERNS.test(f),
  }));

  // Check each individual file group
  const result = [];
  for (const fg of fileGroups) {
    const tokens = estimateGroupTokens(fg, cwd);
    if (tokens <= usableContext) {
      result.push(fg);
    } else {
      // Single file still too large: symbol-level split via splitByFile
      const miniPlan = { ...plan, all_files: fg.files };
      const miniRec = { ...recommendation, file_groups: [fg] };
      const symbolGroups = splitByFile(miniPlan, miniRec, cwd);
      if (symbolGroups.length > 1) {
        result.push(...symbolGroups);
      } else {
        fg._overflow_warning = `File ${fg.files[0]} exceeds context budget — at minimum granularity`;
        result.push(fg);
      }
    }
  }

  return result;
}

// ============================================================
// Main Split Function
// ============================================================

/**
 * Split a plan into sub-plans based on assessor recommendation.
 *
 * @param {object} plan - Parsed plan object (from assessor.parsePlan or assessor.assessPlan().plan)
 * @param {object} recommendation - Assessor's split recommendation (assessPlan() result with needs_split=true)
 * @param {string} cwd - Working directory (repo root)
 * @param {{ format?: 'xml'|'json' }} opts
 * @returns {{ sub_plans: object[], formatted: string[], summary: object }}
 */
function splitPlan(plan, recommendation, cwd, opts = {}) {
  const strategy = recommendation.strategy;
  const format = opts.format || 'xml';
  const config = loadForgeConfig(cwd);
  const usableContext = Math.floor(config.context_budget * (1 - config.safety_margin));

  // Select splitting strategy
  let groups;

  // Try graph-aware connected component split first (unless a specific strategy is requested)
  if (!strategy || strategy === 'connected_component') {
    const components = splitByConnectedComponents(plan, recommendation, cwd);
    if (components) {
      groups = components;
    }
  }

  if (!groups) {
    switch (strategy) {
      case 'module':
        groups = splitByModule(plan, recommendation, cwd);
        break;
      case 'concern':
        groups = splitByConcern(plan, recommendation, cwd);
        break;
      case 'file':
        groups = splitByFile(plan, recommendation, cwd);
        break;
      case 'connected_component':
        // Already tried above and returned null — fall through to module
        groups = splitByModule(plan, recommendation, cwd);
        break;
      default:
        groups = splitByConcern(plan, recommendation, cwd);
    }
  }

  // Cascading split: subdivide groups that still exceed context budget
  let cascaded = false;
  const finalGroups = [];
  for (const group of groups) {
    const tokens = estimateGroupTokens(group, cwd);
    if (tokens <= usableContext) {
      finalGroups.push(group);
    } else {
      cascaded = true;
      const subGroups = subdivideGroup(group, plan, recommendation, cwd, usableContext);
      finalGroups.push(...subGroups);
    }
  }

  // Re-sort after cascading to maintain correct dependency ordering
  if (cascaded) {
    const gq = getGraphQuery(cwd);
    try {
      groups = topoSortGroups(finalGroups, gq, plan.all_files);
    } finally {
      safeClose(gq);
    }
  } else {
    groups = finalGroups;
  }

  // Detect parallelizable groups
  const parallelSets = detectParallelizable(groups);

  // Build sub-plans
  const subPlans = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const dependsOnIndices = group._depends_on_indices || [];
    const dependsOn = dependsOnIndices.map(d => `${d + 1}/${groups.length}`);

    const subPlan = buildSubPlan(group, plan, i, groups.length, dependsOn, cwd, usableContext);

    // Mark parallelizable
    if (parallelSets.some(set => set.includes(i))) {
      subPlan._meta.parallelizable = true;
    }

    // Propagate overflow warnings
    if (group._overflow_warning) {
      subPlan._meta.overflow_warning = group._overflow_warning;
    }

    subPlans.push(subPlan);
  }

  // Format output
  const formatted = subPlans.map(sp => format === 'json' ? formatSubPlanJSON(sp) : formatSubPlanXML(sp));

  // Summary
  const summary = {
    strategy: cascaded ? `${strategy}+cascade` : strategy,
    reason: recommendation.reason + (cascaded ? ' (with cascading subdivision for oversized groups)' : ''),
    total_sub_plans: subPlans.length,
    parallelizable_count: subPlans.filter(sp => sp._meta.parallelizable).length,
    sequential_count: subPlans.filter(sp => !sp._meta.parallelizable).length,
    interface_first: subPlans.findIndex(sp => sp._meta.is_interface_producer) === 0,
    total_files: plan.all_files.length,
    budget_per_subtask: usableContext,
    estimated_tokens: recommendation.metrics.total_estimated,
    context_limit: recommendation.metrics.context_limit,
    cascaded,
    overflow_warnings: subPlans.filter(sp => sp._meta.overflow_warning).map(sp => sp._meta.overflow_warning),
    execution_order: subPlans.map((sp, i) => ({
      index: i + 1,
      name: sp.name,
      files: sp.files.length,
      depends_on: sp.depends_on,
      parallelizable: sp._meta.parallelizable,
    })),
  };

  return { sub_plans: subPlans, formatted, summary };
}

// ============================================================
// Convenience: Assess + Split in one call
// ============================================================

/**
 * End-to-end: assess a plan and split if needed.
 * @param {string} planPath
 * @param {string} cwd
 * @param {{ format?: 'xml'|'json', context_limit?: number }} opts
 * @returns {{ needs_split: boolean, assessment: object, result?: object }}
 */
function assessAndSplit(planPath, cwd, opts = {}) {
  const { assessPlan } = require(assessorPath);
  const assessment = assessPlan(planPath, cwd, opts);

  if (!assessment.needs_split) {
    return { needs_split: false, assessment, result: null };
  }

  const result = splitPlan(assessment.plan, assessment, cwd, opts);
  return { needs_split: true, assessment, result };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  splitPlan,
  assessAndSplit,
  splitByModule,
  splitByConcern,
  splitByFile,
  splitByConnectedComponents,
  topoSortGroups,
  detectParallelizable,
  inferGraphContext,
  inferSessionContext,
  formatSubPlanXML,
  formatSubPlanJSON,
  buildSubPlan,
  calculateBudget,
  estimateGroupTokens,
  subdivideGroup,
};

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
forge-assess/splitter.js — Split oversized plans into context-fitting sub-plans

Usage:
  node splitter.js <plan-file> [--root <cwd>] [--format xml|json] [--strategy module|concern|file]
  node splitter.js --test [--root <cwd>]

Options:
  --root <path>     Repository root (default: cwd)
  --format <fmt>    Output format: xml (default) or json
  --strategy <s>    Override split strategy: connected_component|module|concern|file (default: auto-detect)
  --test            Run built-in pipeline test
`);
    process.exit(0);
  }

  const cwd = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'xml';
  const forceStrategy = args.includes('--strategy') ? args[args.indexOf('--strategy') + 1] : null;

  // --test mode: create synthetic plan, run full pipeline
  if (args.includes('--test')) {
    console.log('=== SPLITTER PIPELINE TEST ===\n');

    // Create a synthetic large plan with real files on disk
    const testDir = path.join(cwd, '.forge', 'test-splitter');
    fs.mkdirSync(testDir, { recursive: true });

    // Generate a plan that would overflow context
    const syntheticFiles = [];
    const modules = ['auth', 'billing', 'api', 'database', 'frontend'];
    for (const mod of modules) {
      syntheticFiles.push(`src/${mod}/types.ts`);
      syntheticFiles.push(`src/${mod}/service.ts`);
      syntheticFiles.push(`src/${mod}/controller.ts`);
      syntheticFiles.push(`src/${mod}/service.test.ts`);
    }

    // Create synthetic source files on disk (~25KB each → ~6250 tokens each → 125k total)
    for (const f of syntheticFiles) {
      const absPath = path.join(cwd, f);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const kind = path.basename(f).split('.')[0];
      const mod = f.split('/')[1];
      // Generate realistic file content
      let content = `// ${mod}/${kind}.ts — Multi-tenant ${mod} ${kind}\n\n`;
      if (kind === 'types') {
        for (let i = 0; i < 80; i++) {
          content += `export interface ${mod.charAt(0).toUpperCase() + mod.slice(1)}Entity${i} {\n  id: string;\n  tenantId: string;\n  name: string;\n  createdAt: Date;\n  updatedAt: Date;\n  metadata: Record<string, unknown>;\n  status: 'active' | 'inactive' | 'pending';\n  config: {\n    enabled: boolean;\n    retryCount: number;\n    timeout: number;\n  };\n}\n\n`;
        }
      } else if (kind === 'service') {
        content += `import { ${mod.charAt(0).toUpperCase() + mod.slice(1)}Entity0 } from './types';\n\n`;
        for (let i = 0; i < 60; i++) {
          content += `export async function handle${mod}Operation${i}(tenantId: string, entity: ${mod.charAt(0).toUpperCase() + mod.slice(1)}Entity0): Promise<void> {\n  // Validate tenant scope\n  if (!tenantId) throw new Error('tenantId required');\n  // Process entity within tenant boundary\n  const scoped = { ...entity, tenantId };\n  await processInTenantScope(scoped);\n  // Log audit trail\n  await auditLog(tenantId, 'operation_${i}', entity.id);\n}\n\n`;
        }
      } else if (kind === 'controller') {
        content += `import { handle${mod}Operation0 } from './service';\n\n`;
        for (let i = 0; i < 50; i++) {
          content += `export function ${mod}Endpoint${i}(req: Request, res: Response) {\n  const tenantId = req.headers['x-tenant-id'] as string;\n  if (!tenantId) return res.status(403).json({ error: 'Missing tenant' });\n  return handle${mod}Operation0(tenantId, req.body)\n    .then(r => res.json(r))\n    .catch(e => res.status(500).json({ error: e.message }));\n}\n\n`;
        }
      } else { // test
        content += `import { handle${mod}Operation0 } from './service';\n\n`;
        for (let i = 0; i < 50; i++) {
          content += `describe('${mod} operation ${i}', () => {\n  it('should enforce tenant isolation', async () => {\n    const tenantA = 'tenant-a';\n    const tenantB = 'tenant-b';\n    await handle${mod}Operation0(tenantA, mockEntity);\n    const result = await query(tenantB);\n    expect(result).toHaveLength(0);\n  });\n\n  it('should reject missing tenantId', async () => {\n    await expect(handle${mod}Operation0('', mockEntity)).rejects.toThrow();\n  });\n});\n\n`;
        }
      }
      fs.writeFileSync(absPath, content);
    }

    const syntheticPlan = `---
wave: 1
depends_on: []
files_modified:
${syntheticFiles.map(f => `  - ${f}`).join('\n')}
autonomous: true
---

## Objective
Add multi-tenant support across all modules. Each module needs tenantId threading through interfaces, services, controllers, and tests.

<task>
<files>
${syntheticFiles.filter(f => f.includes('types')).join('\n')}
</files>

<action>
Add tenantId: string to all entity interfaces and request types.
Update type exports to include TenantContext.
${'This requires careful coordination across module boundaries. '.repeat(200)}
</action>

<verify>
TypeScript compiles without errors.
All existing tests pass.
</verify>

<done>
All type definitions include tenantId field.
</done>
</task>

<task>
<files>
${syntheticFiles.filter(f => f.includes('service')).join('\n')}
</files>

<action>
Thread tenantId through all service methods.
Add tenant isolation to database queries.
${'Ensure proper scoping of all queries to tenant boundary. '.repeat(200)}
</action>

<verify>
Services correctly filter by tenantId.
No cross-tenant data leakage.
</verify>

<done>
All services enforce tenant isolation.
</done>
</task>

<task>
<files>
${syntheticFiles.filter(f => f.includes('controller')).join('\n')}
</files>

<action>
Extract tenantId from JWT claims in middleware.
Pass through to service layer.
${'Controllers must validate tenant access on every request. '.repeat(200)}
</action>

<verify>
Controllers reject requests without valid tenantId.
</verify>

<done>
All controllers enforce tenant-scoped access.
</done>
</task>

<task>
<files>
${syntheticFiles.filter(f => f.includes('test')).join('\n')}
</files>

<action>
Update all tests to include tenantId fixtures.
Add cross-tenant isolation tests.
${'Each test case must verify tenant boundaries are respected. '.repeat(200)}
</action>

<verify>
All tests pass with tenant fixtures.
</verify>

<done>
Test suite covers multi-tenant scenarios.
</done>
</task>

## Success Criteria
- [ ] All modules support multi-tenancy
- [ ] No cross-tenant data access possible
- [ ] All tests updated and passing
`;

    const testPlanPath = path.join(testDir, 'test-plan.md');
    fs.writeFileSync(testPlanPath, syntheticPlan);
    console.log(`Created synthetic plan: ${testPlanPath}`);
    console.log(`Plan size: ${syntheticPlan.length} chars (~${estimateTokens(syntheticPlan)} tokens)\n`);

    // Step 1: Assess
    const { assessPlan } = require(assessorPath);
    const assessment = assessPlan(testPlanPath, cwd);
    console.log(`--- ASSESSOR ---`);
    console.log(`Needs split: ${assessment.needs_split}`);
    if (assessment.needs_split) {
      console.log(`Strategy: ${assessment.strategy}`);
      console.log(`Reason: ${assessment.reason}`);
      console.log(`Overflow: ${assessment.metrics.overflow_ratio.toFixed(2)}x`);
      console.log(`Total tokens: ${assessment.metrics.total_estimated}`);
      console.log(`Context limit: ${assessment.metrics.context_limit}`);
      console.log(`Suggested splits: ${assessment.suggested_subtask_count}`);
      console.log(`File groups: ${assessment.file_groups.length}`);

      // Step 2: Split
      if (forceStrategy) assessment.strategy = forceStrategy;
      const result = splitPlan(assessment.plan, assessment, cwd, { format });
      console.log(`\n--- SPLITTER ---`);
      console.log(`Strategy used: ${result.summary.strategy}`);
      console.log(`Sub-plans: ${result.summary.total_sub_plans}`);
      console.log(`Parallelizable: ${result.summary.parallelizable_count}`);
      console.log(`Sequential: ${result.summary.sequential_count}`);
      console.log(`Interface-first: ${result.summary.interface_first}`);

      console.log(`\n--- EXECUTION ORDER ---`);
      for (const step of result.summary.execution_order) {
        const deps = step.depends_on.length > 0 ? ` (after ${step.depends_on.join(', ')})` : ' (independent)';
        const par = step.parallelizable ? ' [parallelizable]' : '';
        console.log(`  ${step.index}. ${step.name} — ${step.files} file(s)${deps}${par}`);
      }

      console.log(`\n--- SUB-PLANS ---\n`);
      for (const sp of result.formatted) {
        if (format === 'json') {
          console.log(JSON.stringify(sp, null, 2));
        } else {
          console.log(sp);
        }
        console.log('');
      }

      // Step 3: Validate
      console.log(`--- VALIDATION ---`);
      let allFit = true;
      for (const sp of result.sub_plans) {
        const fits = sp.context_budget <= USABLE_CONTEXT;
        if (!fits) allFit = false;
        console.log(`  ${sp.subtask}: budget=${sp.context_budget} ${fits ? '✓' : '✗ OVERFLOW'}`);
      }
      console.log(`\n  All fit in context: ${allFit ? 'YES ✓' : 'NO ✗'}`);

      // Check all files covered
      const coveredFiles = new Set();
      for (const sp of result.sub_plans) {
        for (const f of sp.files) coveredFiles.add(f);
      }
      const allCovered = assessment.plan.all_files.every(f => coveredFiles.has(f));
      console.log(`  All files covered: ${allCovered ? 'YES ✓' : 'NO ✗'}`);

      // Check dependency ordering
      let depsCorrect = true;
      for (let i = 0; i < result.sub_plans.length; i++) {
        const sp = result.sub_plans[i];
        for (const dep of sp.depends_on) {
          const depIdx = parseInt(dep.split('/')[0]) - 1;
          if (depIdx >= i) {
            depsCorrect = false;
            console.log(`  ✗ Sub-plan ${i + 1} depends on ${dep} which comes after it`);
          }
        }
      }
      console.log(`  Dependency ordering: ${depsCorrect ? 'CORRECT ✓' : 'INVALID ✗'}`);

      console.log(`\n=== PIPELINE TEST ${allFit && allCovered && depsCorrect ? 'PASSED ✓' : 'FAILED ✗'} ===`);
    } else {
      console.log(`Plan fits in context — no split needed.`);
      console.log(`Total: ${assessment.metrics.total_estimated} / ${assessment.metrics.context_limit}`);
    }

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
    // Remove synthetic source files
    const srcDir = path.join(cwd, 'src');
    if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
    process.exit(0);
  }

  // Normal mode: assess and split a real plan
  const planPath = args.find(a => !a.startsWith('-'));
  if (!planPath) {
    console.error('Error: provide a plan file path');
    process.exit(1);
  }

  const { needs_split, assessment, result } = assessAndSplit(planPath, cwd, { format });

  if (!needs_split) {
    console.log(`Plan fits in context (${assessment.metrics.total_estimated}/${assessment.metrics.context_limit} tokens). No split needed.`);
    process.exit(0);
  }

  console.log(`Split: ${result.summary.strategy} → ${result.summary.total_sub_plans} sub-plans\n`);
  for (const sp of result.formatted) {
    if (format === 'json') {
      console.log(JSON.stringify(sp, null, 2));
    } else {
      console.log(sp);
    }
    console.log('');
  }
}
