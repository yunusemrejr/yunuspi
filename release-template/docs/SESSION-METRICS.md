# Search and session metrics

Web search returns results directly by default, without opening a browser or waiting for summary approval. Browser curation remains available through `workflow: "summary-review"`; `auto-summary` generates a separate summary without browser review. Existing explicit workflow preferences remain effective. Use `/curator off` to switch an existing installation to direct results.

Automatic provider selection tries the supported session model and then DuckDuckGo. DuckDuckGo tries its Lite endpoint followed by HTML, with a ten-second limit per endpoint, cancellation support, and bot-challenge detection. Custom result counts and recency filters no longer skip the OpenAI route. These fallbacks improve recovery; they do not guarantee provider availability. When every search fails, the tool reports an error and skips the summary and approval wait.

## Visible activity

The footer adds wrapped rows alongside existing traffic, estimated cost and cache statistics:

| Counter | Meaning |
| --- | --- |
| Swarms | Parallel groups with more than one child, including automatic helpers, native parallel results and executed `runs.all` calls |
| Fusions | Executed fusion operations; automatic helpers count only when they provide usable evidence |
| Agents | Distinct recorded child runs, deduplicated across result and accounting receipts |
| Tools | Parent tool results, including blocked and failed calls |
| Errors | Parent tool and model errors; the detail panel separates hook and child failures |
| Skills | Distinct skills recorded as fully read; routed recommendations appear separately in the panel |
| Hooks | Measured extension-handler invocations, or `?` when telemetry is unavailable |
| Compact | Recorded compactions |

Run `/metrics` for a scrollable panel with tool counts, child outcomes, skill names, cache totals, reported reasoning tokens, hook errors and timings, and measured payload reductions. Use arrow keys, `j`/`k`, or Page Up/Down; close with Escape, Enter, or `q`. Viewing the panel does not add messages to model context.

## Interpretation and privacy

Counters use retained session entries. Legacy search results in which every query failed count as errors even when their original success flag was incorrect. Missing historical child outcomes and hook measurements remain explicitly unknown. Cumulative hook snapshots are replaced per instrumentation segment, preventing duplicate totals after reload or compaction. Late events from an old session cannot update a new session.

Cached tokens still contribute to traffic. The panel's cumulative prompt cache rate differs from the existing footer's latest eligible response cache rate. Reported reasoning tokens are a subset of output, not additional traffic. Hook payload reduction measures characters removed at context and provider boundaries, with a four-characters-per-token estimate. Repeated projections can count the same content again; this is neither unique tokens removed nor billed savings.

New hook snapshots contain bounded numeric counters and extension/hook names. They do not capture prompts, tool outputs, secrets or reasoning text. Existing session files and logs remain private and must not be published.

## Harness corrections and activation

Automatic helpers now prioritize the supplied brief within their four-call budget, use optional skill references only for specific uncertainties, and avoid searching session directories for context. Helpers without live-system tools return proposed checks for the parent. Skill routing ignores incidental path tokens in scoped intent matching. Filesystem guards distinguish temporary-script permission changes and read-only inventories from destructive command targets while retaining protected-path checks.

The footer and hook loader use version-specific durable core patches for both SDK and bundled CLI entry points. Apply the normal runtime patches, then restart Pi and resume the session. `/reload` can reload extensions but cannot replace already loaded core modules. Hook measurements begin when the instrumented loader is active; they cannot reconstruct earlier invocations.

Distribution tests use synthetic records and exercise accounting, hook behavior, patch idempotence and drift detection. Private session fixtures and audit reports are excluded from the public repository.
