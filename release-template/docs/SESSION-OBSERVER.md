# Session observer

The session observer is the one independent background reviewer beside the main agent. It judges quality, intent and time in a single note: what the user asked for and may have lost, claims that the evidence does not support, waste (loops, repeated failing calls, the wrong tool or skill, serial work that parallel children could do), and the single biggest time sink when time is the larger risk. It cannot execute tools, write code, delegate, authorize actions or change the user's task. Guardians stay narrow local checks.

It consults [the Observer Book](OBSERVER-BOOK.md), 14 chapters of doctrine selected by deterministic triggers, plus margin notes kept per project, and cites the passages it used.

## Cadence and cost

- Reviews start after the main agent's first response of a task (harness preparation such as prompt analysis or a scope council is not agent work to judge).
- Opportunities start every 30 seconds during active work, at least 30 seconds apart. After a review that adds nothing new the next waits 60, 120, then at most 240 seconds, until something salient happens: a tool error, a test or build result, a plan change, a completion claim, a peer message or a newly fired book trigger. Idle sessions generate no inference.
- At most one review is pending. Each has a three-minute allowance.
- Reviews run on the session model with its own credentials, the same model as the main agent. No other model, preference, fallback or route is chosen for the observer. If the session model is missing or cannot produce the output a review needs, the review is skipped and says so. Reviews use the session's thinking level; a timeout or truncated reply steps it down for later reviews, and clean reviews step it back up. The observer runs only with `PI_LEAN_GATES=on`; `PI_SESSION_OBSERVER=off` and the user phrases `no observers` or `work offline` also stop it.

## What it sees

Every packet carries the whole session's intent (the current request, earlier prompts, the harness's reading of the latest prompt labelled as a helper's reading, active `/reminder` texts), the newest events and failures verbatim with older backlog folded into a digest, a deterministic session profile (phase, calls, reads, edits, errors, verification), todo and child-agent state, running and completed tools, and a **time-ledger** row: task wall time, measured tool time per tool and 3+ repeats of the same tool and target. Counts omit work inside bash, scripts and children, so they are measurements, never verdicts.

It can investigate with bounded read-only tools (`session_detail`, `session_search`, `read_file`, `grep_files`, `book_read`). Packets are capped at 10,000 bytes plus the book's separately bounded 3,400-byte section.

## Delivery

An accepted note (at most 150 words) appears in the TUI and rides the main agent's next normal model request with a delivery receipt; it is never pushed into an idle session. Unknown evidence ids, tools and skills are removed rather than voiding a paid note, a long copy of the user's words is cut out, and a note whose premise has vanished (a cited command has finished) is withheld. Accepted user input, session replacement and model changes invalidate old observations.

While Double mode is on, one `planner-state` row names the mode and its routes, and Double's directive and the scope council's brief appear as peer notes beside Guardian's: the observer does not restate them or advise repeating the deliberation.

Usage is counted as auxiliary model work, never as a spawned child agent. Child sessions cannot register an observer.
