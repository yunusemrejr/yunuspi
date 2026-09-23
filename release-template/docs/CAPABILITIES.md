# Capability inventory

> Generated from the sanitized public source tree by `agent/scripts/generate-capabilities-doc.mjs`. This is a source inventory: it records literal registrations and named dynamic owners, while runtime availability still depends on the host, configuration, permissions, and optional dependencies.

The inventory is intentionally maintainable from two public authorities: the extension manifest and the static capability catalog. The generated JSON beside this file is the machine-readable form. No session, private configuration, credential, or live registry data is read.

**Source authority:** [`agent/extensions/manifest.json`](../../agent/extensions/manifest.json) (shipped files and tombstones); [`agent/extensions/lib/harness-capabilities.ts`](../../agent/extensions/lib/harness-capabilities.ts) (capability records).

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

**Source:** [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts), [`agent/extensions/pi-background-tasks/src/core/registry.ts`](../../agent/extensions/pi-background-tasks/src/core/registry.ts), [`agent/extensions/pi-background-tasks/src/core/completion-wake.ts`](../../agent/extensions/pi-background-tasks/src/core/completion-wake.ts)

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

**Source:** [`agent/extensions/pi-subagents/src/intercom/intercom-bridge.ts`](../../agent/extensions/pi-subagents/src/intercom/intercom-bridge.ts), [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts), [`agent/extensions/pi-subagents/src/intercom/result-intercom.ts`](../../agent/extensions/pi-subagents/src/intercom/result-intercom.ts), [`agent/extensions/pi-subagents/src/shared/types.ts`](../../agent/extensions/pi-subagents/src/shared/types.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

### commands

#### hook-guidance

Attach one deterministic workflow reminder to the first matching tool result; hooks annotate and recover without blocking or changing authority.

**Entrypoints:** `tool_call`, `tool_result`, `session_start`, `session_switch`

**Options:**

- `PI_SESSION_HOOKS`: Disable this annotation surface when set to off. Values: `on`, `off`.
- `tool_call`: Match the tool name and input before execution.
- `tool_result`: Annotate the corresponding success or failure once.

**Related records:** `quick-commands`, `safety-bounds`

**Source:** [`agent/extensions/session-hooks.ts`](../../agent/extensions/session-hooks.ts), [`agent/extensions/lib/session-hooks.ts`](../../agent/extensions/lib/session-hooks.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### quick-commands

Use the installed slash-command surface for session controls, model/provider routing, plans, reminders, project graph, observations and background work.

**Entrypoints:** `pi.getCommands`, `registerCommand`

**Commands:** `/cost`, `/self`, `/metrics`, `/obs`, `/effort`, `/reminder`, `/graph`, `/provider`, `/or-provider`, `/models`, `/todos`, `/memory-prime`, `/bg`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update`, `/jobs`, `/logs`, `/kill`, `/subagents`, `/run`, `/subagents-doctor`, `/subagents-inspect-rpc`, `/subagents-refine`, `/subagents-fleet`, `/subagents-detach`, `/subagents-stop`, `/subagents-steer`, `/subagents-models`, `/subagents-profiles`, `/subagents-load-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles`, `/subagents-check-profile`, `/subagents-watchdog`, `/prompt-workflow`, `/google-account`, `/sys-prompt`, `/used`, `/errors`, `/commands`, `/guardian`

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

**Source:** [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts), [`agent/extensions/model-routing-config.ts`](../../agent/extensions/model-routing-config.ts), [`agent/extensions/lib/session-telemetry.ts`](../../agent/extensions/lib/session-telemetry.ts), [`agent/extensions/thinking.ts`](../../agent/extensions/thinking.ts), [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts), [`agent/extensions/rpiv-todo/todo.ts`](../../agent/extensions/rpiv-todo/todo.ts), [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

### communication

#### agentmail-email

Send and read email through AgentMail (outreach and inbox triage) with an environment-provided API key: inbox discovery, bounded sends with a required subject, compact inbox listing, full-text search, and single-message reads.

**Entrypoints:** `agentmail_status`, `agentmail_send`, `agentmail_messages`, `agentmail_search`, `agentmail_message`

**Catalog tool pointers:** `agentmail_status`, `agentmail_send`, `agentmail_messages`, `agentmail_search`, `agentmail_message`

**Options:**

- `AGENTMAIL_API_KEY`: Required environment variable; read at call time and never persisted, logged or echoed.
- `AGENTMAIL_INBOX_ID`: Default sender inbox (usually the sending address) used when a call omits inboxId.
- `AGENTMAIL_BASE_URL`: Optional endpoint override, for example another AgentMail region.
- `to|cc|bcc|replyTo|subject|text|html|labels`: Send fields; a subject and a text or html body are required, and CR/LF is rejected.
- `inboxId|limit|pageToken|from|to|subject|labels|ascending|includeSpam|includeTrash`: Inbox listing scope and filters; list rows stay compact and carry a preview, and nextPageToken pages through every page.
- `q|before|after`: Full-text search query with optional ISO timestamp bounds; rows carry per-field match highlights.
- `includeHtml`: Opt-in HTML body on a single-message read.

**Related records:** `web-and-media`, `safety-bounds`

**Source:** [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts), [`agent/extensions/http-tools.ts`](../../agent/extensions/http-tools.ts)

**Documentation:** [`docs/EMAIL.md`](EMAIL.md)

### coordination

#### session-coordination

Coordinate independent Pi sessions sharing one checkout through voluntary objectives, file scopes, recent writes and a local Markdown board; peers are advisory, not remote messaging or locks.

**Entrypoints:** `session_coordinate`, `sibling-bridge`, `todo-plan-changed`

**Catalog tool pointers:** `session_coordinate`

**Options:**

- `action`: Coordination operation. Values: `status`, `publish`, `clear`.
- `objective`: Bounded objective text, up to 240 characters.
- `note`: Bounded handoff note, up to 500 characters.
- `files`: Up to 32 absolute or cwd-resolved files/directories.
- `PI_SIBLING_STALE_WRITES`: Disable stale-read write blocking when set to off.
- `coordinationRoot`: Canonical same-checkout identity joins nested paths and symlink aliases.

**Related records:** `todo-planning`, `background-tasks`, `safety-bounds`

**Source:** [`agent/extensions/siblings.ts`](../../agent/extensions/siblings.ts), [`agent/extensions/rpiv-todo/state/plan.ts`](../../agent/extensions/rpiv-todo/state/plan.ts)

**Documentation:** [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)

### diagnostics

#### context-diagnostics

Inspect selected-model full-window context occupancy and 80% automatic compaction threshold alongside separate runtime, failure, efficiency and past-session diagnostics.

**Entrypoints:** `session_self`, `session_audit`, `self`, `cost`, `metrics`, `sys-prompt`, `used`, `errors`, `commands`

**Catalog tool pointers:** `session_self`, `session_audit`

**Commands:** `/self`, `/cost`, `/metrics`, `/sys-prompt`, `/used`, `/errors`, `/commands`

**Options:**

- `view`: Session diagnostic view. Values: `session`, `context`, `runtime`, `failures`, `efficiency`.
- `scope`: Past-session audit scope. Values: `workspace`, `all`.
- `contextWindow`: Selected model's full context window.
- `contextWindowPercent`: Current tokens divided by full context window.
- `compactionTrigger`: Inclusive automatic threshold at 80% of full window.
- `usablePercent`: Separate output/safety headroom pressure diagnostic.

**Related records:** `memory-retrieval`, `quick-commands`, `quality-review`

**Source:** [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts), [`agent/extensions/lib/session-signals.ts`](../../agent/extensions/lib/session-signals.ts), [`agent/extensions/lib/session-audit.ts`](../../agent/extensions/lib/session-audit.ts), [`agent/extensions/lib/session-telemetry.ts`](../../agent/extensions/lib/session-telemetry.ts)

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

**Source:** [`agent/extensions/lib/relevant-guidance.ts`](../../agent/extensions/lib/relevant-guidance.ts), [`agent/extensions/lib/skill-relevance.ts`](../../agent/extensions/lib/skill-relevance.ts), [`agent/extensions/lib/capability-groups.ts`](../../agent/extensions/lib/capability-groups.ts)

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

**Source:** [`agent/extensions/lib/tool-discovery.ts`](../../agent/extensions/lib/tool-discovery.ts), [`agent/extensions/lib/capability-groups.ts`](../../agent/extensions/lib/capability-groups.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

### engineering

#### source-intelligence

Inspect bounded syntax, AST context, symbols, callers/callees and Git structure without executing project code; output limits and omitted coverage remain visible.

**Entrypoints:** `syntax_check`, `context_slice`, `symbol_expand`, `ast_diff`, `git_info`

**Catalog tool pointers:** `syntax_check`, `context_slice`, `symbol_expand`, `ast_diff`, `git_info`

**Options:**

- `paths`: Explicit source files for context_slice or symbol_expand.
- `task`: Task identifiers used to rank context_slice results.
- `symbol`: Symbol name for bounded expansion.
- `maxHops|maxNodes|maxChars`: AST and response bounds.
- `path`: Source path for syntax or Git inspection.
- `base|before|after`: Git base or supplied source pair for ast_diff.
- `action`: Git inspection operation. Values: `scope`, `status`, `diff`, `log`, `show`, `branch`.

**Related records:** `quality-review`, `project-intelligence`, `safety-bounds`

**Source:** [`agent/extensions/lib/source-check.ts`](../../agent/extensions/lib/source-check.ts), [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts), [`agent/extensions/git-tools.ts`](../../agent/extensions/git-tools.ts)

**Documentation:** [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)

#### artifact-numeric-checks

Check SVG references and source cues, image/text metadata, measured frame timing, render attachment memory and numerical/ML metrics locally with bounded results and no model calls. These checks do not certify visual quality, physical safety or GPU performance.

**Entrypoints:** `artifact_check`, `math_check`

**Catalog tool pointers:** `artifact_check`, `math_check`

**Options:**

- `artifact_check.operation`: Explicit artifact inspection. Values: `svg`, `ui`, `image`, `text`.
- `path|text`: One workspace path or supported inline source; SVG is bounded to 64 KiB.
- `math_check.operation`: Deterministic numeric calculation. Values: `frame_budget`, `render_budget`, `summarize`, `compare`, `classify`, `vectors`, `split_overlap`.
- `values|target_fps`: Observed frame durations in milliseconds and target rate.
- `width|height|pixel_ratio|bytes_per_pixel|samples|buffers`: Explicit render attachment assumptions; excludes other allocations and driver overhead.

**Related records:** `source-intelligence`, `web-and-media`, `safety-bounds`

**Source:** [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts), [`agent/extensions/lib/svg-check.ts`](../../agent/extensions/lib/svg-check.ts), [`agent/extensions/lib/numeric-checks.ts`](../../agent/extensions/lib/numeric-checks.ts)

**Documentation:** [`docs/SKILLS-AND-CHECKS.md`](SKILLS-AND-CHECKS.md)

#### rendered-design-review

Collect rendered typography, spacing, surface effects, solid-color text contrast, overflow and motion evidence for accessible and anti-slop UI review. Compare viewport/state screenshots using design skills; no aesthetic score or compliance claim.

**Entrypoints:** `design_audit`

**Catalog tool pointers:** `design_audit`, `render_see`, `browser_session`, `web_asset_check`

**Options:**

- `source`: Local HTML or HTTP(S) page, inspected in the existing isolated browser.
- `width|height|colorScheme|reducedMotion`: Explicit responsive/theme/motion test condition.
- `output`: text for measurements; both includes pixels for vision-capable models. Values: `text`, `both`.

**Related records:** `web-and-media`, `source-intelligence`

**Source:** [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts), [`agent/scripts/render-design-state.mjs`](../../agent/scripts/render-design-state.mjs)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

#### delivery-preflight

Inspect GitHub Actions workflow dependencies/matrix bounds, static web asset references for hosting, and Ubuntu unit/journal metadata without running workflows, publishing sites or mutating services. Source-backed findings with explicit unresolved expressions.

**Entrypoints:** `workflow_probe`, `web_asset_check`, `sys_probe`

**Catalog tool pointers:** `workflow_probe`, `web_asset_check`, `sys_probe`, `git_info`, `package_probe`, `env_audit`

**Options:**

- `path|project`: Explicit workflow YAML and project root.
- `files|asset_root|public_path`: Explicit HTML/CSS/manifest sources and hosting asset boundary.
- `sys_probe.action`: Inspect systemd unit fields or metadata-only journal pages. Values: `service_detail`, `journal`.

**Related records:** `source-intelligence`, `safety-bounds`, `rendered-design-review`

**Source:** [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs), [`agent/extensions/sys-probe.ts`](../../agent/extensions/sys-probe.ts)

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

**Source:** [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts), [`agent/extensions/pi-memory/priming.ts`](../../agent/extensions/pi-memory/priming.ts)

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

**Source:** [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts), [`agent/extensions/pi-memory/priming.ts`](../../agent/extensions/pi-memory/priming.ts), [`agent/extensions/pi-memory/mutation.ts`](../../agent/extensions/pi-memory/mutation.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

#### memory-evidence

Keep small verbatim project observations with SHA256 provenance and retrieve unchanged evidence from the active session branch; inferred claims and unattributed URLs are rejected.

**Entrypoints:** `evidence_cache`, `context_score`, `handoff_capsule`

**Catalog tool pointers:** `evidence_cache`, `context_score`, `handoff_capsule`

**Options:**

- `action`: Evidence cache operation. Values: `put`, `query`.
- `source`: Local project source path or attributable source id.
- `quote`: Verbatim observation to cache.
- `query`: Evidence relevance query.
- `goal`: Goal used to build a handoff capsule.
- `items`: Bounded context items for scoring or capsule extraction.
- `maxChars`: Capsule output bound; default 2200.

**Related records:** `memory-notes`, `memory-retrieval`, `context-diagnostics`

**Source:** [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts), [`agent/extensions/pi-memory/context-evidence.ts`](../../agent/extensions/pi-memory/context-evidence.ts), [`agent/extensions/pi-memory/context-salience.ts`](../../agent/extensions/pi-memory/context-salience.ts)

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

**Source:** [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../../agent/extensions/pi-subagents/src/agents/agent-management.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts)

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

**Related records:** `agent-model-management`, `provider-routing`, `fusion-review`

**Source:** [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../../agent/extensions/pi-subagents/src/agents/agent-management.ts), [`agent/extensions/pi-subagents/src/runs/shared/model-selection.ts`](../../agent/extensions/pi-subagents/src/runs/shared/model-selection.ts), [`agent/extensions/pi-subagents/src/shared/model-info.ts`](../../agent/extensions/pi-subagents/src/shared/model-info.ts)

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

**Source:** [`agent/extensions/provider-cmd.ts`](../../agent/extensions/provider-cmd.ts), [`agent/extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts`](../../agent/extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

#### model-preferences

Prefer explicit per-role model/provider choices from llm_preferences.json, with the autonomous selector as fallback when preferences are absent or unusable.

**Entrypoints:** `/models`, `llm_preferences.json`, `resolveLlmPreferenceChain`, `selectAssistanceTeam`

**Options:**

- `models`: Reusable alias registry of provider/model/thinking/provider_options entries.
- `preferences.<role>.models`: Ordered alias list per role: subagents, council, swarm, fusion, quality_review, project_review, error_review, prompt_analysis, main_session_fallback.
- `/models`: Open the graphical editor for ordered role routes, upstream pins and canonical JSON recovery.
- `thinking`: Explicit level, auto for dynamic logic, or none for off. Values: `auto`, `none`, `low`, `medium`, `high`, `max`.
- `provider_options.routing`: OpenRouter backend control; auto preserves normal selection. Values: `auto`, `pinned`, `custom`.

**Related records:** `model-selection`, `provider-routing`, `agent-model-management`

**Source:** [`agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts`](../../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts), [`agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts`](../../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts), [`agent/extensions/model-routing-config.ts`](../../agent/extensions/model-routing-config.ts), [`agent/extensions/lib/model-routing-store.ts`](../../agent/extensions/lib/model-routing-store.ts), [`agent/extensions/lib/model-routing-metrics.ts`](../../agent/extensions/lib/model-routing-metrics.ts)

**Documentation:** [`docs/LLM-PREFERENCES.md`](LLM-PREFERENCES.md)

#### local-intelligence

Local ML/statistical evidence ranking, context scoring and extractive handoffs; optional Kompress SLM paragraph selection. Automatic helpers run only when configured and eligible; discovery neither loads models nor starts inference.

**Entrypoints:** `context_score`, `handoff_capsule`, `evidence_cache`, `session_self`

**Catalog tool pointers:** `context_score`, `handoff_capsule`, `evidence_cache`, `session_self`

**Options:**

- `context_score`: Rank supplied items by task relevance and protected evidence; scores are priorities, not probabilities.
- `handoff_capsule`: Prepare a short extractive handoff instead of copying an entire session.
- `automatic preprocessing`: Optional local SLM selects original paragraphs; unavailable workers preserve source text. No direct inference tool is implied.

**Related records:** `memory-evidence`, `context-diagnostics`, `skill-catalog`

**Source:** [`agent/extensions/lib/local-intelligence.mjs`](../../agent/extensions/lib/local-intelligence.mjs), [`agent/extensions/lib/mini-preprocessor.ts`](../../agent/extensions/lib/mini-preprocessor.ts), [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts)

**Documentation:** [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)

#### micro-intelligence

Deterministic/Needle3/Smol/Kompress/Jev helper stack for discovery re-ranking, evidence triage, intent pre-screening and request advisories; Jev is a bounded remote OpenRouter advisory and deterministic owners keep authority when helpers are unavailable.

**Entrypoints:** `micro_status`

**Catalog tool pointers:** `micro_status`

**Options:**

- `PI_MICRO_INTELLIGENCE`: Set to off to disable the lifecycle extension; routing, eligibility, safety and truth stay with existing owners.
- `PI_NEEDLE`: Set to off to disable Needle re-ranking, or PI_NEEDLE_SHADOW=1 to measure without applying.
- `PI_MICRO_ADVISORY`: Set to off to skip the per-request Jev advisory batch.
- `PI_JEV`: Set to off to disable remote Jev calls. When enabled, bounded task/request excerpts (maximum 32768 characters) may be sent to OpenRouter.

**Related records:** `local-intelligence`, `tool-catalog`, `skill-catalog`, `context-diagnostics`

**Source:** [`agent/extensions/micro-intelligence.ts`](../../agent/extensions/micro-intelligence.ts), [`agent/extensions/lib/needle-runtime.ts`](../../agent/extensions/lib/needle-runtime.ts), [`agent/extensions/lib/jev-client.ts`](../../agent/extensions/lib/jev-client.ts), [`agent/extensions/lib/micro-intelligence/metrics.ts`](../../agent/extensions/lib/micro-intelligence/metrics.ts)

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

**Related records:** `workflow-orchestration`, `agent-model-management`, `background-tasks`, `swarm-execution`, `fusion-review`

**Source:** [`agent/extensions/pi-subagents/src/extension/index.ts`](../../agent/extensions/pi-subagents/src/extension/index.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/extension/public-execution.ts`](../../agent/extensions/pi-subagents/src/extension/public-execution.ts), [`agent/extensions/pi-subagents/src/intercom/result-intercom.ts`](../../agent/extensions/pi-subagents/src/intercom/result-intercom.ts)

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

**Source:** [`agent/extensions/pi-subagents/src/workflows/workflow-resources.ts`](../../agent/extensions/pi-subagents/src/workflows/workflow-resources.ts), [`agent/extensions/pi-subagents/src/extension/public-execution.ts`](../../agent/extensions/pi-subagents/src/extension/public-execution.ts), [`agent/extensions/pi-subagents/src/extension/schemas.ts`](../../agent/extensions/pi-subagents/src/extension/schemas.ts), [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts)

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

**Source:** [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts), [`agent/extensions/pi-subagents/src/shared/prompt-resources.ts`](../../agent/extensions/pi-subagents/src/shared/prompt-resources.ts)

**Documentation:** [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

#### swarm-execution

Run separable child investigations in parallel and preserve each outcome, failure and acceptance evidence for parent review.

**Entrypoints:** `subagent.tasks`, `runs.all`, `runs.recover`, `todo.execution:swarm`

**Catalog tool pointers:** `subagent`, `todo`

**Options:**

- `tasks`: Parallel child array with agent/task and per-child options.
- `commonTask`: Shared brief injected into every child.
- `concurrency`: Positive native task concurrency.
- `async`: Keep the composite running without blocking the parent.
- `runs.recover`: Build a bounded respawn plan for failed fanout members.
- `execution`: Todo execution annotation. Values: `swarm`.

**Related records:** `subagent-dispatch`, `fusion-review`, `todo-planning`, `agent-model-management`

**Source:** [`agent/extensions/pi-subagents/src/runs/shared/assistance-plan.ts`](../../agent/extensions/pi-subagents/src/runs/shared/assistance-plan.ts), [`agent/extensions/pi-subagents/src/runs/shared/swarm-recovery.ts`](../../agent/extensions/pi-subagents/src/runs/shared/swarm-recovery.ts), [`agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts`](../../agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts), [`agent/extensions/rpiv-todo/tool/types.ts`](../../agent/extensions/rpiv-todo/tool/types.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

#### fusion-review

Merge child outputs deterministically with provenance, retaining duplicate, complementary and conflicting sections for review.

**Entrypoints:** `runs.fuse`, `runs.fuseFragments`, `todo.execution:fusion`

**Catalog tool pointers:** `subagent`, `todo`

**Options:**

- `runs.fuse`: Fuse text outputs from a completed run set.
- `runs.fuseFragments`: Fuse structured owner/kind/body/updatedAt fragments.
- `fragments[].owner`: Source worker identity.
- `fragments[].kind`: Fragment classification. Values: `duplicate`, `complementary`, `conflict`.
- `fragments[].body`: Source-preserving fragment body.
- `fragments[].updatedAt`: Finite ordering timestamp.
- `config.maxBodyChars`: Positive fused-body bound, at most 131072.
- `execution`: Todo execution annotation. Values: `fusion`.

**Related records:** `subagent-dispatch`, `swarm-execution`, `quality-review`

**Source:** [`agent/extensions/pi-subagents/src/runs/shared/fusion.ts`](../../agent/extensions/pi-subagents/src/runs/shared/fusion.ts), [`agent/extensions/pi-subagents/src/workflows/recovery-seam.ts`](../../agent/extensions/pi-subagents/src/workflows/recovery-seam.ts), [`agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts`](../../agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts)

**Documentation:** [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)

### planning

#### todo-planning

Maintain a durable hierarchical plan with dependencies, execution annotations, file scopes and evidence-backed completion.

**Entrypoints:** `todo`, `todos`

**Catalog tool pointers:** `todo`

**Commands:** `/todos`

**Options:**

- `action`: Plan mutation. Values: `create`, `update`, `list`, `get`, `delete`, `clear`, `batch`.
- `view`: List projection. Values: `tree`, `frontier`.
- `execution`: Native orchestration annotation. Values: `self`, `subagent`, `swarm`, `fusion`.
- `parentId|blockedBy`: Hierarchy and dependency ids.
- `files`: Explicit relative paths in a task scope.
- `acceptance|evidence`: Completion contract and observed verification.
- `refs`: Project fact, observation or source references.
- `operations`: Atomic create/update/delete batch, up to 32.

**Related records:** `session-coordination`, `swarm-execution`, `fusion-review`, `memory-notes`

**Source:** [`agent/extensions/rpiv-todo/todo.ts`](../../agent/extensions/rpiv-todo/todo.ts), [`agent/extensions/rpiv-todo/tool/types.ts`](../../agent/extensions/rpiv-todo/tool/types.ts), [`agent/extensions/rpiv-todo/state/plan.ts`](../../agent/extensions/rpiv-todo/state/plan.ts)

**Documentation:** [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)

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

**Source:** [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts), [`agent/extensions/lib/project-intelligence/query.mjs`](../../agent/extensions/lib/project-intelligence/query.mjs), [`agent/extensions/lib/project-intelligence/store.mjs`](../../agent/extensions/lib/project-intelligence/store.mjs)

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

**Source:** [`agent/extensions/pi-subagents/src/extension/scope-council-runner.ts`](../../agent/extensions/pi-subagents/src/extension/scope-council-runner.ts), [`agent/extensions/lib/scope-deliberation.ts`](../../agent/extensions/lib/scope-deliberation.ts)

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

**Source:** [`agent/extensions/lib/quality-review.ts`](../../agent/extensions/lib/quality-review.ts), [`agent/extensions/lib/quality-review-signals.ts`](../../agent/extensions/lib/quality-review-signals.ts)

**Documentation:** [`docs/RECOVERY-AND-TESTING.md`](RECOVERY-AND-TESTING.md)

#### review-coordination

Coordinate distinct review kinds (quality, project, error) with trivial-work suppression, stuck-signal gating and cooldowns; the main agent stays the invoker.

**Entrypoints:** `review-coordinator`, `quality_review`, `prompt-workflow council`, `subagent worker briefs`

**Catalog tool pointers:** `quality_review`, `subagent`

**Options:**

- `kind`: Review kind with a distinct purpose and owner. Values: `quality`, `project`, `error`, `council`, `swarm`, `fusion`.
- `isTrivialChangeRequest`: Formatting/lint/trivial-cleanup suppression for automatic checks.
- `evaluateStuckSignal`: Strong stuck-pattern detection with transient exclusion.
- `shouldSuggestReview`: Cooldown, session-cap and recent-run gating for suggestions.

**Related records:** `quality-review`, `scope-council`, `subagent-dispatch`

**Source:** [`agent/extensions/lib/review-coordinator.ts`](../../agent/extensions/lib/review-coordinator.ts)

**Documentation:** [`docs/REVIEWS-AND-COUNCILS.md`](REVIEWS-AND-COUNCILS.md)

### safety

#### safety-bounds

Inspect host/session dependencies and device candidates before guarded operations; run disposable experiments with path, process, resource and authority boundaries. Recognized connectivity, power and session-destructive shell commands are blocked; unavailable isolation fails closed.

**Entrypoints:** `sys_probe`, `sandbox_run`, `filesystem-safety`, `harness:mutation-preflight`

**Catalog tool pointers:** `sys_probe`, `sandbox_run`, `git_info`

**Options:**

- `sys_probe.action`: Read host resources, network/power/session metadata or device candidates without opening devices. Values: `host`, `devices`, `listeners`, `services`, `processes`, `service_detail`, `journal`.
- `command`: Inline sandbox Bash script.
- `files[].path`: Relative disposable destination.
- `files[].content|source`: Exactly one inline fixture or project source.
- `timeoutMs`: Sandbox execution timeout, 1000–120000.
- `maxOutputBytes`: Sandbox output bound, 1024–65536.
- `PI_WRITE_DEGENERATION`: Disable the repeated-write degeneration heuristic only when set to 0. Values: `0`.
- `PI_SIBLING_STALE_WRITES`: Restore advisory-only sibling write behavior when off.

**Related records:** `session-coordination`, `subagent-dispatch`, `quick-commands`

**Source:** [`agent/extensions/sandbox.ts`](../../agent/extensions/sandbox.ts), [`agent/extensions/filesystem-safety.ts`](../../agent/extensions/filesystem-safety.ts), [`agent/extensions/lib/host-operation-safety.ts`](../../agent/extensions/lib/host-operation-safety.ts), [`agent/extensions/sys-probe.ts`](../../agent/extensions/sys-probe.ts), [`agent/extensions/siblings.ts`](../../agent/extensions/siblings.ts)

**Documentation:** [`docs/SECURITY.md`](SECURITY.md)

### web_media

#### web-and-media

Search and read web sources, operate browser tabs with DOM refs, screenshots, console JavaScript and condition waits, ask for CAPTCHA help, and analyze local media through bounded tools.

**Entrypoints:** `web_search`, `source_check`, `fetch_content`, `get_search_content`, `web_research`, `web_probe`, `browser_session`, `wait_for`, `render_see`, `media_info`, `video_frames`, `audio_analyze`, `media_edit`, `music_compose`, `image_ocr`

**Catalog tool pointers:** `web_search`, `source_check`, `fetch_content`, `get_search_content`, `web_research`, `web_probe`, `browser_session`, `wait_for`, `render_see`, `media_info`, `video_frames`, `audio_analyze`, `media_edit`, `music_compose`, `image_ocr`

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
- `action`: Browser or media operation selected by the tool schema.
- `session|tab|ref|frame`: Reuse owned browser handles and fresh DOM targets, including popup tabs and iframe ids.
- `kind|state|timeoutMs`: Browser wait condition: element, text, URL, load or JavaScript predicate.
- `query|offset|maxChars`: Search and paginate rendered page text with browser_session read.
- `reason`: request_help asks the user about a blocking verification challenge with a screenshot.
- `path|times|count|width|height`: Local media and frame bounds.

**Related records:** `source-intelligence`, `safety-bounds`, `background-tasks`

**Source:** [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts), [`agent/extensions/pi-web-access/research-jobs.ts`](../../agent/extensions/pi-web-access/research-jobs.ts), [`agent/extensions/pi-web-access/web-probe.ts`](../../agent/extensions/pi-web-access/web-probe.ts), [`agent/extensions/lib/browser-session.ts`](../../agent/extensions/lib/browser-session.ts), [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts), [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts)

**Documentation:** [`docs/ISOLATION-AND-WEB.md`](ISOLATION-AND-WEB.md)

#### creative-studio

Author editable local 3D scenes and fixed-clock animations, render H.264 video and posters, compose clip transitions and mix local audio. Three.js studio/clay/toon/wireframe styles, keyframes, camera and lights; no hosted generation or model calls.

**Entrypoints:** `scene_create`, `scene_render`, `video_compose`, `audio_mix`

**Catalog tool pointers:** `scene_create`, `scene_render`, `video_compose`, `audio_mix`, `music_compose`, `media_info`, `video_frames`, `audio_analyze`

**Options:**

- `scene`: Versioned declarative objects, materials, camera, lights and keyframes; inspect the live schema for bounds.
- `outputDir`: Fresh workspace artifact directory; originals preserved.
- `path`: Local scene or media source, never a URL.
- `clips|tracks`: Explicit bounded timeline and audio inputs, with decode verification.

**Related records:** `web-and-media`, `artifact-numeric-checks`, `background-tasks`

**Source:** [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts), [`agent/extensions/lib/scene-studio.ts`](../../agent/extensions/lib/scene-studio.ts), [`agent/extensions/lib/media-timeline.ts`](../../agent/extensions/lib/media-timeline.ts), [`agent/scripts/scene-runtime.mjs`](../../agent/scripts/scene-runtime.mjs)

**Documentation:** [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)

#### research-toolkit

Plan research angles and capture lead/company/contact candidates plus provenance-aware source notes with source URLs, retrieved-at timestamps and hashes. Local-only; compose with web_search/fetch_content/web_research and verify primary sources.

**Entrypoints:** `research_toolkit`

**Catalog tool pointers:** `research_toolkit`

**Options:**

- `action`: Toolkit operation. Values: `plan`, `lead`, `company`, `source`.
- `goal|context`: Research goal and optional context for plan.
- `name|company|role|domain`: Candidate identity fields for lead/company.
- `sourceUrl|retrievedAt`: Required http(s) provenance and timestamp.
- `evidence|quote`: Bounded verbatim evidence for lead/company/source.

**Related records:** `web-and-media`, `memory-evidence`, `safety-bounds`

**Source:** [`agent/extensions/research-toolkit.ts`](../../agent/extensions/research-toolkit.ts)

**Documentation:** [`docs/ISOLATION-AND-WEB.md`](ISOLATION-AND-WEB.md)

## Static tool and command registrations

Tool names come from literal registrations and source-owned factory definitions, catalogs and constants. Command names come from literal `registerCommand` calls. Computed registration names are listed as owners below; they are not guessed. Use `tool_search` for the authoritative live registry and activation state.

### Native core tools

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Extensions can wrap or replace these; explicit tool selections still apply.

### Stable extension tools

- `agentmail_message` — [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts) (line 1061; literal)
- `agentmail_messages` — [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts) (line 853; literal)
- `agentmail_search` — [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts) (line 965; literal)
- `agentmail_send` — [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts) (line 802; literal)
- `agentmail_status` — [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts) (line 725; literal)
- `archive_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 30; catalog)
- `artifact_check` — [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts) (line 105; factory)
- `ast_diff` — [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts) (line 12; definition)
- `audio_analyze` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 218; factory)
- `audio_mix` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 236; factory)
- `bash` — [`agent/extensions/managed-bash.ts`](../../agent/extensions/managed-bash.ts) (line 576; sdk-factory)
- `bg_kill` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 799; literal)
- `bg_logs` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 753; literal)
- `bg_run` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 636; literal)
- `bg_status` — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 722; literal)
- `bg_wait` — [`agent/extensions/pi-subagents/src/runs/background/wait-tool.ts`](../../agent/extensions/pi-subagents/src/runs/background/wait-tool.ts) (line 36; definition)
- `browser_session` — [`agent/extensions/lib/browser-session.ts`](../../agent/extensions/lib/browser-session.ts) (line 136; literal)
- `bulk_edit` — [`agent/extensions/bulk-edit.ts`](../../agent/extensions/bulk-edit.ts) (line 217; literal)
- `checkpoint_read` — [`agent/extensions/checkpoints.ts`](../../agent/extensions/checkpoints.ts) (line 207; literal)
- `contact_supervisor` — [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) (line 305; definition)
- `context_profile` — [`agent/extensions/context-profile.ts`](../../agent/extensions/context-profile.ts) (line 342; literal)
- `context_score` — [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts) (line 9; literal)
- `context_slice` — [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts) (line 10; definition)
- `contract_diff` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 24; catalog)
- `coverage_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 22; catalog)
- `coverage_select` — [`agent/extensions/pi-subagents/src/extension/reasoning-aids.ts`](../../agent/extensions/pi-subagents/src/extension/reasoning-aids.ts) (line 21; factory)
- `data_query` — [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts) (line 127; factory)
- `decision_frontier` — [`agent/extensions/pi-subagents/src/extension/reasoning-aids.ts`](../../agent/extensions/pi-subagents/src/extension/reasoning-aids.ts) (line 20; factory)
- `dependency_plan` — [`agent/extensions/pi-subagents/src/extension/reasoning-aids.ts`](../../agent/extensions/pi-subagents/src/extension/reasoning-aids.ts) (line 19; factory)
- `design_audit` — [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts) (line 218; literal)
- `env_audit` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 26; catalog)
- `evidence_cache` — [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts) (line 11; literal)
- `fetch_content` — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 196; configured-default)
- `get_search_content` — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 197; configured-default)
- `git_info` — [`agent/extensions/git-tools.ts`](../../agent/extensions/git-tools.ts) (line 189; literal)
- `handoff_capsule` — [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts) (line 10; literal)
- `http_request` — [`agent/extensions/http-tools.ts`](../../agent/extensions/http-tools.ts) (line 432; literal)
- `image_ocr` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 217; factory)
- `math_check` — [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts) (line 92; factory)
- `media_edit` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 219; factory)
- `media_info` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 215; factory)
- `memory_forget` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2507; literal)
- `memory_read` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2367; literal)
- `memory_restore` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2650; literal)
- `memory_search` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2749; literal)
- `memory_status` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2893; literal)
- `memory_write` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2019; literal)
- `micro_status` — [`agent/extensions/micro-intelligence.ts`](../../agent/extensions/micro-intelligence.ts) (line 387; literal)
- `music_compose` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 222; factory)
- `net_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 28; catalog)
- `obs_read` — [`agent/extensions/pi-observations.ts`](../../agent/extensions/pi-observations.ts) (line 847; literal)
- `openapi_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 20; catalog)
- `package_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 18; catalog)
- `process` — [`agent/extensions/managed-bash.ts`](../../agent/extensions/managed-bash.ts) (line 604; literal)
- `project_intel` — [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts) (line 736; literal)
- `project_tests` — [`agent/extensions/lib/project-tests.ts`](../../agent/extensions/lib/project-tests.ts) (line 531; literal)
- `quality_review` — [`agent/extensions/lib/quality-review.ts`](../../agent/extensions/lib/quality-review.ts) (line 506; literal)
- `render_see` — [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts) (line 217; literal)
- `research_toolkit` — [`agent/extensions/research-toolkit.ts`](../../agent/extensions/research-toolkit.ts) (line 57; literal)
- `sandbox_run` — [`agent/extensions/sandbox.ts`](../../agent/extensions/sandbox.ts) (line 9; literal)
- `scene_create` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 232; factory)
- `scene_render` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 233; factory)
- `scratchpad` — [`agent/extensions/pi-memory/index.ts`](../../agent/extensions/pi-memory/index.ts) (line 2180; literal)
- `session_audit` — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1818; literal)
- `session_coordinate` — [`agent/extensions/siblings.ts`](../../agent/extensions/siblings.ts) (line 584; literal)
- `session_self` — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1755; literal)
- `session_stop` — [`agent/extensions/checkpoints.ts`](../../agent/extensions/checkpoints.ts) (line 362; literal)
- `skill_review` — [`agent/extensions/lib/relevant-guidance.ts`](../../agent/extensions/lib/relevant-guidance.ts) (line 652; literal)
- `source_check` — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 195; configured-default)
- `sqlite_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 16; catalog)
- `structured_output` — [`agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`](../../agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts) (line 865; literal)
- `subagent` — [`agent/extensions/pi-subagents/src/extension/fanout-child.ts`](../../agent/extensions/pi-subagents/src/extension/fanout-child.ts) (line 179; definition)
- `subagent` — [`agent/extensions/pi-subagents/src/extension/index.ts`](../../agent/extensions/pi-subagents/src/extension/index.ts) (line 757; definition)
- `subagent_supervisor` — [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) (line 22; constant)
- `symbol_expand` — [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts) (line 11; definition)
- `syntax_check` — [`agent/extensions/lib/source-check.ts`](../../agent/extensions/lib/source-check.ts) (line 173; literal)
- `sys_probe` — [`agent/extensions/sys-probe.ts`](../../agent/extensions/sys-probe.ts) (line 254; literal)
- `todo` — [`agent/extensions/rpiv-todo/tool/types.ts`](../../agent/extensions/rpiv-todo/tool/types.ts) (line 11; constant)
- `tool_search` — [`agent/extensions/lib/tool-discovery.ts`](../../agent/extensions/lib/tool-discovery.ts) (line 220; literal)
- `value_convert` — [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts) (line 123; factory)
- `video_compose` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 235; factory)
- `video_frames` — [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) (line 216; factory)
- `wait_for` — [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts) (line 59; literal)
- `web_asset_check` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 14; catalog)
- `web_probe` — [`agent/extensions/pi-web-access/web-probe.ts`](../../agent/extensions/pi-web-access/web-probe.ts) (line 120; literal)
- `web_research` — [`agent/extensions/pi-web-access/research-jobs.ts`](../../agent/extensions/pi-web-access/research-jobs.ts) (line 69; literal)
- `web_search` — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 194; configured-default)
- `workdir_snapshot` — [`agent/extensions/scoped-snapshots.ts`](../../agent/extensions/scoped-snapshots.ts) (line 12; literal)
- `workflow_probe` — [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) (line 12; catalog)

### Dynamic tool owners

- [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `artifact_check`, `data_query`, `math_check`, `value_convert` (lines 75)
- [`agent/extensions/managed-bash.ts`](../../agent/extensions/managed-bash.ts) — registration receives the SDK createBashToolDefinition() for the active cwd; known tools: `bash`, `process` (lines 579)
- [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `audio_analyze`, `audio_mix`, `image_ocr`, `media_edit`, `media_info`, `music_compose`, `scene_create`, `scene_render`, `video_compose`, `video_frames` (lines 205)
- [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts) — registration loops over definitions; literal definition names are enumerated; known tools: `ast_diff`, `context_slice`, `symbol_expand` (lines 14)
- [`agent/extensions/pi-subagents/src/extension/fanout-child.ts`](../../agent/extensions/pi-subagents/src/extension/fanout-child.ts) — registration receives the source-owned subagent definition; known tools: `subagent` (lines 192)
- [`agent/extensions/pi-subagents/src/extension/index.ts`](../../agent/extensions/pi-subagents/src/extension/index.ts) — registration receives the source-owned subagent definition; known tools: `subagent` (lines 807)
- [`agent/extensions/pi-subagents/src/extension/reasoning-aids.ts`](../../agent/extensions/pi-subagents/src/extension/reasoning-aids.ts) — registration passes names through a local factory; literal factory call sites are enumerated; known tools: `coverage_select`, `decision_frontier`, `dependency_plan` (lines 8)
- [`agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts`](../../agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts) — registration receives source-owned supervisor tool definitions; known tools: `contact_supervisor`, `subagent_supervisor` (lines 313, 642)
- [`agent/extensions/pi-subagents/src/runs/background/wait-tool.ts`](../../agent/extensions/pi-subagents/src/runs/background/wait-tool.ts) — registration receives the source-owned primaryTool definition; known tools: `bg_wait` (lines 42)
- [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) — registration uses configurable toolNames; checked-in defaults are enumerated; known tools: `fetch_content`, `get_search_content`, `source_check`, `web_search` (lines 1659, 2247, 2401, 2800)
- [`agent/extensions/rpiv-todo/todo.ts`](../../agent/extensions/rpiv-todo/todo.ts) — registration uses the source-owned TOOL_NAME constant; known tools: `todo` (lines 70)
- [`agent/extensions/utility-tools.ts`](../../agent/extensions/utility-tools.ts) — registration loops over the static TOOLS catalog; catalog names are enumerated; known tools: `archive_probe`, `contract_diff`, `coverage_probe`, `env_audit`, `net_probe`, `openapi_probe`, `package_probe`, `sqlite_probe`, `web_asset_check`, `workflow_probe` (lines 23)

### Literal slash commands

- /bash-routes — [`agent/extensions/bash-router.ts`](../../agent/extensions/bash-router.ts) (line 97)
- /bg — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 473)
- /bg-clear — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 515)
- /bg-tasks — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 507)
- /bg-update — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 523)
- /catalog-status — [`agent/extensions/live-models.ts`](../../agent/extensions/live-models.ts) (line 1613)
- /claude-cache — [`agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts`](../../agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts) (line 2161)
- /commands — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1726)
- /cost — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1328)
- /curator — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 3395)
- /effort — [`agent/extensions/thinking.ts`](../../agent/extensions/thinking.ts) (line 48)
- /errors — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1700)
- /export-json — [`agent/extensions/session-export-json.ts`](../../agent/extensions/session-export-json.ts) (line 72)
- /google-account — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 3437)
- /graph — [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts) (line 860)
- /harness-backup — [`agent/extensions/harness-backup.ts`](../../agent/extensions/harness-backup.ts) (line 37)
- /hook-audit — [`agent/extensions/lib/session-telemetry.ts`](../../agent/extensions/lib/session-telemetry.ts) (line 76)
- /jobs — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 553)
- /kill — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 600)
- /lens-allow-edit — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113705)
- /lens-context-toggle — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113409)
- /lens-drift — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113466)
- /lens-health — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113501)
- /lens-map — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113478)
- /lens-perf — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113620)
- /lens-tdi — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113434)
- /lens-toggle — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113402)
- /lens-tools — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113639)
- /lens-widget-toggle — [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) (line 113416)
- /logs — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 568)
- /memory-prime — [`agent/extensions/pi-memory/priming.ts`](../../agent/extensions/pi-memory/priming.ts) (line 184)
- /metrics — [`agent/extensions/lib/session-telemetry.ts`](../../agent/extensions/lib/session-telemetry.ts) (line 58)
- /models — [`agent/extensions/model-routing-config.ts`](../../agent/extensions/model-routing-config.ts) (line 412)
- /obs — [`agent/extensions/pi-observations.ts`](../../agent/extensions/pi-observations.ts) (line 900)
- /or-provider — [`agent/extensions/provider-cmd.ts`](../../agent/extensions/provider-cmd.ts) (line 647)
- /prompt-workflow — [`agent/extensions/pi-subagents/src/slash/prompt-workflows.ts`](../../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts) (line 254)
- /provider — [`agent/extensions/provider-cmd.ts`](../../agent/extensions/provider-cmd.ts) (line 646)
- /provider-health — [`agent/extensions/provider-gate.ts`](../../agent/extensions/provider-gate.ts) (line 467)
- /reminder — [`agent/extensions/reminders.ts`](../../agent/extensions/reminders.ts) (line 1187)
- /run — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 876)
- /search — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 3485)
- /self — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1653)
- /subagent-cost — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 916)
- /subagents — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 869)
- /subagents-check-profile — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1280)
- /subagents-detach — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 994)
- /subagents-doctor — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 923)
- /subagents-fleet — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 960)
- /subagents-generate-profiles — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1242)
- /subagents-inspect-rpc — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 930)
- /subagents-load-profile — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1155)
- /subagents-models — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1125)
- /subagents-profiles — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1143)
- /subagents-refine — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 947)
- /subagents-refresh-provider-models — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1208)
- /subagents-steer — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1054)
- /subagents-stop — [`agent/extensions/pi-subagents/src/slash/slash-commands.ts`](../../agent/extensions/pi-subagents/src/slash/slash-commands.ts) (line 1006)
- /subagents-watchdog — [`agent/extensions/pi-subagents/src/watchdog/register-main.ts`](../../agent/extensions/pi-subagents/src/watchdog/register-main.ts) (line 405)
- /sys-prompt — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1658)
- /tasks — [`agent/extensions/pi-background-tasks/src/extension.ts`](../../agent/extensions/pi-background-tasks/src/extension.ts) (line 499)
- /used — [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) (line 1677)
- /websearch — [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) (line 3134)

### Dynamic command owners

- [`agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts`](../../agent/extensions/pi-background-tasks/src/core/anthropic-attribution.ts) — registerCommand() receives a computed name (lines 364)
- [`agent/extensions/rpiv-todo/todo.ts`](../../agent/extensions/rpiv-todo/todo.ts) — registerCommand() receives a computed name (lines 118)

## MCP and wrapper service owners

This section reports source owners with explicit MCP or wrapper/adapter/client evidence. It names files and evidence only; it does not claim that a service is running or that every dynamically exposed tool is available.

- [`agent/extensions/context-profile.ts`](../../agent/extensions/context-profile.ts) — `wrapper/adapter`
- [`agent/extensions/filesystem-safety.ts`](../../agent/extensions/filesystem-safety.ts) — `wrapper/adapter`
- [`agent/extensions/http-tools.ts`](../../agent/extensions/http-tools.ts) — `wrapper/adapter`
- [`agent/extensions/lib/harness-capabilities.ts`](../../agent/extensions/lib/harness-capabilities.ts) — `MCP`
- [`agent/extensions/lib/jev-client.ts`](../../agent/extensions/lib/jev-client.ts) — `wrapper/adapter`
- [`agent/extensions/lib/project-intelligence/client.mjs`](../../agent/extensions/lib/project-intelligence/client.mjs) — `wrapper/adapter`
- [`agent/extensions/lib/tool-discovery.ts`](../../agent/extensions/lib/tool-discovery.ts) — `wrapper/adapter`
- [`agent/extensions/lib/utility-client.ts`](../../agent/extensions/lib/utility-client.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/contract.mjs`](../../agent/extensions/lib/utility-mcp/contract.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/coverage.mjs`](../../agent/extensions/lib/utility-mcp/coverage.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/env.mjs`](../../agent/extensions/lib/utility-mcp/env.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/files.mjs`](../../agent/extensions/lib/utility-mcp/files.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/local-reference.mjs`](../../agent/extensions/lib/utility-mcp/local-reference.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/net.mjs`](../../agent/extensions/lib/utility-mcp/net.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/openapi.mjs`](../../agent/extensions/lib/utility-mcp/openapi.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/package.mjs`](../../agent/extensions/lib/utility-mcp/package.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/server.mjs`](../../agent/extensions/lib/utility-mcp/server.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/shapes.mjs`](../../agent/extensions/lib/utility-mcp/shapes.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/web-assets.mjs`](../../agent/extensions/lib/utility-mcp/web-assets.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/worker.mjs`](../../agent/extensions/lib/utility-mcp/worker.mjs) — `MCP`
- [`agent/extensions/lib/utility-mcp/workflow.mjs`](../../agent/extensions/lib/utility-mcp/workflow.mjs) — `MCP`
- [`agent/extensions/micro-intelligence.ts`](../../agent/extensions/micro-intelligence.ts) — `wrapper/adapter`
- [`agent/extensions/model-routing-config.ts`](../../agent/extensions/model-routing-config.ts) — `wrapper/adapter`
- [`agent/extensions/pi-background-tasks/src/core/registry.ts`](../../agent/extensions/pi-background-tasks/src/core/registry.ts) — `wrapper/adapter`
- [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts) — `wrapper/adapter`
- [`agent/extensions/pi-lens/dist/index.js`](../../agent/extensions/pi-lens/dist/index.js) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-observations.ts`](../../agent/extensions/pi-observations.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/agents/agent-management.ts`](../../agent/extensions/pi-subagents/src/agents/agent-management.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/agent-serializer.ts`](../../agent/extensions/pi-subagents/src/agents/agent-serializer.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/agents.ts`](../../agent/extensions/pi-subagents/src/agents/agents.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/agents/runtime-agent-registry.ts`](../../agent/extensions/pi-subagents/src/agents/runtime-agent-registry.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/api/preflight.ts`](../../agent/extensions/pi-subagents/src/api/preflight.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/inspectors/herdr/client.ts`](../../agent/extensions/pi-subagents/src/inspectors/herdr/client.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/background/async-execution.ts`](../../agent/extensions/pi-subagents/src/runs/background/async-execution.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/async-resume.ts`](../../agent/extensions/pi-subagents/src/runs/background/async-resume.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/run-status.ts`](../../agent/extensions/pi-subagents/src/runs/background/run-status.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/background/subagent-runner.ts`](../../agent/extensions/pi-subagents/src/runs/background/subagent-runner.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/foreground/execution.ts`](../../agent/extensions/pi-subagents/src/runs/foreground/execution.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/acceptance.ts`](../../agent/extensions/pi-subagents/src/runs/shared/acceptance.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/claude-code-adapter.ts`](../../agent/extensions/pi-subagents/src/runs/shared/claude-code-adapter.ts) — `MCP`, `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/codex-exec-adapter.ts`](../../agent/extensions/pi-subagents/src/runs/shared/codex-exec-adapter.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/completion-guard.ts`](../../agent/extensions/pi-subagents/src/runs/shared/completion-guard.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/cursor-agent-adapter.ts`](../../agent/extensions/pi-subagents/src/runs/shared/cursor-agent-adapter.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/dynamic-fanout.ts`](../../agent/extensions/pi-subagents/src/runs/shared/dynamic-fanout.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/external-cli-contract.ts`](../../agent/extensions/pi-subagents/src/runs/shared/external-cli-contract.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/external-cli-runner.ts`](../../agent/extensions/pi-subagents/src/runs/shared/external-cli-runner.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-config-sources.ts`](../../agent/extensions/pi-subagents/src/runs/shared/mcp-config-sources.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.ts`](../../agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-grant.ts`](../../agent/extensions/pi-subagents/src/runs/shared/mcp-direct-tool-grant.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts`](../../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/model-research.ts`](../../agent/extensions/pi-subagents/src/runs/shared/model-research.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/runs/shared/parallel-utils.ts`](../../agent/extensions/pi-subagents/src/runs/shared/parallel-utils.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/pi-args.ts`](../../agent/extensions/pi-subagents/src/runs/shared/pi-args.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/single-output.ts`](../../agent/extensions/pi-subagents/src/runs/shared/single-output.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/skill-routing.ts`](../../agent/extensions/pi-subagents/src/runs/shared/skill-routing.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/runs/shared/tool-availability.ts`](../../agent/extensions/pi-subagents/src/runs/shared/tool-availability.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/shared/launch-contract.ts`](../../agent/extensions/pi-subagents/src/shared/launch-contract.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/shared/types.ts`](../../agent/extensions/pi-subagents/src/shared/types.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/slash/delegation-adapters.ts`](../../agent/extensions/pi-subagents/src/slash/delegation-adapters.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/slash/subagents-admin.ts`](../../agent/extensions/pi-subagents/src/slash/subagents-admin.ts) — `MCP`
- [`agent/extensions/pi-subagents/src/watchdog/lsp-diagnostics.ts`](../../agent/extensions/pi-subagents/src/watchdog/lsp-diagnostics.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts`](../../agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts) — `wrapper/adapter`
- [`agent/extensions/pi-subagents/src/workflows/workflow-receipt.ts`](../../agent/extensions/pi-subagents/src/workflows/workflow-receipt.ts) — `MCP`
- [`agent/extensions/pi-web-access/index.ts`](../../agent/extensions/pi-web-access/index.ts) — `wrapper/adapter`
- [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts) — `wrapper/adapter`
- [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts) — `wrapper/adapter`
- [`agent/extensions/sys-probe.ts`](../../agent/extensions/sys-probe.ts) — `wrapper/adapter`
- [`agent/extensions/utility-tools.ts`](../../agent/extensions/utility-tools.ts) — `MCP`, `wrapper/adapter`

## Extension source inventory

The manifest is the source of truth for the shipped extension, library, fork, support-file, dependency, and folded-marker lists.

### Extensions

- [`agent/extensions/agent-context-tools.ts`](../../agent/extensions/agent-context-tools.ts)
- [`agent/extensions/agentmail.ts`](../../agent/extensions/agentmail.ts)
- [`agent/extensions/bash-router.ts`](../../agent/extensions/bash-router.ts)
- [`agent/extensions/bulk-edit.ts`](../../agent/extensions/bulk-edit.ts)
- [`agent/extensions/checkpoints.ts`](../../agent/extensions/checkpoints.ts)
- [`agent/extensions/context-profile.ts`](../../agent/extensions/context-profile.ts)
- [`agent/extensions/continuation-notice.ts`](../../agent/extensions/continuation-notice.ts)
- [`agent/extensions/filesystem-safety.ts`](../../agent/extensions/filesystem-safety.ts)
- [`agent/extensions/git-tools.ts`](../../agent/extensions/git-tools.ts)
- [`agent/extensions/harness-backup.ts`](../../agent/extensions/harness-backup.ts)
- [`agent/extensions/health-log.ts`](../../agent/extensions/health-log.ts)
- [`agent/extensions/http-tools.ts`](../../agent/extensions/http-tools.ts)
- [`agent/extensions/last-model.ts`](../../agent/extensions/last-model.ts)
- [`agent/extensions/live-models.ts`](../../agent/extensions/live-models.ts)
- [`agent/extensions/managed-bash.ts`](../../agent/extensions/managed-bash.ts)
- [`agent/extensions/media-tools.ts`](../../agent/extensions/media-tools.ts)
- [`agent/extensions/micro-intelligence.ts`](../../agent/extensions/micro-intelligence.ts)
- [`agent/extensions/model-config.ts`](../../agent/extensions/model-config.ts)
- [`agent/extensions/model-routing-config.ts`](../../agent/extensions/model-routing-config.ts)
- [`agent/extensions/pi-observations.ts`](../../agent/extensions/pi-observations.ts)
- [`agent/extensions/project-intelligence.ts`](../../agent/extensions/project-intelligence.ts)
- [`agent/extensions/provider-cmd.ts`](../../agent/extensions/provider-cmd.ts)
- [`agent/extensions/provider-gate.ts`](../../agent/extensions/provider-gate.ts)
- [`agent/extensions/reasoning-aids.ts`](../../agent/extensions/reasoning-aids.ts)
- [`agent/extensions/reminders.ts`](../../agent/extensions/reminders.ts)
- [`agent/extensions/render-and-wait.ts`](../../agent/extensions/render-and-wait.ts)
- [`agent/extensions/research-toolkit.ts`](../../agent/extensions/research-toolkit.ts)
- [`agent/extensions/sandbox.ts`](../../agent/extensions/sandbox.ts)
- [`agent/extensions/scoped-snapshots.ts`](../../agent/extensions/scoped-snapshots.ts)
- [`agent/extensions/session-export-json.ts`](../../agent/extensions/session-export-json.ts)
- [`agent/extensions/session-hooks.ts`](../../agent/extensions/session-hooks.ts)
- [`agent/extensions/session-signals.ts`](../../agent/extensions/session-signals.ts)
- [`agent/extensions/siblings.ts`](../../agent/extensions/siblings.ts)
- [`agent/extensions/sys-probe.ts`](../../agent/extensions/sys-probe.ts)
- [`agent/extensions/thinking.ts`](../../agent/extensions/thinking.ts)
- [`agent/extensions/timeout-guard.ts`](../../agent/extensions/timeout-guard.ts)
- [`agent/extensions/utility-tools.ts`](../../agent/extensions/utility-tools.ts)

### Libraries

- [`agent/extensions/lib/activity-indicators.ts`](../../agent/extensions/lib/activity-indicators.ts)
- [`agent/extensions/lib/artifact-checks.ts`](../../agent/extensions/lib/artifact-checks.ts)
- [`agent/extensions/lib/authored-review.ts`](../../agent/extensions/lib/authored-review.ts)
- [`agent/extensions/lib/bash-routing.ts`](../../agent/extensions/lib/bash-routing.ts)
- [`agent/extensions/lib/browser-session.ts`](../../agent/extensions/lib/browser-session.ts)
- [`agent/extensions/lib/bulk-edit.ts`](../../agent/extensions/lib/bulk-edit.ts)
- [`agent/extensions/lib/capability-audit.ts`](../../agent/extensions/lib/capability-audit.ts)
- [`agent/extensions/lib/capability-groups.ts`](../../agent/extensions/lib/capability-groups.ts)
- [`agent/extensions/lib/capability-health.ts`](../../agent/extensions/lib/capability-health.ts)
- [`agent/extensions/lib/catalog-cache-lock.ts`](../../agent/extensions/lib/catalog-cache-lock.ts)
- [`agent/extensions/lib/checkpoint-files.ts`](../../agent/extensions/lib/checkpoint-files.ts)
- [`agent/extensions/lib/code-guidance-signals.ts`](../../agent/extensions/lib/code-guidance-signals.ts)
- [`agent/extensions/lib/code-lexical-mask.ts`](../../agent/extensions/lib/code-lexical-mask.ts)
- [`agent/extensions/lib/compact-tool-json.ts`](../../agent/extensions/lib/compact-tool-json.ts)
- [`agent/extensions/lib/compaction-policy.ts`](../../agent/extensions/lib/compaction-policy.ts)
- [`agent/extensions/lib/context-anchor.ts`](../../agent/extensions/lib/context-anchor.ts)
- [`agent/extensions/lib/context-limits.ts`](../../agent/extensions/lib/context-limits.ts)
- [`agent/extensions/lib/context-profile.mjs`](../../agent/extensions/lib/context-profile.mjs)
- [`agent/extensions/lib/context-provenance.ts`](../../agent/extensions/lib/context-provenance.ts)
- [`agent/extensions/lib/continuation-notice.ts`](../../agent/extensions/lib/continuation-notice.ts)
- [`agent/extensions/lib/cost-evidence.ts`](../../agent/extensions/lib/cost-evidence.ts)
- [`agent/extensions/lib/cost-states.ts`](../../agent/extensions/lib/cost-states.ts)
- [`agent/extensions/lib/data-query.ts`](../../agent/extensions/lib/data-query.ts)
- [`agent/extensions/lib/diagnostic-provenance.ts`](../../agent/extensions/lib/diagnostic-provenance.ts)
- [`agent/extensions/lib/effort-policy.mjs`](../../agent/extensions/lib/effort-policy.mjs)
- [`agent/extensions/lib/execution-evidence.ts`](../../agent/extensions/lib/execution-evidence.ts)
- [`agent/extensions/lib/fail-policy.ts`](../../agent/extensions/lib/fail-policy.ts)
- [`agent/extensions/lib/git-authority.ts`](../../agent/extensions/lib/git-authority.ts)
- [`agent/extensions/lib/guidance-topics-domains.ts`](../../agent/extensions/lib/guidance-topics-domains.ts)
- [`agent/extensions/lib/guidance-topics-systems.ts`](../../agent/extensions/lib/guidance-topics-systems.ts)
- [`agent/extensions/lib/guidance-topics.ts`](../../agent/extensions/lib/guidance-topics.ts)
- [`agent/extensions/lib/harness-activity.ts`](../../agent/extensions/lib/harness-activity.ts)
- [`agent/extensions/lib/harness-capabilities.ts`](../../agent/extensions/lib/harness-capabilities.ts)
- [`agent/extensions/lib/harness-invariants.ts`](../../agent/extensions/lib/harness-invariants.ts)
- [`agent/extensions/lib/harness-orientation.ts`](../../agent/extensions/lib/harness-orientation.ts)
- [`agent/extensions/lib/health-log.ts`](../../agent/extensions/lib/health-log.ts)
- [`agent/extensions/lib/hook-events.ts`](../../agent/extensions/lib/hook-events.ts)
- [`agent/extensions/lib/hook-ledger.ts`](../../agent/extensions/lib/hook-ledger.ts)
- [`agent/extensions/lib/host-operation-safety.ts`](../../agent/extensions/lib/host-operation-safety.ts)
- [`agent/extensions/lib/image-compaction.ts`](../../agent/extensions/lib/image-compaction.ts)
- [`agent/extensions/lib/intent-context.ts`](../../agent/extensions/lib/intent-context.ts)
- [`agent/extensions/lib/intervention-control.ts`](../../agent/extensions/lib/intervention-control.ts)
- [`agent/extensions/lib/intervention-intents.ts`](../../agent/extensions/lib/intervention-intents.ts)
- [`agent/extensions/lib/intervention-registry.ts`](../../agent/extensions/lib/intervention-registry.ts)
- [`agent/extensions/lib/intervention-session.ts`](../../agent/extensions/lib/intervention-session.ts)
- [`agent/extensions/lib/intervention-shared.ts`](../../agent/extensions/lib/intervention-shared.ts)
- [`agent/extensions/lib/jev-client.ts`](../../agent/extensions/lib/jev-client.ts)
- [`agent/extensions/lib/local-intelligence.mjs`](../../agent/extensions/lib/local-intelligence.mjs)
- [`agent/extensions/lib/local-models.ts`](../../agent/extensions/lib/local-models.ts)
- [`agent/extensions/lib/media-process.ts`](../../agent/extensions/lib/media-process.ts)
- [`agent/extensions/lib/media-timeline.ts`](../../agent/extensions/lib/media-timeline.ts)
- [`agent/extensions/lib/metrics-panel.ts`](../../agent/extensions/lib/metrics-panel.ts)
- [`agent/extensions/lib/mini-preprocessor.ts`](../../agent/extensions/lib/mini-preprocessor.ts)
- [`agent/extensions/lib/model-facts.ts`](../../agent/extensions/lib/model-facts.ts)
- [`agent/extensions/lib/model-routing-metrics.ts`](../../agent/extensions/lib/model-routing-metrics.ts)
- [`agent/extensions/lib/model-routing-store.ts`](../../agent/extensions/lib/model-routing-store.ts)
- [`agent/extensions/lib/music-score.ts`](../../agent/extensions/lib/music-score.ts)
- [`agent/extensions/lib/needle-assets.mjs`](../../agent/extensions/lib/needle-assets.mjs)
- [`agent/extensions/lib/needle-policy.ts`](../../agent/extensions/lib/needle-policy.ts)
- [`agent/extensions/lib/needle-runtime.ts`](../../agent/extensions/lib/needle-runtime.ts)
- [`agent/extensions/lib/needle-types.ts`](../../agent/extensions/lib/needle-types.ts)
- [`agent/extensions/lib/needle-worker.mjs`](../../agent/extensions/lib/needle-worker.mjs)
- [`agent/extensions/lib/numeric-checks.ts`](../../agent/extensions/lib/numeric-checks.ts)
- [`agent/extensions/lib/output-distiller.ts`](../../agent/extensions/lib/output-distiller.ts)
- [`agent/extensions/lib/project-tests.ts`](../../agent/extensions/lib/project-tests.ts)
- [`agent/extensions/lib/prompt-analysis-runtime.ts`](../../agent/extensions/lib/prompt-analysis-runtime.ts)
- [`agent/extensions/lib/prompt-interpretation.ts`](../../agent/extensions/lib/prompt-interpretation.ts)
- [`agent/extensions/lib/quality-review-owner.ts`](../../agent/extensions/lib/quality-review-owner.ts)
- [`agent/extensions/lib/quality-review-signals.ts`](../../agent/extensions/lib/quality-review-signals.ts)
- [`agent/extensions/lib/quality-review.ts`](../../agent/extensions/lib/quality-review.ts)
- [`agent/extensions/lib/reasoning-aids.ts`](../../agent/extensions/lib/reasoning-aids.ts)
- [`agent/extensions/lib/relevant-guidance.ts`](../../agent/extensions/lib/relevant-guidance.ts)
- [`agent/extensions/lib/reminders-state.ts`](../../agent/extensions/lib/reminders-state.ts)
- [`agent/extensions/lib/render-queue.ts`](../../agent/extensions/lib/render-queue.ts)
- [`agent/extensions/lib/request-compat.ts`](../../agent/extensions/lib/request-compat.ts)
- [`agent/extensions/lib/retry-policy.ts`](../../agent/extensions/lib/retry-policy.ts)
- [`agent/extensions/lib/review-coordinator.ts`](../../agent/extensions/lib/review-coordinator.ts)
- [`agent/extensions/lib/scene-studio.ts`](../../agent/extensions/lib/scene-studio.ts)
- [`agent/extensions/lib/scope-deliberation.ts`](../../agent/extensions/lib/scope-deliberation.ts)
- [`agent/extensions/lib/scoped-snapshots.ts`](../../agent/extensions/lib/scoped-snapshots.ts)
- [`agent/extensions/lib/self-mutation-guard.ts`](../../agent/extensions/lib/self-mutation-guard.ts)
- [`agent/extensions/lib/service-probe.ts`](../../agent/extensions/lib/service-probe.ts)
- [`agent/extensions/lib/session-audit.ts`](../../agent/extensions/lib/session-audit.ts)
- [`agent/extensions/lib/session-cost.ts`](../../agent/extensions/lib/session-cost.ts)
- [`agent/extensions/lib/session-diagnostics.ts`](../../agent/extensions/lib/session-diagnostics.ts)
- [`agent/extensions/lib/session-errors.ts`](../../agent/extensions/lib/session-errors.ts)
- [`agent/extensions/lib/session-export-json.ts`](../../agent/extensions/lib/session-export-json.ts)
- [`agent/extensions/lib/session-hooks.ts`](../../agent/extensions/lib/session-hooks.ts)
- [`agent/extensions/lib/session-metrics.ts`](../../agent/extensions/lib/session-metrics.ts)
- [`agent/extensions/lib/session-observability.ts`](../../agent/extensions/lib/session-observability.ts)
- [`agent/extensions/lib/session-report.ts`](../../agent/extensions/lib/session-report.ts)
- [`agent/extensions/lib/session-signals.ts`](../../agent/extensions/lib/session-signals.ts)
- [`agent/extensions/lib/session-stop.ts`](../../agent/extensions/lib/session-stop.ts)
- [`agent/extensions/lib/session-telemetry.ts`](../../agent/extensions/lib/session-telemetry.ts)
- [`agent/extensions/lib/skill-discovery-controller.ts`](../../agent/extensions/lib/skill-discovery-controller.ts)
- [`agent/extensions/lib/skill-discovery.ts`](../../agent/extensions/lib/skill-discovery.ts)
- [`agent/extensions/lib/skill-relevance.ts`](../../agent/extensions/lib/skill-relevance.ts)
- [`agent/extensions/lib/skill-routing.ts`](../../agent/extensions/lib/skill-routing.ts)
- [`agent/extensions/lib/skill-telemetry.ts`](../../agent/extensions/lib/skill-telemetry.ts)
- [`agent/extensions/lib/slop-guidance-signals.ts`](../../agent/extensions/lib/slop-guidance-signals.ts)
- [`agent/extensions/lib/small-tools.ts`](../../agent/extensions/lib/small-tools.ts)
- [`agent/extensions/lib/smol-extraction.ts`](../../agent/extensions/lib/smol-extraction.ts)
- [`agent/extensions/lib/smol-preprocessor.ts`](../../agent/extensions/lib/smol-preprocessor.ts)
- [`agent/extensions/lib/source-check.ts`](../../agent/extensions/lib/source-check.ts)
- [`agent/extensions/lib/stable-tool-order.ts`](../../agent/extensions/lib/stable-tool-order.ts)
- [`agent/extensions/lib/stall-core.ts`](../../agent/extensions/lib/stall-core.ts)
- [`agent/extensions/lib/svg-check.ts`](../../agent/extensions/lib/svg-check.ts)
- [`agent/extensions/lib/sys-probe.ts`](../../agent/extensions/lib/sys-probe.ts)
- [`agent/extensions/lib/todo-linkage.ts`](../../agent/extensions/lib/todo-linkage.ts)
- [`agent/extensions/lib/token-budget.ts`](../../agent/extensions/lib/token-budget.ts)
- [`agent/extensions/lib/tool-discovery.ts`](../../agent/extensions/lib/tool-discovery.ts)
- [`agent/extensions/lib/utility-client.ts`](../../agent/extensions/lib/utility-client.ts)
- [`agent/extensions/lib/workspace-write-lease.ts`](../../agent/extensions/lib/workspace-write-lease.ts)

### Local forks

- [`agent/extensions/pi-background-tasks`](../../agent/extensions/pi-background-tasks) — package `pi-background-tasks`
- [`agent/extensions/pi-lens`](../../agent/extensions/pi-lens) — package `pi-lens`
- [`agent/extensions/pi-memory`](../../agent/extensions/pi-memory) — package `pi-memory`
- [`agent/extensions/pi-subagents`](../../agent/extensions/pi-subagents) — package `pi-subagents`
- [`agent/extensions/pi-web-access`](../../agent/extensions/pi-web-access) — package `pi-web-access`
- [`agent/extensions/rpiv-todo`](../../agent/extensions/rpiv-todo) — package `@juicesharp/rpiv-todo`

### Manifest support files

- [`agent/extensions/lib/micro-intelligence/advisory.ts`](../../agent/extensions/lib/micro-intelligence/advisory.ts)
- [`agent/extensions/lib/micro-intelligence/evidence.ts`](../../agent/extensions/lib/micro-intelligence/evidence.ts)
- [`agent/extensions/lib/micro-intelligence/health.ts`](../../agent/extensions/lib/micro-intelligence/health.ts)
- [`agent/extensions/lib/micro-intelligence/intent.ts`](../../agent/extensions/lib/micro-intelligence/intent.ts)
- [`agent/extensions/lib/micro-intelligence/metrics.ts`](../../agent/extensions/lib/micro-intelligence/metrics.ts)
- [`agent/extensions/lib/micro-intelligence/retrieval.ts`](../../agent/extensions/lib/micro-intelligence/retrieval.ts)
- [`agent/extensions/lib/micro-intelligence/review.ts`](../../agent/extensions/lib/micro-intelligence/review.ts)
- [`agent/extensions/lib/micro-intelligence/status.ts`](../../agent/extensions/lib/micro-intelligence/status.ts)
- [`agent/extensions/lib/project-intelligence/client.mjs`](../../agent/extensions/lib/project-intelligence/client.mjs)
- [`agent/extensions/lib/project-intelligence/continuity.mjs`](../../agent/extensions/lib/project-intelligence/continuity.mjs)
- [`agent/extensions/lib/project-intelligence/discovery-parsers.mjs`](../../agent/extensions/lib/project-intelligence/discovery-parsers.mjs)
- [`agent/extensions/lib/project-intelligence/discovery.mjs`](../../agent/extensions/lib/project-intelligence/discovery.mjs)
- [`agent/extensions/lib/project-intelligence/heartbeat.mjs`](../../agent/extensions/lib/project-intelligence/heartbeat.mjs)
- [`agent/extensions/lib/project-intelligence/identity.mjs`](../../agent/extensions/lib/project-intelligence/identity.mjs)
- [`agent/extensions/lib/project-intelligence/privacy.mjs`](../../agent/extensions/lib/project-intelligence/privacy.mjs)
- [`agent/extensions/lib/project-intelligence/query.mjs`](../../agent/extensions/lib/project-intelligence/query.mjs)
- [`agent/extensions/lib/project-intelligence/store.mjs`](../../agent/extensions/lib/project-intelligence/store.mjs)
- [`agent/extensions/lib/project-intelligence/viewer-assets/app.js`](../../agent/extensions/lib/project-intelligence/viewer-assets/app.js)
- [`agent/extensions/lib/project-intelligence/viewer-assets/cytoscape.min.js`](../../agent/extensions/lib/project-intelligence/viewer-assets/cytoscape.min.js)
- [`agent/extensions/lib/project-intelligence/viewer-server.mjs`](../../agent/extensions/lib/project-intelligence/viewer-server.mjs)
- [`agent/extensions/lib/project-intelligence/viewer.mjs`](../../agent/extensions/lib/project-intelligence/viewer.mjs)
- [`agent/extensions/lib/project-intelligence/worker.mjs`](../../agent/extensions/lib/project-intelligence/worker.mjs)
- [`agent/extensions/lib/utility-mcp/catalog.mjs`](../../agent/extensions/lib/utility-mcp/catalog.mjs)
- [`agent/extensions/lib/utility-mcp/contract.mjs`](../../agent/extensions/lib/utility-mcp/contract.mjs)
- [`agent/extensions/lib/utility-mcp/coverage.mjs`](../../agent/extensions/lib/utility-mcp/coverage.mjs)
- [`agent/extensions/lib/utility-mcp/env.mjs`](../../agent/extensions/lib/utility-mcp/env.mjs)
- [`agent/extensions/lib/utility-mcp/files.mjs`](../../agent/extensions/lib/utility-mcp/files.mjs)
- [`agent/extensions/lib/utility-mcp/local-reference.mjs`](../../agent/extensions/lib/utility-mcp/local-reference.mjs)
- [`agent/extensions/lib/utility-mcp/net.mjs`](../../agent/extensions/lib/utility-mcp/net.mjs)
- [`agent/extensions/lib/utility-mcp/openapi.mjs`](../../agent/extensions/lib/utility-mcp/openapi.mjs)
- [`agent/extensions/lib/utility-mcp/package.mjs`](../../agent/extensions/lib/utility-mcp/package.mjs)
- [`agent/extensions/lib/utility-mcp/probe.py`](../../agent/extensions/lib/utility-mcp/probe.py)
- [`agent/extensions/lib/utility-mcp/server.mjs`](../../agent/extensions/lib/utility-mcp/server.mjs)
- [`agent/extensions/lib/utility-mcp/shapes.mjs`](../../agent/extensions/lib/utility-mcp/shapes.mjs)
- [`agent/extensions/lib/utility-mcp/web-assets.mjs`](../../agent/extensions/lib/utility-mcp/web-assets.mjs)
- [`agent/extensions/lib/utility-mcp/worker.mjs`](../../agent/extensions/lib/utility-mcp/worker.mjs)
- [`agent/extensions/lib/utility-mcp/workflow.mjs`](../../agent/extensions/lib/utility-mcp/workflow.mjs)
- [`agent/extensions/pi-background-tasks/src/core/completion-wake.ts`](../../agent/extensions/pi-background-tasks/src/core/completion-wake.ts)
- [`agent/extensions/pi-lens/context-code.mjs`](../../agent/extensions/pi-lens/context-code.mjs)
- [`agent/extensions/pi-lens/context-lsp.mjs`](../../agent/extensions/pi-lens/context-lsp.mjs)
- [`agent/extensions/pi-lens/context-tools.ts`](../../agent/extensions/pi-lens/context-tools.ts)
- [`agent/extensions/pi-lens/semantic-radar/fuzzy-identifiers.mjs`](../../agent/extensions/pi-lens/semantic-radar/fuzzy-identifiers.mjs)
- [`agent/extensions/pi-lens/semantic-radar/neural-ranker.mjs`](../../agent/extensions/pi-lens/semantic-radar/neural-ranker.mjs)
- [`agent/extensions/pi-lens/semantic-radar/rank-features.mjs`](../../agent/extensions/pi-lens/semantic-radar/rank-features.mjs)
- [`agent/extensions/pi-lens/semantic-radar/reuse-ranker-model.json`](../../agent/extensions/pi-lens/semantic-radar/reuse-ranker-model.json)
- [`agent/extensions/pi-memory/context-evidence.ts`](../../agent/extensions/pi-memory/context-evidence.ts)
- [`agent/extensions/pi-memory/context-salience.ts`](../../agent/extensions/pi-memory/context-salience.ts)
- [`agent/extensions/pi-memory/context-tools.ts`](../../agent/extensions/pi-memory/context-tools.ts)
- [`agent/extensions/pi-memory/mutation.ts`](../../agent/extensions/pi-memory/mutation.ts)
- [`agent/extensions/pi-memory/priming.ts`](../../agent/extensions/pi-memory/priming.ts)
- [`agent/extensions/pi-memory/project-identity.ts`](../../agent/extensions/pi-memory/project-identity.ts)
- [`agent/extensions/pi-subagents/src/runs/shared/common-task.ts`](../../agent/extensions/pi-subagents/src/runs/shared/common-task.ts)
- [`agent/extensions/pi-subagents/src/runs/shared/file-verification.ts`](../../agent/extensions/pi-subagents/src/runs/shared/file-verification.ts)
- [`agent/extensions/pi-subagents/src/shared/progress-evidence.ts`](../../agent/extensions/pi-subagents/src/shared/progress-evidence.ts)
- [`agent/extensions/rpiv-todo/state/plan.ts`](../../agent/extensions/rpiv-todo/state/plan.ts)
- [`agent/scripts/auto-update.sh`](../../agent/scripts/auto-update.sh)
- [`agent/scripts/browser-diagnostics.mjs`](../../agent/scripts/browser-diagnostics.mjs)
- [`agent/scripts/browser-markers.mjs`](../../agent/scripts/browser-markers.mjs)
- [`agent/scripts/browser-page-tools.mjs`](../../agent/scripts/browser-page-tools.mjs)
- [`agent/scripts/browser-session-lease.mjs`](../../agent/scripts/browser-session-lease.mjs)
- [`agent/scripts/browser-session-runner.mjs`](../../agent/scripts/browser-session-runner.mjs)
- [`agent/scripts/compatibility/atomic-edit-preflight-test.mjs`](../../agent/scripts/compatibility/atomic-edit-preflight-test.mjs)
- [`agent/scripts/compatibility/automatic-compaction-test.mjs`](../../agent/scripts/compatibility/automatic-compaction-test.mjs)
- [`agent/scripts/compatibility/autonomous-recovery-test.mjs`](../../agent/scripts/compatibility/autonomous-recovery-test.mjs)
- [`agent/scripts/compatibility/harness-load-test.mjs`](../../agent/scripts/compatibility/harness-load-test.mjs)
- [`agent/scripts/compatibility/hook-lifecycle-integrity-test.mjs`](../../agent/scripts/compatibility/hook-lifecycle-integrity-test.mjs)
- [`agent/scripts/compatibility/reasoning-aids-loader-test.mjs`](../../agent/scripts/compatibility/reasoning-aids-loader-test.mjs)
- [`agent/scripts/compatibility/retry-lifecycle-test.mjs`](../../agent/scripts/compatibility/retry-lifecycle-test.mjs)
- [`agent/scripts/compatibility/session-recovery-guidance-test.mjs`](../../agent/scripts/compatibility/session-recovery-guidance-test.mjs)
- [`agent/scripts/compatibility/skill-pack-routing-test.mjs`](../../agent/scripts/compatibility/skill-pack-routing-test.mjs)
- [`agent/scripts/compatibility/summary-recovery-test.mjs`](../../agent/scripts/compatibility/summary-recovery-test.mjs)
- [`agent/scripts/compatibility/tool-integrity-test.mjs`](../../agent/scripts/compatibility/tool-integrity-test.mjs)
- [`agent/scripts/compatibility/utility-mcp-loader-test.mjs`](../../agent/scripts/compatibility/utility-mcp-loader-test.mjs)
- [`agent/scripts/core-update.mjs`](../../agent/scripts/core-update.mjs)
- [`agent/scripts/effort-audit.mjs`](../../agent/scripts/effort-audit.mjs)
- [`agent/scripts/harness-readonly-exec.py`](../../agent/scripts/harness-readonly-exec.py)
- [`agent/scripts/lib/core-compatibility.mjs`](../../agent/scripts/lib/core-compatibility.mjs)
- [`agent/scripts/lib/effort-audit.mjs`](../../agent/scripts/lib/effort-audit.mjs)
- [`agent/scripts/lib/owned-core.mjs`](../../agent/scripts/lib/owned-core.mjs)
- [`agent/scripts/lib/paragraph_selector.py`](../../agent/scripts/lib/paragraph_selector.py)
- [`agent/scripts/mini-preprocessor.py`](../../agent/scripts/mini-preprocessor.py)
- [`agent/scripts/pi-launch.sh`](../../agent/scripts/pi-launch.sh)
- [`agent/scripts/render-capture.mjs`](../../agent/scripts/render-capture.mjs)
- [`agent/scripts/render-design-state.mjs`](../../agent/scripts/render-design-state.mjs)
- [`agent/scripts/render-page-state.mjs`](../../agent/scripts/render-page-state.mjs)
- [`agent/scripts/repair-harness-hardlinks.py`](../../agent/scripts/repair-harness-hardlinks.py)
- [`agent/scripts/sandbox-runner.py`](../../agent/scripts/sandbox-runner.py)
- [`agent/scripts/scene-model.mjs`](../../agent/scripts/scene-model.mjs)
- [`agent/scripts/scene-runtime.mjs`](../../agent/scripts/scene-runtime.mjs)
- [`agent/scripts/systemd/pi-mini-preprocessor.service`](../../agent/scripts/systemd/pi-mini-preprocessor.service)
- [`agent/scripts/systemd/pi-smol-preprocessor.service`](../../agent/scripts/systemd/pi-smol-preprocessor.service)
- [`agent/scripts/transaction.mjs`](../../agent/scripts/transaction.mjs)
- [`agent/scripts/wait-condition.mjs`](../../agent/scripts/wait-condition.mjs)
- [`agent/scripts/workspace-facts.mjs`](../../agent/scripts/workspace-facts.mjs)

### Folded markers

- `extensions/pi-lens/dist/index.js` — pi-lens exact-repeat mark dedup (bundle; per-module copies deleted in fork trim) (marker `PI_LENS_MARK_DEDUP`)
- `extensions/pi-memory/index.ts` — pi-memory project scope (marker `PROJECT_SCOPE`)
- `extensions/pi-subagents/src/runs/background/subagent-runner.ts` — subagent background runner inference gate (marker `PI_SUBAGENT_PRESSURE`)
- `extensions/pi-subagents/src/runs/foreground/execution.ts` — subagent foreground inference gate (marker `PI_SUBAGENT_PRESSURE`)

### Vendored runtime dependencies

- `@ast-grep/cli`
- `@ast-grep/napi`
- `@mozilla/readability`
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

The exporter includes 157 public skill directories. This list is a path inventory; skill contents remain in their linked `SKILL.md` files.

- `accessible-interaction-design` — [`agent/skills/accessible-interaction-design/SKILL.md`](../../agent/skills/accessible-interaction-design/SKILL.md)
- `ai-engineering` — [`agent/skills/ai-engineering/SKILL.md`](../../agent/skills/ai-engineering/SKILL.md)
- `algorithm-design` — [`agent/skills/algorithm-design/SKILL.md`](../../agent/skills/algorithm-design/SKILL.md)
- `animation-libraries` — [`agent/skills/animation-libraries/SKILL.md`](../../agent/skills/animation-libraries/SKILL.md)
- `anti-ai-slop` — [`agent/skills/anti-ai-slop/SKILL.md`](../../agent/skills/anti-ai-slop/SKILL.md)
- `api-design` — [`agent/skills/api-design/SKILL.md`](../../agent/skills/api-design/SKILL.md)
- `audio-processing` — [`agent/skills/audio-processing/SKILL.md`](../../agent/skills/audio-processing/SKILL.md)
- `behavioral-contracts` — [`agent/skills/behavioral-contracts/SKILL.md`](../../agent/skills/behavioral-contracts/SKILL.md)
- `blender-production` — [`agent/skills/blender-production/SKILL.md`](../../agent/skills/blender-production/SKILL.md)
- `browser-animation-engineering` — [`agent/skills/browser-animation-engineering/SKILL.md`](../../agent/skills/browser-animation-engineering/SKILL.md)
- `browser-automation` — [`agent/skills/browser-automation/SKILL.md`](../../agent/skills/browser-automation/SKILL.md)
- `browser-javascript-engineering` — [`agent/skills/browser-javascript-engineering/SKILL.md`](../../agent/skills/browser-javascript-engineering/SKILL.md)
- `browser-ml` — [`agent/skills/browser-ml/SKILL.md`](../../agent/skills/browser-ml/SKILL.md)
- `browser-task-recovery` — [`agent/skills/browser-task-recovery/SKILL.md`](../../agent/skills/browser-task-recovery/SKILL.md)
- `c-cpp-multiplatform` — [`agent/skills/c-cpp-multiplatform/SKILL.md`](../../agent/skills/c-cpp-multiplatform/SKILL.md)
- `c-systems-engineering` — [`agent/skills/c-systems-engineering/SKILL.md`](../../agent/skills/c-systems-engineering/SKILL.md)
- `cad-engineering` — [`agent/skills/cad-engineering/SKILL.md`](../../agent/skills/cad-engineering/SKILL.md)
- `cinematic-pixel-scene` — [`agent/skills/cinematic-pixel-scene/SKILL.md`](../../agent/skills/cinematic-pixel-scene/SKILL.md)
- `classical-ml-modeling` — [`agent/skills/classical-ml-modeling/SKILL.md`](../../agent/skills/classical-ml-modeling/SKILL.md)
- `cloudflare-platform-engineering` — [`agent/skills/cloudflare-platform-engineering/SKILL.md`](../../agent/skills/cloudflare-platform-engineering/SKILL.md)
- `coding-practices` — [`agent/skills/coding-practices/SKILL.md`](../../agent/skills/coding-practices/SKILL.md)
- `color-theory` — [`agent/skills/color-theory/SKILL.md`](../../agent/skills/color-theory/SKILL.md)
- `colors` — [`agent/skills/colors/SKILL.md`](../../agent/skills/colors/SKILL.md)
- `community-promotion` — [`agent/skills/community-promotion/SKILL.md`](../../agent/skills/community-promotion/SKILL.md)
- `compiler-construction` — [`agent/skills/compiler-construction/SKILL.md`](../../agent/skills/compiler-construction/SKILL.md)
- `component-libraries` — [`agent/skills/component-libraries/SKILL.md`](../../agent/skills/component-libraries/SKILL.md)
- `concurrency-memory-models` — [`agent/skills/concurrency-memory-models/SKILL.md`](../../agent/skills/concurrency-memory-models/SKILL.md)
- `copywriting` — [`agent/skills/copywriting/SKILL.md`](../../agent/skills/copywriting/SKILL.md)
- `cpp-performance-engineering` — [`agent/skills/cpp-performance-engineering/SKILL.md`](../../agent/skills/cpp-performance-engineering/SKILL.md)
- `css-battle` — [`agent/skills/css-battle/SKILL.md`](../../agent/skills/css-battle/SKILL.md)
- `custom-svg` — [`agent/skills/custom-svg/SKILL.md`](../../agent/skills/custom-svg/SKILL.md)
- `data-lineage-validation` — [`agent/skills/data-lineage-validation/SKILL.md`](../../agent/skills/data-lineage-validation/SKILL.md)
- `data-viz` — [`agent/skills/data-viz/SKILL.md`](../../agent/skills/data-viz/SKILL.md)
- `databases` — [`agent/skills/databases/SKILL.md`](../../agent/skills/databases/SKILL.md)
- `debugging` — [`agent/skills/debugging/SKILL.md`](../../agent/skills/debugging/SKILL.md)
- `design-systems` — [`agent/skills/design-systems/SKILL.md`](../../agent/skills/design-systems/SKILL.md)
- `desktop-app-dev` — [`agent/skills/desktop-app-dev/SKILL.md`](../../agent/skills/desktop-app-dev/SKILL.md)
- `desktop-ui` — [`agent/skills/desktop-ui/SKILL.md`](../../agent/skills/desktop-ui/SKILL.md)
- `distributed-systems` — [`agent/skills/distributed-systems/SKILL.md`](../../agent/skills/distributed-systems/SKILL.md)
- `dotnet-linux-engineering` — [`agent/skills/dotnet-linux-engineering/SKILL.md`](../../agent/skills/dotnet-linux-engineering/SKILL.md)
- `edge-model-deployment` — [`agent/skills/edge-model-deployment/SKILL.md`](../../agent/skills/edge-model-deployment/SKILL.md)
- `email` — [`agent/skills/email/SKILL.md`](../../agent/skills/email/SKILL.md)
- `embedded-device-engineering` — [`agent/skills/embedded-device-engineering/SKILL.md`](../../agent/skills/embedded-device-engineering/SKILL.md)
- `evidence-first-engineering` — [`agent/skills/evidence-first-engineering/SKILL.md`](../../agent/skills/evidence-first-engineering/SKILL.md)
- `financial-statement-analysis` — [`agent/skills/financial-statement-analysis/SKILL.md`](../../agent/skills/financial-statement-analysis/SKILL.md)
- `fonts` — [`agent/skills/fonts/SKILL.md`](../../agent/skills/fonts/SKILL.md)
- `formal-model-checking` — [`agent/skills/formal-model-checking/SKILL.md`](../../agent/skills/formal-model-checking/SKILL.md)
- `fortran-scientific-computing` — [`agent/skills/fortran-scientific-computing/SKILL.md`](../../agent/skills/fortran-scientific-computing/SKILL.md)
- `frontend-design` — [`agent/skills/frontend-design/SKILL.md`](../../agent/skills/frontend-design/SKILL.md)
- `frontend-js` — [`agent/skills/frontend-js/SKILL.md`](../../agent/skills/frontend-js/SKILL.md)
- `gif-animation-editing` — [`agent/skills/gif-animation-editing/SKILL.md`](../../agent/skills/gif-animation-editing/SKILL.md)
- `git-github` — [`agent/skills/git-github/SKILL.md`](../../agent/skills/git-github/SKILL.md)
- `github-actions-workflows` — [`agent/skills/github-actions-workflows/SKILL.md`](../../agent/skills/github-actions-workflows/SKILL.md)
- `github-identity-integration` — [`agent/skills/github-identity-integration/SKILL.md`](../../agent/skills/github-identity-integration/SKILL.md)
- `github-readme-authoring` — [`agent/skills/github-readme-authoring/SKILL.md`](../../agent/skills/github-readme-authoring/SKILL.md)
- `github-release-notes` — [`agent/skills/github-release-notes/SKILL.md`](../../agent/skills/github-release-notes/SKILL.md)
- `github-repo-presentation` — [`agent/skills/github-repo-presentation/SKILL.md`](../../agent/skills/github-repo-presentation/SKILL.md)
- `go-service-engineering` — [`agent/skills/go-service-engineering/SKILL.md`](../../agent/skills/go-service-engineering/SKILL.md)
- `google-colab-training` — [`agent/skills/google-colab-training/SKILL.md`](../../agent/skills/google-colab-training/SKILL.md)
- `google-identity-integration` — [`agent/skills/google-identity-integration/SKILL.md`](../../agent/skills/google-identity-integration/SKILL.md)
- `harness-self-maintenance` — [`agent/skills/harness-self-maintenance/SKILL.md`](../../agent/skills/harness-self-maintenance/SKILL.md)
- `hybrid-ml-systems` — [`agent/skills/hybrid-ml-systems/SKILL.md`](../../agent/skills/hybrid-ml-systems/SKILL.md)
- `image-analysis` — [`agent/skills/image-analysis/SKILL.md`](../../agent/skills/image-analysis/SKILL.md)
- `incremental-computation` — [`agent/skills/incremental-computation/SKILL.md`](../../agent/skills/incremental-computation/SKILL.md)
- `industrial-automation-control` — [`agent/skills/industrial-automation-control/SKILL.md`](../../agent/skills/industrial-automation-control/SKILL.md)
- `industrial-device-protocols` — [`agent/skills/industrial-device-protocols/SKILL.md`](../../agent/skills/industrial-device-protocols/SKILL.md)
- `inference-serving` — [`agent/skills/inference-serving/SKILL.md`](../../agent/skills/inference-serving/SKILL.md)
- `investment-risk-analysis` — [`agent/skills/investment-risk-analysis/SKILL.md`](../../agent/skills/investment-risk-analysis/SKILL.md)
- `java-cross-platform` — [`agent/skills/java-cross-platform/SKILL.md`](../../agent/skills/java-cross-platform/SKILL.md)
- `java-platform-engineering` — [`agent/skills/java-platform-engineering/SKILL.md`](../../agent/skills/java-platform-engineering/SKILL.md)
- `libreoffice-automation` — [`agent/skills/libreoffice-automation/SKILL.md`](../../agent/skills/libreoffice-automation/SKILL.md)
- `linux` — [`agent/skills/linux/SKILL.md`](../../agent/skills/linux/SKILL.md)
- `linux-desktop-ui-ux` — [`agent/skills/linux-desktop-ui-ux/SKILL.md`](../../agent/skills/linux-desktop-ui-ux/SKILL.md)
- `linux-host-defense` — [`agent/skills/linux-host-defense/SKILL.md`](../../agent/skills/linux-host-defense/SKILL.md)
- `linux-network-engineering` — [`agent/skills/linux-network-engineering/SKILL.md`](../../agent/skills/linux-network-engineering/SKILL.md)
- `llm-dataset-preparation` — [`agent/skills/llm-dataset-preparation/SKILL.md`](../../agent/skills/llm-dataset-preparation/SKILL.md)
- `llm-fine-tuning` — [`agent/skills/llm-fine-tuning/SKILL.md`](../../agent/skills/llm-fine-tuning/SKILL.md)
- `llm-systems-engineering` — [`agent/skills/llm-systems-engineering/SKILL.md`](../../agent/skills/llm-systems-engineering/SKILL.md)
- `local-network-analysis` — [`agent/skills/local-network-analysis/SKILL.md`](../../agent/skills/local-network-analysis/SKILL.md)
- `media-in-web` — [`agent/skills/media-in-web/SKILL.md`](../../agent/skills/media-in-web/SKILL.md)
- `memory-resource-ownership` — [`agent/skills/memory-resource-ownership/SKILL.md`](../../agent/skills/memory-resource-ownership/SKILL.md)
- `ml-engineering` — [`agent/skills/ml-engineering/SKILL.md`](../../agent/skills/ml-engineering/SKILL.md)
- `model-evaluation` — [`agent/skills/model-evaluation/SKILL.md`](../../agent/skills/model-evaluation/SKILL.md)
- `modern-frontend-frameworks` — [`agent/skills/modern-frontend-frameworks/SKILL.md`](../../agent/skills/modern-frontend-frameworks/SKILL.md)
- `motion` — [`agent/skills/motion/SKILL.md`](../../agent/skills/motion/SKILL.md)
- `motion-graphics-production` — [`agent/skills/motion-graphics-production/SKILL.md`](../../agent/skills/motion-graphics-production/SKILL.md)
- `multi-developer-pipelines` — [`agent/skills/multi-developer-pipelines/SKILL.md`](../../agent/skills/multi-developer-pipelines/SKILL.md)
- `music-composition` — [`agent/skills/music-composition/SKILL.md`](../../agent/skills/music-composition/SKILL.md)
- `natural-editorial-writing` — [`agent/skills/natural-editorial-writing/SKILL.md`](../../agent/skills/natural-editorial-writing/SKILL.md)
- `network-iso-compliance` — [`agent/skills/network-iso-compliance/SKILL.md`](../../agent/skills/network-iso-compliance/SKILL.md)
- `network-traffic-analysis` — [`agent/skills/network-traffic-analysis/SKILL.md`](../../agent/skills/network-traffic-analysis/SKILL.md)
- `nlp-system-design` — [`agent/skills/nlp-system-design/SKILL.md`](../../agent/skills/nlp-system-design/SKILL.md)
- `node-runtime-engineering` — [`agent/skills/node-runtime-engineering/SKILL.md`](../../agent/skills/node-runtime-engineering/SKILL.md)
- `numerical-computing` — [`agent/skills/numerical-computing/SKILL.md`](../../agent/skills/numerical-computing/SKILL.md)
- `optimization-modeling` — [`agent/skills/optimization-modeling/SKILL.md`](../../agent/skills/optimization-modeling/SKILL.md)
- `organic-growth-engineering` — [`agent/skills/organic-growth-engineering/SKILL.md`](../../agent/skills/organic-growth-engineering/SKILL.md)
- `packet-trace-analysis` — [`agent/skills/packet-trace-analysis/SKILL.md`](../../agent/skills/packet-trace-analysis/SKILL.md)
- `performance-experiments` — [`agent/skills/performance-experiments/SKILL.md`](../../agent/skills/performance-experiments/SKILL.md)
- `php-application-engineering` — [`agent/skills/php-application-engineering/SKILL.md`](../../agent/skills/php-application-engineering/SKILL.md)
- `physical-animation-systems` — [`agent/skills/physical-animation-systems/SKILL.md`](../../agent/skills/physical-animation-systems/SKILL.md)
- `physics-modeling` — [`agent/skills/physics-modeling/SKILL.md`](../../agent/skills/physics-modeling/SKILL.md)
- `ponytail` — [`agent/skills/ponytail/SKILL.md`](../../agent/skills/ponytail/SKILL.md)
- `presentation-authoring` — [`agent/skills/presentation-authoring/SKILL.md`](../../agent/skills/presentation-authoring/SKILL.md)
- `procedural-animation-math` — [`agent/skills/procedural-animation-math/SKILL.md`](../../agent/skills/procedural-animation-math/SKILL.md)
- `product-ui-verification` — [`agent/skills/product-ui-verification/SKILL.md`](../../agent/skills/product-ui-verification/SKILL.md)
- `property-based-testing` — [`agent/skills/property-based-testing/SKILL.md`](../../agent/skills/property-based-testing/SKILL.md)
- `proxy-analysis` — [`agent/skills/proxy-analysis/SKILL.md`](../../agent/skills/proxy-analysis/SKILL.md)
- `proxy-operations` — [`agent/skills/proxy-operations/SKILL.md`](../../agent/skills/proxy-operations/SKILL.md)
- `python-software-engineering` — [`agent/skills/python-software-engineering/SKILL.md`](../../agent/skills/python-software-engineering/SKILL.md)
- `rag-engineering` — [`agent/skills/rag-engineering/SKILL.md`](../../agent/skills/rag-engineering/SKILL.md)
- `reinforcement-learning` — [`agent/skills/reinforcement-learning/SKILL.md`](../../agent/skills/reinforcement-learning/SKILL.md)
- `research` — [`agent/skills/research/SKILL.md`](../../agent/skills/research/SKILL.md)
- `resourceful-market-strategy` — [`agent/skills/resourceful-market-strategy/SKILL.md`](../../agent/skills/resourceful-market-strategy/SKILL.md)
- `rl-decision-systems` — [`agent/skills/rl-decision-systems/SKILL.md`](../../agent/skills/rl-decision-systems/SKILL.md)
- `rust-systems-engineering` — [`agent/skills/rust-systems-engineering/SKILL.md`](../../agent/skills/rust-systems-engineering/SKILL.md)
- `scientific-paper-research` — [`agent/skills/scientific-paper-research/SKILL.md`](../../agent/skills/scientific-paper-research/SKILL.md)
- `scroll-animated-websites` — [`agent/skills/scroll-animated-websites/SKILL.md`](../../agent/skills/scroll-animated-websites/SKILL.md)
- `search-discoverability` — [`agent/skills/search-discoverability/SKILL.md`](../../agent/skills/search-discoverability/SKILL.md)
- `simulation-engineering` — [`agent/skills/simulation-engineering/SKILL.md`](../../agent/skills/simulation-engineering/SKILL.md)
- `small-model-engineering` — [`agent/skills/small-model-engineering/SKILL.md`](../../agent/skills/small-model-engineering/SKILL.md)
- `software-engineering-wisdom` — [`agent/skills/software-engineering-wisdom/SKILL.md`](../../agent/skills/software-engineering-wisdom/SKILL.md)
- `sound-analysis` — [`agent/skills/sound-analysis/SKILL.md`](../../agent/skills/sound-analysis/SKILL.md)
- `spreadsheet-authoring` — [`agent/skills/spreadsheet-authoring/SKILL.md`](../../agent/skills/spreadsheet-authoring/SKILL.md)
- `sql-query-engineering` — [`agent/skills/sql-query-engineering/SKILL.md`](../../agent/skills/sql-query-engineering/SKILL.md)
- `statistical-experiments` — [`agent/skills/statistical-experiments/SKILL.md`](../../agent/skills/statistical-experiments/SKILL.md)
- `storytelling` — [`agent/skills/storytelling/SKILL.md`](../../agent/skills/storytelling/SKILL.md)
- `svg-assessment` — [`agent/skills/svg-assessment/SKILL.md`](../../agent/skills/svg-assessment/SKILL.md)
- `svg-motion-engineering` — [`agent/skills/svg-motion-engineering/SKILL.md`](../../agent/skills/svg-motion-engineering/SKILL.md)
- `systems-security` — [`agent/skills/systems-security/SKILL.md`](../../agent/skills/systems-security/SKILL.md)
- `terminal-video-editing` — [`agent/skills/terminal-video-editing/SKILL.md`](../../agent/skills/terminal-video-editing/SKILL.md)
- `threejs` — [`agent/skills/threejs/SKILL.md`](../../agent/skills/threejs/SKILL.md)
- `threejs-animation-engineering` — [`agent/skills/threejs-animation-engineering/SKILL.md`](../../agent/skills/threejs-animation-engineering/SKILL.md)
- `type-driven-design` — [`agent/skills/type-driven-design/SKILL.md`](../../agent/skills/type-driven-design/SKILL.md)
- `typescript-contract-engineering` — [`agent/skills/typescript-contract-engineering/SKILL.md`](../../agent/skills/typescript-contract-engineering/SKILL.md)
- `ubuntu-operations` — [`agent/skills/ubuntu-operations/SKILL.md`](../../agent/skills/ubuntu-operations/SKILL.md)
- `ui-antipattern-review` — [`agent/skills/ui-antipattern-review/SKILL.md`](../../agent/skills/ui-antipattern-review/SKILL.md)
- `ui-ux-principles` — [`agent/skills/ui-ux-principles/SKILL.md`](../../agent/skills/ui-ux-principles/SKILL.md)
- `vanilla-web-libs` — [`agent/skills/vanilla-web-libs/SKILL.md`](../../agent/skills/vanilla-web-libs/SKILL.md)
- `video-analysis` — [`agent/skills/video-analysis/SKILL.md`](../../agent/skills/video-analysis/SKILL.md)
- `visual-composition` — [`agent/skills/visual-composition/SKILL.md`](../../agent/skills/visual-composition/SKILL.md)
- `wasm-animation-pipelines` — [`agent/skills/wasm-animation-pipelines/SKILL.md`](../../agent/skills/wasm-animation-pipelines/SKILL.md)
- `wasm-browsers` — [`agent/skills/wasm-browsers/SKILL.md`](../../agent/skills/wasm-browsers/SKILL.md)
- `wasm-c-cpp` — [`agent/skills/wasm-c-cpp/SKILL.md`](../../agent/skills/wasm-c-cpp/SKILL.md)
- `wasm-python` — [`agent/skills/wasm-python/SKILL.md`](../../agent/skills/wasm-python/SKILL.md)
- `wasm-runtime-engineering` — [`agent/skills/wasm-runtime-engineering/SKILL.md`](../../agent/skills/wasm-runtime-engineering/SKILL.md)
- `wasm-rust` — [`agent/skills/wasm-rust/SKILL.md`](../../agent/skills/wasm-rust/SKILL.md)
- `web-component-patterns` — [`agent/skills/web-component-patterns/SKILL.md`](../../agent/skills/web-component-patterns/SKILL.md)
- `web-effects` — [`agent/skills/web-effects/SKILL.md`](../../agent/skills/web-effects/SKILL.md)
- `web-patterns` — [`agent/skills/web-patterns/SKILL.md`](../../agent/skills/web-patterns/SKILL.md)
- `web-performance` — [`agent/skills/web-performance/SKILL.md`](../../agent/skills/web-performance/SKILL.md)
- `web-security` — [`agent/skills/web-security/SKILL.md`](../../agent/skills/web-security/SKILL.md)
- `web-ui-stack-selection` — [`agent/skills/web-ui-stack-selection/SKILL.md`](../../agent/skills/web-ui-stack-selection/SKILL.md)
- `windows-on-linux-engineering` — [`agent/skills/windows-on-linux-engineering/SKILL.md`](../../agent/skills/windows-on-linux-engineering/SKILL.md)
- `winecharm` — [`agent/skills/winecharm/SKILL.md`](../../agent/skills/winecharm/SKILL.md)
- `wireless-signal-analysis` — [`agent/skills/wireless-signal-analysis/SKILL.md`](../../agent/skills/wireless-signal-analysis/SKILL.md)
- `word-document-authoring` — [`agent/skills/word-document-authoring/SKILL.md`](../../agent/skills/word-document-authoring/SKILL.md)
- `x86-assembly-engineering` — [`agent/skills/x86-assembly-engineering/SKILL.md`](../../agent/skills/x86-assembly-engineering/SKILL.md)

## Migration test fixtures

The historical core transforms were deleted after the owned-core migration (see PATCH-MIGRATION.md). Runtime behavior is owned directly in `runtime/core/*/src` and `extensions/`; no transform catalogue remains.

- _None recorded in the manifest/source tree._

## Public documentation

- [`docs/ACTION-PLANS.md`](ACTION-PLANS.md)
- [`docs/ASYNC-AND-STUDIO.md`](ASYNC-AND-STUDIO.md)
- [`docs/AUDIT-CHANGED-FILES.md`](AUDIT-CHANGED-FILES.md)
- [`docs/CHANGE-SCOPE.md`](CHANGE-SCOPE.md)
- [`docs/CONTEXT-AUDIT.md`](CONTEXT-AUDIT.md)
- [`docs/CORE-OWNERSHIP.md`](CORE-OWNERSHIP.md)
- [`docs/CORE-UPDATES.md`](CORE-UPDATES.md)
- [`docs/COST-ACCOUNTING.md`](COST-ACCOUNTING.md)
- [`docs/EFFICIENCY-AUDIT.md`](EFFICIENCY-AUDIT.md)
- [`docs/EMAIL.md`](EMAIL.md)
- [`docs/GUARDIAN-IMPLEMENTATION-AUDIT.md`](GUARDIAN-IMPLEMENTATION-AUDIT.md)
- [`docs/GUARDIAN-INTELLIGENCE.md`](GUARDIAN-INTELLIGENCE.md)
- [`docs/GUIDANCE-AND-DIAGNOSTICS.md`](GUIDANCE-AND-DIAGNOSTICS.md)
- [`docs/INDEPENDENT-AUDIT.md`](INDEPENDENT-AUDIT.md)
- [`docs/INSTALL.md`](INSTALL.md)
- [`docs/INTENT.md`](INTENT.md)
- [`docs/ISOLATION-AND-WEB.md`](ISOLATION-AND-WEB.md)
- [`docs/LLM-PREFERENCES.md`](LLM-PREFERENCES.md)
- [`docs/LOCAL-INTELLIGENCE.md`](LOCAL-INTELLIGENCE.md)
- [`docs/MICRO-INTELLIGENCE.md`](MICRO-INTELLIGENCE.md)
- [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md)
- [`docs/NEEDLE-AUDIT.md`](NEEDLE-AUDIT.md)
- [`docs/ORCHESTRATION-EVIDENCE.md`](ORCHESTRATION-EVIDENCE.md)
- [`docs/PATCH-MIGRATION.md`](PATCH-MIGRATION.md)
- [`docs/PLATFORMS.md`](PLATFORMS.md)
- [`docs/PROJECT-INTELLIGENCE.md`](PROJECT-INTELLIGENCE.md)
- [`docs/PUBLISHING.md`](PUBLISHING.md)
- [`docs/RECOVERY-AND-TESTING.md`](RECOVERY-AND-TESTING.md)
- [`docs/REVIEWS-AND-COUNCILS.md`](REVIEWS-AND-COUNCILS.md)
- [`docs/SANDBOXES.md`](SANDBOXES.md)
- [`docs/SCREENSHOTS.md`](SCREENSHOTS.md)
- [`docs/SECURITY.md`](SECURITY.md)
- [`docs/SESSION-METRICS.md`](SESSION-METRICS.md)
- [`docs/SESSION-RECOVERY-AUDIT.md`](SESSION-RECOVERY-AUDIT.md)
- [`docs/SKILLS-AND-CHECKS.md`](SKILLS-AND-CHECKS.md)
- [`docs/STRUCTURE.md`](STRUCTURE.md)
- [`docs/SUBAGENT-CONTRACTS.md`](SUBAGENT-CONTRACTS.md)

## Retired source markers

The manifest tombstones retired names so the inventory can explain historical references without presenting them as available capabilities.

- `*-auto-models.ts` — retired 2026-08-31: the 7 provider auto-catalog extensions (openrouter, baseten, cerebras, friendli, lmstudio, orcarouter, together) — superseded by native pi-ai catalogs + static models.json; backups/provider-cleanup-20260831/. SUPERSEDED AGAIN 2026-08-31 by extensions/live-models.ts (single live-catalog extension for openrouter/orcarouter/together/friendli — native catalog lacks orcarouter entirely; live lists merged over the store)
- `a-speech-fix.ts` — retired 2026-08-31: speech-to-text misdecoding rewriter (input-hook mapping/fuzzy corrector) removed at user direction; its config speech-fix.json deleted with it; both moved to backups/retired-extensions/
- `auto-apply-extensions.sh` — retired 2026-09-01: sole consumer of the PI_AUTOUPDATE banner trigger; removed with it (auto-update.sh also no longer runs pi update --extensions)
- `auto-recover.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `auto-update-extensions.mjs` — retired 2026-09-01: dormant: settings.packages=[] since the 2026-08-31 fork completion — session-start auto-apply of npm extension updates had nothing to apply; extensions are local forks updated via git; moved to backups/retired-patches/
- `capabilities.ts` — retired 2026-09-02: user direction: one-time per-session delegation/parallelism awareness message removed permanently (no backup) — the toolkit reachability is already evident from the tool list itself. Do not recreate
- `context-composition.json` — retired 2026-08-31: orphan of deleted pi-context-router; no writer/reader since 2026-08-12
- `context-mode` — retired 2026-09-01: user direction: context/knowledge-base system removed entirely — ctx_* MCP-bridge tools, 8 ctx skills, CM_PREWARM folded marker, ctx group in tool-loader, ctx overrides/excludes, drift-prompt mention; ~/.pi/context-mode/ state archived to ~/.pi/backups/retired-context-mode-state-20260901; fork moved to backups/retired-extensions/context-mode. Do not recreate
- `DOCTRINE.md` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `governor-core.ts` — retired 2026-09-02: user direction: governor policy core removed with governor.ts (see that tombstone) — no broker remains; each extension owns its own injection gating. Do not recreate
- `governor.ts` — retired 2026-09-02: user direction: injection-budget broker removed permanently (no backup) — governor.ts + lib/governor-core.ts, /gov /why commands, governance tool, ~/.pi/governor policy/state all deleted. reminders/checkpoints/siblings now inject directly with their own hysteresis/dedup. Do not recreate
- `greybeard` — retired 2026-09-01: user direction: Greybeard standards engine removed entirely — fork (standards dir, skills, /greybeard commands, code-intent JIT banner) deleted; shared detectCodeIntent heuristic removed from tool-loader.ts; fork moved to backups/retired-extensions/greybeard. Do not recreate
- `harness-config.json` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `long-prompt-offload.ts` — retired 2026-08-31: long-prompt offload system removed per user direction — long prompts now pass through the normal input path verbatim (no file offload, ORIENTATION map, or discovery pre-pass); ~/.pi/prompt-offload/ deleted
- `loop.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `micro-agents.ts` — retired 2026-09-02: user direction: single-model read-only micro-agent swarm (micro_agent/micro_status/micro_wait/micro_kill tools, /micro-agent command, micro-agents.json config, agent/micro-runs/ state) removed permanently (no backup) — pi-subagents + pi-background-tasks cover the capability. Do not recreate
- `micro-intelligence/coordinator.ts` — retired 2026-09-19: Removed unused duplicate caches and write-only evidence ledger; helper owners retain their production caches and metrics.
- `minify-system-prompt.mjs` — retired 2026-09-02: user direction: system-prompt minification (intro + tool-catalog snippet dedupe) removed permanently (no backup) — saving prompt bytes no longer worth patching pi core and altering tool-catalog presentation. Do not recreate
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
- `pi-mcp-adapter.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-orchestrator.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
- `pi-subagents.ts` — retired 2026-08-12: extension file superseded by npm:pi-subagents (the package name stays live)
- `pi-tinyfish.ts` — retired 2026-08-31: web_search/web_fetch overlap with npm:pi-web-access; moved to backups/retired-extensions/
- `pi-ux.ts` — retired 2026-09-01: user direction: UX-discipline extension removed — ux_audit tool, UX banner injection, nearestPassingFg folded marker, ux group in tool-loader all deleted; shared detectUiIntent heuristic removed from tool-loader.ts; moved to backups/retired-extensions/pi-ux.ts. Do not recreate
- `ponytail` — retired 2026-08-31: pilot/ponytail governor-predecessor experiment; scrubbed. (Sibling codename "pilot" deliberately NOT tombstoned — too generic a token for word-boundary matching.)
- `pressure-journal.mjs` — retired 2026-09-01: patch module folded into retry-429-policy.mjs (single owner per file: both edited pi-ai retry.js/retryAssistantCall and that pairing broke once); moved to backups/retired-patches/
- `repo-recon.json` — retired 2026-08-31: orphan of deleted pi-context-router; backup backups/repo-recon.json.20260831.bak
- `session-bridge.ts` — retired 2026-08-31: cross-session awareness + bridge tool removed at user direction; backups/retired-extensions/session-bridge.ts; data dir ~/.pi/session-bridge deleted (residual files from still-running sessions queued for cleanup). SUPERSEDED 2026-08-31 by extensions/siblings.ts — user-directed reinstatement, leaner: one-shot join notice + voluntary md board; no bridge tool, no tool-result annotations
- `session-reviewer.ts` — retired 2026-08-31: review channel superseded by checkpoints; references scrubbed
- `subagent-tool-description.md` — retired 2026-09-02: runtime-orphaned custom tool-description file (its toolDescriptionMode: 'custom' loader retired with the tool-desc-overrides seam 2026-09-02). Delegation posture folded into the pi-subagents fork's DEFAULT_SUBAGENT_TOOL_DESCRIPTION + SUBAGENT_TOOL_PROMPT_GUIDELINES (src/extension/tool-description.ts), which now own the subagent tool prompt; file moved to backups/retired-extensions/. Do not recreate
- `telemetry.json` — retired 2026-08-31: orphan of deleted pi-context-router; nothing wrote or read it since 2026-08-12
- `thinking-control.ts` — retired 2026-08-31: full /effort alias + dynamic thinking control superseded by minimal extensions/thinking.ts (2026-08-31, same session); pi-native /thinking stays authoritative for native level-setting
- `tool-desc-overrides.mjs` — retired 2026-09-02: user direction: tool-description override seam (SDK agent-session.js + bundle chunk __piOverrideTools builder) removed permanently (no backup) — patch module, tool-description-overrides.json config, and bench/tool-overrides-test.mjs all deleted. Do not recreate
- `tool-loader.ts` — retired 2026-09-01: user direction: default pi tool exposure restored. Its reason to exist was the oversized tool/skill surface of context-mode + greybeard + pi-ux, all retired 2026-09-01; gating 6 groups (files/intel/web/memory/delegate/bg) behind `load_tools` no longer pays for itself. Removed: load_tools + skills catalogue tools, session_start group deactivation, turn_end settle re-apply, drift warning, JIT skills/pi-docs prompt strips, deferred-skill path tracking. Consequence (accepted): every registered tool schema ships every turn (~86KB at 15 extensions) and the skills/pi-docs prompt blocks are no longer stripped. File moved to backups/retired-extensions/tool-loader.ts. Do not recreate
- `ultimate-pi.ts` — retired 2026-08-12: 2026-08-12 refactor — do not recreate
