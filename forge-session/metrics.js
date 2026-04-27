'use strict';
const fs = require('fs');
const path = require('path');

function metricsPath(cwd) { return path.join(cwd, '.forge', 'session', 'metrics.json'); }

function ensureDir(cwd) {
  const dir = path.join(cwd, '.forge', 'session');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMetrics(cwd) {
  const p = metricsPath(cwd);
  if (!fs.existsSync(p)) return { version: 1, started_at: new Date().toISOString(), budget_ceiling_usd: null, units: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { version: 1, started_at: new Date().toISOString(), budget_ceiling_usd: null, units: [] }; }
}

function saveMetrics(cwd, data) {
  ensureDir(cwd);
  fs.writeFileSync(metricsPath(cwd), JSON.stringify(data, null, 2));
}

function initMetrics(cwd) {
  const existing = loadMetrics(cwd);
  if (!existing.started_at) existing.started_at = new Date().toISOString();
  saveMetrics(cwd, existing);
  return existing;
}

function snapshotUnitMetrics(cwd, unitData) {
  const metrics = loadMetrics(cwd);
  const unit = {
    type: unitData.type || 'unknown',
    id: unitData.id || 'unknown',
    model: unitData.model || 'unknown',
    started_at: unitData.started_at || Date.now(),
    finished_at: unitData.finished_at || Date.now(),
    tokens: unitData.tokens || { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
    cost_usd: unitData.cost_usd || 0,
    phase: unitData.phase || 'execution',
    tool_calls: unitData.tool_calls || 0,
  };
  metrics.units.push(unit);
  saveMetrics(cwd, metrics);
  return unit;
}

function getProjectTotals(cwd) {
  const metrics = loadMetrics(cwd);
  const totals = { total_cost: 0, total_tokens: 0, unit_count: metrics.units.length, by_phase: {}, by_model: {} };

  for (const u of metrics.units) {
    totals.total_cost += u.cost_usd || 0;
    totals.total_tokens += u.tokens?.total || 0;

    const phase = u.phase || 'unknown';
    if (!totals.by_phase[phase]) totals.by_phase[phase] = { cost: 0, tokens: 0, count: 0 };
    totals.by_phase[phase].cost += u.cost_usd || 0;
    totals.by_phase[phase].tokens += u.tokens?.total || 0;
    totals.by_phase[phase].count++;

    const model = u.model || 'unknown';
    if (!totals.by_model[model]) totals.by_model[model] = { cost: 0, tokens: 0, count: 0 };
    totals.by_model[model].cost += u.cost_usd || 0;
    totals.by_model[model].tokens += u.tokens?.total || 0;
    totals.by_model[model].count++;
  }

  return totals;
}

function checkBudget(cwd) {
  const metrics = loadMetrics(cwd);
  const totals = getProjectTotals(cwd);
  const ceiling = metrics.budget_ceiling_usd;
  if (!ceiling || ceiling <= 0) return { has_ceiling: false, within_budget: true };
  const remaining = ceiling - totals.total_cost;
  const projected = metrics.units.length > 0 ? (totals.total_cost / metrics.units.length) * (metrics.units.length + 5) : 0;
  return {
    has_ceiling: true,
    ceiling_usd: ceiling,
    spent_usd: totals.total_cost,
    remaining_usd: remaining,
    within_budget: remaining > 0,
    projected_total_usd: projected,
  };
}

module.exports = { initMetrics, snapshotUnitMetrics, getProjectTotals, checkBudget, loadMetrics };
