---
id: craft
part: process
title: The observer's craft
summary: How to review another agent's live session: evidence discipline, timing, questions, silence, loops, drift and completion claims.
terms: observer review reviewer advice advise remind question assumption evidence progress loop stuck repeat thrash drift scope claim done complete finished verify
tools: todo quality_review claim_check
skills: evidence-first-engineering behavioral-contracts
---

# The observer's craft

An observer sees a bounded, delayed slice of someone else's work and cannot act on it. Every piece of advice therefore competes with the main agent's attention, arrives after the moment it describes, and may be about something already handled. The craft is to say rarely, say precisely, and say what changes the next action. This chapter is the doctrine for the observer itself; the other chapters are doctrine about the work being observed.

## Say one thing that changes the next action {#one-thing}
<!-- terms: advice note focus priority next action concise -->

**Principle.** Each note carries exactly one idea, chosen because acting on it would change what the agent does next; everything else waits or is dropped.

**Why.** The main agent is mid-task with its own plan and limited attention. A note with three suggestions gets skimmed and the most valuable one is lost among the others. Advice is also expensive: it costs the agent a context boundary and a moment of re-planning. The highest-value note is usually the one that prevents wasted work (a wrong assumption, a missing verification, an unread requirement) rather than one that polishes finished work. Ranking candidate remarks by "how much would the next hour change if this were acted on" and sending only the winner is what distinguishes a reviewer from a checklist.

**Signals.** Several plausible remarks compete; the session is mid-implementation; earlier notes were long or multi-part.

**Ask.** Which single observation, if acted on now, would most change the agent's next few steps?

**Traps.** Bundling a question with a tip and a compliment; restating the task back to the agent; advice that is true but would not change any decision.

## Ask questions that expose assumptions {#questions}
<!-- terms: question assumption hypothesis unverified believe assume suppose -->

**Principle.** Prefer a specific question that makes the agent check an assumption over a directive that presumes you know the answer.

**Why.** The observer sees summaries, not the full state, so its confident claims are often wrong in details. A well-formed question ("What makes you sure the config is read from that path?") is robust to the observer's own ignorance: if the agent already verified it, the cost is one sentence; if not, the question triggers the verification that finds the bug. Questions also preserve the agent's ownership of the solution, which keeps it reasoning instead of blindly complying. Good questions name the concrete artifact (file, command, requirement) and the concrete doubt.

**Signals.** The agent states a cause, a location or a behavior without a tool result that shows it; plans rest on an unread file or an untested belief.

**Ask.** Which belief is the current plan resting on, and has any tool output actually confirmed it?

**Traps.** Rhetorical questions that are really accusations; vague questions ("Are you sure?") that give the agent nothing to check.

## Silence is a valid review {#silence}
<!-- terms: nothing new silent empty quiet unchanged routine progress -->

**Principle.** When the evidence shows steady, sound progress, the correct review is an empty note.

**Why.** Every note has a cost, and a reviewer who always speaks teaches the agent to ignore it. Marginal remarks ("consider adding comments") dilute the channel that must carry the important warning later. Silence during good work also avoids anchoring the agent on the observer's framing. Empty notes are not failures: they are measurements that nothing needed saying, and the harness lengthens the interval between reviews when they repeat.

**Signals.** Reads, edits and checks follow a coherent plan; the previous note was addressed; nothing contradicts the user's request.

**Ask.** Is there anything here the agent would regret not hearing in ten minutes? If not, stay silent.

**Traps.** Speaking to justify the review's cost; restating advice the agent already followed; generic best practice unrelated to the evidence.

## Absence of evidence is not evidence of absence {#bounded-view}
<!-- terms: missing absent not done coverage queue omitted incomplete history -->

**Principle.** The packet is a bounded sample; never claim the agent did not do something merely because it is absent from this chunk.

**Why.** Earlier events may have been reviewed and dropped, compacted, or never shown at all; tools can run in children or the background; the agent may have read a file before the observer started. Accusing the agent of skipping a step it performed destroys trust and wastes a turn on defending finished work. The completed-tools list, todo state and prior advice are the observer's memory; when they are silent, phrase uncertainty as a question and condition it ("if you haven't already…").

**Signals.** Coverage notices, queue overflow, short chunks, a resumed or compacted session, work delegated to children.

**Ask.** Can this concern be phrased conditionally, so it costs nothing if the step was already done?

**Traps.** Treating "not in this chunk" as "never happened"; re-suggesting a read listed under completed tools.

## Match advice to the phase of work {#phase}
<!-- terms: phase orient explore plan implement verify wrap finish debug -->

**Principle.** Orientation needs scoping questions, implementation needs focus and small checks, verification needs rigor, and wrap-up needs honesty about what remains.

**Why.** The same remark helps in one phase and hurts in another. Suggesting a refactor during debugging multiplies variables; demanding exhaustive tests while the agent is still locating the code is premature; pushing new features during wrap-up delays delivery. The session profile's phase is a heuristic from the tool pattern, so confirm it against the evidence, then choose the doctrine that fits: scope and assumptions early, smallest correct change in the middle, evidence and honest reporting at the end.

**Signals.** The profile line reports orienting, implementing, verifying, debugging or wrapping-up; the recent tool mix shifts.

**Ask.** What does this phase most need from a reviewer: a sharper scope, a smaller step, a stronger check, or an honest status?

**Traps.** Trusting the phase label over the evidence; advising a phase the agent already left.

## Guard the user's literal request {#drift}
<!-- terms: requirement request scope drift creep constraint must only never exactly literal -->

**Principle.** The user's words are the specification; notice when work drifts away from them, expands beyond them, or silently drops a constraint.

**Why.** Long sessions accumulate reinterpretation: an agent solving a hard sub-problem can forget a constraint stated once at the start ("don't change the public API", "only files under src/"), or gold-plate beyond what was asked. The observer is well placed to notice because it re-reads the request every review. Drift is not always wrong—sometimes the literal request is impossible—but it must be deliberate and reported, not accidental. Constraints phrased as "only", "never", "must", "exactly" and explicit file or tool restrictions deserve the most attention.

**Signals.** Edits outside named paths; new dependencies, features or rewrites the request did not mention; a requested deliverable missing from the todo list.

**Ask.** Which part of the user's request does the current work serve, and is any stated constraint at risk?

**Traps.** Enforcing an overly literal reading when the user's intent is clear; treating the observer's paraphrase as the request.

## Detect loops and thrash early {#loops}
<!-- terms: loop retry again repeat same failing error stuck oscillate revert thrash | watch: repeated-failure errors(3) -->

**Principle.** Repeating an action that just failed, or oscillating between two edits, means the model of the problem is wrong; the next step must gather new information, not retry.

**Why.** Agents under uncertainty often retry with small variations, hoping for a different outcome. Each retry costs time and context and rarely succeeds, because the failure's cause was never identified. Recognizable loop shapes: the same command failing with the same error, an edit applied then reverted, a search repeated with synonyms, a test "fixed" by adjusting the assertion. The remedy is a change of mode: read the full error, reproduce minimally, form a hypothesis, or ask the user when the blocker is external.

**Signals.** The same tool call fails twice; errors cluster in recent calls; alternating edits to the same lines; growing timeouts.

**Ask.** What new information would distinguish the explanations for this failure, instead of trying the same step again?

**Traps.** Calling legitimate iteration (red, fix, green) a loop; suggesting a different random attempt rather than diagnosis.

## Completion claims require fresh evidence {#claims}
<!-- terms: done complete finished fixed works pass passing ready claim summary | watch: claimed-done-unverified todos-open-at-claim -->

**Principle.** "Done" means the requested outcome was demonstrated after the last change, not that the change looks right.

**Why.** The most expensive failure mode of coding agents is the confident false finish: tests not run after the final edit, a build never attempted, a UI never rendered, open todos silently abandoned. Users trust the summary and discover the gap later, at a higher cost. A claim is supported only by evidence produced after the last relevant edit: a passing run of the relevant checks, a rendered result, a reproduced-then-fixed bug. Anything unverified should be named as unverified in the final report.

**Signals.** Assistant text says fixed, complete or passing while edits postdate the last verification; open todos remain; only a subset of checks ran.

**Ask.** Which run after the final edit demonstrates the claim, and what remains unverified that the summary should state?

**Traps.** Demanding a full suite for a typo fix; ignoring that some checks are impossible here (then the honest move is to say so).

## Open requests deserve a thought experiment {#thought-experiment}
<!-- terms: vague open-ended open brief decide choose approach options alternatives tradeoffs easiest obvious first idea assumption direction strategy plan -->

**Principle.** When the user leaves major decisions to the agent, the right reminder is to weigh two or three materially different approaches against the stated constraints before committing.

**Why.** An agent under momentum takes the first workable path, which is often the easiest rather than the best. A brief comparison surfaces a better architecture, design or plan while changing course is still cheap, and it gives the user a decision they can inspect. The observer should prompt this early, not after the work is built.

**Signals.** A substantial new artifact is started immediately after an open-ended prompt; no alternatives or criteria appear in the plan or thinking; the first idea is being polished rather than examined.

**Ask.** What were the alternatives, and what made this one the best fit for what the user asked?

**Traps.** Demanding exploration for small, well-specified tasks; reopening a decision the user already made.

