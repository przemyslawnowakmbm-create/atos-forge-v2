'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOCK_FILE = 'auto.lock';

function lockPath(cwd) { return path.join(cwd, '.forge', 'session', LOCK_FILE); }

function ensureDir(cwd) {
  const dir = path.join(cwd, '.forge', 'session');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeLock(cwd, { taskId, waveN, phase, startedAt, agentId }) {
  ensureDir(cwd);
  const data = {
    pid: process.pid,
    taskId: taskId || null,
    waveN: waveN || null,
    phase: phase || null,
    startedAt: startedAt || new Date().toISOString(),
    agentId: agentId || null,
    completedUnits: 0,
  };
  fs.writeFileSync(lockPath(cwd), JSON.stringify(data, null, 2));
  return data;
}

function updateLock(cwd, updates) {
  const lock = readCrashLock(cwd);
  if (!lock) return null;
  Object.assign(lock, updates);
  fs.writeFileSync(lockPath(cwd), JSON.stringify(lock, null, 2));
  return lock;
}

function clearLock(cwd) {
  const p = lockPath(cwd);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* silent */ }
}

function readCrashLock(cwd) {
  const p = lockPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    try { process.kill(data.pid, 0); data.processAlive = true; }
    catch { data.processAlive = false; }
    return data;
  } catch { return null; }
}

function synthesizeRecovery(cwd, lockData) {
  const lines = ['## Crash Recovery Briefing\n'];
  lines.push(`Previous session crashed at: ${lockData.startedAt}`);
  lines.push(`Task: ${lockData.taskId || 'unknown'}`);
  lines.push(`Phase: ${lockData.phase || 'unknown'}`);
  if (lockData.waveN) lines.push(`Wave: ${lockData.waveN}`);
  lines.push('');
  try {
    const since = lockData.startedAt;
    const log = execSync(`git log --oneline --since="${since}" 2>/dev/null`, { cwd, encoding: 'utf8' }).trim();
    if (log) { lines.push('### Commits made before crash:'); lines.push('```'); lines.push(log); lines.push('```'); }
    else { lines.push('### No commits were made before crash.'); }
  } catch { lines.push('### Could not read git log.'); }
  try {
    const ledgerPath = path.join(cwd, '.forge', 'session', 'ledger.md');
    if (fs.existsSync(ledgerPath)) {
      const content = fs.readFileSync(ledgerPath, 'utf8');
      const lastEntries = content.split('\n').filter(l => l.startsWith('- ')).slice(-5);
      if (lastEntries.length) { lines.push('\n### Last ledger entries:'); lastEntries.forEach(e => lines.push(e)); }
    }
  } catch {}
  lines.push('\n### Recovery action: Resume from where the crash interrupted.');
  return lines.join('\n');
}

module.exports = { writeLock, updateLock, clearLock, readCrashLock, synthesizeRecovery };
