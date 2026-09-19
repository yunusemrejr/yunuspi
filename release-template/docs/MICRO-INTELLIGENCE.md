# Micro-intelligence architecture

YunusPi layers five kinds of intelligence so the main model spends its
reasoning on work that actually requires it:

```text
DETERMINISTIC HARNESS LOGIC        cheap, auditable, authoritative
        ↓
NEEDLE3                            local semantic reflex (this machine)
        ↓
SMOL                               speculative structured line selection
        ↓
KOMPRESS                           extractive prose paragraph selection
        ↓
JEV                                cheap remote typed semantic judgment
        ↓
MAIN / CHILD LLM / COUNCIL         deep reasoning, synthesis, judgment
```

This is not a serial pipeline. Every job invokes the combination its
content shape and uncertainty warrant, usually in parallel with the main
model's own latency. Cheap layers propose; deterministic owners dispose;
nothing below the main model establishes truth, authorization, completion,
test success, or permission.

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

## Smol — speculative structured selection

SmolLM2 proposes source-linked line selections for successful line-oriented
output. The host reconstructs exact source text and keeps the original behind
`obs_read`. It retains every distinct protected fact, boundary and task match;
only identical repeated status facts can collapse. Plain inventory rows may be
background. Protected facts are collected across the complete source before
4–32 KiB windowing; unsafe or overly dense evidence falls back to raw. Windowed
results identify both the original source hash and the selected window hash.
Errors, instructions, secrets, cancellation and truncation are excluded.

## Kompress — extractive prose selection

Kompress selects complete paragraphs from bounded successful documentation
and command output. Soft line wrapping stays inside the original paragraph
span. The host and worker protect the same decisions, test status, constraints,
paths and quantities. Unknown-price providers can use the context-saving floor;
low-value reductions still abstain. The current observation owner covers bash
and documentation reads; routing flags alone do not demonstrate execution in
web, review or council flows. Cold requests can time out and retain raw text.

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
slots. The separate finding-clustering and duplicate-judgment primitives remain
unconnected to production review flows; their tests are not evidence of live
review deduplication.

Project graph retrieval retains its literal identity, lexical and statistical
ranking. Memory search retains its existing qmd keyword/semantic/hybrid owner;
these are not Needle integrations. Compaction keeps native summary and keep-boundary
ownership; helper salience is advisory and must not silently discard history.

## Jev — remote typed semantic judge

Jev validates what local layers cannot decide: ranking disagreements,
uncertain classifications, advisory batches (request kind, verification
need, review worth, council perspectives), and error-cause refinement. A
finding-duplicate helper is available but has no production caller. Related judgments batch into one call;
identical judgments reuse the bounded process cache; simultaneous uncancelled
identical requests share one paid call. Caller mutation cannot alter cached
answers. The circuit breaker preserves heuristic fallback. New sites: `rank` (validation),
`request-advisory`, `intent`, `finding-duplicate`, `classify`, and
`skill-discovery`. Skill discovery asks one typed choice/existence batch before
launching a general-model advisor. Valid catalog choices or clear no-fit
judgments avoid that launch; uncertainty keeps the bounded original fallback.

Jev evidence selection preserves protected chunks independently of scores,
rejects sources exceeding the complete-input budget, and cannot truncate kept
facts to meet an output cap. Ready results may apply at the context boundary;
a pending remote request adds no context wait. A raw first exposure remains
sealed. A clipped Needle prefix cannot rescue a mutation request as read-only;
Jev receives the complete bounded task before that judgment.

## Coordination, metrics, health

`agent/extensions/lib/micro-intelligence/` holds the lightweight
coordination layer: request dedup, bounded result caches, an opportunity
ledger, escalation chains, provenance, and unified metrics. Subsystem
owners keep their authority; the coordinator only stops repeated work.

- `micro_status` (read-only tool) reports request classification, the
  advisory verdict, per-layer health, utilization, and the ledger.
- Health vocabulary: `ready / warming / unavailable / disabled / busy /
  breaker-open / no-key`.
- Metrics count actual offers, runs, accepts, cache hits, skip reasons, and
  latencies per layer, plus Jev questions/tokens/spend by site and
  full-LLM micro-calls avoided (estimates are labeled as estimates). Smol and
  Kompress owners report execution separately from candidate routing. Projected
  savings remain distinct from newly sealed provider reductions; replaying a
  seal does not manufacture another reduction. A typed skill selection counts
  one avoided dispatch, with no invented token estimate.
- Skip reasons (`too-small`, `busy`, `low-confidence`, `cooldown`,
  `deterministic-won`, …) explain dormancy instead of hiding it.

## Request lifecycle

```text
before_agent_start → deterministic pass (terms, intent cues)
                   → Needle family classification (async, local)
                   → ONE Jev advisory batch (async, after Needle or 500ms)
tool_search        → deterministic eligibility → lexical order
                   → Needle head-slice rank → Jev on uncertainty/disagreement
tool_result        → deterministic distiller first (its win ends routing)
                   → Smol (structured) / Kompress (prose) / Needle cue / Jev triage
failure            → deterministic rules → Needle family cue → Jev validation
spawn guard        → Needle→Jev intent pre-screen → full arbiter only on defer
```

Controls: `PI_NEEDLE=off`, `PI_NEEDLE_SHADOW=1`,
`PI_MICRO_ADVISORY=off`, `PI_INTENT_PRESCREEN=off`,
`PI_MICRO_INTELLIGENCE=off`, plus the existing `PI_MINI_PREPROCESSOR`,
`PI_SMOL_PREPROCESSOR`, `PI_JEV`, and `PI_OUTPUT_DISTILLER` scopes.

## Calibration evidence (2026-09-19)

Committed fixtures live in `tests/fixtures/micro-intel/`; run
`node --test tests/micro-intel-bench.test.mjs` (Needle sections need
installed assets, otherwise they skip with a note).

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

The synthetic coding-session test now executes the real Smol and Kompress
clients, source validators and projections with mocked transport, instead of
counting routing flags as inference. Adversarial fixtures cover distinct
status facts, middle-of-source constraints, malformed judgments, source hashes,
shadow results and mutation instructions after a truncation boundary.

A separate authorized live probe used synthetic evidence only. Warm Kompress
selected 1,792 characters into a 361-character projection in 301 ms, retaining
the blocked verification status. Its first cold call timed out at 455 ms.
Jev answered a synthetic false-verification question with `noul=0.02` in
618–1,085 ms; the client estimated 44 input tokens per call. Smol's first call
hit its five-second deadline. An 82-line listing exposed prompt overhead: JSON
line objects exceeded the service budget; tuples used 2,036 prompt/cache tokens
and truncated the reply. Numbered verbatim lines reduced that to 1,792 tokens;
the warm service returned a complete `UNKNOWN` in 1,553 ms. The host safely
retained the original, and now reports that specific abstention reason. These are small operational probes, not
production utilization, accepted Smol evidence reduction, or measured paid
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
