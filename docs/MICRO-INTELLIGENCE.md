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

Needle3 (Cactus Compute, Apache-2.0) runs continuously on this machine as
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
- Safety: bounded queue, per-op input-scaled timeouts, main-side and
  worker-side embedding caches, crash recovery with a restart budget,
  cooldown with periodic re-probe, and graceful `unavailable` states. No
  Needle failure can break normal operation; every op degrades to a skip
  reason the caller already handles.
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
  while lexical order stays authoritative.

Assets (`needle.js`, `needle.wasm`, `needle3.cact`, upstream `LICENSE`)
are never committed. The installer fetches the pinned revision from the
official `Cactus-Compute/needle3` repository with SHA-256 verification
into an atomic stage directory, then swaps; interrupted downloads cannot
destroy working assets, and offline installs continue without local
semantics. Repair, verify, and smoke-test any time with:

```text
node <agent>/extensions/lib/needle-assets.mjs <verify|install|repair|smoke|status>
```

Telemetry is disabled (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`). No
prompt, file, or tool content leaves the machine for Needle.

## Smol — speculative structured selection

SmolLM2 proposes source-linked line selections for line-oriented output
(listings, logs, build output, status dumps) in the background; the
provider-visible projection is reconstructed verbatim from the source,
and the original stays behind `obs_read`. Measured finding: the old
block-level protection regex forced whole numeric listings into the
required set and abstained nearly every offer; retention is now
line-calibrated and frequency-capped (boundary + task + status/failure
representatives), tool eligibility covers `bash/read/grep/find/ls`, and
4–32 KiB outputs window to head + diagnostics + tail with original line
numbers. Lease contention and windowed takes are now visible in health.

## Kompress — extractive prose selection

Kompress selects source paragraphs for prose evidence (docs, reads,
research text, reports). The trained shape contract is enforced by the
server itself (multi-line or oversized inputs return `UNKNOWN`), so
expansion comes from more callers and better operations, not wider
shapes: session warmup removes the ~450ms cold-start from the critical
path, and timeouts are now counted apart from refusals.

## Jev — remote typed semantic judge

Jev validates what local layers cannot decide: ranking disagreements,
uncertain classifications, advisory batches (request kind, verification
need, review worth, council perspectives), error-cause refinement, and
finding-duplicate judgments. Related judgments batch into one call;
identical judgments reuse the persistent cache; the circuit breaker and
spend ledger behavior are unchanged. New sites: `rank` (validation),
`request-advisory`, `intent`, `finding-duplicate`, `classify`.

## Coordination, metrics, health

`agent/extensions/lib/micro-intelligence/` holds the lightweight
coordination layer: request dedup, bounded result caches, an opportunity
ledger, escalation chains, provenance, and unified metrics. Subsystem
owners keep their authority; the coordinator only stops repeated work.

- `micro_status` (read-only tool) reports request classification, the
  advisory verdict, per-layer health, utilization, and the ledger.
- Health vocabulary: `ready / warming / unavailable / disabled / busy /
  breaker-open / no-key`.
- Metrics count offers, runs, accepts, cache hits, skip reasons, and
  latencies per layer, plus Jev questions/tokens/spend by site and
  full-LLM micro-calls avoided (estimates are labeled as estimates).
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
| Needle routing, paraphrase set | 4/6 top-1, 0 accepted-wrong (bars hold) |
| Blended system (needle + judge) | 6/6 (escalation rescues every miss) |
| Needle intent pre-screen | 4/8 decided, 4/4 correct (rest defer) |
| Jev intent judgments | 7/8 decided, 7/7 correct |
| Jev routing judgments | 5/6 (one transient network skip), all served correct |
| Deterministic error families | 6/6 |
| Needle rank p50 (3 short candidates) | ~364ms; per-char ~3.5ms warm |

Bars decide only clear cases; everything uncertain escalates. Keep them
honest with shadow agreement rates and the skip-reason ledger, and
re-calibrate from production data before loosening anything.
