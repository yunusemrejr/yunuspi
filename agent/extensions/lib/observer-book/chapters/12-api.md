---
id: api
part: engineering
title: APIs and services
summary: Designing and operating service interfaces: explicit contracts and versioning, error models, pagination and idempotency, authentication and authorization, observability and resilience.
terms: api apis endpoint endpoints rest graphql grpc http request response status code json schema openapi version versioning backend server service services route handler pagination idempotency idempotent webhook rate limit auth authentication authorization token jwt oauth
files: .proto .graphql openapi.yaml openapi.json /routes/ /api/ /handlers/
tools: http_request web_probe workflow_probe package_probe
skills: api-design go-service-engineering node-runtime-engineering web-security
---

# APIs and services

An API is a promise to strangers. Once published, its shape, semantics and failure behavior become dependencies for code you will never see. Good APIs are explicit, predictable under failure, and evolvable without breaking the promise.

## Make the contract explicit and versioned {#contracts}
<!-- terms: contract schema openapi version versioning breaking change backward compatible deprecate -->

**Principle.** Define request and response schemas explicitly, validate them at the edge, and evolve by adding—never by silently changing meaning.

**Why.** Implicit contracts ("whatever the handler returns") drift with refactors and break clients unpredictably. A schema (OpenAPI, protobuf, GraphQL SDL, JSON Schema) documents, validates and generates clients. Compatibility rules are simple but strict: adding optional fields is safe; removing fields, renaming, changing types or tightening validation breaks someone. Breaking changes need a new version or a deprecation window with telemetry showing who still uses the old behavior.

**Signals.** Response shapes changed in a refactor; fields renamed or removed; validation added that rejects previously accepted input.

**Ask.** Would every existing client keep working after this change, and how would we know?

**Traps.** Versioning everything eagerly; treating internal APIs with one caller like public ones.

## Design the error model, not just the happy path {#errors}
<!-- terms: error status code 400 401 403 404 409 422 429 500 503 problem details retry message -->

**Principle.** Use status codes and structured error bodies that tell clients what went wrong, whether retrying can help, and what to do next.

**Why.** Clients act on errors programmatically: retry on 503 or 429, re-authenticate on 401, fix input on 422, stop on 403. A 200 with an error message inside, or a 500 for invalid input, breaks that automation. Structured errors (a stable code, a human message, the offending field, a correlation id) make debugging cross-team failures fast. Internal details—stack traces, SQL, file paths—must never leak.

**Signals.** Generic 500s for client mistakes; errors returned with 200; stack traces in responses; inconsistent error formats across endpoints.

**Ask.** For each failure this endpoint can produce, can a client tell whether to retry, fix its input or give up?

**Traps.** Over-detailed error taxonomies nobody handles; leaking existence of resources via different error codes.

## Paginate, bound and make writes idempotent {#pagination-idempotency}
<!-- terms: pagination cursor offset limit bounded idempotency key retry duplicate webhook replay -->

**Principle.** Every list endpoint is bounded and paginated; every write that clients may retry accepts an idempotency key or is naturally idempotent.

**Why.** Unbounded lists work until a customer has a million rows, then time out or exhaust memory. Cursor-based pagination stays correct when items are inserted during iteration, unlike offsets. Networks fail after the server commits but before the client hears back, so clients retry; without idempotency keys, retries create duplicate orders, charges or messages. Webhooks are delivered at least once and must be deduplicated by event id.

**Signals.** List endpoints returning everything; offset pagination over changing data; payment or creation endpoints without idempotency; webhook handlers without deduplication.

**Ask.** What happens if this request is retried after a timeout, and what if the list has a million items?

**Traps.** Idempotency keys that expire before client retries end; pagination tokens that leak internal ids.

## Authenticate who, authorize what, on every access {#authz}
<!-- terms: authentication authorization login signin jwt oauth permission role rbac object level idor tenant access control token session -->

**Principle.** Authentication establishes identity; authorization must be checked for each object accessed, including tenant boundaries.

**Why.** The most common severe API vulnerability is broken object-level authorization: an authenticated user changes an id in the URL and reads someone else's data. Checking "is logged in" is not enough; every access to a resource must verify the caller may act on that specific resource. Centralizing checks (policies, middleware, query scoping by tenant) prevents forgotten routes. Tokens need short lifetimes, rotation and revocation.

**Signals.** Handlers loading records by id without ownership checks; admin actions guarded only in the UI; multi-tenant queries lacking a tenant filter.

**Ask.** If a logged-in user changes the id in this request, what stops them from accessing another user's data?

**Traps.** Authorization only in the frontend; confusing API keys (who is calling) with user permissions.

## Every call has a timeout, a retry policy and a budget {#resilience}
<!-- terms: timeout retry backoff jitter circuit breaker bulkhead fallback degrade dependency outage -->

**Principle.** Calls to other services need timeouts, bounded retries with exponential backoff and jitter, and a plan for when the dependency is down.

**Why.** A dependency without a timeout turns its slowness into your outage as requests pile up and exhaust threads or connections. Retries without backoff turn a brief blip into a thundering herd that keeps the dependency down. Circuit breakers stop hammering a failing service; bulkheads isolate resources so one slow dependency cannot starve others. Graceful degradation (cached data, reduced features) keeps core flows alive.

**Signals.** HTTP clients without timeouts; retry loops without backoff; synchronous chains of several services on the user's critical path.

**Ask.** What happens to this endpoint when the dependency it calls is slow or down?

**Traps.** Retrying non-idempotent operations; timeouts longer than the caller's own timeout.

## Observability is part of the API {#observability}
<!-- terms: logging logs metrics tracing trace correlation id structured log latency error rate dashboard slo -->

**Principle.** Emit structured logs, request metrics and traces with correlation ids so any failed request can be followed across services.

**Why.** When something fails in production, the questions are always the same: which requests, since when, how many, where in the chain. Structured logs (key-value, not prose), the golden signals (latency, traffic, errors, saturation) and distributed tracing answer them in minutes. Without correlation ids, a multi-service failure is guesswork. Logs must exclude secrets and personal data.

**Signals.** Print-style logs without context; no request ids; errors logged without inputs or identifiers; secrets or tokens in logs.

**Ask.** If this request fails in production, what would we see, and could we trace it across services?

**Traps.** Logging everything at high volume and cost; high-cardinality metric labels that explode storage.
