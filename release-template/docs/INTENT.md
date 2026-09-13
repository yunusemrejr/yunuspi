# Intent evidence and critique

The harness uses the existing project intelligence and automatic helper paths
to recover context for vague follow-ups. The original user message remains
unchanged. Short referential requests add recent user vocabulary to the existing
bounded graph query; helpers receive intact user excerpts with branch references
in space reclaimed from their instructions.

The same bounded cue covers compound instructions that name their subject only
by reference ("do this and that", "handle the rest", "same for the others"),
including a bare demonstrative that stands alone rather than modifying a noun
("do this SQL query" is a complete instruction, not an inherited subject). An
explicit task pivot, a refusal to continue or an over-long message keeps the cue
off. Inheritance stays retrieval and evidence only; it never becomes a new
instruction or permission.

Newer corrections take precedence only within their scope. Historical evidence
is not fresh authorization. Selection stops at explicit task pivots and does not
backfill an older preference across an omitted newer correction. Assistant and
tool messages are not treated as user instructions by this selector. Missing,
oversized or redacted evidence remains unknown.

Curated project memories can retain design preferences such as typography,
palette and motion. The graph brief prioritizes complete decision and constraint
descriptions, including their source and historical status. An extractor version
refreshes previously indexed memory once, then incremental reuse resumes.

Existing helpers compare plausible interpretations, distinguish constraints from
assumptions, challenge the preferred interpretation and suggest a decisive check.
Their conclusions remain advisory; agreement does not establish correctness.

This local selection adds no model calls, tools, processes or higher helper
budgets. Queries retain their 900-character cap, graph briefs their 1,800-character
cap, and helper history uses at most 280 encoded UTF-8 bytes. These are context
limits, not a guarantee of identical actual token use or total task cost. The
separate scope council has its own inference costs and limits.

Portable regression coverage is in `tests/intent-context.test.mjs`. It uses
synthetic data and local fixtures; it makes no model calls.
