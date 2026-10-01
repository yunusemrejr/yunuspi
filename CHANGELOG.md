# Changelog

## Unreleased

Child outcomes now recognize successful exit-only results and preserve failed
acceptance or exit evidence over coarse completion status. Retained breaker
causes survive into wait results. Child permission cancellation propagates the
hook deadline and prevents reviewer dispatch after delayed authentication has
outlived the request. The builtin delegate accepts `general-purpose` explicitly.
See [child outcomes and cancellation](docs/SESSION-ORCHESTRATION.md).

- Fix account-specific Codex discovery hiding new models behind an older catalog protocol. Refresh older protocol caches and preserve explicitly advertised `ultra` reasoning through CLI, configuration, menus, sessions and child routes.
- Preserve prompt/schema order for identical active tool sets and record Qwen cache creation separately from cached input hits.
- Reuse equivalent JEV requests across hook builders, keep valid cached judgments through provider outages, and ask fewer distillation questions over larger bounded logs.
- Share deterministic local Qwen probability reuse across judgments and choices, skip duplicate queued inference, and scope warmed prefixes to their actual server/transport. Add a reproducible live inference-reuse benchmark and cache behavior documentation.
- Bound shared capability retrieval to one total latency budget, resolve exact identifiers before inference, and preserve fallback helpers after stage timeouts.
- Give every skill-discovery JEV question the same candidate evidence, enforce serialized input/option bounds and require complete probability distributions before promotion.
- Reconcile cancellation in skill judgments and vector-memory recall, propagate observation/tool consumer cancellation, and adapt max/ultra reviewer effort after truncation without disabling session helpers.

## 0.18.0 — 2026-09-30

**Direct work carries fewer schemas; assurance carries less repeated text.** Adaptive routing stages 17 core tool names for direct work instead of 30, restores coordination on observed escalation, and retains explicit/named/used tools and caller ceilings. Compact verification and review views retain actionable gaps and findings; full native state remains available. Current source-bound test receipts include bounded, protected-material-aware diagnostics for independent reviewers, avoiding unnecessary temporary evidence logs. Source changes and changed/deleted supplied captures still invalidate old evidence.

**Quality checks distinguish prose from code and examples.** Writing checks exclude scripts, styles, JSON-LD and quoted technical examples, inspect short copy without loading syntax parsers, and require actual basis for metric claims. Ambiguous prose/design cues may receive one bounded cached JEV batch; judgments are annotations and never remove findings, certify pixels or authorize actions. Detailed output is available on request. SEO checks distinguish crawl evidence, canonical hints and indexing uncertainty, handle crawler-scoped noindex, validate hreflang/structured-data structure, and keep robots throttling/server failures unknown.

**Motion and 3D inspection use actual local evidence.** Motion review compares transforms within the same element, recognizes active reduced-motion playback and measures loop seams only for verified periods. Bounded decoded-video inspection reports timestamps, movement, freezes and explicit coverage limits. Local glTF/GLB preflight validates contained resources, geometry/index/accessor/node structure, mesh-local decoded bounds and animation times; imports retain required resources and provenance. Inspection remains separate from rendered appearance and interaction quality.

**Nonpersistent scouts record terminal usage.** A completed skill scout in `--no-session` print mode now emits its final usage receipt. Session identity and completion ownership still prevent late results from crossing sessions.

**Custom installation scope is contained.** A custom `--target` no longer treats its parent temporary directory as the maintenance harness. Canonical root/home/temp paths cannot grant maintenance authority; settings, shared skills, memory exemptions and the namespace wrapper use the actual installed agent directory. Real isolation regressions cover sibling denial and legitimate maintenance.

**Network and Linux diagnosis share existing tools.** One explicit-target network diagnosis reuses one connection across DNS/TCP/TLS and optional HEAD phases, preserves TLS trust failures and stops before sending HTTP on an untrusted connection. Linux diagnosis reads bounded proc/pressure/cgroup facts and optional exact PID, listener or unit facts. Cancellation, permission, unavailable and partial results are explicit; checks make no configuration changes or broad network scans.

CI now checks concise-tool/evidence bounds alongside scheduler dispatch and the complete strict distribution suite. See [verification and measurements](docs/RELEASE-0.18.0-VERIFICATION.md), [media preflight](docs/MEDIA-PREFLIGHT.md), [system/network diagnosis](docs/SYSTEM-NETWORK-DIAGNOSIS.md), [code quality](docs/CODE-QUALITY.md) and [SEO checks](docs/CODE-QUALITY.md#static-seo-checks).

## 0.17.0 — 2026-09-30

**Execution support now follows the work.** A shared, deterministic policy selects task, subtask and native todo support, reassesses real failures, lowers support after current substantive verification, and bounds automatic helpers, councils, reviews, Observer, Watchmaker, local ranking and JEV. Direct work skips remote prompt interpretation, skill scouts and periodic reviewers. Native child scheduling and reasoning defaults adapt to their own briefs; explicit model, concurrency, thinking and delegation constraints stay authoritative. Completed assurance remains evidence for the current source revision, with no synthetic passes or acceptance.

**Recurring development workflows start with the right capabilities.** Automatically selected recipes cover PHP 8+, Node, browser/vanilla JavaScript, React CDN and Node builds, Go, Rust, Java, Python/Flask, Bash, C/C++, Linux applications, local webapps, algorithms, AI/ML, local/Colab finetuning, UI quality and Git/SSH hosted deployment. Stage receipts reuse existing checks, distinguish prepared artifacts from actual execution, require pixels and interactions for UI claims, and preserve deployment/training gaps. Inferred schemas are released on simpler follow-ups; deliberate discoveries remain available.

**Local media production has an executable reusable pipeline.** `media_pipeline` combines editable score generation, effects, voice-driven music ducking, mixing, clip/scene composition and measured delivery QA. Tracks support bounded looping, pitch-preserving speed and denoise; optional mastering is verified on the delivered audio. Exported subtitles use measured narration timing. Malformed timeline inputs, silent mastering and FFmpeg sidechain starvation cannot produce misleading successful delivery receipts.

**Lifecycle fixes have behavioral regressions.** Native todo subjects now reach task state and policy. Updated scope requirements retire old evidence; delayed writes invalidate other scopes' checks; aborted startup inputs do not become tasks; stale, empty, skipped, signaled or detached test runs cannot simplify policy or certify completion. Review status distinguishes completed reports awaiting assessment from work still running.

**Formatting settles before verification.** Pi Lens drains pending autofix and formatting before native tests and review capture source identity. Failed or interrupted drains refuse verification, and final settlement cannot silently change a revision already accepted by its reviewer.

**Proofreading can finish after an actual readback.** Guardian accepts a complete, current, hash-matched readback for one small prose edit requested as proofreading. Native tool evidence bounds the file, changed text and mutation count. Code, policy, risky or mixed work, opaque commands and explicit requests for behavioral tests retain verification requirements. This does not record a test pass.

**Small sessions preserve memory without waiting for semantic indexing.** Automatic ingestion retains raw text, lexical indexes and provenance for direct work while deferring embedding and backlog recovery. Explicit memory operations, substantial tasks and unresolved failures retain semantic indexing.

See [adaptive execution](docs/ADAPTIVE-EXECUTION.md), [task pipelines](docs/TASK-PIPELINES.md), [video and audio workflows](docs/VIDEO-STUDIO.md) and the measured [verification report](docs/RELEASE-0.17.0-VERIFICATION.md). CI checks the real scheduler's bounded dispatch counts alongside the complete distribution suite.

## 0.16.3 — 2026-09-29

**Reading a memory no longer prints `chars undefined–undefined`.** The memory read view showed each retrieval unit's character span, and the matched fragment line, from properties the stored records do not have (`charStart`/`charEnd`; the store uses `char_start`/`char_end`). Every read of an atom, and every "Matched fragment" line, rendered the span as `undefined–undefined`, so the evidence trail pointed nowhere. The spans now come from the stored columns.

**Sub-projects at the same depth are ordered by path.** The tie-break that orders descendant projects compared a path to the whole project record instead of its path, so it never returned "before" and simply reversed whatever order the registry happened to hold. Which sub-project came first, and which survived the eight-project cap, then depended on registration order. Equal-depth descendants are now sorted by path.

## 0.16.2 — 2026-09-29

**A background suite now records its result when it actually finishes.** 0.16.1 stopped a launched `bg_run` from claiming a pass before it ran, which left the ledger honest but silent — nothing ever recorded the outcome either. A `<background-task-notification>` receipt now settles it: a suite that reports `completed` with a zero exit records the passing check, a failed or killed one records the failure, and a receipt for a command that is not a check changes nothing.

**A continuation that could not be sent is no longer swallowed.** The harness told you the goal was continuing, and if the nudge never left it the session just looked stalled — criteria open, no explanation for either. A failed send is now reported with the reason and pointed at `/goal resume`, matching what `/goal` already did for its own kickoff.

## 0.16.1 — 2026-09-29

**A goal could quietly lose its end-to-end verification criterion.** `goal criteria` replaces the open criteria with your list, and the mandatory "check the real artifact" criterion was appended *last* and then trimmed to the cap. A long enough replacement list cut it off — exactly when the list filled up and the check mattered most. A goal in that state could be closed with every criterion satisfied and nothing ever checked end to end. The verification slot is now reserved before the trim.

**pnpm, yarn and bun projects could never clear the goal completion gate.** Only `npm` was recognised as a package manager and only under `npx` were the bare runners recognised, so on a pnpm or bun project no passing run of the test suite registered as verification. After any file edit, `goal complete` stayed refused for the rest of the session and the only way out was the deliberate repeat-to-waive path meant for a user override. Package managers are now one family, and the common build and test entry points (`make`, `just`, `mvn`, `gradlew`, `go build`, `cargo`, `dotnet`, `composer`, `tox`, `deno`, `python -m unittest`, bare `vitest`/`jest`, `npm run build`) are recognised alongside them.

**A command that merely mentioned a checker was treated as a check.** The old pattern matched `tsc` anywhere in the line, so `cat tsc-config.json` and `git commit -m "fix tsc types"` both cleared the goal's unverified-change debt without a single test running. Every alternative is now anchored to command position — the start of the line or after a shell separator, behind an optional environment prefix — so `cd /tmp && tsc --noEmit` still counts and a filename or a commit message does not.

**A background test run no longer counts as verification before it has run.** `bg_run` returns a task id immediately, but the goal and task-state ledgers were clearing verification debt — and recording a passing check — the moment it was called. A suite launched in the background and left to fail still left the goal free to close. Both now settle on the terminal receipt: the debt clears and the passing check is recorded when the task reports `completed` with a zero exit, and a failed or killed run verifies nothing. A launch is still recorded as an attempt.

**An old waiver could silently approve a later, unrelated change.** The completion gate refuses once per distinct set of gaps and treats a repeat of that same call as the deliberate "ship anyway" it asks for. The refusal was remembered for the rest of the session, so any later gap of the same shape inherited it: refuse once over one unverified edit, take the waiver, and the next unrelated unverified edit of the same size closed the goal with nothing checked. A waiver is now spent by the call that uses it, so the next gap of the same shape is refused again. Only an immediate repeat waives, which is what the refusal asks for.

## 0.16.0 — 2026-09-29

**Static audits that run without being asked.** A new `code_audit` tool and a new `review` action on `svg_inspect` find the defects a careful reviewer would raise, from source text alone: nothing runs, nothing is installed, no model is called.
- `code_audit` checks security (injection into SQL and shell, secrets in provider formats, `eval`, HTML sinks, unsafe deserialization, disabled TLS, open CORS with credentials, cookie flags, JWT misuse, path traversal, open redirects, SSRF), backend engineering (outbound calls without timeouts, N+1 queries, whole request bodies written to models, stack traces sent to clients, blocking calls in handlers and `async def`, async Express 4 routes without error forwarding, a database client per request), efficiency (quadratic `reduce`, I/O inside loops, non-passive scroll listeners, render-blocking scripts), coding patterns (mutable defaults, bare `except`, thrown strings, boolean traps) and UI source (alt text, focus outlines, blocked zoom, tiny text, click handlers on `div`s, plus the design-slop cues). It reads JS/TS, Python, Go, PHP, shell, CSS, HTML, JSX/Vue/Svelte and config files, over paths, the workspace or `changed: true`.
- `svg_inspect` gained a `review` action instead of a second SVG tool, so measurements and verdicts come from one owner. Each file gets a score and verdict with fixes: art clipped by the viewBox (strokes included), no viewBox, hard-coded colours where `currentColor` belongs, node bloat, circles drawn as paths, embedded rasters, live text, filter cost, accessibility, active content, duplicate ids and broken references. `optimize: true` writes a lossless cleaned copy to a fresh git-ignored folder, only after the measurements agree (same paths, nodes and bounds). A messy Inkscape export went from 1,112 to 266 bytes; the original is never modified. Icon-set consistency stays in the existing set review.

Agents do not have to remember either one. After every `write` or `edit`, the security, backend, efficiency and UI-source rules run on the changed span and the edit result carries at most two findings, once per finding per session, with the fix. A saved `.svg` gets the same treatment on top of the existing structural check. Security and runtime cues promote the `security` and `runtime` review aspects, and requests that mention security, backends, endpoints, authentication, N+1, performance audits or coding patterns stage `code_audit`, and SVGs, icons or vector logos stage `svg_inspect`, on the first model turn. High-severity rules were tuned on this repository's own source: `db.exec` is not a shell, joined placeholders and constants are not SQL injection, and a `request` parameter alone does not make a function an HTTP handler.

**Smaller tool schemas.** Eight extensions each defined their own `choices()` helper, and about fifty other sites built enums as `Type.Union` of `Type.Literal`s, which serializes every value as its own `anyOf` object on every model turn. They now share one helper (`lib/tool-schema.ts`) that emits `{type:"string",enum:[…]}`. Across the existing tools this removed about 11,000 characters of schema (7%), and enums are now valid on providers that reject `anyOf` of constants.

**`svg_inspect` no longer measures a fragment of long paths.** Attribute values were cut at 4,096 characters, so a `d` longer than that (any traced or illustrated SVG) lost its tail mid-number: node counts, bounds, padding and centre described part of the drawing. Path and polygon data are now kept whole (the document is still bounded at 4 MB).

**`bg_run` no longer rejects ordinary commands.** Omitting `isAgent` cost a turn in four of the last four days of sessions, always for a server or script. It is now inferred as `false` unless the command launches an agent CLI (`claude`, `codex`, `pi`, `yunuspi` and similar), which still requires an explicit answer.

**Skills know the tools.** `svg-assessment`, `custom-svg`, `web-security`, `api-design`, `coding-practices` and `ui-antipattern-review` end with a short note on when to run `code_audit` or `svg_inspect` review and what they cannot judge. See `docs/CODE-AUDIT.md`.

## 0.15.0 — 2026-09-29

**Heavy work can no longer take the machine down.** Sessions that edited the harness kept dying: the kernel killed a node process holding 34 GB. The cause was a test, not a render. Comparing two differing WAV files with `assert.deepEqual` builds a diff that grows without bound, so one failing byte comparison exhausted RAM. Binary comparisons in the tests now go through `tests/bytes.mjs`, which reports sizes and hashes instead.

**Renders, narration and music synthesis run under a memory watchdog.** `lib/memory-guard.ts` sums the resident memory of a child's whole process tree once a second and kills it when it passes its budget (half of free memory, kept between 1.5 and 12 GB; `YUNUSPI_VIDEO_MEMORY_MB` overrides) or when the host drops under 1 GB free. The tool returns an error that says to lower the resolution, render by scene or range, or shorten the audio. Render workers are also sized to memory: about 300 MB plus 200 MB per output megapixel each, so a 4K render runs fewer Chrome tabs in parallel instead of exhausting RAM.

**Code-first video studio, finished.** Six tools now carry a vague prompt to a verified film: `video_project` (art-directed looks derived from the subject, vertical/square/landscape formats, publish or personal intent, brand, calls to action, optional 3D), `video_assets` (license-tracked photographs, footage and CC0 3D models), `video_render` (stills, preview, final with loudness mastering, captions, chapters and a description draft, and a thumbnail mode), `video_qa`, `narration_tts` (styles, word-level timing, more voices) and `audio_synth` (arranged music with drums, melody and an intensity arc, sound design, band-limited sfx). The `code-first-video` skill documents the new tools and the memory-safe way to iterate.

**Tests.** The template font, tool-count and transition assertions match the redesigned template, an unknown sound name is rejected before any directory is created, and the drum test describes the current style-driven arrangement.

## 0.14.1 — 2026-09-28

**`/goal` no longer freezes the session.** Setting a goal printed "Goal … set" and then nothing happened: no working indicator, no turn, and the editor stopped reacting to input. The command held the input queue while its handler ran, and the handler's kickoff message waited in that same queue for the handler to finish, so neither could proceed. Extension commands now release the input queue before their handler runs, because they drive their own turns. This fixes every command that sends a message, not only `/goal`. `/goal` also returns as soon as the kickoff is queued instead of waiting for the whole run, and reports a kickoff failure instead of discarding it. A regression test reproduces the deadlock.

**The loaded-extensions list names `pi-lens` correctly.** An extension whose entry is a built `dist/index.js` was listed as `dist`; it is now listed under its package name.

## 0.14.0 — 2026-09-28

**`/goal` gives important tasks a definition of done.** `/goal <what you want done>` turns the demand into numbered acceptance criteria (your list items and directives, plus a mandatory end-to-end verification criterion), stages a `goal` tool, and starts the work. The criteria ride the context every turn and are saved as snapshots on the session branch, so compaction, resume and fork keep them. A criterion only counts when the agent records what it observed (command and result, file and line, screenshot finding); a bare "done" is refused. `goal complete` is refused while criteria are open or files changed after the last passing check, once per distinct set of gaps; repeating the call is a recorded waiver, so you are never deadlocked. When the agent settles with criteria open, the harness sends one continuation naming them. Loops are bounded by construction: at most six continuations, a stop at the second continuation in a row that records no new evidence, a pause on interrupt, and no continuation while your messages are queued. `/goal` shows progress; `pause`, `resume`, `retry`, `done`, `clear` and `criteria a; b` manage it. Earlier goal trackers were retired because they inferred goals; this one exists only when asked. `PI_GOAL=0` disables it. See `docs/GOAL.md`.

**Tool mistakes that cost real turns now recover or explain themselves.** From recent session transcripts:
- `git_info review` and `log` failed with a git error in a repository with no commits, exactly when the first commit needs its review. Review now compares against the empty tree, and log and show say "No commits yet".
- `creative_direct` rejected 21 calls because models send `focalHierarchy` as a ranked list, `intent` as `{terms:[…]}` and array-valued `secondary`. All three shapes are accepted.
- `expert_director taste` rejected 7 calls: the fields models send flat beside `action` were stripped by schema validation, so the documented flat form never worked. They are declared now.
- A JSON-encoded array that does not parse (for example `subagent tasks` with an unescaped quote) produced "tasks.0: must be object", and the model resent the identical 12 KB payload three times. The error now says the argument is a string that is not valid JSON, and how to send it.

**`code_quality structure` checks the import graph.** Runtime import cycles (type-only imports are ignored), modules nothing imports, the most imported and most importing files, files over 600 lines, and packages imported but undeclared or declared but unused. It reads JS/TS and Python without running anything, and is meant as evidence for a decision, not a verdict.

**Video QA no longer passes a slideshow.** A rendered video that was static for 53% of its runtime in three 2-second holds passed automated QA because no single hold reached 4 seconds. QA now also warns when 35% or more of a video of six seconds or longer is static in holds of 1.5 seconds or more. The full pipeline (scaffold, check, stills, music and sound effects, final render, QA) was run end to end for this release.

## 0.13.9 — 2026-09-28

**Interface work now starts from an embedded design doctrine.** Unconstrained models converge on the same two looks: the indigo/purple SaaS page, then the cream/terracotta editorial page that reacted against it. The new `design-slop-prevention` skill ships inside the harness and explains the mechanism, lists the tells of both generations, and gives a nine-step procedure. It includes the swap test: if another company's logo and headline can replace yours and the page still works, the design is slop. It is a second layer on top of `anti-ai-slop` and the UI checklist, aimed at the choice of palette, typeface, layout and copy before any code is written.

**Jev decides when to demand it.** A new typed decision, `ui-work`, judges whether a request is interface work at a few hundred input tokens instead of a model turn. UI vocabulary and UI files frame the question; Jev settles the ambiguous middle in both directions. Live probe: "make the checkout less confusing" scored 0.88 and "add a dark mode toggle" 0.86, while "fix the page fault handler", "add a CLI flag" and "website scraper" scored 0.02–0.18. When the answer is yes, the agent must read the skill:
- a reminder rides the context until it is read;
- a UI file write is refused at most twice per request until then, so ignoring the reminder cannot loop or stall;
- one read clears it for the session;
- subagents launched without a skill catalog still get the installed path, and the reminder tells the parent to pass it along when delegating interface work.

An unavailable or unsure judge keeps the heuristic: strong UI vocabulary still counts, weak vocabulary does not. Writing a `.tsx`, `.html`, `.css` or GUI-toolkit file settles it without any judge. The web-design expert pack lists the skill and requires the swap test at convergence.

**Jev spares the change-scope council for small edits.** The council is a paid, up-to-four-minute, three-reviewer run started by a regex cue. In a probe of eight small edits that pass the cue ("refactor `parseDate` to use early returns", "fix the modal overflow on mobile"), six triggered it. A new typed decision, `scope-council-need`, asks whether the request is a small self-contained change with no design choice or earlier preference at stake. Small edits scored 0.43–0.84 and open redesign or refactor work 0.04–0.23. The veto needs 0.7, so it can only skip the council, never add one. Open visual briefs are never vetoed, and uncertainty, a 2.5-second timeout or an unavailable judge keeps the council. A skip is recorded as a `scope-deliberation-v1` receipt with status `skipped-by-jev`.

**Runaway shell writers are capped.** An unbounded writer (ffmpeg with `apad`) once filled the SSD. Shell commands now run under a 32 GiB per-file cap (`ulimit -f`), and a disk watcher stops a command that consumes more than 40 GiB or pushes free space under a 10 GiB reserve, including one that has been detached. `PI_MAX_FILE_GB`, `PI_DISK_BUDGET_GB` and `PI_DISK_RESERVE_GB` tune the limits; 0 disables one.

## 0.13.8 — 2026-09-28

**A reply-only prompt gets a reply, not a work session.** The live smoke check ("Reply with exactly: OK") ran for over three minutes. It loaded the maintenance skill, made todos, ran bash, and sent 28k-token turns. The prompt analyser and the Observer had both read the request as trivial. Three first-turn nudges still told the model to orient, plan and do maintenance:
- the harness orientation;
- the todo-plan guidance;
- the harness-maintenance note.

A single-line request whose whole deliverable is the reply text ("reply/respond/answer/say/print/output with exactly/only …", with no follow-on work) now skips all three. It does not use up their once-per-session delivery, so the next real request still gets them.

## 0.13.7 — 2026-09-28

**The Span behavior sensor works.** OpenRouter serves `respan/span-01-lite` only through its decisions endpoint and refuses chat completions with a 400, so every Span evaluation failed and recorded `unavailable`. That was 13 of 13 in recent sessions, with no success. The sensor now sends the bounded trace as the decisions state, with one plain `noul` question per catalog signal. Span answers only that question type, so P(yes) becomes present/absent. A live check on a repeated-failure trace flagged the loop and the premature completion at 0.97 each, took 1.7 s and cost nothing. Scores stay shadow-only, as before.

**Paid reviewer reports are no longer discarded on malformed JSON.** In one live session, two paid quality reviews were thrown away as "did not contain a reviews array":
- One contained invalid escapes (`\u夕暮れ\u`).
- The other was missing its closing `]}`.

Stray backslashes are now read as literal characters, and one report (or a bare array of reports) is wrapped as the envelope. Nothing is invented: text without an aspect report stays rejected.

**Work after an accepted revision can be reviewed.** Both review rounds could be spent on the first revision. Later feature work in the same request then could only close on a forced waiver. Accepting a revision now leaves one round for the work that follows. Automatic admission still stays within the per-request budget.

**Closing the last todo no longer races a verification in the same batch.** A todo call that completes the plan was checked for verification receipts before a sibling `quality_review` or `project_tests` call in the same message had settled. It was refused, which cost a turn. `todo` now runs as a sequential barrier, so earlier calls settle first.

**A self-matching `pgrep -f` is rewritten instead of refused.** `pgrep -f name` matches its own shell, so the router used to refuse it and spend a turn. A plain pattern is now rewritten in place to the equivalent bracket form, `pgrep -f '[n]ame'`. Patterns that start with regex syntax or contain quotes are still refused, with the fix named. pgrep's pattern is its last positional argument, so `-u root -f sshd` no longer treats `root` as the pattern.

**Clearer Double failure notes.** An unavailable Double stream used to cite the child's JSON watchdog status line as its "underlying failure". It now names the classified exit, for example `process-signal (exit 129)` when the user interrupts.

## 0.13.6 — 2026-09-28

**`/double` streams no longer fail on a stale model exclusion.** A 595-second provider-gate cooldown was recorded as a 24-hour model exclusion, so every explicit same-route `/double` stream failed for a day. Transient failures (rate limits, 429, 5xx, timeouts, connection errors, provider cooldowns) now exclude a route only for their stated wait, clamped between 30 seconds and 15 minutes. Durable failures (auth, quota, unknown model) keep 24 hours. Stores written before this release heal on load.

**Browser handle recovery in one call.** An `unknown-session` rejection now lists the open session handles and aliases, so the agent retries with a valid handle instead of spending a turn on a separate list call.

**Todo calls without an `action` are inferred.** A top-level todo call with a subject becomes a create and one with a positive task id becomes an update, matching what batch operations already did. Calls that match neither are still rejected.

## 0.13.5 — 2026-09-28

**Jev/Kev review triage now defers routine reviews.** Before each Watchmaker or Observer review, a cheap Jev/Kev call (about $0.0001) asks whether anything new needs attention. In the last five days it ran 368 times for the Watchmaker and deferred nothing, while 440 of about 740 paid Watchmaker reviews returned no advice. Probing the live judge showed it separates the cases well. Routine progress scored worthwhile about 0.2 and routine about 0.75. Time sinks, repeated rereads, stalls and scope drift scored worthwhile 0.33 or more and routine 0.45 or less. The generic 0.2/0.8 acceptance bars sat outside that range. Admission now has its own bars: it defers when worthwhile is at most 0.3 and routine at least 0.7. A deferral postpones only one review, and the next review is always a full one. Tool errors, Guardian interventions and completion claims still bypass triage entirely.

**Sandbox toolchains work.** `sandbox_run` mounted an empty `/etc`, so every Debian alternatives link was left dangling. `cc` and `c++`, which `make` uses by default, were missing, and numpy failed to import because its BLAS and LAPACK libraries are alternatives links. `/etc/alternatives` (package symlinks only) and `/etc/fonts` are now bound read-only. Everything else under `/etc`, including `passwd`, stays absent. Verified in the sandbox: a C build through `make`, a raw x86-64 assembly program, and numpy 2.3 linear algebra. A live test covers it and skips on hosts that do not use alternatives.

**Post-edit code-noise check no longer drops findings under load.** The WASM AST scan that flags restated-return comments and undocumented empty catches had a 20 ms clock cap. When the CPU was busy with builds or tests, it truncated even a ten-line file and returned no findings. The 20,000-node cap already bounds the work, so the clock is now a 100 ms backstop. Under CPU stress the old cap missed findings in 2 of 6 runs; the new one missed none in 6.

**SEO audit in `web_probe`.** `seo: true` reads up to 1 MiB of the page, still behind the SSRF-guarded fetch, and returns structured signals. These are:
- title and description with their true lengths;
- canonical, meta robots and `X-Robots-Tag`;
- `lang` and hreflang;
- Open Graph and Twitter cards;
- JSON-LD types, including `@graph` and invalid blocks;
- h1 and heading order;
- images missing alt text;
- robots.txt, matched with RFC 9309 longest-match rules, plus its sitemaps.

Findings flag problems such as length issues, a missing or foreign canonical, `noindex`, h1 count, skipped heading levels, a missing viewport or lang, and a missing `og:image`. The h1 checks are skipped on a truncated page instead of reporting 0. An empty `href` counts as absent rather than resolving to the page itself. A robots.txt 4xx means allowed, and a 5xx means disallowed with a note. Without `seo`, the probe makes the same single 64 KiB request as before. The search-discoverability skill now starts from this tool.

**Video template scales to any output size.** The Remotion template laid out in pixels from `useVideoConfig()`. At 1280x720, a caption covered a diagram label and a particle network ran edge to edge. Now layout uses `useCanvas()` units, where the short side is always 1080, and one `Canvas` wrapper scales scenes, captions and narration. Music and effects audio stay outside it. The skill documents the rule, and a test keeps primitives and scenes from reading raw output dimensions.

**`audio_synth` sound effects.** `kind: "sfx"` without a `type` used to fail inside Python. A name such as `whoosh` or `impact-2` now implies the type. Any other name fails at once and lists the valid types. The schema offers the types as an enum.

**Smaller todo schema.** The batch `operations` items no longer repeat every field description from the top-level fields. That cuts characters from every request that carries the todo tool.

## 0.13.4 — 2026-09-28

**Kompress preprocessor on demand.** The Kompress paragraph selector (`pi-mini-preprocessor.service`) was still enabled at boot and kept its ONNX model resident with no session running. It now runs under the same owner-record guard as the local model. A session's client starts it when it loads, so the warmup finishes before the first large tool result, and again after a failed request. The guard stops it 90 seconds after the last live YunusPi process, so one session exiting never stops it under another. A request that timed out against a busy service does not trigger a restart. `ensureLocalServices` now throttles per unit.

## 0.13.3 — 2026-09-27

**Session-owned processes.** A session that was killed, or whose terminal closed before its shutdown handlers ran, used to leave its processes running: detached browsers, desktops, renders, background tasks and long bash jobs. Now each YunusPi process that starts such a group writes an owner record. The record holds the owner's start identity and one `pgid identity` line per group. The owner also starts one detached reaper (`scripts/process-owner.sh reap`). Once the owner is gone, the reaper stops only the recorded groups whose leader identity still matches. Only direct children that lead their own group are recorded, so a recycled or foreign pid is never signalled. This replaces managed bash's per-job watchdog.

**Local model on demand.** The local model service used to hold about 1.1 GB at all times. It is no longer enabled at boot. Sessions start it on demand, and the owner records act as its leases. Its guard stops it 90 seconds after the last live owner disappears, so one session exiting never stops the model while another is using it. A refused connection while the service warms up reports the model as unavailable without tripping the breaker.

**`/double` on dynamic catalogs.** A catalog published after the runtime's last snapshot, such as OrcaRouter's, never reached the available-model list. Every subagent, including both `/double` streams, then rejected the session's own active model within milliseconds. The model registry now keeps a publication revision, and the runtime reconciles its available list when it reads it. A timed-out stream is no longer relaunched into a window shorter than the one it already exhausted. An unavailable stream shows its cause in the progress row. Enabling `/double` in the middle of a run now says when the mode takes effect.

**Project memory isolation.** A session started in `/tmp` wrote a generated project id into `/tmp` itself. Every later project beneath it that had no Git remote, id file or project marker inherited that id, so unrelated temporary projects shared one vector-memory database. Generated ids are no longer written into the filesystem root, the home directory or the temp roots, which fall back to a path alias in the registry. An id file found in a world-writable temp root no longer anchors the projects beneath it.

**Tool argument recovery.** Each change below replaces an error that cost a turn in recent sessions:

- **Validator:** JSON-string arrays and objects are decoded. Result bounds over the limit are clamped: `limit`, `topK`, `max*`/`min*`, `timeoutMs` and `depth`.
- **`browser_session`:**
  - `resize`/`set_viewport` and the `expression`/`code`/`js` aliases are mapped to their real names.
  - A bare `evaluate` or `wait` expression returns its value.
  - `open` without a URL starts a blank tab that a later `navigate` fills.
- **`render_see`:**
  - `file:` URLs are decoded.
  - A local page keeps its `?query` as well as its `#route`; literal filenames still take precedence.
  - Loopback renders wait up to 3 seconds for a server that `bg_run` just started.
  - A WebGL page that is already served over HTTP now gets advice to open that URL in `browser_session`.
- **`creative_direct`:** accepts string `intent`/`avoid` lists and a bare `hierarchy`.

## 0.13.2 — 2026-09-27

Watchmaker stops paying for a review every minute. It used to read its unread events oldest-first, eight at a time, so during active work the review fell minutes behind. The leftover backlog also reset the quiet backoff after every silent review. Measured across recent sessions, 85–100% of its reviews returned no advice and it cost more than the main model. Now it folds long unread runs into one digest row, the same way the Observer does. Older failures and guardian interventions stay verbatim, and the newest work is always shown. Routine progress therefore no longer counts as backlog, so the backoff grows after quiet reviews (up to four minutes) and the Jev/Kev triage preflight can defer routine chunks. New failures, guardian interventions and salient events still force a full review.

The fixes below target the tool errors seen most in recent sessions:

- **Todo batches:** a batch that completes a dependency or child later in the same batch now applies its updates in dependency order. It no longer rejects the whole batch.
- **Browser sessions:** a guessed browser session alias resolves to the only open session, and `navigate` with no open session opens one. The result reports the resolution. Closed or unknown UUIDs still fail as `unknown-session`.
- **`skill_review`:** an unknown `group` becomes a search topic instead of an error, and the result lists the valid groups.
- **`git_info`:** outside a repository it reports that there is no Git state, with a hint to run `git init`, instead of failing.
- **UI slop inspection:** `artifact_check` accepts sources up to 192 KiB. It scans them in line-aligned windows with deduplicated findings, and the result reports the window count.
- **Hook metrics:** fingerprinting runs once per output sink, and the reported time covers only the handler.

## 0.13.1 — 2026-09-27

Double mode hardening, same architecture (`A ∥ B → reconcile → one directive → normal parent execution`). The twin streams now reason through complementary lenses on the identical route, thinking level, context and evidence: A constructs the strongest solution while B independently stress-tests for hidden assumptions, failure modes, contradictory evidence, simpler alternatives and edge cases. Reconciliation must compare evidence strength, assumptions, risks and proposed tool actions side by side, choose or define the deciding evidence on disagreement, treat agreement as unproven until independently evidenced, and preserve useful minority findings; a lone surviving stream gets an explicitly adversarial review instead of ever reading as consensus.

Same-route guarantees extend to the reconciliation pass: route and thinking substitution there now degrades the directive visibly, and fork-transcript thinking downgrades are surfaced rather than silent. A failed stream retries once only when the failure is plausibly transient (overload, rate limit, timeout, network) with deadline remaining; deterministic failures (budget, permissions, validation, unknown model) never retry. Progress rows add `retrying` and `route/thinking substituted` states without entering model context, and the status line reads "Twin first-pass (A ∥ B) + reconcile" so the extra inference is never mistaken for a literal 2× total. The read-only ceiling (read, grep, find, ls, git_info over a mutation-free agent, read-only git authority, no nesting) is unchanged and locked by regression tests covering concurrency, pinning, substitution, retry, cancellation, session moves, exact cost/lifecycle accounting and bounded output.

## 0.13.0 — 2026-09-27

Double mode: `/double` toggles a session mode in which every request is first analyzed by two independent streams of the currently selected model, then reconciled into one directive the normal turn executes. Both streams pin the same provider, model, thinking level and forked session context; the pin is verified rather than assumed, and a substituted stream stays usable but visibly degraded instead of passing silently. The streams are peer-aware but never see each other's reasoning; a lightweight reconciliation pass compares, challenges and commits their conclusions, proposals, risks and disagreements into a single plan. Streams investigate read-only and propose actions while only the parent executes, so no state-changing operation runs twice.

Progress rows show each stream and the reconciliation starting and finishing without entering model context. Degradation is explicit throughout: one failed stream continues on the survivor with a single bounded retry, a failed reconciliation falls back to both views with a commit instruction, and two failed streams continue as a normal single turn with a warning. Both streams account through the shared subagent cost and lifecycle ledgers, so `/cost` and `/used` reflect the doubled inference. `/double status` inspects the mode, `PI_DOUBLE=off` disables it, and children never re-double. The mechanism lives in a portable core (`agent/extensions/lib/double.ts`) with no harness imports, bound to the native subagent executor by a thin adapter. Regression coverage adds the core, runner and command-registration suites.

## 0.12.4 — 2026-09-27

A council brief is no longer lost partway through a long turn. The project-intelligence capsule that carries it was charged against the per-input context budget on every inference, even when unchanged, so after a few requests the budget refused it and the brief with it; one session then waited about fourteen minutes for a brief that never arrived. Unchanged capsules are now charged once. A retrieval with no matching entities, evidence or caveat injects nothing, instead of a capsule whose changing query header moved it to the tail on every tool call, broke the prompt cache and read to the model like a new prompt.

A subagent that reaches its tool-call cap is first asked to wrap up and gets a short grace (`PI_SUBAGENT_WRAP_UP_GRACE_TOOLS`, default 12) before the breaker stops it, so its findings are reported rather than cut off. A breaker stop now says which breaker stopped the child and that the user did not, and keeps the partial output.

Observer advice is discarded only when all of its cited evidence is changed task, TODO or child state; otherwise it is delivered with a caveat, so paid reviews are not thrown away. A Watchmaker memo that is slightly too long is clipped at a word boundary instead of rejected.

Tool argument recovery: `ui_explore` creates a missing output folder inside the workspace (paths outside it are still refused), `expert_director` accepts taste fields sent beside `action` instead of nested, and `subagent` accepts `tasks` or `chain` sent as a JSON string. Each of these failed repeatedly in recent sessions. Regression coverage extends the existing suites.

## 0.12.3 — 2026-09-27

Watchmaker uses recent completed results when assessing progress, labels repetition spans separately from execution time, qualifies advice when newer results arrive, and discards advice whose cited task state has changed. Potentially stale memos are not persisted. Councils cancelled by a follow-up persist terminal state and can later attach actual child usage without delivering obsolete advice. Verified shell reads of skills consume the existing guidance receipt, preventing repeated hints; unknown background handles explain the correct task registry.

The terminal footer and reports now share one core accounting implementation. Late native child IDs reconcile with their earlier wrapper receipts instead of double charging. Span provider charges are included, missing costs remain unknown, helper snapshots retain newer evidence, and background helper events flush through the existing health timer. `/used` counts observed main, auxiliary, child and judge models and shows one canonical child state. Shadow executions remain distinguishable from applied decisions. Cache diagnostics no longer double-count reasoning or present a character-based estimate as proven rebilling.

JEV analysis shares one bounded evidence packet across ranking, grouping and up to four additional criteria, with optional task-defining reference evidence. It retains complete category distributions and uncertainty rather than only the winner, rejects malformed partial distributions, and checks the actual serialized request budget. The adaptation follows [Just Ask Jev](https://arxiv.org/pdf/2609.29429v1); raw scores and existing heuristic thresholds are not claimed to be calibrated for the current task. A synthetic twelve-item categorized packet shrank from 34,045 to 22,377 characters by removing duplicated evidence, bringing it within the request limit; this is not a billed-token or accuracy measurement.

Image generation and reference editing can use the existing OpenRouter image provider and catalog. Explicit configuration keeps precedence; available credentials expose the route and models without a paid discovery call. Generated files must decode before becoming registered artifacts, and corrupt or cancelled outputs are cleaned up. Existing OpenAI-compatible generation and mask editing remain available.

The local Qwen service retains prefix reuse with four checkpoints and a 256 MiB prompt cache inside its 2 GiB memory limit, replacing runtime defaults that could exceed that limit. Choices and judgments share the configured request deadline instead of a conflicting shorter choice timeout. Service updates reuse verified assets and report restart failures accurately. Regression coverage extends existing suites; release tags still reuse the exact main commit's successful CI run.

## 0.12.2 — 2026-09-27

Resumed sessions retain explicitly activated tools within their existing authority. Native chain and parallel children now save each executed child's exact recovery contract, including its model and tool ceiling. Explicit parent follow-ups can resume stopped children; automatic recovery still respects cancellation. Status reports distinguish recoverable children from legacy runs whose contracts were never saved, and asynchronous dispatch allows independent work to continue.

Observer and Watchmaker use current task, TODO and child execution evidence. New prompts and changed premises invalidate stale advice before it changes durable notes or reaches the main agent. Recent tool outcomes survive packet pressure, and advisory notes no longer impose an artificial read/dispatch gate. JEV can assess routine progress even when new evidence is waiting, while urgent events retain a full review and a deferred review must run next.

Margin-note comparisons share one bounded JEV batch before smaller local Needle fallback jobs. Distinct or uncertain notes remain separate; cancellation prevents obsolete judgments from changing memory. Repeated identical Needle timeouts back off without disabling unrelated work or repeatedly destroying a warmed worker. A synthetic 24-note native fallback probe completed with no timeouts or restarts.

Guarded shell startup uses native traversal for its fresh hard-link inventory, preserving alias detection and failure on unreadable paths. Three paired local launches reduced median guard startup from 2.90 to 1.75 seconds; this measures guard overhead, not command or model latency. Existing regression suites cover the repaired transitions; release tags continue to reuse the exact commit's successful main CI run.

## 0.12.1 — 2026-09-26

Project memory keeps the foreground wait short while one bounded semantic request finishes for background consumers. Indexing drains the whole bounded event queue before network work, recovers embedding backlog on settled turns, reads the actual compaction event, and records final assistant reports as unverified evidence. Historical follow-ups are scoped to the current request and explicitly cannot supersede it. Provider timeouts remain visible, with compatible local vectors and lexical retrieval preserved.

JEV now makes applied scheduling decisions for Observer and Watchmaker: high-confidence routine progress can defer one repeated full review, retaining the evidence and requiring the next full review. New failures, salient events, backlog, uncertainty and helper failure retain full review. Large discovery shortlists go directly to one batched judge before local fallbacks. Every ranking question now receives the candidate evidence; the previous existence question could reject a correct ranking because it only saw the query. A live synthetic eight-candidate check selected the correct tool in 536 ms without the additional local ranking calls, and an unrelated request was rejected.

The usage report explicitly identifies its saved snapshot, capture time and age, and explains how to reopen it for current activity. Missing measurements are scoped to that snapshot; main conversation model counts are labeled separately from auxiliary and child activity. Sanitized exports retain executable video skill templates and public SVG regression fixtures that the extension allowlist previously omitted.

Guarded execution reuses directory-entry metadata while retaining a fresh hard-link inventory for every command. Maintenance guidance keeps temporary exports and dependency trees outside the live protected root, where accumulated historical copies otherwise slow every shell launch. Focused regressions extend existing suites; release tags continue to reuse the exact main-branch CI result.

Virtual desktop dependency checks follow PATH and require executable files, so user-local Xvfb and screenshot tools work without a system installation. Xvfb allocates each private display itself; concurrent starts respect the session limit, and failed or cancelled startup and capture operations clean up their owned processes.

## 0.12.0 — 2026-09-26

Auxiliary intelligence now has working shared entry points. Project memory applies its configured remote reranker after local Needle ranking, keeps usable local order on failure, and cancels abandoned waits through the core cancellation utility. The bounded micro-worker and routing comparison are exposed through one harness tool with native model dispatch, qualification evidence and explicit cost limits. The unused parallel prompt-advice call is removed; checkpoints and councils reuse mandatory prompt analysis. Qwen judgments and source-line selection share transport and admission rather than issuing independent competing requests. JEV, Needle, Qwen, paragraph compression, Guardian, fuzzy retrieval, skills, councils and reviewers retain their roles and enabled defaults.

Cancellation and failures reach their owners. Extension commands no longer launch after cancellation, signal termination is a failure, cancelled calls cannot remain stuck waiting on descendants or inherited pipes, and split UTF-8 output stays intact. Managed shell execution reuses the owned core process waiter. The maintained execution loop preserves tools' structured error flags. Intelligence clients snapshot mutable inputs, bound streamed response bytes, reject malformed rankings and worker schemas, enforce deadlines, and keep cancelled or caller-mutated results out of caches.

Reviewers retain one fresh undelivered note across later quiet, duplicate or failed reviews. Observer and Watchmaker share deduplication receipts only after delivery; Watchmaker resets on session replacement, restores older persisted memos, and records its own usage. Expert Director derives the pass budget from the existing branch ledger, so omitted arguments cannot restart the review loop. A late deployment check cannot clear a newer receipt.

Model selection reads pricing and exclusion evidence once per decision and reuses per-decision economy calculations. A 500-route synthetic fixture fell from 5,130 evidence-file stat calls to one; median selection time on the audit host fell from about 46 ms to 13 ms. The next decision still reads fresh evidence. This measures selector overhead, not provider latency or billed-token savings.

Housekeeping recognizes closed peer receipts, preserves live-session protection, and shares the installation lease with the updater. The verifier targets the selected installed launcher. The library manifest, generated capability inventory, release templates and SVG certainty regressions are synchronized. Behavioral regressions cover the repaired cancellation, cache, review, routing, cleanup and integration boundaries.

Jev handles larger decision packets through `micro_task` analysis: ranking, relevance and categorization share one call with compact IDs and source references. Review consolidation batches up to twelve comparisons and retains complete originals behind inspection while compacting repeated issue prose. The helper is available from the first turn, with task-specific guidance toward bounded analysis before a full child.

CI installs and builds once per branch run. Release tags verify that the exact commit passed the main workflow and reuse that evidence rather than repeating the suite. Local tests use bounded adaptive concurrency; UI checks share one browser with isolated contexts. Small duplicate test files are folded into existing suites. The extension loader resolves the shared cancellation subpath correctly in both source and bundled runtimes.

## 0.11.0 — 2026-09-26

The harness now coordinates domain excellence instead of leaving "make it great" to unguided inference. A new Expert Director infers the relevant excellence domain(s) from each request — web/UI design, visual art, SVG/iconography, motion, video, audio, frontend, backend, API, database, algorithms, distributed systems, security, ML, writing, or research — and loads bounded expert doctrine for exactly those domains: what excellent work looks like, the characteristic failure modes, the invariants, the deterministic checks, and the evidence required before claiming quality. Sixteen data-driven doctrine packs carry the knowledge, so new specialties arrive as data rather than orchestration changes, and retrieval exposes at most two packs and a bounded passage per brief.

Open-ended work explores before it commits. When a brief leaves the direction open, the Director asks for 2–3 materially different approaches with explicit choice criteria instead of accepting the first idea; transformations name what must survive before broad redesigns and verify it afterward. Per-task critic lenses assemble dynamically from the detected domains — art direction, typography, SVG geometry, timing, component architecture, concurrency, failure/recovery, threat models, leakage, calibration, argument structure, source quality, and more — running cheap deterministic checks first and routing genuine judgment to the existing review owners with bounded evidence packets. An explicit convergence policy stops the loop only when requirements are evidenced, invariants hold, checks pass, no substantive finding remains, and domain evidence is current; polish never blocks and spent budgets are reported, not looped.

Quality preferences persist as priors, not rules. A taste memory records explicit direction immediately and outcome signals only after repetition, scoped by user, project, and domain with provenance and confidence; contradictions lower confidence instead of deleting. Observer and Watchmaker receive domain focus and convergence rows, Guardian keeps its existing loop/evidence gating over the new tool evidence, and `micro_status`, `/metrics`, `/used`, and `/export-json` expose detected domains, doctrine, lenses, verdicts, and skipped layers. A 20-prompt calibration corpus pins inference with zero false positives/negatives, good/mediocre SVG and prose fixtures pin the deterministic check engines, and the extension graph, capability catalog, and generated inventory all cover the new surface.

Cheap intelligence moves into the harness itself. A span behavior sensor scores session traces for repeated failures, stall patterns and tool misuse in shadow-first record-only mode; typed Jev decisions route small judgments to bounded cheap-remote calls with cost accounting; a micro-worker answers narrow factual questions without tools or writes; an opt-in remote rerank stage sharpens retrieval while lexical stays default; a router shadow records what the model router would have done for offline comparison; and a model qualification lab benchmarks candidate routes before they serve traffic. Sensor scores stay advisory until deterministic evidence corroborates them, and `/metrics` reports sensor hits, shadow coverage and spend.

The reliability pass hardens the seams the long sessions found. Completion gates key on structured verification receipts instead of rendered strings, so reworded verdicts never reset a refusal; worktree checkpoints report clean, snapshotted, skipped or failed instead of vanishing; scope-council mutation waits bound at 30 seconds with deferred-protection receipts; filesystem-confirm waits reconcile against inclusive hook time with per-waiter accounting; vector-memory switch and shutdown drain queues instead of dropping them, with priority-aware eviction and cumulative drop counts; review routing gains content signals and tracked R# requirements; and local-LM availability no longer depends on the Smol preprocessor flag.

Creative work and task tracking close their loops. Art direction turns the scattered creative tools into one production cycle — structured briefs, implementation, real renders, visual and motion QA, asset registry, critique and fix — with completion waiting on judged re-review receipts instead of claims; the task-state graph becomes the canonical record of the work itself (stable ids, provenance, requirement blockers that feed the completion gate and observer packets) instead of each subsystem re-deriving reality from transcripts; and project vector memory is reworked end to end (embedder, index, retrieval, vector store) with atom counts and drop accounting visible in `project_memory_status`.

Two regressions from the 0.10.x history rewrite are repaired: isolated child roles carry LongCat authentication again (pinned by a regression test), and the release-template mirrors for four drifted docs plus the generated capability inventory are back in sync, which also repairs the red main-branch check.

## 0.10.11 — 2026-09-26

A slow change-scope council no longer taxes every turn. The context hook waited up to fifteen seconds for a running council on every context build, so each turn of a long deliberation paid the full wait again; per-session hook ledgers showed project-intelligence context averaging over a second a call with multi-second spikes. The first build of a council still waits for a quick brief, later builds render at once, and the first file mutation still waits for the brief before it is chosen. A lifecycle test pins the spend-once wait against a hanging council.

Session ends no longer stall on reworded verdicts. The completion gate keyed its refusal on the full verification lines, so recording the blocked assessment its own refusal asked for changed the receipt set and refused the repeated completion call afresh; the live validation session died on timeout one step from done after exactly this sequence. The gate now keys on the receipt head (source plus verdict): rewording never resets a refusal, while genuinely new verdicts, sources and counts still refuse afresh.

Safety confirms now leave accounted waits. One overnight session attributed 9.8 hours to 609 filesystem-safety hook records with zero blocks: user time at confirm dialogs, amplified when parallel calls share one dialog, misread as handler cost. Each confirm records its dialog, wait and decision, so hook-health diagnostics can separate user latency from handler cost. The visual pixel audit was verified correct against the live validation transcript rather than changed: the one unknown interface verdict came from a reviewer that read two of three required screenshots and passed anyway, which the harness rightly downgraded.

## 0.10.10 — 2026-09-26

`verify-harness.mjs` no longer reports every extension as a syntax error on Node 24. Node 24's `--check` parses TypeScript as JavaScript even with the strip-types flags, so running the documented `node ~/.pi/agent/scripts/verify-harness.mjs` with the system Node reported 183 false failures after the 0.10.9 deployment while the pinned Node 22 passed. The verifier now strips types in-process (positions preserved) and syntax-checks the module source on either runtime; a behavioral test runs the check on valid and broken TypeScript under the CI runtime.

## 0.10.9 — 2026-09-26

Port of the remaining session-evidenced live hotfixes. Observer and Watchmaker notes that never reached a provider request are now carried into the next delivery as receipted capsules instead of expiring on a wall clock; the edit-time status-ornament family generalizes live pills to any status word, adds glow-dot, eyebrow-pill and invented-label cues plus work-thought-leak, leak-vocabulary and vague-nav prose cues, with nested markup and one-cue-per-badge refinements so reminders and review keep sharing the same signals. Prose rules flag eyebrow-style and adjective-stacked label headings, bare vanity metrics and leaked making-of narration; `video_compose` offers all sixteen transitions from one exported list; `image_create` synthesizes deterministic procedural plates; the SVG audit flags default filter regions; rendered-noise checks catch eyebrow pills, literal status dots and sibling-layout dots; and routing hears fake-badge, invented-label and glow-dot complaints. Regression tests cover each port.

Independent review now produces verdicts instead of unknowns. Across twenty sessions with reviews since 2026-09-20 no round ended accepted and aspect outcomes were 329 unknown to 209 decided; the causes were harness defects, not missing evidence. The visual pixel audit read the tail of project-relative, home and URL paths (`build/verify/a.png` → `/verify/a.png`) as extra required images, failed every such interface review and discarded the reviewer's source-backed report with it; bare paths now start at a token boundary, and a rejection that concerns only pixels keeps the report as an explicit unknown. A reviewer that stalls, times out or returns nothing usable now hands its aspects once to a peer route that already returned a validated review, within the round deadline, instead of leaving them empty. A mid-review edit invalidates only the aspects whose files moved; the rest keep their verdicts and carry into the next round. Every behavior rubric now leads with goal fidelity: a tidy change that leaves the requested problem in place is a blocking finding that names the unmet part of the request.

Automatic teams learn from their own history. Reviews, councils, automatic assistance and skill discovery read the run ledger and move a route whose recent automatic runs mostly failed to finish behind reliable routes, using it only when nothing reliable remains (one route had finished 12 of 34 runs, averaging 239s, and still held a slot in every round). Harness verdicts, launch errors and stale runs never count against a route. Skill discovery runs its configured route without the route's thinking suffix, as its thinking-off selection intends: six of seven `:high` attempts had spent the whole first slice reasoning and returned nothing.

Recovery from the model's own tool mistakes replaces wasted turns: `todo` accepts `taskId` for `id`; `bg_run` keeps a declared `service` flag, which argument preparation had silently dropped, and infers `isAgent:false` for it; a unique prefix of an owned browser session id resolves; and a model route passed as a subagent name gets the exact corrected call. Native child sessions no longer list their own orchestrator as an independent sibling (a stray notice in every child context). The subagent model listing puts free and cheapest eligible routes first instead of alphabetical premium routes, and `render_see` tells agents how to turn a capture into project evidence instead of paying a browser-driving child for screenshots. Observer and Watchmaker persist a start line only when the route or settings change (the footer shows reviews in flight), and a route already at its lowest thinking level widens its output ceiling after a truncation instead of truncating repeatedly.

## 0.10.8 — 2026-09-26

Port of session-evidenced live fixes that were rejecting legitimate work. The self-mutation guard now allows harness-instructed `subagent-artifacts` writes under session directories while transcripts and session state stay protected; the child file verifier stops flagging out-of-tree helper writes and `.pi/subagents` artifact writes as out-of-scope edits; render sources accept `file:` URLs without mangling them onto the working directory; todo batch recovery coerces numeric-string ids before validation; and project test checks no longer mistake `curl`/`wget` write-out flags for watch mode. Regression tests cover each fix.

## 0.10.7 — 2026-09-26

Quality doctrine now reaches agents before the slop ships. Redesign, restyle and polish prompts plus generic-look complaints ("the homepage looks generic") route the anti-ai-slop workflow proactively instead of matching nothing; the website-build skill carries the necessity test and checklist pointer, so the workflow that wins the slot for plain website and blog builds teaches subtraction first. Review rubrics point at the resolvable `docs/ANTI-SLOP-CHECKLIST.md` path, and the content rubric holds promotional copy to specific supported claims over buzzword stacks, invented metrics and AI-provenance clutter.

Edit-time cues get sharper and less repetitive. A catch or except block that only logs now cues the same contract check as an empty catch, mirroring the explicit code-quality rule. Hype-density cues nest: a buzzword stack subsumes the stock cluster, and the generated-prose cue needs two distinct tell kinds, so one buzzword-dense paragraph reports once with the strongest check instead of three times.

This release also repairs the 0.10.6 test mirror: the committed `video-motion-upgrade` suite is now mirrored to the release template, and the template changelog is synchronized with the root changelog.

## 0.10.6 — 2026-09-26

Motion graphics, code-to-video and sound take a substantial step forward. The Remotion template gains four progress-driven primitives — `LowerThird` speaker captions, `Counter` jitter-free counting numbers, `ProgressBar` stepped story tracking and `Callout` diagram annotations — plus a dependency-free `src/timing.ts` (`beat`, `pulse`, `beatCount`, `loopProgress`, `pingpong`, `hold`, re-exported by `motion.ts`) so picture and the `audio_synth` bed share one clock, and vertical `slideup`/`slidedown` scene entries alongside the existing transitions.

Timeline checks get stricter where it matters and stay silent otherwise. `video_project check` validates the new transitions, warns when `musicDuckedVolume` sits at or above `musicVolume` or a caption line runs past ~24 characters/s (`captionPace` in the template is the single source), and bounds mix volumes and per-sfx volume. `narration_tts synthesize` accepts a pronunciation `lexicon` (`{"Vaswani": "Vas-wah-nee"}`), applied to the spoken text only while `video.json` keeps the display spelling for captions and on-screen text; per-scene `lexiconEdits` report what changed.

Procedural sound grows without changing existing bytes. The synth gains a `drums` music layer (kick on beats 1 and 3, eighth hats, intensity-automated, off by default so historical specs render identically) and `downlifter`/`pop` effects. `music_compose` auditions add band-limited `square`/`saw` oscillators beside sine/triangle, per-track `pan`, and `stereo:true` constant-power mixes; mono sine/triangle output is byte-identical to before.

Six session-hook rules carry the video review loop: timeline checks, render review, QA review, narration fit, synth balance and timeline-compose review fire once per session on their tools. The tool-source inventory now enumerates the `video-studio.ts` factory, so `video_project`, `video_render`, `video_qa`, `narration_tts` and `audio_synth` appear in the capability inventory and the hook bindings verify against it. Skills (`remotion-video`, `code-first-video` narration/sound and QA references, `procedural-audio`, `music-composition`) document the new primitives, beat sync, lexicon, drums and waveforms. Eight new `video-motion-upgrade` tests pin timing, pace, lexicon, drum determinism, score stereo imaging, hooks and template wiring.

## 0.10.5 — 2026-09-26

Ports the local runtime's stream-idle hotfix into the reviewed tree. The main agent reaches providers through `ModelRuntime.stream`/`streamSimple`, and without the idle wrapper a stalled provider stream hangs the turn silently (measured: 14 minutes with no error until the user aborts). Both paths now run inside the shared `piWithStreamIdle` budget, so a stalled stream surfaces as a stream error and retry/recovery runs instead. The port is byte-identical to the production-proven live hotfix; this also unblocks local installation parity for the 0.10.4 edge-case hardening.

## 0.10.4 — 2026-09-26

Edge-case hardening across the harness: silent failures now leave traces, corrupt state degrades instead of lying, and session switches start clean windows.

Failures that used to vanish are now visible. The harness event bus reports handler errors that have no subscribers instead of dropping them. Skill discovery keeps the skills it already collected when a directory cannot be read and records which subtree stopped. Sibling peer scans that fail report truncation rather than an empty peer list, so overlap warnings are not silently suppressed. Checkpoint state reads distinguish a missing file from corruption or permission faults, and failed state writes leave a shadow trace plus a throttled warning instead of pretending the restore point was saved. Terminate tracking in session signals and reminders tolerates tool results that never arrive.

Budgets and memory fail closed instead of open. An unreadable or corrupt subagent economy config keeps the last-good ceilings and flags the failure instead of silently relaxing to defaults; invalid values still throw their actionable validation error. Memory recall failures are recorded separately from genuinely empty results and surface in memory status. Run-history storage faults are flagged instead of reading as clean history, and every child wall-clock timeout now cools its route in shared provider health so the next selection can skip a stalling route.

Stale state no longer leaks across session switches. Checkpoints and session signals share one reset path for session start, switch, and branch events, so strikes, pending notices, thresholds, and terminating-tool tracking cannot bleed into the next session. Context-profile disk state is normalized field by field on load, so a corrupt file degrades to defaults instead of breaking the diagnostics tool. A second deploy in one session disposes the previous deploy notice before registering its own.

## 0.10.3 — 2026-09-26

Tool and hook integrity fixes. Session-hook guidance no longer names the retired `context_code` tool: the empty-search hook points at identifier-ranked `symbol_search` with a shorter identifier, and repeated-read guidance offers only registered structural tools. A new regression test pins every hook rule binding and every guidance tool reference to the registered tool universe.

The installed-verifier manifest now registers the live `completion-gate.ts` and `requirement-ledger.ts` libraries, closing the integrity blind spot for deploy/completion gating and the requirement ledger. The capability inventory is regenerated for the current tool registrations.

Anti-slop UI/UX coverage expands across every layer. Sixteen new edit-time cues flag pill clusters, hype badges, gradient text, glass panels, oversized type, rounded excess, emoji chrome, fake terminals, missing alt, unnamed icon buttons, skipped headings, autoplaying carousels, custom cursors, transformation CTAs, vague headings and placeholder identities — each with negative controls so legitimate filters, code samples, docs examples and single functional treatments stay quiet. Rendered audits match: `design_audit` counts oversized type and heavy radius, while the noise scanner reports missing alt, unnamed controls, emoji chrome, hype badge clusters and fake terminals with locations. Rendered findings join the quality-review cue set, the interface rubric and design preflight name every family, and de-slop plus ornament-specific complaints route the anti-slop workflows.

## 0.10.1 — 2026-09-26

UI review now enforces standing anti-slop constraints through the existing checkpoint. Large edits and command-generated source retain bounded checks; interactive browser captures and `render_see` share findings. Visible `aria-hidden` SVG branding, full-width heading dots and decorative markers inside large live regions no longer escape inspection. Interface reviewers must read changed implementation source, budget representative screenshots, and compare baseline/final evidence for visual, 3D and motion upgrades. Unaddressed policy cues block acceptance unless repaired or dismissed with specific evidence; they remain separate from independent reviewer reports.

Project memory keeps new history in a compatible Needle3 space when remote indexing fails and incrementally backfills OpenRouter during later ingestion. Explicit migrations retain their selected backend. Automatic recall reserves time for lexical results when semantic work is slow, and activity reports distinguish skipped remote work from completed local fallback.

LongCat joins authenticated live model discovery using `LONGCAT_API_KEY`, current catalog limits and the documented binary thinking switch. Unknown prices/capabilities stay unknown. Streaming native tool calls and tool-result continuation are verified against both `LongCat-2.5-Preview` and `LongCat-2.0`.

This release also includes the concurrent startup, checkpoint, advisor and fleet fixes: prompt analysis leaves the input critical path, tests and reviews share one workspace revision, repeated or stale advisor notes are suppressed, stalled routes receive bounded cooldowns, persistent services avoid completion wakeups, and private worktree checkpoints retain interrupted work.

## 0.10.0 — 2026-09-25

Project memory supports OpenRouter embeddings with `qwen/qwen3-embedding-8b` as its default remote model. Local-first auto selection, explicit model/space metadata, dimension checks, secret redaction, batched incremental migration and compatible-vector fallback preserve the existing SQLite/FTS5 index. Exact technical lookups avoid remote calls. Main/subagent priming and Observer/Watchmaker history share retrieval work, and status plus auxiliary cost receipts make degradation and spend visible. Consolidation reuses stored vectors instead of re-embedding history. The reproducible comparison is in `docs/PROJECT-MEMORY-EVALUATION.md`.

Local Qwen can promote a confident candidate in tool, command and skill shortlists using one token, the shared queue and prefix cache. Uncertain decisions preserve the existing fallback and all candidates. Cancellation includes queue time; waiting requests respect an opened breaker. Jev and OpenRouter Kev split healthy traffic and fail over within a common deadline, retaining cache/model attribution and per-route health.

Video frame and proxy scaling now preserve display aspect ratio using filters supported by FFmpeg 6, fixing the Ubuntu CI failure that blocked recent releases. Regression tests cover non-square input pixels.

## 0.9.3 — 2026-09-25

The local language model is fast and stops pretending to work. Qwen3.5-0.8B is a hybrid recurrent model, so llama.cpp could never reuse a cached prompt prefix: context checkpoints were only taken every 8,192 tokens and every judgement re-read its whole few-shot prompt. The service now keeps checkpoints at any length and gives prompt processing six threads, and the client processes each constant few-shot prefix once, re-warming automatically when the server reports it lost it. A skill-relevance or mutation-intent judgement drops from about 1.1 s to about 0.18 s with identical probabilities.

The line selector said "skipped · input shape unsupported" for almost everything: of about 1,550 recorded offers none was ever applied. Every row containing a digit, a slash or a dotted name counted as a protected fact, and a long prompt's 64 task terms matched most rows, so it always abstained under a misleading label. Protection is now status facts plus qualified facts on rows that are not part of a repeated template, with the four strongest task matches. `read`, `grep`, `find`, `ls` and bash file views (`cat`, `sed -n`, `grep`, `git show`…) are requested content and stay exact instead of costing an `obs_read` round trip. Skip reasons say what happened (control characters, too many lines, already compact, requested content). The model sees a 1.5 KB prompt without the lines the host already keeps, and first exposure waits one measured inference. An UNKNOWN answer still leaves the output untouched: on real harness output the facts alone would have dropped rows the agent printed on purpose.

Guardian, verification and similarity. Verification tracking stays reliable across edits and asynchronous checks. Guardian advice is coordinated with the Observer and Mr. Watchmaker, with session isolation. Detector budgets are fairer, and OFF/ON evidence is handled cleanly. C++/WASM similarity scores are unchanged but about four times faster for typical shapes in the kernel benchmark.

## 0.9.2 — 2026-09-25

Sessions no longer stall behind their own preparation. The automatic scope council held the first model turn for up to four minutes and then discarded its work: the version baseline was captured before the request's own message was saved, so every finished council read as "version changed", and a synthesis that missed the shared deadline took both finished perspectives down with it. The first inference now waits at most 15 seconds; the agent reads while the council deliberates, the first file edit waits for the brief and is re-checked against it once, finished perspectives survive a late synthesis as a partial result, and synthesis is capped at 90 seconds. Aborted council peers still record their accounting, so the cost total no longer stays partial.

The Observer and Mr. Watchmaker stopped arguing with the agent and each other. Neither reviews before the agent's first response of a task, and harness-owned runs (councils, skill discovery, automatic review) are reported separately instead of as children the agent must "harvest". Each reviewer sees the other's latest delivered note and suppresses restatements; a paraphrase that only re-pushes tools already recommended is a repeat. A Watchmaker memo no longer schedules the next review by itself, its answer allowance fits low-thinking routes (4,096 tokens), and its notices say "Watchmaker" instead of "Observer". Verification detection counts `project_tests`, compilers, `--self-test` flags and project test scripts, so a Java project checked with `javac` and `./run.sh --self-test` is no longer called "unverified". A note that also rests on other evidence is delivered with a caveat when the command it cited finishes, instead of being thrown away. Notice headers keep their beginning ("Returned advice in 84s", not "rned advice").

Footer numbers are honest. Flat token and coding plans (step plan, token plan, coding plan, Kimi Coding, Streamlake) count as subscriptions everywhere, including background reviewers, instead of as unknown spend; `$` is metered spend across the main agent, councils, subagents, JEV and auxiliary calls. CH is the main agent's token-weighted cache hit rate on the current model, counting genuine misses (Anthropic responses now report explicit cache counters). The agent count no longer doubles helper runs while they are in flight.

Premium visuals are a first-class output. The 3D scene studio gained a `luminous` frosted-glass style and per-object `glass`, `matte`, `metal` and `emissive` materials (transmission, clearcoat, thin-film iridescence), `arch`, `disc` and `capsule` forms, spot lights with soft penumbra, gradient backdrops with glow, volumetric light beams, soft shadows and a compositing pass (highlight bloom, film grain, vignette), plus a `keyvisual` preset. The new `key-visual-art-direction` skill carries the craft (idea, light, material, palette, composition, motion, review loop, visual anti-slop), and key-visual, logo-reveal, banner and motion-ad prompts stage the scene tools on the first turn.

Anti-slop now covers color, order, placement, prose and the stock generated-UI ornaments. Edit-time cues flag the default indigo-to-pink palette, hue sprawl without tokens, centered-everything layouts, the template landing-section sequence, chatbot prose tells (via the shared prose checker), colored left accent rails, decorative dot markers and icons boxed in tinted tiles; `design_audit` measures accent rails from 2px (including pseudo-element bars), decorative dots and icon tiles on the rendered page. The `anti-ai-slop` skill lists them under "Never produce".

Domain work routes to the right guidance. New `data-analysis` and `financial-modeling` skills; statistics (power, sample-ratio mismatch, peeking, CUPED, multiple testing), verification (a double-check protocol) and marketing (unit economics, ad and landing copy, creative testing, attribution) skills were deepened; and debugging, data analysis, A/B tests, ML modeling, financial models, ad copy, double-checking, planning and pitch decks now reach their skills. A quality-review repair round re-reviews only the aspects its changes touch, carrying clean passes forward, and `subagent` status on a harness-owned run explains it instead of reporting "not found".

## 0.9.1 — 2026-09-25

Media work is faster and cheaper to inspect. `video_frames` extracts its frames with four bounded workers instead of one slow queue, keeping timestamp order and decoded-PTS evidence, and `contactSheet:true` tiles the sample into one contact sheet with a cell map so a single visual read covers up to twelve frames; the sheet geometry is asserted from decoded pixels. `image_crop` decodes once and cuts every region in memory when the source fits the per-target pixel bound, with identical regions proving no target mutates the shared decode, and every studio tool reuses its probe instead of re-probing the same bytes. `media_info capabilities` runs its six subprocess probes in one round rather than six. Singular subprocess savings are small; together they remove the gratuitous process churn from every media call.

The website anti-slop rules are now harness doctrine, not chat text. `docs/ANTI-SLOP-CHECKLIST.md` carries the full 200-rule checklist with the core principle, the ten-question decision test and the final rule; the Observer Book's new `anti-slop` chapter distills it into eight reviewable passages that promotion tests prove surface on website-slop vocabulary. The `anti-ai-slop` skill and its necessity catalog, the `mockup-to-code` failure modes and the quality-review interface rubric all point at the same rules. `code_quality prose` learned the checklist's copy tells — the extended "unlock" family (including the previously missed "your" form), vague-adjective and self-praise patterns, rhetorical filler, "not just X but Y" and emoji headings — with clean copy staying clean.

Two stale-test failures and one stale mirror are fixed. The popup tests expected fixed filenames from before per-invocation cache-busting names; they now resolve the written file and pass. The release-template copy of the installer missed the `projects/` state-preservation line and drifted from its source; the mirror is resynced and the integrity test is green again.

Token spend was measured rather than guessed. The always-on wire carries 23 core extension tools at about 43,000 description and schema characters (~11k tokens) plus ~3,700 in prompt guidelines, dominated by delegation, background-task and todo contract text that stays because trimming it would trade behavior for tokens. Provider serialization was verified to send only tool-result `content`, never the duplicated `details` object. The numbers are recorded in the cost-accounting doc as the baseline for future work.

## 0.9.0 — 2026-09-25

Error paths now name what went wrong, mined from a live session export. Todo refusals list the blocking tasks as `#id "subject" (status)`, attributed through parent inheritance with a bounded tail, and completion refusals name the unfinished children; missing dependency ids surface as `(missing)` instead of refusing silently. An unknown subagent name gets ranked suggestions over names, local names and aliases (edit distance, transposition, shared substring), and `delegate` answers to the `generic` alias the session reached for. A status lookup for an unknown async run names the newest known runs as `id (state)`, live runs first. Failed children keep a structured excerpt — reason, cause, timeout and exit code — instead of a bare "Child failed", and the shared reason table classifies failures the same way everywhere. Failure categorization guards the failure-category field and separates input errors from edit conflicts.

Guardian watches for failure bursts and quality review can no longer starve. Four consecutive fingerprintable failures across varied operations raise one burst intervention per episode instead of staying idle through a long failing session, and verification fingerprints compare correctly. A review need deferred behind running tests escalates after three settled deferrals: the stuck-need round runs with its results delivered as guidance rather than waiting forever. Reviews of DOM-generating scripts select the interface aspect when markup-shape cues fire, so an app.js-only UI change still demands rendered verification.

Design work gets recovery, measurement and teeth. A partial council brief with no synthesis says so plainly — the council chose nothing, silently keeping a default is not a decision — after a session read the first finished perspective as the verdict. `design_audit` counts rendered AI-slop signatures with computed styles: pill clusters, glow halos, gradient text, glass panels and text glow, each with a locating finding past a disclosed threshold (counts, never verdicts). Markup-shape anti-slop cues now scan JavaScript and TypeScript sources while stylesheet cues stay scoped to stylesheets.

Rendering is cheaper and more precise. Remote renders run a bounded readiness probe first: connection-level failures return the structured navigation failure immediately instead of paying a browser launch, while timeouts, TLS and HTTP statuses still proceed to full navigation. A text-output render of a missing local source echoes the caller-supplied path, with HTTP queries stripped and helper-executable failures on their own classification. The final subagent output keeps every text part of the latest substantive assistant message, so a hook-appended trailing notice no longer discards the actual answer. A trailing ` (note)` in a declared check command is named as a probable annotation with the bare-command action instead of a generic shell-operators rejection.

## 0.8.0 — 2026-09-25

The session observer sees the whole session and can look closer. Every review carries all of the session's user prompts (not only the latest), the harness interpretation of the newest one labelled as a helper's reading, and the user's active reminders as standing instructions; reminder deliveries, Guardian interventions, hook firings and guidance sent to the agent arrive as labelled events. An in-memory journal keeps the full text behind every excerpt, and during a review the observer may use bounded read-only tools: `session_detail`, `session_search`, `read_file` (inside the project, secrets refused), `grep_files` and `book_read`, at most three rounds of four calls. Its instructions now ask for the single most valuable note: the user's full intent across prompts and reminders, claims against evidence, waste and tool or skill fit for the phase, and expert quality including originality. Paid reviews are no longer discarded for an unknown id or tool name: unknown identifiers are removed, uncited notes are delivered with a caveat, and over-long notes are shortened. Truncated or timed-out reviews step thinking down for the next review and clean reviews restore it; the output allowance is 8,192 tokens and packets are 10,000 bytes.

SmolLM2-135M is replaced by a local language model that is actually useful: Qwen3.5-0.8B (Apache-2.0) on a pinned llama.cpp server, installed as a loopback user service by `local-lm-assets.mjs` (checksummed, atomic, retires the old service and weights) and by the installer on Linux x86-64 unless `--skip-local-lm`. On real harness decisions it judged skill relevance with AUC 0.88 (SmolLM2: 0.53, chance). It now gates catalog-wide "session context" skill hints, so a music blog no longer gets an ERP reference or another company's brand kit; decides the fail-safe side of the mutation pre-screen before any paid judge; and selects lines from large successful tool output, with relaxed eligibility (status words are retained by the host, not a reason to abstain) and a wait sized to one inference so selections arrive in time.

Guardian gained three detectors and bash coverage. The WASM-scored repeated-failure detector now includes shell commands, fingerprinting long output by head and tail. New deterministic detectors remind the agent to re-read a file after three varied failed edits, to reuse an earlier read after four identical reads, and, once per change set, to verify or state what is unverified when a final reply claims completion after unverified edits. Every WASM verdict is a visible line with its score and threshold, and interventions render as Guardian notices.

The terminal is clearer and harder to break. Routine background work is one live footer line (`harness · Guardian 14 checks · 2 WASM · Needle3 6 · local LM 3 · hooks 2 …`) instead of hundreds of heartbeat, router-match and ranking lines. Hook firings, Guardian verdicts and local-model gating are individual lines. Reminders, Guardian interventions and observer notes render as titled notices with expandable detail. Warnings, errors, status lines and fallback messages pass one sanitizer that removes escape sequences, carriage-return overwrites, control characters and bidirectional overrides. A chain step whose active step was a parallel group crashed its progress label (`groupStart is not defined`); it renders again.

Design and open-ended work get deliberate direction. Prompt analysis reports whether a request is open-ended or visual and separates style references from sites mentioned only for a link, credit or deployment. A new open visual brief receives a divergence protocol (audience and character, peer study, three distinct directions, explicit choice) and context-only references are named as such; refinement keeps its design language. The automatic council runs in design-direction mode for such briefs, the quality-review interface rubric flags look-alike reuse and category-default output, and the Observer Book adds passages on references as context, diverging before converging, and thought experiments for open requests. The interpretation block given to the main agent now says it reads the user message directly above and that the user wins.

Fixes from live sessions. "Only use HTML, CSS, JavaScript and PHP" was read as a model pin and disabled the observer, independent reviews and fallback for a whole session; a pin now needs a route-shaped target. PHP templates without a closing `?>` were reported as orphan `</div>` and three finished workers were rejected; PHP masking now keeps heredoc templates. Over-long explanation fields are shortened with a marker instead of failing the call, `project_tests` splits chains of valid checks instead of rejecting them, Jev trims oversized evidence instead of refusing it, and a multi-line `/reminder` is delivered as one line. New hooks ask for a live-site check after production deploys and a rendered look at the first interface file.

Linux remains the full target; Windows uses WSL2 and macOS can use a Linux VM.

## 0.7.0 — 2026-09-24

The session observer now reads and cites a book. The Observer Book ships 58 Markdown chapters with 400 passages of working doctrine across engineering, architecture, testing, security, performance, UI/UX, color and type theory, minimalism, modern web design, motion and video, Linux, DevOps, DataOps, mathematics, science, statistics, ML and LLMs, research, product, marketing, promotion, copywriting and communication. Each passage states a principle, its reasoning, when it applies, a question to ask and common traps. A deterministic session profile (phase, edits, verification runs, repeated errors, completion claims, plans, children) and watch predicates (edits with no rendered check, unverified completion claims, repeated failures, secrets, dependencies, CI, containers, migrations, long foreground runs) promote the relevant passages with a measured flag line. Passage ranking combines chapter relevance, diversity, rotation and rest after citation, and fuses Needle3 when that worker is already serving; the observer never starts or waits for it. The observer can cite passages, ask to read a chapter first, and keep screened per-project margin notes with expiry and tombstones. Notes are written under a cross-process lock, so sessions sharing a checkout keep each other's notes and never assign one id twice. `/observer-book` shows the book's status, table of contents, passages and margin notes, and can turn the book off for a session.

Observer reviews also cost less. Static rules and the book's contents now come before changing evidence, so provider prefix caching applies. The book has its own byte budget. Quiet reviews and repeated failures back off (60, 120, then 240 seconds) until a salient event arrives. Model-routing evidence is sent only when it bears on the review. A route that fails two reviews in a row cools down while the next configured route serves; a timed-out review counts once, although it reports at its deadline and again when the cancelled request settles. Discoverable tools are named together with their activation call.

A design-to-code studio adds four tools and a `mockup-to-code` skill. `image_analyze` maps a mockup, screenshot or image URL into page bands with guessed roles and blocks classified as text, CSS, SVG or raster. It also reports a structural palette with contrast, a type scale derived from ink height and line pitch, spacing, container, columns and repeated components, and writes a design map, an annotated overlay and CSS tokens. `image_crop` cuts assets at source resolution, with edge-connected background keying and de-fringing. `image_trace` vectorizes flat marks into compact SVG and reports fidelity. `visual_diff` renders a build at the reference width, slicing long pages, and reports SSIM, spacing drift per band, hot regions with zoomed crops, and missing colors. The skill covers element decisions, build order, the fidelity loop, and extending one or two reference images to a whole site. Images decode from stdin, and URLs go through the SSRF-guarded fetcher.

Code quality has its own tool. `code_quality` finds token clones (including renamed ones), code slop, prose problems and function complexity. With `changed:true` it checks a branch. The post-edit hook adds high-precision slop hints and points out new blocks that repeat nearby code. `git_info` gains `review` (pre-commit risk flags, lockfile drift, focused tests, secret-like additions) and `blame`. A bash `git commit` whose staged changes contain secret-like strings or conflict markers is stopped. When a person is present they are asked instead, and `PI_COMMIT_SECRET_GUARD=off` disables the guard. The new checker found unused imports across extensions, and they were removed.

`memory_search` no longer depends on qmd. A built-in BM25 index serves every mode when qmd is missing or broken. It tolerates typos and inflections, weights recent daily logs, redacts token-like strings, and can search every project with `scope:"all"`. In semantic and deep modes, an already healthy Needle3 worker reranks the lexical head. `web_research` now reads the strongest sources first instead of in discovery order. It ranks candidates by agreement across queries, title overlap, and primary hosts, demotes social and aggregator hosts, and spreads reads across sites. Each receipt says why the source was chosen.

The video studio's per-scene transitions were declared in `video.json` but never rendered; they now animate. Narration captions are timed from the measured narration length and burned in, and the final render writes matching `captions.srt` and `captions.vtt`. New frame-deterministic primitives add kinetic text, an audio spectrum driven by the actual soundtrack, film grain, light leaks, camera moves and glitch. They were verified by rendering stills and a final scene with Remotion.

`desktop_session` drives desktop applications (Electron, GTK, Qt, X11) in a private Xvfb display owned by the session. It provides window lists with geometry, screenshots that vision models can read, click, drag, scroll, typing and key input, title waits and process logs. Launch commands pass the same filesystem-safety review as bash, and processes end with the session. The tool needs Xvfb, xdotool and the X11 utilities on Linux. CI installs them and runs the end-to-end test.

Tools now reach the model without a reminder or a discovery round trip. Prompts about implementing a mockup, making a video, reviewing quality or preparing a commit, or working with desktop apps stage the matching tools for the first model turn. An end-to-end test through the real SDK shows this, and shows that an ordinary bug-fix prompt stays lean. When a command uses a specialist tool that is installed but inactive, the bash router says once how to enable it.

Local intelligence reaches more real work. Kompress previously admitted none of this repository's 253 Markdown files in its size range. It now accepts headings, lists, tables, quotes, front matter, link rows and printable Unicode; structural paragraphs are always kept, and the client and worker share one tested gate. On those files the savings admission still finds nothing worth omitting, so routing now offers output to Kompress only when a selection could pay for itself. Output Kompress cannot shorten stays with Smol and Jev instead of ending routing. The worker spends its ten-second inference slot only when inference runs, and it marks earlier refusals so clients skip the cooldown. Guardian compares failure text after normalizing generated IDs, clock times, elapsed durations and temporary paths. A retried call that fails the same way with a new run ID now reaches the WASM kernels; plain numbers stay significant.

Linux remains the full target; Windows uses WSL2 and macOS can use a Linux VM.

## 0.6.6 — 2026-09-24

Sessions now start knowing what the previous one left unfinished. The automatic exit summary's Follow-ups list for the project is carried into the next session's one-time priming even when the new prompt shares no words with it (a plain "continue" used to receive nothing), labelled as historical and bounded, with secrets skipped. Projects with CI configuration also get their workflow names and, for GitHub origins, the Actions result for the current HEAD commit, fetched once in the background at session start (2.5 s timeout, `GITHUB_TOKEN`/`GH_TOKEN` when set, skipped offline, never delaying the first request by more than 300 ms). The agent is told that a failing or missing run for a pushed commit is unfinished work. A one-line `Continuity ·` TUI notice shows what was carried.

Needle3 now contributes where it measurably helps. On real session data its top-vs-second margins never exceeded 0.013, so the 0.02 acceptance bar discarded its ranking every time. Ranking still carries signal (18 skill requests over the 242-skill catalog: top-5 hits 10 Needle, 10 lexical, 13 fused), so `tool_search`, `skill_review` search and observation queries fuse a low-margin Needle order with the lexical order by reciprocal rank. Zero-shot classification did not carry signal (request families agreed with deterministic cues on 1 of 20 real prompts; tool-error families reached 31% even with exemplars), so the per-prompt request pass and the per-error family cue were removed, which keeps the serial Needle worker free for ranking. Deterministic request families now recognise everyday verbs such as make, remove, update and turn … into (9 of 20 recorded prompts were previously "unknown").

Updates keep at most two automatic installation backups (`YUNUSPI_BACKUP_RETAIN`, default 2); 28 had accumulated. Manually named backups are never pruned.

## 0.6.5 — 2026-09-24

Makes the automatic reviewers and local intelligence produce value instead of discarded or idle work, without new model calls. The session observer no longer throws away finished paid reviews because todo, child or completed-tool state moved on during the review (measured 18 of 20 reviews discarded in one active session), or because older events left its bounded queue. A note is withheld only when its premise is gone: every cited running command finished, the model changed, or routing advice weighed child state that has since changed. Other notes are delivered with a caveat naming the changed state. A finished tool call replaces its unread start event, halving queue pressure and the resulting coverage loss. An unchanged idle state is reported once instead of as a new numbered "review" every 90 seconds.

JEV skill discovery fits its 32 KiB input budget: it sends the evidence, not a second copy of the catalog, and shortlists large catalogs lexically. Previously every discovery over a large skill catalog skipped JEV and launched a paid general-model child. A confident JEV pick now avoids that child; a no-fit verdict over a shortlist keeps the fallback. JEV output distillation now receives the task, protects terminal output by outcome signals instead of any digit or path, and gets one bounded wait (at most 1.5 s, only before a result's first render), so a paid selection can reach context instead of arriving after the render was sealed. Smol accepts printable Unicode terminal output (✓, →, tree glyphs); control, ANSI, bidi and zero-width characters stay excluded.

The `todo` tool recovers batch operations that omit `action` when the intent is unambiguous (positive id: update; subject: create), the cause of most recorded todo validation failures and their repeated turns. The TUI labels a skill router match as a match rather than a read, shows a repeated match of the same skill at most every ten minutes, and reports an unchanged Guardian state at most every five minutes while state changes still appear at once.

## 0.6.4 — 2026-09-24

Improves coordination within the existing inference budgets. Identical JEV judgments now share cache entries and in-flight work across caller sites; a cancelled caller cannot retain the paid usage record for an answer delivered to another caller. Regression fixtures verify one request instead of two for duplicate questions. Prompt analysis accepts a complete, validated JSON advisory even when the provider reports reaching its output limit; partial JSON still uses bounded recovery. Failed preview sends remain eligible for display retry, and a session change during a display send discards the old advisory before model-context insertion.

The observer retains chronological evidence when changed state invalidates a review. Its bounded summaries prioritize active todos and unresolved child outcomes, including recorded failure reasons, so completed history cannot hide work needing attention. Review cadence, deadlines, packet sizes and output caps are unchanged.

Automatic teams preserve preference order while counting provider aliases of the same model as one reviewer. Explicit instructions not to spawn agents or helpers suppress automatic delegation. Cross-session messages preserve recorded timestamp order, and the activity footer clears completed helper labels when work ends.

## 0.6.3 — 2026-09-24

The session observer now has three minutes to finish a review, with elapsed/allowed-time check-ins while the main agent continues. This allowance is independent of the 30-second review cadence and 120-second visible check-in bound. Timeout recovery retains the evidence chunk; cancellation, stale-state validation, duplicate suppression and verified main-agent delivery remain enforced.

Automatic research assistants also receive three minutes for their investigation and final answer. Their enclosing watchdog includes cleanup time instead of cancelling otherwise healthy work after 35 seconds. Existing tool, token and cost budgets remain active.

The `/used` dashboard joins legacy helper wrappers to their underlying child only when exact run evidence agrees, so one stopped investigation is not counted twice. Task and run rows show specific causes such as timeout, authentication or quota failure, with expandable execution and retry evidence. Configured assistants are labelled without an unsupported claim that their model is free.

## 0.6.2 — 2026-09-24

Prompt analysis gives preferred providers two minutes per route and both initial and follow-up requests a four-minute overall deadline. A first-route timeout leaves a full two-minute fallback allowance; fast responses return immediately. The TUI shows each attempt's elapsed and allowed time. Provider-originated aborts advance to the fallback instead of silently cancelling the entire analysis, while user cancellation remains immediate. Virtual-time regression tests cover slow preferred responses, slow fallbacks, stalled providers and cancellation.

## 0.6.1 — 2026-09-24

Repairs provider configuration and helper execution without replacing the 0.6.0 features. Empty overrides for an existing provider preserve its built-in models and authentication; incomplete custom providers still report errors. Codex models are discovered from the official account catalog, including account-scoped cache validation, visible model filtering and explicit unknown pricing/output-limit evidence. Catalogs refresh at turn boundaries during long sessions. Inspecting model preferences no longer emits runtime fallback warnings or consumes their deduplication state.

Prompt analysis gives the preferred route a useful allowance independent of the number of fallbacks, requests compact optional fields, and reserves answer room for providers that require reasoning. Initial and follow-up runs remain bounded to 30 and 24 seconds; truncated output gets one compact recovery attempt within that same deadline. The TUI shows the active route, attempt and elapsed time, and distinguishes an output limit from malformed JSON. Completed JSON safely discards unknown fields while retaining strict literal-constraint validation.

Observer validation accepts bounded formatting variations and identifiers actually advertised in its packet, with specific rejection reasons for invalid evidence. Scope councils report their phases and member outcomes in the visible session timeline. Adaptive-thinking helpers receive their intended reasoning allowance, explicit Anthropic thinking-off stays off, and cancelled child processes that ignore termination are escalated using actual process exit state.

The `/used` popup adds compact helper, guardian, observer and skill KPIs with expandable evidence, timings, suggestion history and failure details. New numeric telemetry is collected before TUI notice deduplication; historical displayed notices remain explicitly incomplete. Cumulative guardian snapshots are scoped by supervisor identity instead of counted repeatedly. Observer notes remain pending across pre-dispatch failures, with prepared context distinguished from confirmed provider receipt.

Video bundle caches publish only completed builds and preserve concurrent readers. Narration validates scene IDs and output paths before writing, and fractional scene durations use the same frame rounding as the shipped composition.

## 0.6.0 — 2026-09-24

Code-first video studio. Agents can direct and produce narrated explainer and documentary videos entirely from code, without stock footage, image or video generators, or GUI editors. `video_project` scaffolds a Remotion project around one master timeline, `video.json`, which owns scenes, seconds, narration, scene-relative cues, music and sound. It ships with reusable procedural primitives: tokens with attention arcs, networks, matrices, graphs, charts, history timelines, code, particles and typography. `video_render` renders settled representative stills with a legible contact sheet, scene or range previews, and decode-verified finals, using cached bundles and queued renders. `video_qa` reports near-empty or frozen stretches, audio/video drift, silence, EBU R128 loudness and peak, and per-scene narration audibility, and it always requires visual review of its contact sheet. `narration_tts` adds local Piper narration: an explicit install of a pinned engine with checksum-verified voices, a calibrated documentary pace, syllable-rate pacing checks and measured sentence onsets for cue timing. `audio_synth` renders seeded procedural music beds and sound accents. The `code-first-video`, `remotion-video` and `procedural-audio` skills teach storyboard-first production, visual systems instead of text slides, motion with meaning and a mandatory frame, motion, audio and sync review loop, with a verified worked example. Project code runs through the guarded-command wrapper; the tools are discovered on demand.

Reviewers and automatic helpers with provider reasoning enabled get an 8,192-token reasoning allowance beside their 4,096-token answer, so high-effort reviews no longer truncate before their verdict. Automatic helpers now finalize (tools removed, one steer) before crossing their reported-token budget instead of overrunning it and timing out. A caller abort that arrives after a child's clean final answer is recorded as owned drain cleanup rather than a process-signal failure, and run evidence now retains the signal name.

The session observer keeps paid reviews when later work merely overlaps their topic: such notes are delivered with an explicit "may already be addressed" caveat that is re-checked at delivery. Only a changed cited state or lost coverage discards a note. Failed intent analysis no longer adds a zero-confidence restatement of the prompt to the main agent's context, and the TUI names each route with its actual timeout. An aborted analysis request is reported as late-failed, not as a late completion.

Model preferences clamp an unsupported thinking level to the nearest supported one, matching the core, instead of silently switching to dynamic thinking. Meta's direct API rejects `max` thinking for Muse Spark 1.3 Contributor, so it clamps to `xhigh`. TUI activity lines explain what happened: Needle3 classification, ranking and embeddings, JEV answers (with singular/plural counts) and skill/tool suggestions sent to the agent. Optional local model servers that are simply not running are no longer reported as errors on every start. `symbol_search` waits briefly for an in-flight index build and answers instead of failing, and `bg_kill` reports an already finished task with its terminal state instead of an error.

## 0.5.3 — 2026-09-23

Model search places configured, available matches first, temporary failure exclusions/cooldowns next, and unconfigured catalog entries last. Results explain availability, retain exact provider identities, and accept pasted regional provider/model IDs. Unlisted session-only candidates appear below registered TUI matches and are labeled unverified.

Unavailable catalog endpoints no longer erase the provenance of previously validated cached models, so reloads retain usable catalog additions. MiMo 2.6 Flash and Pro are registered in the three official Xiaomi Token Plan regions; regional credentials stay separate.

## 0.5.2 — 2026-09-23

The session observer reviews chronological chunks during active work, with a 30-second minimum review gap and visible checks within 120 seconds. It remains a conversational reviewer with no tools or execution authority. Advice is consumed once, repeated suggestions are suppressed, and stale or incomplete evidence is identified. Its packet includes current work, actual tool availability, source-backed council/swarm/fusion capabilities, configured model preferences and measured usage. Long foreground commands prompt conditional background-work advice, not automatic interruption.

Initial and follow-up prompt analysis shows task interpretation, route/fallback outcomes and an expandable copy of the exact advisory delivered to the main agent. The original prompt remains unchanged. Reusable mindset preambles no longer become the fallback task. Large inputs are excerpted visibly and user-constraint scanning remains incremental.

Independent sessions can discover and explicitly address peers across projects through `session_coordinate`. Messages are visible to both main agents and their observers, with owner-scoped Guardian receipts. Session epochs reject stale deliveries; peer text remains untrusted advice and does not merge tasks, permissions or private state.

Guardian supervision registers long requests instead of silently disabling the task. Oversized raw-span constraint checks abstain explicitly while tool monitoring and conservative retry detection continue. JEV and Needle admission/fallback outcomes are visible; routine Smol eligibility and lexical-match notices are deduplicated without dropping recorded metrics. Fuzzy counts describe actual lexical matches, and a Smol `UNKNOWN` response is an abstention that preserves the original output.

Read-only council helpers no longer require code edits to count as completed. Native and wrapper child records share their task identity, failed council peers retain useful labels, and owned cleanup after a final response no longer creates a false process failure. Real provider errors and unavailable inference remain visible failures or fallbacks.

Symbol search now reloads an initially missing word index after its background build completes. Long quality-review retry explanations are reduced to a disclosed head/tail excerpt instead of being rejected by a 600-character schema limit; the original tool call retains the full rationale.

## 0.5.1 — 2026-09-23

Model routing now distinguishes local catalog/startup errors from provider failures. Historical exclusions created by the CLI's own missing-model diagnostics are reconciled automatically; real provider failures retain their exclusions. Concurrent sessions update the latest exclusion state instead of overwriting it with stale snapshots.

Preference matching accepts provider separator aliases, colon/dot prefixes before vendor namespaces, and model word/number formatting differences. Exact namespace matches take priority, ambiguous aliases remain unresolved, and explicit model revisions, provider boundaries, thinking settings and backend pins remain intact. Dispatch uses the exact catalog ID.

Isolated helpers preserve models explicitly configured in `models.json` when their cached catalog lacks the selected route. Native child startup regressions verify both reported Friendli and OrcaRouter model identities without network requests or inference tokens.

Idle callbacks retain exclusive lane ownership across nested calls, including cancellation and failures. Workflow child abort listeners are disposed after completion, duplicate signals share one listener, and health-log shutdown invalidates pending asynchronous startup.

Image usage accounting preserves independent cache reads and writes, bounds malformed counters, uses shared tiered pricing and honors charges reported by the official OpenRouter endpoint. Missing pricing remains explicitly incomplete.

Prompt analysis now keeps a literal instruction when the same wording first appears inside a quoted example. Subagent thinking choices follow the owned core's supported levels, so unmapped `xhigh` and nonreasoning routes cannot be presented as supported. Unused model-editor helpers were removed.

## 0.5.0 — 2026-09-23

A periodic session observer offers short tool, skill and process advice during active main-agent work. It runs asynchronously about every 4½ minutes, defaults to official DeepSeek Flash with high thinking, and is configured through the existing `/models` role editor or JSON. Idle and unchanged sessions do not trigger inference; requests have bounded context, a deadline and no retry cascade.

Observer notes appear in the TUI. Only the current advisory enters the next normal model request, without waking an idle agent or interrupting tools. Session changes invalidate pending advice, and actual auxiliary usage is accounted separately from spawned agents. See [the observer's behavior and limits](docs/SESSION-OBSERVER.md).

## 0.4.1 — 2026-09-23

Isolated skill helpers restore only their selected provider's cached model metadata, preserving tool isolation and provider routing constraints. Reasoning models retain a bounded allowance for both reasoning and an answer; a consumed, textless attempt no longer triggers additional provider attempts. Direct prompt-analysis requests enforce proven free-route price caps at dispatch. Foreground and background child receipts preserve output-limit causes. Guardian notes distinguish a standby failure detector from unavailable WASM, and output limits are displayed as limits rather than broken models.

Automatic project intelligence now follows the current file even when the graph revision is unchanged. Entity inspection includes versioned declaration provenance from the same graph used by `/graph`, within the existing output budget.

The [async integration review](docs/UNREAL-INTEGRATION-REVIEW.md) maps Unreal Agent-inspired behavior to executed YunusPi paths and tests, including completion batching, parallel tool barriers, cache stability and OS-isolated experiments. It documents foreground steering limits and makes no unmeasured billing-savings claim.

## 0.4.0 — 2026-09-23

Agents gain bounded workspace and local-mail search, hash-checked message reading, inert SSH connection planning and explicit SSH banner inspection. `claim_check` verifies exact quotations and current file provenance; interpretations remain subject to review. Tools stay behind existing discovery, utility workers and authority boundaries.

Rendered UI checks add animated status capsules, copy density, primary font proliferation, repeated heavy borders and narrow quantified marketing evidence candidates. Checks use existing captures, expose scope and exclusions, and introduce no model calls or repair loops.

Concurrent identical Needle3 operations share existing queued inference with separate consumer results and honest TUI telemetry. Voluntary coordination receipts observe normal authorized shell execution against explicit input hashes; stale or unverifiable evidence cannot be advertised as a current check. Signal-terminated native shell commands now fail explicitly.

Disposable experiments can opt into the existing background-task registry, retaining OS isolation, bounded output, terminal notifications and cleanup. Foreground use remains compatible. Details and limits: [operations audit](docs/OPERATIONS-EVIDENCE-AUDIT.md), [async, operations and studio](docs/ASYNC-AND-STUDIO.md).

## 0.3.0 — 2026-09-23

Slow independent reviews now show aspect progress and elapsed/deadline information in the existing tool display. Repair rounds receive prior blockers and changed-source context. Exhausted review rounds ask for an honest assessment of remaining gaps; stopping a session no longer requires manufacturing a review or child run.

Actual intelligence activity appears immediately as display-only session notes, including during long-running tools. Notes distinguish remote JEV, local Needle3/WASM, cached selections, returned excerpts and evidence added to model context. They remain outside provider input and compaction; concurrent child notes preserve session ownership. Closely timed background completions share one fixed 200 ms grace window before waking the model.

`obs_read` gains optional local query ranking with exact source ranges, hashes, bounded prefix coverage and unchanged full-original pagination. It reuses existing lexical retrieval and Needle3, without sending raw observations to a remote judge or rewriting cached history. Actual parser/render hooks now report narrow, advisory code and UI noise findings using existing WASM parsing and browser captures, with no added model calls or mandatory repair loops.

Details and verification limits: [session recovery audit](docs/SESSION-RECOVERY-AUDIT.md), [micro-intelligence](docs/MICRO-INTELLIGENCE.md), [async and studio](docs/ASYNC-AND-STUDIO.md).

## 0.2.0 — 2026-09-23

YunusPi gains persisted asynchronous delivery receipts, coalesced background wait events, mixed parallel/exclusive tool batches, duplicate-safe background admission and backpressured shell capture with optional head/tail context. These changes extend the existing runtime and preserve normal session, model, provider, skill and hook usage.

Seven native tools add editable 3D scene creation, sandboxed WebGL animation rendering with sound, video transitions, audio mixing, rendered design evidence, GitHub Actions inspection and hosting asset checks. Ubuntu service/journal inspection extends `sys_probe`. Three.js is pinned to 0.180.0 with preserved MIT attribution.

The release also includes the independent Guardian/routing/intent audit and subsequent session repairs: native helper startup, slash completion, accounting evidence, bounded verification follow-ups, browser alias/diagnostic behavior, local render routes and genuine intelligence visibility. Additional review fixed uncertain contrast claims, fractional video frame loss, shell startup cancellation and capture-file collision ownership, and structured tool errors incorrectly recorded as successful executions.

Product metadata, six owned core packages and the workspace lock now use the same release version. CI requires real isolation, browser and audiovisual checks and creates release notes only after a version tag passes checks. Pi 0.85.1 remains the immutable historical origin.

Deployment checks also synchronize standalone extension dependency locks, preserve the changelog through installation and public export, retain the installed browser location inside isolated sessions, and keep Linux CLI command arguments available for active-installation protection.

Details and limits: [async and studio](docs/ASYNC-AND-STUDIO.md), [Guardian audit](docs/GUARDIAN-IMPLEMENTATION-AUDIT.md), [session recovery audit](docs/SESSION-RECOVERY-AUDIT.md).
