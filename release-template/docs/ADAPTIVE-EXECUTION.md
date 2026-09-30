# Adaptive execution

YunusPi selects automatic support from the current task, subtask or todo and
the evidence observed while it runs. `agent/extensions/lib/adaptive-execution.ts`
owns admission policy; the session extension owns live evidence. The existing
native child executor, review lifecycle and observer scheduler still own their
work, cancellation and receipts.

| Scope evidence | Automatic support |
| --- | --- |
| A bounded direct edit, command or explanation | Direct completion; no helper, council, periodic reviewer or routing judge |
| Diagnosis, moderate uncertainty or repeated failures | One bounded investigator, one completion reviewer, observer at 120 seconds |
| Broad independent work or competing approaches | Up to three independent workers, up to three completion reviewers, observer at 60 seconds |
| High consequence work | Independent assurance, observer at 30 seconds |

Watchmaker reviews substantial or failing work at a 120-second routine cadence.
Failure evidence can shorten reviewer admission to the scheduler's next tick.
The scheduler applies cheap admission before building a packet. It still keeps
single-flight dispatch, cancellation, evidence freshness, quiet backoff and
duplicate-advice suppression.

Two unresolved real failures enable diagnosis support; three raise complex
support. Unrelated successful reads do not resolve failure evidence. A passing
substantive check clears that evidence for the current scope. Subtasks and
todos keep separate evidence, so a mechanical todo need not inherit a complex
parent's coordination cost. Completion review separately retains the whole
task's risk and changed files. A final formatting todo cannot waive an
authentication, migration or deployment review.

User constraints remain active in child scopes. Technology restrictions such
as “only use HTML, CSS and PHP” do not pin the model/provider. Explicit configured
model routes and thinking levels remain exact. Native automatic children use
scope-appropriate reasoning defaults where no explicit setting exists.

Ordinary requested native children also classify their own authored brief before
shared task-state context is added. Direct children use minimal reasoning,
investigators use low, and complex or consequential children use high, within
the agent's configured maximum and actual model support. Configured agent
thinking and model suffixes remain exact; external runners keep their native
contract. Missing briefs and unresolved templates retain moderate uncertainty.
Fork transcript restrictions still take precedence.

Requested parallel arrays and chain groups execute every child. Without an
explicit capacity setting, inexpensive independent work defaults to two active
children, substantial work or repeated failures to three, and a single item to
one. Scripted workflows default to three active children. Explicit tool/group
concurrency, the subagent configuration's `parallel.concurrency`, and configured global capacity
remain effective. `adaptive-subagent-dispatch-v1` records applied defaults; the
`concurrency` tool field exposes deliberate overrides without blocking useful
parallelism. The rollback switch removes adaptive capacity and reasoning
defaults while retaining configured capacity.

Remote installed-skill discovery is admitted only when the current scope needs
uncertainty or coordination support. Direct work does not perform a skill judge,
budget reservation or scouting child. Captured `*.log.txt` verification output
remains review evidence without adding a copy reviewer; explicitly requested
textual artifacts remain covered. Completed review reports ask for one parent
assessment with `quality_review`, while an active review is identified as
running. Neither state creates acceptance automatically.

Automatic project-memory ingestion retains raw text, lexical indexes and source
provenance for direct scopes, while deferring semantic embedding and backlog
recovery. Explicit memory tools remain available. Complex work and unresolved
failures resume bounded semantic indexing; optional memory work cannot turn a
simple edit into a remote embedding session.

Guardian can accept a complete, current native readback for one small prose
proofreading edit. It requires matching content hashes, at most four mutations
and 1 KiB of changed text, and a complete document within 16 KiB and 200 lines.
Safe literal discovery does not invalidate that evidence. Code, policy, risky
or mixed edits, stale reads, opaque commands and explicit requested tests retain
the normal verification guard. The exception records no test pass.

The main model also uses minimal reasoning for direct scope, low reasoning for
diagnosis and high reasoning for complex work, bounded by the session's
configured level and the model's supported levels. Explicit CLI thinking/model
suffixes and later manual selections stay exact. Automatic changes restore
the configured session level when work settles, and cannot restore an old
session's level into a replacement session.

Direct changes can have independent review marked `not_needed`, with a policy
reason. This creates no independent pass or acceptance receipt. Required local
tests, visual checks, delivery authority and source verification retain their
existing owners. Deliberate `quality_review` remains available, and stronger
source, risk, failure or authored-policy evidence restores automatic review.

Pi Lens drains same-session deferred autofix and formatting before native
checks capture source identity and before `project_tests` or `quality_review`.
Declared custom check runners use the same boundary. A complete bounded native
read of an owned, modified `.md`, `.rst` or `.txt` document also drains that
document's pending write/edit work before the read captures its content hash;
partial, unrelated and foreign-owner reads do not start a drain. The existing formatter,
workspace/session ownership, cancellation and explicit format settings stay
authoritative. Failed or interrupted drains refuse the check instead of letting
settlement mutate source after verification or accepted review.
This boundary bypasses the recent-write time debounce so a newly edited file
is finalized immediately; ordinary writes/settlement keep that debounce, and
maintained-source, freshness, inline SVG and formatter safety guards still apply.
Formatting never grants a Guardian exception. If it changes the native edit's
content hash, Guardian still requires current validation; a final read cannot
waive that mismatch. When formatting leaves bytes unchanged, direct prose
readback keeps its existing low-overhead completion path. Later settlement
cannot mutate a document whose owned deferred work finished before readback.

Set `PI_ADAPTIVE_EXECUTION=off` (or `0`) to restore established automatic
assistance and reviewer admission. Existing subsystem switches, configured
preferences and user opt-outs remain effective.

## Verification and benchmark

Run the policy, scheduler, helper and completion-review regressions:

```sh
PI_LOCAL_LM=off node --test tests/adaptive-execution.test.mjs tests/adaptive-observer.test.mjs tests/adaptive-thinking.test.mjs tests/adaptive-dispatch.test.mjs tests/automatic-helper-lifecycle.test.mjs tests/skill-discovery-runner.test.mjs tests/subagent-executor-routing.test.mjs tests/quality-review.test.mjs tests/lens-verification-order.test.mjs
PI_LOCAL_LM=off node agent/scripts/adaptive-execution-bench.mjs
```

The benchmark replays the actual observer scheduler for the same simulated
180-second task timeline and fixture responses, with and without the shared
policy. In its three fixtures, automatic reviewer dispatches and packet builds
change from 9 to 0 for direct work, 9 to 4 for complex work, and 9 to 7 for high
consequence work. Required capabilities remain deliberately callable.

These are measured dispatch counts in an offline replay. Packet token counts
are estimates from UTF-8 bytes divided by four. Local replay timing measures
scheduler evaluation only. This benchmark does not measure live model latency,
provider billing or end-to-end task completion; paired live CLI experiments
must report those separately.

## Tool exposure and assurance output in 0.18

Direct work stages a smaller core schema set while keeping file tools, discovery,
project verification, quality assessment and the complete bash background handle
family. Observed escalation restores the standard set at the next tool boundary.
Explicit discoveries, named core tools and core tools already used in the current
task survive simplification; caller tool restrictions and explicit CLI selections
remain authoritative. `PI_ADAPTIVE_EXECUTION=off` retains the standard set.

`project_tests` and `quality_review` return compact views by default;
`view:"detailed"` retrieves full retained state. Native snapshots, source hashes,
stale-evidence rejection and independent review requirements are unchanged.
Observed foreground test receipts retain bounded head/tail diagnostics with
explicit omission or protected-material withholding. Reviewers receive the current
planned receipts directly, so a test-only review needs no temporary log artifact.
Actual visual/interaction captures remain necessary for those claims.

CI runs `tool-efficiency-bench.mjs` to enforce the deterministic schema-count and
output-size contracts while preserving required checks and blockers. Its fixture
byte counts are prompt-overhead bounds, not estimates of model latency or billing.
