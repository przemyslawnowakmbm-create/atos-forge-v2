'use strict';

/**
 * UAT Auto-Evaluator — Programmatic backend test result evaluation.
 *
 * Replaces prompt-based auto-evaluation in verify-work.md with deterministic code.
 * Called via: node forge-tools.cjs verify uat-eval --expected "..." --exit-code N --output "..."
 *
 * Returns JSON: { status: "PASS"|"FAIL"|"INCONCLUSIVE", reason: string }
 */

const core = require('./core.cjs');
const { output, error } = core;

// ── Positive exit-code signal words ──────────────────────────────────────────
const EXIT_ZERO_SIGNALS = [
  'exit:0', 'exit code 0', 'succeeds', 'without errors', 'zero errors',
  'no errors', 'compiles', 'builds', 'passes', 'pass', 'should pass',
  'finishes with no errors', 'all tests pass', 'tests pass',
];

// ── Negative exit-code signal words ──────────────────────────────────────────
const EXIT_NONZERO_SIGNALS = [
  'should fail', 'expect 403', 'expect 404', 'expect 500',
  'should return 4', 'should return 5',
];

// ── Error indicators in output ───────────────────────────────────────────────
const ERROR_PATTERNS = [
  /\berror:/i,
  /\bError:/,
  /\bERROR\b/,
  /\bFAILED\b/,
  /\bFAILURE\b/,
  /\bpanic\b/,
  /\bTraceback\b/,
  /\bfatal\b/i,
  /\bsegfault\b/i,
  /\bSIGSEGV\b/,
  /\bcore dumped\b/i,
  /\bcommand not found\b/,
  /\bNo such file or directory\b/,
];

// ── False-positive exclusions (these look like errors but aren't) ────────────
const ERROR_EXCLUSIONS = [
  /0 errors/i,
  /zero errors/i,
  /without errors/i,
  /no errors/i,
  /0 failed/i,
  /warnings? ok/i,
  /error\[E/,          // Rust error codes in context like "For more information about this error"
  /for more information about this error/i,
];

/**
 * Check if output line is a false-positive error match.
 */
function isExcludedError(line) {
  return ERROR_EXCLUSIONS.some(rx => rx.test(line));
}

/**
 * Extract positive patterns from the expected string.
 * Looks for: "should show X", "should contain X", "N tests pass", etc.
 */
function extractPositivePatterns(expected) {
  const patterns = [];
  const lower = expected.toLowerCase();

  // "should show/contain/list/have X"
  const shouldMatch = expected.match(/should\s+(?:show|contain|list|have|include|display|output|print)\s+["']?([^"'.]+)["']?/gi);
  if (shouldMatch) {
    for (const m of shouldMatch) {
      const val = m.replace(/^should\s+\w+\s+["']?/i, '').replace(/["']?$/, '').trim();
      if (val.length > 1) patterns.push(val);
    }
  }

  // "N tests pass" / "N passed" / "all N tests pass"
  const testCountMatch = expected.match(/(?:all\s+)?(\d+)\+?\s+(?:\w+\s+)?(?:tests?\s+)?pass/i);
  if (testCountMatch) {
    patterns.push({ type: 'test_pass_count', min: parseInt(testCountMatch[1], 10) });
  }

  // "JSON with {field}" / "containing {field}"
  const jsonFieldMatch = expected.match(/(?:JSON|response|output)\s+(?:with|containing)\s+["']?(\w+)["']?/gi);
  if (jsonFieldMatch) {
    for (const m of jsonFieldMatch) {
      const field = m.match(/(?:with|containing)\s+["']?(\w+)["']?/i);
      if (field) patterns.push(field[1]);
    }
  }

  return patterns;
}

/**
 * Check if expected text is too vague to evaluate programmatically.
 */
function isVagueExpected(expected) {
  const lower = expected.toLowerCase().trim();
  // Single short vague sentence
  if (lower.length < 30 && /^should\s+work/i.test(lower)) return true;
  // References visual/manual inspection only
  if (/\b(visually|manually|look at|inspect|screenshot|browser)\b/i.test(lower) &&
      !/\b(exit|code|pass|error|output|contain|show)\b/i.test(lower)) return true;
  // No testable signals at all
  const hasSignals = /\b(pass|fail|error|exit|code|contain|show|output|compil|build|test|run)\b/i.test(lower);
  if (!hasSignals) return true;
  return false;
}

/**
 * Parse test pass counts from output (e.g., "4 passed", "test result: ok. 4 passed")
 */
function parseTestPassCount(outputText) {
  // Rust: "test result: ok. N passed; M failed"
  const rustMatch = outputText.match(/test result:\s*ok\.\s*(\d+)\s*passed/i);
  if (rustMatch) return parseInt(rustMatch[1], 10);

  // Generic: "N passed"
  const genericMatch = outputText.match(/(\d+)\s+passed/i);
  if (genericMatch) return parseInt(genericMatch[1], 10);

  // Jest/Vitest: "Tests: N passed"
  const jestMatch = outputText.match(/Tests?:\s*(\d+)\s+passed/i);
  if (jestMatch) return parseInt(jestMatch[1], 10);

  // pytest: "N passed"
  const pytestMatch = outputText.match(/(\d+)\s+passed/i);
  if (pytestMatch) return parseInt(pytestMatch[1], 10);

  return null;
}

/**
 * Main auto-evaluation function.
 *
 * @param {string} expected - The expected criteria text from the test definition
 * @param {number} exitCode - The actual exit code from the command
 * @param {string} outputText - The actual stdout+stderr from the command
 * @returns {{ status: 'PASS'|'FAIL'|'INCONCLUSIVE', reason: string }}
 */
function autoEvaluate(expected, exitCode, outputText) {
  if (!expected || expected.trim().length === 0) {
    return { status: 'INCONCLUSIVE', reason: 'no expected criteria provided' };
  }

  // Check for vague expected text
  if (isVagueExpected(expected)) {
    return { status: 'INCONCLUSIVE', reason: 'could not parse expected criteria for auto-check' };
  }

  const lower = expected.toLowerCase();
  const failures = [];
  let rulesApplied = 0;

  // ── Rule 1: Exit Code Check ──────────────────────────────────────────────
  let expectZero = EXIT_ZERO_SIGNALS.some(s => lower.includes(s));
  let expectNonZero = EXIT_NONZERO_SIGNALS.some(s => lower.includes(s));

  if (expectZero) {
    rulesApplied++;
    if (exitCode !== 0) {
      failures.push(`exit code ${exitCode}, expected 0`);
    }
  } else if (expectNonZero) {
    rulesApplied++;
    if (exitCode === 0) {
      failures.push(`exit code 0, expected non-zero`);
    }
  }
  // No signal → skip (don't fail on exit code alone)

  // ── Rule 2: Positive Pattern Match ───────────────────────────────────────
  const patterns = extractPositivePatterns(expected);
  for (const pat of patterns) {
    rulesApplied++;
    if (typeof pat === 'object' && pat.type === 'test_pass_count') {
      const actual = parseTestPassCount(outputText);
      if (actual === null) {
        failures.push(`expected ${pat.min}+ tests to pass, could not find pass count in output`);
      } else if (actual < pat.min) {
        failures.push(`expected ${pat.min}+ tests to pass, found ${actual}`);
      }
    } else {
      // String pattern — case-insensitive search
      if (!outputText.toLowerCase().includes(pat.toLowerCase())) {
        failures.push(`expected pattern '${pat}' not found in output`);
      }
    }
  }

  // ── Rule 3: Negative Pattern Check ───────────────────────────────────────
  // Only when success is expected
  if (expectZero || !expectNonZero) {
    for (const rx of ERROR_PATTERNS) {
      const match = outputText.match(rx);
      if (match) {
        // Check surrounding context for false positives
        const matchIdx = outputText.indexOf(match[0]);
        const contextStart = Math.max(0, matchIdx - 40);
        const contextEnd = Math.min(outputText.length, matchIdx + match[0].length + 40);
        const context = outputText.substring(contextStart, contextEnd);

        if (!isExcludedError(context)) {
          rulesApplied++;
          failures.push(`unexpected error indicator '${match[0]}' in output`);
          break; // One error indicator is enough
        }
      }
    }
  }

  // ── Rule 4: Output Presence Check ────────────────────────────────────────
  const expectsOutput = /should\s+(show|contain|list|output|print|display)/i.test(expected) ||
                        /\d+\s+(?:\w+\s+)?(?:tests?\s+)?pass/i.test(expected);
  if (expectsOutput && (!outputText || outputText.trim().length === 0)) {
    rulesApplied++;
    failures.push('no output produced');
  }

  // ── Final Determination ──────────────────────────────────────────────────
  if (rulesApplied === 0) {
    return { status: 'INCONCLUSIVE', reason: 'could not parse expected criteria for auto-check' };
  }

  if (failures.length > 0) {
    return { status: 'FAIL', reason: failures[0] };
  }

  return { status: 'PASS', reason: `exit code ${exitCode}, output matches expected` };
}

/**
 * CLI handler for `forge-tools verify uat-eval`.
 *
 * Expects args: --expected "..." --exit-code N --output "..."
 * Output can also be read from --output-file <path> for large outputs.
 */
function cmdUatAutoEval(cwd, args, raw) {
  let expected = '';
  let exitCode = null;
  let outputText = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--expected' && args[i + 1]) { expected = args[++i]; }
    else if (a === '--exit-code' && args[i + 1]) { exitCode = parseInt(args[++i], 10); }
    else if (a === '--output' && args[i + 1]) { outputText = args[++i]; }
    else if (a === '--output-file' && args[i + 1]) {
      const fs = require('fs');
      const p = require('path');
      const fp = p.isAbsolute(args[i + 1]) ? args[++i] : p.join(cwd, args[++i]);
      try { outputText = fs.readFileSync(fp, 'utf8'); } catch (e) {
        error('Cannot read output file: ' + e.message);
        return;
      }
    }
  }

  if (exitCode === null) {
    error('--exit-code is required');
    return;
  }

  const result = autoEvaluate(expected, exitCode, outputText);
  output(result, raw);
}

module.exports = { autoEvaluate, cmdUatAutoEval };
