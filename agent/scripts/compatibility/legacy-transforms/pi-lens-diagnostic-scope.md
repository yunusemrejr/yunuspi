# pi-lens diagnostic scope — 01a072

## Confirmed root cause

The recorded gumroad-promo-workspace session contains successful bash results
(`isError:false`) with appended `STOP — 9 issue(s) must be fixed` for CDN XML
saved as JavaScript, and `STOP — 10 issue(s) must be fixed` for DDG challenge
HTML. These were coercive tool-result additions, not failed downloads or Pi
execution rejection.

In the installed local fork `extensions/pi-lens/dist/index.js`:

- `handleToolResult` recovers command/disk mutations and synthesizes `write`
  events. Those events previously entered the authored-source pipeline,
  modified-range tracking, deferred formatting, and repair caches regardless
  of authorship. Filename-based file-role detection did not identify these
  responses as generated artifacts.
- Runner severity/semantic flags became STOP output in `dispatchForFile` and
  `buildEnrichedBlockerOutput`. Unused warnings were also promoted to errors.
  Startup guidance explicitly required fixing even pre-existing errors.
- The coverage reporter examined primary LSP publication gaps, without
  reconciling successful concurrent `ast-grep-napi` coverage. No LSP publication
  is not proof that a successful NAPI scan with zero matches failed. Several
  NAPI failure/unsupported paths were all labelled simply `skipped`.
- Tool output, widget/cached findings, turn-end text and the opt-in commit guard
  had different eligibility boundaries. Existing missing-path freshness checks
  did not establish whether a file was maintained source.

## Fix and ownership

`pi-lens-diagnostic-scope.mjs` is auto-discovered by `verify-harness.mjs --fix`.
It patches the local fork, not node_modules. Exact anchors fail loudly on drift;
postconditions cover all replacements. The regression suite simulates an
extension replacement, reapplies the target, and proves byte idempotence.

Eligibility uses existing session facts and project ignore/generated policy:
real successful edit/write receipts establish maintained work, including new
standalone scripts without Git or package.json. Recovered shell changes retain
opaque provenance. Existing recorded maintenance or Git membership can establish
source ownership; previously observed unowned artifacts do not become maintained
merely because Git later lists the same path. Direct editing or a maintained
new destination permits intentional adoption. Unknown writes are still scanned
read-only, with a bounded, deduplicated observation for parser errors.

Only error findings in maintained modified ranges qualify for the existing
`guard.enabled` policy. Default errors remain visible diagnostics, not gates;
warnings are not promoted. Explicit artifact analysis never establishes repair
ownership. Mutation chokepoints, automatic/cache freshness gates, cached all-mode
output, turn-end delivery and commit checks use the same source eligibility.
Content hashes and file identities reject stale/replaced results; formatter
receipts refresh maintained-file identity. Unchanged gate findings remain in
state while their inline text is deduplicated. Old unscoped turn-end records are
not replayed as obligations.

Scanner status reconciles NAPI success, including zero matches, with LSP gaps.
Unsupported, unavailable, skipped, failed and timed-out outcomes remain distinct.
Health changes are informational and edge-triggered per relevant project/language
state, not stored as actionable source warnings. Detailed runner results and
latency records remain available on demand.

## Verification

- `node scripts/bench/pi-lens-scope-test.mjs`: **45 passed**. Real HTMLHint,
  Biome JS/TS/XML syntax findings, real ast-grep zero-match run, actual
  tool-result eligibility boundary, explicit full reporting, mutation guards,
  default/opt-in enforcement, rename/delete/reclassification, asynchronous
  replacement, completion checks and update reapplication. Temporary HOME,
  standalone source tree without ancestor package.json/Git, installs disabled;
  no inference or network downloads.
- `node scripts/bench/pi-lens-debounce-test.mjs`: **17 passed**. Its structural
  expectations now allow the source-eligibility check before the existing
  recent-write debounce; debounce behavior is unchanged.
- `node scripts/verify-harness.mjs --fix`: **PASS**, including the new patch.
- Installed bundle: `node --check` passes. Session `lens_diagnostics mode=all
  severity=error`: no errors.

## Representative agent-visible output

Before (successful download):

```text
🔴 STOP — 9 issue(s) must be fixed:
  L1: Unexpected token
🟡 coverage: ast-grep silent — diagnostics are incomplete
```

After (unowned artifact, at most three finding details, once per changed content):

```text
pi-lens artifact/opaque-write observation (ownership unconfirmed;
raw bytes preserved; no repair obligation):
  .../inertia.js-DpQuU6hf.js:L1: [error <parser-rule>] Unexpected token
```

Authored error with the existing guard enabled:

```text
🔴 Source gate (guard.enabled): 1 error(s) in maintained changes:
  .../script.js:1 [error <parser-rule>] Unexpected token
```

Clean/zero-match scans and unchanged observations: no injected text.

## Limits and activation

No system can recover download intent from arbitrary shell writes alone.
Ambiguous new shell-created scripts are checked read-only, not automatically
made repair obligations. Direct write/edit means authorship/adoption; a caller
copying remote bytes through that API is indistinguishable without provenance.
Tracked third-party snapshots should use existing project ignore/generated
configuration. Receipt scope is session-local; explicit analysis remains
available after reload without reviving an old gate. Tests exercise the actual
bundle/runners and controlled hook dependencies, not paid end-to-end agent
behavior or every external scanner implementation.

The already-running Pi process retains its loaded JavaScript. Use `/reload` or
restart/resume to activate the installed fix. No downloaded evidence was edited,
renamed or deleted. Baseline: `backups/lens-scope-01a072/index.js`.
