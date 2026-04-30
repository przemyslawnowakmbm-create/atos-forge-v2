#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * AI Drift Measurement Module
 *
 * Tracks accumulated deviation between what was specified (REQUIREMENTS.md + PLAN.md must_haves)
 * and what was built (VERIFICATION.md results), across all phases of a project.
 *
 * Drift score per requirement: 1 - (verified_items / total_items)
 *   0.00 = perfect implementation
 *   0.10 = 10% deviation (GREEN)
 *   0.25 = 25% deviation (YELLOW)
 *   0.50 = 50% deviation (RED)
 *
 * Usage:
 *   const { computeDriftReport } = require('./drift.cjs');
 *   const report = computeDriftReport(cwd, { phase: 10 });
 */

function loadConfig(cwd) {
  try {
    const { loadConfig: lc } = require('../../../forge-config/config');
    return lc(cwd).config.drift || {};
  } catch {
    return {};
  }
}

function classifyDrift(score, thresholds) {
  const green = thresholds?.green_max ?? 0.10;
  const yellow = thresholds?.yellow_max ?? 0.25;
  if (score <= green) return 'GREEN';
  if (score <= yellow) return 'YELLOW';
  return 'RED';
}

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
    if (existingIds.has(id)) continue; // don't duplicate
    reqs.push({
      id,
      text: tableMatch[2].trim(),
      completed: false, // table format doesn't have checkboxes
    });
  }

  return reqs;
}

function findPlans(cwd, phase) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!fs.existsSync(phasesDir)) return [];

  const plans = [];
  const dirs = fs.readdirSync(phasesDir).filter(d => {
    if (!fs.statSync(path.join(phasesDir, d)).isDirectory()) return false;
    if (phase !== undefined) {
      const phaseNum = parseInt(d.match(/^(\d+)/)?.[1], 10);
      return phaseNum === phase;
    }
    return true;
  });

  for (const dir of dirs) {
    const dirPath = path.join(phasesDir, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.includes('PLAN') && f.endsWith('.md'));
    for (const f of files) {
      try {
        const planPath = path.join(dirPath, f);
        const assessor = require('../../../forge-agents/plan-assessment');
        const parsed = assessor.parsePlan(planPath);
        plans.push(parsed);
      } catch { /* skip unparseable plans */ }
    }
  }
  return plans;
}

function findVerifications(cwd, phase) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!fs.existsSync(phasesDir)) return [];

  const verifications = [];
  const dirs = fs.readdirSync(phasesDir).filter(d => {
    if (!fs.statSync(path.join(phasesDir, d)).isDirectory()) return false;
    if (phase !== undefined) {
      const phaseNum = parseInt(d.match(/^(\d+)/)?.[1], 10);
      return phaseNum === phase;
    }
    return true;
  });

  for (const dir of dirs) {
    const dirPath = path.join(phasesDir, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.includes('VERIFICATION') && f.endsWith('.md'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(dirPath, f), 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]+?)\n---/);
        const body = content;

        const statusMatch = body.match(/status:\s*(passed|gaps_found|human_needed|failed)/);
        const scoreMatch = body.match(/score:\s*([\d.]+)/);

        const truths = [];
        const truthPattern = /[✓✗?]\s+(VERIFIED|FAILED|UNCERTAIN)\s*[—–-]\s*(.+)/g;
        let tm;
        while ((tm = truthPattern.exec(body)) !== null) {
          truths.push({ verdict: tm[1], text: tm[2].trim() });
        }

        const artifacts = [];
        const artifactPattern = /[✓⚠✗]\s+(VERIFIED|ORPHANED|STUB|MISSING)\s*[—–-]\s*`?([^`\n]+)/g;
        let am;
        while ((am = artifactPattern.exec(body)) !== null) {
          artifacts.push({ verdict: am[1], path: am[2].trim() });
        }

        const keyLinks = [];
        const linkPattern = /(WIRED|PARTIAL|NOT_WIRED)\s*[—–-]\s*(.+)/g;
        let lm;
        while ((lm = linkPattern.exec(body)) !== null) {
          keyLinks.push({ verdict: lm[1], description: lm[2].trim() });
        }

        verifications.push({
          file: f,
          phase: dir,
          status: statusMatch ? statusMatch[1] : 'unknown',
          score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
          truths,
          artifacts,
          keyLinks,
        });
      } catch { /* skip */ }
    }
  }
  return verifications;
}

function computeRequirementDrift(reqId, reqText, plans, verifications) {
  const coveringPlans = plans.filter(p =>
    (p.frontmatter?.requirements || []).includes(reqId)
  );

  if (coveringPlans.length === 0) {
    return {
      requirement_id: reqId,
      specification: reqText,
      status: 'NO_PLAN',
      truths_specified: 0,
      truths_verified: 0,
      truths_failed: 0,
      artifacts_specified: 0,
      artifacts_present: 0,
      artifacts_wired: 0,
      key_links_specified: 0,
      key_links_verified: 0,
      drift_score: 1.0,
      drift_details: ['No plan covers this requirement'],
    };
  }

  let totalItems = 0;
  let verifiedItems = 0;
  let truthsVerified = 0;
  let artifactsVerified = 0;
  let linksVerified = 0;
  let truthCount = 0;
  let artifactCount = 0;
  let linkCount = 0;
  const details = [];

  for (const plan of coveringPlans) {
    const mh = plan.frontmatter?.must_haves || {};

    truthCount += (mh.truths || []).length;
    artifactCount += (mh.artifacts || []).length;
    linkCount += (mh.key_links || []).length;
    totalItems += (mh.truths || []).length + (mh.artifacts || []).length + (mh.key_links || []).length;

    // Match against verifications
    for (const v of verifications) {
      for (const truth of v.truths) {
        if (truth.verdict === 'VERIFIED') { verifiedItems++; truthsVerified++; }
        else if (truth.verdict === 'UNCERTAIN') { verifiedItems += 0.5; truthsVerified += 0.5; details.push(`Truth '${truth.text}' — UNCERTAIN`); }
        else details.push(`Truth '${truth.text}' — ${truth.verdict}`);
      }
      for (const artifact of v.artifacts) {
        if (artifact.verdict === 'VERIFIED') { verifiedItems++; artifactsVerified++; }
        else if (artifact.verdict === 'ORPHANED') { verifiedItems += 0.5; artifactsVerified += 0.5; details.push(`Artifact '${artifact.path}' — ORPHANED (exists but not wired)`); }
        else details.push(`Artifact '${artifact.path}' — ${artifact.verdict}`);
      }
      for (const link of v.keyLinks) {
        if (link.verdict === 'WIRED') { verifiedItems++; linksVerified++; }
        else if (link.verdict === 'PARTIAL') { verifiedItems += 0.5; linksVerified += 0.5; details.push(`Link '${link.description}' — PARTIAL`); }
        else details.push(`Link '${link.description}' — ${link.verdict}`);
      }
    }

    // If no verification exists yet, count as fully drifted
    if (verifications.length === 0 && totalItems > 0) {
      details.push('No VERIFICATION.md found — plan not yet verified');
    }
  }

  if (totalItems === 0) {
    return {
      requirement_id: reqId,
      specification: reqText,
      status: 'NO_MUST_HAVES',
      truths_specified: 0, truths_verified: 0, truths_failed: 0,
      artifacts_specified: 0, artifacts_present: 0, artifacts_wired: 0,
      key_links_specified: 0, key_links_verified: 0,
      drift_score: 0,
      drift_details: ['Plan has no must_haves — cannot measure drift'],
    };
  }

  const driftScore = Math.max(0, Math.min(1, 1 - (verifiedItems / totalItems)));

  return {
    requirement_id: reqId,
    specification: reqText,
    status: driftScore === 0 ? 'PERFECT' : driftScore < 0.10 ? 'GOOD' : driftScore < 0.25 ? 'DRIFTING' : 'SIGNIFICANT_DRIFT',
    truths_specified: truthCount,
    truths_verified: truthsVerified,
    truths_failed: truthCount - truthsVerified,
    artifacts_specified: artifactCount,
    artifacts_present: artifactsVerified,
    artifacts_wired: 0,
    key_links_specified: linkCount,
    key_links_verified: linksVerified,
    drift_score: parseFloat(driftScore.toFixed(4)),
    drift_details: details,
  };
}

function computeDriftReport(cwd, opts = {}) {
  const config = loadConfig(cwd);
  const thresholds = config.thresholds || {};

  const requirements = parseRequirements(cwd);
  const plans = findPlans(cwd, opts.phase);
  const verifications = findVerifications(cwd, opts.phase);

  const perRequirement = requirements.map(req =>
    computeRequirementDrift(req.id, req.text, plans, verifications)
  );

  const scored = perRequirement.filter(r => r.drift_score !== undefined && r.status !== 'NO_MUST_HAVES');
  const aggregateScore = scored.length > 0
    ? scored.reduce((sum, r) => sum + r.drift_score, 0) / scored.length
    : 0;

  const severity = classifyDrift(aggregateScore, thresholds);

  const report = {
    generated: new Date().toISOString(),
    project: cwd,
    phase: opts.phase || 'all',
    total_requirements: requirements.length,
    requirements_with_plans: perRequirement.filter(r => r.status !== 'NO_PLAN').length,
    requirements_verified: perRequirement.filter(r => r.drift_score === 0).length,
    requirements_drifting: perRequirement.filter(r => r.drift_score > 0 && r.drift_score <= 0.25).length,
    requirements_significant_drift: perRequirement.filter(r => r.drift_score > 0.25).length,
    aggregate_drift_score: parseFloat(aggregateScore.toFixed(4)),
    aggregate_severity: severity,
    thresholds: { green_max: thresholds.green_max ?? 0.10, yellow_max: thresholds.yellow_max ?? 0.25 },
    block_on_red: config.block_on_red !== false,
    per_requirement: perRequirement,
  };

  // Write report file
  const reportPath = path.resolve(cwd, config.report_path || '.forge/drift-report.json');
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  // Return block signal for RED drift when block_on_red is true
  report.should_block = report.aggregate_severity === 'RED' && report.block_on_red;

  return report;
}

function formatDriftMarkdown(report) {
  const lines = [];
  const icon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' };

  lines.push('## Drift Report');
  lines.push('');
  lines.push(`**Aggregate:** ${icon[report.aggregate_severity] || '⚪'} ${(report.aggregate_drift_score * 100).toFixed(1)}% drift (${report.aggregate_severity})`);
  lines.push(`**Requirements:** ${report.total_requirements} total, ${report.requirements_with_plans} with plans, ${report.requirements_verified} perfect, ${report.requirements_drifting} drifting, ${report.requirements_significant_drift} significant drift`);
  lines.push('');

  if (report.per_requirement.length > 0) {
    lines.push('| Requirement | Drift | Severity | Status |');
    lines.push('|------------|-------|----------|--------|');
    for (const r of report.per_requirement) {
      const sev = classifyDrift(r.drift_score, report.thresholds);
      lines.push(`| ${r.requirement_id} | ${(r.drift_score * 100).toFixed(1)}% | ${icon[sev] || '⚪'} ${sev} | ${r.status} |`);
    }
  }

  if (report.aggregate_severity === 'RED' && report.block_on_red) {
    lines.push('');
    lines.push('**⛔ BLOCKED:** Drift exceeds 25% threshold. Phase completion blocked.');
  }

  return lines.join('\n');
}

function formatDriftAnnotations(report) {
  const lines = [];
  for (const r of report.per_requirement) {
    if (r.drift_score > report.thresholds.yellow_max) {
      lines.push(`::error::${r.requirement_id}: ${(r.drift_score * 100).toFixed(1)}% drift — ${r.drift_details.slice(0, 3).join('; ')}`);
    } else if (r.drift_score > report.thresholds.green_max) {
      lines.push(`::warning::${r.requirement_id}: ${(r.drift_score * 100).toFixed(1)}% drift — ${r.drift_details.slice(0, 2).join('; ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  computeDriftReport,
  computeRequirementDrift,
  classifyDrift,
  formatDriftMarkdown,
  formatDriftAnnotations,
  parseRequirements,
  findPlans,
  findVerifications,
};
