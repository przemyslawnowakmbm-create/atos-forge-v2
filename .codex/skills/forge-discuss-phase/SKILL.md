---
name: forge-discuss-phase
description: Gather phase context through adaptive questioning before planning
---

<execution_context>
@~/.codex/forge/atos-forge/references/agent-directives.md
@~/.codex/forge/atos-forge/workflows/discuss-phase.md
@~/.codex/forge/atos-forge/templates/context.md
</execution_context>

<objective>
Extract implementation decisions that downstream agents need — researcher and planner will use CONTEXT.md to know what to investigate and what choices are locked.

**How it works:**
1. Analyze the phase to identify gray areas (UI, UX, behavior, etc.)
2. Present gray areas — user selects which to discuss
3. Deep-dive each selected area until satisfied
4. Create CONTEXT.md with decisions that guide research and planning

**Output:** `{phase_num}-CONTEXT.md` — decisions clear enough that downstream agents can act without asking the user again
</objective>

<context>
Phase number: $ARGUMENTS (required)

**Load project state:**
@.planning/STATE.md

**Load roadmap:**
@.planning/ROADMAP.md

**Load upstream decisions (if they exist):**
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
</context>

<process>
1. Validate phase number (error if missing or not in roadmap)
2. Check if CONTEXT.md exists (offer update/view/skip if yes)
3. **Load upstream docs** — Read PROJECT.md, REQUIREMENTS.md, phase research for pre-answered decisions
4. **Analyze phase** — Identify domain, filter out pre-answered decisions, generate remaining gray areas
5. **Present gray areas** — Show pre-answered decisions, then multi-select remaining areas (NO skip option)
6. **Deep-dive each area** — ask until decisions are captured, then offer more/next
7. **Write CONTEXT.md** — Sections match areas discussed, plus upstream decisions carried forward
8. Offer next steps (research or plan)

**CRITICAL: Scope guardrail**
- Phase boundary from ROADMAP.md is FIXED
- Discussion clarifies HOW to implement, not WHETHER to add more
- If user suggests new capabilities: "That's its own phase. I'll note it for later."
- Capture deferred ideas — don't lose them, don't act on them

**Domain-aware gray areas:**
Gray areas depend on what's being built. Analyze the phase goal:
- Something users SEE → layout, density, interactions, states
- Something users CALL → responses, errors, auth, versioning
- Something users RUN → output format, flags, modes, error handling
- Something users READ → structure, tone, depth, flow
- Something being ORGANIZED → criteria, grouping, naming, exceptions

Generate as many **phase-specific** gray areas as the phase actually needs (typically 2-6) — don't pad or cut to hit a fixed number.

**Probing depth:**
- Ask questions until the area's key decisions are resolved
- Typical range: 2-6 questions per area (simple areas need fewer, complex ones more)
- After resolution or 6 questions max → "Anything else about [area], or move on?"
- If more → continue asking, check again after resolution
- After all areas → "Ready to create context?"

**Do NOT ask about (Codex handles these):**
- Technical implementation
- Architecture choices
- Performance concerns
- Scope expansion
</process>

<success_criteria>
- Gray areas identified through intelligent analysis
- User chose which areas to discuss
- Each selected area explored until satisfied
- Scope creep redirected to deferred ideas
- CONTEXT.md captures decisions, not vague vision
- User knows next steps
</success_criteria>
