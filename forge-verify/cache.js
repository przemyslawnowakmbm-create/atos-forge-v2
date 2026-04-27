'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_TTL_MS = 120000; // 2 minutes

function cacheDir(cwd) { return path.join(cwd, '.forge', 'cache'); }

function cacheKey(layer, files, cwd) {
  const hasher = crypto.createHash('sha256');
  hasher.update(layer);
  for (const f of (files || []).sort()) {
    const fullPath = path.resolve(cwd, f);
    if (fs.existsSync(fullPath)) {
      hasher.update(f + ':' + crypto.createHash('md5').update(fs.readFileSync(fullPath)).digest('hex'));
    } else {
      hasher.update(f + ':missing');
    }
  }
  return hasher.digest('hex').slice(0, 16);
}

function get(layer, files, cwd) {
  try {
    const key = cacheKey(layer, files, cwd);
    const cachePath = path.join(cacheDir(cwd), `${layer}-${key}.json`);
    if (!fs.existsSync(cachePath)) return null;
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return cached.result;
  } catch { return null; }
}

function set(layer, files, cwd, result) {
  try {
    const dir = cacheDir(cwd);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const key = cacheKey(layer, files, cwd);
    fs.writeFileSync(path.join(dir, `${layer}-${key}.json`), JSON.stringify({ timestamp: Date.now(), result }));
  } catch { /* silent */ }
}

function invalidate(cwd) {
  try {
    const dir = cacheDir(cwd);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* silent */ }
}

module.exports = { get, set, invalidate, cacheKey };
