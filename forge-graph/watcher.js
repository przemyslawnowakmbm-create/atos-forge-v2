'use strict';
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 500;
const IGNORE_PATTERNS = [/node_modules/, /\.git\//, /\.forge\//, /dist\//, /build\//, /\.DS_Store/];
const CODE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.cjs', '.mjs', '.rs', '.rb', '.php'];

function shouldIgnore(filename) {
  return IGNORE_PATTERNS.some(p => p.test(filename));
}

function watch(cwd, opts = {}) {
  const debounceMs = opts.debounce || DEBOUNCE_MS;
  const pending = new Set();
  let timer = null;

  const onRebuild = opts.onRebuild || ((files) => {
    console.log(`[forge-graph] Rebuilding ${files.length} file(s)...`);
    try {
      const updater = require('./updater');
      if (typeof updater.incrementalUpdate === 'function') {
        updater.incrementalUpdate(cwd, files);
      } else if (typeof updater === 'function') {
        updater(cwd);
      }
      console.log('[forge-graph] Rebuild complete.');
    } catch (e) {
      console.error(`[forge-graph] Rebuild failed: ${e.message}`);
    }
  });

  const watcher = fs.watch(cwd, { recursive: true }, (event, filename) => {
    if (!filename || shouldIgnore(filename)) return;
    const ext = path.extname(filename);
    if (!CODE_EXTENSIONS.includes(ext)) return;

    pending.add(filename);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      timer = null;
      onRebuild(files);
    }, debounceMs);
  });

  watcher.pending = pending;
  console.log(`[forge-graph] Watching ${cwd} for changes (debounce: ${debounceMs}ms)`);
  return watcher;
}

function stop(watcher) {
  if (watcher) {
    watcher.close();
    console.log('[forge-graph] Watcher stopped.');
  }
}

module.exports = { watch, stop };
