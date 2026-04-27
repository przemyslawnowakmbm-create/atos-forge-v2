---
name: forge-set-profile
description: Switch model profile for Forge agents (quality/balanced/budget)
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/set-profile.md
</execution_context>

<objective>
Switch the model profile used by Forge agents. Controls which Codex model each agent uses, balancing quality vs token spend.

Routes to the set-profile workflow which handles:
- Argument validation (quality/balanced/budget)
- Config file creation if missing
- Profile update in config.json
- Confirmation with model table display
</objective>

<process>
**Follow the set-profile workflow** from `@~/.codex/forge/atos-forge/workflows/set-profile.md`.

The workflow handles all logic including:
1. Profile argument validation
2. Config file ensuring
3. Config reading and updating
4. Model table generation from MODEL_PROFILES
5. Confirmation display
</process>
