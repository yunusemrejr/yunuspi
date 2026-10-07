# Native engineering evidence

Start with the smallest failing command or source boundary. Keep the exact input, observed failure, changed files and verification result in the existing plan or project record. Do not create another task ledger or run a second review merely to restate the first.

## Repository context

Use `project_intel` with `action:"impact"`, an exact file/entity `focus`, `direction:"incoming"` and a small hop/character budget to find consumers. Use `direction:"outgoing"` for dependencies. Read the relevant source and affected tests before treating inferred relationships as facts. A missing edge or partial scan cannot establish independence.

`code_quality` with `operation:"structure"` provides runtime import cycles, dependency drift and fan-in/fan-out cues. Type-only imports still matter to project impact, while they do not form runtime cycles. The graph resolves observed relative modules and Python packages; aliases and computed imports remain unknown. An `incomplete` list suppresses orphan/unused-package conclusions. Use source navigation or the project's resolver for those gaps.

For a shared-owner refactor, a bounded `code_quality` baseline can combine structure, duplicated logic and changed-source cues in one call. A local function fix needs its relevant regression; it does not automatically need a workspace-wide review. Do not install packages merely to satisfy a heuristic finding.

## Execution and debugging

Inspect the first failing diagnostic and the command's real exit. Native `project_tests` receipts retain bounded failure excerpts, source identity and command identity; a detailed view can recover diagnostics without inventing temporary logs or rerunning an unchanged command. Syntax checks establish syntax only. Build, type, behavior and runtime evidence answer different questions.

Declare required checks with `project_tests` using `action:"assess"`, the reason and exact literal commands. An already observed pass can satisfy an identical source/command plan. Quoted `&&` arguments are literal data; genuine command chains expand into separate planned checks. A `cd` prefix stays in the label, and an existing symlink target participates in its identity. Different environment values or source revisions need their own receipts.

Use retained background task IDs and completion notifications for long tests, profilers, builds and media renders. Follow the failed scope after a launch or dependency failure; preserve successful sibling results. Inspect filesystem/runtime state before retrying an operation whose timeout leaves its outcome uncertain.

## Continuity and accountability

Record a falsifiable hypothesis and the evidence that rejected or supported it. On resume, check source versions and current receipts before reusing conclusions. A changed scanner invalidates older cached structural evidence once; unchanged returning scans reuse the current records. History and skills provide context, not execution authority or proof.

Preserve the selected model, thinking controls, required verification and explicit user preferences. Extra decomposition, observers and reviews should respond to task risk and observed execution trouble. Successful stronger-model work should not pay for redundant mandatory steps; weaker-model failures should get a precise next action and bounded recovery, not generic repeated reminders.
