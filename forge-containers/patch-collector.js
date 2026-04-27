#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================
// Patch Collection from Container Output
// ============================================================

/**
 * Collect git patches from a container's output directory.
 *
 * Containers write their changes as:
 *   /output/patches/        — One .patch file per logical change
 *   /output/result.json     — Agent result (status, learnings, warnings)
 *   /output/stdout.log      — Container stdout
 *   /output/stderr.log      — Container stderr
 *
 * @param {string} outputDir - Host path to the container's output directory.
 * @returns {CollectionResult}
 */
function collectPatches(outputDir) {
  const patchDir = path.join(outputDir, 'patches');
  const resultPath = path.join(outputDir, 'result.json');
  const stdoutPath = path.join(outputDir, 'stdout.log');
  const stderrPath = path.join(outputDir, 'stderr.log');

  const result = {
    patches: [],
    agentResult: null,
    stdout: '',
    stderr: '',
    errors: [],
  };

  // Collect patches
  if (fs.existsSync(patchDir)) {
    const files = fs.readdirSync(patchDir)
      .filter(f => f.endsWith('.patch'))
      .sort();
    for (const file of files) {
      const patchPath = path.join(patchDir, file);
      try {
        const content = fs.readFileSync(patchPath, 'utf8');
        if (content.trim().length > 0) {
          result.patches.push({ name: file, path: patchPath, content });
        }
      } catch (err) {
        result.errors.push(`Failed to read patch ${file}: ${err.message}`);
      }
    }
  }

  // Collect agent result
  if (fs.existsSync(resultPath)) {
    try {
      result.agentResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch (err) {
      result.errors.push(`Failed to parse result.json: ${err.message}`);
    }
  }

  // Collect logs
  try { result.stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : ''; } catch { /* ignore */ }
  try { result.stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : ''; } catch { /* ignore */ }

  return result;
}

/**
 * Apply collected patches to the main repo working tree.
 *
 * @param {string} repoRoot - Main repository root.
 * @param {object[]} patches - Array of { name, content } from collectPatches().
 * @param {{ dryRun?: boolean, check?: boolean }} opts
 * @returns {{ applied: string[], failed: string[], skipped: string[] }}
 */
function applyPatches(repoRoot, patches, opts = {}) {
  const applied = [];
  const failed = [];
  const skipped = [];

  for (const patch of patches) {
    // First check if patch applies cleanly
    try {
      execSync(`git apply --check --directory=. -`, {
        cwd: repoRoot,
        input: patch.content,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch {
      // Patch won't apply cleanly — try with 3-way merge
      try {
        execSync(`git apply --check --3way --directory=. -`, {
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

    // Apply the patch
    try {
      execSync(`git apply --3way --directory=. -`, {
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
 * Extract learnings (warnings, discoveries) from an agent result for ledger integration.
 *
 * @param {object} agentResult - Parsed result.json from container.
 * @returns {{ warnings: object[], discoveries: object[] }}
 */
function extractLearnings(agentResult) {
  const warnings = [];
  const discoveries = [];

  if (!agentResult) return { warnings, discoveries };

  // Agent-reported warnings
  if (Array.isArray(agentResult.warnings)) {
    for (const w of agentResult.warnings) {
      warnings.push({
        warning: typeof w === 'string' ? w : w.message || w.warning || JSON.stringify(w),
        source: `container:${agentResult.task_id || 'unknown'}`,
        severity: w.severity || 'medium',
      });
    }
  }

  // Agent-reported discoveries
  if (Array.isArray(agentResult.discoveries)) {
    for (const d of agentResult.discoveries) {
      discoveries.push({
        discovery: typeof d === 'string' ? d : d.message || d.discovery || JSON.stringify(d),
        source: `container:${agentResult.task_id || 'unknown'}`,
      });
    }
  }

  // Extract from agent notes/learnings field (alternative format)
  if (agentResult.learnings) {
    const l = agentResult.learnings;
    if (Array.isArray(l.warnings)) {
      for (const w of l.warnings) {
        warnings.push({
          warning: typeof w === 'string' ? w : w.message || JSON.stringify(w),
          source: `container:${agentResult.task_id || 'unknown'}`,
          severity: 'medium',
        });
      }
    }
    if (Array.isArray(l.discoveries)) {
      for (const d of l.discoveries) {
        discoveries.push({
          discovery: typeof d === 'string' ? d : d.message || JSON.stringify(d),
          source: `container:${agentResult.task_id || 'unknown'}`,
        });
      }
    }
  }

  return { warnings, discoveries };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  collectPatches,
  applyPatches,
  extractLearnings,
};
