# Orchestration evidence

Child counts describe logical runs. Helper/controller receipts and their native
run IDs must resolve to one child; an explicit stop is distinct from failure.
Workflow controllers are counted separately. Zero fan-out or workflow counts do
not establish that retry or recovery is unavailable.

New child accounting receipts retain compact `evidence`: a task hash, outcome
reason, model, reported token traffic, observed duration/progress, output
presence, and up to eight recent model attempts with their individual usage.
The full attempt count and retry count remain available when the attempt list
is truncated. Raw tasks, error text and output are excluded. Output presence
is not proof of correctness or usefulness. Older receipts may lack this
evidence; missing values remain unknown. Cached reads are traffic, reasoning
is a subset of output, and cost evidence retains its existing reported versus
estimated distinction.

Recovery remains bounded by the existing execution policy. Startup retries
require evidence of no useful work, model fallback respects permitted routes,
and retained-session continuation requires verified process-tree termination
and no in-flight tool calls. Stops, exhausted budgets and failed acceptance do
not authorize relaunch. Review groups preserve completed validated reports
when a peer fails or reaches its deadline; incomplete aspects remain gaps.

Lens emits `tool_result_handler` timings in its latency log and
`lens.tool_result` numeric health events. These distinguish tools and returned,
unchanged, tool-error and handler-error outcomes. Nested lint/LSP phase times
can overlap and must not be summed as wall time. Profile the expensive edits
before reducing diagnostics: an average across all results can conceal a few
slow checks. Profiling does not disable source validation or mutation guards.

Restart Pi and resume the session to load changed extension modules. Existing
transcripts are retained; new fields are not invented for historical runs.
