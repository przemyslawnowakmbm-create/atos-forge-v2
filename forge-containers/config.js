#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// Defaults
// ============================================================

const CONTAINER_DEFAULTS = {
  max_concurrent: 'auto',
  max_memory_per_container: '2g',
  max_cpu_per_container: 1.0,
  max_total_memory: 'auto',
  max_total_cpu: 'auto',
  timeout_seconds: 600,
  image_prefix: 'forge-agent',
  worktree_base: path.join(os.tmpdir(), 'forge-worktrees'),
  output_base: path.join(os.tmpdir(), 'forge-output'),
  cleanup_on_success: true,
  cleanup_on_failure: false,
};

// ============================================================
// Config Loading
// ============================================================

/**
 * Load container configuration from .forge/config.json or .planning/config.json.
 * Merges `containers` section with CONTAINER_DEFAULTS.
 */
function loadContainerConfig(cwd) {
  // Delegate to unified config system
  try {
    const containers = require('../forge-config/config').getContainers(cwd);
    if (containers && Object.keys(containers).length > 0) {
      return { ...CONTAINER_DEFAULTS, ...containers };
    }
  } catch { /* fallback to inline */ }

  const root = cwd || process.cwd();
  const candidates = [
    path.join(root, '.forge', 'config.json'),
    path.join(root, '.planning', 'config.json'),
  ];
  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const section = parsed.containers || {};
      if (Object.keys(section).length > 0) {
        return { ...CONTAINER_DEFAULTS, ...section };
      }
    } catch { /* try next */ }
  }
  return { ...CONTAINER_DEFAULTS };
}

// ============================================================
// Auto-Detection
// ============================================================

function parseMemoryString(str) {
  if (typeof str === 'number') return str;
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(g|gb|m|mb)?$/i);
  if (!match) return 2 * 1024 * 1024 * 1024; // default 2GB
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'g').toLowerCase();
  if (unit.startsWith('m')) return Math.floor(num * 1024 * 1024);
  return Math.floor(num * 1024 * 1024 * 1024);
}

function formatMemory(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}g`;
  return `${Math.floor(bytes / (1024 * 1024))}m`;
}

/**
 * Detect system resources and compute resolved config with concrete numbers.
 */
function resolveConfig(cwd) {
  const raw = loadContainerConfig(cwd);
  const totalCores = os.cpus().length;
  const totalMemBytes = os.totalmem();

  // Resolve per-container limits
  const memPerContainer = parseMemoryString(raw.max_memory_per_container);
  const cpuPerContainer = raw.max_cpu_per_container;

  // Resolve total limits
  const maxTotalMemory = raw.max_total_memory === 'auto'
    ? Math.floor(totalMemBytes * 0.7)
    : parseMemoryString(raw.max_total_memory);
  const maxTotalCpu = raw.max_total_cpu === 'auto'
    ? Math.max(1, totalCores - 2)
    : parseFloat(raw.max_total_cpu);

  // Resolve max concurrent
  let maxConcurrent;
  if (raw.max_concurrent === 'auto') {
    const byMemory = Math.floor(maxTotalMemory / memPerContainer);
    const byCpu = Math.floor(maxTotalCpu / cpuPerContainer);
    maxConcurrent = Math.min(byMemory, byCpu);
    maxConcurrent = Math.max(1, Math.min(8, maxConcurrent)); // hard cap 1-8
  } else {
    maxConcurrent = Math.max(1, Math.min(8, parseInt(raw.max_concurrent) || 1));
  }

  return {
    ...raw,
    // Resolved concrete values
    max_concurrent: maxConcurrent,
    max_memory_per_container: memPerContainer,
    max_memory_per_container_str: formatMemory(memPerContainer),
    max_cpu_per_container: cpuPerContainer,
    max_total_memory: maxTotalMemory,
    max_total_memory_str: formatMemory(maxTotalMemory),
    max_total_cpu: maxTotalCpu,
    // System info
    system: {
      total_cores: totalCores,
      total_memory: totalMemBytes,
      total_memory_str: formatMemory(totalMemBytes),
    },
  };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  CONTAINER_DEFAULTS,
  loadContainerConfig,
  resolveConfig,
  parseMemoryString,
  formatMemory,
};
