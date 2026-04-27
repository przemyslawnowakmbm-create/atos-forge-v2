'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveProvider, buildInvocation } = require('../forge-agents/provider');

function buildPrompt(cwd, unit) {
  const parts = [];
  parts.push(`You are executing a Forge auto-mode unit.\nPhase: ${unit.phase}\n`);

  // Pre-inline key context files
  const tryRead = (p) => { try { return fs.readFileSync(path.resolve(cwd, p), 'utf8'); } catch { return null; } };

  const state = tryRead('.planning/STATE.md');
  if (state) parts.push(`## Current State\n${state.slice(0, 2000)}\n`);

  if (unit.phase === 'execute' && unit.taskId) {
    parts.push(`Execute task ${unit.taskId} for phase ${unit.phaseNum}.`);
    parts.push('Read the task plan file and implement it completely. Commit when done.');
    // Try to inline task plan
    const planDir = `.planning/phases/${String(unit.phaseNum).padStart(2, '0')}`;
    try {
      const planFiles = fs.readdirSync(path.resolve(cwd, planDir)).filter(f => f.includes('PLAN') && f.endsWith('.md'));
      for (const pf of planFiles) {
        const content = tryRead(path.join(planDir, pf));
        if (content) parts.push(`## Plan: ${pf}\n${content.slice(0, 4000)}\n`);
      }
    } catch {}
  } else if (unit.phase === 'plan') {
    parts.push(`Plan phase ${unit.phaseNum}. Create detailed task plans in .planning/phases/.`);
    parts.push('Read ROADMAP.md for phase description. Break into concrete, actionable tasks.');
  } else if (unit.phase === 'verify') {
    parts.push(`Verify phase ${unit.phaseNum}. Run verification pipeline and report results.`);
    parts.push('Use: node forge-verify/engine.js --root . to run verification.');
  } else if (unit.phase === 'complete') {
    parts.push(`Complete phase ${unit.phaseNum}. Write SUMMARY.md, update ROADMAP.md, commit.`);
  } else if (unit.phase === 'research') {
    parts.push(`Research for phase ${unit.phaseNum}. Investigate implementation approaches.`);
  }

  return parts.join('\n\n');
}

function dispatch(cwd, unit, opts = {}) {
  const prompt = buildPrompt(cwd, unit);
  const timeout = (opts.hardTimeout || 600) * 1000;
  const provider = resolveProvider(cwd, opts);
  const outputDir = path.join(cwd, '.forge', 'session');
  const lastMessagePath = path.join(outputDir, '_auto_last_message.txt');
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

  try {
    const invocation = buildInvocation(provider.name, prompt, {
      outputFile: provider.name === 'codex' ? lastMessagePath : null,
    });
    const result = spawnSync(provider.path, invocation.args, {
      cwd,
      input: invocation.stdin || undefined,
      encoding: 'utf8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: invocation.env,
    });
    const output = provider.name === 'codex' && fs.existsSync(lastMessagePath)
      ? fs.readFileSync(lastMessagePath, 'utf8')
      : (result.stdout || '');
    try { fs.unlinkSync(lastMessagePath); } catch {}
    return { success: result.status === 0, output, error: result.stderr || '' };
  } catch (e) {
    try { fs.unlinkSync(lastMessagePath); } catch {}
    return { success: false, error: e.message || 'unknown error', output: e.stdout || '' };
  }
}

module.exports = { dispatch, buildPrompt };
