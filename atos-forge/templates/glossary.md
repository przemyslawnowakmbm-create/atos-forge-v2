# Domain Glossary

Template for `.forge/glossary.md` — shared vocabulary loaded into every agent's context.

**Purpose:** Ensure all agents use consistent domain terminology. Reduces token consumption (agents don't need lengthy explanations), improves naming consistency in generated code, and makes the codebase navigable for both humans and AI.

**Lifecycle:** Created during `/forge-architect` or `/forge-discuss-phase`. Persists across phases and milestones. Loaded by `forge-agents/factory.js` into every agent's system prompt.

**Two-level glossary:**
- **System glossary** (`.forge-system/glossary.md`): organization-wide terms shared across all services
- **Service glossary** (`.forge/glossary.md`): service-specific terms that may override or extend system terms

---

## File Template

```markdown
# Domain Glossary

| Term | Definition | Aliases | Used in |
|------|-----------|---------|---------|
| [Term] | [Precise definition of domain concept] | [Comma-separated aliases] | [Module/service names or REQ-IDs] |
```

---

## Guidelines

- **Be precise**: "Order" means "a confirmed purchase with payment completed and order number assigned", not "something the user bought"
- **Include aliases**: if stakeholders use different words for the same concept, capture all of them (e.g., "Cart" has aliases "Shopping bag, Basket")
- **Scope to domain**: technical terms (JWT, REST, PostgreSQL) don't belong here unless they have domain-specific meaning in this project
- **Reference modules**: helps agents map terms to code locations and service boundaries
- **Resolve conflicts**: if two services use the same word differently, the glossary MUST define the canonical meaning and note the difference
- **Update continuously**: when new domain concepts emerge during execution, executor agents log suggested additions in SUMMARY.md

---

## Downstream Consumers

| Consumer | What It Uses | How |
|----------|-------------|-----|
| `forge-agents/factory.js` | All terms | Injected into every agent's system prompt as "## Domain Glossary" |
| `forge-planner` | Terms + Used in | Maps domain terms to file/module naming |
| `forge-executor` | Terms + Aliases | Uses canonical terms in generated code |
| `forge-plan-checker` | Terms | Validates plan task actions use consistent terminology |
| `/forge-architect` | Creates glossary | Captures terms during architecture grilling |
