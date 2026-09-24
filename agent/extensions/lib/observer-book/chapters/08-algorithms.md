---
id: algorithms
part: engineering
title: Algorithms and data structures
summary: Choosing structures and algorithms by access pattern and scale: complexity, hashing, sorting and searching, graphs, dynamic programming, streaming and probabilistic structures.
terms: algorithm algorithms data structure structures complexity big-o quadratic linear logarithmic hash map set array list tree heap queue stack graph bfs dfs shortest path sort sorting search binary dynamic programming memoization recursion streaming bloom filter trie
tools: sandbox_run math_check
skills: algorithm-design numerical-computing incremental-computation
---

# Algorithms and data structures

Algorithmic choices determine whether software degrades gracefully or collapses as data grows. The doctrine is not to memorize algorithms but to recognize the access pattern, estimate the scale, and pick the structure that makes the common operation cheap.

## Estimate the scale before choosing {#scale}
<!-- terms: scale size n complexity estimate how many rows items records growth -->

**Principle.** Know roughly how large the input is today and will be later; an O(n²) loop is fine for 100 items and fatal for 100,000.

**Why.** Complexity only matters relative to n. A quick estimate—items per user, users per tenant, growth per year—tells whether a simple approach suffices or a better structure is required. Quadratic behavior hides in innocent code: a lookup in an array inside a loop, repeated string concatenation, re-sorting inside iterations. At a million items, n² is a trillion operations; at a thousand, a million, which is instant.

**Signals.** Nested loops over collections that grow with usage; array includes or find inside loops; performance complaints only with real data.

**Ask.** How large can this input become, and what is the complexity of the operation at that size?

**Traps.** Optimizing tiny, bounded collections; ignoring constant factors and memory for asymptotic purity.

## Pick the structure for the dominant operation {#structures}
<!-- terms: map set hash array list lookup membership index queue heap priority tree ordered -->

**Principle.** Choose data structures by the operation performed most often: hash maps for lookup, sets for membership, heaps for "next best", sorted trees for ranges, queues for order.

**Why.** Most performance problems are a mismatched structure: linear search where a map gives constant time, repeated sorting where a heap maintains order incrementally, a list used as a set. The right structure often simplifies code too, since the operation becomes a single call. Indexing a collection by the key you query on is the single most common high-leverage fix.

**Signals.** Linear scans for lookups; manual deduplication loops; repeated sorts to find the minimum.

**Ask.** What operation does this code perform most, and does the structure make it cheap?

**Traps.** Exotic structures where a plain map suffices; forgetting hash maps' memory overhead at massive scale.

## Recognize graph problems {#graphs}
<!-- terms: graph node edge dependency dependencies cycle topological sort bfs dfs path reachability tree network -->

**Principle.** Dependencies, routes, permissions, workflows and references are graphs; use graph algorithms instead of ad hoc recursion.

**Why.** Many problems are graph problems in disguise: build ordering is topological sort, "can A reach B" is BFS, cycle detection finds circular imports, shortest path solves routing and minimal-edit problems. Ad hoc recursive solutions miss cycles (infinite loops), revisit nodes (exponential time) and break on diamonds. Naming the graph problem gives access to correct, well-understood algorithms.

**Signals.** Recursive traversals without visited sets; dependency ordering done by repeated passes; infinite loops on cyclic data.

**Ask.** Is this a graph problem, and does the traversal handle cycles and shared nodes?

**Traps.** Pulling in a graph library for a two-level tree.

## Overlapping subproblems want memoization {#dynamic-programming}
<!-- terms: dynamic programming memoization memoize recursion overlapping subproblem cache exponential -->

**Principle.** When a recursive solution recomputes the same subproblems, cache results or build a table bottom-up.

**Why.** Naive recursion over overlapping subproblems is exponential; with memoization it becomes polynomial. Edit distance, knapsack-style budgeting, layout fitting, parsing ambiguities and many scheduling problems share this structure. The practical signals are recursion with repeated argument combinations and runtime exploding with input size. Bottom-up tables also avoid stack overflows.

**Signals.** Recursive functions called repeatedly with the same arguments; runtime doubling with each added input element.

**Ask.** Does this recursion revisit the same subproblems, and would caching them change the complexity?

**Traps.** Memoizing functions with side effects or unbounded argument spaces.

## Stream when data exceeds memory {#streaming}
<!-- terms: stream streaming large file memory chunk iterator generator pipeline backpressure batch -->

**Principle.** Process large inputs incrementally—streams, iterators, chunks—rather than loading everything into memory.

**Why.** Loading a multi-gigabyte file or an unbounded query result into memory works in development and crashes in production. Streaming processes constant memory regardless of input size and starts producing output sooner. It requires different thinking: single-pass algorithms, running aggregates, windowing, and backpressure between stages.

**Signals.** readFile or fetchAll on inputs that grow; memory spikes proportional to data size; timeouts on large exports.

**Ask.** Does memory use grow with input size here, and could this be a single-pass stream?

**Traps.** Streaming small data at the cost of simplicity; multiple passes disguised as streams.

## Accept approximation when exactness is expensive {#probabilistic}
<!-- terms: approximate probabilistic bloom filter hyperloglog sketch sampling estimate count distinct top-k -->

**Principle.** For huge-scale counting, deduplication and membership, probabilistic structures trade tiny, known error for enormous savings.

**Why.** Exact distinct counts over billions of events need memory proportional to the distinct count; HyperLogLog estimates them within about 2% in kilobytes. Bloom filters answer "definitely not present" cheaply, count-min sketches approximate frequencies, reservoir sampling picks uniform samples from streams. These are appropriate when the error bound is acceptable and documented; they are wrong where exactness is required (billing, security).

**Signals.** Memory-heavy exact counts for analytics; deduplication of massive streams; dashboards that tolerate small error.

**Ask.** Would a bounded, documented approximation meet this requirement at a fraction of the cost?

**Traps.** Using approximate structures for money, permissions or correctness-critical logic.

## Use proven algorithms, test the edges {#correctness}
<!-- terms: correctness binary search off by one boundary overflow invariant proof sort stable -->

**Principle.** Prefer standard library implementations of classic algorithms; when writing your own, state the invariant and test the boundaries.

**Why.** Binary search is famously hard to get right: off-by-one errors, infinite loops, integer overflow in the midpoint. The same holds for interval merging, date arithmetic and sorting stability assumptions. Library implementations are battle-tested. When a custom algorithm is necessary, writing its loop invariant and testing empty, single-element, duplicate-heavy and extreme inputs catches most defects.

**Signals.** Hand-written searches, sorts or interval logic; loops with complex index arithmetic; no tests for empty or single-element inputs.

**Ask.** What invariant does this loop maintain, and is it tested at empty, one and boundary sizes?

**Traps.** Assuming sort stability or iteration order a language does not guarantee.
