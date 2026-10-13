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

## Thinking-level changes

Changing effort is not cache-neutral everywhere. Anthropic renders the
thinking configuration (mode, `budget_tokens`, `output_config.effort`) into
the prompt, so a mid-session change invalidates cached message blocks, and on
models that render it ahead, tool and system blocks too; see Anthropic's
[prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
The exception is per-message effort (`supportsMidConvoEffort`): the core
carries each change in an appended `role: "system"` message keyed to the
level each assistant turn was produced at, which leaves the cached prefix
intact. OpenAI-, DeepSeek- and Gemini-style caches key on the prompt token
prefix, and effort travels as a generation parameter outside that prefix;
the serialized history itself never depends on the active level, so past
thinking blocks are replayed byte-identically whatever the level does.

Automatic effort adjustment (the adaptive thinking controller for the main
agent; the same controller runs inside sub-agent sessions) therefore refuses
to move the level on Anthropic routes without per-message effort — direct
Anthropic API and Claude models served through compatible gateways alike
(`thinkingChangeBreaksPromptCache` in `lib/adaptive-execution.ts`). On those
routes the configured or manually selected level simply stays in force, and
only a manual `/thinking` or `/effort` change pays the invalidation price,
deliberately. A sub-agent's level is chosen once when it is spawned, before
its first request, so delegation never churns a child's cache mid-run.

## JEV

The existing JEV client canonicalizes JSON map keys before deduplication.
Equivalent hook requests share one in-flight transport and one paid receipt;
array order, strings and scalar evidence stay intact. Cache reads update recency
without extending the original 30-minute TTL. Valid answers can still be reused
while the provider breaker is open. Disabled or cancelled callers cannot use
this to start network work. Distillation keeps protected outcome evidence and
both edges deterministically, asks only about omittable chunks, and accepts up
to twelve bounded chunks within the existing request budget.

## Verification

Synthetic regressions exercise catalog upgrades, reasoning propagation,
provider counter mapping, tool-set stability, cancellation, expiry, response
isolation and JEV failover/cache reuse without credentials or inference.
