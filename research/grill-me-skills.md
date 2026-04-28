# Grill-Me Skills Research: Requirements Grilling, Shared Language, and Requirement Quality

Research Date: 2026-04-27

## Executive Summary

The "grill-me" skill originates from **Matt Pocock** (`mattpocock/skills` on GitHub, 37K stars, 2.9K forks). It is part of a composable skill ecosystem designed for Claude Code and similar AI coding agents. The ecosystem addresses four core failure modes in AI-assisted development: misalignment, verbosity, broken code, and architectural decay. The grill-me pattern has been widely adopted, forked, and adapted across dozens of repositories.

---

## 1. Primary Source: mattpocock/skills

**URL**: https://github.com/mattpocock/skills
**Stars**: ~37,000 | **Forks**: ~2,900
**License**: MIT
**Description**: "Skills for Real Engineers. Straight from my .claude directory."

### Skills Relevant to Requirements/Shared Language

#### 1.1 `/grill-me` (Productivity)

**Path**: `skills/productivity/grill-me/SKILL.md`

The core skill. Minimalist prompt that interviews the user relentlessly about a plan or design until reaching shared understanding.

**Full content**:
```
Interview me relentlessly about every aspect of this plan until we reach a shared
understanding. Walk down each branch of the design tree, resolving dependencies
between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.
```

**Key patterns**:
- One question at a time (prevents overwhelm)
- Decision tree traversal (systematic branch resolution)
- AI provides recommended answers (not just questions)
- Codebase-first answers (avoid asking what can be discovered)
- No output until shared understanding is reached

#### 1.2 `/grill-with-docs` (Engineering)

**Path**: `skills/engineering/grill-with-docs/SKILL.md`

Enhanced version that adds domain model awareness and inline documentation updates.

**Additional capabilities beyond grill-me**:
- **Challenge against glossary**: When user terms conflict with `CONTEXT.md`, surface the conflict immediately
- **Sharpen fuzzy language**: Propose precise canonical terms for vague or overloaded words
- **Discuss concrete scenarios**: Stress-test domain relationships with invented edge-case scenarios
- **Cross-reference with code**: Check if code agrees with user's stated design; surface contradictions
- **Update CONTEXT.md inline**: Capture resolved terms immediately, not batched
- **Offer ADRs sparingly**: Only when decision is hard-to-reverse, surprising-without-context, AND result-of-real-trade-off

**Supporting formats**:
- `CONTEXT-FORMAT.md` - Shared language document (Language section, Relationships, Example dialogue, Flagged ambiguities)
- `ADR-FORMAT.md` - Architectural Decision Records (minimal: title + 1-3 sentence context/decision/why)

#### 1.3 `/ubiquitous-language` (Deprecated - merged into grill-with-docs)

**Path**: `skills/deprecated/ubiquitous-language/SKILL.md`

DDD-style ubiquitous language glossary extraction. Now superseded by the CONTEXT.md approach in grill-with-docs.

**What it did**:
- Scanned conversation for domain-relevant nouns, verbs, concepts
- Identified ambiguities (same word, different concepts) and synonyms (different words, same concept)
- Proposed canonical glossary with opinionated term choices
- Wrote `UBIQUITOUS_LANGUAGE.md` with tables (Term | Definition | Aliases to avoid)
- Included relationships section with cardinality
- Wrote example dialogue showing terms used precisely
- Flagged ambiguities section
- Idempotent: re-running updates existing document

#### 1.4 `/to-prd` (Engineering)

**Path**: `skills/engineering/to-prd/SKILL.md`

Converts conversation context into a PRD. Does NOT interview - synthesizes what is already known (designed to run after `/grill-me` or `/grill-with-docs`).

**PRD structure**: Problem Statement, Solution, User Stories (extensive numbered list), Implementation Decisions (modules, interfaces, schema, API contracts), Testing Decisions, Out of Scope, Further Notes.

**Key pattern**: Uses project domain glossary vocabulary throughout; respects ADRs.

#### 1.5 `/to-issues` (Engineering)

**Path**: `skills/engineering/to-issues/SKILL.md`

Breaks PRD into vertical slice issues (tracer bullets). Each issue cuts through ALL integration layers end-to-end.

**Key patterns**:
- HITL (human-in-the-loop) vs AFK (autonomous) slice classification
- Dependency tracking between slices
- User story coverage mapping
- Interactive breakdown review before publishing

#### 1.6 `/improve-codebase-architecture` (Engineering)

**Path**: `skills/engineering/improve-codebase-architecture/SKILL.md`

Finds deepening opportunities informed by CONTEXT.md and ADRs. Uses the "deletion test" to identify shallow modules. Drops into a grilling loop when user picks a candidate. Updates CONTEXT.md inline as terms crystallize.

### Matt Pocock's Design Philosophy

From the README, the four failure modes these skills address:

1. **Misalignment** ("The Agent Didn't Do What I Want") - Fixed by `/grill-me` and `/grill-with-docs`
2. **Verbosity** ("The Agent Is Way Too Verbose") - Fixed by shared language (CONTEXT.md)
3. **Broken Code** ("The Code Doesn't Work") - Fixed by `/tdd` and `/diagnose`
4. **Architectural Decay** ("We Built A Ball Of Mud") - Fixed by `/improve-codebase-architecture`

**Key insight on shared language** (from README):
> "Agents are usually dropped into a project and asked to figure out the jargon as they go. So they use 20 words where 1 will do."

Benefits of shared language beyond reducing verbosity:
- Variables, functions, and files named consistently
- Codebase easier to navigate for the agent
- Agent spends fewer tokens on thinking

---

## 2. Notable Forks and Adaptations

### 2.1 RobMitt/grill-me-skill

**URL**: https://github.com/RobMitt/grill-me-skill
**Description**: Standalone extraction of grill-me with AskUserQuestion tool integration.

**Unique addition**: Uses `AskUserQuestion` tool for every question (multiple-choice popup), providing 2-4 concrete options per question. This is a Claude Code-specific UX improvement.

### 2.2 S0l0m0n8und9/RalphDex (.claude/skills/)

**URL**: https://github.com/S0l0m0n8und9/RalphDex
**Skills**: grill-me, write-a-prd, prd-to-issues, improve-codebase-architecture, tdd, ralph-iterate, ralph-repair-ledger, ralph-status

**Grill-me variant** adds:
- Explicit instruction: "Do NOT produce a plan, document, or code until the interview is complete"
- Session guidance: "10 questions is short. 40-50 is normal for complex features"
- Clear handoff: "Only when both parties have reached a shared understanding should you offer to proceed to `/write-a-prd`"

### 2.3 viknesh20-20/claude-code-tool-kit

**URL**: https://github.com/viknesh20-20/claude-code-tool-kit
**Description**: 30+ skills including grill-me. Installer script bundles all skills.

**Grill-me variant** adds structured question categories:
- Edge cases, Failure modes, Concurrency, Security, Scale
- Backwards compatibility, Testing, UX, Dependencies
- Rollback, Observability, Data migration
- Rule: "Don't give answers or suggestions - only ask questions" (interrogator mode)
- Concludes with verdict: "Your plan is bulletproof" or "These areas still need work: ..."

### 2.4 russell-davis/rld-skills

**URL**: https://github.com/russell-davis/rld-skills
**Description**: "Agent skills for Claude Code -- design interviews, PRDs, and issue breakdowns. Adapted from mattpocock/skills."

Implements the three-skill pipeline: grill-me -> write-a-prd -> prd-to-issues.

---

## 3. Large Skill Collections with Requirements-Related Skills

### 3.1 alirezarezvani/claude-skills (232+ skills)

**URL**: https://github.com/alirezarezvani/claude-skills

**Relevant skills**:
- `product-team/product-discovery` - Structured discovery with Opportunity Solution Trees (Teresa Torres method), assumption mapping (desirability/viability/feasibility/usability), problem/solution validation, 10-day discovery sprints
- `product-team/agile-product-owner` - INVEST-compliant user stories, Given-When-Then acceptance criteria, epic breakdown with 5 splitting techniques, sprint planning with capacity math, WSJF prioritization
- `product-team/spec-to-repo` - Parses natural-language specs into complete repos; 4-phase process (Parse & Interpret -> Architecture -> Generate -> Validate)
- `product-team/code-to-prd` - Reverse-engineers codebase into PRD; 3-phase (global scan -> page-by-page analysis -> structured doc)
- `product-team/ux-researcher-designer` - UX research and design patterns
- `project-management/scrum-master` - Sprint ceremonies and velocity tracking

### 3.2 daymade/claude-code-skills

**URL**: https://github.com/daymade/claude-code-skills

**Relevant skills**:
- `qa-expert` - Comprehensive QA with Google Testing Standards, OWASP security testing, P0-P4 bug classification, quality gates, autonomous LLM-driven test execution
- `product-analysis` - Product analysis patterns
- `prompt-optimizer` - Prompt optimization techniques

### 3.3 levnikolaevich/claude-code-skills

**URL**: https://github.com/levnikolaevich/claude-code-skills

**Relevant skills** (Agile pipeline with 100+ skills):
- `ln-200-scope-decomposer` - Top orchestrator: scope -> Epics -> Stories via coordinator pipeline
- `ln-201-opportunity-discoverer` - Traffic-First KILL funnel for product direction validation
- `ln-210-epic-coordinator` - Epic decomposition
- `ln-220-story-coordinator` - Story decomposition per Epic
- `ln-230-story-prioritizer` - RICE prioritization
- `ln-310-multi-agent-validator` - Multi-agent validation pipeline
- `ln-500-story-quality-gate` - Story quality gates

---

## 4. Patterns for Requirement Quality

### Pattern 1: Decision Tree Traversal (grill-me)
Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. Don't move to the next branch until the current one is fully resolved.

### Pattern 2: Domain Model Challenge (grill-with-docs)
Maintain a living glossary (CONTEXT.md). Challenge every term against the glossary. Surface conflicts between stated design and existing code. Update documentation inline as decisions crystallize.

### Pattern 3: Structured Question Categories (viknesh20-20 variant)
Systematically cover: edge cases, failure modes, concurrency, security, scale, backwards compatibility, testing, UX, dependencies, rollback, observability, data migration.

### Pattern 4: INVEST Validation (agile-product-owner)
Validate each story against Independent, Negotiable, Valuable, Estimable, Small, Testable criteria before acceptance.

### Pattern 5: Assumption Risk Mapping (product-discovery)
Categorize assumptions as desirability/viability/feasibility/usability. Prioritize high-risk + low-certainty assumptions for testing first.

### Pattern 6: Vertical Slice Decomposition (to-issues)
Break work into thin vertical slices (tracer bullets) that cut through ALL integration layers end-to-end. Each slice is independently demoable.

### Pattern 7: Three-Phase Pipeline
Phase 1: Grill/interview (shared understanding) -> Phase 2: PRD synthesis (documentation) -> Phase 3: Issue breakdown (executable work).

---

## 5. Integration Opportunities for Atos Forge V2

### 5.1 Pre-Planning Grilling Phase

Forge's `/forge-discuss-phase` skill gathers phase context through adaptive questioning. The grill-me pattern could enhance this by:
- Adding decision tree traversal (resolve each branch before moving to next)
- Providing recommended answers for each question (not just asking)
- Setting explicit shared-understanding checkpoint before proceeding to planning
- Supporting 40-50 question sessions for complex phases

### 5.2 Shared Language / CONTEXT.md Integration

Forge could adopt the CONTEXT.md pattern alongside its existing codebase analysis:
- Maintain per-project `CONTEXT.md` with domain glossary
- Auto-update during discuss-phase and plan-phase sessions
- Feed glossary terms into agent prompts (reducing token waste)
- Cross-reference terms against code graph capabilities

This maps well to Forge's existing `forge-graph/` module, which already tracks module capabilities and relationships.

### 5.3 Enhanced Requirements in forge-enhance-requirements

The `/forge-enhance-requirements` skill could incorporate:
- INVEST validation for each requirement/story
- Assumption risk mapping (desirability/viability/feasibility/usability)
- Structured question categories for gap detection
- Vertical slice decomposition guidance

### 5.4 ADR Integration

Forge's `.planning/` structure could include ADRs:
- Record architectural decisions during discuss-phase
- Three-gate test: hard-to-reverse AND surprising-without-context AND result-of-real-trade-off
- Lightweight format (title + 1-3 sentence paragraph)
- ADRs survive milestone boundaries (like learnings.json)

### 5.5 Agent Prompt Enhancement

From the grill-with-docs pattern, Forge agents could:
- Load CONTEXT.md vocabulary into session_context (like existing knowledge_base injection)
- Challenge user terms against established glossary during discussions
- Cross-reference stated plans against codebase reality (already partially done via graph)

### 5.6 Three-Phase Pipeline Mapping

Matt Pocock's pipeline maps directly to Forge's existing workflow:
- `/grill-me` -> `/forge-discuss-phase` (gather context through questioning)
- `/to-prd` -> `/forge-plan-phase` (synthesize into structured plans)
- `/to-issues` -> Forge's sub-plan splitting (assessor + splitter pipeline)

The main gap is the explicit "shared understanding checkpoint" between discussion and planning.

---

## 6. Key Takeaways

1. **The grill-me skill is intentionally minimal** -- its power comes from the "one question at a time, resolve each branch" discipline, not from complex prompting.

2. **Shared language is the highest-leverage technique** -- Matt Pocock calls it "the single coolest technique in this repo." It reduces tokens, improves naming consistency, and makes codebases more AI-navigable.

3. **The deprecated ubiquitous-language skill was merged into grill-with-docs** -- showing that domain language extraction works best when integrated into the grilling/questioning flow, not as a separate post-processing step.

4. **Documentation updates should happen inline during discussion** -- not batched. This prevents drift between what was discussed and what was captured.

5. **ADRs should be rare and lightweight** -- only for decisions that are hard to reverse, surprising without context, and the result of real trade-offs. A single paragraph is sufficient.

6. **The ecosystem is composable** -- small, focused skills that chain together (grill -> prd -> issues -> tdd) rather than monolithic workflows. This is philosophically aligned with Forge's modular architecture but contrasts with Forge's more automated/orchestrated approach.
