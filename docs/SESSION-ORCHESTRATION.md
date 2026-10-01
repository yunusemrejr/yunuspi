# Child outcomes and permission cancellation

Child completion uses the retained evidence that the runner actually supplies.
A child with only `exitCode: 0` succeeded; a missing or invalid exit code does not
establish completion. A failed acceptance contract, nonzero exit code or failed
structured outcome takes precedence over a coarse `completed` status. Explicit
timeout and cancellation markers remain distinct. Wait results preserve those
decisions and count successful siblings independently of failed siblings, so a
degraded group can reuse completed work without certifying a failed contract.

Retained circuit-breaker reasons identify provider failures, tool failures,
exhausted tool/turn/cost budgets and stale activity even when a separate terminal
cause was not saved. Unknown reasons remain unknown.

The builtin `delegate` agent explicitly accepts `generic` and `general-purpose`.
An exact project or user agent definition takes precedence over those aliases.

Child permission checks carry a request-local cancellation signal. The parent
signal remains owned by the parent; expiry aborts only the permission request.
Cancellation listeners are installed before the reviewer starts. A timeout or
cancellation during model authentication prevents later reviewer dispatch, and
the first terminal decision remains authoritative if an abandoned operation
eventually resolves. Permission failures continue to deny the requested tool.

`tests/subagent-terminal-evidence.test.mjs` exercises child projection through
the wait/completion path. `tests/subagent-permission-cancellation.test.mjs`
exercises reentrant cancellation, the hook deadline and delayed authentication.
These deterministic regressions establish lifecycle behavior; they do not
measure a model's answer quality or the latency of a remote provider.
