---
name: engineering
description: "Use when writing, refactoring, reviewing, debugging, testing or profiling code or weighing design tradeoffs, incl. TypeScript, Node, Python, invariants, property tests, bisection, performance, algorithms."
---

# Engineering

## Method
- Project conventions and the existing state owner win; extend that owner, never add a parallel cache, manager or source of truth.
- Smallest general fix. Read the exact target region before editing; never overwrite a whole file to get past a failed match.
- Before claiming done: rerun after the last edit, recompute key numbers a second way, try the negative and boundary case, recheck each explicit requirement.
- Report what ran, what is unverified and residual risk.

## Code and design
- Names reveal intent; a name needing a comment is wrong. Avoid double negatives (`isActive`, not `!isNotDeleted`).
- Functions: one abstraction level, few args, no boolean params (use two functions), no side effects hidden in reads.
- Validate and parse unknown input into typed values at every boundary (HTTP, file, config, IPC). Replace impossible flag combos with a sum type.
- Catch only to retry, translate with context, or propagate. Dispatch on error codes, never message text.
- One writer per contended state; prefer immutable values. Comments say why; TODOs need an owner or date.
- Delete before adding. Abstract at the third occurrence. Prefer stdlib and native features to new dependencies; mark a known shortcut `ponytail:` with its ceiling and upgrade path.

## Tests and contracts
- Test public behavior: happy path, one typed failure, one edge boundary. Fakes over mocks; no test-only branches in production.
- Mutate the code once; no red test means the test proves nothing.
- Property tests need an independent oracle and must fail on a known-bad implementation; keep shrunk counterexamples as regressions. Round trips alone miss paired encoder/decoder bugs.
- Lifecycle bugs: state the invariant ("one accepted job, at most one terminal result"), enumerate orderings (cancel vs complete, late result after restart), reproduce with the real lifecycle.
- A timeout does not prove non-execution; retry only with deduplication or status reconciliation.
- Incremental caches must key on every input (content, flags, tool versions); compare against clean rebuilds across edit sequences.

## Debugging
- Reproduce, minimize, bisect (`git bisect run ./repro.sh`), test one falsifiable hypothesis, fix the cause, add a regression. No repro: capture versions, config, data, commands; say so.
- Instrument boundaries; read the full error. Two failed hypotheses with no new information: read the whole path linearly.
- Never claim a race is fixed without a run that exercises it.
- Hangs: `strace -p PID`, `kill -QUIT` (Go), jstack (JVM). Leaks: heap snapshots over N cycles, valgrind/heaptrack. OOM kills show in dmesg, not app logs.

## Performance and algorithms
- Fix the target workload; keep correctness checks apart from timing. Profile before editing; time completed async work, not enqueue time.
- Compare baseline and candidate with warmup and randomized repeated trials; report distributions. Latency is p95/p99, never averages.
- Check algorithm assumptions first (nonnegative weights for Dijkstra, directedness, disconnected input); validate fast versions against brute force.

## Decisions
- Name the tradeoff: "X over Y because Z; revisit when W." One-way doors (data model, public API, vendor) get a short written record and a second reader.
- Default to boring tech; each dependency is a permanent license, security and upkeep cost.
- Small PRs (under ~400 diff lines), split by concern. Report bad news early with the fix attached.

## TypeScript and Node
- Match module and moduleResolution to the real runtime; check path aliases and packaged ESM/CJS output, not only `tsc`.
- Give every promise, stream and subprocess an owner. `Promise.all` is not a limiter; use `pipeline` for backpressure; a `Promise.race` timeout does not kill the process.
- Stdout may be a protocol: diagnostics go to stderr. Test SIGTERM drains bounded work.

## Python
- Use the project environment; never overwrite the system interpreter. `with` for every resource; pathlib; specific exceptions; no mutable defaults, `eval`, or unpickling untrusted data.
- Never block the event loop with CPU or sync network work. No `shell=True` for untrusted values.
- Test installed-package imports, not only repo-root runs.
