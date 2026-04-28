'use strict';

/**
 * Cross-Phase Regression Testing
 *
 * Discovers all test files across all phases, runs them, and compares
 * results against a saved baseline to detect regressions.
 *
 * Usage:
 *   const { runRegression, saveBaseline } = require('./regression');
 *   const result = runRegression(cwd, { phase: 3 });
 *   if (result.passed) saveBaseline(cwd, result, 3);
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Discover all test files across phase plans and source directories.
 * @param {string} cwd - Project root
 * @returns {{ testFiles: string[], byPhase: Object<string, string[]> }}
 */
function discoverAllTests(cwd) {
  const testFiles = new Set();
  const byPhase = {};

  // 1. Scan .planning/phases/*/PLAN*.md for test references
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (fs.existsSync(phasesDir)) {
    try {
      const phaseDirs = fs.readdirSync(phasesDir).filter(d => {
        try { return fs.statSync(path.join(phasesDir, d)).isDirectory(); } catch { return false; }
      });

      for (const dir of phaseDirs) {
        const dirPath = path.join(phasesDir, dir);
        const planFiles = fs.readdirSync(dirPath).filter(f => f.includes('PLAN') && f.endsWith('.md'));
        const phaseTests = [];

        for (const planFile of planFiles) {
          try {
            const content = fs.readFileSync(path.join(dirPath, planFile), 'utf8');
            // Extract test file references from plan content
            const testRefs = content.match(/(?:test|spec|__tests__)\/[^\s)"`']+\.(test|spec)\.[jt]sx?/g) || [];
            for (const ref of testRefs) {
              const cleaned = ref.replace(/^["'`]|["'`]$/g, '');
              if (!testFiles.has(cleaned)) {
                testFiles.add(cleaned);
                phaseTests.push(cleaned);
              }
            }
          } catch { /* ignore unreadable plan files */ }
        }

        if (phaseTests.length > 0) {
          byPhase[dir] = phaseTests;
        }
      }
    } catch { /* phases dir not readable */ }
  }

  // 2. Scan source directories for test files directly
  const testDirs = ['src', 'tests', 'test', '__tests__', 'lib'];
  for (const testDir of testDirs) {
    const dirPath = path.join(cwd, testDir);
    if (fs.existsSync(dirPath)) {
      const found = findTestFilesRecursive(dirPath, cwd);
      for (const f of found) testFiles.add(f);
    }
  }

  return { testFiles: [...testFiles], byPhase };
}

/**
 * Recursively find test files in a directory.
 * @param {string} dir - Absolute directory path
 * @param {string} cwd - Project root for relative paths
 * @param {number} depth - Current recursion depth
 * @returns {string[]} Relative paths to test files
 */
function findTestFilesRecursive(dir, cwd, depth = 0) {
  if (depth > 8) return [];
  const results = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...findTestFilesRecursive(fullPath, cwd, depth + 1));
      } else if (entry.isFile()) {
        if (/\.(test|spec)\.[jt]sx?$/.test(entry.name) || /test_.*\.py$/.test(entry.name) || /_test\.py$/.test(entry.name)) {
          results.push(path.relative(cwd, fullPath));
        }
      }
    }
  } catch { /* permission errors, etc. */ }

  return results;
}

/**
 * Detect the test command from package.json (same logic as engine.js).
 * @param {string} cwd
 * @returns {string|null}
 */
function detectTestCommand(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
        return 'npm test';
      }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    return 'python -m pytest -x --tb=short';
  }

  return null;
}

/**
 * Run the full test suite.
 * @param {string} cwd
 * @param {object} opts
 * @returns {{ passed: boolean, total_tests: number, passed_tests: number, failed_tests: number, testResults: object[], duration_ms: number }}
 */
function runRegressionSuite(cwd, opts = {}) {
  const start = Date.now();
  const timeout = (opts.timeout || 300) * 1000;
  const command = opts.testCommand || detectTestCommand(cwd);

  if (!command) {
    return {
      passed: true,
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      testResults: [],
      duration_ms: Date.now() - start,
      skipped: true,
      reason: 'No test command detected',
    };
  }

  const result = spawnSync('bash', ['-c', command], {
    cwd,
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = stdout + '\n' + stderr;

  // Try to parse test counts from common frameworks
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  // Jest / Vitest format: Tests: 5 passed, 2 failed, 7 total
  const jestMatch = combined.match(/Tests:\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+total)?/);
  if (jestMatch) {
    passedTests = parseInt(jestMatch[1], 10) || 0;
    failedTests = parseInt(jestMatch[2], 10) || 0;
    totalTests = parseInt(jestMatch[3], 10) || (passedTests + failedTests);
  }

  // Pytest format: X passed, Y failed
  const pytestMatch = combined.match(/(\d+)\s+passed(?:.*?(\d+)\s+failed)?/);
  if (!jestMatch && pytestMatch) {
    passedTests = parseInt(pytestMatch[1], 10) || 0;
    failedTests = parseInt(pytestMatch[2], 10) || 0;
    totalTests = passedTests + failedTests;
  }

  // Node test runner: # tests N, # pass N, # fail N
  const nodeMatch = combined.match(/# tests\s+(\d+)[\s\S]*?# pass\s+(\d+)[\s\S]*?# fail\s+(\d+)/);
  if (!jestMatch && !pytestMatch && nodeMatch) {
    totalTests = parseInt(nodeMatch[1], 10) || 0;
    passedTests = parseInt(nodeMatch[2], 10) || 0;
    failedTests = parseInt(nodeMatch[3], 10) || 0;
  }

  // Fallback: if we couldn't parse counts, use exit code
  if (totalTests === 0 && result.status === 0) {
    totalTests = 1;
    passedTests = 1;
  } else if (totalTests === 0 && result.status !== 0) {
    totalTests = 1;
    failedTests = 1;
  }

  return {
    passed: result.status === 0,
    total_tests: totalTests,
    passed_tests: passedTests,
    failed_tests: failedTests,
    testResults: [{
      command,
      exit_code: result.status ?? 1,
      timed_out: result.signal === 'SIGTERM',
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
    }],
    duration_ms: Date.now() - start,
  };
}

/**
 * Compare current test results against a saved baseline.
 * @param {string} cwd
 * @param {object} currentResults - Result from runRegressionSuite
 * @returns {{ regressions: object[], regression_score: number, new_tests: number, removed_tests: number }}
 */
function compareWithBaseline(cwd, currentResults) {
  const baselinePath = path.join(cwd, '.forge', 'test-baseline.json');

  if (!fs.existsSync(baselinePath)) {
    return {
      regressions: [],
      regression_score: 0,
      new_tests: currentResults.total_tests,
      removed_tests: 0,
      has_baseline: false,
    };
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    return {
      regressions: [],
      regression_score: 0,
      new_tests: currentResults.total_tests,
      removed_tests: 0,
      has_baseline: false,
    };
  }

  const regressions = [];

  // Test count regression: previously N tests passed, now fewer pass
  if (baseline.passed_tests > 0 && currentResults.passed_tests < baseline.passed_tests) {
    regressions.push({
      test_file: '(suite-level)',
      error: `Previously ${baseline.passed_tests} tests passed, now only ${currentResults.passed_tests} pass`,
    });
  }

  // New failures: suite was passing, now failing
  if (baseline.passed && !currentResults.passed) {
    regressions.push({
      test_file: '(suite-level)',
      error: `Test suite was passing in baseline but now fails (exit code ${currentResults.testResults[0]?.exit_code || 'unknown'})`,
    });
  }

  // Failed count increased
  if (currentResults.failed_tests > (baseline.failed_tests || 0)) {
    const newFailures = currentResults.failed_tests - (baseline.failed_tests || 0);
    regressions.push({
      test_file: '(suite-level)',
      error: `${newFailures} new test failure(s) compared to baseline`,
    });
  }

  const newTests = Math.max(0, currentResults.total_tests - baseline.total_tests);
  const removedTests = Math.max(0, baseline.total_tests - currentResults.total_tests);
  const regressionScore = baseline.total_tests > 0
    ? regressions.length / baseline.total_tests
    : 0;

  return {
    regressions,
    regression_score: Math.min(1, regressionScore),
    new_tests: newTests,
    removed_tests: removedTests,
    has_baseline: true,
  };
}

/**
 * Save current test results as the new baseline.
 * Only saves if all tests pass.
 * @param {string} cwd
 * @param {object} results - Result from runRegressionSuite
 * @param {number} phaseNumber
 */
function saveBaseline(cwd, results, phaseNumber) {
  if (!results.passed) return;

  const forgeDir = path.join(cwd, '.forge');
  if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });

  const baseline = {
    passed: results.passed,
    total_tests: results.total_tests,
    passed_tests: results.passed_tests,
    failed_tests: results.failed_tests,
    phase: phaseNumber || 0,
    saved_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(forgeDir, 'test-baseline.json'), JSON.stringify(baseline, null, 2));
}

/**
 * Orchestrator: run suite, compare baseline, return layer-compatible result.
 * @param {string} cwd
 * @param {object} opts
 * @returns {{ passed: boolean, skipped: boolean, regressions: object[], regression_score: number, duration_ms: number, issues: object[] }}
 */
function runRegression(cwd, opts = {}) {
  const suiteResult = runRegressionSuite(cwd, opts);

  if (suiteResult.skipped) {
    return {
      passed: true,
      skipped: true,
      regressions: [],
      regression_score: 0,
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      duration_ms: suiteResult.duration_ms,
      issues: [],
      reason: suiteResult.reason,
    };
  }

  const comparison = compareWithBaseline(cwd, suiteResult);

  const issues = comparison.regressions.map(r => ({
    type: 'regression',
    file: r.test_file,
    message: r.error,
    severity: 'error',
  }));

  return {
    passed: suiteResult.passed && comparison.regressions.length === 0,
    skipped: false,
    regressions: comparison.regressions,
    regression_score: comparison.regression_score,
    total_tests: suiteResult.total_tests,
    passed_tests: suiteResult.passed_tests,
    failed_tests: suiteResult.failed_tests,
    new_tests: comparison.new_tests,
    removed_tests: comparison.removed_tests,
    has_baseline: comparison.has_baseline,
    duration_ms: suiteResult.duration_ms,
    issues,
  };
}

module.exports = {
  discoverAllTests,
  runRegressionSuite,
  compareWithBaseline,
  saveBaseline,
  runRegression,
};
