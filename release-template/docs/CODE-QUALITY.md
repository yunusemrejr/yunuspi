# Code quality tools

YunusPi measures duplication, code slop, reader prose and complexity locally. Nothing is installed and no project code runs. Findings carry `file:line`; intentional repetition, technical wording and deliberate style remain valid. Optional semantic triage adds context to ambiguous prose cues without removing local findings.

## `code_quality`

| Operation | What it reports |
| --- | --- |
| `duplicates` | Token clones across files or a whole tree. `mode:"renamed"` (default) also catches copies that differ only in identifiers and literals; `exact` requires identical text. Clones are grouped into classes, overlapping copies of one repetitive pattern are merged into regions, and declarative data (type fields, option tables) and periodic lists are ignored because only code with logic is worth extracting. `changed:true` indexes the scope but reports only clones touching files changed against `base` (default `HEAD`) plus untracked files: a DRY check for a branch. |
| `slop` | Elided or placeholder code (`// ... rest of the code`, `TODO: implement`, `throw new Error("Not implemented")`), debug leftovers outside tests, scripts and entry points, swallowed errors (catch or except blocks that only log or pass), bare `except:`, loose boolean comparisons and boolean ternaries, commented-out code, double null checks, TypeScript `any` and `@ts-ignore`, emoji in log output, repeated long literals and unused imports (JS/TS and Python, token based, counting template and f-string interpolations). |
| `prose` | Reader copy, including short headings and slogans: stock phrases, generic headings, repeated sentence openings, long sentences and unsupported metric cues. Customer/team nouns alone are not a measurement basis; citations and measurement details are cues to inspect, not verified evidence. English readability is approximate. Technical uses such as robust standard errors and matrix leverage are preserved. Code fences (backticks or tildes), indented/inline code, block quotes, front matter, scripts, styles, templates and pre/code HTML are excluded with source line positions retained. |
| `complexity` | Per-function cyclomatic complexity, length, nesting and parameters for JavaScript, TypeScript and Python (tree-sitter), with `async` functions that never await. Thresholds (12, 80 lines, nesting 4, five parameters) mark candidates for splitting. |
| `structure` | Import-graph health across a tree (JS/TS relative imports, Python packages): runtime import cycles (type-only imports are ignored), modules nothing imports (entry points, tests, scripts and configs are exempt), the most imported and most importing files, files over 600 lines, and, for a whole-workspace scan, packages imported but not declared in `package.json` or declared but never imported. It needs the whole graph, so `changed` does not narrow it. Aliases and dynamic paths are not resolved, so orphans and unused packages are candidates to check, not proof. |

Scans stay inside the workspace, skip `node_modules`, build output, vendored and minified or generated files, never follow symlinks and stop at 1,500 files or 24 MB.

Default `view:"compact"` omits repeated excerpts and secondary counters; `view:"detailed"` includes bounded measurements. Prose results show observed finding totals, emitted findings and omitted files. Only `complexity` loads tree-sitter.

When `PI_JEV` is enabled, ambiguous prose findings may receive one cached Jev/Kev context request: at most eight excerpts, 8,000 excerpt characters and a four-second caller deadline. `semantic:false` keeps the check local. `direction` supplies reader/voice requirements; `protectedPaths` excludes private files or directories. Credential-like values, private path classes and protected/confidential source markers withhold the whole source from remote triage. These pattern checks cannot establish that arbitrary text is public. Disabled, offline, invalid or cancelled judges retain local findings. Choices and probabilities are advisory, uncalibrated context; they cannot prove correctness, evidence or permission. Ordinary code/no-op checks make no judge request. Automatic edit hints remain local.

## Static SEO checks

`web_probe({url,seo:true})` checks fetched HTML and robots.txt with a compact default; `view:"detailed"` adds the page map. It reports HTTP errors, title/description duplication, HTML and HTTP-header canonical targets and conflicts, effective Googlebot noindex, hreflang syntax/duplicates, heading outline, image alt and JSON-LD parsing/shape. Character counts are review cues, canonical is a consolidation signal and multiple h1 elements are outline advice. No result proves indexing, rankings, canonical-target validity, reciprocal locale links, rich-result eligibility or rendered content. Robots.txt 429/5xx, network failures and partial files return an unknown crawl verdict; crawler cache/history is not observable here.

These interpretations follow [Google's canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [title guidance](https://developers.google.com/search/docs/appearance/title-link), [robots meta specification](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) and [robots.txt error behavior](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec).

## Automatic hints after edits

After a successful `write` or `edit`, the existing syntax hook adds one short advisory when the changed span contains a high-precision pattern (placeholder or elided code, debug statements, swallowed errors, commented-out code, redundant booleans) or when the new block repeats code in the same directory or in files edited earlier in the session ("L40-58 repeats src/cart.js:1-9 (9 lines, renamed; differs in subtotal→sum): reuse or extract it"). Batched `edit` calls are checked in each of their changed spans. At most 24 checks run per request (a local WASM parse takes about 20 ms), and each file revision is checked once.

## `git_info` review and blame

`git_info` gains two read-only actions:

- `review` summarizes the working tree (or `staged`, or a `revision`): files by kind, the largest changes, risk flags from added lines (possible secrets, conflict markers, focused tests such as `it.only`, debug statements, `.env` files, edits to generated or vendored paths, dependency manifests changed without their lockfile, binaries, source changed without tests), `git diff --check` whitespace errors and a draft conventional-commit header to rewrite from the real intent.
- `blame` summarizes which commits last touched a line range (`range:"40,80"`), with dates, authors and subjects.

## Commit guard

When an agent runs `git commit` through bash, the staged changes (or tracked changes for `commit -a`) are reviewed first. A secret-like string (private keys, cloud and platform tokens, JSON web tokens, credential assignments) or a conflict marker stops the commit with the flagged files; in an interactive session you are asked instead and can allow it. Other review flags never block. `PI_COMMIT_SECRET_GUARD=off` disables the guard. Patterns can be false positives, and a passing guard does not prove a commit is free of secrets.

## Language servers and linters

The pi-lens tools remain the source for type-aware diagnostics (`lsp_diagnostics`, `lens_diagnostics`), symbol navigation and project-configured linters and formatters. Prefer the project's own checkers when they exist; `code_quality` covers what they usually do not: duplication across files, generated-looking patterns and prose.
