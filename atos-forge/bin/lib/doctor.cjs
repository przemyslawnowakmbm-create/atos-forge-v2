/**
 * Doctor command — extracted from forge-tools.cjs
 *
 * handleDoctor: run health checks via forge-config/doctor
 */

const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

async function handleDoctor(cwd, args, raw) {
  try {
    const doctor = require(path.join(getForgeRoot(), 'forge-config', 'doctor'));
    const result = doctor.doctor(cwd, { json: raw });
    if (raw) output(result, raw);
  } catch (e) {
    error('Doctor error: ' + e.message);
  }
}

module.exports = { handleDoctor };
