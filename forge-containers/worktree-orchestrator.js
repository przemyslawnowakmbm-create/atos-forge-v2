#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync, spawn } = require('child_process');

const { resolveConfig, formatMemory } = require('./config');
const { ResourceManager } = require('./resource-manager');
const { applyPatches, extractLearnings } = require('./patch-collector');
const {
  findProviderBinary,
  checkProvider,
  resolveProvider,
  buildInvocation,
} = require('../forge-agents/provider');

// ============================================================
// Docker-Free Worktree Orchestrator
// ============================================================
// Drop-in replacement for the Docker orchestrator.
// Uses git worktrees + Claude Code subprocesses instead of containers.
//
// Same interface: launch(), launchAll(), cleanup()
// Same result format: { taskId, status, patches, learnings, ... }
// Same resource management: semaphore, concurrency limits
// Same ledger integration: warnings, discoveries, wave logs
// ============================================================

// ============================================================
// Ledger Integration (lazy-loaded, fire-and-forget)
// ============================================================

let _ledger = null;
function getLedger() {
  if (_ledger) return _ledger;
  try {
    _ledger = require(path.join(__dirname, '..', 'forge-session', 'ledger'));
    return _ledger;
  } catch { return null; }
}

function ledgerLog(fn, cwd, entry) {
  try {
    const ledger = getLedger();
    if (ledger && ledger[fn]) ledger[fn](cwd, entry);
  } catch { /* fire and forget */ }
}

// ============================================================
// Timeout Supervision (3-tier: soft / idle / hard)
// ============================================================

const SOFT_TIMEOUT_RATIO = 0.7;
const IDLE_CHECK_INTERVAL_MS = 60000;
const IDLE_MAX_MS = 300000;

function startSupervision(taskCtx, hardTimeoutMs) {
  const timers = {};
  if (hardTimeoutMs > 0) {
    const softMs = Math.floor(hardTimeoutMs * SOFT_TIMEOUT_RATIO);
    timers.soft = setTimeout(() => {
      console.log(`[supervision] Soft timeout for ${taskCtx.taskId || 'task'} — wrapping up`);
      taskCtx.softTimeoutReached = true;
    }, softMs);
  }
  let lastActivity = Date.now();
  timers.idle = setInterval(() => {
    try {
      const cwd = taskCtx.worktreePath || taskCtx.cwd || '.';
      const diff = require('child_process').execSync('git diff --stat HEAD 2>/dev/null', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      if (diff) lastActivity = Date.now();
      if (Date.now() - lastActivity > IDLE_MAX_MS) {
        console.log(`[supervision] Idle timeout for ${taskCtx.taskId || 'task'}`);
        taskCtx.idleTimeoutReached = true;
        clearSupervision(timers);
      }
    } catch {}
  }, IDLE_CHECK_INTERVAL_MS);
  return timers;
}

function clearSupervision(timers) {
  if (timers) {
    if (timers.soft) clearTimeout(timers.soft);
    if (timers.idle) clearInterval(timers.idle);
  }
}

// ============================================================
// Claude Code Detection
// ============================================================

function findClaude() {
  return findProviderBinary('claude');
}

/**
 * Check if Claude Code is available.
 */
function checkClaude() {
  return checkProvider('claude');
}

function findCodex() {
  return findProviderBinary('codex');
}

function checkCodex() {
  return checkProvider('codex');
}

// ============================================================
// Git Worktree Management
// ============================================================

/**
 * Create an isolated git worktree for an agent.
 */
function createWorktree(repoRoot, taskId) {
  const suffix = crypto.randomBytes(3).toString('hex');
  const worktreePath = path.join(os.tmpdir(), `forge-wt-${taskId}-${suffix}`);
  const branch = `forge-work/${taskId}-${suffix}`;

  execSync(
    `git worktree add "${worktreePath}" -b "${branch}" HEAD`,
    { cwd: repoRoot, stdio: 'pipe', timeout: 30000 }
  );

  return { worktreePath, branch };
}

/**
 * Remove a git worktree and its branch.
 */
function removeWorktree(repoRoot, worktreePath, branch) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoRoot, stdio: 'pipe', timeout: 30000,
    });
  } catch {
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' }); } catch { /* ignore */ }
  }
  // Clean up branch
  if (branch) {
    try { execSync(`git branch -D "${branch}"`, { cwd: repoRoot, stdio: 'pipe', timeout: 10000 }); } catch { /* ignore */ }
  }
}

// ============================================================
// Worktree Setup
// ============================================================

/**
 * Prepare a worktree for agent execution:
 * - Write agent config
 * - Copy graph DB
 * - Configure git identity
 * - Create baseline commit
 */
function prepareWorktree(worktreePath, cwd, agentConfig) {
  // Write agent config
  const configPath = path.join(worktreePath, '.forge-agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify(agentConfig, null, 2));

  // Copy graph DB if available
  const graphSrc = path.join(cwd, '.forge', 'graph.db');
  if (fs.existsSync(graphSrc)) {
    const graphDest = path.join(worktreePath, '.forge');
    fs.mkdirSync(graphDest, { recursive: true });
    fs.copyFileSync(graphSrc, path.join(graphDest, 'graph.db'));
  }

  // Copy ledger if available
  const ledgerSrc = path.join(cwd, '.forge', 'session', 'ledger.md');
  if (fs.existsSync(ledgerSrc)) {
    const ledgerDir = path.join(worktreePath, '.forge', 'session');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.copyFileSync(ledgerSrc, path.join(ledgerDir, 'ledger.md'));
  }

  // Copy system-graph.db if available (cross-repo context)
  const systemDbPath = agentConfig.system_context?.system_db_path
    || path.join(cwd, '.forge', 'system-graph.db');
  if (fs.existsSync(systemDbPath)) {
    const forgeDest = path.join(worktreePath, '.forge');
    fs.mkdirSync(forgeDest, { recursive: true });
    fs.copyFileSync(systemDbPath, path.join(forgeDest, 'system-graph.db'));
  }

  // Copy neighbor interfaces.yaml files for cross-repo reference
  if (agentConfig.system_context) {
    const neighborDir = path.join(worktreePath, '.forge', 'neighbor-interfaces');
    let hasNeighbors = false;
    const sc = agentConfig.system_context;
    const neighborServices = [
      ...(sc.consumers || []).map(c => c.consumer_id),
      ...(sc.imports || []).map(i => i.provider_id),
    ];
    for (const svcId of new Set(neighborServices)) {
      // Try to find the neighbor's interfaces.yaml via system graph
      try {
        const SQ = require('../forge-system/query');
        const sq = new SQ.SystemQuery(systemDbPath);
        sq.open();
        try {
          const svc = sq.service(svcId);
          if (svc && svc.service && svc.service.repo_path) {
            const neighborYaml = path.join(svc.service.repo_path, '.forge', 'interfaces.yaml');
            if (fs.existsSync(neighborYaml)) {
              if (!hasNeighbors) {
                fs.mkdirSync(neighborDir, { recursive: true });
                hasNeighbors = true;
              }
              fs.copyFileSync(neighborYaml, path.join(neighborDir, `${svcId}.yaml`));
            }
          }
        } finally {
          sq.close();
        }
      } catch { /* non-fatal */ }
    }
  }

  // Git identity for the worktree
  try {
    execSync('git config user.email "forge-agent@localhost"', { cwd: worktreePath, stdio: 'pipe' });
    execSync('git config user.name "Forge Agent"', { cwd: worktreePath, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Create baseline commit marker for clean diff
  try {
    execSync('git add -A', { cwd: worktreePath, stdio: 'pipe', timeout: 30000 });
    execSync('git commit --allow-empty -m "forge: baseline for agent work"', {
      cwd: worktreePath, stdio: 'pipe', timeout: 10000,
    });
  } catch { /* may fail if clean */ }

  return configPath;
}

// ============================================================
// Build Prompt for Claude Code
// ============================================================

/**
 * Build the full task prompt that combines system prompt + task.
 * Claude --print mode accepts a single prompt, so we concatenate.
 */
function buildPrompt(agentConfig) {
  const parts = [];

  // System prompt (includes archetype, capabilities, session context)
  if (agentConfig.system_prompt) {
    parts.push(agentConfig.system_prompt);
  }

  parts.push('\n---\n');

  // Graph context summary
  if (agentConfig.graph_context) {
    parts.push('## Graph Context');
    const gc = agentConfig.graph_context;
    if (gc.files) {
      parts.push(`Files: ${gc.files.filesAnalyzed || 0} analyzed, Risk: ${gc.risk?.level || 'UNKNOWN'}`);
    }
    if (gc.modules && gc.modules.length > 0) {
      parts.push(`Modules: ${gc.modules.join(', ')}`);
    }
    if (gc.boundaries && gc.boundaries.length > 0) {
      parts.push(`Boundaries: ${gc.boundaries.join(', ')}`);
    }
    if (gc.cycles_count > 0) {
      parts.push(`WARNING: ${gc.cycles_count} circular dependency cycle(s) detected`);
    }
    parts.push('');
  }

  // System graph context (cross-repo)
  if (agentConfig.system_context) {
    const sc = agentConfig.system_context;
    parts.push('## Cross-Repo Context');
    parts.push(`Service: ${sc.service_id}`);
    if (sc.exports && sc.exports.length > 0) {
      parts.push(`Exports: ${sc.exports.map(e => `${e.type}/${e.name}`).join(', ')}`);
    }
    if (sc.consumers && sc.consumers.length > 0) {
      parts.push(`Consumers: ${sc.consumers.map(c => c.consumer_id).join(', ')}`);
      parts.push(`WARNING: Do NOT change exported interfaces — ${sc.consumers.length} service(s) depend on them.`);
    }
    if (sc.imports && sc.imports.length > 0) {
      parts.push(`Dependencies: ${sc.imports.map(i => `${i.provider_id}(${i.type})`).join(', ')}`);
    }
    parts.push('System graph available at: .forge/system-graph.db');
    parts.push('Neighbor interfaces at: .forge/neighbor-interfaces/');
    parts.push('');
  }

  // Task prompt (the actual plan content)
  parts.push('## Task');
  if (agentConfig.task_prompt) {
    parts.push(agentConfig.task_prompt);
  }

  // Verification steps
  if (agentConfig.verification_steps && agentConfig.verification_steps.length > 0) {
    parts.push('\n## Verification');
    parts.push('After completing changes, run these verification steps:');
    for (const step of agentConfig.verification_steps) {
      parts.push(`- ${step}`);
    }
  }

  // Context loading instructions
  if (agentConfig.context) {
    const ctx = agentConfig.context;
    if (ctx.always_load && ctx.always_load.length > 0) {
      parts.push('\n## Files to Read First');
      for (const f of ctx.always_load) {
        parts.push(`- ${f}`);
      }
    }
    if (ctx.task_specific && ctx.task_specific.length > 0) {
      parts.push('\n## Related Files (read if needed)');
      for (const f of ctx.task_specific) {
        parts.push(`- ${f}`);
      }
    }
  }

  return parts.join('\n');
}

// ============================================================
// Claude Code Subprocess
// ============================================================

/**
 * Invoke the configured agent CLI in a worktree.
 *
 * @param {string} prompt - Full prompt text.
 * @param {string} worktreePath - Working directory.
 * @param {object} opts
 * @param {number} opts.timeout - Timeout in seconds.
 * @param {string} opts.outputDir - Directory for stdout/stderr logs.
 * @returns {Promise<{ exitCode: number, duration_ms: number, timedOut: boolean }>}
 */
function invokeProvider(prompt, worktreePath, opts = {}) {
  return new Promise((resolve) => {
    const provider = resolveProvider(worktreePath, opts);
    if (!provider.available) {
      resolve({ exitCode: 1, duration_ms: 0, timedOut: false, error: 'No supported agent CLI found' });
      return;
    }

    const timeout = (opts.timeout || 600) * 1000;
    const outputDir = opts.outputDir || os.tmpdir();
    const stdoutPath = path.join(outputDir, 'stdout.log');
    const stderrPath = path.join(outputDir, 'stderr.log');

    fs.mkdirSync(outputDir, { recursive: true });
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);

    const startTime = Date.now();
    let timedOut = false;
    let finished = false;

    const lastMessagePath = path.join(outputDir, 'last-message.txt');
    const invocation = buildInvocation(provider.name, prompt, {
      outputFile: provider.name === 'codex' ? lastMessagePath : null,
      entrypoint: 'forge-worktree-agent',
      model: opts.model,
    });

    const proc = spawn(provider.path, invocation.args, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...invocation.env,
        HOME: os.homedir(),
      },
    });

    // 3-tier supervision
    const taskCtx = { taskId: opts.taskId || 'claude-agent', worktreePath };
    const supervisionTimers = startSupervision(taskCtx, timeout);

    if (invocation.stdin) {
      proc.stdin.write(invocation.stdin);
      proc.stdin.end();
    }

    proc.stdout.pipe(stdoutStream);
    proc.stderr.pipe(stderrStream);

    // Hard timeout handler
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      // Force kill after 10s grace period
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 10000);
    }, timeout);

    proc.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      clearSupervision(supervisionTimers);
      stdoutStream.end();
      stderrStream.end();
      resolve({
        provider: provider.name,
        exitCode: code ?? 1,
        duration_ms: Date.now() - startTime,
        timedOut,
        softTimeoutReached: taskCtx.softTimeoutReached || false,
        idleTimeoutReached: taskCtx.idleTimeoutReached || false,
      });
    });

    proc.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      clearSupervision(supervisionTimers);
      stdoutStream.end();
      stderrStream.end();
      resolve({
        provider: provider.name,
        exitCode: 1,
        duration_ms: Date.now() - startTime,
        timedOut: false,
        softTimeoutReached: taskCtx.softTimeoutReached || false,
        idleTimeoutReached: taskCtx.idleTimeoutReached || false,
        error: err.message,
      });
    });
  });
}

function invokeClaude(prompt, worktreePath, opts = {}) {
  return invokeProvider(prompt, worktreePath, { ...opts, provider: 'claude' });
}

// ============================================================
// Patch Collection from Worktree
// ============================================================

/**
 * Collect git diff from worktree as a patch.
 * Also reads result.json if the agent wrote one.
 *
 * @param {string} worktreePath
 * @param {string} outputDir
 * @returns {{ patches: object[], agentResult: object|null, errors: string[] }}
 */
function collectWorktreeOutput(worktreePath, outputDir) {
  const result = {
    patches: [],
    agentResult: null,
    stdout: '',
    stderr: '',
    errors: [],
  };

  // Capture git diff (all changes since baseline)
  try {
    // Stage everything first to include new files
    execSync('git add -A', { cwd: worktreePath, stdio: 'pipe', timeout: 30000 });

    const diff = execSync('git diff --cached', {
      cwd: worktreePath, stdio: 'pipe', timeout: 60000, maxBuffer: 50 * 1024 * 1024,
    }).toString();

    if (diff.trim().length > 0) {
      const patchPath = path.join(outputDir, 'patches', 'changes.patch');
      fs.mkdirSync(path.join(outputDir, 'patches'), { recursive: true });
      fs.writeFileSync(patchPath, diff);
      result.patches.push({ name: 'changes.patch', path: patchPath, content: diff });
    }
  } catch (err) {
    result.errors.push(`Failed to collect git diff: ${err.message}`);
  }

  // Check if agent wrote a result.json in the worktree
  const resultPath = path.join(worktreePath, '.forge-agent-result.json');
  if (fs.existsSync(resultPath)) {
    try {
      result.agentResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch (err) {
      result.errors.push(`Failed to parse agent result: ${err.message}`);
    }
  }

  // Also check output dir result.json
  const outputResultPath = path.join(outputDir, 'result.json');
  if (!result.agentResult && fs.existsSync(outputResultPath)) {
    try {
      result.agentResult = JSON.parse(fs.readFileSync(outputResultPath, 'utf8'));
    } catch { /* ignore */ }
  }

  // Collect logs
  const stdoutPath = path.join(outputDir, 'stdout.log');
  const stderrPath = path.join(outputDir, 'stderr.log');
  try { result.stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : ''; } catch { /* ignore */ }
  try { result.stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : ''; } catch { /* ignore */ }

  return result;
}

// ============================================================
// Orchestrator — Full Launch Lifecycle
// ============================================================

/**
 * Launch a worktree-based agent for a sub-plan.
 *
 * Lifecycle:
 * 1. Acquire resource slot
 * 2. Create git worktree
 * 3. Prepare worktree (config, graph DB, ledger, git identity)
 * 4. Build prompt from agentConfig
 * 5. Invoke Claude Code subprocess with timeout
 * 6. Collect git diff as patch
 * 7. Apply patches to main repo
 * 8. Write learnings to session ledger
 * 9. Cleanup worktree
 * 10. Release slot
 *
 * @param {object} agentConfig - Agent configuration from factory.
 * @param {object} params
 * @param {string} params.cwd - Project root.
 * @param {string} params.taskId - Unique task identifier.
 * @param {ResourceManager} params.resourceManager - Shared resource manager.
 * @param {object} [params.opts]
 * @returns {Promise<LaunchResult>}
 */
async function launch(agentConfig, params) {
  const { cwd, taskId, resourceManager, opts = {} } = params;
  const config = resolveConfig(cwd);
  const startTime = Date.now();

  let worktreePath = null;
  let worktreeBranch = null;
  let outputDir = null;
  let slot = null;

  const result = {
    taskId,
    containerId: `wt-${taskId}`,
    status: 'pending',
    exitCode: null,
    duration_ms: 0,
    timedOut: false,
    patches: { applied: [], failed: [], skipped: [] },
    agentResult: null,
    learnings: { warnings: [], discoveries: [] },
    errors: [],
    mode: 'worktree',
  };

  try {
    // 1. Acquire resource slot
    slot = await resourceManager.acquire(taskId);

    // 2. Create git worktree
    const wt = createWorktree(cwd, taskId);
    worktreePath = wt.worktreePath;
    worktreeBranch = wt.branch;

    // 3. Create output directory
    outputDir = path.join(os.tmpdir(), `forge-wt-output-${taskId}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(path.join(outputDir, 'patches'), { recursive: true });

    // 4. Prepare worktree (config, graph, ledger, git identity)
    prepareWorktree(worktreePath, cwd, agentConfig);

    // 5. Build prompt
    const prompt = buildPrompt(agentConfig);

    // 6. Invoke agent CLI
    result.status = 'running';
    const invokeResult = await invokeProvider(prompt, worktreePath, {
      timeout: config.timeout_seconds,
      outputDir,
    });

    result.provider = invokeResult.provider || resolveProvider(cwd, opts).name;
    result.exitCode = invokeResult.exitCode;
    result.timedOut = invokeResult.timedOut;
    result.duration_ms = invokeResult.duration_ms;

    if (invokeResult.error) {
      result.errors.push(invokeResult.error);
    }

    // 7. Collect patches from worktree diff
    const collection = collectWorktreeOutput(worktreePath, outputDir);
    result.agentResult = collection.agentResult;
    if (collection.errors.length > 0) {
      result.errors.push(...collection.errors);
    }

    // 8. Apply patches to main repo
    if (opts.applyPatches !== false && collection.patches.length > 0) {
      // Accept patch even on non-zero exit — Claude may have made valid changes
      // before hitting an error (e.g., classifyHandoffIfNeeded bug)
      const hasChanges = collection.patches.some(p => p.content.trim().length > 0);
      if (hasChanges) {
        const patchResult = applyPatches(cwd, collection.patches, { dryRun: opts.dryRun });
        result.patches = patchResult;
      }
    }

    // 9. Parse structured agent output from stdout
    try {
      const { parseAgentOutput, validateOutput } = require('../forge-agents/agent-output-schema');
      const stdoutContent = collection.stdout || '';
      const agentOutput = parseAgentOutput(stdoutContent);
      if (agentOutput) {
        const { valid, output: parsed } = validateOutput(agentOutput);
        if (valid && parsed) {
          result.agentFindings = parsed.findings;
          result.agentDecisions = parsed.decisions_made;
          result.agentConfidence = parsed.confidence;
        }
      }
    } catch { /* structured output parsing is best-effort */ }

    // 10. Extract and log learnings to session ledger
    const learnings = extractLearnings(collection.agentResult);
    result.learnings = learnings;

    for (const w of learnings.warnings) {
      ledgerLog('logWarning', cwd, w);
    }
    for (const d of learnings.discoveries) {
      ledgerLog('logDiscovery', cwd, d);
    }

    // Log completion
    ledgerLog('logDecision', cwd, {
      decision: `Worktree agent ${taskId} completed: exit=${result.exitCode}, ` +
        `patches=${collection.patches.length}, applied=${result.patches.applied?.length || 0}, ` +
        `duration=${(result.duration_ms / 1000).toFixed(1)}s`,
      rationale: result.timedOut ? 'Timed out' : (result.exitCode === 0 ? 'Success' : 'Failed'),
    });

    // Determine status: exit 0 = success, non-zero but patches applied = partial success
    if (result.exitCode === 0) {
      result.status = 'success';
    } else if (result.patches.applied && result.patches.applied.length > 0) {
      result.status = 'partial';
    } else {
      result.status = 'failed';
    }

  } catch (err) {
    result.status = 'error';
    result.errors.push(err.message);
    ledgerLog('logError', cwd, {
      error: `Worktree agent launch failed for ${taskId}: ${err.message}`,
    });
  } finally {
    // Cleanup
    const shouldCleanup = (result.status === 'success' || result.status === 'partial')
      ? config.cleanup_on_success !== false
      : config.cleanup_on_failure;

    if (shouldCleanup) {
      if (worktreePath) {
        removeWorktree(cwd, worktreePath, worktreeBranch);
      }
      if (outputDir) {
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } else if (worktreePath || outputDir) {
      ledgerLog('logWarning', cwd, {
        warning: `Worktree artifacts preserved for debugging: worktree=${worktreePath}, output=${outputDir}`,
        source: `worktree:${taskId}`,
        severity: 'low',
      });
    }

    // Release resource slot
    if (slot) {
      resourceManager.release(taskId);
    }

    result.duration_ms = Date.now() - startTime;
  }

  return result;
}

/**
 * Launch multiple worktree agents in parallel, respecting resource limits.
 * Uses Promise pool pattern — ResourceManager semaphore controls concurrency.
 *
 * @param {Array<{ agentConfig: object, taskId: string }>} tasks
 * @param {object} params
 * @returns {Promise<LaunchResult[]>}
 */
async function launchAll(tasks, params) {
  const { cwd, opts = {} } = params;
  const resourceManager = new ResourceManager(cwd);

  const promises = tasks.map(task =>
    launch(task.agentConfig, {
      cwd,
      taskId: task.taskId,
      resourceManager,
      opts,
    })
  );

  const results = await Promise.allSettled(promises);

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      taskId: tasks[i].taskId,
      containerId: `wt-${tasks[i].taskId}`,
      status: 'error',
      exitCode: 1,
      duration_ms: 0,
      timedOut: false,
      patches: { applied: [], failed: [], skipped: [] },
      agentResult: null,
      learnings: { warnings: [], discoveries: [] },
      errors: [r.reason?.message || 'Unknown error'],
      mode: 'worktree',
    };
  });
}

// ============================================================
// Cleanup
// ============================================================

/**
 * Clean up orphan worktrees and temp directories.
 */
function cleanup(cwd) {
  const removed = { worktrees: 0, tempDirs: 0 };

  // Prune orphan git worktrees
  try {
    execSync('git worktree prune', { cwd: cwd || process.cwd(), stdio: 'pipe', timeout: 10000 });
  } catch { /* ignore */ }

  // Remove forge worktree temp dirs
  const tmpDir = os.tmpdir();
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith('forge-wt-')) {
        const fullPath = path.join(tmpDir, entry);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed.tempDirs++;
        } catch { /* ignore */ }
      }
      if (entry.startsWith('forge-wt-output-')) {
        const fullPath = path.join(tmpDir, entry);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed.tempDirs++;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Count remaining worktrees
  try {
    const wt = execSync('git worktree list --porcelain', {
      cwd: cwd || process.cwd(), stdio: 'pipe', timeout: 10000,
    }).toString();
    const forgeWt = wt.split('\n').filter(l => l.includes('forge-'));
    removed.worktrees = forgeWt.length;
  } catch { /* ignore */ }

  return removed;
}

// ============================================================
// Auto-Detection: Docker vs Worktree
// ============================================================

/**
 * Detect best execution mode and return the appropriate orchestrator.
 *
 * @param {string} [cwd] - Project root.
 * @returns {{ mode: string, orchestrator: object, reason: string }}
 */
function autoDetect(cwd) {
  const provider = resolveProvider(cwd);
  if (!provider.available) {
    return {
      mode: 'none',
      orchestrator: null,
      reason: 'No supported agent CLI available (expected Claude Code or Codex)',
    };
  }

  // Check Docker
  let dockerAvailable = false;
  try {
    const { checkDocker } = require('./orchestrator');
    const docker = checkDocker();
    dockerAvailable = docker.available;
  } catch { /* orchestrator not loadable */ }

  if (dockerAvailable && provider.container_supported) {
    const dockerOrch = require('./orchestrator');
    return {
      mode: 'container',
      orchestrator: {
        launch: dockerOrch.launch,
        launchAll: dockerOrch.launchAll,
        cleanup: dockerOrch.cleanup,
      },
      reason: `Docker available (${provider.label})`,
    };
  }

  return {
    mode: 'worktree',
    orchestrator: {
      launch,
      launchAll,
      cleanup,
    },
    reason: provider.container_supported
      ? `Docker not available, using worktree mode (${provider.label} ${provider.version})`
      : `${provider.label} does not support container mode, using worktree mode`,
  };
}

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cwd = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();

  if (cmd === 'status') {
    const claude = checkClaude();
    const codex = checkCodex();
    const config = resolveConfig(cwd);
    const detection = autoDetect(cwd);

    console.log('Worktree Orchestrator Status');
    console.log('─'.repeat(50));
    console.log(`Claude Code: ${claude.available ? `${claude.path} (${claude.version})` : 'NOT FOUND'}`);
    console.log(`Codex: ${codex.available ? `${codex.path} (${codex.version})` : 'NOT FOUND'}`);
    console.log(`System: ${config.system.total_cores} cores, ${config.system.total_memory_str} RAM`);
    console.log(`Limits: ${config.max_concurrent} concurrent, timeout ${config.timeout_seconds}s`);
    console.log(`Detection: ${detection.mode} — ${detection.reason}`);

  } else if (cmd === 'cleanup') {
    const r = cleanup(cwd);
    console.log(`Cleaned: ${r.tempDirs} temp dirs, ${r.worktrees} forge worktrees remaining`);

  } else if (cmd === 'detect') {
    const detection = autoDetect(cwd);
    console.log(JSON.stringify(detection, null, 2));

  } else {
    console.log(`forge-containers/worktree-orchestrator.js — Docker-free worktree execution

Usage:
  node worktree-orchestrator.js status   [--root <cwd>]  — Show Claude + resource status
  node worktree-orchestrator.js cleanup  [--root <cwd>]  — Remove orphan worktrees + temp dirs
  node worktree-orchestrator.js detect   [--root <cwd>]  — Auto-detect execution mode (JSON)
`);
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Core lifecycle (same interface as Docker orchestrator)
  launch,
  launchAll,
  cleanup,

  // Worktree management
  createWorktree,
  removeWorktree,
  prepareWorktree,

  // Claude Code
  invokeClaude,
  invokeProvider,
  findClaude,
  checkClaude,
  findCodex,
  checkCodex,
  buildPrompt,

  // Patch collection
  collectWorktreeOutput,

  // Auto-detection
  autoDetect,
};
