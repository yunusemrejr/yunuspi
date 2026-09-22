# Session recovery audit

This audit follows a real interactive test drive after the Guardian implementation audit. Private prompts, session files, screenshots, provider configuration and business artifacts are not included in the repository. Regressions use synthetic inputs and the owned runtime.

## Confirmed defects and repairs

| Boundary | Defect | Repair and regression evidence |
| --- | --- | --- |
| Native child executor | The foreground and background launch helpers referenced a variable defined only in their caller. Discovery and independent reviewers could fail before starting. Lower-level routing tests did not reach these helpers. | Use the helpers' normalized parameters. Execute both real dispatch paths and real subprocess launchers with a deterministic provider boundary; require exact ordered upstream pins across a failed attempt and its successful retry. |
| Startup diagnostics | Failed helpers could lose their agent, model, scope and typed error, while empty usage evidence appeared as zero traffic. | Retain bounded identity and attempt metadata, typed private-safe startup diagnostics and missing usage as unknown. Runtime programming faults do not initiate provider retries. Test receipts through the logical child ledger and rendered `/used` report. |
| Slash completion | Accepting an exact slash command could strip `/`; argument and absolute-path completion could submit prematurely. | Preserve command syntax, distinguish command acceptance from argument/path completion, and test real editor → interactive mode → extension dispatch, with no model request for a command. |
| Automatic verification | Follow-up counters advanced after the entire triggered model turn returned. An edit during that turn could skip the increment and replenish apparent capacity. | Reserve delivery and budget before dispatch; roll back only an unaccepted delivery. Reentrant tests edit source and settle again before the first send returns. |
| Existing check receipts | A safe check run before its declaration could be lost. Displayed commands could omit working-directory prefixes or truncate arguments. | Retain exact bounded command receipts, reuse only current evidence without resurrecting an older pass after a newer failure, and display per-command passed/failed/stale/missing outcomes. Shell composition that masks exit status remains ineligible. |
| Unavailable reviewers | Changing screenshots could trigger another round after every reviewer failed to launch; parent context included reviewer-only rubrics. | Retain launch failures even if source changes during review; require a concrete launch/capacity correction before retrying an unavailable review, send a bounded status without another model turn, and keep reviewer rubrics in reviewer context. Missing review evidence remains a gap. |
| Browser session handles | A requested session alias was ignored; a subsequent alias action failed with misleading generic recovery advice. | Support owner-scoped aliases, retain canonical handles, and distinguish pre-dispatch rejection from uncertain dispatched actions. Test independent owners, close/reuse and current target references. |
| Browser response volume | Routine actions repeated full DOM snapshots and targets. | Return compact state and current targets; explicit snapshot/observe retains detailed DOM. A synthetic page measured 1,376 versus 8,508 reply bytes (84% reduction); this is not a universal token/cost claim. |
| Early popup diagnostics | Inline popup console/script errors could precede tab registration and be lost. | Install context listeners before creating pages and adopt bounded per-page buffers when tabs register. Exercise the early event ordering and real Chromium popups without sleeps. |
| Local render routes | A hash fragment on a local HTML path was treated as part of the filename. | Resolve the confined real file and then apply the URL fragment; preserve literal filenames containing `#` and symlink restrictions. Test both DOM and screenshot paths in Chromium. |
| Render recovery | Oversized decoded source-image failures encouraged retries that changed only screenshot dimensions. | Identify the source-image dimensions and explain that viewport/full-page changes do not resize the input asset. Preserve image limits and test rejection plus a corrected smaller asset. |
| Guardian visibility | Normal observation had no visible event; only interventions proved activity in the transcript. | Emit bounded, display-only observation status after actual owned tool results. Distinguish lazy WASM from actual successful kernel calls; preserve disabled and session-owner behavior. |

## Verification scope

The tests exercise real owned editor and SDK boundaries, real foreground/background launchers, real local Chromium rendering and actual shipped Guardian WASM. Provider-failure injection is a deterministic process boundary, not a claim that every hosted model/provider is healthy.

The shared-skill isolation fixture now uses its own home directory. The live desktop's atomic configuration replacement had raced unrelated mount setup; the sandbox correctly refused to launch. Real namespace protection remains required in local verification; no runtime isolation rule was relaxed.

Main-model reasoning remains the user's selected setting. The repair removes repeat dispatch and redundant observation costs; it does not lower requested reasoning, fabricate intelligence use, weaken source/pixel evidence requirements, or turn unavailable review into acceptance.

The failed historic session cannot prove what unrecorded children consumed. New diagnostics preserve that distinction. Existing edits must still be evaluated against current source; a receipt or review count is not a correctness score. Normal content-drift edit errors and schema validation remain legitimate errors, not reasons to bypass validation.
