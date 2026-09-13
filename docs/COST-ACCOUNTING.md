# Session cost accounting

The footer's `total` covers recorded main responses, delegated runs and auxiliary model usage across the session, including model switches and retries. Run `/cost` for a breakdown by provider/model and main, child or auxiliary work.

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

For official OpenRouter routes, the returned account charge takes precedence over catalog multiplication, including zero charges. Upstream inference cost is retained separately and is not added blindly to the account charge. DeepInfra's returned estimate is marked as a provider estimate. See [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Other providers retain their configured rate schedules, including the existing direct DeepSeek time-based pricing.

## Delegated work

Child runners include billed failed attempts, compactions and usage-bearing tool responses. Compact reported/estimated/unknown/subscription facts and per-model subtotals survive attempt aggregation, detached completion and replay. Swarms and fusion do not receive invented flat surcharges: their actual model calls contribute usage.

Nested run identities are retained in accounting receipts. Repeated status, workflow, step and completion snapshots count a physical child once. Inclusive parent totals do not add descendants twice. Later provider billing can correct an estimate for the same recorded turn, including a correction to zero; stale estimates cannot replace that billing evidence.

## Limits and activation

Restart Pi and resume the session to load updated core adapters/footer code. Existing history benefits from improved aggregation, but missing historical rates, lost child evidence and unrecorded charges cannot be reconstructed. This change does not rewrite old session files or make paid inference probes.

The total is an estimate of recorded metered work, not an invoice. External tools without usage records, hosted storage/containers, account-specific discounts or credits, taxes, subscription fees and separately billed BYOK provider charges may require provider billing records. Audio usage without a matching price breakdown is marked partial. Configured or cached catalogs can be stale; new pricing schedules require refreshed metadata or a matching adapter update.

Offline regression coverage includes model switches, long-context thresholds, hourly cache writes, malformed/missing rates, effective service tiers, nested/deduplicated children, retries, compactions, subscriptions, replay and billing corrections. Synthetic provider streams exercise installed API adapters without contacting model providers.

## Context and traffic controls

Unchanged project and skill guidance keeps its original position during tool continuations, preserving the reusable request prefix. Utility tools share one guidance entry while retaining their individual schemas. Structured tool JSON loses only insignificant whitespace; numeric spellings and string contents remain intact. HTTP responses default to a 16 KiB body limit, report truncation, and accept an explicit larger `maxBytes` when needed.

Offline sessions and subagents do not automatically refresh the model catalog. Regression tests intercept provider requests to check request counts and payload preservation without paid inference. Character and byte reductions in fixtures are not measurements of billed token savings.
