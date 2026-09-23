# Async integration review

Reviewed on 2026-09-23 against YunusPi 0.4.0 and its follow-up worktree. The question was whether the useful Unreal Agent ideas reach actual execution, rather than merely appearing in tool descriptions. The existing integration is real, with deliberately narrower semantics than an all-async harness.

[Unreal Labs' launch article](https://unreallabs.ai/blog/unreal-agent/) emphasizes asynchronous completion, more useful tool execution between model requests, smaller context overhead and environmental isolation. It also reports provider incompatibilities with duplicate running/final outputs for one tool call. Its published cost reductions are their benchmark results; this review does not reproduce them or attribute those savings to YunusPi. The [project README](https://github.com/unreallabsai/unreal-agent) separates durable operations, session history and model-context assembly; the review below checks YunusPi's existing owners at those boundaries.

## Evidence matrix

| Idea | Actual YunusPi integration | Behavioral evidence and limit |
| --- | --- | --- |
| Async completion without a waiting conversation | [`bg_run`](../agent/extensions/pi-background-tasks/src/extension.ts) returns an owned task receipt; the [registry](../agent/extensions/pi-background-tasks/src/core/registry.ts) persists terminal output and metadata before notification. The [completion notifier](../agent/extensions/pi-background-tasks/src/core/completion-wake.ts) waits for session acceptance, then coalesces finite completions. Services default to a UI update without a model wake. | `async-delivery`, `background-admission` and `background-service-policy` tests exercise actual SDK durability, duplicate launches, cancellation, stale owners and accepted-message replay prevention. Eight completion receipts produce one wake within a fixed 200 ms window. Ordinary foreground tools still await their batch before another model request. |
| More tool work per model turn | The [owned tool loop](../core/agent/src/agent-loop.js) executes independent groups concurrently while declared sequential tools form barriers. Preflight and authorization remain ordered. | `tool-batch-scheduling` exercises five tool calls in three execution phases, preserving result order, cancellation and finalization barriers. It does not infer dependencies between arbitrary commands or silently detach them. |
| Avoid model-driven polling | Background completion is event-driven. [Child wait subscriptions](../agent/extensions/pi-subagents/src/runs/background/wait-subscriptions.ts) deduplicate terminal delivery and coalesce event bursts. Tool guidance directs agents to do other work or yield. | `async-delivery` coalesces 600 events into one reconciliation; failed delivery attempts are bounded. Child subscriptions also retain a one-second local reconciliation timer for recovery. That timer is local work, not a model request; “no polling anywhere” would be inaccurate. |
| Bound context and preserve cached prefixes | [Observation projections](../agent/extensions/pi-observations.ts) seal their first provider-visible rendering and retain original output retrieval. [Context diagnostics](../agent/extensions/context-profile.ts) attribute prefix and tool-schema changes. Tool guidelines are assembled from active tools in the [session owner](../core/coding-agent/src/core/agent-session.js). | `observations-render-seal` verifies that late cache fills and changed local state do not rewrite sealed history. Display-only activity is excluded from model context in SDK tests. Actual provider cache hits remain provider-dependent; adding tools, changing prompts or compaction can legitimately change the prefix. |
| Environment-enforced experiments | [`sandbox_run`](../agent/extensions/sandbox.ts) uses the [fixed Python launcher](../agent/scripts/sandbox-runner.py): Bubblewrap namespaces, systemd cgroups, bounded source snapshots, no host home/project mounts or network. Background mode uses the same task registry and cleanup boundary. | `sandbox` and `sandbox-background` execute real Linux isolation, resource limits, failure/deadline propagation, cancellation and detached-descendant cleanup. Isolation is explicit per sandbox call; ordinary authorized host commands are not automatically sandboxed. |
| Avoid duplicate local work | [Needle](../agent/extensions/lib/needle-runtime.ts) shares identical pending requests. [Coordination receipts](../agent/extensions/siblings.ts) associate separately authorized native checks with source hashes. | Needle protocol tests turn 48 concurrent consumers into four worker operations and preserve independent result ownership. `coordination-checks` exercises the native SDK path and rejects changed-source or rewritten-command evidence. Receipts are advisory and never waive required verification. |

## Verification and remaining work

The following focused run passed **72 tests, zero failures or skips**, including required real Linux isolation:

```sh
PI_SANDBOX_REQUIRE=1 node --test --test-concurrency=1 \
  tests/async-delivery.test.mjs tests/background-service-policy.test.mjs \
  tests/background-admission.test.mjs tests/sandbox-background.test.mjs \
  tests/sandbox.test.mjs tests/tool-batch-scheduling.test.mjs \
  tests/observations-render-seal.test.mjs tests/coordination-checks.test.mjs
```

Three additional Needle protocol tests passed with `--test-name-pattern='identical concurrent Needle|Needle coalescing preserves|Needle shared failures'`. These count worker operations through a controlled transport; they do not measure neural quality or hosted billing. Provider responses in SDK tests are deterministic fixtures.

The highest-value next step is measuring actual workload usage of these paths: model turns, uncached tokens, schema size, long foreground calls and duplicate work, alongside task correctness. A same-model, same-task comparison is needed before making cost claims. Steering can be queued while foreground work runs, but the current loop consumes it at the next execution boundary; universal immediate preemption is not implemented. Keeping explicit background admission preserves existing hook, cancellation and provider contracts. No blanket conversion of tools to asynchronous execution or additional polling guidance is justified by this audit.
