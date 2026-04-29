#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Cross-Service Contract Verifier
 *
 * Validates contracts between services defined in CONTRACT-REGISTRY.md.
 * Detects breaking changes by comparing current contracts against a baseline.
 *
 * Supports: REST (OpenAPI-style), Events (AsyncAPI-style), gRPC (proto-style)
 *
 * Usage:
 *   Programmatic:
 *     const { verifyContracts, detectBreakingChanges } = require('./contract-verifier');
 *     const result = verifyContracts(cwd, opts);
 */

// ============================================================
// Contract Registry Parsing
// ============================================================

/**
 * Parse CONTRACT-REGISTRY.md into structured contract objects.
 * Supports REST, Event, and gRPC contract blocks.
 *
 * @param {string} content - Markdown content of CONTRACT-REGISTRY.md
 * @returns {Array<{type, provider, consumer, endpoint, response?, payload?, channel?, proto?}>}
 */
function parseContractRegistry(content) {
  const contracts = [];
  if (!content) return contracts;

  // Split into contract blocks (### headings)
  const blockPattern = /### (.+)\n([\s\S]*?)(?=### |\n## |$)/g;
  let blockMatch;

  // Track current service pair from ## heading
  let currentProvider = '';
  let currentConsumer = '';

  const pairPattern = /## (\S+)\s*(?:→|->|-->)\s*(\S+)/g;
  let pairMatch;
  while ((pairMatch = pairPattern.exec(content)) !== null) {
    currentProvider = pairMatch[1].trim();
    currentConsumer = pairMatch[2].trim();
  }

  while ((blockMatch = blockPattern.exec(content)) !== null) {
    const heading = blockMatch[1].trim();
    const body = blockMatch[2];

    const typeMatch = body.match(/\*\*Type:\*\*\s*(\w+)/);
    const providerMatch = body.match(/\*\*Provider:\*\*\s*(\S+)/);
    const consumerMatch = body.match(/\*\*Consumer:\*\*\s*(\S+)/);
    const responseMatch = body.match(/\*\*Response:\*\*\s*(.+)/);
    const payloadMatch = body.match(/\*\*Payload:\*\*\s*(.+)/);
    const channelMatch = body.match(/\*\*Channel:\*\*\s*(.+)/);
    const statusMatch = body.match(/\*\*Status codes:\*\*\s*(.+)/);
    const protoMatch = body.match(/\*\*Proto:\*\*\s*(.+)/);

    const contract = {
      type: typeMatch ? typeMatch[1].trim() : 'REST',
      provider: providerMatch ? providerMatch[1].trim() : currentProvider,
      consumer: consumerMatch ? consumerMatch[1].trim() : currentConsumer,
      endpoint: heading,
      response: responseMatch ? responseMatch[1].trim() : null,
      payload: payloadMatch ? payloadMatch[1].trim() : null,
      channel: channelMatch ? channelMatch[1].trim() : null,
      statusCodes: statusMatch ? statusMatch[1].trim() : null,
      proto: protoMatch ? protoMatch[1].trim() : null,
    };

    contracts.push(contract);
  }

  return contracts;
}

// ============================================================
// Breaking Change Detection
// ============================================================

/**
 * Detect breaking changes between baseline and current contracts.
 *
 * Breaking changes:
 * - Endpoint removed (existed in baseline, missing in current)
 * - Response schema changed (fields removed or types changed)
 * - Event payload changed
 * - gRPC proto changed
 *
 * Non-breaking (allowed):
 * - New endpoint added
 * - New optional fields added to response
 * - New event type added
 *
 * @param {Array} baseline - Contracts from baseline
 * @param {Array} current - Current contracts
 * @returns {Array<{type: string, severity: string, endpoint: string, provider: string, consumer: string, description: string}>}
 */
function detectBreakingChanges(baseline, current) {
  const breaks = [];

  // Index current by endpoint+provider+consumer key
  const currentMap = new Map();
  for (const c of current) {
    const key = `${c.provider}:${c.consumer}:${c.endpoint}`;
    currentMap.set(key, c);
  }

  for (const base of baseline) {
    const key = `${base.provider}:${base.consumer}:${base.endpoint}`;
    const curr = currentMap.get(key);

    if (!curr) {
      // Endpoint removed
      breaks.push({
        type: 'endpoint_removed',
        severity: 'blocker',
        endpoint: base.endpoint,
        provider: base.provider,
        consumer: base.consumer,
        description: `Contract "${base.endpoint}" from ${base.provider} to ${base.consumer} was removed. Consumer ${base.consumer} will break.`,
      });
      continue;
    }

    // Check response/payload changes
    const baseSchema = base.response || base.payload || base.proto || '';
    const currSchema = curr.response || curr.payload || curr.proto || '';

    if (baseSchema && currSchema && baseSchema !== currSchema) {
      // Detect field removal (rough check: baseline fields not in current)
      const baseFields = extractFields(baseSchema);
      const currFields = extractFields(currSchema);
      const removedFields = baseFields.filter(f => !currFields.includes(f));

      if (removedFields.length > 0) {
        breaks.push({
          type: 'response_changed',
          severity: 'blocker',
          endpoint: base.endpoint,
          provider: base.provider,
          consumer: base.consumer,
          description: `Response schema changed for "${base.endpoint}". Removed fields: ${removedFields.join(', ')}. Consumer ${base.consumer} may break.`,
          removedFields,
        });
      }
    }

    // Check status codes narrowing
    if (base.statusCodes && curr.statusCodes && base.statusCodes !== curr.statusCodes) {
      breaks.push({
        type: 'status_codes_changed',
        severity: 'warning',
        endpoint: base.endpoint,
        provider: base.provider,
        consumer: base.consumer,
        description: `Status codes changed for "${base.endpoint}" from [${base.statusCodes}] to [${curr.statusCodes}].`,
      });
    }
  }

  return breaks;
}

/**
 * Extract field names from a schema string like "{ id: string, email: string, name: string }"
 */
function extractFields(schema) {
  const matches = schema.match(/(\w+)\s*[,:]/g);
  if (!matches) return [];
  return matches.map(m => m.replace(/[,:]/g, '').trim()).filter(Boolean);
}

// ============================================================
// Baseline Management
// ============================================================

function saveContractBaseline(cwd, contractsList) {
  const baselinePath = path.join(cwd, '.forge-system', 'contract-baseline.json');
  const dir = path.dirname(baselinePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    contracts: contractsList,
  }, null, 2) + '\n');
}

function loadContractBaseline(cwd) {
  const baselinePath = path.join(cwd, '.forge-system', 'contract-baseline.json');
  if (!fs.existsSync(baselinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch { return null; }
}

// ============================================================
// Main Verification
// ============================================================

/**
 * Verify contracts between services.
 *
 * @param {string} cwd - System root (where .forge-system/ lives)
 * @param {object} opts
 * @param {boolean} opts.saveBaseline - Save current as baseline
 * @param {boolean} opts.json - JSON output
 * @returns {{ passed, skipped, breakingChanges[], contracts[], summary }}
 */
function verifyContracts(cwd, opts = {}) {
  const registryPath = path.join(cwd, '.forge-system', 'CONTRACT-REGISTRY.md');

  if (!fs.existsSync(registryPath)) {
    return {
      passed: true,
      skipped: true,
      reason: 'No CONTRACT-REGISTRY.md found at ' + registryPath,
      breakingChanges: [],
      contracts: [],
      summary: { total: 0, breaking: 0, warnings: 0 },
    };
  }

  const content = fs.readFileSync(registryPath, 'utf8');
  const currentContracts = parseContractRegistry(content);

  if (opts.saveBaseline) {
    saveContractBaseline(cwd, currentContracts);
  }

  // Compare against baseline if it exists
  const baseline = loadContractBaseline(cwd);
  let breakingChanges = [];

  if (baseline && baseline.contracts) {
    breakingChanges = detectBreakingChanges(baseline.contracts, currentContracts);
  }

  const blockers = breakingChanges.filter(b => b.severity === 'blocker');
  const warnings = breakingChanges.filter(b => b.severity === 'warning');

  return {
    passed: blockers.length === 0,
    skipped: false,
    breakingChanges,
    contracts: currentContracts,
    summary: {
      total: currentContracts.length,
      breaking: blockers.length,
      warnings: warnings.length,
    },
  };
}

/**
 * Format contract verification results as markdown.
 */
function formatContractReport(result) {
  const lines = [];
  lines.push('## Contract Verification');
  lines.push('');

  if (result.skipped) {
    lines.push('_Skipped: ' + result.reason + '_');
    return lines.join('\n');
  }

  lines.push(`**Contracts:** ${result.summary.total} | **Breaking:** ${result.summary.breaking} | **Warnings:** ${result.summary.warnings}`);
  lines.push(`**Status:** ${result.passed ? '✅ PASS' : '❌ FAIL'}`);

  if (result.breakingChanges.length > 0) {
    lines.push('');
    lines.push('| Type | Endpoint | Provider → Consumer | Severity |');
    lines.push('|------|---------|-------------------|----------|');
    for (const b of result.breakingChanges) {
      lines.push(`| ${b.type} | ${b.endpoint} | ${b.provider} → ${b.consumer} | ${b.severity} |`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  parseContractRegistry,
  detectBreakingChanges,
  extractFields,
  verifyContracts,
  saveContractBaseline,
  loadContractBaseline,
  formatContractReport,
};
