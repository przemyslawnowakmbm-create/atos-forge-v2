<purpose>
Design multi-service system architecture through relentless grilling.
Reads: ALL service requirements + system requirements, existing per-service architectures.
Produces: .forge-system/SYSTEM-ARCHITECTURE.md + .forge-system/glossary.md.
Gates: SYSTEM-ARCHITECTURE.md must be approved before per-service /forge-architect can proceed.
</purpose>

<context>
This workflow produces the system-level architecture for a multi-service system.
It defines service boundaries, communication topology, data ownership, contracts,
and cross-cutting concerns that constrain all per-service architecture decisions.

The output SYSTEM-ARCHITECTURE.md becomes the single source of truth for:
- Per-service /forge-architect: must conform to system-level constraints
- forge-system/builder.js: populates system-graph.db from service map + contracts
- forge-planner (multi-repo): per-service plan generation respects service boundaries
- forge-verify Layer 7: cross-repo contract validation against declared contracts
- forge-analyze/analyzer.js: impact analysis traces communication topology

This workflow should run BEFORE per-service /forge-architect when the system
involves multiple services.
</context>

<process>

<step name="initialize">
## Step 1: Load Context

Read the following files if they exist:
1. All `.planning/REQUIREMENTS.md` files across services
2. `.planning/PROJECT.md` — system-level project description
3. Existing per-service `.planning/ARCHITECTURE.md` files (if any)
4. `.forge-system/glossary.md` — existing system glossary
5. `.forge/config.json` — architecture configuration

Discover all services:
- Scan for service directories (each with their own requirements/project files)
- Or read from PROJECT.md which lists system components
- Or ask user to enumerate services

Determine context:
- **New system** — no existing services. Full system design from scratch.
- **Expanding system** — some services exist with architectures. Adding new services.
- **Redesigning** — existing system being restructured.

Load the system-architecture template from templates/system-architecture.md.
</step>

<step name="identify_services">
## Step 2: Identify Service Boundaries

Using bounded context analysis from requirements:

1. **Map business domains** — identify distinct business capabilities
2. **Find language boundaries** — where the same term means different things
3. **Assess change cadence** — which domains change independently
4. **Check data ownership** — which data belongs to which domain exclusively
5. **Evaluate team alignment** — map services to team ownership

For each candidate service, confirm with user:

> **Proposed service: [name]**
> - Domain: [bounded context]
> - Responsibilities: [3-5 bullet points]
> - Data owned: [entities]
> - Rationale: [why this is a separate service]
>
> Does this service boundary make sense?

Validate:
- No two services own the same data entity
- No service has > 7 responsibilities (too broad)
- No service has < 2 responsibilities (too narrow, unless genuinely focused)
- Service count is appropriate for team size and operational capacity
</step>

<step name="grill_communication">
## Step 3: Grill Communication Topology

For each pair of services that need to communicate:

### Synchronous vs Asynchronous
- Does the caller need an immediate response? → synchronous
- Is the interaction a notification or state change propagation? → asynchronous
- Is there a multi-step workflow spanning services? → saga pattern

### Protocol Selection
- REST: broad tooling, CRUD-style interactions
- gRPC: high throughput, internal service-to-service, streaming needed
- Events (Kafka/RabbitMQ): one-to-many, temporal decoupling
- Message queue (SQS/RabbitMQ): one-to-one command processing

For each communication path, capture:
- From service → To service
- Protocol (REST/gRPC/event/message)
- Direction (request-reply/fire-and-forget/bidirectional)
- Purpose (what data flows and why)
- Criticality (is this on the critical path?)

### Communication Patterns
Determine if the system needs:
- Saga choreography or orchestration for multi-service workflows
- CQRS for read/write separation
- Event sourcing for audit trails
- API gateway for external-facing APIs
</step>

<step name="grill_data_ownership">
## Step 4: Grill Data Ownership

For each service's data:

1. **What entities does this service own?** — exclusive ownership, single source of truth
2. **What data does it need from other services?** — consumed via API or events
3. **What is the replication strategy?** — event-driven sync, API lookup, cache
4. **What consistency model?** — strong (financial), eventual (read models), mixed

For cross-service data needs:
- **Who is authoritative?** — exactly one service per entity
- **How do consumers get data?** — API composition vs event-driven replication
- **What happens during partitions?** — can the consumer operate with stale data?

Validate:
- Every entity has exactly one owning service
- No shared databases between services
- Consistency requirements match the chosen communication pattern
- Replication strategies are explicitly defined
</step>

<step name="grill_contracts">
## Step 5: Grill Contract Specifications

For each inter-service communication path identified in Step 3:

### REST Contracts
- Endpoint path and HTTP method
- Request schema (required + optional fields)
- Response schema (success + error)
- Versioning strategy (URL prefix recommended)
- Breaking change policy

### Event Contracts
- Event name/topic
- Payload schema
- Schema evolution strategy (additive-only)
- Delivery guarantee (at-least-once, exactly-once)
- Dead letter policy

### gRPC Contracts
- Service and method definitions
- Proto file location
- Backward compatibility rules

For all contracts:
- Consumer list (who depends on this contract)
- SLA (latency, availability)
- Testing strategy (consumer-driven contract tests)
</step>

<step name="grill_cross_cutting">
## Step 6: Grill Cross-Cutting Concerns

### Authentication & Authorization
- How do tokens propagate across service calls?
- Service-to-service authentication method?
- Authorization model (RBAC, ABAC, policy engine)?
- Where is the auth boundary (gateway, each service, both)?

### Observability
- Distributed tracing strategy (OpenTelemetry recommended)
- Centralized logging format and destination
- Key metrics per service
- Health check standardization
- Alerting thresholds and escalation

### Resilience
- Circuit breaker configuration per service pair
- Retry policy per call type
- Timeout budget propagation
- Graceful degradation strategy per service
- Bulkhead isolation between downstream dependencies

### Deployment
- Orchestration platform (Docker Compose, Kubernetes, serverless)
- Service discovery mechanism
- Configuration management strategy
- CI/CD pipeline structure (per-service or monorepo)
- Scaling triggers per service

### Security
- Network segmentation between services
- Secret management approach
- API gateway configuration (if applicable)
- Encryption policies (at rest, in transit)
</step>

<step name="generate_system_architecture">
## Step 7: Generate System Architecture Document

Using the system-architecture template, produce `.forge-system/SYSTEM-ARCHITECTURE.md` with:

1. **Frontmatter** — status: pending_approval, services list, communication patterns, deployment
2. **System Overview** — what the system does, why this decomposition
3. **Service Map** — one subsection per service with all fields
4. **Communication Topology** — sync table, async table, patterns
5. **Data Ownership** — principles, boundaries table, consistency strategy
6. **Contract Specifications** — REST, event, gRPC contracts per service pair
7. **Cross-Cutting Concerns** — auth, observability, resilience, deployment, security
8. **Architecture Decision Records** — all system-level ADRs

Write `.forge-system/SYSTEM-ARCHITECTURE.md`.

Update `.forge-system/glossary.md` with all captured system-level domain terms:
```markdown
# System Domain Glossary

| Term | Definition | Service |
|------|-----------|---------|
| [term] | [definition] | [owning service or system-wide] |
```
</step>

<step name="approval_gate">
## Step 8: Approval Gate

Present the complete SYSTEM-ARCHITECTURE.md to the user for review.

> **System architecture document generated: `.forge-system/SYSTEM-ARCHITECTURE.md`**
>
> Please review the document. Options:
> 1. **Approve** — set status to `approved`, proceed to per-service architecture
> 2. **Revise [section]** — return to specific grilling step for that section
> 3. **Restart [section]** — discard decisions for a section and re-grill
>
> Which sections, if any, need revision?

On **Approve**:
- Update frontmatter: `status: approved`, `approved_by: user`, `approved_date: [today]`
- Log approval to session ledger
- System-level ADRs become constraints for all per-service /forge-architect runs

On **Revise**:
- Return to the specific grilling step
- Re-grill only the affected section
- Regenerate the document with updated decisions

SYSTEM-ARCHITECTURE.md MUST be approved before per-service /forge-architect can proceed.
</step>

<step name="commit">
## Step 9: Commit

Commit the generated files:
- `.forge-system/SYSTEM-ARCHITECTURE.md`
- `.forge-system/glossary.md` (if updated)

Commit message: `docs(system-architecture): add multi-service system architecture design`

If architecture was revised after initial generation:
`docs(system-architecture): revise [section] per user feedback`
</step>

</process>

<error_handling>

**Single service detected:**
If only one service is found:
> This appears to be a single-service project. System architecture is for multi-service systems.
> Use `/forge-architect` instead for per-service architecture design.

**Missing service requirements:**
If some services lack REQUIREMENTS.md:
> The following services are missing requirements: [list].
> System architecture requires understanding all services. Run `/forge-new-project` for each,
> or provide requirements context manually.

**Conflicting per-service architectures:**
If existing per-service architectures conflict with proposed system design:
> Service [name] has an existing architecture that conflicts:
> - Service says: [decision]
> - System design requires: [constraint]
> The per-service architecture will need to be revised after system architecture approval.

</error_handling>

<quality_criteria>
- Every service maps to a bounded context with clear ownership
- Every inter-service communication path has a defined protocol and contract
- Every entity has exactly one owning service (no shared databases)
- Every contract has a schema, versioning strategy, and breaking change policy
- Cross-cutting concerns (auth, tracing, logging) are standardized across all services
- Resilience patterns are defined for every synchronous inter-service call
- Deployment topology matches the operational capacity of the team
- System-level ADRs are documented for all hard-to-reverse decisions
- Glossary captures all system-level domain terms
- Service count is justified by team size, domain complexity, and operational capacity
</quality_criteria>
