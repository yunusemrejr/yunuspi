# Patch migration audit

All 25 core transform modules were exercised against integrity-verified Pi 0.85.1 packages before their resulting unbundled implementation became owned source. The build and installation never run these transforms. The old transform code is retained under `agent/scripts/compatibility/legacy-transforms/` for synthetic regression tests only.

| Former module | Classification | Disposition |
| --- | --- | --- |
| `autonomous-recovery.mjs` | Functionality now in owned core source | Incorporated; 4 original SDK/bundle targets validated |
| `cache-hit-footer.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `cache-usage-accuracy.mjs` | Functionality now in owned core source | Incorporated; 4 original SDK/bundle targets validated |
| `catalog-refresh-credential-gate.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `compaction-early.mjs` | Functionality now in owned core source | Incorporated; 16 original SDK/bundle targets validated |
| `context-settings.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `edit-optimistic-concurrency.mjs` | Functionality now in owned core source | Incorporated; 1 original SDK/bundle targets validated |
| `export-redaction.mjs` | Functionality now in owned core source | Incorporated; 4 original SDK/bundle targets validated |
| `hook-metrics.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `local-context-allocation.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `model-selector-custom.mjs` | Functionality now in owned core source | Incorporated; 3 original SDK/bundle targets validated |
| `mutation-path-boundary.mjs` | Functionality now in owned core source | Incorporated; 3 original SDK/bundle targets validated |
| `native-read-mutation-queue.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `preserve-terminal-scrollback.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `provider-price-accuracy.mjs` | Functionality now in owned core source | Incorporated; 7 original SDK/bundle targets validated |
| `request-body-gate.mjs` | Functionality now in owned core source | Incorporated; 5 original SDK/bundle targets validated |
| `retry-429-policy.mjs` | Functionality now in owned core source | Incorporated; 20 original SDK/bundle targets validated |
| `search-output-spill.mjs` | Functionality now in owned core source | Incorporated; 4 original SDK/bundle targets validated |
| `stream-idle.mjs` | Functionality now in owned core source | Incorporated; 7 original SDK/bundle targets validated |
| `summary-effort.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `thinking-reflow.mjs` | Functionality now in owned core source | Incorporated; 3 original SDK/bundle targets validated |
| `token-budget.mjs` | Functionality now in owned core source | Incorporated; 5 original SDK/bundle targets validated |
| `tool-validation.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `truncation-context.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |
| `tui-branding.mjs` | Functionality now in owned core source | Incorporated; 2 original SDK/bundle targets validated |

The optimistic-concurrency adaptation had targeted only the former bundle; it was ported explicitly into both owned edit APIs with a real rejected-write test. Duplicate CLI bundle copies were discarded. `post-update-repair.mjs` is obsolete and removed. The old updater transaction implementation was replaced by the YunusPi source installer.

- `README.md`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `background-task-signal-status.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `background-task-terminal-publish.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `calculate-cost.js`: test-only helper payload; corresponding implementation is owned source.
- `hook-metrics-wrapper.js`: test-only helper payload; corresponding implementation is owned source.
- `notify-broker-delivery.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `openai-service-pricing.js`: test-only helper payload; corresponding implementation is owned source.
- `pi-lens-atomic-preflight.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-autofix-debounce.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-compact-reports.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-diagnostic-scope.md`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-diagnostic-scope.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-feedback-notices.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-format-safety.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-fuzzy-identifiers.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-indent-comments.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-radar-state.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-read-guard.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-semantic-dry.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-tool-result-profile.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `pi-lens-workspace-facts.mjs`: historical adaptation/reference for an already owned extension; retained for migration regression tests, never applied by install or verification.
- `session-cost-display.js`: test-only helper payload; corresponding implementation is owned source.

No third-party core patch remains in the runtime path. Future fixes edit owned source and test behavior directly.
