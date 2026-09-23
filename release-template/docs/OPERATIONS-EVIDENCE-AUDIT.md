# Operations and evidence audit — 0.4.0

This follow-up extends the independently audited 0.2–0.3 runtime. The Guardian, routing, initial/follow-up intent and session-recovery audit remains in [Guardian implementation audit](GUARDIAN-IMPLEMENTATION-AUDIT.md) and [session recovery audit](SESSION-RECOVERY-AUDIT.md). New features reuse existing owners; they do not replace model/provider, skill, hook or agent interfaces.

## Runtime paths

| Change | Actual path and verification |
| --- | --- |
| Workspace/mail operations | Native utility adapter → existing MCP worker → bounded Python stdlib reader. Tests exercise actual MCP transport, MIME decoding, confinement, stale snapshots, output caps and cancellation. |
| SSH planning/diagnostics | Existing utility worker → inert argv construction or one explicit TCP target. Loopback fixtures test identification, malformed/oversized/silent banners and cancellation. No test authenticates against a user's server. |
| Factual evidence | Parent memory owner and explicit child context provider → shared bounded source reader. Native tool tests cover exact quotation/hash checks, stale/missing/private sources, interpretations and response-size attacks. No arbitrary factual-truth claim is made. |
| UI advisories | Existing rendered capture → DOM/style/animation inspection. Real Chromium and native design tools test desktop/mobile, reduced motion, legitimate status semantics, hidden/article/user content, density and font/border patterns. |
| Needle concurrency | Existing local inference queue shares identical normalized pending requests. Worker-protocol tests exercise concurrent consumers, independent result ownership, failures, shutdown and session-scoped activity. |
| Coordination receipts | Existing peer heartbeat observes a separately authorized native bash command. SDK tests cover blocked execution, session fences, input changes, forged metadata and terminal cleanup. Native shell signal exits are errors. |
| Async sandboxes | Native sandbox tool → existing background registry → fixed data-only helper invocation → existing Bubblewrap/systemd cgroup boundary. Real Linux checks exercise success, failure, deadlines, kill, resource limits and unchanged foreground operation. |

## Defects found during independent review

- Long unavailable source labels could amplify claim-check output. Receipts now identify input references by index and retain source hashes/positions without echoing arbitrary paths.
- A silent SSH server could lose the fact that TCP connected. All terminal paths now distinguish connection state, identification and unverified host identity.
- Safety-blocked commands skip the ordinary tool-result hook. Coordination now consumes the canonical terminal event too, once, so prepared checks cannot remain permanently running.
- A broad coordination publish merge accepted undeclared receipt metadata. Closed schemas and an explicit publication allowlist prevent tool callers from minting native-looking outcomes.
- Concurrent duplicate sandbox admissions could collide on response identifiers. Admission identity must share one launch/result and reject conflicting reuse; cancellation and session changes must retain ownership of late acknowledgements.

## Cost and verification limits

A deterministic Needle protocol test issues 12 simultaneous consumers for each of four operations. It requires four worker executions, with 44 shared consumers, versus 48 uncoalesced operations. This measures duplicated work in that fixture, not universal latency, quality or billing improvement. No confidence threshold was lowered to inflate helper use.

UI checks and claim checks add no hosted model calls. Search and evidence outputs are bounded; incomplete scans remain explicit. Shared check receipts can avoid repeated exploratory commands, but an exit-zero result proves neither test coverage nor exercise of every declared file. Inspect the originating session/tool-call result; dependency, environment and required release checks still apply.

Sources and mail are untrusted data. A quotation match does not establish source authority or external truth. Rendered heuristics cannot certify taste, factual correctness, all shadow/frame content or accessibility. An SSH banner does not authenticate a host. Disposable sandboxes cover supplied launch-time snapshots, with no automatic copy-back or host fallback; child contexts without the background service retain foreground sandboxes. These limits remain visible rather than being turned into successful verification claims.
