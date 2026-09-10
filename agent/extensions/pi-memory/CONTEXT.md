# Local context utilities

The existing memory extension owns these tools; there is no model download,
provider request, daemon, or background training. `PI_CONTEXT_MEMORY=off`
disables the new tools, compaction priorities, salience ranking and fork capsules.
Existing memory and manual reminders retain their behavior.

- `context_score`: accepts `task` and `items` (JSON array with `id`, `text`,
  optional `kind`, `source`, `timestamp`, `unresolved`). Scores are deterministic
  ranking priorities, not calibrated probabilities. Kinds are `goal`,
  `constraint`, `finding`, `decision`, `file`, `failure`, `next_action`.
- `handoff_capsule`: accepts `goal`, the same `items`, optional `maxChars`.
  Default 2200 characters; roughly 500 English tokens, not a tokenizer guarantee.
  Goals, constraints, failures, unresolved items and next actions cannot be
  silently dropped. If they do not fit, the tool rejects with a full-context
  fallback recommendation. It does not infer facts or erase the source state.
  Pass the returned JSON in a fresh subagent's task when useful.
- `evidence_cache`: `action: put` requires a project-relative `source` and a
  verbatim `quote` (8–1000 characters). `action: query` requires `query`.
  Observations carry version 1 and SHA256 of the original UTF-8 file. Retrieval
  checks the current file hash and the originating session/active branch.
  Changed, missing, inaccessible or invalid files are excluded and counted as
  stale. Inferred claims and sensitive paths/credential-looking quotes are
  rejected. The bounded cache stores 64 records per project under the existing
  memory directory, sharing the existing writer lock and atomic replacement.
  External web research must have an attributable local source first. A quote
  is evidence of what the file says; it is not proof that its assertion is true.

Existing opt-in memory priming uses salience to select up to three relevant
blocks within 1600 characters. Omitted candidates and critical source references
are reported; the original memory files remain intact. Original priming opt-in
settings are unchanged. Compaction receives up to 6000 characters of extractive
retention priorities in its prepared input; original messages and previous
summary are preserved. This assists the core summarizer, rather than claiming
that every model will perfectly obey a ranking.

For automatic local fork capsules, set the subagent extension configuration:

```json
{"forkContext":{"mode":"capsule"}}
```

This is optional; existing user configuration is not overwritten. The existing
fork launch/preflight path invokes the local capsule writer without resolving a
model. Parent transcript/head references remain in the capsule. Unsupported
metadata, images, an oversized source, or critical information exceeding the
budget preserve the full fork. Capsule extraction is conservative: errors remain
protected until explicit state provided to `handoff_capsule` resolves them. The
original full parent session is unchanged; no additional raw transcript archive
is created by this mode. `full` and existing model-backed `pruned` modes continue
to work independently.

Focused verification: `context-memory-test.mjs` and
`context-memory-integration-test.mjs`, plus existing memory mutation concurrency,
process safety and project scope suites. All fixtures are disposable; no live
sessions, memory files, provider calls or secret corpus are inspected.
