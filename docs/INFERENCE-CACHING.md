# Inference reuse and provider caches

YunusPi keeps repeated work out of inference where it can and reports provider
cache usage separately from local answer reuse. A cache hit is evidence about
input processing, not verification that an answer is correct.

## Codex account discovery

The account catalog uses the reviewed Codex catalog protocol version 0.159.2.
Older versions can hide newly introduced models even for an entitled account.
Updating the protocol forces one refresh of a fresh older cache and drops its
conditional ETag; offline startup can still use the same account's saved rows.
Model IDs, visibility, context windows and reasoning levels come from that
account's response. Unknown prices and output limits remain explicitly unknown
or estimated. The harness does not invent access based on an API model list.

`ultra` is available only when a selected model explicitly maps that level.
The CLI, reasoning menus, saved sessions, custom model maps and child routing
preserve it. Models that do not advertise it clamp to a supported level.
Discovery alone does not establish successful inference or output quality.

## Provider cache behavior

Restoring or selecting the same active tool set preserves a canonical tool
order, including system-prompt snippets. Duplicate names do not duplicate
schemas. Real changes in tools, instructions, history, compaction or model can
still change the prefix. Dynamic evidence must retain its provenance and cannot
be frozen merely to raise a cache-hit percentage.

| Provider response | Recorded usage |
| --- | --- |
| OpenAI, GLM, Qwen `prompt_tokens_details.cached_tokens` | Cache reads |
| Qwen `prompt_tokens_details.cache_creation_input_tokens` | Cache writes, separate from reads |
| Compatible `prompt_tokens_details.cache_write_tokens` | Cache writes |
| DeepSeek `prompt_cache_hit_tokens` | Cache reads |
| Compatible top-level `cached_tokens` | Cache reads |

The uncached input count excludes both read and write counts. Explicit zero
cache-read reports remain distinguishable from absent cache telemetry.
Protocol-specific cache fields are sent only to supported endpoints or when
explicit compatibility declares support; a provider family name alone does not
authorize sending another provider's fields.

Provider caches remain best effort. OpenAI describes reuse of stable prefixes
and retention/diagnostic options in its [prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching).
DeepSeek requires full matching of persisted prefix units and explicitly does
not guarantee every hit; see [context caching](https://api-docs.deepseek.com/guides/kv_cache/).
Qwen offers implicit and explicit caching, with different supported models and
creation charges; see [Alibaba Cloud's cache documentation](https://www.alibabacloud.com/help/en/model-studio/context-cache).
GLM uses automatic reuse and reports cached tokens; see [Z.AI context caching](https://docs.z.ai/guides/capabilities/cache).

## JEV and local Qwen

The existing JEV client canonicalizes JSON map keys before deduplication.
Equivalent hook requests share one in-flight transport and one paid receipt;
array order, strings and scalar evidence stay intact. Cache reads update recency
without extending the original 30-minute TTL. Valid answers can still be reused
while the provider breaker is open. Disabled or cancelled callers cannot use
this to start network work. Distillation keeps protected outcome evidence and
both edges deterministically, asks only about omittable chunks, and accepts up
to twelve bounded chunks within the existing request budget.

Local Qwen yes/no judgments and shortlist choices share one five-minute,
128-entry cache of exact prompt probabilities. Different purposes can reuse
the same probabilities; each caller keeps its own candidate IDs, confidence
checks and cancellation. Queued identical calls recheck the cache after acquiring
the shared FIFO, so they do not launch redundant inference. Failed or malformed
responses are never cached. Prefix checkpoints are scoped to their transport,
endpoint and runtime credential; another server cannot inherit a false warm
checkpoint from an identical prefix string.

This optimization avoids work above llama.cpp; it does not modify kernels,
weights, precision, service resource limits or confidence thresholds. The
pinned runtime and bounded recurrent-model checkpoint setup remain in use.

## Verification

Synthetic regressions exercise catalog upgrades, reasoning propagation,
provider counter mapping, tool-set stability, cancellation, expiry, response
isolation and JEV failover/cache reuse without credentials or inference.

For a repeatable live comparison against a previous checkout or private backup:

```sh
node scripts/benchmark-inference-reuse.mjs --live --baseline /path/to/previous/local-lm.ts
```

The benchmark alternates baseline and candidate calls after warmup over three
fixed advisory prompts, with five repeats each. It reports completed request
latency, inference/cache counts and probability differences. Results apply to
that repeated-input workload; they do not measure first-call speed, arbitrary
session quality or a provider's fleet-wide cache hit rate.

A reference run on a Ryzen 5 7530U with Qwen3.5-0.8B Q4_0 and the pinned
llama.cpp b10878 runtime measured 15 repeats per implementation. Baseline p50
was 140.56 ms and p95 was 159.49 ms; reused candidate p50 was 0.146 ms and p95
was 0.206 ms. Including warmup, native inference calls fell from 18 to 3, with
15 candidate cache reads and zero observed probability difference. This is
evidence for exact repeated advisory prompts on that host, not a kernel speedup.
