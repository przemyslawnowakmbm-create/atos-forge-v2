const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FORGE_ROOT = path.resolve(__dirname, '..');

function createTmpProject() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-entropy-'));
  fs.mkdirSync(path.join(dir, '.forge', 'entropy-snapshots'), { recursive: true });
  return dir;
}

function cleanTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('entropy', () => {
  let tmpDir;
  let entropy;

  beforeEach(() => {
    tmpDir = createTmpProject();
    Object.keys(require.cache).filter(k => k.includes('entropy')).forEach(k => delete require.cache[k]);
    entropy = require(path.join(FORGE_ROOT, 'forge-verify', 'entropy'));
  });
  afterEach(() => { cleanTmp(tmpDir); });

  it('computeInstability: Ce=2, Ca=3 → I=0.4', () => {
    const I = entropy.computeInstability(3, 2);
    assert.strictEqual(I, 0.4);
  });

  it('computeInstability: Ce=0, Ca=0 → I=0 (no deps = stable)', () => {
    const I = entropy.computeInstability(0, 0);
    assert.strictEqual(I, 0);
  });

  it('computeDistance: A=0.3, I=0.4 → D=0.3', () => {
    const D = entropy.computeDistance(0.3, 0.4);
    assert.ok(Math.abs(D - 0.3) < 0.001, 'Distance should be |0.3 + 0.4 - 1| = 0.3');
  });

  it('computeDistance: A=0.5, I=0.5 → D=0 (on main sequence)', () => {
    const D = entropy.computeDistance(0.5, 0.5);
    assert.ok(Math.abs(D) < 0.001, 'On main sequence should be D=0');
  });

  it('computeCohesion: 5 internal, 3 external → 0.625', () => {
    const C = entropy.computeCohesion(5, 3);
    assert.ok(Math.abs(C - 0.625) < 0.001);
  });

  it('computeCohesion: 0 internal, 0 external → 1 (trivial = cohesive)', () => {
    const C = entropy.computeCohesion(0, 0);
    assert.strictEqual(C, 1);
  });

  it('classifyHealth: avgDistance < 0.3 → green', () => {
    assert.strictEqual(entropy.classifyHealth(0.15), 'green');
    assert.strictEqual(entropy.classifyHealth(0.29), 'green');
  });

  it('classifyHealth: avgDistance 0.3-0.5 → yellow', () => {
    assert.strictEqual(entropy.classifyHealth(0.3), 'yellow');
    assert.strictEqual(entropy.classifyHealth(0.49), 'yellow');
  });

  it('classifyHealth: avgDistance >= 0.5 → red', () => {
    assert.strictEqual(entropy.classifyHealth(0.5), 'red');
    assert.strictEqual(entropy.classifyHealth(0.8), 'red');
  });

  it('compareSnapshots detects >10% increase as warn', () => {
    const baseline = {
      aggregate: { avgDistance: 0.20, avgInstability: 0.3, avgCohesion: 0.7 },
      modules: [{ name: 'auth', distance: 0.20, instability: 0.3, cohesion: 0.7 }],
    };
    const current = {
      aggregate: { avgDistance: 0.25, avgInstability: 0.4, avgCohesion: 0.6 },
      modules: [{ name: 'auth', distance: 0.25, instability: 0.4, cohesion: 0.6 }],
    };
    const comparison = entropy.compareSnapshots(current, baseline);
    assert.strictEqual(comparison.aggregateChange.verdict, 'warn');
  });

  it('compareSnapshots detects >25% increase as block', () => {
    const baseline = {
      aggregate: { avgDistance: 0.20 },
      modules: [{ name: 'auth', distance: 0.20 }],
    };
    const current = {
      aggregate: { avgDistance: 0.30 },
      modules: [{ name: 'auth', distance: 0.30 }],
    };
    const comparison = entropy.compareSnapshots(current, baseline);
    assert.strictEqual(comparison.aggregateChange.verdict, 'block');
  });

  it('compareSnapshots handles new modules not in baseline', () => {
    const baseline = {
      aggregate: { avgDistance: 0.20 },
      modules: [{ name: 'auth', distance: 0.20 }],
    };
    const current = {
      aggregate: { avgDistance: 0.22 },
      modules: [
        { name: 'auth', distance: 0.20 },
        { name: 'cart', distance: 0.25 },
      ],
    };
    const comparison = entropy.compareSnapshots(current, baseline);
    const cartComp = comparison.moduleComparisons.find(m => m.name === 'cart');
    assert.ok(cartComp, 'New module should appear in comparison');
    assert.strictEqual(cartComp.status, 'new');
  });

  it('saveSnapshot + loadSnapshot roundtrip', () => {
    const report = {
      timestamp: new Date().toISOString(),
      phase: 10,
      aggregate: { avgDistance: 0.25, health: 'green' },
      modules: [{ name: 'auth', distance: 0.2, instability: 0.4 }],
    };
    entropy.saveSnapshot(tmpDir, 10, report);

    const loaded = entropy.loadSnapshot(tmpDir, 10);
    assert.ok(loaded, 'Snapshot should be loadable');
    assert.strictEqual(loaded.phase, 10);
    assert.strictEqual(loaded.aggregate.avgDistance, 0.25);
    assert.strictEqual(loaded.modules[0].name, 'auth');
  });

  it('loadSnapshot returns null for missing phase', () => {
    const loaded = entropy.loadSnapshot(tmpDir, 99);
    assert.strictEqual(loaded, null);
  });

  it('formatEntropyReport produces readable output', () => {
    const report = {
      timestamp: new Date().toISOString(),
      aggregate: {
        totalFiles: 50,
        totalModules: 4,
        avgInstability: 0.35,
        avgDistance: 0.22,
        avgCohesion: 0.68,
        totalLargeFiles: 2,
        health: 'green',
      },
      modules: [
        { name: 'auth', instability: 0.3, abstractness: 0.4, distance: 0.3, cohesion: 0.8, avgComplexity: 5, fileCount: 12 },
        { name: 'cart', instability: 0.5, abstractness: 0.2, distance: 0.3, cohesion: 0.6, avgComplexity: 8, fileCount: 15 },
      ],
    };
    const output = entropy.formatEntropyReport(report);
    assert.ok(output.includes('Entropy Report'), 'Should have title');
    assert.ok(output.includes('auth'), 'Should list auth module');
    assert.ok(output.includes('cart'), 'Should list cart module');
    assert.ok(output.includes('green') || output.includes('GREEN'), 'Should show health status');
  });
});
