'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { createTmpDir, cleanTmpDir } = require('./helpers.cjs');

const mod = require(path.join(__dirname, '..', 'atos-forge', 'bin', 'lib', 'req-conflicts.cjs'));

describe('req-conflicts.cjs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanTmpDir(tmpDir);
  });

  // ─── 1. detectCycles: simple A→B→A ────────────────────────────────────────

  it('detectCycles finds simple A→B→A cycle', () => {
    const graph = new Map();
    graph.set('AUTH-01', ['AUTH-02']);
    graph.set('AUTH-02', ['AUTH-01']);
    const cycles = mod.detectCycles(graph);
    assert.ok(cycles.length >= 1, 'should find at least one cycle');
    // The cycle should contain both nodes
    const flat = cycles.flat();
    assert.ok(flat.includes('AUTH-01'), 'cycle must contain AUTH-01');
    assert.ok(flat.includes('AUTH-02'), 'cycle must contain AUTH-02');
  });

  // ─── 2. detectCycles: multi-node A→B→C→A ─────────────────────────────────

  it('detectCycles finds multi-node A→B→C→A cycle', () => {
    const graph = new Map();
    graph.set('AUTH-01', ['PROD-01']);
    graph.set('PROD-01', ['PAY-01']);
    graph.set('PAY-01', ['AUTH-01']);
    const cycles = mod.detectCycles(graph);
    assert.ok(cycles.length >= 1, 'should find at least one cycle');
    const flat = cycles.flat();
    assert.ok(flat.includes('AUTH-01'));
    assert.ok(flat.includes('PROD-01'));
    assert.ok(flat.includes('PAY-01'));
  });

  // ─── 3. detectCycles: acyclic graph ───────────────────────────────────────

  it('detectCycles returns empty for acyclic graph', () => {
    const graph = new Map();
    graph.set('AUTH-01', ['AUTH-02']);
    graph.set('AUTH-02', ['AUTH-03']);
    graph.set('AUTH-03', []);
    const cycles = mod.detectCycles(graph);
    assert.strictEqual(cycles.length, 0, 'acyclic graph should have no cycles');
  });

  // ─── 4. parseRequirementsGraph: extracts depends_on correctly ─────────────

  it('parseRequirementsGraph extracts depends_on correctly from markdown', () => {
    const content = [
      '# Requirements',
      '',
      '## Authentication',
      '',
      '- [ ] **AUTH-01**: User can log in with email and password',
      '  depends_on: [AUTH-02, PROD-01]',
      '- [ ] **AUTH-02**: System stores hashed passwords in database',
      '',
      '## Products',
      '',
      '- [ ] **PROD-01**: User can view product listings on the homepage',
      '  depends_on: [AUTH-01]',
    ].join('\n');

    const result = mod.parseRequirementsGraph(content);
    assert.strictEqual(result.requirements.length, 3);
    assert.deepStrictEqual(result.depGraph.get('AUTH-01'), ['AUTH-02', 'PROD-01']);
    assert.deepStrictEqual(result.depGraph.get('PROD-01'), ['AUTH-01']);
    assert.deepStrictEqual(result.depGraph.get('AUTH-02'), []);
  });

  // ─── 5. parseRequirementsGraph: requirements without depends_on ───────────

  it('parseRequirementsGraph handles requirements without depends_on', () => {
    const content = [
      '# Requirements',
      '',
      '## Auth',
      '',
      '- [ ] **AUTH-01**: User can log in',
      '- [x] **AUTH-02**: System validates tokens',
    ].join('\n');

    const result = mod.parseRequirementsGraph(content);
    assert.strictEqual(result.requirements.length, 2);
    assert.deepStrictEqual(result.depGraph.get('AUTH-01'), []);
    assert.deepStrictEqual(result.depGraph.get('AUTH-02'), []);
  });

  // ─── 6. detectOverlappingScope: flags high-overlap cross-category ─────────

  it('detectOverlappingScope flags high-overlap cross-category requirements', () => {
    const requirements = [
      { id: 'AUTH-01', text: 'implement secure token validation endpoint returning JWT claims', category: 'Auth' },
      { id: 'PAY-01', text: 'implement secure token validation endpoint returning payment claims', category: 'Payment' },
    ];
    const conflicts = mod.detectOverlappingScope(requirements);
    assert.ok(conflicts.length >= 1, 'should flag overlapping scope');
    assert.strictEqual(conflicts[0].type, 'overlapping_scope');
  });

  // ─── 7. detectOverlappingScope: ignores same-category overlap ─────────────

  it('detectOverlappingScope ignores same-category overlap', () => {
    const requirements = [
      { id: 'AUTH-01', text: 'implement secure token validation endpoint returning JWT claims', category: 'Auth' },
      { id: 'AUTH-02', text: 'implement secure token refresh endpoint returning JWT claims', category: 'Auth' },
    ];
    const conflicts = mod.detectOverlappingScope(requirements);
    assert.strictEqual(conflicts.length, 0, 'same-category overlap should be ignored');
  });

  // ─── 8. detectTechConflicts: flags exclusive tech in different categories ─

  it('detectTechConflicts flags postgresql vs mongodb in different requirements', () => {
    const requirements = [
      { id: 'AUTH-01', text: 'Store user credentials in postgresql database', category: 'Auth' },
      { id: 'PROD-01', text: 'Store product catalog in mongodb collection', category: 'Products' },
    ];
    const conflicts = mod.detectTechConflicts(requirements);
    assert.ok(conflicts.length >= 1, 'should flag database tech conflict');
    assert.strictEqual(conflicts[0].type, 'tech_conflict');
    assert.strictEqual(conflicts[0].severity, 'blocker');
  });

  // ─── 9. detectTechConflicts: ignores non-exclusive tech ───────────────────

  it('detectTechConflicts ignores non-exclusive technologies', () => {
    const requirements = [
      { id: 'AUTH-01', text: 'Store user sessions in postgresql database', category: 'Auth' },
      { id: 'CACHE-01', text: 'Cache session tokens in redis store', category: 'Cache' },
    ];
    const conflicts = mod.detectTechConflicts(requirements);
    assert.strictEqual(conflicts.length, 0, 'postgresql and redis are not exclusive');
  });

  // ─── 10. detectConflicts aggregates all checks ────────────────────────────

  it('detectConflicts aggregates all checks into single result', () => {
    const content = [
      '# Requirements',
      '',
      '## Auth',
      '',
      '- [ ] **AUTH-01**: User can log in with postgresql database backend',
      '  depends_on: [AUTH-02]',
      '- [ ] **AUTH-02**: System validates JWT tokens',
      '  depends_on: [AUTH-01]',
      '',
      '## Products',
      '',
      '- [ ] **PROD-01**: User can browse products stored in mongodb collection',
    ].join('\n');

    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), content);

    const result = mod.detectConflicts(tmpDir);
    assert.ok(result.conflicts.length >= 1, 'should have conflicts');
    assert.ok(typeof result.has_blockers === 'boolean');
    assert.ok(result.summary);
    assert.ok(typeof result.summary.cycles === 'number');
    assert.ok(typeof result.summary.overlaps === 'number');
    assert.ok(typeof result.summary.tech_conflicts === 'number');
    assert.ok(typeof result.summary.total === 'number');
  });

  // ─── 11. has_blockers is true when cycles exist ───────────────────────────

  it('has_blockers is true when cycles exist', () => {
    const content = [
      '# Requirements',
      '',
      '## Auth',
      '',
      '- [ ] **AUTH-01**: User can log in',
      '  depends_on: [AUTH-02]',
      '- [ ] **AUTH-02**: System validates tokens',
      '  depends_on: [AUTH-01]',
    ].join('\n');

    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), content);

    const result = mod.detectConflicts(tmpDir);
    assert.strictEqual(result.has_blockers, true, 'cycles should be blockers');
  });

  // ─── 12. has_blockers is false for warnings-only ──────────────────────────

  it('has_blockers is false for warnings-only (overlapping scope)', () => {
    const content = [
      '# Requirements',
      '',
      '## Auth',
      '',
      '- [ ] **AUTH-01**: Implement secure token validation endpoint returning JWT claims',
      '',
      '## Payment',
      '',
      '- [ ] **PAY-01**: Implement secure token validation endpoint returning payment claims',
    ].join('\n');

    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), content);

    const result = mod.detectConflicts(tmpDir);
    assert.strictEqual(result.has_blockers, false, 'overlaps are warnings, not blockers');
  });

  // ─── 13. Handles empty requirements file gracefully ───────────────────────

  it('handles empty requirements file gracefully', () => {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), '# Requirements\n');

    const result = mod.detectConflicts(tmpDir);
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(result.has_blockers, false);
    assert.strictEqual(result.summary.total, 0);
  });

  // ─── 14. Cross-service: same entity claimed by different categories ───────

  it('detects same entity claimed by two different categories with different definitions', () => {
    const requirements = [
      { id: 'AUTH-01', text: 'User entity stores email password role validated fields in postgresql database table', category: 'Auth' },
      { id: 'BILLING-01', text: 'User entity stores email address role validated fields in postgresql database records', category: 'Billing' },
    ];
    // Both reference "User entity" with nearly identical keywords across different categories
    // This should be detected via overlapping scope (high keyword overlap cross-category)
    const conflicts = mod.detectOverlappingScope(requirements);
    assert.ok(conflicts.length >= 1, 'same entity in different categories should flag overlap');
    assert.ok(
      conflicts.some(c => c.req_a === 'AUTH-01' || c.req_b === 'AUTH-01'),
      'should reference AUTH-01'
    );
    assert.ok(
      conflicts.some(c => c.req_a === 'BILLING-01' || c.req_b === 'BILLING-01'),
      'should reference BILLING-01'
    );
  });
});
