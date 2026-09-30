# YunusPi 0.17.0 verification

**Pre-release verification — 2026-09-30.** The final source passed the strict distribution suite and both live candidate tasks. Simple work improved substantially; the final complex sample regressed and is reported below. Remote publication and local activation use the exact-commit safeguards described under delivery.

## Inspection and resulting changes

Inspection covered the repository-owned SDK and native tools, task and todo state, prompt interpretation, native child execution, automatic helpers, councils, Observer, Mr Watchmaker, local ranking, JEV, review settlement, tool discovery and hooks. Recent local sessions and failures were inspected without publishing their private contents. Commit history, including the 0.16.1–0.16.3 completion and background-check fixes, and the build, installer, export and GitHub release path were checked before implementation.

The changes address observed causes:

- Automatic support previously lacked a shared assessment of the current scope. A deterministic policy now selects support and reasoning for tasks, subtasks and todos, reconsiders real failures and current checks, and admits expensive work before building its context packet. Simple work can finish directly; substantial or consequential work retains bounded investigation, coordination and independent review.
- Native todo subjects, canceled startup input, changed requirements and delayed writes could leave routing or assurance attached to the wrong scope or revision. Lifecycle regressions now cover those orderings. Empty, skipped, signaled, detached, stale or failed checks cannot create a passing receipt or simplify support. Completed reviewers await an explicit parent assessment. Owned background test failures also raise support once per execution; repeated queries, stale revisions and other scopes cannot inflate the count.
- A small README correction with successful readback still triggered Guardian's generic verification continuation. Native tools now supply bounded document hashes; Guardian accepts a current complete readback only for one small explicitly requested prose-proofreading scope. Code, policy, security, operational, mixed or risky work and requested tests retain the guard. This records no test pass. Safe literal `pwd`/`ls`/`grep` discovery is recognized; opaque shell execution remains excluded.
- Deferred formatting could change source after verification or accepted review. Pi Lens now drains pending autofix and formatting before native and declared checks or review capture source identity, and before full readback of an owned modified prose document; failed or interrupted drains refuse verification. The verification boundary bypasses the ordinary recent-write debounce while preserving formatter safety and ownership. If formatting changes prose bytes after a native edit, Guardian still requires current validation of the mismatched edit/read hashes; the drain cannot authorize an exception.
- Direct sessions could wait for optional semantic memory work. Raw text, lexical indexing and provenance remain available while automatic embedding and backlog recovery are deferred for direct scopes. Explicit memory requests, substantial work and unresolved failures retain semantic indexing.
- Repeated development work now selects local stack recipes and a dependency-ordered stage ledger. Existing tools own actual execution and validation; the ledger reuses current evidence and cannot turn preparation or an unsupported claim into training, rendered interaction or deployment success. Automatic schema activation is narrower than the full available capability catalog.
- Local media production now has an executable `media_pipeline`: optional editable score creation, audio effects and mixing, voice-driven music ducking, clip or scene composition, optional measured mastering, decode verification and a delivery receipt. Final encoding is measured. Subtitles share measured narration timing; malformed timelines and silent audio return explicit findings or skips. A finalized voice bus avoids the reproduced FFmpeg 8 sidechain scheduling failure that could silently truncate or fail to duck a mix.

See [adaptive execution](ADAPTIVE-EXECUTION.md), [task pipelines](TASK-PIPELINES.md) and [media workflows](VIDEO-STUDIO.md) for the contracts and boundaries.

## Behavioral and execution checks

| Recorded check | Result | Qualification |
| --- | --- | --- |
| Complete distribution suite | 2,613 passed; 0 failed; 0 skipped; 167.1 s | Final frozen implementation; isolation, sandbox, browser and media are required; the pinned Needle CLI asset check also ran. |
| Focused Guardian, SDK, owned-core and mutation checks | 237 passed; 0 failed; 0 skipped | Includes actual native Bash discovery followed by read/edit/read, causal readback negatives, requested tests, code and policy exclusions, and ordinary write compatibility. |
| Focused media checks | 50 passed; 0 failed; 0 skipped | Real FFmpeg processing and decode, repeated ducking/sample equality, pitch preservation, denoise, measured WAV/AAC mastering, silence, cleanup, captions and actual WebGL animation. |
| Media pipeline checks after bounded binary-assertion repair | 7 passed; 0 failed; 0 skipped; 11.4 s | Uses byte-comparison helpers so a failed binary comparison cannot recreate the known unbounded diff allocation. |
| Owned-core build, public scanner, template comparisons and diff checks | Passed | Final source build and public safeguards; remote CI and activation additionally verify the exact commit. |

The real SDK proofreading regression executes only the necessary tools and finishes without a Guardian continuation or an invented check. A second SDK variant executes the observed safe Bash preflight first and still finishes without extra verification or review. Negative cases cover stale, partial, failed and overlapping reads, later writes, mixed files/code, code blocks, operational prose, opaque commands and explicit tests.

## Paired live CLI measurements

The baseline and candidate runs began with equal original synthetic fixtures: a one-line README typo, and a bounded two-module correctness task involving range clamping and empty-array summation with existing Node tests. An earlier comparison that reused an already expanded fixture was invalid and is excluded.

Each pair used the same configured main provider/model (`orcarouter`, `qwen/qwen3.8-flash`), `--thinking low`, and `PI_LOCAL_LM=off`. These are single stochastic samples, not repeated controlled trials. Completion time below runs from the emitted session start to the last `session-metrics-v1` receipt at the agent-end boundary, before final settlement and shutdown. The assistant message timestamp marks the start of its final response, so it is not used as a completion timestamp. Baseline whole-process lifetime was not recorded; candidate process lifetime is reported separately.

| Fixture and revision | Completion receipt time | Main reported tokens, including cache | Main tool calls | Logical child jobs | Auxiliary dispatch IDs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Simple baseline | 115.035 s | 141,401 | 8 | 2 | 3 |
| Simple final candidate | 25.717 s | 82,471 | 4 | 0 | 0 |
| Complex baseline | 230.018 s | 331,267 | 20 | 2 | 5 |
| Complex intermediate candidate | 188.722 s | 406,168 | 20 | 2 | 2 |
| Complex final candidate | 327.896 s | 852,902 | 30 | 3 | 3 |

The final simple sample corrected the file and checked its complete current contents, with no tool errors or Guardian continuation. Completion-receipt time decreased 77.6%, reported main tokens decreased 41.7%, and tool calls fell from eight to four. It used no logical child or auxiliary model dispatch. Candidate whole-process lifetime was 38.163 seconds. An earlier source-equivalent simple candidate also completed correctly in 24.462 seconds with three calls and 66,411 reported main tokens; the table uses the last run after the final audit fixes.

**The complex performance regression remains.** The intermediate sample reached completion 18.0% sooner but used 22.6% more reported main tokens. Investigation found source formatting occurred after accepted review; the final implementation drains it before verification. The final sample completed correctly, but its completion receipt was 42.6% later and reported main tokens increased 157.5%. Main calls rose from twenty to thirty, and one repeated review raised logical children from two to three; auxiliary dispatch IDs decreased from five to three. Its whole-process lifetime was 339.219 seconds.

The final trace reproduced both original test failures, fixed both implementations, expanded the suite from two to six tests, and performed a scratch mutation comparison against the original defects. It also attempted to finish before assurance was settled. After the first review passed, it deleted its cited test-output file, correctly invalidating that evidence and causing another assessment/review sequence. A configured helper route was unavailable and the existing fallback chain continued. These observations explain concrete additional work; one stochastic pair cannot isolate how much timing/token variation comes from routing, provider availability, cache state, richer test output or model decisions. This is not evidence that complex tasks universally became faster.

Final correctness was independently checked after CLI exit: all six Node tests pass, the last review is accepted at revision 3, and all recorded reviewed-source hashes match the actual delivered files. Final settlement did not mutate the accepted source. Evidence removal was rejected as stale rather than silently accepted. The unresolved limit is complex end-to-end cost under inefficient tool/evidence ordering; the deterministic scheduler savings below do not remove that model-dependent cost.

| Main usage breakdown | Input | Cache read | Output |
| --- | ---: | ---: | ---: |
| Simple baseline | 24,417 | 115,200 | 1,784 |
| Simple final candidate | 4,548 | 77,312 | 611 |
| Complex baseline | 44,657 | 279,808 | 6,802 |
| Complex final candidate | 101,658 | 738,816 | 12,428 |

A separate schema measurement identified 2,603 serialized bytes of automatically exposed generic/control schemas that could be excluded from ordinary Node/Python work while keeping them deliberately discoverable. This is a measured context reduction; it does not explain the entire complex token regression, and it is not a billed-token saving estimate. Cached prefix size, execution sequence, model choices and repeated context all affect reported usage.

Reported token totals are main-model usage, including cache-read tokens. Reasoning counts are part of the provider's reported output and are not added again. These totals are neither billing nor a sum of all auxiliary model costs. Logical child jobs and auxiliary dispatch IDs count observed coordination identities, not every local subprocess. No statistical guarantee or general task-speed claim follows from these samples.

## Deterministic scheduler replay

The benchmark runs the actual Observer/Watchmaker scheduler against equal simulated 180-second task timelines and fixture responses, with and without the shared execution policy. Nine local repetitions supply replay timing summaries; dispatches and packet builds are measured, while packet input tokens are estimated from UTF-8 bytes divided by four.

| Replay scope | Dispatches and packet builds before → after | Estimated packet input tokens before → after | Local replay median before → after |
| --- | ---: | ---: | ---: |
| Direct | 9 → 0 | 14,220 → 0 | 2.889 → 0.089 ms |
| Complex | 9 → 4 | 14,301 → 6,356 | 2.593 → 1.419 ms |
| Critical | 9 → 7 | 13,334 → 10,371 | 2.331 → 1.889 ms |

Required capabilities remained callable in every replay; completed checks did not trigger duplicate automatic work. These timings measure local scheduler evaluation, not live inference or end-to-end completion. Estimated packet tokens are not provider usage or billing.

Reproduce the replay with:

```sh
PI_LOCAL_LM=off node agent/scripts/adaptive-execution-bench.mjs
```

## Executable media comparison

An isolated local comparison used the same score and output requirements for `music_compose` → `audio_mix` → `audio_analyze` and one `media_pipeline` call. Model/tool round trips decreased from three to one. Recorded local processing time decreased from 360 to 301 ms; the delivered WAV bytes and measured loudness were identical. Response JSON decreased from 2,188 to 1,076 bytes in that measurement by avoiding repeated source and stream context.

This measures deterministic local work and response size. Model token usage and provider round-trip latency were not measured, and the one timing sample is not a throughput guarantee. Other real media tests verify output duration, repeatable ducking and recovery, final AAC measurements, decoded animation and failure cleanup. Playback inspection remains necessary for artistic approval.

## Delivery and reproduction

The release version is 0.17.0 across the root, lockfile, identity, six owned packages and export template. The official build produced 1,191 owned-core source files with source digest `9f57c3e9c1ae8e33dafc7979b61c78b6084e442ce5f75883ae29ecc32c06834b`. The candidate was installed through the official state-preserving installer; live experiments used that runnable installation, not isolated policy mocks.

The [main safety workflow](../.github/workflows/public-safety.yml) runs the complete distribution suite with real execution prerequisites and the actual-scheduler benchmark. `release-tag.mjs` waits for successful main CI at the exact pushed commit before creating the immutable version tag. The publishing job independently verifies that commit's successful safety job and the tag object before publishing [v0.17.0](https://github.com/yunusemrejr/yunuspi/releases/tag/v0.17.0). Local activation then uses the same committed source, a private rollback backup and preserved settings/state; installation and owned-core receipts must agree with the tag's exact commit. Publication/activation receipts are checked after commit creation and reported with the delivered release.

Reproduce the strict suite with the appropriate host prerequisites installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:core
PI_LOCAL_LM=off PI_REQUIRE_ISOLATION_TEST=1 PI_SANDBOX_REQUIRE=1 PI_BROWSER_REQUIRE=1 PI_REQUIRE_MEDIA_TEST=1 node --test --test-concurrency=4 tests/*.test.mjs
```

Set `PI_NEEDLE_TEST_ASSETS` to a verified pinned Needle asset directory to include the optional CLI asset smoke test, as in the recorded zero-skip local run. Live fixtures start with `Use teh documented command.` for the simple correction, and a swapped `Math.max(high, Math.min(low, value))` clamp plus unseeded `values.reduce((a,b) => a+b)` sum for the two-module diagnostic. The complex fixture starts with two tests, not the expanded tests produced by an earlier run. Use the same request, model/configuration and original files on both versions; preserve failed and regressed samples when reporting results. Raw private sessions and provider credentials are intentionally excluded from the public report.

Linux is the tested runtime target. Workflow selection and preparation checks do not establish live Google Colab training, local model finetuning, Namecheap/GoDaddy hosting, SSH deployment or production-site behavior. This work does not claim validation of a newly authored production film, actual Piper narration inference, or artistic approval of generated media. Private session content, credentials and local model environments are not part of the release inputs.
