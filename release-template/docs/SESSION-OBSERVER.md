# Periodic session observer

The session observer is an asynchronous adviser for the main agent. During active work it checks recent activity about every 4½ minutes and may offer a short observation about an overlooked tool, a useful skill or a better next step. Its advice does not grant permission, replace the user's request, execute tools or create subagents.

The default route is `deepseek/deepseek-flash` through the official DeepSeek API, with high thinking. Change the **Session Observer** role through `/models`, which edits the existing `llm_preferences.json` document. The role uses the same model references, thinking settings and provider options as other routing roles. It never changes the main session's selected model.

An inline role entry has this form inside `preferences`:

```json
"session_observer": {
  "models": [
    { "provider": "deepseek", "model": "deepseek-flash", "thinking": "high" }
  ]
}
```

Set `"session_observer": { "models": [] }` to disable the observer. A missing role uses the default above; an invalid explicit role is reported as unavailable instead of silently selecting another model. Upgrades preserve existing model aliases and role settings.

## Observation and delivery

The observer receives a bounded slice of the current request, recent assistant activity, tool outcomes and relevant tool/skill descriptions already loaded by the session. The packet is limited to 6,000 UTF-8 bytes, including instructions. Its catalog is a relevant selection of active tools and invocable skills; omitted capabilities are not necessarily unavailable. It can inspect provider-returned reasoning when available. Hidden reasoning that the provider does not return is unavailable. It does not scan private session archives, read skill bodies or copy the full conversation into another context.

An accepted note appears in the TUI and becomes a small advisory in the main agent's next normal model request. The note is limited to 150 words and 1,200 characters. Only the current note is supplied as this advisory; old display notes do not accumulate in model context. A note does not wake an idle agent, interrupt a tool, start a new user turn or require the main agent to act. A new user request, completion or session change invalidates old observations; unused advice expires after nine minutes. Accepted steering starts a new observation interval.

Recommendations are checked against the tool and skill identifiers supplied to that observer call. A valid identifier establishes availability, not that the recommendation is correct. The main agent must assess relevance and verify any substantive claim against source evidence.

## Work and cost limits

There is one in-flight request at most, cancelled at a 45-second deadline, with no retry cascade. A transport that ignores cancellation retains that slot until it settles, preventing overlapping requests. Idle sessions, unchanged activity, offline sessions and child agents do not generate periodic inference. Routes must support at least 12,288 context tokens and 4,096 output tokens. The reasoning-inclusive request allowance is at most 4,096 output tokens; native context checks may reduce it further. High thinking can consume that allowance without producing a useful note; incomplete or invalid responses are discarded. Final dispatch preserves the configured route, provider restrictions and output cap even if model sampling defaults conflict.

The observer requires the configured provider's credentials. An unavailable route is reported without borrowing the main agent's model or silently changing providers. APIs without an enforceable output limit are unavailable for this role; their use by the main agent and other roles is unaffected. Actual requests produce activity notes; idle and unchanged timer checks remain silent. Usage records retain reported tokens and cost evidence in the footer, `/cost` and `/metrics`; missing usage is not treated as free usage. The observer is not counted as a spawned child agent. Late usage from a replaced session is not written to the new session; the old pending receipt remains explicitly unknown.
