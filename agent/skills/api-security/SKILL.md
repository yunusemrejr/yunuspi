---
name: api-security
description: "Design and review HTTP APIs and security: REST/OpenAPI contracts, errors, idempotency, webhooks, authn/authz, OWASP web vulns (XSS, CSRF, SSRF, IDOR, CSP), GitHub/Google sign-in, Turnstile, Cloudflare, retries, Linux hardening, secrets, incidents."
---

## Scope and contract
- Tier first: accounts, money, PII or multi-tenant data get all of this; static sites get TLS, headers, scanning.
- Actions: POST sub-resources (`/orders/42/cancel`); 201+Location; 429+Retry-After.
- Errors: RFC 9457 problem+json, stable codes; never leak stacks, SQL or other tenants' IDs; echo X-Request-Id.
- Keyset pagination, capped limit. Version in path (breaks mean /v2, dated sunset). Diff OpenAPI in CI.
- Retried POSTs need Idempotency-Key (store response, expire 24-48 h); concurrent edits need ETag plus If-Match (409 when stale).
- Webhooks: HMAC plus timestamp (reject skew >5 min); retries with DLQ; receivers dedupe event ids.

## Authorization and web vulns
- Authorize every object on every route, internal too: tenant and owner predicates in the query; fail closed; test IDOR by swapping IDs.
- Parameterized queries only; no `shell:true` with input; `yaml.safe_load`; never unpickle user data.
- Escape by default; no innerHTML or v-html with data; sanitize rich text (DOMPurify allowlist).
- SSRF: allowlist hosts; else resolve and reject private, link-local and 169.254.169.254; re-check redirects.
- Uploads: sniff magic bytes, re-encode images, serve outside the webroot; zips: reject `..`, cap ratio near 10:1.
- CSP: Report-Only first, then nonces, never unsafe-inline. Sandboxed iframes: never allow-scripts plus allow-same-origin.

## Sessions and passwords
- Server-side sessions with 128+ bit random tokens stored hashed; cookies HttpOnly, Secure, SameSite=Lax; revoke on logout.
- JWT only for stateless needs: access <=15 min, rotating refresh tokens, no PII inside.
- Argon2id or bcrypt >=12; CSPRNG tokens, never Math.random. Bearer-header APIs are CSRF-immune; cookie APIs need SameSite=Lax.
- Reset tokens: single-use, 15-30 min, kill sessions on reset, same reply for unknown emails; rate-limit login.

## Identity providers
- GitHub: OAuth App or GitHub App by permissions; single-use state bound to the session; PKCE S256; key on numeric user id.
- Google: verify ID token signature, alg, iss, aud, exp, nonce; key on (iss, sub). An ID token is not an API token.
- Never auto-link by email; logout is not consent revocation; test wrong state, reused codes, denied consent.

## Cloudflare edge
- Workers are not Node: check compat date and limits; no fire-and-forget promises after the response.
- Turnstile success is not authorization: verify at siteverify (secret, success, hostname, action); tokens are single-use.
- Never cache personalized output under a shared key; test anonymous vs logged-in and tenant A vs B.

## Reliability
- Timeout every hop. Retry only idempotent calls: max 3, jittered backoff, retry traffic <=20-30%; never 4xx except 408/429.
- Breaker and bulkhead per dependency; stale fallbacks say "as of". Consumers are at-least-once: dedupe window exceeds redelivery.
- Outbox: row and event in one transaction; relay publishes. DLQ, alerting on non-empty DLQ and lag age.
- Alert on symptoms (p95, error rate) with runbooks; chaos-test staging; test against real DB and queue.

## Host and infra
- Per-service identity, no shared root, short-lived creds; break-glass alerted on use; no superuser in apps, CI or notebooks.
- Secrets in vault or KMS, never in repo, box files or CI variables visible to all jobs; redact logs; rotate on exposure.
- DB, queues and admin stay private; default-deny egress per service; block the metadata endpoint for URL fetchers; require IMDSv2.
- Before SSH/firewall edits: keep a second session, run `sshd -t`; check IPv6 and container ports (UFW alone proves nothing).
- Patch criticals on exposed surfaces within 48 h; pin lockfiles and toolchains; build on ephemeral, egress-limited runners.

## Incidents and checks
- Order: contain, preserve evidence, communicate scope, blameless root cause, verify the fix is enforced (rotate, grep, alert). AV scans prove nothing.
- Per PR: gitleaks, dependency audit, default SAST. Staging: ZAP baseline plus SQLi, XSS, IDOR, SSRF, upload, CORS and login-timing checks; grep the bundle for keys.
- Every fixed vuln gets a regression test on its exact vector. Avoid home-rolled crypto, per-request mTLS, 500-rule WAFs and five blocking scanners.
