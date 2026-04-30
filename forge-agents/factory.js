#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Catalog-Based Agent Factory (V2)
// ============================================================
// Builds agent configurations by selecting specialist agents from
// a curated catalog, then injecting plan-specific context:
// 1. Analyzing the task (graph context, capabilities, risk, ledger)
// 2. Matching against agent catalog → selecting specialist(s)
// 3. Loading agent definition + injecting Plan Contract + context
// 4. Assembling a context package (always_load / task_specific / reference)
// 5. Defining verification criteria from plan + capabilities
// ============================================================

// Lazy-loaded dependencies (only resolved when called)
let _graphQuery, _ledger, _assessor, _capDetector, _systemQuery, _knowledge, _agentCache, _catalog;

function graphQuery() {
  if (!_graphQuery) _graphQuery = require('../forge-graph/query');
  return _graphQuery;
}
function ledger() {
  if (!_ledger) _ledger = require('../forge-session/ledger');
  return _ledger;
}
function assessor() {
  if (!_assessor) _assessor = require('./plan-assessment');
  return _assessor;
}
function capDetector() {
  if (!_capDetector) _capDetector = require('../forge-graph/capability-detector');
  return _capDetector;
}
function systemQuery() {
  if (!_systemQuery) _systemQuery = require('../forge-system/query');
  return _systemQuery;
}
function knowledge() {
  if (!_knowledge) _knowledge = require('../forge-session/knowledge');
  return _knowledge;
}
function agentCache() {
  if (!_agentCache) _agentCache = require('./cache');
  return _agentCache;
}

// ============================================================
// Agent Catalog
// ============================================================

function loadCatalog() {
  if (_catalog) return _catalog;

  const catalogDir = path.join(__dirname, 'catalog');
  _catalog = [];

  if (!fs.existsSync(catalogDir)) return _catalog;

  const files = fs.readdirSync(catalogDir).filter(f => f.endsWith('.md')).sort();
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(catalogDir, file), 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
      if (!fmMatch) continue;

      const yaml = fmMatch[1];
      const body = fmMatch[2].trim();

      const entry = { file, body, matches: {} };
      let currentBlock = null;

      for (const line of yaml.split('\n')) {
        // Nested key under matches: block (indented with spaces)
        if (currentBlock === 'matches' && /^\s+\w+:/.test(line)) {
          const mkv = line.match(/^\s+(\w+):\s*\[([^\]]*)\]/);
          if (mkv) {
            entry.matches[mkv[1]] = mkv[2].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          }
          continue;
        }

        // Top-level key
        const kv = line.match(/^(\w+):\s*(.*)/);
        if (!kv) continue;
        const [, key, val] = kv;

        if (key === 'matches' && val.trim() === '') {
          currentBlock = 'matches';
          continue;
        }
        currentBlock = null;

        if (val.startsWith('[')) {
          // Inline array — handle multi-line arrays by collecting until closing bracket
          const fullVal = val.endsWith(']') ? val : val;
          entry[key] = fullVal.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
          entry[key] = val.trim().replace(/^["']|["']$/g, '');
        }
      }

      entry.priority = parseInt(entry.priority, 10) || 5;
      _catalog.push(entry);
    } catch (err) {
      // Log malformed catalog file but continue loading others
      if (process.env.FORGE_DEBUG) console.error('Warning: malformed catalog file ' + file + ': ' + err.message);
    }
  }

  return _catalog;
}

/**
 * Match plan analysis against the agent catalog.
 * Returns ranked list of matching agents with scores.
 *
 * @param {object} analysis - From analyzeTask()
 * @returns {{ agent: object, score: number, reason: string }[]}
 */
function matchCatalogAgents(analysis) {
  const catalog = loadCatalog();
  if (catalog.length === 0) return [];

  const planFiles = analysis.plan?.all_files || [];
  const objectiveText = (analysis.plan?.objective || '').toLowerCase();
  const rawText = (analysis.plan?.raw || '').toLowerCase();

  // Extract signals from the plan
  const fileExtensions = new Set(planFiles.map(f => path.extname(f).toLowerCase().replace('.', '')).filter(Boolean));
  const allCaps = Object.values(analysis.capabilities).flat();
  const capNames = new Set(allCaps.map(c => c.capability));

  const scored = [];

  for (const agent of catalog) {
    let score = 0;
    const reasons = [];
    const m = agent.matches || {};

    // Language match (from file extensions) — baseline signal
    const langMap = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', java: 'java', go: 'go', rs: 'rust', kt: 'kotlin', swift: 'swift', dart: 'dart' };
    const planLangs = new Set([...fileExtensions].map(ext => langMap[ext]).filter(Boolean));
    if (m.languages) {
      const langHits = m.languages.filter(l => planLangs.has(l));
      if (langHits.length > 0) { score += 15 * langHits.length; reasons.push(`lang: ${langHits.join(',')}`); }
    }

    // Framework match — strong signal, 2x if found in objective (word-boundary)
    if (m.frameworks) {
      for (const fw of m.frameworks) {
        const fwEsc = fw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fwRe = new RegExp('\\b' + fwEsc + '\\b', 'i');
        if (fwRe.test(objectiveText)) {
          score += 40; reasons.push(`fw(obj): ${fw}`);
        } else if (fwRe.test(rawText)) {
          score += 20; reasons.push(`fw: ${fw}`);
        }
      }
    }

    // File pattern match — weak signal (files touched != plan intent)
    if (m.file_patterns) {
      let patternHits = 0;
      for (const pattern of m.file_patterns) {
        const patternParts = pattern.replace(/\*\*/g, '').replace(/\*/g, '').split('/').filter(Boolean);
        for (const part of patternParts) {
          if (part.startsWith('.')) {
            if (fileExtensions.has(part.replace('.', ''))) { patternHits++; break; }
          } else if (planFiles.some(f => f.includes(part))) {
            patternHits++; break;
          }
        }
      }
      if (patternHits > 0) {
        score += Math.min(patternHits * 5, 15);
        reasons.push(`path: ${patternHits} hits`);
      }
    }

    // Capability match — strong signal
    if (m.capabilities) {
      const capHits = m.capabilities.filter(c => capNames.has(c));
      if (capHits.length > 0) { score += 25 * capHits.length; reasons.push(`cap: ${capHits.join(',')}`); }
    }

    // Keyword match — strongest signal, 3x weight for objective matches (word-boundary)
    if (m.keywords) {
      let kwScore = 0;
      const objHits = [];
      const bodyHits = [];
      for (const kw of m.keywords) {
        const kwEsc = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const kwRe = new RegExp('\\b' + kwEsc + '\\b', 'i');
        if (kwRe.test(objectiveText)) {
          kwScore += 15;
          objHits.push(kw);
        } else if (kwRe.test(rawText)) {
          kwScore += 5;
          bodyHits.push(kw);
        }
      }
      if (kwScore > 0) {
        score += kwScore;
        const parts = [];
        if (objHits.length > 0) parts.push(`kw(obj): ${objHits.length <= 4 ? objHits.join(',') : objHits.length + ' hits'}`);
        if (bodyHits.length > 0) parts.push(`kw: ${bodyHits.length <= 3 ? bodyHits.join(',') : bodyHits.length + ' hits'}`);
        reasons.push(parts.join('; '));
      }
    }

    // Priority weighting
    score += agent.priority;

    if (score > 0) {
      scored.push({ agent, score, reason: reasons.join('; ') });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Extract technology signals from the plan for prompt pruning.
 * Uses the union of all catalog agents' keywords + frameworks as the dictionary.
 */
// Generic terms that appear in nearly every plan — excluded from pruning signals
const GENERIC_TERMS = new Set([
  'api', 'route', 'router', 'endpoint', 'handler', 'controller', 'middleware',
  'request', 'response', 'query', 'table', 'index', 'schema', 'model',
  'component', 'form', 'action', 'build', 'test', 'spec', 'type',
  'client', 'server', 'async', 'cache', 'config', 'service', 'module',
  'import', 'export', 'function', 'class', 'interface', 'error', 'status',
  'auth', 'token', 'session', 'database', 'migration', 'seed',
  'css', 'style', 'layout', 'page', 'view', 'template', 'render',
  'task', 'job', 'worker', 'event', 'log', 'metric', 'artifact',
  'deploy', 'ci', 'pipeline', 'docker', 'container',
]);

function extractPlanSignals(analysis) {
  const catalog = loadCatalog();

  // Only use framework names and specific technology keywords (not generic terms)
  const specificTerms = new Set();
  for (const agent of catalog) {
    const m = agent.matches || {};
    if (m.frameworks) m.frameworks.forEach(f => specificTerms.add(f.toLowerCase()));
    if (m.keywords) {
      m.keywords.forEach(k => {
        const kl = k.toLowerCase();
        if (kl.length > 4 && !GENERIC_TERMS.has(kl)) specificTerms.add(kl);
      });
    }
  }

  const signals = new Set();
  const objectiveLower = (analysis.plan?.objective || '').toLowerCase();
  const rawLower = (analysis.plan?.raw || '').toLowerCase();

  // Match specific terms against plan text (word-boundary to avoid substring false positives)
  for (const term of specificTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(objectiveLower) || re.test(rawLower)) {
      signals.add(term);
    }
  }

  // Match against file paths — check path segments to avoid substring issues
  for (const f of (analysis.plan?.all_files || [])) {
    const segments = f.toLowerCase().split(/[/\\.]/).filter(Boolean);
    for (const term of specificTerms) {
      if (segments.some(seg => seg === term || seg.includes(term + '.'))) signals.add(term);
    }
  }

  return signals;
}

/**
 * Prune irrelevant H3 subsections from an agent body.
 * Only prunes under ## Expertise and ## Patterns — preserves Constraints, Anti-Patterns, Verification.
 * Keeps an H3 subsection if any plan signal appears in its title or first 200 chars.
 * If no signals provided, returns body unchanged (safe fallback).
 */
function pruneAgentBody(body, planSignals) {
  if (!planSignals || planSignals.size === 0) return body;

  const h2Sections = body.split(/(?=^## )/m);
  const pruned = [];

  for (const section of h2Sections) {
    const h2Match = section.match(/^## (.+)/m);
    if (!h2Match) { pruned.push(section); continue; }

    const sectionName = h2Match[1].trim().toLowerCase();

    if (sectionName !== 'expertise' && sectionName !== 'patterns') {
      pruned.push(section);
      continue;
    }

    const parts = section.split(/(?=^### )/m);
    const keptParts = [parts[0]];

    for (let i = 1; i < parts.length; i++) {
      const h3Match = parts[i].match(/^### (.+)/m);
      if (!h3Match) { keptParts.push(parts[i]); continue; }

      const h3Title = h3Match[1].toLowerCase();
      const preview = parts[i].substring(0, 300).toLowerCase();
      let relevant = false;
      for (const signal of planSignals) {
        if (h3Title.includes(signal) || preview.includes(signal)) {
          relevant = true;
          break;
        }
      }
      if (relevant) keptParts.push(parts[i]);
    }

    pruned.push(keptParts.join(''));
  }

  return pruned.join('');
}

// ============================================================
// Constants
// ============================================================

// Agent Directives — loaded from reference file, injected into every agent system prompt
let _agentDirectives;
function loadAgentDirectives() {
  if (_agentDirectives !== undefined) return _agentDirectives;
  try {
    // Resolve from forge root (sibling to forge-agents/)
    const forgeRoot = path.resolve(__dirname, '..');
    const directivesPath = path.join(forgeRoot, 'atos-forge', 'references', 'agent-directives.md');
    if (fs.existsSync(directivesPath)) {
      _agentDirectives = fs.readFileSync(directivesPath, 'utf8').trim();
    } else {
      // Fallback: installed location (forge root is ~/.claude/)
      const altPath = path.join(forgeRoot, 'atos-forge', 'references', 'agent-directives.md');
      _agentDirectives = fs.existsSync(altPath) ? fs.readFileSync(altPath, 'utf8').trim() : '';
    }
  } catch {
    _agentDirectives = '';
  }
  return _agentDirectives;
}

/**
 * Load project constitution (non-negotiable rules) from .forge/constitution.md.
 * @param {string} cwd - Project root directory (passed from buildAgentConfig)
 */
function loadConstitution(cwd) {
  try {
    const { config } = require('../forge-config/config').loadConfig(cwd);
    if (config.constitution && config.constitution.enabled === false) return null;
    const constitutionPath = path.resolve(cwd, config.constitution?.path || '.forge/constitution.md');
    if (fs.existsSync(constitutionPath)) {
      return fs.readFileSync(constitutionPath, 'utf8').trim();
    }
    // Constitution enabled but file missing — warn
    if (config.constitution?.enabled !== false) {
      try {
        const ldg = ledger();
        ldg.logWarning(cwd, {
          warning: 'Constitution enabled but .forge/constitution.md not found — agent executing without non-negotiable rules. Run /forge-init to create it.',
          source: 'factory:loadConstitution',
          severity: 'high',
        });
      } catch {}
    }
  } catch { /* config not available */ }
  return null;
}

/**
 * Parse glossary markdown table into structured terms.
 */
function parseGlossaryTable(content) {
  if (!content || !content.trim()) return null;
  const terms = [];
  const rows = content.split('\n').filter(line => line.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const term = cells[0];
    if (term === 'Term' || term.startsWith('---') || term.startsWith('-') || !term) continue;
    terms.push({
      term,
      definition: cells[1] || '',
      aliases: cells[2] || '',
      usedIn: cells[3] || '',
    });
  }
  if (terms.length === 0) return null;
  return { raw: content, terms };
}

/**
 * Load service-level glossary from .forge/glossary.md.
 * @param {string} cwd - Project root directory
 */
function loadGlossary(cwd) {
  try {
    const glossaryPath = path.resolve(cwd, '.forge', 'glossary.md');
    if (!fs.existsSync(glossaryPath)) return null;
    const result = parseGlossaryTable(fs.readFileSync(glossaryPath, 'utf8'));
    if (!result && fs.statSync(glossaryPath).size > 10) {
      // File exists with content but parsing failed
      try {
        const ldg = ledger();
        ldg.logWarning(cwd, {
          warning: '.forge/glossary.md exists but no terms could be parsed — check table format',
          source: 'factory:loadGlossary',
          severity: 'low',
        });
      } catch {}
    }
    return result;
  } catch { return null; }
}

/**
 * Load system-level glossary from .forge-system/glossary.md (parent or configured path).
 * @param {string} cwd - Project root directory
 */
function loadSystemGlossary(cwd) {
  try {
    // Check .forge-system/ in cwd (for monorepo root)
    const localPath = path.resolve(cwd, '.forge-system', 'glossary.md');
    if (fs.existsSync(localPath)) return parseGlossaryTable(fs.readFileSync(localPath, 'utf8'));

    // Check parent directories (service inside a system)
    let dir = cwd;
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      const candidate = path.join(dir, '.forge-system', 'glossary.md');
      if (fs.existsSync(candidate)) return parseGlossaryTable(fs.readFileSync(candidate, 'utf8'));
    }
  } catch {}
  return null;
}

/**
 * Compute SHA256 hashes for test files, must_haves, and verification_steps.
 * Writes to .forge/hash-locks.json keyed by plan task ID.
 * The verification engine reads these locks post-execution to detect tampering.
 */
function computeHashLocks(taskId, plan, cwd) {
  const crypto = require('crypto');
  const entries = [];

  const isTestFile = (f) => /\.(test|spec)\.[^.]+$/.test(f) || f.includes('__tests__/') || f.includes('/test/');

  // Hash test files from plan + discover test-first stubs on disk
  const testFilesToHash = new Set();
  for (const f of (plan.all_files || [])) {
    if (isTestFile(f)) testFilesToHash.add(path.isAbsolute(f) ? path.relative(cwd, f) : f);
  }

  // Also scan for test-first stubs generated by the test-stub-generator
  const testDirs = ['src', 'tests', 'test', '__tests__'];
  for (const dir of testDirs) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            walk(path.join(d, entry.name));
          } else if (entry.isFile() && isTestFile(entry.name)) {
            testFilesToHash.add(path.relative(cwd, path.join(d, entry.name)));
          }
        }
      };
      walk(dirPath);
    } catch { /* scan failure non-fatal */ }
  }

  for (const f of testFilesToHash) {
    const fullPath = path.join(cwd, f);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      entries.push({
        type: 'test_file',
        path: f,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    }
  }

  // Hash must_haves content
  const mh = plan.frontmatter?.must_haves;
  if (mh) {
    entries.push({
      type: 'must_haves',
      sha256: crypto.createHash('sha256').update(JSON.stringify(mh)).digest('hex'),
    });
  }

  // Hash verification_steps
  const vs = plan.frontmatter?.verification_steps || plan.tasks?.map(t => t.verify).filter(Boolean);
  if (vs && vs.length > 0) {
    entries.push({
      type: 'verification_steps',
      sha256: crypto.createHash('sha256').update(vs.join('\n')).digest('hex'),
    });
  }

  if (entries.length === 0) return { locked: false, entries: 0 };

  // Write to .forge/hash-locks.json
  const lockPath = path.join(cwd, '.forge', 'hash-locks.json');
  let locks = {};
  try { if (fs.existsSync(lockPath)) locks = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
  locks[taskId] = entries;
  const forgeDir = path.join(cwd, '.forge');
  if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(locks, null, 2) + '\n');

  return { locked: true, entries: entries.length };
}

const CHARS_PER_TOKEN = 4;

// Context window budgets (tokens)
const DEFAULT_CONTEXT_WINDOW = 200000;
const CONTEXT_LOAD_RATIO = 0.70;

// Capability confidence threshold
const CAPABILITY_CONFIDENCE_MIN = 0.3;

// Verification built-in checks keyed by detected capability
const CAPABILITY_VERIFICATION_MAP = {
  testing: ['npm_test'],
  database_sql: ['npm_test'],
  react_advanced: ['typescript', 'npm_test'],
  ui_components: ['typescript', 'npm_test'],
  state_management: ['typescript', 'npm_test'],
  api_server: ['typescript', 'npm_test'],
  graphql: ['typescript', 'npm_test'],
  docker: ['npm_build'],
  ci_cd: ['npm_build'],
  kubernetes: ['npm_build'],
};

// ============================================================
// Step 1: Analyze Task
// ============================================================

/**
 * Analyze a parsed plan to gather graph context, capabilities, risk, and ledger state.
 *
 * @param {object} plan - Parsed plan from assessor.parsePlan()
 * @param {string} cwd - Project root
 * @returns {object} analysis
 */
function analyzeTask(plan, cwd) {
  const dbPath = path.join(cwd, '.forge', 'graph.db');
  const hasGraph = fs.existsSync(dbPath);

  let graphContext = null;
  let capabilities = {};
  let risk = { level: 'LOW', score: 0, reasons: [] };
  let affectedModules = [];
  let cycles = { count: 0, cycles: [], byModule: {} };
  let moduleBoundaries = { modules: [], edges: [] };

  if (hasGraph && plan.all_files.length > 0) {
    const GQ = graphQuery();
    const gq = new GQ.GraphQuery(dbPath);
    try {
      gq.open();

      // Normalize to relative paths (graph stores relative paths)
      const relFiles = plan.all_files.map(f =>
        path.isAbsolute(f) ? path.relative(cwd, f) : f
      );

      // Graph context for target files
      graphContext = gq.getContextForTask(relFiles);

      // Risk assessment
      risk = gq.getRiskAssessment(relFiles);

      // Cycles
      cycles = gq.getCycles();

      // Module boundaries
      moduleBoundaries = gq.getModuleBoundaries();

      // Determine affected modules from file → module mapping
      const moduleSet = new Set();
      if (graphContext && graphContext.files) {
        for (const f of graphContext.files) {
          if (f.module) moduleSet.add(f.module);
        }
      }
      // Also check unknown files by path prefix
      if (moduleBoundaries.modules) {
        for (const uf of (graphContext?.unknownFiles || [])) {
          for (const m of moduleBoundaries.modules) {
            if (uf.startsWith(m.root_path)) {
              moduleSet.add(m.name);
              break;
            }
          }
        }
      }
      affectedModules = [...moduleSet];

      // Capabilities per affected module
      for (const mod of affectedModules) {
        const caps = gq.getCapabilities(mod);
        if (caps && caps.length > 0) {
          capabilities[mod] = caps;
        }
      }
    } finally {
      gq.close();
    }
  }

  // System graph context (cross-repo)
  let systemContext = null;
  const systemDbCandidates = [
    path.join(cwd, '.forge', 'system-graph.db'),
    process.env.FORGE_SYSTEM_GRAPH_PATH,
    process.env.FORGE_SYSTEM_GRAPH,
  ].filter(Boolean);
  const systemDbPath = systemDbCandidates.find(p => fs.existsSync(p));

  if (systemDbPath) {
    try {
      const SQ = systemQuery();
      const sq = new SQ.SystemQuery(systemDbPath);
      sq.open();
      try {
        // Determine target service: prefer plan frontmatter, fall back to CWD
        let serviceId = plan.frontmatter?.service || null;

        // If frontmatter specifies a service, verify it exists in the system graph
        if (serviceId) {
          try {
            const svcCheck = sq.service(serviceId);
            if (!svcCheck?.service) serviceId = null; // service not found, fall back
          } catch { serviceId = null; }
        }

        // Fall back to CWD-based lookup
        if (!serviceId) {
          serviceId = sq.findServiceByRepoPath(plan.frontmatter?.repo || cwd);
        }

        if (serviceId) {
          const serviceInfo = sq.service(serviceId);
          const consumers = sq.consumers(serviceId);
          const exports = sq.exports(serviceId);
          const imports = sq.imports(serviceId);
          const impact = sq.impact(serviceId, { depth: 1 });

          systemContext = {
            service_id: serviceId,
            service: serviceInfo,
            exports: exports || [],
            imports: imports || [],
            consumers: consumers || [],
            impact,
            system_db_path: systemDbPath,
          };
        }
      } finally {
        sq.close();
      }
    } catch (err) {
      if (process.env.FORGE_DEBUG) console.error('System graph query failed: ' + err.message);
    }
  }

  // Ledger state
  let ledgerState = { exists: false };
  let ledgerContent = '';
  try {
    ledgerState = ledger().readState(cwd);
    if (ledgerState.exists) {
      ledgerContent = ledger().read(cwd);
    }
  } catch (err) {
    if (process.env.FORGE_DEBUG) console.error('Ledger read failed: ' + err.message);
  }

  return {
    plan,
    graphContext,
    capabilities,
    risk,
    affectedModules,
    cycles,
    moduleBoundaries,
    systemContext,
    ledgerState,
    ledgerContent,
    hasGraph,
  };
}

// ============================================================
// Step 2: Select Catalog Agent(s)
// ============================================================

/**
 * Select the best-matching catalog agent(s) for this plan.
 * Falls back to general-executor if no specialist matches.
 *
 * @param {object} analysis - From analyzeTask()
 * @returns {{ agents: object[], primary: object, reason: string }}
 */
function selectAgents(analysis) {
  const matches = matchCatalogAgents(analysis);

  if (matches.length === 0) {
    const catalog = loadCatalog();
    const general = catalog.find(a => a.name === 'general-executor');
    // Warn about fallback to general executor
    try {
      const ldg = ledger();
      ldg.logWarning(process.cwd(), {
        warning: 'No specialist catalog agent matched this plan — falling back to general-executor. Consider adding a specialist agent for this technology stack.',
        source: 'factory:selectAgents',
        severity: 'medium',
      });
    } catch {}
    return {
      agents: general ? [general] : [],
      primary: general || null,
      reason: 'no catalog match — using general executor',
    };
  }

  const primary = matches[0];
  const threshold = primary.score * 0.5;
  const selected = matches.filter(m => m.score >= threshold).slice(0, 3);

  return {
    agents: selected.map(s => s.agent),
    primary: primary.agent,
    reason: selected.map(s => `${s.agent.name}(${s.score}): ${s.reason}`).join(' | '),
  };
}


// Keep legacy determineArchetype for backward compat (wraps catalog selection)
function determineArchetype(analysis) {
  const selection = selectAgents(analysis);
  return {
    archetype: selection.primary?.name || 'general-executor',
    reason: selection.reason,
  };
}

const BASE_EXECUTOR_RULES = `## Execution Rules
- Read files before modifying them.
- Make minimal, focused changes — do not refactor unrelated code.
- Do not create unnecessary files.
- Run verification commands when specified.
- If you encounter an error, try to fix it. If stuck after 2 attempts, document the issue and move on.`;

/**
 * Build a grounding section with verified facts from the code graph.
 * Helps agents avoid hallucinating function signatures, parameters, etc.
 */
function buildGroundingSection(cwd, planFiles) {
  try {
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    if (!fs.existsSync(dbPath)) return '';
    const GQ = graphQuery();
    const q = new GQ.GraphQuery(dbPath);
    q.open();
    const lines = ['## Grounded Facts (VERIFIED from code graph — TRUST over training data)\n'];
    for (const f of (planFiles || [])) {
      const fileInfo = q.file(f);
      if (!fileInfo) { lines.push(`WARNING: NEW FILE: ${f} — will be created by this plan\n`); continue; }
      const symbols = (q.symbolsInFile(f) || []).filter(s => s.exported);
      let imports = [], consumers = [];
      try { imports = q.importsOf(f) || []; } catch {}
      try { const cr = q.getConsumers(f); consumers = cr && cr.consumers ? cr.consumers : []; } catch {}
      lines.push(`FILE: ${f} (module: ${fileInfo.module || '?'}, ${fileInfo.loc} LOC)`);
      if (symbols.length) lines.push(`  Exports: ${symbols.map(s => s.name + (s.signature || '')).join(', ')}`);
      if (imports.length) lines.push(`  Imports: ${imports.slice(0, 10).map(i => i.target_file || i).join(', ')}`);
      if (consumers.length) lines.push(`  Consumers: ${consumers.slice(0, 10).map(c => c.source_file || c).join(', ')}`);
      lines.push('');
    }
    q.close();
    lines.push('IMPORTANT: If your training data contradicts these facts, TRUST the grounded facts.');
    lines.push('Do NOT invent function signatures, parameters, or return types not listed above.\n');
    return lines.join('\n');
  } catch { return ''; }
}

/**
 * Compose a full system prompt for the agent.
 *
 * @param {object} analysis - From analyzeTask()
 * @param {{ archetype: string }} archetypeResult - From determineArchetype()
 * @param {object} sessionContext - From extractSessionContext()
 * @returns {string}
 */

function composeSystemPrompt(analysis, archetypeResult, sessionContext, cwd) {
  const parts = [];

  // Load the primary catalog agent's expertise (pruned to plan-relevant sections)
  const selection = selectAgents(analysis);
  const planSignals = extractPlanSignals(analysis);

  if (selection.primary && selection.primary.body) {
    parts.push(pruneAgentBody(selection.primary.body, planSignals));
  }

  // If secondary agents matched, include their pruned expertise (renamed headings)
  if (selection.agents.length > 1) {
    for (const agent of selection.agents.slice(1)) {
      if (agent.body) {
        const prunedBody = pruneAgentBody(agent.body, planSignals);
        const expertiseMatch = prunedBody.match(/## Expertise[\s\S]*?(?=## Constraints|## Anti-Patterns|$)/);
        if (expertiseMatch) {
          const renamed = expertiseMatch[0]
            .replace(/^## Expertise/m, `### ${agent.name} — Expertise`)
            .replace(/^## Patterns/m, `### ${agent.name} — Patterns`)
            .replace(/^### (?!.*—)/gm, (h) => h.replace('### ', `#### `));
          parts.push(`\n## Additional Domain Knowledge (${agent.name})\n${renamed}`);
        }
      }
    }
  }

  // Plan Contract — structured rendering of plan requirements and must-haves
  if (analysis.plan && analysis.plan.frontmatter) {
    const fm = analysis.plan.frontmatter;
    const parts_contract = [];
    parts_contract.push('\n## Plan Contract');
    parts_contract.push('This is what you MUST deliver. Verify each item before reporting completion.\n');

    // Objective
    if (analysis.plan.objective) {
      parts_contract.push('### Objective');
      parts_contract.push(analysis.plan.objective);
      parts_contract.push('');
    }

    // Requirements
    if (fm.requirements && fm.requirements.length > 0) {
      parts_contract.push('### Requirements');
      parts_contract.push('This plan addresses: ' + fm.requirements.join(', '));
      parts_contract.push('');
    }

    // Observable truths
    const mh = fm.must_haves;
    if (mh) {
      if (mh.truths && mh.truths.length > 0) {
        parts_contract.push('### Observable Truths');
        parts_contract.push('Each must be verifiably true after implementation:');
        for (const t of mh.truths) {
          parts_contract.push('- ' + t);
        }
        parts_contract.push('');
      }

      // Required artifacts
      if (mh.artifacts && mh.artifacts.length > 0) {
        parts_contract.push('### Required Artifacts');
        parts_contract.push('Each file must exist and be substantive:');
        for (const a of mh.artifacts) {
          if (typeof a === 'string') {
            parts_contract.push('- `' + a + '`');
          } else if (a.path) {
            parts_contract.push('- `' + a.path + '`' + (a.provides ? ' — ' + a.provides : ''));
          }
        }
        parts_contract.push('');
      }

      // Required wiring
      if (mh.key_links && mh.key_links.length > 0) {
        parts_contract.push('### Required Wiring');
        parts_contract.push('Each connection must exist in the source file:');
        for (const kl of mh.key_links) {
          const src = kl.source || kl.from || '?';
          const tgt = kl.target || kl.to || '?';
          const pat = kl.pattern || kl.via || '?';
          parts_contract.push('- `' + src + '` must contain pattern `' + pat + '` (connecting to `' + tgt + '`)');
        }
        parts_contract.push('');
      }
    }

    // Locked decisions
    if (fm.locked_decisions && fm.locked_decisions.length > 0) {
      parts_contract.push('### Locked Decisions');
      parts_contract.push('Deviation from these is a verification failure:');
      for (let i = 0; i < fm.locked_decisions.length; i++) {
        parts_contract.push((i + 1) + '. ' + fm.locked_decisions[i]);
      }
      parts_contract.push('');
    }

    parts.push(parts_contract.join('\n'));
  }

  // Constitution — non-negotiable hard rules (loaded from .forge/constitution.md)
  const constitutionContent = loadConstitution(cwd || process.cwd());
  if (constitutionContent) {
    parts.push('\n## CONSTITUTION — Non-Negotiable Rules');
    parts.push('These rules MUST be followed. Violation is equivalent to a verification failure.');
    parts.push('If a rule conflicts with a plan instruction, the CONSTITUTION takes precedence.\n');
    parts.push(constitutionContent);
  }

  // Domain Glossary — shared vocabulary (service-level + system-level)
  const effectiveCwd = cwd || process.cwd();
  const systemGlossary = loadSystemGlossary(effectiveCwd);
  const serviceGlossary = loadGlossary(effectiveCwd);
  if (systemGlossary || serviceGlossary) {
    parts.push('\n## Domain Glossary');
    parts.push('Use these terms consistently in all generated code, variable names, and documentation.');
    parts.push('If user or plan uses an alias, map it to the canonical term.\n');
    if (systemGlossary && systemGlossary.terms.length > 0) {
      parts.push('**Organization-wide terms:**');
      parts.push('| Term | Definition | Aliases |');
      parts.push('|------|-----------|---------|');
      for (const t of systemGlossary.terms) parts.push(`| ${t.term} | ${t.definition} | ${t.aliases} |`);
      parts.push('');
    }
    if (serviceGlossary && serviceGlossary.terms.length > 0) {
      if (systemGlossary) parts.push('**Service-specific terms:**');
      else {
        parts.push('| Term | Definition | Aliases |');
        parts.push('|------|-----------|---------|');
      }
      for (const t of serviceGlossary.terms) parts.push(`| ${t.term} | ${t.definition} | ${t.aliases} |`);
      parts.push('');
    }
  }

  // Base execution rules
  parts.push('\n' + BASE_EXECUTOR_RULES);

  // Agent Directives — mechanical overrides for production-grade code quality
  const directives = loadAgentDirectives();
  if (directives) {
    parts.push('\n' + directives);
  }

  // Graph context summary
  if (analysis.graphContext) {
    const s = analysis.graphContext.summary;
    parts.push(`\n## Code Graph Context`);
    parts.push(`Files analyzed: ${s.filesAnalyzed}, Dependencies: ${s.directDependencyCount}, Consumers: ${s.consumerCount}`);
    parts.push(`Interfaces: ${s.interfaceCount}, Module boundaries crossed: ${s.boundariesCrossed}`);
    parts.push(`Risk: ${s.riskLevel}`);

    if (analysis.graphContext.moduleBoundaries && analysis.graphContext.moduleBoundaries.length > 0) {
      parts.push(`\nModule boundaries crossed by this task:`);
      for (const b of analysis.graphContext.moduleBoundaries) {
        parts.push(`  ${b.source} → ${b.target}`);
      }
    }
  }

  // Cross-repo context from system graph
  if (analysis.systemContext) {
    const sc = analysis.systemContext;
    parts.push(`\n## Cross-Repo Context (System Graph)`);
    parts.push(`This repo is service: ${sc.service_id}`);

    if (sc.exports.length > 0) {
      parts.push(`\nExported Interfaces (${sc.exports.length}):`);
      for (const exp of sc.exports) {
        const consumerNote = sc.consumers.length > 0
          ? ` — consumed by ${sc.consumers.length} service(s)`
          : '';
        parts.push(`  ▸ ${exp.type}/${exp.protocol || ''} ${exp.name}${consumerNote}`);
      }
    }

    if (sc.consumers.length > 0) {
      parts.push(`\nConsuming Services (${sc.consumers.length}):`);
      for (const c of sc.consumers) {
        parts.push(`  ▸ ${c.consumer_id} via ${c.type}${c.interface_name ? ': ' + c.interface_name : ''}`);
      }
      parts.push(`\n⚠ CRITICAL: Do NOT change exported interfaces without coordination.`);
      parts.push(`If you modify an exported API, event schema, or package interface,`);
      parts.push(`the consuming services listed above will break.`);
      parts.push(`Document any interface changes and flag them for cross-repo updates.`);
    }

    if (sc.imports.length > 0) {
      parts.push(`\nImported Dependencies (${sc.imports.length}):`);
      for (const imp of sc.imports) {
        parts.push(`  ▸ ${imp.provider_id} (${imp.type}${imp.deprecated ? ' — DEPRECATED' : ''})`);
      }
    }
  }

  // Cycles warning
  if (analysis.cycles.count > 0) {
    parts.push(`\n## Circular Dependencies Warning`);
    parts.push(`${analysis.cycles.count} cycle(s) detected. Do NOT introduce new cycles.`);
  }

  // Session context
  if (sessionContext && Object.keys(sessionContext).length > 0) {
    parts.push('\n## Session Context');

    if (sessionContext.decisions && sessionContext.decisions.length > 0) {
      parts.push('\nDecisions already made (do NOT re-ask or override):');
      for (const d of sessionContext.decisions) {
        parts.push(`- ${d}`);
      }
    }

    if (sessionContext.warnings && sessionContext.warnings.length > 0) {
      parts.push('\nWarnings from prior work (account for these):');
      for (const w of sessionContext.warnings) {
        parts.push(`- ${w}`);
      }
    }

    if (sessionContext.user_preferences && sessionContext.user_preferences.length > 0) {
      parts.push('\nUser preferences (respect these):');
      for (const p of sessionContext.user_preferences) {
        parts.push(`- ${p}`);
      }
    }

    if (sessionContext.rejected_approaches && sessionContext.rejected_approaches.length > 0) {
      parts.push('\nRejected approaches (do NOT retry):');
      for (const r of sessionContext.rejected_approaches) {
        parts.push(`- ${r}`);
      }
    }

    if (sessionContext.knowledge_base && sessionContext.knowledge_base.length > 0) {
      parts.push('\n## Persistent Knowledge (from previous milestones)');
      parts.push('These learnings were captured from prior work. Account for them:');
      for (const k of sessionContext.knowledge_base) {
        const src = k.source_milestone
          ? ` (${k.source_milestone}${k.source_phase ? ', phase ' + k.source_phase : ''})`
          : '';
        parts.push(`- [${k.type}] ${k.text}${src}`);
      }
    }

    if (sessionContext.impact_analysis && sessionContext.impact_analysis.scope === 'MULTI_REPO') {
      parts.push('\n## Cross-Repo Impact');
      parts.push('This task is part of a multi-repo change. Affected services:');
      for (const svc of sessionContext.impact_analysis.affected_services || []) {
        const current = svc.is_current ? ' (this repo)' : '';
        parts.push(`- ${svc.id} (${svc.role}) — ${svc.team || 'unknown team'}${current} — risk: ${svc.risk}`);
      }
      parts.push('Ensure your changes maintain backward compatibility with consumers.');
      if (sessionContext.impact_analysis.team_coordination && sessionContext.impact_analysis.team_coordination.length > 1) {
        parts.push(`Team coordination required: ${sessionContext.impact_analysis.team_coordination.join(', ')}`);
      }
    }
  }

  // Locked decisions from plan frontmatter (enforced during execution)
  const locked = analysis.plan?.frontmatter?.locked_decisions || [];
  if (locked.length > 0) {
    parts.push('\n## LOCKED DECISIONS (from approved plan — deviation is FAILURE)');
    locked.forEach((d, i) => parts.push(`${i + 1}. ${d}`));
    parts.push('Deviating from locked decisions is equivalent to a verification failure.\n');
  }

  // Grounded facts from code graph (anti-hallucination)
  const groundingCwd = cwd || process.cwd();
  const grounding = buildGroundingSection(groundingCwd, analysis.plan?.all_files);
  if (grounding) parts.push(grounding);

  // Project conventions (auto-detected)
  try {
    const convDbPath = path.join(groundingCwd, '.forge', 'graph.db');
    if (fs.existsSync(convDbPath)) {
      const GQ = graphQuery();
      const q = new GQ.GraphQuery(convDbPath);
      q.open();
      const allMeta = q.meta();
      q.close();
      const convRaw = allMeta ? allMeta.conventions : null;
      if (convRaw) {
        const c = JSON.parse(convRaw);
        const convLines = ['## Project Conventions (auto-detected — follow these)'];
        if (c.naming && c.naming !== 'unknown') convLines.push(`- Naming: ${c.naming}`);
        if (c.importStyle && c.importStyle !== 'unknown') convLines.push(`- Imports: ${c.importStyle}`);
        if (c.exportStyle && c.exportStyle !== 'unknown') convLines.push(`- Exports: ${c.exportStyle}`);
        if (c.testFramework && c.testFramework !== 'unknown') convLines.push(`- Test framework: ${c.testFramework}`);
        if (convLines.length > 1) {
          convLines.push('Follow these conventions in ALL generated code.\n');
          parts.push(convLines.join('\n'));
        }
      }
    }
  } catch { /* conventions not available */ }

  // Previous agent findings (propagated from earlier plans)
  if (sessionContext && sessionContext.previous_findings && sessionContext.previous_findings.length > 0) {
    const findingsLines = ['## Previous Agent Findings\n'];
    for (const f of sessionContext.previous_findings) {
      findingsLines.push(`- [${(f.severity || 'info').toUpperCase()}] ${f.file || '?'}${f.line ? ':' + f.line : ''} — ${f.description}`);
    }
    findingsLines.push('');
    parts.push(findingsLines.join('\n'));
  }

  // Agent output format instruction
  parts.push('\n## Structured Output (optional but recommended)');
  parts.push('After completing your work, include a structured summary block:');
  parts.push('');
  parts.push('```' + 'json:agent-output');
  parts.push(JSON.stringify({
    findings: [{ type: 'bug|convention|risk|note', file: 'path', line: 0, description: 'what', severity: 'info|warning|critical' }],
    decisions_made: [{ text: 'what was decided', rationale: 'why' }],
    files_created: ['path1'],
    files_modified: ['path2'],
    confidence: 0.85,
  }, null, 2));
  parts.push('```');
  parts.push('');

  return parts.join('\n');
}

// ============================================================
// Step 4: Compose Context Package
// ============================================================

/**
 * Build a context package: files the agent should load.
 *
 * Categories:
 * - always_load: plan file, direct task files
 * - task_specific: dependencies, consumers, interfaces, test files
 * - reference: module overviews, capability docs, risk notes
 *
 * Respects a token budget (default: 70% of context window).
 *
 * @param {object} analysis
 * @param {object} config - From loadForgeConfig
 * @returns {{ always_load: string[], task_specific: string[], reference: string[], budget: object }}
 */
function composeContextPackage(analysis, config) {
  const contextWindow = config.context_budget || DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.floor(contextWindow * CONTEXT_LOAD_RATIO);

  const always_load = [];
  const task_specific = [];
  const reference = [];

  let usedTokens = 0;

  // Helper: estimate tokens for a file path
  function fileTokens(filePath) {
    try {
      return assessor().estimateFileTokens(filePath);
    } catch {
      return 500; // conservative fallback
    }
  }

  // Helper: add file if within budget, returns true if added
  function addFile(arr, filePath) {
    const tokens = fileTokens(filePath);
    if (usedTokens + tokens <= maxTokens) {
      arr.push(filePath);
      usedTokens += tokens;
      return true;
    }
    return false;
  }

  // Always load: the plan file itself
  if (analysis.plan.path && fs.existsSync(analysis.plan.path)) {
    addFile(always_load, analysis.plan.path);
  }

  // Always load: direct task files (from plan)
  for (const f of analysis.plan.all_files) {
    if (fs.existsSync(f)) {
      addFile(always_load, f);
    }
  }

  // Include test stubs if they exist (RED→GREEN pipeline)
  try {
    const stubGen = require('../forge-verify/test-stub-generator');
    const testDir = stubGen.detectTestDir(config.cwd || process.cwd());
    const planBase = path.basename(analysis.plan.path || '', '.md').replace(/^\d+-\d+-/, '');
    const fw = stubGen.detectTestFramework(config.cwd || process.cwd());
    const stubFile = path.join(testDir, `plan-${planBase}${fw.ext}`);
    const stubFullPath = path.resolve(config.cwd || process.cwd(), stubFile);
    if (fs.existsSync(stubFullPath)) {
      addFile(always_load, stubFullPath);
    }
  } catch { /* test-stub-generator not available — skip */ }

  // Task-specific: direct dependencies (INTERFACE level — only exported symbols)
  if (analysis.graphContext) {
    const depFiles = new Set();
    for (const dep of (analysis.graphContext.directDependencies || [])) {
      if (dep.target_file && !analysis.plan.all_files.includes(dep.target_file)) {
        depFiles.add(dep.target_file);
      }
    }

    // 3-level context compression:
    // FULL — plan files (always_load above)
    // INTERFACE — direct dependencies (exported symbols only, ~20 tokens per export)
    // SUMMARY — transitive deps (1-line summary)
    const cwd = analysis.plan?.path ? path.dirname(path.dirname(analysis.plan.path)) : process.cwd();
    const dbPath = path.join(cwd, '.forge', 'graph.db');
    let gq = null;
    try {
      if (fs.existsSync(dbPath)) {
        const GQ = graphQuery();
        gq = new GQ.GraphQuery(dbPath);
        gq.open();
      }
    } catch { gq = null; }

    // INTERFACE level for direct dependencies
    for (const f of depFiles) {
      if (!fs.existsSync(f)) continue;
      if (gq) {
        try {
          const symbols = (gq.symbolsInFile(f) || []).filter(s => s.exported);
          if (symbols.length > 0) {
            const interfaceContent = `// Interface: ${f} (${symbols.length} exports)\n` +
              symbols.map(s => `export ${s.kind} ${s.name}${s.signature || ''};`).join('\n');
            const interfaceTokens = Math.ceil(interfaceContent.length / 4);
            if (usedTokens + interfaceTokens <= maxTokens) {
              task_specific.push({ path: f, level: 'interface', content: interfaceContent });
              usedTokens += interfaceTokens;
              continue;
            }
          }
        } catch { /* fall through to full file */ }
      }
      addFile(task_specific, f);
    }

    // SUMMARY level for transitive dependencies (depth 2+)
    if (gq) {
      try {
        const transitiveFiles = new Set();
        for (const f of depFiles) {
          const chain = gq.dependencyChain(f, 1);
          for (const edge of chain) {
            if (!depFiles.has(edge.to) && !analysis.plan.all_files.includes(edge.to)) {
              transitiveFiles.add(edge.to);
            }
          }
        }
        for (const f of transitiveFiles) {
          const fileInfo = gq.file(f);
          if (fileInfo) {
            const summaryLine = `// Summary: ${f} (${fileInfo.module || '?'}, ${fileInfo.loc} LOC, ${fileInfo.language})`;
            const summaryTokens = Math.ceil(summaryLine.length / 4);
            if (usedTokens + summaryTokens <= maxTokens) {
              task_specific.push({ path: f, level: 'summary', content: summaryLine });
              usedTokens += summaryTokens;
            }
          }
        }
      } catch { /* transitive analysis not critical */ }
    }

    if (gq) { try { gq.close(); } catch {} }

    // Task-specific: consumers (files that import our task files)
    const consumerFiles = new Set();
    for (const c of (analysis.graphContext.consumers || [])) {
      if (c.source_file && !analysis.plan.all_files.includes(c.source_file)) {
        consumerFiles.add(c.source_file);
      }
    }
    for (const f of consumerFiles) {
      if (fs.existsSync(f)) {
        addFile(task_specific, f);
      }
    }

    // Task-specific: test files
    for (const t of (analysis.graphContext.testFiles || [])) {
      if (t.path && fs.existsSync(t.path)) {
        addFile(task_specific, t.path);
      }
    }
  }

  // Reference: interface files (high consumer count first)
  if (analysis.graphContext && analysis.graphContext.interfaces) {
    const sorted = [...analysis.graphContext.interfaces].sort((a, b) => (b.consumer_count || 0) - (a.consumer_count || 0));
    for (const iface of sorted.slice(0, 10)) {
      if (iface.file && fs.existsSync(iface.file)) {
        addFile(reference, iface.file);
      }
    }
  }

  // Reference: cross-repo neighbor interfaces.yaml from system graph
  if (analysis.systemContext) {
    // This repo's own interfaces.yaml (use repo_path from system context or plan dir)
    const repoRoot = analysis.systemContext.service?.service?.repo_path
      || (analysis.plan.path ? path.dirname(analysis.plan.path) : null);
    if (repoRoot) {
      const ownInterfaces = path.join(repoRoot, '.forge', 'interfaces.yaml');
      if (fs.existsSync(ownInterfaces)) {
        addFile(reference, ownInterfaces);
      }
    }

    // Consumer and provider interfaces.yaml files (if repo_path known)
    const neighborPaths = new Set();
    const sc = analysis.systemContext;
    for (const c of (sc.consumers || [])) {
      if (c.repo_path) neighborPaths.add(path.join(c.repo_path, '.forge', 'interfaces.yaml'));
    }
    for (const imp of (sc.imports || [])) {
      if (imp.repo_path) neighborPaths.add(path.join(imp.repo_path, '.forge', 'interfaces.yaml'));
    }
    for (const np of neighborPaths) {
      if (fs.existsSync(np)) {
        addFile(reference, np);
      }
    }
  }

  return {
    always_load,
    task_specific,
    reference,
    budget: {
      max_tokens: maxTokens,
      used_tokens: usedTokens,
      remaining_tokens: maxTokens - usedTokens,
      utilization: (usedTokens / maxTokens * 100).toFixed(1) + '%',
    },
  };
}

// ============================================================
// Step 5: Define Verification Criteria
// ============================================================

/**
 * Build verification steps for the agent based on plan tasks and capabilities.
 *
 * @param {object} analysis
 * @returns {string[]} verification steps (command strings or check names)
 */
function defineVerification(analysis) {
  const steps = new Set();

  // From plan tasks: explicit verify fields
  for (const task of (analysis.plan.tasks || [])) {
    if (task.verify && task.verify.trim()) {
      steps.add(task.verify.trim());
    }
  }

  // From capabilities: map to known checks
  const allCaps = Object.values(analysis.capabilities).flat();
  for (const cap of allCaps) {
    const checks = CAPABILITY_VERIFICATION_MAP[cap.capability];
    if (checks) {
      for (const c of checks) steps.add(c);
    }
  }

  // Baseline: always include TypeScript check if project has tsconfig
  if (analysis.plan.all_files.some(f => /\.(ts|tsx)$/.test(f))) {
    steps.add('typescript');
  }

  return [...steps];
}

// ============================================================
// Step 6: Define Container Spec Parameters
// ============================================================

/**
 * Build parameters for container-spec.buildSpec().
 * (Container params removed in V2 — sequential execution only)
 */

// ============================================================
// Step 7: Extract Session Context
// ============================================================

/**
 * Extract session context relevant to this agent's task.
 * Parses the ledger markdown to pull decisions, warnings, preferences, rejected approaches.
 *
 * @param {object} analysis
 * @returns {object} sessionContext
 */
function extractSessionContext(analysis) {
  const ctx = {
    decisions: [],
    warnings: [],
    user_preferences: [],
    rejected_approaches: [],
    knowledge_base: [],
    active_phase: null,
  };

  // Load structured decisions from decisions.db (preferred over markdown parsing)
  try {
    const dec = require('../forge-session/decisions');
    const phase = analysis.ledgerState?.active_phase || null;
    const cwd = analysis.plan?.path ? path.dirname(path.dirname(analysis.plan.path)) : process.cwd();
    const structured = dec.forAgent(cwd, phase, analysis.affectedModules || [], analysis.plan?.all_files || []);
    if (structured && structured.length > 0) {
      ctx.decisions = structured.filter(d => d.type === 'decision').map(d => d.text);
      ctx.user_preferences = structured.filter(d => d.type === 'preference').map(d => d.text);
      ctx.rejected_approaches = structured.filter(d => d.type === 'rejection').map(d => d.text);
    }
  } catch { /* decisions module not available — fallback to markdown parsing below */ }

  if (!analysis.ledgerState.exists) return ctx;

  const content = analysis.ledgerContent;
  if (!content) return ctx;

  ctx.active_phase = analysis.ledgerState.active_phase || null;

  // Parse sections from ledger markdown
  const sections = parseLedgerSections(content);

  // Decisions
  if (sections.decisions) {
    ctx.decisions = extractBulletItems(sections.decisions);
  }

  // Warnings & Discoveries
  if (sections.warnings) {
    ctx.warnings = extractBulletItems(sections.warnings);
  }

  // User Preferences
  if (sections.preferences) {
    ctx.user_preferences = extractBulletItems(sections.preferences);
  }

  // Rejected Approaches
  if (sections.rejected) {
    ctx.rejected_approaches = extractBulletItems(sections.rejected);
  }

  // Filter to relevant items (mention affected modules or files)
  const relevantTerms = [
    ...analysis.affectedModules,
    ...analysis.plan.all_files.map(f => path.basename(f, path.extname(f))),
  ].map(t => t.toLowerCase());

  // Only filter if we have relevant terms; otherwise include everything
  if (relevantTerms.length > 0) {
    const filterRelevant = (items) => {
      // Always include items that mention affected modules/files
      // But also include general items (that don't reference specific modules)
      return items.filter(item => {
        const lower = item.toLowerCase();
        // Include if it references our modules/files OR is generic
        return relevantTerms.some(t => lower.includes(t)) || isGenericItem(lower);
      });
    };

    // For decisions and preferences, include all (they're always relevant)
    // For warnings and rejected, filter to relevant ones
    ctx.warnings = filterRelevant(ctx.warnings);
    ctx.rejected_approaches = filterRelevant(ctx.rejected_approaches);
  }

  // Load persistent knowledge base
  try {
    const kb = knowledge();
    const learnings = kb.relevantFor(
      analysis.plan.path ? path.dirname(analysis.plan.path) : process.cwd(),
      analysis.affectedModules || [],
      analysis.plan.all_files || []
    );
    ctx.knowledge_base = learnings;
  } catch { /* knowledge module not available */ }

  // Load impact analysis if available
  try {
    const analyzerMod = require('../forge-analyze/analyzer');
    const impactPath = analyzerMod.findImpactFile(
      analysis.plan.path ? path.dirname(analysis.plan.path) : process.cwd(),
      analysis.plan.path
    );
    if (impactPath && fs.existsSync(impactPath)) {
      ctx.impact_analysis = JSON.parse(fs.readFileSync(impactPath, 'utf8'));
    }
  } catch { /* impact analysis not available */ }

  // Inject previous agent findings (from earlier wave results)
  if (analysis.previousFindings && analysis.previousFindings.length > 0) {
    ctx.previous_findings = analysis.previousFindings;
  }

  return ctx;
}

/**
 * Check if a ledger item is generic (not module-specific).
 */
function isGenericItem(text) {
  // Generic if it doesn't contain path separators or specific module references
  return !text.includes('/') && !text.includes('\\');
}

/**
 * Parse ledger markdown into named sections.
 */
function parseLedgerSections(content) {
  const sections = {};
  let currentKey = null;
  let currentLines = [];

  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      if (currentKey) {
        sections[currentKey] = currentLines.join('\n');
      }
      const heading = headerMatch[1].toLowerCase().trim();
      if (heading.includes('decision')) currentKey = 'decisions';
      else if (heading.includes('warning') || heading.includes('discover')) currentKey = 'warnings';
      else if (heading.includes('preference')) currentKey = 'preferences';
      else if (heading.includes('rejected')) currentKey = 'rejected';
      else currentKey = heading;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentKey) {
    sections[currentKey] = currentLines.join('\n');
  }

  return sections;
}

/**
 * Extract bullet-pointed items from a markdown section.
 */
function extractBulletItems(sectionText) {
  const items = [];
  for (const line of sectionText.split('\n')) {
    const match = line.match(/^\s*[-*]\s+(.+)/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

// ============================================================
// Main: buildAgentConfig
// ============================================================

/**
 * Build a complete agent configuration from a plan file.
 *
 * @param {string} planPath - Path to a sub-plan markdown file.
 * @param {string} cwd - Project root.
 * @param {object} [opts] - Optional overrides.
 * @param {string} [opts.taskId] - Custom task ID (default: derived from plan filename).
 * @param {number} [opts.context_budget] - Override context budget.
 * @returns {object} agentConfig — ready to pass to orchestrator.launch()
 */
function buildAgentConfig(planPath, cwd, opts = {}) {
  // Determine task ID early (needed for cache lookup)
  const taskId = opts.taskId || path.basename(planPath, path.extname(planPath))
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .substring(0, 40);

  // Check agent cache (skip if opts.skipCache is set, e.g. wave-to-wave rebuilds)
  if (!opts.skipCache) {
    try {
      const cache = agentCache();
      const cached = cache.loadCached(planPath, cwd, taskId);
      if (cached.hit) {
        cache.touchCached(cwd, taskId);
        cached.result._fromCache = true;
        return cached.result;
      }
    } catch { /* cache miss or error — build fresh */ }
  }

  // Parse plan
  const plan = assessor().parsePlan(planPath);

  // Resolve file paths relative to cwd
  plan.all_files = plan.all_files.map(f =>
    path.isAbsolute(f) ? f : path.join(cwd, f)
  );

  // Step 1: Analyze
  const analysis = analyzeTask(plan, cwd);

  // Step 2: Archetype
  const archetypeResult = determineArchetype(analysis);

  // Step 7 (needed for prompt): Session context
  const sessionContext = extractSessionContext(analysis);

  // Step 3: System prompt
  const systemPrompt = composeSystemPrompt(analysis, archetypeResult, sessionContext, cwd);

  // Step 4: Context package
  const config = assessor().loadForgeConfig(cwd);
  if (opts.context_budget) config.context_budget = opts.context_budget;
  const contextPackage = composeContextPackage(analysis, config);

  // Step 5: Verification
  const verification = defineVerification(analysis);

  // Step 5b: Hash locks (tamper detection for test files + verification criteria)
  // Enabled when hash_lock.enabled is true OR when test_first is on (default: on)
  try {
    const { config: cfgFull } = require('../forge-config/config').loadConfig(cwd);
    const testFirst = cfgFull.execution?.test_first !== false;
    if ((cfgFull.hash_lock && cfgFull.hash_lock.enabled) || testFirst) {
      computeHashLocks(taskId, plan, cwd);
    }
  } catch (err) {
    try {
      const ldg = ledger();
      ldg.logWarning(cwd, {
        warning: 'Hash lock computation failed: ' + err.message + ' — test files will NOT be tamper-protected',
        source: 'factory:computeHashLocks',
        severity: 'high',
      });
    } catch {}
  }

  // Task prompt (the actual plan content)
  const taskPrompt = plan.raw;

  // Build agent JSON (matches agent-entrypoint.js expected format)
  const agentConfig = {
    task_id: taskId,
    system_prompt: systemPrompt,
    task_prompt: taskPrompt,
    archetype: archetypeResult.archetype,
    archetype_reason: archetypeResult.reason,

    // Context loading instructions
    context: {
      always_load: contextPackage.always_load,
      task_specific: contextPackage.task_specific,
      reference: contextPackage.reference,
    },

    // Graph context for the agent entrypoint
    graph_context: analysis.graphContext ? {
      files: analysis.graphContext.summary,
      risk: analysis.risk,
      modules: analysis.affectedModules,
      boundaries: (analysis.graphContext.moduleBoundaries || []).map(b => `${b.source} → ${b.target}`),
      cycles_count: analysis.cycles.count,
    } : null,

    // System graph context for cross-repo awareness
    system_context: analysis.systemContext ? {
      service_id: analysis.systemContext.service_id,
      exports: analysis.systemContext.exports.map(e => ({ type: e.type, name: e.name, protocol: e.protocol })),
      consumers: analysis.systemContext.consumers.map(c => ({ consumer_id: c.consumer_id, type: c.type })),
      imports: analysis.systemContext.imports.map(i => ({ provider_id: i.provider_id, type: i.type, deprecated: !!i.deprecated })),
      system_db_path: analysis.systemContext.system_db_path,
    } : null,

    // Session context for the agent entrypoint
    session_context: sessionContext,

    // Verification steps
    verification_steps: verification,

    // Capabilities summary
    capabilities: Object.entries(analysis.capabilities).reduce((acc, [mod, caps]) => {
      acc[mod] = caps
        .filter(c => c.confidence >= CAPABILITY_CONFIDENCE_MIN)
        .map(c => ({ capability: c.capability, confidence: c.confidence }));
      return acc;
    }, {}),

    // Plan metadata
    plan_meta: {
      path: plan.path,
      objective: plan.objective,
      files_modified: plan.files_modified,
      frontmatter: plan.frontmatter,
    },
  };

  const result = {
    agentConfig,
    analysis: {
      archetype: archetypeResult,
      risk: analysis.risk,
      affectedModules: analysis.affectedModules,
      capabilities: analysis.capabilities,
      contextBudget: contextPackage.budget,
      verificationSteps: verification,
      hasGraph: analysis.hasGraph,
      hasSystemGraph: !!analysis.systemContext,
      systemService: analysis.systemContext?.service_id || null,
      systemConsumers: analysis.systemContext?.consumers?.length || 0,
      ledgerActive: analysis.ledgerState.exists,
    },
  };

  // Save to agent cache
  try {
    agentCache().saveToCache(planPath, cwd, taskId, result);
  } catch { /* cache write failure is non-fatal */ }

  return result;
}

// ============================================================
// Batch: buildAll
// ============================================================

/**
 * Build agent configs for multiple plan files.
 *
 * @param {string[]} planPaths
 * @param {string} cwd
 * @param {object} [opts]
 * @returns {object[]}
 */
function buildAll(planPaths, cwd, opts = {}) {
  return planPaths.map((pp, i) => {
    const taskId = opts.taskIds?.[i] || undefined;
    return buildAgentConfig(pp, cwd, { ...opts, taskId });
  });
}

// ============================================================
// CLI
// ============================================================

function formatAnalysis(result) {
  const { agentConfig, analysis } = result;
  const lines = [];

  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║               DYNAMIC AGENT FACTORY — ANALYSIS             ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Plan info
  lines.push(`Plan:       ${agentConfig.plan_meta.path}`);
  lines.push(`Objective:  ${agentConfig.plan_meta.objective || '(none)'}`);
  lines.push(`Task ID:    ${agentConfig.task_id}`);
  lines.push(`Files:      ${agentConfig.plan_meta.files_modified?.length || 0} modified`);
  lines.push('');

  // Archetype
  lines.push('┌─ Archetype ─────────────────────────────────────────────────┐');
  lines.push(`│ ${analysis.archetype.archetype.toUpperCase().padEnd(58)}│`);
  lines.push(`│ Reason: ${analysis.archetype.reason.substring(0, 50).padEnd(50)}│`);
  lines.push('└─────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Risk
  const riskColors = { LOW: '✓', MEDIUM: '⚠', HIGH: '✗', CRITICAL: '✗✗' };
  lines.push(`Risk:       ${riskColors[analysis.risk.level] || '?'} ${analysis.risk.level} (score: ${analysis.risk.score})`);
  if (analysis.risk.reasons.length > 0) {
    for (const r of analysis.risk.reasons.slice(0, 3)) {
      lines.push(`            - ${r}`);
    }
  }
  lines.push('');

  // Modules & capabilities
  lines.push(`Modules:    ${analysis.affectedModules.join(', ') || '(none detected)'}`);
  const capEntries = Object.entries(analysis.capabilities);
  if (capEntries.length > 0) {
    lines.push('Capabilities:');
    for (const [mod, caps] of capEntries) {
      const capStr = caps.map(c => `${c.capability}(${(c.confidence * 100).toFixed(0)}%)`).join(', ');
      lines.push(`  ${mod}: ${capStr}`);
    }
  }
  lines.push('');

  // Context budget
  const b = analysis.contextBudget;
  lines.push(`Context:    ${b.used_tokens} / ${b.max_tokens} tokens (${b.utilization})`);
  lines.push(`  always_load:    ${agentConfig.context.always_load.length} files`);
  lines.push(`  task_specific:  ${agentConfig.context.task_specific.length} files`);
  lines.push(`  reference:      ${agentConfig.context.reference.length} files`);
  lines.push('');

  // Verification
  lines.push(`Verification: ${analysis.verificationSteps.length} step(s)`);
  for (const v of analysis.verificationSteps) {
    lines.push(`  - ${v}`);
  }
  lines.push('');

  // Session & System
  lines.push(`Graph:      ${analysis.hasGraph ? 'available' : 'not found'}`);
  lines.push(`System:     ${analysis.hasSystemGraph ? `service: ${analysis.systemService}, ${analysis.systemConsumers} consumer(s)` : 'not found'}`);
  lines.push(`Ledger:     ${analysis.ledgerActive ? 'active' : 'not found'}`);
  lines.push(`Cache:      ${result._fromCache ? 'HIT (reused cached agent)' : 'MISS (built fresh)'}`);

  // System prompt preview
  lines.push('');
  lines.push('┌─ System Prompt (first 500 chars) ──────────────────────────┐');
  const promptPreview = agentConfig.system_prompt.substring(0, 500).split('\n');
  for (const line of promptPreview) {
    lines.push(`│ ${line.substring(0, 58).padEnd(58)}│`);
  }
  lines.push('└─────────────────────────────────────────────────────────────┘');

  return lines.join('\n');
}

function printUsage() {
  console.log(`
Usage: node forge-agents/factory.js <command> <plan-file> [options]

Commands:
  analyze <plan-file>      Analyze a plan and show agent configuration
  build <plan-file>        Build agent config JSON (stdout)
  build-all <dir>          Build configs for all .md plans in directory

Options:
  --root <path>            Project root (default: cwd)
  --json                   Output raw JSON instead of formatted text
  --task-id <id>           Override task ID
  --context-budget <n>     Override context budget (tokens)
  --skip-cache             Force fresh build, bypass agent cache
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const planArg = args[1];

  // Parse flags
  const flags = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) { flags.root = args[++i]; }
    else if (args[i] === '--json') { flags.json = true; }
    else if (args[i] === '--task-id' && args[i + 1]) { flags.taskId = args[++i]; }
    else if (args[i] === '--context-budget' && args[i + 1]) { flags.contextBudget = parseInt(args[++i], 10); }
    else if (args[i] === '--skip-cache') { flags.skipCache = true; }
  }

  const cwd = path.resolve(flags.root || process.cwd());

  if (command === 'analyze' || command === 'build') {
    if (!planArg) {
      console.error('Error: plan file path required');
      process.exit(1);
    }

    const planPath = path.resolve(planArg);
    if (!fs.existsSync(planPath)) {
      console.error(`Error: plan file not found: ${planPath}`);
      process.exit(1);
    }

    const opts = {};
    if (flags.taskId) opts.taskId = flags.taskId;
    if (flags.contextBudget) opts.context_budget = flags.contextBudget;
    if (flags.skipCache) opts.skipCache = true;

    const result = buildAgentConfig(planPath, cwd, opts);

    if (command === 'build' || flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAnalysis(result));
    }

  } else if (command === 'build-all') {
    if (!planArg) {
      console.error('Error: plan directory path required');
      process.exit(1);
    }

    const planDir = path.resolve(planArg);
    if (!fs.existsSync(planDir)) {
      console.error(`Error: plan directory not found: ${planDir}`);
      process.exit(1);
    }

    const planFiles = fs.readdirSync(planDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(planDir, f))
      .sort();

    if (planFiles.length === 0) {
      console.error('No .md plan files found in directory');
      process.exit(1);
    }

    const results = buildAll(planFiles, cwd, {
      context_budget: flags.contextBudget,
    });

    if (flags.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        console.log(formatAnalysis(r));
        console.log('\n' + '─'.repeat(62) + '\n');
      }
      console.log(`Total: ${results.length} agent config(s) built`);
    }

  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Core pipeline
  analyzeTask,
  selectAgents,
  matchCatalogAgents,
  loadCatalog,
  loadConstitution,
  loadGlossary,
  loadSystemGlossary,
  computeHashLocks,
  extractPlanSignals,
  pruneAgentBody,
  determineArchetype,
  composeSystemPrompt,
  composeContextPackage,
  defineVerification,
  extractSessionContext,

  // High-level
  buildAgentConfig,
  buildAll,

  // Constants
  CAPABILITY_CONFIDENCE_MIN,
  CAPABILITY_VERIFICATION_MAP,
};

// Run CLI if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
