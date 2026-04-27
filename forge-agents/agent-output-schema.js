'use strict';

/**
 * Agent Output Schema — structured JSON output from agents
 * Parsed from stdout after agent execution.
 */

const AGENT_OUTPUT_SCHEMA = {
  findings: [{ type: 'string', file: 'string', line: 'number', description: 'string', severity: 'string' }],
  decisions_made: [{ text: 'string', rationale: 'string' }],
  files_created: ['string'],
  files_modified: ['string'],
  files_not_touched: ['string'],
  confidence: 'number',
};

function parseAgentOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  // Strip Claude Code's [rerun: bN] footer from persisted Bash tool outputs
  const cleaned = stdout.replace(/\n?\[rerun: b\d+\]\s*$/g, '');
  // Look for ```json:agent-output ... ``` block
  const match = cleaned.match(/```json:agent-output\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function validateOutput(output) {
  if (!output || typeof output !== 'object') return { valid: false, reason: 'null or non-object output' };
  // Normalize fields
  if (!Array.isArray(output.findings)) output.findings = [];
  if (!Array.isArray(output.decisions_made)) output.decisions_made = [];
  if (!Array.isArray(output.files_created)) output.files_created = [];
  if (!Array.isArray(output.files_modified)) output.files_modified = [];
  if (!Array.isArray(output.files_not_touched)) output.files_not_touched = [];
  if (typeof output.confidence !== 'number' || output.confidence < 0 || output.confidence > 1) {
    output.confidence = 0.5;
  }
  // Validate findings structure
  output.findings = output.findings.filter(f => f && typeof f.description === 'string');
  output.decisions_made = output.decisions_made.filter(d => d && typeof d.text === 'string');
  return { valid: true, output };
}

module.exports = { AGENT_OUTPUT_SCHEMA, parseAgentOutput, validateOutput };
