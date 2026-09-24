---
id: debugging
part: engineering
title: Debugging
summary: Systematic diagnosis: reproduce, read the first error, one falsifiable hypothesis at a time, bisect, environment differences, causes over symptoms.
terms: bug debug debugging error exception crash fail failing failure broken stack trace traceback reproduce repro regression flaky intermittent investigate diagnose root cause why wrong unexpected
tools: bash obs_read git_info workspace_search
skills: debugging evidence-first-engineering
---

# Debugging

Debugging is applied epistemology: the bug exists because some belief about the system is false, and the job is to find which one as cheaply as possible. The failure modes are well known—guessing, changing several things at once, trusting a stale mental model, fixing the symptom—and so are the remedies.

## Reproduce before you fix {#reproduce}
<!-- terms: reproduce repro minimal case trigger steps deterministic -->

**Principle.** A bug you cannot trigger on demand is a bug you do not yet understand; build a reliable reproduction before changing code.

**Why.** Without a reproduction there is no way to know whether a change fixed the problem, masked it, or did nothing while the bug went quiet by chance. A reproduction turns debugging from speculation into measurement: each hypothesis can be tested in seconds. Minimizing it (smallest input, fewest steps, one process) usually reveals the cause on its own, because every removed element that keeps the bug alive is eliminated as a suspect. The reproduction later becomes the regression test.

**Signals.** Edits made to "fix" a failure never observed in this session; reports from the user with no local reproduction attempt; intermittent failures handled by guesswork.

**Ask.** What command or input reproduces the failure right now, and does it still fail after the change?

**Traps.** Spending an hour perfecting a reproduction for an obvious one-line bug; assuming the user's environment matches the local one.

## Read the whole error; the first one is the cause {#read-error}
<!-- terms: error message stack trace first root cause warning output log line -->

**Principle.** Read the complete error output from the top; the earliest failure usually causes the rest, and the message often names the fix.

**Why.** Build tools and test runners cascade: one missing import produces dozens of downstream type errors; one failed fixture fails every test after it. Agents scanning only the last lines of output chase the noise at the bottom. Error messages also carry precise data—file, line, expected versus actual values, the failing path—that guessing discards. Truncated tool output is a common trap: if the output was clipped, retrieve the beginning before theorizing.

**Signals.** Fixes targeting the last error in a long log; output marked truncated; the same class of error persisting after several "fixes".

**Ask.** What is the first error in the full output, and what exact values or paths does it report?

**Traps.** Treating warnings as the cause of an unrelated failure; ignoring the first error because it looks unrelated.

## One falsifiable hypothesis at a time {#hypotheses}
<!-- terms: hypothesis theory guess assume test experiment predict change one variable -->

**Principle.** State a hypothesis, predict what an observation would show if it were true, run that observation, and change only one variable per experiment.

**Why.** Changing three things at once and seeing the bug disappear teaches nothing about which change mattered, and often leaves two unnecessary changes behind that cause new bugs. A falsifiable prediction ("if the cache is stale, clearing it makes the second request pass") makes each step informative whether it succeeds or fails. Writing the hypothesis down also exposes when the agent is guessing: a hypothesis with no predicted observation is not being tested.

**Signals.** Several speculative edits between test runs; fixes justified with "might", "maybe", "should"; no observation distinguishing competing explanations.

**Ask.** What is the current hypothesis, and what observation would prove it wrong?

**Traps.** Analysis paralysis on trivial bugs; testing hypotheses in an environment that differs from the failing one.

## Bisect instead of reasoning when the space is large {#bisect}
<!-- terms: bisect binary search git bisect worked before regression commit version narrow -->

**Principle.** When something used to work, binary-search the difference—commits, dependency versions, input halves, config keys—rather than theorizing.

**Why.** Bisection finds the culprit in log2(n) steps regardless of how well the system is understood. It beats intuition exactly when intuition is weakest: large diffs, unfamiliar code, emergent interactions. `git bisect` with an automated test is the canonical form, but the same idea applies to halving a failing input file, toggling half of a feature flag set, or pinning half of the upgraded dependencies.

**Signals.** "It worked yesterday"; a dependency upgrade preceded the failure; a large input fails while small ones pass; long theorizing without narrowing.

**Ask.** Is there a known-good state, and can the difference be halved mechanically until one change remains?

**Traps.** Bisecting across commits that do not build; flaky tests producing wrong bisection verdicts.

## Suspect the environment early {#environment}
<!-- terms: environment version path env variable cache node python install locale timezone permissions works on my machine -->

**Principle.** When code that looks correct misbehaves, check the environment: versions, paths, environment variables, caches, permissions, locale and time.

**Why.** A large share of "impossible" bugs are environmental: a stale build artifact, a different runtime version than the lockfile expects, a global install shadowing a local one, an unset variable defaulting silently, a cached response, a file permission, a time zone that shifts a date. These are cheap to check and expensive to reason around. Printing versions and effective configuration at the start of an investigation often ends it.

**Signals.** Behavior differs between tools or shells; "command not found" or version warnings; errors after installs or upgrades; date or encoding surprises.

**Ask.** Which versions, paths and environment values are actually in effect where the failure occurs?

**Traps.** Blaming the environment to avoid reading the code; "fixing" by clearing every cache without learning which one was stale.

## Fix causes, not symptoms {#root-cause}
<!-- terms: root cause symptom workaround patch band-aid why underlying design -->

**Principle.** Ask "why" until you reach a decision or invariant that was wrong; fix there, and treat symptom patches as explicit, labelled workarounds.

**Why.** Symptom fixes—catching the exception, adding a null check, special-casing the failing input—make the test pass while the underlying defect keeps producing new symptoms elsewhere. The root cause is usually a broken invariant: data allowed into a state it should never have, an ordering assumption, an ownership confusion. Fixing it there removes the whole family of symptoms. Sometimes a workaround is the right call (deadline, third-party bug), but it should be named as such with the real cause recorded.

**Signals.** A fix that adds a guard at the crash site without explaining how the bad value arose; special cases keyed on specific inputs; repeated similar bugs.

**Ask.** How did the bad state arise in the first place, and would this fix prevent it or only hide it?

**Traps.** Rewriting a subsystem when a local fix at the true cause suffices; infinite "why" chains past the point of actionability.

## Timing bugs are never fixed by retries {#heisenbugs}
<!-- terms: race condition timing flaky intermittent sleep retry timeout concurrency async order nondeterministic | watch: repeated-failure -->

**Principle.** Intermittent failures reveal a real ordering or resource assumption; sleeps and retries hide them until production.

**Why.** Flakiness means the outcome depends on something uncontrolled: scheduling, network latency, shared state between tests, clock time, randomness, resource exhaustion. Adding a sleep lowers the frequency and removes the signal while leaving the bug. Real fixes make the dependency explicit: await the actual condition, isolate shared state, inject clocks and seeds, bound resources. Running the failing test many times in a loop, with the order randomized, is the standard way to make an intermittent bug frequent enough to study.

**Signals.** Sleep or retry added to make a test pass; failures that disappear on rerun; tests passing alone but failing together.

**Ask.** What exactly must happen before this step succeeds, and is the code waiting for that condition or for time?

**Traps.** Declaring a failure flaky after one passing rerun; ignoring genuine infrastructure flakiness that should be isolated rather than fixed in product code.

## Instrument deliberately, then clean up {#instrument}
<!-- terms: log logging print debug instrument trace breakpoint console debugger remove -->

**Principle.** Add observation points that answer a specific question, and remove temporary debugging code before finishing.

**Why.** Targeted logging at a boundary—inputs, outputs, and the decision taken—answers questions that reading cannot. But scattering prints everywhere floods output and context, and forgotten debug statements ship: they leak data, slow hot paths and confuse future readers. Each probe should correspond to a hypothesis, and the cleanup should be part of the fix.

**Signals.** Many print or console.log statements added; noisy output drowning the relevant line; debug code still present in the final diff.

**Ask.** Which question is each probe answering, and are temporary probes removed from the final change?

**Traps.** Logging secrets or full payloads while debugging; removing permanent, useful diagnostics along with temporary ones.
