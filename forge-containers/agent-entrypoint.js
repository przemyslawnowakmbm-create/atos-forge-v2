#!/usr/bin/env node
'use strict';

/**
 * Agent Entrypoint — runs INSIDE each forge container.
 *
 * Lifecycle:
 * 1. Read /config/agent.json
 * 2. Copy /repo → /workspace (writable)
 * 3. Apply patches from previous agents (wave 2+)
 * 4. Build system prompt with session context
 * 5. Invoke Claude Code: claude --print -p <prompt> --allowedTools ...
 * 6. Capture changes as git patch → /output/patches/changes.patch
 * 7. Write /output/result.json with status, learnings, warnings
 *
 * No network access. All context pre-mounted.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ============================================================
// Paths (container-internal)
// ============================================================

const CONFIG_PATH = process.env.FORGE_CONFIG_PATH || '/config/agent.json';
const REPO_PATH = process.env.FORGE_REPO_PATH || '/repo';
const WORKSPACE_PATH = '/workspace';
const OUTPUT_PATH = process.env.FORGE_OUTPUT_PATH || '/output';
const GRAPH_PATH = process.env.FORGE_GRAPH_PATH || '';
const PATCHES_DIR = path.join(OUTPUT_PATH, 'patches');
const RESULT_PATH = path.join(OUTPUT_PATH, 'result.json');

// ============================================================
// Utilities
// ============================================================

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
}

function exec(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: opts.cwd || WORKSPACE_PATH,
    stdio: opts.stdio || 'pipe',
    timeout: opts.timeout || 60000,
    encoding: 'utf8',
    ...opts,
  });
}

// ============================================================
// Step 1: Load Agent Config
// ============================================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Agent config not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ============================================================
// Step 2: Copy Repo to Writable Workspace
// ============================================================

function setupWorkspace() {
  log('Copying repo to workspace...');

  // Clean workspace if anything exists
  if (fs.existsSync(WORKSPACE_PATH) && fs.readdirSync(WORKSPACE_PATH).length > 0) {
    exec(`rm -rf ${WORKSPACE_PATH}/*`, { cwd: '/' });
  }

  // Copy repo contents (preserving git history for diff)
  exec(`cp -a ${REPO_PATH}/. ${WORKSPACE_PATH}/`, { cwd: '/' });

  // Ensure git is configured for commits in workspace
  try { exec('git config user.email "forge-agent@localhost"'); } catch { /* ignore */ }
  try { exec('git config user.name "Forge Agent"'); } catch { /* ignore */ }

  // Create a baseline commit marker so we can diff later
  try {
    exec('git add -A');
    exec('git commit --allow-empty -m "forge: baseline for agent work"');
  } catch { /* may fail if already clean */ }

  const fileCount = exec('git ls-files | wc -l').trim();
  log(`Workspace ready: ${fileCount} files`);
}

// ============================================================
// Step 3: Apply Previous Agent Patches
// ============================================================

function applyPreviousPatches(config) {
  const previous = config.previous_agent_results;
  if (!previous || previous.length === 0) return 0;

  let applied = 0;
  log(`Applying ${previous.length} patch(es) from previous agents...`);

  for (const prev of previous) {
    // Patches can be inline content or file references
    const patchContent = prev.patch || prev.content;
    if (!patchContent || patchContent.trim().length === 0) continue;

    try {
      exec('git apply --3way -', { input: patchContent, timeout: 30000 });
      applied++;
      log(`  Applied: ${prev.name || prev.agent_id || 'patch'}`);
    } catch (err) {
      log(`  WARN: Failed to apply ${prev.name || 'patch'}: ${err.message?.split('\n')[0]}`);
    }
  }

  // Commit applied patches as baseline
  if (applied > 0) {
    try {
      exec('git add -A');
      exec(`git commit -m "forge: applied ${applied} patches from previous waves"`);
    } catch { /* ignore */ }
  }

  return applied;
}

// ============================================================
// Step 4: Build Prompt
// ============================================================

function buildSystemPrompt(config) {
  const parts = [];

  // Base system prompt
  if (config.system_prompt) {
    parts.push(config.system_prompt);
  }

  // Session context — decisions, warnings, preferences
  const sc = config.session_context;
  if (sc) {
    parts.push('\n## Session Context');

    if (sc.decisions && sc.decisions.length > 0) {
      parts.push('\nDecisions already made (do NOT re-ask or override):');
      for (const d of sc.decisions) parts.push(`- ${d}`);
    }

    if (sc.warnings && sc.warnings.length > 0) {
      parts.push('\nWarnings from prior work (account for these):');
      for (const w of sc.warnings) parts.push(`- ${w}`);
    }

    if (sc.user_preferences && sc.user_preferences.length > 0) {
      parts.push('\nUser preferences (respect these):');
      for (const p of sc.user_preferences) parts.push(`- ${p}`);
    }

    if (sc.rejected_approaches && sc.rejected_approaches.length > 0) {
      parts.push('\nRejected approaches (do NOT retry):');
      for (const r of sc.rejected_approaches) parts.push(`- ${r}`);
    }
  }

  // Graph context
  if (config.graph_context) {
    parts.push('\n## Code Graph Context');
    if (typeof config.graph_context === 'string') {
      parts.push(config.graph_context);
    } else {
      parts.push(JSON.stringify(config.graph_context, null, 2));
    }
  }

  // Capabilities
  if (config.capabilities && config.capabilities.length > 0) {
    parts.push(`\n## Your Capabilities: ${config.capabilities.join(', ')}`);
  }

  // Verification steps
  if (config.verification_steps && config.verification_steps.length > 0) {
    parts.push('\n## Verification (run after changes)');
    for (const v of config.verification_steps) parts.push(`- ${v}`);
  }

  // Context files hint
  if (config.context_files && config.context_files.length > 0) {
    parts.push(`\n## Key Files\nStart by reading: ${config.context_files.join(', ')}`);
  }

  // Output instructions
  parts.push(`
## Output Protocol
After completing your task:
1. Ensure all changes are saved to disk
2. Do NOT commit — the orchestrator handles git operations
3. If you discover important information, write it to /output/learnings.json:
   { "warnings": ["..."], "discoveries": ["..."] }
`);

  return parts.join('\n');
}

function buildTaskPrompt(config) {
  const task = config.task;
  if (!task) return 'No task specified.';

  if (typeof task === 'string') return task;

  // Structured task from plan
  const parts = [];
  if (task.name) parts.push(`# Task: ${task.name}`);
  if (task.objective) parts.push(`\n## Objective\n${task.objective}`);
  if (task.action) parts.push(`\n## Action\n${task.action}`);
  if (task.files && task.files.length > 0) {
    parts.push(`\n## Target Files\n${task.files.join('\n')}`);
  }
  if (task.verify) parts.push(`\n## Verify\n${task.verify}`);
  if (task.done) parts.push(`\n## Done When\n${task.done}`);

  return parts.join('\n') || JSON.stringify(task, null, 2);
}

// ============================================================
// Step 5: Invoke Claude Code
// ============================================================

function invokeClaude(systemPrompt, taskPrompt, config) {
  log('Invoking Claude Code...');

  const timeout = (config.timeout_seconds || 600) * 1000;
  const allowedTools = 'Bash,Read,Write,Edit,Glob,Grep';

  // Write prompt to temp file to avoid arg length limits
  const promptFile = path.join(OUTPUT_PATH, '.task-prompt.txt');
  fs.writeFileSync(promptFile, taskPrompt);

  const systemFile = path.join(OUTPUT_PATH, '.system-prompt.txt');
  fs.writeFileSync(systemFile, systemPrompt);

  // Build claude command
  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '-p', systemPrompt,
    '--allowedTools', allowedTools,
  ];

  log(`  Working directory: ${WORKSPACE_PATH}`);
  log(`  Timeout: ${config.timeout_seconds || 600}s`);
  log(`  Task length: ${taskPrompt.length} chars`);

  const result = spawnSync('claude', [...args, taskPrompt], {
    cwd: WORKSPACE_PATH,
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50MB
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'forge-agent' },
  });

  // Clean up temp files
  try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  try { fs.unlinkSync(systemFile); } catch { /* ignore */ }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    signal: result.signal,
    timedOut: result.signal === 'SIGTERM',
  };
}

// ============================================================
// Step 6: Collect Output
// ============================================================

function collectOutput(claudeResult, config, startTime) {
  const duration = (Date.now() - startTime) / 1000;
  log('Collecting output...');

  fs.mkdirSync(PATCHES_DIR, { recursive: true });

  // Generate diff of all changes since baseline
  let patchContent = '';
  let filesModified = [];
  try {
    patchContent = exec('git diff HEAD', { timeout: 30000 });
    // Also capture untracked files
    const untracked = exec('git ls-files --others --exclude-standard').trim();
    if (untracked) {
      exec('git add -A');
      patchContent = exec('git diff --cached HEAD', { timeout: 30000 });
    }

    filesModified = exec('git diff --name-only HEAD').trim().split('\n').filter(Boolean);
    // Include untracked
    if (untracked) {
      const untrackedFiles = untracked.split('\n').filter(Boolean);
      filesModified = [...new Set([...filesModified, ...untrackedFiles])];
    }
  } catch (err) {
    log(`  WARN: git diff failed: ${err.message?.split('\n')[0]}`);
  }

  // Write patch
  if (patchContent.trim().length > 0) {
    fs.writeFileSync(path.join(PATCHES_DIR, 'changes.patch'), patchContent);
    log(`  Patch: ${patchContent.length} bytes, ${filesModified.length} files`);
  } else {
    log('  No changes detected (may be valid for verify-only tasks)');
  }

  // Collect learnings written by the agent
  let learnings = { warnings: [], discoveries: [] };
  const learningsPath = path.join(OUTPUT_PATH, 'learnings.json');
  if (fs.existsSync(learningsPath)) {
    try {
      learnings = JSON.parse(fs.readFileSync(learningsPath, 'utf8'));
    } catch { /* ignore malformed */ }
  }

  // Determine status
  let status = 'success';
  if (claudeResult.timedOut) status = 'timeout';
  else if (claudeResult.exitCode !== 0) status = 'error';
  else if (patchContent.trim().length === 0 && filesModified.length === 0) status = 'no_changes';

  // Build result
  const result = {
    task_id: config.agent_id || process.env.FORGE_TASK_ID || 'unknown',
    status,
    exit_code: claudeResult.exitCode,
    timed_out: claudeResult.timedOut || false,
    files_modified: filesModified,
    patch_bytes: patchContent.length,
    duration_seconds: Math.round(duration * 10) / 10,
    warnings: learnings.warnings || [],
    discoveries: learnings.discoveries || [],
    learnings,
  };

  // If Claude errored, include stderr excerpt
  if (status === 'error' && claudeResult.stderr) {
    result.error = claudeResult.stderr.slice(0, 2000);
  }

  writeResult(result);
  log(`Result: status=${status}, files=${filesModified.length}, duration=${result.duration_seconds}s`);
  return result;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const startTime = Date.now();
  log('Forge agent starting...');

  let config;
  try {
    // Step 1: Load config
    config = loadConfig();
    log(`Agent: ${config.agent_id || 'unnamed'}`);
    log(`Task: ${config.task?.name || (typeof config.task === 'string' ? config.task.slice(0, 80) : 'structured')}`);

    // Step 2: Setup workspace
    setupWorkspace();

    // Step 3: Apply previous patches
    const patchCount = applyPreviousPatches(config);
    if (patchCount > 0) log(`Applied ${patchCount} previous patches`);

    // Step 4: Build prompts
    const systemPrompt = buildSystemPrompt(config);
    const taskPrompt = buildTaskPrompt(config);

    // Step 5: Invoke Claude
    const claudeResult = invokeClaude(systemPrompt, taskPrompt, config);

    // Step 6: Collect output
    const result = collectOutput(claudeResult, config, startTime);

    process.exit(result.status === 'success' || result.status === 'no_changes' ? 0 : 1);

  } catch (err) {
    log(`FATAL: ${err.message}`);

    // Try to save partial work even on error
    let partialPatch = '';
    try {
      partialPatch = execSync('git diff', {
        cwd: WORKSPACE_PATH,
        encoding: 'utf8',
        timeout: 10000,
      });
      if (partialPatch.trim()) {
        fs.mkdirSync(PATCHES_DIR, { recursive: true });
        fs.writeFileSync(path.join(PATCHES_DIR, 'partial.patch'), partialPatch);
        log('Saved partial work as partial.patch');
      }
    } catch { /* can't save partial — that's ok */ }

    writeResult({
      task_id: config?.agent_id || process.env.FORGE_TASK_ID || 'unknown',
      status: 'error',
      exit_code: 1,
      timed_out: false,
      error: err.message,
      files_modified: [],
      patch_bytes: partialPatch.length,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      warnings: [],
      discoveries: [],
    });

    process.exit(1);
  }
}

main();
