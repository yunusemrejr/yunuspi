# Action plans and bounded context

The existing `todo` tool owns the plan. Agents create or revise it for actionable requests without `/goal`: outcomes contain executable children, steps carry dependencies and acceptance checks, and follow-ups change affected nodes while preserving other work. Decomposition and choice of execution mode belong to the agent; the harness validates the resulting graph and state transitions.

`parentId` forms the hierarchy. `blockedBy` forms dependencies. `execution` is `self`, `subagent`, `swarm` or `fusion`; `owner` and `runId` identify the executor. These fields describe planned work and recorded native runs. They do not launch agents, grant permissions or prove that a run succeeded. Use the existing orchestration tools and review results. `files` declares scope; `refs` points to project facts, observations or source artifacts without copying the project map. `acceptance` describes verification; completing a task with acceptance requires `evidence`. Evidence is the agent's recorded observation, not independently certified truth.

Use `todo` with `action: "batch"` to apply up to 32 mutations atomically. Negative IDs on creates are local aliases for later operations in that batch:

```json
{
  "action": "batch",
  "operations": [
    {"action":"create","id":-1,"subject":"Improve search","acceptance":"Requested behavior verified"},
    {"action":"create","id":-2,"parentId":-1,"subject":"Inspect search behavior","execution":"subagent","refs":["project:search"]},
    {"action":"create","parentId":-1,"subject":"Implement and test","blockedBy":[-2],"execution":"self","files":["src/search.ts"],"acceptance":"Regression checks pass"}
  ]
}
```

The result returns actual IDs. Reuse them for updates. An invalid operation rolls back the entire batch. Parents and dependencies must exist; hierarchy and dependency cycles are rejected. A parent cannot finish with unfinished children. Starting or completing a step requires completed dependencies, including those of its ancestors. Reopen completed work after changed scope or failed verification; reopening clears old evidence from the current node while session history retains it. Reopen a completed parent before its children. Detach a child with `parentId: null` or explicitly delete it when it is superseded.

`todo list` defaults to a bounded tree; `view: "frontier"` returns active steps and pending steps whose dependencies and children are complete. `todo get` retrieves full fields. `/todos` shows the hierarchy, and the overlay identifies parent IDs and delegated modes. A compact orientation appears on user input and after recovery. The existing reminder cadence reconciles stale plans; no additional timer or planning model runs. Compaction receives a bounded plan excerpt; full snapshots remain retrievable from the active session branch. Omitted steps are never assumed complete.

## Shared directories

`session_coordinate` accepts up to 32 files or directories. Active todo nodes automatically publish a separate, bounded plan scope to live peer sessions in the same checkout. Manual objectives and notes remain separate. Oversized path records are represented by a covering common directory and marked `scopeCoarsened`; file coverage is not silently dropped. Completion releases automatic scope; recent-write evidence remains until cleared or expired. Plan notifications cannot change another session's objective. Peers' notes remain untrusted context.

When another independent session joins, the sibling notice includes a bounded digest of any peer objectives and file scopes already published; when none exist it points to one explicit `session_coordinate({action:"publish", ...})` call. The digest is advisory visibility, not a lock, instruction or ownership claim, and subagent forks remain excluded from sibling identity.

Before direct `edit` or `write` to an existing overlapping file, the harness requires a successful `read` receipt whose file fingerprint still matches. Failed, racing and stale reads cannot satisfy the check. This protects against a common lost-update case. It is not a filesystem lock: shell commands, external editors and the race after checking remain outside its coverage. Large overlapping files above 1 MiB need an isolated worktree. Native worktrees or a single writer remain the way to prevent concurrent writers. `PI_SIBLING_STALE_WRITES=off` restores advisory-only behavior.

## Local inference and context

Kompress can select exact complete paragraphs from eligible successful shell output and `.txt`, `.md` or `.rst` reads. Code, structured records, errors, truncation and attachments stay outside that new route. Negations, conditions, numbers, source references and attribution are protected. A deterministic upper bound rejects sources with insufficient possible savings before inference. An accepted extract must justify its local compute cost, or save at least 1,024 characters and 25% of the source after receipt overhead. The latter makes context savings available on cheap and free main routes. The existing loopback worker stays single-flight, rate-limited and resource-bounded. Its 450 ms client deadline, strict source-hash validation and raw-output fallback remain in force; local requests reject redirects. An incomplete projection references `obs_read`, which recovers original bytes. No generated summary replaces evidence.

Context salience now uses corpus-derived binary TF-IDF relevance, so common boilerplate carries less weight and repeating keywords earns no extra score. Goals, constraints, failures and unresolved work retain their protected priority. This runs in existing compaction, capsule and enabled memory-priming paths. `PI_CONTEXT_RANKER=lexical` restores the prior overlap scorer. The existing neural code-reuse ranker remains independently controlled by `PI_LENS_NEURAL_RANKER`.

Automatic compaction uses the selected model's full context window and fires at the inclusive 80% threshold. Output and safety reservations remain separate request-headroom diagnostics; recent-tail settings, model limits, summary validation and raw session history still apply. A provider overflow below 80% is surfaced as an error without an automatic summary; manual compaction remains available. Installers preserve existing user settings. This is a context policy, not a measured guarantee about answer quality or total session tokens. `PI_ACTION_PLAN=off` disables the automatic plan orientation, while the todo tool remains available. Existing local model installation and eligibility requirements still apply; public source does not ship model weights or enable an unavailable worker.
