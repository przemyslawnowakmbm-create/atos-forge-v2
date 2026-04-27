'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function isPlaywrightAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

async function layerBrowser(opts) {
  const { cwd, files } = opts;
  const result = { layer: 'BROWSER', passed: true, skipped: false, duration: 0, issues: [] };
  const start = Date.now();

  if (!isPlaywrightAvailable()) {
    result.skipped = true;
    result.message = 'Playwright not installed (npm install -D playwright)';
    result.duration = Date.now() - start;
    return result;
  }

  const frontendExtensions = ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.css'];
  const hasFrontend = (files || []).some(f => frontendExtensions.includes(path.extname(f)));
  if (!hasFrontend) {
    result.skipped = true;
    result.message = 'No frontend files changed';
    result.duration = Date.now() - start;
    return result;
  }

  // Check dev server
  let serverUp = false;
  const ports = [3000, 5173, 4200, 8080];
  for (const port of ports) {
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
      serverUp = true;
      break;
    } catch {}
  }

  if (!serverUp) {
    result.skipped = true;
    result.message = 'No dev server detected on common ports (3000, 5173, 4200, 8080)';
    result.duration = Date.now() - start;
    return result;
  }

  // Find e2e test directory
  const testPatterns = ['e2e/', 'tests/e2e/', 'playwright/', 'test/e2e/'];
  let testDir = null;
  for (const p of testPatterns) {
    if (fs.existsSync(path.join(cwd, p))) { testDir = p; break; }
  }

  if (!testDir) {
    result.skipped = true;
    result.message = 'No Playwright test directory found';
    result.issues.push({ type: 'no_e2e_tests', message: 'Create e2e/ directory with Playwright tests', severity: 'info', auto_fixable: false });
    result.duration = Date.now() - start;
    return result;
  }

  try {
    execSync(`npx playwright test --reporter=line ${testDir}`, { cwd, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
    result.message = 'All browser tests passed';
  } catch (e) {
    result.passed = false;
    result.issues.push({ type: 'browser_test_fail', message: (e.stdout || e.message || '').slice(0, 500), severity: 'error', auto_fixable: false });
  }

  result.duration = Date.now() - start;
  return result;
}

module.exports = { layerBrowser, isPlaywrightAvailable };
