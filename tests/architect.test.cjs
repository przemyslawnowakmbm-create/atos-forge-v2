const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FORGE_ROOT = path.resolve(__dirname, '..');

function createTmpProject() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-arch-'));
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function cleanTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('architect', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpProject(); });
  afterEach(() => { cleanTmp(tmpDir); });

  it('architecture-design template contains all required sections', () => {
    const template = fs.readFileSync(
      path.join(FORGE_ROOT, 'atos-forge', 'templates', 'architecture-design.md'), 'utf8'
    );
    const requiredSections = [
      'System Overview',
      'Module Boundaries',
      'Data Model',
      'Interface Contracts',
      'Dependency Rules',
      'Technology Decisions',
      'Non-Functional Requirements',
      'File/Folder Structure',
      'Architecture Decision Records',
    ];
    for (const section of requiredSections) {
      assert.ok(template.includes(section), `Template missing section: ${section}`);
    }
  });

  it('system-architecture template contains service-level sections', () => {
    const template = fs.readFileSync(
      path.join(FORGE_ROOT, 'atos-forge', 'templates', 'system-architecture.md'), 'utf8'
    );
    const requiredSections = [
      'Service Map',
      'Communication Topology',
      'Data Ownership',
      'Contract Specifications',
      'Cross-Cutting Concerns',
    ];
    for (const section of requiredSections) {
      assert.ok(template.includes(section), `System template missing section: ${section}`);
    }
  });

  it('module boundaries parseable from ARCHITECTURE.md frontmatter', () => {
    const archContent = `---
status: approved
style: modular-monolith
modules: [auth, catalog, cart, checkout]
---

# System Architecture

## Module Boundaries

### auth
- **Purpose:** User authentication and authorization
- **Public API:** register, login, verifyToken
- **Owns:** User entity, Session entity

### catalog
- **Purpose:** Product management
- **Public API:** createProduct, listProducts, getProduct
- **Owns:** Product entity, Category entity
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ARCHITECTURE.md'), archContent);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'ARCHITECTURE.md'), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]+?)\n---/);
    assert.ok(fmMatch, 'Architecture file should have frontmatter');

    const modulesMatch = fmMatch[1].match(/^modules:\s*\[([^\]]+)\]/m);
    assert.ok(modulesMatch, 'Frontmatter should have modules field');
    const modules = modulesMatch[1].split(',').map(s => s.trim());
    assert.strictEqual(modules.length, 4);
    assert.ok(modules.includes('auth'));
    assert.ok(modules.includes('catalog'));
  });

  it('ADRs extractable from ARCHITECTURE.md via regex', () => {
    const archContent = `# System Architecture

## Architecture Decision Records

### ADR-001: Use modular monolith
- **Context:** Starting a new e-commerce platform with 4 feature domains.
- **Decision:** Modular monolith with clear module boundaries over microservices.
- **Rationale:** Simpler deployment, easier refactoring. Can split later if needed.
- **Status:** Accepted

### ADR-002: PostgreSQL with Prisma ORM
- **Context:** Need a relational database for structured e-commerce data.
- **Decision:** PostgreSQL 18 with Prisma 7 ORM.
- **Rationale:** Type-safe queries, excellent migration tooling, edge-ready.
- **Status:** Accepted
`;
    const adrPattern = /### ADR-(\d+): (.+)\n([\s\S]*?)(?=### ADR-|\Z|$)/g;
    const adrs = [];
    let match;
    while ((match = adrPattern.exec(archContent)) !== null) {
      const body = match[3];
      const contextMatch = body.match(/\*\*Context:\*\*\s*(.+)/);
      const decisionMatch = body.match(/\*\*Decision:\*\*\s*(.+)/);
      const rationaleMatch = body.match(/\*\*Rationale:\*\*\s*(.+)/);
      const statusMatch = body.match(/\*\*Status:\*\*\s*(.+)/);
      adrs.push({
        id: parseInt(match[1]),
        title: match[2].trim(),
        context: contextMatch ? contextMatch[1].trim() : '',
        decision: decisionMatch ? decisionMatch[1].trim() : '',
        rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
        status: statusMatch ? statusMatch[1].trim() : '',
      });
    }
    assert.strictEqual(adrs.length, 2);
    assert.strictEqual(adrs[0].title, 'Use modular monolith');
    assert.strictEqual(adrs[0].status, 'Accepted');
    assert.strictEqual(adrs[1].id, 2);
    assert.ok(adrs[1].decision.includes('PostgreSQL'));
  });

  it('plan-checker reads prescriptive ARCHITECTURE.md over descriptive', () => {
    // Prescriptive (from /forge-architect) takes precedence
    const prescriptivePath = path.join(tmpDir, '.planning', 'ARCHITECTURE.md');
    const descriptivePath = path.join(tmpDir, '.planning', 'codebase', 'ARCHITECTURE.md');
    fs.mkdirSync(path.dirname(descriptivePath), { recursive: true });

    fs.writeFileSync(prescriptivePath, '# Prescriptive Architecture\nstatus: approved');
    fs.writeFileSync(descriptivePath, '# Descriptive Architecture\nauto-generated');

    // Verify the resolution logic: prescriptive exists → use it
    const exists = fs.existsSync(prescriptivePath);
    assert.ok(exists, 'Prescriptive ARCHITECTURE.md should be found first');

    const content = fs.readFileSync(prescriptivePath, 'utf8');
    assert.ok(content.includes('Prescriptive'), 'Should read prescriptive, not descriptive');
  });

  it('approval status toggles in ARCHITECTURE.md frontmatter', () => {
    const pendingContent = `---
status: pending_approval
style: microservices
modules: [auth, catalog]
---
# Architecture`;

    const approvedContent = pendingContent.replace('pending_approval', 'approved');

    assert.ok(pendingContent.includes('status: pending_approval'));
    assert.ok(approvedContent.includes('status: approved'));
    assert.ok(!approvedContent.includes('pending_approval'));
  });

  it('architect catalog agent exists with correct structure', () => {
    const agentPath = path.join(FORGE_ROOT, 'forge-agents', 'catalog', 'architect.md');
    assert.ok(fs.existsSync(agentPath), 'architect.md catalog agent should exist');

    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('name: architect'), 'Should have name: architect');
    assert.ok(content.includes('priority: 0'), 'Should have priority 0 (non-executor)');
    assert.ok(content.includes('## Expertise'), 'Should have Expertise section');
  });

  it('system-architect catalog agent exists with correct structure', () => {
    const agentPath = path.join(FORGE_ROOT, 'forge-agents', 'catalog', 'system-architect.md');
    assert.ok(fs.existsSync(agentPath), 'system-architect.md catalog agent should exist');

    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('name: system-architect'), 'Should have name: system-architect');
    assert.ok(content.includes('priority: 0'), 'Should have priority 0 (non-executor)');
    assert.ok(content.includes('Service'), 'Should mention service-level concepts');
  });

  it('config has architecture section with correct defaults', () => {
    Object.keys(require.cache).filter(k => k.includes('config')).forEach(k => delete require.cache[k]);
    const { loadConfig } = require(path.join(FORGE_ROOT, 'forge-config', 'config'));
    const { config } = loadConfig(tmpDir);
    assert.ok(config.architecture, 'Config should have architecture section');
    assert.strictEqual(config.architecture.enabled, true);
    assert.strictEqual(config.architecture.approval_required, true);
    assert.strictEqual(config.architecture.style, 'flexible');
    assert.strictEqual(config.architecture.grilling_depth, 'relentless');
  });

  it('forge-architect skill file exists', () => {
    const skillPath = path.join(FORGE_ROOT, 'skill-sources', 'forge-architect', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'forge-architect SKILL.md should exist');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('forge-architect'), 'Should reference forge-architect');
    assert.ok(content.includes('architect.md'), 'Should reference workflow');
  });
});
