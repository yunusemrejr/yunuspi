---
id: engineering
part: engineering
title: Engineering patterns
summary: Durable software practice: smallest sufficient change, local idioms, boundaries, error handling, ownership of state, abstraction timing and safe refactoring.
terms: refactor function module class interface abstraction duplicate duplication helper util utility pattern design clean maintain maintainable readable naming name rename error exception handle handling state global config configuration dependency coupling
tools: edit write bulk_edit syntax_check source_check
skills: coding-practices software-engineering-wisdom type-driven-design typescript-contract-engineering python-software-engineering
---

# Engineering patterns

Good engineering is mostly restraint applied with judgment: change what the problem requires, match the code around you, make invalid states hard to represent, and leave the system easier to change than you found it. These passages describe the patterns that most often separate durable changes from ones that pass today and break next month.

## Make the smallest change that fully solves the problem {#smallest-change}
<!-- terms: minimal small diff scope rewrite unnecessary unrelated churn -->

**Principle.** Change exactly what the problem requires—completely, including tests and edge cases—and nothing unrelated.

**Why.** Every changed line is a line to review, a potential regression and a merge conflict for someone else. Unrelated cleanups hide the real change in noise and make bisecting future bugs harder. Yet "small" must not mean "partial": fixing one call site of a bug that exists at four is a small diff and a wrong one. The discipline is to find the full extent of the problem (all callers, all similar patterns), then apply the narrowest change that covers it. Refactors that make the fix possible are fine when they are separated and explained.

**Signals.** Edits spread across many unrelated files; reformatting or renames mixed with a bug fix; a fix applied at one site while a search would show the same pattern elsewhere.

**Ask.** Does the diff contain anything the request did not need, and does it miss any other place with the same defect?

**Traps.** Treating "minimal" as "touch one line"; refusing a necessary refactor; skipping tests to keep the diff small.

## Read before you write; conform to local idioms {#read-first}
<!-- terms: read existing convention idiom style pattern consistent codebase surrounding -->

**Principle.** Before editing, read the surrounding code, its callers and one similar feature; then write code that looks like it belongs.

**Why.** A codebase encodes decisions: error-handling conventions, naming, logging, dependency injection, test style. New code that ignores them works but creates two ways of doing everything, which is how systems rot. Reading first also prevents the most common agent bug: calling a function with the wrong assumptions about its contract because only its name was seen. The cost of reading one caller and one sibling module is minutes; the cost of an alien pattern is paid by every future reader.

**Signals.** Edits to files not read in this session; new helpers that duplicate existing utilities; a different error or logging style than neighbouring code.

**Ask.** Is there an existing helper, convention or sibling implementation this change should follow?

**Traps.** Copying a legacy anti-pattern because it is local; reading an entire large module when one function matters.

## Validate at boundaries, trust inside {#boundaries}
<!-- terms: validate validation input parse schema boundary untrusted null undefined type check guard -->

**Principle.** Convert untrusted input into well-typed values once, at the system's edge, and let internal code rely on those types instead of re-checking everywhere.

**Why.** Scattered defensive checks are both noisy and incomplete: each function guards against a different subset of bad inputs, and nobody knows which invariants actually hold. Parsing at the boundary ("parse, don't validate") produces values whose type proves their validity—non-empty lists, positive quantities, normalized paths—so impossible states cannot reach core logic. Boundaries include HTTP handlers, CLI arguments, file and environment reads, message queues, and model or tool output. Internal code then fails loudly if an invariant is broken, instead of silently limping.

**Signals.** Null checks sprinkled deep in logic; raw request objects passed through many layers; model/tool output used without schema checks.

**Ask.** Where does this data enter the system, and is it parsed into a trustworthy shape there?

**Traps.** Adding validation only at the edge you touched while others bypass it; overly strict parsing that rejects legitimate inputs.

## Fail loudly at the layer that can act {#errors}
<!-- terms: error exception catch throw swallow ignore fallback retry log handle handling silent -->

**Principle.** Handle an error where there is enough context to recover or explain it; otherwise let it propagate with context attached. Never swallow it.

**Why.** Empty catch blocks and blanket fallbacks convert crashes into wrong answers, which are far more expensive: the program keeps running with corrupted state, and the eventual symptom appears far from the cause. Good error handling distinguishes expected failures (not found, invalid input, timeout) that are part of the contract from bugs that should crash. It preserves the original cause, adds the context the caller lacks (which file, which request), and gives the user an actionable message. Retries belong only around transient, idempotent operations.

**Signals.** try/catch returning defaults; errors logged and ignored; messages without the failing input; retries around non-idempotent writes.

**Ask.** If this operation fails in production, who finds out, with what information, and what state is left behind?

**Traps.** Adding catch-all handlers to make an error disappear; converting all errors to one generic message.

## Give every piece of state one owner {#state}
<!-- terms: state global singleton cache mutable shared source truth sync synchronize duplicate stale -->

**Principle.** Each fact should live in exactly one authoritative place; everything else derives from it or subscribes to it.

**Why.** Duplicated state drifts: a cached count, a denormalized flag, a copy in the UI store and another on the server will disagree under concurrency, retries or partial failure. Most "impossible" bugs are two sources of truth diverging. Designing ownership explicitly—who writes, who reads, how changes propagate, what happens when the owner restarts—removes whole classes of bugs. When a copy is necessary for performance, it needs an invalidation story that is written down and tested.

**Signals.** The same value stored in two places; manual syncing code; global mutable singletons; cache writes without invalidation.

**Ask.** Which component owns this state, and how does every other copy learn when it changes?

**Traps.** Eliminating a justified cache instead of adding invalidation; hiding global state behind a getter and calling it owned.

## Duplication is cheaper than the wrong abstraction {#abstraction}
<!-- terms: abstraction duplicate generic reuse helper dry premature wrong framework base class -->

**Principle.** Abstract after the third similar case, when the real axis of variation is visible—not before.

**Why.** Premature abstractions guess at future variation and usually guess wrong; later cases then bend the abstraction with flags and special cases until it is harder to understand than the duplication it replaced. Two similar blocks of code are easy to read and easy to change independently. By the third case the commonality and the differences are empirical, so the abstraction can be shaped around them. Conversely, copy-pasted logic that must stay identical (validation rules, security checks, pricing) should be shared immediately because divergence is a bug.

**Signals.** New generic helpers or base classes with one caller; boolean parameters that switch behavior; the same business rule copied into several places.

**Ask.** Is this abstraction based on cases that already exist, and is duplicated logic here required to stay identical?

**Traps.** Refusing to share security-critical logic; building a plugin system for one plugin.

## Refactor separately from behavior change {#refactor}
<!-- terms: refactor restructure rename move extract behavior preserve regression tests -->

**Principle.** Restructure code in steps that preserve behavior and are verified, then change behavior in a separate, small step.

**Why.** When a diff both moves code and changes what it does, neither reviewers nor tests can tell which part caused a regression. Behavior-preserving refactors can be checked mechanically: the same tests pass before and after, types still line up, public outputs are unchanged. Keeping them separate also makes it trivial to revert the risky part. Large refactors should proceed in increments that each leave the system working, rather than one big switch.

**Signals.** A bug fix that also renames, moves or reformats; many files changed with tests not run between steps.

**Ask.** Could the restructuring land and be verified before the behavior change, so each step is checkable?

**Traps.** Refactoring code without tests and calling it safe; endless preparatory refactoring that delays the requested fix.

## Names carry the design {#naming}
<!-- terms: name naming rename variable function identifier meaning misleading -->

**Principle.** A name should state what a thing is or does in the domain's language; when meaning changes, the name must change too.

**Why.** Code is read far more than written, and names are the densest documentation. A misleading name ("validate" that also saves, "tmp" that lives forever) produces bugs in every future change because readers trust it. Names also reveal design problems: if something cannot be named without "and" or "manager", it probably does too much. Consistency matters as much as accuracy: one concept, one word across the codebase.

**Signals.** Functions whose behavior outgrew their names; synonyms for one concept; generic names like data, info, handler, util in new code.

**Ask.** Would a new reader correctly guess what this does from its name alone?

**Traps.** Mass renames mixed into unrelated work; bikeshedding names while correctness issues remain.
