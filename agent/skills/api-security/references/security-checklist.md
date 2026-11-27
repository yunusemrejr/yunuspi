# Security checklist

Run over a diff that adds or changes a route, job, webhook, query, upload, auth flow or configuration. Tick each line or note why it does not apply. A security check is never switched off to make something pass.

## Access
- [ ] Every new route, job and webhook authenticates on the server. Nothing is protected only because the UI hides it.
- [ ] Object access checks owner or tenant inside the query, not only the role. Swapping the id in the URL gives 403 or 404.
- [ ] A failure inside the check denies access.
- [ ] Admin and destructive actions are role-checked on the server and written to an audit log (who, what, when).
- [ ] Create and update bind an explicit list of fields; no whole request body into a model.

## Input
- [ ] Body, query, headers, path parameters, files and webhook payloads are validated at the boundary: type, length, range, allowed values.
- [ ] SQL values are bound parameters. Dynamic identifiers (sort column, table) come from an allowlist. ORM raw-query calls are reviewed.
- [ ] No shell command is built from input; arguments are passed as a list.
- [ ] A path built from input is resolved and confirmed inside the intended base directory (no `..`, no absolute override, symlinks considered).
- [ ] A URL fetched from user input uses a host allowlist, or the resolved address is checked against loopback, private, link-local and cloud-metadata ranges; redirects are re-checked; there is a timeout and a size cap.
- [ ] No unpickling, unsafe YAML loading or PHP `unserialize` of untrusted data. XML parsers have external entities disabled.

## Output
- [ ] HTML is escaped for its context. No `innerHTML`, `dangerouslySetInnerHTML` or `v-html` with data; rich text goes through an allowlist sanitizer.
- [ ] Error responses carry no stack trace, SQL, file path or other tenant's data.
- [ ] `Content-Type` is correct and `X-Content-Type-Options: nosniff` is set. CORS never combines `*` with credentials; an allowed origin comes from an allowlist.
- [ ] Session cookies are `HttpOnly`, `Secure` and `SameSite`. Cookie-authenticated state changes have CSRF protection.

## Uploads
- [ ] Size is capped before processing; type is judged from content, not the extension.
- [ ] Files are stored outside the web root or in a private bucket under a generated name, and are not executed.
- [ ] Archives are checked for `..` entries and capped on expanded size and file count.

## Secrets and credentials
- [ ] No secret in the diff, fixtures, logs, error responses, URLs or the client bundle. Values come from the environment or a secret store; local secret files are git-ignored.
- [ ] A secret that reached git or a log is rotated, not only deleted.
- [ ] Passwords use Argon2id or bcrypt through a library. Tokens and ids come from a cryptographic random source, never `Math.random` or a plain `random` call. Secrets and signatures are compared in constant time.
- [ ] Reset and session tokens expire, reset tokens are single use, and sessions end on logout and password change.
- [ ] Login and reset are rate limited and answer the same for known and unknown accounts.
- [ ] Tokens and API keys carry the least privilege that works.

## Abuse and logging
- [ ] Request bodies, page sizes, upload sizes and job runtimes are bounded; expensive endpoints have limits.
- [ ] Webhook receivers verify signature and timestamp and ignore an event id already processed.
- [ ] Logs hold ids, not passwords, tokens, full bodies or personal data.
- [ ] A new dependency has a known source, maintenance and licence, an updated lockfile, and install scripts that were looked at.

## Proof
- [ ] There is a test or a manual probe for the unauthorized call, another user's object, malformed input and an oversize input.
