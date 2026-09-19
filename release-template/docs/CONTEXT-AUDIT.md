# Independent context and helper audit — 2026-09-19

The previous implementation had meaningful validators, raw observation retrieval
and provider-history seals, but its utilization claims exceeded its evidence.
The “every layer” session fixture counted a Kompress routing flag as participation
and used a synthetic coordinator result for Smol. It now executes both real
clients, validators and extractive projections with mocked transport. This tests
integration behavior; it is not evidence of production participation.

## Changes made

- Smol preserves every distinct status/qualification/quantity/path fact and task
  match. Only identical repeated status text can collapse. The complete original
  is screened before windowing; protected middle evidence cannot disappear in a
  head/tail window. Dense evidence abstains. Windowed results carry original and
  window hashes, reject mismatched sources and retain cancellation/truncation
  metadata gates. Compact numbered source lines reduce model prompt overhead.
- Jev extraction cannot silently lose sources beyond eight chunks, remove
  protected facts on a low score, treat a missing/malformed score as permission
  to omit, or truncate a retained fact at the render cap. Context consumes only
  ready remote selections: the previous two-second remote wait is removed.
  Existing raw/projection seals still prevent late rewrites.
- Concurrent identical uncancelled Jev requests share one payment; cached
  answers are copied so callers cannot poison later results. Disabled Jev does
  not run a scheduled recovery probe.
- Kompress accepts soft-wrapped complete paragraphs and unknown-price routes
  under the existing context-saving floor. Its Python worker protection
  vocabulary now matches the host for decisions, test status and next actions.
- Request-family classification rejects shadow, low-confidence and unknown
  labels. A truncated Needle prefix cannot establish that a task is read-only;
  the Jev fallback sees the entire bounded task and validates the answer type
  and range. Existing asymmetric intent thresholds remain explicit.
- Skill discovery can use one typed Jev choice/existence batch before launching
  a general-model advisor. Candidate identity, confidence, policy, cancellation
  and stale-result checks remain authoritative. Useful or clear no-fit outcomes
  avoid a child launch; uncertain/unavailable outcomes retain the old bounded
  fallback. A fixture proves one avoided dispatch, with zero invented token
  savings. This optional background stage has a 2.5-second bound within the
  existing discovery deadline.
- Smol/Kompress owners now record actual offers, executions, cache hits,
  abstentions and projected savings. Newly sealed provider reductions have a
  separate counter; replaying a seal does not count another reduction. Smol
  reports specific response/selection outcomes, including UNKNOWN.

Original observation text remains retrievable. A final independent review found
that Jev emergency compaction could drop every unselected middle message and
truncate kept messages to 400 characters, prior summaries to 4,000 characters,
and the final result to a budget. That destructive override and its remote triage hook were removed. A repository
search found no consumer for the remaining audit plan, so retaining the call
would spend money and add synchronous latency without affecting behavior.
Normal compaction and existing explicit overflow recovery preserve authoritative
input and make no Jev call for this unused plan. This audit does not claim that every
compaction or council now invokes all four helpers.

## Actual synthetic inference probes

Configured runtime credentials were used in memory only. No descriptors,
credentials, private sessions or private evidence were copied into the repository.
The network sandbox initially blocked loopback/DNS; authorized external-sandbox
probes then distinguished transport failure from actual model behavior. Smol's
single-probe lease seam avoided modifying private lease files; these probes do
not benchmark fleet scheduling.

| Probe | Observed result |
| --- | --- |
| Kompress cold | 1,792 input characters; 455 ms timeout; original retained |
| Kompress warm | 301 ms; 1,792 → 361 characters; blocked-verification fact retained; 1,431 characters removed, or 1,175 after the client's 256-character reserve |
| Jev, false-verification question | Live `~typesafe/jev-latest`; `noul=0.02`; 618–1,085 ms; client estimate 44 input tokens / $0.000001848 per call |
| Smol cold | Configured five-second deadline reached; original retained |
| Smol old JSON line framing | 3,520-character, 82-line listing rejected with HTTP 400 |
| Smol tuple framing experiment | 2,036 prompt/cache tokens in a 2,048-token service; reply truncated after 12 generated tokens |
| Smol final numbered-line framing | 1,792 prompt/cache tokens; complete valid `UNKNOWN`, 23 generated tokens, 1,553 ms warm; original retained |
| Smol final purpose fixture | 3,541-character repeated activity with an explicit deployment-blocked fact and matching task; 5,020 ms timeout; original retained; no further tuning |

Smol prompt overhead improved, but **no accepted live Smol reduction was
established**. UNKNOWN is an honest abstention. The small fixture set and local
hardware do not establish production accuracy, sustained throughput or general
full-model savings. Remote Jev spend above is the client's estimate, not an
invoice.

## Verification

Fifteen relevant test files passed together: `context-anchor`,
`helper-evidence-integrity`, `jev-client`, `local-intelligence`,
`micro-intel-session`, `micro-intelligence`, `mini-selection-cache`,
`observations-render-seal`, `output-context`, `quality-project-context`,
`skill-discovery-controller`, `skill-discovery-runner`, `skill-discovery`, and
`smol-kompress-expansion`, and `update-preservation` (all `tests/*.test.mjs`). The final Smol formatting
change also passed the integrity and expansion tests again. Python selector
syntax and its expanded protected vocabulary were independently checked.
After removal of the destructive emergency override, the four-file
`compaction-evidence-safety`, `session-signals-diagnostics`,
`compaction-usage-boundary`, and `update-preservation` suite also passed. After
removing the unused remote triage hook, the three compaction/diagnostics files
passed again. The new
compaction fixture includes unselected middle requirements and facts beyond both
old truncation limits; no compaction override, source mutation, remote Jev call
or unused-plan receipt is permitted during ordinary or overflow compaction.

The independent installer review found that a fresh-source replacement would
archive live state rather than carry it forward. The installer owner added
explicit state-preserving updates and managed source inventories. Separate
`tests/update-preservation.test.mjs` cases exercise configuration/auth/session/
memory/model-state carry-forward, custom source, compatible edits, conflicts,
deletions, unsafe links, malformed/traversal inventories, owned-core edit
conflicts, explicit matching ports and prototype-shaped filenames. Installer
source changes are owned and described by that workstream.

## Remaining limits

Cheap emergency compaction is intentionally deferred: a bounded preview cannot
prove that omitted authoritative evidence is disposable. Oversized summaries use
the existing larger-window recovery instead of a lossy committed fallback.

Smol's tiny model still needs useful-output calibration; lowering evidence
protection to increase its success count would conceal the problem. Kompress
retains bounded ASCII/paragraph limits and can time out cold. Its existing
startup warmup and service cooldown can compete with the first real selection;
no live service restart or model deployment was performed. The observation
owner covers bash and documentation reads; web, child, council and compaction
flows do not all execute Kompress merely because a router advertises an
opportunity. Session fixtures demonstrate actual helper mechanics under mocked
transport, and the isolated live probes above demonstrate only their stated
results. Broader production utilization remains unmeasured.
