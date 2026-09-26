/**
 * Expert critic lenses — read-only quality viewpoints assembled per task.
 * Pure module: lens catalogue plus cheap-first plan construction.
 *
 * WHY: one generic review cannot judge typography, transactional integrity
 * and calibration at once. Lenses are dynamically constructed from the
 * detected domains: each lens names what it judges, which deterministic
 * checks answer it cheaply, what evidence it needs, and which existing
 * owner (quality_review aspect, project/error brief, check tool) carries
 * model judgment when cheap layers cannot decide. No new review engine,
 * launcher or model fan-out lives here: see review-coordinator.ts.
 */
import type { ExpertDomainId } from "./expert-domains.ts";
import { getDoctrinePack } from "./expert-doctrine.ts";

export type CriticKind = "deterministic" | "model";
/** Finding tiers. blocking/improvement reuse the ReviewReport vocabulary;
 * polish is expert-only and never blocks convergence. */
export type ExpertFindingSeverity = "blocking" | "improvement" | "polish";

/** Where model judgment for this lens already lives. */
export type CriticOwner =
  | "quality_review:correctness" | "quality_review:security" | "quality_review:interface"
  | "quality_review:content" | "quality_review:runtime" | "quality_review:delivery"
  | "helper:project" | "helper:error" | "checks-only";

export interface CriticLens {
  id: string;
  role: string;
  kind: CriticKind;
  owner: CriticOwner;
  /** Deterministic tool calls that answer cheap questions first (≤4). */
  checks: readonly string[];
  /** Evidence the lens needs before judging. */
  evidence: string;
  /** One-paragraph judgment brief for the model carrier (≤400 chars). */
  brief: string;
}

const lens = (id: string, role: string, kind: CriticKind, owner: CriticOwner, checks: readonly string[], evidence: string, brief: string): CriticLens =>
  ({ id, role, kind, owner, checks, evidence, brief });

export const LENS_CATALOG: Record<string, CriticLens> = {
  "art-direction": lens("art-direction", "Art direction", "model", "quality_review:interface",
    ["design_audit on representative captures", "render_see at 2+ viewports"],
    "captured pixels at representative sizes/states",
    "Judge composition, hierarchy, identity and restraint against the brief: does the work express its own character, guide the eye deliberately, and earn every element? Taste suggestions are improvements; broken or generic-template output against an explicit distinctiveness ask is blocking."),
  "typography-composition": lens("typography-composition", "Typography and composition", "model", "quality_review:interface",
    ["render_see at 2+ viewports", "code_quality slop on new styles"],
    "captured pixels including type-heavy regions",
    "Judge type pairing, scale, measure, rhythm and alignment: is typography carrying the design with deliberate roles, or are competing fonts, tiny tracked labels and centered body copy doing decorative work?"),
  "color-brand": lens("color-brand", "Color and brand", "model", "quality_review:interface",
    ["design_audit on representative captures"],
    "captured pixels across themes where theming applies",
    "Judge palette discipline and brand fit: small token set, intentional temperature/saturation relationships, semantic dark-theme tokens, no muddy defaults or gradient-text abuse."),
  "responsive-state": lens("responsive-state", "Responsive behavior and states", "model", "quality_review:interface",
    ["render_see at 360px and desktop widths", "browser_session representative task pass"],
    "captures at narrow and wide viewports plus loading/empty/error states",
    "Judge that layout, type and targets hold across sizes and that loading, empty, error and disabled states are real designed states reached by interaction, not assumed from source."),
  originality: lens("originality", "Originality", "model", "quality_review:interface",
    ["design_audit on representative captures"],
    "captured pixels plus the named peers/references from the brief",
    "Judge distinctiveness: could a demanding critic name what this is trying to be? Flag category-default output, stock heroes, untouched kit styling and look-alike reuse of context-only references."),
  "svg-geometry": lens("svg-geometry", "SVG geometry", "deterministic", "checks-only",
    ["artifact_check svg on every shipped file", "code_quality duplicates across icon files"],
    "clean artifact_check svg receipts",
    "Deterministic: valid parse, no duplicate ids, all fragment references resolve, no active content, no cost-heavy compositing without explicit regions."),
  "svg-small-size": lens("svg-small-size", "SVG small-size behavior", "model", "quality_review:interface",
    ["render_see rasterized at 16/24/48px", "artifact_check svg"],
    "rasterized 16/24/48px captures",
    "Judge silhouette legibility at 16px and 24px and set coherence (shared grid, stroke language, corners): detail that clogs or vanishes at small sizes is blocking for icons."),
  "timing-rhythm": lens("timing-rhythm", "Timing and rhythm", "model", "quality_review:interface",
    ["math_check frame_budget on measured frames", "render_see key-frame captures"],
    "captured sequence or key frames plus frame-time measurements",
    "Judge that duration, easing and stagger encode information hierarchy, transitions hold one idea each, and measured frames stay within budget; demand the reduced-motion pass as evidence."),
  "caption-audio": lens("caption-audio", "Captions and audio bed", "deterministic", "checks-only",
    ["video_qa pacing/timing checks", "audio_analyze levels/clipping"],
    "video_qa receipt plus measured audio levels",
    "Deterministic: captions match content and timing within tolerance, peaks below clipping, dialogue intelligible, loudness on target."),
  "audio-mix": lens("audio-mix", "Mix quality", "model", "helper:project",
    ["audio_analyze peaks/loudness/spectrum", "media_info format verification"],
    "measured levels plus a full listen pass",
    "Judge clarity chain, arrangement masking, stereo/mono compatibility and edit hygiene from measurements plus listening: mud, harshness, clicks and collapsed stereo are concrete findings."),
  "component-architecture": lens("component-architecture", "Component architecture", "model", "quality_review:correctness",
    ["code_quality duplicates on touched sources", "context_slice on key components"],
    "touched sources plus a test receipt for behavior claims",
    "Judge that component boundaries mirror domain concepts, state lives at the right level, and variants are parameterized rather than cloned; demand behavior evidence, not shape praise."),
  "interaction-state": lens("interaction-state", "Interaction and state", "model", "quality_review:interface",
    ["browser_session representative task pass", "project_tests focused receipts"],
    "real interaction evidence over covered flows",
    "Judge covered flows in a real render: no lost updates, no stale renders, effects fenced with cleanup, loading/error/disabled states reachable by interaction."),
  "a11y-lens": lens("a11y-lens", "Accessibility", "model", "quality_review:interface",
    ["browser_session keyboard-only pass", "render_see focus/contrast regions"],
    "keyboard pass plus focus/contrast captures",
    "Judge keyboard path completeness, focus visibility, control names, announcements and contrast on touched interactions: no new a11y regression ships silently."),
  "frontend-perf": lens("frontend-perf", "Frontend performance", "deterministic", "checks-only",
    ["web_asset_check on shipped assets", "math_check render_budget for canvas/GL work"],
    "asset/budget numbers for claimed performance",
    "Deterministic: asset weights and counts within budget, no waterfall fetching introduced, measured numbers behind every performance claim."),
  "maintainability": lens("maintainability", "Maintainability", "model", "helper:project",
    ["code_quality complexity on touched sources", "code_quality duplicates on touched sources"],
    "touched sources with ownership and test pointers",
    "Judge ownership clarity, complexity distribution and duplication: a future engineer should find the owner of every behavior and a test near it. Defer taste-only refactors."),
  "correctness-lens": lens("correctness-lens", "Correctness", "model", "quality_review:correctness",
    ["syntax_check on touched sources", "project_tests focused receipts"],
    "test receipts plus a counterexample hunt over changed behavior",
    "Judge changed behavior against callers, compatibility and cancellation paths with a concrete counterexample where one exists; goal fidelity first — a tidy change that leaves the request unsolved is blocking."),
  "concurrency-state": lens("concurrency-state", "Concurrency and state", "model", "quality_review:correctness",
    ["project_tests concurrency receipts", "context_slice on shared-state owners"],
    "state-transition walkthrough plus concurrency test receipts",
    "Judge state ownership, race windows, lock/queue discipline and cancellation: every shared mutation names its owner and its behavior under contention and abort."),
  "failure-recovery": lens("failure-recovery", "Failure and recovery", "model", "quality_review:runtime",
    ["project_tests failure-path receipts", "code_quality slop for swallowed errors"],
    "failure-path receipts plus timeout/retry/degradation notes",
    "Judge failure semantics: timeouts, bounded retries with backoff, explicit degradation, no swallowed errors; every new failure path has a test or a disclosed gap."),
  "data-api-lens": lens("data-api-lens", "Data and API surface", "model", "quality_review:correctness",
    ["contract_diff against the previous contract", "data_query bounded shape reads"],
    "contract diff plus example transcripts",
    "Judge data shapes and API behavior for consistency and compatibility: no silent breaks, no shape drift between layers, examples match the live contract."),
  "api-consistency": lens("api-consistency", "API consistency", "model", "quality_review:content",
    ["openapi_probe contract inspection"],
    "contract plus example transcripts",
    "Judge one vocabulary, one error model, one versioning story: naming, casing, status codes and pagination/filtering semantics stay uniform across the surface."),
  "api-compat": lens("api-compat", "API compatibility", "deterministic", "checks-only",
    ["contract_diff against the previous contract", "http_request live endpoint probes"],
    "contract diff plus probe transcripts",
    "Deterministic: no breaking change outside a versioned, documented deprecation; docs examples verified against the live contract."),
  "data-model": lens("data-model", "Data model", "model", "helper:project",
    ["sqlite_probe schema inspection", "data_query bounded shape reads"],
    "schema plus representative queries",
    "Judge that keys, constraints and cardinalities encode domain reality: no god tables, no EAV soup, integrity at the schema boundary rather than hoped for in app code."),
  "migration-safety": lens("migration-safety", "Migration safety", "deterministic", "checks-only",
    ["project_tests migration forward/back receipts"],
    "forward and back receipts on representative data",
    "Deterministic: migrations ordered and reversible, verified both directions, no orphaned rows, acceptable lock behavior on production-shaped data."),
  "query-shape": lens("query-shape", "Query shape", "deterministic", "checks-only",
    ["sqlite_probe query inspection", "data_query bounded reads"],
    "hot-path query plans or timings",
    "Deterministic: hot-path queries carry acceptable plans on representative data; no N+1 access or unbounded result sets."),
  "invariant-proof": lens("invariant-proof", "Invariant and correctness argument", "model", "helper:project",
    ["project_tests adversarial/property receipts"],
    "stated invariant plus adversarial receipts",
    "Judge the invariant statement and its preservation argument: the invariant is named before the code, covers boundary inputs, and property/adversarial tests exercise it."),
  "complexity-arg": lens("complexity-arg", "Complexity argument", "model", "helper:project",
    ["code_quality complexity on hot paths", "coverage_probe branch coverage"],
    "stated complexity plus benchmark numbers with input description",
    "Judge that big-O plus constants are stated and measured on representative sizes; tiny-sorted-input benchmarks presented as general performance fail."),
  "adversarial-cases": lens("adversarial-cases", "Adversarial cases", "deterministic", "checks-only",
    ["project_tests property/adversarial receipts", "coverage_probe edge-case branches"],
    "enumerated adversarial list with per-case coverage",
    "Deterministic: every enumerated adversarial case (empty, singular, maximal, hostile ordering) is covered by a test."),
  "numeric-behavior": lens("numeric-behavior", "Numeric behavior", "model", "quality_review:correctness",
    ["math_check numeric verification", "project_tests boundary receipts"],
    "boundary-input receipts",
    "Judge floating-point discipline: no equality on computed values, stable reductions, defined behavior for nonfinite and boundary inputs, tolerances from scale."),
  "simplicity-check": lens("simplicity-check", "Simplicity", "model", "helper:project",
    ["code_quality complexity on touched sources"],
    "touched sources plus the simpler alternative considered",
    "Judge that the simplest correct approach won: cleverness needs a measured reason, and a worse reimplementation of a library routine is an improvement finding."),
  "state-ownership": lens("state-ownership", "State ownership", "model", "helper:project",
    ["dependency_plan service mapping"],
    "ownership map of every store",
    "Judge singular documented ownership per piece of state: every replica names its staleness contract, and no store has two writers by accident."),
  "consistency-retry": lens("consistency-retry", "Consistency and retries", "model", "quality_review:runtime",
    ["dependency_plan failure-surface mapping", "project_tests recovery receipts"],
    "timeout/retry budget table",
    "Judge explicit per-operation consistency choices with written tradeoffs, bounded retries with backoff and idempotency, no unbounded fan-out, clock assumptions bounded."),
  "backpressure-lens": lens("backpressure-lens", "Backpressure", "model", "quality_review:runtime",
    ["project_tests load/degradation receipts"],
    "queue bounds plus shedding/degradation notes",
    "Judge bounded queues, explicit shedding and graceful degradation: collapse is prevented by design, not deferred by unbounded buffers."),
  "partial-failure": lens("partial-failure", "Partial failure", "model", "quality_review:runtime",
    ["project_tests failure-injection receipts"],
    "failure-injection receipts",
    "Judge partial failure as the normal case: at least one end-to-end scenario tested, failover paths exercised, split-brain and leader hazards addressed where they apply."),
  "threat-model": lens("threat-model", "Threat model", "model", "quality_review:security",
    ["env_audit environment audit"],
    "threat model note naming assets, actors and boundaries",
    "Judge that assets, actors, trust boundaries and out-of-scope items are written down before controls are judged; controls without a threat model are improvements at best."),
  "auth-boundary": lens("auth-boundary", "Authorization boundaries", "model", "quality_review:security",
    ["project_tests denied-case receipts", "context_slice on auth checks"],
    "denied-case receipts for every new boundary",
    "Judge deny-by-default: every access path names its check, mutations and edge routes included; client-side checks and hidden endpoints are never the control."),
  "secret-handling": lens("secret-handling", "Secret handling", "deterministic", "checks-only",
    ["env_audit environment audit", "code_quality slop for embedded secrets"],
    "secret-scan clean bill across touched scope",
    "Deterministic: no secret material in source, logs, URLs, embeddings or error messages; every secret names source, scope and rotation."),
  "input-trust": lens("input-trust", "Input trust", "model", "quality_review:security",
    ["project_tests boundary receipts"],
    "boundary receipts for untrusted inputs",
    "Judge boundary validation of shape, size, encoding and provenance before use: no string-built queries, commands or markup from untrusted input."),
  "data-assumptions": lens("data-assumptions", "Data and evaluation assumptions", "model", "helper:project",
    ["data_query bounded dataset-shape reads"],
    "provenance/labeling/split notes",
    "Judge explicit data assumptions: provenance, labeling process, split identity and drift plan are written down; hidden assumptions behind metrics are findings."),
  "leakage-check": lens("leakage-check", "Leakage", "deterministic", "checks-only",
    ["data_query split-membership verification", "project_tests pipeline receipts"],
    "split-membership proof for train/tune/test",
    "Deterministic: splits frozen and leakage-free; test data never trains, tunes or selects thresholds."),
  "calibration-lens": lens("calibration-lens", "Calibration", "model", "helper:project",
    ["math_check metric verification", "project_tests evaluation receipts"],
    "held-out calibration numbers",
    "Judge calibrated uncertainty on held-out data: probabilities mean what they claim, fitted on data separate from training, reported alongside discrimination."),
  "baseline-compare": lens("baseline-compare", "Baselines", "deterministic", "checks-only",
    ["project_tests evaluation receipts"],
    "trivial-predictor and simplest-model numbers on the frozen split",
    "Deterministic: results beat the simplest baseline on the frozen split with error analysis; improvements over nothing are not progress."),
  "inference-economics": lens("inference-economics", "Inference economics", "model", "helper:project",
    ["math_check latency/cost verification"],
    "latency, cost and quality numbers measured jointly",
    "Judge deliberate latency/cost/quality tradeoffs: budgets hold or the tradeoff is explicit, tail latency measured, failure distributions reported."),
  "audience-argument": lens("audience-argument", "Audience and argument", "model", "quality_review:content",
    ["code_quality prose on final text"],
    "final prose read-through",
    "Judge audience fit and argument structure: claim, evidence, implication in order; every section earns its place for the named reader; filler and throat-clearing are findings."),
  "evidence-provenance": lens("evidence-provenance", "Evidence and provenance", "model", "quality_review:content",
    ["claim_check on factual assertions"],
    "claim support for factual assertions",
    "Judge that every factual claim is supported or explicitly marked uncertain: no invented people, numbers, quotes or references; tone consistent with project voice."),
  "uncertainty-voice": lens("uncertainty-voice", "Uncertainty and voice", "model", "quality_review:content",
    ["code_quality prose on final text"],
    "final prose read-through",
    "Judge plainly stated uncertainty (known, inferred, unknown labeled) and consistent voice: hype adjectives, passive fog and provenance clutter are findings."),
  "density-check": lens("density-check", "Information density", "deterministic", "checks-only",
    ["code_quality prose on final text"],
    "prose-check receipt",
    "Deterministic: prose checks report no remaining hype/filler/AI-tell finding; short sentences, no repeated setup."),
  "source-quality": lens("source-quality", "Source quality", "model", "quality_review:content",
    ["source_check on cited sources", "web_research job receipts"],
    "sourced findings with dates",
    "Judge primary dated accessible sources behind load-bearing claims: no citation ladders, no undated claims presented as current, dead links called out."),
  "claim-support": lens("claim-support", "Claim support", "model", "quality_review:content",
    ["claim_check on load-bearing claims"],
    "claim-by-claim support notes",
    "Judge claim-by-claim support: cherry-picking, false balance and smoothed-over disagreement are blocking for research-grade output."),
  "method-soundness": lens("method-soundness", "Method soundness", "model", "helper:project",
    ["web_research job receipts"],
    "method and scope note",
    "Judge recorded methods and search scope: the work can be redone, competing hypotheses were pursued before concluding, gaps are written down."),
};

export interface CriticPlanLens {
  lens: CriticLens;
  domains: ExpertDomainId[];
  /** Bounded evidence packet: at most these items reach the model carrier. */
  evidencePacket: { maxFiles: number; maxChars: number; maxFindings: number };
}

export interface CriticPlan {
  lenses: CriticPlanLens[];
  deterministicFirst: string[];
  modelJudgment: string[];
  /** Packs whose lenses were merged into this plan. */
  packs: ExpertDomainId[];
  /** Lens ids dropped by the plan cap, for observability (never silent). */
  dropped: string[];
}

const MAX_PLAN_LENSES = 6;
const EVIDENCE_PACKET = { maxFiles: 6, maxChars: 6000, maxFindings: 8 };

/** Assemble the lenses that matter for these domains. Cheap-first order:
 * deterministic lenses run before any model judgment is requested, and
 * model lenses ride existing review owners with bounded evidence packets. */
export function buildCriticPlan(domains: readonly ExpertDomainId[]): CriticPlan {
  const seen = new Map<string, Set<ExpertDomainId>>();
  const packs: ExpertDomainId[] = [];
  for (const domain of domains) {
    const p = getDoctrinePack(domain);
    if (!p) continue;
    packs.push(domain);
    for (const id of p.lenses) {
      if (!LENS_CATALOG[id]) continue;
      const set = seen.get(id) ?? new Set<ExpertDomainId>();
      set.add(domain);
      seen.set(id, set);
    }
  }
  const ordered = [...seen.entries()]
    .map(([id, ds]) => ({ lens: LENS_CATALOG[id], domains: [...ds] }))
    // Deterministic first; shared lenses (more domains) before narrow ones.
    .sort((a, b) => Number(a.lens.kind === "model") - Number(b.lens.kind === "model")
      || b.domains.length - a.domains.length || a.lens.id.localeCompare(b.lens.id));
  const kept = ordered.slice(0, MAX_PLAN_LENSES);
  const dropped = ordered.slice(MAX_PLAN_LENSES).map((e) => e.lens.id);
  return {
    lenses: kept.map((e) => ({ lens: e.lens, domains: e.domains, evidencePacket: { ...EVIDENCE_PACKET } })),
    deterministicFirst: kept.filter((e) => e.lens.kind === "deterministic").map((e) => e.lens.id),
    modelJudgment: kept.filter((e) => e.lens.kind === "model").map((e) => e.lens.id),
    packs,
    dropped,
  };
}

/** One TUI line describing the assembled plan. */
export function criticPlanSummary(plan: CriticPlan): string {
  if (!plan.lenses.length) return "";
  const parts = [`${plan.lenses.length} lens${plan.lenses.length === 1 ? "" : "es"}`];
  if (plan.deterministicFirst.length) parts.push(`cheap: ${plan.deterministicFirst.join(", ")}`);
  if (plan.modelJudgment.length) parts.push(`judgment: ${plan.modelJudgment.join(", ")}`);
  if (plan.dropped.length) parts.push(`dropped: ${plan.dropped.join(", ")}`);
  return `Critics: ${parts.join(" · ")}.`;
}

/** Severity triage shared by the convergence policy: only blocking and
 * improvement findings can keep a pass open; polish never blocks. */
export function isSubstantiveFinding(severity: string): boolean {
  return severity === "blocking" || severity === "improvement";
}
