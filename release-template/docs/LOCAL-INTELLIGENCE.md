# Local evidence selection and ranking

Tiny models and statistical methods choose evidence and order eligible candidates. They do not determine truth, test success, permissions, dependencies or implementation decisions. The transcript or saved child report remains the source of record.

The shared `agent/extensions/lib/local-intelligence.mjs` owns bounded tokenization, binary TF-IDF relevance, explicit retrieval vocabulary, structural similarity, whole-block selection and decayed reliability estimates. These inexpensive functions run in process. Kompress keeps its single existing authenticated loopback inference worker; the code-reuse neural ranker keeps its existing trained artifact and eligibility checks. No extra daemon, vector database, tool governor or model download is added.

## Changes by boundary

| Boundary | Behavior | Limits |
| --- | --- | --- |
| Kompress | The current task supplies at most 64 terms. Task-matching paragraphs join the validated model selection; cache keys include both source and task. | Existing protected evidence, deadline, rate limit, economic admission and source hashing still apply. |
| Compaction | Successful, indexed prose tool bodies can become exact selected blocks in the actual summary input. Retention guidance uses short references when selection saves space. | Requires `obs_read`. User messages, assistant messages, tool-call pairing, errors, status metadata and previous summaries stay intact. |
| Child handoff | Successful saved inline reports can become task-relevant whole blocks, including findings near the end, with a full-report path. | Requires a persisted output path and a task. File-only output, failures and unsaved reports keep their existing delivery. |
| Near duplicates | Bounded structural fingerprints propose earlier visible same-tool baselines, including across changed command/path arguments. | Only a verified exact delta may replace the body. All changed values and ordering remain reconstructable. No forward references or hidden branch baselines. |
| Project intelligence | Up to 30 discovered candidates use statistical relevance to break lexical ties, including graph-neighbor retrieval. | Exact matches, lexical scores, graph distances, membership, provenance and edges remain authoritative. Vocabulary expansion is an auditable heuristic, not learned embeddings. |
| Failure matching | A current error can point to a structurally similar earlier visible same-tool error. | Error codes/types and negation must agree. Matching never removes error text; existing deterministic distillation and raw retrieval still apply. Similarity is not a probability, diagnosis or verified fix. No new cross-project error store. |
| Model routing | The existing decayed failure estimator reports effective sample support and uncertainty. Comparable admitted metered routes can use an estimated retry cost after every route has sufficient effective observations. | Quality ordering, route health, capacity, exclusions and price caps precede optimization. Unknown/stale telemetry is neutral. No exploratory provider calls. |
| Skills/tools | Existing eligible skill candidates get a statistical tie-break after catalog rarity and fuzzy-match gates. | Bash tool routing stays deterministic. Opportunity logs lack verified outcome labels; they are not silently treated as classifier training data. |

## Selection and recovery contract

Selections contain original complete blocks in source order, a source SHA-256 and UTF-16 ranges. No generated prose is accepted as factual evidence. Numeric values, paths, negations, qualifications, decisions, verification, failed hypotheses and unresolved work are protected. Markdown headings and their following block remain together; bullet groups are indivisible. Context capsules also protect explicit decisions and file evidence.

Only bounded English/ASCII prose and simple Markdown are eligible. Code fences, tables, structured records, oversized input, unrelated tasks and insufficient savings abstain. All task-matching blocks form a retention floor. If that floor exceeds the character budget, the selector abstains instead of clipping critical evidence. Existing output size limits may still apply at the caller.

Compaction and observation receipts use `obs_read({id:...})`; child excerpts identify the saved report. Omission never establishes completion. Similarity normalization is internal and never substitutes normalized text for the original evidence.

Kompress is a token classifier, so task conditioning happens around its source-ID proposal. Prepending an instruction prompt would change its input distribution without demonstrating better selection. The model's own [documentation](https://huggingface.co/chopratejas/kompress-small) describes English prose and sequence-length limits. The experimental SmolLM line selector remains inactive; generation, factual summaries, coding and correctness judgments are not assigned to it.

## Controls and evidence

`PI_LOCAL_INTELLIGENCE=off` disables the new selection and reranking paths; established context scoring and provider-health protection remain available. `PI_HANDOFF_SELECTION=off` disables child report selection alone. Existing `PI_MINI_PREPROCESSOR`, `PI_CONTEXT_MEMORY` and `PI_OUTPUT_DISTILLER` controls retain their scopes. Install changes through the normal update/reload workflow; running sessions need to load the updated extensions.

The public `tests/local-intelligence.test.mjs` uses synthetic fixtures to test task switches, cache isolation, exact source reconstruction, critical overflow, compaction input reduction, saved-file handoffs, sparse metric changes, error polarity and stale telemetry. Existing context, observation, skill, graph, model-quality and recovery regressions cover integration. These tests establish their contracts, not broad model intelligence or measured production token savings. Optional local Kompress weights and service availability are separate from distribution tests.

Deferred work needs evidence first: a generative selector must beat deterministic extraction on held-out task relevance and critical-evidence recall; an embedding reranker must beat the lexical baseline without weakening graph eligibility; an error/fix store needs validated resolution labels and scope controls; learned tool routing needs verified outcomes. Presence of telemetry alone does not satisfy these requirements.
