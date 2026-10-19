# Goals

`/goal <what you want done>` is for the tasks that matter. It gives the session a real definition of done and keeps it working until each part has evidence, without you re-prompting.

```
/goal Make the exporter handle unicode filenames, add regression tests and update the docs
/goal                # progress and evidence per criterion
/goal criteria unicode names survive round trip; docs mention the flag
/goal pause | resume | retry | done | clear | help
/goal resume pick up from the logo end card   # resume with a note for the agent
```

**Subcommands are safe to type.** A bare subcommand never becomes a goal: `/goal resume` (or `continue`) resumes this session's goal, or says there is none and starts nothing. With a goal in the session, `/goal resume <words>` resumes it and hands your words to the agent as a note; without one, the same words start a new goal. `stop` means `clear`, `show` and `progress` mean the status view, and `/goal help` lists every form. In the terminal, `/goal ` offers the subcommands as completions.

**Seeing the goal.** The footer status reads `goal ◎ 2/6` while active, `⏸` paused and `⚠` stalled (waiting for `/goal retry`). Reopening a session with an unfinished goal says so once ("Goal … is still open in this session"), so a resumed or updated session never hides one. The desktop shows the same state as a goal bar above the composer (open, running, paused or stalled, with Resume or Retry), even before the session's runtime starts. It draws the kickoff as a goal card (your words, the boosts, the criteria, the full brief folded away) and each automatic continuation as a "Goal continuing on its own · step n of 6" row.

## What happens

1. The goal text becomes numbered criteria (`C1`…): your list items and directives, plus a mandatory `V` criterion that the result was checked end to end against the real artifact. The `goal` tool is staged for the session.
   - The goal text is your prompt, not a harness message. It reaches intent analysis, design-direction guidance, the Guardian's constraint tracking, the requirement ledger, task state and memory exactly like a typed prompt, and it is kept as you typed it (line breaks included, up to 20,000 characters). Only the harness's own continuations count as synthetic input.
2. Every turn carries a compact anchor of the criteria and their state, so the goal survives compaction and resume (state is saved as snapshots on the session branch).
3. Finish in one call: `goal({action:"complete", results:[{id:"C1", evidence:"Exporter diff inspected: unicode filenames preserved"}, {id:"V", evidence:"npm test: 14 passed, exit 0"}]})` records criterion evidence and checks completion together. Include a result for each criterion shown by the goal; no preliminary `status` or `check` call is needed. A bare "done" is refused. `met` and `waive` accept the same `results` batch or the existing single `id`/`evidence` form. A batch validates before changing any criterion; an individual result can use `status:"waived"` with its reason. `criteria` refines the open criteria; `blocked` reports that only you can unblock the work.
4. `goal complete` is refused while criteria are open or files changed after the last passing test, build or render. Plain Markdown and reStructuredText documentation edits do not create new test debt: inspect their final diff as part of `V`. Executable MDX, source/config files and writes without a known path still require verification. The first refusal lists every unresolved check. After that, `complete` with a `reason` naming each remaining item records a waiver even if the list changed, so checks that do not apply to the requested deliverable (a viewer page around a requested video) cannot hold a finished goal open; a call without a reason is refused again, and open criteria or failed media review never waive. The final report names what was waived, and a waiver is spent by the call that uses it.
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

It starts the same goal machinery as `/goal` — same persisted state, same `goal` tool, same completion check — with three fronts plus the usual verification criterion: interface slop gone (made-up labels, decorative pills, fake live/active state, invented colours, neon and glow, emoji icons, boilerplate sections, each screen cut to what its user comes for with element counts before and after), copy and code honest (no stock phrases or unsourced numbers; narrating comments, dead code, unused dependencies and duplicate implementations removed), and nothing real broken. Subtraction comes first; genuine state, a deliberate brand system and motion that carries meaning stay. A focus narrows it and the fronts it does not touch are waived through the goal tool. The brief lives in `agent/extensions/lib/presets.ts`; [ANTI-SLOP-CHECKLIST.md](ANTI-SLOP-CHECKLIST.md) remains the detailed rule set for websites.

## /nobug

`/nobug` is a goal that hunts and fixes real bugs. Bare, it covers the whole codebase; a focus or assignment narrows it.

```
/nobug                        # the whole codebase, what users run and see first
/nobug the checkout flow      # one area, pipeline or output, deeply
```

It starts from a baseline (the project's own build, type check, lint and tests run and recorded, the in-scope surfaces mapped), then hunts logic errors, edge cases, broken imports and scripts, and dependency drift, and tests any interface as rendered. Each fix gets a repro first, the smallest root-cause change, then the repro and existing checks pass; nothing is masked, and what could not be proven is reported as suspected.

## /3d, /video, /anatomy and chaining

Three more presets work the same way, and all five chain:

```
/3d make a minecraft clone
/video make a 60-second explainer about tides, narrated
/anatomy an interactive cutaway of a mechanical watch escapement
/anatomy /video a 10-second 1:1 reveal film of a Moka pot
/3d /video /noslop please make a video about how a steam engine works
/nobug /3d /video make sure the video has no problems
/noslop /nobug             # e.g. in a terminal app: bugs, edge cases and TUI slop
/3d                       # no assignment: fix this project's 3D work
/video                    # no assignment: fix this project's video work
/anatomy                  # no assignment: fix this project's anatomy figures
```

`/3d` asks for real geometry, materials and light: Blender (the `blender` tool and the 3d-cad skill) for assets, three.js for browser and real-time scenes, the anatomy skills for figures made of parts, grounded in references and checked on rendered stills from several angles. A generated or stock image never stands in for the 3D picture.

`/video` asks for a finished film on every track: PRODUCTION.md first (script with timings, shot list, look, audio plan), one pipeline (cinetic for motion design, ads and launch films; the media skill for narrated explainers and existing footage), stills and frames from the final MP4 looked at, narration timed to the picture with music ducked under it, and `video_qa` listen and analyze passing on the delivered file.

`/anatomy` builds the subject from real parts with one of the two bundled anatomy skills (see [ANATOMY.md](ANATOMY.md)): `anatomy` to explain how something works, `anatomy-reveal` to take one object apart as a page or a reveal film. The skill's own checks (kit audit, scan-apart, motion scan) must report clean.

With no assignment, `/3d`, `/video` and `/anatomy` survey the current project for work of their kind and improve and fix what exists. If there is none, the session says so plainly, waives the fronts with that reason, and stops — a bare preset never invents a project.

Chaining puts several boosts on one goal: `/3d /video /noslop please make a video about …` dispatches once and starts a single goal whose text is the assignment followed by each boost's short standard. Each standard is a few sentences, so a five-way chain stays near 5,000 characters. In a chain that makes a video, `/noslop` and `/nobug` judge the picture and the encoded file (every on-screen element does a job; sync, dropped frames, clipping, aspect) instead of auditing a codebase.

**3D films.** When `/video` chains with `/3d` or `/anatomy`, the goal gains one film paragraph naming a single lead skill: `anatomy-reveal` for an object taken apart, `anatomy` for how something works, `cinetic` otherwise. The 3D scene is driven from the film's one timeline, Blender only builds GLB assets for it, and transitions follow motion.

**Typing chains.** Boosts are marked as such in the terminal autocomplete (`[boost · chains]`, listed first) and in the desktop slash menu (a link mark under "Boosts"). After a boost, typing `/` plus a letter offers the boosts that can still join. A mistyped command (`/nobugs`, or a typo inside a chain) is never dropped or sent as text: the terminal puts the correction in the editor and Enter sends it, and the desktop asks "Did you mean /nobug?" with the fix focused. Submitting the original again sends it as typed; an unknown bare command still never reaches the model. The matcher is `core/coding-agent/src/core/command-correction.js`, and a command registers as chainable with `chainable: true`.

Boost tokens count anywhere in a line, including inside `/goal`:

```
/goal build a portfolio site for my bakery /noslop /3d
/goal make the hero /3d, cut a 30-second promo /video, then /noslop everything
/noslop tidy the settings page /goal
```

A `/goal` with boosts keeps the user's own requirements as its first criteria, then adds each boost's core fronts in the order written (three for one boost, two each for two, one each for three to five), then the end-to-end check. Tokens must stand alone: paths, file names and code spans (`src/3d/scene.ts`, `/video.mp4`, `` `/noslop` ``) stay part of the text. A bare boost (`/3d`, `/noslop /nobug`) typed while a goal is active or paused joins that goal: its brief is appended, its fronts take the free criteria slots, and the running work is steered to pick it up; repeating a boost already in force changes nothing. A goal or boost started while a turn is running is queued instead of rejected.

## Loop safety


- At most six continuations per goal, and the goal stops at the second continuation in a row that records no new evidence (`/goal retry` re-arms it).
- An interrupt pauses the goal (`/goal resume` continues); queued user messages and provider errors never trigger a continuation.
- `PI_GOAL=0` disables the system. Any failure inside it leaves the session running as if no goal existed.

Earlier goal trackers were retired because they inferred goals automatically. This one exists only when you ask for it.
