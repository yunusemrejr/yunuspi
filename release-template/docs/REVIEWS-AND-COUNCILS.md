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
| Double | Two independent streams (the current model twice, or two models you pick) reconciled into one decision | Double runner with the native subagent executor | `/double` or `/custom-double`, then work normally |

Findings come back concise: bounded reports with evidence and explicit gaps,
never raw reasoning dumps. The parent verifies, decides and owns changes.

Interface review reads current implementation before inspecting at most three representative captures. A test log does not qualify as an implementation read. Large native edits and current files changed through commands receive bounded source checks; rendered label dots, icon tiles and accent rails feed the same checkpoint. Unaddressed standing UI policy cues appear as `policyFindings` separately from independent reports and prevent acceptance until repaired/reviewed or explicitly dismissed with evidence. These obligations survive session resume and do not create additional review rounds. New rendered findings invalidate earlier acceptance; source edits invalidate stale rendered cues.

## Double mode

`/double` toggles a session mode in which every request is first analyzed by
two independent streams of the currently selected model — same provider,
same model, same thinking, same forked session context — and then
reconciled into one directive the normal turn executes. The streams are
peer-aware but never see each other's reasoning; a lightweight
reconciliation pass compares, challenges and commits their conclusions,
proposals, risks and disagreements into a single plan. The streams
investigate read-only and propose actions; only the parent executes, so no
state-changing operation runs twice.

**The user's words stay in charge.** The directive is planning advice for the
request that precedes it, never an instruction from the user: its header
states that the user's own messages (this prompt, earlier prompts and any
active goal) and explicit constraints outrank it. The requirements the
harness extracts from the prompt (`extractRequirements`, the same owner the
requirement ledger uses) are listed verbatim to both streams, the
reconciliation and the directive, and the reconciliation is told to reject any
proposal that conflicts with them. The list leads the directive so a bounded
directive never loses it. A deterministic note also tells the reconciler how
many files each stream names in common, so disagreement is visible as a fact.

**Cache order.** Cached prompt prefixes depend on byte order, so the two
stream prompts share everything (framing, request, requirements, context,
rules) and differ only in a closing identity and angle. Stream B starts when A
reports its first progress, which means A's request is accepted and the shared
prefix (system prompt, forked transcript and this prompt) has been processed;
a route that stays silent until it finishes costs at most a 6 s wait, and a
stream that fails or finishes opens the gate at once. The directive is added
as a message and the system prompt is never modified: an override that
alternates with harness wakes (which are not doubled) would invalidate the
whole cached conversation each time it flipped.

**What is not doubled.** A bare acknowledgement ("ok", "thanks", "looks good")
carries no request, so that turn continues single and says so once. Approvals
and directives ("do it", "continue") still authorize work and are doubled, as
are all real requests.

Progress rows show each stream and the reconciliation starting and
finishing; a degraded run (a stream failed, a route substituted, no
reconciliation) stays visible in the directive and the transcript instead
of failing the turn. Both streams account through the shared subagent cost
and lifecycle ledgers, so `/cost` and `/used` reflect the doubled
inference. `PI_DOUBLE=off` disables the mode; children never re-double.

### Two models: `/custom-double`

`/double` runs the session model twice. `/custom-double` runs **two models you
choose**, each from any provider (an OpenRouter model beside a direct DeepSeek
route, for instance), because different models make different mistakes and the
reconciliation can weigh what both reach independently against what only one
believes.

With no arguments it opens a small popup in the terminal, built from the same
parts as the `/model` picker. Type to search every model you can run (provider
and id both match), press Enter to fill slot A (builds the plan) and then
slot B (stress-tests it); once both are filled the first row is
`▶ Start Double with these two models` and one more Enter starts it. `Tab`
switches the slot you are filling, `ctrl+t` cycles that slot's thinking level
(only levels the model supports; a model without thinking runs `off`),
`ctrl+r` cycles where the reconciliation runs (A, B or the session model), `Esc`
cancels and changes nothing. Each slot defaults to the session's thinking level
clamped to what its model can run.

Without the popup (scripts, headless sessions) name both models:
`/custom-double deepseek/deepseek-flash:high zai/glm-5.1 reconcile=session`.
A bare id is accepted when exactly one provider carries it, or when it is the
session's own provider; otherwise the command asks for `provider/id` and changes
nothing. `/custom-double on` resumes the last pair without the popup,
`/custom-double off` and `/double off` both end the mode, `/custom-double status`
and `/double status` show it, and `/double` always means the session model twice.
The confirmed pair is saved in the session and remembered across sessions
(`double-pair.json` in the agent directory), so the next `/custom-double` opens
on it; a remembered model that cannot run now is left empty instead of being
offered back.

What differs from the twin mode, and what does not:

- Each stream is pinned to its own route and thinking level and verified like
  the twin streams: a stream or reconciliation that ran elsewhere stays usable
  and shows up as a visible gap in the directive header. A pair never silently
  substitutes a route; if a pinned route can no longer run, that turn continues
  single with one warning.
- Two different routes share no prompt cache, so there is nothing to stagger and
  both streams start at once. Choosing the same model for both slots is allowed
  (it is `/double` with separate thinking levels) and keeps the staggered start.
- The prompts say the peer is a different model and name both, the
  reconciliation is told that independent agreement across models is stronger
  evidence than a model agreeing with itself yet still not proof, and never to
  defer to a model's reputation. Independence, the requirement anchor, the
  read-only tool ceiling, the acknowledgement skip and the subordination of the
  directive to your own words are unchanged.
- The agent that acts on the directive stays the session model; both streams are
  told which model that is.

### One board for every planner and reviewer

Double and the scope council now say what they told the agent on the same
in-process board the Guardian, the session observer and Mr. Watchmaker already
used, and read it back. The reviewers see "Double mode already told the agent
…" and "Scope council already told the agent …" beside each other's notes, so a
note that merely restates a directive is suppressed instead of delivered twice.
While Double is on, both reviewers get one evidence row naming the mode and the
two routes, so they do not recommend repeating a deliberation the harness
already runs before every prompt. In the other direction, both Double streams
receive the reviewers' most recent notes (identically, so the shared prefix stays
byte-identical) as evidence the forked transcript does not carry. Double's own
streams and reconciliation are counted as harness-owned runs, never as children
the agent launched.

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
  (two rounds, bounded aspects, strict evidence parsing). A repair round
  re-reviews only the aspects the files changed since the last review would
  select, plus any that did not pass cleanly; a clean pass whose files did not
  change carries forward with a note naming the revision it came from.
- Harness-owned runs (scope councils, skill discovery, automatic review) are
  not the agent's children: `subagent` status on their ids explains that their
  results arrive in context by themselves, and the background reviewers count
  them separately from agent-launched children.
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
