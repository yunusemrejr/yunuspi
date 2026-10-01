# Autonomous orchestration

Automatic helpers remain enabled by default. Admission follows the current
task's scope, uncertainty, errors and user constraints. Skill routing, child
tasks, swarm/fusion, reviews, hooks, session observer, Watchmaker, project vector
memory, Guardian and WASM checks retain their existing owners and lifecycle.
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

## Skill selection and recovery

The skill scout supplies candidate names/descriptions in shared JEV state.
Both its choice question and its existence question see those descriptions.
Descriptions are sent once, and an exact serialized-size check includes JSON
escaping and criteria overhead. Oversized catalogs retain the most relevant
entries within the 32,768-character input cap and the 255-option API limit.
An inconclusive partial catalog retains the existing bounded child fallback.
Valid JEV selections can avoid that child. The agent still resolves the
installed identifier and reads the skill before applying it.

Skill judgments and project-memory recall stop waiting promptly on
cancellation, including cancellation triggered inside the helper itself.
Late transport failures remain handled. Memory consumers retain their role
policies and existing store; recalled text stays untrusted evidence.

Observer and Watchmaker reviewers using `max` or `ultra` effort now step down
after truncated responses and recover after clean reviews within the original
configured ceiling. Mandatory reviews, error evidence, review receipts and
the one-deferral limit on JEV review triage are preserved.

## Verification

Run the dispatch-count workload with:

```sh
node agent/scripts/orchestration-bench.mjs
node agent/scripts/orchestration-bench.mjs --baseline /path/to/previous/retrieval.ts
```

The synthetic workload contains 100 exact-name requests and 100 ambiguous
requests over 27 authorized candidates. The previous path dispatches 100 JEV
and 100 Needle calls for the exact-name workload; the current path dispatches
zero. Both settle the ambiguous workload with 100 batched JEV calls and zero
local fallbacks. These are dispatch counts, not measured model time or token
savings. A live three-skill PostgreSQL example selected the SQL workflow using
one JEV request, with 496 provider-reported input tokens and no child launch.

Behavioral tests cover incomplete distributions, escaping, large catalogs,
stage/total deadlines, ignored cancellation, late rejection, exact identifiers,
tool-activation freshness, memory ownership and reviewer effort adaptation.
