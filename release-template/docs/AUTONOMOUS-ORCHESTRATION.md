# Autonomous orchestration

Skill routing, child
tasks, fan-out, reviews, hooks, the session observer, project vector memory,
Guardian and WASM checks retain their existing owners and lifecycle.
Configuration and deliberate user selections retain priority.

## Bounded capability retrieval

The shared tool, command, capability and observation ranker resolves an exact
authorized identifier before optional inference. Ambiguous pools of six or
more entries use one batched JEV ranking/existence request first; smaller pools
retain Needle/local selection with JEV as a fallback. Candidate sets are built
by the authorized caller; every candidate survives refinement.

Optional refinement has a 6-second total budget and a 2-second ceiling per
stage. A stuck stage releases its consumer so another helper can run within
the remaining budget. Cancellation reaches local and remote judgment clients;
shared embedding work may finish for its other consumers. A late rejection is
observed, and expired or cancelled work cannot activate tools. Internal callers
can set `timeoutMs` and `stageTimeoutMs` on `multiStageRetrieve` when a workload
has a different latency budget.

JEV promotion requires the full candidate distribution: all and only the
provided identifiers, finite values in [0, 1], a sum of 1 within numerical
tolerance, and a selected option with the highest probability. Existing
relevance thresholds still apply. This implements the documented
[TypeSafe Choice contract](https://docs.typesafe.ai/primitives/choice);
probabilities are selection evidence, not proof that a task is correct.

## Cancellation and memory recall

Project-memory recall stops waiting promptly on
cancellation, including cancellation triggered inside the helper itself.
Late transport failures remain handled. Memory consumers retain their role
policies and existing store; recalled text stays untrusted evidence.

The observer reviewers using `max` or `ultra` effort now step down
after truncated responses and recover after clean reviews within the original
configured ceiling. Mandatory reviews, error evidence, review receipts and
the one-deferral limit on JEV review triage are preserved.

## Verification

Behavioral tests cover incomplete distributions, escaping, large catalogs,
stage/total deadlines, ignored cancellation, late rejection, exact identifiers,
tool-activation freshness, memory ownership and reviewer effort adaptation.
