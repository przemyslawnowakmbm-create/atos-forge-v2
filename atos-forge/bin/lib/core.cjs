const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveProvider } = require('../../../forge-agents/provider');

// ─── Model Profile Table ─────────────────────────────────────────────────────

const MODEL_PROFILES = {
  'forge-planner':              { quality: 'opus', balanced: 'opus',   budget: 'sonnet' },
  'forge-roadmapper':           { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'forge-executor':             { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'forge-phase-researcher':     { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'forge-project-researcher':   { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'forge-research-synthesizer': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-debugger':             { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'forge-codebase-mapper':      { quality: 'sonnet', balanced: 'haiku', budget: 'haiku' },
  'forge-verifier':             { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-plan-checker':         { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-integration-checker':  { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
};

const CODEX_MODEL_PROFILES = {
  'forge-planner':              { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-roadmapper':           { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-executor':             { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-phase-researcher':     { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-project-researcher':   { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-research-synthesizer': { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-debugger':             { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-codebase-mapper':      { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-verifier':             { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-plan-checker':         { quality: 'o3', balanced: 'o3', budget: 'o3' },
  'forge-integration-checker':  { quality: 'o3', balanced: 'o3', budget: 'o3' },
};

// ─── Shared Utilities (Group A) ──────────────────────────────────────────────

function parseIncludeFlag(args) {
  const includeIndex = args.indexOf('--include');
  if (includeIndex === -1) return new Set();
  const includeValue = args[includeIndex + 1];
  if (!includeValue) return new Set();
  return new Set(includeValue.split(',').map(s => s.trim()));
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Strip Claude Code's `[rerun: bN]` footer from a string.
 *
 * When a Bash tool output exceeds Claude Code's inline limit, it is persisted
 * to a `tool-results/*.txt` file with a trailing `[rerun: bN]` line.  If that
 * file is later read back and parsed as JSON, the footer causes parse errors.
 * Call this before JSON.parse / json.load on any string that may originate
 * from a persisted Bash tool result.
 */
function stripClaudeFooter(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\n?\[rerun: b\d+\]\s*$/, '');
}

function loadConfig(cwd) {
  // Delegate to unified config system with fallback to inline defaults
  try {
    const forgeConfig = require(path.join(getForgeRoot(), 'forge-config', 'config'));
    return forgeConfig.getLegacyToolsConfig(cwd);
  } catch { /* fallback below */ }

  const configPath = path.join(cwd, '.planning', 'config.json');
  const defaults = {
    model_profile: 'balanced',
    commit_docs: true,
    search_gitignored: false,
    branching_strategy: 'none',
    phase_branch_template: 'forge/phase-{phase}-{slug}',
    milestone_branch_template: 'forge/{milestone}-{slug}',
    research: true,
    plan_checker: true,
    verifier: true,
    parallelization: true,
    brave_search: false,
  };

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    const get = (key, nested) => {
      if (parsed[key] !== undefined) return parsed[key];
      if (nested && parsed[nested.section] && parsed[nested.section][nested.field] !== undefined) {
        return parsed[nested.section][nested.field];
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in val) return val.enabled;
      return defaults.parallelization;
    })();

    return {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: get('commit_docs', { section: 'planning', field: 'commit_docs' }) ?? defaults.commit_docs,
      search_gitignored: get('search_gitignored', { section: 'planning', field: 'search_gitignored' }) ?? defaults.search_gitignored,
      branching_strategy: get('branching_strategy', { section: 'git', field: 'branching_strategy' }) ?? defaults.branching_strategy,
      phase_branch_template: get('phase_branch_template', { section: 'git', field: 'phase_branch_template' }) ?? defaults.phase_branch_template,
      milestone_branch_template: get('milestone_branch_template', { section: 'git', field: 'milestone_branch_template' }) ?? defaults.milestone_branch_template,
      research: get('research', { section: 'workflow', field: 'research' }) ?? defaults.research,
      plan_checker: get('plan_checker', { section: 'workflow', field: 'plan_check' }) ?? defaults.plan_checker,
      verifier: get('verifier', { section: 'workflow', field: 'verifier' }) ?? defaults.verifier,
      parallelization,
      brave_search: get('brave_search') ?? defaults.brave_search,
    };
  } catch {
    return defaults;
  }
}

function isGitIgnored(cwd, targetPath) {
  try {
    execSync('git check-ignore -q -- ' + targetPath.replace(/[^a-zA-Z0-9._\-/]/g, ''), {
      cwd,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function execGit(cwd, args) {
  try {
    const escaped = args.map(a => {
      if (/^[a-zA-Z0-9._\-/=:@]+$/.test(a)) return a;
      return "'" + a.replace(/'/g, "'\\''") + "'";
    });
    const stdout = execSync('git ' + escaped.join(' '), {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
    };
  }
}

function normalizePhaseName(phase) {
  const match = phase.match(/^(\d+(?:\.\d+)?)/);
  if (!match) return phase;
  const num = match[1];
  const parts = num.split('.');
  const padded = parts[0].padStart(2, '0');
  return parts.length > 1 ? `${padded}.${parts[1]}` : padded;
}

function output(result, raw, rawValue) {
  if (raw && rawValue !== undefined) {
    process.stdout.write(String(rawValue));
  } else {
    const json = JSON.stringify(result, null, 2);
    process.stdout.write(json);
  }
  process.exit(0);
}

function error(message) {
  process.stderr.write('Error: ' + message + '\n');
  process.exit(1);
}

// ─── Internal Helpers (Group B) ──────────────────────────────────────────────

function resolveModelInternal(cwd, agentType) {
  const config = loadConfig(cwd);
  const provider = resolveProvider(cwd, { provider: config.agent_provider }).name;
  const profileTable = provider === 'codex' ? CODEX_MODEL_PROFILES : MODEL_PROFILES;

  // Check per-agent override first
  const override = config.model_overrides?.[agentType];
  if (override) {
    return override === 'opus' ? 'inherit' : override;
  }

  // Fall back to profile lookup
  const profile = config.model_profile || 'balanced';
  const agentModels = profileTable[agentType];
  if (!agentModels) return provider === 'codex' ? 'o3' : 'sonnet';
  const resolved = agentModels[profile] || agentModels['balanced'] || (provider === 'codex' ? 'o3' : 'sonnet');
  return resolved === 'opus' ? 'inherit' : resolved;
}

function getArchivedPhaseDirs(cwd) {
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const results = [];

  if (!fs.existsSync(milestonesDir)) return results;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    // Find v*-phases directories, sort newest first
    const phaseDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of phaseDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const entries = fs.readdirSync(archivePath, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

      for (const dir of dirs) {
        results.push({
          name: dir,
          milestone: version,
          basePath: path.join('.planning', 'milestones', archiveName),
          fullPath: path.join(archivePath, dir),
        });
      }
    }
  } catch {}

  return results;
}

function searchPhaseInDir(baseDir, relBase, normalized) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const match = dirs.find(d => d.startsWith(normalized));
    if (!match) return null;

    const dirMatch = match.match(/^(\d+(?:\.\d+)?)-?(.*)/);
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
    const phaseDir = path.join(baseDir, match);
    const phaseFiles = fs.readdirSync(phaseDir);

    const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').sort();
    const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').sort();
    const hasResearch = phaseFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');
    const hasContext = phaseFiles.some(f => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md');
    const hasVerification = phaseFiles.some(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md');

    const completedPlanIds = new Set(
      summaries.map(s => s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''))
    );
    const incompletePlans = plans.filter(p => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      return !completedPlanIds.has(planId);
    });

    return {
      found: true,
      directory: path.join(relBase, match),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd, phase) {
  if (!phase) return null;

  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalized = normalizePhaseName(phase);

  // Search current phases first
  const current = searchPhaseInDir(phasesDir, path.join('.planning', 'phases'), normalized);
  if (current) return current;

  // Search archived milestone phases (newest first)
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  if (!fs.existsSync(milestonesDir)) return null;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    const archiveDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of archiveDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const relBase = path.join('.planning', 'milestones', archiveName);
      const result = searchPhaseInDir(archivePath, relBase, normalized);
      if (result) {
        result.archived = version;
        return result;
      }
    }
  } catch {}

  return null;
}

function getRoadmapPhaseInternal(cwd, phaseNum) {
  if (!phaseNum) return null;
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    const escapedPhase = phaseNum.toString().replace(/\./g, '\\.');
    const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`, 'i');
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(/\n#{2,4}\s+Phase\s+\d/i);
    const sectionEnd = nextHeaderMatch ? headerIndex + nextHeaderMatch.index : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goalMatch = section.match(/\*\*Goal:\*\*\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    return {
      found: true,
      phase_number: phaseNum.toString(),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

function pathExistsInternal(cwd, targetPath) {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function generateSlugInternal(text) {
  if (!text) return null;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getMilestoneInfo(cwd) {
  try {
    const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
    const versionMatch = roadmap.match(/v(\d+\.\d+)/);
    const nameMatch = roadmap.match(/## .*v\d+\.\d+[:\s]+([^\n(]+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: nameMatch ? nameMatch[1].trim() : 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

// ─── Graph Integration ────────────────────────────────────────────────────────

function getForgeRoot() {
  // FORGE_HOME env var takes priority (e.g. FORGE_HOME=/path/to/atos-forge)
  if (process.env.FORGE_HOME) return process.env.FORGE_HOME;
  // Default: go up 3 levels from atos-forge/bin/lib/core.cjs → parent of atos-forge/
  // bin/lib/core.cjs → bin/lib → bin → atos-forge → ~/.claude/
  const toolsDir = path.dirname(__filename);
  return path.dirname(path.dirname(path.dirname(toolsDir)));
}

function getForgeGraphDir() {
  return path.join(getForgeRoot(), 'forge-graph');
}

function getForgeSystemDir() {
  return path.join(getForgeRoot(), 'forge-system');
}

function getForgeSessionDir() {
  return path.join(getForgeRoot(), 'forge-session');
}

function getLedger(cwd) {
  try {
    return require(path.join(getForgeSessionDir(), 'ledger'));
  } catch {
    return null;
  }
}

// Convenience: fire-and-forget ledger write (never throw)
function ledgerLog(cwd, method, data) {
  try {
    const ledger = getLedger(cwd);
    if (ledger && typeof ledger[method] === 'function') {
      ledger[method](cwd, data);
    }
  } catch { /* ledger writes must never break commands */ }
}

function graphDbExists(cwd) {
  return pathExistsInternal(cwd, '.forge/graph.db');
}

function graphDbPath(cwd) {
  return path.join(cwd, '.forge', 'graph.db');
}

/**
 * Get a graph query summary (status, freshness, stats).
 * Returns null if graph doesn't exist.
 */
function getGraphStatus(cwd) {
  if (!graphDbExists(cwd)) return null;
  try {
    const graphDir = getForgeGraphDir();
    const queryPath = path.join(graphDir, 'query.js');
    const out = execSync(`node "${queryPath}" meta --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Run graph context-for-task on a list of files.
 * Returns null if graph doesn't exist or on error.
 */
function getGraphContextForFiles(cwd, filePaths) {
  if (!graphDbExists(cwd) || !filePaths || filePaths.length === 0) return null;
  try {
    const graphDir = getForgeGraphDir();
    const queryPath = path.join(graphDir, 'query.js');
    const fileArgs = filePaths.map(f => `"${f}"`).join(' ');
    const out = execSync(`node "${queryPath}" context-for-task ${fileArgs} --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Run impact analysis on a single file.
 * Returns null if graph doesn't exist or on error.
 */
function getGraphImpact(cwd, filePath, depth) {
  if (!graphDbExists(cwd)) return null;
  try {
    const graphDir = getForgeGraphDir();
    const queryPath = path.join(graphDir, 'query.js');
    const depthArg = depth ? `--depth ${depth}` : '';
    const out = execSync(`node "${queryPath}" impact "${filePath}" ${depthArg} --json --db "${graphDbPath(cwd)}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Collect all files_modified from plans in a phase.
 */
function collectPhaseFiles(cwd, phaseNumber) {
  try {
    const out = execSync(`node "${path.join(path.dirname(__filename), '..', 'forge-tools.cjs')}" phase-plan-index "${phaseNumber}"`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    const index = JSON.parse(out);
    const files = new Set();
    for (const plan of (index.plans || [])) {
      for (const f of (plan.files_modified || [])) {
        files.add(f);
      }
    }
    return [...files];
  } catch {
    return [];
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Group A - Shared Utilities
  parseIncludeFlag,
  safeReadFile,
  stripClaudeFooter,
  loadConfig,
  isGitIgnored,
  execGit,
  normalizePhaseName,
  output,
  error,
  // Group B - Internal Helpers
  resolveModelInternal,
  getArchivedPhaseDirs,
  searchPhaseInDir,
  findPhaseInternal,
  pathExistsInternal,
  generateSlugInternal,
  getMilestoneInfo,
  getForgeRoot,
  getForgeGraphDir,
  getForgeSystemDir,
  getForgeSessionDir,
  getLedger,
  ledgerLog,
  graphDbExists,
  graphDbPath,
  getGraphStatus,
  getGraphContextForFiles,
  getGraphImpact,
  collectPhaseFiles,
  getRoadmapPhaseInternal,
  // Also export MODEL_PROFILES (needed by resolveModelInternal consumers)
  MODEL_PROFILES,
  CODEX_MODEL_PROFILES,
};
