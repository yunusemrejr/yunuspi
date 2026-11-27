---
name: build
description: "Code, systems, APIs, data and ML — one short method for building and verifying software."
---

# Build — code, systems, data, ML

Good code does what the person needs, the next reader understands it, and it fails loudly instead of quietly. The project's own conventions win.

## Before writing
- What is it for: who runs it, how often, on what data, what happens if it is wrong. A one-off script, a private tool and a public service deserve different amounts of everything.
- Read the neighbors: how this codebase handles errors, config, logging, naming, data access and tests. Use its helpers and dependencies; read the exact region before editing.
- Check, do not recall: library and CLI interfaces change. Look at the installed version, its types or `--help`. Many libraries publish their docs as `/llms.txt` or `.md` pages; the `research` skill says where to find them.

## Design
- Simplest thing that fully works: delete code, use the platform, use a dependency already present, write a little code, only then add a dependency or a structure. Nothing "for later"; generalize at the third real repetition.
- Data first. Prefer types that cannot hold an invalid state. A function turns inputs into outputs; side effects (files, network, clock, randomness) live at the edges. One source of truth: derive, do not copy.
- Real logic: no keyword matching, hard-coded answers or test-only branches standing in for the rule.

## Boundaries and failure
- Validate what comes from outside once, at the edge, into typed values; trust it inside. One writer per contended state.
- Fail early with what was expected and what arrived. Never swallow an exception, return a made-up success or fall back silently.
- Network calls have a timeout and bounded retries. Operations that may run twice (retries, restarts halfway) must be safe to repeat.
- What fails first: empty, one, many, null, huge, duplicates; Unicode and Turkish dotted/dotless i; time zones and DST, UTC storage; money in integer minor units; first/last/off by one; two runs at once; failure halfway; injection (parameters, argument lists, escaping, path traversal); secrets only from the environment.

## Changing existing code
- Smallest diff. No unrelated reformatting, no refactor mixed into a fix. Keep what others depend on (public functions, formats, flags, env names) or migrate it. Delete dead code. Before anything destructive: look at the target, dry-run, confirm.

## Tests and checks
- Test public behavior: happy path, one failure, one boundary. A fixed bug gets the test that failed before. No tests that restate the code or mock everything.
- Run what the change can break; run the whole suite once before a commit or release. Rerun the check after the last edit and state what is unverified. The proof is the real thing running on real input.
- Profile before optimizing; fix the algorithm, the query in a loop, the unbounded read first; report p95/p99, not averages alone.
- Git: never commit, push or rewrite history unless asked. Databases: safe migrations, explicit transactions.
- ML: leakage-safe splits, calibrated metrics, no silent model swaps.

## Debugging: evidence before edits
1. Read the whole error and logs (first error, full stack, timestamp, exact command and input). Check what is running (version, config, environment, data) and what changed since it last worked.
2. Reproduce with a command or payload that fails every time; if intermittent, measure the failure rate over a fixed number of runs. If it cannot be reproduced, say so and ask for the missing piece.
3. Minimize the input, then bisect: time (`git bisect run ./repro.sh`), code (disable parts, halve the path), data (halve rows), config (diff and apply half).
4. One falsifiable hypothesis at a time ("two requests write `balance` between read and update", not "maybe a race"); change one thing per run. Instrument boundaries with ids, counts and timings, not raw secrets; remove the instrumentation afterwards.
5. Fix the cause, not the symptom. A retry, wider timeout or catch-and-ignore is a stop-gap: say so and keep the cause open.
6. Turn the reproducer into a test that fails before and passes after. Sweep sibling code for the same mistake and fix or list each hit.
7. After two failed fixes stop guessing: read the whole path from entry to failure, get another view (the advisor or reviewer, or the user for a missing artifact), change level (the layer below or above), and test the assumption you never tested (the code runs at all, the build is current, the cache is empty).
- Intermittent: shared state, time, one row, resource exhaustion; never retry a flaky test until green. Works here, fails there: enumerate every difference. Hang: find where it waits (`strace -p`, stack dump). Slow: profile first. Killed: `dmesg` or `journalctl -k` for OOM.
- "Fixed" needs a run that exercises the failing condition; for races repeat the baseline number of runs and give the counts. Report cause with evidence, what changed, the passing check, siblings checked, what stays unverified.

For work shared with another session, open the [change handoff](examples/change-handoff.md) and keep only the fields that save the next person a read or a check.
