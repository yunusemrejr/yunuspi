# Model routing

LongCat is discovered through its [authenticated OpenAI-compatible catalog](https://longcat.ai/platform/docs/api/models) using `LONGCAT_API_KEY`. `LongCat-2.5-Preview` and `LongCat-2.0` use the documented binary [thinking control](https://longcat.ai/platform/docs/api/chat): off or enabled (shown as medium), without invented effort tiers. Live context/output limits override static assumptions; unknown prices remain unknown. New catalog IDs appear without acquiring unverified reasoning or vision support. Discovery uses the existing cache, health reporting and provider-confined registry path; proxy credentials are never sent to the official origin. Native tool calls were verified against both listed models on 2026-09-25.

The main session keeps the model you selected, and every subagent runs on that same session model. Agent definitions carry no model, fallback or thinking selection; a child's thinking level is chosen per run by the effort controller, up to the ceiling in `subagents.maxThinking`.

There is no automatic model selection, ranking, benchmark-based choice or price cap. Subagents, reviewers, councils and the session observer run on the session model; the harness never switches models for you. Change the model with `/model`.

`/models` no longer edits language-model routes. It opens a local browser window for image, speech, music and sound-effect choices only (see [Video studio](VIDEO-STUDIO.md)).

Search ranks matching configured, available routes before temporarily blocked routes and unconfigured catalog entries. Availability labels describe the session registry and recorded cooldowns; they do not claim a successful inference probe. Exact `provider/model` queries stay within that provider, including regional IDs. The main TUI puts registered matches before unlisted session-only IDs and labels the latter unverified.

The collapsed Routing diagnostics section reports bounded process-local samples for config load/save and actual HTTP model-search latency, plus child-route attempts. Samples reset with the harness process and do not include task text or credentials.

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
