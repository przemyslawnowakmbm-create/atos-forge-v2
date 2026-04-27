/**
 * Knowledge base commands — extracted from forge-tools.cjs
 *
 * handleKnowledge: list, add, prune, promote
 */

const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

async function handleKnowledge(cwd, args, raw) {
  try {
    const knowledge = require(path.join(getForgeRoot(), 'forge-session', 'knowledge'));
    const sub = args[0];
    if (!sub || sub === 'list') {
      const data = knowledge.load(cwd);
      if (raw) {
        output(data, raw);
      } else if (data.learnings.length === 0) {
        console.log('No learnings in knowledge base.');
      } else {
        console.log(`\nKnowledge base: ${data.learnings.length} entries\n`);
        for (const l of data.learnings) {
          const mods = l.modules && l.modules.length > 0 ? ` [${l.modules.join(', ')}]` : '';
          const src = l.source_milestone ? ` (${l.source_milestone}${l.source_phase ? ', phase ' + l.source_phase : ''})` : '';
          console.log(`  ${l.id}  [${l.type}] ${(l.relevance || 'medium').toUpperCase()}${mods}${src}`);
          console.log(`         ${l.text}`);
          console.log('');
        }
      }
    } else if (sub === 'add') {
      const text = args[1];
      if (!text) {
        error('Usage: knowledge add <text> [--type <type>] [--modules <m1,m2>] [--relevance <level>]');
        return;
      }
      const typeIdx = args.indexOf('--type');
      const modIdx = args.indexOf('--modules');
      const relIdx = args.indexOf('--relevance');
      const type = typeIdx >= 0 ? args[typeIdx + 1] : 'convention';
      const modules = modIdx >= 0 ? args[modIdx + 1].split(',') : [];
      const relevance = relIdx >= 0 ? args[relIdx + 1] : 'medium';
      const result = knowledge.add(cwd, { text, type, modules, relevance });
      if (raw) {
        output(result, raw);
      } else if (result.added) {
        console.log(`Added learning ${result.id}`);
      } else {
        console.log(`Skipped: ${result.reason} (existing: ${result.id})`);
      }
    } else if (sub === 'prune') {
      const ids = args.slice(1).filter(a => !a.startsWith('--'));
      if (ids.length === 0) {
        error('Usage: knowledge prune <id1> [id2 ...]');
        return;
      }
      const result = knowledge.prune(cwd, ids);
      if (raw) {
        output(result, raw);
      } else {
        console.log(`Removed ${result.removed} entries, ${result.remaining} remaining.`);
      }
    } else if (sub === 'promote') {
      const ledger = require(path.join(getForgeRoot(), 'forge-session', 'ledger'));
      const content = ledger.read(cwd);
      if (!content) {
        error('No ledger found at ' + cwd);
        return;
      }
      const result = knowledge.promote(cwd, content);
      if (raw) {
        output(result, raw);
      } else {
        console.log(`Promoted ${result.promoted} learnings, skipped ${result.skipped} duplicates.`);
        if (result.entries.length > 0) {
          for (const e of result.entries) {
            console.log(`  ${e.id} [${e.type}] ${e.text.substring(0, 60)}...`);
          }
        }
      }
    } else {
      error('Unknown knowledge subcommand. Available: list, add, prune, promote');
    }
  } catch (e) {
    error('Knowledge error: ' + e.message);
  }
}

module.exports = { handleKnowledge };
