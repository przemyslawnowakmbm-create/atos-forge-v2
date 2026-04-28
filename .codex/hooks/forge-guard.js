#!/usr/bin/env node
// PreToolUse Guard Hook — Feature 6
// Blocks writes to .env* files, hash-locked test files, and content with hardcoded secrets.
//
// Protocol:
//   stdin:  { tool_name, tool_input: { file_path, content, old_string, new_string }, cwd }
//   stdout: { decision: "allow"|"block", reason?: string }
//
// Fail-open: any error or timeout results in "allow" to avoid blocking the agent.

const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}/i,
  /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/i,
  /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*['"][A-Z0-9]{16,}/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/,
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/,
];

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function isEnvFile(filePath) {
  if (!filePath) return false;
  const base = path.basename(filePath);
  return /^\.env/.test(base);
}

function loadHashLocks(cwd) {
  try {
    const lockPath = path.join(cwd, '.forge', 'hash-locks.json');
    const data = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function isHashLocked(filePath, cwd) {
  if (!filePath || !cwd) return false;
  const locks = loadHashLocks(cwd);
  const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  // locks is keyed by task ID, each value is an array of { type, path, sha256 }
  for (const entries of Object.values(locks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.type === 'test_file' && (entry.path === rel || entry.path === filePath)) {
        return true;
      }
    }
  }
  return false;
}

function containsSecret(text) {
  if (!text) return false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// --- Main ---

let input = '';
const stdinTimeout = setTimeout(() => {
  // 4-second safety: if no input arrives, fail-closed for safety
  block('Guard hook timed out waiting for input — blocking for safety');
}, 4000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;
    const toolInput = data.tool_input || {};
    const cwd = data.cwd || process.cwd();

    // Only guard Write and Edit tools
    if (toolName !== 'Write' && toolName !== 'Edit') {
      return allow();
    }

    const filePath = toolInput.file_path || '';

    // 1. Block writes to .env* files
    if (isEnvFile(filePath)) {
      return block(`Blocked: writing to env file "${path.basename(filePath)}" is not allowed.`);
    }

    // 2. Block writes to hash-locked files
    if (isHashLocked(filePath, cwd)) {
      return block(`Blocked: file "${path.basename(filePath)}" is hash-locked in .forge/hash-locks.json.`);
    }

    // 3. Check content for hardcoded secrets
    let contentToCheck = '';
    if (toolName === 'Write') {
      contentToCheck = toolInput.content || '';
    } else if (toolName === 'Edit') {
      // Only check new_string — old_string is existing content
      contentToCheck = toolInput.new_string || '';
    }

    if (containsSecret(contentToCheck)) {
      return block('Blocked: content contains a hardcoded secret or credential pattern.');
    }

    // All checks passed
    allow();
  } catch (e) {
    // Fail-closed on any error for safety
    block('Guard hook error: ' + (e.message || 'unknown') + ' — blocking for safety');
  }
});

process.stdin.on('error', (err) => {
  clearTimeout(stdinTimeout);
  block('Guard hook stdin error: ' + (err.message || 'unknown') + ' — blocking for safety');
});
