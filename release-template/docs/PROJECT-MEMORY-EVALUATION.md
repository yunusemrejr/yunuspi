# Project-memory and small-model evaluation — 0.10.0

Measured on Linux with the installed Needle3 and Qwen3.5-0.8B runtimes,
and live OpenRouter `qwen/qwen3-embedding-8b`, on 2026-09-25. The corpus is
24 synthetic, public YunusPi memories: decisions, corrections, regressions,
conventions, subsystem relationships and unfinished work. No production
memory or private transcript was uploaded for this evaluation.

Run the same experiment with:

```sh
node scripts/benchmark-project-memory.mjs --live > memory-report.json
node scripts/benchmark-local-choices.mjs --live > local-report.json
```

The checked-in fixtures live under `tests/fixtures/project-memory/` and
`tests/fixtures/micro-intel/`. The memory experiment creates temporary SQLite
indexes, applies the same lexical pipeline and role policies in all modes,
and disables optional reranking to isolate embeddings. Its 32 queries include
6 exact technical lookups, 18 paraphrases, 4 Turkish queries and 4 unrelated
questions. Twenty-eight queries have a labelled relevant memory.

## Retrieval quality and cost

| Metric | A: FTS5 | B: FTS5 + Needle3 | C: FTS5 + Qwen3 |
|---|---:|---:|---:|
| Relevant memory ranked first | 11/28 | 11/28 | 24/28 |
| Relevant memory in top three | 15/28 | 18/28 | 27/28 |
| Mean reciprocal rank, top five | 0.505 | 0.514 | 0.918 |
| Exact identifier queries ranked first | 6/6 | 6/6 | 6/6 |
| Irrelevant top-three slot occupancy | 50.0% | 69.8% | 44.8% |
| Query latency, median / p95 | 1 / 1 ms | 193 / 446 ms | 690 / 1,806 ms |
| Embedding 24 memories | — | 10.37 s | 2.66 s |
| Observed vector dimension | — | 3,072 | 4,096 |
| Remote embedding requests | 0 | 0 | 28 |
| Reported input tokens | — | — | 1,866 |
| Reported embedding cost | $0 | $0 | $0.00001866 |

Recall and reciprocal rank use only answerable queries. Slot occupancy counts
irrelevant returned hits divided by three times all query count; missing slots
are empty, not false matches. It is not precision or a calibrated probability.
Indexing latency measures embedding/backfill after lexical insertion, excluding
runtime startup. Latency is a single laptop/provider observation, not an SLA.

The healthy configuration rows above come from two final runs at 18:42 and
18:43 UTC, using the same fixture and retrieval code. In the first run Needle3
timed out during indexing under concurrent local inference, while Qwen3 was
healthy. In the second run Needle3 was healthy and OpenRouter's first batch hit
the eight-second deadline. These failed runs are part of the degradation result,
not healthy semantic measurements: each affected mode returned the same lexical
ranking as A, retained every memory, and avoided further embedding calls during
that evaluation. No timeout budget was increased to obtain a successful score.

Qwen's 28 requests were two indexing batches (16 + 8 texts) and 26 queries.
All six exact lookups skipped embedding and reranking. Repeated identical
queries, compatible unchanged file content, consolidation and status produce
no additional remote embeddings; these properties have separate behavioral
tests. The [OpenRouter embedding catalog](https://openrouter.ai/api/v1/embeddings/models)
reported $0.01 per million input tokens during the run, giving the same
$0.00001866 estimate as provider-reported usage. Failed or cancelled requests
with no usage response have unknown billing; zero recorded usage is not proof
that the provider charged nothing.

## Calibration and limits

The development split contains 26 queries. Six additional queries, including
one unrelated question, were added after selecting Qwen's conservative semantic
floor, best-score band and RRF weight. On the five answerable held-out queries,
top-three recall was A: 2/5, B: 3/5, C: 5/5; Qwen ranked three first. This is a
small regression set, not evidence of general superiority across repositories.

Qwen uses its [documented query instruction format](https://huggingface.co/Qwen/Qwen3-Embedding-8B).
The retrieval adapter retains scores at least 0.42, within 0.08 of the strongest
candidate, capped at eight, and gives that shortlist a 1.5 RRF contribution.
The existing Needle score scale and role/type/importance weights remain intact.
Literal technical lookups bypass this semantic branch. There was no model
training, production-memory tuning or held-out threshold search.

Qwen admitted no semantic candidates for the four unrelated questions; Needle
admitted candidates for all four on this corpus. A broad lexical match on
“project” still returned unrelated evidence for the revenue question in all
modes. Qwen also placed the intended Watchmaker memory fifth on one paraphrase,
partly due to existing type weights. Results remain cited historical evidence
requiring source verification. Embeddings do not establish truth, replace
AST/LSP navigation, or justify weakening lexical retrieval.

## Degradation and orchestration checks

Injected transport tests cover missing keys, 401/404/429/503, retry cooldown,
network failure, malformed/empty/partial responses, non-finite and zero vectors,
dimension/model mismatch, cancellation and timeout. Storage tests cover legacy
schema migration, distinct spaces with equal dimensions, compatible-only family
retrieval, model changes, content-hash reuse, resumable interrupted backfill,
secret-path exclusion and concurrent content changes. Session tests exercise
main/subagent priming, observer/Watchmaker evidence, shared query work, batched
events, ownership on project switches, status and auxiliary usage receipts.

## Local Qwen and Jev/Kev

The live local chooser evaluation had 22 discovery cases and eight exploratory
review-focus cases. At probability >= 0.85 and margin >= 0.50 it accepted six
discovery choices, all correct, and abstained on all six negative/ambiguous
discovery cases. Warm discovery median was 339 ms; the first request was 988 ms.
All review-focus cases abstained, so review-focus routing was not enabled.
Local advice only promotes an existing shortlist member; it cannot remove
candidates, authorize actions or suppress a required review.

Both Jev and `jaredpalmer/kev-4b` returned valid typed answers through OpenRouter
in live route probes. A temporary Kev failure also exercised actual failover to
Jev. Deterministic tests cover healthy alternating traffic, concurrent load,
both failover directions, cancellation, cooldown and the shared deadline.
These probes establish route operation, not equal judgment quality on all tasks.
