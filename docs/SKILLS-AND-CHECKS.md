# Skill routing and source checks

Skill routing is deterministic and uses no model calls. Explicit task and file
routes take priority; catalog descriptions provide additional suggestions when
at least two distinct discriminating terms match. Hyphenated skill names also
match ordinary prose. Negated clauses, quoted text and code fences do not become
positive task intent. A substantive new request replaces the old lexical topic;
short continuation requests retain it.

Up to three distinct catalog workflows can enter the existing suggestion queue.
Delivery remains capped at two hints at a time, with a small initial allowance
that grows during sustained work. Duplicate, already-read and unavailable skills
do not consume the queue. Suggestions are not evidence that a skill was read.

## Before editing source

The reminders owner checks native `edit` and `write` calls against available
skills with exact file routes. An unread matching skill pauses the edit with its
path and reason. Read its `SKILL.md` using `read`, apply the relevant workflow,
then retry the edit. A successful complete read covers other files using that
skill while its context remains available. Failed or truncated reads do not
count, and compaction invalidates old read receipts.

When a skill is irrelevant to the particular change, already covered by other
instructions, or inaccessible, record the reason:

```json
{"action":"defer","skill":"python-software-engineering","reason":"This change only refreshes a generated parser fixture."}
```

Pass this object to `skill_review`; `{"action":"inspect"}` lists the current
review state. Deferrals expire on the next user request and never count as reads.
The checkpoint covers at most two skills per edit and four per request. It leaves
read-only work available, excludes generated/dependency paths, and requires both
`read` and `skill_review` to be active. It is a workflow checkpoint, not a sandbox:
shell commands and other mutation tools are not intercepted by this mechanism.

User requests to work without skills take precedence. `PI_SKILL_REVIEW=off`
disables the checkpoint; `PI_RELEVANT_GUIDANCE=off` disables its owning guidance
system as well. Ordinary lower-confidence suggestions never block work.

## Batch syntax checks

Call `syntax_check` with explicit workspace-relative paths:

```json
{"paths":["src/handler.ts","scripts/import.py","config/service.yaml"]}
```

| Files | Parser | Coverage |
| --- | --- | --- |
| JS, MJS, CJS | Bundled Acorn | JavaScript syntax; JS/MJS use module mode, CJS uses script mode |
| TS, MTS, CTS, TSX, JSX | Bundled Pi Lens Tree-sitter grammars | Grammar errors and missing syntax nodes |
| Python, PYI | Installed Python, isolated `compile` | Syntax without imports, execution or bytecode files |
| Bash, SH | Installed Bash, `-n` | Bash syntax; SH files are interpreted as Bash syntax |
| Ruby | Installed Ruby, `-c` | Syntax with gem startup disabled |
| PHP | Installed PHP, `-n -l` | Syntax without loading php.ini |
| Go | Installed gofmt, `-e -l` | Syntax only; no formatting changes or verdict |
| JSON | JSON.parse | JSON syntax |
| YAML, YML | Bundled YAML parser | Multi-document syntax and duplicate keys |
| TOML | Installed Python 3.11+ tomllib | TOML parsing |

No parser is installed automatically. Native parsers receive bounded source on
stdin with startup variables removed; executable lookup excludes project PATH
entries. The tool never executes project code, package scripts or build hooks.
It reuses the structural tools' workspace-contained, stable-file reader.

Each batch accepts up to 20 paths, 256 KiB per file and 1 MiB in total. Native
checks have a three-second timeout within a ten-second batch scheduling budget.
In-process parser initialization/parsing can overrun that scheduling budget;
it is not a hard process isolation limit. Results include file digests, compact
diagnostics and separate passed, failed, unavailable and incomplete counts.
Missing parsers, unsupported files, unsafe paths and truncated work never yield
an overall pass. No results are reused across calls; edits require fresh checks.

Post-edit hints suggest batching related paths. Success and failure hooks have
separate once-per-session receipts. `syntax_check` is also available within the
existing read-only child capability ceiling and tool budgets.

Syntax checks complement language-server types, behavior tests and environment
configuration/schema validation. A YAML syntax pass does not validate a Compose
or Kubernetes configuration, and TypeScript syntax does not prove type safety.
These changes reduce repeated command assembly and output volume; they do not
claim a measured cost reduction or guarantee every model's task quality.

## Component quality and shared review evidence

`artifact_check({operation:"ui",path:"src/Status.tsx"})` checks a complete workspace source file up to 24,000 characters. It reports a source hash and bounded advisory cues: decorative blinking live/status pills, competing primary font families, tiny tracked text, explicit opaque text/background pairs below 3:1, repeated absolute positioning, effect/motion clusters, placeholder links, clickable containers and removed focus outlines. Unsupported paths and oversized files do not receive a clean verdict.

The same source policy runs on successful native writes and independent batch replacements. Edit hooks route relevant skills; `quality_review` receives code, UI and content cues. Partial edits retain earlier cues until a complete replacement or fresh source discovery invalidates them. A source cue cannot resolve the CSS cascade, prove a status is fake, or certify usability. Review against project rules and user requirements, then verify rendered appearance and interaction states. Font/color names alone are not a ban list. Decorative blinking LIVE pills are discouraged by default.

Parent and child skill guidance names the available source and render tools, encourages batched syntax checks, and asks workers to retain file/revision/check evidence. Swarm/fusion consumers can reuse current receipts while preserving disagreements and unavailable evidence; merged edits require fresh verification of affected behavior. Tool and skill availability still constrain each worker. Guidance remains bounded and deduplicated.

Semantic radar also records a digest of JSX tags, attributes and text. A changed contract adds a divergence cue and prevents learned reordering within the affected similarity tier. Candidates remain available in baseline order. The neural model estimates code reuse affinity; it is not a visual design classifier and has not been retrained on these UI checks. Older fingerprint caches rebuild automatically.
