'use strict';
const fs = require('fs');
const path = require('path');
const { determineNextUnit, PHASES } = require('./state-machine');
const { dispatch } = require('./dispatcher');

let running = false;
let lastUnitKey = null;
let retryCount = 0;
const MAX_RETRIES = 1;

function readDiskState(cwd) {
  const state = { hasRoadmap: false, currentPhase: null, hasPlans: false, tasks: [], phaseVerified: false };
  try {
    const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
    if (!fs.existsSync(roadmapPath)) return state;
    state.hasRoadmap = true;

    const roadmap = fs.readFileSync(roadmapPath, 'utf8');
    // Find first incomplete phase
    const phasePattern = /##\s+Phase\s+(\d+[\d.]*):?\s*(.*)/gi;
    const donePattern = /\[x\]/i;
    let match;
    while ((match = phasePattern.exec(roadmap)) !== null) {
      const phaseNum = match[1];
      const phaseName = match[2].trim();
      // Check if this phase line has [x] before it
      const lineStart = roadmap.lastIndexOf('\n', match.index) + 1;
      const lineContent = roadmap.substring(lineStart, match.index + match[0].length);
      if (!donePattern.test(lineContent)) {
        state.currentPhase = { number: phaseNum, name: phaseName };
        break;
      }
    }

    if (!state.currentPhase) return state;

    // Check for plans
    const padded = String(state.currentPhase.number).padStart(2, '0');
    const phaseDirs = fs.readdirSync(path.join(cwd, '.planning', 'phases')).filter(d => d.startsWith(padded));
    if (phaseDirs.length > 0) {
      const phaseDir = path.join(cwd, '.planning', 'phases', phaseDirs[0]);
      const plans = fs.readdirSync(phaseDir).filter(f => f.includes('PLAN') && f.endsWith('.md'));
      state.hasPlans = plans.length > 0;

      // Check task completion (PLAN has matching SUMMARY)
      for (const plan of plans) {
        const summaryName = plan.replace('PLAN', 'SUMMARY');
        const done = fs.existsSync(path.join(phaseDir, summaryName));
        state.tasks.push({ id: plan.replace('.md', ''), done });
      }
    }

    // Check verification
    if (phaseDirs.length > 0) {
      const phaseDir = path.join(cwd, '.planning', 'phases', phaseDirs[0]);
      const verFiles = fs.readdirSync(phaseDir).filter(f => f.includes('VERIFICATION'));
      state.phaseVerified = verFiles.length > 0;
    }
  } catch {}
  return state;
}

async function start(cwd, opts = {}) {
  running = true;
  lastUnitKey = null;
  retryCount = 0;

  console.log('[forge-auto] Starting auto mode...');
  console.log('[forge-auto] Reading project state from disk...');

  // Crash recovery check
  try {
    const cr = require('../forge-session/crash-recovery');
    const lock = cr.readCrashLock(cwd);
    if (lock && !lock.processAlive) {
      console.log('[forge-auto] Crash detected from previous session — recovering...');
      console.log(cr.synthesizeRecovery(cwd, lock));
      cr.clearLock(cwd);
    }
  } catch {}

  while (running) {
    const state = readDiskState(cwd);
    const unit = determineNextUnit(state);

    if (unit.phase === PHASES.IDLE) {
      console.log(`[forge-auto] ${unit.action === 'milestone_complete' ? 'Milestone complete!' : 'No roadmap found.'} Auto mode finished.`);
      break;
    }

    const unitKey = `${unit.phase}:${unit.taskId || unit.phaseNum}`;

    // Stuck detection
    if (lastUnitKey === unitKey) {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
        console.log(`[forge-auto] STUCK on ${unitKey} after ${retryCount} retries. Stopping.`);
        break;
      }
      console.log(`[forge-auto] Retry ${retryCount}/${MAX_RETRIES} for ${unitKey}`);
    } else {
      retryCount = 0;
      lastUnitKey = unitKey;
    }

    // Write crash lock
    try { require('../forge-session/crash-recovery').writeLock(cwd, { taskId: unitKey, phase: unit.phase }); } catch {}

    console.log(`[forge-auto] Dispatching: ${unit.phase} ${unit.taskId || unit.phaseNum || ''}`);
    const result = dispatch(cwd, unit, opts);

    if (result.success) {
      console.log(`[forge-auto] Unit complete: ${unitKey}`);
      try {
        require('../forge-session/metrics').snapshotUnitMetrics(cwd, { type: unit.phase, id: unitKey, phase: unit.phase });
      } catch {}
    } else {
      console.log(`[forge-auto] Unit failed: ${unitKey}`);
      if (opts.verbose) console.log(`[forge-auto] Error: ${result.error}`);
    }

    // Clear crash lock
    try { require('../forge-session/crash-recovery').clearLock(cwd); } catch {}
  }

  running = false;
  console.log('[forge-auto] Auto mode stopped.');
}

function stop() { running = false; console.log('[forge-auto] Stop requested...'); }
function isRunning() { return running; }

module.exports = { start, stop, isRunning, readDiskState };
