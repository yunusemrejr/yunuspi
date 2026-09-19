# Skill routing and source checks

Default guidance offers a brief, optional workflow match with its installed path and a bounded description or discovery reason. The agent decides whether to read and apply it; the suggestion creates no review requirement. Grouped browsing and search remain available when the match is insufficient. Deterministic routing uses no model calls; the enabled asynchronous advisor can add suggestions after distinct successful observations within the shared assistance budget. The model-based advisor remains one assistance unit: only an instant no-output launch failure can try another distinct eligible route, with at most three total route attempts under the same claimed budget and deadline; once a child produces a genuine output attempt it is not retried. The final launched failure keeps a bounded diagnostic in health telemetry. The detailed routing below supplies local relevance signals and remains available through inspect and explicit strict mode. Explicit task and file
routes take priority; catalog descriptions provide additional suggestions when
at least two distinct discriminating terms match. Hyphenated skill names also
match ordinary prose. Negated clauses, quoted text and code fences do not become
positive task intent. A substantive new request replaces the old lexical topic;
short continuation requests retain it.

Up to three distinct catalog workflows can enter the existing suggestion queue, and a workflow whose whole match is vocabulary already covered no longer crowds out a genuinely distinct one. A workflow that has already been offered and ignored several times yields its advisory priority to a fresh candidate; reading it clears that fatigue and explicit task/file routes keep their full priority and review obligation.
Delivery remains capped at two hints at a time, with a small initial allowance
that grows during sustained work. Duplicate, already-read and unavailable skills
do not consume the queue. Suggestions are not evidence that a skill was read.

## Read and apply relevant workflows

The reminders owner selects up to three available workflows from deterministic
task routes, then discovers additional workflows from the files being read or
changed. By default these workflows are bounded, optional hints; delivering a
suggestion does not claim that it was read or applied. `skill_review` remains
available for inspecting the current routes and read status, or for a bounded
metadata-only catalogue search such as
`{"action":"search","query":"database migration","limit":5}`. Search
returns names, paths and short descriptions without reading skill bodies or
creating a review obligation. Set `PI_SKILL_REVIEW=required` when a task needs
the strict read checkpoint: unread workflows then remain in bounded model
context until read or deferred, and after a read the context carries the
applicable checks and asks the agent to retain result evidence. Reading does not
establish that those checks were executed successfully.

When `PI_SKILL_REVIEW=required`, the checkpoint covers native edits and writes,
concrete bulk-edit apply targets, and task-routed shell, research, browser,
media, data and delegated execution. An unread matching skill pauses the
operation with its path and reason. Read its `SKILL.md` using `read`, apply the
relevant workflow, then retry. Source reads, search/discovery tools and bulk
previews remain available. A successful complete read covers other files using
that skill while its context remains available. Failed or truncated reads do not
count. Compaction preserves workflow obligations but invalidates old read
receipts, so the agent reads the source again. In the default advisory mode,
these operations remain available while the same routes continue to offer
bounded guidance.

When a skill is irrelevant to the particular change, already covered by other
instructions, or inaccessible, record the reason:

```json
{"action":"defer","skill":"python-software-engineering","reason":"This change only refreshes a generated parser fixture."}
```

In strict mode, pass this object to `skill_review`; `{"action":"inspect"}`
lists the current review state. Deferrals expire on the next user request and
never count as reads. Each checkpoint asks for at most two reads at a time.
Further applicable file workflows remain eligible throughout a long task; the
former four-skill bypass is removed. Generated/dependency paths are excluded.
The checkpoint requires both `read` and `skill_review` to be active and is not a
security boundary or a general shell parser. A task-specific deferral is
available without asking the user for permission.

Built-in child profiles explicitly load the same skill owner and expose
`skill_review`. Child mode registers only skill lifecycle hooks, without parent
manual reminders or extra model turns. Strict custom capability ceilings still
apply; a child without `skill_review` is not blocked by an unavailable tool
and does not receive its required-read checklist. Short continuations retain workflow context;
new tasks replace old task routes. Catalog-only weak matches remain advisory.

User requests to work without skills take precedence. `PI_SKILL_REVIEW=required`
enables the strict read checkpoint and persistent checklist; the unset/default
mode keeps the same routing advisory. `PI_SKILL_REVIEW=off` disables the skill
review checkpoint and marks it unavailable to the guidance owner, while
`PI_RELEVANT_GUIDANCE=off` disables its owning guidance system as well.
Ordinary lower-confidence suggestions never block work.

## GitHub workflow skills

Four skills cover repository-facing work that is not part of ordinary Git
operations (that stays with `git-github`):

| Skill | Selected for | File route |
| --- | --- | --- |
| `github-readme-authoring` | writing, rewriting or polishing a README, front-page structure, badges, screenshots | `README.md` |
| `github-repo-presentation` | description/topics, license choice, CONTRIBUTING, SECURITY, code of conduct, issue/PR templates, CODEOWNERS, social preview | the health-file paths themselves |
| `github-release-notes` | changelog entries, release notes, version and prerelease decisions, migration notes | `CHANGELOG.md`, `.github/release.yml` |
| `github-actions-workflows` | authoring, reviewing or hardening workflow YAML: permissions, pinned actions, caching, matrix, secrets/OIDC, required checks | `.github/workflows/*.yml` |

Task routes require a matching action verb, so "explain the changelog format" or
"improve the readme parser" do not select a skill. Each skill keeps its detailed
checklists in a `references/` file that is read only when the task needs it.

## Batch syntax checks

Call `syntax_check` with explicit workspace-relative paths:

```json
{"paths":["src/handler.ts","scripts/import.py","config/service.yaml"]}
```

| Files | Parser | Coverage |
| --- | --- | --- |
| JS, MJS, CJS | Bundled Acorn | JavaScript syntax; JS/MJS use module mode, CJS uses script mode |
| TS, MTS, CTS, TSX, JSX | Bundled Pi Lens Tree-sitter grammars | Grammar errors and missing syntax nodes |
| Python, PYI | Installed Python, isolated `compile` | Syntax without imports, execution or bytecode files |
| Bash, SH | Installed Bash, `-n` | Bash syntax; SH files are interpreted as Bash syntax |
| Ruby | Installed Ruby, `-c` | Syntax with gem startup disabled |
| PHP | Installed PHP, `-n -l` | Syntax without loading php.ini |
| Go | Installed gofmt, `-e -l` | Syntax only; no formatting changes or verdict |
| JSON | JSON.parse | JSON syntax |
| YAML, YML | Bundled YAML parser | Multi-document syntax and duplicate keys |
| TOML | Installed Python 3.11+ tomllib | TOML parsing |

No parser is installed automatically. Native parsers receive bounded source on
stdin with startup variables removed; executable lookup excludes project PATH
entries. The tool never executes project code, package scripts or build hooks.
It reuses the structural tools' workspace-contained, stable-file reader.

Each batch accepts up to 20 paths, 256 KiB per file and 1 MiB in total. Native
checks have a three-second timeout within a ten-second batch scheduling budget.
In-process parser initialization/parsing can overrun that scheduling budget;
it is not a hard process isolation limit. Results include file digests, compact
diagnostics and separate passed, failed, unavailable and incomplete counts.
Missing parsers, unsupported files, unsafe paths and truncated work never yield
an overall pass. No results are reused across calls; edits require fresh checks.

Post-edit hints suggest batching related paths. Success and failure hooks have
separate once-per-session receipts. `syntax_check` is also available within the
existing read-only child capability ceiling and tool budgets.

Syntax checks complement language-server types, behavior tests and environment
configuration/schema validation. A YAML syntax pass does not validate a Compose
or Kubernetes configuration, and TypeScript syntax does not prove type safety.
These changes reduce repeated command assembly and output volume; they do not
claim a measured cost reduction or guarantee every model's task quality.

## Component quality and shared review evidence

Project-test assessment and unresolved planned checks own the next automatic
verification step. Independent automatic review waits until those checks are
resolved, preserving its two rounds for stable source. Explicit early reviews
remain available, but acceptance still requires current test evidence. Review
guidance is delivered once per revision/status, with one fresh delivery after
compaction, session restoration, user input or provider-error recovery.

`project_tests` asks for verification proportional to the change. Reuse existing
focused checks; add regression coverage for a changed contract or demonstrated
defect. `not_needed` and `blocked` remain valid reasoned assessments. Direct
Python test scripts and literal environment prefixes such as
`PYTHONPATH=src python3 -m pytest` produce reusable receipts even when execution
precedes assessment. Environment values, command arguments, working directory
and source revision remain part of receipt identity. Shell expansion, pipelines
and status-masking commands cannot certify a planned check.

`quality_review` allows two rounds per user turn. If later edits exhaust those
rounds, `inspect` and `review` retain the last report under `previousReview`,
with its original revision. Resuming a session retains the same evidence as
stale; it cannot approve newer source. Automatic reminders omit old report
bodies. An unavailable-review notice retries failed queue delivery without
launching another reviewer or model turn.

The native runner retains source-backed reports emitted at a usage cutoff;
an interrupted review stays incomplete even when its findings are usable.
Exhausted background chains keep the completed child's report beside the budget
notice. A final child that finishes all requested work is not retroactively
failed because its final usage reaches the limit. Empty/malformed reports and
missing source reads are recorded as failures, with specific diagnostics.
Raw tool-protocol text is never executed; a route producing it is excluded
from automatic review for that session without changing the parent's model.

Reports that finish while their source changes are retained as incomplete
evidence rather than discarded. Idle scans monitor the task's known files;
unrelated changes from another session do not reopen an accepted review or a
finished test checkpoint. New changes observed during this agent's mutation
tools still enter its scope. Review availability describes independent evidence,
not whether the user's task is complete: record unavailable evidence as blocked,
disclose the gap, and finish when the actual requirements are met.

Native PHP test scripts such as `php tests/run-tests.php` are recognized before
coverage is declared, so a later assessment can use the observed run. Lint-only
commands and shell commands that mask failures do not become test receipts.
For a reliable receipt, run the simple test command directly; piping into
`tail`/`grep` or appending `echo` can hide its exit status. Missing-evidence
guidance explains this rather than treating a successful output-filter command
as a passing test.

On-write formatting honors the nearest `.prettierignore`, disables Prettier's
embedded-language reformatting, and skips HTML containing inline SVG to preserve
project-owned bytes. Explicit manual formatting remains available. This avoids
automatic polish breaking embedded-widget or SVG equality checks after an edit.

`artifact_check({operation:"ui",path:"src/Status.tsx"})` checks a complete workspace source file up to 24,000 characters. It reports a source hash and bounded advisory cues: decorative blinking live/status pills, competing primary font families, tiny tracked text, explicit opaque text/background pairs below 3:1, repeated absolute positioning, effect/motion clusters, placeholder links, clickable containers and removed focus outlines. Unsupported paths and oversized files do not receive a clean verdict.

The same source policy runs on successful native writes and independent batch replacements. Edit hooks route relevant skills; `quality_review` receives code, UI and content cues. Partial edits retain earlier cues until a complete replacement or fresh source discovery invalidates them. A source cue cannot resolve the CSS cascade, prove a status is fake, or certify usability. Review against project rules and user requirements, then verify rendered appearance and interaction states. Font/color names alone are not a ban list. Decorative blinking LIVE pills are discouraged by default.

Parent and child skill guidance names the available source and render tools, encourages batched syntax checks, and asks workers to retain file/revision/check evidence. Swarm/fusion consumers can reuse current receipts while preserving disagreements and unavailable evidence; merged edits require fresh verification of affected behavior. Tool and skill availability still constrain each worker. Guidance remains bounded and deduplicated.

Semantic radar also records a digest of JSX tags, attributes and text. A changed contract adds a divergence cue and prevents learned reordering within the affected similarity tier. Candidates remain available in baseline order. The neural model estimates code reuse affinity; it is not a visual design classifier and has not been retrained on these UI checks. Older fingerprint caches rebuild automatically.

## SVG, graphics and hardware evidence

`artifact_check({operation:"svg",path:"art/logo.svg"})` inspects a complete workspace SVG up to 64 KiB without executing content or fetching references. It returns a source hash, bounded counts and review findings for duplicate IDs, missing local references, malformed structure where observable, viewBox, active/external content and compositing/motion cues. It is not an XML validator, sanitizer or proof of geometry, accessibility or visual quality. Inspect rendered output at the intended sizes as a separate acceptance check. Successful SVG edits/writes automatically inspect the complete saved workspace file within the same limits, retaining a source-hash receipt and adding at most one compact error line. Unavailable checks are labeled in the receipt and do not claim success. The optional full-report cue remains usable even if an earlier image inspection used the same tool.

`math_check({operation:"frame_budget",values:[12,16,22],target_fps:60})` computes observed p50/p95/p99 frame times and the fraction above budget. `math_check({operation:"render_budget",width:1920,height:1080,pixel_ratio:2,bytes_per_pixel:8,samples:4,buffers:1})` estimates attachment allocation from explicit assumptions. The estimate excludes textures, geometry, alignment, driver overhead and other allocations; it does not measure GPU capacity or predict speed. Compare the same scene, workload and hardware before reducing detail.

Contextual guidance covers GPU allocation lifetime/readback, frame clocks, SVG references, embedded target identity and physics invariants. Existing hooks deduplicate these cues and cap delivery; they add no model calls. Existing Lens diagnostics continue to own duplication, complexity and entropy evidence. `sys_probe` host/device facts and workspace deployment/embedded markers help select the actual target; a configuration marker is neither a live deployment nor verified hardware. The embedded-device-engineering skill joins these facts to compile-only checks, exact board/electrical identity, port ownership, watchdog/interrupt contracts and scoped hardware verification.
