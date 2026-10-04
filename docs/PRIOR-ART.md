# Prior-art scouting

Building or improving something without looking at how others solved the same problem repeats solved work and misses what users already ask for. YunusPi does that look by itself when a task calls for it, with no reminder from the user, and keeps it bounded so ordinary work pays nothing.

## What happens

1. **The prompt is classified** (`lib/prior-art.ts`, pure and I/O-free) into one of three modes, or none:
   - `compare`: an explicit request to compare with, learn from or search for other products, competitors, alternatives or similar projects.
   - `improve`: an open-ended improvement of a product-level subject ("make the app much better, what is missing"), not a named defect.
   - `build`: new software the user has not specified exactly ("build me a terminal notes app with sync").
2. **The Expert Director adds one advisory paragraph** to the brief, naming the workflow for that mode and the `prior-art-scouting` skill. It is added even when no excellence domain qualifies, and it is shown in the Director's summary line (`Expert brief: … · prior art (build)`).
3. **The scouting tools are staged with the first turn** (`github_search`, `web_research`, `fetch_content`, `research_toolkit`), so the agent does not have to discover them.
4. **The Observer book carries a passage** (`research › Look at what already exists`) so a reviewer can notice a new product designed without a look at alternatives.

The agent then follows [the skill](../agent/skills/prior-art-scouting/SKILL.md): profile the local project (`research_toolkit` `action:"profile"`), search GitHub from two or three angles, read the best candidates' fact sheets and their issues sorted by reactions, run `web_research` in the background for closed-source products, compare like with like, and record an adopt, adapt, reject or watch verdict for each candidate with source and license. One pass, about ten sources.

## What never triggers it

Bug fixes, reviews and operations (by task type); trivial and narrow edits (typos, renames, a named function, "make sure", refactors and de-duplication); questions; media production without a software deliverable; a long prompt that has already fixed the design (an explicit comparison must appear early in a long prompt); and any prompt that rules out the web, GitHub, research or competitors, or says to work offline.

## Calibration

The classifier was tuned on the installation's own history: 1,412 distinct user prompts. A first version qualified 13.6% of them, almost all maintenance requests ("make sure the reminders are robust"), which would have paid for scouting that nobody wanted. The shipped version qualifies 0.8% (11 prompts): open improvements of applications and the harness, one explicit look at a rival's version, and one new-application request. `tests/prior-art.test.mjs` pins the positive and negative cases, including the early-versus-late rule for long specifications.

## Tools

- [`github_search`](ISOLATION-AND-WEB.md#github-search): repositories, issues, code and one repository's fact sheet, without the `gh` CLI.
- `research_toolkit` `action:"plan"` with `mode:"prior-art"` returns web angles, two GitHub query angles, the order of work and a decision-record template; `action:"profile"` returns the local project's languages, declared scripts and dependencies, license, layout signals, latest tag and README headings, read-only and never reading environment files.

## Switches and reference providers

`PI_PRIOR_ART=off` (or `0`) makes the classifier return nothing, which removes both the Director paragraph and the first-turn tool staging; `PI_EXPERT=off` also removes the paragraph. The web angles of a prior-art plan run through `web_research` with `fallbackProviders:["hackernews","stackexchange","npm"]`: keyless official indexes (Hacker News via Algolia, Stack Overflow, the npm registry) that stay useful while general web search is cooling down. Measured on the installation's recorded sessions, 3 of 8 `web_search` calls failed completely, all through a single scraped provider hitting its cooldown, which is why a second, independent source of technical discovery matters.

## Limits

The classifier is lexical; it cannot know that a project is a clone of something famous. A directive is advice and the user's words win. GitHub's anonymous limits (10 searches per minute, 60 core calls per hour) bound how much can be read, and code search needs a token. README headings approximate what a project claims, not what it does. Licenses are the agent's responsibility to check before adapting anything.
