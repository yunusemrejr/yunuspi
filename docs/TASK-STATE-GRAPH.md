# Task State Graph

> Git is the canonical state of the code.
> The Task State Graph is the canonical state of the work.

## Problem

Major harness subsystems independently reconstructed task reality from raw
transcripts, local caches, and partial interpretations: requirements from
prompts, completion state from todo snapshots, repeated failures from
tool-error scans, verification state from scattered receipts. Each
reconstruction could disagree with the others, and none carried provenance.

## What it is

An event-sourced, per-session task graph with stable ids and explicit
provenance. It **records and exposes** state, relationships, and evidence. It
is not a governor, decision-maker, permission broker, or orchestrator:
existing components keep their own decisions and read shared state instead of
re-deriving it.

```text
raw events / evidence
        ↓
Task State Graph
        ↓
┌────────────┬────────────┬────────────┬────────────┐
Main Agent   Observer     Watchmaker   Subagents
Reviews      Guardian     Expert       Completion
```

Pipeline:

```text
harness events → typed ingest mappers → events.jsonl (append-only)
        ↓
deterministic reducer (pure, testable)
        ↓
materialized graph (in-memory + snapshot.json)
        ↓
bounded projections (per-consumer budgets)
```

## Concepts

- **Entities** (~21 kinds): task, requirement, constraint,
  inferred-constraint (never a literal user requirement), subtask, decision,
  assumption, question, work, attempt, failure (with stable family keys),
  artifact, tool-exec, child, peer, review, finding, verification, evidence,
  completion-claim, gap.
- **Provenance** (~17 sources): literal-user, prompt-analysis, main-agent,
  tool-output, source-inspection, test-result, render-inspection, subagent,
  observer, watchmaker, expert-director, guardian, review-council,
  project-memory, project-intelligence, sibling-session, session-history.
  A model claim is not test evidence; a subagent statement is not verified;
  history is not instruction.
- **Status**: proposed, active, implemented, partially-verified, verified,
  failed, blocked, superseded, invalidated, unknown. Transitions follow an
  explicit allow-list; impossible transitions are recorded, never applied.
  Terminal entities are history: writers supersede, never rewrite.
- **Links**: implemented-by, affects, verified-by, caused-retry-of, based-on,
  satisfies, challenges, supersedes, caused-by, child-of, evidences, blocks,
  invalidates, relates-to.
- **Evidence bindings**: file + version, hashes, commits, toolCallIds, test
  commands, observation/render/child/review ids. A newer file version stales
  bound evidence and cascades requirement verification back to
  partially-verified — verified claims are re-earned, never inherited.
- **Idempotency**: every event carries a stable id; replays and double
  delivery are no-ops. Equal-timestamp batches keep log order (upserts before
  the links that reference them).

## Neighboring systems (not merged)

- **Task State Graph** = current task truth/state (live, per session task).
- **Requirement ledger** = authoritative deterministic requirement split; the
  graph adopts its R-ids instead of inventing parallel ones.
- **Todo system** = owns executable planning, dependencies, acceptance
  criteria, execution modes, status transitions; todo results become linked
  `work` entities.
- **Project intelligence** = persistent project structure/history/decisions.
- **Project vector memory** = retrievable project/session knowledge.
- **Transcript/observations** = auditable raw history/evidence.
- **Checkpoints/snapshots** = recovery state; the graph snapshots alongside
  compaction/shutdown and reloads on resume.

## Integrations

| Consumer | What it reads | How |
|---|---|---|
| Main Agent | `task_state`: status, requirements, unresolved, evidence, work, entity, blockers, failures, decisions, diagnostics, assess | bounded reads; explicit evidence assessment |
| Operator | `/task-state` summary + entity drill-down | TUI command |
| Observer | reviewer projection: requirements × verification, decisions, assumptions, failures, child findings, claims, contradictions, stale evidence | `task-state` packet row (1500 chars) |
| Watchmaker | progress projection: active work, attempts, repeat families, blocked deps, completed investigations | `task-progress` packet row (time-kind budget) |
| Subagents | per-child slice: goal, relevant requirements/decisions/files/failures/evidence + required output/verification | appended to native briefs at dispatch; results return with subagent provenance, never auto-verified |
| Completion gate | requirement-level blockers (`task state: R2 implemented but unverified`) | additive to existing receipts; claims recorded as `completion-claim` entities |
| `/metrics` | entity/link/requirement/stale/failure counts + degraded flags | session-report line |
| Guardian / Expert | cheap reads via `currentTaskStateService()` (failure families, contradictions, entity attach) | API available; hot paths untouched |

Writes are automatic from harness events: user input (+ ledger sync),
prompt-analysis relation (follow-up vs new-task vs correction), todo results,
file edits/writes (file versions), test-like/failed commands, subagent
dispatch + results, quality-review findings, project-test assessments, and
completion-gate evaluations. Routine passing non-check commands and read-only
traffic are deliberately not indexed (telemetry noise).

### Accountable requirement assessment

The graph reads the checkpoint owner's persisted `requirement-ledger-v1`
receipt after input hooks finish. It never parses the model-only ledger
rendering into another requirement list. A valid empty receipt retires the
reviewer packet's old requirements. Prompt analysis must match the current
request ID; a delayed result from an earlier request cannot rotate the task.
Rotation archives earlier ledger IDs so cumulative session receipts cannot
reintroduce another task's scope, including after recovery.

Successful tool execution records an observation, not requirement coverage.
The main stream can inspect `work` and `evidence` for retained entity IDs,
then use `assess` with one current R#, 1–8 completed implementation IDs,
1–8 native evidence IDs and a concrete coverage reason. Unknown IDs, child
advice, failed or stale checks, retired requirements and incomplete bindings
are rejected. The main agent retains responsibility for whether the check
actually covers the required behavior. A passing build does not establish
visual quality, playback correctness or artistic approval.

For tracked file changes, checks bind source versions and hashes observed
before execution and still matching at the result boundary. Assessment
rechecks the current source; changed files cannot inherit old checks. Source
reads are bounded to 32 regular files of at most 1 MiB each inside the
checkout, with symlink containment and replacement checks. Unknown or
oversized sources cannot support this assessment path. Source bindings do
not prove check coverage or exclude a transient external change and revert
between observations; there is no continuous external-edit watcher.

Unmapped requirements remain visible as unresolved guidance. The additional
completion receipt applies only to mapped implementation, linked evidence
or explicit failed/blocked requirement state. Creative and research tasks
without a task-graph evidence producer retain their existing quality gates
and can close a todo without being forced into irrelevant code checks.

An assessment's links, status transitions and main judgment share one JSONL
record. Failed append rolls back the in-memory assessment. Repeating an
unchanged ledger or accepted assessment adds no duplicate log records.
Background checks remain active until a completed receipt supplies exit
zero; their launch bindings survive recovery. Child async launches stay
active until retained native results arrive. Partial failure, cancellation
and timeout stay distinguishable in their retained summaries; status queries
and other management actions create no child work.

Check detection uses the existing literal shell tokenizer. A runner mentioned
inside a quoted argument, a help/list/dry-run command, or a pipeline/`;`/`||`
whose final exit could mask the check cannot mint passing evidence. These
commands may still execute normally; only the evidence claim is conservative.

## Task lifecycle

- First user input opens the task (literal-user objective).
- Follow-ups continue it; corrections supersede the overlapped prior
  requirement while preserving history; genuinely new tasks (prompt-analysis
  `unrelated`/`replace`/`interrupt`, or explicit new-task cues) rotate to a
  fresh graph with the prior task archived on disk and linked via rotation
  record.
- New-task vs follow-up reuses the prompt-analysis relation vocabulary when
  available, with small deterministic cue fallback. Default is continuity: a
  small follow-up never erases scope.

## Persistence and failure semantics

- Per-session storage under `~/.pi/task-state/<session>/<task>/`
  (`PI_TASK_STATE_DIR` overrides): `events.jsonl` (append-only truth),
  `snapshot.json` (materialized view, tmp+rename), `meta.json`.
- Snapshots are an optimization. A corrupt snapshot is quarantined aside and
  the view rebuilds deterministically from the event log; skipped log lines
  are counted, never fatal.
- Snapshots carry a byte cursor and digest of the accepted log prefix. Resume
  replays only its tail; a replaced or truncated prefix rebuilds the graph.
  Legacy snapshots with an available log rebuild once. Session identity and
  materialized shape are validated before loading. An interrupted final log
  line is preserved for diagnostics and separated from the next append.
- Total storage failure degrades to memory-only operation with visible
  `degraded` health. Every API is fail-open: graph trouble never breaks user
  input, tool calls, reviews, dispatch, compaction, or shutdown.
- Concurrent root sessions keep separate graphs; nothing merges across
  sessions unless explicitly linked.

## Bounds and budgets

- 2000 entities / 5000 links / 20000 tracked event ids per task (soft caps
  with health warnings, not crashes).
- Event membership uses an in-memory index and retains a recent bounded
  window after the ID cap. Snapshot cursors preserve replay correctness
  beyond that window; full rebuilds also deduplicate the complete log.
- Projections carry hard char budgets (default 2000; observer 1500;
  watchmaker 420; child slice 1500) with item caps. The whole graph is never
  injected into context.
- The graph is deterministic: no model calls, no background LLM. Cheap
  intelligence (Needle/local-LM/Jev) is never required for correctness.

## Diagnostics

`/task-state` shows requirements (verified / implemented-unverified /
unresolved), work, current vs stale evidence, attempts and repeated failure
families, and review findings. `task_state` action `diagnostics` (and
`collectDiagnostics`) reports dangling links, duplicate requirement/decision
titles, stale evidence, contradictions, impossible transitions, orphaned
child results, unlinked verification, and completion claims without
requirement coverage.

## Files

- `agent/extensions/lib/task-state/types.ts` — entity/provenance/status/link
  vocabulary, event envelope, materialized view shape.
- `agent/extensions/lib/task-state/reducer.ts` — pure deterministic
  fold + transition contract + staleness cascade + requirement roll-up.
- `agent/extensions/lib/task-state/ingest.ts` — pure harness→event mappers,
  stable ids, failure families, follow-up classification.
- `agent/extensions/lib/task-state/projections.ts` — pure bounded
  per-consumer renderers + diagnostics.
- `agent/extensions/lib/task-state/store.ts` — JSONL + snapshot persistence,
  quarantine/rebuild, resume listing.
- `agent/extensions/lib/task-state/file-evidence.ts` — bounded, contained,
  stable source hashing without retaining source text.
- `agent/extensions/lib/task-state/service.ts` — session-scoped service,
  typed API (`record`, `link`, `updateStatus`, `invalidate`, `supersede`,
  `query`, `project`, …), lifecycle, fail-open wrappers.
- `agent/extensions/task-state.ts` — `task_state` tool, `/task-state`
  command, harness event wiring.
- `tests/task-state-graph.test.mjs` — reducer/ingest/projection/store
  behavioral contracts (19 tests).
- `tests/task-state-integration.test.mjs` — live consumption by main agent,
  Observer, Watchmaker, subagents, reviews, completion gate, metrics (15
  tests).
- `tests/task-state-recovery.test.mjs` — long-log replay, interrupted writes,
  foreign/malformed snapshots, replaced logs, native session scopes and
  invalid verification evidence.
- `tests/task-state-assessment.test.mjs` — actual owned runtime/ledger hook
  ordering and write/bash tools, accountable assessment and recovery, stale
  source, partial append, task isolation, async children and background checks.

## Known limitations

- Reviewer-finding targets and requirement↔evidence links are best-effort:
  links whose endpoints are still unknown are dropped with a warning rather
  than invented. Coverage improves as more producers emit typed events.
- Guardian and Expert Director have read/attach APIs but no hot-path
  behavior change yet; their existing logic is untouched.
- Sibling-session exchange is represented (`peer` entities, `sibling-session`
  provenance) but no automatic cross-session linking is performed.
- Durable promotion of task outcomes into project intelligence/memory is a
  future step; the graph holds live task truth only.

## Verification of the recovery and evidence pass

Targeted command (after building the owned core):

```sh
PI_LOCAL_LM=off node --test tests/task-state-{graph,integration,recovery,assessment}.test.mjs tests/requirement-ledger.test.mjs
```

The native test loads the actual checkpoint ledger and task-state factories
into the owned ExtensionRunner/SessionManager in reversed input-hook order.
It also executes owned write/bash tools against a temporary module and a
real Node assertion, then checks assessment, duplicate delivery and recovery.
Other fixtures deterministically inject interruption, source replacement,
delayed analysis, asynchronous terminal failures and corrupt persistence.
No provider call or private installed state is needed.

A controlled local reducer comparison with baseline `960c9586`, Node
v24.21.0, 20,005 unique follow-up events and three alternating trials observed
median folding time of 1,342.39 ms before versus 6.66 ms after the membership
index. Every trial retained sequence 20,005. This synthetic hot-path result
measures event membership, not overall harness latency, model quality,
token use or billing. Real workloads have other costs.
