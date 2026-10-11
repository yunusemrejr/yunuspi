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

## Loop safety

- At most six continuations per goal, and the goal stops at the second continuation in a row that records no new evidence (`/goal retry` re-arms it).
- An interrupt pauses the goal (`/goal resume` continues); queued user messages and provider errors never trigger a continuation.
- `PI_GOAL=0` disables the system. Any failure inside it leaves the session running as if no goal existed.

Earlier goal trackers were retired because they inferred goals automatically. This one exists only when you ask for it.
