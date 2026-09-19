# Needle audit evidence — 2026-09-19

The audited baseline was main commit
`f01b66accab161b24eea114fe180ce1b4d3f014c`. Measurements below were collected
on the corrected working tree with Node 22.22.3 on Linux x86_64. They describe
small public synthetic fixtures, not production workload quality or a release
commit. No private prompts, memory, credentials or model files are included.

The engine was the official Node/Emscripten WASM distribution, generation 3,
embedding dimension 3072, pinned asset revision
`b009f8937124b2d0458f4ed040c10c41fd2a0dfc`. Loader, WASM, weights and license
hashes are defined in `agent/extensions/lib/needle-assets.mjs`; worker startup
verifies them before evaluating the loader. Official references:
[Needle source and API](https://github.com/cactus-compute/needle),
[platform guidance](https://cactuscompute.com/blog/needle-supported-devices),
[pinned model artifact](https://huggingface.co/Cactus-Compute/needle3/tree/b009f8937124b2d0458f4ed040c10c41fd2a0dfc).

## Reproduce

From the repository root, point `PI_NEEDLE_ASSETS` at an existing verified
installation. Leave it unset to use the normal agent asset directory. The
following checks use assets read-only and never download weights. Asset tests
use isolated temporary fixtures. A clean checkout skips the explicitly marked
live sections when assets are absent; a passing skipped run is not inference
validation.

```sh
node agent/extensions/lib/needle-assets.mjs verify
node --experimental-strip-types --test tests/needle-runtime.test.mjs tests/needle-assets.test.mjs tests/micro-intelligence.test.mjs tests/micro-intel-bench.test.mjs
node --experimental-strip-types --test tests/adaptive-recovery.test.mjs tests/scope-council-runner.test.mjs
```

Routing and intent fixtures live in `tests/fixtures/micro-intel/`. The mixed
workload, extraction and host-exit cases are defined in
`tests/needle-runtime.test.mjs`. Tests print current measurements; timings vary
with host load and startup/cache state. Execution quantiles omit queue wait;
the routing benchmark measures caller elapsed time. The host-exit test requires
an environment that permits child process execution and output capture.

## Observed results

| Check | Observation | Interpretation |
| --- | --- | --- |
| Six paraphrase rankings | 4/6 top-1; 0/6 passed score 0.93 and margin 0.02; no accepted wrong result; elapsed p50 379–401 ms | Conservative abstention, not demonstrated semantic routing benefit on this set |
| Two ranking misses | “mend the broken login check” selected `bash` rather than `edit`; “peruse the settings document” selected `bash` rather than `read` | Preserve lexical/Jev fallback; cosine is not correctness |
| Eight intent fixtures | 4/8 decisions at the asymmetric per-label bars, all four correct | Small calibration sample; not general accuracy |
| Twelve mixed concurrent operations | 12/12 served; cold 1.16–1.21 s, workload 0.59–0.62 s; execution p50 1 ms, p95 423–432 ms; 172–180 main-loop timer ticks; RSS delta 117–141 MiB | Serial WASM work stayed off the main thread; repeated texts benefited from caches |
| Host lifecycle | Real singleton child exited without explicit shutdown in about 1.5 s | An idle worker no longer retains a CLI/test process |
| Address extraction | About 2.52 s; city `Boston`; street `42 Pine Street in Boston`; confidence 1 | Structured output was valid, but the street field was semantically wrong despite maximum confidence |

The extraction fixture previously hit the default 1.5-second embedding-oriented
budget and restarted the worker. Grammar decoding now receives the bounded
execution ceiling (8 seconds by default). This fixes availability, not model
correctness. No production extraction caller was found during this audit.

The benchmark's 6/6 judge-assisted retrieval case uses a mocked oracle returning
the expected answer. It verifies escalation and application contracts. It is
not live Jev accuracy, blended model accuracy, avoided paid calls, or savings.

## Corrected runtime and consumer contracts

The audit reproduced and tested initialization-error recovery, serial admission,
queue expiry, synchronous inference timeouts, terminal shutdown, idle worker
lifecycle, caller-owned cache vectors, finite/dimension-correct embeddings,
candidate identity and score validation, and top-K-independent ranking margins.
Worker cache capacity zero now disables caching. Same-size asset corruption is
repaired; executable assets are verified before load; resumable downloads validate
ranges and discard poisoned partials under bounded attempts and deadlines.

Shadow results cannot reorder retrieval, suppress baseline Jev eligibility,
change observation cues or reach council critique. Accepted semantic disagreement
can still be checked by the configured Jev judge; weak top-result agreement does
not reorder the remaining candidates. Recovery skill ranking skips unavailable
subagents and uninstalled candidates before optional remote work.

The scope council now overlaps local perspective ranking with its mandatory peer
wave and can add a validated, already-ready focus hint to critique. Tests prove
that slow/shadow hints add no wait or evidence changes, both peer roles remain,
and unknown or weak choices are rejected. This is advisory preparation, not a
measured improvement in council outcomes. Production finding deduplication remains
absent: the clustering and duplicate helpers have only test callers. Project graph
retrieval still uses its deterministic/statistical owner; memory search still uses
qmd. Their presence is not evidence that Needle ran.

Native Needle binaries, live Jev service quality, paid-provider savings and
cross-platform behavior were not benchmarked. The small fixtures cannot establish
production reliability or justify looser confidence bars. Compaction and evidence
selection must retain deterministic protection and raw/native recovery paths.
