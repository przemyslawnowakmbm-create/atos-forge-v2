const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FORGE_ROOT = path.resolve(__dirname, '..');

function createTmpProject() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-contracts-'));
  fs.mkdirSync(path.join(dir, '.forge-system'), { recursive: true });
  return dir;
}

function cleanTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('contract-verifier', () => {
  let tmpDir;
  let contracts;

  beforeEach(() => {
    tmpDir = createTmpProject();
    Object.keys(require.cache).filter(k => k.includes('contract-verifier')).forEach(k => delete require.cache[k]);
    contracts = require(path.join(FORGE_ROOT, 'forge-system', 'contract-verifier'));
  });
  afterEach(() => { cleanTmp(tmpDir); });

  it('parseContractRegistry extracts REST contracts from markdown', () => {
    const registry = `# Contract Registry

## auth-service → catalog-service

### GET /api/v1/users/:id
- **Type:** REST
- **Provider:** auth-service
- **Consumer:** catalog-service
- **Response:** { id: string, email: string, name: string }
- **Status codes:** 200, 404
`;
    const result = contracts.parseContractRegistry(registry);
    assert.ok(result.length >= 1, 'Should parse at least one contract');
    assert.strictEqual(result[0].type, 'REST');
    assert.strictEqual(result[0].provider, 'auth-service');
    assert.strictEqual(result[0].consumer, 'catalog-service');
    assert.ok(result[0].endpoint.includes('/api/v1/users'));
  });

  it('parseContractRegistry extracts event contracts', () => {
    const registry = `# Contract Registry

## order-service → notification-service

### Event: order.completed
- **Type:** Event
- **Provider:** order-service
- **Consumer:** notification-service
- **Payload:** { orderId: string, userId: string, total: number }
- **Channel:** orders.events
`;
    const result = contracts.parseContractRegistry(registry);
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].type, 'Event');
    assert.strictEqual(result[0].provider, 'order-service');
    assert.ok(result[0].endpoint.includes('order.completed'));
  });

  it('detectBreakingChanges identifies removed endpoint', () => {
    const baseline = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id, email }' },
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users', response: '{ users[] }' },
    ];
    const current = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id, email }' },
    ];
    const breaks = contracts.detectBreakingChanges(baseline, current);
    assert.ok(breaks.length >= 1, 'Should detect removed endpoint');
    assert.strictEqual(breaks[0].type, 'endpoint_removed');
    assert.ok(breaks[0].endpoint.includes('/api/users'));
  });

  it('detectBreakingChanges identifies changed response schema', () => {
    const baseline = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id: string, email: string, name: string }' },
    ];
    const current = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id: string, email: string }' },
    ];
    const breaks = contracts.detectBreakingChanges(baseline, current);
    assert.ok(breaks.length >= 1, 'Should detect response change');
    assert.strictEqual(breaks[0].type, 'response_changed');
  });

  it('detectBreakingChanges returns empty for no changes', () => {
    const contracts_list = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id, email }' },
    ];
    const breaks = contracts.detectBreakingChanges(contracts_list, contracts_list);
    assert.strictEqual(breaks.length, 0);
  });

  it('verifyContracts returns pass when no registry exists', () => {
    const result = contracts.verifyContracts(tmpDir, {});
    assert.ok(result.passed || result.skipped, 'Should pass or skip when no registry');
  });

  it('saveContractBaseline writes baseline file', () => {
    const contractsList = [
      { type: 'REST', provider: 'auth', consumer: 'catalog', endpoint: 'GET /api/users/:id', response: '{ id }' },
    ];
    contracts.saveContractBaseline(tmpDir, contractsList);
    const baselinePath = path.join(tmpDir, '.forge-system', 'contract-baseline.json');
    assert.ok(fs.existsSync(baselinePath), 'Baseline should be written');
    const loaded = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.strictEqual(loaded.contracts.length, 1);
  });

  it('loadContractBaseline returns null when missing', () => {
    const result = contracts.loadContractBaseline(tmpDir);
    assert.strictEqual(result, null);
  });
});
