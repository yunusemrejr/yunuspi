# Search and session metrics

The detailed activity report includes distinct tools observed separately from total tool results. Replayed result IDs count once. Skill suggestions include both explicit workflow routes and catalog relevance matches; neither is a successful read or proof of application. Tool breadth describes activity and is not a quality score or usage quota. These counters do not prove that model behavior improved; guidance regression tests verify routing and delivery, not live task outcomes.

Web search returns results directly by default, without opening a browser or waiting for summary approval. Browser curation remains available through `workflow: "summary-review"`; `auto-summary` generates a separate summary without browser review. Existing explicit workflow preferences remain effective. Use `/curator off` to switch an existing installation to direct results.

Automatic provider selection tries the supported session model and then DuckDuckGo. DuckDuckGo tries its Lite endpoint followed by HTML, with a ten-second limit per endpoint, cancellation support, and bot-challenge detection. Custom result counts and recency filters no longer skip the OpenAI route. These fallbacks improve recovery; they do not guarantee provider availability. When every search fails, the tool reports an error and skips the summary and approval wait.

## Visible activity

The footer adds wrapped rows alongside existing traffic, estimated cost and cache statistics:

| Counter | Meaning |
| --- | --- |
| Swarms | Parallel groups with more than one child, including automatic helpers, native parallel results and executed `runs.all` calls |
| Fusions | Executed fusion operations; automatic helpers count only when at least two advisory outputs are combined. Forwarding one answer is not a fusion |
| Agents | Distinct accepted child runs, including async runs before completion, with a separate active count. Workflow controllers and planned children are excluded |
| Tools | Parent tool results, including blocked and failed calls |
| Errors | Parent tool/model errors, child-run failures and workflow-controller failures are labeled separately. Recovered errors remain in history |
| Skills | Successfully opened skills and suggested skills are labeled separately; the panel distinguishes full and partial reads. A suggestion is not evidence of use |
| Hook checks | Measured policy/context/tool checks, excluding streamed token notifications, UI/lifecycle observers and the telemetry observer; `?` means unavailable |
| Compact | Recorded compactions |

Run `/metrics` for a scrollable panel with tool counts, child outcomes, skill names, cache totals, reported reasoning tokens, hook errors and timings, and measured payload reductions. Use arrow keys, `j`/`k`, or Page Up/Down; close with Escape, Enter, or `q`. Viewing the panel does not add messages to model context.

Child status separates cumulative token traffic from current context occupancy and its peak. Cumulative traffic may exceed the model's context capacity across many turns. Observed progress reports completed tool results, failures, successful write calls and turns since the last successful write; these are activity evidence, not proof of correct edits or a runaway-loop diagnosis. Read-only work may make useful progress without any writes. Routine successful results omit the fan-out budget boilerplate; explicit status and failure details retain the budget.

## Interpretation and privacy

Counters use retained session entries and observed run transitions. Async launches count immediately; completion updates the same child instead of adding another. Queued, running, completed, failed, stopped, paused and unknown states appear in the panel. Persisted workflow activity survives reload and replaces earlier cumulative values by run identity. A single async reviewer does not add a swarm or fusion.

A workflow can fail before starting any children. Its controller failure is visible without incrementing Agents. A failure reported through a parent tool can appear in both labeled error categories; these are not additive totals. Historical controllers without a recorded outcome remain unknown.

Legacy search results in which every query failed count as errors even when their original success flag was incorrect. Missing historical child outcomes and hook measurements remain explicitly unknown. Cumulative hook snapshots are replaced per instrumentation segment, preventing duplicate totals after reload or compaction. Late events from an old session cannot update a new session. Older streaming/lifecycle callbacks are excluded when interpreting legacy hook totals. Hook checks include checks that returned no change; returned results are listed separately and do not prove useful intervention.

Earlier swarm/fusion telemetry used broader definitions, including reused groups or forwarding a single surviving answer. Those historical values appear separately as `+N legacy`; they are not silently relabeled as exact new operations. New instrumentation snapshots carry version 2 semantics.

Cached tokens still contribute to traffic. The panel's cumulative prompt cache rate differs from the existing footer's latest eligible response cache rate. Reported reasoning tokens are a subset of output, not additional traffic. Hook payload reduction measures characters removed at context and provider boundaries, with a four-characters-per-token estimate. Repeated projections can count the same content again; this is neither unique tokens removed nor billed savings.

New hook snapshots contain bounded numeric counters and extension/hook names. They do not capture prompts, tool outputs, secrets or reasoning text. Existing session files and logs remain private and must not be published.

## Harness corrections and activation

Automatic helpers prioritize the supplied brief within their four-call budget, use at most one directory listing before reading relevant source, and avoid searching session directories for context. Advisory helpers return concise findings or proposed checks; they do not produce work-acceptance reports or spend tool calls formatting them. The parent still verifies their claims. Writer acceptance checks remain separate. Report-only responses are not fused as findings.

UI/design requests receive relevant skill and browser guidance before generic utility hints consume the delivery budget. Incidental phrases and paths do not trigger unrelated utilities or skills. Successful skill reads are counted independently of whether a route receipt exists.

`render_see` is the existing bounded browser inspection tool; agents should call it directly without locating or installing Playwright. It supports DOM inspection and screenshots of local assets or HTTP(S), not interactive actions or GPU/WebGL rendering. Its fixed capture program uses a private temporary directory and Chromium's sandbox; the trusted extension publishes the final artifact. Normal project execution retains the harness write guard. Filesystem guards distinguish temporary-script permission changes and read-only inventories from destructive command targets while retaining protected-path checks.

The footer and hook loader use version-specific durable core patches for both SDK and bundled CLI entry points. Apply the normal runtime patches, then restart Pi and resume the session. `/reload` can reload extensions but cannot replace already loaded core modules. Hook measurements begin when the instrumented loader is active; they cannot reconstruct earlier invocations.

Distribution tests use synthetic records and exercise accounting, async transitions, skill-read evidence, hook behavior, patch idempotence and drift detection. Focused installed-harness integration tests additionally cover the registered browser tool under project launch permissions and actual workflow execution with mocked providers. Private session fixtures and audit reports are excluded from the public repository.
