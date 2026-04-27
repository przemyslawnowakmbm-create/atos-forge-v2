'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Module Detector — Auto-detects module boundaries in a repository.
 *
 * Detection heuristics (in priority order):
 *  1. Directories with their own package.json (monorepo packages)
 *  2. Directories matching known module patterns (src/modules/*, packages/*, etc.)
 *  3. Directories with index.ts/index.js barrel exports
 *  4. Top-level src/ subdirectories as fallback
 */

const MODULE_DIR_PATTERNS = [
  // Monorepo patterns
  /^packages\/([^/]+)/,
  /^apps\/([^/]+)/,
  /^libs\/([^/]+)/,
  /^services\/([^/]+)/,
  // Feature-based patterns
  /^src\/modules\/([^/]+)/,
  /^src\/features\/([^/]+)/,
  /^src\/domains\/([^/]+)/,
  /^src\/apps\/([^/]+)/,
  /^src\/packages\/([^/]+)/,
  // Backend conventions
  /^src\/api\/([^/]+)/,
  /^backend\/src\/([^/]+)/,
  /^server\/src\/([^/]+)/,
  // Frontend conventions
  /^src\/components\/([^/]+)/,
  /^src\/pages\/([^/]+)/,
  /^src\/views\/([^/]+)/,
  /^frontend\/src\/([^/]+)/,
  /^client\/src\/([^/]+)/,
];

const BARREL_FILES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx',
  'index.mjs', 'index.cjs', 'mod.ts', 'mod.js',
  '__init__.py',
];

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  'coverage', '.cache', '.turbo', '.forge', '__pycache__',
  'vendor', 'target', '.idea', '.vscode',
]);

/**
 * Detect all modules in a repository.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string[]} filePaths - All file paths (relative to repoRoot).
 * @returns {{ modules: Map<string, ModuleInfo>, fileModuleMap: Map<string, string> }}
 */
function detectModules(repoRoot, filePaths) {
  const modules = new Map();     // name -> { rootPath, files: Set }
  const fileModuleMap = new Map(); // filePath -> moduleName

  // Phase 1: Find package.json-based modules (strongest signal)
  const packageJsonDirs = findPackageJsonModules(repoRoot, filePaths);
  for (const [name, rootPathRel] of packageJsonDirs) {
    modules.set(name, { rootPath: rootPathRel, files: new Set() });
  }

  // Phase 2: Pattern-based detection for remaining files
  const patternModules = detectPatternModules(filePaths, modules);
  for (const [name, info] of patternModules) {
    if (!modules.has(name)) {
      modules.set(name, info);
    }
  }

  // Phase 3: Barrel-file based detection
  const barrelModules = detectBarrelModules(repoRoot, filePaths, modules);
  for (const [name, info] of barrelModules) {
    if (!modules.has(name)) {
      modules.set(name, info);
    }
  }

  // Phase 4: Fallback — top-level src/ directories
  const fallbackModules = detectFallbackModules(filePaths, modules);
  for (const [name, info] of fallbackModules) {
    if (!modules.has(name)) {
      modules.set(name, info);
    }
  }

  // Phase 5: Assign each file to a module
  for (const filePath of filePaths) {
    let assigned = false;
    // Try longest root path match first (most specific module)
    const sortedModules = [...modules.entries()]
      .sort((a, b) => b[1].rootPath.length - a[1].rootPath.length);

    for (const [modName, modInfo] of sortedModules) {
      if (filePath.startsWith(modInfo.rootPath + '/') || filePath === modInfo.rootPath) {
        fileModuleMap.set(filePath, modName);
        modInfo.files.add(filePath);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      // Root-level files go to a special <root> module
      fileModuleMap.set(filePath, '<root>');
      if (!modules.has('<root>')) {
        modules.set('<root>', { rootPath: '.', files: new Set() });
      }
      modules.get('<root>').files.add(filePath);
    }
  }

  return { modules, fileModuleMap };
}

/**
 * Find modules defined by their own package.json.
 */
function findPackageJsonModules(repoRoot, filePaths) {
  const result = new Map();
  const pkgPaths = filePaths.filter(f => f.endsWith('/package.json') && f !== 'package.json');

  for (const pkgPath of pkgPaths) {
    const dirPath = path.dirname(pkgPath);
    // Skip deeply nested package.json (e.g., node_modules)
    if (dirPath.includes('node_modules')) continue;

    try {
      const fullPath = path.join(repoRoot, pkgPath);
      const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const name = pkg.name || path.basename(dirPath);
      result.set(name, dirPath);
    } catch {
      const name = path.basename(dirPath);
      result.set(name, dirPath);
    }
  }
  return result;
}

/**
 * Detect modules by matching file paths against known patterns.
 */
function detectPatternModules(filePaths, existingModules) {
  const result = new Map();
  const existingRoots = new Set([...existingModules.values()].map(m => m.rootPath));

  for (const filePath of filePaths) {
    for (const pattern of MODULE_DIR_PATTERNS) {
      const match = filePath.match(pattern);
      if (match) {
        const moduleName = match[1];
        const rootPath = filePath.substring(0, match[0].length);
        if (!existingRoots.has(rootPath) && !result.has(moduleName)) {
          result.set(moduleName, { rootPath, files: new Set() });
          existingRoots.add(rootPath);
        }
        break;
      }
    }
  }
  return result;
}

/**
 * Detect modules by the presence of barrel/index files.
 */
function detectBarrelModules(repoRoot, filePaths, existingModules) {
  const result = new Map();
  const existingRoots = new Set([...existingModules.values()].map(m => m.rootPath));

  const barrelDirs = new Set();
  for (const filePath of filePaths) {
    const basename = path.basename(filePath);
    if (BARREL_FILES.includes(basename)) {
      const dirPath = path.dirname(filePath);
      // Only consider directories 2-3 levels deep under src/
      const depth = dirPath.split('/').length;
      if (depth >= 2 && depth <= 4 && !existingRoots.has(dirPath)) {
        barrelDirs.add(dirPath);
      }
    }
  }

  for (const dirPath of barrelDirs) {
    const moduleName = path.basename(dirPath);
    if (!existingModules.has(moduleName) && !result.has(moduleName)) {
      result.set(moduleName, { rootPath: dirPath, files: new Set() });
    }
  }
  return result;
}

/**
 * Fallback: top-level src/ subdirectories.
 */
function detectFallbackModules(filePaths, existingModules) {
  const result = new Map();
  const existingRoots = new Set([...existingModules.values()].map(m => m.rootPath));

  const srcDirs = new Set();
  for (const filePath of filePaths) {
    const match = filePath.match(/^src\/([^/]+)\//);
    if (match) {
      srcDirs.add(match[1]);
    }
  }

  for (const dirName of srcDirs) {
    const rootPath = `src/${dirName}`;
    if (!existingRoots.has(rootPath) && !existingModules.has(dirName) && !result.has(dirName)) {
      result.set(dirName, { rootPath, files: new Set() });
    }
  }
  return result;
}

/**
 * Classify a file within a module as public API or internal.
 * Public: exported from barrel files or explicitly public directories.
 * Internal: everything else.
 */
function classifyFile(filePath, moduleRootPath) {
  const relative = filePath.startsWith(moduleRootPath + '/')
    ? filePath.slice(moduleRootPath.length + 1)
    : filePath;

  const basename = path.basename(filePath);

  // Barrel files are public API
  if (BARREL_FILES.includes(basename)) return 'public';

  // Files directly under module root (not in subdirs) are often public
  if (!relative.includes('/')) return 'public';

  // Internal directories
  const firstDir = relative.split('/')[0];
  const internalDirs = new Set(['internal', 'private', 'utils', 'helpers', 'lib', '__tests__', 'test', 'tests']);
  if (internalDirs.has(firstDir)) return 'internal';

  return 'internal';
}

module.exports = { detectModules, classifyFile, IGNORE_DIRS };
