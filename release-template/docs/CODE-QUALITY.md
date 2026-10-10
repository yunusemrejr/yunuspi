# Code quality tools

YunusPi checks code quality locally: hints after each edit, the static audit and syntax steps of the goal completion check, git review and blame, a commit guard, and static SEO checks. Nothing is installed and no project code runs. Findings carry `file:line`; intentional repetition, technical wording and deliberate style remain valid.

The static audit and syntax check also run as steps of the goal completion check, on files changed since `HEAD`. See [goals](GOAL.md) for how they gate completion. The same check prints non-blocking source-quality advisories from the local baseline (duplicated blocks, flagged patterns, import cycles among the changed files); they inform the agent and never refuse completion.

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

The pi-lens tools remain the source for type-aware diagnostics (`lsp_diagnostics`, `lens_diagnostics`), symbol navigation and project-configured linters and formatters. Prefer the project's own checkers when they exist; the goal check's audit and syntax steps cover the files you changed.
