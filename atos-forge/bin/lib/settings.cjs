/**
 * Settings commands — extracted from forge-tools.cjs
 *
 * handleSettings: show, recommend, validate, get, set
 */

const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

async function handleSettings(cwd, args, raw) {
  try {
    const settings = require(path.join(getForgeRoot(), 'forge-config', 'settings'));
    const forgeConfig = require(path.join(getForgeRoot(), 'forge-config', 'config'));
    const sub = args[0];
    if (sub === 'recommend') {
      const result = settings.recommend(cwd, { json: raw });
      if (raw) output(result, raw);
    } else if (sub === 'validate') {
      const { config: effective } = forgeConfig.loadConfig(cwd);
      const result = forgeConfig.validate(effective);
      output(result, raw);
    } else if (sub === 'get' && args[1]) {
      const keyPath = args[1];
      const { config: effective } = forgeConfig.loadConfig(cwd);
      const keys = keyPath.split('.');
      let value = effective;
      for (const k of keys) {
        if (value && typeof value === 'object') value = value[k];
        else { value = undefined; break; }
      }
      output({ key: keyPath, value }, raw, String(value));
    } else if (sub === 'set' && args[1] && args[2]) {
      const keyPath = args[1];
      const rawValue = args[2];
      // Parse value: boolean, number, null, or string
      let value;
      if (rawValue === 'true') value = true;
      else if (rawValue === 'false') value = false;
      else if (rawValue === 'null') value = null;
      else if (!isNaN(rawValue) && rawValue !== '') value = Number(rawValue);
      else value = rawValue;
      // Validate FIRST — build a candidate config and check before saving
      const { config: projectCfg } = forgeConfig.loadProjectConfig(cwd);
      const cfg = JSON.parse(JSON.stringify(projectCfg || {}));
      const keys = keyPath.split('.');
      let target = cfg;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]] || typeof target[keys[i]] !== 'object') target[keys[i]] = {};
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;
      // Validate the candidate merged config
      const candidateDefaults = forgeConfig.getDefault();
      forgeConfig.deepMerge(candidateDefaults, cfg);
      const validation = forgeConfig.validate(candidateDefaults);
      if (!validation.valid) {
        // Reject — don't save invalid config
        output({ updated: false, key: keyPath, value, valid: false, errors: validation.errors }, raw);
      } else {
        // Save only after validation passes
        forgeConfig.saveProjectConfig(cwd, cfg);
        output({ updated: true, key: keyPath, value, valid: true, errors: [] }, raw);
      }
    } else {
      // Default: show all settings
      const result = settings.showSettings(cwd, { json: raw, section: sub || undefined });
      if (raw && result) output(result, raw);
    }
  } catch (e) {
    error('Settings error: ' + e.message);
  }
}

module.exports = { handleSettings };
