/** Narrow, advisory cues. Matching and delivery budgets belong to guidance-topics. */
import type { GuidanceTopic } from "./guidance-topics.ts";

type Row = [string, RegExp, string, string];
const group = (domain: string, rows: Row[]): GuidanceTopic[] => rows.map(([id, terms, check, example]) => ({
  id: `systems-${domain}-${id}`, domain, terms, check, examples: [example],
}));

export const systemsTopics: GuidanceTopic[] = [
  ...group("api", [
    ["idempotency", /\bidempotency[- _]keys?\b/i, "For idempotency keys, bind the key to the request identity and payload; replay the original result and define behavior for concurrent duplicates.", "Implement idempotency keys for checkout requests"],
    ["cursor-pagination", /\bcursor[- ]pagination\b|\bnext_cursor\b/i, "For cursor pagination, use a stable unique tie-breaker and align the cursor with filters and sort order so inserts do not duplicate or skip rows.", "Fix cursor pagination for the orders API"],
    ["offset-pagination", /\boffset[- ]pagination\b|\bLIMIT\s+\d+\s+OFFSET\b/i, "For offset pagination, keep ordering deterministic and consider how concurrent inserts or deletes affect page boundaries.", "Fix offset pagination for search results"],
    ["conditional-write", /\bIf-Match\b|\bconditional (?:HTTP )?writes?\b/i, "For conditional writes, compare the version atomically with the mutation and preserve the existing stale-version response contract.", "Implement If-Match support for profile updates"],
    ["patch-fields", /\bJSON (?:Merge )?Patch\b|\bmerge[- ]patch\b/i, "For patch requests, distinguish an absent field from an explicit null and validate the resulting resource, including fields the caller cannot modify.", "Implement JSON Merge Patch for account settings"],
    ["rate-limit", /\brate[- ]limit(?:ing|er|ers)?\b|\bRetry-After\b/i, "For rate limiting, choose the intended identity and scope, bound limiter storage, and keep rejection responses and retry timing consistent.", "Implement a rate limiter for login attempts"],
    ["webhook-signature", /\bwebhook signatures?\b|\bverifyWebhookSignature\b/i, "For webhook signatures, verify the exact raw body before parsing, compare safely, and apply the provider's replay-window contract.", "Fix webhook signature verification"],
    ["webhook-retry", /\bwebhook (?:retries|retry|redelivery|duplicates?)\b/i, "For webhook retries, deduplicate by the provider event identity and acknowledge only after the event is durably accepted.", "Fix webhook retries creating duplicate invoices"],
    ["upload-limit", /\b(?:multipart uploads?|upload (?:limits?|sizes?))\b/i, "For uploads, enforce size limits while streaming and clean up partial files when validation, cancellation, or downstream writes fail.", "Implement upload limits for multipart uploads"],
    ["sse", /\bServer-Sent Events\b|\bEventSource\s*\(|\btext\/event-stream\b/i, "For server-sent events, handle disconnect cleanup, bounded buffering, and reconnect event IDs consistently with the stream's delivery guarantees.", "Implement Server-Sent Events for job progress"],
  ]),
  ...group("security", [
    ["jwt", /\bJWT (?:verif\w*|valid\w*)\b|\bjwt\.verify\s*\(/i, "For JWT verification, constrain algorithms and validate issuer, audience, and expiry; decoding a token alone does not authenticate it.", "Fix JWT verification in the API"],
    ["oauth-state", /\bOAuth (?:state|callback)\b/i, "For OAuth callbacks, bind a one-time state value to the initiating session and validate redirect destinations against the intended allowlist.", "Implement OAuth state validation"],
    ["pkce", /\bPKCE\b|\bcode_verifier\b|\bcode_challenge\b/i, "For PKCE, generate a fresh high-entropy verifier per authorization attempt and bind it to that attempt through callback completion.", "Implement PKCE for desktop sign-in"],
    ["csrf", /\bCSRF\b|\bcsrfToken\b/i, "For CSRF protection, cover state-changing cookie-authenticated routes and verify the token's session binding; SameSite behavior depends on the flow.", "Fix CSRF validation for account updates"],
    ["session-fixation", /\bsession fixation\b|\bregenerateSession\b/i, "For session fixation defenses, rotate the session identifier after authentication or privilege changes and invalidate the previous identifier.", "Fix session fixation during login"],
    ["password-reset", /\bpassword[- ]reset\b/i, "For password reset, use expiring single-use tokens, consume them atomically, and keep account-existence responses consistent with the app's policy.", "Implement password reset tokens"],
    ["ssrf", /\bSSRF\b|\bserver[- ]side request forgery\b/i, "For SSRF defenses, validate resolved destinations and redirects at connection time; include loopback, private, link-local, and IPv6 address forms.", "Fix SSRF in the URL preview service"],
    ["path-traversal", /\bpath traversal\b|\bzip[- ]slip\b/i, "For path traversal defenses, resolve paths against the intended root and account for symlinks and archive entries before writing or opening files.", "Fix path traversal in archive extraction"],
    ["command-injection", /\bcommand injection\b|\bexecSync\s*\(/i, "For commands influenced by input, prefer argument arrays without shell interpretation and separate option parsing from user-provided positional arguments.", "Fix command injection in the export script"],
    ["tenant-access", /\b(?:tenant isolation|cross[- ]tenant|object[- ]level authorization|IDOR)\b/i, "For object access, enforce tenant and ownership constraints in the data lookup or mutation itself, including indirect identifiers and bulk operations.", "Fix cross-tenant access in invoice downloads"],
  ]),
  ...group("database", [
    ["unique-race", /\b(?:unique constraint|duplicate[- ]key|ON CONFLICT)\b/i, "For uniqueness, let the database arbitrate concurrent writes and handle the conflict explicitly; a prior existence check cannot close the race.", "Fix duplicate-key errors during account creation"],
    ["transaction", /\b(?:transaction rollback|BEGIN TRANSACTION|withTransaction)\b/i, "For transaction boundaries, ensure every participating query uses the same transaction handle and release it on success, failure, and cancellation.", "Fix transaction rollback when invoice creation fails"],
    ["deadlock", /\bdeadlocks?\b/i, "For deadlocks, inspect lock acquisition order and keep transactions short; retry only the whole retry-safe transaction with a bounded policy.", "Fix database deadlocks between inventory updates"],
    ["n-plus-one", /\bN\+1\b|\bN[- ]plus[- ]one\b/i, "For N+1 queries, measure query count on a representative page and preserve authorization, ordering, and missing-relation behavior when batching.", "Fix N+1 queries on the orders endpoint"],
    ["index-plan", /\b(?:EXPLAIN ANALYZE|composite index|covering index)\b/i, "For index changes, check the representative query plan and predicate/order alignment; include write cost and existing index overlap in the decision.", "Optimize the composite index for the events query"],
    ["nullable-unique", /\b(?:nullable unique|NULLS NOT DISTINCT|unique nullable)\b/i, "For nullable uniqueness, check the database's actual NULL semantics and encode the intended rule explicitly in the constraint.", "Fix nullable unique email constraints"],
    ["foreign-key", /\bforeign[- ]key\b|\bON DELETE CASCADE\b/i, "For foreign keys, verify deletion/update behavior matches ownership and inspect existing orphan rows before adding or tightening the constraint.", "Implement a foreign-key constraint for order items"],
    ["backfill", /\bbackfill\b/i, "For backfills, use resumable bounded batches and a stable progress key; make reruns safe and account for writes arriving during the migration.", "Implement a backfill for normalized account names"],
    ["migration-lock", /\b(?:ALTER TABLE|online migration|concurrent index)\b/i, "For schema changes, inspect the database's lock and rewrite behavior for this exact operation and version, especially on populated tables.", "Implement an online migration for a populated table"],
    ["money-decimal", /\b(?:DECIMAL\s*\(|NUMERIC\s*\(|monetary amounts?|currency rounding)\b/i, "For monetary amounts, preserve decimal or minor-unit precision end to end and make currency scale and rounding rules explicit at boundaries.", "Fix currency rounding when persisting invoice totals"],
  ]),
  ...group("concurrency", [
    ["abort", /\bAbortController\b|\bAbortSignal\b/i, "For cancellation, propagate the signal through owned work and remove listeners/resources on every exit; cancellation should not become an unhandled rejection.", "Implement AbortController cancellation for downloads"],
    ["bounded-fanout", /\bPromise\.all\s*\([^\n]{0,100}\.map\s*\(|\b(?:bounded concurrency|concurrency limit)\b/i, "For concurrent fan-out, bound active work and define whether one failure cancels siblings or allows partial results; preserve required result ordering.", "Implement bounded concurrency for image processing"],
    ["mutex", /\b(?:mutex|async lock)\b/i, "For mutexes, release ownership in a finally/guard path and avoid holding the lock across unrelated slow I/O; check re-entry and cancellation behavior.", "Fix mutex release after an upload failure"],
    ["semaphore", /\bsemaphores?\b/i, "For semaphores, balance every successful acquisition with one release and remove cancelled waiters without consuming future permits.", "Implement a semaphore for worker capacity"],
    ["singleflight", /\bsingle[- ]flight\b|\bsingleflight\b/i, "For single-flight work, clear both fulfilled and rejected entries and decide whether one caller's cancellation should cancel shared work.", "Implement single-flight token refresh"],
    ["optimistic-lock", /\boptimistic (?:lock|concurrency)\w*\b/i, "For optimistic concurrency, compare and update the version atomically and return a clear conflict instead of silently overwriting a newer value.", "Implement optimistic locking for document edits"],
    ["atomic-counter", /\batomic (?:counter|increment)\b|\bAtomics\.add\s*\(/i, "For atomic counters, verify the counter's scope, overflow behavior, and reset lifetime; one atomic increment does not make a multi-step protocol atomic.", "Fix an atomic counter used for worker reservations"],
    ["worker-pool", /\bworker[- ]pool\b/i, "For worker pools, bound pending work, handle worker death, and define how shutdown drains or rejects queued jobs.", "Implement a worker pool for compression jobs"],
    ["race-result", /\b(?:stale responses?|out[- ]of[- ]order responses?|last[- ]request[- ]wins)\b/i, "For overlapping requests, bind results to the request generation so a slower old response cannot replace newer state.", "Fix stale responses overwriting current search results"],
    ["condition-variable", /\bcondition[- ]variable\b|\bcondvar\b/i, "For condition variables, check the predicate while holding its mutex and recheck in a loop after waking, including shutdown and spurious wakeups.", "Fix condition-variable wakeups in the job queue"],
  ]),
  ...group("runtime", [
    ["stream-backpressure", /\bbackpressure\b|\.write\s*\([^\n]{0,60}\)\s*===?\s*false/i, "For streaming writes, honor downstream backpressure and propagate errors in both directions so buffering remains bounded.", "Fix backpressure in the file download stream"],
    ["listener-cleanup", /\b(?:addEventListener|\.on)\s*\(|\bevent listener leak\b/i, "For long-lived event subscriptions, pair registration with cleanup on disposal and avoid registering another listener on every reconnect or request.", "Fix an event listener leak after reconnecting"],
    ["interval-cleanup", /\bsetInterval\s*\(|\binterval timer\b/i, "For interval timers, define ownership and cleanup, and prevent overlapping async ticks when one iteration takes longer than the interval.", "Fix an interval timer that overlaps network requests"],
    ["child-process", /\b(?:child_process|subprocess\.Popen|child process)\b/i, "For child processes, drain output with bounds and handle spawn failure, exit, timeout, and cancellation without leaving descendants or unresolved promises.", "Fix child process cleanup on cancellation"],
    ["temp-files", /\b(?:mkdtemp|TemporaryDirectory|temporary files?)\b/i, "For temporary files, use unique names within the intended temporary directory and clean up on failure as well as normal completion.", "Fix temporary file cleanup after conversion errors"],
    ["atomic-file", /\b(?:atomic file|atomic write|write[- ]rename)\b/i, "For atomic file replacement, write beside the destination, handle permissions and rename failure, and distinguish atomic visibility from crash durability.", "Implement atomic file writes for the local state"],
    ["json-lines", /\b(?:JSONL|NDJSON|JSON Lines)\b/i, "For JSON Lines streams, handle partial trailing records and bounded line lengths; decide explicitly whether one malformed record stops or skips processing.", "Fix JSONL parsing for truncated logs"],
    ["utf8-chunks", /\b(?:TextDecoder|StringDecoder|UTF-?8 chunks?)\b/i, "For chunked text decoding, retain decoder state across chunks so split multibyte characters are not corrupted; flush the decoder at end of stream.", "Fix UTF-8 chunks split across stream boundaries"],
    ["regex-redos", /\b(?:ReDoS|catastrophic backtracking|regex timeout)\b/i, "For regex complexity, bound input and inspect nested ambiguous repetition; verify worst-case near-matches as well as typical successful matches.", "Fix catastrophic backtracking in input validation"],
    ["graceful-shutdown", /\bgraceful shutdown\b|\bSIGTERM\b/i, "For graceful shutdown, stop accepting new work, drain owned work with a deadline, and close resources once even if shutdown signals repeat.", "Implement graceful shutdown for the API worker"],
  ]),
  ...group("distributed", [
    ["retry-backoff", /\b(?:exponential backoff|retry jitter|backoff jitter)\b/i, "For retry backoff, bound attempts and elapsed time, add jitter where callers can synchronize, and honor cancellation and server retry hints.", "Implement exponential backoff for transient API errors"],
    ["retry-safety", /\b(?:retryable errors?|retry policy|automatic retries)\b/i, "For retries, classify transient failures and consider whether the operation may already have committed before retrying a timeout or lost response.", "Fix the retry policy for payment requests"],
    ["circuit-breaker", /\bcircuit[- ]breaker\b/i, "For circuit breakers, scope failure counts to the dependency and bound half-open probes; do not count caller validation failures as dependency outages.", "Implement a circuit breaker for the upstream service"],
    ["outbox", /\btransactional outbox\b|\boutbox pattern\b/i, "For an outbox, commit the business change and event together, then make delivery and consumers tolerate duplicates and interrupted acknowledgments.", "Implement a transactional outbox for order events"],
    ["queue-ack", /\b(?:queue acknowledg\w*|visibility timeout|acknowledg\w* messages?)\b/i, "For queue acknowledgment, acknowledge after durable processing and align visibility renewal with job duration; redelivery must remain safe.", "Fix queue acknowledgments after failed processing"],
    ["lease-fencing", /\b(?:fencing tokens?|distributed lease|lease expiry)\b/i, "For distributed leases, ensure expired owners cannot keep committing writes; a monotonically increasing fencing token can enforce ownership at the resource.", "Implement fencing tokens for a distributed lease"],
    ["cache-stampede", /\bcache stampede\b|\bthundering herd\b/i, "For cache stampedes, coalesce refreshes and spread expiry where appropriate; define how callers behave when refresh fails or the old value expires.", "Fix a cache stampede on popular profiles"],
    ["cache-key", /\bcache keys?\b|\bcacheKey\b/i, "For cache keys, include every input that changes the result, including tenant, authorization scope, locale, and schema version when relevant.", "Fix cache keys mixing account-specific results"],
    ["negative-cache", /\bnegative cach(?:e|ing)\b/i, "For negative caching, distinguish a genuine absence from authorization or transient errors and choose expiry that allows newly created data to appear.", "Implement negative caching for missing objects"],
    ["clock-skew", /\bclock skew\b|\bmonotonic clock\b/i, "For elapsed-time decisions, use a monotonic clock locally; do not compare independent machines' monotonic timestamps or assume wall clocks cannot move backward.", "Fix clock skew affecting retry deadlines"],
  ]),
  ...group("infra", [
    ["docker-context", /(?:\.dockerignore\b|\bDocker build context\b)/i, "For Docker build context, exclude credentials and irrelevant artifacts while retaining every file required by the actual build steps.", "Fix .dockerignore exclusions for the build"],
    ["docker-layers", /\b(?:Docker layer cach\w*|multi[- ]stage Docker|COPY --from)\b/i, "For Docker layer caching, copy stable dependency manifests before frequently changing source and keep build-only dependencies out of the runtime stage.", "Optimize Docker layer caching for the app"],
    ["kube-probes", /\b(?:readinessProbe|livenessProbe|startupProbe|Kubernetes probes?)\b/i, "For Kubernetes probes, separate readiness from liveness and allow startup time; an upstream outage should not automatically create a restart loop.", "Fix Kubernetes probes during slow startup"],
    ["resource-limits", /\b(?:OOMKilled|container memory limits?|Kubernetes resource limits?)\b/i, "For container memory limits, account for native buffers and workers beyond the managed heap and compare the limit with observed peak usage.", "Fix OOMKilled workers within container memory limits"],
    ["terraform-state", /\bTerraform state\b|\bterraform state\b/i, "For Terraform state changes, inspect the exact resource addresses and ownership mapping; distinguish moving state from recreating infrastructure.", "Fix Terraform state addresses after module refactoring"],
    ["ci-cache", /\b(?:CI cache|actions\/cache|cache-dependency-path)\b/i, "For CI caches, key by the inputs that determine compatibility and keep restore behavior correct when the cache is missing, stale, or read-only.", "Fix CI cache keys after dependency updates"],
    ["ci-permissions", /\b(?:GITHUB_TOKEN permissions|workflow permissions|permissions:\s*read-all)\b/i, "For workflow permissions, grant only the operations the job performs and consider the different token and secret behavior of fork pull requests.", "Fix workflow permissions for pull request checks"],
    ["rolling-deploy", /\b(?:rolling deploy\w*|zero[- ]downtime deploy\w*)\b/i, "For rolling deploys, keep old and new instances compatible with shared data and messages during overlap, including rollback behavior.", "Implement a rolling deployment for the API"],
    ["health-endpoint", /\b(?:health[- ]check endpoint|healthcheck endpoint|\/healthz\b)/i, "For health endpoints, make the response reflect the intended readiness contract without expensive work or exposing dependency credentials and internals.", "Implement a health-check endpoint for the service"],
    ["secret-rotation", /\b(?:secret rotation|rotat\w* (?:API keys|credentials|secrets))\b/i, "For credential rotation, account for overlap between old and new credentials, refresh behavior in running processes, and removal of the old credential.", "Implement secret rotation for the worker"],
  ]),
  ...group("testing", [
    ["fake-timers", /\bfake timers?\b|\buseFakeTimers\s*\(/i, "For fake timers, advance the scheduler and pending promises deliberately, and restore real timers so later checks do not inherit the test's clock.", "Fix fake timers in the debounce test"],
    ["flaky-tests", /\bflaky tests?\b|\btest flakiness\b/i, "For flaky tests, identify shared state, scheduling, or external dependencies before adding retries; keep the failure reproducible with a recorded seed or trace.", "Fix flaky tests for concurrent requests"],
    ["snapshot-tests", /\bsnapshot tests?\b|\btoMatchSnapshot\s*\(/i, "For snapshot changes, inspect the actual behavior diff and stabilize irrelevant nondeterminism; updating snapshots alone does not establish correctness.", "Fix snapshot tests after the serializer change"],
    ["property-tests", /\bproperty[- ]based tests?\b|\bfc\.assert\s*\(/i, "For property-based tests, state an invariant independent of the implementation and retain useful shrinking and seed information for failures.", "Implement property-based tests for the parser"],
    ["mock-boundary", /\b(?:mocked (?:API|client|service)|mock boundary|mockImplementation)\b/i, "For mocks, keep the boundary contract realistic, including errors and asynchronous behavior; avoid replacing the behavior the test is meant to verify.", "Fix the mocked API client in retry tests"],
    ["test-isolation", /\b(?:test isolation|parallel tests|shared test state)\b/i, "For parallel tests, isolate mutable files, environment variables, ports, and database rows and clean up even when an assertion fails.", "Fix test isolation for parallel tests"],
    ["contract-tests", /\bcontract tests?\b/i, "For contract tests, cover the observable request and response shape, status, and compatibility behavior at the real integration boundary.", "Implement contract tests for the billing API"],
    ["regression-tests", /\bregression tests?\b/i, "For a regression test, reproduce the original trigger and assert the user-visible failure is fixed; confirm the assertion would fail before the repair.", "Implement a regression test for the duplicate charge bug"],
    ["benchmark", /\b(?:microbenchmark|benchmark variance|benchmark warmup)\b/i, "For microbenchmarks, separate setup from measured work, include warmup where needed, and compare repeated distributions under the same workload.", "Fix microbenchmark setup overhead"],
    ["fuzzing", /\bfuzz(?:ing|er| tests?)\b/i, "For fuzzing, bound resources and target parsing/state invariants; preserve minimized crashes as reproducible inputs without importing unsafe payloads into normal flows.", "Implement fuzzing for the binary decoder"],
  ]),
  ...group("git", [
    ["merge-conflict", /\bmerge conflicts?\b|\bconflict markers?\b/i, "For merge conflicts, reconstruct both sides' intent and check surrounding behavior; resolving markers does not establish that the combined change works.", "Fix merge conflicts in the scheduler"],
    ["rebase", /\bgit rebase\b|\brebase conflicts?\b/i, "For rebase conflicts, verify which commit is being replayed and preserve unrelated work; inspect the resulting commit diff before continuing.", "Fix rebase conflicts in the feature branch"],
    ["cherry-pick", /\bcherry[- ]pick(?:ing|ed)?\b/i, "For cherry-picks, check prerequisite commits and target-branch differences so the selected change does not silently omit required behavior.", "Implement the fix by cherry-picking the upstream commit"],
    ["gitignore", /\.gitignore\b|\bgit ignore rules?\b/i, "For ignore rules, verify the exact affected paths and remember that already tracked files remain tracked after a new ignore pattern.", "Fix .gitignore patterns for generated artifacts"],
    ["submodule", /\bgit submodules?\b|\b\.gitmodules\b/i, "For submodules, distinguish the recorded commit from the local checkout and verify the intended revision is available to fresh clones.", "Fix git submodule references in the build"],
    ["worktree", /\bgit worktrees?\b/i, "For Git worktrees, inspect branch ownership and the correct checkout before editing; account for shared repository configuration and separate working files.", "Fix git worktree setup for the integration branch"],
    ["bisect", /\bgit bisect\b/i, "For bisection, use a stable predicate with distinct good, bad, and untestable outcomes, and preserve the original checkout state for restoration.", "Debug the regression with git bisect"],
    ["rename-case", /\bcase[- ]only (?:rename|file rename)\b/i, "For case-only renames, verify the recorded repository path and imports on a case-sensitive filesystem as well as the current platform.", "Fix a case-only file rename in the repository"],
    ["lockfile", /\blockfile\b|\bpackage-lock\.json\b|\bpnpm-lock\.yaml\b/i, "For lockfile changes, use the repository's package manager and version, and inspect whether the dependency graph changed beyond the requested update.", "Fix the lockfile after a dependency update"],
    ["generated-diff", /\b(?:generated code|generated artifacts?|code generation)\b/i, "For generated changes, locate the source and generator contract, then verify generated output follows that source rather than applying an unstable manual patch.", "Fix generated code after changing the schema"],
  ]),
  ...group("protocol", [
    ["http-redirect", /\b(?:HTTP redirects?|redirect loop|Location header)\b/i, "For redirects, preserve or change method and body according to the intended status code, and bound redirect chains and destination changes.", "Fix an HTTP redirect loop in the client"],
    ["http-cache", /\b(?:Cache-Control|ETag|Vary header)\b/i, "For HTTP caching, align freshness and validators with the representation, and include relevant request variation without caching private data publicly.", "Fix Cache-Control for account responses"],
    ["cors", /\bCORS\b|\bAccess-Control-Allow-Origin\b/i, "For CORS, match allowed origins deliberately and handle preflight and credential behavior together; origin permission does not replace authorization.", "Fix CORS for authenticated browser requests"],
    ["websocket", /\bWebSockets?\b/i, "For WebSockets, bound inbound and outbound messages and handle disconnect cleanup, authentication lifetime, and reconnect behavior explicitly.", "Implement WebSocket reconnect handling"],
    ["grpc-deadline", /\bgRPC deadlines?\b|\bDEADLINE_EXCEEDED\b/i, "For gRPC deadlines, propagate the remaining deadline to downstream work and stop owned work when the call is cancelled or expires.", "Fix gRPC deadline propagation"],
    ["protobuf-fields", /\b(?:protobuf fields?|reserved field numbers?|Protocol Buffers)\b/i, "For Protocol Buffers evolution, preserve field numbers and wire types and reserve removed fields so old and new readers remain compatible.", "Update protobuf fields for the event schema"],
    ["url-encoding", /\b(?:URL encoding|encodeURIComponent|percent[- ]encoding)\b/i, "For URL encoding, encode individual components at the correct boundary and avoid double encoding or treating an encoded separator as a trusted path boundary.", "Fix URL encoding for object identifiers"],
    ["content-length", /\bContent-Length\b/i, "For Content-Length, count transmitted bytes rather than text characters and account for compression or streaming before setting the header.", "Fix Content-Length for Unicode responses"],
    ["range-request", /\b(?:Range requests?|Content-Range|Accept-Ranges)\b/i, "For range requests, validate bounds and suffix forms against the resource size and keep partial-response status and Content-Range consistent.", "Implement Range requests for audio downloads"],
    ["multipart-boundary", /\bmultipart boundar(?:y|ies)\b/i, "For multipart boundaries, let the encoder and Content-Type agree, and handle boundary fragments across chunks without losing part headers or payload bytes.", "Fix multipart boundaries in the upload parser"],
  ]),
];

// Near misses keep unrelated wording from becoming a reason to interrupt.
const nearMisses: Record<string, string> = {
  "api-idempotency": "Implement keyboard keys for the checkout form",
  "api-cursor-pagination": "Fix the mouse cursor on the search page",
  "api-offset-pagination": "Fix the offset of the tooltip",
  "api-conditional-write": "Implement a conditional expression in the form",
  "api-patch-fields": "Fix the patch release notes",
  "api-webhook-signature": "Update the function signature for the parser",
  "api-webhook-retry": "Fix retries in the local task runner",
  "security-jwt": "Update the JWT documentation heading",
  "security-oauth-state": "Fix the state parameter of the animation component",
  "security-session-fixation": "Update the session list sorting",
  "security-path-traversal": "Implement tree traversal in the graph viewer",
  "database-n-plus-one": "Fix one query on the orders page",
  "database-index-plan": "Update the index page title",
  "database-money-decimal": "Fix rounding of chart tick positions",
  "concurrency-atomic-counter": "Fix the visitor counter label",
  "concurrency-worker-pool": "Update the swimming pool booking page",
  "concurrency-race-result": "Fix the response footer typography",
  "runtime-stream-backpressure": "Fix pressure unit conversions",
  "runtime-interval-cleanup": "Update the confidence interval chart",
  "runtime-json-lines": "Fix the JSON settings object",
  "distributed-outbox": "Update the outbox folder icon",
  "distributed-lease-fencing": "Fix the property lease form",
  "distributed-clock-skew": "Fix the wall clock face layout",
  "infra-docker-layers": "Update the layer selector in the image editor",
  "infra-health-endpoint": "Build a health tracking dashboard",
  "testing-fake-timers": "Fix the countdown label",
  "testing-snapshot-tests": "Update the database snapshot retention setting",
  "git-merge-conflict": "Implement a merge sort algorithm",
  "git-rename-case": "Fix uppercase text in the heading",
  "protocol-range-request": "Update the range slider styling",
  "protocol-multipart-boundary": "Fix polygon boundary intersections",
};
for (const topic of systemsTopics) {
  const negative = nearMisses[topic.id.slice("systems-".length)];
  if (negative) topic.negative = [negative];
}

// File gates apply only to edits; explicit task requests remain language agnostic.
const dataFiles = /\.(?:sql|py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|cs|php|rb|prisma|ex|exs|scala|json|ya?ml)$/i;
for (const topic of systemsTopics) {
  if (topic.domain === "database") topic.file = dataFiles;
  if (topic.id === "systems-database-deadlock") {
    topic.context = /\b(?:database|transactions?|postgres(?:ql)?|mysql|sqlite|sqlserver|mariadb)\b|(?:^|\/)(?:db|database|migrations?)(?:\/|$)/i;
    topic.negative = ["Fix mutex deadlocks in the renderer"];
  }
}
