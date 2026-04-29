---
template: system-architecture
version: 1.0.0
produces: .forge-system/SYSTEM-ARCHITECTURE.md
services: [list, of, service, names]
communication_patterns: [rest, events, grpc]
data_strategy: service-owned
deployment: [docker-compose|kubernetes|serverless|hybrid]
---

# System Architecture Template

Template for `.forge-system/SYSTEM-ARCHITECTURE.md` — multi-service system architecture produced by `/forge-system-architect`.

Describes how multiple services interact, who owns what data, and how contracts are enforced across service boundaries.

---

## File Template

```markdown
---
status: pending_approval
services: [list, of, service, names]
communication_patterns: [rest, events, grpc, message-queue]
data_strategy: service-owned
deployment: [docker-compose|kubernetes|serverless|hybrid]
approved_by: null
approved_date: null
---

# System Architecture

## System Overview
[High-level description of the system: what it does, how many services, why this decomposition.
Reference the business domains that drove service boundaries.
State the primary communication paradigm and deployment target.]

## Service Map
### [Service Name]
- **Domain:** [bounded context this service owns]
- **Responsibilities:** [what this service does — 3-5 bullet points]
- **Tech stack:** [language, framework, database, runtime]
- **Exposes:** [APIs, events, packages — what other services can consume]
- **Consumes:** [APIs, events from other services this one depends on]
- **Data store:** [database type and name — each service owns its own]
- **Team:** [owning team, if applicable]
- **SLA:** [availability target, latency budget]

[Repeat for each service. Every service must appear in frontmatter `services` list.]

## Communication Topology
### Synchronous Communication
[REST, gRPC, GraphQL — which services talk synchronously and why.]

| From | To | Protocol | Path/Method | Purpose |
|------|----|----------|-------------|---------|
| [caller] | [callee] | REST/gRPC | [endpoint] | [why] |

### Asynchronous Communication
[Events, message queues, pub/sub — which services communicate asynchronously and why.]

| Publisher | Event/Topic | Subscribers | Payload Schema | Delivery Guarantee |
|-----------|-------------|-------------|----------------|--------------------|
| [service] | [event name] | [services] | [schema ref] | [at-least-once/exactly-once] |

### Communication Patterns
- **Request-Reply:** [which interactions use sync request-reply]
- **Event-Driven:** [which interactions use fire-and-forget events]
- **Saga/Choreography:** [multi-step workflows that span services]
- **CQRS:** [if command/query separation is used, where and why]

## Data Ownership
### Principles
- Each service owns its data store exclusively
- No shared databases between services
- Cross-service data access only through published APIs or events
- Event sourcing for audit trails where required

### Data Boundaries
| Entity/Aggregate | Owner Service | Storage | Replication Strategy |
|-----------------|---------------|---------|---------------------|
| [entity] | [service] | [PostgreSQL/MongoDB/Redis] | [event-driven sync/API lookup/cache] |

### Data Consistency
- **Strong consistency:** [which operations require it and how achieved]
- **Eventual consistency:** [which operations tolerate it and reconciliation strategy]
- **Saga pattern:** [multi-service transactions and compensation logic]

## Contract Specifications
### REST Contracts
For each inter-service REST call:
- **Provider:** [service name]
- **Consumer(s):** [service names]
- **OpenAPI spec:** [path to spec file]
- **Versioning:** [URL path /v1/ | header | query param]
- **Breaking change policy:** [how breaking changes are communicated and migrated]

### Event Contracts
For each event:
- **Publisher:** [service name]
- **Schema:** [AsyncAPI spec path or inline schema]
- **Versioning:** [schema evolution strategy — additive only / envelope version field]
- **Dead letter policy:** [what happens to unprocessable events]

### gRPC Contracts
For each gRPC service:
- **Provider:** [service name]
- **Proto file:** [path to .proto]
- **Backward compatibility:** [field numbering rules, deprecation policy]

## Cross-Cutting Concerns
### Authentication & Authorization
- **Strategy:** [JWT propagation / OAuth2 / API keys / mTLS]
- **Token flow:** [how auth tokens propagate across service calls]
- **Service-to-service auth:** [mTLS / shared secrets / token exchange]
- **Authorization model:** [RBAC / ABAC / policy engine]

### Observability
- **Distributed tracing:** [OpenTelemetry / Jaeger / Zipkin — trace ID propagation]
- **Centralized logging:** [ELK / Loki / CloudWatch — structured log format]
- **Metrics:** [Prometheus / CloudWatch — key business and infra metrics]
- **Health checks:** [standardized /health endpoint per service]
- **Alerting:** [thresholds and escalation paths]

### Resilience
- **Circuit breakers:** [which inter-service calls use them, thresholds]
- **Retries:** [retry policy per call type — exponential backoff, max attempts]
- **Bulkheads:** [thread/connection pool isolation between services]
- **Timeouts:** [per-call timeout budgets]
- **Graceful degradation:** [fallback behavior when a dependency is down]

### Deployment & Infrastructure
- **Orchestration:** [Docker Compose / Kubernetes / ECS / serverless]
- **Service discovery:** [DNS / Consul / k8s services]
- **Configuration management:** [env vars / config server / secrets manager]
- **CI/CD:** [pipeline per service or monorepo pipeline]
- **Scaling strategy:** [horizontal / vertical / auto-scaling triggers per service]

### Security
- **Network segmentation:** [VPC / namespace isolation between services]
- **Secret management:** [Vault / AWS Secrets Manager / env injection]
- **API gateway:** [if used — rate limiting, WAF, throttling]
- **Data encryption:** [at rest and in transit policies]

## Architecture Decision Records

### ADR-001: [Title]
- **Context:** [why this decision was needed]
- **Decision:** [what was decided]
- **Rationale:** [why this option over alternatives]
- **Status:** Accepted

### ADR-002: [Title]
- **Context:** [why this decision was needed]
- **Decision:** [what was decided]
- **Rationale:** [why this option over alternatives]
- **Status:** Accepted
```

---

## Downstream Consumers

| Consumer | What It Uses | How |
|----------|-------------|-----|
| `forge-system/builder.js` | Service Map + contracts | Populates system-graph.db |
| `forge-planner` (multi-repo) | Service boundaries | Per-service plan generation |
| `forge-verify` Layer 7 | Contract Specifications | Cross-repo contract validation |
| `forge-analyze/analyzer.js` | Communication Topology | Impact analysis across services |
| Per-service `/forge-architect` | Service Map entry | Constrains single-service architecture |

## Usage Notes

- The `status` field gates downstream workflows: `pending_approval` blocks system-level planning.
- The `services` list in frontmatter must exactly match the `### [Service Name]` headings in Service Map.
- Communication Topology diagrams feed into `forge-system/dashboard.js` visualization.
- Contract Specifications here become the source of truth for `forge-verify` Layer 7 cross-repo checks.
- Cross-Cutting Concerns decisions propagate to all per-service ARCHITECTURE.md files as constraints.
- ADRs at system level override per-service ADRs when they conflict.
