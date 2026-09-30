# YunusPi 0.18.0 verification

Second optimization round over released/installed 0.17.0. Native source/evidence gates remain authoritative.

## Changes and verified contracts

- Direct-task core schemas: 30 → 17 names. Explicit discoveries/named tools/used coordination survive simplification and host restrictions remain ceilings.
- Compact assurance retains blockers, gaps, exact commands and immutable native receipts; detailed views retain full state. Test diagnostics are bounded and protected material withheld, allowing reviews to reuse actual results without temporary log artifacts.
- Writing/anti-slop checks exclude executable/quoted examples, check short copy, distinguish supported metric claims, and optionally batch ambiguous cues through cached JEV annotations. Deterministic findings and local edit hooks remain authoritative.
- SEO checks separate crawl evidence, canonical hints and index/eligibility unknowns, including crawler-scoped noindex, robots throttling/server errors, hreflang and JSON-LD structure.
- Motion inspection uses the same element and verified loop period; decoded-video preflight inspects bounded frame timing/movement and reports limits. Contained glTF/GLB preflight retains mesh/resource/animation/provenance evidence and required import dependencies.
- Existing network/Linux tools diagnose one explicit network target or exact local resources/PID/port/unit; bounded cancellation, typed unavailable/permission/partial phases, no configuration changes or broad scans.

Independent review caught and repaired quoted credential/URL withholding and named-tool/adaptive-event interleaving defects. Regression tests cover both.

## Validation

Root assurance/routing review suites: 166/166 passed. Final receipt-context suites: 22/22. Final strict custom-install/shared-skill safety suites: 18/18, zero skips. Quality suites: 48/48. Systems suites: 58/58, including real loopback HTTP/TLS and actual Linux resource/PID/listener facts. Media suites include actual Chromium rendering, FFmpeg decoded motion, and GLB through GLTFLoader/WebGL. The initial complete strict suite passed 2,649/2,649 tests, zero skips, in 221.67 seconds. The complete strict suite passed 2,653/2,653 tests, zero skips, in 196.24 seconds after the custom-install and delegated-context repairs. The final release candidate, including the nonpersistent scout accounting repair, passed 2,655/2,655 tests, zero skips, in 188.60 seconds.

JEV is uncalibrated advisory triage, never authorization, a correctness verdict, SEO ranking evidence or visual certification. No production host mutation, live search-index result, external TLS availability, model training or artistic quality guarantee is claimed.

## Matched task observations

Both editions used the same original fixtures, prompts, primary model
(`orcarouter/qwen/qwen3.8-flash`), low requested thinking, private model/role
configuration and local Needle assets, with local LM inference off. The baseline
was built from public tag v0.17.0; the candidate used v0.18 implementation before
the accounting-only scout receipt repair described below.
Both used JSON print mode without a persisted parent session. Timing comes from
actual stdout arrival of session and agent-settled events, not the assistant
message timestamp (which marks generation start). Main tokens sum provider
`totalTokens` once per completed assistant message, including cache tokens;
reasoning tokens are not counted again. They are not billing totals.

| Measurement | Typo v0.17 | Typo v0.18 | Two-module bugs v0.17 | Two-module bugs v0.18 |
|---|---:|---:|---:|---:|
| Active session seconds | 16.342 | 22.444 | 222.769 | 199.849 |
| Entire process seconds | 45.932 | 35.551 | 236.968 | 213.840 |
| Startup seconds | 18.658 | 3.841 | 3.772 | 3.672 |
| Main reported tokens | 64,188 | 38,857 | 507,113 | 288,139 |
| Main model turns | 4 | 5 | 20 | 13 |
| Main tool calls | 3 | 5 | 34 | 23 |
| Returned tool text characters | 516 | 597 | 23,840 | 10,902 |
| Completed native helper children | 0 | 0 | 1 | 2 |
| Uncached JEV receipts | 0 | 0 | 1 | 1 |
| Recorded hook processing ms | 2,109.0 | 2,057.1 | 19,821.8 | 16,689.9 |
| Recorded hook errors | 0 | 0 | 0 | 0 |

The typo has 39% fewer main reported tokens, but its active session was 37%
slower: one grep and an extra read added two tool calls and one main turn. Hook
work stayed near two seconds, so this sample does not demonstrate a hook latency
regression. Its lower overall wall time is dominated by startup/cache freshness;
we do not attribute that difference to schema reduction. The complex task used
43% fewer main tokens, 32% fewer tool calls and 10% less active time. Both final
programs independently passed all five Node tests. Both reviews accepted the
current source revision after one review round, with no retained stale capture.
Both typo outputs matched the expected complete file and actual readback.

Coordination did not improve uniformly: the candidate also completed a supplied
skill scout. The recorded usage-bearing reviewer increased from 15,275 to 29,873
tokens, and the scout lacks a final cost receipt in the captured parent stream.
That exposed a reproduced accounting bug: the runner withheld terminal usage
when no session file existed. The final release records that receipt without
weakening session ownership; nonpersistent completion and late-session-change
regressions passed with the 58-test discovery/accounting suite. The original
benchmark stream remains incomplete and was not replayed for this accounting-only
repair. Do not interpret main-token savings as a complete auxiliary-cost comparison.
Model tool choices, backend latency, caching and reviewer verbosity vary; these
are single observations, not a statistical speed guarantee. The direct-task extra
inspection and variable auxiliary overhead remain measured limitations.

An earlier candidate run was excluded from this matched comparison because its
cold custom-model fallback and broad custom-install maintenance scope differed
from the baseline. That run exposed the reproduced installation bug, now fixed
and independently tested; no timing from that run is claimed as an improvement.

## Tool-level evidence

The deterministic CI contract stages 17 direct core names versus 30 standard
names and keeps required verification/discovery/background capabilities. Its
review fixture falls from 1,584 to 452 characters while retaining blockers and
gaps; this is a fixture size measurement, not a model-token estimate. Identical
prose inputs produced 11,006 versus 5,204 JSON bytes in detailed/compact views;
the SEO fixture projection produced 2,880 versus 1,510 bytes.

A real JEV prose refinement returned an advisory in 641 ms (504 input tokens,
~typesafe/jev-latest); its identical repeat returned cached in 2 ms with zero new
input tokens or cost. No judgment removed a deterministic finding. Offline,
error, cancellation, protected-context and batched-cache behaviors are tested.

Network fixtures verified one MCP call, one connection and one HEAD request,
while a self-signed TLS failure sent zero HTTP bytes. Actual Linux resource/self
PID diagnosis returned 1,975 JSON bytes in 4.61 ms, explicitly partial for cgroup
evidence. Actual authored GLB content passed GLTFLoader and rendered WebGL pixels;
actual MP4/VFR fixtures, every decoded frame within bounds and CSS running/paused
reduced-motion captures passed. These do not establish arbitrary asset aesthetics
or remote production availability.

## Delivery checks

The final candidate was installed with the official dependency-building installer.
Structural harness validation passed; the actual CLI completed the matched tasks
using built owned-core dependencies and the new extension sources. Public safety
checks cover the working tree, index and reachable history; no private session,
configuration, credential, model asset or raw benchmark log is published.

Release tagging requires a clean, pushed main tip and successful exact-commit
GitHub safety CI. The release workflow independently verifies that main job before
publishing the immutable stable version. Local delivery uses the installer’s
backup/preserve-state path, followed by managed-file and owned-core hash checks,
released-commit/core identity, configuration/state preservation and a real CLI
read/edit/readback task. These checks are reported in the final delivery receipt.
