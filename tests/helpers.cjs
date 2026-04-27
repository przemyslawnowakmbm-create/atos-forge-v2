const fs = require('fs');
const path = require('path');
const os = require('os');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
}
function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function createPlanningDir(tmpDir) {
  const planning = path.join(tmpDir, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({ mode: 'interactive' }));
  fs.writeFileSync(path.join(planning, 'STATE.md'), '# State\n\n## Current Phase\nPhase 1\n\n## Position\nStarting\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Foundation\n- [ ] Setup\n');
  return planning;
}
module.exports = { createTmpDir, cleanTmpDir, createPlanningDir };
