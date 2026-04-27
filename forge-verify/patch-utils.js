#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Apply git patches to a repository working tree.
 * Extracted from forge-containers/patch-collector.js for use by the verification loop.
 *
 * @param {string} repoRoot - Repository root directory.
 * @param {object[]} patches - Array of { name, content } patch objects.
 * @param {{ dryRun?: boolean, check?: boolean }} opts
 * @returns {{ applied: string[], failed: string[], skipped: string[] }}
 */
function applyPatches(repoRoot, patches, opts = {}) {
  const applied = [];
  const failed = [];
  const skipped = [];

  for (const patch of patches) {
    try {
      execSync('git apply --check --directory=. -', {
        cwd: repoRoot,
        input: patch.content,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch {
      try {
        execSync('git apply --check --3way --directory=. -', {
          cwd: repoRoot,
          input: patch.content,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
        });
      } catch {
        failed.push(patch.name);
        continue;
      }
    }

    if (opts.dryRun || opts.check) {
      skipped.push(patch.name);
      continue;
    }

    try {
      execSync('git apply --3way --directory=. -', {
        cwd: repoRoot,
        input: patch.content,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      applied.push(patch.name);
    } catch {
      failed.push(patch.name);
    }
  }

  return { applied, failed, skipped };
}

/**
 * Extract learnings (warnings, discoveries) from agent output for ledger integration.
 *
 * @param {object} agentResult - Parsed agent result object.
 * @returns {{ warnings: object[], discoveries: object[] }}
 */
function extractLearnings(agentResult) {
  const warnings = [];
  const discoveries = [];

  if (!agentResult) return { warnings, discoveries };

  if (Array.isArray(agentResult.warnings)) {
    for (const w of agentResult.warnings) {
      warnings.push({
        warning: typeof w === 'string' ? w : w.message || w.warning || JSON.stringify(w),
        source: `agent:${agentResult.task_id || 'unknown'}`,
        severity: w.severity || 'medium',
      });
    }
  }

  if (Array.isArray(agentResult.discoveries)) {
    for (const d of agentResult.discoveries) {
      discoveries.push({
        discovery: typeof d === 'string' ? d : d.message || d.discovery || JSON.stringify(d),
        source: `agent:${agentResult.task_id || 'unknown'}`,
      });
    }
  }

  if (agentResult.learnings) {
    const l = agentResult.learnings;
    if (Array.isArray(l.warnings)) {
      for (const w of l.warnings) {
        warnings.push({
          warning: typeof w === 'string' ? w : w.message || JSON.stringify(w),
          source: `agent:${agentResult.task_id || 'unknown'}`,
          severity: 'medium',
        });
      }
    }
    if (Array.isArray(l.discoveries)) {
      for (const d of l.discoveries) {
        discoveries.push({
          discovery: typeof d === 'string' ? d : d.message || JSON.stringify(d),
          source: `agent:${agentResult.task_id || 'unknown'}`,
        });
      }
    }
  }

  return { warnings, discoveries };
}

module.exports = { applyPatches, extractLearnings };
