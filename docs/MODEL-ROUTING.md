# Model routing and automatic assistance

The main session keeps the model you selected. Inherited children are selected from the available registry using task requirements, cached quality evidence, current route health, and the existing cost limits. Explicit/configured model choices retain their identity and the existing authorization rules. A model argument supplied by an agent does not authorize higher spending.

Optional `~/.pi/settings/llm_preferences.json` preferences guide selection per role (subagents, councils, swarms, fusion, quality/project/error reviews, main-session fallback) with explicit thinking levels and OpenRouter backend control. Preferences are validated against the live registry, exclusions, cooldowns and capabilities, tried in order, and skipped when unusable; missing or exhausted preferences fall back to the autonomous logic below. The main session keeps your last harness-selected configuration while healthy and consults JSON fallbacks only after it fails. See [Model preferences](LLM-PREFERENCES.md).

## Quality before price

Selection first checks capacity, modalities, exclusions, quota/cooldowns, and recent operational failures. Benchmarks describe the model; provider reliability and response speed describe the serving route. Neither a paid price, provider reputation, context window, nor successful HTTP response establishes intelligence.

Benchmarks are compared only for exact model identities and matching suite/evaluation protocols. Different scales are never averaged. The weakest comparable result is retained. Standard work requires at least 90% of the reference scores; critical work requires 97% and at least two independent benchmark measures, excluding composite indices that would double-count components. Missing reference benchmark coverage fails the comparison. These are conservative admission thresholds, not probabilities of task success.

The selected parent's model identity remains an explicit quality baseline. Without comparable evidence, unfamiliar models can provide bounded advisory input for the parent to verify. They cannot replace the baseline for implementation just because they are cheaper. If no affordable model passes, the child is not launched and the parent can do the work itself. Quality gates never raise the price ceiling.

Among eligible routes, verified free models are preferred. Free candidates with comparable evidence rank by performance bands, evidence-supported version progression, continuity, route reliability and observed speed. Paid alternatives stay within the configured caps and favor low cost, with speed breaking close price comparisons. A newer version is preferred only when comparable measurements show no regression; version numbers, model popularity and catalog addition dates are not quality evidence. Different sizes and variants do not inherit sibling scores.

## Evidence refresh and speed

The existing `cache/subagents-model-rank.json` cache accepts its legacy v1 format and v2 observations with model identity, benchmark, protocol, domain, source, observation time and source authority. Legacy unqualified scores remain advisory; they do not pass the new quality gates. Benchmark evidence expires after seven days.

After live catalog refresh, the root session starts bounded research in the background. Selection makes no network requests. Research coalesces within the process, coordinates across sessions, and negatively caches failed lookups for six hours. Each cycle examines at most four public model identities, performs at most one web search, and has an eight-second deadline. Only public model identifiers are sent; task text, project paths and source code are excluded. Cancellation cannot publish a fresh-looking partial snapshot.

The structured sources are:

- [Artificial Analysis](https://artificialanalysis.ai/api-reference): its optional free data API uses `ARTIFICIAL_ANALYSIS_API_KEY`. Exact creator/slug matches and documented numeric units are required. Ambiguous names, variants and missing values stay unknown. Data attribution: [Artificial Analysis](https://artificialanalysis.ai/).
- [Hugging Face model cards](https://huggingface.co/docs/hub/model-cards): exact repository identities and structured metrics with explicit units. These are publisher-reported measurements and alone cannot pass the critical-work gate.
- Web search: discovers references for unfamiliar models. Search snippets and marketing claims never become executable benchmark scores. Many models do not publish suitable structured evidence, so unknown quality is expected and remains visible in the model listing.

Free billing evidence still belongs to the live catalog: [OpenRouter](https://openrouter.ai/docs/guides/routing/provider-selection) receives zero price caps for a proven-free request; [OrcaRouter](https://docs.orcarouter.ai/introduction) depends on its official pricing evidence. Catalog availability does not prove that a quota remains available or that inference will succeed.

Set `PI_MODEL_RESEARCH=off` to disable background research. No paid inference probes are run. The 500-route test records cached selector latency, with a 150 ms regression ceiling; this is a local fixture measurement, not a service latency guarantee.

## Choosing the form of assistance

Automatic assistance uses one helper for a bounded independent investigation, a swarm for separable project investigations, and fusion for competing approaches or alternatives. It runs once per user input and does not delay the parent's first request. Explicit delegation requests are left to the parent to avoid launching a duplicate team; delegation/tool/route opt-outs still apply.

Teams contain at most three different model identities and prefer free routes across different providers. At most one cheap model may complement the free members, with automatic helper ceilings of $0.20/M input and $0.50/M output. Total estimated cost is bounded to $0.01 for one helper, $0.02 for fusion, or $0.03 for a swarm; each child also has token, tool and runtime limits. Provider billing for a request already in flight can settle after a local stop, so these are runtime admission and usage limits, not provider-side dollar guarantees.

Children perform advisory investigations; the parent owns changes, resolves disagreements and validates claims. Fusion preserves source ownership and failed-member counts. It does not turn agreement into proof or silently choose a factual winner. A single usable child remains a single helper. Existing executor cancellation, fleet capacity, request caps and recovery remain authoritative.

Workflow recovery retains a child's native `budget_exhausted` outcome when
planning respawns. An exhausted budget cannot become a fresh attempt merely
because the child also returned `ok:false`; ordinary retryable failures retain
their existing bounded recovery policy.

Provider errors that identify an invalid request, invalid parameters or an
unsupported parameter fail without resending the same payload, including router
wrappers that say “Provider returned error.” Both the installed SDK and CLI use
this rule. A generic HTTP 400 alone does not establish a deterministic failure;
transient overloads keep their retry policy. The original diagnostic remains
available so the request can be corrected. This prevents wasted retries without
claiming to repair every provider-specific payload mismatch.

`model-routing-decision` session entries record the selected mode, reason, routes, evidence explanations and budgets. Model listings distinguish capability metadata, price status and cached benchmark coverage. Set `PI_AUTONOMOUS_FREE_ASSIST=0` to disable proactive helpers while keeping manual delegation available.

## Local preprocessing reuse

The optional mini paragraph selector retains up to 16 validated source-hash selections per client. Repeated source text can reuse exact paragraph IDs without inference, even during cooldown. Changed text needs its own selection; branch/reset clears the cache and aborts in-flight work. Returned IDs cannot mutate cached selections. Original tool text and source retrieval remain intact, and protected status, numbers, negation and qualifiers remain mandatory.

Failed or unsupported inference backs off from 20 to at most 60 seconds; success returns to the existing ten-second limit. There is no retry queue. The client exposes request, accepted-selection, fallback and cache-hit counts plus projected character savings; these are not billed token measurements. Bounded health events carry only outcome categories and duration. Deterministic compaction still runs first, disabled/unavailable models preserve raw data, and no experimental SLM is enabled by these changes.
