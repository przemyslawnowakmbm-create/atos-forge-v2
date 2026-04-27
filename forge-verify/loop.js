#!/usr/bin/env node
'use strict';

/**
 * Verification Loop — verify → fix → re-verify with loop detection.
 *
 * Flow: verify → PASS? commit : analyze fixability →
 *       create fix agent → run → re-verify → max N loops → escalate
 *
 * Auto-fixable: type errors, missing imports, assertion mismatches, interface breaks.
 * Not auto-fixable: behavioral failures → escalate to human.
 *
 * Loop prevention:
 *   - Same patch content twice → stuck, escalate
 *   - New failures introduced by fix → revert, escalate
 *   - Max loops (default 3) exceeded → escalate
 *
 * Usage:
 *   node forge-verify/loop.js --root . [--files f1,f2] [--plan plan.md]
 *       [--max-loops 3] [--commit] [--json] [--no-agent]
 *   Programmatic:
 *     const { verifyLoop } = require('./loop');
 *     const result = await verifyLoop({ cwd, files, ... });
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveProvider } = require('../forge-agents/provider');
const { execSync, spawnSync } = require('child_process');

// ============================================================
// Chalk — graceful fallback
// ============================================================

let chalk;
try {
  chalk = require('chalk');
} catch {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'level') return 0;
      return new Proxy((...args) => args.join(''), handler);
    },
    apply(target, thisArg, args) { return args.join(''); },
  };
  chalk = new Proxy((...args) => args.join(''), handler);
}

// ============================================================
// Lazy Dependencies
// ============================================================

let _engine, _ledger, _factory, _worktreeOrch, _dockerOrch, _config, _graphQuery, _snapshot;

function engine()       { if (!_engine) _engine = require('./engine'); return _engine; }
function ledger()       { if (!_ledger) try { _ledger = require('../forge-session/ledger'); } catch { _ledger = null; } return _ledger; }
function factory()      { if (!_factory) try { _factory = require('../forge-agents/factory'); } catch { _factory = null; } return _factory; }
function worktreeOrch() { if (!_worktreeOrch) try { _worktreeOrch = require('../forge-containers/worktree-orchestrator'); } catch { _worktreeOrch = null; } return _worktreeOrch; }
function dockerOrch()   { if (!_dockerOrch) try { _dockerOrch = require('../forge-containers/orchestrator'); } catch { _dockerOrch = null; } return _dockerOrch; }
function config()       { if (!_config) try { _config = require('../forge-containers/config'); } catch { _config = null; } return _config; }
function graphQuery()   { if (!_graphQuery) try { _graphQuery = require('../forge-graph/query'); } catch { _graphQuery = null; } return _graphQuery; }
function snapshot()     { if (!_snapshot) try { _snapshot = require('../forge-graph/snapshot'); } catch { _snapshot = null; } return _snapshot; }

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_LOOPS = 3;

// Layers that can be auto-fixed by an agent
const AUTO_FIXABLE_LAYERS = new Set([
  'STRUCTURAL',
  'TYPE_COMPILE',
  'INTERFACE_CONTRACTS',
  'DEPENDENCY',
  'TESTS',
  'CONTRACT',
]);

// Layers that need human intervention
const HUMAN_ONLY_LAYERS = new Set([
  'BEHAVIORAL',
]);

/**
 * Load verification config from unified config system or fallback.
 * Returns the `verification` section, or empty object if not found.
 */
function loadVerificationConfig(cwd) {
  // Delegate to unified config system
  try {
    return require('../forge-config/config').getVerification(cwd);
  } catch { /* fallback to inline */ }

  const candidates = [
    path.join(cwd, '.forge', 'config.json'),
    path.join(cwd, '.planning', 'config.json'),
  ];
  for (const configPath of candidates) {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (raw.verification) return raw.verification;
      }
    } catch { /* ignore parse errors */ }
  }
  return {};
}

// ============================================================
// Fixability Analysis
// ============================================================

/**
 * Analyze verification failures and determine fixability.
 *
 * @param {object} verifyResult - Output from engine.verify()
 * @returns {{ fixable: boolean, auto_fixable_errors: object[], human_errors: object[], fix_prompt: string }}
 */
function analyzeFixability(verifyResult) {
  const autoFixable = [];
  const humanErrors = [];

  for (const layer of verifyResult.layers) {
    if (layer.passed || layer.skipped) continue;

    if (HUMAN_ONLY_LAYERS.has(layer.name)) {
      humanErrors.push({
        layer: layer.name,
        index: layer.index,
        reason: 'Behavioral verification requires human judgment',
        errors: getLayerErrorDetails(layer),
      });
      continue;
    }

    if (AUTO_FIXABLE_LAYERS.has(layer.name)) {
      autoFixable.push({
        layer: layer.name,
        index: layer.index,
        errors: getLayerErrorDetails(layer),
        suggestions: (verifyResult.fix_suggestions || []).filter(f => f.layer === layer.index),
      });
    }
  }

  // Build the fix prompt with specific error context
  const fixPrompt = buildFixPrompt(autoFixable, verifyResult);

  return {
    fixable: autoFixable.length > 0,
    auto_fixable_errors: autoFixable,
    human_errors: humanErrors,
    fix_prompt: fixPrompt,
    total_auto_fixable: autoFixable.reduce((n, e) => n + e.errors.length, 0),
    total_human: humanErrors.reduce((n, e) => n + e.errors.length, 0),
  };
}

/**
 * Extract structured error details from a layer result.
 */
function getLayerErrorDetails(layer) {
  const errors = [];

  if (layer.name === 'STRUCTURAL') {
    for (const issue of (layer.result.issues || []).filter(i => i.severity === 'error')) {
      errors.push({ type: 'syntax', file: issue.file, line: issue.line, message: issue.label, snippet: issue.snippet });
    }
  }
  if (layer.name === 'TYPE_COMPILE') {
    for (const check of (layer.result.checks || []).filter(c => c.status === 'fail')) {
      for (const err of (check.errors || []).slice(0, 10)) {
        errors.push({ type: 'type_error', file: err.file, line: err.line, message: err.message || err.code, language: check.language });
      }
      // If no parsed errors, include raw output
      if ((check.errors || []).length === 0) {
        errors.push({ type: 'compile_error', language: check.language, message: (check.stderr || check.stdout || '').slice(-2000) });
      }
    }
  }
  if (layer.name === 'INTERFACE_CONTRACTS') {
    for (const bc of (layer.result.breakingChanges || [])) {
      errors.push({
        type: 'breaking_change', file: bc.file, name: bc.name,
        consumers: bc.affected_consumers || [], consumer_count: bc.consumer_count_actual || 0,
      });
    }
  }
  if (layer.name === 'DEPENDENCY') {
    for (const cycle of (layer.result.newCycles || [])) {
      errors.push({ type: 'circular_dependency', files: cycle });
    }
    for (const orphan of (layer.result.orphanedImports || [])) {
      errors.push({ type: 'orphaned_import', source: orphan.source, target: orphan.target, import_name: orphan.import_name });
    }
  }
  if (layer.name === 'TESTS') {
    for (const tr of (layer.result.testResults || []).filter(r => !r.passed)) {
      errors.push({
        type: 'test_failure', runner: tr.runner, command: tr.command,
        output: (tr.stderr || tr.stdout || '').slice(-3000),
      });
    }
  }
  if (layer.name === 'BEHAVIORAL') {
    for (const step of (layer.result.steps || []).filter(s => !s.passed)) {
      errors.push({
        type: 'behavioral_failure', label: step.label, command: step.command,
        output: (step.stderr || step.stdout || '').slice(-2000),
      });
    }
    // If no steps parsed, count the layer failure itself
    if (errors.length === 0) {
      errors.push({ type: 'behavioral_failure', label: 'Behavioral check failed', message: layer.result.reason || '' });
    }
  }
  if (layer.name === 'CONTRACT') {
    for (const issue of (layer.result.drift || []).filter(d => d.severity === 'error')) {
      errors.push({ type: 'contract_drift', name: issue.name, message: issue.message, suggestion: issue.suggestion });
    }
    for (const issue of (layer.result.compatibility || []).filter(c => c.severity === 'error')) {
      errors.push({ type: 'contract_compat', name: issue.name, message: issue.message, suggestion: issue.suggestion });
    }
    for (const issue of (layer.result.ripple || []).filter(r => r.severity === 'error')) {
      errors.push({
        type: 'contract_ripple', name: issue.name, message: issue.message,
        affected_consumers: issue.affected_consumers || [], suggestion: issue.suggestion,
      });
    }
  }

  return errors;
}

/**
 * Build a targeted fix prompt for the fix agent.
 */
function buildFixPrompt(autoFixable, verifyResult) {
  const parts = [];

  parts.push('# Fix Verification Failures');
  parts.push('');
  parts.push('The verification pipeline found errors that need fixing. Fix ONLY the errors listed below.');
  parts.push('Do NOT make unrelated changes. Do NOT add features. Fix the minimum needed to pass verification.');
  parts.push('');

  for (const group of autoFixable) {
    parts.push(`## Layer ${group.index}: ${group.layer}`);
    parts.push('');

    for (const err of group.errors) {
      switch (err.type) {
        case 'syntax':
          parts.push(`- **Syntax error** in \`${err.file}:${err.line}\`: ${err.message}`);
          if (err.snippet) parts.push(`  \`\`\`\n  ${err.snippet}\n  \`\`\``);
          break;
        case 'type_error':
          parts.push(`- **Type error** in \`${err.file}:${err.line}\`: ${err.message}`);
          break;
        case 'compile_error':
          parts.push(`- **${err.language} compilation failed**:`);
          parts.push(`  \`\`\`\n${err.message.slice(-1000)}\n  \`\`\``);
          break;
        case 'breaking_change':
          parts.push(`- **Breaking change** in \`${err.file}\`: \`${err.name}\` signature changed`);
          parts.push(`  ${err.consumer_count} consumers affected: ${(err.consumers || []).slice(0, 5).join(', ')}`);
          parts.push(`  Either update consumers or revert the signature change.`);
          break;
        case 'circular_dependency':
          parts.push(`- **Circular dependency**: ${err.files.join(' \u2192 ')}`);
          parts.push(`  Extract shared interface or restructure imports.`);
          break;
        case 'orphaned_import':
          parts.push(`- **Orphaned import** in \`${err.source}\`: imports \`${err.import_name}\` from \`${err.target}\` (not found)`);
          parts.push(`  Either create the target file or fix the import path.`);
          break;
        case 'test_failure':
          parts.push(`- **Test failure** (${err.runner}):`);
          parts.push(`  Command: \`${err.command}\``);
          if (err.output) {
            const lastLines = err.output.split('\n').slice(-15).join('\n');
            parts.push(`  \`\`\`\n${lastLines}\n  \`\`\``);
          }
          break;
        case 'contract_drift':
          parts.push(`- **Contract drift**: ${err.message}`);
          if (err.suggestion) parts.push(`  ${err.suggestion}`);
          break;
        case 'contract_compat':
          parts.push(`- **Backward compatibility**: ${err.message}`);
          if (err.suggestion) parts.push(`  ${err.suggestion}`);
          break;
        case 'contract_ripple':
          parts.push(`- **Cross-repo ripple**: ${err.message}`);
          if (err.affected_consumers && err.affected_consumers.length > 0) {
            parts.push(`  Affected: ${err.affected_consumers.map(c => c.id || c).slice(0, 5).join(', ')}`);
          }
          if (err.suggestion) parts.push(`  ${err.suggestion}`);
          break;
      }
      parts.push('');
    }

    // Include fix suggestions
    for (const suggestion of (group.suggestions || [])) {
      parts.push(`> Suggestion: ${suggestion.suggestion}`);
      if (suggestion.fix_command) parts.push(`> Auto-fix: \`${suggestion.fix_command}\``);
      parts.push('');
    }
  }

  parts.push('## Verification');
  parts.push('After fixing, the following must pass:');
  for (const group of autoFixable) {
    if (group.layer === 'TYPE_COMPILE') parts.push('- TypeScript/compiler check passes');
    if (group.layer === 'STRUCTURAL') parts.push('- No syntax errors or debugger statements');
    if (group.layer === 'INTERFACE_CONTRACTS') parts.push('- No interface contract breaks');
    if (group.layer === 'DEPENDENCY') parts.push('- No new circular dependencies or orphaned imports');
    if (group.layer === 'TESTS') parts.push('- All tests pass');
    if (group.layer === 'CONTRACT') parts.push('- No cross-repo contract violations (code matches interfaces.yaml, backward-compatible)');
  }

  return parts.join('\n');
}

// ============================================================
// Fix Agent Builder
// ============================================================

/**
 * Build a fix agent configuration.
 * This is a specialized agent config — not from a plan file,
 * but from verification failure context.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.files - affected files
 * @param {string} opts.fixPrompt - targeted fix instructions
 * @param {number} opts.loopNumber - current loop iteration
 * @param {object} opts.verifyResult - full verification result
 * @param {object} [opts.sessionWarnings] - warnings from ledger
 * @returns {object} agentConfig
 */
function buildFixAgentConfig(opts) {
  const { cwd, files, fixPrompt, loopNumber, verifyResult, sessionWarnings } = opts;
  const taskId = `fix-loop-${loopNumber}-${crypto.randomBytes(3).toString('hex')}`;

  // Build system prompt
  const systemParts = [
    'You are a Forge Fix Agent — a specialized code repair agent.',
    `This is fix loop iteration ${loopNumber}.`,
    '',
    'RULES:',
    '- Fix ONLY the errors described in the task.',
    '- Do NOT refactor, add features, or make unrelated changes.',
    '- Make the MINIMUM change needed to pass verification.',
    '- If you cannot fix an error, leave a comment explaining why.',
    '- After fixing, run the verification checks listed below to confirm.',
    '',
  ];

  // Inject session warnings
  if (sessionWarnings && sessionWarnings.length > 0) {
    systemParts.push('## Warnings from Previous Agents');
    systemParts.push('These warnings came from earlier agent work. Respect them:');
    for (const w of sessionWarnings.slice(0, 10)) {
      systemParts.push(`- ${typeof w === 'string' ? w : w.warning || JSON.stringify(w)}`);
    }
    systemParts.push('');
  }

  // Inject previous loop errors if this isn't the first loop
  if (loopNumber > 1) {
    systemParts.push('## Previous Fix Attempt');
    systemParts.push(`This is loop ${loopNumber}. The previous fix attempt did NOT fully resolve the issues.`);
    systemParts.push('The errors below are what STILL remain after the previous fix. Try a different approach.');
    systemParts.push('');
  }

  // Build verification steps from failed layers
  const verifySteps = [];
  for (const layer of (verifyResult.layers || [])) {
    if (!layer.passed && !layer.skipped && AUTO_FIXABLE_LAYERS.has(layer.name)) {
      if (layer.name === 'TYPE_COMPILE') verifySteps.push('npx tsc --noEmit');
      if (layer.name === 'TESTS') verifySteps.push('npm test');
      if (layer.name === 'STRUCTURAL') verifySteps.push('node -e "process.exit(0)"'); // structural is checked by engine
    }
  }

  // Context files: the failing files + their graph dependencies
  const contextFiles = [...new Set(files)];
  const taskSpecific = [];

  // Try to get graph context
  const GQ = graphQuery();
  if (GQ && fs.existsSync(path.join(cwd, '.forge', 'graph.db'))) {
    try {
      const gq = new GQ.GraphQuery(path.join(cwd, '.forge', 'graph.db'));
      const relFiles = files.map(f => path.isAbsolute(f) ? path.relative(cwd, f) : f);
      const ctx = gq.getContextForTask(relFiles);

      // Add direct dependencies as context
      for (const dep of (ctx.directDependencies || []).slice(0, 10)) {
        if (dep.target_file) taskSpecific.push(dep.target_file);
      }

      // Add consumers for interface breaks
      for (const consumer of (ctx.consumers || []).slice(0, 5)) {
        if (consumer.source_file) taskSpecific.push(consumer.source_file);
      }

      gq.db.close();
    } catch { /* ignore graph errors */ }
  }

  return {
    agent_id: taskId,
    task_id: taskId,
    archetype: 'careful',
    system_prompt: systemParts.join('\n'),
    task_prompt: fixPrompt,
    verification_steps: verifySteps,
    context: {
      always_load: contextFiles.map(f => path.isAbsolute(f) ? f : path.resolve(cwd, f)),
      task_specific: taskSpecific.map(f => path.isAbsolute(f) ? f : path.resolve(cwd, f)),
      reference: [],
    },
    plan_meta: {
      taskId,
      archetype: 'careful',
      is_fix_agent: true,
      fix_loop: loopNumber,
    },
    session_context: {
      warnings: sessionWarnings || [],
      decisions: [],
      user_preferences: [],
      rejected_approaches: [],
    },
  };
}

// ============================================================
// Patch Fingerprinting (Loop Detection)
// ============================================================

/**
 * Compute a hash of a git diff to detect repeated patches.
 */
function patchFingerprint(patchContent) {
  if (!patchContent || patchContent.trim().length === 0) return 'empty';
  // Normalize: strip timestamps and hunk headers that change between runs
  const normalized = patchContent
    .split('\n')
    .filter(l => !l.startsWith('index ') && !l.startsWith('---') && !l.startsWith('+++'))
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ============================================================
// Fix Agent Runner
// ============================================================

/**
 * Run a fix agent via worktree orchestrator (or fallback to direct spawnSync).
 *
 * @param {object} agentConfig
 * @param {string} cwd
 * @param {number} timeout - seconds
 * @returns {Promise<{ success: boolean, patches: string, errors: string[], duration_ms: number }>}
 */
async function runFixAgent(agentConfig, cwd, timeout) {
  const orch = worktreeOrch();
  const provider = resolveProvider(cwd, { provider: agentConfig.provider });

  // If a supported agent CLI exists, use the orchestrator path.
  if (orch && provider.available) {
    return runViaWorktree(agentConfig, cwd, timeout);
  }

  // Fallback: run fix directly via spawnSync (no agent, just commands)
  return runDirectFix(agentConfig, cwd, timeout);
}

/**
 * Run fix via worktree orchestrator (spawns Claude Code).
 */
async function runViaWorktree(agentConfig, cwd, timeout) {
  const orch = worktreeOrch();
  const { ResourceManager } = require('../forge-containers/resource-manager');
  const rm = new ResourceManager({ max_concurrent: 1 });

  try {
    const result = await orch.launch(agentConfig, {
      cwd,
      taskId: agentConfig.task_id,
      resourceManager: rm,
      opts: { timeout, applyPatches: true },
    });

    const patchContent = result.patches?.applied?.map(p => p.content || '').join('\n') || '';

    return {
      success: result.status === 'success' || result.status === 'partial',
      patches: patchContent,
      applied: result.patches?.applied?.length || 0,
      errors: result.errors || [],
      duration_ms: result.duration_ms || 0,
      learnings: result.learnings || { warnings: [], discoveries: [] },
    };
  } catch (err) {
    return {
      success: false,
      patches: '',
      applied: 0,
      errors: [err.message],
      duration_ms: 0,
      learnings: { warnings: [], discoveries: [] },
    };
  }
}

/**
 * Fallback: run auto-fixable suggestions directly (no agent needed).
 * For simple fixes like removing debugger statements.
 */
function runDirectFix(agentConfig, cwd, timeout) {
  const applied = [];
  const errors = [];
  const start = Date.now();

  // Look for auto-fix commands in the fix prompt
  const fixCommands = [];
  if (agentConfig.task_prompt) {
    const lines = agentConfig.task_prompt.split('\n');
    for (const line of lines) {
      const match = line.match(/Auto-fix:\s*`(.+)`/);
      if (match) fixCommands.push(match[1]);
    }
  }

  for (const cmd of fixCommands) {
    try {
      spawnSync('bash', ['-c', cmd], {
        cwd, timeout: 30000, stdio: 'pipe', encoding: 'utf8',
      });
      applied.push(cmd);
    } catch (err) {
      errors.push(`Auto-fix failed: ${cmd} — ${err.message}`);
    }
  }

  // Capture resulting diff
  let patches = '';
  try {
    patches = execSync('git diff', { cwd, encoding: 'utf8', timeout: 10000 });
  } catch { /* ignore */ }

  return Promise.resolve({
    success: applied.length > 0,
    patches,
    applied: applied.length,
    errors,
    duration_ms: Date.now() - start,
    learnings: { warnings: [], discoveries: [] },
  });
}

// ============================================================
// Revert Logic
// ============================================================

/**
 * Revert changes from a failed fix attempt.
 */
function revertChanges(cwd) {
  try {
    execSync('git checkout -- .', { cwd, stdio: 'pipe', timeout: 30000 });
    // Also clean untracked files added by the fix agent
    execSync('git clean -fd', { cwd, stdio: 'pipe', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count failures from a verification result.
 */
function countFailures(verifyResult) {
  let count = 0;
  for (const layer of (verifyResult.layers || [])) {
    if (!layer.passed && !layer.skipped) count++;
  }
  return count;
}

/**
 * Get failed layer names.
 */
function getFailedLayers(verifyResult) {
  return (verifyResult.layers || [])
    .filter(l => !l.passed && !l.skipped)
    .map(l => l.name);
}

// ============================================================
// Session Context from Ledger
// ============================================================

function getSessionWarnings(cwd) {
  const ldg = ledger();
  if (!ldg) return [];

  try {
    const content = ldg.read(cwd);
    if (!content) return [];

    const warnings = [];
    const lines = content.split('\n');
    let inWarnings = false;
    for (const line of lines) {
      if (/^##\s+Warnings/.test(line)) { inWarnings = true; continue; }
      if (/^##\s/.test(line)) { inWarnings = false; continue; }
      if (inWarnings) {
        const m = line.match(/^\s*[-*]\s+(.+)/);
        if (m) warnings.push(m[1].trim());
        // Also capture timestamped entries
        const tm = line.match(/^\[[\d:T.-]+\]\s+(.+)/);
        if (tm) warnings.push(tm[1].trim());
      }
    }
    return warnings;
  } catch { return []; }
}

// ============================================================
// Graph Diff Collection
// ============================================================

function collectGraphDiff(cwd) {
  const snap = snapshot();
  if (!snap) return null;

  try {
    return snap.diffAgainstLatest(cwd);
  } catch { return null; }
}

// ============================================================
// Main Verify Loop
// ============================================================

/**
 * Run the verify → fix → re-verify loop.
 *
 * @param {object} opts
 * @param {string}   opts.cwd            - Project root
 * @param {string[]} [opts.files]        - Changed files (relative paths)
 * @param {string}   [opts.planPath]     - Plan file path
 * @param {string}   [opts.dbPath]       - Graph DB path
 * @param {string}   [opts.baselineDbPath] - Baseline graph DB for diff
 * @param {number}   [opts.maxLoops=3]   - Max fix iterations
 * @param {boolean}  [opts.commit=false] - Auto-commit on PASS
 * @param {string}   [opts.commitMessage] - Custom commit message
 * @param {boolean}  [opts.json=false]   - JSON output
 * @param {boolean}  [opts.silent=false] - No terminal output
 * @param {boolean}  [opts.noAgent=false] - Skip agent, only auto-fix commands
 * @param {number}   [opts.agentTimeout=300] - Fix agent timeout in seconds
 * @param {string}   [opts.mode]         - 'wave' (after each wave) or 'full' (after all waves)
 * @returns {object} Loop result
 */
async function verifyLoop(opts) {
  const cwd = opts.cwd || process.cwd();
  const dbPath = opts.dbPath || path.join(cwd, '.forge', 'graph.db');

  // Load verification config for auto_fix toggle and max_fix_loops override
  const verifyConfig = loadVerificationConfig(cwd);
  const maxLoops = opts.maxLoops ?? verifyConfig.max_fix_loops ?? DEFAULT_MAX_LOOPS;
  const agentTimeout = opts.agentTimeout ?? 300;
  const autoFixEnabled = verifyConfig.auto_fix !== false; // default true

  const loopResult = {
    overall: 'PENDING',
    loops: [],
    total_loops: 0,
    verification_passed: false,
    committed: false,
    escalated: false,
    escalation_reason: null,
    graph_diff: null,
    learnings: [],
    fix_summary: [],
    duration_ms: 0,
  };

  const loopStart = Date.now();
  const patchHashes = new Set(); // For loop detection
  const sessionWarnings = getSessionWarnings(cwd);

  if (!opts.silent) {
    log('');
    log(chalk.bold.cyan(' Verification Loop'));
    log(chalk.dim(` max ${maxLoops} iterations, ${(opts.files || []).length} file(s)`));
    log('');
  }

  for (let loop = 0; loop <= maxLoops; loop++) {
    const loopEntry = {
      iteration: loop,
      phase: loop === 0 ? 'initial_verify' : 'fix_verify',
      verify_result: null,
      fix_result: null,
      fixability: null,
      reverted: false,
      duration_ms: 0,
    };
    const iterStart = Date.now();

    // ── STEP 1: Verify ──
    if (!opts.silent) {
      if (loop === 0) log(chalk.dim(`  [${loop}] `) + 'Running initial verification...');
      else log(chalk.dim(`  [${loop}] `) + 'Re-verifying after fix...');
    }

    const verifyResult = await engine().verify({
      cwd,
      files: opts.files,
      planPath: opts.planPath,
      dbPath,
      baselineDbPath: opts.baselineDbPath,
      incremental: opts.incremental || false,
      failFast: false,
      silent: true,
      logLedger: false, // We log ourselves
      json: false,
    });

    loopEntry.verify_result = {
      overall: verifyResult.overall,
      layers_passed: verifyResult.layers.filter(l => l.passed || l.skipped).length,
      layers_total: verifyResult.layers.filter(l => !l.skipped).length,
      failed_layers: getFailedLayers(verifyResult),
      fix_suggestions: verifyResult.fix_suggestions?.length || 0,
      auto_fixable: verifyResult.auto_fixable || 0,
    };

    // ── STEP 2: Check for PASS ──
    if (verifyResult.overall === 'PASS') {
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);
      loopResult.verification_passed = true;
      loopResult.overall = 'PASS';

      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.green('\u2705 All layers passed'));
      }

      // Log to ledger
      logLedger(cwd, {
        type: 'pass',
        loop,
        layers_passed: loopEntry.verify_result.layers_passed,
      });

      break;
    }

    // ── STEP 3: Analyze fixability ──
    const fixability = analyzeFixability(verifyResult);
    loopEntry.fixability = {
      fixable: fixability.fixable,
      auto_fixable_count: fixability.total_auto_fixable,
      human_count: fixability.total_human,
      layers: fixability.auto_fixable_errors.map(e => e.layer),
    };

    if (!opts.silent) {
      const failedNames = getFailedLayers(verifyResult).join(', ');
      log(chalk.dim(`  [${loop}] `) + chalk.red(`\u274C Failed: ${failedNames}`));
      log(chalk.dim(`        `) + `${fixability.total_auto_fixable} auto-fixable, ${fixability.total_human} need human`);
    }

    // ── STEP 4: Check for escalation conditions ──

    // 4a. Human-only failures with no auto-fixable issues
    if (!fixability.fixable) {
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);
      loopResult.overall = 'ESCALATE';
      loopResult.escalated = true;
      loopResult.escalation_reason = 'No auto-fixable errors — behavioral or human-only failures remain';

      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow('\u26A0\uFE0F  Escalating — only human-fixable errors remain'));
      }

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }

    // 4b. Max loops reached
    if (loop >= maxLoops) {
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);
      loopResult.overall = 'ESCALATE';
      loopResult.escalated = true;
      loopResult.escalation_reason = `Max loops (${maxLoops}) exceeded — errors persist`;

      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow(`\u26A0\uFE0F  Escalating — max ${maxLoops} loops exceeded`));
      }

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }

    // 4c. Auto-fix disabled via config
    if (!autoFixEnabled) {
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);
      loopResult.overall = 'FAIL';
      loopResult.escalated = true;
      loopResult.escalation_reason = 'Auto-fix disabled via verification config (auto_fix: false)';

      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow('\u26A0\uFE0F  Auto-fix disabled — reporting failures only'));
      }

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }

    // ── STEP 5: Run fix agent ──
    if (!opts.silent) {
      log(chalk.dim(`  [${loop}] `) + `Launching fix agent (loop ${loop + 1})...`);
    }

    // Build fix agent config with error context + session warnings
    const agentConfig = buildFixAgentConfig({
      cwd,
      files: opts.files || [],
      fixPrompt: fixability.fix_prompt,
      loopNumber: loop + 1,
      verifyResult,
      sessionWarnings,
    });

    // Log fix attempt to ledger
    const ldg = ledger();
    if (ldg) {
      ldg.logError(cwd, {
        phase: 'verification',
        error: `Fix loop ${loop + 1}: ${fixability.auto_fixable_errors.map(e => `L${e.index} ${e.layer}`).join(', ')}`,
        fix_applied: `Launching fix agent ${agentConfig.task_id}`,
        auto_fixed: true,
        fix_loop: loop + 1,
      });
    }

    // Snapshot current state for potential revert
    let preFixDiff = '';
    try { preFixDiff = execSync('git diff HEAD', { cwd, encoding: 'utf8', timeout: 10000 }); } catch { /* ignore */ }

    // Run fix agent
    const fixResult = opts.noAgent
      ? await runDirectFix(agentConfig, cwd, agentTimeout)
      : await runFixAgent(agentConfig, cwd, agentTimeout);

    loopEntry.fix_result = {
      success: fixResult.success,
      applied: fixResult.applied,
      errors: fixResult.errors,
      duration_ms: fixResult.duration_ms,
    };

    // Invalidate verification cache after fix attempt
    try { require('./cache').invalidate(cwd); } catch { /* ignore */ }

    // Collect learnings
    if (fixResult.learnings) {
      if (fixResult.learnings.warnings) loopResult.learnings.push(...fixResult.learnings.warnings);
      if (fixResult.learnings.discoveries) loopResult.learnings.push(...fixResult.learnings.discoveries);
    }

    loopResult.fix_summary.push({
      loop: loop + 1,
      agent_id: agentConfig.task_id,
      errors_targeted: fixability.total_auto_fixable,
      layers_targeted: fixability.auto_fixable_errors.map(e => e.layer),
      success: fixResult.success,
      patches_applied: fixResult.applied,
    });

    if (!fixResult.success) {
      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow('  Fix agent failed — reverting'));
      }
      revertChanges(cwd);
      loopEntry.reverted = true;
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);

      loopResult.overall = 'ESCALATE';
      loopResult.escalated = true;
      loopResult.escalation_reason = `Fix agent failed: ${fixResult.errors.join(', ')}`;

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }

    // ── STEP 6: Loop detection ──

    // 6a. Same patch twice → stuck
    const hash = patchFingerprint(fixResult.patches);
    if (patchHashes.has(hash)) {
      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow('  Stuck — same patch produced twice, reverting'));
      }
      revertChanges(cwd);
      loopEntry.reverted = true;
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);

      loopResult.overall = 'ESCALATE';
      loopResult.escalated = true;
      loopResult.escalation_reason = 'Same fix patch produced twice — agent is stuck';

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }
    patchHashes.add(hash);

    // 6b. Peek: did the fix introduce NEW failures?
    const peekResult = await engine().verify({
      cwd, files: opts.files, dbPath, incremental: opts.incremental || false, failFast: false, silent: true, logLedger: false,
    });

    const prevFailures = countFailures(verifyResult);
    const newFailures = countFailures(peekResult);
    const prevFailed = new Set(getFailedLayers(verifyResult));
    const newFailed = getFailedLayers(peekResult);
    const genuinelyNew = newFailed.filter(l => !prevFailed.has(l));

    if (genuinelyNew.length > 0) {
      if (!opts.silent) {
        log(chalk.dim(`  [${loop}] `) + chalk.yellow(`  Fix introduced new failures: ${genuinelyNew.join(', ')} — reverting`));
      }
      revertChanges(cwd);
      loopEntry.reverted = true;
      loopEntry.duration_ms = Date.now() - iterStart;
      loopResult.loops.push(loopEntry);

      loopResult.overall = 'ESCALATE';
      loopResult.escalated = true;
      loopResult.escalation_reason = `Fix introduced new failures: ${genuinelyNew.join(', ')}`;

      logLedger(cwd, { type: 'escalate', loop, reason: loopResult.escalation_reason, verifyResult });
      break;
    }

    if (!opts.silent) {
      const delta = prevFailures - newFailures;
      if (delta > 0) log(chalk.dim(`  [${loop}] `) + chalk.green(`  Fixed ${delta} layer(s), ${newFailures} remain`));
      else log(chalk.dim(`  [${loop}] `) + chalk.yellow(`  ${newFailures} failure(s) remain`));
    }

    loopEntry.duration_ms = Date.now() - iterStart;
    loopResult.loops.push(loopEntry);
  }

  // ── Post-loop: commit if passed ──
  if (loopResult.verification_passed && opts.commit) {
    const message = opts.commitMessage || 'feat: verified changes [forge:verified]';
    try {
      execSync('git add -A', { cwd, stdio: 'pipe', timeout: 30000 });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, stdio: 'pipe', timeout: 30000 });
      loopResult.committed = true;
      if (!opts.silent) {
        log(chalk.dim('  ') + chalk.green('\u2705 Committed'));
      }
    } catch (err) {
      if (!opts.silent) {
        log(chalk.dim('  ') + chalk.yellow(`Commit failed: ${err.message.split('\n')[0]}`));
      }
    }
  }

  // ── Collect graph diff ──
  loopResult.graph_diff = collectGraphDiff(cwd);
  loopResult.total_loops = loopResult.loops.length;
  loopResult.duration_ms = Date.now() - loopStart;

  // If we never set an overall, it means we exhausted loops
  if (loopResult.overall === 'PENDING') {
    loopResult.overall = 'ESCALATE';
    loopResult.escalated = true;
    loopResult.escalation_reason = 'Loop completed without resolution';
  }

  // ── Display final report ──
  if (!opts.silent && !opts.json) {
    displayReport(loopResult);
  }
  if (opts.json) {
    console.log(JSON.stringify(loopResult, null, 2));
  }

  // ── Log final state to ledger ──
  logFinalToLedger(cwd, loopResult);

  return loopResult;
}

// ============================================================
// Ledger Logging Helpers
// ============================================================

function logLedger(cwd, entry) {
  const ldg = ledger();
  if (!ldg) return;

  if (entry.type === 'pass') {
    ldg.updateState(cwd, {
      verification: 'passed',
      layers_passed: entry.layers_passed,
      status: 'verified',
    });
    ldg.logEvent(cwd, `Verification passed (loop ${entry.loop})`, {
      layers: entry.layers_passed,
    });
  } else if (entry.type === 'escalate') {
    ldg.updateState(cwd, {
      verification: 'escalated',
      status: 'needs_human',
    });
    ldg.logWarning(cwd, {
      warning: `Verification escalated at loop ${entry.loop}: ${entry.reason}`,
      source: 'verification-loop',
      severity: 'high',
    });
  }
}

function logFinalToLedger(cwd, result) {
  const ldg = ledger();
  if (!ldg) return;

  ldg.logEvent(cwd, `Verification loop completed: ${result.overall}`, {
    loops: result.total_loops,
    duration: formatDuration(result.duration_ms),
    committed: result.committed,
    escalated: result.escalated,
    learnings: result.learnings.length,
  });
}

// ============================================================
// Terminal Display — Final Report
// ============================================================

function displayReport(result) {
  const dbl = { tl: '\u2554', tr: '\u2557', bl: '\u255A', br: '\u255D', h: '\u2550', v: '\u2551' };
  const width = 56;

  log('');
  log(chalk.dim(`  ${dbl.tl}${dbl.h.repeat(width)}${dbl.tr}`));

  // Title
  const title = 'VERIFICATION REPORT';
  const titlePad = Math.floor((width - title.length) / 2);
  log(chalk.dim(`  ${dbl.v}`) + ' '.repeat(titlePad) + chalk.bold.cyan(title) + ' '.repeat(width - titlePad - title.length) + chalk.dim(dbl.v));

  log(chalk.dim(`  ${dbl.v}${'\u2550'.repeat(width)}${dbl.v}`));

  // Overall status
  const overallIcon = result.overall === 'PASS' ? '\u2705' : (result.overall === 'ESCALATE' ? '\u26A0\uFE0F' : '\u274C');
  const overallColor = result.overall === 'PASS' ? chalk.green : (result.overall === 'ESCALATE' ? chalk.yellow : chalk.red);
  log(chalk.dim(`  ${dbl.v} `) + `Overall: ${overallIcon} ${overallColor(result.overall)}` + pad(width - 18 - result.overall.length) + chalk.dim(dbl.v));

  // Layer summary from last verification
  const lastLoop = result.loops[result.loops.length - 1];
  if (lastLoop && lastLoop.verify_result) {
    const vr = lastLoop.verify_result;
    let layerDetail = `Layers: ${vr.layers_passed}/${vr.layers_total} passed`;
    if (result.total_loops > 1) {
      layerDetail += ` (fixed in loop ${result.total_loops - 1})`;
    }
    log(chalk.dim(`  ${dbl.v} `) + layerDetail + pad(width - 2 - layerDetail.length) + chalk.dim(dbl.v));
  }

  // Fix summary
  if (result.fix_summary.length > 0) {
    const fixLine = `Fixes: ${result.fix_summary.length} attempt(s), ${result.fix_summary.filter(f => f.success).length} successful`;
    log(chalk.dim(`  ${dbl.v} `) + fixLine + pad(width - 2 - fixLine.length) + chalk.dim(dbl.v));
  }

  // Graph diff
  if (result.graph_diff) {
    const gd = result.graph_diff;
    const parts = [];
    if (gd.added !== undefined) parts.push(`+${gd.added} file${gd.added !== 1 ? 's' : ''}`);
    else if (gd.files?.added !== undefined) parts.push(`+${gd.files.added} file${gd.files.added !== 1 ? 's' : ''}`);
    if (gd.modified !== undefined) parts.push(`~${gd.modified} modified`);
    else if (gd.files?.modified !== undefined) parts.push(`~${gd.files.modified} modified`);
    if (gd.symbols_delta !== undefined && gd.symbols_delta !== 0) parts.push(`${gd.symbols_delta > 0 ? '+' : ''}${gd.symbols_delta} symbols`);
    if (parts.length > 0) {
      const graphLine = `Graph: ${parts.join(', ')}`;
      log(chalk.dim(`  ${dbl.v} `) + graphLine + pad(width - 2 - graphLine.length) + chalk.dim(dbl.v));
    }
  }

  // Learnings
  if (result.learnings.length > 0) {
    const learnLine = `Learnings: ${result.learnings.length} captured`;
    log(chalk.dim(`  ${dbl.v} `) + learnLine + pad(width - 2 - learnLine.length) + chalk.dim(dbl.v));
  }

  // Duration
  const durLine = `Duration: ${formatDuration(result.duration_ms)}, ${result.total_loops} loop(s)`;
  log(chalk.dim(`  ${dbl.v} `) + chalk.dim(durLine) + pad(width - 2 - durLine.length) + chalk.dim(dbl.v));

  // Escalation reason
  if (result.escalated && result.escalation_reason) {
    log(chalk.dim(`  ${dbl.v}${'\u2500'.repeat(width)}${dbl.v}`));
    const escLine = `Escalation: ${result.escalation_reason}`;
    // Wrap if too long
    const maxLineLen = width - 3;
    if (escLine.length <= maxLineLen) {
      log(chalk.dim(`  ${dbl.v} `) + chalk.yellow(escLine) + pad(width - 2 - escLine.length) + chalk.dim(dbl.v));
    } else {
      const words = escLine.split(' ');
      let currentLine = '';
      for (const word of words) {
        if ((currentLine + ' ' + word).length > maxLineLen) {
          log(chalk.dim(`  ${dbl.v} `) + chalk.yellow(currentLine) + pad(width - 2 - currentLine.length) + chalk.dim(dbl.v));
          currentLine = word;
        } else {
          currentLine = currentLine ? currentLine + ' ' + word : word;
        }
      }
      if (currentLine) {
        log(chalk.dim(`  ${dbl.v} `) + chalk.yellow(currentLine) + pad(width - 2 - currentLine.length) + chalk.dim(dbl.v));
      }
    }
  }

  log(chalk.dim(`  ${dbl.bl}${dbl.h.repeat(width)}${dbl.br}`));
  log('');
}

function pad(n) { return ' '.repeat(Math.max(0, n)); }

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function log(msg) {
  console.log(msg);
}

// ============================================================
// Wave Integration Helpers
// ============================================================

/**
 * Run verification after a single wave (lighter check — layers 1-4 only).
 * Used by execute-phase after each wave completes.
 *
 * @param {object} opts - Same as verifyLoop opts
 * @returns {object} Loop result
 */
async function verifyAfterWave(opts) {
  return verifyLoop({
    ...opts,
    maxLoops: opts.maxLoops ?? 2,  // Fewer loops for wave-level checks
    incremental: true,             // Only verify changed files + consumers
    mode: 'wave',
  });
}

/**
 * Run full verification after all waves complete (all 6 layers).
 * Used by execute-phase after final wave.
 *
 * @param {object} opts - Same as verifyLoop opts
 * @returns {object} Loop result
 */
async function verifyFull(opts) {
  return verifyLoop({
    ...opts,
    maxLoops: opts.maxLoops ?? DEFAULT_MAX_LOOPS,
    mode: 'full',
  });
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) { args.cwd = path.resolve(argv[++i]); }
    else if (arg === '--files' && argv[i + 1]) { args.files = argv[++i].split(','); }
    else if (arg === '--plan' && argv[i + 1]) { args.planPath = path.resolve(argv[++i]); }
    else if (arg === '--db' && argv[i + 1]) { args.dbPath = path.resolve(argv[++i]); }
    else if (arg === '--baseline' && argv[i + 1]) { args.baselineDbPath = path.resolve(argv[++i]); }
    else if (arg === '--max-loops' && argv[i + 1]) { args.maxLoops = parseInt(argv[++i], 10); }
    else if (arg === '--commit') { args.commit = true; }
    else if (arg === '--commit-message' && argv[i + 1]) { args.commitMessage = argv[++i]; }
    else if (arg === '--json') { args.json = true; }
    else if (arg === '--silent') { args.silent = true; }
    else if (arg === '--no-agent') { args.noAgent = true; }
    else if (arg === '--agent-timeout' && argv[i + 1]) { args.agentTimeout = parseInt(argv[++i], 10); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyLoop(args);
  process.exit(result.overall === 'PASS' ? 0 : 1);
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  verifyLoop,
  verifyAfterWave,
  verifyFull,
  analyzeFixability,
  buildFixAgentConfig,
  buildFixPrompt,
  patchFingerprint,
  runFixAgent,
  revertChanges,
  getSessionWarnings,
  displayReport,
  countFailures,
  getFailedLayers,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
