const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FORGE_ROOT = path.resolve(__dirname, '..');

// Helper: create temp project directory
function createTmpProject() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-glossary-'));
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  return dir;
}

function cleanTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('glossary', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpProject(); });
  afterEach(() => { cleanTmp(tmpDir); });

  it('loadGlossary returns null when .forge/glossary.md missing', () => {
    // Clear module cache to get fresh factory
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    assert.strictEqual(result, null);
  });

  it('loadGlossary parses valid markdown table into terms array', () => {
    fs.writeFileSync(path.join(tmpDir, '.forge', 'glossary.md'), `# Domain Glossary

| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| Order | A confirmed purchase with payment | Purchase, Transaction | CART, CHECK |
| Cart | Collection of items before payment | Shopping bag, Basket | CART |
| SKU | Stock Keeping Unit identifier | Product variant | PROD |
`);
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    assert.ok(result);
    assert.strictEqual(result.terms.length, 3);
    assert.strictEqual(result.terms[0].term, 'Order');
    assert.strictEqual(result.terms[0].definition, 'A confirmed purchase with payment');
    assert.strictEqual(result.terms[0].aliases, 'Purchase, Transaction');
    assert.strictEqual(result.terms[2].term, 'SKU');
  });

  it('loadGlossary skips header and separator rows', () => {
    fs.writeFileSync(path.join(tmpDir, '.forge', 'glossary.md'), `| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| Order | A purchase | - | CART |
`);
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    assert.ok(result);
    assert.strictEqual(result.terms.length, 1);
    assert.strictEqual(result.terms[0].term, 'Order');
  });

  it('loadGlossary returns null for empty file', () => {
    fs.writeFileSync(path.join(tmpDir, '.forge', 'glossary.md'), '');
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    assert.strictEqual(result, null);
  });

  it('loadGlossary loads system-level glossary from parent .forge-system/', () => {
    // Create system-level glossary in parent directory
    const systemDir = path.join(tmpDir, '.forge-system');
    fs.mkdirSync(systemDir, { recursive: true });
    fs.writeFileSync(path.join(systemDir, 'glossary.md'), `| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| Customer | A person who buys products | Buyer, User | AUTH, CART |
`);
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    // Service glossary is null (no .forge/glossary.md), but system should be found
    const systemResult = factory.loadSystemGlossary(tmpDir);
    assert.ok(systemResult);
    assert.strictEqual(systemResult.terms.length, 1);
    assert.strictEqual(systemResult.terms[0].term, 'Customer');
  });

  it('loadGlossary handles malformed rows gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, '.forge', 'glossary.md'), `| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| Order | A purchase | - | CART |
| this is not a valid row
| Item | A product in cart | - | CART |
`);
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const result = factory.loadGlossary(tmpDir);
    assert.ok(result);
    assert.strictEqual(result.terms.length, 2); // Order + Item, skips malformed
  });

  it('composeSystemPrompt includes Domain Glossary when glossary exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.forge', 'glossary.md'), `| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| Order | A confirmed purchase | Purchase | CART |
`);
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    // Minimal analysis object for composeSystemPrompt
    const analysis = {
      plan: { path: null, all_files: [], objective: '', raw: '', frontmatter: {}, files_modified: [], tasks: [] },
      capabilities: {}, affectedModules: [], risk: { level: 'LOW', score: 0, reasons: [] },
      cycles: { count: 0 }, graphContext: null, systemContext: null,
      ledgerState: { exists: false }, ledgerContent: '', hasGraph: false,
    };
    const arc = factory.determineArchetype(analysis);
    const ctx = factory.extractSessionContext(analysis);
    const prompt = factory.composeSystemPrompt(analysis, arc, ctx, tmpDir);
    assert.ok(prompt.includes('## Domain Glossary'), 'Prompt should contain Domain Glossary section');
    assert.ok(prompt.includes('Order'), 'Prompt should contain glossary term');
  });

  it('composeSystemPrompt omits glossary when file missing', () => {
    Object.keys(require.cache).filter(k => k.includes('factory')).forEach(k => delete require.cache[k]);
    const factory = require(path.join(FORGE_ROOT, 'forge-agents', 'factory'));
    const analysis = {
      plan: { path: null, all_files: [], objective: '', raw: '', frontmatter: {}, files_modified: [], tasks: [] },
      capabilities: {}, affectedModules: [], risk: { level: 'LOW', score: 0, reasons: [] },
      cycles: { count: 0 }, graphContext: null, systemContext: null,
      ledgerState: { exists: false }, ledgerContent: '', hasGraph: false,
    };
    const arc = factory.determineArchetype(analysis);
    const ctx = factory.extractSessionContext(analysis);
    const prompt = factory.composeSystemPrompt(analysis, arc, ctx, tmpDir);
    assert.ok(!prompt.includes('## Domain Glossary'), 'Prompt should NOT contain Domain Glossary section');
  });
});
