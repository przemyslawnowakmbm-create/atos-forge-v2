'use strict';

/**
 * Browser Verification Layer — Playwright e2e, screenshot comparison, accessibility audit.
 *
 * Layer 10 of the multi-layer verification engine. Off by default.
 * Enable via: verification.layers.browser = true in .forge/config.json
 *
 * Capabilities:
 *   - Dev server detection and lifecycle management
 *   - Multi-viewport screenshot capture and baseline comparison
 *   - Accessibility audit via axe-core injection
 *   - Existing Playwright e2e test execution
 *
 * All operations fail gracefully when Playwright is not installed.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

// ============================================================
// Default Configuration
// ============================================================

const DEFAULT_CONFIG = {
  ports: [3000, 5173, 4200, 8080, 8000],
  viewports: [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1024, height: 768 },
    { name: 'wide', width: 1440, height: 900 },
  ],
  diff_threshold: 0.05,
  fail_diff_threshold: 0.15,
  screenshots: true,
  accessibility: true,
  server_timeout: 30000,
  navigation_timeout: 15000,
};

const FRONTEND_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.css', '.scss', '.less'];

// ============================================================
// Playwright Availability
// ============================================================

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Config Loading
// ============================================================

/**
 * Load browser layer configuration from forge-config, merged with defaults and overrides.
 * @param {string} cwd - Project root
 * @param {object} [overrides] - Direct config overrides
 * @returns {object} Merged browser config
 */
function loadBrowserConfig(cwd, overrides) {
  let projectConfig = {};
  try {
    const forgeConfig = require('../forge-config/config');
    const effective = forgeConfig.resolveEffective(cwd);
    if (effective && effective.browser) {
      projectConfig = effective.browser;
    }
  } catch {
    // forge-config unavailable — use defaults
  }

  // Deep merge: defaults <- project <- overrides
  const merged = { ...DEFAULT_CONFIG };
  if (projectConfig.ports) merged.ports = projectConfig.ports;
  if (projectConfig.viewports) merged.viewports = projectConfig.viewports;
  if (typeof projectConfig.diff_threshold === 'number') merged.diff_threshold = projectConfig.diff_threshold;
  if (typeof projectConfig.fail_diff_threshold === 'number') merged.fail_diff_threshold = projectConfig.fail_diff_threshold;
  if (typeof projectConfig.screenshots === 'boolean') merged.screenshots = projectConfig.screenshots;
  if (typeof projectConfig.accessibility === 'boolean') merged.accessibility = projectConfig.accessibility;
  if (typeof projectConfig.server_timeout === 'number') merged.server_timeout = projectConfig.server_timeout;
  if (typeof projectConfig.navigation_timeout === 'number') merged.navigation_timeout = projectConfig.navigation_timeout;

  if (overrides) {
    Object.assign(merged, overrides);
  }

  return merged;
}

// ============================================================
// Dev Server Management
// ============================================================

/**
 * Detect dev server command from package.json scripts.
 * Looks for dev, start, serve scripts in that priority order.
 * @param {string} cwd - Project root
 * @returns {{ command: string, port: number|null } | null}
 */
function detectDevServer(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }

  if (!pkg.scripts) return null;

  const candidates = ['dev', 'start', 'serve'];
  for (const name of candidates) {
    if (pkg.scripts[name]) {
      const command = `npm run ${name}`;
      // Try to extract port from the script command
      const portMatch = pkg.scripts[name].match(/(?:--port|PORT=|-p)\s*(\d{4,5})/);
      const port = portMatch ? parseInt(portMatch[1], 10) : null;
      return { command, port };
    }
  }

  return null;
}

/**
 * Probe a list of ports for a running HTTP server.
 * @param {number[]} ports - Ports to probe
 * @returns {Promise<{ port: number, url: string } | null>}
 */
async function findRunningServer(ports) {
  for (const port of ports) {
    const alive = await probePort(port, 2000);
    if (alive) {
      return { port, url: `http://localhost:${port}` };
    }
  }
  return null;
}

/**
 * Probe a single port with an HTTP GET request.
 * @param {number} port
 * @param {number} timeout - ms
 * @returns {Promise<boolean>}
 */
function probePort(port, timeout) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, { timeout }, (res) => {
      // Any response means server is up (even 404/500)
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Start a dev server as a detached background process and wait for it to become healthy.
 * @param {string} cwd - Project root
 * @param {{ command: string, port: number|null }} detected - Detected server config
 * @param {object} [opts] - Options
 * @param {number} [opts.timeout] - Max wait time in ms (default 30000)
 * @param {number[]} [opts.ports] - Ports to probe for health
 * @returns {Promise<{ process: import('child_process').ChildProcess, port: number, url: string }>}
 */
async function startDevServer(cwd, detected, opts = {}) {
  const timeout = opts.timeout || 30000;
  const probePorts = detected.port ? [detected.port] : (opts.ports || DEFAULT_CONFIG.ports);

  const parts = detected.command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const proc = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    shell: true,
  });

  // Don't let the parent process wait for the child
  proc.unref();

  // Collect stderr for diagnostics if server fails to start
  let stderrBuf = '';
  if (proc.stderr) {
    proc.stderr.on('data', (d) => { stderrBuf += d.toString().slice(0, 2000); });
  }

  // Poll until server responds or timeout
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeout) {
    // Check if process exited early
    if (proc.exitCode !== null) {
      throw new Error(`Dev server exited with code ${proc.exitCode}: ${stderrBuf.slice(0, 500)}`);
    }

    for (const port of probePorts) {
      const alive = await probePort(port, 1500);
      if (alive) {
        return { process: proc, port, url: `http://localhost:${port}` };
      }
    }

    await sleep(pollInterval);
  }

  // Timeout — kill and report
  stopDevServer(proc);
  throw new Error(`Dev server did not respond within ${timeout}ms. stderr: ${stderrBuf.slice(0, 500)}`);
}

/**
 * Kill a dev server process and its entire process tree.
 * @param {import('child_process').ChildProcess} proc
 */
function stopDevServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    // Kill the process group (negative PID kills the group)
    if (proc.pid) {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    // Process may already be dead
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// ============================================================
// Screenshot Comparison
// ============================================================

/**
 * Capture screenshots at multiple viewports.
 * @param {import('playwright').Page} page - Playwright page
 * @param {Array<{ name: string, width: number, height: number }>} viewports
 * @param {string} outputDir - Directory to save screenshots
 * @returns {Promise<Record<string, string>>} Map of viewport name to file path
 */
async function captureScreenshots(page, viewports, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const results = {};

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await sleep(500); // Wait for layout stabilization
    const filepath = path.join(outputDir, `${vp.name}-${vp.width}x${vp.height}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    results[vp.name] = filepath;
  }

  return results;
}

/**
 * Compare current screenshots against baseline using byte-level diff.
 * @param {string} currentDir - Directory with current screenshots
 * @param {string} baselineDir - Directory with baseline screenshots
 * @param {number} threshold - Diff percentage below which comparison passes (0-1)
 * @returns {Array<{ viewport: string, diff_percentage: number, passed: boolean }>}
 */
function compareScreenshots(currentDir, baselineDir, threshold) {
  const results = [];

  if (!fs.existsSync(baselineDir)) {
    return results; // No baseline yet — nothing to compare
  }

  const currentFiles = fs.readdirSync(currentDir).filter(f => f.endsWith('.png'));

  for (const filename of currentFiles) {
    const viewport = filename.replace(/-\d+x\d+\.png$/, '');
    const currentPath = path.join(currentDir, filename);
    const baselinePath = path.join(baselineDir, filename);

    if (!fs.existsSync(baselinePath)) {
      results.push({ viewport, diff_percentage: 1.0, passed: false, message: 'No baseline exists' });
      continue;
    }

    const currentBuf = fs.readFileSync(currentPath);
    const baselineBuf = fs.readFileSync(baselinePath);

    // Simple byte-level comparison
    const maxLen = Math.max(currentBuf.length, baselineBuf.length);
    const minLen = Math.min(currentBuf.length, baselineBuf.length);

    if (maxLen === 0) {
      results.push({ viewport, diff_percentage: 0, passed: true });
      continue;
    }

    let diffBytes = Math.abs(currentBuf.length - baselineBuf.length); // Size difference counts as diff
    for (let i = 0; i < minLen; i++) {
      if (currentBuf[i] !== baselineBuf[i]) diffBytes++;
    }

    const diffPercentage = diffBytes / maxLen;
    results.push({
      viewport,
      diff_percentage: Math.round(diffPercentage * 10000) / 10000,
      passed: diffPercentage <= threshold,
    });
  }

  return results;
}

// ============================================================
// Accessibility Audit
// ============================================================

/**
 * Run an accessibility audit on the current page using axe-core.
 * Injects axe-core script and runs analysis.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ violations: Array, passes: number, incomplete: number, inapplicable: number }>}
 */
async function runAccessibilityAudit(page) {
  // Try to resolve axe-core from the project or globally
  let axeSource;
  try {
    const axePath = require.resolve('axe-core');
    axeSource = fs.readFileSync(axePath, 'utf8');
  } catch {
    // Try the minified bundle path directly
    try {
      const axePath = require.resolve('axe-core/axe.min.js');
      axeSource = fs.readFileSync(axePath, 'utf8');
    } catch {
      return {
        violations: [],
        passes: 0,
        incomplete: 0,
        inapplicable: 0,
        skipped: true,
        message: 'axe-core not installed (npm install -D axe-core)',
      };
    }
  }

  // Inject and run axe
  await page.evaluate(axeSource);
  const results = await page.evaluate(() => {
    /* global axe */
    return new Promise((resolve, reject) => {
      axe.run(document, {}, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  });

  return {
    violations: results.violations || [],
    passes: (results.passes || []).length,
    incomplete: (results.incomplete || []).length,
    inapplicable: (results.inapplicable || []).length,
  };
}

/**
 * Classify axe-core results into verification issues.
 * critical/serious = FAIL, moderate = WARNING, minor = INFO
 * @param {{ violations: Array }} results
 * @returns {Array<{ type: string, message: string, severity: string, id: string, impact: string, nodes: number }>}
 */
function classifyAxeResults(results) {
  if (!results || !results.violations) return [];

  return results.violations.map((v) => {
    let severity;
    switch (v.impact) {
      case 'critical':
      case 'serious':
        severity = 'error';
        break;
      case 'moderate':
        severity = 'warning';
        break;
      default:
        severity = 'info';
    }

    return {
      type: 'accessibility',
      id: v.id,
      impact: v.impact,
      message: `${v.id}: ${v.description} (${v.nodes.length} node${v.nodes.length !== 1 ? 's' : ''})`,
      severity,
      nodes: v.nodes.length,
      help: v.helpUrl,
      auto_fixable: false,
    };
  });
}

// ============================================================
// E2E Test Runner
// ============================================================

/**
 * Find and run existing Playwright e2e tests.
 * @param {string} cwd - Project root
 * @returns {{ found: boolean, testDir: string|null, passed: boolean, output: string, duration: number }}
 */
function runExistingE2eTests(cwd) {
  const testPatterns = ['e2e/', 'tests/e2e/', 'playwright/', 'test/e2e/', '__e2e__/'];
  let testDir = null;

  for (const p of testPatterns) {
    if (fs.existsSync(path.join(cwd, p))) {
      testDir = p;
      break;
    }
  }

  if (!testDir) {
    return { found: false, testDir: null, passed: true, output: '', duration: 0 };
  }

  const start = Date.now();
  try {
    const output = execSync(`npx playwright test --reporter=line ${testDir}`, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      stdio: 'pipe',
    });
    return { found: true, testDir, passed: true, output: output.slice(0, 2000), duration: Date.now() - start };
  } catch (e) {
    const output = (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || '');
    return { found: true, testDir, passed: false, output: output.slice(0, 2000), duration: Date.now() - start };
  }
}

// ============================================================
// Main Layer Function
// ============================================================

/**
 * Browser verification layer entry point.
 *
 * Steps:
 *   1. Check Playwright available
 *   2. Check frontend files changed
 *   3. Find or start dev server
 *   4. Launch headless Chromium
 *   5. Navigate to server URL, track console errors
 *   6. Capture screenshots at configured viewports
 *   7. Compare against baseline (if exists)
 *   8. Run accessibility audit
 *   9. Run existing e2e tests (if directory exists)
 *  10. Clean up: close browser, stop server (if we started it)
 *
 * @param {object} opts
 * @param {string} opts.cwd - Project root
 * @param {string[]} [opts.files] - Changed files
 * @param {object} [opts.config] - Browser config overrides
 * @param {object} [opts.planContext] - Plan context (planPath, etc.)
 * @returns {Promise<object>} Layer result
 */
async function layerBrowser(opts) {
  const { cwd, files } = opts;
  const config = loadBrowserConfig(cwd, opts.config || {});
  const result = {
    layer: 'BROWSER',
    passed: true,
    skipped: false,
    duration: 0,
    issues: [],
    screenshots: null,
    accessibility: null,
  };
  const start = Date.now();
  let browser = null;
  let serverProc = null;
  let weStartedServer = false;

  try {
    // Step 1 — Check Playwright available
    if (!isPlaywrightAvailable()) {
      result.skipped = true;
      result.message = 'Playwright not installed (npm install -D playwright)';
      result.duration = Date.now() - start;
      return result;
    }

    // Step 2 — Check frontend files changed
    const hasFrontend = (files || []).some(f => FRONTEND_EXTENSIONS.includes(path.extname(f)));
    if (!hasFrontend && files && files.length > 0) {
      result.skipped = true;
      result.message = 'No frontend files changed';
      result.duration = Date.now() - start;
      return result;
    }

    // Step 3 — Find or start dev server
    let serverInfo = await findRunningServer(config.ports);
    if (!serverInfo) {
      const detected = detectDevServer(cwd);
      if (!detected) {
        result.skipped = true;
        result.message = 'No dev server detected (no dev/start/serve script in package.json) and no server running on common ports';
        result.duration = Date.now() - start;
        return result;
      }
      try {
        serverInfo = await startDevServer(cwd, detected, {
          timeout: config.server_timeout,
          ports: config.ports,
        });
        serverProc = serverInfo.process;
        weStartedServer = true;
      } catch (err) {
        result.passed = false;
        result.issues.push({
          type: 'server_start_failure',
          message: `Failed to start dev server: ${err.message}`,
          severity: 'error',
          auto_fixable: false,
        });
        result.duration = Date.now() - start;
        return result;
      }
    }

    // Step 4 — Launch headless Chromium
    const playwright = require('playwright');
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 5 — Navigate and track console errors
    const consoleMessages = [];
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleMessages.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });

    try {
      const response = await page.goto(serverInfo.url, {
        waitUntil: 'networkidle',
        timeout: config.navigation_timeout,
      });

      if (!response) {
        result.issues.push({
          type: 'navigation_failure',
          message: `No response when navigating to ${serverInfo.url}`,
          severity: 'error',
          auto_fixable: false,
        });
        result.passed = false;
      } else if (response.status() >= 400) {
        result.issues.push({
          type: 'navigation_failure',
          message: `Server returned HTTP ${response.status()} for ${serverInfo.url}`,
          severity: 'error',
          auto_fixable: false,
        });
        result.passed = false;
      }
    } catch (navErr) {
      result.issues.push({
        type: 'navigation_failure',
        message: `Navigation to ${serverInfo.url} failed: ${navErr.message}`,
        severity: 'error',
        auto_fixable: false,
      });
      result.passed = false;
      // Cannot continue with screenshots/a11y if page didn't load
      result.duration = Date.now() - start;
      return result;
    }

    // Record console errors as warnings (they might be benign)
    for (const msg of consoleMessages) {
      result.issues.push({
        type: 'console_error',
        message: msg.slice(0, 500),
        severity: 'warning',
        auto_fixable: false,
      });
    }

    for (const err of pageErrors) {
      result.issues.push({
        type: 'page_error',
        message: err.slice(0, 500),
        severity: 'warning',
        auto_fixable: false,
      });
    }

    // Step 6 — Capture screenshots
    if (config.screenshots) {
      const screenshotDir = path.join(cwd, '.forge', 'screenshots');
      const currentDir = path.join(screenshotDir, 'current');
      const baselineDir = path.join(screenshotDir, 'baseline');

      const screenshots = await captureScreenshots(page, config.viewports, currentDir);
      result.screenshots = { current: screenshots };

      // Step 7 — Compare against baseline
      if (fs.existsSync(baselineDir)) {
        const comparisons = compareScreenshots(currentDir, baselineDir, config.diff_threshold);
        result.screenshots.comparisons = comparisons;

        for (const comp of comparisons) {
          if (!comp.passed) {
            const severity = comp.diff_percentage > config.fail_diff_threshold ? 'error' : 'warning';
            result.issues.push({
              type: 'screenshot_diff',
              message: `Viewport "${comp.viewport}" differs by ${(comp.diff_percentage * 100).toFixed(2)}% from baseline`,
              severity,
              viewport: comp.viewport,
              diff_percentage: comp.diff_percentage,
              auto_fixable: false,
            });
            if (severity === 'error') {
              result.passed = false;
            }
          }
        }
      } else {
        // First run — save as baseline
        fs.mkdirSync(baselineDir, { recursive: true });
        for (const [name, filepath] of Object.entries(screenshots)) {
          const dest = path.join(baselineDir, path.basename(filepath));
          fs.copyFileSync(filepath, dest);
        }
        result.screenshots.baseline_created = true;
        result.screenshots.message = 'Baseline screenshots created (first run)';
      }
    }

    // Step 8 — Accessibility audit
    if (config.accessibility) {
      const a11yResults = await runAccessibilityAudit(page);
      result.accessibility = a11yResults;

      if (!a11yResults.skipped) {
        const a11yIssues = classifyAxeResults(a11yResults);
        result.issues.push(...a11yIssues);

        // Critical/serious a11y issues cause failure
        const hasA11yErrors = a11yIssues.some(i => i.severity === 'error');
        if (hasA11yErrors) {
          result.passed = false;
        }
      }
    }

    // Step 9 — Run existing e2e tests
    const e2eResult = runExistingE2eTests(cwd);
    if (e2eResult.found) {
      result.e2e = {
        testDir: e2eResult.testDir,
        passed: e2eResult.passed,
        duration: e2eResult.duration,
      };
      if (!e2eResult.passed) {
        result.passed = false;
        result.issues.push({
          type: 'e2e_test_failure',
          message: e2eResult.output.slice(0, 500),
          severity: 'error',
          auto_fixable: false,
        });
      }
    }
  } catch (err) {
    result.passed = false;
    result.issues.push({
      type: 'browser_layer_error',
      message: `Unexpected error in browser layer: ${err.message}`,
      severity: 'error',
      auto_fixable: false,
    });
  } finally {
    // Step 10 — Clean up
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    if (weStartedServer && serverProc) {
      stopDevServer(serverProc);
    }
  }

  result.duration = Date.now() - start;
  return result;
}

// ============================================================
// Utilities
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  layerBrowser,
  detectDevServer,
  findRunningServer,
  captureScreenshots,
  runAccessibilityAudit,
  // Additional exports for testing and composition
  compareScreenshots,
  classifyAxeResults,
  startDevServer,
  stopDevServer,
  loadBrowserConfig,
  isPlaywrightAvailable,
  DEFAULT_CONFIG,
};
