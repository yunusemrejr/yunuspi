# Team

Delegated work does not have to run on the model you chat with. Every subagent has a role, and each role runs on the model you choose for it. With no settings, every role runs on the session's own model, as before.

## Roles

| Role | For | Agents by default |
| --- | --- | --- |
| main | the session's own model | oracle, and any agent you add |
| helper | long stretches that need judgment | worker, reviewer |
| legwork | finding, reading, checks, mechanical edits | scout, researcher, delegate |

An agent's role comes from, in order: `role` on the call, `team.roles` in settings, a `role:` line in the agent's own definition, the table above, then main. On a `tasks` or `chain` call, the call's `role` is the default for every item and an item's own `role` wins.

## Settings

Put the block in the agent settings file (`settings.json`). A project's settings file overrides it key by key.

```json
{
  "team": {
    "helper": "provider-a/model-b",
    "legwork": "provider-a/model-c",
    "advisor": "provider-d/model-e",
    "roles": { "reviewer": "main" },
    "maxThinking": { "helper": "xhigh", "legwork": "high" },
    "sideCalls": "legwork"
  },
  "run": { "softMinutes": 60, "softUsd": 1 }
}
```

- `helper`, `legwork`: `"inherit"` (the session's model, the default) or `"provider/model-id"`.
- `advisor`: `"off"` (the default) or a model.
- `maxThinking`: the highest thinking level a helper or legwork child may use. It joins the session's own ceiling and the agent's caps; the lowest applies.
- `sideCalls`: where the observer's notes and the memory summary at exit run, `"legwork"` or `"session"`. Calls that judge what you allowed always use the session's model.
- `run`: the soft budget of one run, below. `0` switches a limit off.

A value the settings cannot accept stops the launch with one line naming the file and what is accepted. A model that is not available stops it with the setting and the model named. `/team` edits all of this.

## Thinking level

How hard a model thinks is decided for every model in the team, not chosen by the model itself. For the session, the decision model (Jev) reads each message from you and may lower the thinking level for that run, never above the level you set. For a child, it reads the assignment once, when the child starts, and may lower the level the child was launched with; that level then holds for the child's whole life, so its prompt cache is never disturbed by a change of level. A long brief or one with code in it no longer forces the top level. If the decision cannot be made (no key, no answer, an unclear answer), the launch level stays.

## Forked children

A call with `context: "fork"` keeps the session's model, because the history the child replays is cached only there. It also keeps the session's thinking level; the role ceiling is for children that start fresh. An agent that forks only by its own default, and whose role runs on another model, starts fresh on its role's model instead.

## What a child is told

A child on another model knows only its brief. The harness adds what a brief tends to leave out: the working notes for delegated work, the index of guides it can read, and, when other children of the session are running, up to four lines under "Also at work in this session:" so that two children do not do the same thing. A launch identical to one still running is refused once with the running child named; sending it again runs it.

## The line with each message

A message from you that starts a run is followed by one line the model cannot get from anywhere else:

`Now: Sat 14 Nov 2026, 16:02 (Europe/Istanbul). Session: $0.034, context 41k of 128k tokens, cache hits 96%. Last run: 12 min, $0.021.`

A second line reminds it that the working notes apply to this message. Both are stored once and never rewritten, so they do not disturb the prompt cache. A figure that is not known (no price for the model, no earlier run) is left out. A message you send while a run is still working joins that run and gets no line of its own.

## Run budget

A run is everything the session does after one message from you. When a run passes `softMinutes` or `softUsd` (the session's cost since your message, children included), the model gets one note, which you see in the conversation too, asking it to finish what is in hand, check every open demand and report. At twice a limit one closing note follows. Nothing is stopped. Only time the agent is at work counts: the wait for your next message does not, nor does a gap of more than 10 minutes between two events. `/budget` shows the run: `Run: 12 min, $0.021 of 60 min / $1.00`.

## Advisor

When `team.advisor` names a model, the session has a tool `ask_advisor`. It sends one question of at most 1,500 characters, and nothing else, to that model and returns a few lines. Limits: 3 per run, 12 per session, one at a time. Its cost is recorded under the advisor's model. The tool is added or removed at the next session start; children never have it.

## /team

`/team` opens a picker for the values above, one row each, and saves to the global settings file. A change applies to children launched from now on. `/team show` prints the current values as plain text, which is also what a session without a screen gets.
