# Independent fork and intelligence audit — 2026-09-19

## Assessment and scope

Audited GitHub `main` at `f01b66accab161b24eea114fe180ce1b4d3f014c`, rechecked against the remote during final review. The previous implementation had substantial, useful infrastructure: protected observation records, history seals, deterministic permissions, background advisories, a local WASM worker, typed remote judgments and broad behavioral tests. It was **not an independent core fork**. Its pinned npm core, transforms, repair flow and upstream updater still made an upstream distribution the runtime authority.

The intelligence integration also had correctness and measurement gaps. Tests overstated live helper utilization; several advertised review utilities had no production callers. Smol could lose distinct protected facts, Jev could discard protected middle evidence, shadow results could influence consumers, and a worker lifetime bug could keep a process alive. An emergency compaction override could replace history with incomplete selected text. These are behavioral defects, not merely missing documentation.

This change establishes source ownership and fixes the identified safety and lifecycle defects. It does **not** establish that every ordinary production session successfully uses every model. Synthetic client/owner tests, actual local WASM inference, isolated live helper probes and real owned-core loopback sessions are reported separately below. The user's preexisting live installation was not replaced; fresh and updated installations were exercised in disposable locations.

## Owned core, provenance and release authority

The exact historical baseline is **Pi 0.85.1**, upstream tag `v0.85.1`, source commit `d981de1229ef899957bbe968bc8dcda02a21f477` in `earendil-works/pi`. All six runtime packages came from integrity-verified 0.85.1 distributions. Their individual SHA-512 receipts are retained in [core identity](../core/identity.json); original MIT notices remain in each package and [third-party notices](../THIRD_PARTY_NOTICES.md).

| Owned directory | Runtime package |
| --- | --- |
| `core/ai` | `@yunuspi/ai` |
| `core/agent` | `@yunuspi/agent-core` |
| `core/tui` | `@yunuspi/tui` |
| `core/coding-agent` | `@yunuspi/coding-agent` |
| `core/telemetry` | `@yunuspi/telemetry` |
| `core/chord` | `@yunuspi/chord` |

The canonical source is readable, unbundled ESM JavaScript and declarations under `core/*/src`. Existing adaptations were incorporated once; future changes edit those files. This is deliberately not a claim that pristine upstream TypeScript contains YunusPi's modifications. The duplicate CLI bundle was removed, so CLI and SDK share implementation. `build:core` validates JavaScript/JSON and package ownership, copies source/assets and records a digest; declaration maintenance remains manual.

Product version and core version begin at **0.1.0**. Git commit and SHA-256 source digest are separate build identity fields. The immutable origin remains 0.85.1. `yunuspi --version`, `--core-info` and read-only `micro_status.core` identify the actual owned runtime. The release authority is `yunusemrejr/yunuspi`.

Root npm workspaces contain all six packages plus `agent/npm`; internal package edges are exact 0.1.0 and lockfile entries are local links. External `@earendil-works/pi-*` and `@earendil-works/chord` runtime dependencies were removed. Legacy extension import names map directly to the owned loader exports; they are not external npm dependency aliases. Ordinary third-party libraries, optional tool binaries, provider model catalogs and explicitly requested third-party extensions remain separate dependencies.

All 25 core transform modules were applied and checked once against the baseline. Their intended behavior is ordinary source now. The former edit-concurrency transform had affected only a bundle, so its implementation was explicitly ported to both owned edit APIs and tested against concurrent writes. Historical transforms are isolated as migration test fixtures. `post-update-repair.mjs` is removed; install/build/update/verification never apply them. [The patch classification](PATCH-MIGRATION.md) lists every former module and payload.

## Installation and updates

Fresh installation stages public harness files and an owned runtime, runs the lockfile with npm lifecycle scripts disabled, builds the local core, and activates the staged directory. The launcher and subagent paths select that runtime. Final independent review also removed the background-task PATH fallback and prevented a child from reusing an RPC/SDK module as its CLI. State is not imported into the public repository.

`yunuspi update --source /path/to/reviewed/yunuspi` applies an explicitly selected YunusPi checkout. Bare `yunuspi update` explains policy without network or mutation. The former automatic updater performs local verification only. Upstream release checks, install telemetry, upstream self-install, global Pi discovery and normal patch-after-install repair were removed. A hypothetical upstream 99.0.0 produces no transport call or version change.

Updates preserve private state and compatible customizations using managed-file hash inventories. Conflicting source changes, unsafe links, unknown ownership receipts and unported local core edits reject activation. Installation failure leaves the prior target; a complete adjacent backup supports rollback. Maintained launchers hold a session lease during replacement. Direct SDK hosts outside that launcher still require explicit shutdown. Existing legacy installations without receipts need a reviewed migration; ownership is not guessed.

Actual cached offline fresh installation and an explicit offline source update succeeded. Synthetic auth, settings, sessions and memory survived, the prior installation was backed up, the installed structural verifier passed, and both CLI identity commands reported the owned core. Offline operation needs a complete third-party dependency cache and skips optional Needle asset downloads. It does not query upstream Pi.

Public export now selects the chosen installation's actual owned core before any template fallback and rejects linked metadata, so reviewed local source cannot silently disappear from an export.

Selected upstream improvements may enter only through an explicit reviewed port, YunusPi source commit and regression checks. No upstream package bump, automatic merge or release-following process remains. See [ownership](CORE-OWNERSHIP.md), [installation](INSTALL.md), [updates](CORE-UPDATES.md) and [manual porting](../UPSTREAM-PORTING.md).

## Intelligence changes and active responsibilities

| Layer | Useful responsibility and changes |
| --- | --- |
| Deterministic code | Eligibility, installed candidate filtering, permissions, exact source identity, protected evidence retention and final action authority. Recovery now filters installed/available skills before paying for judgment. |
| Needle3 | Local ranking/classification and advisory shortlist selection. Fixed initialization failure, serial queue deadlines, cache isolation, result membership/shape checks, shutdown and idle process exit. Assets are verified before loader execution; resumed download and corruption handling are bounded. Per-consumer shadow mode never changes decisions. Disagreement can escalate to Jev; weak agreement does not reorder the remaining list. |
| Smol | Source-linked line selection for eligible structured output. Distinct status, qualification, numeric/path and task facts survive selection/windowing. Dense protected evidence abstains. Numbered source lines reduce prompt overhead without weakening validation. |
| Kompress | Exact source paragraph selection for eligible prose. Soft wrapping and unknown-price routes can qualify under the existing context floor. Worker and host agree on protected status/decision/test vocabulary. Raw source remains retrievable. |
| Jev | Typed ambiguity, existence, verification and ranking judgments. Identical concurrent requests share a call and cached results cannot be mutated by consumers. Disabled mode never schedules a recovery probe. Context uses ready selections rather than waiting two seconds for a remote result. Selection cannot silently truncate retained protected material. |
| Main/child LLMs | Implementation, debugging, synthesis, causal reasoning and substantive independent review. A bounded typed skill-existence/choice batch can avoid a full advisor child; uncertain/unavailable responses keep the existing fallback. Councils retain independent peers and authoritative review evidence. |

Tool, skill, command and capability retrieval continue to share the existing discovery owners. Improved Needle semantics apply there, to relevant guidance and memory retrieval, without granting new capabilities. Existing HTTP/error and observation consumers now honor shadow behavior. Project graph, project reports, code intelligence, browser execution and background operations retain their actual tool owners; this audit does not replace their work with model labels.

The additional council integration supplies an already-ready local perspective hint while independent peers run. It does not wait for another remote call, suppress required roles, discard findings or establish correctness. Duplicate clustering/judgment utilities remain independently tested utilities where no safe production synchronization point was justified; their presence is not counted as active session use.

Compaction retains its normal source/history semantics and protected context anchors. The unused synchronous Jev compaction triage and its unsafe emergency override were removed: oversized or unsuccessful summarization must preserve history and use explicit recovery, not commit a truncated selection. Helper confidence is never proof of a passed test, completed task or permission to mutate. Late results cannot rewrite sealed provider history.

## Measurements and test evidence

See [Needle measurements](NEEDLE-AUDIT.md) and [context/helper measurements](CONTEXT-AUDIT.md) for fixture construction, model limitations and detailed evidence.

| Experiment | Observed result and limit |
| --- | --- |
| Needle local paraphrase retrieval | Top result correct on 4/6 fixtures; 0/6 accepted at the configured confidence gates. The former 6/6 oracle-Jev result was not a live model accuracy measurement. |
| Needle local intent classification | 4/8 accepted, all four accepted classifications correct in the small fixture set. Abstention is not counted as success. |
| Needle mixed concurrent WASM work | 12/12 completed; cold startup 1,159 ms; work 592 ms; execution p50 1 ms / p95 423 ms; 172 main-thread timer ticks; RSS increase 141.2 MiB; no restart/timeout. Cached, warm and cold timings are distinct. |
| Needle extraction | About 2.52 s for one actual extraction; an 8 s bounded ceiling is needed on this machine. A confidence of 1 still produced an imperfect field boundary. This is not a truth/verification mechanism. |
| Kompress actual local inference | Cold timeout around 455 ms retained raw text. Warm 301 ms selection reduced 1,792 → 361 characters and retained blocked verification; 1,175 characters saved after the client reserve. |
| Jev actual remote inference | A false-verification question returned `noul=0.02` in 618–1,085 ms. Client estimate: 44 input tokens / $0.000001848 per call; not invoice evidence. |
| Smol actual local inference | Old framing exceeded the small context or truncated the response. Final numbered framing used 1,792 prompt/cache tokens and returned complete `UNKNOWN` in 1,553 ms. No accepted live reduction is established by that probe; a subsequent task-matched 3,541-character log fixture reached its five-second deadline and retained the original. |
| Full-model work avoided | One fixture proves the real skill-discovery owner does not dispatch its general-model child after a valid typed selection. No production avoided-call rate or token savings is inferred. |

Metrics now distinguish offers, executions, cache hits, abstentions, projected character reduction and actual newly sealed provider reduction. Replaying a seal cannot claim another saving. Routing flags and mocked transport are not counted as live inference. Diagnostics report helper state and active core provenance without running a helper or logging private contents.

| Requested workload | Exercise and coverage limit |
| --- | --- |
| Normal implementation | Scripted substantive session executes production coordinator/retrieval and real Smol/Kompress clients/validators with mocked transport; each layer has distinct work. No full production model session claim. |
| Heavy logs and compaction pressure | Adversarial evidence tests cover middle protected facts, source hashes, dense output, truncation and sealed history. Owned compaction integration covers trigger/usage behavior. |
| Research/web | Source ranking/claim judgment fixtures plus real isolated browser/tool tests; remote search quality is not benchmarked. |
| Tool/skill discovery | Real discovery owner, candidate validation, cheap advisory and child fallback tests. |
| Project intelligence and memory | Existing project graph/context/memory tests pass; protected facts and token budget paths remain covered. No long-term memory usefulness claim. |
| Recovery | Actual owned-core root and worker loopback sessions, route switch, external-network guard and retained evidence checks. |
| Review/council | Perspective and finding fixtures, real owner sequencing and advisory-only integration tests; no paid production council benchmark. |
| Trivial task | Fixtures assert no gratuitous local/remote helper calls. |
| Disabled/unavailable/shadow/offline/crash | Focused client/worker tests preserve prior safe behavior and sealed history, enforce timeout/queue/shutdown behavior and prevent shadow application. |
| Fresh install, source update, newer upstream | Actual offline installation/update with state preservation, owned package resolution and simulated 99.0.0 release ignore tests. |

The final full Node suite passed **717/717**, with zero failures, cancellations or skips, in **186.4 seconds**, including compaction/council/launcher follow-ups. The subsequent exporter correction passed **8/8** focused tests. All **12 offline compatibility scripts** passed; the actual root/worker autonomous recovery script passed **48/48** checks. The final installer/update/preservation group passed **16/16**, background launch/service group **7/7**, and independent core group **7/7**. Fresh offline installation, state-preserving source update and installed structural verification passed. The staged index and reachable Git history scan returned zero findings. Clean public export, mirror validation and final whitespace checks complete the publication gate. The first GitHub run also exposed two validation issues: the new exact-file inventory document was added after capability documentation generation, and a positive native parser test exceeded its three-second startup allowance on the shared runner. The generated inventory was refreshed; the positive syntax fixture now has an explicit larger startup allowance while production deadlines and timeout/cancellation regressions remain unchanged. Final GitHub results are attached to the delivered PR.

## Remaining risks and deliberately deferred work

- Useful live Smol output and broad normal-session utilization still need calibration/measurement. Its safe abstention must not be disguised as savings, and evidence protection must not be relaxed to improve a metric.
- Needle's current thresholds are selective and its accuracy sample is small. The observed WASM memory/latency can matter in many child processes. No native backend switch was made without comparative evidence.
- A validated client projection is not automatically provider-rendered savings. Web, child, council and compaction owners do not all consume every helper simply because a general router advertises those evidence shapes.
- Emergency cheap compaction is deferred until it can preserve required evidence and provenance within the real budget. Normal compaction and explicit overflow recovery are safer than destructive truncation.
- The fork imports readable published JavaScript, with manually maintained declarations. It does not yet restore an adapted TypeScript authoring tree or upstream's entire package test infrastructure. Existing core behaviors beyond this harness's exercised API surface can still contain inherited bugs.
- Provider catalogs and pricing remain provider-dependent; core release independence does not make model services or third-party dependencies immutable.
- This is a Linux validation. Native macOS/Windows parity, extended production workload measurements and the user's legacy installation migration are not claimed.

## Deliverable map

The assessment and deficiencies are above; exact filenames are in [AUDIT-CHANGED-FILES.md](AUDIT-CHANGED-FILES.md). Core origin, ownership, removed dependencies, update rules, versions, structure and licensing are in the ownership/patch/installation documents. Responsibilities, missed opportunities, council/review, context, metrics, benchmarks, utilization and avoided work are above and in the two component audit reports. Test results, residual risks and deferred work are explicit. Final implementation and report commit identities are supplied with the delivered branch/PR; a commit cannot truthfully embed its own SHA.
