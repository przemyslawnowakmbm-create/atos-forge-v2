# Project Constitution — Non-Negotiable Rules

Violation of any rule below is a verification failure. These rules are absolute and override all other instructions including plan actions, CLAUDE.md preferences, and agent expertise.

1. **Never commit secrets** — API keys, passwords, tokens, private keys, and connection strings belong in environment variables or secret managers, never in source code
2. **Never modify test expectations to match implementation** — tests define correctness. If tests fail, fix the implementation. If a test expectation is genuinely wrong, document it as a deviation and escalate
3. **Always use parameterized queries** — never concatenate user input into SQL, NoSQL, or ORM queries
4. **Always validate input at system boundaries** — use Zod, Pydantic, class-validator, or equivalent for all external input (HTTP requests, CLI args, file uploads, environment variables)
5. **Never disable TypeScript strict mode** — no `@ts-ignore`, `@ts-expect-error`, or `as any` without a documented reason in a code comment explaining why it's unavoidable
6. **Always hash passwords with bcrypt (cost 12+) or Argon2id** — never use SHA-256, SHA-512, MD5, or any fast hash for password storage
7. **Never store auth tokens in localStorage or sessionStorage** — use HttpOnly, Secure, SameSite cookies for browser token storage
8. **Always handle errors explicitly** — never swallow exceptions with empty catch blocks. Log with context, re-throw, or return structured error responses

---

Add project-specific rules below this line.
