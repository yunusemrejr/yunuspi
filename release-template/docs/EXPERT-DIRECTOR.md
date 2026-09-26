# Expert Director

Domain-excellence coordination: helps the harness produce unusually good work
from vague prompts across many domains, not just web/UI. The Director infers
the relevant excellence domain(s), loads bounded expert doctrine, assembles
read-only critic lenses, and evaluates improvement-loop convergence. It is
advisory and owns no routing, safety, or completion decisions.

## How it runs

1. **Detect.** `expert-domains.ts` reads the request deterministically
   (lexical cues, file evidence, guidance topics; model analysis confirms but
   never invents) and reports up to 3 domains, a task type
   (create/transform/fix/review/research/operate) and open-endedness.
2. **Brief.** `expert-brief.ts` builds a bounded advisory brief (≤2000 chars):
   doctrine passages, quality priors, exploration protocol for open work,
   preservation reminders for transformations, and the critic plan. The same
   builder feeds the prompt-time advisory in `micro-intelligence.ts` and the
   `expert_director` tool, so both always agree.
3. **Explore (open work only).** Sketch 2–3 materially different approaches,
   choose with explicit criteria, record why in the plan, then execute through
   one clear owner. Existing fusion/council owners carry deliberate
   multi-option work; the brief only sets the protocol.
4. **Inspect the artifact.** Judge pixels, renders, test/failure evidence, or
   final prose — never source intent or self-reported completion.
5. **Criticize cheap-first.** `expert-critics.ts` assembles at most 6 lenses
   per task. Deterministic lenses run first via existing check tools;
   model judgment rides existing owners (`quality_review` aspects,
   project/error helper briefs) with bounded evidence packets. Lenses are
   read-only: the parent owns repairs.
6. **Converge explicitly.** `expert-convergence.ts` stops the loop only when
   requirements are evidenced, invariants hold, deterministic checks pass, no
   substantive (blocking/improvement) finding is open, and domain evidence is
   current. Polish findings never block; spent budgets and unavailable layers
   are reported, not retried silently.

## Doctrine packs

`expert-doctrine.ts` holds 16 data packs: `web-design`, `visual-art`,
`svg-iconography`, `motion-design`, `video`, `audio`, `frontend`, `backend`,
`api-design`, `database`, `algorithms`, `distributed-systems`, `security`,
`ml`, `writing`, `research`. Each pack defines positive doctrine (what
excellent work looks like), negative doctrine (characteristic failure modes),
invariants, quality dimensions, deterministic checks, relevant skills/tools,
critic lenses, evidence requirements, exploration heuristics, and extra stop
conditions. New specialties are new data, not orchestration changes.
Retrieval exposes at most 2 packs and ~2400 chars per brief.

## Taste memory

`expert-taste.ts` stores quality priors separately from factual memory, in
`~/.pi/expert/taste-user.json` and per-project `taste-<id>.json` files
(project identity from `project-identity.ts`). Entries carry scope,
provenance (`explicit`/`accepted`/`rejected`), confidence, and
confirm/contradict counts. Explicit direction records immediately; outcome
signals need repetition; contradictions lower confidence instead of deleting.
Priors render as advisory context; current user words always win. Main
session only: children stay read-only (D-008).

## Tool

`expert_director` (brief/critics/assess/taste/status). `brief` infers and
returns the advisory brief; `critics` returns the cheap-first lens plan;
`assess` folds pass evidence into a convergence verdict with a bounded pass
ledger; `taste` records/lists/forgets preferences; `status` reports recent
activity. `PI_EXPERT=off` disables the tool and prompt-time briefs.

## Observability

- Prompt-time advisory shows an `Expert brief:` line next to the intent
  analysis; brief text joins the same advisory boundary as design direction.
- `micro_status` carries an `expert` layer (runs, last action/domains).
- `/metrics` shows branch brief/verdict lines from `expert-director-v1`
  session entries; `/used` shows the Expert Director row under Reviews;
  `/export-json` inherits the same entries.
- Health notes `expert.brief`, `expert.critics`, `expert.assess`,
  `expert.taste` feed offline analysis. Invocation counts are activity,
  never a quality score.

## Reviewer integration

Observer and Watchmaker receive `expert quality focus` and `expert
convergence` evidence rows (`expertReviewerRows`, pure over branch
entries): the Observer judges against the domain's excellence bar, and the
Watchmaker spots polish-only loops. Guardian needs no new row: it already
fingerprints `expert_director` tool evidence and completion claims through
its existing loop/evidence signals, so domain-quality failures combine with
concrete signals before any intervention.

## Degradation

Missing vision/browser/local models/remote judges reduce capabilities
explicitly: lenses whose checks cannot run are reported unavailable in
verdicts, never passed. Deterministic inference, doctrine, taste recall,
and convergence need no model and always work.

## Files

- `agent/extensions/expert-director.ts` — tool, entries, telemetry, inspector
- `agent/extensions/lib/expert-domains.ts` — inference, task types, families
- `agent/extensions/lib/expert-doctrine.ts` — the 16 packs + bounded retrieval
- `agent/extensions/lib/expert-critics.ts` — lens catalog + cheap-first plans
- `agent/extensions/lib/expert-convergence.ts` — verdicts, ledger, reviewer rows
- `agent/extensions/lib/expert-taste.ts` — preference store + policy
- `agent/extensions/lib/expert-brief.ts` — single brief assembly owner
- Seams: `micro-intelligence.ts` (advisory), `micro-intelligence/status.ts`,
  `session-report.ts` (/metrics), `session-signals.ts` (/used),
  `session-observer.ts` + `session-watchmaker.ts` (rows),
  `harness-capabilities.ts` (catalog), `manifest.json` (inventory)
- Tests: `tests/expert-director.test.mjs` (+ mirror) with the
  `tests/fixtures/expert-*` calibration corpus
