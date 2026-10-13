# Goals

`/goal <what you want done>` is for the tasks that matter. It gives the session a real definition of done and keeps it working until each part has evidence, without you re-prompting.

```
/goal Make the exporter handle unicode filenames, add regression tests and update the docs
/goal                # progress and evidence per criterion
/goal criteria unicode names survive round trip; docs mention the flag
/goal pause | resume | retry | done | clear
```

## What happens

1. The goal text becomes numbered criteria (`C1`…): your list items and directives, plus a mandatory `V` criterion that the result was checked end to end against the real artifact. The `goal` tool is staged for the session.
   - The goal text is your prompt, not a harness message. It reaches intent analysis, design-direction and expert guidance, the Guardian's constraint tracking, the requirement ledger, task state and memory exactly like a typed prompt, and it is kept as you typed it (line breaks included, up to 20,000 characters). Only the harness's own continuations count as synthetic input.
2. Every turn carries a compact anchor of the criteria and their state, so the goal survives compaction and resume (state is saved as snapshots on the session branch).
3. Finish in one call: `goal({action:"complete", results:[{id:"C1", evidence:"Exporter diff inspected: unicode filenames preserved"}, {id:"V", evidence:"npm test: 14 passed, exit 0"}]})` records criterion evidence and checks completion together. Include a result for each criterion shown by the goal; no preliminary `status` or `check` call is needed. A bare "done" is refused. `met` and `waive` accept the same `results` batch or the existing single `id`/`evidence` form. A batch validates before changing any criterion; an individual result can use `status:"waived"` with its reason. `criteria` refines the open criteria; `blocked` reports that only you can unblock the work.
4. `goal complete` is refused while criteria are open or files changed after the last passing test, build or render. Plain Markdown and reStructuredText documentation edits do not create new test debt: inspect their final diff as part of `V`. Executable MDX, source/config files and writes without a known path still require verification. The refusal is issued once per distinct set of gaps; repeating the call records a waiver, so you are never deadlocked and the final report must name what was waived. The waiver is spent by the call that uses it — a later gap of the same shape is refused again rather than inheriting an older approval.
   - What counts as a passing check is decided by the command, not by the tool. `npm`, `pnpm`, `yarn` and `bun` scripts, the bare runners (`vitest`, `jest`, `eslint`, `tsc`, `biome`, `pytest`, `tox`, `mypy`, `ruff`, `phpunit`), the usual build tools (`make`, `just`, `mvn`, `gradlew`, `cargo`, `go`, `dotnet`, `composer`, `swift`) and `deno`/`python -m`/`node --test` all count, but only in command position — a filename or a commit message that names one does not.
   - A suite started with `bg_run` does not count yet. It returns a task id immediately, so the debt clears when the background task reports `completed` with a zero exit; a failed or killed run verifies nothing.
5. **One completion check.** `goal({action:"check"})` is optional diagnostics listing every open quality, integrity and delivery step; `complete` uses the same checks. The steps are receipts their owners publish (project tests and the independent quality review, produced files and deliverables, rendered, media and creative review, tracked task requirements) plus two static steps on files changed since `HEAD`: a code audit (high-severity findings only) and a syntax check. The session reuses audit/parse results for identical file contents, rereading current bytes so external or same-stat edits invalidate them. Static work has a ten-second deadline, with partial or unavailable coverage reported as unknown. `check` adds non-blocking duplicates, source-pattern and import-cycle notes within the changed files; it does not rebuild a whole-project duplicate index. Post-edit hooks retain bounded neighbour comparisons. There are no separate audit, quality or syntax tools.
6. When the agent settles with criteria still open, the harness sends one bounded continuation naming them. If every criterion already has evidence and current checks are clear, the harness closes the goal itself without a model turn just to call `complete`. It never automatically waives a gap or closes over work that will resume the session.

Known focused test commands can run directly. The project-test owner adopts current execution receipts automatically; `project_tests inspect` and `assess` are for unclear setup, a deliberately different verification scope, or an explicit exception. Non-check shell calls retain their result-time source scan without a redundant pre-command scan. Actual verification commands still capture source identity before execution and invalidate passes if files change during the check.

## /noslop

`/noslop` is a goal with the aim already written: desloppify the codebase. It needs no instruction after it; an optional focus narrows it.

```
/noslop                       # the whole codebase, user-visible surfaces first
/noslop the settings page     # one area or front, deeply
```

It starts the same goal machinery as `/goal` — same persisted state, same `goal` tool, same completion check — with seven fixed fronts as its criteria plus the usual verification criterion: an inventory first, then UI/visual slop (fake live/active state and blinking dots, decorative pills and badges, stock gradients and glass, emoji icons, decorative mono fonts, build and meta narration in the interface), interface density (every screen of any UI keeps only the few things its user comes for — a dashboard with 20 KPIs, 4 charts, a 10-item sidebar and 10 accordions ends near 4 KPIs, 2 charts and 5 nav items — with secondary detail moved to its own page, duplicates removed, the core design approach kept, and before/after element counts as evidence), honest copy and labels (no made-up labels, SaaS boilerplate, stock phrases, invented metrics or text-noise), comments that earn their place, dead and duplicate code and functionality removed, and proof that the cleanup added no slop of its own and broke nothing real. Subtraction comes first: slop is deleted outright unless it was doing a real job, in which case the plainest honest alternative in the project's own style replaces it. Lower density may also mean one crafted visual instead of a wall of text: where the subject or the user calls for it, scroll-driven motion or an isometric/3D figure built with the anatomy skill (or three.js), reduced-motion aware, never decorative and never on utility screens. Genuine state, earned proof, deliberate branding, product behavior and public interfaces are explicitly not slop and stay. Fronts outside a requested focus are waived with that reason through the goal tool rather than silently skipped. `/goal` shows a desloppify run's progress and pauses, resumes or clears it; the brief and fronts live in `agent/extensions/lib/noslop.ts`, and [ANTI-SLOP-CHECKLIST.md](ANTI-SLOP-CHECKLIST.md) remains the detailed rule set for websites.

## /nobug

`/nobug` is a goal that hunts and fixes real bugs. Bare, it covers the whole codebase; a focus or assignment narrows it.

```
/nobug                        # the whole codebase, what users run and see first
/nobug the checkout flow      # one area, pipeline or output, deeply
```

It starts from a baseline (the project's own build, type check, lint and tests run and recorded, the in-scope surfaces mapped), then hunts across logic (wrong conditions, off-by-one, null paths, units and time zones, races, swallowed errors), edge cases (empty, huge, malformed and unicode input, boundaries, concurrency, failed network, missing files, first run versus upgrade), broken code, dependency problems (missing, unused, conflicting or deprecated packages, lockfile drift), duplicated rules that can drift, and the interface as it actually renders: UI/UX states, keyboard and focus, layouts from a 360px phone to a wide desktop, the target browsers (Chromium, Firefox and WebKit where available, naming any that could not be run), and for terminal apps narrow or resized terminals, non-TTY output, `NO_COLOR` and Ctrl-C cleanup. Every fix is reproduced first (a failing test where the project has tests), made at the root cause, and proven by the repro passing with the baseline still green. Masking is forbidden (swallowed errors, skipped tests, disabled lints, loosened types), unproven suspicions are reported as suspected, and unchecked environments are named. Its six fronts are baseline, logic and edge cases, broken code and dependencies, drifting duplicates, the interface, and honest fixes.

## /3d, /video and chaining

Two more presets work the same way, and all four chain:

```
/3d make a minecraft clone
/video make a 60-second explainer about tides, narrated
/3d /video /noslop please make a video about how a steam engine works
/nobug /3d /video make sure the video has no problems
/noslop /nobug             # e.g. in a terminal app: bugs, edge cases and TUI slop
/3d                       # no assignment: fix this project's 3D work
/video                    # no assignment: fix this project's video work
```

`/3d` puts the harness's 3D capability at full strength: the route is chosen deliberately (Blender for real geometry and offline realism, three.js/WebGL for browser and interactive work, Blender-built assets presented in three.js when the subject wants both), the installed 3D skills and tools for that route are actually loaded, the subject is grounded in real references, web assets and images may be sourced with their licenses checked, and the result is iterated against renders from several angles within honest performance budgets. Its fronts judge grounding, real assets and geometry, craft at inspection distance, motion/interaction behavior, and a deliverable that runs clean end to end.

`/video` demands a finished film on every track: script or shot list and audio plan before any render, purposeful picture and effects, sound that is mixed rather than attached (intelligible narration/TTS timed to the picture, music and effects under speech, consistent levels), pacing and sync that line up, and a master verified by watching the export with audio at its intended resolution, frame rate and format.

With no assignment, `/3d` and `/video` survey the current project for work of their kind and improve and fix what exists. If there is none, the session says so plainly, waives the fronts with that reason, and stops — a bare preset never invents a project.

Chaining stacks aims onto one goal: `/3d /video /noslop please make a video about …` dispatches once and starts a single goal whose brief contains every named directive set in full, applied to the same assignment together (the example gets real 3D craft, finished sound and picture, and desloppification of everything produced). Any order works and repeats are ignored. Chained with `/3d` or `/video`, `/nobug` also inspects the media pipeline and the rendered output (audio/picture sync, dropped frames, wrong levels or aspect, z-fighting, missing textures, context loss) and treats weird or low-quality looks as bugs. Chained with `/noslop` in a terminal app, the TUI's output is the interface: banners, chatter, decorative colors and noise are slop there. The tracked criteria compress to each preset's three core fronts (two each in a four-way chain) so every chain fits the criteria budget; the briefs themselves never compress, and the goal tool can refine criteria as the work takes shape. Briefs, fronts and the chaining grammar live in `agent/extensions/lib/presets.ts`.

## Loop safety


- At most six continuations per goal, and the goal stops at the second continuation in a row that records no new evidence (`/goal retry` re-arms it).
- An interrupt pauses the goal (`/goal resume` continues); queued user messages and provider errors never trigger a continuation.
- `PI_GOAL=0` disables the system. Any failure inside it leaves the session running as if no goal existed.

Earlier goal trackers were retired because they inferred goals automatically. This one exists only when you ask for it.
