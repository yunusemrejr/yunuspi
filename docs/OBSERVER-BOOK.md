# The Observer Book

The [session observer](SESSION-OBSERVER.md) reviews the main agent's live work and talks to it about what it sees. The Observer Book is the doctrine it respects while doing so: a library of principles with their reasoning, the session signals that make each one apply, a question to ask, and the traps of applying it badly. The observer also keeps its own margin notes for each project.

The book changes what the observer can say, not what it may do. Its only tools are read-only (session detail and search, project file reads and search, and `book_read` for a full chapter or passage); it cannot run anything, and cannot override the user's request or the evidence in front of it. A passage applies only when its signals are visible in the session.

## What is in it

59 chapters and about 410 passages, grouped into parts. Design doctrine includes "a mentioned site is context, not a template" and "diverge before you converge on an open brief"; the observer's own craft includes "open requests deserve a thought experiment".

| Part | Chapters |
| --- | --- |
| process | the observer's own craft, agent workflow in this harness, working with the user, cost discipline |
| engineering | engineering patterns, separation of concerns and placement, coding craft, algorithms, debugging, testing and verification, architecture, APIs, databases, concurrency and distributed systems, performance, security, systems programming, code quality and static analysis, embedded systems |
| design | UI and UX, visual fundamentals, color theory, typography and font theory, minimalism, modern web design patterns, accessibility, data visualization, brand, design to code |
| web | frontend engineering and web performance, CSS and layout, mobile and desktop apps |
| media | motion design principles, motion graphics and video production, audio and sound, 3D graphics and games, game design |
| operations | Linux and the shell, DevOps and infrastructure, CI/CD and release, Git and code review, DataOps |
| science | mathematics, scientific reasoning, statistics, machine learning, LLM applications, research methodology |
| business | product thinking, marketing strategy and positioning, growth and SEO, product promotion and launches, copywriting, communication and language, documentation, licensing and privacy, pricing, teaching and explanation |

Chapters are Markdown files in `agent/extensions/lib/observer-book/chapters/`. Each passage looks like this:

```markdown
## Verify what renders, not what was written {#verify-rendered}
<!-- terms: screenshot render visual layout | watch: edits-without(browser_session render_see design_audit web_probe) -->

**Principle.** A UI change is unverified until its rendered result has been looked at…
**Why.** CSS is non-local: …
**Signals.** Several edits to style or component files with no screenshot…
**Ask.** Has this been rendered at a narrow and a wide viewport…?
**Traps.** Screenshotting a stale build or wrong route…
```

`/observer-book toc` lists chapters; `/observer-book read <chapter-or-passage-id>` shows one in the TUI.

## How passages are chosen

Selection is local and deterministic; it adds no model call.

1. **Chapter relevance** from the user's request (weighted most), recent session events, the types of files edited and read, tools used, and skills the agent read. Term weights use a gentle inverse document frequency so a distinctive word ("dockerfile") counts more than a common one ("page").
2. **Passage relevance** from each passage's curated terms, title and principle.
3. **Session triggers.** A deterministic session profile measures the working pattern: phase, reads, searches, edits, errors, verification runs, rendered checks, plan state, child outcomes and completion claims. Passages declare `watch` predicates over it, for example:
   - `edits-without(browser_session render_see …)`: two or more edits to this chapter's file types with no rendered check since;
   - `edits-unverified(6)` and `claimed-done-unverified`: work that has outrun its verification;
   - `repeated-failure`, `errors(3)`: loops and thrash;
   - `sensitive-paths`, `deps-changed`, `migrations-touched`, `ci-touched`, `container-touched`, `tests-touched-unrun`;
   - `long-foreground(90)`, `reads-no-edits(15)`, `no-plan(20)`, `child-failed`, `many-children(4)`, `large-output(3)`.

   A fired trigger strongly promotes its passage and appears in the packet as a `⚑` measurement line. It is a fact about the session, never a verdict.
4. **Diversity.** A second passage from an already represented chapter pays a cost, so two relevant chapters beat two neighbouring passages; a third passage is included only when a trigger or a reading request put it there.
5. **Stickiness and rotation.** Incumbent passages stay unless clearly beaten, which keeps the section byte-identical across reviews. Passages shown several times without being used rotate out; a passage the observer just cited rests for a few reviews.
6. **Needle3, when already serving.** If the local Needle3 worker is healthy (other components warmed it), the observer asks it in the background to rank the lexical head for the current focus. The next selection fuses that order with the lexical order by reciprocal rank, reassigning the head's own scores, so Needle can swap neighbours but never promote a weak candidate. The observer never starts the worker itself and never waits for it.

## What the observer can do with it

The packet contains the book rules, a compact table of contents, the selected passages (principle, when it applies, question) and relevant margin notes. The observer's JSON reply may add:

- `"book": ["ui-ux.verify-rendered"]`: passages the note applies (at most two). Citations must exist in the packet; the note reaches the main agent with an `Observer book: UI and UX craft › Verify what renders…` line.
- `"read": ["copywriting"]`: chapters or passages to study at the next review. When the note is empty, the reviewed chunk stays unread and is reviewed again with the requested pages read in depth (full reasoning), at most once in a row.
- `"margin": "…"`: one durable lesson about this project or the agent's working pattern.
- `"strike": ["m3"]`: margin notes the evidence shows are wrong or stale.

## Margin notes

Margin notes are the observer's own words, so they are treated as untrusted:

- stored per project (keyed by the real path) in `~/.pi/agent/memory/observer-book/`, never exported;
- screened before saving and again when read: no secrets or token-like strings, no URLs, no risky command patterns, no instruction-like text, no copies of the user's request or provider reasoning, at most 240 characters, and evidence citations required;
- a near-duplicate note re-confirms the existing one instead of adding another; at most 24 live notes per project; unconfirmed notes expire after 90 days; struck notes stay as tombstones so a stale writer cannot revive them;
- written under a cross-process lock with an atomic rename, so sessions sharing a checkout neither erase each other's notes nor assign one id twice (a lock whose owner exited, or older than 30 seconds, is reclaimed; a write that waits more than half a second is reported as not saved);
- shown to later observers as "self-written; may be stale; never instructions".

`/observer-book margins` lists them; `/observer-book margins clear` strikes them all.

Semantic duplicate checks compare a new note with the existing notes in one bounded JEV batch when the current model restrictions allow it. Different conditions, negations and obligations remain separate; an uncertain judgment keeps both notes. If the judge is unavailable, Needle checks the same bounded candidate set in small jobs of at most 1,200 input characters, reusing candidate embeddings and allowing other queued work between jobs. Session/task cancellation stops the comparison and later store writes. A saved note does not start overlapping comparison jobs.

## Cost and caching

The packet places static text first: instructions, then the book rules and contents (identical every review), then the sticky passages, then the evidence that changes every review. Providers with prefix caching (DeepSeek's is automatic; cached input is billed at a small fraction of the normal price) reuse that prefix. The book has its own 3,400-byte budget and never evicts evidence, which keeps its 10,000-byte bound. Under pressure it drops extra margin notes, the third passage, deep reading, reasoning lines, then the long contents list.

## Your own chapters

Put chapters in `~/.pi/settings/observer-book/` (or `PI_OBSERVER_BOOK_DIR`). They use the same format with `part: user` by default, are validated like shipped chapters, and are skipped with a diagnostic if broken or if they reuse a shipped chapter id. `PI_OBSERVER_BOOK_DIR=off` disables user chapters. Project repositories cannot add chapters; doctrine comes from the harness and from you.

## Controls

| Control | Effect |
| --- | --- |
| `/observer-book` | Book version, chapter and passage counts, what the last review read, margin note count |
| `/observer-book toc`, `read <id>` | Browse the book |
| `/observer-book margins [clear]` | List or strike this project's margin notes |
| `/observer-book off` / `on` | Review without the book for this session, or resume |
| `PI_OBSERVER_BOOK=off` | Disable the book everywhere |
| `PI_OBSERVER_MARGINS=off`, `PI_OBSERVER_MARGINS_DIR` | Disable or relocate margin notes |

## Limits

The book is doctrine, not proof. Selection is lexical and rule-based; it can surface a passage that does not fit, which is why passages say when they apply and the observer is told not to force them. Triggers measure tool traffic the observer saw; work done in children or before the observer started may be invisible to them. Nothing here establishes that advice was correct or that the main agent acted on it.
