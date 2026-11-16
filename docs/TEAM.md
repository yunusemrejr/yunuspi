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
    "sideCalls": "legwork",
    "free": "on"
  },
  "run": { "softMinutes": 60, "softUsd": 1 }
}
```

- `helper`, `legwork`: `"inherit"` (the session's model, the default) or `"provider/model-id"`.
- `advisor`: `"off"` (the default) or a model.
- `maxThinking`: the highest thinking level a helper or legwork child may use. It joins the session's own ceiling and the agent's caps; the lowest applies.
- `sideCalls`: where the observer's notes and the memory summary at exit run, `"legwork"` or `"session"`. Calls that judge what you allowed always use the session's model.
- `free`: `"on"` (the default) or `"off"`. With it on, legwork children use free OpenRouter models, below.
- `run`: the soft budget of one run, below. `0` switches a limit off.

A value the settings cannot accept stops the launch with one line naming the file and what is accepted. A model that is not available stops it with the setting and the model named. `/team` edits all of this.

## Thinking level

Jev may lower thinking on an eligible request or on a fresh child's first assignment. The check takes at most two seconds. It skips cases where every possible result leaves the current level in place, including costly cache misses. Complex work and explicit requests to think carefully use the configured ceiling. A failed or unclear decision also uses the ceiling. Manual thinking selections take precedence.

## Forked children

A call with `context: "fork"` keeps the session's model, because the history the child replays is cached only there. It also keeps the session's thinking level; the role ceiling is for children that start fresh. An agent that forks only by its own default, and whose role runs on another model, starts fresh on its role's model instead.

## What a child is told

A child on another model knows only its brief. The harness adds what a brief tends to leave out: the working notes for delegated work, the index of guides it can read, and, when other children of the session are running, up to four lines under "Also at work in this session:" so that two children do not do the same thing. A launch identical to one still running is refused once with the running child named; sending it again runs it.

## The line with each message

A message from you that starts a run is followed by one line the model cannot get from anywhere else:

`Now: Sat 14 Nov 2026, 16:02 (Europe/Istanbul). Session: $0.034, context 41k of 128k tokens, cache hits 96%. Last run: 12 min, $0.021.`

The facts line and any matching guide hints are stored once. Unknown figures are omitted. Working notes live in the system prompt. Steering joins the current run and shares its cost and time budget.

## Free models

With an OpenRouter key and `team.free` on, a child of the legwork role (scout, researcher, delegate, or any agent set to legwork) starts on the best free OpenRouter model instead of the legwork model, while the account's free requests for the day last. Helper and main children, forked children, and every session without an OpenRouter key are not touched. A free model that is rate limited or fails is rested, and the child moves on to the next free model, and last to the model its role would have used, without starting over.

What counts as usable: a model whose name ends in `:free`, that takes tools, has a context of at least 64k tokens, is not about to be retired, and is in the session's model list. Router aliases such as `openrouter/free` and anything from Anthropic never count.

**Limits.** OpenRouter gives an account a fixed number of free requests a day (shown in `/team` as "973 of 1000 left today") and 20 a minute. Free models are used only while the day's remainder, less 30 for each free child already running, is at least 40, and no more than two children run on free models at once. A model that failed rests 10 minutes, then 20, 40, up to 2 hours; one success clears it.

**How a model is rated.** The first time a model is seen, the session tests it in the background with five short requests (at most 3 models per session start and 60 requests a day): call a tool with the exact path, use a tool's answer and ignore a distractor, answer in strict JSON, predict the output of a tricky JavaScript snippet, and find one line in about 6,000 tokens of logs. A model that fails any of the first three is never used. IQ is the share of those checks, and of the real children that ran on the model, that went well, from 0 to 100; speed is the median output tokens per second of the tests. Children that edit or write files need an IQ of 70, read-only children 50. Among the models that qualify, the pick is 60% IQ and 40% speed relative to the fastest. A model is tested again after 14 days. All of it is kept in `free-models.json` in the agent directory.

**Data.** A free endpoint may keep and use the prompts it receives under its provider's own data policy. Turn `team.free` off, or set the legwork model yourself and keep the session off OpenRouter, for work that must not leave your control.

`/team` shows the state in one line, for example `on · 973 of 1000 left today · 9 usable · next: nvidia/nemotron-3-ultra-550b-a55b:free (IQ 80, 54 tok/s)`, and `off` stops all of it: no requests, no tests, no free children.

## Run budget

A run starts with a request sent while the session is idle. Passing `softMinutes` or `softUsd` (including child costs) adds one note asking the model to focus on finishing and verifying the requested work. At twice a limit it gets one more note. The limits are advisory. Time spent waiting for you and gaps over ten minutes are excluded. `/budget` shows the run, for example `Run: 12 min, $0.021 of 60 min / $1.00`.

## Advisor

When `team.advisor` names a model, the session has a tool `ask_advisor`. It sends one question of at most 1,500 characters, and nothing else, to that model and returns a few lines. Limits: 3 per run, 12 per session, one at a time. Each question is rated by the decision model: an easy one thinks at a lower level, and a question it cannot rate thinks at medium; never above the session's own level. Its cost is recorded under the advisor's model. The tool is added at the next message after an advisor is set and stays for the rest of the session; with the advisor off, a call is refused. Children never have it.

## /team

`/team` opens a picker for the values above, one row each, and saves to the global settings file. A change applies to children launched from now on. `/team show` prints the current values as plain text, which is also what a session without a screen gets.
