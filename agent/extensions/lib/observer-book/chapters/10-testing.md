---
id: testing
part: engineering
title: Testing and verification
summary: Evidence that software works: the right test level, red before green, behavior over implementation, edge cases, determinism, scope of runs and honest claims.
terms: test tests testing unit integration e2e end-to-end spec assert assertion coverage fixture mock stub flaky suite ci verify verification check pass passing fail failing regression tdd jest vitest pytest mocha playwright
files: .test.ts .spec.ts /tests/ /test/ /__tests__/ /spec/
tools: bash bg_run quality_review
skills: property-based-testing behavioral-contracts evidence-first-engineering
---

# Testing and verification

A test is an executable claim about behavior. Its value is the probability that it fails when the behavior breaks and passes when it does not. Verification is the broader discipline of producing evidence—tests, builds, renders, measurements—after the last change, so that claims about the work are true.

## Run what proves the claim, after the last change {#verify-claims}
<!-- terms: verify verification run proof evidence after change claim should work | watch: edits-unverified(6) claimed-done-unverified -->

**Principle.** Evidence counts only if it was produced after the final relevant edit and actually exercises the claimed behavior.

**Why.** Agents often run tests mid-task, make further edits, then report success based on the earlier run. Every edit after a verification invalidates it for the code it touched. Likewise, a passing unrelated test proves nothing about the change. The strongest evidence is a check that failed before the change and passes after it; the next strongest is a targeted run of the tests covering the touched code, followed by the full suite when the change is broad. When verification is impossible here (no credentials, no hardware), the honest report says so.

**Signals.** Many edits since the last test or build run; a success summary citing an older run; checks that do not touch the changed module.

**Ask.** Which check ran after the last edit and exercises exactly what changed?

**Traps.** Requiring a 20-minute suite after a comment change; accepting "the build compiles" as proof of behavior.

## A test that never failed proves nothing {#red-green}
<!-- terms: fail first red green tdd regression reproduce test before fix -->

**Principle.** For a bug fix, write or identify a test that fails on the old code and passes on the new; for new behavior, confirm the test can fail.

**Why.** Tests written after the fix frequently pass for the wrong reason: they exercise a different path, mock away the bug, or assert something that was always true. Seeing the test fail first proves it detects the defect. It also documents the bug precisely for future readers and prevents regressions. When running old code is impractical, temporarily reverting the fix or inverting an assertion achieves the same check.

**Signals.** Tests added alongside a fix but never observed failing; assertions loosened until green; snapshot tests regenerated wholesale.

**Ask.** Has this test been seen failing without the fix, so we know it actually guards the bug?

**Traps.** Rigid TDD for exploratory prototypes; tests coupled to incidental output that fail for irrelevant reasons.

## Test behavior, not implementation {#behavior}
<!-- terms: behavior implementation detail mock private internal brittle refactor contract public api -->

**Principle.** Assert on observable behavior through public interfaces; mock only true boundaries such as networks, clocks and external services.

**Why.** Tests coupled to internals—private method calls, exact call counts, internal data shapes—break on every refactor while missing real regressions, which trains people to update tests mechanically. Over-mocking produces tests that verify the mocks. Behavioral tests survive restructuring and fail only when users would notice. Boundary mocks keep tests fast and deterministic without hiding the logic under test.

**Signals.** Mocks of the module under test; assertions on call order of internal helpers; tests edited in the same commit as every refactor.

**Ask.** Would this test still pass after a correct refactor, and fail if a user-visible behavior broke?

**Traps.** Refusing all mocks and writing slow, flaky end-to-end tests for pure logic.

## Put each test at the cheapest level that can catch the bug {#levels}
<!-- terms: unit integration e2e end-to-end pyramid level slow fast contract component -->

**Principle.** Pure logic belongs in fast unit tests, contracts between components in integration tests, and only critical user journeys in end-to-end tests.

**Why.** End-to-end tests are slow, flaky and hard to diagnose, but they catch wiring bugs no unit test can. Unit tests are fast and precise but blind to integration. A healthy suite has many cheap tests and a few expensive ones chosen deliberately. When a bug escapes, the right response is a test at the lowest level that would have caught it, which usually reveals a missing contract test rather than a missing end-to-end test.

**Signals.** Complex logic tested only through the UI; integration seams (serialization, database queries, API schemas) with no tests; suites too slow to run during iteration.

**Ask.** What is the cheapest test level that would have caught this defect?

**Traps.** Dogmatic ratios; skipping the one end-to-end test that proves the feature is actually reachable.

## Hunt the edges {#edge-cases}
<!-- terms: edge case boundary empty null zero one many large unicode timezone leap overflow negative concurrent -->

**Principle.** Test the boundaries where assumptions break: empty, one, many, limits, invalid, concurrent, slow, and non-ASCII.

**Why.** The happy path is the case the author already imagined; defects live at edges the author did not. A small standard checklist catches most of them: empty and single-element collections, maximum sizes, zero and negative numbers, missing optional fields, Unicode and right-to-left text, time zones and daylight-saving transitions, duplicate submissions, partial failures and retries, and concurrent modification. Property-based testing automates edge discovery for pure functions.

**Signals.** Tests only with typical inputs; parsing, dates, money, pagination or text handling without boundary cases.

**Ask.** Which boundary input—empty, huge, malformed, concurrent, or non-ASCII—would most likely break this change?

**Traps.** Exhaustive edge testing of throwaway code; edge tests that assert current buggy behavior.

## Deterministic tests or no signal {#determinism}
<!-- terms: flaky deterministic seed random clock time sleep network order isolation fixture shared state -->

**Principle.** Control every source of nondeterminism in tests: time, randomness, network, filesystem, ordering and shared state.

**Why.** A flaky test is worse than no test: it fails without a bug, teaching everyone to rerun and ignore failures, and eventually a real regression hides behind "probably flaky". Determinism comes from injecting clocks and random seeds, isolating temporary directories, stubbing external services, avoiding sleeps in favor of awaited conditions, and resetting state between tests. Quarantining a flaky test without an owner and a fix date is deletion by another name.

**Signals.** sleep calls in tests; tests reading the real clock or network; order-dependent failures; reruns used to get green.

**Ask.** What uncontrolled input could make this test pass or fail without any code change?

**Traps.** Over-engineering determinism for scripts that run once; mocking time in tests that are specifically about real timing.

## Narrow runs while iterating, full runs before claiming {#scope}
<!-- terms: run subset focused full suite slow iterate watch filter pattern | watch: tests-touched-unrun long-foreground(120) -->

**Principle.** Iterate with the smallest relevant test selection, then run the broader suite once before declaring completion.

**Why.** Running a ten-minute suite after every edit wastes time and context; running only one test before finishing misses collateral damage. The efficient loop is targeted tests (by file, name pattern or module) during development, then the full or CI-equivalent run at the end. Long runs are candidates for the background when independent work remains, but the final verification that a claim depends on should be observed to completion.

**Signals.** The full suite rerun after each tiny edit; only a single test run before finishing a cross-cutting change; long foreground runs blocking unrelated work.

**Ask.** Is the current run the narrowest one that answers the question, and will a full run happen before the final claim?

**Traps.** Background-running the final verification and never reading its result.
