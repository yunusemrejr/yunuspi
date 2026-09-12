# Session guidance and diagnostics

Relevant UI and browser guidance is delivered before generic utility hints exhaust the prompt budget. Skill suggestions are distinct from successful skill reads. Ordinary file-related capability hints expire after four tool steps; newly relevant edits can refresh them. Manual reminders preserve their configured content and cadence.

Ambient reminders emit no empty check-in or generic soft-check-in header. Todo nudges include bounded task IDs, titles and status from the current session branch, rather than an unexplained pending count. Compaction file-state notes prioritize unresolved evidence and summarize settled history; `checkpoint_read` retrieves the full retained records.

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
