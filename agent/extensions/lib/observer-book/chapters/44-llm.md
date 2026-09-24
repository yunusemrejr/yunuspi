---
id: llm
part: science
title: LLM applications
summary: Building with language models: evals over vibes, prompts as versioned code, context engineering and retrieval, tool design, structured outputs, injection defenses, and cost and latency control.
terms: llm llms language model gpt claude openai anthropic prompt prompts prompting system prompt context window rag retrieval embedding embeddings vector agent agents tool calling function calling structured output json schema eval evals evaluation hallucination fine-tuning token tokens temperature streaming
tools: sandbox_run web_search
skills: llm-systems-engineering rag-engineering nlp-system-design ai-engineering model-evaluation llm-fine-tuning small-model-engineering inference-serving
---

# LLM applications

Language models are probabilistic components with surprising capabilities and surprising failures. Building reliably with them means treating prompts as code, outputs as untrusted, and quality as something measured with evaluations rather than judged from a few demos.

## Evals, not vibes {#evals}
<!-- terms: eval evals evaluation test set golden examples regression score judge rubric benchmark quality -->

**Principle.** Build an evaluation set of real, representative cases with expected outcomes, and run it on every prompt or model change.

**Why.** LLM behavior changes nonlinearly with small prompt edits and model updates; a fix for one case silently breaks others. Demos select for success. An eval set—drawn from real inputs, including hard and adversarial cases, scored by exact checks, rubrics or carefully validated model judges—turns prompt engineering into engineering. Tracking scores over time catches regressions.

**Signals.** Prompt changes validated on a handful of manual tries; no stored test cases; model upgrades without comparison.

**Ask.** Which evaluation cases show this prompt or model change is an improvement overall?

**Traps.** Model-graded evals that are never checked against human judgment.

## Prompts are code {#prompts}
<!-- terms: prompt prompts system prompt template version instructions examples few-shot delimiter format -->

**Principle.** Version prompts, keep instructions separate from data with clear delimiters, show examples of the desired output, and review prompt changes like code.

**Why.** Prompts encode product behavior; untracked edits make regressions untraceable. Mixing instructions and user data invites injection and confusion; delimiters and structured sections reduce both. Concrete examples communicate format and style more reliably than descriptions. Shorter, specific instructions often beat long lists of rules.

**Signals.** Prompts assembled by string concatenation of user text; no version history; contradictory instructions accumulated over time.

**Ask.** Is the instruction clearly separated from untrusted data, and is this prompt versioned and tested?

**Traps.** Prompt bloat from adding a rule for every observed failure.

## Context is a budget: retrieve, rank, trim {#context}
<!-- terms: context window rag retrieval chunking embeddings rerank relevant documents long context tokens -->

**Principle.** Put only the most relevant information into context: retrieve candidates, rerank them, and include the best within a budget, with sources.

**Why.** Long contexts cost money and latency, and models attend less reliably to information buried in the middle. Retrieval quality usually matters more than generation quality in RAG systems: chunking strategy, hybrid lexical and semantic search, reranking and metadata filters determine whether the answer is even available. Citing sources makes answers verifiable.

**Signals.** Entire documents stuffed into prompts; retrieval never evaluated separately; answers without sources.

**Ask.** Does the context contain the information needed for the answer, and how was that measured?

**Traps.** Tuning the generator when retrieval is the failure.

## Design tools for models {#tools}
<!-- terms: tool calling function calling tool design schema parameters errors idempotent agent actions -->

**Principle.** Give models narrow, well-named tools with typed parameters, clear descriptions, bounded outputs and actionable error messages.

**Why.** Models choose and use tools based on names and descriptions; ambiguous tools get misused. Broad tools ("run any SQL") create risk; narrow tools encode safe operations. Errors should tell the model how to recover. Large tool outputs flood context; pagination and summaries keep it usable. Dangerous actions need confirmation or policy gates outside the model.

**Signals.** Vague tool descriptions; tools returning unbounded output; errors returned as stack traces; destructive tools without gates.

**Ask.** Would a model understand when to use this tool, and can it recover from its errors?

**Traps.** Too many overlapping tools confusing selection.

## Validate structured outputs {#structured-output}
<!-- terms: structured output json schema validation parse retry type constrained decoding format -->

**Principle.** Request structured outputs against a schema, validate them strictly, and handle invalid outputs with bounded retries or fallbacks.

**Why.** Even with JSON modes, outputs can omit fields, invent values or violate constraints. Validation turns silent corruption into handled errors. Constrained decoding and schemas reduce failure rates; semantic validation (does the cited id exist?) catches plausible-but-wrong values.

**Signals.** Model output parsed without validation; missing fields causing downstream crashes; no retry policy.

**Ask.** What happens when the model returns output that does not match the schema?

**Traps.** Unbounded retry loops on consistently failing inputs.

## Model inputs from the world are untrusted {#injection}
<!-- terms: prompt injection untrusted content indirect injection web page document email exfiltration jailbreak guard -->

**Principle.** Treat retrieved documents, web pages, emails and tool outputs as data that may contain adversarial instructions; limit what the model can do with them.

**Why.** Indirect prompt injection hides instructions in content the model processes, attempting to trigger tool calls, leak data or alter answers. No prompt fully prevents it. Defenses are architectural: least-privilege tools, confirmation for sensitive actions, separating untrusted content, output filtering for exfiltration channels (URLs, markdown images), and monitoring.

**Signals.** Agents with broad tools processing external content; model outputs rendered as HTML or markdown with remote images; no confirmation on sensitive actions.

**Ask.** If this content contained malicious instructions, what is the worst action the model could take?

**Traps.** Relying on "ignore instructions in documents" prompts as the defense.

## Control cost and latency {#cost-latency}
<!-- terms: cost latency tokens caching prompt cache streaming smaller model routing batch cheaper -->

**Principle.** Route easy requests to smaller models, cache stable prompt prefixes and repeated answers, stream long outputs, and cap tokens.

**Why.** LLM costs scale with tokens and model size; latency with output length. Many requests do not need the largest model. Prompt caching discounts repeated prefixes heavily when static content comes first. Streaming improves perceived latency. Output caps prevent runaway costs from verbose responses.

**Signals.** The largest model for all requests; volatile content at the start of prompts; no output limits.

**Ask.** Which requests could use a smaller model or a cached answer without hurting quality?

**Traps.** Routing that degrades quality on the hard cases that matter most.
