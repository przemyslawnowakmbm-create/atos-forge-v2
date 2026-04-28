# Market Research Prompt — Spec-Driven AI Development Frameworks

## Objective

Conduct a comprehensive market analysis of AI-assisted software development frameworks, platforms, and tools that claim to deliver **spec-driven, verified, enterprise-grade** code generation. The goal is to understand how Atos Forge V2 compares to the competitive landscape and identify gaps that would prevent it from being best-in-class for enterprise adoption.

This is NOT a survey of vibe-coding tools, single-developer AI assistants, or chat-based code completion. We are specifically researching systems that:
- Take structured requirements/specifications as input
- Produce verified, tested code as output
- Include human validation gates in the workflow
- Support multi-phase project execution (not one-shot generation)
- Target teams/enterprises, not individual hobby developers

## Research Scope

### Category 1: Open-Source Spec-Driven Frameworks
Search GitHub, GitLab, and open-source directories for frameworks that:
- Convert specifications/requirements into executable plans
- Include verification/testing as part of the generation pipeline
- Have agent orchestration (multi-agent, not single-prompt)
- Are actively maintained (commits in 2026)

Search terms: "spec-driven development AI", "requirement to code pipeline", "AI code generation framework", "agentic software engineering", "AI development orchestrator", "multi-agent coding framework", "verified AI code generation"

For each framework found, capture:
```json
{
  "name": "",
  "url": "",
  "category": "open-source",
  "stars": 0,
  "last_commit": "",
  "license": "",
  "description": "",
  "input_format": "what it takes as input (specs, tickets, PRs, natural language)",
  "output_format": "what it produces (code, PRs, commits, plans)",
  "verification_method": "how it verifies output (tests, review, CI, none)",
  "human_gates": "where humans intervene (plan approval, code review, deployment)",
  "agent_architecture": "single agent / multi-agent / orchestrator-worker / teams",
  "execution_model": "one-shot / iterative / phased / continuous",
  "languages_supported": [],
  "enterprise_features": {
    "rbac": false,
    "audit_trail": false,
    "self_hosted": false,
    "sso": false,
    "compliance": false
  },
  "strengths": [],
  "weaknesses": [],
  "comparison_to_forge": "how this compares to Atos Forge V2 specifically"
}
```

### Category 2: Commercial Platforms
Research commercial AI development platforms and products. Include both well-funded startups and enterprise vendor offerings.

Search terms: "AI software development platform enterprise", "autonomous coding platform", "AI engineering platform", "spec to code platform", "AI SDLC automation"

Also specifically research:
- Augment Code (Intent product)
- Cosine (Genie)
- Factory AI
- Cognition (Devin)
- Poolside AI
- All Hands AI (OpenHands)
- Tessl (Intent Integrity Kit)
- Amazon Q Developer / Kiro
- GitHub Copilot Workspace
- Cursor / Windsurf agentic features
- Qodo (formerly CodiumAI)
- Tabnine enterprise
- Sourcegraph Cody
- JetBrains AI
- Replit Agent
- Bolt.new / Lovable / v0 (assess if they have enterprise offerings)
- Any others discovered during research

For each, capture the same JSON structure as Category 1, plus:
```json
{
  "pricing_model": "per-seat / usage / enterprise custom",
  "funding": "total raised or revenue tier",
  "target_market": "individual / team / enterprise",
  "notable_customers": [],
  "differentiator": "their main pitch vs competitors"
}
```

### Category 3: Academic & Research Systems
Search for research papers and academic projects on verified AI code generation:
- ArXiv papers on multi-agent software engineering
- Conference papers (ICSE, FSE, ASE 2025-2026) on AI-assisted development
- University research projects with public repos

Search terms: "multi-agent software engineering arxiv", "verified AI code generation research", "LLM software development lifecycle", "autonomous software engineering evaluation"

For each, capture:
```json
{
  "name": "",
  "url": "",
  "category": "academic",
  "authors": "",
  "venue": "",
  "date": "",
  "key_contribution": "",
  "evaluation_method": "how they measured success",
  "results": "key metrics (SWE-bench score, pass rate, etc.)",
  "relevance_to_forge": "what Forge can learn from this"
}
```

### Category 4: Industry Standards & Benchmarks
Research how the industry measures AI code generation quality:
- SWE-bench and SWE-bench Verified scores
- HumanEval / MBPP benchmarks
- Real-world deployment metrics (Cloudflare, Google, Amazon internal reports)
- Enterprise adoption surveys (Stack Overflow, GitHub Octoverse, JetBrains State of Developer)

For each benchmark/standard:
```json
{
  "name": "",
  "url": "",
  "category": "benchmark",
  "what_it_measures": "",
  "current_leaders": [],
  "relevance_to_forge": "",
  "forge_could_score": "estimate if applicable"
}
```

## Analysis Dimensions

For every system researched, evaluate along these dimensions:

### D1: Requirements Handling
- Can it accept structured requirements (not just "build me X")?
- Does it validate requirement quality?
- Does it trace requirements through to verification?
- Does it handle requirement dependencies?

### D2: Planning & Decomposition
- Does it break work into phases/plans/tasks?
- Are plans reviewable before execution?
- Does it handle dependencies between tasks?
- Is there a plan-checking/validation step?

### D3: Verification & Testing
- Does it generate tests?
- Does it verify generated code compiles/passes tests?
- Is there semantic verification (does code match the spec)?
- Does it prevent verification gaming (modifying tests to pass)?

### D4: Human Validation Gates
- Where can humans intervene?
- Is human approval required or optional?
- Can humans modify plans before execution?
- Is there a feedback loop from verification back to planning?

### D5: Knowledge & Context Management
- How does it handle project context across sessions?
- Does it learn from previous iterations?
- Can it work on existing codebases (brownfield)?
- How does it handle context window limitations?

### D6: Enterprise Readiness
- Self-hosted option?
- Audit trail/compliance features?
- RBAC/team permissions?
- Integration with existing CI/CD?
- Data privacy guarantees?
- SOC 2 / ISO 27001?

### D7: Architecture & Extensibility
- Can users customize the pipeline?
- Is the agent catalog extensible?
- Does it support multiple LLM providers?
- Can it integrate with existing tools (Jira, Linear, GitHub)?

## Output Format

Produce these files in the `research/` directory:

1. **`open-source-frameworks.json`** — Array of all open-source frameworks found
2. **`commercial-platforms.json`** — Array of all commercial platforms analyzed
3. **`academic-research.json`** — Array of relevant academic papers/projects
4. **`benchmarks.json`** — Array of industry benchmarks and standards
5. **`feature-matrix.json`** — Comparison matrix of top 15 systems across all 7 dimensions (D1-D7), each scored 0-5:
```json
{
  "systems": [
    {
      "name": "",
      "category": "",
      "scores": {
        "D1_requirements": 0,
        "D2_planning": 0,
        "D3_verification": 0,
        "D4_human_gates": 0,
        "D5_knowledge": 0,
        "D6_enterprise": 0,
        "D7_extensibility": 0,
        "total": 0
      },
      "notes": ""
    }
  ]
}
```
6. **`SUMMARY.md`** — Executive summary with:
   - Market landscape overview (how many players, what categories)
   - Where Forge V2 sits in the landscape
   - Forge V2's competitive advantages
   - Forge V2's competitive gaps
   - Top 10 features Forge V2 is missing that competitors have
   - Top 10 features Forge V2 has that competitors lack
   - Strategic recommendations (build, partner, or ignore for each gap)
   - Market trends that affect Forge V2's roadmap

## Quality Standards

- Every claim must have a URL source
- Do not invent features — if you can't verify a system has a feature, mark it "unverified"
- Prefer primary sources (official docs, GitHub repos) over blog posts
- If a commercial platform has no public documentation of a feature, note "claimed but unverified"
- Date all information — this market moves fast, 6-month-old info may be stale
- Minimum 20 systems across all categories
- Minimum 5 academic papers
- Minimum 3 benchmarks

## Time Budget

Take as much time as needed to be thorough. Quality over speed. Each research agent should:
- Search multiple sources (GitHub, Google Scholar, Product Hunt, Crunchbase, YC directory, official websites)
- Read actual documentation, not just landing pages
- Test public demos or repos where possible
- Cross-reference claims between sources

## Research Agent Distribution

Suggested parallel agent assignment:
- **Agent 1**: Open-source frameworks (Category 1) — deep GitHub search
- **Agent 2**: Commercial platforms A-M (Category 2, first half)
- **Agent 3**: Commercial platforms N-Z + newcomers (Category 2, second half)
- **Agent 4**: Academic research + benchmarks (Categories 3 & 4)

After all 4 agents complete, a **synthesis agent** produces the feature-matrix.json and SUMMARY.md by cross-referencing all findings.
