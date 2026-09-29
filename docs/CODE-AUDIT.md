# Static audits: `code_audit` and `svg_inspect review`

Two read-only checks that find the defects a careful reviewer would raise, from source text alone: `code_audit` for source files and the `review` action of `svg_inspect` for SVG. Nothing runs, nothing is installed, no model is called, so they cost no tokens beyond their (compact) results. The same rules also run **automatically** after every `write` or `edit`, so an agent that never asks for an audit still hears about a SQL injection or a clipped icon on the edit that introduced it.

## `code_audit`

Domains (default all):

| Domain | Looks for |
| --- | --- |
| `security` | Provider-format credentials and secret-named literals, `eval`/`new Function`, shell commands built from values, SQL built from values (JS, Python, Go), HTML sinks (`innerHTML`, `document.write`, `dangerouslySetInnerHTML`, `v-html`), unsafe deserialization (`pickle`, `yaml.load`), disabled TLS verification, `Math.random`/`random` for tokens, MD5/SHA-1/`createCipher`, CORS with credentials, cookie flags, JWT `none` and ignored expiry, path traversal, open redirects, SSRF, `curl \| sh` |
| `backend` | Whole request body written to a model, stack traces sent to clients, credentials in log calls, outbound HTTP without timeouts, unbounded Go request bodies, async Express 4 handlers without `try`/`next`, synchronous I/O in request handlers, blocking calls inside `async def`, a database client per request, queries inside loops (N+1), `defer` in loops |
| `efficiency` | `reduce` with spread (quadratic), constant `RegExp` in loops, synchronous I/O in loops, non-passive scroll listeners, pandas `iterrows`, `transition: all`, remote CSS `@import`, render-blocking scripts in `<head>` |
| `patterns` | Thrown strings, mutable default arguments, bare `except`, `is` against literals, `open` without `with`, promise-constructor wrapping, catch-and-rethrow, JSON deep clones, boolean traps, nested ternaries, index keys, `var`, shell without `set -e` |
| `ui` | Missing `alt`, blocked zoom, removed focus outlines, positive `tabindex`, click handlers on non-interactive elements, missing `lang`/viewport, autoplay with sound, text under 12px, `100vh`, plus the design-slop cues from the `design-slop-prevention` doctrine |

Scope is explicit paths, the whole workspace, or `changed: true` (files changed against `base` plus untracked). Results carry `at: file:line`, severity, rule id and the offending line; each rule's message and fix are listed once under `rules`. Test, fixture, example, script and vendored paths are skipped, except for provider-format credentials, which are reported everywhere.

These are cues, not verdicts: there is no data-flow analysis, so trusted input and admin scripts will occasionally trigger them. No findings does not mean secure or fast.

## `svg_inspect` review

`svg_inspect` measures SVG geometry (viewBox, bounds, strokes, ids, transforms, set consistency; `action: "inspect"`) and rasterizes size matrices (`"matrix"`). `action: "review"` adds a verdict on top of those measurements for one to 24 files: a 0 to 100 score (`ship`, `fix-first`, `rework`) and findings such as:

- **Geometry**: art outside the `viewBox` (clipped), strokes that reach past the edge, no safe margin, off-centre icons, no `viewBox` on a fixed-size root, stretchy `preserveAspectRatio`.
- **Theming**: hard-coded colours on an icon where `currentColor` belongs, implicit black fills, `userSpaceOnUse` gradients that shift on resize.
- **Weight**: node bloat, over-traced paths, circles and rectangles drawn as paths, embedded base64 rasters, live text that depends on installed fonts, filter and animation cost.
- **Safety and structure**: script, `foreignObject`, event handlers, external references, duplicate ids and broken references.
- **Accessibility**: missing accessible name, SMIL without a reduced-motion path.

`optimize: true` writes a cleaned copy per file into a fresh git-ignored folder: prolog, comments, editor metadata (Inkscape, Sketch, Illustrator), unused gradient, filter and mask definitions, empty groups, default attributes, auto-generated ids nothing references, and compact path data at `precision` decimals (default 3). A copy is written only after the measurements agree: the same paths, nodes and element counts, and the same art bounds. The original file is never modified; look at the copy, then copy it over. Icon-set consistency (grid, stroke width, caps, corners, mass, centre, padding) is the set review of `inspect` with two or more paths.

Review is from source only: it cannot see overlap, optical weight or whether the metaphor reads. Render the SVG (`render_see`, or the `matrix` action) at its real sizes before shipping.

## Automatic use

- After a `write` or `edit`, `source-check` runs the security, backend, efficiency and UI-source rules on the changed span and appends at most two findings (medium and above) to the edit result, once per finding per session. A high-severity cue also suggests `code_audit({changed: true})`.
- After a `.svg` write, `small-tools` appends up to two high or medium review findings to the existing `svg-check` note.
- `code_audit` is staged for the first model turn when a request mentions security, vulnerabilities, backends, APIs, endpoints, authentication, N+1, performance audits or coding patterns, and `svg_inspect` when it mentions SVGs, icons or vector logos; everything else finds them through `tool_search`.
- Security and backend cues found in an edit promote the review aspects (`security`, `runtime`) that `quality_review` runs.

See [CODE-QUALITY.md](CODE-QUALITY.md) for duplication, slop, prose, complexity and import-graph measurements, and the `svg-assessment` skill for the human checklist behind the SVG rules.
