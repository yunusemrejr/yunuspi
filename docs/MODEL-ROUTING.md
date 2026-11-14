# Model routing

LongCat is discovered through its [authenticated OpenAI-compatible catalog](https://longcat.ai/platform/docs/api/models) using `LONGCAT_API_KEY`. `LongCat-2.5-Preview` and `LongCat-2.0` use the documented binary [thinking control](https://longcat.ai/platform/docs/api/chat): off or enabled (shown as medium), without invented effort tiers. Live context/output limits override static assumptions; unknown prices remain unknown. New catalog IDs appear without acquiring unverified reasoning or vision support. Discovery uses the existing cache, health reporting and provider-confined registry path; proxy credentials are never sent to the official origin. Native tool calls were verified against both listed models on 2026-09-25.

Ant Ling is discovered through its [authenticated OpenAI-compatible catalog](https://developer.ant-ling.com/en/docs/api-reference/chat/openai/) using the key stored in `auth.json` or `ANT_LING_API_KEY`. The catalog lists ids only, so context, image input, thinking and prices come from dated facts checked on 14 Nov 2026 (the Ling 3.0, 3.1 and 3.2 line); an id the facts do not know is a plain text model without thinking. The 3.x models take one thinking switch, so they offer off and medium, without invented effort tiers. Ant Ling publishes no output limit, so the harness's unverified allowance applies. Its prices are promotional and in yuan, converted at the rate of 13 Nov 2026 (0.14988 US dollars), and each is quoted only until its review date: Ling-3.2-flash is free until 18 Nov 2026 and its later price is unknown, the other published prices are reviewed on 28 Nov 2026. Ling-2.6-1T, Ling-2.6-flash and Ring-2.6-1T were withdrawn on 14 Nov 2026 at 16:00 UTC (Ling-3.1-flash replaces them) and are no longer offered although the built-in list and the catalog still name them; the speech and image models (`Ming-*`) are not chat routes and are left out.

The main session keeps the model you selected. Each subagent has a role (main, helper or legwork) and runs on the model the `team` settings give that role; with no `team` block every subagent runs on the session model. A child that forks the conversation always runs on the session model, because the history it replays is cached only there. Agent definitions carry no model, fallback or thinking selection; a child's thinking level is chosen per run by the effort controller, up to the lowest of the ceiling in `subagents.maxThinking` and the role's ceiling in `team.maxThinking`. See [Team](TEAM.md).

There is no automatic model selection, ranking, benchmark-based choice or price cap. Subagents, reviewers and councils run on the model of their role, which is the session model unless you set another with `/team`. The session observer and the memory exit summary run on the legwork model when `team.sideCalls` is `legwork` and a legwork model is set; calls that judge what you allowed stay on the session model. The harness never switches the main session's model for you. Change it with `/model`.

`/models` no longer edits language-model routes. It opens a local browser window for image, speech, music and sound-effect choices only (see [Video studio](VIDEO-STUDIO.md)).

Search ranks matching configured, available routes before temporarily blocked routes and unconfigured catalog entries. Availability labels describe the session registry and recorded cooldowns; they do not claim a successful inference probe. Exact `provider/model` queries stay within that provider, including regional IDs. The main TUI puts registered matches before unlisted session-only IDs and labels the latter unverified.

The collapsed Routing diagnostics section reports bounded process-local samples for config load/save and actual HTTP model-search latency, plus child-route attempts. Samples reset with the harness process and do not include task text or credentials.

## Adding a provider

A provider needs three things in `models.json`: a base URL, the wire API it speaks, and a key.

```json
{ "providers": { "acme": { "baseUrl": "https://api.acme.example/v1", "api": "openai-completions", "apiKey": "${ACME_API_KEY}" } } }
```

That is enough. At the next start the harness asks the provider for its own model list (`GET <baseUrl>/models`, or `<baseUrl>/v1/models` for `anthropic-messages`) and every chat model it offers appears in `/model`. Models you list yourself under `models` keep exactly the definition you gave them; discovery only adds the ones you did not list. The key is sent to the base URL you configured and nowhere else, a key written as a `!command` is never run for discovery, and a provider that has no model list simply keeps the models you listed.

A plain model list is ids and nothing more, so limits and prices come from the **model directory**: the public catalogue at [models.dev](https://models.dev), fetched without credentials at most once a day and cut down to the providers you have configured. A provider is recognised by the host of its base URL, so the name you give it does not matter; when the directory has several entries on one host, the one whose path fits the base URL is used, and when none clearly fits, no facts are attached. Where facts meet, the order is: your `models.json` values, then what the provider's own list states, then the directory, then a general allowance (128,000 tokens of context, 16,384 of output) that the status line marks as unverified. A price nobody states stays unknown; it is never shown as free. Models that do not write text (image, speech, embedding) are left out.

`/catalog-status` shows the age of each list; `/catalog-status refresh` updates the selected provider's list and the directory now, whatever their age. `PI_MODEL_DISCOVERY=off` turns discovery off, the directory request included, and `PI_OFFLINE=1` stops every catalogue request. The saved directory records which providers it was cut for by address only (origin and path), never a user name, password or query string from a base URL.

Dated facts shipped with the harness (the wire formats of DeepSeek and Cerebras, for example) carry the day they were checked. Past their review date they stay in force, because an old wire format is still the best evidence there is; only their prices stop being quoted, and the directory supplies current limits and prices instead. Inside its review window a provider's own price list outranks the directory: DeepSeek's API bills a peak rate on weekdays from 01:00 to 04:00 and 06:00 to 10:00 UTC and half that otherwise, the directory lists only the lower rate, and the harness costs each request by the hour it was sent.

## Provider capability updates

The parent refreshes live catalogs and the existing native catalog adapters for available providers at startup and at prompt boundaries after 15 minutes. Each adapter retains its own TTL; workers and offline sessions do not start automatic network discovery. Shutdown cancels outstanding discovery. Completed refreshes update the selected route's capacities and supported thinking level before the next prompt's context checks. Catalog disappearance never silently switches the user's route.

Explicit `models.json` overrides remain authoritative. Otherwise, live capability metadata wins over stored snapshots: OpenRouter's advertised effort enum determines the available levels, Friendli's `reasoning_options` drives effort/toggle/budget controls, and Cerebras' public limits and supported parameters determine token limits and request fields. Missing metadata uses existing adapter defaults or dated facts; malformed catalogs retain prior usable data. Retired concrete OpenRouter IDs are removed from the live list while synthetic `~` aliases remain. Native catalogs validate network and disk records before applying them; unknown additive fields survive.

HTTP 404/501 from the optional catalog endpoint preserves previously validated cached models and their freshness metadata. A failed check does not make stale or unproven data authoritative. Xiaomi Token Plan includes MiMo 2.6 Flash and Pro in its SGP, AMS and CN catalogs, with separate regional credentials. Official metadata: [regional endpoints](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access) and [model capabilities](https://mimo.mi.com/docs/en-US/tokenplan/integration/opencode), checked 2026-09-23.

Direct SDK calls and session/worker calls clamp requested effort through the same model capability map. Friendli's documented disable controls omit the unsupported `none` effort and use a zero reasoning budget plus its template toggle where advertised. A declared `thinkingTokenBudgetOff` supports this endpoint behavior without applying it to other providers. Prompt-cache keys remain stable per session; extended cache retention requires an exact supported OpenAI endpoint or explicit compatibility. Cache accounting and bounded retries retain their existing owners.

Metadata cannot prove inference availability, undocumented capabilities, tokenizer accuracy, or future API compatibility. Unknown facts remain uncertain; explicit overrides and `/catalog-status` provide the existing correction and diagnostics paths. These changes do not infer capabilities from a new model's family name or spend inference tokens probing it.

Sources checked 2026-09-19: [OpenRouter model schema](https://github.com/OpenRouterTeam/terraform-provider-openrouter/blob/main/docs/data-sources/model.md), [Friendli's provider integration](https://github.com/friendliai/hermes-friendli-provider), [Cerebras public catalog](https://api.cerebras.ai/public/v1/models), and [DeepSeek thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/). Regression coverage: `tests/provider-capabilities.test.mjs`, `agent/scripts/compatibility/live-models-refresh-test.mjs`, and `agent/scripts/compatibility/provider-cache-wire-test.mjs` use synthetic data and loopback requests.

## Choosing the form of delegation

Delegation is on demand. The main model starts one `subagent` for a bounded independent investigation, or fan-out for separable project investigations or competing approaches or alternatives, and the workers' outputs are merged with provenance. The harness does not start helpers by itself; delegation, tool and route opt-outs still apply.

Each child has token, tool and runtime limits.

Children perform advisory investigations; the parent owns changes, resolves disagreements and validates claims. Fan-out preserves source ownership and failed-member counts. It does not turn agreement into proof or silently choose a factual winner. A single usable child remains a single helper. Existing executor cancellation, fleet capacity, request caps and recovery remain authoritative.

Workflow recovery retains a child's native `budget_exhausted` outcome when
planning respawns. An exhausted budget cannot become a fresh attempt merely
because the child also returned `ok:false`; ordinary retryable failures retain
their existing bounded recovery policy.

Terminal `length` stops caused by a child output limit are treated as budget/output-limit faults, not evidence that the underlying model or serving route is unhealthy, so that stop alone does not add a provider cooldown. Likewise, a `not found` response for a harness-composed thinking-suffixed model ID is attributed to the composed ID rather than the healthy base route; a bare-model `not found` response can still be route-health evidence.

Provider errors that identify an invalid request, invalid parameters or an
unsupported parameter fail without resending the same payload, including router
wrappers that say “Provider returned error.” Both the installed SDK and CLI use
this rule. A generic HTTP 400 alone does not establish a deterministic failure;
transient overloads keep their retry policy. The original diagnostic remains
available so the request can be corrected. This prevents wasted retries without
claiming to repair every provider-specific payload mismatch.

Model listings distinguish capability metadata and price status.

## Local preprocessing reuse

The optional mini paragraph selector retains up to 16 validated source-hash selections per client. Repeated source text can reuse exact paragraph IDs without inference, even during cooldown. Changed text needs its own selection; branch/reset clears the cache and aborts in-flight work. Returned IDs cannot mutate cached selections. Original tool text and source retrieval remain intact, and protected status, numbers, negation and qualifiers remain mandatory.

Failed or unsupported inference backs off from 20 to at most 60 seconds; success returns to the existing ten-second limit. There is no retry queue. The client exposes request, accepted-selection, fallback and cache-hit counts plus projected character savings; these are not billed token measurements. Bounded health events carry only outcome categories and duration. Deterministic compaction still runs first, disabled/unavailable models preserve raw data, and no experimental SLM is enabled by these changes.

## Micro-intelligence routing

Cheap layers route work before expensive models see it. Tool, capability,
and command discovery runs deterministic eligibility, then lexical order,
then a Needle head-slice re-rank, then Jev validation when Needle is
uncertain or disagrees with lexical order; the main model still chooses
what to execute. Tool results route by deterministic content shape to
Kompress (prose), Needle (relevance/error cues), and Jev (ambiguity
triage) after the deterministic distiller. A Needle→Jev
intent pre-screen can resolve task-mutation rescue checks before the
full-LLM arbiter, with asymmetric bars. None of these layers delay
provider startup: slow or missing helpers degrade to skips, and the
`micro_status` tool plus `docs/MICRO-INTELLIGENCE.md` show what ran,
what skipped, and why.

Codex discovery uses the official authenticated account catalog rather than a generic catalog overlay. Verified visible IDs are cached only for the matching account; stale or failed refreshes keep that account's last usable catalog. Newly discovered models with no advertised prices remain unknown-cost, and a conservative output allowance is labelled estimated until explicit metadata replaces it. Empty overrides for existing providers are no-ops. The routing editor collects skip diagnostics without emitting runtime warnings for roles merely being inspected.
