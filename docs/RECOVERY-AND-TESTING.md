# Session recovery and project tests

The main session's recovery hook resumes the pending inference continuation. Completed tool results stay in the conversation; recovery does not restart the task or replay tool executions.

## Recovery order

1. For an attributed OpenRouter upstream failure, fetch the selected model's current serving-endpoint metadata once per recovery episode. Try up to two unvisited endpoints with sufficient context/output capacity, required parameter support, compatible restrictions and token prices no higher than the selected route. Rank admitted endpoints using reported uptime, latency, throughput, price and recent local outcomes.
2. Choose another configured and scoped route. Prefer the same model identity, then use current catalog capacity/reasoning/modality requirements and available benchmark proximity, recent reliability, price proximity and measured response speed. Models and their capabilities come from registry/catalog evidence; there is no baked-in model list or intelligence tier table.
3. If no compatible route remains, honor shared cooldowns and recheck the primary within the existing four-attempt/two-minute recovery budget. Exhaustion pauses with history retained. New user input starts a fresh budget.

Account-level quotas, billing exhaustion and authentication failures remain provider-wide. Only structured upstream attribution can narrow a quota failure. Content rejections are not rerouted. Manual model choices, cancellation, free-only restrictions, scoped model lists, configured economic admission and hard routing restrictions remain authoritative. OpenRouter privacy/allowlist policies are retained on endpoint retries; policies that cannot be translated to another API block cross-provider changes. Soft ordering alone does not disable recovery.

Temporary endpoint pins stay in the session and are restored at settlement; credentials and persistent provider settings are untouched. `PI_AUTONOMOUS_MODEL_FALLBACK=off` disables automatic route changes. Offline mode avoids endpoint-catalog network requests. Endpoint discovery failure falls through to other configured routes without probing inference.

The existing provider-health file keeps at most 100 recovery observations per observed route over seven days. Recent outcomes receive more weight. Observations are bound to endpoint/API/rate fingerprints; successes do not erase failure history. Economic admission retains its separate, stricter freshness rules. Response duration and capacity are operational/structural proxies, not proof of equivalent model intelligence. Missing evidence stays unknown. Generic errors without upstream attribution may skip endpoint recovery rather than override a provider cooldown.

OpenRouter protocol references: [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [endpoint metadata](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

## Project test lifecycle

The checkpoints extension exposes `project_tests` and observes code/config changes and test-command results. Bounded local discovery finds existing test filenames, manifests and script names without executing them or following symlinks. The model assesses affected behavior, adds or updates meaningful unit tests, and runs appropriate checks through existing execution tools.

Use `project_tests` with `action: "inspect"` to inspect the current change revision and evidence. Use `action: "assess"`, a concrete reason, and `disposition: "required"` with the focused commands to record the plan. `not_needed` and `blocked` preserve an explicit reason for work that does not require unit tests or cannot currently be verified.

The harness records observed execution outcomes and invalidates evidence after further source/test changes. Missing or failed verification can trigger at most two continuation turns per user request. Background starts alone are not passes. Cancellation, explicit test opt-outs and read-only work suppress these continuations. Set `PI_PROJECT_TESTS=off` to disable this lifecycle; the checkpoints extension's existing disable/shadow controls also apply.

A passing command is execution evidence, not a coverage or correctness verdict. The model still evaluates whether assertions cover the behavior, investigates failures and reports blockers. Large scans, unsupported command forms and unobserved external execution remain explicit limitations. No dependencies are installed and no project scripts are executed automatically by discovery or the checkpoint tool.
