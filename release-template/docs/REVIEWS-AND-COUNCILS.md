# Reviews, councils, swarms and fusion

Each mechanism has a distinct purpose and reuses an existing launcher. No
parallel review engine exists: the table below is the complete formalization,
and the main agent remains responsible for the session in every case.

| Kind | Purpose | Owner | How to invoke deliberately |
| --- | --- | --- | --- |
| Quality review | Implementation quality and regressions in observed changes | Quality-review lifecycle with the native runner | `quality_review({action:"review"})`, then `assess` |
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
repeats. Automatic behavior stays quiet otherwise; the main agent invokes
these workflows deliberately when they fit.

## Automatic behavior and anti-spam

Automatic intervention complements deliberate invocation; it never replaces
it:

- Quality reviews run at completion checkpoints with changed-source evidence
  (two rounds, bounded aspects, strict evidence parsing).
- The scope council runs only for qualifying change-scope requests.
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
