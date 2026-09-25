# Guardian implementation audit

Independent implementation audit, 2026-09-23. Starting public/installed revision:
`51b2d7ffb19876b6ecc38a58b5855a054a89e9d2`. Guardian, prompt analysis, and the
routing editor initially existed only in an unpublished working copy. The audit
integrated that work with the current owned core, repaired defects, and checked
source/export/installation parity. This report distinguishes exercised behavior
from architecture that is still absent.

## Subsequent coordination and kernel update (2026-09-25)

The audit below is a historical record. The current supervisor has six detectors, documented
in [Guardian Intelligence](GUARDIAN-INTELLIGENCE.md). The subsequent changes add causal
verification generations, owned background-check completion, cooldown fairness, fresh
OFF/ON working evidence, and Guardian-to-reviewer advice deduplication scoped to the live
session manager. The C++ similarity kernel preserves exact multiset Dice scores while
using an identical-input fast path and bounded O(n log n) comparison. The model weights,
threshold and synthetic calibration claims remain unchanged.

Regression fixtures exercise overlapping checks/edits, identical timestamps, partial
mutations, pending/failed/foreign background jobs, masked exits, reviewer ownership and
more than 600 differential similarity cases. These are offline behavior checks, not a
claim of semantic correctness or whole-session speedup. Rebuild provenance and the
public scanner fingerprint accompany the modified binary.

### Kernel comparison

On Node 22.22.3/Linux with Clang 21.1.8, alternating old/new kernels in one process
(10 measured batches of 5,000 calls after two warm-up batches) gave these median
batch means for the raw exported similarity function:

| Input | Previous | Updated |
| --- | ---: | ---: |
| Typical identical argument shape | 1.56 µs | 0.40 µs |
| 512 identical bytes | 152.54 µs | 3.65 µs |
| 512 disjoint bytes | 311.25 µs | 11.29 µs |

This comparison excludes host encoding, event dispatch and model inference. Separate
full-supervisor runs on the busy laptop were noisy and did not demonstrate an end-to-end
speedup. The binary grew from 943 to 1,437 bytes; its fixed 128 KiB memory and import-free
ABI are unchanged. Source-built hashes and score equivalence are independently checked.

## Verified correct

| Requirements | Runtime path and evidence |
| --- | --- |
| Guardian defaults and agent classes (1, 12, 28) | Every SDK `AgentSession` owns a default-enabled supervisor. Main/child launch paths use this session owner. Real SDK tests run actual failing builtin edits through WASM, steering, and the next provider context; two concurrent sessions verify ON/OFF isolation. Existing child/swarm/fusion/council/review suites cover their launch mechanisms. These tests do not constitute live inference on every agent/model combination. |
| Signals, confidence, silence, templates (2–5, 7–8) | Typed tool outcomes, bounded exact argument/error fingerprints, response epochs, request lineage, verified literal user constraints, successful canonical file paths, freshness and independent evidence gates feed two bounded detectors. Topic words alone have no activation path. Templates use fixed text backed by verified path evidence; missing or contradictory evidence abstains. Arbitrary architecture decisions are not classified. |
| Timing, isolation and WASM (6, 9–11) | Event-triggered evaluation, at most 16 candidate evaluations/two minutes; no idle polling timer. Separate session WASM instances, fixed 128 KiB/module memory, hash/version checks, quarantine, input validation, OFF and stale-completion tests. Four-process benchmark checks isolated intervention counts. |
| Intelligence visibility (13, 29–30) | Actual JEV results, Needle calls, accepted retrieval, fuzzy recovery, neural ranking and consumed Smol/Kompress projections reach the existing activity system. Controlled messages stay visible and excluded from model context. Async session scope keeps hooks, commands, tools, metrics and late completions isolated. Tests drive the real extension loader and tool wrapper, including equal textual session IDs with distinct owners. |
| Initial/follow-up intent and authority (14–16) | Real SDK → input hook → configured routes → `ModelRegistry`/`ModelRuntime` → native provider → structured analysis → separate advisory message → main provider. Raw user text remains unchanged. Tests cover automatic-event exclusion, cancellation, active-branch restore, queued follow-ups, bounded earlier requirements and aborted navigation. |
| Routing and fallbacks (17, 19, 25–27) | Canonical role preferences resolve ordered model/backend pairs. Real provider-runtime tests cover failure, malformed reply, third-route success and auth URL overrides. Child launch tests verify backend pins reach outgoing payloads. New requests read new settings while an active main turn keeps its resolved model. |
| Graphical editor and persistence (18, 20–24) | `/models` uses the existing external viewer opener. Production HTTP server and Chrome tests exercise canonical JSON, add/remove/replace/reorder, reopen, manual edits, revisions, aliases, provider/upstream distinctions and search word order. Writer tests inject backup/rename/post-rename failure and preserve the prior canonical bytes. Unknown role keys and extension fields survive edits. |
| Regression and release boundaries (28–34) | Owned-core build, full public regression suite, release-template parity, fork independence, sanitized export, exact-credential comparison, public scanner and state-preserving installation checks. The command record below identifies final release validation. |

## Defects found and fixed

| Defect and root cause | Repair and direct verification |
| --- | --- |
| Real Guardian interventions were rejected: UUID-derived keys exceeded the shared arbiter's 160-character bound; short-ID tests missed it. | Hash bounded semantic identities. `guardian-session-integration.test.mjs` exercises three real builtin-edit errors, real kernels and next-turn delivery. |
| Unhashable arguments could appear identical; an asynchronous kernel load could score obsolete evidence. | Abstain on invalid fingerprints and check session/task/evidence generations after awaits. Adversarial supervisor tests cover both paths. |
| Old path constraints survived corrections, parsing accepted historical/negative examples, and current authority expired after ten minutes. | Reverify literal spans, reject contradictory examples, replace newer constraint values independently of model labels, and timestamp evidence instead of expiring the task. Long-task and stale-evidence tests cover this. |
| A shared lifetime slot suppressed materially different failures, and there was no separate semantic history to deduplicate previously emitted advice when allowing new evidence. | Keep bounded per-task semantic history and identity-specific slots within the existing arbiter budgets. Tests cover expired windows, OFF/ON, changed errors and new tasks. |
| Reopening one transcript in two SDK runtimes overwrote a global session-ID-to-owner lookup, disabling one Guardian and misattributing helper ownership. | Track live owners independently, resolve by session-manager identity, reject ambiguous unscoped lookups, and carry owner identity in request/advisory provenance. Real SDK tests reopen the same transcript, run concurrent ON/OFF sessions and dispose one without detaching the other. |
| WASM scratch state/quarantine was shared, native exports accepted invalid pointer/value ranges, and status was ambiguous. | Separate instances, checked ABI bounds, rebuilt source-fingerprinted binaries, and real readiness/error reporting. Direct WASM and corruption/missing-file tests pass. |
| Auxiliary analysis bypassed canonical native providers/authentication, and early slow candidates exhausted all fallback time. | Add `ModelRegistry.completeSimple` through its existing runtime and reserve bounded time for later candidates. Real SDK/native-provider tests cover auth overrides and failure cascades. |
| Handled/aborted inputs, cancelled navigation and history across branches polluted intent lineage. | Cancel advisory state at rejected preflight, restore only the active branch at committed lifecycle events, accept queued request IDs, retain bounded original/recent task summaries. Lifecycle and active-turn tests exercise the actual input pipeline. |
| Last-session global telemetry taps mixed in-process sessions; advertised fuzzy/retrieval markers lacked producers; marker dedupe used the wrong interval. | Capture async session scope at existing dispatch boundaries; wire actual result paths. The later session-stall repair replaces the original 60-second component window with aggregation of simultaneous completions only, distinguishes cached/local/remote result availability from actual model delivery, and streams display-only messages during long tools. `intelligence-observability.test.mjs` and adjacent activity/ML suites cover isolation and failures. |
| Provider priorities were keyed only by model ID, so an interleaved second backend overwrote the first model's position. | Order candidate/model-backend pairs by their exact configured position. Regression checks `[A/Together, B, A/Friendli]`. |
| Editing shared aliases changed other roles; editor diagnostics used a different config path; displayed routing disagreed with the resolver. | Detach edited aliases into the selected role and derive diagnostics/effective routing from the canonical server resolver. Real browser tests inspect both JSON and resolution. |
| Invalid pins silently became unrestricted routes; valid large pins disappeared during child serialization. | Reject malformed restrictions, align serialization/decoder/recovery bounds and refuse an unencodable launch. Payload tests preserve exact backend constraints. |
| An excluded inherited model blocked good preferences, and a lossy task cache key ignored middle-of-prompt requirements. | Resolve healthy configured alternatives and hash the full bounded task text. Route/capability regressions cover both cases. |
| Failed backup creation escaped the editor's structured save response. | Keep rollback/error handling around every write stage, preserve original bytes, clean locks. Injected disk failures test all stages. |
| Installer trusted only launcher leases, allowing replacement under direct CLI processes. | Check the shared active-core process detector both before staging and immediately before activation; direct, relative/symlink and start-during-build tests preserve the old install. |
| Exporter exact-secret gathering missed credential headers and bare tokens in prefixed Authorization values. | Recognize narrowly defined credential headers and scheme payloads; synthetic canary tests reject publication without printing secrets, while ordinary endpoints/headers remain exportable. |
| Two new extension libraries were omitted from the installed integrity manifest. | Register prompt analysis and session observability libraries; a source-inventory regression now compares all shipped TypeScript libraries with the installed verifier inventory. |
| The Needle smoke CLI awaited a runtime that statically imported the still-evaluating CLI module, exiting with unsettled top-level await before inference. | Finish module evaluation before asynchronous CLI execution. Real subprocess tests cover corrupt assets and successful embedding/ranking with installed pinned assets. |
| Text mode inspected only the final stored message, so a later advisory display could hide a successful assistant response or its error status. | Track the current prompt’s completed assistant response through events while ignoring trailing custom display messages. Regression tests exercise the actual SDK/post-turn message path and command-only history. |
| Two newer local skills contained incorrect animation examples. | Correct reflection pivot, delta-time steam, saved/restored fog alpha, line reveal baseline and resize-dependent scroll measurements. Frontmatter/skill validation and reflection invariant checked. |

## Remaining concerns

- Confidence calibration uses a small synthetic feature corpus. A score of 0.95
  is not demonstrated to mean 95% correctness on real user tasks.
- Semantic analysis remains advisory and model-dependent. Synthetic native
  providers prove harness contracts, not semantic accuracy for every live model.
- Follow-up lineage has explicit IDs, but Guardian constraint inheritance still
  uses conservative lexical cues. Ambiguous cases deliberately abstain.
- Browser tests exercise the production server in Chrome. Remote catalogs and
  example provider availability are controlled fixtures, not assertions that a
  particular advertised model/upstream is currently available.
- Active-process protection covers maintained-launcher leases and direct CLI entrypoints.
  An arbitrary SDK host whose command line does not identify the core must still be
  stopped before installation; `/proc` arguments cannot attest its imports.
- Scope isolation covers the audited hooks, commands, tools and observations;
  third-party extensions that bypass these boundaries remain their own owners.

## Performance

Reproduce with `node --expose-gc scripts/guardian/benchmark.mjs` after the owned
core build. Measurements below use Node 22.22.3/Linux, synthetic bounded events,
and no provider inference:

| Measurement | Observed |
| --- | ---: |
| Cold initialization of both kernels | 1.53 ms |
| WASM classifier median / p95 | 2.38 / 4.26 µs |
| WASM similarity median / p95 | 3.70 / 6.15 µs |
| Mean processing at 1 / 16 / 64 sessions | 13.91 / 5.69 / 5.53 µs/event |
| 64 sessions, 96,000 events | 531.28 ms wall; 622.65 ms process CPU |
| Retained heap at 64 sessions | approximately 16.47 KiB/session |
| Fixed WASM memory | 256 KiB/session once both kernels are loaded |
| Idle process CPU at 64 sessions | 0.255 ms over 250.49 ms wall |
| Four processes × eight sessions | 48,000 events; exactly 32 isolated interventions |
| 12,000-model production HTTP search | approximately 281 ms |

Heap/CPU include runtime/GC effects; the short idle sample is not a long-run
energy study. Cold/JIT overhead makes the single-session memory estimate larger.
These measurements do not include LLM latency, full-terminal rendering or the
child visibility relay, which can wait up to three seconds.

## Regression status

The baseline run passed 1,133 of 1,134 tests; its failure was a stale capability
inventory. The first combined repair run passed 1,158 of 1,159 tests while source
was still changing; its failure was an unsynchronized release-test copy. These
counts are diagnostic history, not the final release gate.

Final release validation: a fresh sanitized distribution, with no Git metadata,
passed **1,180/1,180 tests**, zero failures, skips or cancellations, in 71.99
seconds using Node 22.22.3 and four test workers. This includes the owned-core
build, actual SDK/native-provider integrations, browser/HTTP routing tests,
concurrency, adversarial input, installation/export safety and existing regression
suites, including an opt-in real embedding/ranking check against locally installed
pinned Needle assets. Deployment testing also exposed the manifest, Needle CLI
and text-output defects listed above; this final run includes all three repairs.
The owner-isolation repair additionally passed 100 directly affected tests.

The first distribution run exposed two tests that assumed `.git` existed. They
now use explicit temporary Git fixtures and assert exact metadata; an additional
case verifies that absent Git metadata remains absent. Production provenance was
not fabricated to satisfy the tests.

Both WASM binaries reproduce byte-for-byte from the recorded source, generated
parameters and compiler. Public safety scans and whitespace checks pass. Final
report/benchmark documentation changes receive the source-integrity and inventory
checks again. Machine installation, preserved private settings, installed CLI
controls and live-provider smoke are verified separately during deployment; the
synthetic regression suite alone does not establish remote availability.

## Implementation gaps

Guardian currently implements **two** intervention categories: repeated identical
failures and verified path-boundary violations. It does not implement general
architecture/task-topic supervision, a large template taxonomy, or Guardian
classification that combines JEV/Needle3/fuzzy scores, project graph, memory and
recent decisions. File type/skill observations are diagnostics rather than
classification features. Historical Guardian evidence is not reconstructed on
resume. Initial and follow-up analysis share one configurable `prompt_analysis`
role, with different request/output budgets; there are not two separately
configured GUI sections.

Scoring and similarity use C++/WASM; path matching, lineage, evidence gating and
orchestration remain JavaScript. Guidance is advisory after tool execution; it
cannot prevent or reverse a write.

Those absences are reported rather than represented as verified functionality.
The repairs preserve the existing harness's breadth and favor silence over
inventing weakly supported interventions.
