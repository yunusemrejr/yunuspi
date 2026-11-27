---
name: api-security
description: "Design and review HTTP APIs and security: REST/OpenAPI contracts, errors, idempotency, webhooks, authn/authz, OWASP web vulns (XSS, CSRF, SSRF, IDOR, CSP), GitHub/Google sign-in, Turnstile, Cloudflare, retries, Linux hardening, secrets, incidents."
disable-model-invocation: true
---

# API, backend and security

A backend is correct when it holds under hostile input, concurrent callers, retries and failing dependencies, and the real request works through every layer in front of it. The project's own conventions win. Size controls to risk: money, personal data or several tenants get every control below, tested; a private tool gets TLS, patched dependencies and no secrets in the repo.

## Contracts
- Plural-noun resources; methods keep their meaning (GET safe, PUT and DELETE idempotent). Honest status codes: 201 with `Location`, 202 async, 400 malformed, 401, 403, 404, 409 conflict, 422 valid shape but unacceptable, 429 with `Retry-After`; upstream faults are 5xx (502, 503, 504), never 200 with `"success": false`.
- One error shape: stable code, human message, field errors, request id (RFC 9457). No stack traces, SQL, paths or other tenants' ids.
- Every list is paginated with a default and maximum `limit` (keyset for large data). ISO 8601 UTC timestamps; money in integer minor units or a decimal string with currency.
- Adding optional fields is free; removing or changing meaning needs a new version and a dated deprecation.
- Retried writes take an `Idempotency-Key`: scoped to caller and operation, bound to a payload hash, claimed atomically before the work, response stored for replay. Concurrent edits use `ETag`/`If-Match` (412) or a version column (409).
- Webhooks you send are signed (HMAC over body and timestamp) and retried with backoff; those you receive are verified and idempotent.

## Data model first
- Relational by default; the database enforces invariants (foreign keys with explicit `ON DELETE`, `NOT NULL`, unique and check constraints). "Check then insert" in app code is a race. Exact decimals or integers for money, never floats; a column you filter or join on is a column, not a JSON field.
- Before a schema or data change read [references/migration-checklist.md](references/migration-checklist.md).

## Access and input
- Authenticate, then authorize on the server for every route, job, webhook and object: owner or tenant is part of the query. Fail closed. Vetted libraries for sessions, Argon2id/bcrypt and tokens; no custom crypto; rate limit login and reset without revealing whether an account exists.
- Validate everything from outside at the boundary and bind explicit fields. Parameterized queries, no shell built from input, output escaped for its context, paths confirmed inside a base directory, user-supplied URLs fetched with private and metadata addresses blocked, uploads capped and stored outside the web root. Run [references/security-checklist.md](references/security-checklist.md) over each diff touching these. OWASP classes (XSS, CSRF, SSRF, IDOR) and CSP belong in that review.
- Secrets come from the environment or a secret store, never code, logs, error responses, URLs, client bundles or git; a committed secret is leaked and gets rotated. Least-privilege tokens. Validate config at startup and fail fast.

## When dependencies fail
- Every outbound call has a timeout inside the caller's deadline; retry only idempotent operations, a few times, with exponential backoff and jitter, never a 4xx except 408/429. Answer "what if this stays down?" per dependency: queue, labelled stale value, visible switch-off, or clear failure. On SIGTERM stop accepting work, finish in-flight work within a bound, flush logs, exit.

## Transactions, concurrency, jobs
- State the invariant, enforce it with a constraint, an atomic `UPDATE ... WHERE` with the row count checked, or a row lock. Never read, decide in app code, then write a row two callers can touch. Short transactions, no network calls inside; retry deadlocks by replaying the whole transaction. A row write plus an event is two writes: use an outbox.
- Queues deliver at least once: consumers are idempotent (dedupe key and effect in one transaction, acknowledge after commit); order per key only; bounded retries, then a dead-letter queue with an alert. Scheduled jobs take a lock so two instances never overlap.

## Observability and performance
- One structured log line per request or job (request id, route, status, duration); ids, never secrets or full bodies. Liveness and readiness checks; alert on error rate, latency, queue age.
- Measure first. Order of fixes: queries in a loop (N+1), missing indexes (read the `EXPLAIN` plan; use a copy for `EXPLAIN ANALYZE` on writes), unbounded reads, repeated work; then cache with a stated staleness, invalidation on write, jittered TTL, and never a shared personalized response.

## Deploy, rollback, live check
- Write the rollback before deploying: previous build, flag to flip, what the database change leaves behind; schema changes let old and new code both work.
- Verify what the user sees: the public URL through the CDN, cache headers (`Age`, `cf-cache-status`), anonymous versus signed-in, CORS from the real page origin, allow for propagation, purge narrowly. Report which checks were live and which local or mocked.
- Touch production, a remote host, a real database or a signed-in account only when the task authorizes it: read-only first, backup before destructive steps, no secret values printed.
- SQL notes: fix the grain before joining; `NOT IN` with a NULL matches nothing (use `NOT EXISTS`); a WHERE on the nullable side turns a left join into an inner join.
