'use strict';

const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

async function cmdVerifyRegression(cwd, args, raw) {
  const regression = require(path.join(getForgeRoot(), 'forge-verify', 'regression'));
  const opts = { cwd };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' || args[i] === '--raw') opts.json = true;
    if (args[i] === '--update-baseline') opts.updateBaseline = true;
    if (args[i] === '--phase' && args[i + 1]) opts.phase = parseInt(args[++i], 10);
  }
  if (raw) opts.json = true;

  const result = regression.runRegression(cwd, opts);

  if (opts.updateBaseline && result.passed) {
    regression.saveBaseline(cwd, result, opts.phase || 0);
  }

  if (opts.json || raw) {
    output(result, raw);
  } else {
    console.log('Regression: ' + (result.passed ? 'PASS' : 'FAIL'));
    console.log('Tests: ' + result.passed_tests + '/' + result.total_tests);
    if (result.regressions && result.regressions.length > 0) {
      console.log('Regressions: ' + result.regressions.length);
      for (const r of result.regressions) console.log('  - ' + r.test_file);
    }
  }
}

module.exports = { cmdVerifyRegression };
