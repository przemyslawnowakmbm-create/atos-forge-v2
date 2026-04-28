'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Test Stub Generator — creates minimal test stubs from plan verification criteria.
 * Generated stubs are RED (failing) before implementation, GREEN after.
 */

function detectTestFramework(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.jest) return { framework: 'jest', ext: '.test.js', runner: 'npx jest' };
    if (deps.vitest) return { framework: 'vitest', ext: '.test.ts', runner: 'npx vitest run' };
    if (deps.mocha) return { framework: 'mocha', ext: '.test.js', runner: 'npx mocha' };
    const testScript = pkg.scripts?.test || '';
    if (testScript.includes('node --test')) return { framework: 'node:test', ext: '.test.cjs', runner: 'node --test' };
    return { framework: 'node:test', ext: '.test.cjs', runner: 'node --test' }; // fallback
  } catch {
    return { framework: 'node:test', ext: '.test.cjs', runner: 'node --test' };
  }
}

function detectTestDir(cwd) {
  const candidates = ['tests', 'test', '__tests__', 'spec'];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(cwd, dir))) return dir;
  }
  // Check if tests live next to source
  if (fs.existsSync(path.join(cwd, 'src'))) return 'src';
  return 'tests'; // default — create if needed
}

function parsePlanVerification(planPath, cwd) {
  const fullPath = path.resolve(cwd, planPath);
  if (!fs.existsSync(fullPath)) return { checks: [], files: [] };

  const content = fs.readFileSync(fullPath, 'utf8');
  const checks = [];
  const files = [];

  // Extract verification_must_check from frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const lines = fmMatch[1].split('\n');
    let inMustCheck = false;
    let inFiles = false;
    for (const line of lines) {
      if (line.startsWith('verification_must_check:')) { inMustCheck = true; inFiles = false; continue; }
      if (line.startsWith('files:')) { inFiles = true; inMustCheck = false; continue; }
      if (inMustCheck && line.match(/^\s+-\s+/)) {
        checks.push(line.replace(/^\s+-\s+["']?/, '').replace(/["']?\s*$/, ''));
      } else if (inMustCheck && !line.match(/^\s/)) { inMustCheck = false; }
      if (inFiles && line.match(/^\s+-\s+/)) {
        files.push(line.replace(/^\s+-\s+["']?/, '').replace(/["']?\s*$/, ''));
      } else if (inFiles && !line.match(/^\s/)) { inFiles = false; }
    }
  }

  // Extract verify section from body
  const verifyMatch = content.match(/##\s*Verify\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (verifyMatch) {
    const verifyLines = verifyMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of verifyLines) {
      const text = line.replace(/^\s*-\s+/, '').trim();
      if (text && !checks.includes(text)) checks.push(text);
    }
  }

  return { checks, files };
}

function generateStubContent(framework, checks, planFiles) {
  if (framework === 'jest' || framework === 'vitest') {
    const tests = checks.map((check, i) => `
  test('verify: ${check.replace(/'/g, "\\'")}', () => {
    // TODO: implement verification for: ${check}
    // This test should PASS after implementation
    expect(true).toBe(true); // placeholder — replace with real assertion
  });`).join('\n');

    return `/**
 * Auto-generated test stubs from plan verification criteria.
 * These define SUCCESS CRITERIA — implementation must make all tests pass.
 */

describe('Plan Verification', () => {
${tests}
});
`;
  }

  // node:test fallback
  const tests = checks.map((check, i) => `
test('verify: ${check.replace(/'/g, "\\'")}', () => {
  // TODO: implement verification for: ${check}
  assert.ok(true, 'placeholder — replace with real assertion');
});`).join('\n');

  return `/**
 * Auto-generated test stubs from plan verification criteria.
 * These define SUCCESS CRITERIA — implementation must make all tests pass.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
${tests}
`;
}

function generateStubs(planPath, cwd) {
  const { checks, files: planFiles } = parsePlanVerification(planPath, cwd);
  if (checks.length === 0) return { generated: false, reason: 'No verification criteria found in plan', files: [] };

  const fw = detectTestFramework(cwd);
  const testDir = detectTestDir(cwd);
  const testDirPath = path.join(cwd, testDir);

  if (!fs.existsSync(testDirPath)) {
    fs.mkdirSync(testDirPath, { recursive: true });
  }

  // Generate stub filename from plan filename
  const planBasename = path.basename(planPath, '.md').replace(/^\d+-\d+-/, '');
  const stubFilename = `plan-${planBasename}${fw.ext}`;
  const stubPath = path.join(testDirPath, stubFilename);

  const content = generateStubContent(fw.framework, checks, planFiles);
  fs.writeFileSync(stubPath, content);

  return {
    generated: true,
    files: [path.relative(cwd, stubPath)],
    framework: fw,
    checks: checks.length,
  };
}

/**
 * Parse ALL verification criteria from a plan file, including must_haves from frontmatter.
 * Uses the plan-assessment parser for robust frontmatter extraction.
 *
 * @param {string} planPath - Path to the plan file
 * @param {string} cwd - Project root directory
 * @returns {{ truths: string[], artifacts: object[], key_links: object[], checks: string[], files: string[] }}
 */
function parsePlanFullCriteria(planPath, cwd) {
  const result = { truths: [], artifacts: [], key_links: [], checks: [], files: [] };

  // Use existing parser for verification_must_check and ## Verify section
  const { checks, files } = parsePlanVerification(planPath, cwd);
  result.checks = checks;
  result.files = files;

  // Use plan-assessment parser for frontmatter must_haves
  try {
    const { parsePlan } = require('../forge-agents/plan-assessment');
    const plan = parsePlan(path.resolve(cwd, planPath));
    const mh = plan.frontmatter?.must_haves;

    if (mh) {
      // truths — array of strings
      if (Array.isArray(mh.truths)) {
        result.truths = mh.truths;
      }

      // artifacts — array of strings from YAML; parse into objects with path/provides/exports
      if (Array.isArray(mh.artifacts)) {
        result.artifacts = mh.artifacts.map(a => {
          if (typeof a === 'object') return a;
          // Parse "path: src/foo.ts, provides: bar, exports: baz" style strings
          const pathMatch = (typeof a === 'string') ? a.match(/(?:path:\s*)?(\S+)/) : null;
          return {
            path: pathMatch ? pathMatch[1].replace(/,\s*$/, '') : a,
            provides: null,
            exports: null,
          };
        });
      }

      // key_links — array of objects with source/from, target/to, pattern
      if (Array.isArray(mh.key_links)) {
        result.key_links = mh.key_links.map(link => {
          if (typeof link === 'object') {
            return {
              source: link.source || link.from || null,
              target: link.target || link.to || null,
              pattern: link.pattern || null,
            };
          }
          return { source: null, target: null, pattern: null };
        });
      }
    }
  } catch { /* plan-assessment module not available — return what we have */ }

  return result;
}

/**
 * Generate categorized FAILING test content for test-first execution.
 *
 * Produces three describe blocks:
 * - Observable Truths (throw NOT IMPLEMENTED)
 * - Required Artifacts (check file existence)
 * - Key Link Wiring (check import/pattern in source)
 *
 * @param {{ framework: string, ext: string, runner: string }} framework - Detected test framework
 * @param {{ truths: string[], artifacts: object[], key_links: object[], checks: string[], files: string[] }} criteria
 * @returns {string} Test file content
 */
function generateTestFirstContent(framework, criteria) {
  if (framework.framework === 'jest' || framework.framework === 'vitest') {
    const truthTests = criteria.truths.map(truth => {
      const escaped = truth.replace(/'/g, "\\'");
      return `
  it('truth: ${escaped}', () => {
    throw new Error('NOT IMPLEMENTED: ${escaped}');
  });`;
    }).join('\n');

    const artifactTests = criteria.artifacts.map(artifact => {
      const filePath = typeof artifact === 'object' ? artifact.path : artifact;
      const escaped = (filePath || '').replace(/'/g, "\\'");
      return `
  it('artifact: ${escaped} must exist', () => {
    expect(fs.existsSync(path.resolve(__dirname, '..', '${escaped}'))).toBe(true);
  });`;
    }).join('\n');

    const linkTests = criteria.key_links.map(link => {
      const source = link.source || '(unknown)';
      const target = link.target || '(unknown)';
      const pattern = link.pattern || '(unknown)';
      const sourceEscaped = source.replace(/'/g, "\\'");
      const patternEscaped = pattern.replace(/'/g, "\\'");
      return `
  it('link: ${sourceEscaped} imports from ${target.replace(/'/g, "\\'")} (pattern: ${patternEscaped})', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '${sourceEscaped}'), 'utf8');
    expect(source).toMatch(/${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/);
  });`;
    }).join('\n');

    return `/**
 * Auto-generated TEST-FIRST stubs from plan verification criteria.
 * These tests MUST FAIL before implementation and PASS after.
 * DO NOT MODIFY — hash-locked by Forge.
 */
const fs = require('fs');
const path = require('path');

describe('Observable Truths', () => {${truthTests || `
  // No truths defined in plan`}
});

describe('Required Artifacts', () => {${artifactTests || `
  // No artifacts defined in plan`}
});

describe('Key Link Wiring', () => {${linkTests || `
  // No key links defined in plan`}
});
`;
  }

  // node:test format
  const truthTests = criteria.truths.map(truth => {
    const escaped = truth.replace(/'/g, "\\'");
    return `
  it('truth: ${escaped}', () => {
    throw new Error('NOT IMPLEMENTED: ${escaped}');
  });`;
  }).join('\n');

  const artifactTests = criteria.artifacts.map(artifact => {
    const filePath = typeof artifact === 'object' ? artifact.path : artifact;
    const escaped = (filePath || '').replace(/'/g, "\\'");
    return `
  it('artifact: ${escaped} must exist', () => {
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', '${escaped}')), 'File must exist: ${escaped}');
  });`;
  }).join('\n');

  const linkTests = criteria.key_links.map(link => {
    const source = link.source || '(unknown)';
    const target = link.target || '(unknown)';
    const pattern = link.pattern || '(unknown)';
    const sourceEscaped = source.replace(/'/g, "\\'");
    const patternEscaped = pattern.replace(/'/g, "\\'");
    return `
  it('link: ${sourceEscaped} imports from ${target.replace(/'/g, "\\'")} (pattern: ${patternEscaped})', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '${sourceEscaped}'), 'utf8');
    assert.match(source, new RegExp('${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "\\'")}'));
  });`;
  }).join('\n');

  return `/**
 * Auto-generated TEST-FIRST stubs from plan verification criteria.
 * These tests MUST FAIL before implementation and PASS after.
 * DO NOT MODIFY — hash-locked by Forge.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Observable Truths', () => {${truthTests || `
  // No truths defined in plan`}
});

describe('Required Artifacts', () => {${artifactTests || `
  // No artifacts defined in plan`}
});

describe('Key Link Wiring', () => {${linkTests || `
  // No key links defined in plan`}
});
`;
}

/**
 * Generate categorized FAILING test stubs for test-first execution.
 * Unlike generateStubs (placeholder tests), these produce tests that MUST FAIL
 * before implementation, covering truths, artifacts, and key_links from the plan.
 *
 * @param {string} planPath - Path to the plan file
 * @param {string} cwd - Project root directory
 * @returns {{ generated: boolean, files: string[], framework: string, criteria_count: number, stub_type: string }}
 */
function generateTestFirstStubs(planPath, cwd) {
  const criteria = parsePlanFullCriteria(planPath, cwd);
  const framework = detectTestFramework(cwd);
  const testDir = detectTestDir(cwd);

  // Generate categorized failing test content
  const content = generateTestFirstContent(framework, criteria);

  // Determine output path
  const planBase = path.basename(planPath, path.extname(planPath)).replace(/^\d+-\d+-/, '');
  const testFile = path.join(testDir, `plan-${planBase}.test-first${framework.ext}`);
  const fullPath = path.resolve(cwd, testFile);

  // Write to disk
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content);

  return {
    generated: true,
    files: [testFile],
    framework: framework.framework,
    criteria_count: criteria.truths.length + criteria.artifacts.length + criteria.key_links.length,
    stub_type: 'test_first',
  };
}

module.exports = {
  generateStubs,
  detectTestFramework,
  detectTestDir,
  parsePlanVerification,
  parsePlanFullCriteria,
  generateTestFirstStubs,
  generateTestFirstContent,
};
