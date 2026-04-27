#!/usr/bin/env node
'use strict';

/**
 * Agent Verifier — lightweight entrypoint for verification-only containers.
 *
 * Applies patches from an agent, then runs verification steps (types, tests, lint).
 * Reports pass/fail without invoking Claude Code.
 *
 * Lifecycle:
 * 1. Read /config/agent.json
 * 2. Copy /repo → /workspace
 * 3. Apply patches from the agent being verified
 * 4. Run each verification step
 * 5. Write /output/result.json with pass/fail per step
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

// ============================================================
// Setup
// ============================================================

function setupWorkspace() {
  log('Setting up verification workspace...');
  if (fs.existsSync(WORKSPACE_PATH) && fs.readdirSync(WORKSPACE_PATH).length > 0) {
    execSync(`rm -rf ${WORKSPACE_PATH}/*`, { cwd: '/', stdio: 'pipe' });
  }
  execSync(`cp -a ${REPO_PATH}/. ${WORKSPACE_PATH}/`, { cwd: '/', stdio: 'pipe', timeout: 60000 });
  try { execSync('git config user.email "forge-verifier@localhost"', { cwd: WORKSPACE_PATH, stdio: 'pipe' }); } catch { /* ignore */ }
  try { execSync('git config user.name "Forge Verifier"', { cwd: WORKSPACE_PATH, stdio: 'pipe' }); } catch { /* ignore */ }
}

function applyPatches(config) {
  const patches = config.patches || config.previous_agent_results || [];
  if (patches.length === 0) return 0;

  let applied = 0;
  log(`Applying ${patches.length} patch(es)...`);

  for (const p of patches) {
    const content = p.patch || p.content;
    if (!content || content.trim().length === 0) continue;

    try {
      execSync('git apply --3way -', {
        cwd: WORKSPACE_PATH,
        input: content,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      applied++;
      log(`  Applied: ${p.name || p.agent_id || 'patch'}`);
    } catch (err) {
      log(`  WARN: Failed to apply ${p.name || 'patch'}: ${err.message?.split('\n')[0]}`);
    }
  }
  return applied;
}

// ============================================================
// Verification Step Runner
// ============================================================

/**
 * Built-in verification strategies.
 * Each detects whether it's applicable and returns the command to run.
 */
const BUILT_IN_CHECKS = {
  // TypeScript compilation
  typescript: {
    detect: () => fs.existsSync(path.join(WORKSPACE_PATH, 'tsconfig.json')),
    command: 'npx tsc --noEmit',
    label: 'TypeScript compiles',
  },

  // Node.js tests
  npm_test: {
    detect: () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE_PATH, 'package.json'), 'utf8'));
        return pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1';
      } catch { return false; }
    },
    command: 'npm test',
    label: 'Tests pass',
  },

  // Python tests
  pytest: {
    detect: () => fs.existsSync(path.join(WORKSPACE_PATH, 'pyproject.toml'))
      || fs.existsSync(path.join(WORKSPACE_PATH, 'pytest.ini'))
      || fs.existsSync(path.join(WORKSPACE_PATH, 'setup.cfg')),
    command: 'python -m pytest -x --tb=short',
    label: 'Python tests pass',
  },

  // ESLint
  eslint: {
    detect: () => fs.existsSync(path.join(WORKSPACE_PATH, '.eslintrc.json'))
      || fs.existsSync(path.join(WORKSPACE_PATH, '.eslintrc.js'))
      || fs.existsSync(path.join(WORKSPACE_PATH, '.eslintrc.cjs'))
      || fs.existsSync(path.join(WORKSPACE_PATH, 'eslint.config.js'))
      || fs.existsSync(path.join(WORKSPACE_PATH, 'eslint.config.mjs')),
    command: 'npx eslint . --max-warnings=0',
    label: 'ESLint passes',
  },

  // Ruff (Python linter)
  ruff: {
    detect: () => {
      try {
        const toml = fs.readFileSync(path.join(WORKSPACE_PATH, 'pyproject.toml'), 'utf8');
        return toml.includes('ruff');
      } catch { return false; }
    },
    command: 'ruff check .',
    label: 'Ruff passes',
  },

  // Go vet
  go_vet: {
    detect: () => fs.existsSync(path.join(WORKSPACE_PATH, 'go.mod')),
    command: 'go vet ./...',
    label: 'Go vet passes',
  },

  // Build check (generic)
  npm_build: {
    detect: () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE_PATH, 'package.json'), 'utf8'));
        return pkg.scripts && pkg.scripts.build;
      } catch { return false; }
    },
    command: 'npm run build',
    label: 'Build succeeds',
  },
};

/**
 * Run a single verification step.
 */
function runStep(step) {
  const label = step.label || step.command || step;
  const command = step.command || step;
  const timeoutMs = (step.timeout || 120) * 1000;

  log(`  Running: ${label}`);
  const start = Date.now();

  const result = spawnSync('bash', ['-c', command], {
    cwd: WORKSPACE_PATH,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const duration = (Date.now() - start) / 1000;
  const passed = result.status === 0;

  return {
    label,
    command,
    passed,
    exit_code: result.status ?? 1,
    duration_seconds: Math.round(duration * 10) / 10,
    timed_out: result.signal === 'SIGTERM',
    stdout: (result.stdout || '').slice(-2000), // last 2KB
    stderr: (result.stderr || '').slice(-2000),
  };
}

// ============================================================
// Main
// ============================================================

function main() {
  const startTime = Date.now();
  log('Forge verifier starting...');

  let config;
  try {
    // Step 1: Load config
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(`Config not found: ${CONFIG_PATH}`);
    }
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    log(`Verifying: ${config.agent_id || config.task_id || 'unknown'}`);

    // Step 2: Setup workspace
    setupWorkspace();

    // Step 3: Apply patches
    const patchCount = applyPatches(config);
    log(`Applied ${patchCount} patches`);

    // Step 4: Install dependencies if needed
    if (fs.existsSync(path.join(WORKSPACE_PATH, 'package.json'))) {
      log('Installing dependencies...');
      try {
        execSync('npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts', {
          cwd: WORKSPACE_PATH,
          stdio: 'pipe',
          timeout: 120000,
        });
      } catch (err) {
        log(`  WARN: npm install failed: ${err.message?.split('\n')[0]}`);
      }
    }

    // Step 5: Determine verification steps
    const steps = [];

    // Explicit steps from config
    if (config.verification_steps && config.verification_steps.length > 0) {
      for (const step of config.verification_steps) {
        if (typeof step === 'string') {
          // Try to match against built-in checks
          const builtin = matchBuiltIn(step);
          if (builtin) {
            steps.push(builtin);
          } else {
            // Treat as a shell command
            steps.push({ label: step, command: step });
          }
        } else {
          steps.push(step);
        }
      }
    }

    // Auto-detect if no explicit steps
    if (steps.length === 0) {
      log('No explicit verification steps — auto-detecting...');
      for (const [name, check] of Object.entries(BUILT_IN_CHECKS)) {
        if (check.detect()) {
          steps.push({ label: check.label, command: check.command });
          log(`  Detected: ${check.label}`);
        }
      }
    }

    if (steps.length === 0) {
      log('No verification steps found or detected');
      writeResult({
        task_id: config.agent_id || config.task_id || 'unknown',
        status: 'skip',
        message: 'No verification steps applicable',
        steps: [],
        all_passed: true,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
        warnings: [],
        discoveries: [],
      });
      process.exit(0);
    }

    // Step 6: Run verification steps
    log(`Running ${steps.length} verification step(s)...`);
    const results = [];
    for (const step of steps) {
      const r = runStep(step);
      results.push(r);
      log(`  ${r.passed ? 'PASS' : 'FAIL'}: ${r.label} (${r.duration_seconds}s)`);
    }

    const allPassed = results.every(r => r.passed);
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Build warnings from failures
    const warnings = results
      .filter(r => !r.passed)
      .map(r => ({
        message: `Verification failed: ${r.label}`,
        stderr: r.stderr?.slice(0, 500) || '',
      }));

    log(`\nVerification ${allPassed ? 'PASSED' : 'FAILED'}: ${results.filter(r => r.passed).length}/${results.length} steps passed (${duration}s)`);

    writeResult({
      task_id: config.agent_id || config.task_id || 'unknown',
      status: allPassed ? 'success' : 'failed',
      steps: results,
      all_passed: allPassed,
      passed_count: results.filter(r => r.passed).length,
      failed_count: results.filter(r => !r.passed).length,
      duration_seconds: duration,
      warnings,
      discoveries: [],
    });

    process.exit(allPassed ? 0 : 1);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    writeResult({
      task_id: config?.agent_id || config?.task_id || 'unknown',
      status: 'error',
      error: err.message,
      steps: [],
      all_passed: false,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      warnings: [{ message: err.message }],
      discoveries: [],
    });
    process.exit(1);
  }
}

// ============================================================
// Helper: Match string to built-in check
// ============================================================

function matchBuiltIn(step) {
  const lower = step.toLowerCase();

  if (lower.includes('typescript') || lower.includes('tsc') || lower === 'typecheck') {
    const check = BUILT_IN_CHECKS.typescript;
    if (check.detect()) return { label: check.label, command: check.command };
  }
  if (lower.includes('test') && !lower.includes('lint') && !lower.includes('eslint')) {
    // Check python first, then npm
    if (BUILT_IN_CHECKS.pytest.detect()) return { label: BUILT_IN_CHECKS.pytest.label, command: BUILT_IN_CHECKS.pytest.command };
    if (BUILT_IN_CHECKS.npm_test.detect()) return { label: BUILT_IN_CHECKS.npm_test.label, command: BUILT_IN_CHECKS.npm_test.command };
  }
  if (lower.includes('eslint') || lower.includes('lint')) {
    if (BUILT_IN_CHECKS.eslint.detect()) return { label: BUILT_IN_CHECKS.eslint.label, command: BUILT_IN_CHECKS.eslint.command };
    if (BUILT_IN_CHECKS.ruff.detect()) return { label: BUILT_IN_CHECKS.ruff.label, command: BUILT_IN_CHECKS.ruff.command };
  }
  if (lower.includes('build')) {
    if (BUILT_IN_CHECKS.npm_build.detect()) return { label: BUILT_IN_CHECKS.npm_build.label, command: BUILT_IN_CHECKS.npm_build.command };
  }

  // No match — return as raw command
  return null;
}

main();
