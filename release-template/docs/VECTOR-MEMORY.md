# Project Vector Memory

The workdir-level semantic memory spine. Each project owns one SQLite index
(`<projectsDir>/<project-id>/memory.sqlite`) holding chunk text + metadata,
an FTS5 lexical index, and Needle3 embedding vectors. JSONL transcripts and
Markdown stay the auditable source of truth; this store is a lossy,
rebuildable **index over project history**, never the authority.

Session is no longer the unit of memory — the project is. A new session
starts conversationally empty but immediately reconnects to its project's
index, including memories recorded by earlier sessions.

## Files

```text
agent/extensions/pi-vector-memory.ts            extension: tools, /project-memory, session hooks
agent/extensions/lib/project-identity.ts        stable project ids, chains, descendants
agent/extensions/lib/project-vector-store.ts    SQLite schema, FTS5, vector similarity
agent/extensions/lib/project-memory-index.ts    chunking, enrichment, events, embeddings
agent/extensions/lib/project-memory-retrieve.ts hybrid retrieval, role policies, families
agent/extensions/lib/project-memory-consolidate.ts clustering + canonical facts
tests/project-vector-memory.test.mjs            33 tests (mirrored to release-template/tests)
```

## Storage layout

Default projects root is `<agentDir>/projects` (`PI_PROJECTS_DIR` overrides;
`PI_CODING_AGENT_DIR` overrides the agent dir) — under the agent dir so
installer state preservation, backups and containment treat project
memories like every other private state. Set
`PI_PROJECTS_DIR=~/.pi/projects` for the literal `~/.pi/projects/<id>/`
layout from the original proposal:

```text
projects/
  registry.json                 identity-key -> project id + anchor roots
  <project-id>/memory.sqlite    chunks + FTS5 + vectors (WAL mode)
```

One table (`chunks`) carries text plus provenance: source type/path/range,
session, commit, timestamps, validity bounds, concepts, importance,
confidence, authority, supersession links, content hash, embedder id, and the
L2-normalized float32 vector. `chunks_fts` (FTS5, porter stemming) indexes
title/text/concepts in the same transaction. Vectors scan brute-force cosine
over normalized BLOBs — no sqlite-vec dependency; project-scale corpora
(thousands of chunks) answer in milliseconds.

Concurrent sessions share one DB file: WAL + `busy_timeout=10s` lets writers
queue instead of failing, and registry updates serialize on an atomic-mkdir
lock (stale locks expire; a stuck lock never blocks resolution).

## Project identity

Resolution walks up from the workdir collecting anchors; the **nearest**
anchor wins, so root/subdir/symlink spawns share one DB:

1. explicit `.pi-project-id` file (walked up; symlinks refused),
2. git `origin` remote (normalized: scheme/user/port/`.git` ignored),
3. generated UUID, auto-written to `.pi-project-id` at the project root
   (git root, else nearest marker dir: package.json, pyproject.toml,
   Cargo.toml, go.mod, … — markers anchor, never split).

Nested projects chain: a subfolder with its own id file or its own remote
is its own project, chained to its ancestors
(`resolveProjectChain` → `[primary, …ancestors]`). Repeated ids collapse.
The same dir's git remote cross-links to its explicit id, so a second clone
shares the project. Sub-projects register their anchor roots, so a parent
discovers descendants (`findDescendantProjects`) even across moves.

`PI_PROJECT_ID_AUTO=off` disables id-file writes (registry path-aliases
still converge). `PI_PROJECT_ID_GIT=off` skips remote lookups.

## What gets indexed

Event-driven and incremental — content hashes skip unchanged material, so
only new chunks are embedded:

| Event | Chunk type | Notes |
|---|---|---|
| user prompt (`input`) | `user_request` | first 2000 chars; `/commands` skipped |
| tool error (`tool_result`) | `error` | tool + compact input + 800-char excerpt |
| file edit (`tool_result`) | `code` | path marker; full text via `project_memory_index_path` |
| `git commit` (`tool_result`) | `commit` | command + output excerpt |
| compaction (`session_compact`) | `session_summary` | summary text, importance 0.9 |
| `project_memory_remember` | any | curated, authority ≥ 0.8 |
| `project_memory_index_path` | `code`/`architecture` | hash-changed chunks only |

Type weights keep raw exhaust below curated knowledge: decision 1.0,
architecture 0.95, concept/session_summary 0.9, convention 0.85,
observation/bug 0.8, commit/error 0.7, user_request/code 0.6, todo 0.5,
tool_result 0.35. Secrets (tokens, keys, long opaque blobs) are redacted
before indexing and never stored raw.

The queue (cap 200) flushes in batches of 8 on `agent_settled`, shutdown,
and switch. Every hook is budgeted and isolated: indexing failures surface
as health notes, never session errors. `PI_PROJECT_MEMORY=off` disables all.

## Retrieval

Hybrid pipeline: FTS5/BM25 lexical candidates (exact identifiers, commit
shas) plus Needle cosine candidates, fused by reciprocal rank, scored by
role policy (type weights × recency × authority × importance), then one
shared Needle re-rank over the merged head. Without embeddings the lexical
baseline still serves; degradation is reported in `stats.degraded`, never
silent. The re-ranker is local Needle, not remote JEV: retrieval stays
offline and free, and JEV remains available as an opt-in escalation for
judgment calls, mirroring its role elsewhere in the harness. Tombstoned/superseded chunks stay retrievable for provenance at
×0.25 score unless `include_superseded`.

Role policies (`role` param) — same store, different ranking:

- `main` (default): broad project recall, mild recency.
- `observer`: mistakes/regressions/issues/constraints first (error/bug ×1.6,
  observation ×1.4, decision ×1.3; code/tool_result down).
- `subagent`: task-focused code/architecture/decisions; session chatter down.
- `watchmaker`: progress/timing evidence (summaries ×1.6, commits/todos ×1.4).

Scores rank candidates; they prove nothing. Every hit cites
`[id] type · path:lines · commit · date · authority`, and rendered output
frames retrieved text as untrusted evidence to verify, never instructions.

Family scope (`scope`, default `family`): retrieval fans out to ancestor
and descendant project DBs (weights self 1.0 / ancestor 0.85 / descendant
0.75), so a general project sees sub-project memories and vice versa.
Family stores open per search (never created; missing ones skipped), so
DBs created mid-session join without a restart. `scope=project` isolates.
Siblings are excluded by design.

## Tools (main session)

| Tool | Purpose |
|---|---|
| `project_memory_search` | hybrid retrieval (`query`, `role`, `types`, `limit`, `since`, `include_superseded`, `scope`) |
| `project_memory_remember` | record a durable typed fact (`text`, `type`, `title`, `path`, `concepts`, `importance`, `supersedes`) |
| `project_memory_status` | identity, chain, counts, backend health |
| `project_memory_index_path` | index a repo file (regular files ≤ 500 KiB, no symlinks) |
| `project_memory_forget` | tombstone by id (provenance kept, restorable) |
| `project_memory_restore` | clear a tombstone |
| `project_memory_consolidate` | cluster + ratify canonical facts (dry-run default) |

`/project-memory` prints status plus recent entries. Subagent children get
search + status only (query and read; the parent session is the sole
writer, mirroring the harness child-mutation policy).

## Consolidation

`project_memory_consolidate` (or `findClusters` + `consolidate`) groups
near-duplicate same-concept chunks (Jaccard ≥ 0.5, or cosine ≥ 0.92 with
vectors), picks the canonical survivor (highest authority, then newest),
boosts it to authority 1.0, and tombstones members with backlinks. History
is never deleted. Dry-run by default; agent-authored canonicals via
`project_memory_remember` with `supersedes=[…]` always outrank engine output
(the engine ratifies, never invents).

## Consumer integration

**Main agent.** Tools are registered in-session; search before implementing
in unfamiliar subsystems, remember durable decisions after. No code changes
needed.

**Subagents.** `project_memory_search` (role `subagent`) and
`project_memory_status` are available in children. Child prompts that need
project context should name the subsystem; retrieval handles the rest.

**Session observer** (`agent/extensions/session-observer.ts`,
`lib/session-observer.ts`, `lib/observer-book.ts`). Programmatic access
from any lib/extension module — no tool round-trip:

```ts
import { openProjectStore } from "./project-vector-store.ts";
import { needleMemoryEmbedder } from "./project-memory-index.ts";
import { retrieveProjectMemory } from "./project-memory-retrieve.ts";
import { projectDbPath, resolveProjectIdentity } from "./project-identity.ts";

const identity = resolveProjectIdentity(ctx.cwd);
const store = openProjectStore(projectDbPath(identity), { projectId: identity.id });
try {
  const { hits } = await retrieveProjectMemory(store, focusText, {
    role: "observer", limit: 5, embedder: needleMemoryEmbedder(),
  });
  // hits[].chunk: { id, source_type, source_path, text, authority, … }
} finally {
  store.close();
}
```

Suggested observer query shape: "previous mistakes, regressions, unresolved
issues, or architectural constraints relevant to <current focus>". Keep the
observer's existing lexical/Needle selection as the primary signal; project
memory is corroborating cross-session evidence. Recording durable observer
insights: `indexEvent(store, id, { kind: "observation", … })`.

**Watchmaker** (`agent/extensions/session-watchmaker.ts`,
`lib/session-watchmaker.ts`). Same import surface with `role: "watchmaker"`
and progress-oriented queries ("recent outcomes, commits, stalls, open work
for <task>"); family scope shows sub-project progress too. Watchmaker's
time-only packet stays authoritative — memory adds cross-session progress
context, never timestamps.

**Other extensions.** Import from `lib/project-*.ts` (same directory, no
new dependencies beyond `node:sqlite` + `typebox`). Reuse
`testEmbedder()` for hermetic tests; never depend on live Needle assets in
unit tests. Index writes go through `indexEvent`/`indexFile` with content
hashes; never write `chunks` rows by hand.

## Failure behavior

| Condition | Behavior |
|---|---|
| Needle missing/unhealthy | lexical-only retrieval; chunks stored unembedded; `reindexEmbeddings` backfills later |
| `node:sqlite` unavailable | tools report "unavailable"; session unaffected |
| corrupt `registry.json` | quarantined to `registry.corrupt-*.json`; explicit/git keys re-resolve |
| schema mismatch | open throws with versions; extension reports outage via status |
| concurrent writers | WAL + busy timeout queue; registry lock converges fresh ids |
| stuck registry lock | proceeds unlocked after 2 s (last-writer-wins, next resolve converges) |

## Repository files vs live state

`agent/extensions/{pi-vector-memory.ts,lib/project-*}` and this doc are the
durable source. `~/.pi/agent/projects/` (registry + per-project SQLite) is
runtime state: never commit it, never export it. `scripts/install.mjs
--apply` installs the extension; `--preserve-state` keeps memory across
reinstalls.
