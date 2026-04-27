#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_START = '# --- Forge Graph Auto-Update (start) ---';
const MARKER_END = '# --- Forge Graph Auto-Update (end) ---';

/**
 * Generate the hook snippet that runs the updater in the background.
 */
function generateHookSnippet(forgeGraphDir) {
  // Resolve path to updater.js relative to where it's installed
  const updaterPath = path.resolve(forgeGraphDir, 'updater.js');
  return [
    MARKER_START,
    '# Auto-update the Forge code graph after each commit.',
    '# To disable: set "auto_update_graph": false in .forge/config.json',
    `FORGE_CONFIG="\${GIT_DIR}/../.forge/config.json"`,
    'if [ -f "$FORGE_CONFIG" ]; then',
    '  DISABLED=$(node -e "try{const c=require(\'$FORGE_CONFIG\');process.stdout.write(String(c.auto_update_graph===false))}catch{process.stdout.write(\'false\')}" 2>/dev/null)',
    '  if [ "$DISABLED" = "true" ]; then',
    `    exit 0`,
    '  fi',
    'fi',
    `( node "${updaterPath}" "$(git rev-parse --show-toplevel)" > /dev/null 2>&1 & )`,
    MARKER_END,
  ].join('\n');
}

/**
 * Install the post-commit hook into a repository.
 */
function install(repoRoot) {
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    console.error(`  Error: ${repoRoot} is not a git repository (no .git directory).`);
    process.exit(1);
  }

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, 'post-commit');
  const forgeGraphDir = __dirname;
  const snippet = generateHookSnippet(forgeGraphDir);

  let existing = '';
  if (fs.existsSync(hookPath)) {
    existing = fs.readFileSync(hookPath, 'utf8');
  }

  // Check if our block already exists — replace it
  if (existing.includes(MARKER_START)) {
    const regex = new RegExp(
      escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END),
      'g'
    );
    existing = existing.replace(regex, snippet);
    fs.writeFileSync(hookPath, existing, { mode: 0o755 });
    console.log(`  Updated Forge hook in ${hookPath}`);
  } else {
    // Append our block
    let content = existing;
    if (!content) {
      content = '#!/bin/sh\n';
    }
    if (!content.endsWith('\n')) content += '\n';
    content += '\n' + snippet + '\n';
    fs.writeFileSync(hookPath, content, { mode: 0o755 });
    console.log(`  Installed Forge hook in ${hookPath}`);
  }
}

/**
 * Uninstall the post-commit hook (remove only the Forge block).
 */
function uninstall(repoRoot) {
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  if (!fs.existsSync(hookPath)) {
    console.log('  No post-commit hook found. Nothing to uninstall.');
    return;
  }

  let content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(MARKER_START)) {
    console.log('  No Forge hook block found. Nothing to uninstall.');
    return;
  }

  const regex = new RegExp(
    '\\n?' + escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END) + '\\n?',
    'g'
  );
  content = content.replace(regex, '\n');

  // If only shebang + whitespace remains, remove the file entirely
  if (content.replace(/^#!.*\n?/, '').trim() === '') {
    fs.unlinkSync(hookPath);
    console.log(`  Removed empty post-commit hook: ${hookPath}`);
  } else {
    fs.writeFileSync(hookPath, content, { mode: 0o755 });
    console.log(`  Removed Forge block from ${hookPath}`);
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// CLI Entry Point
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(args.find(a => !a.startsWith('--')) || process.cwd());

  if (args.includes('--uninstall')) {
    uninstall(repoRoot);
  } else {
    // Check .forge/config.json for opt-out at install time
    const configPath = path.join(repoRoot, '.forge', 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.auto_update_graph === false) {
          console.log('  Auto-update disabled in .forge/config.json. Skipping hook installation.');
          console.log('  Set "auto_update_graph": true (or remove the key) to enable.');
          process.exit(0);
        }
      } catch {
        // Ignore parse errors
      }
    }
    install(repoRoot);
  }
}

module.exports = { install, uninstall };
