<overview>
Session continuity for Forge framework. The session ledger persists critical context across context compaction, /clear, and full session restarts.
</overview>

<core_principle>

**The ledger is your memory when context is lost.**

After compaction or restart, the ledger contains decisions, warnings, preferences, and execution state that would otherwise be gone. Trust it over summarized conversation history when they conflict.
</core_principle>

<session_continuity_rule>

## Session Continuity

If `.forge/session/ledger.md` exists, **ALWAYS** read it at the start of your first response in a new context or after compaction. It contains:

- **Current execution state** (phase, wave, what's done) — know where you are
- **Decisions made and rationale** (don't re-ask these questions) — respect prior choices
- **Warnings from agents** (load into context for downstream agents) — don't repeat mistakes
- **User preferences for this session** (respect these) — honor what the user asked for
- **Rejected approaches** (don't retry these) — avoid wasting time on known dead ends

**Trust the ledger over summarized conversation history when they conflict.**

</session_continuity_rule>

<when_to_write>

## When to Write to the Ledger

The ledger is written automatically by forge commands at these points:

| Event | Logged As | Section |
|-------|-----------|---------|
| User expresses a preference | `log-preference` | User Preferences |
| Decision is made (planning, discussion) | `log-decision` | Decisions |
| Agent reports a warning or issue | `log-warning` | Warnings & Discoveries |
| Agent discovers something notable | `log-discovery` | Warnings & Discoveries |
| Wave completes during execution | `update-state` + `log-decision` | Current State + Completed Work |
| Verification passes/fails | `log-decision` or `log-warning` | Decisions or Warnings |
| Error occurs and is fixed | `log-error` | Errors & Fixes |
| Approach is rejected | `log-rejected` | Rejected Approaches |
| Phase completes | `archive` | Archived to .forge/session/archive/ |

**Any command where the user expresses a preference should log it:**
```bash
node ~/.claude/atos-forge/atos-forge/bin/forge-tools.cjs ledger log-preference "User preference text"
```

</when_to_write>

<how_to_read>

## How to Read the Ledger

```bash
# Full content (for reading at session start)
node ~/.claude/atos-forge/atos-forge/bin/forge-tools.cjs ledger read

# Just the state summary (for quick checks)
node ~/.claude/atos-forge/atos-forge/bin/forge-tools.cjs ledger state
```

**At session start or after compaction:**
1. Check if `.forge/session/ledger.md` exists
2. If yes: read it with the `Read` tool
3. Load decisions, warnings, and preferences into your working context
4. Continue from where the ledger says work was left off

</how_to_read>

<cli_reference>

## CLI Commands

```bash
# Read operations
forge-tools ledger read              # Full ledger content
forge-tools ledger state             # JSON state summary

# Write operations
forge-tools ledger log-decision "text" [--rationale "why"] [--rejected "alt"]
forge-tools ledger log-warning "text" [--severity high] [--source agent-id]
forge-tools ledger log-discovery "text" [--source agent-id]
forge-tools ledger log-preference "text"
forge-tools ledger log-error "text" [--fix "fix text"] [--auto-fixed]
forge-tools ledger log-rejected "approach" --reason "why" [--better "alt"]
forge-tools ledger update-state '{"active_phase":3,"current_wave":"2 of 4"}'

# Maintenance
forge-tools ledger compact           # Shrink to target size
forge-tools ledger archive [label]   # Archive current ledger
forge-tools ledger reset [label]     # Archive and create fresh ledger
```

</cli_reference>

<programmatic_api>

## Node.js API

```javascript
const ledger = require('~/.claude/forge-session/ledger');

// State tracking
ledger.updateState(cwd, { active_phase: 3, current_wave: '2 of 4', status: 'executing' });

// Logging
ledger.logDecision(cwd, { decision: "Use JWT", rationale: "Stateless auth", rejected_alternatives: ["Sessions"] });
ledger.logWarning(cwd, { warning: "Rate limiter missing", severity: "high", source: "agent-001" });
ledger.logDiscovery(cwd, { discovery: "API supports batch operations", source: "agent-002" });
ledger.logUserPreference(cwd, { preference: "Don't touch legacy code" });
ledger.logError(cwd, { error: "Type mismatch", fix_applied: "Added type guard", auto_fixed: true });
ledger.logRejected(cwd, { approach: "Polling", reason: "Too slow", better_alternative: "WebSockets" });

// Reading
const content = ledger.read(cwd);       // Full markdown
const state = ledger.readState(cwd);     // Structured object

// Maintenance
ledger.compact(cwd);                     // Shrink if needed
ledger.archive(cwd, 'phase-3');          // Archive to .forge/session/archive/
ledger.archiveAndReset(cwd, 'phase-3');  // Archive + fresh ledger (preserves preferences)
```

</programmatic_api>

<size_management>

## Size Management

- **Target:** Keep ledger under 8,000 tokens (~32KB) — loadable in one pass
- **Auto-compact trigger:** When ledger exceeds 10,000 tokens (~40KB)
- **Compaction strategy:**
  - Completed work from older entries → one-line summaries
  - Auto-fixed errors → summarized count
  - **Never deleted:** Decisions, warnings, user preferences, rejected approaches
- **Archival:** On phase completion, ledger is archived to `.forge/session/archive/phase-N-ledger.md`
  - Fresh ledger created, user preferences carried forward
  - Last 50 archives kept

</size_management>
