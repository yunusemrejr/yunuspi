# Mr. Watchmaker

Mr. Watchmaker is a second, fully autonomous background reviewer beside the
[session observer](SESSION-OBSERVER.md). Where the observer judges quality and
intent, the Watchmaker judges one thing only: time versus progress. It names
the biggest current time sink and the faster alternative — an exact tool,
skill, or delegation move (subagent, swarm, fusion, council, quality review)
with the reason it saves time on the current trajectory.

It is read-only: it cannot execute tools, write code, delegate, authorize
actions, or change the user's task. Notes arrive in context like observer
advice, with the same provider-confirmed delivery receipts. It starts with
every session on its own; nothing needs enabling.

## What it sees (and what it skips)

Every review carries timestamps, not bodies: wall-clock elapsed, per-tool call
counts with durations, 3x+ tool+target repeats, edit/read pace, child-agent
counts, todo progress, the current and recent user prompts (excerpted), the
harness interpretation, and standing reminders. Tool output bodies and
provider-returned thinking never enter its packet, which is capped at 5,000
bytes. An in-memory journal keeps one-line result summaries plus 200-character
heads for spot checks with the same bounded read-only tools the observer uses
(`session_detail`, `session_search`, `read_file`, `grep_files`; no book).

Durable conclusions persist as short `watchmaker-memo-v1` session entries (at
most 140 characters each, twelve kept in the working ring). Later reviews read
the scratchpad instead of re-deriving history, which keeps token spend low. A
memo that restates an earlier one replaces it. When the scratchpad and intent
rows would overflow the packet bound, the oldest memos and then intent rows
are dropped, so a review still runs with its time evidence instead of being
skipped.

## Cadence and cost

Reviews wait for the main agent's first response of each task: prompt
analysis and a scope council run before it, and that preparation is reported
as such in the elapsed row, never as agent idle time. Children the harness
launched on its own (scope councils, skill discovery, automatic review) are
counted separately from the agent's children: their results arrive in context
by themselves, so there is nothing for the agent to harvest. A memo the
Watchmaker writes does not make the next review due, and a note that only
re-recommends tools or skills its last notes already named is suppressed as a
repeat. The time sink a note leads with (for example bash) is delivered at most
twice per task; further diagnoses of the same sink are suppressed. The packet
lists only registered tools, and a note may not call verification that another
reviewer asked for churn; it names a cheaper way to meet that check instead.

Review opportunities start every 60 seconds with a two-minute request
allowance. Quiet stretches (empty or repeated notes, unusable responses) back
off the same way the observer's do. Answers are capped at 4,096 output tokens (low-thinking routes spent a 2,048 cap on reasoning alone)
and notes at 60 words.

The default route is `deepseek/deepseek-flash` through the official DeepSeek
API, with low thinking. Change the **Mr. Watchmaker** role through `/models`:

```json
"watchmaker": {
  "models": [
    { "provider": "deepseek", "model": "deepseek-flash", "thinking": "low" }
  ]
}
```

Set `"watchmaker": { "models": [] }` to disable it; `PI_WATCHMAKER=off` and
`/watchmaker off` pause it for the process or session. It honors the same
user opt-out phrases (`no observers`, `work offline`) and model restrictions
(fixed route, same model, free-only) as the observer. `/watchmaker memos`
lists the session scratchpad.
