const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const core = require(path.join(__dirname, '..', 'atos-forge', 'bin', 'lib', 'core.cjs'));

describe('core.cjs', () => {
  it('generateSlugInternal converts text to slug', () => {
    assert.strictEqual(core.generateSlugInternal('Hello World'), 'hello-world');
    assert.strictEqual(core.generateSlugInternal('Test 123!'), 'test-123');
    assert.strictEqual(core.generateSlugInternal('  spaces  '), 'spaces');
  });

  it('normalizePhaseName pads single digits', () => {
    assert.strictEqual(core.normalizePhaseName('1'), '01');
    assert.strictEqual(core.normalizePhaseName('12'), '12');
    assert.strictEqual(core.normalizePhaseName('1.1'), '01.1');
  });

  it('pathExistsInternal returns correct results', () => {
    const result = core.pathExistsInternal(process.cwd(), 'package.json');
    assert.strictEqual(result, true);
    const missing = core.pathExistsInternal(process.cwd(), 'nonexistent-file-xyz.json');
    assert.strictEqual(missing, false);
  });

  it('getForgeRoot returns a path', () => {
    const root = core.getForgeRoot();
    assert.ok(typeof root === 'string');
    assert.ok(root.length > 0);
  });

  it('safeReadFile returns content for existing file', () => {
    const content = core.safeReadFile(path.join(process.cwd(), 'package.json'));
    assert.ok(content !== null);
    assert.ok(content.includes('atos-forge'));
  });

  it('safeReadFile returns null for missing file', () => {
    const content = core.safeReadFile('/nonexistent/path/file.txt');
    assert.strictEqual(content, null);
  });

  it('parseIncludeFlag parses comma-separated values', () => {
    const result = core.parseIncludeFlag(['--include', 'a,b,c']);
    assert.ok(result instanceof Set);
    assert.ok(result.has('a'));
    assert.ok(result.has('b'));
    assert.ok(result.has('c'));
  });

  it('parseIncludeFlag returns empty set when no flag', () => {
    const result = core.parseIncludeFlag(['--other', 'value']);
    assert.strictEqual(result.size, 0);
  });
});
