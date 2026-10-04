# Comparison rubric and search recipes

## Shared signals

`research_toolkit` profile (local) and `github_search` repo (remote) report the same keys, so two projects compare line by line.

| Signal | Local profile | Remote fact sheet | Read it as |
| --- | --- | --- | --- |
| languages | by recognised source files | by bytes | stack fit and effort to adopt an idea |
| license | manifest or LICENSE text | SPDX id | whether code can be borrowed at all |
| tests, ci, docs, changelog, contributing, container, examples | root entries | root entries | maturity and how seriously it is maintained |
| latest release / tag | newest tag | latest release | cadence; a year of silence is a signal |
| health | n/a | active (30d), maintained (180d), slow (540d), stale, archived | whether to depend on or just learn from it |
| capability headings / README digest | README headings | README digest | what it claims to do; verify the load-bearing claims |
| open issues, stars, forks | n/a | counts | attention and pressure, not quality |

## Scoring a candidate improvement

Score each from 1 to 5, then keep the top few. Do not average across unrelated dimensions; reject first on risk or fit.

| Dimension | 1 | 5 |
| --- | --- | --- |
| User value | nobody asked for it | many users ask, or it removes a real failure |
| Evidence | one README claim | several independent sources, code or issues confirm it |
| Effort | a large rewrite | a small change in the existing owner |
| Risk | breaks contracts, adds a heavy dependency or a license problem | local, reversible, covered by tests |
| Fit | fights our architecture | extends what we already have |

Verdicts: adopt (use as is, license permitting), adapt (reimplement the idea in our owners), reject (state why), watch (revisit when it matures).

## Memo template

1. Answer in two or three sentences: what to build or change, and what not to.
2. Decisions: candidate, verdict, one-line reason, effort, source.
3. Evidence: per source the URL, license, version or date read, and the quote or fact relied on.
4. What we already do better or equal, so it is not rebuilt.
5. Open questions and what would change the answer.

## GitHub search recipes

- Repositories: plain words for the problem, then `topic:` for precision, `language:`, `stars:>=100`, `pushed:>=YYYY-MM-DD`, `license:mit`. Long phrases match nothing because every word must match; use two or three distinctive words, or several angles.
- Issues: `github_search` `action:"issues"` with `repo:"owner/name"`, `sort:"reactions"`, `type:"issue"`; labels such as enhancement or feature-request mark requests.
- Code: `action:"code"` needs `GITHUB_TOKEN`; without one, search the web with `site:github.com` and a distinctive identifier, then read the file with `fetch_content`.
- Rate limits: anonymous search allows 10 calls per minute and the core API 60 per hour; a token raises them. A repo fact sheet costs five calls (two with `depth:"brief"`), so shortlist before drilling in.

## Web recipes

- `<problem> alternatives`, `<product> vs <product>`, `<product> limitations`, `<product> complaints`, `awesome <topic>`.
- Product truth lives on pricing, docs and changelog pages; reviews and forum threads show real friction. Prefer the vendor's own docs for what a product does and independent sources for how well.
