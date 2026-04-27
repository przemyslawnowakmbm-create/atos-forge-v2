---
name: forge-impact
description: Analyze change impact for a file or phase
argument-hint: "<file-or-phase> [--depth N]"
allowed-tools:
  - Bash
  - Read
---

<execution_context>
@~/.claude/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Run impact analysis on a file or all files in a phase's plans. Shows: consumers, transitive dependents, module boundary crossings, risk level, required capabilities.
</objective>

<context>
Arguments: $ARGUMENTS

**Modes:**
- `<file-path>` — Analyze a single file (e.g., `src/auth/login.ts`)
- `<phase-number>` — Analyze all `files_modified` from plans in that phase
- `--depth N` — How deep to trace transitive dependencies (default: 2)
</context>

<process>

## 1. Check Graph Exists

```bash
STATUS=$(node ~/.claude/atos-forge/bin/forge-tools.cjs graph status)
GRAPH_EXISTS=$(echo "$STATUS" | jq -r '.graph_exists')
```

**If graph doesn't exist:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► NO CODE GRAPH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Run `/forge-init` first to build the code graph.
```
Exit.

## 2. Determine Mode

Parse $ARGUMENTS:
- If argument looks like a phase number (integer or decimal): use `--phase` mode
- If argument looks like a file path (contains `/` or `.`): use file mode
- Pass through `--depth N` if present

## 3. Run Analysis

**File mode:**
```bash
IMPACT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs graph impact "$FILE" --depth $DEPTH)
```

**Phase mode:**
```bash
IMPACT=$(node ~/.claude/atos-forge/bin/forge-tools.cjs graph impact --phase "$PHASE")
```

## 4. Display Results

### For single file:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► IMPACT ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**File:** {file}
**Module:** {fileInfo.module} | **Stability:** {moduleInfo.stability}
**Risk:** {risk.level} (score {risk.score})

{If risk.reasons: bullet list of reasons}

### Exported Symbols ({exported.length})
{Table: name, kind, consumer_count}

### Direct Consumers ({directConsumers.length})
{Table: source_file, module, import_name}

### Transitive Impact ({transitiveImpact.length})
{Table: source_file, module, via, depth}

### Module Boundaries Crossed
{List of boundary crossings, or "None"}

### Capabilities Required
{List of capabilities for the module, or "None detected"}
```

### For phase:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► PHASE {N} IMPACT ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Files analyzed:** {summary.filesAnalyzed}
**Risk:** {risk.level}
**Consumers affected:** {summary.consumerCount}
**Module boundaries crossed:** {summary.boundariesCrossed}
**Test files to run:** {summary.testFileCount}

### Risk Reasons
{bullet list from risk.reasons}

### Module Boundaries
{list of boundaries, source -> target}

### Capability Requirements
{by module: list of capabilities}
```

## 5. Risk Warnings

If risk level is **HIGH** or **CRITICAL**, add:
```
⚠ HIGH/CRITICAL risk — changes affect many consumers across module boundaries.
Consider: incremental changes, extra test coverage, peer review.
```

</process>
