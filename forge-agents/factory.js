#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Dynamic Agent Factory
// ============================================================
// Builds specialized agent configurations from sub-plans by:
// 1. Analyzing the task (graph context, capabilities, risk, ledger)
// 2. Determining archetype (specialist / integrator / careful / general)
// 3. Composing a system prompt with capability-specific instructions
// 4. Assembling a context package (always_load / task_specific / reference)
// 5. Defining verification criteria
// 6. Defining container spec parameters
// 7. Extracting session context for the agent
// ============================================================

// Lazy-loaded dependencies (only resolved when called)
let _graphQuery, _ledger, _assessor, _capDetector, _containerSpec, _containerConfig, _systemQuery, _knowledge, _agentCache;

function graphQuery() {
  if (!_graphQuery) _graphQuery = require('../forge-graph/query');
  return _graphQuery;
}
function ledger() {
  if (!_ledger) _ledger = require('../forge-session/ledger');
  return _ledger;
}
function assessor() {
  if (!_assessor) _assessor = require('../forge-assess/assessor');
  return _assessor;
}
function capDetector() {
  if (!_capDetector) _capDetector = require('../forge-graph/capability-detector');
  return _capDetector;
}
function containerSpec() {
  if (!_containerSpec) _containerSpec = require('../forge-containers/container-spec');
  return _containerSpec;
}
function containerConfig() {
  if (!_containerConfig) _containerConfig = require('../forge-containers/config');
  return _containerConfig;
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

const CHARS_PER_TOKEN = 4;

// Context window budgets (tokens)
const DEFAULT_CONTEXT_WINDOW = 200000;
const CONTEXT_LOAD_RATIO = 0.70; // Load context up to 70% of window

// Archetype thresholds
const ARCHETYPE = {
  SPECIALIST: 'specialist',
  INTEGRATOR: 'integrator',
  CAREFUL: 'careful',
  GENERAL: 'general',
};

// Risk level → archetype bias
const RISK_ARCHETYPE_MAP = {
  CRITICAL: ARCHETYPE.CAREFUL,
  HIGH: ARCHETYPE.CAREFUL,
  MEDIUM: null, // no override
  LOW: null,
};

// Module count thresholds for archetype
const MODULE_THRESHOLD_SINGLE = 1;
const MODULE_THRESHOLD_INTEGRATOR = 3;

// Capability confidence threshold to include agent_context
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
    } catch { /* system graph not available or query failed */ }
  }

  // Ledger state
  let ledgerState = { exists: false };
  let ledgerContent = '';
  try {
    ledgerState = ledger().readState(cwd);
    if (ledgerState.exists) {
      ledgerContent = ledger().read(cwd);
    }
  } catch { /* ledger may not exist */ }

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
// Step 2: Determine Archetype
// ============================================================

/**
 * Determine agent archetype based on analysis results.
 *
 * Archetypes:
 * - specialist: Single module, strong capability match (≥1 cap at ≥0.6 confidence)
 * - integrator: 3+ modules affected, cross-boundary work
 * - careful: High/critical risk level
 * - general: Default fallback
 *
 * @param {object} analysis - From analyzeTask()
 * @returns {{ archetype: string, reason: string }}
 */
function determineArchetype(analysis) {
  const { risk, affectedModules, capabilities } = analysis;

  // Risk override takes priority
  const riskOverride = RISK_ARCHETYPE_MAP[risk.level];
  if (riskOverride) {
    return {
      archetype: riskOverride,
      reason: `Risk level ${risk.level} (score: ${risk.score}): ${risk.reasons.slice(0, 2).join('; ')}`,
    };
  }

  // Integrator: many modules
  if (affectedModules.length >= MODULE_THRESHOLD_INTEGRATOR) {
    return {
      archetype: ARCHETYPE.INTEGRATOR,
      reason: `${affectedModules.length} modules affected: ${affectedModules.join(', ')}`,
    };
  }

  // Specialist: single module with strong capability match
  if (affectedModules.length <= MODULE_THRESHOLD_SINGLE) {
    const allCaps = Object.values(capabilities).flat();
    const strongCap = allCaps.find(c => c.confidence >= 0.6);
    if (strongCap) {
      return {
        archetype: ARCHETYPE.SPECIALIST,
        reason: `Single module with strong ${strongCap.capability} capability (${(strongCap.confidence * 100).toFixed(0)}%)`,
      };
    }
  }

  return {
    archetype: ARCHETYPE.GENERAL,
    reason: `${affectedModules.length} module(s), no strong specialization or risk signal`,
  };
}

// ============================================================
// Step 3: Compose System Prompt
// ============================================================

const BASE_EXECUTOR_PROMPT = `You are a code execution agent working inside a containerized environment.
Your task is to implement changes according to the plan provided.

Rules:
- Read files before modifying them.
- Make minimal, focused changes — do not refactor unrelated code.
- Do not create unnecessary files.
- Run verification commands when specified.
- If you encounter an error, try to fix it. If stuck after 2 attempts, document the issue and move on.
- Write your changes as a git diff (already handled by the entrypoint).`;

const ARCHETYPE_PROMPTS = {
  [ARCHETYPE.SPECIALIST]: `
You are a SPECIALIST agent. Focus deeply on the specific domain and module assigned.
- Use domain-specific best practices and patterns.
- Prefer idiomatic solutions for the technology stack.
- You have deep knowledge of this module — leverage it.`,

  [ARCHETYPE.INTEGRATOR]: `
You are an INTEGRATOR agent. Your task spans multiple modules.
- Pay careful attention to module boundaries and interfaces.
- Ensure changes in one module don't break contracts consumed by others.
- Check import paths and export signatures across module boundaries.
- Prefer minimal cross-module coupling.`,

  [ARCHETYPE.CAREFUL]: `
You are a CAREFUL agent. The changes you're making touch high-risk areas.
- Verify each change thoroughly before moving on.
- Pay special attention to backwards compatibility.
- Check consumer count for interfaces you modify.
- Run verification commands after each logical change.
- If unsure about a change, document the concern in a comment.`,

  [ARCHETYPE.GENERAL]: `
You are a general-purpose execution agent.
- Follow the plan step by step.
- Make clean, focused changes.
- Verify your work when verification steps are provided.`,
};

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
function composeSystemPrompt(analysis, archetypeResult, sessionContext) {
  const parts = [BASE_EXECUTOR_PROMPT];

  // Archetype behavior
  parts.push(ARCHETYPE_PROMPTS[archetypeResult.archetype] || ARCHETYPE_PROMPTS[ARCHETYPE.GENERAL]);

  // Agent Directives — mechanical overrides for production-grade code quality
  const directives = loadAgentDirectives();
  if (directives) {
    parts.push('\n' + directives);
  }

  // Capability-specific instructions
  const allCaps = Object.values(analysis.capabilities).flat();
  const relevantCaps = allCaps.filter(c => c.confidence >= CAPABILITY_CONFIDENCE_MIN);
  if (relevantCaps.length > 0) {
    parts.push('\n## Domain Knowledge');
    const seen = new Set();
    for (const cap of relevantCaps) {
      if (seen.has(cap.capability)) continue;
      seen.add(cap.capability);
      // Pull agent_context from capability definitions
      const agentCtx = getAgentContext(cap.capability, analysis.plan.path);
      if (agentCtx) {
        parts.push(`\n### ${cap.capability} (${(cap.confidence * 100).toFixed(0)}% confidence)`);
        parts.push(agentCtx);
      }
    }
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
  const groundingCwd = analysis.plan?.path ? path.dirname(path.dirname(analysis.plan.path)) : process.cwd();
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

  // Previous agent findings (propagated from earlier waves)
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

/**
 * Get agent_context for a capability by name.
 * First checks graph DB capabilities, then falls back to CAPABILITY_DEFINITIONS.
 */
function getAgentContext(capabilityName, planPath) {
  try {
    const defs = capDetector().CAPABILITY_DEFINITIONS;
    if (defs[capabilityName] && defs[capabilityName].agent_context) {
      return defs[capabilityName].agent_context;
    }
  } catch { /* capability detector not available */ }
  return null;
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
 * Does NOT call buildSpec — returns the params for the orchestrator to use.
 *
 * @param {string} taskId
 * @param {string} cwd
 * @param {object} analysis
 * @param {object} agentConfig - Full agent JSON (prompt, task, context, etc.)
 * @returns {object} params suitable for containerSpec.buildSpec()
 */
function defineContainerParams(taskId, cwd, analysis, agentConfig) {
  let resourceConfig;
  try {
    resourceConfig = containerConfig().resolveConfig(cwd);
  } catch {
    // Fallback defaults
    resourceConfig = {
      max_memory_per_container_str: '2g',
      max_cpu_per_container: 1.0,
      timeout_seconds: 600,
    };
  }

  // Determine image template
  let dockerfile;
  const allCaps = Object.values(analysis.capabilities).flat();
  const capNames = new Set(allCaps.map(c => c.capability));

  // If Python-related capabilities detected, use python or full template
  const pythonCaps = ['database_sql', 'ai_ml', 'testing'];
  const nodeCaps = ['react_advanced', 'ui_components', 'state_management', 'graphql', 'websockets'];
  const hasPython = pythonCaps.some(c => capNames.has(c)) ||
    analysis.plan.all_files.some(f => /\.py$/.test(f));
  const hasNode = nodeCaps.some(c => capNames.has(c)) ||
    analysis.plan.all_files.some(f => /\.(ts|tsx|js|jsx)$/.test(f));

  if (hasPython && hasNode) {
    dockerfile = 'full';
  } else if (hasPython) {
    dockerfile = 'python';
  }
  // else: default node (container-spec.selectImage handles it)

  return {
    taskId,
    cwd,
    worktreePath: null, // Set by orchestrator
    outputDir: null,    // Set by orchestrator
    agentConfig,
    resourceConfig,
    opts: {
      dockerfile,
      mode: 'agent',
    },
  };
}

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
  const systemPrompt = composeSystemPrompt(analysis, archetypeResult, sessionContext);

  // Step 4: Context package
  const config = assessor().loadForgeConfig(cwd);
  if (opts.context_budget) config.context_budget = opts.context_budget;
  const contextPackage = composeContextPackage(analysis, config);

  // Step 5: Verification
  const verification = defineVerification(analysis);

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

  // Step 6: Container params
  const containerParams = defineContainerParams(taskId, cwd, analysis, agentConfig);

  const result = {
    agentConfig,
    containerParams,
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
  determineArchetype,
  composeSystemPrompt,
  composeContextPackage,
  defineVerification,
  defineContainerParams,
  extractSessionContext,

  // High-level
  buildAgentConfig,
  buildAll,

  // Constants
  ARCHETYPE,
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
