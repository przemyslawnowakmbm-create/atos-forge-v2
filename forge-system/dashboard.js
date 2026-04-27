#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// System Dashboard Generator
// ============================================================
// Generates a self-contained HTML dashboard for the system graph.
// Same pattern as forge-graph/dashboard-generator.js.
// Tabs: Service Map, Dependency Matrix, Interface Registry,
//       Risk Register, Team View.

// ============================================================
// Data Collection
// ============================================================

function collectSystemData(dbPath) {
  const { SystemQuery } = require('./query');
  const sq = new SystemQuery(dbPath);
  sq.open();
  try {
    const overview = sq.overview();

    // All services with details
    const services = sq.db.prepare(`
      SELECT s.*, m.fan_in, m.fan_out, m.interface_count, m.coupling_score, m.risk_level
      FROM services s
      LEFT JOIN service_metrics m ON m.service_id = s.id
      ORDER BY s.id
    `).all();

    // All interfaces
    const interfaces = sq.db.prepare(`
      SELECT i.*, s.team FROM interfaces i
      LEFT JOIN services s ON s.id = i.service_id
      ORDER BY i.service_id, i.type, i.name
    `).all().map(i => ({ ...i, metadata: i.metadata ? JSON.parse(i.metadata) : null }));

    // All dependencies
    const dependencies = sq.db.prepare(`
      SELECT d.*, i.name as interface_name, i.type as interface_type
      FROM dependencies d
      LEFT JOIN interfaces i ON i.id = d.interface_id
      ORDER BY d.consumer_id, d.provider_id
    `).all();

    // Teams
    const teams = sq.db.prepare('SELECT * FROM teams ORDER BY id').all();

    // Cycles
    let cycles = [];
    try { cycles = sq.cycles(); } catch { /* no cycles method or error */ }

    // Sync log (recent)
    const syncLog = sq.db.prepare(`
      SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20
    `).all();

    // Per-service modules from per-repo graph.db
    const serviceModules = {};
    const Database = (() => { try { return require('better-sqlite3'); } catch { return null; } })();
    if (Database) {
      for (const svc of services) {
        if (!svc.repo_path) continue;
        const graphDbPath = require('path').join(svc.repo_path, '.forge', 'graph.db');
        try {
          if (!require('fs').existsSync(graphDbPath)) { continue; }
          const gdb = new Database(graphDbPath, { readonly: true });
          try {
            const modules = gdb.prepare(`
              SELECT name, root_path, file_count, public_api_count, stability
              FROM modules ORDER BY name
            `).all().map(m => {
              const caps = gdb.prepare(
                'SELECT capability, confidence FROM module_capabilities WHERE module_name = ? ORDER BY confidence DESC'
              ).all(m.name);
              const files = gdb.prepare(
                'SELECT path, language, loc, complexity_score FROM files WHERE module = ? ORDER BY loc DESC LIMIT 10'
              ).all(m.name);
              return { ...m, capabilities: caps, files };
            });
            // Compute module edges from file-level deps (more complete than module_dependencies table)
            const modDeps = gdb.prepare(`
              SELECT sf.module as source_module, tf.module as target_module, COUNT(*) as edge_count
              FROM dependencies d
              JOIN files sf ON sf.path = d.source_file
              JOIN files tf ON tf.path = d.target_file
              WHERE sf.module != tf.module
              GROUP BY sf.module, tf.module
              ORDER BY edge_count DESC
            `).all();
            serviceModules[svc.id] = { modules, modDeps };
          } finally {
            gdb.close();
          }
        } catch { /* skip repos without valid graph.db */ }
      }
    }

    return {
      overview,
      services,
      interfaces,
      dependencies,
      teams,
      cycles: Array.isArray(cycles) ? cycles : (cycles.cycles || []),
      syncLog,
      serviceModules,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    sq.close();
  }
}

// ============================================================
// CSS
// ============================================================

function generateCSS() {
  return `
    :root {
      --forge-primary: #003366;
      --forge-secondary: #2990EA;
      --forge-accent: #008dbb;
      --forge-navy: #001f3d;
      --forge-sky: #e8f2fc;
      --bg: #f5f7fa;
      --bg-card: #ffffff;
      --bg-hover: #eef3f9;
      --border: #dce3eb;
      --text: #1a2e4a;
      --text-dim: #6b7c93;
      --green: #2e8b57;
      --yellow: #c49000;
      --red: #d32f2f;
      --orange: #e65100;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Header */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 24px;
      background: linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-navy) 100%);
      flex-shrink: 0; z-index: 10; position: relative;
    }
    .header::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
      background: linear-gradient(90deg, var(--forge-secondary), var(--forge-accent));
    }
    .header h1 { font-size: 16px; font-weight: 700; color: #fff; letter-spacing: 1px; text-transform: uppercase; }
    .header .stats { display: flex; gap: 20px; }
    .header .stat { font-size: 12px; color: rgba(255,255,255,0.6); }
    .header .stat strong { color: #fff; font-size: 14px; margin-right: 3px; }
    .header .meta { font-size: 11px; color: rgba(255,255,255,0.4); }

    /* Tabs */
    .tabs {
      display: flex; gap: 0; background: var(--bg-card);
      border-bottom: 1px solid var(--border); padding: 0 24px; flex-shrink: 0;
    }
    .tab {
      padding: 10px 20px; cursor: pointer; font-size: 13px; font-weight: 500;
      color: var(--text-dim); border-bottom: 2px solid transparent; transition: all 0.15s;
    }
    .tab:hover { color: var(--text); background: var(--bg-hover); }
    .tab.active { color: var(--forge-secondary); border-bottom-color: var(--forge-secondary); }

    /* Content */
    .content { flex: 1; overflow: hidden; position: relative; }
    .panel { display: none; width: 100%; height: 100%; overflow: auto; padding: 20px; }
    .panel.active { display: block; }
    #panel-map.active { display: flex; padding: 0; }

    /* Service Map SVG */
    #service-map-svg { width: 100%; height: 100%; }
    .node-circle { cursor: pointer; transition: opacity 0.15s; }
    .node-circle:hover { opacity: 0.8; }
    .node-label { font-size: 11px; fill: var(--text); pointer-events: none; font-weight: 500; }
    .link-line { stroke: var(--border); stroke-opacity: 0.6; }
    .link-line.deprecated { stroke: var(--red); stroke-dasharray: 5,3; }
    .arrow-head { fill: var(--text-dim); }

    /* Map legend sidebar */
    .map-legend {
      width: 220px; flex-shrink: 0; padding: 16px 14px;
      background: var(--bg-card); border-right: 1px solid var(--border);
      overflow-y: auto; font-size: 12px;
    }
    .map-legend h4 {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-dim); margin: 0 0 8px 0; font-weight: 600;
    }
    .map-legend .legend-item {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 0; color: var(--text);
    }
    .map-legend .legend-dot {
      width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    }
    .map-legend .legend-divider {
      height: 1px; background: var(--border); margin: 12px 0;
    }
    .map-legend .legend-hint {
      font-size: 10px; color: var(--text-dim); margin-top: 4px; line-height: 1.4;
    }
    .svc-tree { margin: 0; padding: 0; list-style: none; }
    .svc-tree-item {
      cursor: pointer; user-select: none;
      padding: 4px 6px; border-radius: 4px; display: flex; align-items: center; gap: 5px;
      font-size: 12px; font-weight: 500; transition: background 0.12s;
    }
    .svc-tree-item:hover { background: rgba(41,144,234,0.08); }
    .svc-tree-item.active { background: rgba(41,144,234,0.12); color: var(--forge-secondary); }
    .svc-tree-chevron {
      font-size: 8px; width: 10px; text-align: center; flex-shrink: 0;
      color: var(--text-dim); transition: transform 0.2s; display: inline-block;
    }
    .svc-tree-item.open .svc-tree-chevron { transform: rotate(90deg); }
    .svc-tree-icon { font-size: 11px; flex-shrink: 0; }
    .svc-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .svc-tree-count {
      font-size: 9px; background: var(--border); color: var(--text-dim);
      padding: 0 4px; border-radius: 8px; flex-shrink: 0;
    }
    .mod-tree { margin: 0; padding: 0 0 0 16px; list-style: none; max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
    .mod-tree.open { max-height: 800px; overflow-y: auto; }
    .mod-tree-item {
      padding: 2px 6px; border-radius: 3px; display: flex; align-items: center; gap: 5px;
      font-size: 11px; cursor: pointer; transition: background 0.12s; color: var(--text);
    }
    .mod-tree-item:hover { background: rgba(41,144,234,0.06); }
    .mod-stability { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .mod-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mod-tree-meta { font-size: 9px; color: var(--text-dim); flex-shrink: 0; }
    .mod-caps { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px 6px 4px 27px; }
    .mod-cap-tag {
      font-size: 8px; padding: 0 4px; border-radius: 3px; background: var(--forge-sky);
      color: var(--forge-primary); font-weight: 500; letter-spacing: 0.3px;
    }
    /* Drill-down back button */
    .drill-back {
      position: absolute; top: 12px; left: 12px; z-index: 6;
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 6px;
      background: var(--bg-card); border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      cursor: pointer; font-size: 12px; font-weight: 600; font-family: inherit;
      color: var(--forge-primary); transition: all 0.15s;
    }
    .drill-back:hover { background: var(--forge-sky); border-color: var(--forge-secondary); }
    .drill-back .arrow { font-size: 14px; }
    .drill-title {
      position: absolute; top: 48px; left: 12px; z-index: 6;
      font-size: 12px; font-weight: 600; color: var(--text-dim);
      pointer-events: none;
    }
    /* Module nodes in drill-down */
    .mod-node-circle { cursor: pointer; transition: opacity 0.15s; }
    .mod-node-circle:hover { opacity: 0.8; }
    .mod-node-label { font-size: 10px; fill: var(--text); pointer-events: none; font-weight: 500; text-anchor: middle; }
    .mod-link { stroke: var(--border); stroke-opacity: 0.5; }
    .mod-link-cross { stroke: var(--forge-secondary); stroke-opacity: 0.6; stroke-dasharray: 4,2; }

    .svc-search {
      width: 100%; padding: 5px 8px 5px 26px; border: 1px solid var(--border); border-radius: 5px;
      font-size: 11px; font-family: inherit; outline: none; background: var(--bg);
      color: var(--text); margin-bottom: 8px; box-sizing: border-box;
    }
    .svc-search:focus { border-color: var(--forge-secondary); box-shadow: 0 0 0 2px rgba(41,144,234,0.1); }
    .svc-search-wrap {
      position: relative;
    }
    .svc-search-icon {
      position: absolute; left: 8px; top: 7px; font-size: 11px; color: var(--text-dim);
      pointer-events: none;
    }
    .svc-tree li.hidden { display: none; }
    .svc-tree-item.search-match { background: rgba(41,144,234,0.12); }

    /* Detail panel */
    .detail-panel {
      position: absolute; top: 0; right: 0; width: 380px; height: 100%;
      background: var(--bg-card); border-left: 1px solid var(--border);
      box-shadow: -4px 0 20px rgba(0,0,0,0.08); overflow-y: auto;
      transform: translateX(100%); transition: transform 0.2s ease;
      z-index: 5; padding: 20px;
    }
    .detail-panel.open { transform: translateX(0); }
    .detail-close {
      position: absolute; top: 12px; right: 12px; cursor: pointer;
      width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--border);
      background: var(--bg); display: flex; align-items: center; justify-content: center;
      font-size: 14px; color: var(--text-dim);
    }
    .detail-close:hover { background: var(--bg-hover); }
    .detail-panel h2 { font-size: 16px; margin-bottom: 4px; color: var(--forge-primary); }
    .detail-panel .sub { font-size: 12px; color: var(--text-dim); margin-bottom: 16px; }
    .detail-section { margin-bottom: 16px; }
    .detail-section h3 { font-size: 12px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px; letter-spacing: 0.5px; }
    .detail-item {
      font-size: 13px; padding: 4px 8px; border-radius: 4px;
      margin-bottom: 2px; display: flex; align-items: center; gap: 8px;
    }
    .detail-item:hover { background: var(--bg-hover); }
    .badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px;
      font-weight: 600; text-transform: uppercase;
    }
    .badge-api { background: #e3f2fd; color: #1565c0; }
    .badge-event { background: #fce4ec; color: #c62828; }
    .badge-database { background: #e8f5e9; color: #2e7d32; }
    .badge-rpc { background: #fff3e0; color: #e65100; }
    .badge-package { background: #f3e5f5; color: #7b1fa2; }

    /* Matrix */
    .matrix-container { overflow: auto; }
    .matrix-table { border-collapse: collapse; font-size: 11px; }
    .matrix-table th, .matrix-table td {
      border: 1px solid var(--border); padding: 4px; text-align: center; min-width: 30px;
    }
    .matrix-table th { background: var(--forge-sky); font-weight: 600; position: sticky; }
    .matrix-table th.row-header { text-align: right; padding-right: 8px; }
    .matrix-cell-dep { background: var(--forge-secondary); color: #fff; font-weight: 600; cursor: pointer; }
    .matrix-cell-dep:hover { background: var(--forge-primary); }
    .matrix-cell-self { background: #f0f0f0; }

    /* Registry table */
    .search-input {
      padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px;
      font-size: 13px; width: 300px; margin-bottom: 16px; outline: none;
      font-family: inherit;
    }
    .search-input:focus { border-color: var(--forge-secondary); box-shadow: 0 0 0 2px rgba(41,144,234,0.1); }
    .registry-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .registry-table th {
      text-align: left; padding: 8px 12px; background: var(--forge-sky);
      font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--text-dim);
      letter-spacing: 0.5px; position: sticky; top: 0; border-bottom: 2px solid var(--forge-secondary);
    }
    .registry-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .registry-table tr:hover td { background: var(--bg-hover); }

    /* Risk register */
    .risk-card {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
      padding: 16px; margin-bottom: 12px; cursor: pointer; transition: box-shadow 0.15s;
    }
    .risk-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .risk-card .risk-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .risk-card .risk-name { font-weight: 600; font-size: 14px; }
    .risk-badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .risk-low { background: #e8f5e9; color: #2e7d32; }
    .risk-medium { background: #fff3e0; color: #e65100; }
    .risk-high { background: #fce4ec; color: #c62828; }
    .risk-critical { background: #f44336; color: #fff; }
    .risk-metrics { display: flex; gap: 16px; font-size: 12px; color: var(--text-dim); }

    /* Team view */
    .team-group { margin-bottom: 24px; }
    .team-group h3 {
      font-size: 14px; font-weight: 600; margin-bottom: 8px; padding: 8px 12px;
      background: var(--forge-sky); border-radius: 6px; color: var(--forge-primary);
    }
    .team-services { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .team-service-card {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; cursor: pointer; transition: all 0.15s;
    }
    .team-service-card:hover { border-color: var(--forge-secondary); box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .team-service-card .svc-name { font-weight: 600; margin-bottom: 4px; }
    .team-service-card .svc-meta { font-size: 12px; color: var(--text-dim); }

    /* Expandable detail items */
    .detail-item-expand {
      cursor: pointer; user-select: none;
      font-size: 13px; padding: 6px 8px; border-radius: 4px;
      margin-bottom: 2px; display: flex; align-items: center; gap: 8px;
      transition: background 0.12s;
    }
    .detail-item-expand:hover { background: rgba(41,144,234,0.08); }
    .detail-item-expand .chevron {
      font-size: 10px; transition: transform 0.2s; display: inline-block;
      color: var(--text-dim); width: 12px; flex-shrink: 0;
    }
    .detail-item-expand.open .chevron { transform: rotate(90deg); }
    .expand-content {
      max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
      margin-left: 20px; margin-bottom: 4px;
    }
    .expand-content.open { max-height: 600px; overflow-y: auto; }
    .endpoint-table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 4px; }
    .endpoint-table td, .endpoint-table th {
      padding: 3px 8px; border-bottom: 1px solid var(--border); text-align: left;
    }
    .endpoint-table th { font-size: 10px; text-transform: uppercase; color: var(--text-dim); font-weight: 600; }
    .method-badge {
      font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px;
      font-family: monospace; display: inline-block;
    }
    .method-GET { background: #e8f5e9; color: #2e7d32; }
    .method-POST { background: #e3f2fd; color: #1565c0; }
    .method-PUT { background: #fff3e0; color: #e65100; }
    .method-PATCH { background: #fff8e1; color: #f57f17; }
    .method-DELETE { background: #fce4ec; color: #c62828; }
    .meta-list { list-style: none; padding: 0; margin: 4px 0; }
    .meta-list li {
      font-size: 12px; padding: 2px 0; color: var(--text);
      border-bottom: 1px solid rgba(0,0,0,0.04);
    }
    .meta-list li::before { content: '\\2022'; color: var(--text-dim); margin-right: 6px; }
    .consumer-link {
      cursor: pointer; color: var(--forge-secondary); text-decoration: none;
    }
    .consumer-link:hover { text-decoration: underline; }

    /* Node pulse animation for highlight */
    @keyframes node-pulse {
      0% { stroke-width: 2; stroke-opacity: 1; }
      50% { stroke-width: 8; stroke-opacity: 0.4; }
      100% { stroke-width: 2; stroke-opacity: 1; }
    }
    .node-highlight circle { animation: node-pulse 1s ease-in-out 3; }

    /* Expanded cluster */
    .cluster-boundary { fill: none; stroke: var(--border); stroke-dasharray: 6,3; stroke-width: 1.5; }
    .iface-node { cursor: pointer; transition: opacity 0.15s; }
    .iface-node:hover { opacity: 0.8; }
    .iface-label { font-size: 9px; fill: var(--text-dim); pointer-events: none; text-anchor: middle; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
  `;
}

// ============================================================
// HTML Structure
// ============================================================

function esc(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function generateHTML(data) {
  const o = data.overview;
  return `
  <div class="header">
    <h1>Forge System Graph</h1>
    <div class="stats">
      <span class="stat"><strong>${esc(String(o.services))}</strong>services</span>
      <span class="stat"><strong>${esc(String(o.interfaces))}</strong>interfaces</span>
      <span class="stat"><strong>${esc(String(o.dependencies))}</strong>dependencies</span>
      <span class="stat"><strong>${esc(String(o.teams))}</strong>teams</span>
    </div>
    <div class="meta">Generated ${esc(data.generatedAt.split('T')[0])}</div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="map">Service Map</div>
    <div class="tab" data-tab="matrix">Dependency Matrix</div>
    <div class="tab" data-tab="registry">Interface Registry</div>
    <div class="tab" data-tab="risk">Risk Register</div>
    <div class="tab" data-tab="teams">Team View</div>
  </div>

  <div class="content">
    <div class="panel active" id="panel-map">
      <div id="map-legend" class="map-legend"></div>
      <div style="flex:1;position:relative;overflow:hidden">
        <svg id="service-map-svg"></svg>
      </div>
    </div>
    <div class="panel" id="panel-matrix">
      <div class="matrix-container" id="matrix-container"></div>
    </div>
    <div class="panel" id="panel-registry">
      <input class="search-input" id="registry-search" placeholder="Search interfaces..." />
      <div id="registry-table-container"></div>
    </div>
    <div class="panel" id="panel-risk">
      <div id="risk-container"></div>
    </div>
    <div class="panel" id="panel-teams">
      <div id="teams-container"></div>
    </div>

    <div class="detail-panel" id="detail-panel">
      <div class="detail-close" id="detail-close">&times;</div>
      <div id="detail-content"></div>
    </div>
  </div>
  `;
}

// ============================================================
// JavaScript (client-side)
// ============================================================

function generateJS() {
  return `
(function() {
  const D = window.__SYSTEM_DATA__;
  const services = D.services;
  const deps = D.dependencies;
  const interfaces = D.interfaces;
  const serviceModules = D.serviceModules || {};

  // ── Tab switching ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      closeDetail();
      if (tab.dataset.tab === 'map' && !window.__mapRendered) renderServiceMap();
      if (tab.dataset.tab === 'matrix' && !window.__matrixRendered) renderMatrix();
      if (tab.dataset.tab === 'registry' && !window.__registryRendered) renderRegistry();
      if (tab.dataset.tab === 'risk' && !window.__riskRendered) renderRisk();
      if (tab.dataset.tab === 'teams' && !window.__teamsRendered) renderTeams();
    });
  });

  // ── Detail panel ──
  const detailPanel = document.getElementById('detail-panel');
  const detailContent = document.getElementById('detail-content');
  document.getElementById('detail-close').addEventListener('click', closeDetail);

  function closeDetail() { detailPanel.classList.remove('open'); }

  // ── Interface detail renderer ──
  function renderInterfaceDetail(iface) {
    const meta = iface.metadata;
    if (!meta) return '<div style="font-size:12px;color:var(--text-dim);padding:4px 0">No detail data</div>';

    let html = '';
    const type = iface.type;

    if (type === 'api' && meta.endpoints && meta.endpoints.length > 0) {
      html += '<table class="endpoint-table"><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>';
      for (const ep of meta.endpoints) {
        const method = (ep.method || 'GET').toUpperCase();
        html += '<tr><td><span class="method-badge method-' + method + '">' + method + '</span></td>';
        html += '<td style="font-family:monospace;font-size:11px">' + esc(ep.path || '') + '</td>';
        html += '<td style="color:var(--text-dim)">' + esc(ep.description || '') + '</td></tr>';
      }
      html += '</tbody></table>';
      if (meta.base_path && meta.base_path !== '/') {
        html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px">Base: <code>' + esc(meta.base_path) + '</code></div>';
      }
    } else if (type === 'database' && meta.tables && meta.tables.length > 0) {
      html += '<ul class="meta-list">';
      for (const t of meta.tables) html += '<li><code style="font-size:12px">' + esc(t) + '</code></li>';
      html += '</ul>';
    } else if (type === 'event') {
      if (meta.topic) html += '<div style="font-size:12px;padding:2px 0">Topic: <code>' + esc(meta.topic) + '</code></div>';
      if (meta.channels && meta.channels.length > 0) {
        html += '<ul class="meta-list">';
        for (const ch of meta.channels) html += '<li>' + esc(ch) + '</li>';
        html += '</ul>';
      }
      if (meta.message_type) html += '<div style="font-size:12px;color:var(--text-dim)">Message: ' + esc(meta.message_type) + '</div>';
    } else if (type === 'rpc') {
      if (meta.service_name) html += '<div style="font-size:12px;padding:2px 0">Service: <code>' + esc(meta.service_name) + '</code></div>';
      if (meta.methods && meta.methods.length > 0) {
        html += '<ul class="meta-list">';
        for (const m of meta.methods) html += '<li><code style="font-size:12px">' + esc(m) + '</code></li>';
        html += '</ul>';
      }
    } else if (type === 'package') {
      if (meta.entry) html += '<div style="font-size:12px;padding:2px 0">Entry: <code>' + esc(meta.entry) + '</code></div>';
      if (meta.exports && meta.exports.length > 0) {
        html += '<ul class="meta-list">';
        for (const ex of meta.exports.slice(0, 20)) html += '<li><code style="font-size:12px">' + esc(ex) + '</code></li>';
        if (meta.exports.length > 20) html += '<li style="color:var(--text-dim)">... +' + (meta.exports.length - 20) + ' more</li>';
        html += '</ul>';
      }
    } else {
      html += '<div style="font-size:12px;color:var(--text-dim);padding:4px 0">No detail data</div>';
    }
    return html;
  }

  function countDetail(iface) {
    const m = iface.metadata;
    if (!m) return '';
    if (m.endpoints) return ' (' + m.endpoints.length + ' endpoints)';
    if (m.tables) return ' (' + m.tables.length + ' tables)';
    if (m.methods) return ' (' + m.methods.length + ' methods)';
    if (m.channels) return ' (' + m.channels.length + ' channels)';
    return '';
  }

  // ── Highlight node on map ──
  function highlightNode(svcId) {
    const mapSvg = d3.select('#service-map-svg');
    mapSvg.selectAll('.node-highlight').classed('node-highlight', false);
    mapSvg.selectAll('g').filter(function() {
      const circles = d3.select(this).selectAll('circle');
      if (circles.empty()) return false;
      const d = circles.datum();
      return d && d.id === svcId;
    }).classed('node-highlight', true);

    // Switch to map tab
    document.querySelectorAll('.tab').forEach(t => {
      if (t.dataset.tab === 'map') t.click();
    });
  }

  function showServiceDetail(svcId) {
    const svc = services.find(s => s.id === svcId);
    if (!svc) return;
    const exports_ = interfaces.filter(i => i.service_id === svcId);
    const imports_ = deps.filter(d => d.consumer_id === svcId);
    const consumers = deps.filter(d => d.provider_id === svcId);

    let html = '<h2>' + esc(svc.id) + '</h2>';
    html += '<div class="sub">' + esc(svc.description || svc.team || 'No description') + '</div>';

    html += '<div class="detail-section"><h3>Metrics</h3>';
    html += '<div class="risk-metrics">';
    html += '<span>Fan-in: <strong>' + (svc.fan_in || 0) + '</strong></span>';
    html += '<span>Fan-out: <strong>' + (svc.fan_out || 0) + '</strong></span>';
    html += '<span>Interfaces: <strong>' + (svc.interface_count || 0) + '</strong></span>';
    html += '<span>Risk: <strong>' + esc(svc.risk_level || 'low') + '</strong></span>';
    html += '</div></div>';

    if (exports_.length > 0) {
      html += '<div class="detail-section"><h3>Exports (' + exports_.length + ')</h3>';
      for (let idx = 0; idx < exports_.length; idx++) {
        const e = exports_[idx];
        const detailHtml = renderInterfaceDetail(e);
        const count = countDetail(e);
        html += '<div class="detail-item-expand" data-expand="exp-' + idx + '">';
        html += '<span class="chevron">&#9656;</span>';
        html += '<span class="badge badge-' + esc(e.type) + '">' + esc(e.type) + '</span>';
        html += '<span style="flex:1">' + esc(e.name) + count + '</span>';
        if (e.protocol) html += '<span style="color:var(--text-dim);font-size:11px">' + esc(e.protocol) + '</span>';
        html += '</div>';
        html += '<div class="expand-content" id="exp-' + idx + '">' + detailHtml + '</div>';
      }
      html += '</div>';
    }

    if (imports_.length > 0) {
      html += '<div class="detail-section"><h3>Imports (' + imports_.length + ')</h3>';
      for (let idx = 0; idx < imports_.length; idx++) {
        const i = imports_[idx];
        const provIfaces = interfaces.filter(x => x.service_id === i.provider_id);
        const matchedIface = i.interface_name ? provIfaces.find(x => x.name === i.interface_name) : provIfaces[0];
        const type = i.interface_type || i.type || '';
        const ifaceName = i.interface_name || i.provider_id;

        html += '<div class="detail-item-expand" data-expand="imp-' + idx + '">';
        html += '<span class="chevron">&#9656;</span>';
        html += '<span class="badge badge-' + esc(type) + '">' + esc(type) + '</span>';
        html += '<span style="flex:1">' + esc(i.provider_id) + ' <span style="color:var(--text-dim);font-size:11px">via ' + esc(ifaceName) + '</span></span>';
        if (i.deprecated) html += '<span style="color:var(--red);font-size:11px">DEPRECATED</span>';
        html += '</div>';
        html += '<div class="expand-content" id="imp-' + idx + '">';
        if (matchedIface) {
          html += renderInterfaceDetail(matchedIface);
        } else {
          html += '<div style="font-size:12px;color:var(--text-dim)">No interface detail</div>';
        }
        if (i.usage) html += '<div style="font-size:12px;color:var(--text-dim);margin-top:4px">Usage: ' + esc(i.usage) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    if (consumers.length > 0) {
      html += '<div class="detail-section"><h3>Consumers (' + consumers.length + ')</h3>';
      for (const c of consumers) {
        const cIfaces = c.interface_name ? (' via ' + c.interface_name) : '';
        html += '<div class="detail-item" style="cursor:pointer" onclick="highlightNode(\\'' + esc(c.consumer_id) + '\\')">';
        html += '<span class="consumer-link">' + esc(c.consumer_id) + '</span>';
        html += '<span style="color:var(--text-dim);font-size:11px">' + esc(c.type) + esc(cIfaces) + '</span></div>';
      }
      html += '</div>';
    }

    if (svc.repo_path) {
      html += '<div class="detail-section"><h3>Repo</h3>';
      html += '<div class="detail-item" style="font-size:12px;color:var(--text-dim)">' + esc(svc.repo_path) + '</div>';
      html += '</div>';
    }

    detailContent.innerHTML = html;
    detailPanel.classList.add('open');

    // Wire up expand/collapse toggles
    detailContent.querySelectorAll('.detail-item-expand').forEach(el => {
      el.addEventListener('click', () => {
        const targetId = el.getAttribute('data-expand');
        const target = document.getElementById(targetId);
        if (target) {
          el.classList.toggle('open');
          target.classList.toggle('open');
        }
      });
    });
  }

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Expose to window for inline onclick handlers
  window.showServiceDetail = showServiceDetail;
  window.highlightNode = highlightNode;

  // ── Service Map (D3 force-directed) ──
  function renderServiceMap() {
    window.__mapRendered = true;
    const svg = d3.select('#service-map-svg');
    const container = svg.node().parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
    svg.attr('viewBox', [0, 0, width, height]);

    // Build graph data
    const nodeMap = new Map();
    const nodes = services.map(s => {
      const n = { id: s.id, fanIn: s.fan_in || 0, fanOut: s.fan_out || 0, team: s.team || 'unassigned', risk: s.risk_level || 'low' };
      nodeMap.set(s.id, n);
      return n;
    });

    const links = [];
    const seen = new Set();
    for (const d of deps) {
      const key = d.consumer_id + '->' + d.provider_id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (nodeMap.has(d.consumer_id) && nodeMap.has(d.provider_id)) {
        links.push({ source: d.consumer_id, target: d.provider_id, type: d.type, deprecated: !!d.deprecated });
      }
    }

    // Team color scale
    const teamSet = [...new Set(nodes.map(n => n.team))];
    const teamColors = d3.scaleOrdinal()
      .domain(teamSet)
      .range(['#2990EA', '#e65100', '#2e8b57', '#7b1fa2', '#c62828', '#00695c', '#4527a0', '#ef6c00']);

    // Risk color
    const riskColor = { low: '#2e8b57', medium: '#c49000', high: '#e65100', critical: '#d32f2f' };

    // Radius by fan-in
    const maxFanIn = Math.max(1, ...nodes.map(n => n.fanIn));
    const radius = n => 12 + (n.fanIn / maxFanIn) * 20;

    // Arrow marker — fixed size via userSpaceOnUse
    svg.append('defs').append('marker')
      .attr('id', 'arrow').attr('viewBox', '0 -3 6 6')
      .attr('refX', 6).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-2.5L6,0L0,2.5').attr('class', 'arrow-head');

    // Zoom container — all graph elements go inside this <g>
    const zoomG = svg.append('g').attr('class', 'zoom-container');

    const zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 6])
      .on('zoom', (e) => { zoomG.attr('transform', e.transform); });

    svg.call(zoomBehavior);

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(140))
      .force('charge', d3.forceManyBody().strength(-350))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => radius(d) + 18));

    const link = zoomG.append('g')
      .selectAll('line').data(links).join('line')
      .attr('class', d => 'link-line' + (d.deprecated ? ' deprecated' : ''))
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arrow)');

    const node = zoomG.append('g')
      .selectAll('g').data(nodes).join('g')
      .call(d3.drag()
        .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    node.append('circle')
      .attr('class', 'node-circle')
      .attr('r', d => radius(d))
      .attr('fill', d => teamColors(d.team))
      .attr('stroke', d => riskColor[d.risk] || riskColor.low)
      .attr('stroke-width', d => d.risk === 'low' ? 1.5 : 3)
      .on('click', (e, d) => { e.stopPropagation(); showServiceDetail(d.id); });

    node.append('text')
      .attr('class', 'node-label')
      .attr('dy', d => radius(d) + 16)
      .attr('text-anchor', 'middle')
      .text(d => d.id.length > 24 ? d.id.slice(0, 22) + '...' : d.id);

    // ── Interface type colors ──
    const ifaceTypeColor = { api: '#1565c0', database: '#2e7d32', event: '#c62828', rpc: '#e65100', package: '#7b1fa2' };

    // ── Double-click → drill into module graph ──
    let drilledSvc = null;
    let moduleSimulation = null;
    const svgContainer = svg.node().parentElement;

    function drillIntoModules(svcId) {
      const svcMods = serviceModules[svcId];
      if (!svcMods || svcMods.modules.length === 0) return;
      drilledSvc = svcId;

      // Stop system simulation
      simulation.stop();

      // Hide system graph elements
      zoomG.style('display', 'none');

      // Reset zoom
      svg.call(zoomBehavior.transform, d3.zoomIdentity);

      // Create module graph container
      const modG = svg.append('g').attr('class', 'module-graph-container');
      svg.call(zoomBehavior.on('zoom', (e) => { modG.attr('transform', e.transform); }));

      // Add back button + title overlay
      let backBtn = svgContainer.querySelector('.drill-back');
      if (!backBtn) {
        backBtn = document.createElement('button');
        backBtn.className = 'drill-back';
        backBtn.innerHTML = '<span class="arrow">&#8592;</span> System View';
        svgContainer.appendChild(backBtn);
      }
      backBtn.style.display = 'flex';
      backBtn.onclick = () => drillBack();

      let titleEl = svgContainer.querySelector('.drill-title');
      if (!titleEl) {
        titleEl = document.createElement('div');
        titleEl.className = 'drill-title';
        svgContainer.appendChild(titleEl);
      }
      titleEl.textContent = svcId + ' — Module Graph';
      titleEl.style.display = 'block';

      // Build module nodes & links
      const stabColor = { high: '#2e8b57', medium: '#c49000', low: '#c62828' };
      const capColor = d3.scaleOrdinal()
        .domain(['api_server', 'database_sql', 'react_advanced', 'ui_components', 'authentication', 'ai_ml', 'testing', 'docker', 'logging'])
        .range(['#1565c0', '#2e7d32', '#7b1fa2', '#9c27b0', '#e65100', '#00838f', '#546e7a', '#37474f', '#795548']);

      const modNodes = svcMods.modules.map(m => ({
        id: m.name,
        fileCount: m.file_count || 0,
        stability: m.stability || 'medium',
        capabilities: (m.capabilities || []).map(c => typeof c === 'string' ? { capability: c, confidence: null } : c),
        rootPath: m.root_path || m.name,
        publicApiCount: m.public_api_count || 0,
      }));
      const modNodeMap = new Map(modNodes.map(n => [n.id, n]));

      const modLinks = svcMods.modDeps
        .filter(d => modNodeMap.has(d.source_module) && modNodeMap.has(d.target_module))
        .map(d => ({ source: d.source_module, target: d.target_module, weight: d.edge_count || 1 }));

      // Radius by file count — compact range
      const maxFiles = Math.max(1, ...modNodes.map(n => n.fileCount));
      const modRadius = n => 6 + (n.fileCount / maxFiles) * 16;

      // Primary capability determines color
      const modColor = n => {
        const mainCap = n.capabilities[0];
        const capName = mainCap ? (mainCap.capability || mainCap) : null;
        return capName ? capColor(capName) : '#6b7c93';
      };

      // Arrow marker — fixed size via userSpaceOnUse so it doesn't scale with stroke-width
      svg.select('defs').append('marker')
        .attr('id', 'mod-arrow')
        .attr('viewBox', '0 -3 6 6')
        .attr('refX', 6).attr('refY', 0)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,-2.5L6,0L0,2.5').attr('fill', '#99aabb');

      // Force simulation — adaptive to node count
      const nodeCount = modNodes.length;
      const linkDist = nodeCount > 20 ? 165 : nodeCount > 10 ? 195 : 240;
      const chargeStr = nodeCount > 20 ? -300 : nodeCount > 10 ? -420 : -540;

      moduleSimulation = d3.forceSimulation(modNodes)
        .force('link', d3.forceLink(modLinks).id(d => d.id).distance(linkDist).strength(d => 0.4 + d.weight * 0.05))
        .force('charge', d3.forceManyBody().strength(chargeStr))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => modRadius(d) + 6))
        .force('x', d3.forceX(width / 2).strength(0.06))
        .force('y', d3.forceY(height / 2).strength(0.06));

      // Render links
      const mLink = modG.append('g')
        .selectAll('line').data(modLinks).join('line')
        .attr('class', 'mod-link')
        .attr('stroke-width', d => Math.min(2, 0.5 + d.weight * 0.2))
        .attr('marker-end', 'url(#mod-arrow)');

      // Render nodes
      const mNode = modG.append('g')
        .selectAll('g').data(modNodes).join('g')
        .call(d3.drag()
          .on('start', (e, d) => { if (!e.active) moduleSimulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on('end', (e, d) => { if (!e.active) moduleSimulation.alphaTarget(0); d.fx = null; d.fy = null; })
        );

      mNode.append('circle')
        .attr('class', 'mod-node-circle')
        .attr('r', d => modRadius(d))
        .attr('fill', d => modColor(d))
        .attr('stroke', d => stabColor[d.stability] || '#6b7c93')
        .attr('stroke-width', d => d.stability === 'low' ? 3 : 1.5)
        .on('click', (e, d) => { e.stopPropagation(); showModuleDetail(svcId, d); })
        .append('title').text(d => d.id + ' (' + d.fileCount + ' files)');

      mNode.append('text')
        .attr('class', 'mod-node-label')
        .attr('dy', d => modRadius(d) + 16)
        .text(d => d.id.length > 20 ? d.id.slice(0, 18) + '..' : d.id);

      moduleSimulation.on('tick', () => {
        mLink.each(function(d) {
          const dx = d.target.x - d.source.x;
          const dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const tR = modRadius(d.target) + 5;
          const sR = modRadius(d.source) + 2;
          d3.select(this)
            .attr('x1', d.source.x + (dx / dist) * sR)
            .attr('y1', d.source.y + (dy / dist) * sR)
            .attr('x2', d.target.x - (dx / dist) * tR)
            .attr('y2', d.target.y - (dy / dist) * tR);
        });
        mNode.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      });

      // Update sidebar legend for module view
      updateLegendForModules(svcId, svcMods, stabColor, capColor);
    }

    function drillBack() {
      drilledSvc = null;

      // Stop module simulation
      if (moduleSimulation) { moduleSimulation.stop(); moduleSimulation = null; }

      // Remove module graph
      svg.selectAll('.module-graph-container').remove();
      svg.select('defs').selectAll('#mod-arrow').remove();

      // Hide overlays
      const backBtn = svgContainer.querySelector('.drill-back');
      const titleEl = svgContainer.querySelector('.drill-title');
      if (backBtn) backBtn.style.display = 'none';
      if (titleEl) titleEl.style.display = 'none';

      // Restore system graph
      zoomG.style('display', null);
      svg.call(zoomBehavior.on('zoom', (e) => { zoomG.attr('transform', e.transform); }));
      svg.call(zoomBehavior.transform, d3.zoomIdentity);
      simulation.alpha(0.1).restart();

      // Restore sidebar
      renderSystemLegend();
    }

    // Module detail panel
    function showModuleDetail(svcId, mod) {
      // Look up full module data from serviceModules (has files, capabilities with confidence)
      const svcMods = serviceModules[svcId];
      const fullMod = svcMods ? svcMods.modules.find(m => m.name === mod.id) : null;

      let html = '<h2>' + esc(mod.id) + '</h2>';
      html += '<div class="sub">Module in ' + esc(svcId) + '</div>';

      html += '<div class="detail-section"><h3>Overview</h3>';
      html += '<div class="risk-metrics">';
      html += '<span>Files: <strong>' + mod.fileCount + '</strong></span>';
      html += '<span>Public API: <strong>' + mod.publicApiCount + '</strong></span>';
      html += '<span>Stability: <strong>' + esc(mod.stability) + '</strong></span>';
      html += '</div></div>';

      if (mod.rootPath) {
        html += '<div class="detail-section"><h3>Path</h3>';
        html += '<div class="detail-item" style="font-size:12px;color:var(--text-dim);font-family:monospace">' + esc(mod.rootPath) + '</div>';
        html += '</div>';
      }

      // Capabilities with confidence %
      const caps = mod.capabilities || [];
      if (caps.length > 0) {
        html += '<div class="detail-section"><h3>Capabilities</h3>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
        caps.forEach(cap => {
          const capName = cap.capability || cap;
          const conf = cap.confidence != null ? ' (' + Math.round(cap.confidence * 100) + '%)' : '';
          html += '<span class="badge" style="background:var(--forge-sky);color:var(--forge-primary)">' + esc(capName) + esc(conf) + '</span>';
        });
        html += '</div></div>';
      }

      // Dependencies from modDeps
      if (svcMods) {
        const depsOut = svcMods.modDeps.filter(d => d.source_module === mod.id);
        const depsIn = svcMods.modDeps.filter(d => d.target_module === mod.id);

        if (depsIn.length > 0) {
          html += '<div class="detail-section"><h3>Depended On By (' + depsIn.length + ')</h3>';
          depsIn.forEach(d => {
            html += '<div class="detail-item"><span style="color:var(--text-dim);font-size:11px">&larr;</span> ' + esc(d.source_module);
            html += ' <span style="color:var(--text-dim);font-size:10px">(' + d.edge_count + ' import' + (d.edge_count !== 1 ? 's' : '') + ')</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        if (depsOut.length > 0) {
          html += '<div class="detail-section"><h3>Depends On (' + depsOut.length + ')</h3>';
          depsOut.forEach(d => {
            html += '<div class="detail-item"><span style="color:var(--text-dim);font-size:11px">&rarr;</span> ' + esc(d.target_module);
            html += ' <span style="color:var(--text-dim);font-size:10px">(' + d.edge_count + ' import' + (d.edge_count !== 1 ? 's' : '') + ')</span>';
            html += '</div>';
          });
          html += '</div>';
        }
      }

      // Top files by LOC
      const files = (fullMod && fullMod.files) ? fullMod.files : [];
      if (files.length > 0) {
        html += '<div class="detail-section"><h3>Top Files by LOC</h3>';
        files.forEach(f => {
          const fname = f.path.split('/').pop();
          html += '<div class="detail-item" style="font-size:12px">';
          html += '<span style="flex:1;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(f.path) + '">' + esc(fname) + '</span>';
          html += '<span style="color:var(--text-dim);font-size:11px;flex-shrink:0">' + (f.loc || 0) + ' LOC</span>';
          html += '</div>';
        });
        html += '</div>';
      }

      detailContent.innerHTML = html;
      detailPanel.classList.add('open');
    }

    // Make drillIntoModules accessible
    window.__drillIntoModules = drillIntoModules;
    window.__drillBack = drillBack;

    node.on('dblclick', (e, d) => {
      e.stopPropagation();
      e.preventDefault();
      drillIntoModules(d.id);
    });

    simulation.on('tick', () => {
      // Shorten lines to stop at target node edge + arrow gap
      link.each(function(d) {
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetR = radius(d.target) + 6;
        const sourceR = radius(d.source) + 2;
        const sx = d.source.x + (dx / dist) * sourceR;
        const sy = d.source.y + (dy / dist) * sourceR;
        const tx = d.target.x - (dx / dist) * targetR;
        const ty = d.target.y - (dy / dist) * targetR;
        d3.select(this).attr('x1', sx).attr('y1', sy).attr('x2', tx).attr('y2', ty);
      });
      node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
    });

    // ── Sidebar legend ──
    const legendEl = document.getElementById('map-legend');
    const stabilityColor = { high: '#2e8b57', medium: '#c49000', low: '#c62828' };

    function renderSystemLegend() {
      let legHtml = '<h4>Teams</h4>';
      teamSet.forEach(team => {
        legHtml += '<div class="legend-item"><span class="legend-dot" style="background:' + teamColors(team) + '"></span>' + esc(team) + '</div>';
      });
      legHtml += '<div class="legend-divider"></div>';
      legHtml += '<h4>Interface Types</h4>';
      Object.entries(ifaceTypeColor).forEach(([type, color]) => {
        legHtml += '<div class="legend-item"><span class="legend-dot" style="background:' + color + '"></span>' + type + '</div>';
      });
      legHtml += '<div class="legend-divider"></div>';
      legHtml += '<h4>Risk Level</h4>';
      Object.entries(riskColor).forEach(([level, color]) => {
        legHtml += '<div class="legend-item"><span class="legend-dot" style="background:' + color + ';width:10px;height:4px;border-radius:2px"></span>' + level + '</div>';
      });
      legHtml += '<div class="legend-divider"></div>';
      legHtml += '<div class="legend-hint">Click node for details<br>Double-click to drill into modules<br>Scroll to zoom, drag to pan</div>';

      // Service → Module tree
      legHtml += '<div class="legend-divider"></div>';
      legHtml += '<h4>Services</h4>';
      legHtml += '<div class="svc-search-wrap"><span class="svc-search-icon">&#128269;</span>';
      legHtml += '<input type="text" class="svc-search" id="svc-search" placeholder="Search services..." /></div>';
      legHtml += '<ul class="svc-tree" id="svc-tree">';
      const sortedSvcs = [...services].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
      sortedSvcs.forEach(svc => {
        const mods = serviceModules[svc.id];
        const modList = mods ? mods.modules : [];
        const hasModules = modList.length > 0;
        const svcColor = teamColors(svc.team || 'unassigned');

        legHtml += '<li>';
        legHtml += '<div class="svc-tree-item" data-svc="' + esc(svc.id) + '"' + (hasModules ? ' data-expandable="1"' : '') + '>';
        if (hasModules) {
          legHtml += '<span class="svc-tree-chevron">&#9656;</span>';
        } else {
          legHtml += '<span class="svc-tree-chevron" style="visibility:hidden">&#9656;</span>';
        }
        legHtml += '<span class="legend-dot" style="background:' + svcColor + ';width:8px;height:8px"></span>';
        legHtml += '<span class="svc-tree-name" title="' + esc(svc.id) + '">' + esc(svc.id) + '</span>';
        if (hasModules) legHtml += '<span class="svc-tree-count">' + modList.length + '</span>';
        legHtml += '</div>';

        if (hasModules) {
          legHtml += '<ul class="mod-tree" id="mod-tree-' + esc(svc.id) + '">';
          modList.forEach(mod => {
            const stabColor = stabilityColor[mod.stability] || '#6b7c93';
            legHtml += '<li><div class="mod-tree-item" data-svc="' + esc(svc.id) + '" data-mod="' + esc(mod.name) + '">';
            legHtml += '<span class="mod-stability" style="background:' + stabColor + '" title="stability: ' + esc(mod.stability || 'unknown') + '"></span>';
            legHtml += '<span class="mod-tree-name" title="' + esc(mod.root_path || mod.name) + '">' + esc(mod.name) + '</span>';
            legHtml += '<span class="mod-tree-meta">' + (mod.file_count || 0) + 'f</span></div>';
            if (mod.capabilities && mod.capabilities.length > 0) {
              legHtml += '<div class="mod-caps">';
              mod.capabilities.slice(0, 4).forEach(cap => {
                const capName = cap.capability || cap;
                legHtml += '<span class="mod-cap-tag">' + esc(capName) + '</span>';
              });
              if (mod.capabilities.length > 4) legHtml += '<span class="mod-cap-tag">+' + (mod.capabilities.length - 4) + '</span>';
              legHtml += '</div>';
            }
            legHtml += '</li>';
          });
          legHtml += '</ul>';
        }
        legHtml += '</li>';
      });
      legHtml += '</ul>';
      legendEl.innerHTML = legHtml;
      wireUpSystemLegend();
    }

    function wireUpSystemLegend() {
      // Expand/collapse
      legendEl.querySelectorAll('.svc-tree-item[data-expandable]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const svcId = el.getAttribute('data-svc');
          const modTree = document.getElementById('mod-tree-' + svcId);
          if (modTree) { el.classList.toggle('open'); modTree.classList.toggle('open'); }
        });
      });

      // Double-click service → drill into module graph
      legendEl.querySelectorAll('.svc-tree-item').forEach(el => {
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          drillIntoModules(el.getAttribute('data-svc'));
        });
      });

      // Click module → show service detail
      legendEl.querySelectorAll('.mod-tree-item').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          showServiceDetail(el.getAttribute('data-svc'));
        });
      });

      // Search
      const searchInput = document.getElementById('svc-search');
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          const q = searchInput.value.trim().toLowerCase();
          const treeItems = legendEl.querySelectorAll('.svc-tree > li');

          if (!q) {
            treeItems.forEach(li => li.classList.remove('hidden'));
            legendEl.querySelectorAll('.svc-tree-item.search-match').forEach(el => el.classList.remove('search-match'));
            node.classed('node-highlight', false);
            svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
            return;
          }

          let firstMatch = null;
          treeItems.forEach(li => {
            const svcEl = li.querySelector('.svc-tree-item');
            const svcId = svcEl ? svcEl.getAttribute('data-svc') : '';
            const modEls = li.querySelectorAll('.mod-tree-name');
            let modMatch = false;
            modEls.forEach(mel => { if (mel.textContent.toLowerCase().includes(q)) modMatch = true; });
            const matches = svcId.toLowerCase().includes(q) || modMatch;
            li.classList.toggle('hidden', !matches);
            if (svcEl) svcEl.classList.toggle('search-match', matches);
            if (matches && !firstMatch) firstMatch = svcId;
          });

          if (firstMatch) {
            let target = null;
            node.each(function(d) { if (d.id === firstMatch) target = d; });
            if (target && target.x != null) {
              const svgEl = svg.node();
              const svgW = svgEl.clientWidth || width;
              const svgH = svgEl.clientHeight || height;
              const t = d3.zoomIdentity.translate(svgW / 2 - target.x * 1.5, svgH / 2 - target.y * 1.5).scale(1.5);
              svg.transition().duration(600).call(zoomBehavior.transform, t);
              zoomG.selectAll('.node-highlight').classed('node-highlight', false);
              node.filter(d => d.id === firstMatch).classed('node-highlight', true);
            }
          }
        });

        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const firstVisible = legendEl.querySelector('.svc-tree > li:not(.hidden) .svc-tree-item');
            if (firstVisible) {
              const svcId = firstVisible.getAttribute('data-svc');
              drillIntoModules(svcId);
            }
          }
        });
      }
    }

    function updateLegendForModules(svcId, svcMods, stabColor, capColor) {
      const svc = services.find(s => s.id === svcId);
      let html = '<h4 style="color:var(--forge-primary)">' + esc(svcId) + '</h4>';
      html += '<div class="legend-hint" style="margin-bottom:8px">' + esc(svc ? svc.description || '' : '') + '</div>';

      html += '<h4>Stability</h4>';
      Object.entries(stabColor).forEach(([level, color]) => {
        html += '<div class="legend-item"><span class="legend-dot" style="background:' + color + '"></span>' + level + '</div>';
      });
      html += '<div class="legend-divider"></div>';

      html += '<h4>Node Size = File Count</h4>';
      html += '<div class="legend-hint">Larger circles have more files</div>';
      html += '<div class="legend-divider"></div>';

      html += '<div class="legend-hint">Click module for details<br>Drag to reposition<br>Scroll to zoom</div>';
      html += '<div class="legend-divider"></div>';

      // Module list
      html += '<h4>Modules (' + svcMods.modules.length + ')</h4>';
      html += '<ul class="svc-tree">';
      svcMods.modules.forEach(mod => {
        const sc = stabColor[mod.stability] || '#6b7c93';
        html += '<li><div class="mod-tree-item" data-mod="' + esc(mod.name) + '" style="cursor:pointer">';
        html += '<span class="mod-stability" style="background:' + sc + '"></span>';
        html += '<span class="mod-tree-name">' + esc(mod.name) + '</span>';
        html += '<span class="mod-tree-meta">' + (mod.file_count || 0) + 'f</span>';
        html += '</div></li>';
      });
      html += '</ul>';
      legendEl.innerHTML = html;

      // Wire up module list clicks to highlight on graph
      legendEl.querySelectorAll('.mod-tree-item').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const modName = el.getAttribute('data-mod');
          // Find module datum and center on it
          const modG = svg.select('.module-graph-container');
          if (modG.empty()) return;
          let target = null;
          modG.selectAll('.mod-node-circle').each(function(d) { if (d.id === modName) target = d; });
          if (target && target.x != null) {
            const svgEl = svg.node();
            const svgW = svgEl.clientWidth || width;
            const svgH = svgEl.clientHeight || height;
            const t = d3.zoomIdentity.translate(svgW / 2 - target.x * 1.5, svgH / 2 - target.y * 1.5).scale(1.5);
            svg.transition().duration(500).call(zoomBehavior.transform, t);
          }
          // Show detail
          const modData = svcMods.modules.find(m => m.name === modName) || {};
          showModuleDetail(svcId, {
            id: modName,
            fileCount: modData.file_count || 0,
            publicApiCount: modData.public_api_count || 0,
            stability: modData.stability || 'medium',
            capabilities: modData.capabilities || [],
            rootPath: modData.root_path || modName,
          });
        });
      });
    }

    // Initial render
    renderSystemLegend();
  }

  // ── Dependency Matrix ──
  function renderMatrix() {
    window.__matrixRendered = true;
    const svcIds = services.map(s => s.id).sort();
    const depMap = new Map();
    for (const d of deps) {
      const key = d.consumer_id + '|' + d.provider_id;
      depMap.set(key, (depMap.get(key) || 0) + 1);
    }

    let html = '<table class="matrix-table"><thead><tr><th></th>';
    for (const id of svcIds) html += '<th title="' + esc(id) + '">' + esc(id.slice(0, 8)) + '</th>';
    html += '</tr></thead><tbody>';

    for (const row of svcIds) {
      html += '<tr><th class="row-header" title="' + esc(row) + '">' + esc(row.slice(0, 16)) + '</th>';
      for (const col of svcIds) {
        if (row === col) {
          html += '<td class="matrix-cell-self">-</td>';
        } else {
          const count = depMap.get(row + '|' + col) || 0;
          if (count > 0) {
            html += '<td class="matrix-cell-dep" title="' + esc(row) + ' depends on ' + esc(col) + ' (' + count + ')" onclick="showServiceDetail(\\'' + esc(col) + '\\')">' + count + '</td>';
          } else {
            html += '<td></td>';
          }
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('matrix-container').innerHTML = html;

    // Expose for onclick
    window.showServiceDetail = showServiceDetail;
  }

  // ── Interface Registry ──
  function renderRegistry() {
    window.__registryRendered = true;
    renderRegistryTable(interfaces);

    document.getElementById('registry-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = interfaces.filter(i =>
        i.service_id.toLowerCase().includes(q) ||
        i.name.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      );
      renderRegistryTable(filtered);
    });
  }

  function renderRegistryTable(items) {
    let html = '<table class="registry-table"><thead><tr>';
    html += '<th>Service</th><th>Type</th><th>Protocol</th><th>Name</th><th>Description</th><th>Team</th>';
    html += '</tr></thead><tbody>';
    for (const i of items) {
      html += '<tr onclick="showServiceDetail(\\'' + esc(i.service_id) + '\\')" style="cursor:pointer">';
      html += '<td>' + esc(i.service_id) + '</td>';
      html += '<td><span class="badge badge-' + esc(i.type) + '">' + esc(i.type) + '</span></td>';
      html += '<td>' + esc(i.protocol || '-') + '</td>';
      html += '<td>' + esc(i.name) + '</td>';
      html += '<td style="color:var(--text-dim);font-size:12px">' + esc(i.description || '') + '</td>';
      html += '<td>' + esc(i.team || '-') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('registry-table-container').innerHTML = html;
    window.showServiceDetail = showServiceDetail;
  }

  // ── Risk Register ──
  function renderRisk() {
    window.__riskRendered = true;
    // Sort by risk: critical > high > medium > low
    const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...services].sort((a, b) => (riskOrder[a.risk_level||'low']||3) - (riskOrder[b.risk_level||'low']||3));

    let html = '';
    for (const s of sorted) {
      const risk = s.risk_level || 'low';
      html += '<div class="risk-card" onclick="showServiceDetail(\\'' + esc(s.id) + '\\')">';
      html += '<div class="risk-header"><span class="risk-name">' + esc(s.id) + '</span>';
      html += '<span class="risk-badge risk-' + risk + '">' + risk + '</span></div>';
      html += '<div class="risk-metrics">';
      html += '<span>Fan-in: ' + (s.fan_in || 0) + '</span>';
      html += '<span>Fan-out: ' + (s.fan_out || 0) + '</span>';
      html += '<span>Coupling: ' + ((s.coupling_score || 0) * 100).toFixed(0) + '%</span>';
      html += '<span>Interfaces: ' + (s.interface_count || 0) + '</span>';
      html += '</div>';
      if (s.description) html += '<div style="margin-top:6px;font-size:12px;color:var(--text-dim)">' + esc(s.description) + '</div>';
      html += '</div>';
    }

    // Deprecated deps
    const deprecatedDeps = deps.filter(d => d.deprecated);
    if (deprecatedDeps.length > 0) {
      html += '<h3 style="margin:20px 0 10px;color:var(--red)">Deprecated Dependencies (' + deprecatedDeps.length + ')</h3>';
      for (const d of deprecatedDeps) {
        html += '<div class="risk-card" style="border-color:var(--red)">';
        html += '<span>' + esc(d.consumer_id) + ' &rarr; ' + esc(d.provider_id) + '</span>';
        html += '<span style="color:var(--text-dim);font-size:12px;margin-left:12px">' + esc(d.type) + '</span>';
        html += '</div>';
      }
    }

    // Cycles
    const cycles = D.cycles || [];
    if (cycles.length > 0) {
      html += '<h3 style="margin:20px 0 10px;color:var(--orange)">Service Cycles (' + cycles.length + ')</h3>';
      for (const c of cycles) {
        const path_ = Array.isArray(c) ? c.join(' &rarr; ') : String(c);
        html += '<div class="risk-card" style="border-color:var(--orange)">';
        html += '<span style="font-size:13px">' + path_ + '</span></div>';
      }
    }

    document.getElementById('risk-container').innerHTML = html;
    window.showServiceDetail = showServiceDetail;
  }

  // ── Team View ──
  function renderTeams() {
    window.__teamsRendered = true;
    const byTeam = new Map();
    for (const s of services) {
      const team = s.team || 'Unassigned';
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(s);
    }

    let html = '';
    for (const [team, svcs] of [...byTeam.entries()].sort()) {
      html += '<div class="team-group"><h3>' + esc(team) + ' (' + svcs.length + ' services)</h3>';
      html += '<div class="team-services">';
      for (const s of svcs) {
        html += '<div class="team-service-card" onclick="showServiceDetail(\\'' + esc(s.id) + '\\')">';
        html += '<div class="svc-name">' + esc(s.id) + '</div>';
        html += '<div class="svc-meta">';
        html += '<span>Fan-in: ' + (s.fan_in || 0) + '</span> &middot; ';
        html += '<span>Fan-out: ' + (s.fan_out || 0) + '</span> &middot; ';
        html += '<span>Interfaces: ' + (s.interface_count || 0) + '</span>';
        html += '</div>';
        if (s.description) html += '<div style="margin-top:4px;font-size:12px;color:var(--text-dim)">' + esc(s.description) + '</div>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    document.getElementById('teams-container').innerHTML = html;
    window.showServiceDetail = showServiceDetail;
  }

  // Render Service Map on load
  renderServiceMap();
})();
  `;
}

// ============================================================
// Build Full HTML
// ============================================================

function buildHTML(data) {
  // D3.js — use vendor copy or CDN fallback
  let d3Source = '';
  const vendorPath = path.join(__dirname, '..', 'forge-graph', 'vendor', 'd3.v7.min.js');
  if (fs.existsSync(vendorPath)) {
    d3Source = fs.readFileSync(vendorPath, 'utf-8');
  }

  const d3Tag = d3Source
    ? `<script>${d3Source}</script>`
    : `<script src="https://d3js.org/d3.v7.min.js"></script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge System Graph</title>
  <style>${generateCSS()}</style>
</head>
<body>
  ${generateHTML(data)}
  ${d3Tag}
  <script>window.__SYSTEM_DATA__ = ${JSON.stringify(data)};</script>
  <script>${generateJS()}</script>
</body>
</html>`;
}

// ============================================================
// Browser Opening
// ============================================================

function openInBrowser(filePath) {
  const { exec } = require('child_process');
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'cmd /c start ""'
    : 'xdg-open';
  exec(`${cmd} "${filePath}"`, () => {});
}

// ============================================================
// CLI
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const shouldOpen = !args.includes('--no-open');

  const dbIdx = args.indexOf('--db');
  const outIdx = args.indexOf('--output');

  let dbPath = dbIdx !== -1 ? args[dbIdx + 1] : null;
  const outputPath = outIdx !== -1 ? args[outIdx + 1] : null;

  if (!dbPath) {
    // Try default locations
    const candidates = [
      path.join(process.cwd(), '.forge', 'system-graph.db'),
      path.join(require('os').homedir(), '.forge', 'system-graph.db'),
    ];
    dbPath = candidates.find(c => fs.existsSync(c));
  }

  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error('Error: system-graph.db not found. Use --db <path> or run system-init first.');
    process.exit(1);
  }

  let chalk;
  try { chalk = require('chalk'); } catch {
    chalk = { bold: s => s, cyan: s => s, green: s => s, dim: s => s };
  }

  console.log('');
  console.log(chalk.bold('  System Dashboard Generator'));
  console.log(chalk.dim('  ──────────────────────────────'));

  const startTime = Date.now();
  const data = collectSystemData(dbPath);

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const html = buildHTML(data);
  const dest = outputPath || path.join(path.dirname(dbPath), 'system-dashboard.html');
  fs.writeFileSync(dest, html, 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeKB = Math.round(html.length / 1024);

  console.log(`  Output:     ${chalk.cyan(dest)}`);
  console.log(`  Size:       ${sizeKB} KB`);
  console.log(`  Services:   ${data.services.length}`);
  console.log(`  Interfaces: ${data.interfaces.length}`);
  console.log(`  Time:       ${elapsed}s`);
  console.log('');

  if (shouldOpen) {
    openInBrowser(dest);
    console.log(`  ${chalk.green('✓')} Opened in browser.`);
    console.log('');
  }
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  collectSystemData,
  buildHTML,
  generateCSS,
  generateHTML,
  generateJS,
};

if (require.main === module) {
  main();
}
