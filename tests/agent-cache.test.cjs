const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cache = require(path.join(__dirname, '..', 'forge-agents', 'cache'));

describe('agent-cache', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-test-'));
    // Create .forge directory structure
    fs.mkdirSync(path.join(tmpDir, '.forge', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.forge', 'session'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.forge', 'knowledge'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computeInputHash returns consistent hash for same inputs', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test Plan\nDo something.');
    const h1 = cache.computeInputHash(planPath, tmpDir);
    const h2 = cache.computeInputHash(planPath, tmpDir);
    assert.ok(h1);
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 64); // SHA-256 hex
  });

  it('computeInputHash changes when plan content changes', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Plan v1');
    const h1 = cache.computeInputHash(planPath, tmpDir);
    fs.writeFileSync(planPath, '# Plan v2');
    const h2 = cache.computeInputHash(planPath, tmpDir);
    assert.notStrictEqual(h1, h2);
  });

  it('computeInputHash returns null for missing plan', () => {
    const h = cache.computeInputHash('/nonexistent/plan.md', tmpDir);
    assert.strictEqual(h, null);
  });

  it('loadCached returns miss when cache is empty', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');
    const result = cache.loadCached(planPath, tmpDir, 'test-task');
    assert.strictEqual(result.hit, false);
  });

  it('saveToCache + loadCached round-trip works', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test Plan');

    const factoryResult = {
      agentConfig: {
        task_id: 'test-task',
        archetype: 'specialist',
        archetype_reason: 'test reason',
        plan_meta: { path: 'plan.md', files_modified: ['a.js'] },
        verification_steps: ['typescript'],
        capabilities: { mod: [{ capability: 'testing', confidence: 0.8 }] },
        context: { always_load: [], task_specific: [], reference: [] },
        system_prompt: 'You are a test agent.',
      },
      containerParams: { taskId: 'test-task' },
      analysis: {
        archetype: { archetype: 'specialist', reason: 'test' },
        risk: { level: 'LOW', score: 5, reasons: [] },
        affectedModules: ['mod'],
        capabilities: {},
        verificationSteps: ['typescript'],
      },
    };

    cache.saveToCache(planPath, tmpDir, 'test-task', factoryResult);

    const loaded = cache.loadCached(planPath, tmpDir, 'test-task');
    assert.strictEqual(loaded.hit, true);
    assert.strictEqual(loaded.result.agentConfig.archetype, 'specialist');
    assert.strictEqual(loaded.result.agentConfig.task_id, 'test-task');
  });

  it('loadCached returns miss when plan changes after save', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Plan v1');

    const factoryResult = {
      agentConfig: { task_id: 't', archetype: 'general', plan_meta: {}, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    };

    cache.saveToCache(planPath, tmpDir, 'test-task', factoryResult);

    // Change plan
    fs.writeFileSync(planPath, '# Plan v2 - changed');

    const loaded = cache.loadCached(planPath, tmpDir, 'test-task');
    assert.strictEqual(loaded.hit, false);
  });

  it('listAgents returns saved agents', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');

    const factoryResult = {
      agentConfig: { task_id: 'agent-1', archetype: 'careful', archetype_reason: 'high risk', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'HIGH' }, affectedModules: ['core'] },
    };

    cache.saveToCache(planPath, tmpDir, 'agent-1', factoryResult);

    const agents = cache.listAgents(tmpDir);
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].task_id, 'agent-1');
    assert.strictEqual(agents[0].archetype, 'careful');
    assert.strictEqual(agents[0].stale, false);
  });

  it('showAgent returns full details', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');

    const factoryResult = {
      agentConfig: { task_id: 'agent-x', archetype: 'integrator', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'MEDIUM' }, affectedModules: ['a', 'b', 'c'] },
    };

    cache.saveToCache(planPath, tmpDir, 'agent-x', factoryResult);
    const detail = cache.showAgent(tmpDir, 'agent-x');
    assert.strictEqual(detail.found, true);
    assert.strictEqual(detail.meta.archetype, 'integrator');
    assert.strictEqual(detail.meta.stale, false);
  });

  it('invalidateStale removes stale entries', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');

    cache.saveToCache(planPath, tmpDir, 'agent-a', {
      agentConfig: { task_id: 'agent-a', archetype: 'general', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    });

    // Make stale by changing plan
    fs.writeFileSync(planPath, '# Changed');

    const removed = cache.invalidateStale(tmpDir);
    assert.strictEqual(removed, 1);
    assert.strictEqual(cache.listAgents(tmpDir).length, 0);
  });

  it('clearAll removes all agents', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');

    cache.saveToCache(planPath, tmpDir, 'a1', {
      agentConfig: { task_id: 'a1', archetype: 'general', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    });
    cache.saveToCache(planPath, tmpDir, 'a2', {
      agentConfig: { task_id: 'a2', archetype: 'specialist', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    });

    const count = cache.clearAll(tmpDir);
    assert.strictEqual(count, 2);

    const registry = cache.loadRegistry(tmpDir);
    assert.strictEqual(Object.keys(registry.agents).length, 0);
  });

  it('invalidateOne removes specific agent', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Test');

    cache.saveToCache(planPath, tmpDir, 'keep-me', {
      agentConfig: { task_id: 'keep-me', archetype: 'general', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    });
    cache.saveToCache(planPath, tmpDir, 'remove-me', {
      agentConfig: { task_id: 'remove-me', archetype: 'general', plan_meta: { path: planPath }, verification_steps: [], capabilities: {} },
      analysis: { risk: { level: 'LOW' }, affectedModules: [] },
    });

    const existed = cache.invalidateOne(tmpDir, 'remove-me');
    assert.strictEqual(existed, true);
    assert.strictEqual(cache.listAgents(tmpDir).length, 1);
    assert.strictEqual(cache.listAgents(tmpDir)[0].task_id, 'keep-me');
  });
});
