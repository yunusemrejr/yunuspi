---
id: code-quality
part: engineering
title: Code quality and static analysis
summary: Using linters, type checkers, language servers and analyzers as evidence: duplication and the DRY principle, dead code, complexity, formatting, and recognizing generated-looking code slop.
terms: quality lint linter linting eslint ruff pylint flake8 clippy golangci prettier black format formatter static analysis analyzer lsp language server diagnostics typecheck tsc mypy duplicate duplication duplicated dry copy paste redundant complexity cyclomatic dead unused slop smell smells
tools: syntax_check source_check quality_review ast_diff symbol_expand
skills: coding-practices anti-ai-slop software-engineering-wisdom
---

# Code quality and static analysis

Quality tools are cheap reviewers that never get tired. They are only useful when their output is treated as evidence—read, triaged and acted on—rather than silenced or ignored. This chapter covers how to use them and the code smells they miss.

## Run the project's own checkers, not your preferences {#project-checkers}
<!-- terms: lint linter typecheck formatter config eslint ruff tsc mypy clippy project configured ci -->

**Principle.** Use the linters, type checkers and formatters the project already configures, with its settings, before claiming code is clean.

**Why.** A project's lint and type configuration encodes decisions its maintainers made; CI will enforce them. Code that passes a different tool's defaults may still fail CI, and reformatting with a different formatter produces noisy diffs. Discovering the configured commands (package scripts, Makefile targets, CI workflow steps, pre-commit hooks) and running them on changed files is fast and catches real bugs: unused variables, unsafe any, unreachable code, missing awaits.

**Signals.** Edits in a project with lint or type configuration and no checker run; formatting churn across untouched lines; CI failing on lint after "done".

**Ask.** Which lint and type commands does this project run in CI, and have they passed on the changed files?

**Traps.** Blanket disable comments to get green; fixing lint in unrelated files inside a feature change.

## Language-server diagnostics are free evidence {#lsp}
<!-- terms: lsp language server diagnostics hover definition references rename symbol type error warning editor -->

**Principle.** Use language-server and compiler diagnostics to confirm references, types and renames instead of trusting text search alone.

**Why.** Text search finds strings, not symbols: it misses aliased imports and dynamic references and matches comments and unrelated names. Language servers resolve definitions, references and types exactly, and their diagnostics flag errors immediately after an edit. For renames and signature changes, symbol-aware tools prevent the classic partial update where one caller still uses the old shape.

**Signals.** Renames or signature changes done with search-and-replace; type errors discovered only at the end; unresolved imports after moves.

**Ask.** Did symbol-aware diagnostics confirm every reference to what changed?

**Traps.** Treating a clean editor state as proof of runtime behavior.

## Duplicated knowledge must have one source {#dry}
<!-- terms: dry duplicate duplication duplicated copy paste clone redundant repeated logic same code twice single source -->

**Principle.** DRY is about knowledge, not text: every business rule, constant, validation or algorithm should have one authoritative implementation; similar-looking code with different reasons to change may stay separate.

**Why.** Copy-pasted logic diverges: a bug fixed in one copy survives in the others, and a rule changed in one place is silently old elsewhere. Clone detection (token or AST similarity) finds candidates, but judgment decides: two blocks encoding the same rule must be unified; two blocks that coincidentally look alike but serve different concepts should not be forced together (that creates the wrong abstraction). New code that re-implements an existing helper is the most common agent duplication.

**Signals.** New functions similar to existing ones; the same constant or regex in several files; blocks pasted with small edits.

**Ask.** Does this change re-implement something the codebase already has, or copy a rule that must stay identical elsewhere?

**Traps.** Merging coincidental similarity into a flag-driven abstraction; DRYing test code into unreadability.

## Complexity is a budget, measure it {#complexity}
<!-- terms: complexity cyclomatic cognitive nesting long function parameters branches metrics maintainability -->

**Principle.** Keep functions within a complexity budget—branches, nesting, parameters, length—and treat growth past it as a design signal, not a style nit.

**Why.** Complexity metrics correlate with defect density because each branch is a path that must be understood and tested. A function that accumulates conditions release after release eventually cannot be changed safely. Measuring complexity on changed functions makes growth visible in review, and the usual fixes (guard clauses, extracting decisions, lookup tables, polymorphism) are well known.

**Signals.** Functions gaining new branches with each change; switch statements over types in many places; boolean parameters multiplying.

**Ask.** Did this change push a function past a size or branching level where it should be split?

**Traps.** Splitting to satisfy a metric while making logic harder to follow.

## Recognize generated-looking slop {#slop}
<!-- terms: slop ai generated boilerplate verbose redundant comments placeholder todo filler generic defensive over-engineered -->

**Principle.** Reject code that has the texture of generation without thought: redundant comments, defensive checks for impossible cases, speculative options, placeholder TODOs and needless wrappers.

**Why.** Generated code often looks thorough while adding noise: comments restating each line, try/catch around code that cannot throw, parameters nobody passes, abstractions with one caller, logging on every step, "TODO: implement" stubs left behind. Each item costs reviewers attention and hides the real logic. Matching the surrounding code's density and idioms, and deleting what the change does not need, is the antidote.

**Signals.** Comment density far above the surrounding code; unused parameters or options; stubbed functions; repeated try/catch-log-rethrow blocks.

**Ask.** Which lines in this diff would a careful human author delete as noise?

**Traps.** Stripping comments that explain genuinely non-obvious decisions.

## Warnings are defects waiting to happen {#warnings}
<!-- terms: warning warnings deprecation deprecated compiler notice suppress ignore noqa eslint-disable -->

**Principle.** Treat new warnings and deprecations as work items; suppressions need a reason and a scope as narrow as one line.

**Why.** Warning noise hides the one warning that matters. Deprecations become breakages at the next upgrade. Suppression comments without justification accumulate until nobody knows which are safe. A clean baseline makes every new warning visible, which is the whole value of having warnings.

**Signals.** New warnings in build output; broad disable comments added; deprecation notices ignored during upgrades.

**Ask.** Did this change add warnings or suppressions, and is each one justified?

**Traps.** Fixing warnings in code outside the change's scope without being asked.
