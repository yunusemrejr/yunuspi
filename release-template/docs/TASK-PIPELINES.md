# Task pipelines

UI work stages responsive capture, current visual judgment and real interaction separately. `ui-responsive` retains 320px/mobile/tablet/desktop measurements and inspected matrix pixels; `ui-pixels` requires actual rendered judgment; `ui-interaction` requires the representative task and keyboard/focus evidence. Source-only or stale receipts cannot substitute for them. SVG work pairs automatic structural inspection with intended-size visual review. These checks work without mandatory skill reads and preserve the caller's tool ceiling and selected model.

The adaptive workflow owner selects development pipelines from the current user request, explicitly observed relevant files and inspected dependency names. `agent/extensions/lib/task-pipelines.ts` performs this selection locally. It reads no project files, launches no models or commands and injects no skill bodies. Questions and explicit workflow opt-outs return no pipelines.

A request counts as work when it contains a build, fix, test or release verb, or a further action verb such as generate, convert, export, migrate, configure, automate, integrate, scrape, trim or cut (nouns such as model or port count only when imperative). Question-shaped requests (what, why, how, explain, describe, list) never activate a pipeline on a verb alone; observed project files still do.

Selection follows the evidence available at task, subtask or todo scope. New file or manifest evidence can change the selected stack; the execution profile decides how much context, coordination and review that scope needs. Do not feed arbitrary tool-output prose into selection. A JavaScript file without browser evidence receives runtime discovery; it does not force a visual review. A React CDN request keeps the no-build edition distinct from a normal React package/bundler project.

## Recurring stacks

| Pipeline | Discovery and validation |
| --- | --- |
| PHP 8+ | Composer constraints, actual CLI/web SAPI versions and extensions, document root; changed-source lint and relevant request/auth/database checks. |
| Node.js | Package scripts, lockfile, installed runtime, ESM/CJS and entry point; focused checks for affected behavior, async failures and shutdown. |
| Frontend JavaScript | Actual browser versus Node entry point, modules and state owner; runtime checks proportional to the change. Pure functions need no compulsory browser review. |
| Vanilla frontend | Existing HTML/CSS/DOM and native controls; real served page, load order and keyboard operation, preserving a working no-build deployment. |
| React CDN | Pinned React/ReactDOM, import-map/global/JSX strategy; served browser edition, network/CSP and representative interaction. |
| React with Node.js | Existing bundler, scripts, lockfile and state boundaries; affected build/test/type checks and served interaction. |
| Go | go.mod/toolchain, context and contracts; affected tests/vet/build, with race detection when the change warrants it. |
| Rust | Cargo edition/workspace/features/target and ownership; affected tests/checks/lints plus failure/cleanup paths. |
| Java | JDK target and Maven/Gradle wrapper; affected tests/packaging and resource disposal. |
| Python and Flask | Actual interpreter/environment and application entry point; syntax/focused tests, Flask routes and relevant auth/session/error behavior. |
| Bash | Declared shell, quoting/status and side effects; shell syntax, available ShellCheck and safe failure/cleanup cases. |
| C and C++ | Standard, compiler/build target, ABI, ownership and integer boundaries; affected build/tests and appropriate warnings/sanitizers. |
| Linux-native | Actual toolkit/entry point, packaging and display/audio dependencies; normal CLI/GUI launch, real input and shutdown, with displayed-content checks for GUI work. |
| Local webapps | Host/port ownership, start/stop, data boundaries and backend connection; a representative browser-to-backend task and cleanup. |
| Algorithms and AI/ML | Input contract/invariants/scale or objective/data splits/baseline; oracle/invariant checks or leakage-free fixed evaluation and measured performance. |
| Fine-tuning and Colab | Immutable model/tokenizer revisions, data hashes/masking, hardware, checkpoints and actual connection mode; appropriate preparation checks or real training smoke/resume/export/evaluation evidence. |
| Research | Question/date/version scope, query-ranked source reads and cached text; exact quotation/hash dossiers, copied-source grouping, contradictions and explicit evidence gaps. Subject nouns in a literature report do not activate training or code production. |
| Reinforcement learning | Actual environment transitions and random/scripted baseline; terminal/truncated final-observation bootstraps, finite updates and frozen policy evaluation on separate seeds. |
| Edge models | Actual ISA/runtime and RAM/latency budgets; train-only calibration, original/exported prediction comparison and measured inference on the target. |
| UI/UX and desloppification | Existing design doctrine before palette/type/layout; actual application pixels and interaction, swap test, accessibility and relevant states. |
| UI motion and scroll | Existing motion/transform owners, purpose and fallback before mechanics; `ui_recipe` prepares entrances or section tracks, `motion_inspect` samples live forward/reverse scroll, with mobile, reduced-motion, focus and cleanup checks after integration. |
| Responsive UI | Current 320px/mobile/tablet/desktop captures plus relevant touch, DPR, orientation and breakpoint neighbors; explicit matrix gaps remain unresolved. Measurements, inspected pixels and real interaction retain their native evidence owners. |
| UI consistency | Existing shared components, role variants and design tokens; `ui_consistency` compares the same named roles across routes and reports drift or missing coverage without prescribing a stock visual identity. |
| Web 3D | Current local GLB/glTF resources and decoder requirements before Three.js integration; Blender export preflight, matching installed loader imports, real model loading, fallback, reduced motion, resizing and resource disposal. |
| Codebase controls | Actual symbols, callers, shared owners and edit scope before structural changes; source intelligence and impact inspection precede bounded edits, expanded scope requires fresh inspection, then affected behavior is verified. |
| Image media | Exact provider/model, reference/mask constraints, direct vision evidence and original-preserving conversion; decoded pixels and review at intended sizes. |
| Video | Source metadata and timeline constraints; decoded delivery output, followed by playback review for pacing, transitions and sound/image fit. |
| Audio | Source metadata and signal analysis; decoded delivery output and measured mastering checks, followed by listening review. |
| SVG art | Transformed geometry, visible bounds and disclosed approximation limits; rendered pixels at intended sizes. |
| 3D and Blender | Saved-scene inventory, units, budgets and destination format; `blender_inspect` manifold, normal, scale and UV measurements, validated exports, then rendered frames from several angles plus a close-up. A viewport or script exit cannot settle appearance. |
| SEO | Canonical host, indexable versus private routes and target intents; `web_probe` on served pages for status, canonicals, robots, sitemap and structured data. Rankings, traffic and AI citations are measured outcomes, never claims. |
| LLM applications | Provider, prompt and tool contracts, retrieval sources, a frozen golden set and a simple baseline; structured-output and injection checks, then a frozen-set comparison with slice breakdown, cost and latency. |
| API automation | Provider auth, scopes, rate limits, pagination and webhook semantics; a state machine with idempotency keys and approval points; dry run, failure injection (timeout, 429, 5xx, partial batch) and an idempotent re-run. |
| Office documents | Source, template or example opened with `office_doc read` before writing; docx and xlsx built from a spec rather than hand-written OOXML; the produced file reopened with `office_doc` or `deliverable_check` and every error and warning resolved, with pages rendered for anything a person will look at. A script printing "Saved x" is not evidence. |
| Tabular data | Every input profiled before transforming (columns and types, row counts, empty and duplicate keys, encodings, date and number formats); originals untouched; the output reconciled with the input (row counts in and out with every dropped or merged row accounted for, totals and distinct keys, spot-checked rows, no silent type changes) and opened with `deliverable_check`. A script that exits zero is not a reconciliation. |
| Folder organization | `fs_organize scan` before choosing a scheme; a plan reviewed, then `apply` (no overwrite, journaled, self-verifying) and the moved and skipped counts reported with the plan id for undo. Shell move loops and deletion are not part of the recipe. |
| Debugging | Observed reproduction before implementation; relevant regression checks after the fix. An expected failing reproduction is evidence of the bug, not a fixed result. |
| Git/SSH hosting | Actual Git source and authorized destination/capabilities, protected data and rollback; local validation, preflight, remote revision and live serving-path checks when deployment is requested. |

The recipes name installed skills and registered tools. Skills are optional guides and docs; consult one when useful and adapt its steps to the task. UI pipelines reuse the existing `ui-doctrine`, source signals and bounded `quality_review` owners rather than starting another reviewer. The doctrine covers both default purple-gradient SaaS styling and cream/terracotta cursive or italic editorial styling, fabricated proof and ornaments without a role; explicit user style instructions still take precedence.

The catalog includes every stage's available tools. Automatic schema activation uses the shared `automaticPipelineTools` policy instead of exposing that entire catalog on every turn. Ordinary Node/Python fixes keep generic source-quality, Git and workflow-control tools discoverable. Source audits/refactors, consequential scopes or unresolved failures activate `code_quality`; actual Git work, inspected Git metadata and hosting pipelines activate `git_info`; a complex or critical scope or an explicit workflow/control request activates `task_pipeline`. Existing deliberate quality/prose intent bundles remain effective. Required UI rendering/interaction and hosting tools remain available before the first model turn. Explicit tool discovery retains the caller's choices across continuations and later tasks.

## Execution and evidence

Pure video, audio and SVG tasks activate their inspection tools without compulsory source audits or programming tests. Native media inspection can settle discovery; a decoded output with measured checks can settle implementation and technical validation. Playback, listening and pixel review use distinct evidence kinds and remain pending until reviewed. Replacing an output invalidates those reviews. Mixed programming and media scopes keep the relevant programming checks. Audio denoising and pitch-preserving time stretching route to `audio_mix`; trimming and normalization route to `media_edit`.

A selected workflow has a dependency graph: discovery → implementation → relevant validation → delivery. Appearance requires pixels from the actual application; interaction requires actual input evidence. A process exit code or source analysis cannot settle either. An explicit request to execute fine-tuning adds a real training smoke test and fixed-model comparison; fixing trainer code does not require a full training run. Preparing a notebook or training script keeps those live execution claims unresolved rather than requiring a paid run. Namecheap/GoDaddy branding does not imply SSH access, runtime versions or deployment capability.

`task_pipeline` exposes status, explicit scope selection and stage recording through the adaptive workflow owner. The stage ledger indexes references to existing native evidence. It does not run commands, manufacture project-test receipts or certify an agent's unsupported claim. `project_tests`, `quality_review`, browser/native interaction and other tools remain the owners of their respective evidence.

Receipts identify the scope, observed content revision, stage, outcome, evidence kind and source reference. Identical receipts are deduplicated. Passed stages are not repeated while scope/content remain current. Changing an upstream result invalidates its descendants while retaining unrelated validation evidence. Failed and blocked stages remain pending; repeated failures retain a count so execution policy can escalate. A new todo/task scope or changed content revision cannot borrow another scope's pass. The ledger keeps one latest receipt per scope/revision/stage and bounds retained keys to 256; revisiting evicted evidence requires renewed inspection.

For trivial changes, a reasoned assessment may establish that additional behavioral tests are unnecessary. Such an assessment cannot claim that tests passed, rendered appearance was inspected, a GPU was reached, training completed or a live deployment works. Pipeline context contains only pending, ready checks within the execution profile's context budget. Full status remains available when the bounded hint cannot include every check.

## Implementation surface

- `selectTaskPipelines({prompt, files?, dependencies?})` returns IDs, installed skill names, registered tool names and deduplicated stages.
- `automaticPipelineTools(selection, {prompt, profile?, files?})` returns the schemas justified automatically by the request, current scope risk/failures and observed metadata. Initial intent and runtime scope updates share this policy; the full stage catalog remains unchanged.
- `createPipelineLedger()` creates the stage index.
- `recordPipelineEvidence(ledger, receipt, selection)` rejects unknown stages, unsupported successful evidence kinds and successful recording before prerequisites pass.
- `pendingPipelineStages(selection, ledger, {scope, revision})` returns unresolved stages with readiness and failure counts; `nextPipelineStages` returns ready stages only.
- `buildPipelineContext(selection, ledger, {scope, revision, maxChars?})` returns a bounded next-step hint or nothing when no workflow applies or all stages passed.

Runtime hooks provide the selector with relevant request/file metadata and update activation through the existing tool-discovery owner. Source changes must update the content identity; a task-local revision counter alone is insufficient across reloads. Pipeline receipts are session evidence, not deployment authority or a public data export.

Source audit/refactor requests add `source-quality`. A current `code_quality`
baseline can settle its inspection; truncated or missing focus coverage remains
blocked. Research adds `research-evidence`: dossier gaps keep it blocked, while
complete current quotations settle inspection without certifying interpretation.
`ml_lab` and the shipped trainers support data/smoke/evaluation stages, but static
arrays and prepared notebooks cannot claim model execution or cloud connection.
See [research, code and ML controls](RESEARCH-CODE-ML.md) for tool contracts.

Required inferred schemas stay available during automatic continuations and are released when a new accepted user request no longer needs them. Deliberately selected tools retain their existing authority. Aborted replacement input cannot swap the current workflow or activate an unrelated bundle.

Main prompts, goals and short steering follow-ups share this policy. Related follow-ups retain the authored objective and explicit exclusions while refreshing checks affected by changed requirements. New unrelated tasks retire the prior automatic selection. Current stage prerequisites determine which specialist schemas are useful next; context is refreshed after native receipts and source changes rather than repeating a fixed startup checklist. Restoring a session restores routing purpose, not stale passes or completed side effects. See [autonomous UI engineering](UI-ENGINEERING.md) for the mechanics, device and consistency tools.

The runtime consumes `project-source-observed` from the native project-test scan after source and quality owners observe the same tree. It does not launch a second scan. Successful native writes and bulk-edit commit receipts also update bounded content hashes. Shell and background changes retire stale stage evidence, including delayed writes from another scope; failures remain with the scope that dispatched the work. Complete unchanged native observations preserve current evidence. An unknown shell command without a complete observation retires prior evidence conservatively; truncated or unavailable observations cannot supply new automatic verification. The native scanner's bounded coverage remains an explicit limitation.

Native nonzero exits and termination signals retire earlier passes even when a tool result marks `isError:false`; both ordinary exit fields and `details.execution` are supported. Background launches, skipped/empty test runs and setup inspection cannot create a pass. Real `project_tests` inspect/assess receipts retain their native meanings: observed successful execution, a scoped `not_needed` assessment, or an unresolved blocker. An assessment never claims execution occurred.

Owned background checks also feed failure escalation once per execution. Registry notifications and process/status results wait for a complete native source observation; stale revisions, another scope and unowned jobs cannot add current failures. Repeated status queries or project-test inspections reuse the original execution reference. A successful background status alone does not certify coverage; the native planned test receipt remains the verification owner.

Focused behavioral coverage lives in `tests/task-pipelines.test.mjs`: direct-task overhead, relevant-file routing, CDN/package separation, installed capabilities, preparation versus execution, required evidence kinds, ordering, duplicate/stale receipts, prerequisite invalidation, scope isolation and bounded repeated failure accounting. It uses no network, cloud accounts, live deployment or training hardware.

`tests/adaptive-workflows.test.mjs` covers the owned native event integration, committed bulk edits, shell/background source observations, nested execution exits, incomplete evidence, scope isolation and continuation schema retention. It uses the real native project-test and bulk-edit owners against temporary local files.
