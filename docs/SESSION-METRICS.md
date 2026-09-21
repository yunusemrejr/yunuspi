# Search and session metrics

The detailed activity report includes distinct tools observed separately from total tool results. Replayed result IDs count once. Skill suggestions include both explicit workflow routes and catalog relevance matches; neither is a successful read or proof of application. Tool breadth describes activity and is not a quality score or usage quota. These counters do not prove that model behavior improved; guidance regression tests verify routing and delivery, not live task outcomes.

Web search returns results directly by default, without opening a browser or waiting for summary approval. Browser curation remains available through `workflow: "summary-review"`; `auto-summary` generates a separate summary without browser review. Existing explicit workflow preferences remain effective. Use `/curator off` to switch an existing installation to direct results.

Automatic provider selection tries the supported session model and then DuckDuckGo. DuckDuckGo tries its Lite endpoint followed by HTML, with a ten-second limit per endpoint, cancellation support, and bot-challenge detection. Custom result counts and recency filters no longer skip the OpenAI route. These fallbacks improve recovery; they do not guarantee provider availability. When every search fails, the tool reports an error and skips the summary and approval wait.

## Visible activity

The footer keeps two compact activity rows alongside existing traffic, estimated cost and cache statistics:

| Counter | Meaning |
| --- | --- |
| Agents | Distinct accepted child runs, including async runs before completion, with a separate active count. Workflow controllers and planned children are excluded |
| Failures | Total parent, child and workflow-controller failures when present; the compact suffix labels them `P`, `C` and `W`. Recovered errors remain in history |

Run `/used` for a readable separate-window overview: its native expandable sections show current and previously used model routes, skill-read status, deduplicated child-agent details, tool failures, Harness activity and session totals. Run `/errors` for the deep newest-first error list with failed payloads, owning modules, causes and a copyable JSON block. Run `/metrics` for the denser scrollable diagnostic panel with swarm/fusion activity, tool counts, child outcomes, skill names, cache totals, per-model routes and configurations, reported reasoning tokens, hook errors and timings, and measured payload reductions. Use the mouse wheel, arrow keys, `j`/`k`, Page Up/Down, or Home/End (`g`/`G`); close with Escape, Enter, or `q`. All are stable snapshots. Viewing any of them does not add messages to model context.

The first sections show grouped failure categories and recovery clues, recent error excerpts and call IDs, the largest tool outputs, exact repeated request/result pairs, skill-read gaps, current review evidence and the slowest/erroring hooks. Failure totals continue beyond the 12-excerpt limit; up to 16 groups are shown with explicit omissions. A generic guard refusal does not hide a more specific budget or argument problem.

Compact child accounting retains failure category, attempt count and output presence. Diagnostics use that evidence even when a later lifecycle receipt only says `failed`, without copying raw child prompts or output into telemetry.

Failure and context-traffic sections use the newest 2,000 current-branch entries; cumulative activity and hook sections use all retained entries. The panel labels these scopes. Raw returned characters precede context projection and do not measure billed savings. Identical observations can be legitimate polling or verification. Agents can request the eight largest traffic contributors through `session_self({view:"efficiency"})`; no raw tool arguments or result excerpts appear in that view.

The Models section lists every route the session used, one row per `provider/model` with turns, input/output/cache-reuse tokens and error counts. Each row also shows the thinking levels that route ran with, its OpenRouter backend routing pins (`OR:`) and any automatic recovery endpoint, recorded at each selection boundary; the live row is marked `● current`. Routes without a recorded configuration show turns and tokens only — thinking and routing are never reconstructed by guessing. Compaction and branch-summary traffic names no route, so it appears as an explicit unattributed row rather than being assigned to a neighbor. `/export-json` carries the same table in machine-sortable form (`analytics.routes`, plus `summary.modelsUsed` and the configured current model), alongside the `modelTrail` of model and thinking-level changes.

## Terminal scrolling

Automatic full redraws in the regular terminal renderer preserve scrollback and repaint the visible tail, including after content shrinks or the terminal resizes. This prevents redraws from erasing the history while it is being read. Old terminal rows remain historical snapshots; corrections to content that has already scrolled off screen are reflected in the retained session transcript. The fullscreen renderer has its own scroll view. Restart Pi after applying the core patch; extension reload alone cannot replace an already loaded renderer.

Child status separates cumulative token traffic from current context occupancy and its peak. Cumulative traffic may exceed the model's context capacity across many turns. Observed progress reports completed tool results, failures, successful write calls and turns since the last successful write; these are activity evidence, not proof of correct edits or a runaway-loop diagnosis. Read-only work may make useful progress without any writes. Routine successful results omit the fan-out budget boilerplate; explicit status and failure details retain the budget.

## Interpretation and privacy

Counters use retained session entries and observed run transitions. Async launches count immediately; completion updates the same child instead of adding another. Queued, running, completed, failed, stopped, paused and unknown states appear in the panel. Persisted workflow activity survives reload and replaces earlier cumulative values by run identity. A single async reviewer does not add a swarm or fusion.

A workflow can fail before starting any children. Its controller failure is visible without incrementing Agents. A failure reported through a parent tool can appear in both labeled error categories; these are not additive totals. Historical controllers without a recorded outcome remain unknown.

Legacy search results in which every query failed count as errors even when their original success flag was incorrect. Missing historical child outcomes and hook measurements remain explicitly unknown. Cumulative hook snapshots are replaced per instrumentation segment, preventing duplicate totals after reload or compaction. Late events from an old session cannot update a new session. Older streaming/lifecycle callbacks are excluded when interpreting legacy hook totals. Hook checks include checks that returned no change; returned results are listed separately and do not prove useful intervention.

Earlier swarm/fusion telemetry used broader definitions, including reused groups or forwarding a single surviving answer. Those historical values appear separately as `+N legacy`; they are not silently relabeled as exact new operations. New instrumentation snapshots carry version 2 semantics.

Cached tokens still contribute to traffic. The panel's cumulative prompt cache rate differs from the existing footer's latest eligible response cache rate. Reported reasoning tokens are a subset of output, not additional traffic. Hook payload reduction measures characters removed at context and provider boundaries, with a four-characters-per-token estimate. Repeated projections can count the same content again; this is neither unique tokens removed nor billed savings.

## Micro-intelligence metrics

The `micro_status` tool and `/export-json` `analytics.micro` section expose
the cheap-layer ledger: Needle head-slice re-rank counts by stage
(tool/skill/command/intent), acceptance outcomes, shadow vs applied mode,
embedding latency buckets, per-engine evidence outcomes (retained,
offered, skipped, abstain reasons), advisory batches by family, pre-screen
verdicts by label, and token-window allocations for Smol and Kompress.
The `projectedCharsSaved` and `projectedTokensAvoided` fields estimate
characters not forwarded plus sandbox outcome categories; they use the
same four-characters-per-token convention and are not billed savings.
Bounded numeric counters only: no prompts, tool outputs, vectors, or
secret-bearing strings are retained in telemetry snapshots.

New hook snapshots contain bounded numeric counters and extension/hook names. They do not capture prompts, tool outputs, secrets or reasoning text. Existing session files and logs remain private and must not be published.

## Harness corrections and activation

Automatic helpers prioritize the supplied brief within their four-call budget, use at most one directory listing before reading relevant source, and avoid searching session directories for context. Advisory helpers return concise findings or proposed checks; they do not produce work-acceptance reports or spend tool calls formatting them. The parent still verifies their claims. Writer acceptance checks remain separate. Report-only responses are not fused as findings.

UI/design requests receive relevant skill and browser guidance before generic utility hints consume the delivery budget. Incidental phrases and paths do not trigger unrelated utilities or skills. Successful skill reads are counted independently of whether a route receipt exists.

`render_see` is the existing bounded browser inspection tool; agents should call it directly without locating or installing Playwright. It supports DOM inspection and screenshots of local assets or HTTP(S), not interactive actions or GPU/WebGL rendering. Its fixed capture program uses a private temporary directory and Chromium's sandbox; the trusted extension publishes the final artifact. Normal project execution retains the harness write guard. Filesystem guards distinguish temporary-script permission changes and read-only inventories from destructive command targets while retaining protected-path checks.

The footer and hook loader are maintained in YunusPi-owned core source shared by the SDK and CLI. Build and install the reviewed YunusPi source, then restart YunusPi and resume the session. `/reload` can reload extensions but cannot replace already loaded core modules. Hook measurements begin when the instrumented loader is active; they cannot reconstruct earlier invocations.

Distribution tests use synthetic records and exercise accounting, async transitions, skill-read evidence, hook behavior and owned-core source invariants. Focused installed-harness integration tests additionally cover the registered browser tool under project launch permissions and actual workflow execution with mocked providers. Private session fixtures and audit reports are excluded from the public repository.
