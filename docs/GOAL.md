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

**Seeing the goal.** The footer status reads `goal ◎ 2/6` while active, `⏸` paused and `⚠` stalled (waiting for `/goal retry`). Reopening a session with an unfinished goal says so once ("Goal … is still open in this session"), so a resumed or updated session never hides one. The desktop shows the same state as a goal bar above the composer (open, running, paused or stalled, with Resume or Retry), even before the session's runtime starts. It draws the kickoff as a goal card (your words, any standards you named, the criteria, the full brief folded away) and each automatic continuation as a "Goal continuing on its own · step n of 6" row.

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

## Standards a goal adopts on its own

A goal needs no second command for the kind of work it is. The kickoff ends with eight standards in one line each, and the agent adopts the ones the work calls for:

| Standard | Adopted for | What it insists on |
| --- | --- | --- |
| `design` | building or redesigning an interface, page, deck or other visual surface | a direction chosen from the subject and its audience, real content, the rendered result looked at on phone, tablet and desktop |
| `noslop` | removing AI slop and clutter from an existing interface, copy or codebase | subtraction first: made-up labels, decorative pills, fake state, stock phrases, dead and duplicate code gone, and nothing real broken |
| `nobug` | hunting and fixing bugs in existing code | a recorded baseline, a repro before each fix, the smallest root-cause change, nothing masked |
| `3d` | real 3D assets or scenes | real geometry, materials and light, checked on rendered stills from several angles |
| `video` | a finished video or film | a production plan first, one pipeline, frames from the final file looked at, sound in step with picture |
| `anatomy` | a figure or film that shows a real object's parts or how a mechanism works | the subject built from real parts with one of the bundled anatomy skills, its own checks clean |
| `research` | an answer or report built from sources found on the web | primary sources read, not snippets; each claim next to its source and date; gaps named |
| `browser` | operating a live website | the page read before acting; up to but not through pay, send or publish unless told; logins handed to you |

Adoption is one call, `goal({action:"adopt", items:["design","research"]})`. It returns each standard in full, adds its checks to the goal's criteria and readies its tools. A standard can be adopted later when the work turns out to need it, and a goal that fits none adopts none, so a small fix carries no extra text. A film or a 3D scene started without its standard gets it at the first render or Blender call, with a notice. `/goal` lists the standards in force, and the desktop goal card shows the ones named when the goal started.

The standards are written in `agent/extensions/lib/presets.ts`. The guides they point to (`ui-design`, `cinetic`, `media`, `anatomy`, `anatomy-reveal`, `iso-glow`, `browser`, `research`) are also indexed in every session's working notes, so a plain prompt without `/goal` reaches them too. [ANTI-SLOP-CHECKLIST.md](ANTI-SLOP-CHECKLIST.md) remains the detailed rule set for websites and [ANATOMY.md](ANATOMY.md) describes the two anatomy skills.

**3D films.** When `video` is in force together with `3d` or `anatomy`, the goal gains one film paragraph naming a single lead skill: `anatomy-reveal` for an object taken apart, `anatomy` for how something works, `cinetic` otherwise. The 3D scene is driven from the film's one timeline, Blender only builds GLB assets for it, and transitions follow motion. In a goal that makes a video, `noslop` and `nobug` judge the picture and the encoded file (every on-screen element does a job; sync, dropped frames, clipping, aspect) instead of auditing a codebase.

### Insisting on a standard

To require a standard instead of leaving the choice to the agent, name it. The five shortcut commands from earlier releases still work when typed, alone or chained, though menus no longer list them:

```
/goal build a portfolio site for my bakery /noslop /3d
/noslop                       # the whole codebase, user-visible surfaces first
/nobug the checkout flow      # one area, pipeline or output, deeply
/anatomy /video a 10-second 1:1 reveal film of a Moka pot
/3d                           # no assignment: fix this project's 3D work
```

A shortcut is a goal with that standard already in force: same persisted state, same `goal` tool, same completion check. Several on one line start one goal. The user's own requirements stay its first criteria, then each named standard's core checks in the order written (three for one, two each for two, one each for three to five), then the end-to-end check. Tokens must stand alone: paths, file names and code spans (`src/3d/scene.ts`, `/video.mp4`, `` `/noslop` ``) stay part of the text. A bare shortcut typed while a goal is active or paused joins that goal, and repeating one already in force changes nothing. With no assignment, `/3d`, `/video` and `/anatomy` survey the current project for work of their kind; if there is none, the session says so, waives those checks with that reason, and stops. A goal or shortcut started while a turn is running is queued instead of rejected.

A mistyped command (`/nobugs`, or a typo inside a chain) is never dropped or sent as text: the terminal puts the correction in the editor and Enter sends it, and the desktop asks "Did you mean /nobug?" with the fix focused. Submitting the original again sends it as typed; an unknown bare command still never reaches the model. The matcher is `core/coding-agent/src/core/command-correction.js`. An extension registers its own chainable command with `chainable: true`, and one that should work without being listed with `hidden: true`.

## Loop safety


- At most six continuations per goal, and the goal stops at the second continuation in a row that records no new evidence (`/goal retry` re-arms it).
- An interrupt pauses the goal (`/goal resume` continues); queued user messages and provider errors never trigger a continuation.
- `PI_GOAL=0` disables the system. Any failure inside it leaves the session running as if no goal existed.

Earlier goal trackers were retired because they inferred goals automatically. This one exists only when you ask for it.
