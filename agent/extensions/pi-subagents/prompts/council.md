---
description: Run a bounded supervisor-mediated council of advisors and write a decision memo
argument-hint: "<question> [--advisors name,name] [--max-passes 2|3] [--scope ...] [--non-goals ...]"
---

Run a bounded, supervisor-mediated council on this question. You, the parent
session, are the supervisor. You select the roster, curate cross-advisor packets,
decide which feedback is valid, and write the final memo. Advisors do not talk
directly or see peer transcripts by default. This is not free-form agent chat.

Before you orchestrate, read `skills/council-mode/SKILL.md` and
`skills/pi-subagents/references/execution-controls.md` when they are installed.
If either is missing, follow the fallback protocol below instead of improvising.

Parse the invocation yourself. The flags below are conventions, not runtime
options. Record a brief with the question, scope, non-goals, evidence targets,
roster, known advisor context modes, and pass cap. Default `--max-passes` to 2.
Clamp it to 2 or 3. If the question is trivial or settled, answer directly instead
of convening a council.

## Roster

- If `--advisors` is given, use exactly those agent names. Fail clearly on an
  unknown agent. Do not require or invent per-advisor role labels.
- Otherwise list agents with `subagent({ action: "list" })`, then prefer 2–3
  executable names that start with `council-`.
- If fewer than two profiles are available, fill the roster with `oracle`, then
  `reviewer`, until it has two advisors. Launch fallback `oracle` with
  `context: "fork"` so global defaults cannot remove its parent-chat context.
  Let `reviewer` use its normal profile context. Note the fallback and known
  context modes in the memo.
- Use the normal single-oracle loop only when a requested roster or unavailable
  builtins leaves fewer than two advisors. Label the memo as degraded mode.

Profiles provide the model, tools, context, and advisor stance. The council
question and scope provide the decision frame. If the user wants a specific lens,
they should put it in the question, scope, or profile definition. Keep the roster
at 2–3 and never exceed 4.

Package advisors such as Surf's `gpt-pro` are valid only when the package Pi
extension is installed and its external-job provider is registered. For Surf,
that means the `surf-cli` Pi extension has loaded and `surf-oracle` appears in
`subagent({ action: "list" })` or the advisor is explicitly requested in
`--advisors` after that install. Treat them as external-runner advisors: omit
child `async` for normal attached council results, do not pass `outputSchema`,
include any needed evidence in the prompt, and use the fresh fallback cross-exam
path if the run is not resumable.

## Run the protocol

Use the canonical workflow, structured advisor contracts, aggregate pass receipts,
and memo requirements in `skills/council-mode/SKILL.md` (or the fallback protocol
below when that skill is missing). Keep the parent as the
only synthesizer and decision maker. Do not introduce a chair advisor, peer chat,
or transcript sharing.

## Fallback protocol (only when the council-mode skill is missing)

- Pass 1: one async `workflowScript` with `runs.all` for independent read-only
  advisor reports (at most ~600 words each): recommendation, evidence as
  claim-plus-sources, assumptions marked verified/unverified, risks, confidence
  (high/medium/low with reason), up to 3 challenge claims, owner decisions, and
  what would change the advisor's mind. Same contract for every advisor; ask
  external runners for compact JSON text with the same fields. Return one
  aggregate receipt (advisor key, agent, run id, report) and record every run id.
- The parent synthesizes a claim matrix in session: agreements, disputed claims,
  missing proof, owner decisions, and at most five high-impact relayed claims per
  advisor. Do not delegate this synthesis.
- Pass 2: one async `workflowScript` with resume calls carrying curated challenge
  packets (disputed claims and conflicting evidence only; attribute peer content
  as "another advisor", never paste full peer reports). When an advisor is not
  resumable, rerun its profile in fresh context with its own pass-1 report plus
  the packet, and label the response a fresh-context fallback, not a cross-exam.
- Stop at convergence, the pass cap, failed fallback, or interruption. The parent
  writes the final memo: question and scope, recommendation, rationale, accepted
  and rejected feedback with reasons, owner decisions, evidence and run ids,
  confidence, what would change the decision, and the roster, passes, fallbacks,
  and known advisor context modes. Do not delegate the memo.

Use its required boundary checkpoints, yield for each async workflow without
polling, and write its required final memo.

Question and options from the slash command invocation:

$@
