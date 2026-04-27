const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fm = require(path.join(__dirname, '..', 'atos-forge', 'bin', 'lib', 'frontmatter.cjs'));

describe('frontmatter.cjs', () => {
  it('extractFrontmatter parses YAML frontmatter', () => {
    const content = '---\nname: Test Plan\nwave: 1\n---\n# Content\nBody text';
    const result = fm.extractFrontmatter(content);
    assert.ok(result);
    assert.strictEqual(result.name, 'Test Plan');
    assert.strictEqual(result.wave, '1');
  });

  it('extractFrontmatter returns empty for no frontmatter', () => {
    const result = fm.extractFrontmatter('# Just markdown\nNo frontmatter');
    assert.ok(result !== null);
    assert.deepStrictEqual(result, {});
  });

  it('reconstructFrontmatter produces valid YAML', () => {
    const obj = { name: 'Test', wave: 2 };
    const yaml = fm.reconstructFrontmatter(obj);
    assert.ok(yaml.includes('name:'));
    assert.ok(yaml.includes('wave:'));
  });

  it('extractFrontmatter + reconstructFrontmatter roundtrip', () => {
    const original = '---\nname: Test\nwave: 1\n---\nBody';
    const parsed = fm.extractFrontmatter(original);
    const rebuilt = fm.reconstructFrontmatter(parsed);
    assert.ok(rebuilt.includes('name:'));
  });

  it('extractFrontmatter handles arrays', () => {
    const content = '---\ntags: [a, b, c]\n---\nBody';
    const result = fm.extractFrontmatter(content);
    assert.ok(Array.isArray(result.tags));
    assert.deepStrictEqual(result.tags, ['a', 'b', 'c']);
  });
});
