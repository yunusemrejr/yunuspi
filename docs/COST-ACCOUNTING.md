# Session cost accounting

The footer's `total` covers recorded main responses, delegated runs and auxiliary usage across the session, including model switches and retries. Desktop shows the saved total when you open history, and refreshes it when a child or helper records usage after a turn. Run `/cost` for a breakdown by provider/model and main, child or auxiliary work.

- `$…`: provider-reported charges, or an attested zero-activity run.
- `$~…`: includes estimates derived from response usage and model rates.
- `+?`: the total is partial because a child is pending, usage is missing or a price is unknown.
- `$?`: no usable metered cost is available.
- `sub` / `(sub)`: recorded subscription usage, excluded from marginal API charges.

Amounts use USD. Sub-dollar and sub-microdollar amounts retain enough precision to avoid displaying nonzero usage as zero. Selecting a subscription model does not relabel earlier API work. New session responses retain the native provider/auth subscription classification; historical OpenAI Codex responses remain recognized.

## Pricing and provider evidence

Each priced response stores its provider, model, selected token rates, applicable context threshold and estimate coverage. Session history is summed from those response records, so switching models or refreshing a catalog does not reprice earlier work.

The shared calculator selects the highest applicable context tier using input plus cache reads and writes. Token buckets are disjoint; reasoning already included in output is not billed again. One-hour cache writes retain the native separate rate. Missing or malformed rates yield partial estimates; all-zero placeholder metadata is not proof that a route is free.

OpenAI service-tier pricing uses the effective returned tier. Both `fast` and `priority` are recognized. Model-specific factors replace the old blanket multiplier; applicable regional processing adds its documented uplift. Unsupported tier/model combinations remain partial. These rules apply only to official OpenAI endpoints, across both Chat Completions and Responses. The schedule was checked against [OpenAI pricing](https://developers.openai.com/api/docs/pricing) on September 12, 2026; token base rates continue to come from the model catalog/configuration.

For official OpenRouter routes, the returned account charge takes precedence over catalog multiplication, including zero charges. A confirmed BYOK request adds its separately billed upstream cost when the response supplies it. If the upstream cost is missing, the gateway charge is shown with `+?`. DeepInfra's returned estimate is marked as a provider estimate. Other providers retain their configured rate schedules, including the existing direct DeepSeek time-based pricing. [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) · [OpenRouter BYOK billing](https://openrouter.ai/docs/guides/overview/auth/byok)

Hosted Web Access records each submission separately so a failed first route and its fallback can both contribute charges. Perplexity Sonar supplies a total in USD and Datalab's final conversion charge is reported in cents. OpenAI web search records the published search-call fee as a partial estimate when it has evidence of completed search calls. Gemini token usage and Voyage reranking token usage are retained when available, with the USD amount marked unknown when the request does not report it. [Perplexity cost metadata](https://community.perplexity.ai/t/cost-information-now-included-in-api-response-json/833) · [Datalab conversion SDK](https://documentation.datalab.to/docs/welcome/sdk/conversion.md) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [Gemini usage metadata](https://ai.google.dev/api/generate-content) · [Voyage reranker usage](https://docs.voyageai.com/docs/reranker)

## Delegated work

Child runners include billed failed attempts, compactions and usage-bearing tool responses. A child on a role model is billed at that model's rates and appears under its own provider/model in `/cost`; the advisor's answers and the observer's notes are recorded as auxiliary usage under the model that ran them. Compact reported/estimated/unknown/subscription facts and per-model subtotals survive attempt aggregation, detached completion and replay. Fan-out does not receive invented flat surcharges: their actual model calls contribute usage.

Nested run identities are retained in accounting receipts. Repeated status, workflow, step and completion snapshots count a physical child once. Inclusive parent totals do not add descendants twice. Later provider billing can correct an estimate for the same recorded turn, including a correction to zero; stale estimates cannot replace that billing evidence.

Managed `bg_run` agent commands contribute their captured YunusPi usage when they finish, including hosted and nested work. Their durable task receipt is attached to the owning session and can be recovered on reopen. Status and wait results never add another charge. Shell work outside the managed process and runs with incomplete captures remain partial.

Native compaction and branch summaries count their committed usage and save separate receipts for failed or discarded attempts when the operation settles. Split compactions retain reported and estimated cost separately. A request stopped at the local payload gate contributes a confirmed zero if the runtime can prove no dispatch was possible. Once dispatch is possible, missing provider usage keeps the total partial.

Supported transports with session admission submit one inference attempt at a time. Main turns and native summaries retry through the session policy, which honors the provider's minimum wait within `retry.provider.maxRetryDelayMs` when the transport exposes it. Scoped extension calls retain their own fallback policy. Standalone SDK calls keep their transport retry configuration.

## Limits and activation

Restart Pi and resume the session to load updated core adapters/footer code. Existing history benefits from improved aggregation, but missing historical rates, lost child evidence and unrecorded charges cannot be reconstructed. This change does not rewrite old session files or make paid inference probes.

Reconciling the total against an invoice requires billing records for external tools without usage receipts, hosted storage or containers, discounts, credits, taxes and subscription fees. ElevenLabs requests retain the provider's usage units when available and show a partial total when dollar billing is missing. Configured or cached catalogs can be stale. New pricing schedules require refreshed metadata or a matching adapter update. [ElevenLabs billing](https://elevenlabs.io/docs/overview/administration/billing)

Offline regression coverage includes model switches, long-context thresholds, hourly cache writes, malformed/missing rates, effective service tiers, nested/deduplicated children, retries, compactions, subscriptions, replay and billing corrections. Synthetic provider streams exercise installed API adapters without contacting model providers.

## Context and traffic controls

Unchanged project and skill guidance keeps its original position during tool continuations, preserving the reusable request prefix. Utility tools share one guidance entry while retaining their individual schemas. Structured tool JSON loses only insignificant whitespace; numeric spellings and string contents remain intact. HTTP responses default to a 16 KiB body limit, report truncation, and accept an explicit larger `maxBytes` when needed.

Measured per-turn schema tax (0.9.1): lazy discovery narrows 122 registered extension tools to 23 always-on core tools plus host built-ins, about 43,000 description and schema characters (~11k tokens) with another ~3,700 in prompt guidelines. The weight is delegation, background-task and todo contract text; trimming it would trade behavior for tokens, so it stays. Tool-result `details` never reach providers — only `content` text and images are serialized. `video_frames` with `contactSheet:true` collapses up to 12 vision attachments into one tiled image.

Offline sessions and subagents do not automatically refresh the model catalog. Regression tests intercept provider requests to check request counts and payload preservation without paid inference. Character and byte reductions in fixtures are not measurements of billed token savings.
