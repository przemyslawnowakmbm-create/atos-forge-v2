'use strict';
const fs = require('fs');
const path = require('path');

const PHASES = { IDLE: 'idle', RESEARCH: 'research', PLAN: 'plan', EXECUTE: 'execute', VERIFY: 'verify', COMPLETE: 'complete', REASSESS: 'reassess' };

function determineNextUnit(state) {
  if (!state.hasRoadmap) return { phase: PHASES.IDLE, action: 'no_roadmap' };
  const cp = state.currentPhase;
  if (!cp) return { phase: PHASES.IDLE, action: 'milestone_complete' };
  if (!state.hasPlans) return { phase: PHASES.PLAN, phaseNum: cp.number };
  const pending = state.tasks.find(t => !t.done);
  if (pending) return { phase: PHASES.EXECUTE, phaseNum: cp.number, taskId: pending.id };
  if (!state.phaseVerified) return { phase: PHASES.VERIFY, phaseNum: cp.number };
  return { phase: PHASES.COMPLETE, phaseNum: cp.number };
}

module.exports = { PHASES, determineNextUnit };
