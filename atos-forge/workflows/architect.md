<purpose>
Design per-service architecture through relentless grilling.
Reads: REQUIREMENTS.md, PROJECT.md, SYSTEM-ARCHITECTURE.md (if exists), codebase map (if brownfield).
Produces: .planning/ARCHITECTURE.md + .forge/glossary.md updates.
Gates: ARCHITECTURE.md must be approved (status: approved) before /forge-plan-phase can proceed.
</purpose>

<context>
This workflow produces the prescriptive architecture for a single service or application.
It is distinct from /forge-map-codebase which produces a descriptive analysis of existing code.

The output ARCHITECTURE.md becomes the single source of architectural truth for:
- forge-planner: module boundaries constrain file placement and dependency rules
- forge-plan-checker: Dimension 9 evaluates architectural compliance (BLOCKER severity)
- forge-verify Layer 9: post-execution architectural fitness check
- forge-graph: module boundaries inform architecture-aware detection
- All executor agents: ADRs become locked decisions they cannot contradict

If SYSTEM-ARCHITECTURE.md exists at .forge-system/, this service's architecture must
conform to system-level constraints (communication patterns, auth strategy, data ownership).
</context>

<process>

<step name="initialize">
## Step 1: Load Context

Read the following files if they exist:
1. `.planning/REQUIREMENTS.md` — the requirements this architecture must satisfy
2. `.planning/PROJECT.md` — project description and high-level scope
3. `.forge-system/SYSTEM-ARCHITECTURE.md` — system-level constraints (if multi-service)
4. `.planning/codebase/ARCHITECTURE.md` — existing codebase map (if brownfield)
5. `.forge/glossary.md` — existing domain glossary
6. `.forge/config.json` — architecture configuration (style preference, grilling depth)

Determine project context:
- **Greenfield** — no existing codebase map. Full architecture design from scratch.
- **Brownfield** — codebase map exists. Architecture must account for existing code.
- **System-constrained** — SYSTEM-ARCHITECTURE.md exists. Must conform to system-level decisions.

Load the architecture-design template from templates/architecture-design.md.
</step>

<step name="propose_style">
## Step 2: Propose Architecture Style

Based on requirements analysis, propose an architecture style with rationale:

Consider:
- Number and nature of feature domains (from requirements)
- Team size and structure (from PROJECT.md)
- Deployment constraints (from requirements NFRs)
- Scaling requirements (from requirements NFRs)
- System-level constraints (from SYSTEM-ARCHITECTURE.md if exists)

Styles: monolith | modular-monolith | microservices | serverless | event-driven

Present recommendation to user:

> **Recommended architecture style: [style]**
>
> Rationale: [why this style fits these requirements]
>
> Alternatives considered:
> - [alt 1]: [why not chosen]
> - [alt 2]: [why not chosen]
>
> Do you agree with this style, or would you prefer a different approach?

Wait for user confirmation before proceeding. If user redirects, adopt their choice and
document the override as ADR-001.
</step>

<step name="grill_decisions">
## Step 3: Grill Architecture Decisions

Walk the decision tree one question at a time. For EACH question:
1. State the decision to be made
2. Provide your recommended answer based on requirements + tech stack
3. Explain your reasoning
4. Wait for user confirmation or override

### Branch 1: Module Boundaries
For each candidate module:
- What domain concept does it own?
- What is its public API (exported functions/interfaces)?
- What data entities does it own exclusively?
- What does it depend on from other modules?
- What can other modules NOT import from it?

Validate: Every requirement must map to at least one module. No orphan requirements.
Validate: No circular dependencies between proposed modules.

### Branch 2: Data Model
For each module's entities:
- What are the core entities and their relationships (1:1, 1:N, M:N)?
- What are the primary access patterns (read-heavy, write-heavy, mixed)?
- Normalize or denormalize? (default: normalize, justify denormalization)
- Soft-delete or hard-delete per entity?
- What indexes are needed based on query patterns?
- What constraints (unique, check, not-null) apply?

Produce a Mermaid ER diagram as you go.

### Branch 3: Interface Contracts
For each external-facing and inter-module interface:
- REST/Event/gRPC/WebSocket?
- Endpoint path or event name?
- Request and response schemas (with required vs optional)?
- Error format (standardized across all endpoints)?
- Authentication requirement?
- Rate limiting or idempotency needs?

### Branch 4: Dependency Rules
- What layer structure applies (presentation, service, domain, infrastructure)?
- What are the import rules between layers?
- What is the shared utilities strategy?
- Any specific forbidden dependencies?

### Branch 5: Technology Decisions
For each technology choice that is hard-to-reverse:
- What is the decision? (e.g., ORM, database, auth library, state management)
- Why this over alternatives?
- Document as ADR if surprising or involves significant trade-offs.

### Branch 6: Security Model
- Authentication strategy (JWT, session, OAuth2, API keys)?
- Authorization model (RBAC, ABAC, policy engine)?
- Multi-tenancy approach (if applicable)?
- Sensitive data handling?

### Branch 7: Non-Functional Requirements
For each NFR from REQUIREMENTS.md:
- What is the measurable target? (reject vague targets)
- How will it be verified?
- What architectural decisions support this target?

### Branch 8: File/Folder Structure
- Propose directory layout based on module boundaries
- Map each directory to its owning module
- Identify shared directories
- Convention for file naming

### Glossary Capture
Throughout all branches, when the user uses domain-specific terms:
- Capture the term and its definition immediately
- Confirm the definition with the user
- Add to the running glossary

Continue grilling until ALL branches are fully resolved. There is no fixed question count —
the depth depends on project complexity. Simple projects may resolve in 15 questions,
complex ones in 50+.
</step>

<step name="generate_architecture">
## Step 4: Generate Architecture Document

Using the architecture-design template, produce `.planning/ARCHITECTURE.md` with:

1. **Frontmatter** — status: pending_approval, style, modules list
2. **System Overview** — style chosen and why
3. **Module Boundaries** — one subsection per module with all fields
4. **Data Model** — Mermaid ER diagram + descriptions
5. **Interface Contracts** — all APIs and events with full schemas
6. **Dependency Rules** — explicit allow/deny rules
7. **Technology Decisions** — table with concern, decision, rationale
8. **Non-Functional Requirements** — table with metric, target, measurement
9. **File/Folder Structure** — proposed directory layout
10. **Architecture Decision Records** — all ADRs captured during grilling

Write `.planning/ARCHITECTURE.md`.

Update `.forge/glossary.md` with all captured domain terms:
```markdown
# Domain Glossary

| Term | Definition | Module |
|------|-----------|--------|
| [term] | [definition] | [owning module] |
```
</step>

<step name="approval_gate">
## Step 5: Approval Gate

Present the complete ARCHITECTURE.md to the user for review.

> **Architecture document generated: `.planning/ARCHITECTURE.md`**
>
> Please review the document. Options:
> 1. **Approve** — set status to `approved`, proceed to planning phase
> 2. **Revise [section]** — return to specific grilling branch for that section
> 3. **Restart [section]** — discard decisions for a section and re-grill from scratch
>
> Which sections, if any, need revision?

On **Approve**:
- Update frontmatter: `status: approved`, `approved_by: user`, `approved_date: [today]`
- Log approval to session ledger

On **Revise**:
- Return to the specific grilling branch
- Re-grill only the affected section
- Regenerate the document with updated decisions

On **Restart section**:
- Discard all decisions for that section
- Re-grill from scratch
- Regenerate the document

ARCHITECTURE.md MUST be approved before /forge-plan-phase can proceed.
The plan-phase workflow checks `status: approved` in frontmatter.
</step>

<step name="register_in_graph">
## Step 6: Register in Code Graph

If a code graph exists (.forge/graph.db):
1. Register module boundaries as architecture-informed overrides
2. The graph's module detector will prefer these boundaries over auto-detection
3. This ensures planner file placement respects architectural decisions

If no code graph exists (greenfield), skip this step — the graph will be built
after initial code is generated and will inherit these boundaries.
</step>

<step name="commit">
## Step 7: Commit

Commit the generated files:
- `.planning/ARCHITECTURE.md`
- `.forge/glossary.md` (if updated)

Commit message: `docs(architecture): add prescriptive architecture design`

If architecture was revised after initial generation:
`docs(architecture): revise [section] per user feedback`
</step>

</process>

<error_handling>

**Requirements not found:**
If `.planning/REQUIREMENTS.md` does not exist, warn the user:
> Requirements file not found. Architecture design without requirements risks misalignment.
> Run `/forge-new-project` or `/forge-enhance-requirements` first, or proceed with manual context.

**System architecture conflict:**
If a decision contradicts SYSTEM-ARCHITECTURE.md, flag immediately:
> This decision conflicts with the system-level architecture:
> - System says: [constraint]
> - You want: [conflicting decision]
> Either align with the system architecture or escalate to revise SYSTEM-ARCHITECTURE.md.

**Brownfield constraints:**
If existing codebase conflicts with proposed architecture:
> The existing code has [pattern]. The proposed architecture would require:
> - [migration step 1]
> - [migration step 2]
> Should we design for the ideal state (with migration plan) or constrain to current state?

</error_handling>

<quality_criteria>
- Every requirement traces to at least one module
- Every module has a clear single responsibility
- No circular dependencies between modules
- Every entity has exactly one owning module
- Every external API has a complete contract (path, methods, schemas, errors, auth)
- Every technology decision that is hard-to-reverse has an ADR
- Every NFR has a measurable target and verification method
- Dependency rules are explicit and enforceable
- File structure maps cleanly to module boundaries
- Glossary captures all domain-specific terms used in the document
</quality_criteria>
