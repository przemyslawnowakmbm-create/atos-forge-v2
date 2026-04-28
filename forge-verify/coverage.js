'use strict';

/**
 * Code Coverage Collection
 *
 * Detects coverage tools, wraps test commands with coverage flags,
 * parses coverage reports, and checks against thresholds.
 *
 * Usage:
 *   const { collectCoverage } = require('./coverage');
 *   const result = collectCoverage(cwd, { minLineCoverage: 80 });
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Detect which coverage tool is available.
 * @param {string} cwd
 * @returns {{ tool: string|null, detected_from: string }}
 */
function detectCoverageTool(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = {
        ...(pkg.devDependencies || {}),
        ...(pkg.dependencies || {}),
      };

      // Check in priority order (most specific first)
      if (allDeps['@vitest/coverage-v8']) return { tool: 'vitest-v8', detected_from: '@vitest/coverage-v8 in devDependencies' };
      if (allDeps['@vitest/coverage-istanbul']) return { tool: 'vitest-istanbul', detected_from: '@vitest/coverage-istanbul in devDependencies' };
      if (allDeps['c8']) return { tool: 'c8', detected_from: 'c8 in devDependencies' };
      if (allDeps['nyc']) return { tool: 'nyc', detected_from: 'nyc in devDependencies' };

      // Check if vitest is used (has built-in coverage support)
      if (allDeps['vitest']) return { tool: 'vitest', detected_from: 'vitest in devDependencies' };

      // Jest has built-in coverage
      if (allDeps['jest'] || allDeps['@jest/core']) return { tool: 'jest', detected_from: 'jest in devDependencies' };

      // Check test script for hints
      const testCmd = pkg.scripts && pkg.scripts.test;
      if (testCmd) {
        if (testCmd.includes('vitest')) return { tool: 'vitest', detected_from: 'vitest in test script' };
        if (testCmd.includes('jest')) return { tool: 'jest', detected_from: 'jest in test script' };
        if (testCmd.includes('mocha')) return { tool: 'c8', detected_from: 'mocha in test script (c8 wrapper)' };
      }
    } catch { /* ignore parse errors */ }
  }

  // Python coverage
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    try {
      const pyprojectContent = fs.existsSync(path.join(cwd, 'pyproject.toml'))
        ? fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8')
        : '';
      if (pyprojectContent.includes('pytest-cov')) return { tool: 'pytest-cov', detected_from: 'pytest-cov in pyproject.toml' };
    } catch { /* ignore */ }
    return { tool: 'pytest-cov', detected_from: 'Python project detected (fallback)' };
  }

  return { tool: null, detected_from: 'none' };
}

/**
 * Build a coverage-enabled test command.
 * @param {string} baseCommand - Original test command (e.g. 'npm test')
 * @param {string} tool - Coverage tool name from detectCoverageTool
 * @param {string} cwd
 * @returns {{ command: string, reportPath: string }}
 */
function buildCoverageCommand(baseCommand, tool, cwd) {
  const coverageDir = path.join(cwd, '.forge', 'coverage');

  switch (tool) {
    case 'jest':
      return {
        command: `npx jest --coverage --coverageReporters=json-summary --coverageDirectory=${coverageDir}`,
        reportPath: path.join(coverageDir, 'coverage-summary.json'),
      };

    case 'vitest':
    case 'vitest-v8':
    case 'vitest-istanbul':
      return {
        command: `npx vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=${coverageDir}`,
        reportPath: path.join(coverageDir, 'coverage-summary.json'),
      };

    case 'c8':
      return {
        command: `npx c8 --reporter=json-summary --report-dir=${coverageDir} ${baseCommand}`,
        reportPath: path.join(coverageDir, 'coverage-summary.json'),
      };

    case 'nyc':
      return {
        command: `npx nyc --reporter=json-summary --report-dir=${coverageDir} ${baseCommand}`,
        reportPath: path.join(coverageDir, 'coverage-summary.json'),
      };

    case 'pytest-cov':
      return {
        command: `${baseCommand} --cov=. --cov-report=json:${path.join(coverageDir, 'coverage-summary.json')}`,
        reportPath: path.join(coverageDir, 'coverage-summary.json'),
      };

    default:
      return { command: baseCommand, reportPath: '' };
  }
}

/**
 * Parse a coverage JSON report.
 * Handles jest/c8/nyc format (coverage-summary.json with `total` key)
 * and pytest-cov format.
 * @param {string} cwd
 * @param {string} reportPath
 * @returns {{ aggregate: object, per_file: object[] }|null}
 */
function parseCoverageReport(cwd, reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) return null;

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }

  // Jest / c8 / nyc format: { total: { lines: { pct: N }, ... }, file1: { ... }, ... }
  if (report.total) {
    const aggregate = {
      lines: report.total.lines ? report.total.lines.pct : 0,
      branches: report.total.branches ? report.total.branches.pct : 0,
      functions: report.total.functions ? report.total.functions.pct : 0,
      statements: report.total.statements ? report.total.statements.pct : 0,
    };

    const perFile = [];
    for (const [filePath, data] of Object.entries(report)) {
      if (filePath === 'total') continue;
      perFile.push({
        file: path.relative(cwd, filePath),
        lines: data.lines ? data.lines.pct : 0,
        branches: data.branches ? data.branches.pct : 0,
        functions: data.functions ? data.functions.pct : 0,
      });
    }

    return { aggregate, per_file: perFile };
  }

  // Pytest-cov JSON format: { totals: { percent_covered: N }, files: { ... } }
  if (report.totals) {
    const aggregate = {
      lines: report.totals.percent_covered || 0,
      branches: report.totals.percent_covered_branches || 0,
      functions: 0, // pytest-cov doesn't track function coverage
      statements: report.totals.percent_covered || 0,
    };

    const perFile = [];
    if (report.files) {
      for (const [filePath, data] of Object.entries(report.files)) {
        perFile.push({
          file: path.relative(cwd, filePath),
          lines: data.summary ? data.summary.percent_covered : 0,
          branches: data.summary ? (data.summary.percent_covered_branches || 0) : 0,
          functions: 0,
        });
      }
    }

    return { aggregate, per_file: perFile };
  }

  return null;
}

/**
 * Detect the base test command from package.json or project files.
 * @param {string} cwd
 * @returns {string|null}
 */
function detectBaseTestCommand(cwd) {
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
    return 'python -m pytest';
  }
  return null;
}

/**
 * Orchestrator: detect tool, build command, run, parse, threshold check.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.tool] - Force a specific coverage tool
 * @param {number} [opts.minLineCoverage] - Minimum line coverage percentage (0-100)
 * @param {boolean} [opts.failBelowThreshold] - Fail if coverage is below threshold
 * @param {number} [opts.timeout] - Test timeout in seconds
 * @returns {{ passed: boolean, skipped: boolean, aggregate: object|null, per_file: object[]|null, meets_threshold: boolean, tool_used: string|null, duration_ms: number, issues: object[] }}
 */
function collectCoverage(cwd, opts = {}) {
  const start = Date.now();
  const issues = [];

  // Detect tool
  const detection = opts.tool
    ? { tool: opts.tool, detected_from: 'user override' }
    : detectCoverageTool(cwd);

  if (!detection.tool) {
    return {
      passed: true,
      skipped: true,
      aggregate: null,
      per_file: null,
      meets_threshold: true,
      tool_used: null,
      duration_ms: Date.now() - start,
      issues: [],
      reason: 'No coverage tool detected',
    };
  }

  // Build command
  const baseCommand = detectBaseTestCommand(cwd) || 'npm test';
  const { command, reportPath } = buildCoverageCommand(baseCommand, detection.tool, cwd);

  // Ensure coverage directory exists
  const coverageDir = path.join(cwd, '.forge', 'coverage');
  if (!fs.existsSync(coverageDir)) fs.mkdirSync(coverageDir, { recursive: true });

  // Run tests with coverage
  const timeout = (opts.timeout || 300) * 1000;
  const result = spawnSync('bash', ['-c', command], {
    cwd,
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    issues.push({
      type: 'test_failure',
      message: `Tests failed with exit code ${result.status}`,
      severity: 'error',
    });
  }

  if (result.signal === 'SIGTERM') {
    issues.push({
      type: 'timeout',
      message: `Coverage collection timed out after ${opts.timeout || 300}s`,
      severity: 'error',
    });
  }

  // Parse report
  const parsed = parseCoverageReport(cwd, reportPath);

  if (!parsed) {
    return {
      passed: result.status === 0,
      skipped: false,
      aggregate: null,
      per_file: null,
      meets_threshold: true,
      tool_used: detection.tool,
      duration_ms: Date.now() - start,
      issues: [...issues, {
        type: 'parse_failure',
        message: 'Could not parse coverage report — report file may not have been generated',
        severity: 'warning',
      }],
    };
  }

  // Threshold check
  const minLine = opts.minLineCoverage ?? 0;
  const meetsThreshold = parsed.aggregate.lines >= minLine;

  if (!meetsThreshold && minLine > 0) {
    issues.push({
      type: 'below_threshold',
      message: `Line coverage ${parsed.aggregate.lines.toFixed(1)}% is below minimum ${minLine}%`,
      severity: opts.failBelowThreshold ? 'error' : 'warning',
    });
  }

  const passed = result.status === 0 && (!opts.failBelowThreshold || meetsThreshold);

  return {
    passed,
    skipped: false,
    aggregate: parsed.aggregate,
    per_file: parsed.per_file,
    meets_threshold: meetsThreshold,
    tool_used: detection.tool,
    detected_from: detection.detected_from,
    command_used: command,
    duration_ms: Date.now() - start,
    issues,
  };
}

module.exports = {
  detectCoverageTool,
  buildCoverageCommand,
  parseCoverageReport,
  collectCoverage,
};
