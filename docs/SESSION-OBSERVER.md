# Session observer

The session observer is an independent, conversational quality reviewer. It asks useful questions and offers brief reminders about the main agent's progress, assumptions, user requirements, todo updates, child-agent follow-up, and harness choices. It cannot execute tools, write code, delegate, authorize actions, or change the user's task. Guardians remain narrow local checks.

During active work, review opportunities start every 30 seconds. Consecutive reviews are separated by at least 30 seconds; requests have a 45-second deadline. New advice is shown as soon as it passes validation. When nothing useful changed or a provider remains stuck, a visible check-in explains the state within 120 seconds. Check-ins do not pad the main agent's context with repeated suggestions. These timing bounds assume the process/event loop is running; provider availability and fresh evidence cannot be guaranteed by a timer.

The default route is `deepseek/deepseek-flash` through the official DeepSeek API, with high thinking. Change the **Session Observer** role through `/models`, which edits the existing `llm_preferences.json` document. The observer does not change the main session's selected model. For example:

```json
"session_observer": {
  "models": [
    { "provider": "deepseek", "model": "deepseek-flash", "thinking": "high" }
  ]
}
```

Set `"session_observer": { "models": [] }` to disable it. A missing role uses the default; an invalid explicit role is reported as unavailable instead of silently borrowing another model. Existing aliases, reasoning settings and provider restrictions are preserved.

## Evidence and harness knowledge

Events are read as chronological chunks with a cursor. A successfully validated review advances only the events actually included in its packet; an invalid response leaves the chunk available for the next review. The in-memory queue retains 256 events. Overflow produces a visible coverage notice and explicit incomplete-coverage evidence instead of pretending old work never happened. The original user request remains authoritative in the main session; the observer's excerpt focuses on the actual task after complete mindset wrappers, and marks omitted portions of long requests.

Explicit peer messages sent or received by this exact session are included as untrusted coordination evidence. They do not become user instructions, authorization or model restrictions, and messages owned by another session are rejected.

Each review also receives bounded current todo and child-agent status, recently completed tool calls with paths/actions, active foreground commands with elapsed time and timeout, exposed assistant activity, and recent advice. Provider-returned reasoning is included only when explicitly available. Hidden reasoning is unavailable. No private session archive scan or skill-body read is required.

A source-backed harness map explains direct subagents, scope councils, parallel swarms, provenance-preserving fusion, quality review, todo completion evidence and background jobs. Relevant tools and installed invocable skills are ranked from their metadata for each chunk. Tools are explicitly marked **active** or **discoverable**; a discoverable tool must be activated/discovered before use. Catalog presence does not prove that a feature is enabled or has run. Recommendations must match exact listed names.

Suggestions depend on current work. For example, a long foreground check can be a candidate for background execution when useful independent work remains. A 120-second timeout alone is not evidence of a bad choice, and final verification on the critical path may appropriately stay foreground. The observer does not stop or move an already running command. A separate complete JSON evidence record supplies configured subagent/council/quality-review preferences and relevant explicitly configured swarm/fusion roles, proven-free candidates allowed by current restrictions, observed child outcomes and reported/estimated/unknown costs. Model suggestions must respect these preferences and constraints, use measured usage/performance where present, and acknowledge unknown quality or cost. Execution counts are not quality scores, and unused preferences are not a quota to spend.

Packets, including instructions and capability metadata, are capped at 8,000 UTF-8 bytes. The builder reduces catalog breadth and summaries first, preserves compact current running/completed/todo/child state and the latest advice, and keeps the next unread event. When necessary it reduces model evidence by whole JSON rows with an explicit sampling notice; unknown cost and user restrictions remain intact. This is a bounded evidence sample, not a claim to have read every byte of the session.

## Delivery and freshness

An accepted note appears in the TUI and enters the main agent's next normal model request once. It is limited to 150 words and 1,200 characters. Later context rebuilds remove the consumed note; it is not re-injected on every turn. Exact and near-duplicate suggestions are suppressed, including across user steering in the same session. Prior advice is included in subsequent reviewer packets to discourage repetition before validation.

Accepted user input, session replacement and model changes always invalidate old observations. Freshness is checked against the evidence actually cited: changed running/todo/child/completed state and lost intervening events reject a note, because its premise no longer holds. Later work that merely overlaps the note's resources, topics or suggested tools does not discard a paid review; the note is delivered with an explicit caveat naming the overlap and asking the agent to check whether it was already addressed. Notes include their reviewed snapshot identifiers and require checking newer work. Resource/topic matching is a heuristic, not a semantic proof. Unconsumed advice expires after 120 seconds and its freshness is re-checked at delivery. Context advice remains optional and cannot act as a user request or permission.

The observer never wakes an idle agent, interrupts a tool or starts a new user turn. It can show advice while a foreground command runs, but the main agent can consume that advice only at its next model/context boundary. Idle sessions and explicit opt-outs do not generate periodic inference.

## Failure, isolation and cost

There is at most one physical observer request in flight. The 45-second deadline settles the coordinator even if transport ignores cancellation. In that case the transport retains its slot, the TUI explicitly reports that cancellation was not acknowledged, and no overlapping requests are launched. Reviews recover after the transport actually settles. A timeout does not prove that provider billing stopped.

Malformed, incomplete, tool-calling or uncited replies are rejected visibly. The next eligible review can retry unconsumed evidence; there is no hidden retry cascade. Configured-route failure, offline/user restrictions, missing credentials and insufficient output capacity remain explicit constraints. Routes require at least 12,288 context tokens and 4,096 output tokens. Reasoning and answer share a maximum 4,096-token output allowance; native checks may reduce it further.

Session-manager identity and generation own callbacks, evidence and usage. A replaced session cannot receive another session's late advice or billing. Child sessions cannot register an observer. Usage records contain only reported token/cost fields; missing usage is unknown, not free. The observer is counted as auxiliary model work rather than a spawned child agent. Late usage that cannot safely be attached to its original owner remains unknown there instead of being charged to a replacement session.
