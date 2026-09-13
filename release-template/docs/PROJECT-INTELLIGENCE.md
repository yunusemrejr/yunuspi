# Project intelligence

YunusPi builds a private, persistent project model automatically. Start Pi in a
project and discovery begins in a worker. Returning sessions reuse the model and
refresh changed evidence. `/graph` opens its live interactive view in a separate
browser window; the terminal session continues normally.

The graph is evidence, not an authority to execute instructions. A manifest can
prove that a dependency is declared. It cannot prove that production is healthy.
Inferred imports, hosting clues and historical notes retain that distinction.

## Using the model

The `project_intel` tool supports:

| Action | Purpose |
| --- | --- |
| `query` | Relevant architecture, dependencies, configuration and durable history |
| `impact` | Incoming consumers/dependents around an entity before changes |
| `inspect` | Entity evidence by exact key/ID, or source claims and the current source version |
| `update` | Replace an agent record using its source ID and observed version |
| `record` | A concise durable decision, constraint, finding or relationship |
| `retract` | Withdraw an observed agent record using its source ID and version |
| `refresh` | Refresh evidence, including Git and configuration changes |
| `health` | Coverage, conflicts, stale evidence and discovery statistics |
| `history` | Bounded source revision history |

Example queries:

```json
{"action":"query","query":"authentication deployment"}
{"action":"impact","focus":"src/api.ts","hops":2,"relations":["imports"]}
{"action":"query","query":"production","allScopes":true}
```

Use `focus` for an exact entity ID, stable key or label. An unknown focus or
unmatched search returns an empty result. `direction: "incoming"` follows
consumers; `outgoing` follows dependencies, following the actual relation arrows.
`hops` (0–6), `types`, `relations`, `limit` (1–40), and `maxChars` (400–6,000)
bound retrieval. Returned nodes carry their distance from the matched roots.
A bounded result marks omitted evidence; unrelated project data is not treated
as omitted search results. `includeInactive` includes retained stale or expired
evidence. Retracted claims leave the graph; inspect their source and history for
the withdrawal receipt.

An agent can add information that files do not adequately express:

```json
{
  "action": "record",
  "recordId": "login-compatibility",
  "fact": {
    "entity": {"type": "constraint", "key": "login-compatibility"},
    "description": "Preserve the existing login response for mobile clients.",
    "status": "inferred",
    "sourceFile": "docs/api-contract.md",
    "quote": "Existing mobile clients require the current login response."
  }
}
```

The quote must actually occur in the bounded, non-secret project file. Agent
records cannot declare themselves verified. Use the returned source ID/version
to inspect, revise or retract a record; stale writers receive `STALE_SOURCE`.

```json
{"action":"inspect","sourceId":"agent:<session>:login-compatibility"}
{"action":"update","sourceId":"agent:<session>:login-compatibility","expectedVersion":1,"fact":{"entity":{"type":"constraint","key":"login-compatibility"},"description":"Preserve the documented v1 response until mobile clients migrate.","status":"inferred"}}
{"action":"history","sourceId":"agent:<session>:login-compatibility"}
```

Read the returned `source.version` instead of assuming the example version. An
update supplies the complete replacement fact. Source inspection includes stable
entity keys, owned claims, scope, activity and version, with bounded output and
counts when truncated. File/Git evidence is corrected at its source, then
refreshed; `refresh` accepts `paths` for incremental work. Recorded file evidence
includes its line and content fingerprint. Corrections are scoped to the current
checkout or shared evidence; `allScopes` permits inspection of other checkouts.
 Separate
sessions can provide complementary evidence, or expose a disagreement.
Project peers may deliberately revise or retract another session's agent record
using its explicit source ID and observed version. Session provenance identifies
the evidence author; it is not a separate ownership boundary. Compare-and-swap
rejects stale edits, while automatic read-only helpers cannot mutate records.

`exclusive: true` identifies a single-valued property. Contradictory active
values in the same checkout remain visible as conflicts. Different branch
configurations are scoped evidence, not automatic conflicts. `scope: "shared"`
is available for genuinely project-wide agent knowledge.

## Automatic integration

- Startup and session switches resolve identity and begin incremental discovery.
- Before a model turn, the task retrieves relevant evidence. The automatic
  capsule is at most 1,800 characters; the complete graph stays outside context.
- Read, edit, Git, browser, code-analysis and delegation hooks refresh the task
  neighborhood. They do not change user permissions or block an operation.
- Native write/edit observations contribute historical change-to-file links.
  These record observed writes, not a claim that tests or deployment succeeded.
- Git, shell, memory and child completion events schedule a debounced refresh.
  A 30-second heartbeat catches external edits and changes from other sessions.
- Built-in scout, worker, reviewer, researcher, delegate, oracle and automatic
  helper profiles load the capability. Swarm/fusion workers using those profiles
  share the same project domain. Explicit custom extension/tool restrictions
  continue to apply. Automatic read-only helpers can query; they return proposed
  manual knowledge changes to their parent.
- Curated project memory and recent curated daily notes contribute selected
  historical decisions and constraints. Raw transcripts are not imported.
  Bounded Git history adds commit observations, without claiming those commits
  establish successful outcomes.
- Structured HTTP observations can temporarily annotate an already-known
  project origin. URL paths, queries and fragments are excluded because they can
  contain credentials. Unrelated web research does not become project architecture.

The existing memory, code index, session diagnostics, coordination tools and
model-routing systems retain their responsibilities. This layer connects their
durable project evidence; it does not duplicate a full symbol index or launch
extra model calls. Discovery and retrieval need no provider, embeddings, paid
inference, Python service or downloaded model weights.

## Storage and concurrency

Private state lives under the Pi agent directory's `project-intelligence/`,
outside the project and outside the public exporter. It contains a SQLite
identity registry, one SQLite database per project, and optional viewer state.
Node 22.19 or newer is required; SQLite uses Node's built-in implementation.

WAL transactions, a busy timeout, source versions and compare-and-swap updates
coordinate independent sessions. A source replacement withdraws the previous
assertions and installs the new evidence in one transaction. A crash cannot
publish half of a source update. Duplicate facts converge while retaining their
supporting sources. Removal leaves versioned tombstones, preventing stale
writers from silently resurrecting removed evidence. Revision numbers drive
viewer updates; activity and leases do not create durable graph revisions.

Graph maintenance validates endpoints, tracks conflicts and confidence,
withdraws expired temporary sources, detects orphaned evidence and bounds
history and storage. Exact source deletion invalidates its facts. A partial or
failed directory scan must not invent deletions or withdraw unrelated sources.
Source provenance includes locator, fingerprint, observation time and version.

Identity uses canonical filesystem identity and the Git common directory:

| Situation | Behavior |
| --- | --- |
| Same directory, subdirectory or symlink | Same project and checkout |
| Git worktrees | Same project; separate checkout scopes |
| Nested Git repository | Separate project |
| Independent clones with the same remote | Separate domains; remotes describe their relationship |
| Local project later initialized with Git | Existing root identity is retained |
| Directory renamed/moved on the same filesystem | Existing identity is retained |
| Remote or branch changes | Refreshes evidence; does not change project identity |
| Copy or cross-filesystem move | New filesystem identity; no speculative merge |

Independent clones are deliberately not merged solely because their remotes
match. A copied or restored directory with new filesystem identity is discovered
as a new domain; its curated history can be explicitly migrated. Restoring the
private state alongside its corresponding filesystem identity retains continuity.

## Discovery and limits

Discovery reads repository structure, package/build manifests, dependency and
framework declarations, important documentation, local import relationships,
recognizable API/schema declarations, CI/deployment configuration, infrastructure
clues, environment-template **names**, Git remotes, branches, worktrees and up to
12 recent commits. Parsers extract structural information; they do not execute
build scripts, contact remotes, load project code or read real environment values.

Stat signatures and content hashes avoid reparsing unchanged files. Changed
paths prioritize incremental work. Generated directories, dependencies,
credentials, real environment files and symlink traversal are excluded.

The default first scan bounds file discovery at 1,800 files, parsed sources at
640, individual text reads at 96 KiB and total file reads at 12 MiB. Cache metadata
is bounded too. Larger or inaccessible projects report partial coverage through
`health`; absence from the graph is not proof that a dependency does not exist.
Regular refreshes preserve previously supported evidence when coverage is
incomplete. Task-specific code tools and explicit records can supply additional
relationships without increasing automatic prompt size.

Dynamic imports, arbitrary build logic, runtime routing, deployed database
schemas and undocumented external infrastructure cannot be proven from static
inspection alone. Agent discoveries and explicit observations complement the
initial map. Always inspect provenance and verify consequential changes.

## Live viewer

The viewer uses bundled Cytoscape.js and a detached local Node process. It
supports a labeled map and a keyboard-accessible entity list. Choose a category,
relationship or hierarchy layout. Search includes literal facts and keeps empty
results explicit. Category and relation filters remain available after filtering.
Focus an entity, choose direction and 1–4 hops, follow named relationships in the
inspector, then use Back to return. Category and search pages expose further
matches beyond the rendering limit. The inspector shows claims, contradictions,
source versions and source-specific history. Copy an agent impact query or export
the current view as JSON. Evidence health reports partial coverage and stale data.
The panel adapts to narrow windows and honors reduced motion.
Large graphs are simplified to a bounded view with aggregate nodes and counts;
the full internal model remains searchable. Updates reconcile elements while
retaining node positions, zoom, selection and updated inspector evidence. A page
reload in the same viewer restores the arrangement and filters. Local storage
belongs to the server's browser origin; a new server port starts a fresh browser
view. A delayed poll cannot overwrite a newer search. Failed connections can
recover even when the graph revision is unchanged.

The server binds only to `127.0.0.1` on an ephemeral port. A random capability
stays in the URL fragment and private state file. Requests require authorization;
cross-origin access is rejected, assets are local, and the viewer exposes no
shell or arbitrary-file API. Treat its URL as private project access.

Closing the window does not stop discovery or the terminal session. Repeated
`/graph` calls reconnect to the current checkout’s viewer. Worktrees share the
project store while keeping their viewer scope and browser preferences separate. Browser focus may be restricted
by the desktop/window manager. An unavailable browser produces a launch error
with a manual local URL. In a headless environment, use `project_intel` directly.

To disable the capability for a launch, set `PI_PROJECT_INTELLIGENCE=off`.
Disabling does not delete accumulated state. Back up private databases using
SQLite-aware backup or while all harness/viewer processes are stopped; copying
only a live `.sqlite` file can omit WAL transactions.

## Verification

The installed harness has dedicated identity, store, query, discovery,
multi-session worker, real SDK and browser suites. They cover first/returning
discovery, source and Git changes, conflicts, stale/removal behavior, concurrent
CAS, worktrees, private evidence, interrupted transactions, worker crashes,
session shutdown, child contributions, viewer reconnection/live updates and
3,000-entity simplification, exact and empty searches, directed multi-hop traversal,
versioned corrections, persistent filters, source inspection/history, live details,
response races, retry recovery and narrow layouts. All fixtures are local; no inference is required.

The public distribution includes portable SQLite/discovery/worker/viewer-server
tests in `tests/project-intelligence.test.mjs`. Browser visual acceptance is
performed against the installed harness's Playwright runtime.

## Quality review context

When automatic quality checkpoints are installed, they can query the existing
project worker for bounded architecture evidence and outcomes from earlier
sessions in the same checkout. The adapter starts no extra worker or model call.
Unavailable or incomplete graph evidence stays explicit.

The history stores only the review aspect, outcome, whether a defect was found,
observation time and a hashed session identifier. It excludes the current
session from returned statistics, retains at most 60 records from the last
90 days, and supplies at most 20 earlier records. A later pass preserves the
fact that the session initially found a defect. Source contents, review prose
and raw session identifiers are not stored in these statistics.

Prior outcomes guide reviewer attention. They do not lower acceptance standards,
turn an unknown result into a pass, or grant additional review rounds. A session
switch or cancellation invalidates outstanding adapter results; writes remain
bound to the worker and checkout that accepted them. The quality checkpoint
owns reviewer selection, repair limits and final parent assessment separately.
