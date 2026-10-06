# YunusPi 0.23.8 verification

This maintenance audit repairs reproduced lifecycle, cache, subprocess, redirect and archive defects in the owned harness and core. It does not claim that an open-ended bug audit can prove the absence of every defect.

## Reproduced defects and contracts

- A terminal stream event left additional readers parked. Terminal push now releases every waiting reader; large queues retain exact FIFO order while draining without repeated array shifts.
- RPC prompt failures appeared successful, stopped clients retained event waits, and a self-removing subscriber could skip the next waiter. Command errors reject, every wait settles on stop or process exit, and subscriber dispatch uses a stable snapshot. Startup detects signal exits and resolves the owned CLI independently of the caller's working directory.
- A process printing a long unterminated line grew an unbounded progress buffer and repeatedly scanned old text. Pending lines and diagnostic tails are bounded, split UTF-8 remains intact, callback errors stop the owned child, and cancellation stops buffered progress.
- Process-tree memory accounting repeatedly scanned all processes for every descendant. Parent adjacency and a visited set now count the same descendants in one traversal. A synthetic 7,000-process chain measured about 1.6 seconds before and 44 milliseconds after on the audit machine; this is a local algorithm measurement, not an end-to-end agent speed guarantee.
- An old SQLite connection could read or overwrite a new model's embeddings. Model identity predicates now guard each read, write, count and prune atomically. Invalid vectors, parameters and incompatible schemas degrade without contaminating valid rows.
- Manual HTTP redirects forwarded source-origin credentials and stale body headers. Cross-origin hops strip credentials and host overrides, method changes remove request body headers, and explicit domain policy and cancellation also cover shortcut and deferred lookup paths. Tests cover header representations and changes of host, port and scheme.
- Office ZIP verification accepted duplicate names and directory overruns; its writer also emitted highly compressible files its own reader refused. Ambiguous entries and malformed bounds are rejected, ZIP comments are framed correctly, and the writer stores entries without compression when required by the reader's expansion limit.

## Validation

The final release candidate passed **3,087 of 3,089 tests**, with **zero failures** and **two skips**, in 333.19 seconds on Linux x86-64 with Node 24.21.0. The skips are the explicitly opted-in pinned-assets CLI test and the negative legacy-Office test that requires LibreOffice to be absent. The suite exercised actual Needle WASM, Chromium rendering, media processing, subprocess cancellation and Linux sandbox integration alongside deterministic fixtures.

The affected lifecycle, cache and memory subset passed **34/34** with no skips on Node 22.22.3. GitHub's minimum-runtime lane now also includes these regressions on the declared minimum Node 22.19.0. The Office ZIP subset passed **17/17**. Tool efficiency, adaptive execution and competence replay benchmarks all passed, preserving their required capability and evidence contracts.

An initial complete run found a spreadsheet-conversion failure in the Codex tool environment's bundled LibreOffice development nightly. A separate ordinary workbook reproduced the same excessive memory growth, and the watchdog stopped it. The installed stable LibreOffice passed the conversion suite; the final complete run selected that stable installation by excluding the development wrapper from its test PATH. The watchdog and its budget remain intact. The bundled nightly remains an external limitation for environments that select it.

Public safety checks cover the tree, index and reachable Git history. Release-template tests, workflow and metadata are synchronized with the root files. After adding the verification report and regenerating its capability index, the inventory, release metadata and source/template integrity subset passed 13/13 with no skips. The public push hook now checks inventory freshness before upload. Provider inference and local installation preservation are separate delivery checks; the complete source test suite alone does not establish them.
