'use strict';

/**
 * Mutation Testing
 *
 * Introduces controlled bugs (mutations) into source code and checks whether
 * the test suite catches them. A high mutation score indicates tests that
 * thoroughly verify behavior, not just coverage.
 *
 * SAFETY: Original files are always restored via try/finally before moving
 * to the next mutant. Backup copies provide an additional safety layer.
 *
 * Usage:
 *   const { runMutationTesting, formatMutationReport } = require('./mutation');
 *   const result = runMutationTesting(cwd, { maxMutantsPerFile: 5, minScore: 0.70 });
 *   console.log(formatMutationReport(result));
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============================================================
// Mutation Operators
// ============================================================

const MUTATION_OPERATORS = [
  { name: 'negate_equality', pattern: /===(?!=)/g, replacement: '!==', desc: 'Negate ===' },
  { name: 'negate_inequality', pattern: /!==(?!=)/g, replacement: '===', desc: 'Negate !==' },
  { name: 'flip_true', pattern: /\btrue\b/g, replacement: 'false', desc: 'true -> false' },
  { name: 'flip_false', pattern: /\bfalse\b/g, replacement: 'true', desc: 'false -> true' },
  { name: 'remove_return', pattern: /return [^;]+;/g, replacement: 'return undefined;', desc: 'Remove return value' },
  { name: 'boundary_lt', pattern: /< (?!=)/g, replacement: '<= ', desc: '< -> <=' },
  { name: 'boundary_gt', pattern: /> (?!=)/g, replacement: '>= ', desc: '> -> >=' },
  { name: 'arith_plus', pattern: /\+ (?!=)/g, replacement: '- ', desc: '+ -> -' },
  { name: 'arith_minus', pattern: /- (?!=)/g, replacement: '+ ', desc: '- -> +' },
];

/**
 * Check if a file should be skipped for mutation.
 * @param {string} relPath
 * @returns {boolean}
 */
function shouldSkipFile(relPath) {
  if (relPath.includes('node_modules/')) return true;
  if (relPath.includes('.test.') || relPath.includes('.spec.')) return true;
  if (relPath.includes('__tests__/')) return true;
  if (relPath.includes('/test/') || relPath.includes('/tests/')) return true;
  if (relPath.includes('.config.') || relPath.includes('.conf.')) return true;
  if (relPath.includes('.min.')) return true;
  if (relPath.includes('vendor/')) return true;
  if (relPath.includes('.d.ts')) return true;

  const ext = path.extname(relPath).toLowerCase();
  const skipExtensions = ['.json', '.md', '.txt', '.yaml', '.yml', '.lock', '.svg',
    '.png', '.jpg', '.gif', '.ico', '.woff', '.ttf', '.css', '.scss', '.less',
    '.html', '.xml', '.toml', '.ini', '.env', '.map'];
  return skipExtensions.includes(ext);
}

/**
 * Find the line number for a character index in content.
 * @param {string} content
 * @param {number} index
 * @returns {number}
 */
function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Generate mutant descriptors for source files.
 * @param {string} cwd
 * @param {string[]} files - Relative paths to source files
 * @param {object} opts
 * @param {number} [opts.maxMutantsPerFile=10]
 * @param {string[]} [opts.operators] - Specific operator names to use
 * @returns {object[]} Array of mutant descriptors
 */
function generateMutants(cwd, files, opts = {}) {
  const maxPerFile = opts.maxMutantsPerFile || 10;
  const allowedOps = opts.operators ? new Set(opts.operators) : null;
  const mutants = [];
  let mutantId = 0;

  for (const relPath of files) {
    if (shouldSkipFile(relPath)) continue;

    const absPath = path.resolve(cwd, relPath);
    if (!fs.existsSync(absPath)) continue;

    let content;
    try { content = fs.readFileSync(absPath, 'utf8'); } catch { continue; }

    // Skip very small or very large files
    if (content.length < 50 || content.length > 500000) continue;

    let fileCount = 0;

    for (const operator of MUTATION_OPERATORS) {
      if (fileCount >= maxPerFile) break;
      if (allowedOps && !allowedOps.has(operator.name)) continue;

      // Find all match locations — use a fresh regex each time
      const regex = new RegExp(operator.pattern.source, operator.pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (fileCount >= maxPerFile) break;

        const line = lineNumberAt(content, match.index);
        const contextStart = Math.max(0, match.index - 20);
        const contextEnd = Math.min(content.length, match.index + match[0].length + 20);
        const original = content.substring(contextStart, contextEnd).replace(/\n/g, '\\n');

        mutants.push({
          id: `mut-${mutantId++}`,
          file: relPath,
          operator: operator.name,
          line,
          original: match[0],
          mutated: operator.replacement,
          match_index: match.index,
          match_length: match[0].length,
          desc: operator.desc,
          context: original,
        });
        fileCount++;
      }
    }
  }

  return mutants;
}

/**
 * Run a single mutant: backup, mutate, test, restore.
 * CRITICAL: The original file is ALWAYS restored via try/finally.
 * @param {string} cwd
 * @param {object} mutant
 * @param {string} testCommand
 * @param {number} timeout - in milliseconds
 * @returns {{ mutant_id: string, killed: boolean, survived: boolean, timed_out: boolean }}
 */
function runMutant(cwd, mutant, testCommand, timeout) {
  const absPath = path.resolve(cwd, mutant.file);
  const backupPath = absPath + '.forge-mutation-backup';

  let originalContent;
  try {
    originalContent = fs.readFileSync(absPath, 'utf8');
  } catch {
    return { mutant_id: mutant.id, killed: false, survived: false, timed_out: false, error: 'Could not read file' };
  }

  // Create backup
  try { fs.writeFileSync(backupPath, originalContent); } catch { /* proceed with in-memory backup */ }

  try {
    // Apply mutation
    const mutatedContent = originalContent.substring(0, mutant.match_index)
      + mutant.mutated
      + originalContent.substring(mutant.match_index + mutant.match_length);

    fs.writeFileSync(absPath, mutatedContent);

    // Run tests
    const result = spawnSync('bash', ['-c', testCommand], {
      cwd,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const timedOut = result.signal === 'SIGTERM';
    const testFailed = result.status !== 0;

    return {
      mutant_id: mutant.id,
      killed: testFailed || timedOut,  // Killed = test detected the mutation
      survived: !testFailed && !timedOut,  // Survived = test missed the mutation (bad)
      timed_out: timedOut,
    };
  } finally {
    // ALWAYS restore the original file
    try {
      fs.writeFileSync(absPath, originalContent);
    } catch {
      // Fallback to backup file
      try {
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, absPath);
        }
      } catch { /* critical: manual restore needed */ }
    }

    // Clean up backup
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch { /* ignore */ }
  }
}

/**
 * Compute the mutation score.
 * @param {object[]} results - Array of runMutant results
 * @returns {number} Score between 0 and 1
 */
function computeMutationScore(results) {
  const killed = results.filter(r => r.killed).length;
  const survived = results.filter(r => r.survived).length;
  const total = killed + survived;
  if (total === 0) return 1; // No mutants = perfect score
  return killed / total;
}

/**
 * Detect the test command for running mutation tests.
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
    return 'python -m pytest -x --tb=short -q';
  }
  return null;
}

/**
 * Find source files to mutate. If not specified, scan common directories.
 * @param {string} cwd
 * @param {string[]} [explicitFiles]
 * @returns {string[]}
 */
function findSourceFiles(cwd, explicitFiles) {
  if (explicitFiles && explicitFiles.length > 0) return explicitFiles;

  const srcDirs = ['src', 'lib', 'app'];
  const results = [];

  for (const dir of srcDirs) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) continue;
    scanDirForSources(dirPath, cwd, results, 0);
  }

  // Limit to 30 files to keep mutation testing reasonable
  return results.slice(0, 30);
}

/**
 * Recursively scan for source files.
 */
function scanDirForSources(dir, cwd, results, depth) {
  if (depth > 6 || results.length >= 30) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 30) return;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDirForSources(fullPath, cwd, results, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py'].includes(ext)) {
          const rel = path.relative(cwd, fullPath);
          if (!shouldSkipFile(rel)) {
            results.push(rel);
          }
        }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Orchestrator: find files, generate mutants, run each, score.
 * @param {string} cwd
 * @param {object} opts
 * @param {string[]} [opts.files] - Specific files to mutate
 * @param {string[]} [opts.operators] - Specific mutation operators
 * @param {number} [opts.maxMutantsPerFile=10]
 * @param {number} [opts.timeoutMultiplier=2] - Multiply base test timeout
 * @param {number} [opts.minScore=0.70] - Minimum passing mutation score
 * @param {string} [opts.testCommand] - Override test command
 * @param {number} [opts.timeout=300] - Base test timeout in seconds
 * @returns {{ passed: boolean, skipped: boolean, mutation_score: number, total_mutants: number, killed: number, survived: number, timed_out: number, per_file: object[], duration_ms: number, issues: object[] }}
 */
function runMutationTesting(cwd, opts = {}) {
  const start = Date.now();
  const issues = [];

  // Detect test command
  const testCommand = opts.testCommand || detectTestCommand(cwd);
  if (!testCommand) {
    return {
      passed: true,
      skipped: true,
      mutation_score: 0,
      total_mutants: 0,
      killed: 0,
      survived: 0,
      timed_out: 0,
      per_file: [],
      duration_ms: Date.now() - start,
      issues: [],
      reason: 'No test command detected',
    };
  }

  // Find source files
  const files = findSourceFiles(cwd, opts.files);
  if (files.length === 0) {
    return {
      passed: true,
      skipped: true,
      mutation_score: 0,
      total_mutants: 0,
      killed: 0,
      survived: 0,
      timed_out: 0,
      per_file: [],
      duration_ms: Date.now() - start,
      issues: [],
      reason: 'No source files found to mutate',
    };
  }

  // Generate mutants
  const mutants = generateMutants(cwd, files, {
    maxMutantsPerFile: opts.maxMutantsPerFile || 10,
    operators: opts.operators,
  });

  if (mutants.length === 0) {
    return {
      passed: true,
      skipped: true,
      mutation_score: 1,
      total_mutants: 0,
      killed: 0,
      survived: 0,
      timed_out: 0,
      per_file: [],
      duration_ms: Date.now() - start,
      issues: [],
      reason: 'No applicable mutations found in source files',
    };
  }

  // Calculate timeout per mutant
  const baseTimeout = (opts.timeout || 300) * 1000;
  const multiplier = opts.timeoutMultiplier || 2;
  const mutantTimeout = Math.min(baseTimeout, 60000 * multiplier); // Cap at 2min per mutant by default

  // Run each mutant
  const results = [];
  for (const mutant of mutants) {
    const result = runMutant(cwd, mutant, testCommand, mutantTimeout);
    results.push(result);
  }

  // Compute scores
  const score = computeMutationScore(results);
  const killed = results.filter(r => r.killed).length;
  const survived = results.filter(r => r.survived).length;
  const timedOut = results.filter(r => r.timed_out).length;

  // Per-file breakdown
  const perFileMap = {};
  for (let i = 0; i < mutants.length; i++) {
    const mutant = mutants[i];
    const result = results[i];
    if (!perFileMap[mutant.file]) {
      perFileMap[mutant.file] = { file: mutant.file, total: 0, killed: 0, survived: 0, timed_out: 0 };
    }
    perFileMap[mutant.file].total++;
    if (result.killed) perFileMap[mutant.file].killed++;
    if (result.survived) perFileMap[mutant.file].survived++;
    if (result.timed_out) perFileMap[mutant.file].timed_out++;
  }

  const perFile = Object.values(perFileMap).map(f => ({
    ...f,
    score: f.total > 0 ? ((f.killed) / (f.killed + f.survived)) : 1,
  }));

  // Check minimum score
  const minScore = opts.minScore ?? 0.70;
  const passed = score >= minScore;

  if (!passed) {
    issues.push({
      type: 'low_mutation_score',
      message: `Mutation score ${(score * 100).toFixed(1)}% is below minimum ${(minScore * 100).toFixed(1)}%`,
      severity: 'error',
    });

    // Report survived mutants
    for (let i = 0; i < results.length; i++) {
      if (results[i].survived) {
        const m = mutants[i];
        issues.push({
          type: 'survived_mutant',
          file: m.file,
          line: m.line,
          message: `Survived: ${m.desc} at line ${m.line}`,
          severity: 'warning',
        });
      }
    }
  }

  return {
    passed,
    skipped: false,
    mutation_score: score,
    total_mutants: mutants.length,
    killed,
    survived,
    timed_out: timedOut,
    per_file: perFile,
    duration_ms: Date.now() - start,
    issues,
  };
}

/**
 * Format mutation testing results as a markdown report.
 * @param {object} result - From runMutationTesting
 * @returns {string}
 */
function formatMutationReport(result) {
  if (result.skipped) {
    return `Mutation Testing: SKIPPED (${result.reason || 'unknown'})`;
  }

  const lines = [];
  lines.push(`## Mutation Testing Report`);
  lines.push('');
  lines.push(`Score: ${(result.mutation_score * 100).toFixed(1)}% ${result.passed ? '(PASS)' : '(FAIL)'}`);
  lines.push(`Total: ${result.total_mutants} | Killed: ${result.killed} | Survived: ${result.survived} | Timed out: ${result.timed_out}`);
  lines.push(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
  lines.push('');

  if (result.per_file.length > 0) {
    lines.push('| File | Total | Killed | Survived | Score |');
    lines.push('|------|-------|--------|----------|-------|');
    for (const f of result.per_file) {
      lines.push(`| ${f.file} | ${f.total} | ${f.killed} | ${f.survived} | ${(f.score * 100).toFixed(0)}% |`);
    }
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push('### Issues');
    for (const issue of result.issues.filter(i => i.type === 'survived_mutant').slice(0, 10)) {
      lines.push(`- ${issue.file}:${issue.line} - ${issue.message}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  MUTATION_OPERATORS,
  generateMutants,
  runMutant,
  computeMutationScore,
  runMutationTesting,
  formatMutationReport,
};
