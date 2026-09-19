# Harness efficiency and reliability audit

This pass follows the owned-core migration at `4a22b32eccf42573bdcf7eb7c6f0b35a9df344eb`.
Changes target observed defects and redundant work, with independent Luna subsystem
investigations and integration review. The six core packages remain YunusPi-owned;
the historical Pi 0.85.1 baseline and release authority are unchanged.

## Scope and findings

The manifest contains 36 standalone extensions and six extension forks, exposing
45 loadable entrypoints. All entrypoints load together against the owned SDK and
retain unique tool ownership. All 154 shipped skill manifests and local references
were checked. Core changes focus on compaction; dependency/build and compatibility
checks cover all six core packages. This is subsystem coverage, not a claim that
every line of every bundled parser or external dependency received manual review.
Historical patch fixtures remain offline tests, not runtime patch installers.

| Area | Observed problem | Applied change |
| --- | --- | --- |
| Helper coordination | A second coordinator's cache/assist/escalation APIs had no production callers; its status ledger was always empty | Removed the 209-line duplicate module and write-only bookkeeping; retained helper-owned caches and production metrics |
| Smol | Large framed prompts approached the tiny model's context limit, omitted the task, and repeated identical rows | Bound the complete prompt to 1,024 bytes, include task terms, retain whole candidate lines, deduplicate exact repeats, and constrain offered source IDs |
| Smol lifecycle | Repeated polling and unbounded caller wait values could waste work or stall rendering | Wait on completion with a finite deadline; preserve the first raw/selected seal |
| Jev | Model-catalog discovery preceded even a working preferred route or cache hit | Try known routes and cache first; discover only after model rejection; stop recovery aliases on transport/auth failures |
| Jev cancellation | Cancellation during catalog lookup could be missed before a paid judgment | Detach a cancelled waiter promptly and recheck cancellation before transport; reject malformed and oversized input before paying |
| Memory | Unbounded reads could fill context; malformed writes and lock cleanup had edge cases | Bounded reads with exact continuation pages, bounded nonempty writes, cancellation checks, and tolerant lock release |
| Project context | Snapshots queried the same scoped sources twice; worker dispatch had a cancellation race | Reuse one query and visibility timestamp; reject cancellation before dispatch |
| Compaction/recovery | Invalid usage totals could defeat context accounting; circular tool arguments could crash estimation; expired recovery retained a controller | Validate finite nonnegative counts, tolerate unserializable arguments, clear expired recovery ownership |
| Browser/network | Discarded redirect bodies retained streams, authenticated DNS checks missed cancellation, redirect bounds accepted invalid values | Release discarded bodies, propagate cancellation, validate a finite redirect limit |
| Skills | Local ranking hid catalog entries after position 256; one bundled reference was missing | Index every supplied local skill; provide an independently authored timeline starter and validate all local skill references |
| Installation | Launcher swallowed non-source update commands; updates rejected model-environment symlinks and copied large private trees | Route only explicit source updates to the source updater; move private state intact during activation with rollback and preserve source conflicts |

Memory source remains retrievable in full. Model selections are incomplete exact
extracts, never authoritative summaries. Required facts, task matches, source hashes,
original observations, and provider-visible history seals remain independently checked.
Local customizations and credentials are excluded from public export.

## Measurements and limits

Local Smol tests used the installed 135M Q2_K model and synthetic data. Three initial
fixtures reached the five-second timeout without an accepted extract. With the bounded
prompt, two produced valid source projections (3,461 to 571 characters and 3,423 to
317 characters) in approximately 3.25 seconds and 0.77 seconds; the third abstained in
0.90 seconds. These are individual observations, not a latency percentile or general
accuracy estimate. Additional relevance spot checks were weak. The change does not
claim reliable semantic judgment from this model, lower confidence thresholds, or
measured production dollar savings. A result arriving after first exposure only warms
the exact source/task cache; it cannot rewrite earlier provider context.

Jev regression tests prove that successful preferred/cache paths make zero catalog
requests and that cancelled/invalid inputs do not issue a later judgment. Exact-input
concurrency deduplication still pays for one request. No new general-model micro-call
or additional reviewer was introduced by these changes.

## Verification

Targeted regressions cover helper availability and evidence, paging, source conflicts,
cancellation, compaction accounting, recovery, redirects and the complete skill inventory.
The final local run passed all 736 tests with no skips, including the installed Needle
assets. The owned-core build compiled 1,138 source files across six packages. Clean-export
and staged Git privacy scans passed, along with offline compatibility and installation checks.
Live activation verifies the committed source identity, normal launchers, all extension
entrypoints and local helper health, while preserving private state and local overrides.

## Follow-up lifecycle and release audit

A subsequent bounded Luna audit started from `b0f85977b88866cacf2af9b9c7080bad79752779`.
It examined orchestration and task dependencies, execution isolation, model refresh
cancellation, memory and local intelligence, hook accounting, tool registration,
and the installation/public-export boundary. This is targeted subsystem coverage,
not a claim that every remaining bug or external-provider failure has been eliminated.

The verified fixes are:

- Background task output directories follow the current project and session;
  telemetry launches honor the registry's configured child launcher.
- Deleting a prerequisite still referenced by a live task is rejected. Removing
  its dependency links and deleting it in an atomic batch remains supported.
- Local model catalog callers can cancel independently. Canceled older requests
  cannot overwrite a newer catalog when their response parsing completes late.
- Guarded shell processes receive an isolated device filesystem, preventing writes
  to the host's shared-memory directory through a writable device bind mount.
- Public exports retain the session HTML/CSS templates and the referenced motion
  starter. Unrelated HTML stays excluded. An unused core retry backup was removed.
- Source updater flags without a source fail with usage guidance, rather than
  starting a Node process that can consume terminal input as JavaScript.
- Hook accounting removes indexes when their dispatch leaves the retained window,
  while preserving duplicate counts for dispatches whose displayed rows were capped.

Focused regression coverage includes installer rollback and private-state
preservation, public-export privacy, core identity/session exports, background
work, task graphs, local catalogs, real namespace isolation, Git/web/utility tools,
and memory/project intelligence/Smol/Jev/Needle behavior. All 45 declared extension
entrypoints loaded against the owned runtime with 91 unique tools and no duplicate
registrations. Structural host verification passed. These checks do not establish
live provider availability or production semantic quality for every local model.

### Historical-session follow-up

Private-session review found repeated stale-text and overlapping-batch edit
rejections across multiple model/provider routes. The current core already rejects
overlapping edits safely and explains how to merge them, but the existing skill
and recovery-guidance owner did not recognize that error wording. Its narrow
matcher now treats overlap failures as edit-recovery events, with the same bounded
advisory and cooldown behavior as stale or partially applied edits. Exact matching
and concurrent-change protection remain enforced.

Historical provider penalties for output-length stops and invalid thinking-suffix
model IDs are already corrected in the current routing owner; this audit did not
reintroduce route penalties, model rankings or universal skill-read requirements.
Different task types, provider failures, harness versions, injected context and
shell-based skill reads make raw route counts unsuitable as competence scores.
New regression inputs are synthetic. Private prompts, sessions and their detailed
analysis remain outside the public distribution.
