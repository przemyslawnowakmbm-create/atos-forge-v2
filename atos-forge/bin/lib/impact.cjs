/**
 * Impact analysis commands — extracted from forge-tools.cjs
 *
 * handleImpact: analyze, show
 */

const fs = require('fs');
const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

async function handleImpact(cwd, args, raw) {
  try {
    const analyzer = require(path.join(getForgeRoot(), 'forge-analyze', 'analyzer'));
    const sub = args[0];
    if (!sub || sub === 'analyze') {
      const phaseIdx = args.indexOf('--phase');
      const goalIdx = args.indexOf('--goal');
      const dbIdx = args.indexOf('--db');
      const phaseNumber = phaseIdx >= 0 ? parseInt(args[phaseIdx + 1], 10) : null;
      const goalText = goalIdx >= 0 ? args[goalIdx + 1] : '';
      const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

      // Auto-read phase goal from ROADMAP.md
      let phaseGoal = goalText;
      if (!phaseGoal && phaseNumber) {
        try {
          const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
          // Match "## Phase N: Title" and grab the title + first paragraph
          const re = new RegExp(`##\\s*Phase\\s+${phaseNumber}[:\\s]+([^\\n]+)(?:\\n([\\s\\S]*?)(?=\\n##|$))`, 'i');
          const m = roadmap.match(re);
          if (m) {
            const title = m[1].trim();
            const body = (m[2] || '').trim().split('\n').slice(0, 5).join('\n'); // first 5 lines
            phaseGoal = title + (body ? '\n' + body : '');
          }
        } catch { /* no roadmap */ }
      }

      // Auto-read requirements
      let requirements = '';
      try {
        const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
        if (fs.existsSync(reqPath)) {
          requirements = fs.readFileSync(reqPath, 'utf8');
        }
      } catch { /* no requirements */ }

      const result = analyzer.analyzeRequirement(cwd, {
        phase_goal: phaseGoal,
        phase_requirements: requirements,
        system_db: dbPath,
      });

      // Write IMPACT files if --write flag or phase specified
      if (phaseNumber && args.includes('--write')) {
        const written = analyzer.writeImpact(cwd, phaseNumber, result, phaseGoal);
        if (written) result._written = written;
      }

      if (raw || args.includes('--json')) {
        output(result, true);
      } else {
        const md = analyzer.generateImpactMarkdown(result, phaseNumber, phaseGoal || 'Unknown');
        console.log(md);
      }
    } else if (sub === 'show') {
      const phaseIdx = args.indexOf('--phase');
      const phaseNumber = phaseIdx >= 0 ? parseInt(args[phaseIdx + 1], 10) : null;
      if (!phaseNumber) {
        error('Usage: impact show --phase <N>');
        return;
      }
      const padded = String(phaseNumber).padStart(2, '0');
      const mdPath = path.join(cwd, '.planning', 'phases', padded, `${padded}-IMPACT.md`);
      if (fs.existsSync(mdPath)) {
        console.log(fs.readFileSync(mdPath, 'utf8'));
      } else {
        error(`No IMPACT.md found for phase ${phaseNumber}`);
      }
    } else {
      error('Unknown impact subcommand. Available: analyze, show');
    }
  } catch (e) {
    error('Impact analysis error: ' + e.message);
  }
}

module.exports = { handleImpact };
