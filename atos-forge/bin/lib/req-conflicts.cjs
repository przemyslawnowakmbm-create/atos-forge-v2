'use strict';
const fs = require('fs');
const path = require('path');
const { output, error } = require('./core.cjs');

// ─── Constants ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'can', 'with', 'and', 'or', 'in', 'to',
  'for', 'of', 'by', 'on', 'at', 'from', 'user', 'system', 'must', 'should',
]);

const EXCLUSIVE_GROUPS = [
  ['postgresql', 'mysql', 'mongodb', 'dynamodb', 'firestore', 'sqlite'],
  ['rest', 'graphql', 'grpc', 'trpc'],
  ['jwt', 'session-cookie', 'oauth-only'],
  ['serverless', 'kubernetes', 'single-server'],
  ['react', 'vue', 'angular', 'svelte'],
];

// Database group index (0) — conflicts are blockers; all others are warnings
const BLOCKER_GROUP_INDICES = new Set([0]);

const OVERLAP_THRESHOLD = 0.60;

// ─── parseRequirementsGraph ─────────────────────────────────────────────────

/**
 * Parse REQUIREMENTS.md content into a structured graph.
 *
 * @param {string} content - Raw markdown content
 * @returns {{ requirements: Array<{id:string, text:string, category:string, dependsOn:string[], line:number}>, depGraph: Map<string, string[]> }}
 */
function parseRequirementsGraph(content) {
  const lines = content.split('\n');
  const requirements = [];
  const depGraph = new Map();
  let currentCategory = '';

  const reqPattern = /^- \[[ x]\] \*\*([A-Z]+-\d+)\*\*:\s*(.+)$/;
  const categoryPattern = /^##\s+(.+)$/;
  const dependsOnPattern = /^\s*depends_on:\s*\[([^\]]*)\]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current category heading
    const catMatch = line.match(categoryPattern);
    if (catMatch) {
      currentCategory = catMatch[1].trim();
      continue;
    }

    // Match requirement line
    const reqMatch = line.match(reqPattern);
    if (reqMatch) {
      const id = reqMatch[1];
      const text = reqMatch[2].trim();
      let dependsOn = [];

      // Check the NEXT line for depends_on
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const depMatch = nextLine.match(dependsOnPattern);
        if (depMatch) {
          dependsOn = depMatch[1]
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        }
      }

      requirements.push({
        id,
        text,
        category: currentCategory,
        dependsOn,
        line: i + 1,
      });
      depGraph.set(id, dependsOn);
    }
  }

  // Ensure every referenced node exists in the graph (even if not defined as a requirement)
  for (const deps of depGraph.values()) {
    for (const dep of deps) {
      if (!depGraph.has(dep)) {
        depGraph.set(dep, []);
      }
    }
  }

  return { requirements, depGraph };
}

// ─── detectCycles (Tarjan's SCC) ────────────────────────────────────────────

/**
 * Detect cycles in a dependency graph using Tarjan's strongly connected components.
 *
 * @param {Map<string, string[]>} depGraph - Adjacency list (node → dependencies)
 * @returns {string[][]} Array of cycles (each cycle is an array of node IDs)
 */
function detectCycles(depGraph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const neighbors = depGraph.get(v) || [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    // Root of an SCC
    if (lowlinks.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      // Only report SCCs with more than 1 node (actual cycles)
      // or self-loops
      if (scc.length > 1) {
        sccs.push(scc);
      } else if (scc.length === 1) {
        // Check for self-loop
        const node = scc[0];
        const deps = depGraph.get(node) || [];
        if (deps.includes(node)) {
          sccs.push(scc);
        }
      }
    }
  }

  for (const node of depGraph.keys()) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}

// ─── detectOverlappingScope ─────────────────────────────────────────────────

/**
 * Extract keywords from requirement text (lowercase, stopwords removed).
 */
function extractKeywords(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Compute Jaccard similarity between two keyword arrays.
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Detect cross-category requirements with high keyword overlap.
 *
 * @param {Array<{id:string, text:string, category:string}>} requirements
 * @returns {Array<{type:string, severity:string, req_a:string, req_b:string, similarity:number, message:string}>}
 */
function detectOverlappingScope(requirements) {
  const conflicts = [];

  // Pre-compute keywords for each requirement
  const keywordMap = new Map();
  for (const req of requirements) {
    keywordMap.set(req.id, extractKeywords(req.text));
  }

  // Compare every pair
  for (let i = 0; i < requirements.length; i++) {
    for (let j = i + 1; j < requirements.length; j++) {
      const a = requirements[i];
      const b = requirements[j];

      const kwA = keywordMap.get(a.id);
      const kwB = keywordMap.get(b.id);
      const similarity = jaccardSimilarity(kwA, kwB);

      if (a.category === b.category) {
        // Same category: check for near-duplicate instead of scope overlap
        if (similarity > 0.80) {
          conflicts.push({
            type: 'potential_duplicate',
            severity: 'info',
            req_a: a.id,
            req_b: b.id,
            similarity: Math.round(similarity * 100) / 100,
            message: `${a.id} and ${b.id} in same category have ${Math.round(similarity * 100)}% keyword overlap — may be duplicates`,
          });
        }
        continue;
      }

      if (similarity > OVERLAP_THRESHOLD) {
        conflicts.push({
          type: 'overlapping_scope',
          severity: 'warning',
          req_a: a.id,
          req_b: b.id,
          similarity: Math.round(similarity * 100) / 100,
          message: `Overlapping scope between ${a.category} and ${b.category}: ${a.id} and ${b.id} share ${Math.round(similarity * 100)}% keyword overlap`,
        });
      }
    }
  }

  return conflicts;
}

// ─── detectTechConflicts ────────────────────────────────────────────────────

/**
 * Detect mutually exclusive technology references across categories.
 *
 * @param {Array<{id:string, text:string, category:string}>} requirements
 * @returns {Array<{type:string, severity:string, req_a:string, req_b:string, tech_a:string, tech_b:string, group:string, message:string}>}
 */
function detectTechConflicts(requirements) {
  const conflicts = [];

  // For each requirement, find which exclusive group technologies it references
  function findTechRefs(text) {
    const lower = text.toLowerCase();
    const refs = [];
    for (let gi = 0; gi < EXCLUSIVE_GROUPS.length; gi++) {
      const group = EXCLUSIVE_GROUPS[gi];
      for (const tech of group) {
        // Match whole word (allow hyphenated terms)
        const regex = new RegExp('\\b' + tech.replace(/[-]/g, '[-\\s]?') + '\\b', 'i');
        if (regex.test(lower)) {
          refs.push({ tech, groupIndex: gi, groupName: getGroupName(gi) });
        }
      }
    }
    return refs;
  }

  function getGroupName(gi) {
    const names = ['database', 'api_style', 'auth_strategy', 'deployment', 'frontend_framework'];
    return names[gi] || `group_${gi}`;
  }

  // Compare all pairs for conflicting tech (same-category IS valid —
  // two reqs in same domain using different DBs is a real conflict)
  for (let i = 0; i < requirements.length; i++) {
    for (let j = i + 1; j < requirements.length; j++) {
      const a = requirements[i];
      const b = requirements[j];

      const refsA = findTechRefs(a.text);
      const refsB = findTechRefs(b.text);

      for (const ra of refsA) {
        for (const rb of refsB) {
          // Same exclusive group, different technology = conflict
          if (ra.groupIndex === rb.groupIndex && ra.tech !== rb.tech) {
            const severity = BLOCKER_GROUP_INDICES.has(ra.groupIndex) ? 'blocker' : 'warning';
            conflicts.push({
              type: 'tech_conflict',
              severity,
              req_a: a.id,
              req_b: b.id,
              tech_a: ra.tech,
              tech_b: rb.tech,
              group: ra.groupName,
              message: `Technology conflict (${ra.groupName}): ${a.id} uses ${ra.tech} but ${b.id} uses ${rb.tech}`,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

// ─── detectConflicts (main aggregator) ──────────────────────────────────────

/**
 * Run all conflict detectors on a project's REQUIREMENTS.md.
 *
 * @param {string} cwd - Project root directory
 * @param {object} [opts] - Options
 * @param {string} [opts.systemRequirements] - Path to system-level requirements for cross-service checks
 * @param {string} [opts.content] - Provide content directly (skips file read)
 * @returns {{ conflicts: Array, has_blockers: boolean, summary: { cycles: number, overlaps: number, tech_conflicts: number, total: number } }}
 */
function detectConflicts(cwd, opts) {
  opts = opts || {};
  let content = opts.content;

  if (!content) {
    const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
    if (!fs.existsSync(reqPath)) {
      return {
        conflicts: [],
        has_blockers: false,
        summary: { cycles: 0, overlaps: 0, tech_conflicts: 0, total: 0 },
        error: 'REQUIREMENTS.md not found',
      };
    }
    content = fs.readFileSync(reqPath, 'utf-8');
  }

  const { requirements, depGraph } = parseRequirementsGraph(content);
  const allConflicts = [];

  // 1. Cycle detection
  const cycles = detectCycles(depGraph);
  for (const cycle of cycles) {
    allConflicts.push({
      type: 'dependency_cycle',
      severity: 'blocker',
      nodes: cycle,
      message: `Dependency cycle: ${cycle.join(' → ')} → ${cycle[0]}`,
    });
  }

  // 2. Overlapping scope
  const overlaps = detectOverlappingScope(requirements);
  allConflicts.push(...overlaps);

  // 3. Tech conflicts
  const techConflicts = detectTechConflicts(requirements);
  allConflicts.push(...techConflicts);

  // 4. Cross-service checks (if system requirements provided)
  if (opts.systemRequirements) {
    try {
      const sysContent = fs.readFileSync(opts.systemRequirements, 'utf-8');
      const sysGraph = parseRequirementsGraph(sysContent);
      const crossOverlaps = detectOverlappingScope([...requirements, ...sysGraph.requirements]);
      // Only keep cross-file overlaps (at least one req from each source)
      const localIds = new Set(requirements.map(r => r.id));
      const sysIds = new Set(sysGraph.requirements.map(r => r.id));
      for (const c of crossOverlaps) {
        const aLocal = localIds.has(c.req_a);
        const bLocal = localIds.has(c.req_b);
        const aSys = sysIds.has(c.req_a);
        const bSys = sysIds.has(c.req_b);
        if ((aLocal && bSys) || (aSys && bLocal)) {
          c.type = 'cross_service_overlap';
          c.message = `Cross-service overlap: ${c.req_a} and ${c.req_b}`;
          allConflicts.push(c);
        }
      }
    } catch {
      // System requirements file not readable — skip
    }
  }

  const has_blockers = allConflicts.some(c => c.severity === 'blocker');

  return {
    conflicts: allConflicts,
    has_blockers,
    summary: {
      cycles: cycles.length,
      overlaps: overlaps.length,
      tech_conflicts: techConflicts.length,
      total: allConflicts.length,
    },
  };
}

// ─── CLI handler ────────────────────────────────────────────────────────────

/**
 * CLI entry point for `forge-tools requirements conflicts`.
 *
 * @param {string} cwd - Working directory
 * @param {string[]} args - Remaining CLI arguments
 * @param {boolean} raw - JSON output mode
 */
function cmdRequirementsConflicts(cwd, args, raw) {
  const jsonFlag = args.includes('--json');
  const systemIndex = args.indexOf('--system');
  const systemPath = systemIndex !== -1 ? args[systemIndex + 1] : undefined;

  const opts = {};
  if (systemPath) {
    opts.systemRequirements = path.isAbsolute(systemPath)
      ? systemPath
      : path.join(cwd, systemPath);
  }

  const result = detectConflicts(cwd, opts);

  if (result.error) {
    error(result.error);
    return;
  }

  if (jsonFlag || raw) {
    output(result, raw);
    return;
  }

  // Human-readable output
  const { conflicts, has_blockers, summary } = result;

  if (conflicts.length === 0) {
    process.stdout.write('No requirement conflicts detected.\n');
    return;
  }

  process.stdout.write(`\nRequirement Conflicts (${summary.total} found):\n`);
  process.stdout.write('─'.repeat(60) + '\n\n');

  if (summary.cycles > 0) {
    process.stdout.write(`BLOCKERS — Dependency Cycles (${summary.cycles}):\n`);
    for (const c of conflicts.filter(c => c.type === 'dependency_cycle')) {
      process.stdout.write(`  ✗ ${c.message}\n`);
    }
    process.stdout.write('\n');
  }

  if (summary.tech_conflicts > 0) {
    process.stdout.write(`Technology Conflicts (${summary.tech_conflicts}):\n`);
    for (const c of conflicts.filter(c => c.type === 'tech_conflict')) {
      const icon = c.severity === 'blocker' ? '✗' : '⚠';
      process.stdout.write(`  ${icon} ${c.message}\n`);
    }
    process.stdout.write('\n');
  }

  if (summary.overlaps > 0) {
    process.stdout.write(`Overlapping Scope (${summary.overlaps}):\n`);
    for (const c of conflicts.filter(c => c.type === 'overlapping_scope')) {
      process.stdout.write(`  ⚠ ${c.message}\n`);
    }
    process.stdout.write('\n');
  }

  const crossService = conflicts.filter(c => c.type === 'cross_service_overlap');
  if (crossService.length > 0) {
    process.stdout.write(`Cross-Service Overlaps (${crossService.length}):\n`);
    for (const c of crossService) {
      process.stdout.write(`  ⚠ ${c.message}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write('─'.repeat(60) + '\n');
  process.stdout.write(`Summary: ${summary.cycles} cycles, ${summary.tech_conflicts} tech conflicts, ${summary.overlaps} overlaps\n`);

  if (has_blockers) {
    process.stdout.write('Status: BLOCKERS FOUND — resolve before planning\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Status: Warnings only — review recommended\n');
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  parseRequirementsGraph,
  detectCycles,
  detectOverlappingScope,
  detectTechConflicts,
  detectConflicts,
  cmdRequirementsConflicts,
};
