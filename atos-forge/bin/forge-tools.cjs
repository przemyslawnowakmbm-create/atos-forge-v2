#!/usr/bin/env node

/**
 * Forge Tools — CLI utility for Forge workflow operations
 *
 * Replaces repetitive inline bash patterns across ~50 Forge command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node forge-tools.cjs <command> [args] [--raw]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2]   Commit planning docs
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   verify-path-exists <path>          Check file/directory existence
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description>            Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *   requirements enhance [mode]        Analyze requirements and return stats for enhancement
 *                                      Modes: full (default), quality, gaps, add
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--archive-phases]               Move phase dirs to milestones/vX.Y-phases/
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *   state add-blocker --text "..."     Add blocker
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *
 * Graph Commands:
 *   graph init [--root <path>]         Build code graph + install hooks
 *   graph status                       Graph freshness, stats, hotspots
 *   graph impact <file> [--depth N]    Impact analysis for a file
 *   graph impact-phase <phase>         Impact analysis for all files in a phase's plans
 *   graph context <f1> [f2] ...        Get task context for files (JSON)
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick <description>           All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');


// --- Module imports (extracted from monolith) ---
const core = require('./lib/core.cjs');
const { parseIncludeFlag, safeReadFile, loadConfig, isGitIgnored, execGit,
        normalizePhaseName, output, error, getForgeRoot, getForgeGraphDir,
        getForgeSystemDir, getForgeSessionDir, getLedger, ledgerLog,
        graphDbExists, graphDbPath, getGraphStatus, getGraphContextForFiles,
        getGraphImpact, getMilestoneInfo, generateSlugInternal, pathExistsInternal,
        findPhaseInternal, resolveModelInternal, getArchivedPhaseDirs,
        searchPhaseInDir, collectPhaseFiles, getRoadmapPhaseInternal,
        MODEL_PROFILES } = core;
const frontmatterMod = require('./lib/frontmatter.cjs');
const { extractFrontmatter, reconstructFrontmatter, spliceFrontmatter, parseMustHavesBlock,
        cmdFrontmatterGet, cmdFrontmatterSet, cmdFrontmatterMerge, cmdFrontmatterValidate,
        FRONTMATTER_SCHEMAS } = frontmatterMod;
const stateMod = require('./lib/state.cjs');
const { cmdStateLoad, cmdStateGet, cmdStatePatch, cmdStateUpdate, stateExtractField,
        stateReplaceField, cmdStateAdvancePlan, cmdStateRecordMetric, cmdStateUpdateProgress,
        cmdStateAddDecision, cmdStateAddBlocker, cmdStateResolveBlocker, cmdStateRecordSession,
        cmdStateSnapshot } = stateMod;
const configMod = require('./lib/config.cjs');
const { cmdConfigEnsureSection, cmdConfigSet, cmdConfigGet } = configMod;
const miscMod = require('./lib/misc.cjs');
const { cmdGenerateSlug, cmdCurrentTimestamp, cmdListTodos, cmdVerifyPathExists, cmdTodoComplete,
        cmdWebsearch, cmdSummaryExtract, cmdRequirementsMarkComplete, cmdRequirementsEnhance,
        cmdResolveModel, cmdFindPhase, cmdCommit, cmdVerifySummary, cmdTemplateSelect } = miscMod;
const phaseMod = require('./lib/phase.cjs');
const { cmdPhaseNextDecimal, cmdPhaseAdd, cmdPhaseInsert, cmdPhaseRemove, cmdPhaseComplete, cmdPhasesList, cmdPhasePlanIndex } = phaseMod;
const roadmapMod = require('./lib/roadmap.cjs');
const { cmdRoadmapGetPhase, cmdRoadmapAnalyze, cmdRoadmapUpdatePlanProgress } = roadmapMod;
const milestoneMod = require('./lib/milestone.cjs');
const { cmdMilestoneComplete } = milestoneMod;
const verifyMod = require('./lib/verify.cjs');
const { cmdVerifyPlanStructure, cmdVerifyPhaseCompleteness, cmdVerifyReferences, cmdVerifyCommits, cmdVerifyArtifacts, cmdVerifyKeyLinks, cmdVerifyWork } = verifyMod;
const uatAutoEvalMod = require('./lib/uat-auto-eval.cjs');
const { cmdUatAutoEval } = uatAutoEvalMod;
const validateMod = require('./lib/validate.cjs');
const { cmdValidateConsistency, cmdValidateHealth } = validateMod;
const templateMod = require('./lib/template.cjs');
const { cmdTemplateFill } = templateMod;
const scaffoldMod = require('./lib/scaffold.cjs');
const { cmdScaffold } = scaffoldMod;
const progressMod = require('./lib/progress.cjs');
const { cmdProgressRender, cmdHistoryDigest } = progressMod;
const graphMod = require('./lib/graph.cjs');
const { cmdGraphInit, cmdGraphStatus, cmdGraphImpact, cmdGraphContext,
        cmdGraphVisualize, cmdGraphSnapshot, cmdGraphSnapshotDiff, cmdGraphQuery } = graphMod;
const systemMod = require('./lib/system.cjs');
const { runSystemModule, cmdSystemInit, cmdSystemRebuild, cmdSystemSync,
        cmdSystemStatus, cmdSystemImpact, cmdSystemValidate, cmdSystemDashboard,
        resolveSystemDbPath } = systemMod;
const initMod = require('./lib/init.cjs');
const { cmdInitExecutePhase, cmdInitPlanPhase, cmdInitNewProject, cmdInitNewMilestone,
        cmdInitQuick, cmdInitResume, cmdInitVerifyWork, cmdInitPhaseOp, cmdInitTodos,
        cmdInitMilestoneOp, cmdInitMapCodebase, cmdInitProgress } = initMod;


// ─── Extracted to lib/ modules ─────────────────────────────────────────────────
// cmdHistoryDigest, cmdProgressRender → lib/progress.cjs
// cmdTemplateFill → lib/template.cjs
// cmdVerifyPlanStructure..cmdVerifyWork → lib/verify.cjs
// cmdValidateConsistency, cmdValidateHealth → lib/validate.cjs
// cmdScaffold → lib/scaffold.cjs
// cmdGraphInit..cmdGraphQuery → lib/graph.cjs
// runSystemModule, cmdSystem*, resolveSystemDbPath → lib/system.cjs
// cmdInit* (12 compound init commands) → lib/init.cjs


// ─── Extracted to lib/ modules (continued) ───────────────────────────────────
// cmdInit* (12 functions) → lib/init.cjs

// ─── CLI Router ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  if (rawIndex !== -1) args.splice(rawIndex, 1);

  const command = args[0];
  const cwd = process.cwd();

  if (!command) {
    error('Usage: forge-tools <command> [args] [--raw]\nCommands: state, resolve-model, find-phase, commit, verify-summary, verify, frontmatter, template, generate-slug, current-timestamp, list-todos, verify-path-exists, config-ensure-section, init, graph, ledger, system, settings, doctor');
  }

  switch (command) {
    case 'state': {
      const subcommand = args[1];
      if (subcommand === 'update') {
        cmdStateUpdate(cwd, args[2], args[3]);
      } else if (subcommand === 'get') {
        cmdStateGet(cwd, args[2], raw);
      } else if (subcommand === 'patch') {
        const patches = {};
        for (let i = 2; i < args.length; i += 2) {
          const key = args[i].replace(/^--/, '');
          const value = args[i + 1];
          if (key && value !== undefined) {
            patches[key] = value;
          }
        }
        cmdStatePatch(cwd, patches, raw);
      } else if (subcommand === 'advance-plan') {
        cmdStateAdvancePlan(cwd, raw);
      } else if (subcommand === 'record-metric') {
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const durationIdx = args.indexOf('--duration');
        const tasksIdx = args.indexOf('--tasks');
        const filesIdx = args.indexOf('--files');
        cmdStateRecordMetric(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          duration: durationIdx !== -1 ? args[durationIdx + 1] : null,
          tasks: tasksIdx !== -1 ? args[tasksIdx + 1] : null,
          files: filesIdx !== -1 ? args[filesIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'update-progress') {
        cmdStateUpdateProgress(cwd, raw);
      } else if (subcommand === 'add-decision') {
        const phaseIdx = args.indexOf('--phase');
        const summaryIdx = args.indexOf('--summary');
        const rationaleIdx = args.indexOf('--rationale');
        cmdStateAddDecision(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          summary: summaryIdx !== -1 ? args[summaryIdx + 1] : null,
          rationale: rationaleIdx !== -1 ? args[rationaleIdx + 1] : '',
        }, raw);
      } else if (subcommand === 'add-blocker') {
        const textIdx = args.indexOf('--text');
        cmdStateAddBlocker(cwd, textIdx !== -1 ? args[textIdx + 1] : null, raw);
      } else if (subcommand === 'resolve-blocker') {
        const textIdx = args.indexOf('--text');
        cmdStateResolveBlocker(cwd, textIdx !== -1 ? args[textIdx + 1] : null, raw);
      } else if (subcommand === 'record-session') {
        const stoppedIdx = args.indexOf('--stopped-at');
        const resumeIdx = args.indexOf('--resume-file');
        cmdStateRecordSession(cwd, {
          stopped_at: stoppedIdx !== -1 ? args[stoppedIdx + 1] : null,
          resume_file: resumeIdx !== -1 ? args[resumeIdx + 1] : 'None',
        }, raw);
      } else {
        cmdStateLoad(cwd, raw);
      }
      break;
    }

    case 'resolve-model': {
      cmdResolveModel(cwd, args[1], raw);
      break;
    }

    case 'find-phase': {
      cmdFindPhase(cwd, args[1], raw);
      break;
    }

    case 'commit': {
      const amend = args.includes('--amend');
      const message = args[1];
      // Parse --files flag (collect args after --files, stopping at other flags)
      const filesIndex = args.indexOf('--files');
      const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
      cmdCommit(cwd, message, files, raw, amend);
      break;
    }

    case 'verify-summary': {
      const summaryPath = args[1];
      const countIndex = args.indexOf('--check-count');
      const checkCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
      cmdVerifySummary(cwd, summaryPath, checkCount, raw);
      break;
    }

    case 'template': {
      const subcommand = args[1];
      if (subcommand === 'select') {
        cmdTemplateSelect(cwd, args[2], raw);
      } else if (subcommand === 'fill') {
        const templateType = args[2];
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const nameIdx = args.indexOf('--name');
        const typeIdx = args.indexOf('--type');
        const waveIdx = args.indexOf('--wave');
        const fieldsIdx = args.indexOf('--fields');
        cmdTemplateFill(cwd, templateType, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          name: nameIdx !== -1 ? args[nameIdx + 1] : null,
          type: typeIdx !== -1 ? args[typeIdx + 1] : 'execute',
          wave: waveIdx !== -1 ? args[waveIdx + 1] : '1',
          fields: fieldsIdx !== -1 ? JSON.parse(args[fieldsIdx + 1]) : {},
        }, raw);
      } else {
        error('Unknown template subcommand. Available: select, fill');
      }
      break;
    }

    case 'frontmatter': {
      const subcommand = args[1];
      const file = args[2];
      if (subcommand === 'get') {
        const fieldIdx = args.indexOf('--field');
        cmdFrontmatterGet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, raw);
      } else if (subcommand === 'set') {
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        cmdFrontmatterSet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, valueIdx !== -1 ? args[valueIdx + 1] : undefined, raw);
      } else if (subcommand === 'merge') {
        const dataIdx = args.indexOf('--data');
        cmdFrontmatterMerge(cwd, file, dataIdx !== -1 ? args[dataIdx + 1] : null, raw);
      } else if (subcommand === 'validate') {
        const schemaIdx = args.indexOf('--schema');
        cmdFrontmatterValidate(cwd, file, schemaIdx !== -1 ? args[schemaIdx + 1] : null, raw);
      } else {
        error('Unknown frontmatter subcommand. Available: get, set, merge, validate');
      }
      break;
    }

    case 'verify': {
      const subcommand = args[1];
      if (subcommand === 'plan-structure') {
        cmdVerifyPlanStructure(cwd, args[2], raw);
      } else if (subcommand === 'phase-completeness') {
        cmdVerifyPhaseCompleteness(cwd, args[2], raw);
      } else if (subcommand === 'references') {
        cmdVerifyReferences(cwd, args[2], raw);
      } else if (subcommand === 'commits') {
        cmdVerifyCommits(cwd, args.slice(2), raw);
      } else if (subcommand === 'artifacts') {
        cmdVerifyArtifacts(cwd, args[2], raw);
      } else if (subcommand === 'key-links') {
        cmdVerifyKeyLinks(cwd, args[2], raw);
      } else if (subcommand === 'work') {
        await cmdVerifyWork(cwd, args.slice(2), raw);
      } else if (subcommand === 'uat-eval') {
        cmdUatAutoEval(cwd, args.slice(2), raw);
      } else {
        error('Unknown verify subcommand. Available: plan-structure, phase-completeness, references, commits, artifacts, key-links, work, uat-eval');
      }
      break;
    }

    case 'generate-slug': {
      cmdGenerateSlug(args[1], raw);
      break;
    }

    case 'current-timestamp': {
      cmdCurrentTimestamp(args[1] || 'full', raw);
      break;
    }

    case 'list-todos': {
      cmdListTodos(cwd, args[1], raw);
      break;
    }

    case 'verify-path-exists': {
      cmdVerifyPathExists(cwd, args[1], raw);
      break;
    }

    case 'config-ensure-section': {
      cmdConfigEnsureSection(cwd, raw);
      break;
    }

    case 'config-set': {
      cmdConfigSet(cwd, args[1], args[2], raw);
      break;
    }

    case 'config-get': {
      cmdConfigGet(cwd, args[1], raw);
      break;
    }

    case 'history-digest': {
      cmdHistoryDigest(cwd, raw);
      break;
    }

    case 'phases': {
      const subcommand = args[1];
      if (subcommand === 'list') {
        const typeIndex = args.indexOf('--type');
        const phaseIndex = args.indexOf('--phase');
        const options = {
          type: typeIndex !== -1 ? args[typeIndex + 1] : null,
          phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
          includeArchived: args.includes('--include-archived'),
        };
        cmdPhasesList(cwd, options, raw);
      } else {
        error('Unknown phases subcommand. Available: list');
      }
      break;
    }

    case 'roadmap': {
      const subcommand = args[1];
      if (subcommand === 'get-phase') {
        cmdRoadmapGetPhase(cwd, args[2], raw);
      } else if (subcommand === 'analyze') {
        cmdRoadmapAnalyze(cwd, raw);
      } else if (subcommand === 'update-plan-progress') {
        cmdRoadmapUpdatePlanProgress(cwd, args[2], raw);
      } else {
        error('Unknown roadmap subcommand. Available: get-phase, analyze, update-plan-progress');
      }
      break;
    }

    case 'requirements': {
      const subcommand = args[1];
      if (subcommand === 'mark-complete') {
        cmdRequirementsMarkComplete(cwd, args.slice(2), raw);
      } else if (subcommand === 'enhance') {
        cmdRequirementsEnhance(cwd, args[2], raw);
      } else {
        error('Unknown requirements subcommand. Available: mark-complete, enhance');
      }
      break;
    }

    case 'phase': {
      const subcommand = args[1];
      if (subcommand === 'next-decimal') {
        cmdPhaseNextDecimal(cwd, args[2], raw);
      } else if (subcommand === 'add') {
        cmdPhaseAdd(cwd, args.slice(2).join(' '), raw);
      } else if (subcommand === 'insert') {
        cmdPhaseInsert(cwd, args[2], args.slice(3).join(' '), raw);
      } else if (subcommand === 'remove') {
        const forceFlag = args.includes('--force');
        cmdPhaseRemove(cwd, args[2], { force: forceFlag }, raw);
      } else if (subcommand === 'complete') {
        cmdPhaseComplete(cwd, args[2], raw);
      } else {
        error('Unknown phase subcommand. Available: next-decimal, add, insert, remove, complete');
      }
      break;
    }

    case 'milestone': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        const nameIndex = args.indexOf('--name');
        const archivePhases = args.includes('--archive-phases');
        // Collect --name value (everything after --name until next flag or end)
        let milestoneName = null;
        if (nameIndex !== -1) {
          const nameArgs = [];
          for (let i = nameIndex + 1; i < args.length; i++) {
            if (args[i].startsWith('--')) break;
            nameArgs.push(args[i]);
          }
          milestoneName = nameArgs.join(' ') || null;
        }
        cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases }, raw);
      } else {
        error('Unknown milestone subcommand. Available: complete');
      }
      break;
    }

    case 'validate': {
      const subcommand = args[1];
      if (subcommand === 'consistency') {
        cmdValidateConsistency(cwd, raw);
      } else if (subcommand === 'health') {
        const repairFlag = args.includes('--repair');
        cmdValidateHealth(cwd, { repair: repairFlag }, raw);
      } else {
        error('Unknown validate subcommand. Available: consistency, health');
      }
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      cmdProgressRender(cwd, subcommand, raw);
      break;
    }

    case 'todo': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        cmdTodoComplete(cwd, args[2], raw);
      } else {
        error('Unknown todo subcommand. Available: complete');
      }
      break;
    }

    case 'scaffold': {
      const scaffoldType = args[1];
      const phaseIndex = args.indexOf('--phase');
      const nameIndex = args.indexOf('--name');
      const scaffoldOptions = {
        phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
        name: nameIndex !== -1 ? args.slice(nameIndex + 1).join(' ') : null,
      };
      cmdScaffold(cwd, scaffoldType, scaffoldOptions, raw);
      break;
    }

    case 'init': {
      const workflow = args[1];
      const includes = parseIncludeFlag(args);
      switch (workflow) {
        case 'execute-phase':
          cmdInitExecutePhase(cwd, args[2], includes, raw);
          break;
        case 'plan-phase':
          cmdInitPlanPhase(cwd, args[2], includes, raw);
          break;
        case 'new-project':
          cmdInitNewProject(cwd, raw);
          break;
        case 'new-milestone':
          cmdInitNewMilestone(cwd, raw);
          break;
        case 'quick':
          cmdInitQuick(cwd, args.slice(2).join(' '), raw);
          break;
        case 'resume':
          cmdInitResume(cwd, raw);
          break;
        case 'verify-work':
          cmdInitVerifyWork(cwd, args[2], raw);
          break;
        case 'phase-op':
          cmdInitPhaseOp(cwd, args[2], raw);
          break;
        case 'todos':
          cmdInitTodos(cwd, args[2], raw);
          break;
        case 'milestone-op':
          cmdInitMilestoneOp(cwd, raw);
          break;
        case 'map-codebase':
          cmdInitMapCodebase(cwd, raw);
          break;
        case 'progress':
          cmdInitProgress(cwd, includes, raw);
          break;
        default:
          error(`Unknown init workflow: ${workflow}\nAvailable: execute-phase, plan-phase, new-project, new-milestone, quick, resume, verify-work, phase-op, todos, milestone-op, map-codebase, progress`);
      }
      break;
    }

    case 'phase-plan-index': {
      cmdPhasePlanIndex(cwd, args[1], raw);
      break;
    }

    case 'state-snapshot': {
      cmdStateSnapshot(cwd, raw);
      break;
    }

    case 'summary-extract': {
      const summaryPath = args[1];
      const fieldsIndex = args.indexOf('--fields');
      const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
      cmdSummaryExtract(cwd, summaryPath, fields, raw);
      break;
    }

    case 'websearch': {
      const query = args[1];
      const limitIdx = args.indexOf('--limit');
      const freshnessIdx = args.indexOf('--freshness');
      await cmdWebsearch(query, {
        limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
        freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
      }, raw);
      break;
    }

    case 'graph': {
      const subcommand = args[1];
      if (subcommand === 'init') {
        cmdGraphInit(cwd, args.slice(2), raw);
      } else if (subcommand === 'status') {
        cmdGraphStatus(cwd, raw);
      } else if (subcommand === 'impact') {
        cmdGraphImpact(cwd, args.slice(2), raw);
      } else if (subcommand === 'context') {
        cmdGraphContext(cwd, args.slice(2), raw);
      } else if (subcommand === 'visualize') {
        cmdGraphVisualize(cwd, args.slice(2), raw);
      } else if (subcommand === 'snapshot') {
        cmdGraphSnapshot(cwd, args.slice(2), raw);
      } else if (subcommand === 'snapshot-diff') {
        cmdGraphSnapshotDiff(cwd, args.slice(2), raw);
      } else if (subcommand === 'overview') {
        cmdGraphQuery(cwd, 'overview', args.slice(2), raw);
      } else if (subcommand === 'show') {
        cmdGraphQuery(cwd, 'show', args.slice(2), raw);
      } else if (subcommand === 'hotspots') {
        cmdGraphQuery(cwd, 'hotspots', args.slice(2), raw);
      } else if (subcommand === 'cycles') {
        cmdGraphQuery(cwd, 'cycles', args.slice(2), raw);
      } else if (subcommand === 'capabilities') {
        cmdGraphQuery(cwd, 'capabilities', args.slice(2), raw);
      } else {
        error('Unknown graph subcommand. Available: init, status, impact, context, visualize, snapshot, snapshot-diff, overview, show, hotspots, cycles, capabilities');
      }
      break;
    }

    case 'ledger': {
      const { handleLedger } = require('./lib/ledger.cjs');
      await handleLedger(cwd, args.slice(1), raw);
      break;
    }

    case 'settings': {
      const { handleSettings } = require('./lib/settings.cjs');
      await handleSettings(cwd, args.slice(1), raw);
      break;
    }

    case 'system': {
      const sub = args[1];
      const subArgs = args.slice(2);
      if (sub === 'init') {
        cmdSystemInit(cwd, subArgs, raw);
      } else if (sub === 'rebuild') {
        cmdSystemRebuild(cwd, subArgs, raw);
      } else if (sub === 'sync') {
        cmdSystemSync(cwd, subArgs, raw);
      } else if (sub === 'status') {
        cmdSystemStatus(cwd, subArgs, raw);
      } else if (sub === 'impact') {
        cmdSystemImpact(cwd, subArgs, raw);
      } else if (sub === 'validate') {
        cmdSystemValidate(cwd, subArgs, raw);
      } else if (sub === 'dashboard') {
        cmdSystemDashboard(cwd, subArgs, raw);
      } else {
        error('Unknown system subcommand. Available: init, rebuild, sync, status, impact, validate, dashboard');
      }
      break;
    }

    case 'doctor': {
      const { handleDoctor } = require('./lib/doctor.cjs');
      await handleDoctor(cwd, args.slice(1), raw);
      break;
    }

    case 'knowledge': {
      const { handleKnowledge } = require('./lib/knowledge.cjs');
      await handleKnowledge(cwd, args.slice(1), raw);
      break;
    }

    case 'impact': {
      const { handleImpact } = require('./lib/impact.cjs');
      await handleImpact(cwd, args.slice(1), raw);
      break;
    }

    case 'agents': {
      const { handleAgents } = require('./lib/agents.cjs');
      await handleAgents(cwd, args.slice(1), raw);
      break;
    }

    default:
      error(`Unknown command: ${command}`);
  }
}

main();
