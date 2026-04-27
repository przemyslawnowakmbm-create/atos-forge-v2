#!/usr/bin/env node
'use strict';

/**
 * UAT Run-and-Eval — Combined backend test executor + evaluator.
 *
 * Runs a test command internally (hiding raw output from the calling agent),
 * evaluates the result using uat-auto-eval.cjs, and returns ONLY a verdict.
 *
 * The agent never sees raw test output for passing tests, making it impossible
 * to show output and ask the user to "Type pass".
 *
 * Usage:
 *   node uat-run-and-eval.cjs --command "cargo test ..." --expected "all tests pass"
 *
 * Exit codes:
 *   0 — PASS (auto-pass, no user interaction needed)
 *   1 — FAIL or INCONCLUSIVE (show to user for manual review)
 *
 * Stdout:
 *   On PASS:  "FORGE_UAT_PASS: {reason}"
 *   On FAIL:  "FORGE_UAT_FAIL: {reason}\n---RAW_OUTPUT---\n{output}\n---END_OUTPUT---"
 *   On INCONCLUSIVE: "FORGE_UAT_INCONCLUSIVE: {reason}\n---RAW_OUTPUT---\n{output}\n---END_OUTPUT---"
 */

const { execSync } = require('child_process');
const path = require('path');

// ── Parse arguments ──────────────────────────────────────────────────────────
let command = '';
let expected = '';

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--command' && process.argv[i + 1]) {
    command = process.argv[++i];
  } else if (a === '--expected' && process.argv[i + 1]) {
    expected = process.argv[++i];
  }
}

if (!command) {
  console.error('Error: --command is required');
  process.exit(2);
}
if (!expected) {
  console.error('Error: --expected is required');
  process.exit(2);
}

// ── Execute the test command ─────────────────────────────────────────────────
let output = '';
let exitCode = 0;

try {
  output = execSync(command, {
    encoding: 'utf8',
    timeout: 120000,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (e) {
  // Command failed — capture output and exit code
  output = (e.stdout || '') + (e.stderr || '');
  exitCode = typeof e.status === 'number' ? e.status : 1;
}

// ── Evaluate using uat-auto-eval ─────────────────────────────────────────────
let autoEvaluate;
try {
  // Try relative path first (same bin/lib/ directory)
  autoEvaluate = require(path.join(__dirname, 'lib', 'uat-auto-eval.cjs')).autoEvaluate;
} catch {
  try {
    // Fallback: try the home directory path
    const homeForge = path.join(process.env.HOME || '', '.claude', 'atos-forge', 'bin', 'lib', 'uat-auto-eval.cjs');
    autoEvaluate = require(homeForge).autoEvaluate;
  } catch (e2) {
    // Cannot load evaluator — treat as INCONCLUSIVE
    console.log('FORGE_UAT_INCONCLUSIVE: auto-evaluator module not found');
    console.log('---RAW_OUTPUT---');
    console.log(output);
    console.log('---END_OUTPUT---');
    process.exit(1);
  }
}

const result = autoEvaluate(expected, exitCode, output);

// ── Output verdict ───────────────────────────────────────────────────────────
if (result.status === 'PASS') {
  // PASS: Show ONLY the verdict. No raw output. Agent has nothing to show user.
  console.log(`FORGE_UAT_PASS: ${result.reason}`);
  process.exit(0);
} else {
  // FAIL or INCONCLUSIVE: Include raw output so agent can show it in NEEDS REVIEW box.
  console.log(`FORGE_UAT_${result.status}: ${result.reason}`);
  console.log('---RAW_OUTPUT---');
  console.log(output);
  console.log('---END_OUTPUT---');
  process.exit(1);
}
