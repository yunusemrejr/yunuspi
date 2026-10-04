# Competence control

Optional coordination (periodic observers, completion reviewers, automatic
helpers) is a cost paid to lower the cost of mistakes. YunusPi therefore
allocates it from what the executing route is measurably doing, never from a
model name. `agent/extensions/lib/model-competence.ts` turns observed tool
outcomes into a control level; `adaptive-execution.ts` applies it to the same
admission policy that already owns coordination, and `adaptive-workflows.ts`
feeds it live. Nothing here adds a parallel controller, and nothing here can
remove a required check, a user constraint or authority.

## What is measured

Every finished tool call becomes one outcome, classified without inference:

| Outcome | Examples | Counts as |
| --- | --- | --- |
| clean | any successful call; a passing project check | evidence of clean execution |
| slip | invalid arguments, an edit whose `oldText` does not match, an invented path, a shell syntax error, a call the guard refused | model-attributable waste (weight 0.5 to 1) |
| check | a failing build or test after the model's change | small weight (0.3), expected iteration |
| gate | a completion or review call the harness rejected as premature | weight 0.5 |
| stall | an identical call returning an identical result while the workspace did not change | weight 0.4 to 0.8 |
| reversal | an edit that restores text an earlier edit removed from the same file | weight 0.8 |
| neutral | provider and network failures, timeouts, user aborts, polling, `grep` finding nothing | ignored |

Weights are small where the cause is ambiguous, so the estimate is driven by
clear, repeated evidence.

## Two structures, two timescales

Measured on 20,581 recorded tool steps from 162 sessions (the weighted slip
rate was 3.8%, strong slips 2.4%):

- **Bursts.** Failure is self-exciting. After a slip the next step slips 10.9%
  of the time against 2.3% after a clean step, and the effect fades within about
  five steps. Two strong slips among three steps predict another within five
  steps 31% of the time against a 10.7% base rate. A burst is a short
  transient: it raises a direct scope to verification support for its duration
  and sends one targeted `[recovery]` note into the failing tool's result (for
  edits: re-read the exact region and copy `oldText` verbatim instead of
  retyping it). It never starts a helper agent. A clean step of the failing
  family ends it.
- **Baseline.** Routes and sessions differ only by about 2x in long-run slip
  rate, so telling 4% from 8% needs roughly 200 weighted observations. The
  baseline uses long memory (half-life of about 138 steps) plus aged history
  from earlier sessions of the same route. Its Wilson interval is compared with
  the fleet's own rate, which the store derives from every route on this
  installation, so thresholds follow the installation instead of fixed numbers.

## Levels

| Level | Condition | Effect on optional coordination |
| --- | --- | --- |
| earned | the whole interval is below 1.2x the fleet rate, at least 60 weighted observations, every slip repaired | observer cadence doubled, periodic watchmaker review only once failures appear, one reviewer fewer for complex work, no automatic helper for open-ended work alone, a standard-scope change of up to four files with resolved checks needs no copy reviewer |
| standard | not enough evidence, or in between | the established policy, unchanged |
| guarded | the whole interval is above 1.4x the fleet rate, at least 10 observations | observer cadence halved and enabled even for direct work, independent review of code changes (prose-only changes stay exempt), two reviewers for standard scope |

Freedom needs the **upper** bound to be low (trust is earned, not assumed);
tightening needs the **lower** bound to be high (a noisy streak is not
unreliability). A level is kept at least 12 steps and uses hysteresis (earned is
left at 1.6x, guarded at 1.0x). An unrepaired slip blocks `earned` until its
tool family succeeds again or twelve steps pass. Critical scope, unresolved
failures, user constraints such as "do not spawn helpers", explicit model
choices and every required check ignore the level. Deliberate calls to
`quality_review`, councils and swarms remain available at every level.

Changes are visible: a level change or burst appears once in the transcript as
`Oversight · …`, and the published `adaptive-execution-v1` entries record
`control`.

## Persistence

`<agent dir>/competence/routes.json` keeps one aged aggregate per route
(`provider/model`) plus the fleet row `*`: weighted slips and observations,
decayed with a 14-day half-life. Sessions add commutative increments (read,
merge, atomic rename), so concurrent sessions cannot overwrite each other. A
missing, corrupt or unwritable store only means a session starts from the
neutral prior. Child agents never write to it. `PI_COMPETENCE_STORE=off`
disables persistence; `PI_ADAPTIVE_EXECUTION=off` disables the whole policy.

## Calibration and verification

`node agent/scripts/competence-replay-bench.mjs` replays outcomes through the
real estimator and the real policy and checks that the levels order future
outcomes. The default is a seeded synthetic workload with the measured
structure (CI runs it); `--sessions <dir>` replays recorded session JSONL
locally and prints only aggregates. On the recorded sessions the replay gave:

| Level | Share of steps | Strong-slip rate over the next 20 steps |
| --- | --- | --- |
| earned | 18% | 2.1% |
| standard | 79% | 2.7% |
| guarded | 2.5% | 5.2% |

and a burst predicted a further slip within five steps 31% of the time against
10.7%. The thresholds were chosen by sweeping the multiples above on those
sessions; levels are rare enough to mean something and change about once per
200 steps.

## What this does not claim

The classifier is heuristic text matching, so the estimate measures tool-use
precision and discipline, not the quality of the solution. The replay measures
how well the levels predict slips; it does not measure live task completion,
cost or session length end to end. The same recordings show that sessions are
already lean (about two thirds of active time is model-turn latency, optional
helpers well under 1%), so the control reallocates oversight rather than
promising a large aggregate saving. Only 14% of independent-review reports on
those sessions were usable (reviewers failing to start, deadlines, invalid
JSON); reviewer-route reliability keeps its own existing demotion rule and is a
separate, open problem.
