#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Requirement Impact Analyzer
// ============================================================
// Detects whether a phase requirement has cross-repo implications
// by querying system-graph.db before planning begins.
//
// Usage:
//   Programmatic: require('forge-analyze/analyzer').analyzeRequirement(cwd, opts)
//   CLI:          node analyzer.js --phase 3 --root . [--json]

// ── Lazy dependencies ──────────────────────────────────────

let _systemQuery, _config;

function systemQuery() {
  if (!_systemQuery) _systemQuery = require('../forge-system/query');
  return _systemQuery;
}

function config() {
  if (!_config) _config = require('../forge-config/config');
  return _config;
}

// ── Configuration ──────────────────────────────────────────

function loadAnalyzerConfig(cwd) {
  try {
    const c = config();
    const { config: effective } = c.loadConfig(cwd);
    return effective.impact_analysis || {};
  } catch {
    return {};
  }
}

// ── System DB Resolution ───────────────────────────────────

function resolveSystemDb(cwd, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;

  const env = process.env.FORGE_SYSTEM_GRAPH_PATH || process.env.FORGE_SYSTEM_GRAPH;
  if (env && fs.existsSync(env)) return env;

  const candidates = [
    path.join(cwd, '.forge', 'system-graph.db'),
    path.join(cwd, 'system-graph.db'),
  ];

  // Walk parent directories
  let dir = path.dirname(cwd);
  for (let i = 0; i < 3 && dir !== path.dirname(dir); i++) {
    candidates.push(path.join(dir, '.forge', 'system-graph.db'));
    dir = path.dirname(dir);
  }

  // Home directory
  const home = process.env.HOME || '';
  if (home) candidates.push(path.join(home, '.forge', 'system-graph.db'));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Keyword Extraction ─────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'how',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'its', 'his', 'her', 'their',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'up', 'down', 'out', 'off', 'over', 'under', 'between',
  'not', 'no', 'nor', 'so', 'too', 'very', 'just', 'also', 'than',
  'each', 'every', 'all', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same',
  // Common planning/generic terms to skip
  'implement', 'add', 'create', 'update', 'remove', 'fix', 'build',
  'phase', 'step', 'task', 'plan', 'feature', 'new', 'existing',
  'system', 'application', 'app', 'project', 'code', 'file', 'module',
  'use', 'using', 'used', 'make', 'ensure', 'support', 'enable',
  'based', 'level', 'type', 'data', 'set', 'get', 'handle', 'process',
  // HTTP/API generic terms (match too many interfaces)
  'post', 'put', 'delete', 'patch', 'request', 'response', 'endpoint',
  'status', 'service', 'server', 'client', 'route', 'routes', 'api',
  'url', 'uri', 'http', 'https', 'method', 'body', 'header', 'headers',
  // Generic architecture terms
  'change', 'changes', 'needs', 'must', 'work', 'works', 'existing',
  'current', 'first', 'next', 'last', 'user', 'users', 'account', 'accounts',
  'per', 'via', 'req', 'res', 'min', 'max', 'now', 'later', 'added',
]);

function extractKeywords(text) {
  if (!text) return [];

  // Strip markdown formatting
  const clean = text
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/`[^`]+`/g, '')              // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .replace(/[#*_~>|]/g, ' ')            // markdown chars
    .replace(/[-–—]/g, ' ')              // dashes
    .replace(/[^\w\s/]/g, ' ')           // punctuation except /
    .toLowerCase();

  // Extract words, keep multi-word terms like "api gateway"
  const words = clean.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Count frequency
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  // Also extract compound terms (adjacent pairs)
  const tokens = clean.split(/\s+/).filter(w => w.length > 1);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!STOP_WORDS.has(tokens[i]) && !STOP_WORDS.has(tokens[i + 1])) {
      const compound = `${tokens[i]} ${tokens[i + 1]}`;
      freq[compound] = (freq[compound] || 0) + 1;
    }
  }

  // Sort by frequency, return unique keywords
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count }));
}

// ── Core Analyzer ──────────────────────────────────────────

function analyzeRequirement(cwd, opts = {}) {
  const cfg = loadAnalyzerConfig(cwd);
  if (cfg.enabled === false) {
    return { scope: 'SINGLE_REPO', reason: 'impact_analysis_disabled', affected_services: [] };
  }

  const dbPath = resolveSystemDb(cwd, opts.system_db);
  if (!dbPath) {
    return { scope: 'SINGLE_REPO', reason: 'no_system_graph', affected_services: [] };
  }

  const maxDepth = opts.max_depth || cfg.max_depth || 2;

  // Combine all text sources for keyword extraction
  const textParts = [
    opts.phase_goal || '',
    opts.phase_requirements || '',
    opts.context || '',
  ].filter(Boolean);

  const allText = textParts.join('\n');
  if (!allText.trim()) {
    return { scope: 'SINGLE_REPO', reason: 'no_input_text', affected_services: [] };
  }

  const keywords = extractKeywords(allText);
  if (keywords.length === 0) {
    return { scope: 'SINGLE_REPO', reason: 'no_keywords_extracted', affected_services: [] };
  }

  // Query system graph
  const SQ = systemQuery();
  const sq = new SQ.SystemQuery(dbPath);
  sq.open();

  try {
    return _analyzeWithGraph(sq, cwd, keywords, maxDepth, opts, dbPath);
  } finally {
    sq.close();
  }
}

function _analyzeWithGraph(sq, cwd, keywords, maxDepth, opts, dbPath) {
  // Step 1: Identify current service
  const currentServiceId = sq.findServiceByRepoPath(cwd);
  let currentService = null;
  if (currentServiceId) {
    try {
      currentService = sq.service(currentServiceId);
    } catch { /* service query failed */ }
  }

  // Step 2: Search interface registry for keyword matches
  const matchedInterfaces = new Map(); // interface_id → { interface, keywords[] }
  const matchedServices = new Map();   // service_id → { service, roles: Set, interfaces[], reasons[] }

  // Take top keywords (limit to avoid noise)
  const searchKeywords = keywords.slice(0, 20);

  for (const { word, count } of searchKeywords) {
    // Skip very short or numeric keywords
    if (word.length < 3 || /^\d+$/.test(word)) continue;

    try {
      const results = sq.interfaceRegistry({ search: word });
      for (const iface of results) {
        const key = `${iface.service_id}:${iface.type}:${iface.name}`;
        if (!matchedInterfaces.has(key)) {
          matchedInterfaces.set(key, { interface: iface, keywords: [] });
        }
        matchedInterfaces.get(key).keywords.push(word);

        // Track matched service
        if (!matchedServices.has(iface.service_id)) {
          // Look up repo_path from service record
          let repoPath = iface.repo || '';
          try {
            const svcInfo = sq.service(iface.service_id);
            if (svcInfo?.service?.repo_path) repoPath = svcInfo.service.repo_path;
          } catch { /* service lookup failed */ }

          matchedServices.set(iface.service_id, {
            id: iface.service_id,
            repo: repoPath,
            team: iface.team,
            roles: new Set(),
            interfaces: [],
            reasons: [],
          });
        }
        const svc = matchedServices.get(iface.service_id);
        svc.interfaces.push(iface.name);
        svc.reasons.push(`Interface "${iface.name}" matches keyword "${word}"`);
      }
    } catch { /* query failed for this keyword */ }
  }

  // Step 3: For each matched service, run impact analysis
  const serviceDetails = new Map();
  for (const [serviceId] of matchedServices) {
    try {
      const impact = sq.impact(serviceId, { depth: maxDepth });
      serviceDetails.set(serviceId, impact);

      // Add consumer services too
      if (impact.direct_consumers) {
        for (const consumer of impact.direct_consumers) {
          if (!matchedServices.has(consumer.consumer_id)) {
            // Look up repo_path from service record
            let repoPath = consumer.repo_path || consumer.repo || '';
            try {
              const svcInfo = sq.service(consumer.consumer_id);
              if (svcInfo?.service?.repo_path) repoPath = svcInfo.service.repo_path;
              else if (svcInfo?.service?.repo) repoPath = svcInfo.service.repo;
            } catch { /* service lookup failed */ }

            matchedServices.set(consumer.consumer_id, {
              id: consumer.consumer_id,
              repo: repoPath,
              team: consumer.team || '',
              roles: new Set(['consumer']),
              interfaces: [],
              reasons: [`Consumes ${serviceId} (${consumer.usage || 'dependency'})`],
            });
          }
          matchedServices.get(consumer.consumer_id).roles.add('consumer');
        }
      }
    } catch { /* impact query failed */ }
  }

  // Step 4: Classify roles (provider vs consumer)
  for (const [serviceId, svc] of matchedServices) {
    const impact = serviceDetails.get(serviceId);
    if (impact && impact.direct_consumers && impact.direct_consumers.length > 0) {
      svc.roles.add('provider');
    }
    // If this service imports from others in the matched set, it's a consumer
    if (impact && impact.service) {
      // Check if any of its imports come from other matched services
      try {
        const imports = sq.imports(serviceId);
        for (const imp of imports) {
          if (matchedServices.has(imp.provider_id || imp.service_id)) {
            svc.roles.add('consumer');
          }
        }
      } catch { /* import query failed */ }
    }
  }

  // Step 5: Determine scope
  const uniqueServices = [...matchedServices.keys()];

  // Filter to only services that are actually affected (not just keyword matches in current service)
  const externalServices = uniqueServices.filter(id => id !== currentServiceId);

  let scope = 'SINGLE_REPO';
  let confidence = 'low';

  if (externalServices.length > 0) {
    scope = 'MULTI_REPO';
    // Confidence based on keyword match quality
    const directMatches = externalServices.filter(id => {
      const svc = matchedServices.get(id);
      return svc.interfaces.length > 0; // Has actual interface matches
    });
    confidence = directMatches.length >= 2 ? 'high' : directMatches.length === 1 ? 'medium' : 'low';
  } else if (currentServiceId) {
    // Check if current service has consumers that might be affected
    const impact = serviceDetails.get(currentServiceId);
    if (impact && impact.direct_consumers && impact.direct_consumers.length > 0) {
      scope = 'MULTI_REPO';
      confidence = 'medium';
    } else {
      confidence = 'high'; // Confident it's single-repo
    }
  }

  // Step 6: Build execution order (providers before consumers)
  const executionOrder = buildExecutionOrder(matchedServices, serviceDetails);

  // Step 7: Collect team coordination
  const teams = new Set();
  for (const [, svc] of matchedServices) {
    if (svc.team) teams.add(svc.team);
  }

  // Step 8: Build affected_services array
  const affectedServices = [];
  for (const [serviceId, svc] of matchedServices) {
    const impact = serviceDetails.get(serviceId);
    const roles = [...svc.roles];
    const primaryRole = roles.includes('provider') ? 'provider' : 'consumer';
    const fanIn = impact?.metrics?.fan_in || 0;

    affectedServices.push({
      id: serviceId,
      repo_path: svc.repo || '',
      role: primaryRole,
      risk: fanIn >= 5 ? 'critical' : fanIn >= 3 ? 'high' : fanIn >= 1 ? 'medium' : 'low',
      fan_in: fanIn,
      affected_interfaces: [...new Set(svc.interfaces)],
      team: svc.team || '',
      reasons: [...new Set(svc.reasons)].slice(0, 5),
      is_current: serviceId === currentServiceId,
    });
  }

  // Sort: current service first, then providers, then consumers
  affectedServices.sort((a, b) => {
    if (a.is_current && !b.is_current) return -1;
    if (!a.is_current && b.is_current) return 1;
    if (a.role === 'provider' && b.role !== 'provider') return -1;
    if (a.role !== 'provider' && b.role === 'provider') return 1;
    return b.fan_in - a.fan_in;
  });

  // Build keyword match summary
  const keywordMatches = {};
  for (const [, mi] of matchedInterfaces) {
    for (const kw of mi.keywords) {
      keywordMatches[kw] = (keywordMatches[kw] || 0) + 1;
    }
  }

  return {
    scope,
    confidence,
    current_service: currentService ? {
      id: currentServiceId,
      repo: currentService.service?.repo || '',
      team: currentService.service?.team || '',
    } : null,
    affected_services: affectedServices,
    execution_order: executionOrder,
    team_coordination: [...teams],
    keyword_matches: keywordMatches,
    total_interfaces_matched: matchedInterfaces.size,
    system_db: dbPath ? (path.basename(path.dirname(dbPath)) + '/system-graph.db') : null,
  };
}

// ── Execution Order (topological) ──────────────────────────

function buildExecutionOrder(matchedServices, serviceDetails) {
  // Simple provider-before-consumer ordering
  const providers = [];
  const consumers = [];
  const mixed = [];

  for (const [serviceId, svc] of matchedServices) {
    const roles = [...svc.roles];
    if (roles.includes('provider') && !roles.includes('consumer')) {
      providers.push(serviceId);
    } else if (roles.includes('consumer') && !roles.includes('provider')) {
      consumers.push(serviceId);
    } else {
      mixed.push(serviceId);
    }
  }

  const order = [];
  // Wave 1: pure providers + mixed (they provide first)
  const wave1 = [...providers, ...mixed];
  if (wave1.length > 0) order.push(wave1.length === 1 ? wave1[0] : wave1);
  // Wave 2: pure consumers (can run in parallel)
  if (consumers.length > 0) order.push(consumers.length === 1 ? consumers[0] : consumers);

  return order;
}

// ── IMPACT.md Generation ───────────────────────────────────

function generateImpactMarkdown(result, phaseNumber, phaseName) {
  const lines = [];
  // Use only first line of phaseName as heading
  const title = (phaseName || 'Unknown').split('\n')[0].trim();
  lines.push(`# Impact Analysis — Phase ${phaseNumber || '?'}: ${title}`);
  lines.push('');
  lines.push(`## Scope: ${result.scope} (${result.affected_services.length} services affected)`);
  lines.push(`Confidence: ${result.confidence.toUpperCase()}`);
  lines.push('');

  if (result.current_service) {
    lines.push(`**Current service:** ${result.current_service.id} (${result.current_service.team || 'no team'})`);
    lines.push('');
  }

  if (result.affected_services.length > 0) {
    lines.push('## Affected Services (execution order)');
    lines.push('');

    let waveNum = 0;
    for (const wave of result.execution_order) {
      waveNum++;
      const services = Array.isArray(wave) ? wave : [wave];
      const parallel = services.length > 1 ? ' (parallel)' : '';
      lines.push(`### Wave ${waveNum}${parallel}`);
      lines.push('');

      for (const svcId of services) {
        const svc = result.affected_services.find(s => s.id === svcId);
        if (!svc) continue;
        lines.push(`**${svc.id}** — ${svc.role}${svc.is_current ? ' (current repo)' : ''}`);
        lines.push(`- **Repo:** ${svc.repo_path || 'unknown'}`);
        lines.push(`- **Team:** ${svc.team || 'unknown'}`);
        lines.push(`- **Risk:** ${svc.risk.toUpperCase()} (fan-in: ${svc.fan_in})`);
        if (svc.affected_interfaces.length > 0) {
          lines.push(`- **Interfaces:** ${svc.affected_interfaces.join(', ')}`);
        }
        if (svc.reasons.length > 0) {
          lines.push(`- **Why:** ${svc.reasons[0]}`);
        }
        lines.push('');
      }
    }
  }

  if (result.team_coordination.length > 1) {
    lines.push('## Team Coordination Required');
    lines.push('');
    for (const team of result.team_coordination) {
      lines.push(`- ${team}`);
    }
    lines.push('');
  }

  if (result.scope === 'MULTI_REPO') {
    lines.push('## Recommendations');
    lines.push('');
    lines.push('- Plan provider service changes first (Wave 1), consumer updates after (Wave 2+)');
    lines.push('- Run contract verification (L7) after provider changes to detect breaking changes');
    if (result.team_coordination.length > 1) {
      lines.push(`- Coordinate with: ${result.team_coordination.join(', ')}`);
    }
    lines.push('- Each consumer plan should include integration verification with provider');
    lines.push('');
  }

  if (Object.keys(result.keyword_matches).length > 0) {
    lines.push('## Keyword Matches');
    lines.push('');
    const sorted = Object.entries(result.keyword_matches).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [kw, count] of sorted) {
      lines.push(`- **${kw}**: ${count} interface${count > 1 ? 's' : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Write IMPACT.md ────────────────────────────────────────

function writeImpact(cwd, phaseNumber, result, phaseName) {
  const padded = String(phaseNumber).padStart(2, '0');
  const phaseDir = path.join(cwd, '.planning', 'phases', padded);

  // Only write if planning directory exists
  if (!fs.existsSync(path.join(cwd, '.planning'))) {
    return null;
  }

  if (!fs.existsSync(phaseDir)) {
    fs.mkdirSync(phaseDir, { recursive: true });
  }

  const impactPath = path.join(phaseDir, `${padded}-IMPACT.md`);
  const markdown = generateImpactMarkdown(result, phaseNumber, phaseName);
  fs.writeFileSync(impactPath, markdown, 'utf8');

  // Also write JSON for programmatic consumption
  const jsonPath = path.join(phaseDir, `${padded}-IMPACT.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');

  return { markdown_path: impactPath, json_path: jsonPath };
}

// ── Find existing IMPACT file ──────────────────────────────

function findImpactFile(cwd, planPath) {
  if (!planPath) return null;

  // Try to find IMPACT.json in same directory as plan
  const planDir = path.dirname(planPath);
  const files = fs.readdirSync(planDir).filter(f => f.endsWith('-IMPACT.json'));
  if (files.length > 0) {
    return path.join(planDir, files[0]);
  }

  // Try phase directory
  const match = planDir.match(/(\d+)/);
  if (match) {
    const padded = match[1].padStart(2, '0');
    const candidate = path.join(cwd, '.planning', 'phases', padded, `${padded}-IMPACT.json`);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// ── CLI ────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
  forge-analyze/analyzer.js — Requirement Impact Analyzer

  Usage:
    node analyzer.js analyze [options]     Analyze phase for cross-repo impact
    node analyzer.js show [options]        Show existing IMPACT.md

  Options:
    --phase <N>          Phase number
    --goal <text>        Phase goal text (auto-read from ROADMAP.md if omitted)
    --root <path>        Project root (default: cwd)
    --db <path>          Path to system-graph.db
    --json               JSON output
    --write              Write IMPACT.md to .planning/phases/
    `);
    process.exit(0);
  }

  const action = args[0];
  const cwd = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const jsonOutput = args.includes('--json');
  const write = args.includes('--write');
  const phaseIdx = args.indexOf('--phase');
  const phaseNumber = phaseIdx !== -1 ? parseInt(args[phaseIdx + 1], 10) : null;
  const goalIdx = args.indexOf('--goal');
  const goalText = goalIdx !== -1 ? args[goalIdx + 1] : '';
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : undefined;

  if (action === 'analyze') {
    // Try to read phase goal from ROADMAP.md if not provided
    let phaseGoal = goalText;
    if (!phaseGoal && phaseNumber) {
      try {
        const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
        const re = new RegExp(`##\\s*Phase\\s+${phaseNumber}[:\\s]+([^\\n]+)(?:\\n([\\s\\S]*?)(?=\\n##|$))`, 'i');
        const match = roadmap.match(re);
        if (match) {
          const title = match[1].trim();
          const body = (match[2] || '').trim().split('\n').slice(0, 5).join('\n');
          phaseGoal = title + (body ? '\n' + body : '');
        }
      } catch { /* no roadmap */ }
    }

    // Try to read requirements
    let requirements = '';
    try {
      const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
      if (fs.existsSync(reqPath)) requirements = fs.readFileSync(reqPath, 'utf8');
    } catch { /* no requirements */ }

    const result = analyzeRequirement(cwd, {
      phase_goal: phaseGoal,
      phase_requirements: requirements,
      system_db: dbPath,
    });

    if (write && phaseNumber) {
      const paths = writeImpact(cwd, phaseNumber, result, phaseGoal);
      if (paths) result._written = paths;
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const md = generateImpactMarkdown(result, phaseNumber, phaseGoal || 'Unknown');
      console.log(md);
    }
  } else if (action === 'show') {
    if (!phaseNumber) {
      console.error('Error: --phase <N> required for show');
      process.exit(1);
    }
    const padded = String(phaseNumber).padStart(2, '0');
    const mdPath = path.join(cwd, '.planning', 'phases', padded, `${padded}-IMPACT.md`);
    if (fs.existsSync(mdPath)) {
      console.log(fs.readFileSync(mdPath, 'utf8'));
    } else {
      console.error(`No IMPACT.md found for phase ${phaseNumber}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown action: ${action}. Use 'analyze' or 'show'.`);
    process.exit(1);
  }
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  analyzeRequirement,
  extractKeywords,
  resolveSystemDb,
  generateImpactMarkdown,
  writeImpact,
  findImpactFile,
  loadAnalyzerConfig,
};
