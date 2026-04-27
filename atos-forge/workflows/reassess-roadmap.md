<purpose>
Re-evaluate the project roadmap after a phase completes. Reads completed work, learnings, and warnings to determine
if the plan is still optimal. Proposes additions, removals, or reordering of future phases.
Triggered automatically after /forge-execute-phase or manually.
</purpose>

<process>

<step name="load_context">
Read the following files to understand current state:

1. .planning/ROADMAP.md — current phase plan with completion status
2. .planning/STATE.md — project position and recent activity
3. Most recent phase SUMMARY.md files — what was actually implemented
4. .forge/session/ledger.md — warnings, discoveries, decisions from agents

Present banner:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► ROADMAP REASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
</step>

<step name="analyze_delta">
Compare what was PLANNED vs what was IMPLEMENTED:

1. Did any phase take significantly longer or shorter than expected?
2. Were there unexpected discoveries that change future work?
3. Are there new dependencies between phases discovered during implementation?
4. Did agent warnings suggest architectural changes?
5. Were any planned phases made unnecessary by implementation decisions?
6. Are there new phases needed that weren't anticipated?
</step>

<step name="propose_changes">
Based on analysis, propose specific changes to the roadmap:

For each proposed change, explain:
- WHAT: Add phase / Remove phase / Reorder / Modify scope
- WHY: What evidence from completed work supports this change
- IMPACT: How it affects remaining timeline and dependencies

Present proposals to the user for review.
</step>

<step name="confirm_and_apply">
Ask the user to approve, modify, or reject each proposal.

For approved changes:
1. Update ROADMAP.md with new phase ordering
2. Handle renumbering if phases were inserted or removed
3. Update STATE.md with reassessment note
4. Log the reassessment decision to the session ledger

╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT: Reassessment Review                             ║
╚══════════════════════════════════════════════════════════════╝

Present the before/after roadmap diff for final approval.

──────────────────────────────────────────────────────────────
→ Type "approved" to apply changes, or describe modifications
──────────────────────────────────────────────────────────────
</step>

<step name="summary">
Report what was changed:

## Reassessment Complete

| Change | Phase | Reason |
|--------|-------|--------|
| Added  | ...   | ...    |
| Removed| ...   | ...    |
| Moved  | ...   | ...    |

───────────────────────────────────────────────────────────────

## Next Up

**Phase {N}: {name}** — {description}

`/forge-plan-phase {N}`

───────────────────────────────────────────────────────────────
</step>

</process>

<success_criteria>
- [ ] Current state loaded (ROADMAP, STATE, SUMMARYs, ledger)
- [ ] Delta analysis completed (planned vs implemented)
- [ ] Change proposals presented to user
- [ ] User approved/modified proposals
- [ ] ROADMAP.md updated
- [ ] STATE.md updated with reassessment note
- [ ] Ledger entry logged
</success_criteria>
