#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const { resolveConfig, formatMemory } = require('./config');
const { ResourceManager } = require('./resource-manager');
const { buildSpec, toDockerArgs, dockerfilePath } = require('./container-spec');
const { collectPatches, applyPatches, extractLearnings } = require('./patch-collector');
const { resolveProvider } = require('../forge-agents/provider');

// ============================================================
// Ledger Integration (lazy-loaded)
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
// Image Management
// ============================================================

/**
 * Build a Docker image from a forge template if not already cached.
 *
 * @param {string} templateName - 'node', 'python', or 'full'
 * @param {{ force?: boolean }} opts
 * @returns {{ image: string, built: boolean, cached: boolean }}
 */
function ensureImage(templateName, opts = {}) {
  const imageName = `forge-agent:${templateName}`;
  const dockerfile = dockerfilePath(templateName);

  if (!fs.existsSync(dockerfile)) {
    throw new Error(`Dockerfile template not found: ${dockerfile}`);
  }

  // Check if image exists
  if (!opts.force) {
    try {
      execSync(`docker image inspect ${imageName}`, { stdio: 'pipe', timeout: 10000 });
      return { image: imageName, built: false, cached: true };
    } catch { /* not cached — build */ }
  }

  // Build image — context is forge-containers/ so COPY can reach entrypoint scripts
  const contextDir = __dirname;
  execSync(
    `docker build -f ${dockerfile} -t ${imageName} ${contextDir}`,
    { stdio: 'inherit', timeout: 300000 }
  );
  return { image: imageName, built: true, cached: false };
}

// ============================================================
// Git Worktree Management
// ============================================================

/**
 * Create an isolated git worktree for a container.
 *
 * @param {string} repoRoot - Main repository root.
 * @param {string} taskId - Task identifier (used in worktree name).
 * @returns {{ worktreePath: string, branch: string }}
 */
function createWorktree(repoRoot, taskId) {
  const suffix = crypto.randomBytes(3).toString('hex');
  const worktreePath = path.join(
    require('os').tmpdir(),
    `forge-${taskId}-${suffix}`
  );
  const branch = `forge-work/${taskId}-${suffix}`;

  execSync(
    `git worktree add "${worktreePath}" -b "${branch}" HEAD`,
    { cwd: repoRoot, stdio: 'pipe', timeout: 30000 }
  );

  return { worktreePath, branch };
}

/**
 * Remove a git worktree.
 */
function removeWorktree(repoRoot, worktreePath) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    // Fallback: manual cleanup
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' }); } catch { /* ignore */ }
  }
}

// ============================================================
// Container Lifecycle
// ============================================================

/**
 * Run a Docker container and wait for it to finish.
 *
 * @param {object} spec - ContainerSpec from buildSpec().
 * @param {{ onStdout?: function, onStderr?: function }} callbacks
 * @returns {Promise<{ exitCode: number, duration_ms: number, timedOut: boolean }>}
 */
function runContainer(spec, callbacks = {}) {
  return new Promise((resolve) => {
    const args = toDockerArgs(spec);
    const stdoutPath = path.join(spec._meta.outputDir, 'stdout.log');
    const stderrPath = path.join(spec._meta.outputDir, 'stderr.log');
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);

    const startTime = Date.now();
    let timedOut = false;
    let finished = false;

    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // 3-tier supervision
    const hardTimeoutMs = spec.timeout * 1000;
    const taskCtx = { taskId: spec.id, worktreePath: spec._meta?.worktreePath, cwd: spec._meta?.cwd };
    const supervisionTimers = startSupervision(taskCtx, hardTimeoutMs);

    proc.stdout.pipe(stdoutStream);
    proc.stderr.pipe(stderrStream);

    if (callbacks.onStdout) proc.stdout.on('data', callbacks.onStdout);
    if (callbacks.onStderr) proc.stderr.on('data', callbacks.onStderr);

    // Hard timeout handler
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      try {
        execSync(`docker kill ${spec.id}`, { stdio: 'pipe', timeout: 10000 });
      } catch { /* container may have already exited */ }
    }, hardTimeoutMs);

    proc.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      clearSupervision(supervisionTimers);
      stdoutStream.end();
      stderrStream.end();
      resolve({
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

// ============================================================
// Orchestrator — Full Launch Lifecycle
// ============================================================

/**
 * Launch a containerized agent for a sub-plan.
 *
 * Full lifecycle:
 * 1. Acquire resource slot
 * 2. Create git worktree
 * 3. Build container spec
 * 4. Ensure Docker image
 * 5. Start container with timeout
 * 6. Collect patches and results
 * 7. Write learnings to session ledger
 * 8. Cleanup container, worktree, temp dirs
 * 9. Release slot
 *
 * @param {object} agentConfig - Agent configuration (task, prompt, context).
 * @param {object} params
 * @param {string} params.cwd - Project root.
 * @param {string} params.taskId - Unique task identifier.
 * @param {ResourceManager} params.resourceManager - Shared resource manager.
 * @param {{ dockerfile?: string, image?: string, applyPatches?: boolean, dryRun?: boolean }} [params.opts]
 * @returns {Promise<LaunchResult>}
 */
async function launch(agentConfig, params) {
  const { cwd, taskId, resourceManager, opts = {} } = params;
  const provider = resolveProvider(cwd, { provider: agentConfig.provider });
  if (!provider.container_supported) {
    return require('./worktree-orchestrator').launch(agentConfig, params);
  }

  const config = resolveConfig(cwd);
  const startTime = Date.now();

  let worktreePath = null;
  let outputDir = null;
  let slot = null;

  const result = {
    taskId,
    containerId: null,
    status: 'pending',
    exitCode: null,
    duration_ms: 0,
    timedOut: false,
    patches: { applied: [], failed: [], skipped: [] },
    agentResult: null,
    learnings: { warnings: [], discoveries: [] },
    errors: [],
  };

  try {
    // 1. Acquire resource slot
    slot = await resourceManager.acquire(taskId);

    // 2. Create git worktree
    const wt = createWorktree(cwd, taskId);
    worktreePath = wt.worktreePath;

    // 3. Create output directory
    outputDir = path.join(
      require('os').tmpdir(),
      `forge-output-${taskId}-${crypto.randomBytes(3).toString('hex')}`
    );
    fs.mkdirSync(path.join(outputDir, 'patches'), { recursive: true });

    // 4. Build container spec
    const spec = buildSpec({
      taskId,
      cwd,
      worktreePath,
      outputDir,
      agentConfig,
      resourceConfig: config,
      opts: { image: opts.image, dockerfile: opts.dockerfile },
    });
    result.containerId = spec.id;

    // 5. Ensure Docker image
    const imageResult = ensureImage(
      opts.dockerfile || detectTemplate(cwd),
      { force: false }
    );

    // 6. Run container
    result.status = 'running';
    const runResult = await runContainer(spec);
    result.exitCode = runResult.exitCode;
    result.timedOut = runResult.timedOut;
    result.duration_ms = runResult.duration_ms;

    if (runResult.error) {
      result.errors.push(runResult.error);
    }

    // 7. Collect patches and results
    const collection = collectPatches(outputDir);
    result.agentResult = collection.agentResult;
    if (collection.errors.length > 0) {
      result.errors.push(...collection.errors);
    }

    // 8. Apply patches (if requested and agent succeeded)
    if (opts.applyPatches !== false && result.exitCode === 0 && collection.patches.length > 0) {
      const patchResult = applyPatches(cwd, collection.patches, { dryRun: opts.dryRun });
      result.patches = patchResult;
    }

    // 9. Parse structured agent output from stdout
    try {
      const { parseAgentOutput, validateOutput } = require('../forge-agents/agent-output-schema');
      const stdoutLogPath = path.join(outputDir, 'stdout.log');
      const stdoutContent = fs.existsSync(stdoutLogPath) ? fs.readFileSync(stdoutLogPath, 'utf8') : '';
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
      decision: `Container ${result.containerId} completed: exit=${result.exitCode}, ` +
        `patches=${collection.patches.length}, applied=${result.patches.applied?.length || 0}, ` +
        `duration=${(result.duration_ms / 1000).toFixed(1)}s`,
      rationale: result.timedOut ? 'Timed out' : (result.exitCode === 0 ? 'Success' : 'Failed'),
    });

    result.status = result.exitCode === 0 ? 'success' : 'failed';

  } catch (err) {
    result.status = 'error';
    result.errors.push(err.message);
    ledgerLog('logError', cwd, {
      error: `Container launch failed for ${taskId}: ${err.message}`,
    });
  } finally {
    // Cleanup
    const shouldCleanup = result.status === 'success'
      ? config.cleanup_on_success
      : config.cleanup_on_failure;

    if (shouldCleanup) {
      // Remove container (in case --rm didn't work)
      if (result.containerId) {
        try { execSync(`docker rm -f ${result.containerId}`, { stdio: 'pipe', timeout: 10000 }); } catch { /* ignore */ }
      }

      // Remove worktree
      if (worktreePath) {
        removeWorktree(cwd, worktreePath);
      }

      // Remove output dir
      if (outputDir) {
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } else if (worktreePath || outputDir) {
      // Keep artifacts for debugging — log their locations
      ledgerLog('logWarning', cwd, {
        warning: `Container artifacts preserved for debugging: worktree=${worktreePath}, output=${outputDir}`,
        source: `container:${taskId}`,
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
 * Launch multiple containers in parallel, respecting resource limits.
 *
 * @param {Array<{ agentConfig: object, taskId: string }>} tasks
 * @param {object} params - Shared params: cwd, opts.
 * @returns {Promise<LaunchResult[]>}
 */
async function launchAll(tasks, params) {
  const provider = resolveProvider(params.cwd);
  if (!provider.container_supported) {
    return require('./worktree-orchestrator').launchAll(tasks, params);
  }

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
      status: 'error',
      errors: [r.reason?.message || 'Unknown error'],
      patches: { applied: [], failed: [], skipped: [] },
      learnings: { warnings: [], discoveries: [] },
    };
  });
}

// ============================================================
// Template Detection
// ============================================================

function detectTemplate(cwd) {
  const hasNode = fs.existsSync(path.join(cwd, 'package.json'))
    || fs.existsSync(path.join(cwd, 'frontend', 'package.json'));
  const hasPython = fs.existsSync(path.join(cwd, 'pyproject.toml'))
    || fs.existsSync(path.join(cwd, 'requirements.txt'))
    || fs.existsSync(path.join(cwd, 'backend', 'requirements.txt'));
  const hasCompose = fs.existsSync(path.join(cwd, 'docker-compose.yml'))
    || fs.existsSync(path.join(cwd, 'docker-compose.yaml'));

  if ((hasNode && hasPython) || hasCompose) return 'full';
  if (hasPython) return 'python';
  return 'node';
}

// ============================================================
// Docker Availability Check
// ============================================================

/**
 * Check if Docker is available and responsive.
 */
function checkDocker() {
  try {
    const version = execSync('docker version --format "{{.Server.Version}}"', {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

/**
 * List all forge agent containers (running or stopped).
 */
function listContainers() {
  try {
    const output = execSync(
      'docker ps -a --filter "name=forge-" --format "{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.CreatedAt}}"',
      { stdio: 'pipe', timeout: 10000 }
    ).toString().trim();
    if (!output) return [];
    return output.split('\n').map(line => {
      const [id, name, status, created] = line.split('\t');
      return { id, name, status, created };
    });
  } catch { return []; }
}

/**
 * Clean up all stopped forge containers and dangling images.
 */
function cleanup() {
  const removed = { containers: 0, images: 0, worktrees: 0 };

  // Remove stopped forge containers
  try {
    const stopped = execSync(
      'docker ps -a --filter "name=forge-" --filter "status=exited" -q',
      { stdio: 'pipe', timeout: 10000 }
    ).toString().trim();
    if (stopped) {
      const ids = stopped.split('\n').filter(Boolean);
      for (const id of ids) {
        try { execSync(`docker rm ${id}`, { stdio: 'pipe', timeout: 5000 }); removed.containers++; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Remove dangling forge images
  try {
    execSync('docker image prune -f --filter "label=forge-agent"', { stdio: 'pipe', timeout: 30000 });
  } catch { /* ignore */ }

  // Prune orphan worktrees
  try {
    execSync('git worktree prune', { stdio: 'pipe', timeout: 10000 });
  } catch { /* ignore */ }

  return removed;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  launch,
  launchAll,
  ensureImage,
  createWorktree,
  removeWorktree,
  runContainer,
  checkDocker,
  listContainers,
  cleanup,
  detectTemplate,
};

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cwd = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const jsonOutput = args.includes('--json');

  if (cmd === 'status') {
    const docker = checkDocker();
    const config = resolveConfig(cwd);
    const containers = listContainers();
    if (jsonOutput) {
      console.log(JSON.stringify({
        docker, system: config.system,
        limits: { max_concurrent: config.max_concurrent, max_memory_per_container: config.max_memory_per_container_str, max_cpu_per_container: config.max_cpu_per_container },
        containers,
      }));
    } else {
      console.log('Docker:', docker.available ? `v${docker.version}` : 'NOT AVAILABLE');
      console.log(`System: ${config.system.total_cores} cores, ${config.system.total_memory_str} RAM`);
      console.log(`Limits: ${config.max_concurrent} concurrent, ${config.max_memory_per_container_str}/container, ${config.max_cpu_per_container} CPU/container`);
      console.log(`Total budget: ${config.max_total_memory_str} RAM, ${config.max_total_cpu} CPU`);
      if (containers.length > 0) {
        console.log(`\nActive containers (${containers.length}):`);
        for (const c of containers) {
          console.log(`  ${c.name}: ${c.status}`);
        }
      }
    }

  } else if (cmd === 'check-docker') {
    // Simple Docker availability check — returns JSON
    const result = checkDocker();
    console.log(JSON.stringify(result));

  } else if (cmd === 'resources') {
    // Resource detection — returns JSON for workflow consumption
    try {
      const config = resolveConfig(cwd);
      console.log(JSON.stringify({
        cores: config.system.total_cores,
        memory: config.system.total_memory_str,
        max_concurrent: config.max_concurrent,
        mem_per_container: config.max_memory_per_container_str,
        cpu_per_container: config.max_cpu_per_container,
        total_mem: config.max_total_memory_str,
        total_cpu: config.max_total_cpu,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        cores: 2, memory: '4.0g', max_concurrent: 1,
        mem_per_container: '2.0g', cpu_per_container: 1,
        total_mem: '4.0g', total_cpu: 2,
        error: err.message,
      }));
    }

  } else if (cmd === 'ensure-image') {
    // Build or verify Docker image — returns JSON
    // Usage: node orchestrator.js ensure-image [template] [--root <cwd>] [--force]
    const template = (args[1] && !args[1].startsWith('--')) ? args[1] : detectTemplate(cwd);
    const force = args.includes('--force');
    try {
      const result = ensureImage(template, { force });
      console.log(JSON.stringify({ success: true, ...result, template }));
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: err.message, template }));
      process.exit(1);
    }

  } else if (cmd === 'launch-wave') {
    // Launch a wave of containers from a JSON config file
    // Usage: node orchestrator.js launch-wave <config.json> --root <cwd>
    //
    // config.json format:
    // { "tasks": [{ "taskId": "...", "agentConfig": {...} }], "applyPatches": true }
    const configPath = args[1];
    if (!configPath || !fs.existsSync(configPath)) {
      console.error(JSON.stringify({ success: false, error: `Config file not found: ${configPath}` }));
      process.exit(1);
    }

    let waveConfig;
    try {
      waveConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(JSON.stringify({ success: false, error: `Invalid JSON in ${configPath}: ${err.message}` }));
      process.exit(1);
    }

    const tasks = waveConfig.tasks || [];
    if (tasks.length === 0) {
      console.log(JSON.stringify({ success: true, results: [], message: 'No tasks in wave' }));
      process.exit(0);
    }

    // First ensure image is built
    const template = detectTemplate(cwd);
    try {
      const imgResult = ensureImage(template);
      process.stderr.write(`Image: ${imgResult.image} (${imgResult.cached ? 'cached' : 'built'})\n`);
    } catch (err) {
      console.error(JSON.stringify({ success: false, error: `Image build failed: ${err.message}`, template }));
      process.exit(1);
    }

    // Launch all containers
    launchAll(tasks, {
      cwd,
      opts: {
        applyPatches: waveConfig.applyPatches !== false,
        dryRun: waveConfig.dryRun || false,
      },
    }).then(results => {
      const passed = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status !== 'success').length;
      console.log(JSON.stringify({
        success: failed === 0,
        total: results.length,
        passed,
        failed,
        results,
      }));
      process.exit(failed > 0 ? 1 : 0);
    }).catch(err => {
      console.error(JSON.stringify({ success: false, error: err.message }));
      process.exit(1);
    });

  } else if (cmd === 'build') {
    const template = args[1] || 'node';
    console.log(`Building forge-agent:${template}...`);
    const r = ensureImage(template, { force: args.includes('--force') });
    console.log(r.cached ? `Image cached: ${r.image}` : `Image built: ${r.image}`);

  } else if (cmd === 'cleanup') {
    const r = cleanup();
    if (jsonOutput) {
      console.log(JSON.stringify({ success: true, ...r }));
    } else {
      console.log(`Cleaned up: ${r.containers} containers, ${r.images} images`);
    }

  } else {
    console.log(`forge-containers/orchestrator.js — Container lifecycle management

Usage:
  node orchestrator.js status        [--root <cwd>] [--json]  — Docker status and resource limits
  node orchestrator.js check-docker                           — Docker availability (JSON)
  node orchestrator.js resources     [--root <cwd>]           — System resources (JSON)
  node orchestrator.js ensure-image  [template] [--root <cwd>] [--force]  — Build/verify agent image
  node orchestrator.js launch-wave   <config.json> --root <cwd>           — Launch container wave
  node orchestrator.js build         <template> [--force]     — Build agent image
  node orchestrator.js cleanup       [--json]                 — Remove stopped containers
`);
  }
}
