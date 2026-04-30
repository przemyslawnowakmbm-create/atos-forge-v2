'use strict';

/**
 * Requirement Change Impact Analysis
 *
 * Builds a traceability map from requirements to plans/files/tests,
 * detects requirement changes against a baseline, and reports which
 * plans, files, and tests are affected by each change.
 *
 * Usage:
 *   const { handleRequirementsImpact } = require('./req-impact.cjs');
 *   handleRequirementsImpact(cwd, ['--json'], false);
 */

const fs = require('fs');
const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

/**
 * Parse requirements from REQUIREMENTS.md.
 * Reuses the same pattern as drift.cjs.
 * @param {string} cwd
 * @returns {object[]} Array of { id, text, completed }
 */
function parseRequirements(cwd) {
  const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  if (!fs.existsSync(reqPath)) return [];

  const content = fs.readFileSync(reqPath, 'utf8');
  const reqs = [];
  const pattern = /^- \[[ x]\] \*\*([A-Z]+-\d+)\*\*:\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    reqs.push({
      id: match[1],
      text: match[2].trim(),
      completed: content.charAt(match.index + 3) === 'x',
    });
  }

  // Also try table format: | REQ-ID | Description | ...
  const tablePattern = /^\|\s*([A-Z]+-\d+)\s*\|\s*([^|]+)/gm;
  let tableMatch;
  const existingIds = new Set(reqs.map(r => r.id));
  while ((tableMatch = tablePattern.exec(content)) !== null) {
    const id = tableMatch[1].trim();
    if (existingIds.has(id)) continue;
    reqs.push({ id, text: tableMatch[2].trim(), completed: false });
    existingIds.add(id);
  }

  return reqs;
}

/**
 * Build a reverse traceability map: requirement ID -> plans, files, tests, truths, artifacts, key_links.
 * @param {string} cwd
 * @returns {Object<string, { plans: string[], files: string[], tests: string[], truths: string[], artifacts: string[], key_links: string[] }>}
 */
function buildTraceabilityMap(cwd) {
  const map = {};
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!fs.existsSync(phasesDir)) return map;

  let parsePlan;
  try {
    const assessor = require(path.join(getForgeRoot(), 'forge-agents', 'plan-assessment'));
    parsePlan = assessor.parsePlan;
  } catch {
    parsePlan = null;
  }

  const phaseDirs = fs.readdirSync(phasesDir).filter(d => {
    try { return fs.statSync(path.join(phasesDir, d)).isDirectory(); } catch { return false; }
  });

  for (const dir of phaseDirs) {
    const dirPath = path.join(phasesDir, dir);
    const planFiles = fs.readdirSync(dirPath).filter(f => f.includes('PLAN') && f.endsWith('.md'));

    for (const planFile of planFiles) {
      const planPath = path.join(dirPath, planFile);
      const planId = `${dir}/${planFile}`;

      let parsed = null;
      if (parsePlan) {
        try { parsed = parsePlan(planPath); } catch { /* ignore */ }
      }

      // Fall back to raw content parsing if parsePlan unavailable
      let content;
      try { content = fs.readFileSync(planPath, 'utf8'); } catch { continue; }

      // Extract requirement IDs from frontmatter and body
      const reqIds = new Set();

      // Frontmatter: requirements: [REQ-01, REQ-02]
      if (parsed && parsed.frontmatter && parsed.frontmatter.requirements) {
        const reqs = parsed.frontmatter.requirements;
        for (const r of (Array.isArray(reqs) ? reqs : [reqs])) {
          if (typeof r === 'string') reqIds.add(r);
        }
      }

      // Body references: REQ-XX pattern
      const bodyRefs = content.match(/\bREQ-\d+\b/g) || [];
      for (const ref of bodyRefs) reqIds.add(ref);

      // Extract files, tests, truths, artifacts, key_links from parsed plan
      const files = [];
      const tests = [];
      const truths = [];
      const artifacts = [];
      const keyLinks = [];

      if (parsed && parsed.frontmatter) {
        const fm = parsed.frontmatter;
        if (fm.files_modified) {
          const fmFiles = Array.isArray(fm.files_modified) ? fm.files_modified : [fm.files_modified];
          files.push(...fmFiles.filter(f => typeof f === 'string'));
        }
        if (fm.must_haves) {
          const mh = fm.must_haves;
          if (mh.truths && Array.isArray(mh.truths)) truths.push(...mh.truths.filter(t => typeof t === 'string'));
          if (mh.artifacts && Array.isArray(mh.artifacts)) artifacts.push(...mh.artifacts.filter(a => typeof a === 'string'));
          if (mh.key_links && Array.isArray(mh.key_links)) keyLinks.push(...mh.key_links.filter(k => typeof k === 'string'));
        }
      }

      // Find test file references in plan content
      const testRefs = content.match(/(?:test|spec|__tests__)\/[^\s)"`']+\.(test|spec)\.[jt]sx?/g) || [];
      tests.push(...testRefs.map(t => t.replace(/^["'`]|["'`]$/g, '')));

      // Register each req ID
      for (const reqId of reqIds) {
        if (!map[reqId]) {
          map[reqId] = { plans: [], files: [], tests: [], truths: [], artifacts: [], key_links: [] };
        }
        map[reqId].plans.push(planId);
        for (const f of files) { if (!map[reqId].files.includes(f)) map[reqId].files.push(f); }
        for (const t of tests) { if (!map[reqId].tests.includes(t)) map[reqId].tests.push(t); }
        for (const tr of truths) { if (!map[reqId].truths.includes(tr)) map[reqId].truths.push(tr); }
        for (const a of artifacts) { if (!map[reqId].artifacts.includes(a)) map[reqId].artifacts.push(a); }
        for (const k of keyLinks) { if (!map[reqId].key_links.includes(k)) map[reqId].key_links.push(k); }
      }
    }
  }

  return map;
}

/**
 * Detect requirement changes by comparing current REQUIREMENTS.md against a saved baseline.
 * @param {string} cwd
 * @returns {{ has_baseline: boolean, changes: object[] }}
 */
function detectRequirementChanges(cwd) {
  const currentReqs = parseRequirements(cwd);
  const baselinePath = path.join(cwd, '.forge', 'requirements-baseline.json');

  if (!fs.existsSync(baselinePath)) {
    return {
      has_baseline: false,
      changes: currentReqs.map(r => ({ id: r.id, change_type: 'added', new_text: r.text })),
    };
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    return {
      has_baseline: false,
      changes: currentReqs.map(r => ({ id: r.id, change_type: 'added', new_text: r.text })),
    };
  }

  const baselineMap = {};
  for (const r of (baseline.requirements || [])) {
    baselineMap[r.id] = r;
  }

  const currentMap = {};
  for (const r of currentReqs) {
    currentMap[r.id] = r;
  }

  const changes = [];

  // Check for modified and removed requirements
  for (const id of Object.keys(baselineMap)) {
    if (!currentMap[id]) {
      changes.push({ id, change_type: 'removed', old_text: baselineMap[id].text });
    } else if (currentMap[id].text !== baselineMap[id].text) {
      changes.push({ id, change_type: 'modified', old_text: baselineMap[id].text, new_text: currentMap[id].text });
    }
  }

  // Check for added requirements
  for (const id of Object.keys(currentMap)) {
    if (!baselineMap[id]) {
      changes.push({ id, change_type: 'added', new_text: currentMap[id].text });
    }
  }

  return { has_baseline: true, changes };
}

/**
 * Analyze the impact of changed requirements.
 * @param {string} cwd
 * @param {string[]} changedReqIds
 * @returns {{ changed_requirements: object[], total_impact_score: number }}
 */
function analyzeImpact(cwd, changedReqIds) {
  const traceMap = buildTraceabilityMap(cwd);
  const changeInfo = detectRequirementChanges(cwd);
  const changeMap = {};
  for (const c of changeInfo.changes) changeMap[c.id] = c;

  const results = [];
  const allAffectedPlans = new Set();
  const allAffectedFiles = new Set();
  const allAffectedTests = new Set();

  for (const reqId of changedReqIds) {
    const trace = traceMap[reqId] || { plans: [], files: [], tests: [], truths: [], artifacts: [], key_links: [] };
    const change = changeMap[reqId] || { id: reqId, change_type: 'unknown' };

    for (const p of trace.plans) allAffectedPlans.add(p);
    for (const f of trace.files) allAffectedFiles.add(f);
    for (const t of trace.tests) allAffectedTests.add(t);

    results.push({
      id: reqId,
      change_type: change.change_type,
      old_text: change.old_text,
      new_text: change.new_text,
      affected_plans: trace.plans,
      affected_files: trace.files,
      affected_tests: trace.tests,
    });
  }

  // Impact score: ratio of total artifacts affected
  const totalPlans = Object.values(traceMap).reduce((sum, t) => sum + t.plans.length, 0) || 1;
  const totalImpactScore = allAffectedPlans.size / totalPlans;

  return {
    changed_requirements: results,
    total_impact_score: Math.min(1, totalImpactScore),
    summary: {
      total_affected_plans: allAffectedPlans.size,
      total_affected_files: allAffectedFiles.size,
      total_affected_tests: allAffectedTests.size,
    },
  };
}

/**
 * Save the current requirements as a baseline for future comparisons.
 * @param {string} cwd
 */
function saveRequirementsBaseline(cwd) {
  const reqs = parseRequirements(cwd);
  const forgeDir = path.join(cwd, '.forge');
  if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });

  const baseline = {
    requirements: reqs,
    saved_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(forgeDir, 'requirements-baseline.json'), JSON.stringify(baseline, null, 2));
  return { saved: true, count: reqs.length };
}

/**
 * CLI handler for requirements impact analysis.
 * @param {string} cwd
 * @param {string[]} args
 * @param {boolean} raw
 */
function handleRequirementsImpact(cwd, args, raw) {
  const opts = { json: raw };
  let saveBaseline = false;
  let specificReqs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' || args[i] === '--raw') opts.json = true;
    if (args[i] === '--save-baseline') saveBaseline = true;
    if (args[i] === '--reqs' && args[i + 1]) {
      specificReqs = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  // Save baseline mode
  if (saveBaseline) {
    const result = saveRequirementsBaseline(cwd);
    if (opts.json) {
      output(result, raw);
    } else {
      console.log(`Requirements baseline saved (${result.count} requirements)`);
    }
    return;
  }

  // Detect changes
  const changes = detectRequirementChanges(cwd);

  // Determine which req IDs to analyze
  const changedIds = specificReqs.length > 0
    ? specificReqs
    : changes.changes.map(c => c.id);

  if (changedIds.length === 0) {
    const result = { changes: [], impact: null, message: 'No requirement changes detected' };
    if (opts.json) {
      output(result, raw);
    } else {
      console.log('No requirement changes detected.');
      if (!changes.has_baseline) {
        console.log('Tip: Run with --save-baseline to create a baseline for future comparisons.');
      }
    }
    return;
  }

  // Analyze impact
  const impact = analyzeImpact(cwd, changedIds);

  const result = {
    has_baseline: changes.has_baseline,
    changes: changes.changes,
    impact: impact.changed_requirements,
    summary: impact.summary,
    total_impact_score: impact.total_impact_score,
  };

  if (opts.json) {
    output(result, raw);
  } else {
    console.log(`Requirements Impact Analysis`);
    console.log(`${'='.repeat(40)}`);
    console.log(`Changes detected: ${changes.changes.length}`);
    console.log(`Impact score: ${(impact.total_impact_score * 100).toFixed(1)}%`);
    console.log('');

    for (const req of impact.changed_requirements) {
      console.log(`  ${req.id} (${req.change_type})`);
      if (req.affected_plans.length > 0) {
        console.log(`    Plans: ${req.affected_plans.join(', ')}`);
      }
      if (req.affected_files.length > 0) {
        console.log(`    Files: ${req.affected_files.length} affected`);
      }
      if (req.affected_tests.length > 0) {
        console.log(`    Tests: ${req.affected_tests.length} affected`);
      }
    }

    console.log('');
    console.log(`Total: ${impact.summary.total_affected_plans} plans, ${impact.summary.total_affected_files} files, ${impact.summary.total_affected_tests} tests`);
  }
}

module.exports = {
  buildTraceabilityMap,
  detectRequirementChanges,
  analyzeImpact,
  saveRequirementsBaseline,
  handleRequirementsImpact,
};
