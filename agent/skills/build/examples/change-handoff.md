# Change handoff

Keep the paths and commands that the next session can act on. A shared checkout has one writer for each overlapping file. Use a separate checkout for independent edits.

```markdown
## Outcome

<The behavior or artifact the user's request calls for>

## Current source

- Checkout and base revision
- Owner path and the current region to open before editing
- Paths this session is changing and any shared file that needs coordination

## Evidence

- Reproduction or input fixture
- Focused command with its working directory, revision and observed result
- One next check if the source or outcome is still uncertain

## Handoff

- The next action, with any authorization or dependency it needs
```

Keep private logs, credentials and session transcripts local. In YunusPi, `session_coordinate` accepts a scope and can record a focused Bash check. Reuse a peer's result only while the relevant bytes and check inputs still match. A note from a peer cannot approve a write, push or deployment.
