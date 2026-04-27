#!/usr/bin/env node
'use strict';

/**
 * 7-Layer Verification Engine — graph-aware, fail-fast verification pipeline.
 *
 * Layers (run in order, fail-fast):
 *   1. STRUCTURAL   (<5s)    — syntax errors, stray console.log/debugger
 *   2. TYPE/COMPILE  (10-30s) — tsc --noEmit, mypy, go build as applicable
 *   3. INTERFACE     (5-15s)  — graph contract hashes → detect breaks → verify consumers
 *   4. DEPENDENCY    (<5s)    — new circular deps, orphaned imports
 *   5. TESTS         (30s-5m) — graph-identified test files + integration
 *   6. BEHAVIORAL    (varies) — plan's custom verify steps (curl, CLI, etc.)
 *   7. CONTRACT      (5-30s)  — cross-repo contract verification (code↔YAML drift,
 *                                backward compat, consumer ripple via system-graph.db)
 *
 * Output: { overall, layers[], fix_suggestions[], auto_fixable, graph_diff }
 *
 * Usage:
 *   node forge-verify/engine.js --root . [--files f1,f2] [--plan plan.md]
 *       [--db path] [--layer 1-7] [--fail-fast] [--json] [--baseline db]
 *   Programmatic:
 *     const { verify } = require('./engine');
 *     const result = await verify({ cwd, files, plan, dbPath, ... });
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { resolveProvider, buildInvocation } = require('../forge-agents/provider');

let cache; try { cache = require('./cache'); } catch { cache = null; }

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
// Constants
// ============================================================

const LAYER_NAMES = [
  'STRUCTURAL',
  'TYPE_COMPILE',
  'INTERFACE_CONTRACTS',
  'DEPENDENCY',
  'TESTS',
  'BEHAVIORAL',
  'CONTRACT',
  'ARCHITECTURAL',
  'BROWSER',
];

const LAYER_ICONS = { pass: '\u2705', fail: '\u274C', skip: '\u23ED\uFE0F' };

const STRUCTURAL_PATTERNS = [
  { pattern: /\bconsole\.(log|warn|info|debug|trace)\b/, label: 'console.log/warn/info/debug/trace', severity: 'warning' },
  { pattern: /\bdebugger\b/, label: 'debugger statement', severity: 'error' },
  { pattern: /\bTODO\s*:\s*FIXME\b/i, label: 'TODO:FIXME marker', severity: 'warning' },
  { pattern: /<<<<<<< |>>>>>>> |=======/, label: 'merge conflict marker', severity: 'error' },
];

const COMPILE_COMMANDS = {
  typescript: { detect: 'tsconfig.json', command: 'npx tsc --noEmit', label: 'TypeScript', timeout: 60 },
  python:     { detect: 'pyproject.toml', command: 'python -m mypy .', label: 'mypy', timeout: 120 },
  go:         { detect: 'go.mod', command: 'go build ./...', label: 'Go build', timeout: 120 },
};

/**
 * Search for tsconfig.json broadly: cwd, parent dirs, common subdirs.
 * Returns { found: boolean, tsconfigPath?: string, projectDir?: string }.
 */
function findTsConfig(cwd) {
  // 1. Check cwd itself
  const direct = path.join(cwd, 'tsconfig.json');
  if (fs.existsSync(direct)) return { found: true, tsconfigPath: direct, projectDir: cwd };

  // 2. Walk up parent directories (max 5 levels)
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return { found: true, tsconfigPath: candidate, projectDir: dir };
  }

  // 3. Check common subdirectories
  const subdirs = ['src', 'lib', 'app', 'packages'];
  for (const sub of subdirs) {
    const subDir = path.join(cwd, sub);
    if (!fs.existsSync(subDir)) continue;

    const candidate = path.join(subDir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return { found: true, tsconfigPath: candidate, projectDir: subDir };

    // Check packages/*/tsconfig.json (monorepo)
    if (sub === 'packages') {
      try {
        const entries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const pkgCandidate = path.join(subDir, entry.name, 'tsconfig.json');
          if (fs.existsSync(pkgCandidate)) return { found: true, tsconfigPath: pkgCandidate, projectDir: path.join(subDir, entry.name) };
        }
      } catch { /* ignore */ }
    }
  }

  return { found: false };
}

const MAX_STRUCTURAL_ISSUES = 50; // cap per file scan

// ============================================================
// Layer 1 — STRUCTURAL
// ============================================================

/**
 * Fast syntax and hygiene checks. Reads files directly, no external tools needed.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.files - relative paths
 * @returns {{ passed: boolean, issues: object[], duration_ms: number }}
 */
function layerStructural(opts) {
  const start = Date.now();
  const issues = [];
  const files = opts.files || [];

  for (const relPath of files) {
    const absPath = path.resolve(opts.cwd, relPath);
    if (!fs.existsSync(absPath)) continue;

    let content;
    try { content = fs.readFileSync(absPath, 'utf8'); }
    catch { continue; }

    const lines = content.split('\n');
    const ext = path.extname(relPath).toLowerCase();

    // Skip non-source files
    if (['.json', '.md', '.txt', '.yaml', '.yml', '.lock', '.svg', '.png', '.jpg', '.gif', '.ico', '.woff', '.ttf'].includes(ext)) continue;
    if (relPath.includes('node_modules/') || relPath.includes('vendor/') || relPath.includes('.min.')) continue;

    for (let i = 0; i < lines.length && issues.length < MAX_STRUCTURAL_ISSUES; i++) {
      const line = lines[i];
      for (const { pattern, label, severity } of STRUCTURAL_PATTERNS) {
        if (pattern.test(line)) {
          issues.push({
            file: relPath,
            line: i + 1,
            label,
            severity,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    }

    // Check for syntax — basic brace/bracket/paren matching for JS/TS
    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      const syntaxIssue = checkBracketBalance(content, relPath);
      if (syntaxIssue) issues.push(syntaxIssue);
    }
  }

  return {
    passed: !issues.some(i => i.severity === 'error'),
    issues,
    duration_ms: Date.now() - start,
  };
}

/**
 * Basic bracket/brace/paren balance check (not a full parser, but catches obvious issues).
 */
function checkBracketBalance(content, filePath) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set([')', ']', '}']);
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;
  let lineNum = 1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    if (ch === '\n') { lineNum++; inLineComment = false; continue; }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }

    // Toggle string state
    if (!inString && (ch === '"' || ch === "'" || ch === '`') && prev !== '\\') {
      inString = true; stringChar = ch; continue;
    }
    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }

    // Comments
    if (ch === '/' && i + 1 < content.length) {
      if (content[i + 1] === '/') { inLineComment = true; continue; }
      if (content[i + 1] === '*') { inBlockComment = true; continue; }
    }

    if (pairs[ch]) {
      stack.push({ char: ch, line: lineNum });
    } else if (closers.has(ch)) {
      if (stack.length === 0) {
        return { file: filePath, line: lineNum, label: `unmatched '${ch}'`, severity: 'error', snippet: '' };
      }
      const top = stack.pop();
      if (pairs[top.char] !== ch) {
        return {
          file: filePath, line: lineNum,
          label: `expected '${pairs[top.char]}' (opened line ${top.line}) but got '${ch}'`,
          severity: 'error', snippet: '',
        };
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      file: filePath, line: unclosed.line,
      label: `unclosed '${unclosed.char}' (never closed)`,
      severity: 'error', snippet: '',
    };
  }
  return null;
}

// ============================================================
// Layer 2 — TYPE / COMPILE
// ============================================================

/**
 * Run type-checker / compiler for detected languages.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.files - changed files (used to determine which compilers to run)
 * @param {object} [opts.capabilities] - graph capabilities per module
 * @returns {{ passed: boolean, checks: object[], duration_ms: number }}
 */
function layerTypeCompile(opts) {
  const start = Date.now();
  const checks = [];

  // Determine which languages are in play
  const extensions = new Set(opts.files.map(f => path.extname(f).toLowerCase()));
  const languages = new Set();
  if (extensions.has('.ts') || extensions.has('.tsx')) languages.add('typescript');
  if (extensions.has('.py')) languages.add('python');
  if (extensions.has('.go')) languages.add('go');

  // Also check capabilities from graph
  if (opts.capabilities) {
    for (const [, caps] of Object.entries(opts.capabilities)) {
      for (const cap of (Array.isArray(caps) ? caps : [])) {
        const name = cap.capability || cap;
        if (typeof name === 'string' && name.includes('typescript')) languages.add('typescript');
        if (typeof name === 'string' && name.includes('python')) languages.add('python');
        if (typeof name === 'string' && name.includes('go')) languages.add('go');
      }
    }
  }

  // Allow config overrides for compile commands
  const configOverrides = opts.config && opts.config.verification ? opts.config.verification : {};

  for (const lang of languages) {
    const spec = COMPILE_COMMANDS[lang];
    if (!spec) continue;

    // Check if this layer/language is disabled via config
    if (configOverrides.layers && configOverrides.layers[lang] === false) {
      checks.push({ language: lang, label: spec.label, status: 'skip', reason: 'disabled via config', duration_ms: 0 });
      continue;
    }

    let command = configOverrides.type_check_command || null;
    let runCwd = opts.cwd;

    if (lang === 'typescript') {
      // Broad tsconfig discovery
      const tsResult = findTsConfig(opts.cwd);

      if (tsResult.found) {
        // Use --project flag pointing to discovered tsconfig
        command = command || `npx tsc --noEmit --project ${tsResult.tsconfigPath}`;
        runCwd = tsResult.projectDir;
      } else {
        // No tsconfig found — fall back to tsc --noEmit --strict on changed .ts files directly
        const tsFiles = (opts.files || [])
          .filter(f => /\.(ts|tsx)$/.test(f))
          .map(f => path.isAbsolute(f) ? f : path.join(opts.cwd, f));
        if (tsFiles.length === 0) {
          checks.push({ language: lang, label: spec.label, status: 'skip', reason: 'no .ts files in changeset', duration_ms: 0 });
          continue;
        }
        command = `npx tsc --noEmit --strict --esModuleInterop --resolveJsonModule ${tsFiles.join(' ')}`;
      }
    } else {
      // Python, Go — simple root-level detect
      if (!fs.existsSync(path.join(opts.cwd, spec.detect))) {
        checks.push({ language: lang, label: spec.label, status: 'skip', reason: `${spec.detect} not found`, duration_ms: 0 });
        continue;
      }
      command = command || spec.command;
    }

    const result = spawnSync('bash', ['-c', command], {
      cwd: runCwd,
      timeout: spec.timeout * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    checks.push({
      language: lang,
      label: spec.label,
      status: result.status === 0 ? 'pass' : 'fail',
      exit_code: result.status ?? 1,
      duration_ms: 0, // filled below
      timed_out: result.signal === 'SIGTERM',
      stdout: (result.stdout || '').slice(-3000),
      stderr: (result.stderr || '').slice(-3000),
      errors: parseCompileErrors(result.stderr || result.stdout || '', lang),
      command_used: command,
    });
  }

  const duration = Date.now() - start;
  checks.forEach(c => { if (!c.duration_ms) c.duration_ms = duration; });

  return {
    passed: checks.every(c => c.status !== 'fail'),
    checks,
    duration_ms: duration,
  };
}

/**
 * Parse compiler output into structured errors.
 */
function parseCompileErrors(output, language) {
  const errors = [];
  const lines = output.split('\n');

  for (const line of lines) {
    let match;
    if (language === 'typescript') {
      // file.ts(10,5): error TS1234: message
      match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
      if (match) {
        errors.push({ file: match[1], line: +match[2], col: +match[3], code: match[4], message: match[5] });
      }
    } else if (language === 'python') {
      // file.py:10: error: message [code]
      match = line.match(/^(.+?):(\d+):\s*error:\s*(.+)/);
      if (match) {
        errors.push({ file: match[1], line: +match[2], message: match[3] });
      }
    } else if (language === 'go') {
      // file.go:10:5: message
      match = line.match(/^(.+?\.go):(\d+):(\d+):\s*(.+)/);
      if (match) {
        errors.push({ file: match[1], line: +match[2], col: +match[3], message: match[4] });
      }
    }
    if (errors.length >= 30) break;
  }
  return errors;
}

// ============================================================
// Layer 3 — INTERFACE CONTRACTS
// ============================================================

/**
 * Check if changed files broke interface contracts (signature hash changes on
 * high-consumer interfaces).
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.dbPath
 * @param {string[]} opts.files - changed files (relative)
 * @param {string} [opts.baselineDbPath] - baseline graph.db for comparison
 * @returns {{ passed: boolean, breakingChanges: object[], consumerRisk: object[], duration_ms: number }}
 */
function layerInterfaceContracts(opts) {
  const start = Date.now();
  const breakingChanges = [];
  const consumerRisk = [];

  let GraphQuery;
  try { GraphQuery = require('../forge-graph/query').GraphQuery; }
  catch { GraphQuery = null; }

  if (!GraphQuery || !opts.dbPath || !fs.existsSync(opts.dbPath)) {
    return { passed: true, breakingChanges: [], consumerRisk: [], duration_ms: Date.now() - start, skipped: true, reason: 'Graph DB not available' };
  }

  const gq = new GraphQuery(opts.dbPath);
  try {
    gq.open();

    // Get current interfaces for changed files
    const currentInterfaces = [];
    for (const fp of opts.files) {
      const ifaces = gq.db.prepare(`
        SELECT i.name, i.kind, i.file, i.consumer_count, i.contract_hash
        FROM interfaces i WHERE i.file = ?
      `).all(fp);
      currentInterfaces.push(...ifaces);
    }

    // If we have a baseline, compare contract hashes
    if (opts.baselineDbPath && fs.existsSync(opts.baselineDbPath)) {
      const diff = gq.getGraphDiff(opts.baselineDbPath);
      if (diff.interfaces && diff.interfaces.breakingChanges) {
        // Filter to only changes in our files
        const changedSet = new Set(opts.files);
        for (const bc of diff.interfaces.breakingChanges) {
          if (changedSet.has(bc.file)) {
            breakingChanges.push({
              name: bc.name,
              file: bc.file,
              hash_before: bc.hashBefore,
              hash_after: bc.hashAfter,
              consumers_before: bc.consumersBefore,
              consumers_after: bc.consumersAfter,
            });
          }
        }
      }
    }

    // Check consumer risk for high-consumer interfaces in changed files
    for (const iface of currentInterfaces) {
      if (iface.consumer_count > 5) {
        consumerRisk.push({
          name: iface.name,
          file: iface.file,
          consumer_count: iface.consumer_count,
          contract_hash: iface.contract_hash,
          risk: iface.consumer_count > 15 ? 'CRITICAL' : iface.consumer_count > 10 ? 'HIGH' : 'MEDIUM',
        });
      }
    }

    // If there are breaking changes on high-consumer interfaces, try to compile
    // their consumers to verify they still work
    if (breakingChanges.length > 0) {
      for (const bc of breakingChanges) {
        const consumers = gq.db.prepare(`
          SELECT d.source_file FROM dependencies d
          WHERE d.target_file = ? AND d.import_name = ?
        `).all(bc.file, bc.name);
        bc.affected_consumers = consumers.map(c => c.source_file);
        bc.consumer_count_actual = consumers.length;
      }
    }
  } finally {
    try { gq.db.close(); } catch { /* ignore */ }
  }

  return {
    passed: breakingChanges.length === 0,
    breakingChanges,
    consumerRisk,
    duration_ms: Date.now() - start,
  };
}

// ============================================================
// Layer 4 — DEPENDENCY
// ============================================================

/**
 * Check for new circular dependencies and orphaned imports.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.dbPath
 * @param {string[]} opts.files
 * @param {number} [opts.baselineCycleCount] - cycle count from before changes
 * @returns {{ passed: boolean, newCycles: object[], orphanedImports: object[], cycleCount: number, duration_ms: number }}
 */
function layerDependency(opts) {
  const start = Date.now();

  let GraphQuery;
  try { GraphQuery = require('../forge-graph/query').GraphQuery; }
  catch { GraphQuery = null; }

  if (!GraphQuery || !opts.dbPath || !fs.existsSync(opts.dbPath)) {
    return { passed: true, newCycles: [], orphanedImports: [], cycleCount: 0, duration_ms: Date.now() - start, skipped: true, reason: 'Graph DB not available' };
  }

  const gq = new GraphQuery(opts.dbPath);
  try {
    gq.open();

    // Check cycles
    const cycleResult = gq.getCycles();
    const cycleCount = cycleResult.count;

    // Find cycles that involve our changed files
    const changedSet = new Set(opts.files);
    const newCycles = [];
    for (const cycle of cycleResult.cycles) {
      if (cycle.some(fp => changedSet.has(fp))) {
        newCycles.push(cycle);
      }
    }

    // Check for orphaned imports — files that import targets not in the graph
    const orphanedImports = [];
    for (const fp of opts.files) {
      const deps = gq.db.prepare(`
        SELECT d.target_file, d.import_name, d.import_type
        FROM dependencies d WHERE d.source_file = ?
      `).all(fp);

      for (const dep of deps) {
        // Check if target file exists in graph
        const target = gq.db.prepare('SELECT path FROM files WHERE path = ?').get(dep.target_file);
        if (!target) {
          // Check if it's a known external/node_modules import
          if (!dep.target_file.includes('node_modules/') && !dep.import_type.includes('external')) {
            orphanedImports.push({
              source: fp,
              target: dep.target_file,
              import_name: dep.import_name,
            });
          }
        }
      }
    }

    const baseline = opts.baselineCycleCount ?? 0;
    const cyclesIncreased = cycleCount > baseline;

    return {
      passed: newCycles.length === 0 && orphanedImports.length === 0 && !cyclesIncreased,
      newCycles,
      orphanedImports,
      cycleCount,
      baselineCycleCount: baseline,
      cyclesIncreased,
      duration_ms: Date.now() - start,
    };
  } finally {
    try { gq.db.close(); } catch { /* ignore */ }
  }
}

// ============================================================
// Layer 5 — TESTS
// ============================================================

/**
 * Run tests identified by the graph as relevant to changed files.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.dbPath
 * @param {string[]} opts.files
 * @param {number} [opts.timeout=300] - seconds
 * @returns {{ passed: boolean, testResults: object[], testFiles: string[], duration_ms: number }}
 */
function layerTests(opts) {
  const start = Date.now();
  const timeout = (opts.timeout ?? 300) * 1000;
  const configOverrides = opts.config || {};

  // If config specifies a custom test_command, run it directly
  if (configOverrides.test_command) {
    const result = spawnSync('bash', ['-c', configOverrides.test_command], {
      cwd: opts.cwd, timeout, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    return {
      passed: result.status === 0,
      testResults: [{
        runner: 'config_override',
        command: configOverrides.test_command,
        passed: result.status === 0,
        exit_code: result.status ?? 1,
        timed_out: result.signal === 'SIGTERM',
        stdout: (result.stdout || '').slice(-4000),
        stderr: (result.stderr || '').slice(-4000),
      }],
      testFiles: [],
      duration_ms: Date.now() - start,
    };
  }

  // Collect test files from graph
  let testFiles = [];
  let GraphQuery;
  try { GraphQuery = require('../forge-graph/query').GraphQuery; }
  catch { GraphQuery = null; }

  if (GraphQuery && opts.dbPath && fs.existsSync(opts.dbPath)) {
    const gq = new GraphQuery(opts.dbPath);
    try {
      gq.open();
      const ctx = gq.getContextForTask(opts.files);
      testFiles = (ctx.testFiles || []).map(t => t.path);
    } finally {
      try { gq.db.close(); } catch { /* ignore */ }
    }
  }

  // Also check if changed files are themselves test files
  const directTests = opts.files.filter(f =>
    f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__/') || f.includes('/test/')
  );
  const allTests = [...new Set([...testFiles, ...directTests])];

  if (allTests.length === 0) {
    // Fall back to project-level test runner
    return runProjectTests(opts.cwd, timeout, start);
  }

  // Run tests for specific files
  const testResults = [];
  const cwd = opts.cwd;

  // Group by test runner type
  const jsTests = allTests.filter(f => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f));
  const pyTests = allTests.filter(f => f.endsWith('.py'));

  // JavaScript tests — try jest/mocha/node:test
  if (jsTests.length > 0) {
    const result = runJsTests(cwd, jsTests, timeout);
    testResults.push(result);
  }

  // Python tests
  if (pyTests.length > 0) {
    const result = runPyTests(cwd, pyTests, timeout);
    testResults.push(result);
  }

  return {
    passed: testResults.every(r => r.passed),
    testResults,
    testFiles: allTests,
    duration_ms: Date.now() - start,
  };
}

function runJsTests(cwd, files, timeout) {
  // Detect test runner
  let command;
  const hasPkg = fs.existsSync(path.join(cwd, 'package.json'));
  if (hasPkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const testCmd = pkg.scripts && pkg.scripts.test;
      if (testCmd && !testCmd.includes('no test specified')) {
        // Use project test command but scope to specific files if possible
        if (testCmd.includes('jest') || testCmd.includes('vitest')) {
          command = `npx jest --passWithNoTests --bail ${files.join(' ')}`;
        } else if (testCmd.includes('mocha')) {
          command = `npx mocha --bail ${files.join(' ')}`;
        } else {
          command = 'npm test';
        }
      }
    } catch { /* ignore */ }
  }

  if (!command) {
    // Node built-in test runner
    command = `node --test ${files.join(' ')}`;
  }

  const result = spawnSync('bash', ['-c', command], {
    cwd, timeout, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });

  return {
    runner: 'javascript',
    command,
    passed: result.status === 0,
    exit_code: result.status ?? 1,
    timed_out: result.signal === 'SIGTERM',
    stdout: (result.stdout || '').slice(-4000),
    stderr: (result.stderr || '').slice(-4000),
    file_count: files.length,
  };
}

function runPyTests(cwd, files, timeout) {
  const command = `python -m pytest -x --tb=short ${files.join(' ')}`;
  const result = spawnSync('bash', ['-c', command], {
    cwd, timeout, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });

  return {
    runner: 'python',
    command,
    passed: result.status === 0,
    exit_code: result.status ?? 1,
    timed_out: result.signal === 'SIGTERM',
    stdout: (result.stdout || '').slice(-4000),
    stderr: (result.stderr || '').slice(-4000),
    file_count: files.length,
  };
}

function runProjectTests(cwd, timeout, start) {
  // No specific test files found — run project-level test command
  let command = null;

  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
        command = 'npm test';
      }
    } catch { /* ignore */ }
  }
  if (!command && fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    command = 'python -m pytest -x --tb=short';
  }

  if (!command) {
    return {
      passed: true,
      testResults: [],
      testFiles: [],
      skipped: true,
      reason: 'No test files or test runner found',
      duration_ms: Date.now() - start,
    };
  }

  const result = spawnSync('bash', ['-c', command], {
    cwd, timeout, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });

  return {
    passed: result.status === 0,
    testResults: [{
      runner: 'project',
      command,
      passed: result.status === 0,
      exit_code: result.status ?? 1,
      timed_out: result.signal === 'SIGTERM',
      stdout: (result.stdout || '').slice(-4000),
      stderr: (result.stderr || '').slice(-4000),
    }],
    testFiles: [],
    duration_ms: Date.now() - start,
  };
}

// ============================================================
// Layer 6 — BEHAVIORAL
// ============================================================

/**
 * Run plan-specific verify steps (curl commands, CLI invocations, custom checks).
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {Array<string|object>} opts.verifySteps - from plan frontmatter
 * @param {number} [opts.timeout=120]
 * @returns {{ passed: boolean, steps: object[], duration_ms: number }}
 */
function layerBehavioral(opts) {
  const start = Date.now();
  const steps = opts.verifySteps || [];
  const timeout = (opts.timeout ?? 120) * 1000;

  if (steps.length === 0) {
    return { passed: true, steps: [], duration_ms: Date.now() - start, skipped: true, reason: 'No behavioral verify steps in plan' };
  }

  const results = [];
  for (const step of steps) {
    const command = typeof step === 'string' ? step : step.command;
    const label = typeof step === 'string' ? step : (step.label || step.command);
    const stepTimeout = typeof step === 'object' && step.timeout ? step.timeout * 1000 : timeout;

    if (!command) continue;

    // Skip built-in check names (tsc, npm test, etc.) — those are handled by layers 2/5
    if (isBuiltInCheck(command)) continue;

    const result = spawnSync('bash', ['-c', command], {
      cwd: opts.cwd,
      timeout: stepTimeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    results.push({
      label,
      command,
      passed: result.status === 0,
      exit_code: result.status ?? 1,
      timed_out: result.signal === 'SIGTERM',
      stdout: (result.stdout || '').slice(-2000),
      stderr: (result.stderr || '').slice(-2000),
    });
  }

  // Check plan must_check items (from verification_must_check frontmatter)
  if (opts.planPath) {
    try {
      const planContent = fs.readFileSync(path.resolve(opts.cwd, opts.planPath), 'utf8');
      const fmMatch = planContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const mustChecks = [];
        const lines = fmMatch[1].split('\n');
        let inMustCheck = false;
        for (const line of lines) {
          if (line.startsWith('verification_must_check:')) { inMustCheck = true; continue; }
          if (inMustCheck && line.match(/^\s+-\s+/)) {
            mustChecks.push(line.replace(/^\s+-\s+["']?/, '').replace(/["']?\s*$/, ''));
          } else if (inMustCheck && !line.match(/^\s/)) { inMustCheck = false; }
        }
        for (const check of mustChecks) {
          const keyword = check.toLowerCase().split(' ').find(w => w.length > 3) || check.toLowerCase();
          const checkFiles = opts.files || [];
          const found = checkFiles.some(f => {
            try {
              const content = fs.readFileSync(path.resolve(opts.cwd, f), 'utf8').toLowerCase();
              return content.includes(keyword);
            } catch { return false; }
          });
          if (!found) {
            results.push({
              label: `must_check: ${check}`,
              command: `(plan verification_must_check)`,
              passed: false,
              exit_code: 1,
              timed_out: false,
              stdout: `Plan must_check not verified: "${check}" — keyword "${keyword}" not found in changed files`,
              stderr: '',
            });
          }
        }
      }
    } catch { /* plan read error — skip must_check */ }
  }

  return {
    passed: results.every(r => r.passed),
    steps: results,
    duration_ms: Date.now() - start,
  };
}

function isBuiltInCheck(cmd) {
  const lower = cmd.toLowerCase().trim();
  return lower === 'tsc' || lower === 'typescript' || lower === 'typecheck'
    || lower === 'npm test' || lower === 'pytest' || lower === 'mypy'
    || lower === 'eslint' || lower === 'ruff' || lower === 'go vet'
    || lower === 'npm_test' || lower === 'go_vet';
}

// ============================================================
// Layer 7 — CONTRACT (lazy-loaded)
// ============================================================

let _contractLayer;
function contractLayer() {
  if (!_contractLayer) {
    try { _contractLayer = require('./contract-layer'); }
    catch { _contractLayer = null; }
  }
  return _contractLayer;
}

// ============================================================
// Layer 9 — BROWSER (lazy-loaded, optional)
// ============================================================

let layerBrowserMod; try { layerBrowserMod = require('./browser-layer'); } catch {}

// ============================================================
// Layer 8 — ARCHITECTURAL (optional, agent-based)
// ============================================================

/**
 * Architectural verification layer.
 * Reads ARCHITECTURE.md and CONVENTIONS.md, then uses a Claude agent
 * to check changed files against documented rules.
 *
 * This layer is optional (off by default) and expensive (LLM call).
 * Enable via config: verification.layers.architectural = true
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.files - Changed files
 * @returns {{ passed: boolean, skipped: boolean, issues: Array, duration_ms: number }}
 */
function layerArchitectural(opts) {
  const start = Date.now();
  const { cwd, files } = opts;

  // Load architecture and conventions docs
  const archPath = path.join(cwd, '.planning', 'codebase', 'ARCHITECTURE.md');
  const convPath = path.join(cwd, '.planning', 'codebase', 'CONVENTIONS.md');

  const hasArch = fs.existsSync(archPath);
  const hasConv = fs.existsSync(convPath);

  if (!hasArch && !hasConv) {
    return {
      passed: true,
      skipped: true,
      reason: 'No ARCHITECTURE.md or CONVENTIONS.md found',
      issues: [],
      duration_ms: Date.now() - start,
    };
  }

  if (!files || files.length === 0) {
    return {
      passed: true,
      skipped: true,
      reason: 'No files to check',
      issues: [],
      duration_ms: Date.now() - start,
    };
  }

  const archContent = hasArch ? fs.readFileSync(archPath, 'utf-8') : '';
  const convContent = hasConv ? fs.readFileSync(convPath, 'utf-8') : '';

  // Read changed file contents (limit to avoid huge prompts)
  const fileContents = [];
  let totalSize = 0;
  const MAX_CONTENT = 50000; // ~12k tokens
  for (const f of files.slice(0, 20)) {
    const abs = path.isAbsolute(f) ? f : path.join(cwd, f);
    if (fs.existsSync(abs)) {
      const content = fs.readFileSync(abs, 'utf-8');
      if (totalSize + content.length <= MAX_CONTENT) {
        fileContents.push({ path: f, content });
        totalSize += content.length;
      }
    }
  }

  if (fileContents.length === 0) {
    return {
      passed: true,
      skipped: true,
      reason: 'No readable files to check',
      issues: [],
      duration_ms: Date.now() - start,
    };
  }

  // Build prompt for the configured agent provider.
  const prompt = buildArchitecturalPrompt(archContent, convContent, fileContents);

  // Invoke provider CLI
  try {
    const provider = resolveProvider(cwd);
    if (!provider.available) {
      return {
        passed: true,
        skipped: true,
        reason: 'No supported agent CLI available',
        issues: [],
        duration_ms: Date.now() - start,
      };
    }

    const outputPath = path.join(cwd, '.forge', 'architectural-last-message.txt');
    const invocation = buildInvocation(provider.name, prompt, {
      outputFile: provider.name === 'codex' ? outputPath : null,
    });
    const result = spawnSync(provider.path, invocation.args, {
      cwd,
      timeout: 120000,
      input: invocation.stdin || undefined,
      encoding: 'utf-8',
      env: invocation.env,
    });
    const stdout = provider.name === 'codex' && fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, 'utf8')
      : result.stdout;
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }

    if (result.status !== 0 || !stdout) {
      return {
        passed: true,
        skipped: true,
        reason: `${provider.label} CLI not available or failed`,
        issues: [],
        duration_ms: Date.now() - start,
      };
    }

    // Parse JSON response
    const issues = parseArchitecturalResponse(stdout);
    return {
      passed: issues.length === 0,
      skipped: false,
      issues,
      duration_ms: Date.now() - start,
    };
  } catch {
    return {
      passed: true,
      skipped: true,
      reason: 'Architectural review agent failed',
      issues: [],
      duration_ms: Date.now() - start,
    };
  }
}

function buildArchitecturalPrompt(archContent, convContent, fileContents) {
  let prompt = `You are an architectural review agent. Check the following changed files against the project's architecture and conventions.

Reply ONLY with a JSON array of issues found. If no issues, reply with an empty array: []

Each issue should be: { "file": "path", "issue": "description", "severity": "suggestion|warning", "suggestion": "how to fix" }

`;
  if (archContent) {
    prompt += `## ARCHITECTURE.md\n${archContent.substring(0, 8000)}\n\n`;
  }
  if (convContent) {
    prompt += `## CONVENTIONS.md\n${convContent.substring(0, 8000)}\n\n`;
  }
  prompt += `## Changed Files\n\n`;
  for (const f of fileContents) {
    prompt += `### ${f.path}\n\`\`\`\n${f.content.substring(0, 3000)}\n\`\`\`\n\n`;
  }
  return prompt;
}

function parseArchitecturalResponse(output) {
  try {
    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = output.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter(i => i && i.file && i.issue);
      }
    }
  } catch { /* parse failure */ }
  return [];
}

// ============================================================
// Plan Parser
// ============================================================

/**
 * Extract verify steps from a plan file's frontmatter.
 */
function parsePlanVerifySteps(planPath) {
  if (!planPath || !fs.existsSync(planPath)) return [];

  const content = fs.readFileSync(planPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  const fm = fmMatch[1];
  const verifyMatch = fm.match(/^verify:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (!verifyMatch) {
    // Inline array: verify: [a, b, c]
    const inlineMatch = fm.match(/^verify:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      return inlineMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return [];
  }

  return verifyMatch[1].split('\n')
    .map(l => l.replace(/^\s+-\s+/, '').trim())
    .filter(Boolean);
}

/**
 * Extract files from plan frontmatter or body.
 */
function parsePlanFiles(planPath) {
  if (!planPath || !fs.existsSync(planPath)) return [];

  const content = fs.readFileSync(planPath, 'utf8');
  const files = [];

  // Frontmatter files list
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const filesMatch = fm.match(/^files:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (filesMatch) {
      for (const line of filesMatch[1].split('\n')) {
        const f = line.replace(/^\s+-\s+/, '').trim();
        if (f) files.push(f);
      }
    }
  }

  // Body: ## Files section with markdown list
  const filesSection = content.match(/## Files\s*\n([\s\S]*?)(?:\n##|\n---|$)/);
  if (filesSection) {
    const lines = filesSection[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^[-*]\s+`?([^\s`]+)`?/);
      if (m && m[1].includes('/')) files.push(m[1]);
    }
  }

  return [...new Set(files)];
}

// ============================================================
// Fix Suggestion Generator
// ============================================================

function generateFixSuggestions(layers) {
  const suggestions = [];

  // Layer 1 — structural
  const structural = layers.find(l => l.name === 'STRUCTURAL');
  if (structural && !structural.passed) {
    for (const issue of (structural.result.issues || [])) {
      if (issue.label === 'debugger statement') {
        suggestions.push({
          layer: 1, file: issue.file, line: issue.line,
          suggestion: `Remove debugger statement`,
          auto_fixable: true,
          fix_command: `sed -i '${issue.line}s/debugger;//' ${issue.file}`,
        });
      }
      if (issue.label.includes('console.log')) {
        suggestions.push({
          layer: 1, file: issue.file, line: issue.line,
          suggestion: `Remove or replace console.${issue.snippet.match(/console\.(\w+)/)?.[1] || 'log'} with proper logger`,
          auto_fixable: true,
          fix_command: `sed -i '${issue.line}d' ${issue.file}`,
        });
      }
      if (issue.label === 'merge conflict marker') {
        suggestions.push({
          layer: 1, file: issue.file, line: issue.line,
          suggestion: `Resolve merge conflict`,
          auto_fixable: false,
        });
      }
    }
  }

  // Layer 2 — compile errors
  const compile = layers.find(l => l.name === 'TYPE_COMPILE');
  if (compile && !compile.passed) {
    for (const check of (compile.result.checks || [])) {
      if (check.status === 'fail') {
        for (const err of (check.errors || []).slice(0, 5)) {
          suggestions.push({
            layer: 2, file: err.file, line: err.line,
            suggestion: `${check.label} error: ${err.message || err.code}`,
            auto_fixable: false,
          });
        }
      }
    }
  }

  // Layer 3 — breaking changes
  const iface = layers.find(l => l.name === 'INTERFACE_CONTRACTS');
  if (iface && !iface.passed) {
    for (const bc of (iface.result.breakingChanges || [])) {
      suggestions.push({
        layer: 3, file: bc.file,
        suggestion: `Breaking change in ${bc.name}: contract hash changed, ${bc.consumer_count_actual || 0} consumers affected. Update consumers or revert signature.`,
        auto_fixable: false,
        affected_files: bc.affected_consumers || [],
      });
    }
  }

  // Layer 4 — cycles
  const dep = layers.find(l => l.name === 'DEPENDENCY');
  if (dep && !dep.passed) {
    for (const cycle of (dep.result.newCycles || []).slice(0, 3)) {
      suggestions.push({
        layer: 4,
        suggestion: `Circular dependency: ${cycle.join(' \u2192 ')}. Extract shared interface or restructure imports.`,
        auto_fixable: false,
        affected_files: cycle,
      });
    }
    for (const orphan of (dep.result.orphanedImports || []).slice(0, 5)) {
      suggestions.push({
        layer: 4, file: orphan.source,
        suggestion: `Orphaned import: ${orphan.source} imports '${orphan.import_name}' from ${orphan.target} which doesn't exist`,
        auto_fixable: false,
      });
    }
  }

  // Layer 5 — test failures
  const tests = layers.find(l => l.name === 'TESTS');
  if (tests && !tests.passed) {
    for (const tr of (tests.result.testResults || [])) {
      if (!tr.passed) {
        suggestions.push({
          layer: 5,
          suggestion: `${tr.runner} tests failed (exit ${tr.exit_code}). Check output for details.`,
          auto_fixable: false,
          detail: (tr.stderr || tr.stdout || '').slice(-500),
        });
      }
    }
  }

  // Layer 6 — behavioral
  const behavioral = layers.find(l => l.name === 'BEHAVIORAL');
  if (behavioral && !behavioral.passed) {
    for (const step of (behavioral.result.steps || [])) {
      if (!step.passed) {
        suggestions.push({
          layer: 6,
          suggestion: `Behavioral check failed: ${step.label}`,
          auto_fixable: false,
          detail: (step.stderr || step.stdout || '').slice(-500),
        });
      }
    }
  }

  // Layer 7 — contract
  const contract = layers.find(l => l.name === 'CONTRACT');
  if (contract && !contract.passed) {
    for (const issue of (contract.result.drift || [])) {
      if (issue.severity === 'error') {
        suggestions.push({
          layer: 7,
          suggestion: `Contract drift: ${issue.message}`,
          auto_fixable: issue.type === 'undeclared_export' || issue.type === 'undeclared_endpoint',
          detail: issue.suggestion,
        });
      }
    }
    for (const issue of (contract.result.compatibility || [])) {
      if (issue.severity === 'error') {
        suggestions.push({
          layer: 7,
          suggestion: `Backward compat: ${issue.message}`,
          auto_fixable: false,
          detail: issue.suggestion,
        });
      }
    }
    for (const issue of (contract.result.ripple || [])) {
      if (issue.severity === 'error') {
        suggestions.push({
          layer: 7,
          suggestion: `Cross-repo ripple: ${issue.message}`,
          auto_fixable: false,
          detail: issue.suggestion,
          affected_files: (issue.affected_consumers || []).map(c => c.id),
        });
      }
    }
  }

  return suggestions;
}

// ============================================================
// Terminal Display
// ============================================================

function displayResults(result) {
  const b = { tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518', h: '\u2500', v: '\u2502', t: '\u251c', r: '\u2524' };
  const width = 66;

  console.log('');
  console.log(chalk.dim(`  ${b.tl}${b.h} `) + chalk.bold.cyan('Verification Report') + chalk.dim(` ${b.h.repeat(width - 23)}${b.tr}`));

  // Summary line
  const overallIcon = result.overall === 'PASS' ? LAYER_ICONS.pass : LAYER_ICONS.fail;
  const overallColor = result.overall === 'PASS' ? chalk.green : chalk.red;
  console.log(chalk.dim(`  ${b.v} `) + `Overall: ${overallIcon} ${overallColor(result.overall)}` +
    chalk.dim(`  (${result.layers.filter(l => l.passed).length}/${result.layers.filter(l => !l.skipped).length} layers passed, ${formatDuration(result.total_duration_ms)})`) +
    ' '.repeat(Math.max(0, width - 60)) + chalk.dim(b.v));
  console.log(chalk.dim(`  ${b.t}${b.h.repeat(width)}${b.r}`));

  // Per-layer results
  for (const layer of result.layers) {
    const icon = layer.skipped ? LAYER_ICONS.skip : (layer.passed ? LAYER_ICONS.pass : LAYER_ICONS.fail);
    const color = layer.skipped ? chalk.dim : (layer.passed ? chalk.green : chalk.red);
    const dur = formatDuration(layer.duration_ms);
    const status = layer.skipped ? 'SKIP' : (layer.passed ? 'PASS' : 'FAIL');

    let detail = '';
    if (layer.name === 'STRUCTURAL' && layer.result.issues && layer.result.issues.length > 0) {
      detail = ` (${layer.result.issues.length} issue${layer.result.issues.length !== 1 ? 's' : ''})`;
    }
    if (layer.name === 'TYPE_COMPILE' && layer.result.checks) {
      const failed = layer.result.checks.filter(c => c.status === 'fail');
      if (failed.length > 0) detail = ` (${failed.map(c => c.label).join(', ')} failed)`;
    }
    if (layer.name === 'INTERFACE_CONTRACTS' && layer.result.breakingChanges && layer.result.breakingChanges.length > 0) {
      detail = ` (${layer.result.breakingChanges.length} breaking)`;
    }
    if (layer.name === 'DEPENDENCY') {
      const parts = [];
      if (layer.result.newCycles && layer.result.newCycles.length > 0) parts.push(`${layer.result.newCycles.length} cycle(s)`);
      if (layer.result.orphanedImports && layer.result.orphanedImports.length > 0) parts.push(`${layer.result.orphanedImports.length} orphan(s)`);
      if (parts.length > 0) detail = ` (${parts.join(', ')})`;
    }
    if (layer.name === 'TESTS' && layer.result.testFiles) {
      detail = ` (${layer.result.testFiles.length} file${layer.result.testFiles.length !== 1 ? 's' : ''})`;
    }
    if (layer.name === 'BEHAVIORAL' && layer.result.steps) {
      const failed = layer.result.steps.filter(s => !s.passed);
      if (failed.length > 0) detail = ` (${failed.length} failed)`;
    }
    if (layer.name === 'CONTRACT') {
      const parts = [];
      if (layer.result.drift && layer.result.drift.length > 0) parts.push(`${layer.result.drift.length} drift`);
      if (layer.result.compatibility && layer.result.compatibility.length > 0) parts.push(`${layer.result.compatibility.length} compat`);
      if (layer.result.ripple && layer.result.ripple.length > 0) parts.push(`${layer.result.ripple.length} ripple`);
      if (parts.length > 0) detail = ` (${parts.join(', ')})`;
    }
    if (layer.skipped && layer.result.reason) {
      detail = ` (${layer.result.reason})`;
    }

    const num = chalk.dim(`L${layer.index}`);
    const nameStr = chalk.white(layer.name.replace(/_/g, ' '));
    console.log(chalk.dim(`  ${b.v} `) + `${icon} ${num} ${nameStr}  ${color(status)}  ${chalk.dim(dur)}${chalk.dim(detail)}`);

    // Show specific errors inline (up to 3)
    if (!layer.passed && !layer.skipped) {
      const errors = getLayerErrors(layer);
      for (const err of errors.slice(0, 3)) {
        console.log(chalk.dim(`  ${b.v}     `) + chalk.red(`\u2514\u2500 ${err}`));
      }
      if (errors.length > 3) {
        console.log(chalk.dim(`  ${b.v}     `) + chalk.dim(`   ... and ${errors.length - 3} more`));
      }
    }
  }

  console.log(chalk.dim(`  ${b.t}${b.h.repeat(width)}${b.r}`));

  // Fix suggestions
  if (result.fix_suggestions.length > 0) {
    console.log(chalk.dim(`  ${b.v} `) + chalk.bold.yellow('Fix Suggestions:'));
    for (const fix of result.fix_suggestions.slice(0, 8)) {
      const prefix = fix.auto_fixable ? chalk.green('\u2692 ') : chalk.yellow('\u25B6 ');
      const loc = fix.file ? `${chalk.yellow(fix.file)}${fix.line ? `:${fix.line}` : ''}` : '';
      console.log(chalk.dim(`  ${b.v}   `) + prefix + `${loc ? loc + ' ' : ''}${fix.suggestion}`);
    }
    if (result.fix_suggestions.length > 8) {
      console.log(chalk.dim(`  ${b.v}   `) + chalk.dim(`... and ${result.fix_suggestions.length - 8} more`));
    }
    const autoCount = result.fix_suggestions.filter(f => f.auto_fixable).length;
    if (autoCount > 0) {
      console.log(chalk.dim(`  ${b.v} `) + chalk.green(`  ${autoCount} auto-fixable issue(s)`));
    }
  }

  console.log(chalk.dim(`  ${b.bl}${b.h.repeat(width)}${b.br}`));
  console.log('');
}

function getLayerErrors(layer) {
  const errors = [];
  if (layer.name === 'STRUCTURAL') {
    for (const issue of (layer.result.issues || []).filter(i => i.severity === 'error')) {
      errors.push(`${issue.file}:${issue.line} ${issue.label}`);
    }
  }
  if (layer.name === 'TYPE_COMPILE') {
    for (const check of (layer.result.checks || []).filter(c => c.status === 'fail')) {
      for (const err of (check.errors || []).slice(0, 3)) {
        errors.push(`${err.file || ''}:${err.line || ''} ${err.message || err.code || ''}`);
      }
      if ((check.errors || []).length === 0 && check.stderr) {
        errors.push(check.stderr.split('\n').find(l => l.includes('error')) || check.stderr.split('\n')[0]);
      }
    }
  }
  if (layer.name === 'INTERFACE_CONTRACTS') {
    for (const bc of (layer.result.breakingChanges || [])) {
      errors.push(`${bc.file}::${bc.name} contract changed (${bc.consumer_count_actual || '?'} consumers)`);
    }
  }
  if (layer.name === 'DEPENDENCY') {
    for (const cycle of (layer.result.newCycles || []).slice(0, 2)) {
      errors.push(`cycle: ${cycle.slice(0, 3).join(' \u2192 ')}${cycle.length > 3 ? ' \u2192 ...' : ''}`);
    }
    for (const orphan of (layer.result.orphanedImports || []).slice(0, 2)) {
      errors.push(`orphan: ${orphan.source} \u2192 ${orphan.target}`);
    }
  }
  if (layer.name === 'TESTS') {
    for (const tr of (layer.result.testResults || []).filter(r => !r.passed)) {
      const errLine = (tr.stderr || tr.stdout || '').split('\n').find(l => /fail|error|assert/i.test(l));
      errors.push(errLine || `${tr.runner} tests failed (exit ${tr.exit_code})`);
    }
  }
  if (layer.name === 'BEHAVIORAL') {
    for (const step of (layer.result.steps || []).filter(s => !s.passed)) {
      errors.push(`${step.label}: exit ${step.exit_code}`);
    }
  }
  if (layer.name === 'CONTRACT') {
    for (const issue of (layer.result.drift || []).filter(d => d.severity === 'error')) {
      errors.push(`drift: ${issue.message}`);
    }
    for (const issue of (layer.result.compatibility || []).filter(c => c.severity === 'error')) {
      errors.push(`compat: ${issue.message}`);
    }
    for (const issue of (layer.result.ripple || []).filter(r => r.severity === 'error')) {
      errors.push(`ripple: ${issue.message}`);
    }
  }
  return errors;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ============================================================
// Graph Diff Collection
// ============================================================

function collectGraphDiff(opts) {
  if (!opts.baselineDbPath || !opts.dbPath) return null;
  if (!fs.existsSync(opts.baselineDbPath) || !fs.existsSync(opts.dbPath)) return null;

  let GraphQuery;
  try { GraphQuery = require('../forge-graph/query').GraphQuery; }
  catch { return null; }

  const gq = new GraphQuery(opts.dbPath);
  try {
    return gq.getGraphDiff(opts.baselineDbPath);
  } catch {
    return null;
  } finally {
    try { gq.db.close(); } catch { /* ignore */ }
  }
}

// ============================================================
// Config Loading
// ============================================================

/**
 * Load verification config from .forge/config.json or .planning/config.json.
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
// Ledger Integration
// ============================================================

function logToLedger(cwd, result) {
  let ledger;
  try { ledger = require('../forge-session/ledger'); }
  catch { return; }

  if (result.overall === 'PASS') {
    ledger.updateState(cwd, {
      verification: 'passed',
      layers_passed: result.layers.filter(l => l.passed || l.skipped).length,
      status: 'verified',
    });
    ledger.logEvent(cwd, 'Verification passed', {
      layers: result.layers.filter(l => !l.skipped).length,
      duration: formatDuration(result.total_duration_ms),
      files_checked: result.files_checked || 0,
    });
  } else {
    // Log each failure
    const failedLayers = result.layers.filter(l => !l.passed && !l.skipped);
    for (const layer of failedLayers) {
      const errors = getLayerErrors(layer);
      for (const err of errors.slice(0, 5)) {
        ledger.logError(cwd, {
          phase: 'verification',
          error: `[L${layer.index} ${layer.name}] ${err}`,
          fix_applied: null,
        });
      }
    }

    // Log fix suggestions
    for (const fix of result.fix_suggestions.slice(0, 5)) {
      if (fix.auto_fixable) {
        ledger.logWarning(cwd, {
          warning: `Auto-fixable: ${fix.suggestion}`,
          source: 'verification-engine',
          severity: 'medium',
          resolution: fix.fix_command || 'Auto-fix available',
        });
      }
    }

    ledger.updateState(cwd, {
      verification: 'failed',
      layers_passed: result.layers.filter(l => l.passed || l.skipped).length,
      layers_failed: failedLayers.length,
      status: 'verification_failed',
    });
  }
}

// ============================================================
// Main Verify Function
// ============================================================

/**
 * Run the full 6-layer verification pipeline.
 *
 * @param {object} opts
 * @param {string}   opts.cwd            - Project root
 * @param {string[]} [opts.files]        - Changed files (relative paths)
 * @param {string}   [opts.planPath]     - Path to plan .md (for verify steps + file list)
 * @param {string}   [opts.dbPath]       - Path to graph.db
 * @param {string}   [opts.baselineDbPath] - Previous graph.db for diff
 * @param {number}   [opts.maxLayer=7]   - Stop after this layer (1-7)
 * @param {boolean}  [opts.failFast=true] - Stop on first layer failure
 * @param {boolean}  [opts.json=false]   - Output JSON instead of display
 * @param {boolean}  [opts.silent=false] - No terminal output
 * @param {boolean}  [opts.logLedger=true] - Log results to session ledger
 * @param {boolean}  [opts.incremental=false] - Only verify changed files + their consumers
 * @returns {object} Full verification result
 */

/**
 * Resolve affected files: changed files + their graph consumers.
 * Used in incremental mode to limit verification scope.
 */
function resolveAffectedFiles(changedFiles, cwd) {
  const affected = new Set(changedFiles);
  try {
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    if (!fs.existsSync(dbPath)) return [...affected];
    const { GraphQuery } = require('../forge-graph/query');
    const gq = new GraphQuery(dbPath);
    gq.open();
    for (const f of changedFiles) {
      try {
        const consumers = gq.getConsumers(f);
        if (Array.isArray(consumers)) {
          consumers.forEach(c => affected.add(typeof c === 'string' ? c : (c.path || c)));
        }
      } catch { /* file may not be in graph */ }
    }
    gq.close();
  } catch { /* graph not available, fall back to changed files only */ }
  return [...affected];
}

async function verify(opts) {
  const cwd = opts.cwd || process.cwd();
  const failFast = opts.failFast !== false;
  const maxLayer = opts.maxLayer ?? 7;
  const logLedger = opts.logLedger !== false;

  // Load verification config from .forge/config.json or .planning/config.json
  const verifyConfig = loadVerificationConfig(cwd);

  // Resolve DB path
  const dbPath = opts.dbPath || path.join(cwd, '.forge', 'graph.db');

  // Collect files from plan or opts
  let files = opts.files || [];
  let verifySteps = [];

  if (opts.planPath) {
    const planFiles = parsePlanFiles(opts.planPath);
    if (planFiles.length > 0 && files.length === 0) files = planFiles;
    verifySteps = parsePlanVerifySteps(opts.planPath);
  }

  // Normalize to relative paths
  files = files.map(f => path.isAbsolute(f) ? path.relative(cwd, f) : f);

  // If no files specified, try to get from git diff
  if (files.length === 0) {
    try {
      const diff = execSync('git diff --name-only HEAD~1 2>/dev/null || git diff --name-only --cached 2>/dev/null || true', {
        cwd, encoding: 'utf8', timeout: 5000,
      });
      files = diff.trim().split('\n').filter(Boolean);
    } catch { /* ignore */ }
  }

  // Incremental mode: expand files to include graph consumers
  if (opts.incremental && files.length > 0) {
    files = resolveAffectedFiles(files, cwd);
  }

  // Collect graph context for capabilities
  let capabilities = {};
  let baselineCycleCount = 0;
  let GraphQuery;
  try { GraphQuery = require('../forge-graph/query').GraphQuery; }
  catch { GraphQuery = null; }

  if (GraphQuery && fs.existsSync(dbPath)) {
    const gq = new GraphQuery(dbPath);
    try {
      gq.open();
      if (files.length > 0) {
        const ctx = gq.getContextForTask(files);
        capabilities = ctx.capabilities || {};
      }
      // Get baseline cycle count from current DB (before any changes)
      if (opts.baselineDbPath && fs.existsSync(opts.baselineDbPath)) {
        const baseGq = new GraphQuery(opts.baselineDbPath);
        try {
          const baseCycles = baseGq.getCycles();
          baselineCycleCount = baseCycles.count;
        } finally {
          try { baseGq.db.close(); } catch { /* ignore */ }
        }
      }
    } finally {
      try { gq.db.close(); } catch { /* ignore */ }
    }
  }

  // Run layers
  const layers = [];
  const totalStart = Date.now();

  // Layer 1 — STRUCTURAL
  if (maxLayer >= 1 && !(verifyConfig.layers && verifyConfig.layers.STRUCTURAL === false)) {
    const cached1 = cache ? cache.get('STRUCTURAL', files, cwd) : null;
    const result = cached1 || layerStructural({ cwd, files });
    if (!cached1 && cache) cache.set('STRUCTURAL', files, cwd, result);
    layers.push({ index: 1, name: 'STRUCTURAL', passed: result.passed, skipped: false, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed && result.issues.some(i => i.severity === 'error')) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 2 — TYPE/COMPILE
  if (maxLayer >= 2 && !(verifyConfig.layers && verifyConfig.layers.TYPE_COMPILE === false)) {
    const cached2 = cache ? cache.get('TYPE_COMPILE', files, cwd) : null;
    const result = cached2 || layerTypeCompile({ cwd, files, capabilities, config: verifyConfig });
    if (!cached2 && cache) cache.set('TYPE_COMPILE', files, cwd, result);
    const skipped = result.checks.length === 0;
    layers.push({ index: 2, name: 'TYPE_COMPILE', passed: result.passed, skipped, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 3 — INTERFACE CONTRACTS
  if (maxLayer >= 3 && !(verifyConfig.layers && verifyConfig.layers.INTERFACE_CONTRACTS === false)) {
    const cached3 = cache ? cache.get('INTERFACE_CONTRACTS', files, cwd) : null;
    const result = cached3 || layerInterfaceContracts({ cwd, dbPath, files, baselineDbPath: opts.baselineDbPath });
    if (!cached3 && cache) cache.set('INTERFACE_CONTRACTS', files, cwd, result);
    layers.push({ index: 3, name: 'INTERFACE_CONTRACTS', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 4 — DEPENDENCY
  if (maxLayer >= 4 && !(verifyConfig.layers && verifyConfig.layers.DEPENDENCY === false)) {
    const cached4 = cache ? cache.get('DEPENDENCY', files, cwd) : null;
    const result = cached4 || layerDependency({ cwd, dbPath, files, baselineCycleCount });
    if (!cached4 && cache) cache.set('DEPENDENCY', files, cwd, result);
    layers.push({ index: 4, name: 'DEPENDENCY', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 5 — TESTS
  if (maxLayer >= 5 && !(verifyConfig.layers && verifyConfig.layers.TESTS === false)) {
    const testTimeout = (verifyConfig.test_timeout) || 300;
    const cached5 = cache ? cache.get('TESTS', files, cwd) : null;
    const result = cached5 || layerTests({ cwd, dbPath, files, timeout: testTimeout, config: verifyConfig });
    if (!cached5 && cache) cache.set('TESTS', files, cwd, result);
    layers.push({ index: 5, name: 'TESTS', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 6 — BEHAVIORAL
  if (maxLayer >= 6 && !(verifyConfig.layers && verifyConfig.layers.BEHAVIORAL === false)) {
    const cached6 = cache ? cache.get('BEHAVIORAL', files, cwd) : null;
    const result = cached6 || layerBehavioral({ cwd, verifySteps, timeout: 120, planPath: opts.planPath, files });
    if (!cached6 && cache) cache.set('BEHAVIORAL', files, cwd, result);
    layers.push({ index: 6, name: 'BEHAVIORAL', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    if (failFast && !result.passed) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  // Layer 7 — CONTRACT (cross-repo contract verification)
  if (maxLayer >= 7 && !(verifyConfig.layers && verifyConfig.layers.CONTRACT === false)) {
    const cl = contractLayer();
    if (cl) {
      const systemDbPath = opts.systemDbPath
        || process.env.FORGE_SYSTEM_GRAPH_PATH
        || process.env.FORGE_SYSTEM_GRAPH
        || cl.resolveSystemDb(cwd);
      const cached7 = cache ? cache.get('CONTRACT', files, cwd) : null;
      const result = cached7 || cl.layerContract({ cwd, files, systemDbPath, config: verifyConfig });
      if (!cached7 && cache) cache.set('CONTRACT', files, cwd, result);
      layers.push({ index: 7, name: 'CONTRACT', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    } else {
      layers.push({ index: 7, name: 'CONTRACT', passed: true, skipped: true, result: { passed: true, skipped: true, reason: 'contract-layer.js not available', drift: [], compatibility: [], ripple: [], duration_ms: 0 }, duration_ms: 0 });
    }
  }

  // Layer 8 — ARCHITECTURAL (optional, agent-based, off by default)
  if (maxLayer >= 8 && verifyConfig.layers && verifyConfig.layers.ARCHITECTURAL === true) {
    const cached8 = cache ? cache.get('ARCHITECTURAL', files, cwd) : null;
    const result = cached8 || layerArchitectural({ cwd, files });
    if (!cached8 && cache) cache.set('ARCHITECTURAL', files, cwd, result);
    layers.push({ index: 8, name: 'ARCHITECTURAL', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration_ms });
    // Architectural issues are suggestions, don't fail-fast
  }

  // Layer 9 — BROWSER (optional, Playwright e2e, off by default)
  if (maxLayer >= 9 && verifyConfig.layers && verifyConfig.layers.BROWSER === true && layerBrowserMod) {
    const cached9 = cache ? cache.get('BROWSER', files, cwd) : null;
    const result = cached9 || await layerBrowserMod.layerBrowser({ cwd, files });
    if (!cached9 && cache) cache.set('BROWSER', files, cwd, result);
    layers.push({ index: 9, name: 'BROWSER', passed: result.passed, skipped: !!result.skipped, result, duration_ms: result.duration || 0 });
    if (!result.passed && !result.skipped && opts.failFast) {
      return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
    }
  }

  return finalize({ cwd, layers, files, dbPath, opts, totalStart, verifySteps, capabilities, baselineCycleCount, logLedger });
}

function finalize({ cwd, layers, files, dbPath, opts, totalStart, logLedger }) {
  const totalDuration = Date.now() - totalStart;
  const allPassed = layers.every(l => l.passed || l.skipped);
  const fixSuggestions = generateFixSuggestions(layers);
  const graphDiff = collectGraphDiff({ dbPath, baselineDbPath: opts.baselineDbPath });

  const result = {
    overall: allPassed ? 'PASS' : 'FAIL',
    layers,
    fix_suggestions: fixSuggestions,
    auto_fixable: fixSuggestions.filter(f => f.auto_fixable).length,
    graph_diff: graphDiff,
    total_duration_ms: totalDuration,
    files_checked: files.length,
    timestamp: new Date().toISOString(),
  };

  // Display
  if (!opts.silent) {
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      displayResults(result);
    }
  }

  // Ledger
  if (logLedger) {
    try { logToLedger(cwd, result); } catch { /* ignore */ }
  }

  return result;
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
    else if (arg === '--layer' && argv[i + 1]) { args.maxLayer = parseInt(argv[++i], 10); }
    else if (arg === '--system-db' && argv[i + 1]) { args.systemDbPath = path.resolve(argv[++i]); }
    else if (arg === '--fail-fast') { args.failFast = true; }
    else if (arg === '--no-fail-fast') { args.failFast = false; }
    else if (arg === '--json') { args.json = true; }
    else if (arg === '--silent') { args.silent = true; }
    else if (arg === '--no-ledger') { args.logLedger = false; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verify(args);
  process.exit(result.overall === 'PASS' ? 0 : 1);
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  verify,
  layerStructural,
  layerTypeCompile,
  layerInterfaceContracts,
  layerDependency,
  layerTests,
  layerBehavioral,
  get layerContract() { const cl = contractLayer(); return cl ? cl.layerContract : null; },
  layerArchitectural,
  get layerBrowser() { return layerBrowserMod ? layerBrowserMod.layerBrowser : null; },
  parsePlanVerifySteps,
  parsePlanFiles,
  generateFixSuggestions,
  displayResults,
  checkBracketBalance,
  findTsConfig,
  loadVerificationConfig,
  resolveAffectedFiles,
  LAYER_NAMES,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
