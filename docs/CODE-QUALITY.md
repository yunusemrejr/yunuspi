# Code quality tools

YunusPi measures duplication, code "slop", prose quality and complexity with local, dependency-free tools, and reviews a change before it is committed. Nothing is installed, no project code runs and no model is called. Findings are evidence with `file:line`, not a score: intentional repetition, data tables, tests and deliberate style are allowed.

## `code_quality`

| Operation | What it reports |
| --- | --- |
| `duplicates` | Token clones across files or a whole tree. `mode:"renamed"` (default) also catches copies that differ only in identifiers and literals; `exact` requires identical text. Clones are grouped into classes, overlapping copies of one repetitive pattern are merged into regions, and declarative data (type fields, option tables) and periodic lists are ignored because only code with logic is worth extracting. `changed:true` indexes the scope but reports only clones touching files changed against `base` (default `HEAD`) plus untracked files: a DRY check for a branch. |
| `slop` | Elided or placeholder code (`// ... rest of the code`, `TODO: implement`, `throw new Error("Not implemented")`), debug leftovers outside tests, scripts and entry points, swallowed errors (catch or except blocks that only log or pass), bare `except:`, loose boolean comparisons and boolean ternaries, commented-out code, double null checks, TypeScript `any` and `@ts-ignore`, emoji in log output, repeated long literals and unused imports (JS/TS and Python, token based, counting template and f-string interpolations). |
| `prose` | Stock AI-sounding phrases with plain replacements ("leverage" → use, "delve into" → explore, "in today's fast-paced world" → cut), boilerplate headings, emoji bullets, rule-of-three overuse, repeated sentence openers, dash density, long sentences, Flesch reading ease and grade, passive voice share and hedge and filler rates. Code blocks, inline code, URLs and front matter are skipped. |
| `complexity` | Per-function cyclomatic complexity, length, nesting and parameters for JavaScript, TypeScript and Python (tree-sitter), with `async` functions that never await. Thresholds (12, 80 lines, nesting 4, five parameters) mark candidates for splitting. |

Scans stay inside the workspace, skip `node_modules`, build output, vendored and minified or generated files, never follow symlinks and stop at 1,500 files or 24 MB.

## Automatic hints after edits

After a successful `write` or `edit`, the existing syntax hook adds one short advisory when the changed span contains a high-precision pattern (placeholder or elided code, debug statements, swallowed errors, commented-out code, redundant booleans) or when the new block repeats code in the same directory or in files edited earlier in the session ("L40-58 repeats src/cart.js:1-9 (9 lines, renamed; differs in subtotal→sum): reuse or extract it"). At most six checks run per request and each file revision is checked once.

## `git_info` review and blame

`git_info` gains two read-only actions:

- `review` summarizes the working tree (or `staged`, or a `revision`): files by kind, the largest changes, risk flags from added lines (possible secrets, conflict markers, focused tests such as `it.only`, debug statements, `.env` files, edits to generated or vendored paths, dependency manifests changed without their lockfile, binaries, source changed without tests), `git diff --check` whitespace errors and a draft conventional-commit header to rewrite from the real intent.
- `blame` summarizes which commits last touched a line range (`range:"40,80"`), with dates, authors and subjects.

## Language servers and linters

The pi-lens tools remain the source for type-aware diagnostics (`lsp_diagnostics`, `lens_diagnostics`), symbol navigation and project-configured linters and formatters. Prefer the project's own checkers when they exist; `code_quality` covers what they usually do not: duplication across files, generated-looking patterns and prose.
