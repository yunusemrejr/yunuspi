# Guardian Intelligence

Guardian Intelligence provides narrow, event-driven checks. The independent conversational
quality reviewer is the [session observer](SESSION-OBSERVER.md). Guardians observe a running session and, only
when verified evidence accumulates, injects one short piece of bounded guidance. It is not an
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

## The two interventions

Both are produced by the intervention control plane, which enforces bounded guidance slots per
semantic intervention identity, per-request context budgets, a TTL-based duplicate cache and an
evidence requirement. Guardian additionally retains bounded delivery history beyond the TTL.

1. **Repeated identical failure.** The same tool call with the same argument fingerprint must fail
   three times with the same typed error text across at least two independent assistant responses,
   remain fresh, belong to the live task, and not be covered by an explicit user retry directive.
   Generated identifiers (UUIDs, long hex ids), clock times, epoch timestamps, elapsed durations and
   temporary paths are normalized before the error text is compared, so a retry that fails the same
   way with a new run id or timing is recognized; plain numbers such as line numbers, counts and
   status codes stay significant.
2. **Verified constraint drift.** A literal, non-quoted user path constraint (for example
   "only write files under src/") must be crossed by two independent *successful* file changes
   inside the same task lineage, after the constraint itself was re-verified against the raw
   prompt text by exact offset.

Anything else abstains. There is no keyword or topic classifier, so a CSS file in a backend task,
the word "architecture" in documentation, or a discussion of an unrelated earlier task cannot
produce guidance.

## Kernels

Scoring runs in two checked-in WebAssembly kernels built from `core/coding-agent/src/core/guardian/*.cpp`
by `node scripts/guardian/build-wasm.mjs`:

- `classifier.wasm` — a 12-feature linear scorer with hard minimum-evidence gates and a monotone
  calibration table; it imports nothing and holds no task state.
- `similarity.wasm` — a byte n-gram similarity kernel used only as a corroborating signal.

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

- Guidance appears in the transcript as a `guardian_intervention` custom message.
- Routine monitoring and actual WASM evaluations have separate visible receipts, so standby
  is not confused with successful inference. Reduced prompt coverage is explicit.
- Child-subagent guidance is relayed to the parent session through the subagent supervisor channel.
- Internal intelligence components (JEV, Needle3, Smol, Kompress, fuzzy/neural helpers, the intent
  classifier) report a single bounded `activity` line per real use, deduplicated per component.
- `/guardian stats` and the `micro_status` tool expose counters; neither runs inference.

JEV uses its configured remote judgment service; Needle3, the native Guardian kernels, and
fuzzy recovery run locally. Guardian never invokes JEV or another remote model for scoring.
See the [independent implementation audit](GUARDIAN-IMPLEMENTATION-AUDIT.md) for repairs,
measurements, exercised paths and remaining implementation gaps.

## Boundaries and measured overhead

This is a narrow supervisor, not a general semantic task or architecture classifier. The two
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
