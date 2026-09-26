/**
 * Expert doctrine packs — data-driven excellence knowledge per domain.
 * Pure module: data plus bounded retrieval. No I/O, no inference.
 *
 * WHY: vague prompts ("make it stunning", "build the backend") underspecify
 * what good looks like. Each pack defines positive doctrine (what excellent
 * work actually is), negative doctrine (characteristic AI-template failure
 * modes generalized from the anti-slop philosophy), invariants, measurable
 * checks, critic lenses, evidence requirements, exploration heuristics and
 * convergence conditions. Packs are data so new specialties can be added
 * without touching orchestration; retrieval exposes only bounded
 * task-relevant passages, never the whole catalogue.
 */
import type { ExpertDomainId } from "./expert-domains.ts";
import { EXPERT_DOMAIN_LABELS } from "./expert-domains.ts";

export interface DoctrineCheck {
  /** Registered tool name that performs this check. */
  tool: string;
  /** Tool operation/variant where applicable. */
  op?: string;
  what: string;
}

export interface DoctrinePack {
  id: ExpertDomainId;
  /** Positive doctrine: what excellent work actually looks like (≤6). */
  principles: readonly string[];
  /** Negative doctrine: characteristic failure modes to avoid (≤6). */
  antiPatterns: readonly string[];
  /** Must-preserve truths across any transformation (≤5). */
  invariants: readonly string[];
  /** Named quality dimensions critics judge (≤6). */
  dimensions: readonly string[];
  /** Deterministic checks that run before model judgment (≤6). */
  checks: readonly DoctrineCheck[];
  /** Advisory skill names worth reading for this domain (≤4). */
  skills: readonly string[];
  /** Relevant registered tools beyond the checks (≤6). */
  tools: readonly string[];
  /** Critic lens ids (see expert-critics.ts) that matter here (≤6). */
  lenses: readonly string[];
  /** Evidence kinds required before claiming excellence (≤4). */
  evidence: readonly string[];
  /** When exploring alternatives pays off for this domain. */
  exploreWhen: string;
  /** Domain-specific stop conditions beyond the global ones (≤3). */
  convergeExtra: readonly string[];
}

const pack = (id: ExpertDomainId, rest: Omit<DoctrinePack, "id">): DoctrinePack => ({ id, ...rest });

export const EXPERT_PACKS: Record<ExpertDomainId, DoctrinePack> = {
  "web-design": pack("web-design", {
    principles: [
      "One clear hierarchy: a visitor knows what this is and what to do next within seconds.",
      "Typography carries the design: deliberate pairing, scale, measure and rhythm over decoration.",
      "Restraint: every element earns its place; whitespace and quiet surfaces are design decisions.",
      "Identity: the page expresses its own brief and brand, not a component-kit default.",
      "Responsive by construction: layout, type and touch targets hold from 360px to desktop.",
      "Honest states: loading, empty, error and disabled states are designed, not defaulted.",
    ],
    antiPatterns: [
      "Unearned pill clusters, fake BETA/NEW/LIVE badges and glowing status dots without backing state.",
      "Eyebrow labels above every heading, gradient-text headlines and glass-panel excess.",
      "Competing font roles, tiny tracked-out labels and oversized hero type doing all the work.",
      "Redundant card grids, decorative dividers and effect clusters that add no meaning.",
      "Template hero (badge, giant headline, two buttons, logos row) with swapped words.",
      "Work-thought narration or AI-provenance chrome leaked into visible copy.",
    ],
    invariants: [
      "Existing brand tokens, IA and user flows survive unless the user asked to change them.",
      "Accessibility floor holds: keyboard path, focus visibility, contrast, names for controls.",
      "Content truth: no invented metrics, testimonials, logos or capabilities.",
    ],
    dimensions: ["composition", "typography", "color/brand", "responsive behavior", "interaction states", "originality"],
    checks: [
      { tool: "visual_review", what: "Rendered rubric review with recorded verdicts." },
      { tool: "ui_explore", what: "Viewport/state matrix with DOM facts." },
      { tool: "design_audit", what: "Rendered noise/pattern inspection of captured pages." },
      { tool: "code_quality", op: "slop", what: "AI-template tells in new markup/styles." },
    ],
    skills: ["frontend-design", "ui-ux-principles", "anti-ai-slop", "product-ui-verification"],
    tools: ["creative_direct", "browser_session", "render_see", "design_audit", "web_asset_check", "creative_compare"],
    lenses: ["art-direction", "typography-composition", "color-brand", "responsive-state", "originality", "information-architecture"],
    evidence: ["captured pixels at 2+ viewports", "recorded visual_review verdict", "interaction pass over key flows", "states (loading/empty/error) shown"],
    exploreWhen: "Open briefs without an explicit style: sketch 3 distinct directions before building.",
    convergeExtra: [
      "No blocking anti-slop finding remains on representative captures.",
      "A demanding art director could name what this design is trying to be.",
    ],
  }),
  "visual-art": pack("visual-art", {
    principles: [
      "A single focal idea with deliberate composition: value structure reads at thumbnail size.",
      "Constrained palette with intentional temperature and saturation relationships.",
      "Consistent light logic: one key direction, coherent shadows and material response.",
      "Texture and detail serve the focal hierarchy; quiet areas stay quiet.",
      "Cohesive series language when producing sets: shared geometry, palette and finish.",
    ],
    antiPatterns: [
      "Muddy default palettes, plastic-smooth rendering and over-sharpened detail everywhere.",
      "Extra fingers/limbs, warped text-like marks and incoherent small-scale structure.",
      "Centered symmetrical compositions repeated with no variation or intent.",
      "Watermark-like artifacts, fake signatures and provenance clutter baked into pixels.",
      "Oversaturated glow-and-bloom defaults standing in for lighting design.",
    ],
    invariants: [
      "Requested subject, aspect ratio and deliverable format are honored exactly.",
      "No real-person likeness, trademark or watermark is fabricated or forged.",
      "Series consistency: shared palette/geometry/finish across the set.",
    ],
    dimensions: ["composition", "value/color", "light logic", "detail hierarchy", "cohesion", "craft/finish"],
    checks: [
      { tool: "media_info", what: "Dimensions, format, color profile and size of outputs." },
      { tool: "image_ocr", what: "Detect accidental text-like artifacts in art." },
      { tool: "render_see", what: "View final art at display size and thumbnail size." },
      { tool: "visual_review", what: "Rendered rubric review with recorded verdicts." },
    ],
    skills: ["visual-composition", "color-theory", "image-analysis"],
    tools: ["media_info", "image_generate", "render_see", "image_ocr", "scene_render", "asset_register"],
    lenses: ["art-direction", "color-brand", "originality"],
    evidence: ["final art at full and thumbnail sizes", "palette/geometry notes for series"],
    exploreWhen: "Open briefs: produce 2-3 distinct compositional directions before refining one.",
    convergeExtra: [
      "Composition reads at thumbnail size and holds at full size.",
      "No anatomical/structural defect visible at display size.",
    ],
  }),
  "svg-iconography": pack("svg-iconography", {
    principles: [
      "Silhouette first: the icon reads at 16px before any interior detail is judged.",
      "Consistent geometry: shared grid, corner language, stroke width and optical corrections.",
      "Honest strokes: expanded or aligned strokes that survive scaling and theming.",
      "Negative space is designed: counters and gaps stay open at small sizes.",
      "Set coherence: siblings share weight, rhythm and corner treatment.",
    ],
    antiPatterns: [
      "Hairline details that vanish or clog below 24px.",
      "Mixed stroke widths, corner radii and end caps within one set.",
      "Unnecessary filters, gradients and masks adding weight without meaning.",
      "Duplicate ids, broken fragment references and copy-pasted defs across files.",
      "Icons that only read at large sizes or only in one theme.",
    ],
    invariants: [
      "Valid SVG: parses cleanly, no duplicate ids, all references resolve.",
      "No active content: no scripts, event handlers or external references.",
      "Small-size legibility: 16px and 24px renders stay recognizable.",
    ],
    dimensions: ["silhouette", "geometry consistency", "stroke language", "small-size behavior", "set coherence", "hygiene"],
    checks: [
      { tool: "svg_inspect", what: "Geometry, refs, transforms and set-consistency review." },
      { tool: "artifact_check", op: "svg", what: "Reference integrity, ids, active content, cost cues." },
      { tool: "code_quality", op: "duplicates", what: "Copy-pasted defs shared across icon files." },
    ],
    skills: ["custom-svg", "svg-assessment"],
    tools: ["render_see", "media_info", "browser_session", "asset_register"],
    lenses: ["svg-geometry", "svg-small-size", "originality"],
    evidence: ["rasterized 16/24/48px captures", "svg_inspect set review with no drift outlier", "clean artifact_check svg receipt"],
    exploreWhen: "New marks or sets: sketch 2-3 silhouette directions before detailing.",
    convergeExtra: [
      "artifact_check svg reports no issues on every shipped file.",
      "Every icon reads at 16px in both themes where theming applies.",
    ],
  }),
  "motion-design": pack("motion-design", {
    principles: [
      "Timing encodes meaning: duration, easing and stagger reflect information hierarchy.",
      "One idea per transition: entrances, exits and emphasis never compete.",
      "Physics with intent: springs and decays tuned to mass and distance, not defaults.",
      "Continuity: shared-element and layout transitions preserve object identity.",
      "Reduced-motion parity: a calm equivalent exists for every animated behavior.",
    ],
    antiPatterns: [
      "Identical fade-up choreography on every element with mechanical stagger.",
      "Long overshooting springs on small UI controls.",
      "Continuous decorative motion (floating blobs, pulsing rings) with no information role.",
      "Layout-thrashing property animation (width/height/top/left) causing jank.",
      "Motion that blocks input or strands focus without a reduced-motion path.",
    ],
    invariants: [
      "Reduced-motion users get full function with calm feedback.",
      "Animation never strands keyboard focus or traps input.",
      "Frame budget holds on representative hardware; no sustained jank.",
    ],
    dimensions: ["timing/easing", "rhythm/choreography", "continuity", "performance", "reduced-motion parity", "restraint"],
    checks: [
      { tool: "motion_inspect", what: "Animation inventory plus sampled temporal QA." },
      { tool: "math_check", op: "frame_budget", what: "Measured frame times against budget." },
      { tool: "code_quality", op: "slop", what: "Layout-property animation and motion defaults." },
    ],
    skills: ["motion", "browser-animation-engineering", "svg-motion-engineering"],
    tools: ["browser_session", "render_see", "video_frames"],
    lenses: ["timing-rhythm", "responsive-state", "originality"],
    evidence: ["captured sequence or key frames", "frame-time measurements", "reduced-motion pass"],
    exploreWhen: "Signature transitions: prototype 2-3 timing/choreography directions.",
    convergeExtra: [
      "Measured frames stay within budget on the target device class.",
      "Reduced-motion path verified, not assumed.",
    ],
  }),
  video: pack("video", {
    principles: [
      "Structure first: hook, progression and payoff are legible in the timeline.",
      "Cutting serves rhythm: shot length, transitions and beats match the narration.",
      "Legible captions: paced, synchronized, readable typography with safe contrast.",
      "Clean audio bed: leveled dialogue, intentional music, no clipping or mud.",
      "Consistent grade and finish across scenes and sources.",
    ],
    antiPatterns: [
      "Random transition salad: spins, zooms and glitches between every shot.",
      "Captions flashing faster than reading speed or drifting out of sync.",
      "Music drowning narration; abrupt loudness jumps between segments.",
      "Mismatched color/levels between clips with no grade pass.",
      "Autoplay-assumed pacing with no verify of actual rendered timing.",
    ],
    invariants: [
      "Captions match spoken content and timing within tolerance.",
      "Audio peaks stay below clipping; dialogue stays intelligible throughout.",
      "Deliverable spec holds: resolution, frame rate, codec, duration limits.",
    ],
    dimensions: ["structure/pacing", "cutting/rhythm", "captions", "audio bed", "grade/finish", "spec compliance"],
    checks: [
      { tool: "video_qa", what: "Caption pacing, timing and render verification." },
      { tool: "video_frames", what: "Sampled frame inspection across scenes." },
      { tool: "audio_analyze", what: "Levels, clipping and loudness measurement." },
    ],
    skills: ["terminal-video-editing", "video-analysis"],
    tools: ["video_project", "video_render", "video_frames", "video_qa", "audio_analyze", "narration_tts"],
    lenses: ["timing-rhythm", "caption-audio", "art-direction"],
    evidence: ["rendered output with checked captions", "measured audio levels", "spec checklist"],
    exploreWhen: "Open creative briefs: cut 2 rough assemblies with different pacing before finishing.",
    convergeExtra: [
      "video_qa reports pacing/timing checks passing on the final render.",
      "Full watch-through with no defect noted.",
    ],
  }),
  audio: pack("audio", {
    principles: [
      "Clarity chain: source quality, noise control, EQ, dynamics, then space.",
      "Levels with headroom: consistent loudness, no clipping, intentional dynamics.",
      "Arrangement serves the ear: entries, exits and frequency space avoid masking.",
      "Stereo/mono compatibility: the mix survives collapsing to mono.",
      "Fades and boundaries: clean heads, tails and edit points everywhere.",
    ],
    antiPatterns: [
      "Brick-walled loudness with crushed dynamics.",
      "Muddy low-mid buildup and harsh unaddressed resonances.",
      "Reverb wash hiding edits instead of serving space.",
      "Clicks, pops and truncated tails at edit boundaries.",
      "Stereo widening that collapses or phase-cancels in mono.",
    ],
    invariants: [
      "No clipping or digital overs at any point in the deliverable.",
      "Deliverable spec holds: sample rate, bit depth, format, loudness target.",
      "Mono compatibility: no essential content vanishes when summed.",
    ],
    dimensions: ["clarity", "levels/dynamics", "arrangement", "space", "edit hygiene", "spec compliance"],
    checks: [
      { tool: "audio_analyze", what: "Peaks, loudness, clipping and spectrum measurement." },
      { tool: "media_info", what: "Format, sample rate and channel verification." },
    ],
    skills: ["sound-analysis", "audio-processing"],
    tools: ["audio_analyze", "audio_mix", "audio_synth", "music_compose", "media_info"],
    lenses: ["audio-mix", "caption-audio"],
    evidence: ["measured levels/loudness", "mono-compatibility check", "full listen pass"],
    exploreWhen: "Open sonic briefs: sketch 2-3 arrangement/mix directions before finalizing.",
    convergeExtra: [
      "Measured loudness meets target with headroom and no clipping.",
      "Full listen pass with no defect noted.",
    ],
  }),
  frontend: pack("frontend", {
    principles: [
      "Component boundaries mirror domain concepts, not file-size accidents.",
      "State lives at the right level: local first, lifted only with shared readers.",
      "Deterministic rendering: same state produces same output; effects are fenced.",
      "Fast by default: measured bundles, lazy boundaries, no waterfall fetching.",
      "Accessible interaction: keyboard, focus, names and announcements are built in.",
    ],
    antiPatterns: [
      "Prop drilling through five layers instead of colocating state.",
      "Effects that fight the render cycle: loops, stale closures, missing cleanup.",
      "Client waterfalls: sequential fetching that could be parallel or colocated.",
      "Global store as a junk drawer for unrelated local state.",
      "Copy-pasted component variants instead of one parameterized component.",
    ],
    invariants: [
      "No lost updates or stale renders on the covered flows.",
      "Existing routes, data contracts and a11y behavior survive refactors.",
      "Bundle and runtime budgets hold or improve unless scope changed.",
    ],
    dimensions: ["component architecture", "state ownership", "render determinism", "performance", "accessibility", "maintainability"],
    checks: [
      { tool: "syntax_check", what: "Parse/type-level verification of touched sources." },
      { tool: "code_quality", op: "duplicates", what: "Cloned components and handlers." },
      { tool: "code_quality", op: "complexity", what: "Over-complex render paths." },
      { tool: "project_tests", what: "Focused test receipts for behavior claims." },
    ],
    skills: ["frontend-js", "web-component-patterns", "web-performance"],
    tools: ["browser_session", "render_see", "project_intel", "context_slice", "symbol_expand"],
    lenses: ["component-architecture", "interaction-state", "a11y-lens", "frontend-perf", "maintainability"],
    evidence: ["test receipts", "rendered behavior evidence", "bundle/perf numbers when claimed"],
    exploreWhen: "Architecture choices (state, routing, data layer): compare 2-3 approaches on paper first.",
    convergeExtra: [
      "Covered flows verified in a real render, not inferred from source.",
      "No new a11y regression on touched interactions.",
    ],
  }),
  backend: pack("backend", {
    principles: [
      "Explicit transactional boundaries: every mutation names its unit of consistency.",
      "Idempotent operations where retries exist; safe repeated delivery by design.",
      "Failure semantics first: timeouts, retries with backoff, and degradation paths.",
      "Boring and observable: structured logs, metrics and traces over clever code.",
      "Least privilege data access: queries fetch what they need, nothing ambient.",
    ],
    antiPatterns: [
      "N+1 queries and unbounded result sets behind innocent-looking endpoints.",
      "Swallowed exceptions and catch-all handlers hiding partial failure.",
      "Retry storms: unbounded retries with no backoff, jitter or circuit breaking.",
      "Business logic scattered across handlers, middleware and cron with no owner.",
      "Stringly-typed domain concepts and magic status codes.",
    ],
    invariants: [
      "Data integrity: no partial writes visible; constraints hold under failure.",
      "Auth boundaries: every mutation path re-checks authorization.",
      "Compatibility: existing clients, jobs and migrations keep working.",
    ],
    dimensions: ["correctness", "transactional integrity", "concurrency", "failure/recovery", "observability", "simplicity"],
    checks: [
      { tool: "syntax_check", what: "Parse/type-level verification of touched sources." },
      { tool: "code_quality", op: "complexity", what: "Over-complex handlers and branches." },
      { tool: "project_tests", what: "Focused test receipts incl. failure paths." },
      { tool: "coverage_probe", what: "Coverage evidence for claimed behavior." },
    ],
    skills: ["go-service-engineering", "node-runtime-engineering", "php-application-engineering"],
    tools: ["project_intel", "context_slice", "dependency_plan", "http_request", "sqlite_probe", "sandbox_run"],
    lenses: ["correctness-lens", "concurrency-state", "failure-recovery", "data-api-lens", "maintainability"],
    evidence: ["test receipts incl. failure paths", "state-transition walkthrough", "log/metric proof when claimed"],
    exploreWhen: "State ownership and consistency choices: compare approaches before building.",
    convergeExtra: [
      "Every new failure path has a test or an explicit disclosed gap.",
      "No unbounded query, retry or queue without a bound.",
    ],
  }),
  "api-design": pack("api-design", {
    principles: [
      "Conceptual consistency: one vocabulary, one error model, one versioning story.",
      "Predictable resources and verbs: clients guess right about the next endpoint.",
      "Explicit contracts: schemas, examples and error cases are specified, not implied.",
      "Evolution without breakage: additive change, deprecation windows, compat tests.",
      "Least surprise pagination, filtering and idempotency semantics.",
    ],
    antiPatterns: [
      "Inconsistent naming, casing and pluralization across endpoints.",
      "Overloaded 200-with-error-body responses and undocumented status codes.",
      "Breaking renames shipped without versioning or migration path.",
      "Chatty APIs forcing N+1 client round trips for one screen.",
      "Examples in docs that no longer match the actual contract.",
    ],
    invariants: [
      "Published contracts stay backward compatible within a major version.",
      "Auth and error semantics are uniform across the surface.",
      "Every endpoint has a documented failure contract, not just happy path.",
    ],
    dimensions: ["consistency", "predictability", "contract explicitness", "compatibility", "ergonomics", "documentation"],
    checks: [
      { tool: "openapi_probe", what: "Contract structure and coverage inspection." },
      { tool: "contract_diff", what: "Compatibility diff against the previous contract." },
      { tool: "http_request", what: "Live endpoint behavior probes." },
    ],
    skills: ["api-design", "web-patterns"],
    tools: ["openapi_probe", "contract_diff", "http_request", "data_query"],
    lenses: ["api-consistency", "api-compat", "data-api-lens"],
    evidence: ["contract diff (no silent breaks)", "example request/response transcripts"],
    exploreWhen: "Resource modeling and versioning choices: compare 2 designs before committing.",
    convergeExtra: [
      "contract_diff shows no breaking change or each break is versioned and documented.",
      "Docs examples verified against the live contract.",
    ],
  }),
  database: pack("database", {
    principles: [
      "Model the domain truthfully: keys, constraints and cardinalities encode reality.",
      "Explicit migrations: reversible, ordered, tested against production-shaped data.",
      "Index with evidence: measured queries, not guessed columns.",
      "Integrity at the boundary: constraints in the schema, not just in app code.",
      "Growth-aware: partitioning, retention and vacuum owned before they bite.",
    ],
    antiPatterns: [
      "Missing foreign keys and constraints 'handled in the app'.",
      "Migrations that cannot roll back or that lock tables on large data.",
      "God tables and EAV soup standing in for a designed model.",
      "N+1-shaped access baked in by missing indexes or wrong grain.",
      "Unbounded history tables with no retention or archival plan.",
    ],
    invariants: [
      "Migrations are ordered, reversible and verified forward and back.",
      "Constraints hold on existing data; no orphaned or half-migrated rows.",
      "Query plans for hot paths stay acceptable on representative data.",
    ],
    dimensions: ["model fidelity", "integrity", "migration safety", "query shape", "growth/ops", "simplicity"],
    checks: [
      { tool: "sqlite_probe", what: "Schema and query inspection on SQLite targets." },
      { tool: "data_query", what: "Bounded data-shape verification reads." },
      { tool: "project_tests", what: "Migration forward/back receipts." },
    ],
    skills: ["databases", "sql-query-engineering"],
    tools: ["sqlite_probe", "data_query", "dependency_plan"],
    lenses: ["data-model", "migration-safety", "query-shape", "correctness-lens"],
    evidence: ["migration forward/back receipts", "hot-path query plans or timings"],
    exploreWhen: "Grain and normalization choices: model 2 options against real queries first.",
    convergeExtra: [
      "Migrations verified forward and back on representative data.",
      "No hot-path query without an acceptable plan.",
    ],
  }),
  algorithms: pack("algorithms", {
    principles: [
      "State the invariant first, then the code that preserves it.",
      "Correctness argument before optimization: proof sketch or exhaustive reasoning.",
      "Complexity stated and measured: big-O plus constants on real inputs.",
      "Adversarial cases enumerated: empty, singular, maximal, hostile ordering.",
      "Simplest correct algorithm wins ties; cleverness needs a measured reason.",
    ],
    antiPatterns: [
      "Optimized code with no stated invariant or complexity.",
      "Floating-point equality and unstable reductions in numeric code.",
      "Recursion without depth bounds on untrusted-size inputs.",
      "Benchmarks on tiny sorted inputs presented as general performance.",
      "Reimplemented standard algorithms worse than the library version.",
    ],
    invariants: [
      "Stated invariants hold on all enumerated adversarial cases.",
      "Numerical code defines behavior for nonfinite and boundary inputs.",
      "Complexity claims match measured behavior on representative sizes.",
    ],
    dimensions: ["invariant clarity", "correctness argument", "complexity", "adversarial coverage", "numeric behavior", "simplicity"],
    checks: [
      { tool: "math_check", what: "Numeric verification where the op applies." },
      { tool: "project_tests", what: "Property/adversarial test receipts." },
      { tool: "code_quality", op: "complexity", what: "Complexity hotspots in hot paths." },
      { tool: "coverage_probe", what: "Branch coverage of edge cases." },
    ],
    skills: ["algorithm-design", "numerical-computing", "property-based-testing"],
    tools: ["project_intel", "context_slice", "sandbox_run"],
    lenses: ["invariant-proof", "complexity-arg", "adversarial-cases", "numeric-behavior", "simplicity-check"],
    evidence: ["adversarial/property test receipts", "benchmark numbers with input description"],
    exploreWhen: "Approach selection: compare 2-3 algorithms on complexity and fit before coding.",
    convergeExtra: [
      "Every enumerated adversarial case is covered by a test.",
      "Measured complexity matches the claim on representative sizes.",
    ],
  }),
  "distributed-systems": pack("distributed-systems", {
    principles: [
      "One owner per piece of state; every other copy names its staleness contract.",
      "Explicit consistency choice per operation, with the tradeoff written down.",
      "Retries with budgets, backoff and idempotency; no unbounded anything.",
      "Backpressure over collapse: queues bounded, shedding explicit, degradation graceful.",
      "Partial failure is the normal case: design for it, test it, observe it.",
    ],
    antiPatterns: [
      "Distributed transactions and locks as the first resort.",
      "Retry without idempotency keys or with unbounded fan-out.",
      "Unbounded queues and buffers that defer collapse instead of preventing it.",
      "Split-brain-prone leader logic and untested failover paths.",
      "Clock assumptions (ordering, expiry, leases) without skew bounds.",
    ],
    invariants: [
      "State ownership is singular and documented for every store.",
      "Every cross-boundary call has timeout, retry budget and failure mode.",
      "Failover and recovery paths are tested, not just drawn.",
    ],
    dimensions: ["state ownership", "consistency", "retries/timeouts", "backpressure", "partial failure", "observability"],
    checks: [
      { tool: "dependency_plan", what: "Service dependency and failure-surface mapping." },
      { tool: "project_tests", what: "Failure-injection and recovery receipts." },
      { tool: "code_quality", op: "complexity", what: "Coordination hotspots." },
    ],
    skills: ["distributed-systems", "concurrency-memory-models"],
    tools: ["dependency_plan", "project_intel", "http_request", "sandbox_run", "net_probe"],
    lenses: ["state-ownership", "consistency-retry", "backpressure-lens", "partial-failure", "failure-recovery"],
    evidence: ["failure-injection receipts", "timeout/retry budget table", "ownership map"],
    exploreWhen: "Consistency and topology choices: compare 2-3 designs against failure cases.",
    convergeExtra: [
      "Every cross-boundary call documents timeout, retries and degradation.",
      "At least one partial-failure scenario is tested end to end.",
    ],
  }),
  security: pack("security", {
    principles: [
      "Threat model first: assets, actors, trust boundaries and what is out of scope.",
      "Deny by default: every access path names its authorization check.",
      "Validate at the boundary: shape, size, encoding and provenance before use.",
      "Secrets have a lifecycle: sourced, scoped, rotated, never logged or embedded.",
      "Fail closed on the security path; errors reveal nothing useful to attackers.",
    ],
    antiPatterns: [
      "Security by obscurity: hidden endpoints and client-side checks as the control.",
      "String-built queries, commands and markup from untrusted input.",
      "Secrets in code, logs, URLs, embeddings or error messages.",
      "Overbroad permissions granted because the narrow path was harder.",
      "Auth checks on the happy path only; mutations and edge routes unguarded.",
    ],
    invariants: [
      "Every trust-boundary crossing re-validates and re-authorizes.",
      "No secret material in source, logs, telemetry or public artifacts.",
      "Security controls fail closed under error, timeout and misconfiguration.",
    ],
    dimensions: ["threat coverage", "auth boundaries", "input trust", "secret handling", "fail-closed behavior", "auditability"],
    checks: [
      { tool: "syntax_check", what: "Parse-level verification of touched security code." },
      { tool: "code_quality", op: "slop", what: "Swallowed catches and dangerous defaults." },
      { tool: "project_tests", what: "Denied-case and boundary test receipts." },
      { tool: "env_audit", what: "Environment and configuration audit." },
    ],
    skills: ["web-security", "systems-security"],
    tools: ["project_intel", "context_slice", "http_request", "env_audit", "sandbox_run"],
    lenses: ["threat-model", "auth-boundary", "secret-handling", "input-trust", "failure-recovery"],
    evidence: ["threat model note", "denied-case receipts", "secret-scan clean bill"],
    exploreWhen: "Trust-boundary and auth-model choices: compare 2 designs against abuse cases.",
    convergeExtra: [
      "Every new trust boundary has denied-case tests.",
      "No new secret, credential or PII flow without lifecycle handling.",
    ],
  }),
  ml: pack("ml", {
    principles: [
      "Baselines first: the simplest model and the trivial predictor set the bar.",
      "Evaluation before iteration: frozen splits, documented metrics, error analysis.",
      "Data assumptions explicit: provenance, labeling, leakage boundaries, drift plan.",
      "Calibrated uncertainty: probabilities mean what they claim on held-out data.",
      "Inference economics: latency, cost and quality traded deliberately, measured jointly.",
    ],
    antiPatterns: [
      "Leakage: split violations, target-derived features, test in training.",
      "Metric hacking: tuning on the test set, hiding slices that fail.",
      "No-baseline claims: improvements over nothing presented as progress.",
      "Uncalibrated scores treated as certainties in downstream decisions.",
      "Ignoring failure distributions: aggregate metrics hiding harmed subgroups.",
    ],
    invariants: [
      "Splits are frozen and leakage-free; test data never trains or tunes.",
      "Metrics, baselines and ablations are reproducible from recorded artifacts.",
      "Inference cost/latency budgets hold or the tradeoff is explicit.",
    ],
    dimensions: ["data/eval hygiene", "baselines", "calibration", "failure distribution", "inference economics", "reproducibility"],
    checks: [
      { tool: "math_check", what: "Metric and statistical verification where the op applies." },
      { tool: "data_query", what: "Bounded dataset-shape verification." },
      { tool: "project_tests", what: "Pipeline and evaluation receipts." },
    ],
    skills: ["ml-engineering", "model-evaluation", "classical-ml-modeling"],
    tools: ["data_query", "context_slice", "sandbox_run"],
    lenses: ["data-assumptions", "leakage-check", "calibration-lens", "baseline-compare", "inference-economics"],
    evidence: ["frozen-split eval numbers", "baseline comparison", "error/failure breakdown"],
    exploreWhen: "Approach selection: compare baselines and 2 candidate directions on the same split.",
    convergeExtra: [
      "Results beat the simplest baseline on the frozen split with error analysis.",
      "No unresolved leakage or calibration gap.",
    ],
  }),
  writing: pack("writing", {
    principles: [
      "Audience first: every section earns its place for the named reader.",
      "Argument structure: claim, evidence, implication — in that order.",
      "Concrete over abstract: examples, numbers and named references beat adjectives.",
      "Uncertainty stated plainly: known, inferred and unknown are labeled.",
      "Information density: short sentences, no throat-clearing, no repeated setup.",
    ],
    antiPatterns: [
      "Buzzword stacks and hype adjectives standing in for substance.",
      "Invented metrics, quotes and citations.",
      "Throat-clearing openers and repeated roadmap paragraphs.",
      "Passive fog hiding who does what.",
      "AI-provenance clutter and work-narration leaked into the prose.",
    ],
    invariants: [
      "Every factual claim is supported or explicitly marked uncertain.",
      "No invented people, numbers, quotes or references.",
      "Tone and terminology stay consistent with the project's voice.",
    ],
    dimensions: ["audience fit", "structure", "evidence", "clarity/density", "tone", "correctness"],
    checks: [
      { tool: "code_quality", op: "prose", what: "Hype, filler and AI-tell detection in prose." },
      { tool: "claim_check", what: "Claim support verification." },
      { tool: "syntax_check", what: "Markup/docs syntax verification." },
    ],
    skills: ["natural-editorial-writing", "copywriting", "storytelling"],
    tools: ["claim_check", "web_search", "source_check"],
    lenses: ["audience-argument", "evidence-provenance", "uncertainty-voice", "density-check"],
    evidence: ["final prose read-through", "claim support for factual assertions"],
    exploreWhen: "Open topics: draft 2-3 outlines with different arguments before writing.",
    convergeExtra: [
      "A full read-through finds no unsupported claim or filler paragraph.",
      "prose checks report no remaining hype/filler finding.",
    ],
  }),
  research: pack("research", {
    principles: [
      "Question first: a falsifiable question bounds the whole investigation.",
      "Provenance always: every claim carries its source and its date.",
      "Primary sources over summaries; verify the load-bearing claims directly.",
      "Uncertainty quantified: confidence, disagreement and gaps are explicit.",
      "Synthesis over collection: compared, weighed and judged — not listed.",
    ],
    antiPatterns: [
      "Citation ladders: summaries citing summaries with no primary check.",
      "Cherry-picked sources supporting a pre-chosen conclusion.",
      "Undated claims presented as current; dead links and changed facts.",
      "False balance or false consensus on settled questions.",
      "Research dumps: long undigested pastes instead of synthesized findings.",
    ],
    invariants: [
      "Load-bearing claims trace to primary, dated, accessible sources.",
      "Disagreement and uncertainty are reported, not smoothed away.",
      "Methods and search scope are recorded so the work can be redone.",
    ],
    dimensions: ["question clarity", "source quality", "provenance", "synthesis", "uncertainty", "currency"],
    checks: [
      { tool: "claim_check", what: "Claim support verification." },
      { tool: "source_check", what: "Source quality and accessibility checks." },
      { tool: "web_research", what: "Bounded research job receipts." },
    ],
    skills: ["research", "scientific-paper-research"],
    tools: ["web_search", "web_research", "source_check", "claim_check", "fetch_content"],
    lenses: ["source-quality", "claim-support", "method-soundness", "uncertainty-voice"],
    evidence: ["sourced findings with dates", "method/scope note", "disagreement log"],
    exploreWhen: "Open questions: pursue 2-3 competing hypotheses or framings before concluding.",
    convergeExtra: [
      "Every load-bearing claim has a primary dated source.",
      "Known disagreements and gaps are written down, not omitted.",
    ],
  }),
};

/** Bounded doctrine retrieval. Exposes only task-relevant passages:
 * at most two packs, capped bullets and characters, deterministic order. */
export interface DoctrineBrief {
  packs: ExpertDomainId[];
  text: string;
  chars: number;
  truncated: boolean;
}

const BRIEF_CHAR_BUDGET = 2400;
const MAX_BRIEF_PACKS = 2;

export function selectDoctrineBrief(
  domains: ReadonlyArray<{ domain: ExpertDomainId; confidence: number }>,
  opts: { taskType?: string; budget?: number } = {},
): DoctrineBrief {
  const budget = Math.max(400, Math.min(6000, opts.budget ?? BRIEF_CHAR_BUDGET));
  const ranked = [...domains]
    .filter((d) => Object.hasOwn(EXPERT_PACKS, d.domain))
    .sort((a, b) => b.confidence - a.confidence || a.domain.localeCompare(b.domain))
    .slice(0, MAX_BRIEF_PACKS);
  if (!ranked.length) return { packs: [], text: "", chars: 0, truncated: false };
  const lines: string[] = ["Expert doctrine (advisory; user words and project conventions win):"];
  let truncated = false;
  for (const { domain } of ranked) {
    const p = EXPERT_PACKS[domain];
    const block = [
      `${EXPERT_DOMAIN_LABELS[domain]} — excellence means: ${p.principles.slice(0, 3).join(" ")}`,
      `Avoid: ${p.antiPatterns.slice(0, 3).join(" ")}`,
      `Invariants: ${p.invariants.slice(0, 3).join(" ")}`,
      `Prove it with: ${p.evidence.join("; ")}.`,
      `Stop when: ${p.convergeExtra.join(" ")}`,
    ].join("\n");
    const candidate = `${lines.join("\n")}\n${block}`;
    if (candidate.length > budget) { truncated = true; break; }
    lines.push(block);
  }
  const text = lines.join("\n").slice(0, budget);
  return { packs: ranked.map((r) => r.domain), text, chars: text.length, truncated };
}

/** Full pack access for the expert_director tool path and critic planner.
 * Never injected wholesale into prompts; use selectDoctrineBrief instead. */
export function getDoctrinePack(domain: ExpertDomainId): DoctrinePack | undefined {
  return Object.hasOwn(EXPERT_PACKS, domain) ? EXPERT_PACKS[domain] : undefined;
}
