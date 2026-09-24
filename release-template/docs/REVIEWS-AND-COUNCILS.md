# Reviews, councils, swarms and fusion

Each mechanism has a distinct purpose and reuses an existing launcher. No
parallel review engine exists: the table below is the complete formalization,
and the main agent remains responsible for the session in every case.

| Kind | Purpose | Owner | How to invoke deliberately |
| --- | --- | --- | --- |
| Quality review | Implementation quality and regressions in observed changes; for interfaces also identity (look-alike reuse of an incidentally mentioned site or category-default output is flagged) | Quality-review lifecycle with the native runner | `quality_review({action:"review"})`, then `assess` |
| Project review | Architecture, goals, consistency, debt, direction | One bounded advisory helper via the native subagent executor | `subagent` worker with a project-review brief |
| Error review | Likely faults, root causes, failed assumptions, debugging leads | One bounded advisory helper via the native subagent executor | `subagent` worker with an error-review brief |
| Council | Multi-perspective reasoning for genuinely hard questions | Automatic scope council, or the supervisor-mediated council prompt | `prompt-workflow` council, or `prompts/council.md` protocol |
| Swarm | Separable parallel investigations in one broad task | Assistance-plan swarm mode with bounded respawns | `subagent({tasks:[...],async:true})` |
| Fusion | Competing approaches merged with provenance | Fusion-mode workers plus the deterministic fusion planner | Fusion workers plus `runs.fuse` |

Findings come back concise: bounded reports with evidence and explicit gaps,
never raw reasoning dumps. The parent verifies, decides and owns changes.

## Session-start disclosure

The first prompt of a session carries one short orientation line naming
native-tool preference and the availability of reviews, councils, swarms and
fusion. It appears once per session, costs negligible context and never
repeats. The main agent invokes these workflows deliberately when they fit.
When an automatic scope council runs, its transcript shows each phase and
member starting and finishing, including the selected model/thinking and elapsed
time. Successful members show a short advice preview that expands to the
bounded full report; completion, partial results and cancellation remain visible
after the footer clears. These persisted display messages do not enter model
context or wake the agent. They expose returned advice, never hidden thinking.

## Automatic behavior and anti-spam

Automatic intervention complements deliberate invocation; it never replaces
it:

- Quality reviews run at completion checkpoints with changed-source evidence
  (two rounds, bounded aspects, strict evidence parsing).
- The scope council runs only for qualifying change-scope requests, and in
  design-direction mode for a new open visual brief: the same three members,
  budgets and read-only limits read the brief (classifying mentioned sites as
  style or context-only), propose three distinct directions, and critique
  them to recommend one. Its progress rows are labelled "Design council".
- A strong stuck pattern — the same fix attempted four or more times, four
  or more consecutive errors with multi-cause or loop evidence — earns at
  most a single bounded *suggestion* naming an error review. Suggestions
  never launch work by themselves.
- Suggestions honor a 30-minute per-kind cooldown, a cap of two per session
  and kind, and suppression for ten minutes after a review ran.

The following never trigger councils or reviews: trivial formatting, linting
or cleanup work; expected transient failures (rate limits, quota, budget);
repeated successful commands; harmless iteration. Deliberate invocation
always stays available regardless of these gates.

Model and thinking choices for every kind follow
[llm_preferences.json](LLM-PREFERENCES.md) first and the autonomous selector
second. See [Model routing](MODEL-ROUTING.md) for budgets and quality gates.

Short follow-ups such as “keep going” retain the current task. A model,
provider or thinking change is not a new project objective; a genuine task
pivot starts a new scope. Automatic wakes reuse the latest real user direction
and do not spend a fresh council budget or reinterpret a completion notice as
a user request. Late advice from a cancelled or replaced session is discarded.

Interpretation and effort helpers provide passive advice. They do not change
the main session's model or thinking, interrupt its active turn, or wake it.
An optional second reading of an unclear follow-up is delivered as next-turn
context, leaving the parent responsible for interpretation and action.
