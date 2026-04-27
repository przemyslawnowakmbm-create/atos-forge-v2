#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Constants
// ============================================================

const CHARS_PER_TOKEN = 4;
const CONTEXT_LIMIT = 128000;       // Claude context window
const SAFETY_MARGIN = 0.20;         // Reserve for system prompt, tool results, etc.
const USABLE_CONTEXT = Math.floor(CONTEXT_LIMIT * (1 - SAFETY_MARGIN)); // ~102400
const OVERHEAD_PER_SUBTASK = 5000;  // System prompt, formatting per sub-plan
const MIN_ACTION_BUDGET = 15000;    // Minimum tokens for the agent to think + act

// Thresholds for split strategy selection
const MODULE_SPLIT_MIN_MODULES = 2;     // Need ≥2 modules to split by module
const FILE_SPLIT_MIN_SYMBOLS = 50;      // Large file threshold for symbol-level split
const CONCERN_TYPE_PATTERNS = {
  schema:   /\.(types?|schema|interfaces?|models?|d)\.(ts|tsx|js|jsx|cjs|mjs|py|go|java)$|\.graphql$|\.proto$|\/(types?|schema|interfaces?|models?)\.(ts|tsx|js|jsx|cjs|mjs|py|go|java)$/,
  test:     /\.(test|spec|_test)\.(ts|tsx|js|jsx|cjs|mjs|py|go|java)$|__tests__\//,
  config:   /\.(config|rc|env|ya?ml|json|toml)$|Dockerfile|docker-compose|\.github\//,
  migration: /migrat|seed|fixture/i,
};

// ============================================================
// Configuration
// ============================================================

const CONFIG_DEFAULTS = {
  context_budget: CONTEXT_LIMIT,
  safety_margin: SAFETY_MARGIN,
  assessment_threshold: 0.80,
  auto_split: true,
  max_fix_loops: 3,
  overhead_per_subtask: OVERHEAD_PER_SUBTASK,
  min_action_budget: MIN_ACTION_BUDGET,
  chars_per_token: CHARS_PER_TOKEN,
};

function loadForgeConfig(cwd) {
  // Delegate to unified config system
  try {
    const exec = require('../forge-config/config').getExecution(cwd);
    if (exec && Object.keys(exec).length > 0) {
      return { ...CONFIG_DEFAULTS, ...exec };
    }
  } catch { /* fallback to inline */ }

  const root = cwd || process.cwd();
  const candidates = [
    path.join(root, '.forge', 'config.json'),
    path.join(root, '.planning', 'config.json'),
  ];
  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const exec = parsed.execution || {};
      if (Object.keys(exec).length > 0) {
        return { ...CONFIG_DEFAULTS, ...exec };
      }
    } catch { /* try next */ }
  }
  return { ...CONFIG_DEFAULTS };
}

// ============================================================
// Token Estimation
// ============================================================

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function estimateFileTokens(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Math.ceil(stat.size / CHARS_PER_TOKEN);
  } catch { return 0; }
}

// ============================================================
// Plan Parsing
// ============================================================

function parsePlan(planPath) {
  const raw = fs.readFileSync(planPath, 'utf8');
  const plan = { raw, path: planPath, frontmatter: {}, tasks: [], objective: '', files_modified: [] };

  // Parse YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const waveMatch = fm.match(/^wave:\s*(\d+)/m);
    const depsMatch = fm.match(/^depends_on:\s*\[(.*?)\]/m);
    const autoMatch = fm.match(/^autonomous:\s*(true|false)/m);

    plan.frontmatter.wave = waveMatch ? parseInt(waveMatch[1]) : 1;
    plan.frontmatter.depends_on = depsMatch ? depsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    plan.frontmatter.autonomous = autoMatch ? autoMatch[1] === 'true' : true;

    // Multi-repo plan fields
    const serviceMatch = fm.match(/^service:\s*(.+)/m);
    const repoMatch = fm.match(/^repo:\s*(.+)/m);
    const roleMatch = fm.match(/^role:\s*(.+)/m);
    if (serviceMatch) plan.frontmatter.service = serviceMatch[1].trim().replace(/^["']|["']$/g, '');
    if (repoMatch) plan.frontmatter.repo = repoMatch[1].trim().replace(/^["']|["']$/g, '');
    if (roleMatch) plan.frontmatter.role = roleMatch[1].trim();

    // Extract files_modified (can be multiline YAML list)
    const filesSection = fm.match(/^files_modified:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (filesSection) {
      plan.files_modified = filesSection[1].match(/^\s+-\s+(.+)/gm)
        ?.map(l => l.replace(/^\s+-\s+/, '').trim()) || [];
    } else {
      const filesInline = fm.match(/^files_modified:\s*\[(.*?)\]/m);
      if (filesInline) {
        plan.files_modified = filesInline[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
    }
  }

  // Parse task blocks
  const taskRegex = /<task>([\s\S]*?)<\/task>/g;
  let taskMatch;
  while ((taskMatch = taskRegex.exec(raw)) !== null) {
    const block = taskMatch[1];
    const filesMatch = block.match(/<files>([\s\S]*?)<\/files>/);
    const actionMatch = block.match(/<action>([\s\S]*?)<\/action>/);
    const verifyMatch = block.match(/<verify>([\s\S]*?)<\/verify>/);
    const doneMatch = block.match(/<done>([\s\S]*?)<\/done>/);

    const files = filesMatch
      ? filesMatch[1].trim().split('\n').map(l => l.trim()).filter(Boolean)
      : [];

    plan.tasks.push({
      files,
      action: actionMatch ? actionMatch[1].trim() : '',
      verify: verifyMatch ? verifyMatch[1].trim() : '',
      done: doneMatch ? doneMatch[1].trim() : '',
    });
  }

  // Merge all file references
  const allFiles = new Set([...plan.files_modified]);
  for (const t of plan.tasks) {
    for (const f of t.files) allFiles.add(f);
  }
  plan.all_files = [...allFiles];

  // Parse objective
  const objMatch = raw.match(/##\s*Objective\s*\n([\s\S]*?)(?=\n##|\n<|\Z)/);
  plan.objective = objMatch ? objMatch[1].trim() : '';

  return plan;
}

// ============================================================
// Strategy Selection
// ============================================================

function classifyFile(filePath) {
  for (const [concern, pattern] of Object.entries(CONCERN_TYPE_PATTERNS)) {
    if (pattern.test(filePath)) return concern;
  }
  return 'implementation';
}

function determineStrategy(plan, fileAnalysis, graphData) {
  const { moduleGroups, concernGroups, totalTokens } = fileAnalysis;
  const overflowRatio = totalTokens / USABLE_CONTEXT;

  // MODULE SPLIT: preferred when files span multiple modules
  if (Object.keys(moduleGroups).length >= MODULE_SPLIT_MIN_MODULES) {
    return {
      strategy: 'module',
      reason: `Files span ${Object.keys(moduleGroups).length} modules — split along module boundaries for isolation`,
    };
  }

  // CONCERN SPLIT: when files have clear type separation
  const concernTypes = Object.keys(concernGroups).filter(k => concernGroups[k].length > 0);
  const hasSchema = concernGroups.schema && concernGroups.schema.length > 0;
  const hasTests = concernGroups.test && concernGroups.test.length > 0;
  if (concernTypes.length >= 3 || (hasSchema && concernTypes.length >= 2)) {
    return {
      strategy: 'concern',
      reason: `Files separate into ${concernTypes.join(', ')} concerns — schema/types first, then implementation`,
    };
  }

  // FILE SPLIT: last resort — within-file splitting by symbols
  if (plan.all_files.length <= 3 && overflowRatio > 1.5) {
    return {
      strategy: 'file',
      reason: `Few files (${plan.all_files.length}) but high overflow (${overflowRatio.toFixed(1)}x) — split by logical sections within files`,
    };
  }

  // Default: concern split (safest general approach)
  return {
    strategy: 'concern',
    reason: `General overflow (${overflowRatio.toFixed(1)}x context) — split by concern type for ordered execution`,
  };
}

// ============================================================
// Main Assessment
// ============================================================

function assessPlan(planPath, cwd, opts = {}) {
  const plan = parsePlan(planPath);
  const config = loadForgeConfig(cwd);
  const usableContext = Math.floor(config.context_budget * (1 - config.safety_margin));
  const contextLimit = opts.context_limit || usableContext;
  const threshold = opts.assessment_threshold || config.assessment_threshold;

  // Token estimation
  const planTokens = estimateTokens(plan.raw);
  let fileTokens = 0;
  const fileDetails = [];

  for (const f of plan.all_files) {
    const absPath = path.isAbsolute(f) ? f : path.join(cwd, f);
    const tokens = estimateFileTokens(absPath);
    fileTokens += tokens;
    fileDetails.push({ path: f, tokens, exists: fs.existsSync(absPath), is_plan_file: true });
  }

  // Interface-only deps: estimate ~20 tokens per export instead of full file size
  // This reflects 3-level context compression (FULL for plan files, INTERFACE for deps)
  const graphContextEstimate = plan.all_files.length * 800; // reduced: deps use interface-level loading
  const sessionContextEstimate = 2000; // Ledger entries
  const totalEstimated = planTokens + fileTokens + graphContextEstimate + sessionContextEstimate + OVERHEAD_PER_SUBTASK;

  // Analyze file groups
  const moduleGroups = {};
  const concernGroups = { schema: [], implementation: [], test: [], config: [], migration: [] };

  // Try to get graph data for module grouping
  let graphData = null;
  try {
    const graphDir = path.join(path.dirname(__dirname), 'forge-graph');
    const { GraphQuery } = require(path.join(graphDir, 'query'));
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    if (fs.existsSync(dbPath)) {
      const gq = new GraphQuery(dbPath);
      gq.open();

      for (const f of plan.all_files) {
        const fileInfo = gq.db.prepare('SELECT module FROM files WHERE path = ?').get(f);
        const mod = fileInfo ? fileInfo.module : '<unknown>';
        if (!moduleGroups[mod]) moduleGroups[mod] = [];
        moduleGroups[mod].push(f);
      }

      graphData = { boundaries: gq.getModuleBoundaries(), depGraph: gq.moduleDependencyGraph() };
      gq.close();
    }
  } catch { /* graph not available — degrade gracefully */ }

  // Fallback module grouping by directory
  if (Object.keys(moduleGroups).length === 0) {
    for (const f of plan.all_files) {
      const dir = path.dirname(f).split('/').slice(0, 2).join('/') || '<root>';
      if (!moduleGroups[dir]) moduleGroups[dir] = [];
      moduleGroups[dir].push(f);
    }
  }

  // Classify by concern
  for (const f of plan.all_files) {
    const concern = classifyFile(f);
    if (!concernGroups[concern]) concernGroups[concern] = [];
    concernGroups[concern].push(f);
  }

  const overflowRatio = totalEstimated / contextLimit;
  const needsSplit = overflowRatio > threshold;

  if (!needsSplit) {
    return {
      needs_split: false,
      metrics: {
        plan_tokens: planTokens,
        file_tokens: fileTokens,
        graph_context_estimate: graphContextEstimate,
        session_context_estimate: sessionContextEstimate,
        overhead: config.overhead_per_subtask,
        total_estimated: totalEstimated,
        context_limit: contextLimit,
        overflow_ratio: overflowRatio,
        assessment_threshold: threshold,
      },
      plan,
      file_details: fileDetails,
    };
  }

  // Determine split strategy
  const fileAnalysis = { moduleGroups, concernGroups, totalTokens: totalEstimated };
  const { strategy, reason } = determineStrategy(plan, fileAnalysis, graphData);

  // Estimate sub-task count
  const tokensPerSubtask = contextLimit - config.overhead_per_subtask - config.min_action_budget;
  const suggestedCount = Math.max(2, Math.ceil(totalEstimated / tokensPerSubtask));

  // Build file groups based on strategy
  const fileGroups = [];
  if (strategy === 'module') {
    for (const [mod, files] of Object.entries(moduleGroups)) {
      const tokens = files.reduce((sum, f) => {
        const d = fileDetails.find(fd => fd.path === f);
        return sum + (d ? d.tokens : 0);
      }, 0);
      fileGroups.push({ label: mod, files, tokens, module: mod, concern: null });
    }
  } else if (strategy === 'concern') {
    const order = ['schema', 'migration', 'implementation', 'test', 'config'];
    for (const concern of order) {
      const files = concernGroups[concern] || [];
      if (files.length === 0) continue;
      const tokens = files.reduce((sum, f) => {
        const d = fileDetails.find(fd => fd.path === f);
        return sum + (d ? d.tokens : 0);
      }, 0);
      fileGroups.push({ label: concern, files, tokens, module: null, concern });
    }
  } else { // file
    for (const f of plan.all_files) {
      const d = fileDetails.find(fd => fd.path === f);
      fileGroups.push({ label: path.basename(f), files: [f], tokens: d ? d.tokens : 0, module: null, concern: null });
    }
  }

  // Dependency chain from graph
  let dependencyChain = plan.all_files;
  if (graphData) {
    try {
      dependencyChain = buildDependencyOrder(plan.all_files, cwd);
    } catch { /* keep original order */ }
  }

  return {
    needs_split: true,
    strategy,
    reason,
    metrics: {
      plan_tokens: planTokens,
      file_tokens: fileTokens,
      graph_context_estimate: graphContextEstimate,
      session_context_estimate: sessionContextEstimate,
      overhead: config.overhead_per_subtask,
      total_estimated: totalEstimated,
      context_limit: contextLimit,
      overflow_ratio: overflowRatio,
      assessment_threshold: threshold,
    },
    plan,
    file_details: fileDetails,
    file_groups: fileGroups,
    suggested_subtask_count: suggestedCount,
    dependency_chain: dependencyChain,
    graph_available: graphData !== null,
  };
}

// ============================================================
// Dependency Ordering Helper
// ============================================================

function buildDependencyOrder(files, cwd) {
  try {
    const graphDir = path.join(path.dirname(__dirname), 'forge-graph');
    const { GraphQuery } = require(path.join(graphDir, 'query'));
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    const gq = new GraphQuery(dbPath);
    gq.open();

    const fileSet = new Set(files);
    const adjacency = new Map(); // file -> files it depends on (within set)
    for (const f of files) {
      adjacency.set(f, []);
      const imports = gq.importsOf(f);
      for (const imp of imports) {
        if (fileSet.has(imp.target_file)) {
          adjacency.get(f).push(imp.target_file);
        }
      }
    }
    gq.close();

    // Topological sort (Kahn's algorithm)
    const inDegree = new Map();
    for (const f of files) inDegree.set(f, 0);
    for (const [, deps] of adjacency) {
      for (const d of deps) {
        inDegree.set(d, (inDegree.get(d) || 0) + 1);
      }
    }

    const queue = files.filter(f => inDegree.get(f) === 0);
    const sorted = [];
    while (queue.length > 0) {
      const node = queue.shift();
      sorted.push(node);
      for (const dep of (adjacency.get(node) || [])) {
        const newDegree = inDegree.get(dep) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) queue.push(dep);
      }
    }

    // Add any remaining (cycles) at the end
    for (const f of files) {
      if (!sorted.includes(f)) sorted.push(f);
    }

    return sorted;
  } catch {
    return files;
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  assessPlan,
  parsePlan,
  estimateTokens,
  estimateFileTokens,
  classifyFile,
  buildDependencyOrder,
  loadForgeConfig,
  CONFIG_DEFAULTS,
  USABLE_CONTEXT,
  CONTEXT_LIMIT,
  SAFETY_MARGIN,
  OVERHEAD_PER_SUBTASK,
  MIN_ACTION_BUDGET,
  CHARS_PER_TOKEN,
};

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const planPath = args.find(a => !a.startsWith('-')) || args[0];
  const cwd = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();

  if (!planPath) {
    console.error('Usage: node assessor.js <plan-file> [--root <cwd>]');
    process.exit(1);
  }

  const result = assessPlan(planPath, cwd);

  if (result.needs_split) {
    console.log(`\nSPLIT RECOMMENDED: ${result.strategy}`);
    console.log(`Reason: ${result.reason}`);
    console.log(`\nMetrics:`);
    console.log(`  Plan tokens:     ${result.metrics.plan_tokens}`);
    console.log(`  File tokens:     ${result.metrics.file_tokens}`);
    console.log(`  Total estimated: ${result.metrics.total_estimated}`);
    console.log(`  Context limit:   ${result.metrics.context_limit}`);
    console.log(`  Overflow:        ${result.metrics.overflow_ratio.toFixed(2)}x`);
    console.log(`  Suggested splits: ${result.suggested_subtask_count}`);
    console.log(`\nFile groups:`);
    for (const g of result.file_groups) {
      console.log(`  [${g.label}] ${g.files.length} files, ~${g.tokens} tokens`);
      for (const f of g.files) console.log(`    - ${f}`);
    }
  } else {
    console.log(`\nNO SPLIT NEEDED`);
    console.log(`  Total: ${result.metrics.total_estimated} / ${result.metrics.context_limit} (${(result.metrics.overflow_ratio * 100).toFixed(0)}%)`);
  }
}
