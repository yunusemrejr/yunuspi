# Project Vector Memory

The workdir-level semantic memory spine. Each project owns one SQLite index
(`<projectsDir>/<project-id>/memory.sqlite`) holding parent-span text +
metadata, an FTS5 lexical index, and compatible Needle3 or OpenRouter
embedding vectors over semantic atoms. JSONL transcripts and
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
agent/extensions/lib/project-memory-embedder.ts local/remote transports, space contracts
agent/extensions/lib/project-memory-context.ts  session-scoped access for existing consumers
tests/project-vector-memory.test.mjs            storage, retrieval, family and extension tests
tests/project-memory-openrouter.test.mjs        transport, migration and failure contracts
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

Retrieval units and reading units are separate (schema v3). `chunks` are
parent spans — the reading units — carrying text plus provenance: source
type/path/range, session, commit, timestamps, validity bounds, concepts,
importance, confidence, authority, supersession links and content hash.
`atoms` are semantic atoms — the retrieval units — 200–800 character
fragments of one parent with char/line spans, each carrying its own
L2-normalized float32 vector. A query matches an atom; the agent reads the
parent. `chunks_fts` (FTS5, porter stemming) indexes parent title/text/
concepts in the same transaction. Vectors scan brute-force cosine over
normalized BLOBs — no sqlite-vec dependency; project-scale corpora
(thousands of chunks) answer in milliseconds.

Prose atoms split on paragraph/list boundaries; code atoms split on
blank lines and definition starts (types and functions at any indent,
top-level declarations only, so a mid-function statement never splits its
own function) and pack to the same target. Short parents stay a single atom
with byte-identical text. Legacy chunk-level vectors from schema v2 stay
searchable through the original scan; backfill atomizes a touched legacy
chunk and retires its chunk vector, so databases converge without a bulk
rewrite. Opening an old database never re-embeds anything.

Concurrent sessions share one DB file: WAL + `busy_timeout=10s` lets writers
queue instead of failing, and registry updates serialize on an atomic-mkdir
lock (stale locks expire; a stuck lock never blocks resolution).

## Embedding configuration and migration

`PI_MEMORY_EMBEDDER=openrouter` is the enabled default, using
`qwen/qwen3-embedding-8b`. Remote service failure never prevents lexical recall;
compatible stored Needle3 vectors can serve as a local fallback.
`PI_MEMORY_EMBEDDER=auto` prefers healthy Needle3, then OpenRouter, and pins the
first successful space for that session owner.
`PI_MEMORY_EMBEDDER=needle` selects local embeddings explicitly.
`PI_MEMORY_EMBEDDING_MODEL` overrides the default OpenRouter model.
OpenRouter credentials reuse the existing provider key resolver (configured
OpenRouter key, then `OPENROUTER_API_KEY`). `PI_OFFLINE=1` prevents remote calls.

OpenRouter uses `/api/v1/embeddings`, not completions. Requests batch up to 16
texts, each at most 2,000 characters after redaction. Qwen query inputs use its
[documented retrieval instruction](https://huggingface.co/Qwen/Qwen3-Embedding-8B);
document inputs remain plain. A bounded cache reuses identical sanitized inputs.
Each operation has an eight-second deadline; transport, authentication, rate
limit, malformed/partial response, non-finite vectors, zero vectors, model and
dimension mismatches fail without breaking lexical memory. Failed transports
cool down; cancellation does not poison provider health. Usage includes actual
provider token and cost fields, including paid responses rejected by validation.

Embedding inputs are atom texts (title plus fragment), so every embedded
unit fits the transport whole — no more semantically invisible tail text.
A single index call embeds at most 96 atoms; the remainder stays lexical
until backfill. Schema v3 migrates existing SQLite databases additively.
`embedding_spaces` persists backend, full model, representation version,
observed dimension and creation time. Each atom records its space and
embedding timestamp. Dimensions are learned from real responses and pinned;
equal dimensions alone never imply compatible vectors. Existing Needle3 data
remains readable. Each atom has one vector: explicitly migrating it replaces
that vector while retaining its text, content hash and parent provenance.
Different chunks can coexist in different spaces, and retrieval only compares
compatible ones.

For a Qwen migration, select OpenRouter in the session configuration and call:

```text
project_memory_reembed backend=openrouter model=qwen/qwen3-embedding-8b limit=32
```

Repeat to resume until `remaining=0`. The limit is 1–256 chunks; successful
batches are durable, interrupted batches remain eligible, and unchanged compatible
content is not embedded again. This tool does not change the session's configured
backend. Unchanged content re-indexed after a model change is also eligible for
bounded backfill. Queries never implicitly upload the existing corpus. If Qwen
is unavailable, retrieval can use existing compatible Needle3 atoms or legacy
chunk vectors; otherwise FTS5 still serves. It never compares a Qwen query
against Needle3 document vectors.

Automatic ingestion also embeds failed remote batches with Needle3 when healthy, preserving the distinct local space. Those chunks remain eligible for OpenRouter backfill; each later settled turn adds at most four earlier eligible chunks to its bounded batch, even when no new events arrived. Compatible local vectors are reused during cooldown. Explicit `project_memory_reembed` remains an exact-backend operation. Status distinguishes remote progress, local fallback embeddings and remaining remote work. Automatic recall waits at most 900ms for semantics, then returns lexical history within the existing 1200ms consumer budget. The single query embedding may finish in the background (bounded to eight seconds) and supplies later role consumers from the same session cache. Switching or closing the session cancels that work; foreground deadline expiry does not repeatedly cancel otherwise healthy provider requests.

Raw tool-result exhaust and automatic file-edit markers stay lexical. Explicitly
indexed code and durable decisions, corrections, architecture, observations,
regressions, errors, summaries, commits and todos remain eligible. Credential
files and symlink paths are refused. Shared redaction removes known key formats,
private keys, authorization headers, credential assignments, credential URLs,
JWTs and secret environment values before remote transmission. Only bounded
retrieval text is sent; repositories are not uploaded automatically.

`project_memory_status` and `/project-memory` show the selected backend/model,
observed dimension, vector spaces and counts, Qwen3/Needle3/unembedded counts,
backfill progress, lexical/vector/reranker state and the last embedding error.
Embedding and recall events also enter the existing health/activity surfaces.
Deadline expiry is reported as a timeout with provider cooldown; an actual session abort remains cancellation. Status never makes a provider request.

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
| completed assistant response (`agent_end` → `agent_settled`) | `observation` | final report only, labeled unverified; errors/tool calls/aborts excluded |
| compaction (`session_compact`) | `session_summary` | committed `compactionEntry.summary`, importance 0.9 |
| `project_memory_remember` | any | curated, authority ≥ 0.8 |
| `project_memory_index_path` | `code`/`architecture` | hash-changed chunks only |

Type weights keep raw exhaust below curated knowledge: decision 1.0,
architecture 0.95, concept/session_summary 0.9, convention 0.85,
observation/bug 0.8, commit/error 0.7, user_request/code 0.6, todo 0.5,
tool_result 0.35. Secrets (tokens, keys, long opaque blobs) are redacted
before indexing and never stored raw.

The queue (cap 200) persists all queued lexical events on `agent_settled`; embedding work is bounded to eight new chunks plus four eligible backlog chunks. Shutdown and switch cancel optional inference and drain the captured lexical tail before closing the old database. Every hook is budgeted and isolated: indexing failures surface
as health notes, never session errors. `PI_PROJECT_MEMORY=off` disables all.

## Retrieval

Hybrid pipeline: FTS5/BM25 lexical candidates (exact identifiers, commit
shas) plus compatible semantic candidates (atom vectors merged with legacy
chunk vectors, collapsed to the best fragment per parent), fused by
reciprocal rank, scored by role policy (type weights × recency × authority
× importance), then one shared Needle re-rank over the merged head. Without
embeddings the lexical baseline still serves; degradation is reported in
`stats.degraded`, never silent. The optional re-ranker remains local Needle.
Short exact technical lookups with strong lexical evidence skip embeddings
and reranking. Longer natural questions omit common stop words without
removing terms from literal queries.
For Qwen3, a conservative cosine floor (0.42), a band within 0.08 of the best
candidate and at most eight candidates keep weak semantic tails out of fusion.
Those admitted candidates receive a 1.5 RRF weight; existing role/importance/type
weights still apply. Needle's compressed cosine scale does not use Qwen's gates. Tombstoned/superseded chunks stay retrievable for provenance at
×0.25 score unless `include_superseded`.

Search returns compact candidates — id, type, score, provenance and the
matched fragment centered on the query terms — not full bodies. Each hit
carries its matched atom id and fragment in `details` plus an `atoms`
admission count in `stats` for retrieval tracing. Full parent evidence
(text, atom map, adjacent source blocks, supersession chain) lives behind
`project_memory_read`. Automatic priming still inlines bounded slices, so
background recall pays no extra round trip.

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
| `project_memory_search` | compact hybrid candidates (`query`, `role`, `types`, `limit`, `since`, `include_superseded`, `scope`) |
| `project_memory_read` | expand one memory id (`id`, `context`, `source`, `history`); chunk or atom ids, family-wide |
| `project_memory_remember` | record a durable typed fact (`text`, `type`, `title`, `path`, `concepts`, `importance`, `supersedes`) |
| `project_memory_status` | identity, chain, chunk/atom counts, backend health |
| `project_memory_index_path` | index a repo file (regular files ≤ 500 KiB, no symlinks) |
| `project_memory_forget` | tombstone by id (provenance kept, restorable) |
| `project_memory_restore` | clear a tombstone |
| `project_memory_reembed` | controlled compatible-vector backfill (`backend`, `model`, `limit`) |
| `project_memory_consolidate` | cluster + ratify canonical facts (dry-run default) |

`/project-memory` prints status plus recent entries. Subagent children get
search + read + status (query and read; the parent session is the sole
writer, mirroring the harness child-mutation policy).

## Consolidation

`project_memory_consolidate` (or `findClusters` + `consolidate`) groups
near-duplicate same-concept chunks (Jaccard ≥ 0.5, or cosine ≥ 0.92 with
compatible stored vectors and Jaccard ≥ 0.25), picks the canonical survivor (highest authority, then newest),
boosts it to authority 1.0, and tombstones members with backlinks. History
is never deleted. Dry-run by default; agent-authored canonicals via
`project_memory_remember` with `supersedes=[…]` always outrank engine output
(the engine ratifies, never invents). It reuses persisted vectors — legacy
chunk vectors, or mean-pooled atom vectors for atom-only chunks — and makes no
embedding requests; proposed clusters remain reviewable in dry-run output.

## Consumer integration

**Main agent and subagents.** The existing once-per-session memory priming
flow includes cited project-vector history using the `main` or `subagent` policy.
`/memory-prime` still controls that flow. Previous-session follow-ups are carried only for an explicit continuation or when their terms match the new request; their completion status is unknown until verified. Search/status tools remain available for
explicit recall; children cannot mutate memory.

**Observer and Watchmaker.** Each accepted task starts one bounded background
recall using its role policy. These background consumers can await the same query for up to eight seconds without holding the main turn; foreground priming retains its shorter wait. Repeated periodic reviews reuse the result. The
observer receives previous mistakes, corrections, constraints and rejected
approaches; Watchmaker receives historical progress evidence. Results pass through
the existing evidence packets and byte budgets and cannot create requirements.
Session-owner and task-generation guards reject stale replies.

All consumers call the session-scoped vector-memory owner. Identical task queries
share one embedding across all four policy views and the project family, without
extra remote reranking calls. Recall includes timestamps and matched fragments, labels earlier user requests and unverified assistant reports, and explicitly gives the current user request precedence. Historical requests may already be complete or superseded; memory does not make them active tasks again. Automatic priming waits at most 1.2 seconds; slow
or unavailable helpers leave the session running normally. Structural code questions
still belong to AST/LSP/project-intelligence tools.

**Other extensions.** Import from `lib/project-*.ts` (same directory, no
new dependencies beyond `node:sqlite` + `typebox`). Reuse
`testEmbedder()` for hermetic tests; never depend on live Needle assets in
unit tests. Index writes go through `indexEvent`/`indexFile` with content
hashes; never write `chunks`/`atoms` rows by hand.

## Failure behavior

| Condition | Behavior |
|---|---|
| Needle missing/unhealthy | auto can select OpenRouter; otherwise lexical recall and controlled backfill |
| OpenRouter unavailable or incompatible | compatible local vectors or lexical retrieval, with explicit health state |
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

## Reproducible comparison

Run `node scripts/benchmark-project-memory.mjs --live` to compare lexical-only,
lexical + real Needle3, and lexical + real OpenRouter Qwen3. Only the checked-in
public synthetic fixture is transmitted. The script reports relevance ranks,
false-positive occupancy, indexing/query latency, calls, tokens and current
provider pricing. Reranking is disabled equally for the three configurations.
See [the measured report](PROJECT-MEMORY-EVALUATION.md) for results and limits.
