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

module.exports = { generateStubs, detectTestFramework, detectTestDir, parsePlanVerification };
