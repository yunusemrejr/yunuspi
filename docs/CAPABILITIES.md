# Capability inventory

> Generated from the sanitized public source tree by `agent/scripts/generate-capabilities-doc.mjs`. This is a source inventory: it records literal registrations and named dynamic owners, while runtime availability still depends on the host, configuration, permissions, and optional dependencies.

The inventory is intentionally maintainable from two public authorities: the extension manifest and the static capability catalog. The generated JSON beside this file is the machine-readable form. No session, private configuration, credential, or live registry data is read.

**Source authority:** [`agent/extensions/manifest.json`](../agent/extensions/manifest.json) (shipped files and tombstones); [`agent/extensions/lib/harness-capabilities.ts`](../agent/extensions/lib/harness-capabilities.ts) (capability records).

## Contents

- [Capability catalog](#capability-catalog)
- [Static tool and command registrations](#static-tool-and-command-registrations)
- [MCP and wrapper service owners](#mcp-and-wrapper-service-owners)
- [Extension source inventory](#extension-source-inventory)
- [Skills](#skills)
- [Migration test fixtures](#migration-test-fixtures)
- [Public documentation](#public-documentation)
- [Retired source markers](#retired-source-markers)

## Capability catalog

Each record below is copied from `HARNESS_CAPABILITIES`. Catalog tool names are pointers to entrypoints; the registration inventory later in this file is the independent source scan.

### async

#### background-tasks

Track explicit shell jobs in the local background registry, receive durable completion notifications and inspect bounded output by task id.

**Entrypoints:** `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `background-task-notification`

**Catalog tool pointers:** `bg_run`, `bg_status`, `bg_logs`, `bg_kill`

**Commands:** `/bg`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update`, `/jobs`, `/logs`, `/kill`

**Options:**

- `name`: Short task name.
- `command`: Shell command to start.
- `isAgent`: Whether the command launches an LLM/agent process.
- `description`: Optional task context.
- `timeoutSeconds`: Positive task timeout.
- `notifyOnCompletion`: Deliver the durable terminal notification.
- `triggerOnCompletion`: Request an agent wake for a finite task or explicitly opted-in service.
- `taskId`: Task id or unambiguous prefix for status/logs/kill.
- `maxBytes|tail`: Bound and direction for log reads.

**Related records:** `subagent-dispatch`, `session-coordination`, `quick-commands`

**Source:** [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts), [`agent/extensions/pi-background-tasks/src/core/registry.ts`](../agent/extensions/pi-background-tasks/src/core/registry.ts), [`agent/extensions/pi-background-tasks/src/core/completion-wake.ts`](../agent/extensions/pi-background-tasks/src/core/completion-wake.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### subagent-intercom

Coordinate a child with its supervisor through explicit decision, interview or progress messages and deliver grouped run receipts; targets are run/session scoped and completed children may be unreachable.

**Entrypoints:** `contact_supervisor`, `subagent_supervisor`, `subagent:result-intercom`, `intercomBridge`

**Catalog tool pointers:** `contact_supervisor`, `subagent_supervisor`

**Options:**

- `reason`: Child-to-supervisor message kind. Values: `need_decision`, `interview_request`, `progress_update`.
- `message`: Bounded question, update or reply text.
- `interview`: Structured supervisor questions for interview_request.
- `action`: Parent supervisor operation. Values: `list`, `send`, `ask`, `reply`, `pending`, `status`.
- `to|replyTo`: Explicit intercom target or pending request id.
- `intercomBridge.mode`: Child bridge activation mode. Values: `off`, `fork-only`, `always`.
- `intercomBridge.resultDelivery`: Deliver grouped completion receipts to an acknowledged intercom listener.
- `PI_INTERCOM_SESSION_ID|PI_SUBAGENT_INTERCOM_SESSION_NAME`: Optional target identity used by the native bridge.
- `PI_INTERCOM_ASK_TIMEOUT_MS`: Native supervisor reply wait bound.

**Related records:** `subagent-dispatch`, `session-coordination`, `background-tasks`

**Source:** [`agent/extensions/pi-subagents/src/intercom/intercom-bridge.ts`](../agent/extensions/pi-subagents/src/intercom/intercom-bridge.ts), [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts), [`agent/extensions/pi-subagents/src/intercom/result-intercom.ts`](../agent/extensions/pi-subagents/src/intercom/result-intercom.ts), [`agent/extensions/pi-subagents/src/shared/types.ts`](../agent/extensions/pi-subagents/src/shared/types.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

### commands

#### hook-guidance

Attach one deterministic workflow reminder to the first matching tool result (including deploy-then-verify-live and render-the-first-interface hooks); each firing shows a visible Hook line and reaches the observer. Hooks annotate and recover without blocking or changing authority.

**Entrypoints:** `tool_call`, `tool_result`, `session_start`, `session_switch`

**Options:**

- `PI_SESSION_HOOKS`: Disable this annotation surface when set to off. Values: `on`, `off`.
- `tool_call`: Match the tool name and input before execution.
- `tool_result`: Annotate the corresponding success or failure once.

**Related records:** `quick-commands`, `safety-bounds`

**Source:** [`agent/extensions/session-hooks.ts`](../agent/extensions/session-hooks.ts), [`agent/extensions/lib/session-hooks.ts`](../agent/extensions/lib/session-hooks.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### cost-governor

Keep long sessions affordable: DeepSeek routes stay cache-first and fold only near the window, other routes fold at a stable budget; batch independent file reads, cap oversized bash/search output with a full-output spill, tighten tool caps and routine thinking at a soft USD budget, name the cause of every prompt-cache miss, and route one thinking-level decision per human turn through the configured Jev judge when the request is clearly simple. No work skipped.

**Entrypoints:** `cost-governor`, `/budget`, `read_many`

**Catalog tool pointers:** `read_many`

**Commands:** `/budget`

**Options:**

- `read_many.files`: Two to six independent paths with optional offset/limit; one request instead of one read per file.
- `/budget`: Report session spend, cache hit rate, current context budget, fold count, tool caps and adaptive effort state.
- `/budget <usd|off|reset>`: Set the soft budget for this session; economy mode lowers caps and routine effort, it does not stop the task.
- `PI_CONTEXT_GOVERNOR`: Set to off to disable folding, tool caps and the budget.
- `PI_CONTEXT_BUDGET|PI_CONTEXT_KEEP`: Explicit fold threshold and verbatim recent-tail tokens. Unset, DeepSeek routes fold near 80% of the model window and other routes at 100000; the tail defaults to 20000.
- `PI_TOOL_RESULT_MAX`: Bash/search result cap in characters; default 24000.
- `PI_COST_BUDGET_USD`: Soft USD budget; default 0.10, off disables economy mode.
- `PI_ADAPTIVE_EFFORT`: Set to off to keep the configured thinking level in economy mode.
- `PIJEV_EFFORT`: Set to off to disable Jev-backed per-turn thinking-level routing. Jev may only lower effort below the configured ceiling, never to off, and only when the cache miss fits the switch budget.

**Related records:** `quick-commands`, `context-diagnostics`, `micro-intelligence`

**Source:** [`agent/extensions/cost-governor.ts`](../agent/extensions/cost-governor.ts), [`agent/extensions/lib/context-governor.ts`](../agent/extensions/lib/context-governor.ts), [`agent/extensions/lib/effort-policy.mjs`](../agent/extensions/lib/effort-policy.mjs)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### quick-commands

Use the installed slash-command surface for session controls, model/provider routing, plans, reminders, project graph, observations and background work.

**Entrypoints:** `pi.getCommands`, `registerCommand`

**Commands:** `/cost`, `/budget`, `/self`, `/metrics`, `/obs`, `/effort`, `/reminder`, `/goal`, `/graph`, `/provider`, `/or-provider`, `/models`, `/todos`, `/memory-prime`, `/bg`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update`, `/jobs`, `/logs`, `/kill`, `/subagents`, `/run`, `/subagents-doctor`, `/subagents-inspect-rpc`, `/subagents-refine`, `/subagents-fleet`, `/subagents-detach`, `/subagents-stop`, `/subagents-steer`, `/subagents-models`, `/subagents-profiles`, `/subagents-load-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles`, `/subagents-check-profile`, `/subagents-watchdog`, `/prompt-workflow`, `/google-account`, `/sys-prompt`, `/used`, `/errors`, `/commands`, `/guardian`, `/observer-book`

**Options:**

- `pi.getCommands()`: Read the live command registry; command availability can depend on loaded extensions and configuration.
- `/self`: Current-session diagnostics.
- `/cost|/metrics|/obs`: Session accounting, metrics and observations.
- `/sys-prompt|/used|/errors|/commands|/models`: Separate-window popups: system prompt, session usage, detailed errors, command list, graphical model routing.
- `/guardian on|off|status|stats|debug`: Guardian supervision for this session only; on by default, off stops analysis and intervention.
- `/effort`: Thinking control alias owned by the extension.
- `/graph`: Open the project intelligence viewer.
- `/todos`: Show the hierarchical action plan.

**Related records:** `tool-catalog`, `context-diagnostics`, `todo-planning`, `background-tasks`

**Source:** [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts), [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts), [`agent/extensions/lib/session-telemetry.ts`](../agent/extensions/lib/session-telemetry.ts), [`agent/extensions/thinking.ts`](../agent/extensions/thinking.ts), [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts), [`agent/extensions/rpiv-todo/todo.ts`](../agent/extensions/rpiv-todo/todo.ts), [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

### communication

#### agentmail-email

Send and read email through AgentMail (outreach and inbox triage) with an environment-provided API key: inbox discovery, bounded sends with a required subject, compact inbox listing, full-text search, and single-message reads.

**Entrypoints:** `agentmail`

**Catalog tool pointers:** `agentmail`

**Options:**

- `AGENTMAIL_API_KEY`: Required environment variable; read at call time and never persisted, logged or echoed.
- `AGENTMAIL_INBOX_ID`: Default sender inbox (usually the sending address) used when a call omits inboxId.
- `AGENTMAIL_BASE_URL`: Optional endpoint override, for example another AgentMail region.
- `to|cc|bcc|replyTo|subject|text|html|labels`: Send fields; a subject and a text or html body are required, and CR/LF is rejected.
- `inboxId|limit|pageToken|from|to|subject|labels|ascending|includeSpam|includeTrash`: Inbox listing scope and filters; list rows stay compact and carry a preview, and nextPageToken pages through every page.
- `q|before|after`: Full-text search query with optional ISO timestamp bounds; rows carry per-field match highlights.
- `includeHtml`: Opt-in HTML body on a single-message read.

**Related records:** `web-and-media`, `safety-bounds`

**Source:** [`agent/extensions/agentmail.ts`](../agent/extensions/agentmail.ts), [`agent/extensions/http-tools.ts`](../agent/extensions/http-tools.ts)

**Documentation:** [`docs/EMAIL.md`](EMAIL.md)

### coordination

#### session-coordination

Coordinate independent Pi sessions through checkout scope/check receipts and explicitly addressed asynchronous local peer messages across projects. Each session keeps its own goals, plans, observer and guardian state; peer advice carries no user authority.

**Entrypoints:** `session_coordinate`, `sibling-bridge`, `todo-plan-changed`, `session-peer-message`

**Catalog tool pointers:** `session_coordinate`

**Options:**

- `action`: Coordination operation. Values: `status`, `publish`, `clear`, `prepare_check`, `send`.
- `scope`: Default checkout discovery; all explicitly lists independent roots across projects. Values: `checkout`, `all`.
- `to|recipientEpoch|message`: Send 1–2000 characters of untrusted peer advice to the full session ID and current epoch from status. Atomic inbox delivery is visible, does not wake idle inference, and never merges goals. Stale/absent recipients and full inboxes return errors.
- `objective`: Bounded objective text, up to 240 characters.
- `note`: Bounded handoff note, up to 500 characters.
- `files`: Up to 32 absolute or cwd-resolved scopes; prepare_check requires 1–8 regular input files <=256 KiB each.
- `checkName|command`: Name and exact next authorized bash command to observe. This tool never executes it; freshness covers declared inputs only.
- `PI_SIBLING_STALE_WRITES`: Disable stale-read write blocking when set to off.
- `coordinationRoot`: Canonical same-checkout identity joins nested paths and symlink aliases.

**Related records:** `todo-planning`, `background-tasks`, `safety-bounds`

**Source:** [`agent/extensions/siblings.ts`](../agent/extensions/siblings.ts), [`agent/extensions/rpiv-todo/state/plan.ts`](../agent/extensions/rpiv-todo/state/plan.ts)

**Documentation:** [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)

### diagnostics

#### context-diagnostics

Inspect selected-model full-window context occupancy and 80% automatic compaction threshold alongside separate runtime, failure, efficiency and past-session diagnostics.

**Entrypoints:** `session_self`, `self`, `cost`, `metrics`, `sys-prompt`, `used`, `errors`, `commands`

**Catalog tool pointers:** `session_self`

**Commands:** `/self`, `/cost`, `/metrics`, `/sys-prompt`, `/used`, `/errors`, `/commands`

**Options:**

- `view`: Session diagnostic view. Values: `session`, `context`, `runtime`, `failures`, `efficiency`.
- `scope`: Past-session audit scope. Values: `workspace`, `all`.
- `contextWindow`: Selected model's full context window.
- `contextWindowPercent`: Current tokens divided by full context window.
- `compactionTrigger`: Inclusive automatic threshold at 80% of full window.
- `usablePercent`: Separate output/safety headroom pressure diagnostic.

**Related records:** `memory-retrieval`, `quick-commands`, `quality-review`

**Source:** [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts), [`agent/extensions/lib/session-signals.ts`](../agent/extensions/lib/session-signals.ts), [`agent/extensions/lib/session-audit.ts`](../agent/extensions/lib/session-audit.ts), [`agent/extensions/lib/session-telemetry.ts`](../agent/extensions/lib/session-telemetry.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

### discovery

#### skill-catalog

Browse and search installed SKILL.md workflows with bounded group and query pages; inspect or defer a tracked skill when a file route requests it.

**Entrypoints:** `skill_review`

**Catalog tool pointers:** `skill_review`

**Options:**

- `action`: Operation to perform. Values: `browse`, `search`, `inspect`, `defer`.
- `group`: Capability group id from browse.
- `query`: Case-insensitive name or description query.
- `skill`: Skill name or file path for inspect/defer.
- `reason`: Task-specific rationale required for defer.
- `limit`: Page size, 1–8.
- `offset`: Metadata page offset.

**Related records:** `tool-catalog`, `workflow-orchestration`

**Source:** [`agent/extensions/lib/relevant-guidance.ts`](../agent/extensions/lib/relevant-guidance.ts), [`agent/extensions/lib/skill-relevance.ts`](../agent/extensions/lib/skill-relevance.ts), [`agent/extensions/lib/capability-groups.ts`](../agent/extensions/lib/capability-groups.ts)

**Documentation:** [`docs/SKILLS-AND-CHECKS.md`](SKILLS-AND-CHECKS.md)

#### tool-catalog

Preview active tool schemas by group or query, then explicitly enable selected names while preserving the host's original authority.

**Entrypoints:** `tool_search`

**Catalog tool pointers:** `tool_search`

**Options:**

- `group`: Tool capability group id.
- `query`: Name or description search text.
- `names`: Exact tool names to enable, up to 8.
- `enable`: Enable query matches only when true.
- `limit`: Preview page size, 1–8.
- `offset`: Preview page offset.

**Related records:** `skill-catalog`, `quick-commands`

**Source:** [`agent/extensions/lib/tool-discovery.ts`](../agent/extensions/lib/tool-discovery.ts), [`agent/extensions/lib/capability-groups.ts`](../agent/extensions/lib/capability-groups.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

### engineering

#### source-intelligence

Inspect bounded syntax, advisory code-noise patterns, AST context, symbols, callers/callees and Git structure without executing project code; output limits and omitted coverage remain visible.

**Entrypoints:** `context_slice`, `symbol_expand`, `ast_diff`, `git_info`

**Catalog tool pointers:** `context_slice`, `symbol_expand`, `ast_diff`, `git_info`

**Options:**

- `paths`: Explicit source files for context_slice or symbol_expand.
- `task`: Task identifiers used to rank context_slice results.
- `symbol`: Symbol name for bounded expansion.
- `maxHops|maxNodes|maxChars`: AST and response bounds.
- `path`: Source path for syntax or Git inspection.
- `base|before|after`: Git base or supplied source pair for ast_diff.
- `action`: Git inspection operation; review is pre-commit risk evidence and blame summarizes line history. Values: `scope`, `status`, `diff`, `log`, `show`, `branch`, `review`, `blame`.
- `range`: blame line range such as 40,80 or 40,+20.

**Related records:** `quality-review`, `project-intelligence`, `safety-bounds`, `code-quality`

**Source:** [`agent/extensions/lib/source-check.ts`](../agent/extensions/lib/source-check.ts), [`agent/extensions/lib/code-noise.mjs`](../agent/extensions/lib/code-noise.mjs), [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts), [`agent/extensions/git-tools.ts`](../agent/extensions/git-tools.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### code-quality

Measure duplication, code slop, prose quality and complexity without installing anything or running project code. Token clone detection (renamed clones included) across a tree or only the files changed against a revision, placeholder and debug-leftover patterns, swallowed errors, dead and unused code, stock AI-sounding prose with replacements and readability, per-function complexity, import-graph structure (cycles, orphans, hotspots, oversized files, undeclared and unused dependencies); edits automatically get high-precision hints when a new block repeats nearby or bounded cross-directory code. baseline combines source slop/security/backend/UI cues, DRY groups and structure in one call. Advisory evidence with file:line, not a quality score.

**Catalog tool pointers:** `git_info`, `lsp_diagnostics`, `lens_diagnostics`

**Options:**

- `operation`: Measurement to run. Values: `baseline`, `duplicates`, `slop`, `prose`, `complexity`, `structure`.
- `paths`: Files or directories inside the workspace; default is the workspace root.
- `changed|base`: Focus on files changed against a revision plus untracked files.
- `mode|minTokens|minLines`: Clone matching: renamed (identifiers and literals ignored) or exact, and size thresholds.

**Related records:** `source-intelligence`, `quality-review`, `artifact-numeric-checks`

**Source:** [`agent/extensions/lib/code-quality.ts`](../agent/extensions/lib/code-quality.ts), [`agent/extensions/lib/code-structure.ts`](../agent/extensions/lib/code-structure.ts), [`agent/extensions/lib/source-check.ts`](../agent/extensions/lib/source-check.ts), [`agent/extensions/git-tools.ts`](../agent/extensions/git-tools.ts)

**Documentation:** [`docs/CODE-QUALITY.md`](CODE-QUALITY.md)

#### static-audits

Audit source and SVG files with local deterministic rules after every edit and as a step of the goal completion check. Security (injection, secrets, deserialization, TLS, CORS, cookies, JWT, path traversal, SSRF), backend (timeouts, N+1 queries, mass assignment, error leaks, blocking calls), efficiency, coding patterns and UI source, in JS/TS, Python, Go, PHP, shell, CSS, HTML and config files. High-severity findings and unparseable changed files reopen the goal until fixed or waived. svg_inspect (action review) scores an SVG for clipped art, theming, bloat, accessibility and active content, and writes a verified lossless optimized copy. Findings never become automatic approvals.

**Entrypoints:** `svg_inspect`

**Catalog tool pointers:** `svg_inspect`

**Options:**

- `svg_inspect.action`: inspect measures, review scores with fixes, matrix rasterizes sizes. Values: `inspect`, `review`, `matrix`.
- `svg_inspect.kind`: review: override icon/logo/illustration inference. Values: `icon`, `logo`, `illustration`.
- `svg_inspect.optimize|precision|outputDir`: review: write verified lossless copies into a fresh git-ignored folder; the original is untouched.

**Related records:** `code-quality`, `artifact-numeric-checks`, `quality-review`, `design-studio`

**Source:** [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts), [`agent/extensions/lib/code-audit.ts`](../agent/extensions/lib/code-audit.ts), [`agent/extensions/lib/svg-analysis.ts`](../agent/extensions/lib/svg-analysis.ts), [`agent/extensions/lib/source-check.ts`](../agent/extensions/lib/source-check.ts), [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts)

**Documentation:** [`docs/CODE-AUDIT.md`](CODE-AUDIT.md)

#### artifact-numeric-checks

Check SVG references and source cues, image/text metadata, measured frame timing, render attachment memory and numerical/ML metrics locally with bounded results and no model calls. These checks do not certify visual quality, physical safety or GPU performance.

**Entrypoints:** `math_check`

**Catalog tool pointers:** `math_check`

**Options:**

- `path|text`: One workspace path or supported inline source; SVG is bounded to 64 KiB.
- `math_check.operation`: Deterministic numeric calculation. Values: `frame_budget`, `render_budget`, `summarize`, `compare`, `classify`, `vectors`, `split_overlap`.
- `values|target_fps`: Observed frame durations in milliseconds and target rate.
- `width|height|pixel_ratio|bytes_per_pixel|samples|buffers`: Explicit render attachment assumptions; excludes other allocations and driver overhead.

**Related records:** `source-intelligence`, `web-and-media`, `safety-bounds`

**Source:** [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts), [`agent/extensions/lib/svg-check.ts`](../agent/extensions/lib/svg-check.ts), [`agent/extensions/lib/numeric-checks.ts`](../agent/extensions/lib/numeric-checks.ts)

**Documentation:** [`docs/SKILLS-AND-CHECKS.md`](SKILLS-AND-CHECKS.md)

#### google-colab

Run ML and general compute on Google Colab through the official google-colab-cli: install and browser-authenticate the CLI, rent CPU, T4/L4/G4/H100/A100 or TPU v5e1/v6e1 runtimes, execute scripts or notebooks, sync files, export session logs, detach long training jobs and release billable sessions. Includes QLoRA/SFT, GRPO/PPO, from-scratch small-model and evaluation workflows with reference scripts.

**Entrypoints:** `colab`

**Catalog tool pointers:** `colab`

**Options:**

- `action`: setup, status, auth, new, sessions, exec, run, install_packages, upload, download, ls, rm, log, stop, restart, url, usage, doctor, jobs, job_output or job_kill.
- `gpu|tpu`: new/run: T4, L4, G4, H100, A100 or TPU v5e1/v6e1. Availability is account-tier gated; unknown GPUs are rejected instead of silently falling back.
- `session`: Persistent kernel name. Reuse it for iterative exec calls; stop it to release the VM.
- `background`: Detach a long exec/run after the foreground grace and return a job id; poll jobs/job_output.
- `auth_action`: status, login (visible browser or manual code), complete with a pasted code, or cancel. Values: `status`, `login`, `complete`, `cancel`.
- `mode`: oauth2 cached user token or adc Application Default Credentials. Values: `oauth2`, `adc`.

**Related records:** `background-tasks`, `web-and-media`, `model-routing`

**Source:** [`agent/extensions/colab.ts`](../agent/extensions/colab.ts), [`agent/extensions/lib/colab.ts`](../agent/extensions/lib/colab.ts), [`agent/extensions/lib/colab-auth.ts`](../agent/extensions/lib/colab-auth.ts), [`agent/extensions/lib/colab-jobs.ts`](../agent/extensions/lib/colab-jobs.ts), [`agent/scripts/colab-auth-browser.mjs`](../agent/scripts/colab-auth-browser.mjs), [`agent/skills/colab/SKILL.md`](../agent/skills/colab/SKILL.md)

**Documentation:** [`docs/GOOGLE-COLAB.md`](GOOGLE-COLAB.md)

#### rendered-design-review

Collect rendered typography, spacing, surface effects, solid-color text contrast, overflow, motion and bounded placeholder/adjacent-label repetition, animated status pills, copy density, font proliferation, heavy border panels and quantified-claim evidence candidates. Compare viewport/state screenshots using design skills; intentional repetition is allowed, with no aesthetic score or compliance claim.

**Catalog tool pointers:** `render_see`, `browser_session`, `web_asset_check`

**Options:**

- `source`: Local HTML or HTTP(S) page, inspected in the existing isolated browser.
- `width|height|colorScheme|reducedMotion`: Explicit responsive/theme/motion test condition.
- `output`: text for measurements; both includes pixels for vision-capable models. Values: `text`, `both`.

**Related records:** `web-and-media`, `source-intelligence`

**Source:** [`agent/extensions/render-and-wait.ts`](../agent/extensions/render-and-wait.ts), [`agent/scripts/render-design-state.mjs`](../agent/scripts/render-design-state.mjs), [`agent/scripts/render-noise-state.mjs`](../agent/scripts/render-noise-state.mjs)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

#### delivery-preflight

Inspect GitHub Actions workflow dependencies/matrix bounds, static web asset references for hosting, and Ubuntu unit/journal metadata without running workflows, publishing sites or mutating services. Source-backed findings with explicit unresolved expressions.

**Entrypoints:** `web_asset_check`, `sys_probe`

**Catalog tool pointers:** `web_asset_check`, `sys_probe`, `git_info`, `package_probe`

**Options:**

- `path|project`: Explicit workflow YAML and project root.
- `files|asset_root|public_path`: Explicit HTML/CSS/manifest sources and hosting asset boundary.
- `sys_probe.action`: Inspect exact units/journals or bounded proc/pressure/cgroup resources plus explicit PID/port diagnosis. Values: `service_detail`, `journal`, `diagnose`.

**Related records:** `source-intelligence`, `safety-bounds`, `rendered-design-review`

**Source:** [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs), [`agent/extensions/sys-probe.ts`](../agent/extensions/sys-probe.ts)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

#### bounded-operations

Search explicit workspace roots and local Maildir/mbox exports with scan limits, source hashes and stale-page rejection. Prepare inert SSH argv or inspect one explicit server banner without authenticating or executing remote commands.

**Entrypoints:** `workspace_search`, `ssh_plan`, `net_probe`

**Catalog tool pointers:** `workspace_search`, `ssh_plan`, `net_probe`

**Options:**

- `root|path`: Explicit workspace-contained root or local mail export; hidden content is opt-in.
- `query|mode|kind`: Literal content/path or mail-field search; bounded and paginated.
- `snapshot|message_hash`: Current snapshot identity required for continuation or reading mail.
- `host|port|user`: One explicit SSH target; no ranges, configuration execution or automatic connection.

**Related records:** `source-intelligence`, `memory-evidence`, `safety-bounds`

**Source:** [`agent/extensions/utility-tools.ts`](../agent/extensions/utility-tools.ts), [`agent/extensions/lib/utility-mcp/local_operations.py`](../agent/extensions/lib/utility-mcp/local_operations.py), [`agent/extensions/lib/utility-mcp/net.mjs`](../agent/extensions/lib/utility-mcp/net.mjs)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

### memory

#### memory-retrieval

Read durable global/project notes, scratchpad and daily logs; search prior memory with qmd keyword, semantic or deep modes and check search health.

**Entrypoints:** `memory_read`, `memory_search`, `memory_status`, `memory-prime`

**Catalog tool pointers:** `memory_read`, `memory_search`, `memory_status`

**Commands:** `/memory-prime`

**Options:**

- `target`: Memory read target. Values: `long_term`, `project`, `scratchpad`, `daily`, `list`.
- `date`: Daily log date in YYYY-MM-DD form.
- `query`: Prior-memory search text.
- `mode`: qmd search mode. Values: `keyword`, `semantic`, `deep`.
- `limit`: Search result bound.
- `scope`: Memory priming scope. Values: `project`, `global`.
- `on|off`: Control selective memory priming, enabled by default with project/task relevance checks.

**Related records:** `memory-notes`, `memory-evidence`, `context-diagnostics`

**Source:** [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts), [`agent/extensions/pi-memory/priming.ts`](../agent/extensions/pi-memory/priming.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

#### memory-notes

Record future-session notes, project-scoped decisions and checklist state, with recoverable forget/restore operations and bounded compaction handoffs.

**Entrypoints:** `memory_write`, `scratchpad`, `memory_forget`, `memory_restore`

**Catalog tool pointers:** `memory_write`, `scratchpad`, `memory_forget`, `memory_restore`

**Options:**

- `target`: Write target. Values: `long_term`, `project`, `daily`.
- `content`: Markdown note to append.
- `mode`: Write mode; append is the supported mode. Values: `append`.
- `action`: Scratchpad or restore operation.
- `match`: Case-insensitive memory_forget match.
- `recoveryId`: Recovery record id for memory_restore.
- `text`: Scratchpad item or substring.

**Related records:** `memory-retrieval`, `memory-evidence`, `todo-planning`

**Source:** [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts), [`agent/extensions/pi-memory/priming.ts`](../agent/extensions/pi-memory/priming.ts), [`agent/extensions/pi-memory/mutation.ts`](../agent/extensions/pi-memory/mutation.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

#### memory-evidence

Keep small verbatim project observations with SHA256 provenance and retrieve unchanged evidence from the active session branch; inferred claims and unattributed URLs are rejected.

**Entrypoints:** `handoff_capsule`

**Catalog tool pointers:** `handoff_capsule`

**Options:**

- `action`: Evidence cache operation. Values: `put`, `query`.
- `source`: Local project source path or attributable source id.
- `quote`: Verbatim observation to cache.
- `query`: Evidence relevance query.
- `claims`: Up to 12 quotations/interpretations with explicit source excerpts and optional expected hashes; matches establish provenance, never real-world truth.
- `goal`: Goal used to build a handoff capsule.
- `items`: Bounded context items for scoring or capsule extraction.
- `maxChars`: Capsule output bound; default 2200.

**Related records:** `memory-notes`, `memory-retrieval`, `context-diagnostics`

**Source:** [`agent/extensions/pi-memory/context-tools.ts`](../agent/extensions/pi-memory/context-tools.ts), [`agent/extensions/pi-memory/context-salience.ts`](../agent/extensions/pi-memory/context-salience.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

### models

#### agent-model-management

List executable agents and their capabilities, inspect or edit scoped definitions, and ask for effective models without hardcoding a provider inventory.

**Entrypoints:** `subagent`, `action:list`, `action:get`, `action:models`, `action:create`, `action:update`

**Catalog tool pointers:** `subagent`

**Commands:** `/subagents`, `/subagents-models`, `/subagents-doctor`, `/subagents-profiles`, `/subagents-load-profile`, `/subagents-check-profile`

**Options:**

- `action`: Management operation. Values: `list`, `get`, `models`, `create`, `update`, `delete`, `eject`, `disable`, `enable`, `reset`.
- `agent`: Agent name or alias.
- `agentScope`: Definition scope. Values: `user`, `project`, `both`.
- `capabilities`: Include compact executable capability rows for list.
- `config`: Agent config object or JSON for create/update.
- `model`: Model selector for models or explicit child route.
- `thinking`: Configured thinking level or ceiling.
- `skill`: Declared child skill name(s).

**Related records:** `subagent-dispatch`, `model-selection`, `provider-routing`, `skill-catalog`

**Source:** [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../agent/extensions/pi-subagents/src/agents/agent-management.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

#### model-selection

Filter the live session model registry by exact name, free eligibility, provider, input modality, tools support or catalog addition month.

**Entrypoints:** `subagent`, `action:models`, `filterModelsByQuery`

**Catalog tool pointers:** `subagent`

**Commands:** `/subagents-models`

**Options:**

- `action`: Use model listing mode. Values: `models`.
- `model`: All-token selector query.
- `free:true`: Keep eligible free routes after economy checks.
- `provider:<id>`: Filter to an exact provider id from the current registry.
- `input:<modality>`: Filter advertised input modality.
- `tools:true`: Require advertised tool calling support.
- `added:this-month|added:YYYY-MM`: Filter provider catalog addition timestamps in UTC.
- `model: provider/id:thinking`: Pass an exact route with optional supported thinking suffix.

**Related records:** `agent-model-management`, `provider-routing`

**Source:** [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../agent/extensions/pi-subagents/src/agents/agent-management.ts), [`agent/extensions/pi-subagents/src/runs/shared/model-selection.ts`](../agent/extensions/pi-subagents/src/runs/shared/model-selection.ts), [`agent/extensions/pi-subagents/src/shared/model-info.ts`](../agent/extensions/pi-subagents/src/shared/model-info.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

#### provider-routing

Inspect and persist OpenRouter provider selection pins for the selected model, with soft order, hard only, metric sorting or raw routing JSON.

**Entrypoints:** `provider`, `or-provider`, `models.json providers.openrouter.modelOverrides`

**Commands:** `/provider`, `/or-provider`

**Options:**

- `subcommand`: Provider command operation. Values: `list`, `status`, `order`, `only`, `sort`, `clear`, `reset`, `json`.
- `model`: Optional selected or provider/model target.
- `tag`: Exact endpoint tag returned by the live endpoint listing.
- `sort key`: Endpoint metric used by sort. Values: `price`, `latency`, `throughput`, `uptime`.
- `json.only|order|ignore`: Endpoint tag arrays in raw routing JSON.
- `json.allow_fallbacks`: Boolean fallback policy in raw routing JSON.

**Related records:** `model-selection`, `agent-model-management`

**Source:** [`agent/extensions/provider-cmd.ts`](../agent/extensions/provider-cmd.ts), [`agent/extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts`](../agent/extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

#### model-preferences

Prefer explicit per-role model/provider choices from llm_preferences.json, with the autonomous selector as fallback when preferences are absent or unusable.

**Entrypoints:** `/models`, `llm_preferences.json`, `resolveLlmPreferenceChain`, `selectAssistanceTeam`

**Options:**

- `models`: Reusable alias registry of provider/model/thinking/provider_options entries.
- `preferences.<role>.models`: Ordered alias list per role: subagents, council, fanout, quality_review, project_review, error_review, prompt_analysis, main_session_fallback.
- `/models`: Open the graphical editor for ordered role routes, upstream pins and canonical JSON recovery.
- `thinking`: Explicit level, auto for dynamic logic, or none for off. Values: `auto`, `none`, `low`, `medium`, `high`, `max`.
- `provider_options.routing`: OpenRouter backend control; auto preserves normal selection. Values: `auto`, `pinned`, `custom`.

**Related records:** `model-selection`, `provider-routing`, `agent-model-management`

**Source:** [`agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts`](../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts), [`agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts`](../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts), [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts), [`agent/extensions/lib/model-routing-store.ts`](../agent/extensions/lib/model-routing-store.ts), [`agent/extensions/lib/model-routing-metrics.ts`](../agent/extensions/lib/model-routing-metrics.ts)

**Documentation:** [`docs/LLM-PREFERENCES.md`](LLM-PREFERENCES.md)

#### local-intelligence

Local ML/statistical evidence ranking, context scoring and extractive handoffs; optional Kompress SLM paragraph selection. Automatic helpers run only when configured and eligible; discovery neither loads models nor starts inference.

**Entrypoints:** `handoff_capsule`, `session_self`

**Catalog tool pointers:** `handoff_capsule`, `session_self`

**Options:**

- `handoff_capsule`: Prepare a short extractive handoff instead of copying an entire session.
- `automatic preprocessing`: Optional local SLM selects original paragraphs; unavailable workers preserve source text. No direct inference tool is implied.

**Related records:** `memory-evidence`, `context-diagnostics`, `skill-catalog`

**Source:** [`agent/extensions/lib/local-intelligence.mjs`](../agent/extensions/lib/local-intelligence.mjs), [`agent/extensions/lib/mini-preprocessor.ts`](../agent/extensions/lib/mini-preprocessor.ts), [`agent/extensions/pi-memory/context-tools.ts`](../agent/extensions/pi-memory/context-tools.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

#### micro-intelligence

Shared Needle3, Kompress and Jev helpers for discovery ranking, source selection, prompt analysis, evidence triage and one conservative per-turn thinking-level decision, plus batched ranking, categorization and qualified micro tasks; deterministic owners retain safety and completion authority.

**Entrypoints:** `micro_status`, `micro_task`

**Catalog tool pointers:** `micro_status`, `micro_task`

**Options:**

- `PI_MICRO_INTELLIGENCE`: Set to off to disable the lifecycle extension; routing, eligibility, safety and truth stay with existing owners.
- `PI_NEEDLE`: Set to off to disable Needle re-ranking, or PI_NEEDLE_SHADOW=1 to measure without applying.
- `PI_JEV`: Set to off to disable remote Jev calls. When enabled, bounded task/request excerpts (maximum 32768 characters) may be sent to OpenRouter.
- `micro_task.action`: Batch semantic analysis, inspect routes, refresh qualification, compare routing or run one bounded task. Values: `analyze`, `status`, `qualify`, `route`, `run`.
- `PI_MICRO_WORKER_ROUTES`: Optional exact provider/model candidates; the current session route and existing economy selector are available when omitted.
- `PI_RERANK_MODEL|VOYAGE_API_KEY`: Configure remote memory refinement after Needle; unavailable remote inference retains local order.

**Related records:** `local-intelligence`, `tool-catalog`, `skill-catalog`, `context-diagnostics`

**Source:** [`agent/extensions/micro-intelligence.ts`](../agent/extensions/micro-intelligence.ts), [`agent/extensions/lib/needle-runtime.ts`](../agent/extensions/lib/needle-runtime.ts), [`agent/extensions/lib/jev-client.ts`](../agent/extensions/lib/jev-client.ts), [`agent/extensions/lib/micro-intelligence/micro-task.ts`](../agent/extensions/lib/micro-intelligence/micro-task.ts), [`agent/extensions/lib/micro-intelligence/metrics.ts`](../agent/extensions/lib/micro-intelligence/metrics.ts)

**Documentation:** [`docs/MICRO-INTELLIGENCE.md`](MICRO-INTELLIGENCE.md)

### orchestration

#### subagent-dispatch

Launch one child, native parallel tasks or a sequential chain with explicit context, model, skills, output and acceptance controls.

**Entrypoints:** `subagent`, `bg_wait`, `runs.run`, `runs.all`, `runs.steer`, `runs.status`

**Catalog tool pointers:** `subagent`, `bg_wait`

**Commands:** `/run`, `/subagents`, `/subagents-stop`, `/subagents-steer`, `/subagents-detach`

**Options:**

- `agent`: Named child agent for one-child execution or management.
- `task`: Optional one-child prompt.
- `tasks`: 1–64 native parallel child objects.
- `chain`: 1–64 sequential child objects; previous output can flow forward.
- `commonTask`: Shared brief for native tasks or chain.
- `async`: Run composite or child work in the background.
- `context`: Child context mode. Values: `fresh`, `fork`, `profile`.
- `model`: Explicit provider/id route with optional :thinking suffix.
- `thinking`: Thinking level for supported control actions.
- `skill`: Child skill name, names, or false.
- `cwd`: Execution project working directory (workdir).
- `worktree`: Use managed per-child Git isolation.
- `output`: Inline output path or false.
- `timeoutMs`: Positive execution timeout.
- `acceptance`: Structured completion contract.
- `gate`: Host gate command, mutually exclusive with acceptance.

**Related records:** `workflow-orchestration`, `agent-model-management`, `background-tasks`, `fanout-execution`

**Source:** [`agent/extensions/pi-subagents/src/extension/index.ts`](../agent/extensions/pi-subagents/src/extension/index.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/extension/public-execution.ts`](../agent/extensions/pi-subagents/src/extension/public-execution.ts), [`agent/extensions/pi-subagents/src/intercom/result-intercom.ts`](../agent/extensions/pi-subagents/src/intercom/result-intercom.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

#### workflow-orchestration

Run extension-owned review/run-ci resources or repeatable prompt workflows with bounded arguments and explicit foreground/background flags.

**Entrypoints:** `subagent`, `workflow`, `workflowScript`, `workflowScriptPath`, `prompt-workflow`

**Catalog tool pointers:** `subagent`

**Commands:** `/prompt-workflow`

**Options:**

- `workflow`: Named resource; currently review or run-ci. Values: `review`, `run-ci`.
- `args.task`: Required non-empty task for review.
- `args.command`: run-ci command. Values: `npm test`, `npm run typecheck`.
- `args.timeoutMs`: run-ci timeout, 1–86400000.
- `workflowScript`: Inline filesystem-free workflow body for supported maintenance sessions.
- `workflowScriptPath`: Workflow file path relative to request cwd.
- `async`: Background execution flag.
- `--fork`: Prompt-workflow child context override.
- `--fresh`: Prompt-workflow fresh-context override.
- `--bg|--async`: Prompt-workflow background flag.
- `--subagent`: Prompt-workflow agent override.

**Related records:** `subagent-dispatch`, `prompt-workflows`, `quality-review`

**Source:** [`agent/extensions/pi-subagents/src/workflows/workflow-resources.ts`](../agent/extensions/pi-subagents/src/workflows/workflow-resources.ts), [`agent/extensions/pi-subagents/src/extension/public-execution.ts`](../agent/extensions/pi-subagents/src/extension/public-execution.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

#### prompt-workflows

Discover package, user and project Markdown prompt workflows, substitute positional arguments and optionally chain their outputs.

**Entrypoints:** `prompt-workflow`, `getPromptDirectories`, `discoverPromptWorkflows`

**Commands:** `/prompt-workflow`

**Options:**

- `list`: List discovered prompt workflows.
- `$ARGUMENTS|$@`: Substitute all runtime arguments in a prompt body.
- `$1..$N`: Substitute one positional runtime argument.
- `${N:-fallback}`: Use a fallback when a positional argument is absent.
- `chain`: Frontmatter workflow names joined by ' -> '.
- `--fork`: Run with fork context.
- `--fresh`: Run with fresh context.
- `--bg|--async`: Run the workflow in the background.
- `--subagent`: Override the declared agent.

**Related records:** `workflow-orchestration`, `subagent-dispatch`

**Source:** [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts), [`agent/extensions/pi-subagents/src/shared/prompt-resources.ts`](../agent/extensions/pi-subagents/src/shared/prompt-resources.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

#### fanout-execution

Fan-out (formerly swarm and fusion): run separable investigations or competing approaches as parallel children, preserve each outcome, failure and acceptance evidence, and merge outputs deterministically with provenance (duplicate, complementary and conflicting sections stay visible for parent review).

**Entrypoints:** `subagent.tasks`, `runs.all`, `runs.recover`, `runs.fuse`, `runs.fuseFragments`, `todo.execution:fanout`

**Catalog tool pointers:** `subagent`, `todo`

**Options:**

- `tasks`: Parallel child array with agent/task and per-child options.
- `commonTask`: Shared brief injected into every child.
- `concurrency`: Positive native task concurrency.
- `async`: Keep the composite running without blocking the parent.
- `runs.recover`: Build a bounded respawn plan for failed fan-out members.
- `runs.fuse`: Merge text outputs or ```fragment blocks from a completed run set.
- `fragments[].kind`: Fragment classification. Values: `duplicate`, `complementary`, `conflict`.
- `execution`: Todo execution annotation. Values: `fanout`.

**Related records:** `subagent-dispatch`, `todo-planning`, `agent-model-management`, `quality-review`

**Source:** [`agent/extensions/pi-subagents/src/runs/shared/assistance-plan.ts`](../agent/extensions/pi-subagents/src/runs/shared/assistance-plan.ts), [`agent/extensions/pi-subagents/src/runs/shared/fanout.ts`](../agent/extensions/pi-subagents/src/runs/shared/fanout.ts), [`agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts`](../agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts), [`agent/extensions/rpiv-todo/tool/types.ts`](../agent/extensions/rpiv-todo/tool/types.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

#### double-mode

Session mode that analyzes every user request twice before the agent starts and reconciles both into one planning directive. /double runs the session model twice; /custom-double opens a popup to search and pick two models (any providers) for streams A and B plus the reconciling route. The directive is advice below the user's own words; reviewers and the scope council see it on a shared note board.

**Entrypoints:** `/double`, `/custom-double`, `before_agent_start`, `double-directive`

**Commands:** `/double`, `/custom-double`

**Options:**

- `PI_DOUBLE`: Disable Double mode (both commands) when set to off. Values: `on`, `off`.
- `/double [on|off|status]`: Twin mode: the session model runs both streams.
- `/custom-double provider/model[:thinking] provider/model[:thinking]`: Pin two chosen routes without the popup.
- `reconcile`: Which route reconciles the two analyses. Values: `a`, `b`, `session`.

**Related records:** `scope-council`, `fanout-execution`, `subagent-dispatch`

**Source:** [`agent/extensions/pi-subagents/src/extension/double-runner.ts`](../agent/extensions/pi-subagents/src/extension/double-runner.ts), [`agent/extensions/pi-subagents/src/extension/double-pair.ts`](../agent/extensions/pi-subagents/src/extension/double-pair.ts), [`agent/extensions/pi-subagents/src/slash/double-pair-picker.ts`](../agent/extensions/pi-subagents/src/slash/double-pair-picker.ts), [`agent/extensions/lib/double.ts`](../agent/extensions/lib/double.ts), [`agent/extensions/lib/reviewer-board.ts`](../agent/extensions/lib/reviewer-board.ts)

**Documentation:** [`docs/REVIEWS-AND-COUNCILS.md`](REVIEWS-AND-COUNCILS.md)

### planning

#### todo-planning

Maintain a durable hierarchical plan with dependencies, execution annotations, file scopes and evidence-backed completion.

**Entrypoints:** `todo`, `todos`

**Catalog tool pointers:** `todo`

**Commands:** `/todos`

**Options:**

- `action`: Plan mutation. Values: `create`, `update`, `list`, `get`, `delete`, `clear`, `batch`.
- `view`: List projection. Values: `tree`, `frontier`.
- `execution`: Native orchestration annotation. Values: `self`, `subagent`, `fanout`.
- `parentId|blockedBy`: Hierarchy and dependency ids.
- `files`: Explicit relative paths in a task scope.
- `acceptance|evidence`: Completion contract and observed verification.
- `refs`: Project fact, observation or source references.
- `operations`: Atomic create/update/delete batch, up to 32.

**Related records:** `session-coordination`, `fanout-execution`, `memory-notes`

**Source:** [`agent/extensions/rpiv-todo/todo.ts`](../agent/extensions/rpiv-todo/todo.ts), [`agent/extensions/rpiv-todo/tool/types.ts`](../agent/extensions/rpiv-todo/tool/types.ts), [`agent/extensions/rpiv-todo/state/plan.ts`](../agent/extensions/rpiv-todo/state/plan.ts)

**Documentation:** [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)

#### goal-tracking

Set a /goal with numbered criteria backed by observed evidence. Finish in one complete call with a results batch; check is optional diagnostics. A fully verified settled goal closes without a bookkeeping model turn. Content-bound static checks reuse identical files; plain documentation updates do not create test debt. Criteria and verification survive resume and compaction. Open work uses bounded, stall-aware continuations; an interrupt pauses the goal.

**Entrypoints:** `goal`, `goal-anchor`

**Catalog tool pointers:** `goal`

**Commands:** `/goal`

**Options:**

- `action`: Evidence and lifecycle step. Values: `status`, `met`, `waive`, `criteria`, `blocked`, `complete`.
- `id|evidence`: Criterion id and what was observed (command and result, file and line, screenshot finding).
- `PI_GOAL`: Disable the goal system when set to 0. Values: `0`.

**Related records:** `todo-planning`, `session-coordination`

**Source:** [`agent/extensions/goal.ts`](../agent/extensions/goal.ts), [`agent/extensions/lib/goal-state.ts`](../agent/extensions/lib/goal-state.ts), [`agent/extensions/lib/completion-gate.ts`](../agent/extensions/lib/completion-gate.ts)

**Documentation:** [`docs/GOAL.md`](GOAL.md)

### project

#### project-intelligence

Query and maintain project-scoped architecture and dependency evidence, inspect versions and impact, or open the live graph viewer.

**Entrypoints:** `project_intel`, `graph`, `project_intelligence`

**Catalog tool pointers:** `project_intel`

**Commands:** `/graph`

**Options:**

- `action`: Graph operation. Values: `query`, `impact`, `inspect`, `update`, `record`, `retract`, `refresh`, `health`, `history`.
- `query|focus`: Search text or exact entity key.
- `direction`: Impact traversal direction. Values: `incoming`, `outgoing`, `both`.
- `hops`: Traversal depth, 0–6.
- `limit`: Candidate bound, 1–40.
- `maxChars`: Response bound, 400–6000.
- `types|relations`: Entity or relationship filters.
- `expectedVersion`: Required optimistic version for updates.

**Related records:** `scope-council`, `quality-review`, `todo-planning`, `source-intelligence`

**Source:** [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts), [`agent/extensions/lib/project-intelligence/query.mjs`](../agent/extensions/lib/project-intelligence/query.mjs), [`agent/extensions/lib/project-intelligence/store.mjs`](../agent/extensions/lib/project-intelligence/store.mjs)

**Documentation:** [`docs/PROJECT-INTELLIGENCE.md`](PROJECT-INTELLIGENCE.md)

### review

#### scope-council

Automatically deliberate over open-ended change scope with preservation and meaningful-change perspectives under a shared bounded budget; it has no opt-in user tool.

**Entrypoints:** `scope-council-runner`, `before_agent_start`, `context`

**Options:**

- `PI_SCOPE_COUNCIL`: Disable automatic scope deliberation when set to off. Values: `on`, `off`.
- `deadlineMs`: Shared council deadline; default 240000.
- `tokens`: Aggregate child token ceiling; default 144000.
- `tools`: Aggregate child tool ceiling; default 12.
- `costUsd`: Aggregate runtime ceiling; default 0.03.
- `nativeSubagent`: The council runs only when the native subagent capability is active; project sessions do not provide workflowScript.
- `fixedRoute|sameModel|freeOnly|noDelegation`: Constraints that can make the council unavailable.

**Related records:** `project-intelligence`, `quality-review`, `subagent-dispatch`

**Source:** [`agent/extensions/pi-subagents/src/extension/scope-council-runner.ts`](../agent/extensions/pi-subagents/src/extension/scope-council-runner.ts), [`agent/extensions/lib/scope-deliberation.ts`](../agent/extensions/lib/scope-deliberation.ts)

**Documentation:** [`docs/CHANGE-SCOPE.md`](CHANGE-SCOPE.md)

#### quality-review

Run or inspect bounded read-only aspect reviews, then accept or block only with retained independent evidence and explicit rationale.

**Entrypoints:** `quality_review`, `quality-review-followup`

**Catalog tool pointers:** `quality_review`

**Options:**

- `action`: Review lifecycle operation. Values: `inspect`, `review`, `assess`.
- `disposition`: Assessment outcome. Values: `accepted`, `blocked`.
- `reason`: Evidence-based assessment rationale, 20–1200 characters.
- `dismissals`: Blocking finding ids with concrete dismissal reasons.

**Related records:** `scope-council`, `project-intelligence`, `source-intelligence`

**Source:** [`agent/extensions/lib/quality-review.ts`](../agent/extensions/lib/quality-review.ts), [`agent/extensions/lib/quality-review-signals.ts`](../agent/extensions/lib/quality-review-signals.ts)

**Documentation:** [`docs/RECOVERY-AND-TESTING.md`](RECOVERY-AND-TESTING.md)

#### review-coordination

Coordinate distinct review kinds (quality, project, error) with trivial-work suppression, stuck-signal gating and cooldowns; the main agent stays the invoker.

**Entrypoints:** `review-coordinator`, `quality_review`, `prompt-workflow council`, `subagent worker briefs`

**Catalog tool pointers:** `quality_review`, `subagent`

**Options:**

- `kind`: Review kind with a distinct purpose and owner. Values: `quality`, `project`, `error`, `council`, `fanout`.
- `isTrivialChangeRequest`: Formatting/lint/trivial-cleanup suppression for automatic checks.
- `evaluateStuckSignal`: Strong stuck-pattern detection with transient exclusion.
- `shouldSuggestReview`: Cooldown, session-cap and recent-run gating for suggestions.

**Related records:** `quality-review`, `scope-council`, `subagent-dispatch`

**Source:** [`agent/extensions/lib/review-coordinator.ts`](../agent/extensions/lib/review-coordinator.ts)

**Documentation:** [`docs/REVIEWS-AND-COUNCILS.md`](REVIEWS-AND-COUNCILS.md)

#### expert-director

Domain-excellence coordination: infer excellence domains from a request, load bounded expert doctrine with quality priors, assemble read-only critic lenses, and evaluate improvement-loop convergence. Advisory; the main agent stays the invoker.

**Entrypoints:** `expert_director`

**Catalog tool pointers:** `expert_director`

**Options:**

- `action`: Director operation. Values: `brief`, `critics`, `assess`, `taste`, `status`.
- `taste.op`: Quality-preference operation (main session only). Values: `record`, `list`, `forget`.
- `PI_EXPERT`: Set to off to disable the Director tool and prompt-time briefs.

**Related records:** `quality-review`, `review-coordination`, `session-observer`, `micro-intelligence`

**Source:** [`agent/extensions/expert-director.ts`](../agent/extensions/expert-director.ts), [`agent/extensions/lib/expert-brief.ts`](../agent/extensions/lib/expert-brief.ts), [`agent/extensions/lib/expert-domains.ts`](../agent/extensions/lib/expert-domains.ts), [`agent/extensions/lib/expert-doctrine.ts`](../agent/extensions/lib/expert-doctrine.ts), [`agent/extensions/lib/expert-critics.ts`](../agent/extensions/lib/expert-critics.ts), [`agent/extensions/lib/expert-convergence.ts`](../agent/extensions/lib/expert-convergence.ts), [`agent/extensions/lib/expert-taste.ts`](../agent/extensions/lib/expert-taste.ts)

**Documentation:** [`docs/EXPERT-DIRECTOR.md`](EXPERT-DIRECTOR.md)

#### session-observer

Periodic independent reviewer that talks to the main agent about the live session, grounded in the Observer Book: 58 doctrine chapters (engineering, design, color, typography, web, media, operations, science, marketing, communication and more) selected by deterministic session triggers, plus per-project margin notes it keeps; advisory only, never authority.

**Entrypoints:** `session_observer preference role`, `/observer-book`

**Commands:** `/observer-book`, `/models`

**Options:**

- `/observer-book [toc|read <id>|margins [clear]|on|off]`: Read the book and its current selection, manage this project's margin notes, or disable the book for this session.
- `PI_OBSERVER_BOOK`: Set to off to review without the book.
- `PI_OBSERVER_BOOK_DIR`: Directory of extra user chapters (default ~/.pi/settings/observer-book); off disables user chapters.
- `PI_OBSERVER_MARGINS|PI_OBSERVER_MARGINS_DIR`: Disable margin notes or relocate their per-project store (default under the agent memory directory).
- `PI_SESSION_OBSERVER`: Set to off to disable periodic observation entirely; the /models Session Observer role chooses the route.

**Related records:** `quality-review`, `review-coordination`, `micro-intelligence`, `session-coordination`

**Source:** [`agent/extensions/session-observer.ts`](../agent/extensions/session-observer.ts), [`agent/extensions/lib/session-observer.ts`](../agent/extensions/lib/session-observer.ts), [`agent/extensions/lib/observer-book.ts`](../agent/extensions/lib/observer-book.ts)

**Documentation:** [`docs/SESSION-OBSERVER.md`](SESSION-OBSERVER.md)

### safety

#### safety-bounds

Inspect host/session dependencies and device candidates before guarded operations; run disposable experiments with path, process, resource and authority boundaries. Recognized connectivity, power and session-destructive shell commands are blocked; unavailable isolation fails closed.

**Entrypoints:** `sys_probe`, `sandbox_run`, `filesystem-safety`, `harness:mutation-preflight`

**Catalog tool pointers:** `sys_probe`, `sandbox_run`, `git_info`

**Options:**

- `sys_probe.action`: Read host resources, network/power/session metadata or device candidates without opening devices. Values: `host`, `devices`, `listeners`, `services`, `processes`, `service_detail`, `journal`, `diagnose`.
- `command`: Inline sandbox Bash script.
- `files[].path`: Relative disposable destination.
- `files[].content|source`: Exactly one inline fixture or project source.
- `timeoutMs`: Sandbox execution timeout, 1000–120000.
- `background`: Opt in to the existing background-task owner for disposable experiments; completion arrives without polling.
- `maxOutputBytes`: Sandbox output bound, 1024–65536.
- `PI_WRITE_DEGENERATION`: Disable the repeated-write degeneration heuristic only when set to 0. Values: `0`.
- `PI_SIBLING_STALE_WRITES`: Restore advisory-only sibling write behavior when off.

**Related records:** `session-coordination`, `subagent-dispatch`, `quick-commands`

**Source:** [`agent/extensions/sandbox.ts`](../agent/extensions/sandbox.ts), [`agent/extensions/filesystem-safety.ts`](../agent/extensions/filesystem-safety.ts), [`agent/extensions/lib/host-operation-safety.ts`](../agent/extensions/lib/host-operation-safety.ts), [`agent/extensions/sys-probe.ts`](../agent/extensions/sys-probe.ts), [`agent/extensions/siblings.ts`](../agent/extensions/siblings.ts)

**Documentation:** [`docs/SECURITY.md`](SECURITY.md)

### web_media

#### site-seo

Proactive public-site SEO: route purpose and content planning, built HTML inspection, bounded same-origin robots/sitemap/link-graph/canonical/status/hreflang/schema/media/cache audits, and synchronized public sitemap/index, llms.txt, feed and entity-graph generation. Public website/content work stages the tools automatically; private apps remain excluded. Raw, rendered, editorial, factual, freshness and performance evidence remain distinct.

**Entrypoints:** `seo_toolkit`

**Catalog tool pointers:** `seo_toolkit`, `web_probe`, `web_search`, `fetch_content`, `render_see`, `browser_session`

**Options:**

- `action`: Plan, inspect raw built HTML, audit served pages, generate discovery artifacts, or page an existing snapshot. Values: `plan`, `inspect`, `audit`, `discovery`, `report`.
- `scope`: Public/private/unknown intent; private scope performs no network/generation.
- `pages`: Reviewed canonical route purpose, query intent and real dates.
- `maxPages|offset|view|resultId`: Bounded crawl and paginated evidence; report reuses session snapshots without refetching.
- `path|html|url|canonicalOrigin`: Built HTML source or served public URL and canonical origin.

**Related records:** `web-and-media`, `workflow-orchestration`, `source-intelligence`

**Source:** [`agent/extensions/pi-web-access/seo-toolkit.ts`](../agent/extensions/pi-web-access/seo-toolkit.ts), [`agent/extensions/pi-web-access/seo-document.ts`](../agent/extensions/pi-web-access/seo-document.ts), [`agent/extensions/pi-web-access/seo-audit.ts`](../agent/extensions/pi-web-access/seo-audit.ts), [`agent/extensions/pi-web-access/seo-discovery.ts`](../agent/extensions/pi-web-access/seo-discovery.ts), [`agent/extensions/lib/seo-policy.ts`](../agent/extensions/lib/seo-policy.ts), [`agent/extensions/lib/task-pipelines.ts`](../agent/extensions/lib/task-pipelines.ts), [`agent/extensions/lib/session-hooks.ts`](../agent/extensions/lib/session-hooks.ts)

**Documentation:** [`docs/SITE-SEO.md`](SITE-SEO.md)

#### web-and-media

Search and read web sources, operate browser tabs with DOM refs, screenshots, console JavaScript and condition waits, ask for CAPTCHA help, and analyze local media through bounded tools.

**Entrypoints:** `web_search`, `source_check`, `fetch_content`, `get_search_content`, `web_research`, `web_probe`, `github_search`, `browser_session`, `render_see`, `media_info`, `video_frames`, `audio_analyze`, `music_compose`

**Catalog tool pointers:** `web_search`, `source_check`, `fetch_content`, `get_search_content`, `web_research`, `web_probe`, `github_search`, `browser_session`, `render_see`, `media_info`, `video_frames`, `audio_analyze`, `music_compose`

**Commands:** `/websearch`, `/search`, `/curator`, `/google-account`

**Options:**

- `query|queries`: One or several search angles.
- `provider`: Configured search route or explicit provider list.
- `fallbackProviders`: Research routes tried after an empty or failed preceding route.
- `sourceUrls`: Known HTTP sources for bounded background research.
- `readPages`: Research source page bound, 0–8.
- `recencyFilter|domainFilter`: Search narrowing filters.
- `workflow`: Search workflow. Values: `none`, `summary-review`, `auto-summary`.
- `url|urls`: Web or local source targets.
- `mode`: Fetch mode. Values: `readable`, `raw`, `answer`.
- `github_search.action`: GitHub operation: ranked repository search over several angles, a project's user requests by reactions, code search (token), or one repository's fact sheet. Values: `repos`, `issues`, `code`, `repo`.
- `action`: Browser or media operation selected by the tool schema.
- `session|tab|ref|frame`: Reuse owned browser handles and fresh DOM targets, including popup tabs and iframe ids.
- `kind|state|timeoutMs`: Browser waits or verification: exact text, element state or a boolean page predicate. verify executes predicates once and charges the script action budget.
- `query|offset|maxChars`: Search and paginate rendered page text with browser_session read.
- `reason`: request_help asks the user about a blocking verification challenge with a screenshot.
- `path|times|count|width|height`: Local media and frame bounds.

**Related records:** `source-intelligence`, `safety-bounds`, `background-tasks`

**Source:** [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts), [`agent/extensions/pi-web-access/research-jobs.ts`](../agent/extensions/pi-web-access/research-jobs.ts), [`agent/extensions/pi-web-access/web-probe.ts`](../agent/extensions/pi-web-access/web-probe.ts), [`agent/extensions/pi-web-access/github-search.ts`](../agent/extensions/pi-web-access/github-search.ts), [`agent/extensions/pi-web-access/github-rest.ts`](../agent/extensions/pi-web-access/github-rest.ts), [`agent/extensions/lib/browser-session.ts`](../agent/extensions/lib/browser-session.ts), [`agent/extensions/render-and-wait.ts`](../agent/extensions/render-and-wait.ts), [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts)

**Documentation:** [`docs/ISOLATION-AND-WEB.md`](ISOLATION-AND-WEB.md)

#### creative-studio

Author editable local 3D scenes and fixed-clock animations, render H.264 video and posters, compose clip transitions and mix local audio. Three.js studio/clay/toon/wireframe styles, keyframes, camera and lights; no hosted generation or model calls.

**Entrypoints:** `audio_mix`

**Catalog tool pointers:** `audio_mix`, `music_compose`, `media_info`, `video_frames`, `audio_analyze`

**Options:**

- `scene`: Versioned declarative objects, materials, camera, lights and keyframes; inspect the live schema for bounds.
- `outputDir`: Fresh workspace artifact directory; originals preserved.
- `path`: Local scene or media source, never a URL.
- `clips|tracks`: Explicit bounded timeline and audio inputs, with decode verification.

**Related records:** `web-and-media`, `artifact-numeric-checks`, `background-tasks`

**Source:** [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts), [`agent/extensions/lib/media-timeline.ts`](../agent/extensions/lib/media-timeline.ts)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

#### video-studio

Produce code-first videos: Remotion projects driven by one master video.json timeline, a look derived from the subject (palette, type pair, backdrop, voice and music that avoid the stock looks) with design and source lint, reusable SVG/Canvas primitives, Blender shots (RGBA sequences with 3D-tracked annotations, alpha image cards, shared arrays, staggered object motion and editable camera/lens paths) and vanilla HTML/WebGL motion pages in the timeline, a library of worked motion examples to search and copy, independent /models image/speech/music/SFX choices, capability-aware image plans, local Piper or selected ElevenLabs narration with measured durations, seeded procedural music/sfx, license-tracked media, stills contact sheets, scene previews, decode-verified finals and fixed-camera RGB atmosphere over approved detailed plates, and revision-bound visual/playback/listening review alongside technical QA.

**Entrypoints:** `video_project`, `video_render`, `video_shot`, `motion_examples`, `video_qa`, `narration_tts`, `audio_synth`, `video_browser`, `image_generate`, `audio_generate`

**Catalog tool pointers:** `video_project`, `video_render`, `video_shot`, `motion_examples`, `video_assets`, `video_qa`, `narration_tts`, `audio_synth`, `video_frames`, `media_info`, `audio_analyze`, `video_browser`, `image_generate`, `audio_generate`, `media_sync`

**Options:**

- `dir`: Video project directory inside the workspace (video.json + src/).
- `mode`: stills with contact sheet, review with critical stills plus bounded playback in one browser, preview of a scene or seconds range, resumable segments, final or thumbnail. Values: `stills`, `review`, `preview`, `segments`, `final`, `thumbnail`.
- `action`: Project init/compose/plan/check/install or narration status/install/synthesize.
- `flow|phase|beat`: Job-specific production plans with current blockers and exact next calls; storyboard beat role/claim/visualAction preserves the visual argument. Plans neither spend nor approve art.
- `kind`: Procedural audio music bed or sound effect. Values: `music`, `sfx`.
- `look`: derive (default) builds the look from the subject, suggest lists curated looks; variation and accent re-roll or anchor it.
- `model|maxCostUsd`: Media tool override; /models preferences stay independent of the LLM. Plans reject unknown pricing units and incompatible capabilities. Quotes are estimates, not provider spending limits.
- `cameraPath|scene.objects.instances`: Editable camera target/lens keys and shared line/grid/radial instances with bounded staggering; video_shot action:plan creates no output.
- `rig|lights|material|shadow|anchors`: video_shot: Blender camera move, lighting, material, ground shadow and named 3D anchors for pinned annotations.
- `approach|query`: motion_examples: search, get or copy worked examples (html, blender, merge, ffmpeg, python). Values: `html`, `blender`, `merge`, `ffmpeg`, `python`.

**Related records:** `creative-studio`, `web-and-media`, `background-tasks`, `3d-studio`

**Source:** [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts), [`agent/extensions/lib/video-studio.ts`](../agent/extensions/lib/video-studio.ts), [`agent/extensions/lib/video-production-flow.ts`](../agent/extensions/lib/video-production-flow.ts), [`agent/extensions/lib/video-review-evidence.ts`](../agent/extensions/lib/video-review-evidence.ts), [`agent/extensions/lib/video-color-evidence.ts`](../agent/extensions/lib/video-color-evidence.ts), [`agent/extensions/lib/video-looks.ts`](../agent/extensions/lib/video-looks.ts), [`agent/extensions/lib/video-derive.ts`](../agent/extensions/lib/video-derive.ts), [`agent/extensions/lib/video-shot.ts`](../agent/extensions/lib/video-shot.ts), [`agent/extensions/lib/media-model-routing.ts`](../agent/extensions/lib/media-model-routing.ts), [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts), [`core/coding-agent/src/core/media-models.js`](../core/coding-agent/src/core/media-models.js), [`core/coding-agent/src/modes/interactive/components/scoped-models-selector.js`](../core/coding-agent/src/modes/interactive/components/scoped-models-selector.js), [`agent/extensions/lib/motion-library.ts`](../agent/extensions/lib/motion-library.ts), [`agent/scripts/video-render.mjs`](../agent/scripts/video-render.mjs), [`agent/skills/motion-approaches/SKILL.md`](../agent/skills/motion-approaches/SKILL.md)

**Documentation:** [`docs/VIDEO-STUDIO.md`](VIDEO-STUDIO.md)

#### 3d-studio

Headless Blender as one tool with actions: setup (pinned local 5.2.2 LTS install and engine report), run (agent-authored bpy scripts), inspect (scene summary), render (bounded still/preview/animation with contact sheets; EEVEE headless, Cycles CPU). Every process is guarded, niced and memory-watched.

**Entrypoints:** `blender`

**Catalog tool pointers:** `blender`, `video_shot`, `video_frames`, `media_info`

**Options:**

- `blend`: Local .blend file; renders and exports never modify it.
- `code|script`: Inline bpy Python or a .py path run with --factory-startup; print YUNUSPI_RESULT {json} to return data.
- `mode`: Render still frames, a quarter-resolution preview or a from/to animation with mp4 and contact sheet. Values: `still`, `preview`, `animation`.
- `format`: Geometry export or a nerfstudio transforms.json dataset (with init.ply seed points) for splat training. Values: `glb`, `gltf`, `obj`, `ply`, `stl`, `usd`, `fbx`, `abc`, `blend`, `dataset`.
- `dataset|path`: COLMAP or transforms.json dataset to train; a splat PLY to preview.
- `action`: status/install for both engines; check validates a dataset and prints the command.

**Related records:** `video-studio`, `creative-studio`, `web-and-media`, `background-tasks`

**Source:** [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts), [`agent/extensions/lib/blender-studio.ts`](../agent/extensions/lib/blender-studio.ts), [`agent/extensions/lib/guarded-process.ts`](../agent/extensions/lib/guarded-process.ts), [`agent/scripts/blender-studio.py`](../agent/scripts/blender-studio.py)

**Documentation:** [`docs/3D-STUDIO.md`](3D-STUDIO.md)

#### office-and-deliverables

Read, build, verify and render Office files with no office suite, and open any produced file before calling it done. office_doc reads docx, xlsx, pptx and OpenDocument into structured content with findings (damaged packages, unreplaced placeholders, uncalculated or error formulas, post-2007 functions stored without the _xlfn. prefix, numbers stored as text, empty slides), builds docx, xlsx and pptx decks from declarative specs (a deck is laid out and measured for the model: type sizes chosen to fit, long lists and tables continue on numbered follow-on slides) with real styles, list numbering, repeating table headers, frozen panes, number formats and calculated formula results (about 100 functions including SUMIF, COUNTIF, VLOOKUP, INDEX/MATCH, XLOOKUP, TEXT and DATE, checked against LibreOffice), renders PDF and PNG pages through LibreOffice, and converts between formats with LibreOffice (office_doc convert: docx, xlsx, pptx, pdf, odt, csv per sheet, txt, html, and the legacy doc, xls, ppt, rtf, which the read tool and office_doc read also open by converting them). deliverable_check inspects PDFs, images, SVG, video, audio, CSV, JSON, HTML, Markdown and archives for measurable defects. A tracker notices final-product files that scripts wrote, lists unopened ones once in the answer footer and wakes the model at most twice per distinct set to check them. For documents the session itself produced (docx, pptx, odt, odp, pdf) the checks also compare the specifics they state (emails, phone numbers, links, greeting and signature names, rooms and addresses, dates, times, amounts) with the user's words, tool output and the input files the session referenced, and warn about contact data, names and places that appeared nowhere, so a made-up room or phone number is caught instead of delivered. The native read tool no longer returns raw bytes for binary files: a PDF reads as page text (offset is the page), an Office file as structured text, and an archive, SQLite database or media file as its entries, schema or streams.

**Entrypoints:** `office_doc`, `deliverable_check`

**Catalog tool pointers:** `office_doc`, `deliverable_check`, `render_see`, `video_frames`, `audio_analyze`, `data_query`

**Options:**

- `action`: office_doc operation. Values: `read`, `verify`, `build`, `render`, `convert`.
- `spec`: build content: docx {title, blocks:[heading|paragraph|bullets|numbered|table|image|quote|code|pagebreak], page, font, header, footer}, xlsx {sheets:[{name, columns, rows, totals, freeze, filter}]} (strings starting with = are formulas) or pptx {title, size, font, accent, dark, footer, slides:[{title, subtitle, bullets, numbered, columns, image, table, quote, text, notes}]}.
- `to`: convert: the format to write (docx, xlsx, pptx, pdf, odt, ods, odp, doc, xls, ppt, rtf, txt, html, csv); outPath chooses the destination inside the workspace, overwrite:true replaces an existing file.
- `pdfPath`: render: also save the PDF at this path inside the workspace and check it; with pages 0 the Office file becomes a checked PDF in one call.
- `paths`: deliverable_check files (1 to 8, relative to the working directory or absolute).
- `PI_DELIVERABLES`: Set to off to disable the unopened-file tracker and its follow-ups; the tools stay available. Values: `on`, `off`.
- `PI_SPECIFICS`: Set to off to stop comparing the specifics of documents this session produced (contact data, names, rooms, dates, times, amounts) with what the session was told or showed. Values: `on`, `off`.
- `PI_BINARY_READ`: Set to off to restore the raw read of binary files. By default read shows a PDF as page text, an Office file as structured text, and an archive, database or media file as what it contains. Values: `on`, `off`.

**Related records:** `creative-studio`, `video-studio`, `quality-review`, `background-tasks`

**Source:** [`agent/extensions/deliverables.ts`](../agent/extensions/deliverables.ts), [`agent/extensions/lib/office-read.ts`](../agent/extensions/lib/office-read.ts), [`agent/extensions/lib/office-build.ts`](../agent/extensions/lib/office-build.ts), [`agent/extensions/lib/sheet-formula.ts`](../agent/extensions/lib/sheet-formula.ts), [`agent/extensions/lib/office-zip.ts`](../agent/extensions/lib/office-zip.ts), [`agent/extensions/lib/xml-lite.ts`](../agent/extensions/lib/xml-lite.ts), [`agent/extensions/lib/office-render.ts`](../agent/extensions/lib/office-render.ts), [`agent/extensions/lib/binary-read.ts`](../agent/extensions/lib/binary-read.ts), [`agent/extensions/lib/specifics.ts`](../agent/extensions/lib/specifics.ts), [`agent/extensions/lib/pptx-build.ts`](../agent/extensions/lib/pptx-build.ts), [`agent/extensions/lib/deliverable-inspect.ts`](../agent/extensions/lib/deliverable-inspect.ts), [`agent/extensions/lib/deliverable-ledger.ts`](../agent/extensions/lib/deliverable-ledger.ts)

**Documentation:** [`docs/OFFICE-AND-DELIVERABLES.md`](OFFICE-AND-DELIVERABLES.md)

#### ui-engineering

Autonomous UI engineering through the existing adaptive pipeline and creative direction owners. ui_explore covers touch/DPR/orientation and breakpoint neighbors with explicit bounded coverage. motion_inspect scroll samples forward/backtracking and reduced states in one live document, including JS/scroll-driven effects; ui_consistency compares shared role/token measurements across routes with declared variants and missing coverage. Main prompts, short follow-ups, goals and observed source changes refresh the relevant tools and evidence stages. Prepared code, measured drift and screenshots never establish interaction or artistic approval.

**Entrypoints:** `ui_explore`, `motion_inspect`, `ui_consistency`

**Catalog tool pointers:** `creative_direct`, `ui_explore`, `motion_inspect`, `ui_consistency`, `render_see`, `visual_review`, `browser_session`, `asset_register`, `blender`, `image_generate`

**Related records:** `design-studio`, `art-direction`, `3d-studio`, `source-intelligence`, `task-pipelines`

**Source:** [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts), [`agent/scripts/ui-motion-runtime.mjs`](../agent/scripts/ui-motion-runtime.mjs), [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts), [`agent/extensions/lib/creative-qa.ts`](../agent/extensions/lib/creative-qa.ts), [`agent/extensions/lib/motion-inspect.ts`](../agent/extensions/lib/motion-inspect.ts), [`agent/extensions/adaptive-workflows.ts`](../agent/extensions/adaptive-workflows.ts), [`agent/extensions/lib/task-pipelines.ts`](../agent/extensions/lib/task-pipelines.ts)

**Documentation:** [`docs/UI-ENGINEERING.md`](UI-ENGINEERING.md)

#### design-studio

Turn design references into code. image_understand uses the selected vision model with hashed crop/scale evidence; image_crop cuts and keys assets at source resolution; render_see compares the build against the reference at the same width. Pixel measurements and model observations remain evidence, not design intent.

**Entrypoints:** `image_understand`, `image_crop`

**Catalog tool pointers:** `image_understand`, `image_crop`, `render_see`

**Options:**

- `path|url`: Local image, or an http(s) image downloaded once through the SSRF-guarded fetcher and kept locally.
- `scale|referenceScale`: Reference pixel ratio (2 for @2x exports); inferred from common export widths.
- `ocr`: Attach recognized copy to text blocks with local Tesseract.
- `map|blocks|kinds`: Target assets by design-map block ids or kinds.
- `key|trim|format`: Edge-connected background keying with de-fringing, trimming, and PNG/JPEG/WebP selection.
- `source|candidate|region`: Build to compare: an HTML path or URL rendered at the reference width (long pages in slices) or a screenshot; optional reference region.
- `op`: Procedural plate to synthesize: solid, linear-gradient, checker, noise or grid. Values: `solid`, `linear-gradient`, `checker`, `noise`, `grid`.
- `outputDir`: Artifacts default to the git-ignored .pi/design folder in the workspace.

**Related records:** `rendered-design-review`, `web-and-media`, `artifact-numeric-checks`

**Source:** [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts), [`agent/extensions/lib/design-studio.ts`](../agent/extensions/lib/design-studio.ts), [`agent/extensions/lib/image-analysis.ts`](../agent/extensions/lib/image-analysis.ts), [`agent/extensions/lib/image-understand.ts`](../agent/extensions/lib/image-understand.ts), [`agent/scripts/render-capture.mjs`](../agent/scripts/render-capture.mjs)

**Documentation:** [`docs/DESIGN-STUDIO.md`](DESIGN-STUDIO.md)

#### art-direction

Close the creative loop around one shared direction. creative_direct owns the structured brief (intent, focal hierarchy, visual bounds, avoid-list, motion and audio character); visual_review captures real renders and records revision-sensitive rubric verdicts; ui_explore renders the viewport/state matrix with DOM facts; motion_inspect inventories animations and samples verified periods without claiming an arbitrary sample is a loop seam; media_info motion measures bounded decoded video frames; svg_render exports authored CSS/SMIL/data-keyframe SVG to sampled PNGs or narrated H.264 with clock/clipping diagnostics; svg_inspect measures geometry and set consistency; asset_register keeps provenance, roles and reuse search and inspects contained glTF/GLB dependencies, meshes and animation metadata; image_generate briefs and calls the native OpenRouter or configured OpenAI-compatible backend with review routing; creative_compare renders direction variants side by side. Blocking verdicts hold the completion gate.

**Entrypoints:** `creative_direct`, `visual_review`, `ui_explore`, `ui_consistency`, `motion_inspect`, `svg_render`, `svg_inspect`, `asset_register`, `image_generate`, `creative_compare`

**Catalog tool pointers:** `creative_direct`, `visual_review`, `ui_explore`, `ui_consistency`, `motion_inspect`, `svg_render`, `svg_inspect`, `asset_register`, `image_generate`, `creative_compare`, `render_see`

**Options:**

- `action`: Direction set/get/brief/status/clear; review run/record/status; SVG inspect/matrix; asset register/get/search/usage; image status/brief/generate/edit.
- `direction`: Structured brief object: intent, hierarchy.primary, visual, avoid, motion, audio, references.
- `source|sources`: Local HTML/SVG path or http(s) URL; compare takes 2..4 variants at one width.
- `viewports|states|devices|breakpoints`: Narrow 320px/mobile/tablet/desktop plus touch/DPR/orientation profiles and breakpoint neighbors. The 12-capture bound covers widths before variants and reports omitted cells.
- `detail`: ui_explore and visual_review run return compact text with full measurements in report; true includes typography/spacing inline. Findings and coverage remain inline either way.
- `runId|entrypoint`: Record a matching current visual capture by runId, which can recover its source in this session; entrypoint binds served/compiled URL evidence to its workspace HTML. Every rubric section and delivered vision evidence are required.
- `PI_UI_VERIFICATION`: Default on: UI edits stage native QA, SVG saves get structural review, missing/stale evidence feeds completion, with at most two automatic follow-ups. off is an explicit opt-out.
- `mode|positions|backtrack`: Time inventory or live scroll-mode observations, forward/backtracking and reduced-motion frames; continuous smoothness and GPU cost remain unknown.
- `verdict`: Recorded rubric sections with PASS/WARN/FAIL/UNKNOWN plus evidence lines; UNKNOWN stays open, FAIL blocks completion.
- `role`: Asset purpose: hero-focal, editorial-support, diagram, texture, icon, illustration, background, product-shot, avatar.
- `prompt|negative|aspect|size|seed`: Generation brief: prompt plus direction/role constraints; configured backend required.

**Related records:** `design-studio`, `rendered-design-review`, `creative-studio`, `video-studio`

**Source:** [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts), [`agent/extensions/lib/creative-direction.ts`](../agent/extensions/lib/creative-direction.ts), [`agent/extensions/lib/creative-qa.ts`](../agent/extensions/lib/creative-qa.ts), [`agent/extensions/lib/creative-evidence.ts`](../agent/extensions/lib/creative-evidence.ts), [`agent/extensions/lib/motion-inspect.ts`](../agent/extensions/lib/motion-inspect.ts), [`agent/extensions/lib/svg-inspect.ts`](../agent/extensions/lib/svg-inspect.ts), [`agent/extensions/lib/svg-render.ts`](../agent/extensions/lib/svg-render.ts), [`agent/extensions/lib/asset-registry.ts`](../agent/extensions/lib/asset-registry.ts), [`agent/extensions/lib/gltf-inspect.ts`](../agent/extensions/lib/gltf-inspect.ts), [`agent/extensions/lib/video-motion.ts`](../agent/extensions/lib/video-motion.ts), [`agent/extensions/lib/image-generate.ts`](../agent/extensions/lib/image-generate.ts), [`agent/scripts/render-capture.mjs`](../agent/scripts/render-capture.mjs)

**Documentation:** [`docs/ART-DIRECTION.md`](ART-DIRECTION.md)

## Static tool and command registrations

Tool names come from literal registrations and source-owned factory definitions, catalogs and constants. Command names come from literal `registerCommand` calls. Computed registration names are listed as owners below; they are not guessed. Use `tool_search` for the authoritative live registry and activation state.

### Native core tools

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Extensions can wrap or replace these; explicit tool selections still apply.

### Stable extension tools

- `archive_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 24; catalog)
- `asset_register` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 510; factory)
- `ast_diff` — [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts) (line 12; definition)
- `audio_analyze` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 161; factory)
- `audio_generate` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 132; factory)
- `audio_mix` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 169; factory)
- `audio_synth` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 144; factory)
- `bash` — [`agent/extensions/managed-bash.ts`](../agent/extensions/managed-bash.ts) (line 586; sdk-factory)
- `bg_kill` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 867; literal)
- `bg_logs` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 821; literal)
- `bg_run` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 731; literal)
- `bg_status` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 790; literal)
- `bg_wait` — [`agent/extensions/pi-subagents/src/runs/background/wait-tool.ts`](../agent/extensions/pi-subagents/src/runs/background/wait-tool.ts) (line 36; definition)
- `blender_inspect` — [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts) (line 54; factory)
- `blender_render` — [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts) (line 58; factory)
- `blender_run` — [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts) (line 50; factory)
- `blender_setup` — [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts) (line 46; factory)
- `browser_session` — [`agent/extensions/lib/browser-session.ts`](../agent/extensions/lib/browser-session.ts) (line 166; literal)
- `bulk_edit` — [`agent/extensions/bulk-edit.ts`](../agent/extensions/bulk-edit.ts) (line 217; literal)
- `checkpoint_read` — [`agent/extensions/checkpoints.ts`](../agent/extensions/checkpoints.ts) (line 222; literal)
- `colab` — [`agent/extensions/colab.ts`](../agent/extensions/colab.ts) (line 239; literal)
- `contact_supervisor` — [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) (line 305; definition)
- `context_slice` — [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts) (line 10; definition)
- `creative_compare` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 614; factory)
- `creative_direct` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 314; factory)
- `data_query` — [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts) (line 119; factory)
- `deliverable_check` — [`agent/extensions/deliverables.ts`](../agent/extensions/deliverables.ts) (line 135; literal)
- `expert_director` — [`agent/extensions/expert-director.ts`](../agent/extensions/expert-director.ts) (line 65; literal)
- `fetch_content` — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 198; configured-default)
- `get_search_content` — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 199; configured-default)
- `git_info` — [`agent/extensions/git-tools.ts`](../agent/extensions/git-tools.ts) (line 397; literal)
- `github_search` — [`agent/extensions/pi-web-access/github-search.ts`](../agent/extensions/pi-web-access/github-search.ts) (line 422; literal)
- `goal` — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 399; literal)
- `handoff_capsule` — [`agent/extensions/pi-memory/context-tools.ts`](../agent/extensions/pi-memory/context-tools.ts) (line 8; literal)
- `http_request` — [`agent/extensions/http-tools.ts`](../agent/extensions/http-tools.ts) (line 496; literal)
- `image_crop` — [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts) (line 32; factory)
- `image_generate` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 556; factory)
- `image_understand` — [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts) (line 29; factory)
- `math_check` — [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts) (line 102; factory)
- `media_info` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 159; factory)
- `media_sync` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 140; factory)
- `memory_forget` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2604; literal)
- `memory_read` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2464; literal)
- `memory_restore` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2747; literal)
- `memory_search` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2846; literal)
- `memory_status` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 3001; literal)
- `memory_write` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2116; literal)
- `micro_status` — [`agent/extensions/micro-intelligence.ts`](../agent/extensions/micro-intelligence.ts) (line 501; literal)
- `micro_task` — [`agent/extensions/lib/micro-intelligence/micro-task.ts`](../agent/extensions/lib/micro-intelligence/micro-task.ts) (line 46; literal)
- `motion_examples` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 156; factory)
- `motion_inspect` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 444; factory)
- `music_compose` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 166; factory)
- `narration_tts` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 128; factory)
- `net_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 22; catalog)
- `obs_read` — [`agent/extensions/pi-observations.ts`](../agent/extensions/pi-observations.ts) (line 710; literal)
- `office_doc` — [`agent/extensions/deliverables.ts`](../agent/extensions/deliverables.ts) (line 170; literal)
- `package_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 20; catalog)
- `process` — [`agent/extensions/managed-bash.ts`](../agent/extensions/managed-bash.ts) (line 618; literal)
- `project_intel` — [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts) (line 805; literal)
- `quality_review` — [`agent/extensions/lib/quality-review.ts`](../agent/extensions/lib/quality-review.ts) (line 811; literal)
- `read_many` — [`agent/extensions/cost-governor.ts`](../agent/extensions/cost-governor.ts) (line 256; literal)
- `render_see` — [`agent/extensions/render-and-wait.ts`](../agent/extensions/render-and-wait.ts) (line 242; literal)
- `sandbox_run` — [`agent/extensions/sandbox.ts`](../agent/extensions/sandbox.ts) (line 59; literal)
- `scratchpad` — [`agent/extensions/pi-memory/index.ts`](../agent/extensions/pi-memory/index.ts) (line 2277; literal)
- `seo_toolkit` — [`agent/extensions/pi-web-access/seo-toolkit.ts`](../agent/extensions/pi-web-access/seo-toolkit.ts) (line 45; literal)
- `session_coordinate` — [`agent/extensions/siblings.ts`](../agent/extensions/siblings.ts) (line 824; literal)
- `session_self` — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1876; literal)
- `session_stop` — [`agent/extensions/checkpoints.ts`](../agent/extensions/checkpoints.ts) (line 377; literal)
- `skill_review` — [`agent/extensions/lib/relevant-guidance.ts`](../agent/extensions/lib/relevant-guidance.ts) (line 690; literal)
- `source_check` — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 197; configured-default)
- `sqlite_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 18; catalog)
- `ssh_plan` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 14; catalog)
- `structured_output` — [`agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`](../agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts) (line 940; literal)
- `studio` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 172; factory)
- `subagent` — [`agent/extensions/pi-subagents/src/extension/fanout-child.ts`](../agent/extensions/pi-subagents/src/extension/fanout-child.ts) (line 179; definition)
- `subagent` — [`agent/extensions/pi-subagents/src/extension/index.ts`](../agent/extensions/pi-subagents/src/extension/index.ts) (line 783; definition)
- `subagent_supervisor` — [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) (line 22; constant)
- `svg_inspect` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 475; factory)
- `svg_render` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 470; factory)
- `symbol_expand` — [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts) (line 11; definition)
- `sys_probe` — [`agent/extensions/sys-probe.ts`](../agent/extensions/sys-probe.ts) (line 258; literal)
- `task_pipeline` — [`agent/extensions/adaptive-workflows.ts`](../agent/extensions/adaptive-workflows.ts) (line 580; literal)
- `task_state` — [`agent/extensions/task-state.ts`](../agent/extensions/task-state.ts) (line 156; literal)
- `todo` — [`agent/extensions/rpiv-todo/tool/types.ts`](../agent/extensions/rpiv-todo/tool/types.ts) (line 11; constant)
- `tool_search` — [`agent/extensions/lib/tool-discovery.ts`](../agent/extensions/lib/tool-discovery.ts) (line 521; literal)
- `ui_consistency` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 433; factory)
- `ui_explore` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 406; factory)
- `value_convert` — [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts) (line 115; factory)
- `video_assets` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 122; factory)
- `video_browser` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 142; factory)
- `video_frames` — [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) (line 160; factory)
- `video_project` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 68; factory)
- `video_qa` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 118; factory)
- `video_render` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 114; factory)
- `video_shot` — [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) (line 91; factory)
- `visual_review` — [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) (line 356; factory)
- `web_asset_check` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 16; catalog)
- `web_probe` — [`agent/extensions/pi-web-access/web-probe.ts`](../agent/extensions/pi-web-access/web-probe.ts) (line 275; literal)
- `web_research` — [`agent/extensions/pi-web-access/research-jobs.ts`](../agent/extensions/pi-web-access/research-jobs.ts) (line 73; literal)
- `web_search` — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 196; configured-default)
- `workdir_snapshot` — [`agent/extensions/scoped-snapshots.ts`](../agent/extensions/scoped-snapshots.ts) (line 12; literal)
- `workspace_search` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) (line 12; catalog)

### Dynamic tool owners

- [`agent/extensions/agentmail.ts`](../agent/extensions/agentmail.ts) — registerTool() receives a computed or indirect definition; the runtime name is not inferred (lines 1116)
- [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `asset_register`, `creative_compare`, `creative_direct`, `image_generate`, `motion_inspect`, `svg_inspect`, `svg_render`, `ui_consistency`, `ui_explore`, `visual_review` (lines 280)
- [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `blender_inspect`, `blender_render`, `blender_run`, `blender_setup` (lines 63)
- [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts) — registerTool() receives a computed or indirect definition; the runtime name is not inferred; known tools: `image_crop`, `image_understand` (lines 19)
- [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `data_query`, `math_check`, `value_convert` (lines 85)
- [`agent/extensions/managed-bash.ts`](../agent/extensions/managed-bash.ts) — registration receives the SDK createBashToolDefinition() for the active cwd; known tools: `bash`, `process` (lines 589)
- [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `audio_analyze`, `audio_mix`, `media_info`, `music_compose`, `studio`, `video_frames` (lines 149)
- [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts) — registration loops over definitions; literal definition names are enumerated; known tools: `ast_diff`, `context_slice`, `symbol_expand` (lines 14)
- [`agent/extensions/pi-subagents/src/extension/fanout-child.ts`](../agent/extensions/pi-subagents/src/extension/fanout-child.ts) — registration receives the source-owned subagent definition; known tools: `subagent` (lines 192)
- [`agent/extensions/pi-subagents/src/extension/index.ts`](../agent/extensions/pi-subagents/src/extension/index.ts) — registration receives the source-owned subagent definition; known tools: `subagent` (lines 834)
- [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) — registration receives source-owned supervisor tool definitions; known tools: `contact_supervisor`, `subagent_supervisor` (lines 313, 658)
- [`agent/extensions/pi-subagents/src/runs/background/wait-tool.ts`](../agent/extensions/pi-subagents/src/runs/background/wait-tool.ts) — registration receives the source-owned primaryTool definition; known tools: `bg_wait` (lines 42)
- [`agent/extensions/pi-vector-memory.ts`](../agent/extensions/pi-vector-memory.ts) — registerTool() receives a computed or indirect definition; the runtime name is not inferred (lines 592)
- [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) — registration uses configurable toolNames; checked-in defaults are enumerated; known tools: `fetch_content`, `get_search_content`, `source_check`, `web_search` (lines 1668, 2256, 2410, 2809)
- [`agent/extensions/rpiv-todo/todo.ts`](../agent/extensions/rpiv-todo/todo.ts) — registration uses the source-owned TOOL_NAME constant; known tools: `todo` (lines 124)
- [`agent/extensions/utility-tools.ts`](../agent/extensions/utility-tools.ts) — registration loops over the static TOOLS catalog; catalog names are enumerated; known tools: `archive_probe`, `net_probe`, `package_probe`, `sqlite_probe`, `ssh_plan`, `web_asset_check`, `workspace_search` (lines 31)
- [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `audio_generate`, `audio_synth`, `media_sync`, `motion_examples`, `narration_tts`, `video_assets`, `video_browser`, `video_project`, `video_qa`, `video_render`, `video_shot` (lines 36)

### Literal slash commands

- /3d — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 376)
- /anatomy — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 390)
- /bg — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 568)
- /bg-clear — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 610)
- /bg-tasks — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 602)
- /bg-update — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 618)
- /budget — [`agent/extensions/cost-governor.ts`](../agent/extensions/cost-governor.ts) (line 884)
- /catalog-status — [`agent/extensions/live-models.ts`](../agent/extensions/live-models.ts) (line 1731)
- /claude-cache — [`agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts`](../agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts) (line 2161)
- /commands — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1846)
- /cost — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1398)
- /curator — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 3404)
- /custom-double — [`agent/extensions/pi-subagents/src/extension/double-runner.ts`](../agent/extensions/pi-subagents/src/extension/double-runner.ts) (line 488)
- /double — [`agent/extensions/pi-subagents/src/extension/double-runner.ts`](../agent/extensions/pi-subagents/src/extension/double-runner.ts) (line 468)
- /effort — [`agent/extensions/thinking.ts`](../agent/extensions/thinking.ts) (line 49)
- /errors — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1812)
- /export-json — [`agent/extensions/session-export-json.ts`](../agent/extensions/session-export-json.ts) (line 72)
- /goal — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 351)
- /google-account — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 3446)
- /graph — [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts) (line 921)
- /harness-backup — [`agent/extensions/harness-backup.ts`](../agent/extensions/harness-backup.ts) (line 37)
- /hook-audit — [`agent/extensions/lib/session-telemetry.ts`](../agent/extensions/lib/session-telemetry.ts) (line 78)
- /jobs — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 648)
- /kill — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 695)
- /lens-allow-edit — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113838)
- /lens-context-toggle — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113542)
- /lens-drift — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113599)
- /lens-health — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113634)
- /lens-map — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113611)
- /lens-perf — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113753)
- /lens-tdi — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113567)
- /lens-toggle — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113535)
- /lens-tools — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113772)
- /lens-widget-toggle — [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) (line 113549)
- /logs — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 663)
- /memory-prime — [`agent/extensions/pi-memory/priming.ts`](../agent/extensions/pi-memory/priming.ts) (line 221)
- /metrics — [`agent/extensions/lib/session-telemetry.ts`](../agent/extensions/lib/session-telemetry.ts) (line 59)
- /models — [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts) (line 494)
- /nobug — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 369)
- /noslop — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 362)
- /obs — [`agent/extensions/pi-observations.ts`](../agent/extensions/pi-observations.ts) (line 786)
- /observer-book — [`agent/extensions/session-observer.ts`](../agent/extensions/session-observer.ts) (line 577)
- /or-provider — [`agent/extensions/provider-cmd.ts`](../agent/extensions/provider-cmd.ts) (line 654)
- /project-memory — [`agent/extensions/pi-vector-memory.ts`](../agent/extensions/pi-vector-memory.ts) (line 614)
- /prompt-workflow — [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts) (line 258)
- /provider — [`agent/extensions/provider-cmd.ts`](../agent/extensions/provider-cmd.ts) (line 653)
- /provider-health — [`agent/extensions/provider-gate.ts`](../agent/extensions/provider-gate.ts) (line 485)
- /reminder — [`agent/extensions/reminders.ts`](../agent/extensions/reminders.ts) (line 1229)
- /run — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 872)
- /search — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 3494)
- /self — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1736)
- /subagent-cost — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 912)
- /subagents — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 865)
- /subagents-check-profile — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1284)
- /subagents-detach — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 990)
- /subagents-doctor — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 919)
- /subagents-fleet — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 956)
- /subagents-generate-profiles — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1246)
- /subagents-inspect-rpc — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 926)
- /subagents-load-profile — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1159)
- /subagents-models — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1129)
- /subagents-profiles — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1147)
- /subagents-refine — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 943)
- /subagents-refresh-provider-models — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1212)
- /subagents-steer — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1058)
- /subagents-stop — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1002)
- /subagents-watchdog — [`agent/extensions/pi-subagents/src/watchdog/register-main.ts`](../agent/extensions/pi-subagents/src/watchdog/register-main.ts) (line 405)
- /sys-prompt — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1761)
- /task-state — [`agent/extensions/task-state.ts`](../agent/extensions/task-state.ts) (line 215)
- /tasks — [`agent/extensions/pi-background-tasks/src/extension.ts`](../agent/extensions/pi-background-tasks/src/extension.ts) (line 594)
- /used — [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) (line 1780)
- /video — [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) (line 383)
- /websearch — [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) (line 3143)

### Dynamic command owners

- [`agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts`](../agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts) — registerCommand() receives a computed name (lines 364)
- [`agent/extensions/rpiv-todo/todo.ts`](../agent/extensions/rpiv-todo/todo.ts) — registerCommand() receives a computed name (lines 177)

## MCP and wrapper service owners

This section reports source owners with explicit MCP or wrapper/adapter/client evidence. It names files and evidence only; it does not claim that a service is running or that every dynamically exposed tool is available.

- [`agent/extensions/checkpoints.ts`](../agent/extensions/checkpoints.ts) — `wrapper/adapter`
- [`agent/extensions/cost-governor.ts`](../agent/extensions/cost-governor.ts) — `wrapper/adapter`
- [`agent/extensions/filesystem-safety.ts`](../agent/extensions/filesystem-safety.ts) — `wrapper/adapter`
- [`agent/extensions/goal.ts`](../agent/extensions/goal.ts) — `wrapper/adapter`
- [`agent/extensions/http-tools.ts`](../agent/extensions/http-tools.ts) — `wrapper/adapter`
- [`agent/extensions/lib/code-audit.ts`](../agent/extensions/lib/code-audit.ts) — `wrapper/adapter`
- [`agent/extensions/lib/expert-domains.ts`](../agent/extensions/lib/expert-domains.ts) — `MCP`
- [`agent/extensions/lib/harness-capabilities.ts`](../agent/extensions/lib/harness-capabilities.ts) — `MCP`
- [`agent/extensions/lib/image-generate.ts`](../agent/extensions/lib/image-generate.ts) — `wrapper/adapter`
- [`agent/extensions/lib/jev-client.ts`](../agent/extensions/lib/jev-client.ts) — `wrapper/adapter`
- [`agent/extensions/lib/micro-intelligence/micro-task.ts`](../agent/extensions/lib/micro-intelligence/micro-task.ts) — `wrapper/adapter`
- [`agent/extensions/lib/micro-intelligence/span-sensor.ts`](../agent/extensions/lib/micro-intelligence/span-sensor.ts) — `wrapper/adapter`
- [`agent/extensions/lib/project-intelligence/client.mjs`](../agent/extensions/lib/project-intelligence/client.mjs) — `wrapper/adapter`
- [`agent/extensions/lib/relevant-guidance.ts`](../agent/extensions/lib/relevant-guidance.ts) — `wrapper/adapter`
- [`agent/extensions/lib/tool-discovery.ts`](../agent/extensions/lib/tool-discovery.ts) — `wrapper/adapter`
- [`agent/extensions/lib/utility-client.ts`](../agent/extensions/lib/utility-client.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/files.mjs`](../agent/extensions/lib/utility-mcp/files.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/local-reference.mjs`](../agent/extensions/lib/utility-mcp/local-reference.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/net.mjs`](../agent/extensions/lib/utility-mcp/net.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/package.mjs`](../agent/extensions/lib/utility-mcp/package.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/server.mjs`](../agent/extensions/lib/utility-mcp/server.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/system-probe.mjs`](../agent/extensions/lib/utility-mcp/system-probe.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/web-assets.mjs`](../agent/extensions/lib/utility-mcp/web-assets.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/worker.mjs`](../agent/extensions/lib/utility-mcp/worker.mjs) — `MCP`
- [`agent/extensions/lib/video-assets.ts`](../agent/extensions/lib/video-assets.ts) — `wrapper/adapter`
- [`agent/extensions/live-models.ts`](../agent/extensions/live-models.ts) — `wrapper/adapter`
- [`agent/extensions/micro-intelligence.ts`](../agent/extensions/micro-intelligence.ts) — `wrapper/adapter`
- [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts) — `wrapper/adapter`
- [`agent/extensions/pi-background-tasks/src/core/registry.ts`](../agent/extensions/pi-background-tasks/src/core/registry.ts) — `wrapper/adapter`
- [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts) — `wrapper/adapter`
- [`agent/extensions/pi-lens/dist/index.js`](../agent/extensions/pi-lens/dist/index.js) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-observations.ts`](../agent/extensions/pi-observations.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../agent/extensions/pi-subagents/src/agents/agent-management.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/agent-serializer.ts`](../agent/extensions/pi-subagents/src/agents/agent-serializer.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/agents.ts`](../agent/extensions/pi-subagents/src/agents/agents.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/runtime-agent-registry.ts`](../agent/extensions/pi-subagents/src/agents/runtime-agent-registry.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/api/preflight.ts`](../agent/extensions/pi-subagents/src/api/preflight.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/inspectors/herdr/client.ts`](../agent/extensions/pi-subagents/src/inspectors/herdr/client.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/background/async-execution.ts`](../agent/extensions/pi-subagents/src/runs/background/async-execution.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/async-resume.ts`](../agent/extensions/pi-subagents/src/runs/background/async-resume.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/run-status.ts`](../agent/extensions/pi-subagents/src/runs/background/run-status.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/subagent-runner.ts`](../agent/extensions/pi-subagents/src/runs/background/subagent-runner.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/foreground/execution.ts`](../agent/extensions/pi-subagents/src/runs/foreground/execution.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/acceptance.ts`](../agent/extensions/pi-subagents/src/runs/shared/acceptance.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/claude-code-adapter.ts`](../agent/extensions/pi-subagents/src/runs/shared/claude-code-adapter.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/codex-exec-adapter.ts`](../agent/extensions/pi-subagents/src/runs/shared/codex-exec-adapter.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/completion-guard.ts`](../agent/extensions/pi-subagents/src/runs/shared/completion-guard.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/cursor-agent-adapter.ts`](../agent/extensions/pi-subagents/src/runs/shared/cursor-agent-adapter.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/dynamic-fanout.ts`](../agent/extensions/pi-subagents/src/runs/shared/dynamic-fanout.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/external-cli-contract.ts`](../agent/extensions/pi-subagents/src/runs/shared/external-cli-contract.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/external-cli-runner.ts`](../agent/extensions/pi-subagents/src/runs/shared/external-cli-runner.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-config-sources.ts`](../agent/extensions/pi-subagents/src/runs/shared/mcp-config-sources.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.ts`](../agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-grant.ts`](../agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-grant.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts`](../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/model-research.ts`](../agent/extensions/pi-subagents/src/runs/shared/model-research.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/parallel-utils.ts`](../agent/extensions/pi-subagents/src/runs/shared/parallel-utils.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/pi-args.ts`](../agent/extensions/pi-subagents/src/runs/shared/pi-args.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/single-output.ts`](../agent/extensions/pi-subagents/src/runs/shared/single-output.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/skill-routing.ts`](../agent/extensions/pi-subagents/src/runs/shared/skill-routing.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/tool-availability.ts`](../agent/extensions/pi-subagents/src/runs/shared/tool-availability.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/shared/launch-contract.ts`](../agent/extensions/pi-subagents/src/shared/launch-contract.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/shared/types.ts`](../agent/extensions/pi-subagents/src/shared/types.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/slash/delegation-adapters.ts`](../agent/extensions/pi-subagents/src/slash/delegation-adapters.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/slash/subagents-admin.ts`](../agent/extensions/pi-subagents/src/slash/subagents-admin.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/watchdog/lsp-diagnostics.ts`](../agent/extensions/pi-subagents/src/watchdog/lsp-diagnostics.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts`](../agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/workflows/workflow-receipt.ts`](../agent/extensions/pi-subagents/src/workflows/workflow-receipt.ts) — `MCP`
- [`agent/extensions/pi-web-access/index.ts`](../agent/extensions/pi-web-access/index.ts) — `wrapper/adapter`
- [`agent/extensions/pi-web-access/web-probe.ts`](../agent/extensions/pi-web-access/web-probe.ts) — `wrapper/adapter`
- [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts) — `wrapper/adapter`
- [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts) — `wrapper/adapter`
- [`agent/extensions/sys-probe.ts`](../agent/extensions/sys-probe.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/utility-tools.ts`](../agent/extensions/utility-tools.ts) — `MCP`, `wrapper/adapter`

## Extension source inventory

The manifest is the source of truth for the shipped extension, library, fork, support-file, dependency, and folded-marker lists.

### Extensions

- [`agent/extensions/adaptive-workflows.ts`](../agent/extensions/adaptive-workflows.ts)
- [`agent/extensions/agent-context-tools.ts`](../agent/extensions/agent-context-tools.ts)
- [`agent/extensions/agentmail.ts`](../agent/extensions/agentmail.ts)
- [`agent/extensions/art-direction.ts`](../agent/extensions/art-direction.ts)
- [`agent/extensions/blender-studio.ts`](../agent/extensions/blender-studio.ts)
- [`agent/extensions/bulk-edit.ts`](../agent/extensions/bulk-edit.ts)
- [`agent/extensions/checkpoints.ts`](../agent/extensions/checkpoints.ts)
- [`agent/extensions/colab.ts`](../agent/extensions/colab.ts)
- [`agent/extensions/continuation-notice.ts`](../agent/extensions/continuation-notice.ts)
- [`agent/extensions/cost-governor.ts`](../agent/extensions/cost-governor.ts)
- [`agent/extensions/deliverables.ts`](../agent/extensions/deliverables.ts)
- [`agent/extensions/design-studio.ts`](../agent/extensions/design-studio.ts)
- [`agent/extensions/expert-director.ts`](../agent/extensions/expert-director.ts)
- [`agent/extensions/filesystem-safety.ts`](../agent/extensions/filesystem-safety.ts)
- [`agent/extensions/git-tools.ts`](../agent/extensions/git-tools.ts)
- [`agent/extensions/goal.ts`](../agent/extensions/goal.ts)
- [`agent/extensions/harness-backup.ts`](../agent/extensions/harness-backup.ts)
- [`agent/extensions/health-log.ts`](../agent/extensions/health-log.ts)
- [`agent/extensions/http-tools.ts`](../agent/extensions/http-tools.ts)
- [`agent/extensions/live-models.ts`](../agent/extensions/live-models.ts)
- [`agent/extensions/managed-bash.ts`](../agent/extensions/managed-bash.ts)
- [`agent/extensions/media-tools.ts`](../agent/extensions/media-tools.ts)
- [`agent/extensions/micro-intelligence.ts`](../agent/extensions/micro-intelligence.ts)
- [`agent/extensions/model-config.ts`](../agent/extensions/model-config.ts)
- [`agent/extensions/model-routing-config.ts`](../agent/extensions/model-routing-config.ts)
- [`agent/extensions/pi-observations.ts`](../agent/extensions/pi-observations.ts)
- [`agent/extensions/pi-vector-memory.ts`](../agent/extensions/pi-vector-memory.ts)
- [`agent/extensions/project-intelligence.ts`](../agent/extensions/project-intelligence.ts)
- [`agent/extensions/provider-cmd.ts`](../agent/extensions/provider-cmd.ts)
- [`agent/extensions/provider-gate.ts`](../agent/extensions/provider-gate.ts)
- [`agent/extensions/reminders.ts`](../agent/extensions/reminders.ts)
- [`agent/extensions/render-and-wait.ts`](../agent/extensions/render-and-wait.ts)
- [`agent/extensions/sandbox.ts`](../agent/extensions/sandbox.ts)
- [`agent/extensions/scoped-snapshots.ts`](../agent/extensions/scoped-snapshots.ts)
- [`agent/extensions/session-export-json.ts`](../agent/extensions/session-export-json.ts)
- [`agent/extensions/session-hooks.ts`](../agent/extensions/session-hooks.ts)
- [`agent/extensions/session-observer.ts`](../agent/extensions/session-observer.ts)
- [`agent/extensions/session-signals.ts`](../agent/extensions/session-signals.ts)
- [`agent/extensions/siblings.ts`](../agent/extensions/siblings.ts)
- [`agent/extensions/sys-probe.ts`](../agent/extensions/sys-probe.ts)
- [`agent/extensions/task-state.ts`](../agent/extensions/task-state.ts)
- [`agent/extensions/thinking.ts`](../agent/extensions/thinking.ts)
- [`agent/extensions/utility-tools.ts`](../agent/extensions/utility-tools.ts)
- [`agent/extensions/video-studio.ts`](../agent/extensions/video-studio.ts)

### Libraries

- [`agent/extensions/lib/activity-indicators.ts`](../agent/extensions/lib/activity-indicators.ts)
- [`agent/extensions/lib/adaptive-execution.ts`](../agent/extensions/lib/adaptive-execution.ts)
- [`agent/extensions/lib/artifact-checks.ts`](../agent/extensions/lib/artifact-checks.ts)
- [`agent/extensions/lib/asset-registry.ts`](../agent/extensions/lib/asset-registry.ts)
- [`agent/extensions/lib/assurance-output.ts`](../agent/extensions/lib/assurance-output.ts)
- [`agent/extensions/lib/audio-studio.ts`](../agent/extensions/lib/audio-studio.ts)
- [`agent/extensions/lib/authored-review.ts`](../agent/extensions/lib/authored-review.ts)
- [`agent/extensions/lib/bash-routing.ts`](../agent/extensions/lib/bash-routing.ts)
- [`agent/extensions/lib/binary-read.ts`](../agent/extensions/lib/binary-read.ts)
- [`agent/extensions/lib/blender-studio.ts`](../agent/extensions/lib/blender-studio.ts)
- [`agent/extensions/lib/browser-session.ts`](../agent/extensions/lib/browser-session.ts)
- [`agent/extensions/lib/bulk-edit.ts`](../agent/extensions/lib/bulk-edit.ts)
- [`agent/extensions/lib/cache-sentinel.ts`](../agent/extensions/lib/cache-sentinel.ts)
- [`agent/extensions/lib/capability-groups.ts`](../agent/extensions/lib/capability-groups.ts)
- [`agent/extensions/lib/capability-health.ts`](../agent/extensions/lib/capability-health.ts)
- [`agent/extensions/lib/catalog-cache-lock.ts`](../agent/extensions/lib/catalog-cache-lock.ts)
- [`agent/extensions/lib/checkpoint-files.ts`](../agent/extensions/lib/checkpoint-files.ts)
- [`agent/extensions/lib/ci-awareness.ts`](../agent/extensions/lib/ci-awareness.ts)
- [`agent/extensions/lib/code-audit.ts`](../agent/extensions/lib/code-audit.ts)
- [`agent/extensions/lib/code-guidance-signals.ts`](../agent/extensions/lib/code-guidance-signals.ts)
- [`agent/extensions/lib/code-lexical-mask.ts`](../agent/extensions/lib/code-lexical-mask.ts)
- [`agent/extensions/lib/code-quality.ts`](../agent/extensions/lib/code-quality.ts)
- [`agent/extensions/lib/code-structure.ts`](../agent/extensions/lib/code-structure.ts)
- [`agent/extensions/lib/colab-auth.ts`](../agent/extensions/lib/colab-auth.ts)
- [`agent/extensions/lib/colab-jobs.ts`](../agent/extensions/lib/colab-jobs.ts)
- [`agent/extensions/lib/colab.ts`](../agent/extensions/lib/colab.ts)
- [`agent/extensions/lib/compact-tool-json.ts`](../agent/extensions/lib/compact-tool-json.ts)
- [`agent/extensions/lib/compaction-policy.ts`](../agent/extensions/lib/compaction-policy.ts)
- [`agent/extensions/lib/competence-store.ts`](../agent/extensions/lib/competence-store.ts)
- [`agent/extensions/lib/completion-check.ts`](../agent/extensions/lib/completion-check.ts)
- [`agent/extensions/lib/completion-gate.ts`](../agent/extensions/lib/completion-gate.ts)
- [`agent/extensions/lib/context-anchor.ts`](../agent/extensions/lib/context-anchor.ts)
- [`agent/extensions/lib/context-governor.ts`](../agent/extensions/lib/context-governor.ts)
- [`agent/extensions/lib/context-limits.ts`](../agent/extensions/lib/context-limits.ts)
- [`agent/extensions/lib/context-provenance.ts`](../agent/extensions/lib/context-provenance.ts)
- [`agent/extensions/lib/continuation-notice.ts`](../agent/extensions/lib/continuation-notice.ts)
- [`agent/extensions/lib/cost-evidence.ts`](../agent/extensions/lib/cost-evidence.ts)
- [`agent/extensions/lib/cost-states.ts`](../agent/extensions/lib/cost-states.ts)
- [`agent/extensions/lib/creative-direction.ts`](../agent/extensions/lib/creative-direction.ts)
- [`agent/extensions/lib/creative-evidence.ts`](../agent/extensions/lib/creative-evidence.ts)
- [`agent/extensions/lib/creative-qa.ts`](../agent/extensions/lib/creative-qa.ts)
- [`agent/extensions/lib/data-query.ts`](../agent/extensions/lib/data-query.ts)
- [`agent/extensions/lib/deliverable-inspect.ts`](../agent/extensions/lib/deliverable-inspect.ts)
- [`agent/extensions/lib/deliverable-ledger.ts`](../agent/extensions/lib/deliverable-ledger.ts)
- [`agent/extensions/lib/design-direction.ts`](../agent/extensions/lib/design-direction.ts)
- [`agent/extensions/lib/design-studio.ts`](../agent/extensions/lib/design-studio.ts)
- [`agent/extensions/lib/diagnostic-provenance.ts`](../agent/extensions/lib/diagnostic-provenance.ts)
- [`agent/extensions/lib/disk-guard.ts`](../agent/extensions/lib/disk-guard.ts)
- [`agent/extensions/lib/double.ts`](../agent/extensions/lib/double.ts)
- [`agent/extensions/lib/effort-policy.mjs`](../agent/extensions/lib/effort-policy.mjs)
- [`agent/extensions/lib/elevenlabs.ts`](../agent/extensions/lib/elevenlabs.ts)
- [`agent/extensions/lib/execution-evidence.ts`](../agent/extensions/lib/execution-evidence.ts)
- [`agent/extensions/lib/expert-brief.ts`](../agent/extensions/lib/expert-brief.ts)
- [`agent/extensions/lib/expert-convergence.ts`](../agent/extensions/lib/expert-convergence.ts)
- [`agent/extensions/lib/expert-critics.ts`](../agent/extensions/lib/expert-critics.ts)
- [`agent/extensions/lib/expert-doctrine.ts`](../agent/extensions/lib/expert-doctrine.ts)
- [`agent/extensions/lib/expert-domains.ts`](../agent/extensions/lib/expert-domains.ts)
- [`agent/extensions/lib/expert-taste.ts`](../agent/extensions/lib/expert-taste.ts)
- [`agent/extensions/lib/film-blend.ts`](../agent/extensions/lib/film-blend.ts)
- [`agent/extensions/lib/git-authority.ts`](../agent/extensions/lib/git-authority.ts)
- [`agent/extensions/lib/gltf-inspect.ts`](../agent/extensions/lib/gltf-inspect.ts)
- [`agent/extensions/lib/goal-state.ts`](../agent/extensions/lib/goal-state.ts)
- [`agent/extensions/lib/guarded-process.ts`](../agent/extensions/lib/guarded-process.ts)
- [`agent/extensions/lib/guidance-topics-domains.ts`](../agent/extensions/lib/guidance-topics-domains.ts)
- [`agent/extensions/lib/guidance-topics-systems.ts`](../agent/extensions/lib/guidance-topics-systems.ts)
- [`agent/extensions/lib/guidance-topics.ts`](../agent/extensions/lib/guidance-topics.ts)
- [`agent/extensions/lib/harness-activity.ts`](../agent/extensions/lib/harness-activity.ts)
- [`agent/extensions/lib/harness-capabilities.ts`](../agent/extensions/lib/harness-capabilities.ts)
- [`agent/extensions/lib/harness-notice.ts`](../agent/extensions/lib/harness-notice.ts)
- [`agent/extensions/lib/harness-orientation.ts`](../agent/extensions/lib/harness-orientation.ts)
- [`agent/extensions/lib/health-log.ts`](../agent/extensions/lib/health-log.ts)
- [`agent/extensions/lib/helper-usage.ts`](../agent/extensions/lib/helper-usage.ts)
- [`agent/extensions/lib/hook-ledger.ts`](../agent/extensions/lib/hook-ledger.ts)
- [`agent/extensions/lib/host-operation-safety.ts`](../agent/extensions/lib/host-operation-safety.ts)
- [`agent/extensions/lib/image-analysis.ts`](../agent/extensions/lib/image-analysis.ts)
- [`agent/extensions/lib/image-compaction.ts`](../agent/extensions/lib/image-compaction.ts)
- [`agent/extensions/lib/image-generate.ts`](../agent/extensions/lib/image-generate.ts)
- [`agent/extensions/lib/image-understand.ts`](../agent/extensions/lib/image-understand.ts)
- [`agent/extensions/lib/intent-context.ts`](../agent/extensions/lib/intent-context.ts)
- [`agent/extensions/lib/intervention-control.ts`](../agent/extensions/lib/intervention-control.ts)
- [`agent/extensions/lib/intervention-intents.ts`](../agent/extensions/lib/intervention-intents.ts)
- [`agent/extensions/lib/intervention-registry.ts`](../agent/extensions/lib/intervention-registry.ts)
- [`agent/extensions/lib/intervention-session.ts`](../agent/extensions/lib/intervention-session.ts)
- [`agent/extensions/lib/intervention-shared.ts`](../agent/extensions/lib/intervention-shared.ts)
- [`agent/extensions/lib/jev-client.ts`](../agent/extensions/lib/jev-client.ts)
- [`agent/extensions/lib/jev-fusion.ts`](../agent/extensions/lib/jev-fusion.ts)
- [`agent/extensions/lib/lean-policy.ts`](../agent/extensions/lib/lean-policy.ts)
- [`agent/extensions/lib/local-intelligence.mjs`](../agent/extensions/lib/local-intelligence.mjs)
- [`agent/extensions/lib/local-models.ts`](../agent/extensions/lib/local-models.ts)
- [`agent/extensions/lib/media-model-routing.ts`](../agent/extensions/lib/media-model-routing.ts)
- [`agent/extensions/lib/media-process.ts`](../agent/extensions/lib/media-process.ts)
- [`agent/extensions/lib/media-sync.ts`](../agent/extensions/lib/media-sync.ts)
- [`agent/extensions/lib/media-timeline.ts`](../agent/extensions/lib/media-timeline.ts)
- [`agent/extensions/lib/media-work.ts`](../agent/extensions/lib/media-work.ts)
- [`agent/extensions/lib/memory-guard.ts`](../agent/extensions/lib/memory-guard.ts)
- [`agent/extensions/lib/memory-redaction.ts`](../agent/extensions/lib/memory-redaction.ts)
- [`agent/extensions/lib/metrics-panel.ts`](../agent/extensions/lib/metrics-panel.ts)
- [`agent/extensions/lib/mini-preprocessor.ts`](../agent/extensions/lib/mini-preprocessor.ts)
- [`agent/extensions/lib/model-competence.ts`](../agent/extensions/lib/model-competence.ts)
- [`agent/extensions/lib/model-facts.ts`](../agent/extensions/lib/model-facts.ts)
- [`agent/extensions/lib/model-routing-metrics.ts`](../agent/extensions/lib/model-routing-metrics.ts)
- [`agent/extensions/lib/model-routing-store.ts`](../agent/extensions/lib/model-routing-store.ts)
- [`agent/extensions/lib/motion-inspect.ts`](../agent/extensions/lib/motion-inspect.ts)
- [`agent/extensions/lib/motion-library.ts`](../agent/extensions/lib/motion-library.ts)
- [`agent/extensions/lib/music-score.ts`](../agent/extensions/lib/music-score.ts)
- [`agent/extensions/lib/needle-assets.mjs`](../agent/extensions/lib/needle-assets.mjs)
- [`agent/extensions/lib/needle-embedding-cache.mjs`](../agent/extensions/lib/needle-embedding-cache.mjs)
- [`agent/extensions/lib/needle-policy.ts`](../agent/extensions/lib/needle-policy.ts)
- [`agent/extensions/lib/needle-runtime.ts`](../agent/extensions/lib/needle-runtime.ts)
- [`agent/extensions/lib/needle-types.ts`](../agent/extensions/lib/needle-types.ts)
- [`agent/extensions/lib/needle-worker.mjs`](../agent/extensions/lib/needle-worker.mjs)
- [`agent/extensions/lib/noslop.ts`](../agent/extensions/lib/noslop.ts)
- [`agent/extensions/lib/numeric-checks.ts`](../agent/extensions/lib/numeric-checks.ts)
- [`agent/extensions/lib/observation-retrieval.ts`](../agent/extensions/lib/observation-retrieval.ts)
- [`agent/extensions/lib/observer-book.ts`](../agent/extensions/lib/observer-book.ts)
- [`agent/extensions/lib/observer-journal.ts`](../agent/extensions/lib/observer-journal.ts)
- [`agent/extensions/lib/observer-model-evidence.ts`](../agent/extensions/lib/observer-model-evidence.ts)
- [`agent/extensions/lib/office-build.ts`](../agent/extensions/lib/office-build.ts)
- [`agent/extensions/lib/office-read.ts`](../agent/extensions/lib/office-read.ts)
- [`agent/extensions/lib/office-render.ts`](../agent/extensions/lib/office-render.ts)
- [`agent/extensions/lib/office-zip.ts`](../agent/extensions/lib/office-zip.ts)
- [`agent/extensions/lib/output-distiller.ts`](../agent/extensions/lib/output-distiller.ts)
- [`agent/extensions/lib/path-safety.ts`](../agent/extensions/lib/path-safety.ts)
- [`agent/extensions/lib/popup-theme.ts`](../agent/extensions/lib/popup-theme.ts)
- [`agent/extensions/lib/pptx-build.ts`](../agent/extensions/lib/pptx-build.ts)
- [`agent/extensions/lib/presets.ts`](../agent/extensions/lib/presets.ts)
- [`agent/extensions/lib/prior-art.ts`](../agent/extensions/lib/prior-art.ts)
- [`agent/extensions/lib/process-owner.ts`](../agent/extensions/lib/process-owner.ts)
- [`agent/extensions/lib/project-identity.ts`](../agent/extensions/lib/project-identity.ts)
- [`agent/extensions/lib/project-memory-context.ts`](../agent/extensions/lib/project-memory-context.ts)
- [`agent/extensions/lib/project-memory-embedder.ts`](../agent/extensions/lib/project-memory-embedder.ts)
- [`agent/extensions/lib/project-memory-index.ts`](../agent/extensions/lib/project-memory-index.ts)
- [`agent/extensions/lib/project-memory-retrieve.ts`](../agent/extensions/lib/project-memory-retrieve.ts)
- [`agent/extensions/lib/project-profile.ts`](../agent/extensions/lib/project-profile.ts)
- [`agent/extensions/lib/project-tests.ts`](../agent/extensions/lib/project-tests.ts)
- [`agent/extensions/lib/project-vector-store.ts`](../agent/extensions/lib/project-vector-store.ts)
- [`agent/extensions/lib/prompt-analysis-runtime.ts`](../agent/extensions/lib/prompt-analysis-runtime.ts)
- [`agent/extensions/lib/prompt-interpretation.ts`](../agent/extensions/lib/prompt-interpretation.ts)
- [`agent/extensions/lib/quality-refinement.ts`](../agent/extensions/lib/quality-refinement.ts)
- [`agent/extensions/lib/quality-review-owner.ts`](../agent/extensions/lib/quality-review-owner.ts)
- [`agent/extensions/lib/quality-review-signals.ts`](../agent/extensions/lib/quality-review-signals.ts)
- [`agent/extensions/lib/quality-review.ts`](../agent/extensions/lib/quality-review.ts)
- [`agent/extensions/lib/relevant-guidance.ts`](../agent/extensions/lib/relevant-guidance.ts)
- [`agent/extensions/lib/reminders-state.ts`](../agent/extensions/lib/reminders-state.ts)
- [`agent/extensions/lib/render-queue.ts`](../agent/extensions/lib/render-queue.ts)
- [`agent/extensions/lib/request-compat.ts`](../agent/extensions/lib/request-compat.ts)
- [`agent/extensions/lib/requirement-ledger.ts`](../agent/extensions/lib/requirement-ledger.ts)
- [`agent/extensions/lib/research-evidence.ts`](../agent/extensions/lib/research-evidence.ts)
- [`agent/extensions/lib/retry-policy.ts`](../agent/extensions/lib/retry-policy.ts)
- [`agent/extensions/lib/review-coordinator.ts`](../agent/extensions/lib/review-coordinator.ts)
- [`agent/extensions/lib/reviewer-board.ts`](../agent/extensions/lib/reviewer-board.ts)
- [`agent/extensions/lib/rpc-report.ts`](../agent/extensions/lib/rpc-report.ts)
- [`agent/extensions/lib/scope-deliberation.ts`](../agent/extensions/lib/scope-deliberation.ts)
- [`agent/extensions/lib/scoped-snapshots.ts`](../agent/extensions/lib/scoped-snapshots.ts)
- [`agent/extensions/lib/self-mutation-guard.ts`](../agent/extensions/lib/self-mutation-guard.ts)
- [`agent/extensions/lib/seo-policy.ts`](../agent/extensions/lib/seo-policy.ts)
- [`agent/extensions/lib/service-probe.ts`](../agent/extensions/lib/service-probe.ts)
- [`agent/extensions/lib/session-audit.ts`](../agent/extensions/lib/session-audit.ts)
- [`agent/extensions/lib/session-cost.ts`](../agent/extensions/lib/session-cost.ts)
- [`agent/extensions/lib/session-diagnostics.ts`](../agent/extensions/lib/session-diagnostics.ts)
- [`agent/extensions/lib/session-errors.ts`](../agent/extensions/lib/session-errors.ts)
- [`agent/extensions/lib/session-export-json.ts`](../agent/extensions/lib/session-export-json.ts)
- [`agent/extensions/lib/session-hooks.ts`](../agent/extensions/lib/session-hooks.ts)
- [`agent/extensions/lib/session-metrics.ts`](../agent/extensions/lib/session-metrics.ts)
- [`agent/extensions/lib/session-observability.ts`](../agent/extensions/lib/session-observability.ts)
- [`agent/extensions/lib/session-observer.ts`](../agent/extensions/lib/session-observer.ts)
- [`agent/extensions/lib/session-report.ts`](../agent/extensions/lib/session-report.ts)
- [`agent/extensions/lib/session-signals.ts`](../agent/extensions/lib/session-signals.ts)
- [`agent/extensions/lib/session-stop.ts`](../agent/extensions/lib/session-stop.ts)
- [`agent/extensions/lib/session-telemetry.ts`](../agent/extensions/lib/session-telemetry.ts)
- [`agent/extensions/lib/sheet-formula.ts`](../agent/extensions/lib/sheet-formula.ts)
- [`agent/extensions/lib/shot-scene.ts`](../agent/extensions/lib/shot-scene.ts)
- [`agent/extensions/lib/skill-discovery-controller.ts`](../agent/extensions/lib/skill-discovery-controller.ts)
- [`agent/extensions/lib/skill-discovery.ts`](../agent/extensions/lib/skill-discovery.ts)
- [`agent/extensions/lib/skill-relevance.ts`](../agent/extensions/lib/skill-relevance.ts)
- [`agent/extensions/lib/skill-routing.ts`](../agent/extensions/lib/skill-routing.ts)
- [`agent/extensions/lib/skill-telemetry.ts`](../agent/extensions/lib/skill-telemetry.ts)
- [`agent/extensions/lib/slop-guidance-signals.ts`](../agent/extensions/lib/slop-guidance-signals.ts)
- [`agent/extensions/lib/small-tools.ts`](../agent/extensions/lib/small-tools.ts)
- [`agent/extensions/lib/source-check.ts`](../agent/extensions/lib/source-check.ts)
- [`agent/extensions/lib/specifics.ts`](../agent/extensions/lib/specifics.ts)
- [`agent/extensions/lib/stable-tool-order.ts`](../agent/extensions/lib/stable-tool-order.ts)
- [`agent/extensions/lib/stall-core.ts`](../agent/extensions/lib/stall-core.ts)
- [`agent/extensions/lib/svg-analysis.ts`](../agent/extensions/lib/svg-analysis.ts)
- [`agent/extensions/lib/svg-check.ts`](../agent/extensions/lib/svg-check.ts)
- [`agent/extensions/lib/svg-inspect.ts`](../agent/extensions/lib/svg-inspect.ts)
- [`agent/extensions/lib/svg-render.ts`](../agent/extensions/lib/svg-render.ts)
- [`agent/extensions/lib/sys-probe.ts`](../agent/extensions/lib/sys-probe.ts)
- [`agent/extensions/lib/task-pipelines.ts`](../agent/extensions/lib/task-pipelines.ts)
- [`agent/extensions/lib/token-budget.ts`](../agent/extensions/lib/token-budget.ts)
- [`agent/extensions/lib/tool-discovery.ts`](../agent/extensions/lib/tool-discovery.ts)
- [`agent/extensions/lib/tool-schema.ts`](../agent/extensions/lib/tool-schema.ts)
- [`agent/extensions/lib/ui-doctrine.ts`](../agent/extensions/lib/ui-doctrine.ts)
- [`agent/extensions/lib/utility-client.ts`](../agent/extensions/lib/utility-client.ts)
- [`agent/extensions/lib/video-art.ts`](../agent/extensions/lib/video-art.ts)
- [`agent/extensions/lib/video-assets.ts`](../agent/extensions/lib/video-assets.ts)
- [`agent/extensions/lib/video-browser.ts`](../agent/extensions/lib/video-browser.ts)
- [`agent/extensions/lib/video-color-evidence.ts`](../agent/extensions/lib/video-color-evidence.ts)
- [`agent/extensions/lib/video-compose.ts`](../agent/extensions/lib/video-compose.ts)
- [`agent/extensions/lib/video-derive.ts`](../agent/extensions/lib/video-derive.ts)
- [`agent/extensions/lib/video-looks.ts`](../agent/extensions/lib/video-looks.ts)
- [`agent/extensions/lib/video-motion.ts`](../agent/extensions/lib/video-motion.ts)
- [`agent/extensions/lib/video-production-flow.ts`](../agent/extensions/lib/video-production-flow.ts)
- [`agent/extensions/lib/video-publish.ts`](../agent/extensions/lib/video-publish.ts)
- [`agent/extensions/lib/video-review-evidence.ts`](../agent/extensions/lib/video-review-evidence.ts)
- [`agent/extensions/lib/video-segments.ts`](../agent/extensions/lib/video-segments.ts)
- [`agent/extensions/lib/video-shot.ts`](../agent/extensions/lib/video-shot.ts)
- [`agent/extensions/lib/video-studio.ts`](../agent/extensions/lib/video-studio.ts)
- [`agent/extensions/lib/wire-warmth.ts`](../agent/extensions/lib/wire-warmth.ts)
- [`agent/extensions/lib/workspace-write-lease.ts`](../agent/extensions/lib/workspace-write-lease.ts)
- [`agent/extensions/lib/worktree-checkpoint.ts`](../agent/extensions/lib/worktree-checkpoint.ts)
- [`agent/extensions/lib/xml-lite.ts`](../agent/extensions/lib/xml-lite.ts)

### Local forks

- [`agent/extensions/pi-background-tasks`](../agent/extensions/pi-background-tasks) — package `pi-background-tasks`
- [`agent/extensions/pi-lens`](../agent/extensions/pi-lens) — package `pi-lens`
- [`agent/extensions/pi-memory`](../agent/extensions/pi-memory) — package `pi-memory`
- [`agent/extensions/pi-subagents`](../agent/extensions/pi-subagents) — package `pi-subagents`
- [`agent/extensions/pi-web-access`](../agent/extensions/pi-web-access) — package `pi-web-access`
- [`agent/extensions/rpiv-todo`](../agent/extensions/rpiv-todo) — package `@juicesharp/rpiv-todo`

### Manifest support files

- [`agent/extensions/lib/micro-intelligence/advisory.ts`](../agent/extensions/lib/micro-intelligence/advisory.ts)
- [`agent/extensions/lib/micro-intelligence/evidence.ts`](../agent/extensions/lib/micro-intelligence/evidence.ts)
- [`agent/extensions/lib/micro-intelligence/health.ts`](../agent/extensions/lib/micro-intelligence/health.ts)
- [`agent/extensions/lib/micro-intelligence/intent.ts`](../agent/extensions/lib/micro-intelligence/intent.ts)
- [`agent/extensions/lib/micro-intelligence/jev-decisions.ts`](../agent/extensions/lib/micro-intelligence/jev-decisions.ts)
- [`agent/extensions/lib/micro-intelligence/metrics.ts`](../agent/extensions/lib/micro-intelligence/metrics.ts)
- [`agent/extensions/lib/micro-intelligence/micro-task.ts`](../agent/extensions/lib/micro-intelligence/micro-task.ts)
- [`agent/extensions/lib/micro-intelligence/micro-worker.ts`](../agent/extensions/lib/micro-intelligence/micro-worker.ts)
- [`agent/extensions/lib/micro-intelligence/model-qual-lab.ts`](../agent/extensions/lib/micro-intelligence/model-qual-lab.ts)
- [`agent/extensions/lib/micro-intelligence/rerank.ts`](../agent/extensions/lib/micro-intelligence/rerank.ts)
- [`agent/extensions/lib/micro-intelligence/retrieval.ts`](../agent/extensions/lib/micro-intelligence/retrieval.ts)
- [`agent/extensions/lib/micro-intelligence/review.ts`](../agent/extensions/lib/micro-intelligence/review.ts)
- [`agent/extensions/lib/micro-intelligence/route-privacy.ts`](../agent/extensions/lib/micro-intelligence/route-privacy.ts)
- [`agent/extensions/lib/micro-intelligence/router-shadow.ts`](../agent/extensions/lib/micro-intelligence/router-shadow.ts)
- [`agent/extensions/lib/micro-intelligence/span-sensor.ts`](../agent/extensions/lib/micro-intelligence/span-sensor.ts)
- [`agent/extensions/lib/micro-intelligence/status.ts`](../agent/extensions/lib/micro-intelligence/status.ts)
- [`agent/extensions/lib/project-intelligence/client.mjs`](../agent/extensions/lib/project-intelligence/client.mjs)
- [`agent/extensions/lib/project-intelligence/continuity.mjs`](../agent/extensions/lib/project-intelligence/continuity.mjs)
- [`agent/extensions/lib/project-intelligence/discovery-parsers.mjs`](../agent/extensions/lib/project-intelligence/discovery-parsers.mjs)
- [`agent/extensions/lib/project-intelligence/discovery.mjs`](../agent/extensions/lib/project-intelligence/discovery.mjs)
- [`agent/extensions/lib/project-intelligence/heartbeat.mjs`](../agent/extensions/lib/project-intelligence/heartbeat.mjs)
- [`agent/extensions/lib/project-intelligence/identity.mjs`](../agent/extensions/lib/project-intelligence/identity.mjs)
- [`agent/extensions/lib/project-intelligence/privacy.mjs`](../agent/extensions/lib/project-intelligence/privacy.mjs)
- [`agent/extensions/lib/project-intelligence/query.mjs`](../agent/extensions/lib/project-intelligence/query.mjs)
- [`agent/extensions/lib/project-intelligence/store.mjs`](../agent/extensions/lib/project-intelligence/store.mjs)
- [`agent/extensions/lib/project-intelligence/viewer-assets/app.js`](../agent/extensions/lib/project-intelligence/viewer-assets/app.js)
- [`agent/extensions/lib/project-intelligence/viewer-assets/cytoscape.min.js`](../agent/extensions/lib/project-intelligence/viewer-assets/cytoscape.min.js)
- [`agent/extensions/lib/project-intelligence/viewer-server.mjs`](../agent/extensions/lib/project-intelligence/viewer-server.mjs)
- [`agent/extensions/lib/project-intelligence/viewer.mjs`](../agent/extensions/lib/project-intelligence/viewer.mjs)
- [`agent/extensions/lib/project-intelligence/worker.mjs`](../agent/extensions/lib/project-intelligence/worker.mjs)
- [`agent/extensions/lib/utility-mcp/catalog.mjs`](../agent/extensions/lib/utility-mcp/catalog.mjs)
- [`agent/extensions/lib/utility-mcp/files.mjs`](../agent/extensions/lib/utility-mcp/files.mjs)
- [`agent/extensions/lib/utility-mcp/local_operations.py`](../agent/extensions/lib/utility-mcp/local_operations.py)
- [`agent/extensions/lib/utility-mcp/local-reference.mjs`](../agent/extensions/lib/utility-mcp/local-reference.mjs)
- [`agent/extensions/lib/utility-mcp/net.mjs`](../agent/extensions/lib/utility-mcp/net.mjs)
- [`agent/extensions/lib/utility-mcp/package.mjs`](../agent/extensions/lib/utility-mcp/package.mjs)
- [`agent/extensions/lib/utility-mcp/probe.py`](../agent/extensions/lib/utility-mcp/probe.py)
- [`agent/extensions/lib/utility-mcp/server.mjs`](../agent/extensions/lib/utility-mcp/server.mjs)
- [`agent/extensions/lib/utility-mcp/web-assets.mjs`](../agent/extensions/lib/utility-mcp/web-assets.mjs)
- [`agent/extensions/lib/utility-mcp/worker.mjs`](../agent/extensions/lib/utility-mcp/worker.mjs)
- [`agent/extensions/pi-background-tasks/src/core/completion-wake.ts`](../agent/extensions/pi-background-tasks/src/core/completion-wake.ts)
- [`agent/extensions/pi-lens/context-code.mjs`](../agent/extensions/pi-lens/context-code.mjs)
- [`agent/extensions/pi-lens/context-lsp.mjs`](../agent/extensions/pi-lens/context-lsp.mjs)
- [`agent/extensions/pi-lens/context-tools.ts`](../agent/extensions/pi-lens/context-tools.ts)
- [`agent/extensions/pi-lens/semantic-radar/fuzzy-identifiers.mjs`](../agent/extensions/pi-lens/semantic-radar/fuzzy-identifiers.mjs)
- [`agent/extensions/pi-lens/semantic-radar/neural-ranker.mjs`](../agent/extensions/pi-lens/semantic-radar/neural-ranker.mjs)
- [`agent/extensions/pi-lens/semantic-radar/rank-features.mjs`](../agent/extensions/pi-lens/semantic-radar/rank-features.mjs)
- [`agent/extensions/pi-lens/semantic-radar/reuse-ranker-model.json`](../agent/extensions/pi-lens/semantic-radar/reuse-ranker-model.json)
- [`agent/extensions/pi-memory/context-salience.ts`](../agent/extensions/pi-memory/context-salience.ts)
- [`agent/extensions/pi-memory/context-tools.ts`](../agent/extensions/pi-memory/context-tools.ts)
- [`agent/extensions/pi-memory/mutation.ts`](../agent/extensions/pi-memory/mutation.ts)
- [`agent/extensions/pi-memory/priming.ts`](../agent/extensions/pi-memory/priming.ts)
- [`agent/extensions/pi-memory/project-identity.ts`](../agent/extensions/pi-memory/project-identity.ts)
- [`agent/extensions/pi-subagents/src/runs/shared/common-task.ts`](../agent/extensions/pi-subagents/src/runs/shared/common-task.ts)
- [`agent/extensions/pi-subagents/src/runs/shared/file-verification.ts`](../agent/extensions/pi-subagents/src/runs/shared/file-verification.ts)
- [`agent/extensions/pi-subagents/src/shared/progress-evidence.ts`](../agent/extensions/pi-subagents/src/shared/progress-evidence.ts)
- [`agent/extensions/rpiv-todo/state/plan.ts`](../agent/extensions/rpiv-todo/state/plan.ts)
- [`agent/scripts/auto-update.sh`](../agent/scripts/auto-update.sh)
- [`agent/scripts/blender-studio.py`](../agent/scripts/blender-studio.py)
- [`agent/scripts/browser-diagnostics.mjs`](../agent/scripts/browser-diagnostics.mjs)
- [`agent/scripts/browser-markers.mjs`](../agent/scripts/browser-markers.mjs)
- [`agent/scripts/browser-page-tools.mjs`](../agent/scripts/browser-page-tools.mjs)
- [`agent/scripts/browser-session-lease.mjs`](../agent/scripts/browser-session-lease.mjs)
- [`agent/scripts/browser-session-runner.mjs`](../agent/scripts/browser-session-runner.mjs)
- [`agent/scripts/colab-auth-browser.mjs`](../agent/scripts/colab-auth-browser.mjs)
- [`agent/scripts/compatibility/atomic-edit-preflight-test.mjs`](../agent/scripts/compatibility/atomic-edit-preflight-test.mjs)
- [`agent/scripts/compatibility/automatic-compaction-test.mjs`](../agent/scripts/compatibility/automatic-compaction-test.mjs)
- [`agent/scripts/compatibility/autonomous-recovery-test.mjs`](../agent/scripts/compatibility/autonomous-recovery-test.mjs)
- [`agent/scripts/compatibility/harness-load-test.mjs`](../agent/scripts/compatibility/harness-load-test.mjs)
- [`agent/scripts/compatibility/hook-lifecycle-integrity-test.mjs`](../agent/scripts/compatibility/hook-lifecycle-integrity-test.mjs)
- [`agent/scripts/compatibility/retry-lifecycle-test.mjs`](../agent/scripts/compatibility/retry-lifecycle-test.mjs)
- [`agent/scripts/compatibility/session-recovery-guidance-test.mjs`](../agent/scripts/compatibility/session-recovery-guidance-test.mjs)
- [`agent/scripts/compatibility/skill-pack-routing-test.mjs`](../agent/scripts/compatibility/skill-pack-routing-test.mjs)
- [`agent/scripts/compatibility/summary-recovery-test.mjs`](../agent/scripts/compatibility/summary-recovery-test.mjs)
- [`agent/scripts/compatibility/tool-integrity-test.mjs`](../agent/scripts/compatibility/tool-integrity-test.mjs)
- [`agent/scripts/compatibility/utility-mcp-loader-test.mjs`](../agent/scripts/compatibility/utility-mcp-loader-test.mjs)
- [`agent/scripts/core-update.mjs`](../agent/scripts/core-update.mjs)
- [`agent/scripts/effort-audit.mjs`](../agent/scripts/effort-audit.mjs)
- [`agent/scripts/harness-readonly-exec.py`](../agent/scripts/harness-readonly-exec.py)
- [`agent/scripts/lib/core-compatibility.mjs`](../agent/scripts/lib/core-compatibility.mjs)
- [`agent/scripts/lib/effort-audit.mjs`](../agent/scripts/lib/effort-audit.mjs)
- [`agent/scripts/lib/owned-core.mjs`](../agent/scripts/lib/owned-core.mjs)
- [`agent/scripts/lib/paragraph_selector.py`](../agent/scripts/lib/paragraph_selector.py)
- [`agent/scripts/mini-preprocessor.py`](../agent/scripts/mini-preprocessor.py)
- [`agent/scripts/music-soundfont.py`](../agent/scripts/music-soundfont.py)
- [`agent/scripts/pi-launch.sh`](../agent/scripts/pi-launch.sh)
- [`agent/scripts/process-owner.sh`](../agent/scripts/process-owner.sh)
- [`agent/scripts/render-capture.mjs`](../agent/scripts/render-capture.mjs)
- [`agent/scripts/render-design-state.mjs`](../agent/scripts/render-design-state.mjs)
- [`agent/scripts/render-noise-state.mjs`](../agent/scripts/render-noise-state.mjs)
- [`agent/scripts/render-page-state.mjs`](../agent/scripts/render-page-state.mjs)
- [`agent/scripts/repair-harness-hardlinks.py`](../agent/scripts/repair-harness-hardlinks.py)
- [`agent/scripts/sandbox-runner.py`](../agent/scripts/sandbox-runner.py)
- [`agent/scripts/skill-mirrors.mjs`](../agent/scripts/skill-mirrors.mjs)
- [`agent/scripts/systemd/pi-mini-preprocessor.service`](../agent/scripts/systemd/pi-mini-preprocessor.service)
- [`agent/scripts/transaction.mjs`](../agent/scripts/transaction.mjs)
- [`agent/scripts/ui-motion-runtime.mjs`](../agent/scripts/ui-motion-runtime.mjs)
- [`agent/scripts/video-browser.mjs`](../agent/scripts/video-browser.mjs)
- [`agent/scripts/video-render.mjs`](../agent/scripts/video-render.mjs)
- [`agent/scripts/wait-condition.mjs`](../agent/scripts/wait-condition.mjs)
- [`agent/scripts/workspace-facts.mjs`](../agent/scripts/workspace-facts.mjs)

### Folded markers

- `extensions/pi-lens/dist/index.js` — pi-lens exact-repeat mark dedup (bundle; per-module copies deleted in fork trim) (marker `PI_LENS_MARK_DEDUP`)
- `extensions/pi-memory/index.ts` — pi-memory project scope (marker `PROJECT_SCOPE`)
- `extensions/pi-subagents/src/runs/background/subagent-runner.ts` — subagent background runner inference gate (marker `PI_SUBAGENT_PRESSURE`)
- `extensions/pi-subagents/src/runs/foreground/execution.ts` — subagent foreground inference gate (marker `PI_SUBAGENT_PRESSURE`)

### Vendored runtime dependencies

- `@ast-grep/cli`
- `@ast-grep/napi`
- `@mozilla/readability`
- `@xmldom/xmldom`
- `acorn`
- `defuddle`
- `jiti`
- `js-yaml`
- `linkedom`
- `minimatch`
- `p-limit`
- `pidusage`
- `playwright`
- `promise.try`
- `three`
- `turndown`
- `typebox`
- `undici`
- `unpdf`
- `vscode-jsonrpc`
- `web-tree-sitter`
- `yaml`

### Extension packages

- _None recorded in the manifest/source tree._

## Skills

The exporter includes 33 public skill directories. This list is a path inventory; skill contents remain in their linked `SKILL.md` files.

- `3d-cad` — [`agent/skills/3d-cad/SKILL.md`](../agent/skills/3d-cad/SKILL.md)
- `anatomy` — [`agent/skills/anatomy/SKILL.md`](../agent/skills/anatomy/SKILL.md)
- `anatomy-reveal` — [`agent/skills/anatomy-reveal/SKILL.md`](../agent/skills/anatomy-reveal/SKILL.md)
- `api-security` — [`agent/skills/api-security/SKILL.md`](../agent/skills/api-security/SKILL.md)
- `audio` — [`agent/skills/audio/SKILL.md`](../agent/skills/audio/SKILL.md)
- `browser` — [`agent/skills/browser/SKILL.md`](../agent/skills/browser/SKILL.md)
- `build` — [`agent/skills/build/SKILL.md`](../agent/skills/build/SKILL.md)
- `cinetic` — [`agent/skills/cinetic/SKILL.md`](../agent/skills/cinetic/SKILL.md)
- `code-first-video` — [`agent/skills/code-first-video/SKILL.md`](../agent/skills/code-first-video/SKILL.md)
- `colab` — [`agent/skills/colab/SKILL.md`](../agent/skills/colab/SKILL.md)
- `create` — [`agent/skills/create/SKILL.md`](../agent/skills/create/SKILL.md)
- `data-science` — [`agent/skills/data-science/SKILL.md`](../agent/skills/data-science/SKILL.md)
- `engineering` — [`agent/skills/engineering/SKILL.md`](../agent/skills/engineering/SKILL.md)
- `frontend` — [`agent/skills/frontend/SKILL.md`](../agent/skills/frontend/SKILL.md)
- `git-github` — [`agent/skills/git-github/SKILL.md`](../agent/skills/git-github/SKILL.md)
- `growth-finance` — [`agent/skills/growth-finance/SKILL.md`](../agent/skills/growth-finance/SKILL.md)
- `harness-self-maintenance` — [`agent/skills/harness-self-maintenance/SKILL.md`](../agent/skills/harness-self-maintenance/SKILL.md)
- `linux-ops` — [`agent/skills/linux-ops/SKILL.md`](../agent/skills/linux-ops/SKILL.md)
- `media` — [`agent/skills/media/SKILL.md`](../agent/skills/media/SKILL.md)
- `ml` — [`agent/skills/ml/SKILL.md`](../agent/skills/ml/SKILL.md)
- `motion-approaches` — [`agent/skills/motion-approaches/SKILL.md`](../agent/skills/motion-approaches/SKILL.md)
- `networking` — [`agent/skills/networking/SKILL.md`](../agent/skills/networking/SKILL.md)
- `office-documents` — [`agent/skills/office-documents/SKILL.md`](../agent/skills/office-documents/SKILL.md)
- `operate` — [`agent/skills/operate/SKILL.md`](../agent/skills/operate/SKILL.md)
- `remotion-video` — [`agent/skills/remotion-video/SKILL.md`](../agent/skills/remotion-video/SKILL.md)
- `research` — [`agent/skills/research/SKILL.md`](../agent/skills/research/SKILL.md)
- `research-writing` — [`agent/skills/research-writing/SKILL.md`](../agent/skills/research-writing/SKILL.md)
- `signature-experience` — [`agent/skills/signature-experience/SKILL.md`](../agent/skills/signature-experience/SKILL.md)
- `svg-images` — [`agent/skills/svg-images/SKILL.md`](../agent/skills/svg-images/SKILL.md)
- `systems-languages` — [`agent/skills/systems-languages/SKILL.md`](../agent/skills/systems-languages/SKILL.md)
- `ui-design` — [`agent/skills/ui-design/SKILL.md`](../agent/skills/ui-design/SKILL.md)
- `video-editing` — [`agent/skills/video-editing/SKILL.md`](../agent/skills/video-editing/SKILL.md)
- `web-motion` — [`agent/skills/web-motion/SKILL.md`](../agent/skills/web-motion/SKILL.md)

## Migration test fixtures

The historical core transforms were deleted after the owned-core migration (see PATCH-MIGRATION.md). Runtime behavior is owned directly in `runtime/core/*/src` and `extensions/`; no transform catalogue remains.

- _None recorded in the manifest/source tree._

## Public documentation

- [`docs/3D-STUDIO.md`](3D-STUDIO.md)
- [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)
- [`docs/ADAPTIVE-EXECUTION.md`](ADAPTIVE-EXECUTION.md)
- [`docs/ANATOMY.md`](ANATOMY.md)
- [`docs/ANTI-SLOP-CHECKLIST.md`](ANTI-SLOP-CHECKLIST.md)
- [`docs/ART-DIRECTION.md`](ART-DIRECTION.md)
- [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)
- [`docs/AUTONOMOUS-ORCHESTRATION.md`](AUTONOMOUS-ORCHESTRATION.md)
- [`docs/CHANGE-SCOPE.md`](CHANGE-SCOPE.md)
- [`docs/CODE-AUDIT.md`](CODE-AUDIT.md)
- [`docs/CODE-QUALITY.md`](CODE-QUALITY.md)
- [`docs/COMPETENCE-CONTROL.md`](COMPETENCE-CONTROL.md)
- [`docs/CORE-OWNERSHIP.md`](CORE-OWNERSHIP.md)
- [`docs/CORE-UPDATES.md`](CORE-UPDATES.md)
- [`docs/COST-ACCOUNTING.md`](COST-ACCOUNTING.md)
- [`docs/DESIGN-STUDIO.md`](DESIGN-STUDIO.md)
- [`docs/DESKTOP.md`](DESKTOP.md)
- [`docs/EMAIL.md`](EMAIL.md)
- [`docs/ENGINEERING-RELIABILITY.md`](ENGINEERING-RELIABILITY.md)
- [`docs/EXPERT-DIRECTOR.md`](EXPERT-DIRECTOR.md)
- [`docs/GOAL.md`](GOAL.md)
- [`docs/GOOGLE-COLAB.md`](GOOGLE-COLAB.md)
- [`docs/GUARDIAN-INTELLIGENCE.md`](GUARDIAN-INTELLIGENCE.md)
- [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)
- [`docs/INFERENCE-CACHING.md`](INFERENCE-CACHING.md)
- [`docs/INSTALL.md`](INSTALL.md)
- [`docs/INTENT.md`](INTENT.md)
- [`docs/ISOLATION-AND-WEB.md`](ISOLATION-AND-WEB.md)
- [`docs/LLM-PREFERENCES.md`](LLM-PREFERENCES.md)
- [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)
- [`docs/MEDIA-CREATION.md`](MEDIA-CREATION.md)
- [`docs/MEDIA-PREFLIGHT.md`](MEDIA-PREFLIGHT.md)
- [`docs/MICRO-INTELLIGENCE.md`](MICRO-INTELLIGENCE.md)
- [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)
- [`docs/OBSERVER-BOOK.md`](OBSERVER-BOOK.md)
- [`docs/OFFICE-AND-DELIVERABLES.md`](OFFICE-AND-DELIVERABLES.md)
- [`docs/ORCHESTRATION-EVIDENCE.md`](ORCHESTRATION-EVIDENCE.md)
- [`docs/PATCH-MIGRATION.md`](PATCH-MIGRATION.md)
- [`docs/PLATFORMS.md`](PLATFORMS.md)
- [`docs/PRIOR-ART.md`](PRIOR-ART.md)
- [`docs/PROJECT-INTELLIGENCE.md`](PROJECT-INTELLIGENCE.md)
- [`docs/PUBLISHING.md`](PUBLISHING.md)
- [`docs/RECOVERY-AND-TESTING.md`](RECOVERY-AND-TESTING.md)
- [`docs/REVIEWS-AND-COUNCILS.md`](REVIEWS-AND-COUNCILS.md)
- [`docs/SANDBOXES.md`](SANDBOXES.md)
- [`docs/SCREENSHOTS.md`](SCREENSHOTS.md)
- [`docs/SECURITY.md`](SECURITY.md)
- [`docs/SESSION-METRICS.md`](SESSION-METRICS.md)
- [`docs/SESSION-OBSERVER.md`](SESSION-OBSERVER.md)
- [`docs/SESSION-ORCHESTRATION.md`](SESSION-ORCHESTRATION.md)
- [`docs/SITE-SEO.md`](SITE-SEO.md)
- [`docs/SKILLS-AND-CHECKS.md`](SKILLS-AND-CHECKS.md)
- [`docs/STRUCTURE.md`](STRUCTURE.md)
- [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)
- [`docs/SYSTEM-NETWORK-DIAGNOSIS.md`](SYSTEM-NETWORK-DIAGNOSIS.md)
- [`docs/TASK-PIPELINES.md`](TASK-PIPELINES.md)
- [`docs/TASK-STATE-GRAPH.md`](TASK-STATE-GRAPH.md)
- [`docs/TERMINAL-INTERFACE.md`](TERMINAL-INTERFACE.md)
- [`docs/TESTING.md`](TESTING.md)
- [`docs/UI-ENGINEERING.md`](UI-ENGINEERING.md)
- [`docs/VECTOR-MEMORY.md`](VECTOR-MEMORY.md)
- [`docs/VIDEO-STUDIO.md`](VIDEO-STUDIO.md)

## Retired source markers

The manifest tombstones retired names so the inventory can explain historical references without presenting them as available capabilities.

- `*-auto-models.ts` — retired 2026-08-31: the 7 provider auto-catalog extensions (openrouter, baseten, cerebras, friendli, lmstudio, orcarouter, together) — superseded by native pi-ai catalogs + static models.json; backups/provider-cleanup-20260831/. SUPERSEDED AGAIN 2026-08-31 by extensions/live-models.ts (single live-catalog extension for openrouter/orcarouter/together/friendli — native catalog lacks orcarouter entirely; live lists merged over the store)
- `a-speech-fix.ts` — retired 2026-08-31: speech-to-text misdecoding rewriter (input-hook mapping/fuzzy corrector) removed at user direction; its config speech-fix.json deleted with it; both moved to backups/retired-extensions/
- `ambient-frames.ts` — retired 2026-10-10: fixed-camera RGB atmosphere had no tool after video_ambient was removed. Do not recreate
- `auto-apply-extensions.sh` — retired 2026-09-01: sole consumer of the PI_AUTOUPDATE banner trigger; removed with it (auto-update.sh also no longer runs pi update --extensions)
- `auto-recover.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `auto-update-extensions.mjs` — retired 2026-09-01: dormant: settings.packages=[] since the 2026-08-31 fork completion — session-start auto-apply of npm extension updates had nothing to apply; extensions are local forks updated via git; moved to backups/retired-patches/
- `bash-router.ts` — retired 2026-10-10: annotation hook that nudged bash commands toward dedicated tools; the nudges duplicated tool descriptions and tool_search. The pure classifier stays in lib/bash-routing.ts for guidance and test detection. Do not recreate
- `capabilities.ts` — retired 2026-09-02: user direction: one-time per-session delegation/parallelism awareness message removed permanently (no backup) — the toolkit reachability is already evident from the tool list itself. Do not recreate
- `context-composition.json` — retired 2026-08-31: orphan of deleted pi-context-router; no writer/reader since 2026-08-12
- `context-mode` — retired 2026-09-01: user direction: context/knowledge-base system removed entirely — ctx_* MCP-bridge tools, 8 ctx skills, CM_PREWARM folded marker, ctx group in tool-loader, ctx overrides/excludes, drift-prompt mention; ~/.pi/context-mode/ state archived to ~/.pi/backups/retired-context-mode-state-20260901; fork moved to backups/retired-extensions/context-mode. Do not recreate
- `context-profile.ts` — retired 2026-10-10: 0 uses in 45 days of sessions; context diagnostics live in session_self. Do not recreate
- `desktop-session.ts` — retired 2026-10-10: 1 use in 45 days; Xvfb/xdotool via bash is enough. Do not recreate
- `DOCTRINE.md` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `fs-organize.ts` — retired 2026-10-10: 0 uses; file organization is plain bash guidance in the linux-ops skill. Do not recreate
- `governor-core.ts` — retired 2026-09-02: user direction: governor policy core removed with governor.ts (see that tombstone) — no broker remains; each extension owns its own injection gating. Do not recreate
- `governor.ts` — retired 2026-09-02: user direction: injection-budget broker removed permanently (no backup) — governor.ts + lib/governor-core.ts, /gov /why commands, governance tool, ~/.pi/governor policy/state all deleted. reminders/checkpoints/siblings now inject directly with their own hysteresis/dedup. Do not recreate
- `greybeard` — retired 2026-09-01: user direction: Greybeard standards engine removed entirely — fork (standards dir, skills, /greybeard commands, code-intent JIT banner) deleted; shared detectCodeIntent heuristic removed from tool-loader.ts; fork moved to backups/retired-extensions/greybeard. Do not recreate
- `harness-config.json` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `last-model.ts` — retired 2026-10-10: merged into model-config.ts (one model bookkeeping extension). Do not recreate
- `lichtfeld-studio.ts` — retired 2026-10-02: LichtFeld Studio needs an NVIDIA GPU (CUDA 12.8+, compute 7.5+) and could not run on the AMD-only development machine; replaced by lib/splat-studio.ts driving Brush (Apache-2.0, wgpu/Vulkan, works on integrated AMD/Intel GPUs) with splat_setup/splat_train/splat_preview. Do not recreate
- `local-lm-assets.mjs` — retired 2026-10-14: user direction 2026-10-14: no automatic local language model. Removed the Qwen3.5-0.8B llama.cpp service and every caller (Smol line selection, skill-relevance gate, mutation pre-screen step, discovery chooser); Kompress, Needle and Jev remain. scripts/install.mjs stops the unit and deletes local-models/qwen3.5-0.8b. Do not recreate
- `local-lm.ts` — retired 2026-10-14: user direction 2026-10-14: no automatic local language model. Removed the Qwen3.5-0.8B llama.cpp service and every caller (Smol line selection, skill-relevance gate, mutation pre-screen step, discovery chooser); Kompress, Needle and Jev remain. scripts/install.mjs stops the unit and deletes local-models/qwen3.5-0.8b. Do not recreate
- `long-prompt-offload.ts` — retired 2026-08-31: long-prompt offload system removed per user direction — long prompts now pass through the normal input path verbatim (no file offload, ORIENTATION map, or discovery pre-pass); ~/.pi/prompt-offload/ deleted
- `loop.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `media-pipeline.ts` — retired 2026-10-10: media_pipeline tool removed; lib/media-pipeline.ts batch orchestrator had no production caller left (audio_mix and music_compose remain standalone). Do not recreate
- `micro-agents.ts` — retired 2026-09-02: user direction: single-model read-only micro-agent swarm (micro_agent/micro_status/micro_wait/micro_kill tools, /micro-agent command, micro-agents.json config, agent/micro-runs/ state) removed permanently (no backup) — pi-subagents + pi-background-tasks cover the capability. Do not recreate
- `micro-intelligence/coordinator.ts` — retired 2026-09-19: Removed unused duplicate caches and write-only evidence ledger; helper owners retain their production caches and metrics.
- `minify-system-prompt.mjs` — retired 2026-09-02: user direction: system-prompt minification (intro + tool-catalog snippet dedupe) removed permanently (no backup) — saving prompt bytes no longer worth patching pi core and altering tool-catalog presentation. Do not recreate
- `ml-lab.ts` — retired 2026-10-10: 0 uses; ML training is plain bash/python guidance in the ml skill. Do not recreate
- `openrouter-provider.ts` — retired 2026-08-31: provider routing redundant with native catalogs + suffix selectors; backups/provider-cleanup-20260831/. SUPERSEDED AGAIN 2026-08-31 by extensions/provider-cmd.ts (/provider + /or-provider slash command: interactive pick, order/only/sort/list/status/clear/json, persists providers.openrouter.modelOverrides[].compat.openRouterRouting)
- `pi-agent-extensions.ts` — retired 2026-08-12: todo duty moved to the rpiv-todo fork
- `pi-cache-optimizer.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-capabilities.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-context-router.ts` — retired 2026-08-12: task classifier (doctrine/memory/goal/todo/gov injection, context budgets); 2026-08-12 refactor — do not recreate
- `pi-evaluator.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-fff` — retired 2026-09-01: user direction: fffind/ffgrep (fuzzy find/grep via @ff-labs/fff-node, native libfff_c.so through ffi-rs) removed ENTIRELY — fork source DELETED with NO backup retained (user: no rollback ability wanted), FFF_DEFER session_start-defer folded marker removed, vendored node_modules (@ff-labs/fff-node + ffi-rs + @yuuang/ffi-rs-linux-x64-gnu native platform binding) deleted with it, ~/.pi/agent/fff/ runtime state (frecency/history index) deleted, harness-backup vendored-deps machinery removed. Do not recreate
- `pi-goal` — retired 2026-08-31: goal-tracker extension removed; todo duty is the rpiv-todo fork. Not to be confused with pi-goals.ts (older, also deleted 2026-08-12)
- `pi-goals.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate (distinct from pi-goal)
- `pi-hermes-memory.ts` — retired 2026-08-12: superseded by the pi-memory fork
- `pi-local-lm.service` — retired 2026-10-14: user direction 2026-10-14: no automatic local language model. Removed the Qwen3.5-0.8B llama.cpp service and every caller (Smol line selection, skill-relevance gate, mutation pre-screen step, discovery chooser); Kompress, Needle and Jev remain. scripts/install.mjs stops the unit and deletes local-models/qwen3.5-0.8b. Do not recreate
- `pi-mcp-adapter.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-orchestrator.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-smol-preprocessor.service` — retired 2026-09-25: SmolLM2-135M-Instruct (Q2_K) chose lines at chance level on harness data (skill-relevance AUC 0.53) and almost never ran (eligibility gates rejected nearly every offer; its 250ms take-wait missed ~1s inference). Replaced by the shared local language model Qwen3.5-0.8B (pi-local-lm.service, lib/local-lm.ts, lib/local-lm-assets.mjs): AUC 0.88. local-lm-assets.mjs install retires the old unit and weights. Do not recreate
- `pi-subagents.ts` — retired 2026-08-12: extension file superseded by npm:pi-subagents (the package name stays live)
- `pi-tinyfish.ts` — retired 2026-08-31: web_search/web_fetch overlap with npm:pi-web-access; moved to backups/retired-extensions/
- `pi-ux.ts` — retired 2026-09-01: user direction: UX-discipline extension removed — ux_audit tool, UX banner injection, nearestPassingFg folded marker, ux group in tool-loader all deleted; shared detectUiIntent heuristic removed from tool-loader.ts; moved to backups/retired-extensions/pi-ux.ts. Do not recreate
- `ponytail` — retired 2026-08-31: pilot/ponytail governor-predecessor experiment; scrubbed. (Sibling codename "pilot" deliberately NOT tombstoned — too generic a token for word-boundary matching.)
- `pressure-journal.mjs` — retired 2026-09-01: patch module folded into retry-429-policy.mjs (single owner per file: both edited pi-ai retry.js/retryAssistantCall and that pairing broke once); moved to backups/retired-patches/
- `project-memory-consolidate.ts` — retired 2026-10-10: project_memory consolidate action removed; lib/project-memory-consolidate.ts had no production caller left. Do not recreate
- `reasoning-aids.ts` — retired 2026-10-10: coverage_select/decision_frontier/dependency_plan had 0 uses; reasoning is the model's job. Do not recreate
- `repo-recon.json` — retired 2026-08-31: orphan of deleted pi-context-router; backup backups/repo-recon.json.20260831.bak
- `research-toolkit.ts` — retired 2026-10-10: 0 uses; web_research/fetch_content/web_search cover it. Do not recreate
- `scene-model.mjs` — retired 2026-10-10: scene studio runtime had no tool after scene_create/scene_render were removed. Do not recreate
- `scene-runtime.mjs` — retired 2026-10-10: scene studio runtime had no tool after scene_create/scene_render were removed. Do not recreate
- `scene-studio.ts` — retired 2026-10-10: scene_create and scene_render tools removed; lib/scene-studio.ts had no production caller left. Do not recreate
- `session-bridge.ts` — retired 2026-08-31: cross-session awareness + bridge tool removed at user direction; backups/retired-extensions/session-bridge.ts; data dir ~/.pi/session-bridge deleted (residual files from still-running sessions queued for cleanup). SUPERSEDED 2026-08-31 by extensions/siblings.ts — user-directed reinstatement, leaner: one-shot join notice + voluntary md board; no bridge tool, no tool-result annotations
- `session-reviewer.ts` — retired 2026-08-31: review channel superseded by checkpoints; references scrubbed
- `session-watchmaker.ts` — retired 2026-10-10: merged into session-observer.ts: one background reviewer now judges quality, intent and time (time-ledger row); the watchmaker role, scratchpad memos, /watchmaker command and its model role were removed. Do not recreate
- `smol-extraction.ts` — retired 2026-10-14: user direction 2026-10-14: no automatic local language model. Removed the Qwen3.5-0.8B llama.cpp service and every caller (Smol line selection, skill-relevance gate, mutation pre-screen step, discovery chooser); Kompress, Needle and Jev remain. scripts/install.mjs stops the unit and deletes local-models/qwen3.5-0.8b. Do not recreate
- `smol-preprocessor.ts` — retired 2026-10-14: user direction 2026-10-14: no automatic local language model. Removed the Qwen3.5-0.8B llama.cpp service and every caller (Smol line selection, skill-relevance gate, mutation pre-screen step, discovery chooser); Kompress, Needle and Jev remain. scripts/install.mjs stops the unit and deletes local-models/qwen3.5-0.8b. Do not recreate
- `subagent-tool-description.md` — retired 2026-09-02: runtime-orphaned custom tool-description file (its toolDescriptionMode: 'custom' loader retired with the tool-desc-overrides seam 2026-09-02). Delegation posture folded into the pi-subagents fork's DEFAULT_SUBAGENT_TOOL_DESCRIPTION + SUBAGENT_TOOL_PROMPT_GUIDELINES (src/extension/tool-description.ts), which now own the subagent tool prompt; file moved to backups/retired-extensions/. Do not recreate
- `telemetry.json` — retired 2026-08-31: orphan of deleted pi-context-router; nothing wrote or read it since 2026-08-12
- `thinking-control.ts` — retired 2026-08-31: full /effort alias + dynamic thinking control superseded by minimal extensions/thinking.ts (2026-08-31, same session); pi-native /thinking stays authoritative for native level-setting
- `timeout-guard.ts` — retired 2026-10-10: merged into managed-bash.ts: the bash tool owner now injects the default timeout. Do not recreate
- `tool-desc-overrides.mjs` — retired 2026-09-02: user direction: tool-description override seam (SDK agent-session.js + bundle chunk __piOverrideTools builder) removed permanently (no backup) — patch module, tool-description-overrides.json config, and bench/tool-overrides-test.mjs all deleted. Do not recreate
- `tool-loader.ts` — retired 2026-09-01: user direction: default pi tool exposure restored. Its reason to exist was the oversized tool/skill surface of context-mode + greybeard + pi-ux, all retired 2026-09-01; gating 6 groups (files/intel/web/memory/delegate/bg) behind `load_tools` no longer pays for itself. Removed: load_tools + skills catalogue tools, session_start group deactivation, turn_end settle re-apply, drift warning, JIT skills/pi-docs prompt strips, deferred-skill path tracking. Consequence (accepted): every registered tool schema ships every turn (~86KB at 15 extensions) and the skills/pi-docs prompt blocks are no longer stripped. File moved to backups/retired-extensions/tool-loader.ts. Do not recreate
- `ultimate-pi.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `video-ambient.mjs` — retired 2026-10-10: worker script of lib/video-ambient.ts, retired with it. Do not recreate
- `video-ambient.ts` — retired 2026-10-10: video_ambient tool removed; lib/video-ambient.ts native ambient renderer had no production caller left. Do not recreate
- `video-generate.ts` — retired 2026-10-10: hosted video generation had no tool after video_generate was removed. Do not recreate
