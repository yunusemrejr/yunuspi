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
intact. OpenAI- and Gemini-style caches key on the prompt token prefix, and effort
travels as a generation parameter outside that prefix; the serialized history
itself never depends on the active level, so past thinking blocks are replayed
byte-identically whatever the level does. DeepSeek is measured instead of
assumed: across 572 recorded sessions a thinking-level change on the same
DeepSeek model was followed by a cache miss on 24 of 32 requests, against 1.8%
for requests with no change, so the DeepSeek family is handled like Anthropic.

Automatic effort adjustment (the adaptive thinking controller for the main
agent, which also runs inside sub-agent sessions, and the cost governor's
economy step-down) therefore refuses to move the level on Anthropic routes
without per-message effort — direct Anthropic API and Claude models served
through compatible gateways alike — on Qwen chat-template routes and on
DeepSeek routes, whether named by provider, model id or `deepseek` thinking
format (`thinkingChangeBreaksPromptCache` in `lib/adaptive-execution.ts`). On
those routes the configured or manually selected level simply stays in force, and
only a manual `/thinking` or `/effort` change pays the invalidation price,
deliberately. A sub-agent's level is chosen once when it is spawned, before
its first request, so delegation never churns a child's cache mid-run.

## Keeping the request head stable

The system prompt lists the active tools and the tools array precedes the
conversation, so any change to either, to a system-prompt addition or to an
earlier message re-bills the whole cached transcript at the fresh-input rate
(about 50 times the cache rate on DeepSeek). Four rules keep the head still:

- **Stage before the host snapshots.** Tool discovery stages the wire when a
  prompt is accepted (`input`), not only in `before_agent_start`. The host
  snapshots the system prompt before that hook, and any handler that rewrites
  the prompt (`pi-memory` does on every prompt) pins the snapshot for the run,
  which used to leave the first request listing tools it did not carry and
  forced a rebuilt head on the second prompt. Only an idle prompt is staged.
- **A warm wire only grows.** `lib/wire-warmth.ts` prices a rebuild from the
  session's last request (prompt tokens at the route's fresh-minus-cached rate)
  and treats it as warm when that exceeds 0.4 cents inside the route's cache
  lifetime on the same route. While warm, a difficulty-tier change never
  removes a schema and never adds core tools unasked; an explicit request, an
  intent bundle, `tool_search` or a "Tool not found" retry still stage a tool
  at once. Inferred schemas stay tracked and are released once the cache is
  cold. A small, idle or free session simplifies as before.
- **Head text never toggles.** System-prompt additions use `stickyHeadText`:
  the first bytes a session receives are the bytes it keeps, recorded in the
  session as `head-latch-v1`. In a warm session a new addition is delivered as
  one persisted hidden message instead.
- **Small notes ride the tail.** `createContextAnchor` places a block under
  6,000 characters at the end of every request. A block kept at its first
  boundary re-bills everything appended since when its content changes or it
  retires, which costs more than re-sending a few hundred tokens each call.

`/budget` reports every cache miss with its cause: tools (with the names that
changed), system prompt, a rewritten earlier message, an idle gap past the
route's cache lifetime, a route change, or the provider. Misses over 20,000
tokens are also recorded as `cache-miss-v1` entries. `lib/cache-sentinel.ts`
only hashes outgoing requests and never alters one.

`node agent/scripts/cache-probe.mjs` checks all of this on any build. It drives
the real harness over RPC against a local fake provider with a simulated prefix
cache and a throwaway agent directory, then lists each tool, system-prompt and
history change between consecutive requests and exits nonzero when the wire
shrinks, the head changes without a tool change, an earlier message is
rewritten, or the first request lists a tool it does not carry. `--repo
<checkout>` probes a checkout, `--scenario ui` the larger interface-work wire,
`--keep` keeps the work directory. Run it after changing tool staging,
system-prompt owners, `context` hooks or thinking control.

## JEV

The existing JEV client canonicalizes JSON map keys before deduplication.
Equivalent hook requests share one in-flight transport and one paid receipt;
array order, strings and scalar evidence stay intact. Cache reads update recency
without extending the original 30-minute TTL. Valid answers can still be reused
while the provider breaker is open. Disabled or cancelled callers cannot use
this to start network work. Distillation keeps protected outcome evidence and
both edges deterministically, asks only about omittable chunks, and accepts up
to twelve bounded chunks within the existing request budget.

**The latest Jev is resolved, not pinned.** The decisions route is called
through the `~typesafe/jev-latest` alias first, so a new release is used without
a code change; the route reports the dated model it served
(`typesafe/jev-1.14-20261014`), and that concrete id is what `/used`, the Jev
ledger and health show. The dated id is also kept as the next fallback if the
alias is ever rejected, followed by the previous stable release. The chat-only
`typesafe/jev-router` is not a decisions model and never joins the cascade.

**Effort routing is a Jev site.** Once per human turn the cost governor may ask
two typed `noul` questions — is this request genuinely simple, and does it need
deep multi-step reasoning — through the shared decision registry. Only two
agreeing scores can step the thinking level *down* from the user's configured
ceiling, never to `off`, and only when the context that would have to be
re-read at the new level is within `EFFORT_SWITCH_BUDGET_TOKENS` (4000). That
budget applies to a warm prefix only: the session's first request, a compacted
prefix and a route switch have no provider cache to lose, so the decision is
not blocked there even when the system prompt is large. Goal
rounds, preset briefs, complex or critical wording, long input, code, prior tool
failures and an ambiguous/failed judge keep the ceiling. A step up is always
allowed, and a burst of two tool errors restores the ceiling immediately.
`PIJEV_EFFORT=off` (or `PI_JEV=off`, `PI_OFFLINE=1`) disables the router; a
manual `/effort` or `/thinking` selection wins for the rest of the session. The
decision and the configured ceiling are persisted, so reopening a session
restores the human's ceiling rather than inheriting the last automatic level.

## Verification

Synthetic regressions exercise catalog upgrades, reasoning propagation,
provider counter mapping, tool-set stability, cancellation, expiry, response
isolation, latest-alias resolution, Jev effort routing and JEV failover/cache
reuse without credentials or inference.
