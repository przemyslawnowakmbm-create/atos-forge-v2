#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { detectModules, classifyFile, IGNORE_DIRS } = require('./module-detector');
const { detectCapabilities } = require('./capability-detector');

// ============================================================
// Configuration (unified config with hardcoded fallbacks)
// ============================================================

function loadGraphConfig(repoRoot) {
  try {
    const config = require('../forge-config/config');
    const { config: effective } = config.loadConfig(repoRoot);
    return effective.graph || {};
  } catch {
    return {};
  }
}

const LANGUAGE_EXTENSIONS = {
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.py':   'python',
  '.java': 'java',
  '.go':   'go',
};

const TEST_PATTERNS = [
  /\.test\./i, /\.spec\./i, /\.e2e\./i, /__tests__\//i,
  /test\//i, /tests\//i, /testing\//i, /_test\.go$/i,
  /test_.*\.py$/i, /.*_test\.py$/i,
];

const CONFIG_PATTERNS = [
  /\.config\./i, /tsconfig/i, /eslint/i, /prettier/i,
  /webpack/i, /vite\.config/i, /jest\.config/i, /next\.config/i,
  /docker/i, /\.env/i, /Dockerfile/i, /Makefile/i,
  /package\.json$/i, /\.ya?ml$/i, /\.toml$/i,
];

const BATCH_SIZE = 500; // Insert batch size for SQLite

// ============================================================
// Tree-sitter Parser Manager
// ============================================================

class ParserManager {
  constructor() {
    this.Parser = null;
    this.parsers = {};
    this.available = {};
    this._initialized = false;
  }

  init() {
    if (this._initialized) return;
    try {
      this.Parser = require('tree-sitter');
    } catch {
      console.warn('  [warn] tree-sitter not available, falling back to regex parsing');
      this._initialized = true;
      return;
    }

    const langMap = {
      javascript: 'tree-sitter-javascript',
      typescript: 'tree-sitter-typescript',
      python:     'tree-sitter-python',
      java:       'tree-sitter-java',
      go:         'tree-sitter-go',
    };

    for (const [lang, pkg] of Object.entries(langMap)) {
      try {
        const langModule = require(pkg);
        const parser = new this.Parser();
        // tree-sitter-typescript exports { typescript, tsx }
        if (lang === 'typescript') {
          parser.setLanguage(langModule.typescript);
          this.parsers[lang] = parser;
          // Also create a TSX parser
          const tsxParser = new this.Parser();
          tsxParser.setLanguage(langModule.tsx);
          this.parsers['tsx'] = tsxParser;
        } else {
          parser.setLanguage(langModule);
          this.parsers[lang] = parser;
        }
        this.available[lang] = true;
      } catch {
        this.available[lang] = false;
      }
    }
    this._initialized = true;
  }

  getParser(language, filePath) {
    if (!this.Parser) return null;
    if (language === 'typescript' && (filePath.endsWith('.tsx') || filePath.endsWith('.jsx'))) {
      return this.parsers['tsx'] || null;
    }
    return this.parsers[language] || null;
  }

  hasParser(language) {
    return !!this.available[language];
  }
}

// ============================================================
// AST-based Symbol & Import Extraction
// ============================================================

/**
 * Extract symbols and imports from a file using tree-sitter.
 */
function extractFromAST(tree, language, source) {
  const symbols = [];
  const imports = [];

  const cursor = tree.walk();
  walkTree(cursor, tree.rootNode, language, symbols, imports, source);

  return { symbols, imports };
}

function walkTree(cursor, node, language, symbols, imports, source) {
  switch (language) {
    case 'typescript':
    case 'javascript':
      extractJS(node, symbols, imports, source);
      break;
    case 'python':
      extractPython(node, symbols, imports, source);
      break;
    case 'java':
      extractJava(node, symbols, imports, source);
      break;
    case 'go':
      extractGo(node, symbols, imports, source);
      break;
  }
}

// --- JavaScript / TypeScript extraction ---

function extractJS(node, symbols, imports, source) {
  visitNodeJS(node, symbols, imports, source, false);
}

function visitNodeJS(node, symbols, imports, source, isExported) {
  const type = node.type;

  // Track export context
  if (type === 'export_statement' || type === 'export_default_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      visitNodeJS(node.child(i), symbols, imports, source, true);
    }
    return;
  }

  // Function declarations
  if (type === 'function_declaration' || type === 'generator_function_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: extractJSSignature(node, source),
      });
    }
  }

  // Arrow functions / function expressions assigned to const/let/var
  if (type === 'lexical_declaration' || type === 'variable_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        if (nameNode && valueNode) {
          const isFunc = valueNode.type === 'arrow_function' || valueNode.type === 'function_expression';
          const isComponent = nameNode.text[0] === nameNode.text[0].toUpperCase()
            && nameNode.text[0] !== '_' && isFunc;
          symbols.push({
            name: nameNode.text,
            kind: isComponent ? 'component' : (isFunc ? 'function' : 'const'),
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            exported: isExported,
            signature: isFunc ? extractJSSignature(valueNode, source) : null,
          });
        }
      }
    }
  }

  // Class declarations
  if (type === 'class_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: null,
      });
    }
  }

  // TypeScript: interface_declaration, type_alias_declaration, enum_declaration
  if (type === 'interface_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'interface',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: null,
      });
    }
  }
  if (type === 'type_alias_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'type',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: null,
      });
    }
  }
  if (type === 'enum_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'enum',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: null,
      });
    }
  }

  // Import statements
  if (type === 'import_statement') {
    const sourceNode = node.childForFieldName('source');
    if (sourceNode) {
      const importPath = sourceNode.text.replace(/['"]/g, '');
      // Determine import type
      const text = node.text;
      let importType = 'named';
      if (text.includes('* as')) importType = 'namespace';
      else if (/import\s+\w+\s+from/.test(text) && !text.includes('{')) importType = 'default';

      imports.push({ name: importPath, type: importType });
    }
  }

  // Dynamic imports: import('...')
  if (type === 'call_expression') {
    const func = node.child(0);
    if (func && func.type === 'import') {
      const args = node.child(1);
      if (args && args.childCount > 0) {
        const arg = args.child(0) || args.child(1);
        if (arg && arg.type === 'string') {
          imports.push({ name: arg.text.replace(/['"]/g, ''), type: 'dynamic' });
        }
      }
    }
  }

  // require() calls
  if (type === 'call_expression') {
    const func = node.child(0);
    if (func && func.text === 'require' && node.childCount >= 2) {
      const args = node.child(1);
      if (args) {
        for (let i = 0; i < args.childCount; i++) {
          const arg = args.child(i);
          if (arg && (arg.type === 'string' || arg.type === 'template_string')) {
            imports.push({ name: arg.text.replace(/['"]/g, ''), type: 'require' });
          }
        }
      }
    }
  }

  // Recurse children (for non-export nodes)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== 'export_statement' && child.type !== 'export_default_declaration') {
      visitNodeJS(child, symbols, imports, source, false);
    }
  }
}

function extractJSSignature(node, source) {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  if (params) {
    let sig = params.text;
    if (returnType) sig += ': ' + returnType.text;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }
  return null;
}

// --- Python extraction ---

function extractPython(node, symbols, imports, source) {
  visitNodePython(node, symbols, imports);
}

function visitNodePython(node, symbols, imports) {
  const type = node.type;

  if (type === 'function_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const isExported = !nameNode.text.startsWith('_');
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: extractPythonSignature(node),
      });
    }
  }

  if (type === 'class_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: !nameNode.text.startsWith('_'),
        signature: null,
      });
    }
  }

  if (type === 'import_statement' || type === 'import_from_statement') {
    const text = node.text;
    const match = text.match(/(?:from\s+(\S+)\s+import|import\s+(\S+))/);
    if (match) {
      imports.push({
        name: match[1] || match[2],
        type: text.startsWith('from') ? 'named' : 'namespace',
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    visitNodePython(node.child(i), symbols, imports);
  }
}

function extractPythonSignature(node) {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  if (params) {
    let sig = params.text;
    if (returnType) sig += ' -> ' + returnType.text;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }
  return null;
}

// --- Java extraction ---

function extractJava(node, symbols, imports, source) {
  visitNodeJava(node, symbols, imports);
}

function visitNodeJava(node, symbols, imports) {
  const type = node.type;

  if (type === 'method_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const modifiers = node.childForFieldName('modifiers');
      const isPublic = modifiers ? modifiers.text.includes('public') : false;
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isPublic,
        signature: extractJavaSignature(node),
      });
    }
  }

  if (type === 'class_declaration' || type === 'interface_declaration' || type === 'enum_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const kind = type === 'interface_declaration' ? 'interface' :
                   type === 'enum_declaration' ? 'enum' : 'class';
      symbols.push({
        name: nameNode.text,
        kind,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: true,
        signature: null,
      });
    }
  }

  if (type === 'import_declaration') {
    const text = node.text.replace(/^import\s+/, '').replace(/;\s*$/, '');
    imports.push({ name: text, type: 'named' });
  }

  for (let i = 0; i < node.childCount; i++) {
    visitNodeJava(node.child(i), symbols, imports);
  }
}

function extractJavaSignature(node) {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('type');
  if (params) {
    let sig = params.text;
    if (returnType) sig = returnType.text + ' ' + sig;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }
  return null;
}

// --- Go extraction ---

function extractGo(node, symbols, imports, source) {
  visitNodeGo(node, symbols, imports);
}

function visitNodeGo(node, symbols, imports) {
  const type = node.type;

  if (type === 'function_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const isExported = nameNode.text[0] === nameNode.text[0].toUpperCase();
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: extractGoSignature(node),
      });
    }
  }

  if (type === 'method_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const isExported = nameNode.text[0] === nameNode.text[0].toUpperCase();
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        exported: isExported,
        signature: extractGoSignature(node),
      });
    }
  }

  if (type === 'type_declaration') {
    const spec = node.child(1); // type_spec
    if (spec) {
      const nameNode = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      if (nameNode) {
        const kind = typeNode && typeNode.type === 'interface_type' ? 'interface' :
                     typeNode && typeNode.type === 'struct_type' ? 'class' : 'type';
        const isExported = nameNode.text[0] === nameNode.text[0].toUpperCase();
        symbols.push({
          name: nameNode.text,
          kind,
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          exported: isExported,
          signature: null,
        });
      }
    }
  }

  if (type === 'import_declaration') {
    // Go imports can be single or grouped
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'import_spec' || child.type === 'interpreted_string_literal') {
        const importPath = child.text.replace(/['"]/g, '');
        imports.push({ name: importPath, type: 'named' });
      }
      if (child.type === 'import_spec_list') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec.type === 'import_spec') {
            const pathNode = spec.childForFieldName('path');
            if (pathNode) {
              imports.push({ name: pathNode.text.replace(/['"]/g, ''), type: 'named' });
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    visitNodeGo(node.child(i), symbols, imports);
  }
}

function extractGoSignature(node) {
  const params = node.childForFieldName('parameters');
  const result = node.childForFieldName('result');
  if (params) {
    let sig = params.text;
    if (result) sig += ' ' + result.text;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }
  return null;
}

// ============================================================
// Regex Fallback Extraction (when tree-sitter unavailable)
// ============================================================

function extractWithRegex(source, language) {
  const symbols = [];
  const imports = [];
  const lines = source.split('\n');

  if (language === 'javascript' || language === 'typescript') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Exports
      const exportFunc = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (exportFunc) {
        symbols.push({ name: exportFunc[1], kind: 'function', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      const exportClass = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (exportClass) {
        symbols.push({ name: exportClass[1], kind: 'class', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      const exportConst = line.match(/^export\s+const\s+(\w+)/);
      if (exportConst) {
        symbols.push({ name: exportConst[1], kind: 'const', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      const exportInterface = line.match(/^export\s+interface\s+(\w+)/);
      if (exportInterface) {
        symbols.push({ name: exportInterface[1], kind: 'interface', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      const exportType = line.match(/^export\s+type\s+(\w+)/);
      if (exportType) {
        symbols.push({ name: exportType[1], kind: 'type', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      const exportEnum = line.match(/^export\s+enum\s+(\w+)/);
      if (exportEnum) {
        symbols.push({ name: exportEnum[1], kind: 'enum', line_start: i + 1, line_end: i + 1, exported: true, signature: null });
      }
      // Non-exported
      const funcDecl = line.match(/^(?:async\s+)?function\s+(\w+)/);
      if (funcDecl && !line.startsWith('export')) {
        symbols.push({ name: funcDecl[1], kind: 'function', line_start: i + 1, line_end: i + 1, exported: false, signature: null });
      }
      const classDecl = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (classDecl && !line.startsWith('export')) {
        symbols.push({ name: classDecl[1], kind: 'class', line_start: i + 1, line_end: i + 1, exported: false, signature: null });
      }
      // Imports
      const importMatch = line.match(/import\s+.*?from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const importType = line.includes('* as') ? 'namespace' : line.includes('{') ? 'named' : 'default';
        imports.push({ name: importMatch[1], type: importType });
      }
      const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (requireMatch) {
        imports.push({ name: requireMatch[1], type: 'require' });
      }
    }
  } else if (language === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
      if (funcMatch) {
        symbols.push({ name: funcMatch[1], kind: 'function', line_start: i + 1, line_end: i + 1, exported: !funcMatch[1].startsWith('_'), signature: null });
      }
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line_start: i + 1, line_end: i + 1, exported: !classMatch[1].startsWith('_'), signature: null });
      }
      const importMatch = line.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
      if (importMatch) {
        imports.push({ name: importMatch[1] || importMatch[2], type: line.startsWith('from') ? 'named' : 'namespace' });
      }
    }
  }

  return { symbols, imports };
}

// ============================================================
// Complexity Estimation
// ============================================================

/**
 * Approximate cyclomatic complexity from source code.
 * Counts decision points: if, else if, while, for, case, catch, &&, ||, ternary.
 */
function estimateComplexity(source, language) {
  let complexity = 1; // Base complexity
  const patterns = [
    /\bif\b/g, /\belse\s+if\b/g, /\bwhile\b/g, /\bfor\b/g,
    /\bcase\b/g, /\bcatch\b/g, /\?\s*[^:]/g, /&&/g, /\|\|/g,
  ];
  if (language === 'python') {
    patterns.push(/\belif\b/g, /\bexcept\b/g);
  }
  for (const pattern of patterns) {
    const matches = source.match(pattern);
    if (matches) complexity += matches.length;
  }
  return complexity;
}

// ============================================================
// Import Resolution
// ============================================================

/**
 * Resolve an import path to an actual file path in the repo.
 * Handles: relative (./foo), @/ alias, Python absolute (app.models.ticket),
 * and bare path heuristics.
 */
function resolveImport(importName, sourceFile, allFilePaths) {
  const fileSet = allFilePaths instanceof Set ? allFilePaths : new Set(allFilePaths);
  const sourceDir = path.dirname(sourceFile);
  const exts = Object.keys(LANGUAGE_EXTENSIONS);

  // Try a resolved base path with extension/index candidates
  function tryResolve(base) {
    const candidates = [
      base,
      ...exts.map(ext => base + ext),
      ...exts.map(ext => base + '/index' + ext),
    ];
    for (const c of candidates) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  // 1. Relative imports: ./foo, ../bar
  if (importName.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(sourceDir, importName));
    return tryResolve(resolved);
  }

  // 2. @/ alias — try common prefixes: src/, frontend/src/, client/src/, etc.
  if (importName.startsWith('@/')) {
    const tail = importName.slice(2);
    // Try direct src/ first
    const direct = tryResolve('src/' + tail);
    if (direct) return direct;
    // Try with common frontend prefixes
    for (const prefix of ['frontend/src/', 'client/src/', 'web/src/', 'app/src/']) {
      const result = tryResolve(prefix + tail);
      if (result) return result;
    }
    return null;
  }

  // 3. Python absolute imports: from app.models.ticket import Ticket
  //    importName comes in as "app.models.ticket" or "app.database"
  if (importName.includes('.') && !importName.startsWith('/')) {
    const asDotPath = importName.replace(/\./g, '/');
    // Try direct (e.g., app/models/ticket.py)
    const direct = tryResolve(asDotPath);
    if (direct) return direct;
    // Try with backend/ prefix (common in full-stack repos)
    for (const prefix of ['backend/', 'server/', 'api/', '']) {
      const result = tryResolve(prefix + asDotPath);
      if (result) return result;
      // Also try as package __init__.py
      const initResult = tryResolve(prefix + asDotPath + '/__init__');
      if (initResult) return initResult;
    }
    return null;
  }

  // 4. Absolute path
  if (importName.startsWith('/')) {
    return tryResolve(importName);
  }

  // 5. Bare name heuristic — could be a local module (e.g., "utils", "config")
  //    Only try if it could plausibly be a project file (not an npm package)
  //    Skip if it looks like an npm package (no slash, lowercase, common package names)
  if (importName.includes('/')) {
    // Scoped-ish path like "components/Button" — try from source root contexts
    const fromRoot = tryResolve(importName);
    if (fromRoot) return fromRoot;
    for (const prefix of ['src/', 'frontend/src/', 'backend/']) {
      const result = tryResolve(prefix + importName);
      if (result) return result;
    }
  }

  return null;
}

// ============================================================
// Git Analysis
// ============================================================

function getGitChangeFrequency(repoRoot) {
  const result = {};
  const now = new Date();
  const periods = [
    { key: 'changes_7d',  days: 7 },
    { key: 'changes_30d', days: 30 },
    { key: 'changes_90d', days: 90 },
  ];

  for (const { key, days } of periods) {
    const since = new Date(now - days * 86400000).toISOString().split('T')[0];
    try {
      const output = execSync(
        `git log --since="${since}" --name-only --pretty=format: -- .`,
        { cwd: repoRoot, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const files = output.split('\n').filter(Boolean);
      for (const file of files) {
        if (!result[file]) result[file] = { changes_7d: 0, changes_30d: 0, changes_90d: 0, last_changed: null, top_changers: [] };
        result[file][key]++;
      }
    } catch {
      // Not a git repo or git not available
    }
  }

  // Get last changed date and top changers
  try {
    const output = execSync(
      `git log --pretty=format:"%an|||%ai|||%H" --name-only -- .`,
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const lines = output.split('\n');
    let currentAuthor = null;
    let currentDate = null;

    for (const line of lines) {
      if (line.includes('|||')) {
        const parts = line.split('|||');
        currentAuthor = parts[0];
        currentDate = parts[1];
      } else if (line.trim() && currentAuthor) {
        const file = line.trim();
        if (!result[file]) result[file] = { changes_7d: 0, changes_30d: 0, changes_90d: 0, last_changed: null, top_changers: [] };
        if (!result[file].last_changed) {
          result[file].last_changed = currentDate.split(' ')[0];
        }
        if (!result[file].top_changers.includes(currentAuthor)) {
          result[file].top_changers.push(currentAuthor);
        }
      }
    }
  } catch {
    // Ignore
  }

  // Limit top_changers to 5
  for (const file of Object.keys(result)) {
    result[file].top_changers = result[file].top_changers.slice(0, 5);
  }

  return result;
}

function getFileLastModified(repoRoot, filePath) {
  try {
    const output = execSync(
      `git log -1 --format=%aI -- "${filePath}"`,
      { cwd: repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim().split('T')[0] || null;
  } catch {
    return null;
  }
}

// ============================================================
// File Discovery
// ============================================================

function discoverFiles(repoRoot, graphConfig = {}) {
  const files = [];

  // Merge config ignore_patterns with hardcoded IGNORE_DIRS
  const ignoreSet = new Set(IGNORE_DIRS);
  if (Array.isArray(graphConfig.ignore_patterns)) {
    for (const p of graphConfig.ignore_patterns) ignoreSet.add(p);
  }

  // Build allowed language extensions from config + defaults
  let langExts = LANGUAGE_EXTENSIONS;
  if (Array.isArray(graphConfig.languages) && graphConfig.languages.length > 0) {
    langExts = {};
    for (const [ext, lang] of Object.entries(LANGUAGE_EXTENSIONS)) {
      if (graphConfig.languages.includes(lang)) langExts[ext] = lang;
    }
  }

  function walk(dir, relative) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignoreSet.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (langExts[ext]) {
          files.push(relPath);
        }
      }
    }
  }

  walk(repoRoot, '');
  return files;
}

// ============================================================
// Main Builder
// ============================================================

class GraphBuilder {
  constructor(repoRoot, dbPath) {
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = dbPath || path.join(this.repoRoot, '.forge', 'graph.db');
    this.db = null;
    this.parserMgr = new ParserManager();
    this.stats = { files: 0, symbols: 0, dependencies: 0, modules: 0, parseErrors: 0 };
    this.graphConfig = loadGraphConfig(this.repoRoot);
  }

  build() {
    const startTime = Date.now();
    console.log(`\n  Forge Graph Engine — Building code graph`);
    console.log(`  Repository: ${this.repoRoot}\n`);

    // 1. Initialize
    this.initDatabase();
    this.parserMgr.init();
    this.reportParserStatus();

    // 2. Discover files (using config for ignore_patterns and languages)
    process.stdout.write('  [1/7] Discovering files... ');
    const filePaths = discoverFiles(this.repoRoot, this.graphConfig);
    console.log(`${filePaths.length} files found`);

    if (filePaths.length === 0) {
      console.log('  No source files found. Exiting.\n');
      this.finalize(startTime);
      return;
    }

    // 3. Detect modules (respects graph.module_detection config)
    process.stdout.write('  [2/7] Detecting modules... ');
    let modules, fileModuleMap;
    if (this.graphConfig.module_detection === false) {
      modules = new Map();
      fileModuleMap = new Map();
      console.log('skipped (disabled in config)');
    } else {
      ({ modules, fileModuleMap } = detectModules(this.repoRoot, filePaths));
      console.log(`${modules.size} modules detected`);
    }

    // 4. Parse files and extract symbols/imports
    process.stdout.write(`  [3/7] Parsing ${filePaths.length} files...\n`);
    const fileData = this.parseAllFiles(filePaths, fileModuleMap);

    // 5. Resolve dependencies
    process.stdout.write('  [4/7] Resolving dependencies... ');
    const dependencies = this.resolveDependencies(fileData, filePaths);
    console.log(`${dependencies.length} edges`);

    // 6. Git analysis
    process.stdout.write('  [5/7] Analyzing git history... ');
    const changeFreq = getGitChangeFrequency(this.repoRoot);
    console.log(`${Object.keys(changeFreq).length} files with history`);

    // 7. Compute module stats & capabilities
    process.stdout.write('  [6/7] Computing module stats... ');
    this.computeModuleStats(modules, fileData, dependencies, changeFreq);
    console.log('done');

    // 8. Write to database
    process.stdout.write('  [7/7] Writing to database... ');
    this.writeDatabase(fileData, dependencies, modules, fileModuleMap, changeFreq);
    console.log('done');

    // 9. Extract call graph, class hierarchy, and detect dead code
    try { this.extractCallGraph(fileData); } catch { /* non-critical */ }
    try { this.extractClassHierarchy(fileData); } catch { /* non-critical */ }
    try { this.detectDeadCode(); } catch { /* non-critical */ }

    this.finalize(startTime);
  }

  initDatabase() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);

    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
  }

  reportParserStatus() {
    const langs = ['javascript', 'typescript', 'python', 'java', 'go'];
    const available = langs.filter(l => this.parserMgr.hasParser(l));
    const missing = langs.filter(l => !this.parserMgr.hasParser(l));
    if (available.length > 0) {
      console.log(`  Parsers: ${available.join(', ')}`);
    }
    if (missing.length > 0) {
      console.log(`  Fallback (regex): ${missing.join(', ')}`);
    }
    console.log('');
  }

  parseAllFiles(filePaths, fileModuleMap) {
    const fileData = new Map();
    let processed = 0;
    const total = filePaths.length;
    const progressInterval = Math.max(Math.floor(total / 20), 1);

    for (const filePath of filePaths) {
      processed++;
      if (processed % progressInterval === 0 || processed === total) {
        const pct = Math.round((processed / total) * 100);
        process.stdout.write(`\r  [3/7] Parsing ${filePaths.length} files... ${pct}%`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const language = LANGUAGE_EXTENSIONS[ext];
      if (!language) continue;

      const fullPath = path.join(this.repoRoot, filePath);
      let source;
      try {
        source = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      const loc = source.split('\n').length;
      const complexity = estimateComplexity(source, language);
      const isTest = TEST_PATTERNS.some(p => p.test(filePath));
      const isConfig = CONFIG_PATTERNS.some(p => p.test(filePath));
      const moduleName = fileModuleMap.get(filePath) || '<root>';

      let symbols = [];
      let imports = [];

      // Try tree-sitter first, fall back to regex
      const parser = this.parserMgr.getParser(language, filePath);
      if (parser) {
        try {
          const tree = parser.parse(source);
          const extracted = extractFromAST(tree, language, source);
          symbols = extracted.symbols;
          imports = extracted.imports;
        } catch {
          this.stats.parseErrors++;
          const extracted = extractWithRegex(source, language);
          symbols = extracted.symbols;
          imports = extracted.imports;
        }
      } else {
        const extracted = extractWithRegex(source, language);
        symbols = extracted.symbols;
        imports = extracted.imports;
      }

      this.stats.files++;
      this.stats.symbols += symbols.length;

      fileData.set(filePath, {
        language, loc, complexity, isTest, isConfig, moduleName,
        symbols, imports,
        lastModified: null, // Populated later in batch
      });
    }
    console.log(''); // newline after progress
    return fileData;
  }

  resolveDependencies(fileData, allFilePaths) {
    const deps = [];
    for (const [filePath, data] of fileData) {
      for (const imp of data.imports) {
        const resolved = resolveImport(imp.name, filePath, allFilePaths);
        if (resolved && resolved !== filePath) {
          deps.push({
            source_file: filePath,
            target_file: resolved,
            import_name: imp.name,
            import_type: imp.type,
          });
          this.stats.dependencies++;
        }
      }
    }
    return deps;
  }

  computeModuleStats(modules, fileData, dependencies, changeFreq) {
    for (const [modName, modInfo] of modules) {
      const modFiles = [...modInfo.files];
      let publicApiCount = 0;
      let internalCount = 0;
      const modSymbols = [];
      const modImports = [];

      for (const fp of modFiles) {
        const fd = fileData.get(fp);
        if (!fd) continue;

        const classification = classifyFile(fp, modInfo.rootPath);
        if (classification === 'public') publicApiCount++;
        else internalCount++;

        for (const sym of fd.symbols) {
          if (sym.exported) modSymbols.push({ file: fp, name: sym.name });
        }
        for (const imp of fd.imports) {
          modImports.push({ source_file: fp, import_name: imp.name });
        }
      }

      // Stability: based on change frequency
      let totalChanges = 0;
      for (const fp of modFiles) {
        if (changeFreq[fp]) totalChanges += changeFreq[fp].changes_30d;
      }
      const avgChanges = modFiles.length > 0 ? totalChanges / modFiles.length : 0;
      const stability = avgChanges <= 1 ? 'high' : avgChanges <= 5 ? 'medium' : 'low';

      modInfo.fileCount = modFiles.length;
      modInfo.publicApiCount = publicApiCount;
      modInfo.internalCount = internalCount;
      modInfo.stability = stability;

      // Detect capabilities
      modInfo.capabilities = detectCapabilities(modName, modFiles, modSymbols, modImports, { repoRoot: this.repoRoot });
    }

    // Compute module-level dependencies
    for (const dep of dependencies) {
      const srcData = fileData.get(dep.source_file);
      const tgtData = fileData.get(dep.target_file);
      if (srcData && tgtData && srcData.moduleName !== tgtData.moduleName) {
        const srcMod = modules.get(srcData.moduleName);
        if (srcMod) {
          if (!srcMod.moduleDeps) srcMod.moduleDeps = new Map();
          const key = tgtData.moduleName;
          srcMod.moduleDeps.set(key, (srcMod.moduleDeps.get(key) || 0) + 1);
        }
      }
    }

    this.stats.modules = modules.size;
  }

  writeDatabase(fileData, dependencies, modules, fileModuleMap, changeFreq) {
    const insertFile = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, module, language, loc, complexity_score, last_modified, is_test, is_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (name, kind, file, line_start, line_end, exported, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDep = this.db.prepare(`
      INSERT OR IGNORE INTO dependencies (source_file, target_file, import_name, import_type)
      VALUES (?, ?, ?, ?)
    `);
    const insertModule = this.db.prepare(`
      INSERT OR REPLACE INTO modules (name, root_path, file_count, public_api_count, internal_file_count, stability)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertModDep = this.db.prepare(`
      INSERT OR REPLACE INTO module_dependencies (source_module, target_module, edge_count)
      VALUES (?, ?, ?)
    `);
    const insertInterface = this.db.prepare(`
      INSERT INTO interfaces (name, file, kind, consumer_count, contract_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertChangeFreq = this.db.prepare(`
      INSERT OR REPLACE INTO change_frequency (file, changes_7d, changes_30d, changes_90d, last_changed, top_changers)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertCapability = this.db.prepare(`
      INSERT OR REPLACE INTO module_capabilities (module_name, capability, confidence, evidence)
      VALUES (?, ?, ?, ?)
    `);
    const insertMeta = this.db.prepare(`
      INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)
    `);

    // Use transaction for performance
    const writeAll = this.db.transaction(() => {
      // Files
      for (const [fp, fd] of fileData) {
        insertFile.run(fp, fd.moduleName, fd.language, fd.loc, fd.complexity, fd.lastModified, fd.isTest ? 1 : 0, fd.isConfig ? 1 : 0);
      }

      // Symbols + Interfaces
      const consumerCount = new Map(); // symbolName -> count (from imports)
      for (const dep of dependencies) {
        const key = dep.import_name;
        consumerCount.set(key, (consumerCount.get(key) || 0) + 1);
      }

      for (const [fp, fd] of fileData) {
        for (const sym of fd.symbols) {
          insertSymbol.run(sym.name, sym.kind, fp, sym.line_start, sym.line_end, sym.exported ? 1 : 0, sym.signature);

          // Create interface records for exported symbols
          if (sym.exported) {
            const kindMap = {
              function: 'export_function', class: 'export_class',
              type: 'export_type', interface: 'export_type',
              component: 'export_component', const: 'export_function',
              enum: 'export_type',
            };
            const interfaceKind = kindMap[sym.kind] || 'export_function';
            const hash = crypto.createHash('sha256').update(sym.signature || sym.name).digest('hex').slice(0, 16);
            const consumers = consumerCount.get(sym.name) || 0;
            insertInterface.run(sym.name, fp, interfaceKind, consumers, hash);
          }
        }
      }

      // Dependencies — only insert if both source and target exist in files table
      for (const dep of dependencies) {
        if (fileData.has(dep.source_file) && fileData.has(dep.target_file)) {
          insertDep.run(dep.source_file, dep.target_file, dep.import_name, dep.import_type);
        }
      }

      // Modules — pass 1: insert all module records first (FK targets must exist)
      for (const [modName, modInfo] of modules) {
        insertModule.run(modName, modInfo.rootPath, modInfo.fileCount || 0, modInfo.publicApiCount || 0, modInfo.internalCount || 0, modInfo.stability || 'medium');
      }

      // Modules — pass 2: dependencies and capabilities (after all modules exist)
      const moduleNames = new Set(modules.keys());
      for (const [modName, modInfo] of modules) {
        if (modInfo.moduleDeps) {
          for (const [target, count] of modInfo.moduleDeps) {
            if (moduleNames.has(target)) {
              insertModDep.run(modName, target, count);
            }
          }
        }

        if (modInfo.capabilities) {
          for (const cap of modInfo.capabilities) {
            insertCapability.run(modName, cap.capability, cap.confidence, cap.evidence);
          }
        }
      }

      // Change frequency
      for (const [fp, freq] of Object.entries(changeFreq)) {
        if (fileData.has(fp)) {
          insertChangeFreq.run(fp, freq.changes_7d, freq.changes_30d, freq.changes_90d, freq.last_changed, JSON.stringify(freq.top_changers));
        }
      }

      // Metadata
      insertMeta.run('built_at', new Date().toISOString());
      insertMeta.run('repo_root', this.repoRoot);
      insertMeta.run('file_count', String(this.stats.files));
      insertMeta.run('symbol_count', String(this.stats.symbols));
      insertMeta.run('dependency_count', String(this.stats.dependencies));
      insertMeta.run('module_count', String(this.stats.modules));

      // Store current commit for incremental updates
      try {
        const commit = execSync('git rev-parse HEAD', {
          cwd: this.repoRoot, encoding: 'utf8', timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (commit) insertMeta.run('last_commit', commit);
      } catch {
        // Not a git repo
      }
    });

    writeAll();

    // Detect and persist project conventions into graph_meta
    try { const { detectConventions } = require('./convention-detector'); detectConventions(this.repoRoot); } catch {}
  }

  /**
   * Extract call graph edges from function/method symbols by scanning source lines.
   */
  extractCallGraph(fileData) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO call_graph (caller_symbol_id, callee_name, callee_file, call_site_line, call_type, resolved) VALUES (?, ?, ?, ?, ?, ?)');
    const allSymbols = this.db.prepare('SELECT id, name, file FROM symbols').all();
    const symbolMap = new Map(allSymbols.map(s => [s.name, s]));

    const SKIP_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'throw', 'new', 'typeof', 'catch', 'function', 'class', 'const', 'let', 'var', 'require', 'import', 'export', 'delete', 'void', 'await', 'async', 'yield', 'super', 'this', 'try', 'else', 'do', 'break', 'continue', 'case', 'default', 'finally', 'with', 'debugger', 'instanceof', 'in', 'of']);

    const insertBatch = this.db.transaction((entries) => {
      for (const e of entries) {
        try { insert.run(e.callerId, e.calleeName, e.calleeFile, e.line, e.callType, e.resolved); } catch { /* dup or constraint */ }
      }
    });

    for (const [fp, fd] of fileData) {
      const entries = [];
      // Get symbol ids for this file
      const fileSymbols = this.db.prepare('SELECT id, name, kind, line_start, line_end FROM symbols WHERE file = ?').all(fp);
      const funcSymbols = fileSymbols.filter(s => ['function', 'method'].includes(s.kind));
      if (funcSymbols.length === 0) continue;

      let content;
      try { content = fs.readFileSync(path.join(this.repoRoot, fp), 'utf8'); } catch { continue; }
      const lines = content.split('\n');

      for (const sym of funcSymbols) {
        if (!sym.id) continue;
        const startLine = (sym.line_start || 1) - 1;
        const endLine = sym.line_end || sym.line_start || startLine + 1;
        const symLines = lines.slice(startLine, endLine);
        const callPattern = /(?:^|[^.\w])(\w+)\s*\(/g;

        for (let i = 0; i < symLines.length; i++) {
          let match;
          while ((match = callPattern.exec(symLines[i])) !== null) {
            const calleeName = match[1];
            if (SKIP_KEYWORDS.has(calleeName)) continue;
            if (calleeName === sym.name) continue; // skip self-recursion noise
            const resolved = symbolMap.get(calleeName);
            entries.push({
              callerId: sym.id,
              calleeName,
              calleeFile: resolved ? resolved.file : null,
              line: startLine + i + 1,
              callType: resolved ? 'direct' : 'unresolved',
              resolved: resolved ? 1 : 0,
            });
          }
        }
      }
      if (entries.length > 0) insertBatch(entries);
    }
  }

  /**
   * Extract class hierarchy (extends/implements) from source files.
   */
  extractClassHierarchy(fileData) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO class_hierarchy (child_id, parent_name, parent_file, relation, resolved) VALUES (?, ?, ?, ?, ?)');
    const insertBatch = this.db.transaction((entries) => {
      for (const e of entries) {
        try { insert.run(e.childId, e.parentName, e.parentFile, e.relation, e.resolved); } catch { /* dup or constraint */ }
      }
    });

    for (const [fp] of fileData) {
      let content;
      try { content = fs.readFileSync(path.join(this.repoRoot, fp), 'utf8'); } catch { continue; }

      const classPattern = /class\s+(\w+)\s+(?:extends|implements)\s+(\w+)/g;
      let match;
      const entries = [];

      while ((match = classPattern.exec(content)) !== null) {
        const childName = match[1];
        const parentName = match[2];
        const relation = content.substring(match.index).startsWith('class ' + childName + ' implements') ? 'implements' : 'extends';
        const childSym = this.db.prepare('SELECT id FROM symbols WHERE name = ? AND kind = ? AND file = ?').get(childName, 'class', fp);
        if (childSym) {
          const parentSym = this.db.prepare('SELECT file FROM symbols WHERE name = ? AND kind = ?').get(parentName, 'class');
          entries.push({
            childId: childSym.id,
            parentName,
            parentFile: parentSym ? parentSym.file : null,
            relation,
            resolved: parentSym ? 1 : 0,
          });
        }
      }
      if (entries.length > 0) insertBatch(entries);
    }
  }

  /**
   * Detect potentially dead code: unexported symbols with no callers and no importers.
   */
  detectDeadCode() {
    this.db.prepare('DELETE FROM dead_code').run();
    const deadSymbols = this.db.prepare(`
      SELECT s.id, s.name, s.file, s.kind
      FROM symbols s
      WHERE s.exported = 0
        AND s.kind IN ('function', 'class', 'method')
        AND s.id NOT IN (SELECT caller_symbol_id FROM call_graph)
        AND s.name NOT IN (SELECT callee_name FROM call_graph)
        AND s.name NOT IN (SELECT import_name FROM dependencies)
    `).all();

    const insert = this.db.prepare('INSERT OR IGNORE INTO dead_code (symbol_id, reason, confidence) VALUES (?, ?, ?)');
    const insertBatch = this.db.transaction((syms) => {
      for (const sym of syms) {
        insert.run(sym.id, 'no_callers_no_importers', 0.6);
      }
    });
    if (deadSymbols.length > 0) insertBatch(deadSymbols);
  }

  finalize(startTime) {
    if (this.db) this.db.close();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n  Build complete in ${elapsed}s`);
    console.log(`  Files: ${this.stats.files} | Symbols: ${this.stats.symbols} | Dependencies: ${this.stats.dependencies} | Modules: ${this.stats.modules}`);
    if (this.stats.parseErrors > 0) {
      console.log(`  Parse errors (fell back to regex): ${this.stats.parseErrors}`);
    }
    console.log(`  Database: ${this.dbPath}\n`);
  }
}

// ============================================================
// CLI Entry Point
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoRoot = args[0] || process.cwd();
  const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : undefined;

  const builder = new GraphBuilder(repoRoot, dbPath);
  builder.build();
}

module.exports = {
  GraphBuilder, discoverFiles, resolveImport, estimateComplexity,
  ParserManager, extractFromAST, extractWithRegex,
  LANGUAGE_EXTENSIONS, TEST_PATTERNS, CONFIG_PATTERNS,
};
