# Guardian Intelligence

Guardian Intelligence provides narrow, event-driven checks. The independent conversational
quality reviewer is the [session observer](SESSION-OBSERVER.md). Guardians observe a running session and, only
when verified evidence accumulates, inject one short piece of bounded guidance. It is not an
agent: it never plans, never calls a model for its own decisions, never spawns work, and cannot
block a tool call.

## Controls

- `/guardian` or `/guardian status` — live state: on/off, kernel state, tracked tasks and counters.
- `/guardian on` / `/guardian off` — enable or disable guardians **for this session only**.
  Off stops observation, analysis and intervention; a new session starts from the default.
- `/guardian stats` — admitted, abstained, quarantined and constraint counters.
- `/guardian debug` — toggles diagnostics: request and instance IDs, verified-constraint count,
  analysis confidence, observed file types/skills/tool count, and recent arbitration decisions.

Guardians are on by default in every session, including subagents, swarm workers, fusion
branches, council members and review agents, because each of those runs as a normal YunusPi
session. Turning them off in one session never affects another.

## What it observes

Guardian state is per session and per request lineage. For the active user request it tracks:

- the literal user prompt and its verified constraints;
- follow-up prompts, and whether the model classified them as a continuation, correction,
  expansion, narrowing, replacement, interruption or unrelated request;
- task lineage (which request a follow-up descends from) and the task label;
- tool calls as bounded argument fingerprints and type shapes;
- successful file writes and edits, as canonicalised paths;
- typed tool failures and whether an assistant response intervened;
- session, process, agent and project identity.

It retains at most 64 bounded user prompts (up to 131,072 characters each) in session memory.
Larger requests still register a supervised task: retry instructions are scanned in bounded
chunks across the entire input, and tool monitoring and WASM failure checks continue. The TUI
reports reduced exact constraint coverage; unretained text cannot establish verified path
constraints. The original user request still reaches the main agent unchanged.
Tool argument values and typed error text are hashed; only bounded type shapes and path evidence
are retained. Sensitive argument keys are excluded from shapes. Guardian itself writes no prompt
or tool-content log. Skill names and file extensions are diagnostic signals, not activation rules.

## The interventions

All are produced by the intervention control plane, which enforces bounded guidance slots per
semantic intervention identity, per-request context budgets, a TTL-based duplicate cache and an
evidence requirement. Guardian additionally retains bounded delivery history beyond the TTL, and
each detector admits at most one intervention per two-minute window.

1. **Repeated identical failure** (WASM-scored). The same tool call with the same argument
   fingerprint must fail three times with the same typed error text across at least two independent
   assistant responses, remain fresh, belong to the live task, and not be covered by an explicit user
   retry directive. Shell commands are included (an exact command string failing the same way is the
   most common loop in live sessions); long output is fingerprinted by its head and tail, where
   commands print the error. Generated identifiers (UUIDs, long hex ids), clock times, epoch
   timestamps, elapsed durations and temporary paths are normalized before the error text is
   compared, so a retry that fails the same way with a new run id or timing is recognized; plain
   numbers such as line numbers, counts and status codes stay significant.
2. **Verified constraint drift.** A literal, non-quoted user path constraint (for example
   "only write files under src/") must be crossed by two independent *successful* file changes
   inside the same task lineage, after the constraint itself was re-verified against the raw
   prompt text by exact offset.
3. **Edit-mismatch loop.** Three failed edits to one file, with at least two different argument
   fingerprints and no successful read of that file in between, produce one reminder to re-read the
   exact region before editing again. Identical retries stay with detector 1.
4. **Repeated identical read.** The same file range read four times with no write, edit or other
   mutation in between produces one reminder to reuse the earlier read or narrow it.
5. **Unverified completion.** A final reply that presents the work as finished, while files changed
   after the last verification run (tests, builds, linters, syntax checks, renders, reviews), is
   steered once per change set to run the proving check or state what remains unverified. A reply
   that already says the work is unverified or blocked does not trigger it.

6. **Consecutive failure burst.** Four consecutive fingerprintable failures across varied
   operations produce one reminder to diagnose the causes; a success resets the streak.
   Identical operations stay with the WASM detector.

Anything else abstains. There is no keyword or topic classifier, so a CSS file in a backend task,
the word "architecture" in documentation, or a discussion of an unrelated earlier task cannot
produce guidance. Detectors 3–6 are deterministic evidence counts; paths are hashed in evidence and
no file content is stored.

### Verification and coordination

Completion supervision uses mutation generations rather than wall-clock ordering. A check
must start after the latest observed mutation and finish without an overlapping mutation.
A failed bulk edit carrying `fileMutation` also invalidates earlier verification. A later
failed or pending check retires an earlier pass. These receipts establish execution, not
proof that a check covers every user requirement.

`project_tests` and `quality_review` inspection/assessment calls, browser-session setup,
background launches, and shell text merely mentioning tests do not count as executed
verification. Shell recognition is conservative: a supported leading check, optionally
following a simple `cd`, without compound commands or masked exits. Explicit `bg_run`
checks retain at most 32 owned job IDs; only `completed` with exit code zero and no signal,
observed through a background notification or `bg_status`, satisfies their generation.
A job from another request cannot satisfy the current request. Detached managed-bash
launches remain unverified here; their richer receipts belong to `project_tests`.

Delivered Guardian intervention messages join the existing reviewer note board. The
observer and Watchmaker see an attributed Guardian peer note and suppress restatements
through their normal advice deduplication. Status/debug messages do not become advice.
The board is scoped to the live session manager, so two runtimes reopening the same
transcript cannot consume each other's notes. This is coordination of optional guidance,
not shared authority or permission to act. Guardian itself still makes no model calls.

Cooldown-suppressed candidates do not spend the evaluation allowance for other detector
categories. Turning Guardian off clears pending checks, reads, and edit evidence; turning
it back on starts fresh observation, while already-delivered advice retains its bounded
history.

## Kernels

Scoring runs in two checked-in WebAssembly kernels built from `core/coding-agent/src/core/guardian/*.cpp`
by `node scripts/guardian/build-wasm.mjs`:

- `classifier.wasm` — a 12-feature linear scorer with hard minimum-evidence gates and a monotone
  calibration table; it imports nothing and holds no task state.
- `similarity.wasm` — exact byte n-gram multiset Dice similarity, used only as a
  corroborating signal. Identical normalized inputs take a linear fast path; other
  inputs use allocation-free heapsort and merge, bounding worst-case work to O(n log n).

The provenance manifest (`wasm-provenance.json`) records compiler, flags, artifact hashes and
source hashes, and `scripts/check-public.mjs` re-verifies them. A missing, modified or corrupt
kernel is quarantined: the affected scorer abstains and the session continues. The independent
verified-path detector does not call WASM. Each session owns separate WASM scratch memory and
quarantine state; status reports each loaded kernel's actual state.

## Prompt-intent analysis

The auxiliary prompt analysis described in [LLM-PREFERENCES.md](LLM-PREFERENCES.md) is advisory.
The literal user prompt always reaches the main model unmodified; the analysis is injected as a
separate, clearly labelled custom message. Guardian consumes only its *verified* part: literal
constraint spans that it re-checks against the original prompt, with model provenance and high
confidence. Fallback analyses, quoted spans and inferred constraints can never create a Guardian
constraint.

## Observability

- Guidance appears in the transcript as a `guardian_intervention` notice (⛨ Guardian · kind · guidance sent to the agent, with the WASM score where one was computed).
- Every WASM verdict, including an abstention, is one `Guardian` activity line with its score and threshold (for example `WASM score 0.62 < 0.95 · no intervention`). Routine monitoring is summarized in the live footer pulse (`Guardian 14 checks · 2 WASM · 1 sent`) instead of repeated transcript lines.
- Routine monitoring and actual WASM evaluations have separate visible receipts, so standby
  is not confused with successful inference. Reduced prompt coverage is explicit.
- Child-subagent guidance is relayed to the parent session through the subagent supervisor channel.
- Internal intelligence components (JEV, Needle3, the local LM, Kompress, fuzzy/neural helpers, the intent
  classifier) report a single bounded `activity` line per real use, deduplicated per component.
- `/guardian stats` and the `micro_status` tool expose counters; neither runs inference.

JEV uses its configured remote judgment service; Needle3, the native Guardian kernels, and
fuzzy recovery run locally. Guardian never invokes JEV or another remote model for scoring.
See the [independent implementation audit](GUARDIAN-IMPLEMENTATION-AUDIT.md) for repairs,
measurements, exercised paths and remaining implementation gaps.

## Boundaries and measured overhead

This is a narrow supervisor, not a general semantic task or architecture classifier. The six
detectors above are its complete intervention set. Architecture/tool-choice constraints may be
retained as verified metadata but are not enforced. JEV/Needle3/fuzzy usage is observable through
the intelligence event system; those scores do not feed Guardian decisions. Path constraints
depend on successful model-backed prompt analysis and are verified again locally.

Request IDs and parent IDs are explicit, but constraint inheritance currently requires a
conservative lexical follow-up cue. Cancellation, unrelated-task and older-session cues sever
inheritance. New literal values replace older values of the same constraint key regardless of
the advisory model's relation label. This does not establish complete natural-language task
lineage understanding. Resume does not reconstruct Guardian evidence from historical messages.

The classifier's 0.95 threshold is calibrated against a small synthetic feature corpus; it is
not an empirically validated 95% probability of correctness in real workloads. Hard evidence
gates precede scoring. Classification and advice must be evaluated independently of that number.

Evaluation is event-driven with at most 16 candidate evaluations per two-minute window and one
admission per category per window. Each task also retains up to 32 failure identities and 32
constraint identities that already produced advice, so an expired cooldown does not repeat
identical guidance. Changed inputs/errors or a new task can form a new failure identity. Path
evidence must consist of two distinct successful changes within two minutes; the current user
constraint itself has no task-age expiration. There is no idle supervision timer. Child guidance may wait
up to three seconds for its parent's bounded UI acknowledgment.

Run `node --expose-gc scripts/guardian/benchmark.mjs` after `npm run build:core` to measure offline
kernel latency, active/idle process CPU, per-session memory, 1/16/64 concurrent sessions and four
concurrent processes. It asserts the expected intervention counts. These are supervisor/kernel
measurements; they do not measure model inference, the full TUI, or child UI relay latency.
