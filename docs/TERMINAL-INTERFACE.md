# Terminal interface

The default footer uses a stable order: working directory and session name; selected model and thinking level; context, main-model cache reuse and recorded total cost; tool activity, active agents/jobs and failures when present. Up to two extension status previews follow, with warnings first. Idle agent/failure counts and cumulative helper counters stay in expanded details.

`Ctrl+O` (or your configured tool-expansion shortcut) expands the footer and tool output together. Expanded details include input/output/cache token traffic, automatic-compaction state, accepted child counts, named tools used, session ID and every extension status. Extra compact statuses show a count and the configured expansion key. `/catalog-status` retains the full catalog warning. Cache `?` and cost `$?` indicate unavailable evidence; an estimated or partial amount keeps its original markers.

`/metrics`, `/cost` and `/self` share a scrollable snapshot panel with highlighted section headings. Use arrows or `j`/`k`, Page Up/Down, Home/End or `g`/`G`, and the mouse wheel. Escape, Enter or `q` closes the report. `/metrics` retains keys 1–6 for its detailed sections. Resizing preserves the logical row being read. Reports fall back to readable text when a custom TUI panel is unavailable. The `session_self` tool still returns its structured evidence.

Tools without a custom result renderer show at most three wrapped result rows normally and six for errors, followed by an expansion hint. The generic tool display also bounds its argument/result preview. Expansion retains the complete result; these are display limits and do not change stored evidence or model input. Tools that provide their own renderers retain their own presentation.

These changes preserve model selection, effort, accounting, helper execution and session history. Restart YunusPi after updating to load the new core interface.
