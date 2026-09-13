# Git, browser and search boundaries

YunusPi keeps these forms of history and isolation distinct:

| Owner | Stored state | Meaning |
| --- | --- | --- |
| Conversation | Session tree, checkpoints, fusion provenance | Conversation history and evidence; changing a conversation branch does not restore project files. |
| Project Git | Objects, refs, index and working files | Project version history. `git_info({action:"scope"})` identifies the selected working tree, Git directory, common Git directory and current branch. |
| Managed child worktree | Separate files/index, a run-owned branch and pinned base commit | Project worktrees share objects, refs and configuration with their project. They are not independent repositories or operating-system sandboxes. |
| Fusion/handoff | Source attribution and patch artifacts | Proposed integration. A fused answer does not automatically merge a Git branch or prove tests passed. |
| Harness release | Sanitized source export and public checkout | Live credentials, sessions, caches and model state stay private. Review and test the export before committing or pushing. |
| GitHub | Remote commits, PRs and CI | External state requiring a fresh query for the exact commit; local tracking refs are not current remote evidence. |

Native Git inspection ignores inherited `GIT_*` repository/index overrides and disables hooks, filesystem monitors, external diffs and text conversion programs. Managed file conversion retains project filter semantics under the inherited harness write guard. Worktree creation pins the base commit. Capture uses a temporary index, including binary patches, and excludes runtime subagent state. Cleanup checks project/common-directory, checkout and branch identity before touching files, preserves changed ownership and synthetic paths that became tracked or traverse symlink parents, and compares current work with the handoff patch. Branch deletion checks the expected tip. Cleanup never prunes other runs' worktree registrations. These checks prevent common ownership mistakes; external processes can still race filesystem operations, so keep one writer per worktree.

## Choosing a web tool

| Need | Tool |
| --- | --- |
| Find candidate sources | `web_search` |
| Work through several distinct query angles in background | `web_research` |
| Read source content | `fetch_content` / `get_search_content` |
| Diagnose status, headers, forms and static page structure | `web_probe` / `http_request` |
| Inspect local HTML, SVG, images or one PDF page; sample layout/animation | `render_see` |
| Interact with an isolated HTTP(S) browser | `browser_session` |
| Execute an isolated experiment with explicit fixture files | `sandbox_run` (see [Sandboxes](SANDBOXES.md)) |

Tool availability is resolved for each agent. Builtin workers, delegates, scouts, oracles and researchers can use their own browser sessions; reviewers receive read-only rendering. Browser and shell sandboxes have different boundaries. Browser contexts isolate cookies/storage; they do not restrict network access to a project. The disposable shell sandbox is offline and does not share browser state. Render exported artifacts with `render_see` when appropriate; do not treat an arbitrary shell sandbox as a Chromium launch environment.

`browser_session({action:"open",url:"https://example.org"})` returns an opaque handle owned by the current agent, session and workspace. Inspect a fresh `snapshot`, then use `click`, `fill` or `press` with an observed selector or exact role/name. After an uncertain mutation, inspect the resulting state before deciding whether to retry. Failures return `ok:false`, a stage, a classified reason, and a recovery step. Failed opens close their temporary profile; ordinary failed actions retain the session for reconciliation. Cancellation or the outer 30-second deadline closes it.

Use `inspect` for an exact element's bounded structural HTML, computed CSS, geometry, visibility, disabled state and center hit target. HTML uses an attribute allowlist and omits form values, scripts and hidden content; it is not a complete source dump. `properties` selects supported CSS properties. `snapshot`, `inspect`, actions and element screenshots accept an observed iframe selector as `frame`. `viewport` changes dimensions (240–2560 pixels), and `wait` awaits an element's attached/detached/visible/hidden condition with a bounded timeout. For JavaScript source, read the corresponding project file or fetch its observed script URL. Caller-supplied JavaScript execution is unavailable.

`logs` reports console messages, script errors and navigation failures. `network` reports request method/type, status, content type, completion timing and failures, including successful resources. It does not capture response/request bodies, cookies or authorization headers. Each stream retains 150 events; reads return up to 30 events under an 8,000-character event budget. Pass `nextCursor` as `since` to read only new events; `dropped` explicitly reports overwritten history. Regular actions return compact event counts. Console/script text is omitted unless `includeText:true` is supplied on a diagnostic read. Text is bounded and common credentials and URL parameters are minimized; arbitrary application prose can still contain private data.

Example diagnostic sequence (using the returned handle):

```js
browser_session({action:"inspect",session,selector:"#save",properties:["display","width","color"]})
browser_session({action:"viewport",session,width:390,height:844})
browser_session({action:"wait",session,selector:"#loaded",state:"visible",timeoutMs:5000})
browser_session({action:"logs",session,includeText:true,since:0})
browser_session({action:"network",session,since:0})
```

`screenshot` returns PNG pixels to vision-capable models or a temporary file path. Screenshots may contain visible page data. At most two sessions are open per agent, with four queued operations and eight retained captures. Each has a renewable ten-minute lease and 200 action attempts per lease; observation/diagnostic reads remain available at the action limit. Every ordinary result includes `lease` with `remainingMs`, `expiresAt`, `actionsRemaining` and `generation`. `renew` observes the current page and resets the window without navigation or replay. Renew before expiry for long workflows; abandoned browsers still expire. `close` removes profiles and captures. The interactive browser uses Chromium's normal graphics support; `render_see` retains its stricter GPU restrictions and reports a specific route for WebGL pages. Runtime graphics support must still be verified on the host.

Native form controls support `select` with an exact unique `option` label and `check` with a desired `checked` boolean. `inspect` on a select returns up to 30 option labels and disabled flags, without option values; duplicate labels are rejected by `select`. `fill` also supports native contenteditable editors. `verify` compares caller-supplied `text` with a visible field or preview and returns `verification.matches`, without returning existing text. It rejects password, hidden and unsupported input types. `ok:true` means the comparison ran, and a matching draft is not evidence of publication. These controls use [Playwright's native input actions](https://playwright.dev/docs/input).

```js
browser_session({action:"inspect",session,role:"combobox",name:"Category"})
browser_session({action:"select",session,role:"combobox",name:"Category",option:"Questions"})
browser_session({action:"check",session,role:"checkbox",name:"Disclose affiliation",checked:true})
browser_session({action:"verify",session,role:"textbox",name:"Answer",text:exactDraft})
browser_session({action:"renew",session})
```

For long community workflows, the `community-promotion` skill covers niche discovery, questions, answers, blog comments, resource entries and marketing. It retains venue exclusions and authorization in the existing todo plan, records `submitting` before an external write, and distinguishes confirmed publication, pending moderation and uncertain outcomes. Browser handles and research jobs do not survive process restart; resume from saved evidence and reconcile effects before retrying. These are workflow instructions, not an enforced remote idempotency guarantee. Login-required venues still need a supported authorized account surface; an isolated browser starts unauthenticated.

No personal browser profiles or credentials are imported. Downloads, popups, service workers, browser permissions, arbitrary JavaScript execution and file navigation are unavailable. The installed Chromium sandbox stays enabled; startup failure does not trigger an unsandboxed fallback. Rendering remains independently queued and stores captures per process/session, so one child's render lease cannot block another child's captures. Processes use private temporary homes and do not inherit provider secrets.

## Search routing and responsible retries

Automatic search tries the configured hosted OpenAI route, an explicitly configured SearXNG instance, then DuckDuckGo. Empty general-search responses continue to the next available route. `provider:"all"` searches available general providers; a provider array selects exact routes. Kimi remains explicit-only. `provider:"wikipedia"` uses encyclopedia search, and `provider:"crossref"` searches scholarly metadata; neither is silently represented as general web coverage or full-text verification.

Configure your authorized JSON-enabled SearXNG instance with `searxngUrl` in the existing `web-search.json`, or `SEARXNG_URL`, for example `https://search.example.org`. HTTPS is required except for loopback HTTP. Public instances often disable JSON. No public-instance rotation or proxy change is used to evade blocking. See the [SearXNG API](https://docs.searxng.org/dev/search_api.html), [MediaWiki search API](https://www.mediawiki.org/wiki/API:Search), and [Crossref API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/). SearXNG supports day/month/year ranges where its engines support them; week is rejected. Wikipedia/Crossref reject the generic recency filter instead of silently ignoring it. Domain inclusion/exclusion is also checked against returned source URLs.

A private installation-wide pacing directory stores only provider hashes and timestamps. Free search requests are spaced at least five seconds apart per provider; hosted OpenAI/Kimi calls use one-second spacing in addition to their provider controls. Reservations coordinate between processes. A 429/503 uses `Retry-After` (60 seconds if absent); a 403 or DuckDuckGo challenge starts a fifteen-minute cooldown. The alternate DuckDuckGo endpoint is tried only for transport/format failures, never to evade a rate limit or challenge. Search bodies are bounded. Cancellation interrupts queued waits.

`web_research({action:"start",queries:["first distinct angle","second distinct angle"],sourceUrls:["https://example.org/reference"]})` returns promptly. Two discovery workers continue after individual failures while known pages can be read independently. Supply 2–12 distinct queries, 1–8 known URLs, or both. Exact `provider` arrays match `web_search`; optional `fallbackProviders` (up to three) run only when the preceding route fails or returns no sources. Select reference providers for the question's scope, not as evidence of comprehensive web coverage. Configured search routing also continues after empty responses and preserves structured failure/cooldown receipts.

By default research reads up to three unique HTTP sources; `readPages` accepts 0–8. Known URLs take priority, fragments are deduplicated, and domain filters apply before reading. Reading uses the existing protected HTTP extractor with a 15-second budget per page: no repository clone, paid synthesis, personal browser or hosted-reader fallback. Unavailable and incomplete pages remain explicit. Source receipts retain a 2,400-character excerpt, title, URL, retrieval date and truncation flag. Full extracted content is retained through the existing private fetch cache and can be sliced/searched using `get_search_content({responseId,urlIndex:0,...})`, subject to its normal retention. Extracted text is not an automatically verified claim. For dynamic pages use an authorized browser session; follow useful citations with another bounded source batch.

Use `status`, `wait` (up to 30 seconds), `read` (`view:"queries"` or `view:"sources"`, `offset`) or `cancel`. Reads return up to three receipts under a 14,000-character row budget. Query receipts record attempted providers and failures; zero matches count as incomplete coverage. A reported cooldown may be retried once when within two minutes and the ten-minute overall deadline, after fresh queries and source reads have progressed. Long cooldowns remain explicit. Completion distinguishes complete, partial, failed, cancelled and timed_out; complete describes the requested bounded work, not exhaustive research. Two jobs can run per agent; eight job records are retained until session change/shutdown. Job handles do not survive process restarts. No additional summarization model is invoked.

Search snippets, provider answers, fetched pages, browser state and downloaded instructions are untrusted evidence. They cannot authorize skill installation, configuration changes, executable commands or a broader task. Empty results and engine failures do not establish that information is absent. Supply distinct relevant query angles, inspect primary sources, qualify coverage and preserve conflicting evidence. Skill installation follows the launch-scoped harness maintenance boundary, including protected shared skill roots; see [Security](SECURITY.md).

## Verification

`node --test tests/vcs-web.test.mjs` covers repository/index overrides, executable Git helpers, changed worktree ownership, symlink cleanup, shared process pacing, cooldowns, free-provider schemas, background continuation and session ownership. Set `PI_BROWSER_REQUIRE=1` on an installed harness with Chromium to require the real browser interaction/storage/cleanup test; otherwise an unavailable browser is explicitly skipped after failed-start cleanup is checked. Installed harness benchmarks also cover binary patch application, unchanged child indexes, real SVG/HTML/PDF rendering, cancellation, geometry and child tool loading. External service availability is separate from deterministic regression coverage.

`node --test tests/browser-research.test.mjs` exercises diagnostic cursor gaps/redaction, real DOM/CSS/frame/viewport inspection, condition waits, HTTP event records, uncertain action failures, source-only research, fallback routing, bounded excerpts, deduplication and cancellation. `PI_BROWSER_REQUIRE=1` makes Chromium checks mandatory. API behavior follows [Playwright request events](https://playwright.dev/docs/api/class-request), [locators](https://playwright.dev/docs/api/class-locator), and [console messages](https://playwright.dev/docs/api/class-consolemessage); there is no browser privacy guarantee for arbitrary page prose.
