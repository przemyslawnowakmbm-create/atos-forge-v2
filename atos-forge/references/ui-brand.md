<ui_patterns>

Visual patterns for user-facing Forge output. Orchestrators @-reference this file.

## Stage Banners

Use for major workflow transitions.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► {STAGE NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Stage names (uppercase):**
- `QUESTIONING`
- `RESEARCHING`
- `DEFINING REQUIREMENTS`
- `CREATING ROADMAP`
- `PLANNING PHASE {N}`
- `EXECUTING WAVE {N}`
- `VERIFYING`
- `PHASE {N} COMPLETE ✓`
- `MILESTONE COMPLETE 🎉`

---

## Checkpoint Boxes

User action required. 62-character width.

```
╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT: {Type}                                          ║
╚══════════════════════════════════════════════════════════════╝

{Content}

──────────────────────────────────────────────────────────────
→ {ACTION PROMPT}
──────────────────────────────────────────────────────────────
```

**Types:**
- `CHECKPOINT: Verification Required` → `→ Type "approved" or describe issues`
- `CHECKPOINT: Decision Required` → `→ Select: option-a / option-b`
- `CHECKPOINT: Action Required` → `→ Type "done" when complete`

---

## Status Symbols

```
✓  Complete / Passed / Verified
✗  Failed / Missing / Blocked
◆  In Progress
○  Pending
⚡ Auto-approved
⚠  Warning
🎉 Milestone complete (only in banner)
```

---

## Progress Display

**Phase/milestone level:**
```
Progress: ████████░░ 80%
```

**Task level:**
```
Tasks: 2/4 complete
```

**Plan level:**
```
Plans: 3/5 complete
```

---

## Spawning Indicators

```
◆ Spawning researcher...

◆ Spawning 4 researchers in parallel...
  → Stack research
  → Features research
  → Architecture research
  → Pitfalls research

✓ Researcher complete: STACK.md written
```

---

## Next Up Block

Always at end of major completions.

```
───────────────────────────────────────────────────────────────

## ▶ Next Up

**{Identifier}: {Name}** — {one-line description}

`{copy-paste command}`

<sub>`/clear` first → fresh context window</sub>

───────────────────────────────────────────────────────────────

**Also available:**
- `/forge-alternative-1` — description
- `/forge-alternative-2` — description

───────────────────────────────────────────────────────────────
```

---

## Error Box

```
╔══════════════════════════════════════════════════════════════╗
║  ERROR                                                       ║
╚══════════════════════════════════════════════════════════════╝

{Error description}

**To fix:** {Resolution steps}
```

---

## Tables

```
| Phase | Status | Plans | Progress |
|-------|--------|-------|----------|
| 1     | ✓      | 3/3   | 100%     |
| 2     | ◆      | 1/4   | 25%      |
| 3     | ○      | 0/2   | 0%       |
```

---

## Anti-Patterns

- Varying box/banner widths
- Mixing banner styles (`===`, `---`, `***`)
- Skipping `Forge ►` prefix in banners
- Random emoji (`🚀`, `✨`, `💫`)
- Missing Next Up block after completions

---

## Information Hierarchy

Structure output so users can scan quickly without reading every line.

**Bold** for key data the user needs to act on:
- Plan names, file paths, status verdicts, commands to run

Plain text for supporting context:
- Descriptions, explanations, rationale

`Code` for anything copy-pasteable:
- Commands, file paths, config values

<sub>Small text</sub> for secondary guidance:
- `/clear` reminders, alternative commands, tips

**Hierarchy order in any output block:**
1. Status/verdict first (passed, failed, 3/5 complete)
2. Key details second (what changed, what's next)
3. Supporting context last (why, alternatives)

---

## Spacing Rhythm

Consistent vertical spacing prevents visual clutter.

```
[Banner]
                          ← 1 empty line after banner
Content paragraph.
                          ← 1 empty line between sections
| Table | Data |
| ----- | ---- |
                          ← 1 empty line after table
Next section.
                          ← 1 empty line before box
╔════════════════════════╗
║  CHECKPOINT            ║
╚════════════════════════╝
                          ← 1 empty line after box
```

**Rules:**
- 1 empty line between all sections — never 0, never 2+
- No trailing whitespace inside boxes
- Tables: align columns, pad cells with 1 space minimum
- Lists: no blank lines between items in the same list

---

## Terminal Color Coding

When using colored output (chalk, ANSI), follow consistent meaning:

| Color | Meaning | Use For |
|-------|---------|---------|
| Green | Success / safe | ✓ marks, "passed", "complete", file created |
| Yellow | Warning / attention | ⚠ marks, "skipped", degraded state, suggestions |
| Red | Error / failure | ✗ marks, "failed", "blocked", error messages |
| Cyan | Info / reference | File paths, commands, URLs, identifiers |
| Dim/gray | Secondary | Timestamps, metadata, hints, sub-text |
| White (default) | Primary content | Body text, descriptions, labels |

**Rules:**
- Never use color as the ONLY indicator — always pair with a symbol (✓/✗/⚠/◆/○)
- Keep colored spans short (a word or symbol, not full sentences)
- Dim text for anything the user can safely ignore on first scan

</ui_patterns>
