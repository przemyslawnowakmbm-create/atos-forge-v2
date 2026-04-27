---
name: forge-init
description: Build the code graph and initialize .forge/ infrastructure
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
</execution_context>

<objective>
Build the full code graph for this repository, install incremental-update git hooks, and detect capabilities. Creates the .forge/ directory with graph.db.
</objective>

<context>
Arguments: $ARGUMENTS (optional --root flag to specify repo root)

This command must run before other graph-dependent features work. If .forge/graph.db already exists, it will be rebuilt from scratch.
</context>

<process>

## 1. Build the Code Graph

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► INITIALIZING CODE GRAPH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Run the graph build:

```bash
RESULT=$(node ~/.codex/forge/atos-forge/bin/forge-tools.cjs graph init $ARGUMENTS)
```

Parse JSON result for: `success`, `build_time`, `total_files`, `total_symbols`, `module_count`, `dependency_count`, `hooks_installed`, `capabilities_detected`, `gitignore_updated`, `db_path`.

## 2. Report Results

Display completion:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Forge ► CODE GRAPH READY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Build time:** {build_time}
**Files indexed:** {total_files}
**Symbols found:** {total_symbols}
**Modules detected:** {module_count}
**Dependencies mapped:** {dependency_count}
**Git hooks:** {hooks_installed ? "Installed (auto-update on commit)" : "Not installed (no .git)"}
**Capabilities:** {capabilities_detected ? "Detected (see .forge/capabilities/)" : "Skipped"}
**Gitignore:** {gitignore_updated ? ".forge/ added to .gitignore" : ".forge/ already in .gitignore"}

Database: {db_path}

───────────────────────────────────────────────────────

The code graph powers:
- `$forge-impact <file>` — see what breaks when you change a file
- `$forge-graph-status` — graph health and hotspots
- Automatic risk assessment during `$forge-plan-phase` and `$forge-execute-phase`

Graph updates automatically after each git commit.
```

## 3. Error Handling

If `success` is false or build fails, display the error and suggest:
- Check that the repository has source files
- Try `node ~/.codex/forge/forge-graph/builder.js .` directly for verbose output

</process>
