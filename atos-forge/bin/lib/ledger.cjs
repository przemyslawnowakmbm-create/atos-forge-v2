/**
 * Ledger commands — extracted from forge-tools.cjs
 *
 * handleLedger: read, state, compact, archive, reset, log-decision, log-warning,
 *   log-discovery, log-preference, log-error, log-rejected, update-state
 */

const { output, error, getLedger } = require('./core.cjs');

async function handleLedger(cwd, args, raw) {
  const sub = args[0];
  const ledger = getLedger(cwd);
  if (!ledger) { error('Session ledger module not found.'); return; }

  if (sub === 'read') {
    const content = ledger.read(cwd);
    if (raw) { output({ content: content || '' }, raw); }
    else { console.log(content || 'No ledger found.'); }
  } else if (sub === 'state') {
    output(ledger.readState(cwd), raw);
  } else if (sub === 'compact') {
    output(ledger.compact(cwd), raw);
  } else if (sub === 'archive') {
    const label = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    output(ledger.archive(cwd, label) || { message: 'No ledger to archive' }, raw);
  } else if (sub === 'reset') {
    const label = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const result = ledger.archiveAndReset(cwd, label);
    output({ archived: result, message: 'Ledger reset' }, raw);
  } else if (sub === 'log-decision') {
    const decision = args[1];
    if (!decision) { error('Usage: ledger log-decision "text" [--rationale "why"] [--rejected "alt"]'); return; }
    const rationale = args.includes('--rationale') ? args[args.indexOf('--rationale') + 1] : undefined;
    const rejected = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--rejected' && args[i + 1]) rejected.push(args[i + 1]);
    }
    ledger.logDecision(cwd, { decision, rationale, rejected_alternatives: rejected.length ? rejected : undefined });
    output({ logged: true }, raw);
  } else if (sub === 'log-warning') {
    const warning = args[1];
    if (!warning) { error('Usage: ledger log-warning "text" [--severity high] [--source agent-id]'); return; }
    const severity = args.includes('--severity') ? args[args.indexOf('--severity') + 1] : 'medium';
    const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
    ledger.logWarning(cwd, { warning, severity, source });
    output({ logged: true }, raw);
  } else if (sub === 'log-discovery') {
    const discovery = args[1];
    if (!discovery) { error('Usage: ledger log-discovery "text" [--source agent-id]'); return; }
    const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
    ledger.logDiscovery(cwd, { discovery, source });
    output({ logged: true }, raw);
  } else if (sub === 'log-preference') {
    const preference = args[1];
    if (!preference) { error('Usage: ledger log-preference "text"'); return; }
    ledger.logUserPreference(cwd, { preference });
    output({ logged: true }, raw);
  } else if (sub === 'log-error') {
    const errorText = args[1];
    if (!errorText) { error('Usage: ledger log-error "text" [--fix "fix text"] [--auto-fixed]'); return; }
    const fix = args.includes('--fix') ? args[args.indexOf('--fix') + 1] : undefined;
    const autoFixed = args.includes('--auto-fixed');
    ledger.logError(cwd, { error: errorText, fix_applied: fix, auto_fixed: autoFixed });
    output({ logged: true }, raw);
  } else if (sub === 'log-rejected') {
    const approach = args[1];
    if (!approach) { error('Usage: ledger log-rejected "approach" --reason "why" [--better "alt"]'); return; }
    const reason = args.includes('--reason') ? args[args.indexOf('--reason') + 1] : 'no reason given';
    const better = args.includes('--better') ? args[args.indexOf('--better') + 1] : undefined;
    ledger.logRejected(cwd, { approach, reason, better_alternative: better });
    output({ logged: true }, raw);
  } else if (sub === 'update-state') {
    const stateJson = args[1];
    if (!stateJson) { error('Usage: ledger update-state \'{"active_phase":3}\''); return; }
    try {
      ledger.updateState(cwd, JSON.parse(stateJson));
      output({ updated: true }, raw);
    } catch (e) { error('Invalid JSON: ' + e.message); }
  } else {
    error('Unknown ledger subcommand. Available: read, state, compact, archive, reset, log-decision, log-warning, log-discovery, log-preference, log-error, log-rejected, update-state');
  }
}

module.exports = { handleLedger };
