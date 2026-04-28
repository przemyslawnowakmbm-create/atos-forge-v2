# Token Consumption Audit — Forge V2

Generated: 2026-04-28T21:41:38.503Z

## V1 vs V2 Comparison

| Metric | V1 (post-remediation) | V2 (current) | Delta |
|---|---|---|---|
| **Total static prompt footprint** | **174,101** | **242,266** | **+68,165 (39.2%)** |
| Agent definitions | 60,704 | 119,237 (agents + catalog) | +58,533 |
| References | 24,581 | 24,585 | +4 |
| Workflows + Skills | 88,816 | 98,444 | 9,628 |

**Why V2 is +39% larger in static footprint:**
- **+55,351 tokens**: 18 new catalog agents (did not exist in V1)
- **+3,182 tokens**: Agent definitions grew (executor gained test-first protocol, two-stage awareness)
- **−5,555 tokens**: Workflows shrank (execute-phase 1,024→415 lines, auto.md deleted)
- **+15,183 tokens**: 41 skill files (existed in V1 but not measured in original audit)

The catalog agents are the dominant new cost. However, they are NOT all loaded per execution — only the matched agents are injected.

## What Actually Loads Per Execution

The static footprint (242K tokens) is misleading. Here is what actually enters the LLM context for a single plan execution:

| Component | Tokens | Source |
|---|---|---|
| Primary catalog agent body (pruned) | ~3,000-4,000 | security-engineer, nextjs-api, etc. |
| Secondary agent expertise (2 agents) | ~1,500-2,000 | Extracted + renamed H3 sections |
| Constitution | ~393 | .forge/constitution.md |
| Agent directives | ~800 | atos-forge/references/agent-directives.md |
| Execution rules | ~100 | BASE_EXECUTOR_RULES constant |
| Session context (ledger + knowledge) | ~200-500 | Decisions, warnings, preferences |
| Locked decisions | ~50-100 | From plan frontmatter |
| Grounding facts (if graph exists) | ~200-400 | Code graph file metadata |
| Structured output format | ~150 | JSON template |
| **System prompt total** | **~6,100-7,500** | Measured: 6,133 for auth plan |
| Plan content (task prompt) | ~800-1,500 | The actual PLAN.md |
| Test-first stubs | ~500-1,000 | Generated failing tests |
| **Total input per plan** | **~7,400-10,000** | Measured: 8,368 for auth plan |

**Context utilization: 4.2%** of 200K window for a typical plan. This leaves 191K+ tokens for the agent to think and work.

## Per-Category Breakdown

| Category | Files | Tokens | Type | Loaded when? |
|---|---|---|---|---|
| Agent Definitions | 12 | 63,886 | prompt | Per workflow (executor, planner, verifier, etc.) |
| Catalog Agents | 18 | 55,351 | prompt | Per plan — only matched agents loaded + pruned |
| References | 13 | 24,585 | prompt | Per agent — injected as context |
| Workflows | 34 | 83,261 | prompt | Per command invocation |
| Skills | 41 | 15,183 | prompt | Per slash command — one skill at a time |
| Templates | 31 | 42,512 | static | During init/scaffold — not at runtime |
| Engine Modules | 71 | 415,115 | code | Code execution — not in LLM context |
| Documentation | 4 | 35,989 | static | Never loaded into LLM context |

## Top 10 Largest Files (prompt category)

| File | Tokens | Category |
|---|---|---|
| agents/forge-planner.md | 11,517 | Agent Definitions |
| agents/forge-debugger.md | 8,943 | Agent Definitions |
| agents/forge-plan-checker.md | 8,421 | Agent Definitions |
| atos-forge/workflows/new-project.md | 7,950 | Workflows |
| atos-forge/references/checkpoints.md | 7,031 | References |
| agents/forge-verifier.md | 6,619 | Agent Definitions |
| atos-forge/workflows/verify-work.md | 5,919 | Workflows |
| agents/forge-executor.md | 5,165 | Agent Definitions |
| atos-forge/workflows/plan-phase.md | 4,964 | Workflows |
| atos-forge/workflows/execute-plan.md | 4,765 | Workflows |

## Pruning Effectiveness

Dynamic prompt pruning removes irrelevant H3 sections from catalog agents before injection.
Measured from the ShopNova auth plan simulation:

| Agent | Raw tokens | After pruning | Reduction |
|---|---|---|---|
| security-engineer (primary) | ~3,900 | ~3,370 | 13.6% |
| database-engineer (secondary) | ~3,629 | ~2,716 | 25.2% |
| nextjs-api (secondary) | ~3,201 | ~3,054 | 4.6% |

Average effective pruning: ~15% per agent. The pruning uses word-boundary matching against plan-specific technology signals to remove unrelated framework/ORM/language sections.

## V2 Execution Cost Model

Assuming Claude Sonnet pricing (~/M input, ~/M output):

| Phase | Input tokens | Output tokens (est.) | Input cost | Output cost | Total |
|---|---|---|---|---|---|
| Plan execution (1 plan) | ~8,400 | ~15,000 | /bin/bash.025 | /bin/bash.225 | **/bin/bash.25** |
| Verification (8 layers) | ~2,000 | ~1,000 | /bin/bash.006 | /bin/bash.015 | /bin/bash.02 |
| Semantic verifier (opt-in) | ~10,000 | ~2,000 | /bin/bash.030 | /bin/bash.030 | /bin/bash.06 |
| Fix loop (per attempt) | ~10,000 | ~10,000 | /bin/bash.030 | /bin/bash.150 | /bin/bash.18 |
| **Typical plan (no fix loop)** | | | | | **~/bin/bash.27** |
| **Plan with 1 fix attempt** | | | | | **~/bin/bash.45** |
| **Phase (3 plans, no fixes)** | | | | | **~/bin/bash.81** |
| **Full project (10 plans)** | | | | | **~.70** |

With Opus pricing (~/M input, ~/M output), multiply by ~5x:
- Typical plan: ~.35
- Full project (10 plans): ~.50

## Optimization Opportunities

| Opportunity | Savings | Effort | Priority |
|---|---|---|---|
| Improve pruning specificity (remove more irrelevant sections) | ~500-1,000 tokens/plan | Medium | P2 |
| Lazy-load agent directives only for executor (not planner/verifier) | ~800 tokens for non-executor | Low | P3 |
| Compress session context (summarize instead of raw bullets) | ~100-300 tokens | Low | P3 |
| Route verification layers to cheaper models (haiku for L1-4) | 50-70% cost reduction on verification | Medium | P1 |
| Cache system prompts across plans in same phase | Avoid recomputing for each plan | Low | P2 |

## Conclusion

V2 has a larger static footprint (+39%) than V1, entirely due to the 18 catalog agents (+55K tokens). However, the **per-execution cost is low**: only 4.2% of the context window is consumed by Forge scaffolding, leaving 96% for the agent to work.

The critical metric is per-plan input tokens (~8,400), not static footprint. At Sonnet pricing, a full 10-plan project costs ~.70 in Forge overhead. The actual code generation tokens (agent output) dominate the cost at ~.50 for the same project.

Forge scaffolding is ~10% of total execution cost. The verification, test-first, constitution, and drift enforcement features justify this overhead by reducing rework and bugs.
