---
id: performance
part: engineering
title: Performance engineering
summary: Making software fast on purpose: measure first, find the bottleneck, fix complexity and I/O before micro-optimizing, manage memory and caches, and benchmark honestly.
terms: performance perf fast faster slow slowness latency throughput optimize optimization bottleneck profile profiler profiling benchmark flame graph cpu memory leak allocation cache hot path p95 p99 load
tools: sys_probe bg_run sandbox_run
skills: performance-experiments cpp-performance-engineering web-performance node-runtime-engineering
---

# Performance engineering

Performance work fails in two ways: optimizing without measuring, which spends effort on code that was never slow, and measuring badly, which produces numbers that do not describe reality. Everything else follows from getting those two right.

## Measure before you optimize {#measure-first}
<!-- terms: measure profile profiler flame graph bottleneck hot path guess intuition timing -->

**Principle.** Profile the real workload to find where time or memory actually goes, then optimize that—and only that.

**Why.** Intuition about bottlenecks is wrong most of the time; programs spend their time in surprising places (serialization, logging, a hidden N+1, lock contention, GC). Profilers and flame graphs show the true distribution. Amdahl's law bounds the payoff: speeding up code that takes 5% of runtime can never save more than 5%. A before-and-after measurement is also the only proof an optimization worked.

**Signals.** Optimization edits without any profile or timing; micro-optimizations in code not shown to be hot; performance claims without numbers.

**Ask.** Which measurement shows this code is the bottleneck, and what will prove the change helped?

**Traps.** Profiling a debug build or tiny dataset; optimizing latency when throughput is the real problem.

## Fix the complexity class before the constant {#complexity-first}
<!-- terms: complexity algorithm quadratic loop constant factor micro-optimization big-o -->

**Principle.** An algorithmic improvement (O(n²) to O(n log n)) beats any amount of micro-tuning; look for it first.

**Why.** Micro-optimizations yield percentages; complexity fixes yield orders of magnitude, and they keep paying as data grows. Common wins: indexing lookups with maps, avoiding repeated work inside loops, batching I/O, precomputing, and removing accidental quadratic behavior in string building or array operations.

**Signals.** Hand-tuned loops around a quadratic algorithm; runtime growing faster than data size.

**Ask.** Is there a lower-complexity approach before tuning constant factors?

**Traps.** Complex algorithms with worse constants for small inputs.

## I/O dominates: batch, stream, cache {#io}
<!-- terms: io network disk latency round trip batch bulk stream cache n+1 serialization -->

**Principle.** Most application latency is waiting on I/O; reduce round trips by batching, parallelizing independent calls and caching stable results.

**Why.** A network round trip costs as much as millions of CPU instructions. Sequential awaits on independent calls add their latencies; parallel calls take the maximum. Batching turns N round trips into one. Serialization formats and payload sizes matter at scale. Caching avoids I/O entirely but needs invalidation.

**Signals.** Sequential awaits for independent requests; per-item remote calls in loops; large payloads fetched for a few fields.

**Ask.** How many round trips does this path make, and which could be batched, parallelized or avoided?

**Traps.** Unbounded parallelism that overwhelms a dependency.

## Memory: allocation churn, retention and leaks {#memory}
<!-- terms: memory leak allocation garbage collection gc heap retention closure listener cache growth oom -->

**Principle.** Watch for memory that grows without bound—caches without eviction, listeners never removed, closures retaining large objects—and for allocation churn in hot paths.

**Why.** Leaks in long-running processes cause slow degradation and eventual crashes that appear unrelated to their cause. Garbage-collected languages leak through references: global maps, event listeners, timers, closures capturing big objects. Allocation churn in hot loops increases GC pauses and latency tails. Heap snapshots compared over time find leaks; allocation profiles find churn.

**Signals.** Module-level caches or maps without eviction; listeners added per request; memory rising steadily under constant load.

**Ask.** What in this change grows with time or traffic, and what bounds it?

**Traps.** Premature pooling that complicates code for negligible gain.

## Caches need keys, bounds and invalidation {#caching}
<!-- terms: cache caching ttl eviction lru invalidation stale stampede thundering herd key -->

**Principle.** Every cache needs a correct key, a size bound, an expiry or invalidation rule, and protection against stampedes.

**Why.** Caches are the most common cause of "the data is wrong sometimes". Keys that omit a parameter return one user's data to another; missing invalidation serves stale values; unbounded caches become leaks; when a hot entry expires, many requests recompute it at once (stampede). Request coalescing, jittered TTLs and stale-while-revalidate address stampedes. Caching must be measured: a low hit rate means cost without benefit.

**Signals.** Cache keys missing tenant, user or locale; caches with no TTL or size limit; no hit-rate measurement.

**Ask.** What exactly is in this cache key, when does an entry become wrong, and what bounds the cache size?

**Traps.** Caching errors; caching personalized data in shared caches.

## Benchmark honestly {#benchmarks}
<!-- terms: benchmark benchmarking warmup variance statistics representative jit repeat noise percentile -->

**Principle.** Benchmarks need warmup, repetitions, representative data and variance reporting; a single run is an anecdote.

**Why.** JIT compilation, caches, CPU frequency scaling and background load make single timings noisy by tens of percent. Microbenchmarks often measure a dead-code-eliminated loop. Honest benchmarking runs enough iterations, reports medians and spread (or confidence intervals), uses production-like data, and compares against a baseline measured the same way. Tail latency (p95/p99) often matters more than averages to users.

**Signals.** Speedup claims from one run; benchmarks on toy inputs; averages reported without spread.

**Ask.** How many runs, on what data, with what variance, support this performance claim?

**Traps.** Optimizing for the benchmark instead of real workloads.

## Watch the tail, not just the average {#tail-latency}
<!-- terms: p95 p99 tail latency percentile outlier slow request jitter gc pause -->

**Principle.** Users experience percentiles, not averages; the slowest 1% of requests often decides how a product feels.

**Why.** A page making 50 backend calls hits each service's p99 frequently. Tail latency comes from GC pauses, lock contention, cold caches, noisy neighbors and retries. Averages hide all of it. Monitoring and budgets should be set on p95/p99, and fixes should target the causes of outliers: hedged requests, timeouts, reducing fan-out, eliminating pauses.

**Signals.** Performance discussed only as averages; high fan-out request paths; sporadic slow requests dismissed as noise.

**Ask.** What does the p99 look like here, and what causes the slowest requests?

**Traps.** Chasing p99.99 on non-critical paths.
