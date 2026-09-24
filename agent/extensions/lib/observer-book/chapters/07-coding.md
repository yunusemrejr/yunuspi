---
id: coding
part: engineering
title: Coding craft
summary: Line-level quality: readable control flow, small honest functions, immutability, types as documentation, async correctness, comments that explain why, and idiomatic use of each language.
terms: code coding function functions readable readability control flow nested nesting early return immutable immutability const mutable type types typescript python go rust javascript async await promise callback comment comments idiom idiomatic lint style
tools: syntax_check source_check symbol_expand
skills: coding-practices typescript-contract-engineering python-software-engineering rust-systems-engineering go-service-engineering node-runtime-engineering
---

# Coding craft

Most code is read many times and written once. Line-level craft is what makes the reading cheap: control flow a reader can follow, functions that do what their names say, data that does not change behind their back, and types that record intent.

## Flatten control flow {#control-flow}
<!-- terms: nested nesting if else early return guard clause complexity branch -->

**Principle.** Handle edge cases and errors first with early returns, so the main path reads straight down without deep nesting.

**Why.** Deeply nested conditionals force readers to hold a stack of conditions in mind to understand one line. Guard clauses state preconditions up front and exit, leaving the rest of the function about the normal case. Flat code is also easier to modify: adding a condition does not require re-indenting a pyramid. Cyclomatic complexity is a rough proxy; the real measure is how many conditions a reader must remember at each line.

**Signals.** Indentation four or more levels deep; else branches containing the main logic; long functions with many interleaved conditions.

**Ask.** Can the edge cases exit early so the main path reads without nesting?

**Traps.** Scattering many returns through long functions in ways that hide cleanup; flattening by extracting meaningless tiny helpers.

## Small functions with honest names {#functions}
<!-- terms: function small long method extract name side effect pure parameters arguments -->

**Principle.** A function should do one thing at one level of abstraction, with a name that tells the truth about its effects.

**Why.** Long functions mixing levels—parsing, business decisions and I/O in one body—are hard to test and reuse. Extracting well-named steps turns the top-level function into a readable summary. Honest names matter as much as size: a getX that writes, a validate that mutates, or a function with hidden global side effects breaks every reader's mental model. Many parameters, especially booleans, suggest a function doing several jobs.

**Signals.** Functions over a screen long; boolean flag parameters changing behavior; functions with side effects their names hide.

**Ask.** Does each function's name describe everything it does, including side effects?

**Traps.** Fragmenting code into dozens of one-line functions that must be read together anyway.

## Prefer immutable data and pure transforms {#immutability}
<!-- terms: immutable mutation mutate mutable const readonly pure side effect copy state shared -->

**Principle.** Build new values instead of mutating shared ones, and keep side effects at the edges of the program.

**Why.** Mutation at a distance is a leading cause of confusing bugs: an object modified by one function surprises another that held a reference. Immutable values can be shared freely, compared cheaply, cached safely and reasoned about locally. Pure functions (output depends only on input) are trivially testable. Mutation is fine inside a function on data it owns—performance sometimes demands it—but should not leak across boundaries.

**Signals.** Functions that modify their arguments; shared mutable module state; bugs that depend on call order.

**Ask.** Could this function return a new value instead of mutating one that others hold?

**Traps.** Copying huge structures in hot loops; performative immutability that complicates simple local code.

## Let types carry the invariants {#types}
<!-- terms: type types typing any unknown interface union discriminated enum null undefined optional generic strict -->

**Principle.** Use types to make invalid states unrepresentable; avoid escape hatches like any, unchecked casts and ignored errors.

**Why.** Types are checked documentation: they record intent where the compiler enforces it. Discriminated unions model states precisely (loading, error with message, success with data) so impossible combinations cannot compile. Escape hatches silently disable this protection exactly where code is trickiest. In dynamically typed languages, runtime schemas at boundaries and type hints with a checker provide much of the same value.

**Signals.** New any or type: ignore comments; casts to silence errors; optional fields encoding state machines; booleans pairs like isLoading and isError.

**Ask.** Could these states be modeled so invalid combinations do not type-check?

**Traps.** Type gymnastics that readers cannot follow; strictness demands in throwaway scripts.

## Async code must handle order, failure and cancellation {#async}
<!-- terms: async await promise concurrent parallel race cancel abort timeout unhandled rejection callback -->

**Principle.** Every asynchronous operation needs an answer to three questions: what if it fails, what if it is slow, and what if its result arrives after it stopped mattering?

**Why.** Async bugs are timing bugs, and they escape tests that run fast on a quiet machine. Unawaited promises drop errors; sequential awaits in loops waste time when work is independent; parallel operations without limits overwhelm services; late responses overwrite newer state (the classic search-as-you-type bug). Cancellation signals, timeouts, bounded concurrency and sequence checks turn these into designed behaviors.

**Signals.** Promises created without await or catch; await inside loops over independent items; responses applied without checking they are still current.

**Ask.** What happens here if the operation fails, hangs, or finishes after a newer one?

**Traps.** Unbounded Promise.all over large inputs; sleeps used as synchronization.

## Comments explain why, code explains what {#comments}
<!-- terms: comment comments documentation docstring why explain todo fixme outdated -->

**Principle.** Write comments for intent, constraints and non-obvious reasons; let names and structure explain what the code does.

**Why.** Comments restating code rot as the code changes and become lies. Comments that explain why—a workaround for a specific bug, a performance constraint, a business rule's origin, an invariant callers must keep—carry knowledge the code cannot. Match the comment density of the surrounding code: a sudden wall of comments in a terse codebase is noise; missing context on a tricky algorithm is a trap.

**Signals.** Comments narrating each line; outdated comments contradicting code; complex logic with no explanation of intent.

**Ask.** Does each comment tell the reader something the code itself cannot?

**Traps.** Deleting important historical context as "noise"; commented-out code kept "just in case".

## Write the language, not a translation {#idioms}
<!-- terms: idiom idiomatic pythonic language convention standard library style guide -->

**Principle.** Use each language's idioms and standard library instead of transliterating patterns from another language.

**Why.** Idiomatic code is easier for that language's practitioners to read and usually more efficient: comprehensions in Python, iterators and Result in Rust, error values in Go, structured concurrency in modern runtimes. Translated patterns—Java-style getters in Python, manual loops where a standard function exists, exceptions for control flow in Go—work but add friction and bugs. The standard library is also better tested than hand-rolled equivalents.

**Signals.** Hand-written utilities duplicating standard functions; patterns foreign to the language; ignoring the project's linter or formatter.

**Ask.** Is there a standard or idiomatic way to express this in this language?

**Traps.** Clever idioms that obscure intent; chasing idiom over consistency with the existing codebase.

## Delete dead code {#dead-code}
<!-- terms: dead code unused remove delete unreachable deprecated legacy commented out -->

**Principle.** Remove code that is unused, unreachable or replaced; version control remembers it.

**Why.** Dead code costs attention forever: readers must figure out whether it matters, refactors must keep it compiling, searches return false hits, and security scanners flag its dependencies. Commented-out blocks and unused exports accumulate because deletion feels risky. Tooling (unused-export detection, coverage, compiler warnings) makes it safe to find, and tests make it safe to remove.

**Signals.** Unused functions, imports or parameters; commented-out code in diffs; feature flags that are always on.

**Ask.** Is any code touched here now unused, and can it be removed in this change?

**Traps.** Removing public API that external consumers use; deleting code referenced by reflection or configuration.
