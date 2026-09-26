# Micro-intelligence architecture

YunusPi layers five kinds of intelligence so the main model spends its
reasoning on work that actually requires it:

```text
DETERMINISTIC HARNESS LOGIC        cheap, auditable, authoritative
        ↓
NEEDLE3                            local semantic reflex (this machine)
        ↓
LOCAL LM (Qwen3.5-0.8B)            calibrated judgements, shortlists, line selection
        ↓
KOMPRESS                           extractive prose paragraph selection
        ↓
JEV                                cheap remote typed semantic judgment
        ↓
SPAN                               soft behavior sensor over session traces (shadow-first)
        ↓
MICRO-WORKER                       bounded cheap-remote helper (no tools, no writes)
        ↓
REMOTE RERANK                      opt-in precision stage (Needle stays default)
        ↓
MAIN / CHILD LLM / COUNCIL         deep reasoning, synthesis, judgment
```

Typed Jev decisions, finding consolidation, the router shadow and the
model qualification lab are coordination around these layers: registries,
evidence stores and benchmarks, not additional inference authorities.

This is not a serial pipeline. Every job invokes the combination its
content shape and uncertainty warrant, usually in parallel with the main
model's own latency. Cheap layers propose; deterministic owners dispose;
nothing below the main model establishes truth, authorization, completion,
test success, or permission.

## Exact observation queries and visible activity

`obs_read({id:17,query:"authentication failure",limit:3000,maxMatches:3})` searches the active branch's original result. Existing binary TF-IDF with explicit vocabulary expansion selects candidates; the shared Needle3 worker may reorder a bounded head when its score and margin clear the existing acceptance thresholds. Weak or unavailable inference keeps lexical order. Raw observations are never sent to JEV for this query path. There is no separate evidence store, embedding cache or background model turn.

Responses contain exact UTF-16 source ranges, a SHA256 source hash, original error/exit metadata, actual scanned-prefix length and an explicit incomplete-evidence warning. At most 524,288 UTF-16 code units and 1,024 overlapping source windows are considered; a lower window cap reports the shorter actual prefix. Queries return at most six excerpts and 20,000 source characters, defaulting to three and 6,000. No lexical match does not establish absence. Keep `obs_read({id:17,offset:0,limit:20000})` for original pagination, including evidence omitted from a query. Ranking never changes previously rendered provider history.

Actual completed intelligence work produces small, flowing session notes. They distinguish local WASM operations, remote JEV judgments, cache hits, selected/abstained results, exact excerpts returned by a tool and evidence first added to model context. A context projection is not proof that a provider accepted a request. Character savings or omissions are not token or billing measurements. Only simultaneous event bursts aggregate; later meaningful uses remain visible. Child notes require the matching live owner, and display-only notes are excluded from provider input, replay conversion and compaction. They do not wake the model.

JEV is invoked for eligible semantic judgments, not on every prompt or tool call. Admission failures now leave a visible reason as well as diagnostics. Needle unavailable states likewise retain a reason and the caller's fallback. Fuzzy skill matching is local lexical JavaScript; its match count includes only fuzzy matches, not every skill selected by another route. It is not a WASM inference claim.

Routine background work (Guardian checks, Needle rankings, fuzzy matches, router matches, local-model calls, hooks and hints) is counted in one live footer line, `harness · Guardian 14 checks · 2 WASM · Needle3 6 · local LM 3 · hooks 2 …`, instead of a transcript line each. Actions that change what the agent sees stay individual lines: Guardian verdicts and interventions, hooks, local-model gating, JEV answers, evidence added to context. Without a footer the previous lines remain. The line selector distinguishes short inputs, unsupported shapes, budget boundaries and protected content. An `UNKNOWN` response means no safe useful selection was returned, so the full original remains available.

## Inspectable prompt analysis

Initial and follow-up analyses produce one persistent TUI message. It shows the task interpretation, follow-up relationship, model route or categorized fallback cause, and whether a long input was excerpted. Expand the message to inspect the exact advisory inserted next to the corresponding original user message. No approval step is introduced and no replacement prompt is substituted for the user's text.

The advisory separates concrete work from reusable mindset scaffolding and quoted examples. This extraction is a heuristic, not authority: omitted content may contain additional requirements, and the main agent still receives the original. A bounded model attempt may time out; the final configured route gets the remaining preflight budget. When every route fails, the TUI names each route and its timeout or failure category, and nothing is added to the main agent's context: a zero-confidence restatement of the prompt carries no information. Late responses cannot turn an already delivered fallback into a model success, and an aborted request is reported as late-failed rather than as a late completion.

Initial and follow-up prompt analysis each have one absolute four-minute deadline. A preferred route receives up to two minutes without dividing that allowance by the number of fallback routes; the final route can use the remaining time. With two configured routes, a two-minute timeout on the first still leaves two minutes for the second. This allows provider queueing and reasoning time; successful responses and fast failures advance immediately without waiting out the allowance. Only caller cancellation stops the whole analysis: a provider-originated abort advances to the next route. The JSON request asks for required intent/label/confidence and only relevant optional fields. Dynamic thinking uses the lowest supported effort; explicit configured effort is retained, with a separate bounded reasoning allowance. Output-limit responses are identified from the native stop reason and may receive one compact retry within the same deadline and four-attempt cap. Complete bounded JSON ignores unknown fields; truncated JSON is never salvaged or injected. The active route, attempt, elapsed time and allowed time are visible while analysis runs; cancellation and session replacement clear that status immediately.

## Needle3 — local semantic reflex

Needle3 (Cactus Compute, Apache-2.0) runs in a process-local worker when
verified assets are installed and the feature is enabled. It serves as
an internal harness service. It answers "which existing choice best
matches" and "what kind of thing is this" for recurring decisions:
request classification, tool/capability/skill/command ranking, error
families, evidence relevance, and escalation triage.

- Runtime: one long-lived worker thread (`needle-worker.mjs`) hosts the
  official `needle.js`/`needle.wasm` engine with `needle3.cact` weights
  (dim 3072). WASM loads once and stays warm; the main thread never
  blocks on inference.
- Operations: `needleEmbed`, `needleRank`, `needleClassify`,
  `needleExtract`, `needleHealth`. No unrestricted freeform completion.
- Safety: a bounded serial queue with an 8-second default queue deadline,
  per-op input-scaled execution timeouts, main-side and worker-side
  embedding caches, crash recovery with a restart budget,
  cooldown with periodic re-probe, and graceful `unavailable` states. No
  Needle failure can break normal operation; every op degrades to a skip
  reason the caller already handles. Initialization errors settle callers;
  execution timeouts terminate the blocked worker before new work starts.
  Candidate ids and finite embeddings are validated, cache reads return
  caller-owned vectors, and shutdown is terminal. Idle workers are unreferenced
  so they cannot retain the host process. Grammar decoding uses the execution
  ceiling (8 seconds by default); embedding budgets remain input-scaled.
- Concurrent identical normalized embedding, ranking, classification and
  extraction requests share the existing queue's in-flight operation. Each
  consumer receives its own result object and session-scoped telemetry;
  different candidates, thresholds, schema or text remain separate. Failed
  work is never retained as a reusable result, and shutdown settles all
  waiters. `coalescedCalls` reports successful shared consumers; the TUI
  identifies a shared in-flight result separately from cached embeddings.
  A controlled before/after worker fixture with twelve concurrent consumers
  for each of the four operations dispatched 48 operations before the change
  and 4 after it, with 44 shared consumers. This measures duplicate local
  work removed, not paid-provider savings or inference-quality improvement.
- Latency (measured 2026-09-19, pinned build): ~3.5ms per character warm,
  so ranking call sites truncate to ~160 chars and re-rank a 12-entry
  head slice. Repeat ranks hit the worker cache in milliseconds. Static
  corpora (tool/capability/command descriptions) warm in the background
  after the first discovery call of each kind.
- Calibration: absolute cosine is compressed (~0.90–0.99 on short
  texts), so the margin floor does the separation. Production bars are
  score ≥ 0.93 with margin ≥ 0.02; per-site bars may differ (the intent
  pre-screen uses asymmetric bars). Near-ties escalate to Jev instead of
  misapplying. Shadow mode (`PI_NEEDLE_SHADOW=1`) measures agreement
  without applying Needle results or changing baseline Jev eligibility.
- Measured 2026-09-24 on real session data: top-vs-second margins stay at
  0.000–0.013 for ranking and classification alike, so the 0.02 floor almost
  never passes. Ranking still carries signal: on 18 requests against the
  242-skill catalog, top-1/top-5 hits were 4/10 for Needle, 7/10 for lexical
  and 9/13 for their reciprocal-rank fusion. Retrieval (`tool_search`,
  `skill_review` search, observation queries) therefore fuses a low-margin
  Needle order with the lexical order (`applied: "fused"`); an adjacent swap
  ties and keeps lexical order, so Needle cannot flip neighbours on its own.
  Zero-shot classification did not carry signal: request families agreed
  with deterministic cues on 1 of 20 real prompts, and tool-error families
  reached 31% top-1 even with exemplar nearest neighbours. Both per-event
  classifications were removed; deterministic cues and rules own those
  verdicts, and the serial worker stays free for ranking. The intent
  pre-screen keeps its asymmetric bars with Jev fallback.

Assets (`needle.js`, `needle.wasm`, `needle3.cact`, upstream `LICENSE`)
are never committed. The installer fetches the pinned revision from the
official `Cactus-Compute/needle3` repository with SHA-256 verification
into an atomic stage directory, then swaps; interrupted downloads cannot
destroy working assets. Every worker startup hashes the pinned assets
before evaluating the executable loader; installation repairs same-size
corruption. Downloads have bounded attempts and validate resume ranges.
Offline installs continue without local
semantics. Repair, verify, and smoke-test any time with:

```text
node <agent>/extensions/lib/needle-assets.mjs <verify|install|repair|smoke|status>
```

Telemetry is disabled (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`). No
prompt, file, or tool content leaves the machine for Needle.

## Local language model — judgements and line selection

Qwen3.5-0.8B (Apache-2.0, 4-bit GGUF, about 580 MB with the pinned llama.cpp
`b10878` server) runs as a loopback-only user service (`pi-local-lm.service`,
port 18735, API key, four threads, 2 GB memory ceiling). It replaced the
SmolLM2-135M selector, which chose at chance level on harness data and almost
never ran. `agent/extensions/lib/local-lm-assets.mjs
<status|verify|install|repair|smoke|uninstall>` installs it with pinned
checksums, an atomic swap and the service unit, and retires the old SmolLM
service and weights; `scripts/install.mjs` runs it on Linux x86-64 unless
`--skip-local-lm`.

Measured on real harness decisions (2026-09-25, four threads): skill-hint
relevance AUC 0.88, and against the served model 0.88 accuracy with no off-topic hint kept at P(relevant) 0.70, against 0.53 for
SmolLM2-135M, 0.47 for LFM2.5-350M and 0.85 for the slower LFM2.5-1.2B; p50
about 0.9 s per judgement. On a test log it selected exactly the failing
test's lines. These are small fixtures, not production accuracy.

The model never writes prose that reaches the main agent. It answers bounded
yes/no questions with a calibrated probability (P(yes) from the first token of
a few-shot prompt) and proposes source line ids. One request runs at a time;
bursts beyond a small queue are refused as busy and three failures pause use
for a minute. `PI_LOCAL_LM=off` disables it; the tests run with it off.

- **Skill-hint gate.** "Session context" skill hints come from lexical overlap
  with the whole session. They must now contain a non-generic term and, when
  the model is ready, pass a relevance judgement for the current request. In a
  live music-blog session the lexical path had offered an ERP reference, a
  proxy-research pack and another company's brand kit. Judgements run in the
  background and the hint is delivered at the next boundary; without the model
  the lexical hint keeps its previous behavior. Each verdict is a visible
  `skill gate` line.
- **Mutation pre-screen.** Between Needle and Jev, the model may decide only
  the fail-safe "implementation" direction (P ≥ 0.5; on 12 real prompts every
  file-changing task scored ≥ 0.51 but one, every read-only one ≤ 0.42). The
  dangerous read-only rescue keeps Needle's strict bar, Jev and the arbiter.
- **Line selection.** Successful line-oriented output of 3–32 KiB can become a
  source-linked selection. The host reconstructs exact source text, keeps the
  original behind `obs_read`, and always retains boundary lines, task matches
  and every distinct status line (errors, warnings, totals), so status words no
  longer block eligibility. Stack traces, patches, credentials and
  instruction-like text stay excluded, as do failed commands, truncation and
  cancellation. The model sees up to 2 KiB of task-aware framing and whole
  lines; its ids must belong to that view. A first exposure waits about one
  inference (0.9 s, 1.8 s for 4–32 KiB windows) and is then sealed; the
  cooldown is eight seconds and ten-second leases bound the model fleet-wide.

### Local capability shortlists

Tool, command and skill discovery can use one local Qwen token to promote one
existing candidate from a three-entry shortlist. It never removes candidates,
creates tool names, authorizes a write or replaces correctness checks. Exact
names, shadow mode and cancelled work preserve their prior behavior. Acceptance
requires absolute token probability ≥ 0.85 and margin ≥ 0.50; weak/unknown answers
retain the existing Needle/Jev fallback. Requests share the local queue, a fixed
prefix checkpoint, total deadlines including queue time, and a bounded five-minute
cache of exact decisions. Waiting callers cancel promptly and honor the breaker
if earlier requests reveal an outage.

A 30-case local trial accepted 6/22 discovery cases, all six correct; ambiguous
and irrelevant requests abstained. The eight review-focus cases yielded no useful
accepted choices, so review-focus routing was not enabled. This is conservative
advisory coverage on a small fixture, not a general accuracy guarantee. Reproduce
with `node scripts/benchmark-local-choices.mjs --live`.

## Kompress — extractive prose selection

Kompress selects complete paragraphs from bounded successful documentation
and command output. Soft line wrapping stays inside the original paragraph
span. The host and worker protect the same decisions, test status, constraints,
paths and quantities. Unknown-price providers can use the context-saving floor;
low-value reductions still abstain. The current observation owner covers bash
and documentation reads; routing flags alone do not demonstrate execution in
web, review or council flows. Cold requests can time out and retain raw text.

Eligibility covers ordinary Markdown: headings, lists, tables, quotes, front
matter, link rows, HTML lines and lead-ins ending in a colon are structural
paragraphs that are always kept, so only prose paragraphs can be omitted, and
printable Unicode (curly quotes, dashes, accents) is accepted while control,
bidi, zero-width and unpaired surrogate characters are not. The client and the
worker apply one gate (`miniSource` and `paragraph_source`), with a test that
runs the same fixtures through both; ASCII word boundaries on both sides keep
their protected sets identical. Sources with more whitespace-separated words
than the 512-token window can hold are not offered. The worker spends its
ten-second inference slot only when inference runs: shape, size and
token-window refusals are answered at once with `X-Kompress-Inference: 0`,
after which the client needs no cooldown, and the slot is released before the
response is written so an immediate next request is not refused as busy.

Measured on this repository's 253 Markdown files of 800–4,096 characters: the
previous gate admitted none (146 failed the prose-shape rule, 79 contained
non-ASCII text, 28 had code fences); the current gate admits 192. None of them
passes the savings admission, because the protected-evidence rule keeps nearly
every prose paragraph that mentions a number, path, negation or status. The
observation owner therefore routes output to Kompress only when a selection
could pay for itself (`miniAdmissible`, the same test `select` applies);
Kompress-shaped output it cannot shorten stays available to the local LM and Jev,
where previously any Kompress-shaped output ended routing.

## Council and recovery consumers

The automatic scope council starts one local Needle perspective ranking alongside
its two required independent peers. At critique time it may add already-settled,
recognized perspective descriptions with score at least 0.90 and margin at least
0.025. Slow, shadow, malformed and weak results add nothing. This introduces no
remote judgment or extra wait; it does not replace either peer, discard evidence,
limit required reviews or approve a result. Accepted metrics count hints actually
included. This wiring is regression-tested with injected ranks; live improvement
in council judgment quality has not been established.

Recovery skill ranking checks that subagents and multiple applicable installed
skills exist before asking Jev. Missing catalog entries never consume ranking
slots. Finding clustering and duplicate judgment are now connected to
production review flows through provenance-preserving consolidation (see
"Finding consolidation" below): multi-aspect quality-review blockers merge
with per-id method/source provenance, and Observer margin notes fold
paraphrase duplicates into the confirmed note. Guardian intervention
deduplication stays in the owned core (existing suppression windows);
agent-side Guardian changes would cross the core ownership boundary, so
repeated-behavior coverage there rides the Span advisories plus those
windows rather than a new dedup call.

Project graph retrieval retains its literal identity, lexical and statistical
ranking. Markdown memory search retains its existing qmd owner. The project SQLite
vector-memory system separately supports compatible Needle3/OpenRouter embeddings;
see [Project Vector Memory](VECTOR-MEMORY.md). Compaction keeps native summary and keep-boundary
ownership; helper salience is advisory and must not silently discard history.

## Jev / Kev — remote typed semantic judges

The Jev layer balances uncached traffic between Jev on OpenRouter and
`jaredpalmer/kev-4b` on OpenRouter. Equal-load healthy routes alternate; concurrent
requests favor the less occupied route. Transport errors, timeouts, malformed
answers, 429 and 5xx cool the failing family and use the other within one deadline.
Jev model aliases remain an internal fallback within the Jev family. Shared account
errors stop further paid attempts. Cache hits retain their actual model attribution,
and health exposes both routes. `PI_JEV=off` disables both.

The pair validates what local layers cannot decide: ranking disagreements,
uncertain classifications, advisory batches (request kind, verification
need, review worth, council perspectives), and error-cause refinement.
The finding-duplicate judgment now serves bounded disambiguation inside
finding consolidation (ambiguous mid-overlap pairs only, at most a few
per consolidation). Related judgments batch into one call;
identical judgments reuse the bounded process cache; simultaneous uncancelled
identical requests share one paid call. Caller mutation cannot alter cached
answers. The circuit breaker preserves heuristic fallback. New sites: `rank` (validation),
`request-advisory`, `intent`, `finding-duplicate`, `classify`, and
`skill-discovery`. Skill discovery asks one typed choice/existence batch before
launching a general-model advisor. It sends the evidence section of the brief,
not its embedded catalog copy; a catalog over the 32 KiB budget is shortlisted
by lexical overlap. Valid catalog choices or clear no-fit judgments over the
complete catalog avoid that launch; a no-fit over a shortlist, and uncertainty,
keep the bounded original fallback.

Preferred working routes and exact-input cache hits avoid model-catalog discovery.
Only model rejections trigger catalog fallback. Cancelled, malformed and over-budget
inputs stop before another judgment; the serialized state/question budget is 32 KiB.

Jev evidence selection preserves protected chunks independently of scores,
rejects sources exceeding the complete-input budget, and cannot truncate kept
facts to meet an output cap. The relevance question carries the current task
terms. Terminal (`bash`) output protects chunks with outcome signals (errors,
failures, warnings, exit status, summaries, totals); other tools keep the broad
protection, under which any digit or path marks a chunk as required. The next
provider request normally follows a tool result within milliseconds, before a
~0.6 s answer, so the context boundary waits at most 1.5 s, once, for a pending
selection whose result has not been rendered yet. Sealed renders never wait (an
earlier version waited up to 2 s on every pass; its removal left paid
selections unused). A raw first exposure remains sealed. A clipped Needle prefix cannot rescue a mutation request as read-only;
Jev receives the complete bounded task before that judgment.

## Span — soft behavior sensor (shadow-first)

Span scores a fixed twelve-signal behavior catalog (repeated-failure
loops, scope drift, ignored requirements, premature completion,
verification gaps, stale evidence, redundant verification,
capability/tool misuse, unnecessary delegation, review churn,
unproductive progress, unsafe assumptions) against a bounded trace of
recent session events. Each signal resolves to
present/absent/not-observable probabilities. Span is strictly a soft
semantic sensor: it never mutates, blocks, settles, or grants anything.

The session bridge records tool names and outcomes only — never tool
arguments, result content, prompts, or file bytes — so no secrets can
reach the remote scorer through the trace. Scoring runs at most once
per turn end and at most every 30 seconds; unchanged traces reuse the
fingerprint-cached score instead of rescoring.

Scores reach Guardian, Observer, Watchmaker, quality and recovery logic
only through `spanAdvisory`, which requires P(present) ≥ 0.80 AND
deterministic corroborating evidence per signal. Anything weaker, and
everything while `PI_SPAN_SHADOW=1` (the default), is record-only:
measured in metrics, ledgered for cost, and benchmarked, but never
acted on. Intervention requires shadow benchmarks on real and synthetic
traces first.

Transport is OpenRouter chat completions, default route
`respan/span-01-lite` with paid `respan/span-01` fallback when the Lite
route itself is missing (never on auth, quota, timeout, or malformed
answers). Slugs are configuration resolved against the live registry;
an unlisted slug degrades to `route-unavailable`, never to an invented
model. Every paid call is ledgered as `span-usage-v1` (same contract
as `jev-usage-v1`) and surfaces in `micro_status`, `/metrics`,
`/used`, export analytics, and concise TUI activity. `PI_SPAN=off`
disables the sensor.

## Typed Jev decisions

`agent/extensions/lib/micro-intelligence/jev-decisions.ts` names every
production Jev/Kev decision type, its question builder, and its
calibrated acceptance bars in one registry so call sites cannot drift
into ad-hoc thresholds: requirement-to-evidence closure, final-answer
claim/evidence verification, high-blast-radius tool-intent alignment,
Observer/Watchmaker admission and focus, quality-review aspect
selection (add-only: Jev may suggest aspects, never remove the
deterministic set), memory classification/admission, delegation
topology, recovery strategy, verification method, evidence relevance,
and shortlist-based tool/skill routing.

Deterministic code still owns permissions, safety, completion, and
final decisions; a typed decision only refines an ambiguous choice the
owner framed, and every verdict degrades to unknown (caller keeps its
heuristic). New production uses start in shadow mode — judged,
measured, and agreement-recorded via `ml.jev.shadow` health events, but
never applied — until calibration evidence justifies influence.
Currently shadow-wired: requirement closure at ledger settle time,
review aspects per review round, and recovery strategy per recovery
episode. The remaining registry entries are defined, barred, and
tested, with production call sites staged behind the same shadow
evidence bar.

## Finding consolidation

`consolidateFindings` merges semantically duplicate findings with
provenance instead of generating repeated repair churn. Deterministic
Jaccard (≥ 0.6) and Needle clustering merge first; ambiguous
mid-overlap pairs (0.3–0.6) earn a bounded number of Jev duplicate
judgments. Nothing is dropped, only grouped: each group names its kept
representative, merged ids with the per-id method
(jaccard/needle/jev), and reviewer/aspect sources.

Production wiring: quality-review consolidates multi-aspect blocking
findings after each round (deterministic pass always; Needle/Jev
passes via injected deps), exposes groups in the review summary, and
lets one evidence-based dismissal of a group representative cover its
merged duplicates. Observer margin notes keep their deterministic
match at add time plus a Needle-only paraphrase pass that folds a new
lookalike into the confirmed note (failure keeps both).

## Micro-worker — bounded cheap-remote helper

The micro-worker role sits between Jev and a full subagent for tasks
too generative for typed judgments but too small for delegation:
error-hypothesis generation, finding consolidation, handoff briefs,
structured extraction, inspection-target proposals, patch comparison,
and small source glances. Hard bounds: no recursive delegation, zero
tools, no writes, validated JSON outputs, ≤ 8,000 input characters,
≤ 1,000 output tokens, per-call cost cap, and result caching.

Routes are never hardcoded as available. Candidates come from
`PI_MICRO_WORKER_ROUTES`, and eligibility gates price, quality
evidence, health/cooldowns, AND provider privacy tier: `route-privacy`
classifies loopback providers as local, operator-allowlisted routes
(`PI_PRIVATE_ROUTES`) as allowed, and everything else as unknown —
and unknown is never safe for private repository content. "Free" never
implies safe. Without evidence the worker abstains rather than
guessing on a random cheap route.

## Remote rerank — opt-in precision stage

Local Needle3 ranking stays the zero-cost default in every retrieval
pipeline. `remoteRanker` adds an optional precision stage after
lexical/vector retrieval and before final context selection for
project memory, historical/session retrieval, Observer evidence,
source relevance, skills, and docs. It speaks the Voyage rerank API
shape against a configurable endpoint (`PI_RERANK_URL`, default the
Voyage API; OpenRouter exposes no `/v1/rerank`), so Voyage rerank
variants — or any compatible proxy — can be benchmarked without
hardcoded assumptions. Unconfigured, unreachable, or low-value
reranking returns undefined and the caller keeps its local order.
`PI_RERANK=off` is the default; `PI_RERANK_MODEL` selects the model.

## Router shadow and qualification lab

The TypeSafe Jev Router integration is shadow advisory only: the
router suggests a model/reasoning-effort pair, YunusPi records that
suggestion alongside its own capability-, benchmark-, health-,
privacy-, cost-, restriction-, reliability- and cache-aware choice
plus the actual outcome (success, latency, cost, retries, review
outcome). The suggestion never influences routing and never bypasses
restrictions; promotion into routing influence requires accumulated
shadow evidence plus an explicit operator change. Router slugs are
discovered from live model ids (configurable), never assumed.

The model qualification lab (`model-qual-lab.ts`,
`agent/scripts/run-model-qual-lab.mjs --live --route p/m`) runs a
bounded fixed battery over newly discovered routes — tool selection,
structured output, small coding/debugging, repository navigation,
instruction fidelity, requirement extraction, review quality,
long-context retrieval, tool-call validity, plus measured
latency/tokens/cost/reliability and privacy metadata — and records
expiring (7-day) role-specific eligibility (`micro-worker`,
`skill-router`, `coding-child`, `observer`, `quality-reviewer`,
`main-fallback`) in a private store. The lab records evidence; it
never promotes a route by itself.

Whether code-specific embeddings (e.g. Voyage Code) beat Qwen3 plus
project intelligence for issue→file retrieval is an open measurement,
not an assumption: `agent/scripts/benchmark-code-embeddings.mjs`
compares lexical, Qwen3, and a configured code candidate on the
synthetic fixture. A separate code embedding space ships only if
measured gains justify the extra index and complexity.

## Coordination, metrics, health

`agent/extensions/lib/micro-intelligence/` holds routing, evidence preparation
and unified metrics. Needle, the local LM, Kompress, Jev, Span, the
micro-worker and remote rerank retain their own bounded
caches and lifecycle controls. The unused duplicate coordinator and its
always-empty ledger were removed; production helper metrics remain authoritative.

- `micro_status` (read-only tool) reports request classification, the
  advisory verdict, per-layer health and utilization, including the
  Span, micro-worker, and rerank layers and the live Span trace state.
- Health vocabulary: `ready / warming / unavailable / disabled / busy /
  breaker-open / no-key`.
- Metrics count actual offers, runs, accepts, cache hits, skip reasons, and
  latencies per layer, plus Jev questions/tokens/spend by site and
  full-LLM micro-calls avoided (estimates are labeled as estimates). The line
  selector and Kompress owners report execution separately from candidate routing. Projected
  savings remain distinct from newly sealed provider reductions; replaying a
  seal does not manufacture another reduction. A typed skill selection counts
  one avoided dispatch, with no invented token estimate.
- Span ledgering (`span-usage-v1`) feeds `/metrics` (scored traces,
  shadow/cached splits, above-bar readings, tokens, reported cost) and
  export analytics (`microIntel.span`); `/used` tracks the Span sensor,
  Micro worker, and Remote rerank components like any other helper.
- Skip reasons (`too-small`, `busy`, `low-confidence`, `cooldown`,
  `deterministic-won`, `shadow`, `route-unavailable`, `no-scorer`,
  `private-input-unsafe-route`, …) explain dormancy instead of hiding it.

## Request lifecycle

```text
before_agent_start → deterministic pass (terms, intent cues, request family)
                   → ONE Jev advisory batch (async)
tool_search and    → deterministic eligibility → lexical order
skill_review search → Needle head-slice rank (accepted, else fused with
                     lexical) → Jev on uncertainty/disagreement
tool_result        → deterministic distiller first (its win ends routing)
                   → local LM (structured lines) / Kompress (prose) / Jev triage
failure            → deterministic rules → Jev validation
spawn guard        → Needle → local LM (fail-safe side only) → Jev pre-screen
                     → full arbiter only on defer
skill hints        → lexical rank → generic-term filter → local LM relevance
```

Controls: `PI_NEEDLE=off`, `PI_NEEDLE_SHADOW=1`,
`PI_MICRO_ADVISORY=off`, `PI_INTENT_PRESCREEN=off`,
`PI_MICRO_INTELLIGENCE=off`, `PI_SPAN=off`, `PI_SPAN_SHADOW=0` (leaves
shadow record-only mode; benchmarks must justify this first),
`PI_SPAN_MODEL` / `PI_SPAN_FALLBACK`, `PI_MICRO_WORKER=off`,
`PI_MICRO_WORKER_ROUTES`, `PI_PRIVATE_ROUTES`, `PI_RERANK=on`,
`PI_RERANK_MODEL` / `PI_RERANK_URL`, `PI_OBSERVER_SEMANTIC_MARGINS=off`,
plus the existing `PI_MINI_PREPROCESSOR`,
`PI_SMOL_PREPROCESSOR` (line selection), `PI_LOCAL_LM` (the whole local
model), `PI_SKILL_GATE`, `PI_JEV`, and `PI_OUTPUT_DISTILLER` scopes.

Jev trims oversized evidence instead of refusing it: the longest text fields
lose their middle, with an explicit omission marker, until the request fits
its 32 KiB input budget (health logs showed every Jev refusal was an input
budget refusal). Callers name decisive fields that must never be trimmed
(`protect`: the verify claim, distill task/tool); when nothing trimmable
remains, the call abstains with input-budget instead of judging damaged
evidence. Oversized questions still refuse before any request, and the
caller site is now recorded with each skip.

Jev cost accounting prefers provider-reported usage, then the documented Jev
family input price, and otherwise reports unknown: Kev and discovered alias
routes never borrow Jev's price, and /cost marks totals with unpriced
judgments unknown rather than adding invented dollars.

## Calibration evidence (2026-09-19)

Committed fixtures live in `tests/fixtures/micro-intel/`; run
`node --test tests/micro-intel-bench.test.mjs` (Needle sections need
installed assets, otherwise they skip with a note). New-layer fixtures
(`traces.json`, `code-retrieval.json`) back the offline benchmark
scripts: `agent/scripts/benchmark-span-sensor.mjs` (pipeline and
keyword baseline; `--live` for the real Span route),
`agent/scripts/benchmark-code-embeddings.mjs` (`--live` for Qwen3 and
an optional `PI_CODE_EMBED_MODEL` candidate),
`agent/scripts/benchmark-rerank.mjs` (lexical vs Needle vs a
`PI_RERANK_MODEL` remote variant), and
`agent/scripts/run-model-qual-lab.mjs --live --route p/m` for role
eligibility. New-layer unit coverage lives in
`tests/micro-intel-span.test.mjs`,
`tests/micro-intel-decisions.test.mjs`,
`tests/micro-intel-microworker.test.mjs`,
`tests/micro-intel-rerank-router-lab.test.mjs`,
`tests/micro-intel-consolidation.test.mjs`, and
`tests/micro-intel-observability.test.mjs`.

| Benchmark | Result |
| --- | --- |
| Lexical routing, easy set | 5/6 top-1 (floor holds) |
| Lexical zero-overlap paraphrase | 3/6 score nothing (need documented) |
| Needle routing, paraphrase set | 4/6 top-1; **0/6 accepted**, 0 accepted-wrong |
| Escalation/application contract | 6/6 with a fixture-perfect **mock judge**; no live Jev accuracy measured |
| Needle intent pre-screen | 4/8 decided, 4/4 correct (rest defer) |
| Deterministic error families | 6/6 |
| Needle rank p50 (3 short candidates) | 379–401ms across independent reruns; machine/workload dependent |
| Mixed concurrent real WASM workload | 12/12 served, 0 timeouts/restarts; 1.16s cold startup, 592ms workload; execution p50 1ms, p95 423ms |
| Mixed workload memory and responsiveness | 117–141 MiB process RSS increase across runs; the main event loop remained responsive |
| Grammar extraction | 2.52s on a synthetic address; correct city but street included the city at engine confidence 1 |

Extraction confidence does not establish field correctness; consumers must
validate both schema and source grounding before using fields.

These are small synthetic fixtures, not production accuracy or measured
paid-model savings. The zero accepted paraphrase results mean this run
demonstrates advisory ranking and escalation, not local routing-call
avoidance. Earlier live Jev claims were not independently reproduced.
The benchmark keeps the existing thresholds: lowering them to manufacture
utilization would admit known ranking mistakes. Shadow and rejection runs
are counted separately from accepted results. Re-calibrate with a larger
held-out, deployment-specific set before changing acceptance floors.

## Independent context probe (2026-09-19)

The synthetic coding-session test now executes the real line-selector and Kompress
clients, source validators and projections with mocked transport, instead of
counting routing flags as inference. Adversarial fixtures cover distinct
status facts, middle-of-source constraints, malformed judgments, source hashes,
shadow results and mutation instructions after a truncation boundary.

A separate authorized live probe used synthetic evidence only. Warm Kompress
selected 1,792 characters into a 361-character projection in 301 ms, retaining
the blocked verification status. Its first cold call timed out at 455 ms.
Jev answered a synthetic false-verification question with `noul=0.02` in
618–1,085 ms; the client estimated 44 input tokens per call. SmolLM2's first call
hit its five-second deadline. An 82-line listing exposed prompt overhead: JSON
line objects exceeded the service budget; tuples used 2,036 prompt/cache tokens
and truncated the reply. Numbered verbatim lines reduced that to 1,792 tokens;
the warm service returned a complete `UNKNOWN` in 1,553 ms. The host safely
retained the original, and now reports that specific abstention reason. These are small operational probes, not
production utilization, accepted SmolLM2 evidence reduction, or measured paid
main-model savings. Conservative abstentions remain visible rather than being
counted as successes.

## Audit evidence and owned core identity

[Needle audit measurements](NEEDLE-AUDIT.md) record reproducible fixtures, observed
failures, latency and the limits of these small evaluations. Mock judge tests
verify contracts rather than model accuracy or paid-call savings.

`micro_status.core` reads the actually resolved owned package identity: core
version, immutable origin, source commit and source digest. Missing or mismatched
identity is reported as unavailable/mismatch. This read-only inspection performs
no inference and does not infer ownership from a display name.

The independent audit also removed a Jev emergency-compaction override that
dropped unselected middle messages and clipped retained facts. The remaining
remote audit plan had no consumer, so that call was removed as well. Normal
compaction and explicit overflow recovery retain authoritative history without
that unnecessary remote latency or spend. See [CONTEXT-AUDIT.md](CONTEXT-AUDIT.md).
