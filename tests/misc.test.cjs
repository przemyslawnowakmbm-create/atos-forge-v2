const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createTmpDir, cleanTmpDir, createPlanningDir } = require('./helpers.cjs');
const misc = require(path.join(__dirname, '..', 'atos-forge', 'bin', 'lib', 'misc.cjs'));

describe('misc.cjs', () => {
  it('cmdGenerateSlug generates correct slugs via core', () => {
    const core = require(path.join(__dirname, '..', 'atos-forge', 'bin', 'lib', 'core.cjs'));
    assert.strictEqual(core.generateSlugInternal('Add Dark Mode'), 'add-dark-mode');
  });

  it('cmdVerifyPathExists is a function', () => {
    assert.ok(typeof misc.cmdVerifyPathExists === 'function');
  });

  it('cmdListTodos is a function', () => {
    assert.ok(typeof misc.cmdListTodos === 'function');
  });

  it('cmdCurrentTimestamp is a function', () => {
    assert.ok(typeof misc.cmdCurrentTimestamp === 'function');
  });

  it('cmdResolveModel is a function', () => {
    assert.ok(typeof misc.cmdResolveModel === 'function');
  });
});
