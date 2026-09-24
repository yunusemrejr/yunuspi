# Session guidance and diagnostics

`tool_search({})` includes structured shortcuts to skills, the ability index and local ML/SLM helpers. Ability previews provide an `inspect` argument object for the next `tool_search` call; tool, skill and ability pages report `nextOffset` (`null` at the end). Skill results point to the chosen `path` for reading. Preview pages omit empty detail fields; exact capability lookup explains entrypoints, options, related abilities and live tool registration. The `local-intelligence` entry distinguishes callable context helpers from automatic statistical ranking and optional Kompress preprocessing. Browsing does not activate tools, load models or run inference. Before browser/screenshot/DOM work, web research, jq/Python data reads or past-session/memory questions, use `tool_search` with `enable:true` when the specialized tool is not already active; those capabilities are commonly installed but intentionally off-wire.

Default capability and workflow guidance offers one concrete optional match per category through the existing coalescing and cooldown limits. Workflow hints retain the installed path and a bounded description or discovery reason; rank-derived and asynchronous workflow hints keep their concrete skill identity instead of collapsing into a generic discovery topic. When a suggested skill is already tracked by the review owner, the hint can point to `skill_review({action:"inspect"})` for its checks. Capability hints retain the useful operation and explain explicit schema activation only when needed. Operational safety, recovery and quality guidance remains specific when necessary. Relevant UI and browser guidance is delivered before generic utility hints exhaust the prompt budget. Skill suggestions are distinct from successful skill reads. Guidance starts with three ordinary suggestions, gains one more opportunity per four tool results during sustained work, and stops at twenty ordinary suggestions per user turn. Delivery stays limited to two hints per message, with one additional recovery slot. This is a ceiling on guidance, never a target for tool calls or skill reads.

Explicit tool, command and skill search preserves short domain terms such as
PHP, API, CSS and SQL. Exact names and word-boundary matches outrank incidental
description matches; API does not match “capital,” and board does not match
“keyboard.” Skill search retains fuzzy fallback after direct metadata matches.
Searching reads metadata only and does not activate or execute a capability.

Task-level suggestions remain pending until the next prompt; file-related cues expire after four tool steps and new edits can refresh them. The pending queue holds at most 32 candidates. A bounded history of 96 delivery receipts prevents repeated suggestions without permanently disabling guidance in long sessions. Active tools are checked again at delivery; successful execution suppresses tool hints, while agent discovery and status calls do not count as execution. Manual reminders preserve their configured content and cadence.

Routes cover disposable sandbox experiments, structured data, Git inspection, HTTP diagnostics, system probes, repeated edits, background execution, readiness, task dependencies, child discovery and supported fusion. Web form guidance uses `web_probe` for read-only reconnaissance; it does not submit forms or provide browser login state. Children receive the same principle of matching each phase to their own tools and supplied skills, without inheriting the parent's permissions. Native tasks, chains, shared briefs, completion notifications and fusion helpers remain the owners of orchestration. Automatic-assistance planning also recognizes deployment, release/publication and migration work as potentially useful independent work, subject to the same capability, route and cost gates. Hooks distinguish management from execution and attach short guidance to native parallel runs, form probes and task tracking.

Use the tools and skills needed to complete and verify the task. Existing descriptions and `session_self {view:"runtime"}` provide current availability; do not create another script, queue or capability registry when a supported owner already fits. Code edits can surface scoped diagnostics and structured-file reads can surface `data_query` even when the original prompt did not name those tools. Simple tasks need no catalog tour.

Ambient reminders emit no empty check-in or generic soft-check-in header. Todo nudges include bounded task IDs, titles and status from the current session branch, rather than an unexplained pending count. Compaction file-state notes prioritize unresolved evidence and summarize settled history; `checkpoint_read` retrieves the full retained records.

`session_self {view:"efficiency"}` gives the eight largest tool-text contributors and exact repeated request/result counts for a bounded branch window. This is a way to choose focused inspection and reuse retained evidence; repeated verification is not automatically waste. Structured results from context, reasoning, skill-review and quality-review tools use lossless JSON whitespace compaction at context assembly, including string-form results. Original results, number lexemes, string contents and tool-call pairing stay unchanged. Extractive handoff capsules collapse only exact duplicates with the same source and protection state. Compaction retries append retention guidance once per preparation object and preserve original messages and prior summaries.

Environmental `render_see` startup failures suppress further render suggestions for that session, including across reload and compaction. A successful render clears that state. Missing files, selectors and text emitted by an inspected page do not establish that the renderer is unavailable. The bounded renderer remains usable directly after its environment has recovered.

Automatic diagnostics use retained baseline and verified changed-line evidence to distinguish new findings from unchanged or out-of-scope findings. Suppressed findings are summarized; explicit diagnostic inspection remains available. An unknown first-scan history is not treated as proof that a finding was pre-existing. New parser errors still receive their normal severity.

Open-redirect rules are review warnings, not proof that a runtime target lacks validation. Safe literal internal paths are excluded; dynamic and protocol-relative targets remain review candidates. The scanner does not claim general taint analysis. Scanner execution status is informational; actual scanner failures remain visible. HTML tag-pair checks continue to reject malformed containers and accept legal whitespace before a closing tag's `>`.

Long located grep/ripgrep matches receive bounded excerpts with emitted source pointers. Compound-command lines that are not search matches remain available. Original tool records are preserved and can be retrieved with `obs_read`; an excerpt is never represented as complete source content. Source reads and patches retain their separate handling.

Shell-write observations happen after the command and are labeled post-write audits. The verified-read guard accepts native `read` and supported Lens source-reading tools; shell `cat`, `sed` and `grep` do not establish guard coverage. Rejection text explains that requirement. These wording changes do not weaken read-before-edit or atomic preflight checks.

See [native delegation and independent file checks](SUBAGENT-CONTRACTS.md), [session metrics](SESSION-METRICS.md), and the [execution boundary](SECURITY.md). Restart Pi and resume an existing session to load the updated extension and core modules.

Fresh installations expose Pi's built-in `grep`, `find` and `ls` alongside file
editing and bash, so searches and listings can use structured arguments. Child
thinking defaults to `low`; explicit model/thinking selections and economy
budgets remain authoritative.

`session_self {view:"failures"}` inspects at most 2,000 recent branch entries and
returns up to 12 model, tool, child or workflow diagnostics with recovery clues.
Cancellation and failed work are distinct. Child/controller reports are
reconciled so replayed receipts do not create extra failures; missing historical
evidence remains unknown. The same collector backs the zero-inference
`session_audit` tool and `agent/scripts/session-audit.mjs` command for historical
audits. The tool defaults to exact canonical workspace matching; `scope:"all"`
explicitly requests a harness-wide aggregate. It returns counts without prompt
bodies, error excerpts or paths. Discovery, file size and retained entries are
bounded, and cancellation stops further work. The CLI retains its explicit
operator-oriented all-session default and accepts `--scope workspace`.

Session hooks are bounded and advisory. They avoid duplicate concurrent hints,
discard abandoned calls on lifecycle changes, and cannot fail a tool because a
telemetry sink is unavailable. Delegation recovery preserves successful siblings;
background guidance encourages completion notifications and owned task IDs.

Bash routing defaults to advisory annotations for simple commands. Hints are
bounded, stop after successful use of the suggested native tool, and abstain
when the active tool catalogue fails. Explicit `PI_BASH_ROUTER=soft|hard`
settings retain enforcement. Compound shell workflows remain available.

Native tools stay the default posture: a shell-heavy stretch with no native
inspection tool in the window earns one tiny once-per-session nudge through
the normal hint budget, and the session-start orientation names tool
preference once. A strong stuck pattern (same fix four or more times, or four
or more consecutive errors with multi-cause or loop evidence) earns at most a
single bounded error-review suggestion; transient failures and trivial work
stay quiet. Trivial formatting, linting or cleanup requests never trigger
automatic reviews or councils. See [Reviews and councils](REVIEWS-AND-COUNCILS.md).

Independent review emits transient tool progress with each aspect's state and the
remaining deadline; these updates do not enter model context or start turns. A
repair round receives only its assigned prior blockers/gaps and a content-hash
comparison of changed files, while retaining full aspect coverage and current
source-read requirements. Once the two-round budget is spent, the receipt directs
assessment of retained evidence and honest reporting of gaps; optional polish
and unavailable reviewer capacity do not reopen completed requested work.

Skill matching can recover one typo in sufficiently long terms, but requires
distinct concepts and discounts fuzzy matches. Restored guidance filters stale
skill receipts and bounds history work. The local semantic index validates its
persisted records and reparses damaged files; nested callback returns no longer
change the enclosing function's return fingerprint. These paths need no model
request.

Web probes cancel during DNS preflight as well as fetch, validate redirects, and
return bounded failure categories. Search fallback retains provider diagnostics;
HTTP requests enforce byte limits and distinguish caller cancellation from a
retryable timeout. A successful browser-launch handoff is not visual evidence.

Economy settings refresh when the settings file changes; authorization updates
share Pi's bundled settings lock and replace the document atomically. Automatic
helper admission consumes its attempt only after a route is admitted. Fusion
provenance uses indexed lookups, background diagnostics preserve the original
failure cause within their output cap, and sibling cleanup reaches stale
heartbeats beyond the discovery display limit. Existing capability checks,
price ceilings and bounded fan-out still govern automatic work.

## Session reliability fixes

A limited skill read satisfies the read requirement when its returned text matches the entire small skill file. Partial reads remain insufficient. Skill reads bypass observation deduplication so a fresh read after compaction delivers the instructions again. Review failures distinguish malformed, empty, oversized, incomplete and execution-failed reports; invalid output does not become accepted evidence. Tool argument validation is classified before words echoed inside the invalid arguments.

Startup animation stops when its content no longer fits the terminal viewport, preventing repeated full-screen startup redraws after a pane shrinks. MCP lifecycle handling isolates replacement workers from stale callbacks, discards failed handshakes, and avoids launching processes for already-cancelled calls. Restart an existing Pi process to load updated extensions and startup code.

## Asynchronous skill discovery and visible activity

Skill suggestions combine task language with successful native file/tool evidence. File extensions and known tool operations contribute bounded domain signals; new files can refine suggestions even when their extension has already appeared. Catalog ranking is independent of catalog order.

Asynchronous skill discovery is enabled by default. After two distinct successful observations, an eligible discovery child can inspect a compact catalog-wide metadata packet while the parent continues. It receives no tool bodies, skill bodies, conversation transcript, inherited project instructions or tool access. It returns at most three validated installed skill names with short reasons. Suggestions use the existing reminder limits and never become mandatory reviews or read receipts. New input, session changes, cancellation and completed work invalidate pending results; duplicate packets are cached for the session.

Discovery prefers proven free routes, otherwise admitted low-cost routes under the existing economy policy. Each attempt has reported-usage budgets of $0.001 and 16,000 cumulative tokens, plus a 1,024-output-token request cap and 25-second deadline. Reported-usage thresholds can be crossed by an in-flight response; they are not a provider billing guarantee. It shares the generic automatic-assistance budget and replaces a generic single investigator only when deterministic skill routing actually claims the current prompt; merely having a skill catalog does not suppress unrelated fix/debug/research assistance. An instant no-output launch failure can try another distinct eligible route, with at most three total route attempts under the same assistance unit, budget and deadline. Once a discovery child produces a genuine output attempt it is not retried, and there is no premium fallback. Offline sessions, child sessions, relevant opt-outs and unavailable capacity skip discovery quietly. Set `PI_SKILL_DISCOVERY=off` to disable it.

The terminal status area shows short action labels for tools and automatic work, including skill discovery and local model preprocessing. Concurrent actions share a compact line; completion is briefly visible. These indicators contain no arguments or result bodies and add nothing to the model context or session messages.

## Actionable session metrics and background services

`/metrics` opens a terminal overlay with keys 1–5 for section navigation. The overview separates tool, provider and child failures. Failure rows distinguish read coverage, stale edit targets, read ranges, selectors and navigation. Context traffic reports raw returned characters, tool shares, largest-result locators and repeated content separately from identical requests; these are not wire-token or billing measurements.

Four further commands open separate-window popups instead of terminal overlays: `/sys-prompt` shows the system prompt captured at the session's first agent run (exactly what the agent saw initially, with model and tool names); `/used` opens an expandable session inventory with clear totals and drill-downs for current and previously used model routes, token traffic and routing settings, fully opened versus partial-only versus suggestion-only skills, deduplicated child-agent runs with recorded model/thinking/status/usage/cost, tool results and failures, Harness activity, session totals and hook measurements; `/errors` opens a detailed newest-first error list with per-error drill-downs (failed payload, owning module, cause and recovery) plus the full bounded JSON with a copy button; `/commands` lists every registered slash command with its description. The `/used` and `/errors` controls are native keyboard-accessible disclosure rows. Missing provenance or usage stays visibly “not recorded,” never guessed or displayed as zero.

The main agent can end its own session with `session_stop` when requested work is complete, stating observed verification and any remaining gaps. Review and delegation receipts are informational; stopping never requires an extra review or subagent run and does not certify completion. It ends this session's active subagent runs, silences automatic quality/test follow-ups and ends the turn. Any new user message resumes the session normally, with quality triggers active again.

Memory append receipts no longer echo existing memory into model context. Native reads share the per-file mutation queue so concurrent edits cannot expose temporarily truncated files. Shell path validation respects quotes inside command substitutions.

Recognized development and HTTP servers do not keep automatic continuation pending or inject completion messages into model context by default. Finite background jobs retain completion wakes. Explicit `triggerOnCompletion: true` opts a newly launched service into waking; legacy service records use the non-waking default. Restart existing Pi processes to load the updated callbacks and native read patch.

The user-facing `bash` tool keeps ordinary blocking and sequential shell semantics and waits for its terminal result within `timeout`. Bounded `wait_for` or render captures may return a pending helper handle for the managed `process` tool; explicit background work belongs to `bg_run` and its `bg_status`, `bg_logs` and `bg_kill` tools. A pending helper has no terminal exit code until a later process status or wait confirms it.

## Cost and lifecycle boundaries

The offline session audit reports the ten largest raw-text contributors and exact-repeat totals without emitting transcript bodies, paths or arguments. These figures precede context projection and do not measure billed tokens. Native utility calls share a bounded queue with two active requests, matching the MCP server’s worker capacity; cancellation and shutdown remove queued requests before dispatch.

Automatic exit summaries abort provider work at their deadline, request at most 2,048 output tokens, skip offline mode and do not fall back from an unavailable explicitly configured summary model to the active model. Truncated responses are not saved as completed memory. A session metadata marker prevents another summary of unchanged history after resume; new messages make a later summary eligible. Selective priming can retrieve a bounded task-relevant memory digest once per session; complete memory contents remain available on demand.

Automatic research assistance has a three-minute investigation allowance for source-reading turns and synthesis. The enclosing cancellation watchdog allows five additional seconds for terminal receipts and cleanup. These helpers run asynchronously while the main agent continues; their existing tool, token and cost budgets still apply, and cancelling the owning task cancels its helpers immediately.

| Component | Admission and relationship | What enters model context |
| --- | --- | --- |
| Scope council | Qualifying change-scope requests; uses the native child executor and suppresses the separate startup helper | A bounded advisory discussion; never authorization or quality evidence |
| Skill discovery | Distinct successful observations and an eligible cheap route; shares the automatic-assistance budget | Validated, bounded skill suggestions; no skill bodies or full transcript in the discovery packet |
| Automatic assistance | Useful work and admitted route/cost/capability limits; one shared group budget | Bounded findings from fresh read-only children |
| Quality review | Completion checkpoints and changed-source evidence; uses the shared native launcher | Current findings and explicit evidence gaps, not an automatic pass |
| Swarm and fusion | Existing workflow/planner policies, child budgets and capabilities | Bounded attributed outputs; attempts use one-based suffixes |
| Provider recovery | Existing retry, cooldown and route constraints; settlement invalidates pending recovery | Existing results are retained; stale cancellation notices are not published after settlement |
| Utility MCP | Explicit tool calls; two active workers and bounded queued requests | Tool results only; process startup and queue state add no messages |

Cheap mechanical judgments (fetch screening, skill and tool ranking, claim verification, error classification, output distillation, compaction triage) route through TypeSafe Jev on the configured OpenRouter key. Every site keeps its heuristic path: Jev refines, low confidence keeps the legacy result, and failures degrade silently to it. Served results carry a `[successfully routed with Jev · …]` marker; each paid call is ledgered as session cost under its `openrouter/…` route and counted in session metrics. Slug failover, a 5-minute breaker with background recovery, trivial-input skips and per-session answer dedupe keep spend negligible with no hard caps; `PI_JEV=off` disables all calls.
| Background services | Recognized persistent services default to no completion wake; explicit opt-in remains available | UI completion notices stay out of model context by default |

Loading and inventory checks establish registered ownership, not live provider correctness. Offline scripted-stream tests validate request behavior without paid inference; unavailable live observations remain unverified.

Discovery also accepts the actual path arrays and operations used by source-intelligence tools. Distinct search variants are counted using an in-memory hash; query text is not copied into discovery packets. Skill-only reads do not count toward the observation threshold. After two large broad source reads, one expiring hint can point to an available structural outline or context tool; small complete reads do not trigger that hint. Completed managed-process waits include their status once, followed by the unchanged stdout/stderr tails.

After eight successful basic-tool operations, the existing guidance owner may offer one low-priority reminder naming at most two available, unused inspection tools and relevant skill workflows. The reminder uses the normal delivery quota, expires after four tool steps and has a persisted delivery receipt. It does not launch work or require extra calls. More specific task, failure and source evidence takes priority.

Extension-owned bulk edits and snapshot restores now invoke the same filesystem-scope and sibling-read policies as native mutations through `harness:mutation-preflight`. Policy owners add checks; the mutator awaits them before committing. Successful mutations invalidate sibling read receipts and publish bounded recent-write paths through `harness:mutation-committed`. New extension mutators must use this preflight and commit protocol; shell and external writers still require their existing command/sandbox boundaries and optimistic conflict checks.

Bulk edits stage the complete batch before committing. A failed or cancelled commit rolls back already-written files only when their identity and content still match this operation. If a peer has changed a committed file, its content is preserved and the error identifies the retained original backup. This is rollback on reported failures, not a filesystem-wide atomic transaction or crash-recovery guarantee; use snapshots or Git for durable recovery.

Model catalog failures retain the last usable models without renewing freshness. The active provider's status shows stale data, failed refreshes, failed cache writes and expired snapshot facts. `/catalog-status` reports all observed providers locally without fetching or invoking a model. Date-sensitive capability and pricing overrides live in a versioned registry with their original source dates and explicit expiry; expired snapshots cannot grant image support, output limits or free-price evidence. Explicit configuration and native/live catalog evidence remain separate authorities. Unknown ID-only model prices are marked missing rather than looking free.

Memory compaction no longer copies daily-log text into the same log. It records at most twenty bounded open scratchpad items and skips an unchanged snapshot. The scratchpad owns current item status; this entry is historical evidence. Durable memory supplies selective historical retrieval, native checkpoints own conversation recovery, project intelligence owns retrieved workspace evidence, scoped snapshots own explicit file recovery, and reminder delivery receipts own reminder deduplication. These stores are not interchangeable completion or authorization evidence.

Catalog-cache recovery verifies a dead owner under a kernel `flock` recovery gate before moving the abandoned lock aside. Competing reclaimers re-check the current owner, so they cannot remove a replacement writer's lock. Live owners and unknown/ownerless legacy locks are preserved; acquisition times out after five seconds and cancellation remains bounded. If recovery infrastructure is unavailable, the current catalog remains usable and a failed cache write is visible rather than silently presented as persisted.

`http_request` uses the web-access URL/address validator and a per-request transport pinned to the validated DNS answers. Explicit loopback APIs remain available; ordinary hostnames resolving to private or metadata addresses are rejected without a retry recommendation. DNS waits, including localhost lookup, share the same abort/deadline helper. The transport closes after each request. Raw API calls do not inherit the browsing subsystem's proxy/range exemptions.

Provider-gate bookkeeping is separated by route and session, bounded to 128 pending attempts with ten-minute expiry. A completion from a different known session cannot consume another request's attribution. The native request hook does not expose a unique transport request ID: overlapping requests on the same route therefore omit ambiguous endpoint/latency metadata. Duplicate model identifiers cannot bypass a known candidate's cooldown; actual response provider/model evidence still owns failure attribution.

Automatic compaction uses the selected model's full context window and fires at the inclusive 80% threshold (`ceil(contextWindow * 0.8)`). Legacy `maxContextTokens` values do not affect the trigger or summary preparation. `session_self {view:"context"}` reports `contextWindowPercent` and `compactionTrigger`; output and safety reservations remain separate usable-budget diagnostics. A provider overflow below 80% is surfaced as an error without an automatic summary; manual compaction remains available. After resume or compaction, stale harness pressure notices are removed from projected context while persisted history remains unchanged. Compaction estimates ignore usage counters from retained assistant messages older than the current compaction summary. Those counters remain intact for billing, but describe the previous large request. Until a fresh response supplies usage, the trigger measures current summary and retained messages. Both SDK and terminal bundle use the same full-window threshold and post-compaction usage boundary.

Switching mid-session to a model with a smaller context window warns immediately when retained tokens already exceed the new window, with both counts: compact with the previous model first (`/compact`) or start a fresh session, since the next request cannot fit otherwise. The notice stays silent when the previous window was equal or larger. When automatic compaction itself fails (overflow or threshold) while retained context still exceeds the window, a warning points at the same recovery instead of leaving the headroom error unexplained; aborted compactions stay silent. Both notices are best-effort diagnostics and never block model selection.

## Lightweight startup and optional discovery

Main sessions expose a stable core set for editing, source inspection, coordination, quality checks and existing context readers. Specialized tools remain registered with their normal safety hooks. `tool_search({})` returns a compact group overview; a group or query returns short previews (three by default, at most eight). Previews do not load schemas. Pass exact `names` or explicitly set `enable:true` to load chosen schemas without executing tools. Direct search and activation remain available; browsing is optional. Enabled tools stay available during uninterrupted work. Resume restores at most six recent specialized tools from the last twelve messages, plus tools needed by unresolved calls. Older discoveries remain searchable instead of accumulating schemas forever. Explicit command-line tool selection, child tool policies and external tool-selection changes remain authoritative. `PI_TOOL_DISCOVERY=off` retains the full default tool set.

The model receives a short skill-discovery orientation instead of the complete installed-skill XML catalog. `skill_review` with `action:"browse"` returns group counts; `action:"search"` with a task-specific query or group returns bounded, paginated descriptions and file paths; reading a selected skill remains optional unless explicitly required by the user or project. Local relevance routing still sees the original catalog before projection, so timely suggestions and asynchronous discovery remain available. Only the exact SDK-configured catalog is projected; custom instructions are preserved. `PI_SKILL_CATALOG=full` retains the full catalog, and it also remains intact when the search tool is unavailable.

These are exposure and context-cost choices, not a required workflow. Ordinary tools remain usable, security hooks still apply to activated tools, and quality review keeps its existing evidence policy. No model call is needed to search or enable tools or to search the installed skill catalog.

Discovery invitations are coalesced and bounded per user request; successful discovery suppresses further invitations during that request. Manual reminders, operational recovery, safety hooks and quality checks retain their own owners and delivery rules. Browsing groups does not create a skill-read requirement or a tool-use quota.
The existing loop tracker also detects exact repeated observation cycles of one to three turns, including parallel read batches, after four complete repetitions. It asks for a change of strategy and rejects only the repeated inspection calls. Changed evidence, productive work, explicit waits and user/lifecycle resets release the cycle. It adds no model calls or durable state, and repeated shell results alone do not block potentially productive shell commands.

Context skill ranking excludes generic engineering words such as “platform”, “systems” and “quality” as domain evidence. Native C/C++ file activity contributes language-specific context instead of suggesting unrelated cloud, Java or LLM platforms. Pi-lens quality advisories direct callers to `lens_diagnostics({mode:"delta"})` rather than assuming a cache filename exists.
