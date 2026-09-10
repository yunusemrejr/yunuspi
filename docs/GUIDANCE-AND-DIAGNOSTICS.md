# Session guidance and diagnostics

Relevant UI and browser guidance is delivered before generic utility hints exhaust the prompt budget. Skill suggestions are distinct from successful skill reads. Ordinary file-related capability hints expire after four tool steps; newly relevant edits can refresh them. Manual reminders preserve their configured content and cadence.

Ambient reminders emit no empty check-in or generic soft-check-in header. Todo nudges include bounded task IDs, titles and status from the current session branch, rather than an unexplained pending count. Compaction file-state notes prioritize unresolved evidence and summarize settled history; `checkpoint_read` retrieves the full retained records.

Environmental `render_see` startup failures suppress further render suggestions for that session, including across reload and compaction. A successful render clears that state. Missing files, selectors and text emitted by an inspected page do not establish that the renderer is unavailable. The bounded renderer remains usable directly after its environment has recovered.

Automatic diagnostics use retained baseline and verified changed-line evidence to distinguish new findings from unchanged or out-of-scope findings. Suppressed findings are summarized; explicit diagnostic inspection remains available. An unknown first-scan history is not treated as proof that a finding was pre-existing. New parser errors still receive their normal severity.

Open-redirect rules are review warnings, not proof that a runtime target lacks validation. Safe literal internal paths are excluded; dynamic and protocol-relative targets remain review candidates. The scanner does not claim general taint analysis. Scanner execution status is informational; actual scanner failures remain visible. HTML tag-pair checks continue to reject malformed containers and accept legal whitespace before a closing tag's `>`.

Long located grep/ripgrep matches receive bounded excerpts with emitted source pointers. Compound-command lines that are not search matches remain available. Original tool records are preserved and can be retrieved with `obs_read`; an excerpt is never represented as complete source content. Source reads and patches retain their separate handling.

Shell-write observations happen after the command and are labeled post-write audits. The verified-read guard accepts native `read` and supported Lens source-reading tools; shell `cat`, `sed` and `grep` do not establish guard coverage. Rejection text explains that requirement. These wording changes do not weaken read-before-edit or atomic preflight checks.

See [native delegation and independent file checks](SUBAGENT-CONTRACTS.md), [session metrics](SESSION-METRICS.md), and the [execution boundary](SECURITY.md). Restart Pi and resume an existing session to load the updated extension and core modules.
