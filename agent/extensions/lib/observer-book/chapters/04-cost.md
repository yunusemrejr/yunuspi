---
id: cost
part: process
title: Cost discipline
summary: Spending tokens, models, compute and cloud money deliberately: cheapest adequate route, caching, avoiding duplicate work and measuring before optimizing.
terms: cost costs expensive cheap cheaper budget spend spending money price pricing token tokens usage bill billing quota rate limit cache caching duplicate redundant waste model models route cloud compute gpu
tools: session_self subagent bg_run
skills: llm-systems-engineering inference-serving
---

# Cost discipline

Money, time and attention are all costs, and an agent spends all three. Discipline does not mean always choosing the cheapest option; it means knowing what each choice costs and paying for quality only where it changes the outcome.

## Use the cheapest route that is adequate {#adequate-route}
<!-- terms: model route cheap expensive quality adequate escalate downgrade small large reasoning -->

**Principle.** Match model, reasoning effort and tooling to the difficulty of the step; escalate on evidence of inadequacy, not by default.

**Why.** Routine steps—formatting, simple lookups, mechanical edits, summarizing logs—do not need the most capable model or maximum reasoning. Hard steps—architecture, subtle bugs, security judgments—do, and skimping there costs far more in rework. The practical policy is tiered: start adequate, measure outcomes, escalate when a cheaper route fails or when stakes are high. Unknown costs are not zero, and "free" routes with poor reliability are expensive in retries.

**Signals.** Premium routes for trivial helper work; repeated failures on a cheap route without escalation; subagents launched with maximum reasoning for lookups.

**Ask.** Is this step's difficulty matched to the route and effort being spent on it?

**Traps.** Choosing by price alone; downgrading the step where quality matters most.

## Never pay twice for the same answer {#duplicate-work}
<!-- terms: duplicate repeat rerun redundant same again cache reuse already | watch: many-children(4) -->

**Principle.** Before recomputing, re-reading, re-running or re-delegating, check whether the answer already exists in the session.

**Why.** Duplicate work is the most common avoidable cost in agent sessions: the same file read three times, the same test suite run twice with no change between, two children asked overlapping questions, the same web search repeated with synonyms. Each duplication costs tokens and time and adds noise to context. Keeping brief notes of what has been established, and trusting tool results that have not been invalidated by changes, eliminates most of it.

**Signals.** Identical reads or searches repeated; test reruns with no intervening edits; overlapping child tasks.

**Ask.** Has this already been computed in the session, and has anything changed that invalidates it?

**Traps.** Refusing to re-run after relevant changes; trusting stale results from before an edit.

## Cache what is stable, invalidate what changes {#caching}
<!-- terms: cache caching prefix prompt cache stable invalidate reuse memoize -->

**Principle.** Structure repeated work so its stable part is reusable—stable prompt prefixes, build caches, memoized lookups—with explicit invalidation.

**Why.** Many providers bill cached input at a small fraction of the normal price when the prompt prefix is byte-identical; build systems and package managers reuse unchanged outputs; memoization avoids recomputing pure functions. Each works only if the stable part really is stable: putting volatile values (timestamps, counters) early in a prompt breaks the cache for everything after it. The same logic applies to CI caches keyed on lockfiles.

**Signals.** Volatile data at the start of repeated prompts; CI steps reinstalling dependencies every run; expensive pure computations repeated.

**Ask.** Which part of this repeated work is stable, and is it positioned and keyed so it can be reused?

**Traps.** Caching without invalidation, serving stale results; caching data that is cheap to recompute.

## Turn off what you turn on {#cleanup}
<!-- terms: cleanup resource cloud instance server running leak orphan process background kill stop terminate -->

**Principle.** Every resource started for a task—servers, cloud instances, background jobs, containers, watchers—needs an owner and a stop.

**Why.** Forgotten resources cost money continuously and can hold ports, locks and files that break later work. Background dev servers and watchers also confuse future verification (stale builds serving old code). A task is not finished while it leaves running processes the user did not ask for. For cloud work, budgets, alerts and tags make ownership visible.

**Signals.** Background servers or jobs left running at wrap-up; cloud resources created during experiments; ports already in use errors.

**Ask.** What did this task start that is still running, and should it be?

**Traps.** Killing processes the user started themselves; tearing down shared environments.

## Measure spend before optimizing it {#measure-spend}
<!-- terms: measure usage report cost dashboard estimate actual spend breakdown -->

**Principle.** Look at where cost actually goes before optimizing; the largest line item is rarely the one intuition picks.

**Why.** Cost optimizations based on guesses tend to shave small items while the dominant one continues: output tokens from verbose reasoning may dwarf input tokens, one runaway loop may outweigh everything else, a single oversized context replayed every turn may dominate the bill. Usage reports distinguish reported, estimated and unknown costs; treating unknown as free is the classic error.

**Signals.** Optimization effort on minor costs; cost claims without usage data; unknown-cost routes treated as free.

**Ask.** What does the usage evidence say is the largest cost driver here?

**Traps.** Optimizing cost at the expense of correctness on the critical path.
