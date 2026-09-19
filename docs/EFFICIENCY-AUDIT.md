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
