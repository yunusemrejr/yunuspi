/**
 * Creative QA — visual review, viewport/state exploration and comparative
 * review over real rendered output. Pure planners plus bounded runners.
 *
 * WHY: visual_diff answers "how different from a reference", not "is this
 * good"; a single screenshot never proves a UI. visual_review captures a
 * source and returns structured rubric sections with deterministic evidence
 * (contrast, spacing/type counts, slop-pattern hits, ink distribution,
 * direction conformance) plus explicit needsVision gaps a vision model must
 * judge from the attached pixels; the verdict is then recorded as a
 * revision-sensitive receipt. ui_explore renders the viewport/state matrix
 * (viewports × theme × reduced-motion × full page) with per-state DOM facts
 * so narrow-width breakage and missing states surface without manual
 * clicking. creative_compare renders 2..4 direction variants side by side
 * for design fusion. Open blocking verdicts feed the completion gate.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { textPath } from "./media-process.ts";
import { decodeImage, encodeImage } from "./design-studio.ts";
import {
  borderColor, compareImages, composeRow, contrastRatio, cropRgba, designPalette, detectBlocks,
  extractPalette, hex, nameTypeLevels, segmentSections, spacingRhythm, typeScale,
  type Rgba,
} from "./image-analysis.ts";
import { directionSummary, matchAvoidSignals, type CreativeDirection } from "./creative-direction.ts";
import { relativeOrAbsolute } from "./path-safety.ts";

export type QAVerdict = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface QASection {
  id: string;
  verdict: QAVerdict;
  evidence: string[];
  needsVision?: boolean;
}

export interface QACapture {
  (params: {
    source: string; width: number; height: number; fullPage: boolean;
    colorScheme?: string; reducedMotion?: string; animationTimeMs?: number;
    timeoutMs?: number; clip?: { y: number; height: number };
    includeState?: boolean; designAudit?: boolean; animationInventory?: boolean;
  }, destination: string, cwd: string, signal?: AbortSignal): Promise<any>;
}

export const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

const relative = (cwd: string, file: string): string => relativeOrAbsolute(cwd, file);

/** Fresh artifact folder under .pi/<area> (git-ignored), else a caller-owned
 * workspace folder. Mirrors the studioFolder contract. */
export async function qaFolder(value: unknown, cwd: string, area: string, prefix: string): Promise<string> {
  const root = await fs.realpath(cwd);
  let parent: string;
  if (value === undefined) {
    parent = path.join(root, ".pi", area);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(parent, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  } else parent = canonicalMutationPath(textPath(value), root);
  if (!containsPath(root, parent)) throw new Error("Output directory must be inside the current workspace");
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Output directory must already exist");
  const output = path.join(parent, `${prefix}-${randomBytes(5).toString("hex")}`);
  const denial = selfMutationDenial(output, root);
  if (denial) throw new Error(denial);
  await fs.mkdir(output, { mode: 0o700 });
  return output;
}

/** Revision of a review source: content hash for local files (bounded),
 * so edits invalidate receipts; URLs hash to "live" and always re-verify. */
export async function sourceRevision(source: string, cwd: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) return "live";
  try {
    const file = path.resolve(cwd, source.replace(/^@/, ""));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 40 * 1024 * 1024) return `unhashed-${stat.size}`;
    return createHash("sha256").update(await fs.readFile(file)).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

// ─────────────────────────── ui_explore ──────────────────────────────────

export interface MatrixCell {
  viewport: string;
  width: number;
  height: number;
  state: string;
  colorScheme: string;
  reducedMotion: string;
  fullPage: boolean;
  file: string;
}

export interface UiMatrixPlan {
  cells: MatrixCell[];
  capped: boolean;
}

const MATRIX_MAX_CELLS = 12;

/** Expand viewports × states into a bounded capture plan. Pure. States:
 * default, dark (color-scheme), reduced-motion, full (full-page). */
export function planUiMatrix(params: {
  viewports?: unknown; states?: unknown; widths?: unknown; colorScheme?: unknown; reducedMotion?: unknown; fullPage?: unknown;
}): UiMatrixPlan {
  const viewportNames = (Array.isArray(params.viewports) ? params.viewports : ["mobile", "desktop"]).map(String).filter((v) => VIEWPORT_PRESETS[v]);
  const viewports = [...new Set(viewportNames.length ? viewportNames : ["desktop"])];
  if (Array.isArray(params.widths)) {
    for (const w of params.widths.slice(0, 4)) {
      const width = Math.round(Number(w));
      if (Number.isFinite(width) && width >= 200 && width <= 2048) viewports.push(`w${width}`);
    }
  }
  const wantStates = new Set((Array.isArray(params.states) ? params.states : ["default"]).map(String));
  if (params.colorScheme === "dark" || wantStates.has("dark")) wantStates.add("dark");
  if (params.reducedMotion === true || wantStates.has("reduced-motion")) wantStates.add("reduced-motion");
  if (params.fullPage === true || wantStates.has("full")) wantStates.add("full");
  wantStates.add("default");
  const cells: MatrixCell[] = [];
  for (const viewport of viewports.slice(0, 4)) {
    const preset = VIEWPORT_PRESETS[viewport] ?? { width: Number(viewport.slice(1)) || 1280, height: 900 };
    for (const state of ["default", "dark", "reduced-motion", "full"]) {
      if (!wantStates.has(state)) continue;
      cells.push({
        viewport, width: preset.width, height: preset.height, state,
        colorScheme: state === "dark" ? "dark" : "light",
        reducedMotion: state === "reduced-motion" ? "reduce" : "no-preference",
        fullPage: state === "full",
        file: `${viewport}-${state}.png`,
      });
    }
  }
  const capped = cells.length > MATRIX_MAX_CELLS;
  return { cells: cells.slice(0, MATRIX_MAX_CELLS), capped };
}

export interface PageStateSummary {
  items: number;
  overflowElements: number;
  scopeOverflowPx: number;
  missingAlt: number;
  images: number;
  controls: number;
  truncated: boolean;
}

/** Bounded roll-up of render page-state DOM facts. Pure. Overflow may be
 * intentional (carousels, menus); counts select inspection targets. */
export function summarizePageState(pageState: any): PageStateSummary {
  const items = Array.isArray(pageState?.items) ? pageState.items : [];
  let overflowElements = 0, missingAlt = 0, images = 0, controls = 0;
  for (const item of items.slice(0, 500)) {
    if (typeof item?.horizontalOverflowPx === "number" && item.horizontalOverflowPx > 1) overflowElements++;
    if (item?.kind === "img" || item?.role === "img" || /\bimg\b/i.test(String(item?.label ?? ""))) {
      images++;
      if (item?.alt === null || item?.alt === undefined) missingAlt++;
    }
    if (typeof item?.role === "string" && /button|link|checkbox|radio|textbox|combobox|menuitem|tab|switch|slider/i.test(item.role)) controls++;
  }
  return {
    items: items.length,
    overflowElements,
    scopeOverflowPx: Math.max(0, Math.round(Number(pageState?.scopeHorizontalOverflowPx) || 0)),
    missingAlt, images, controls,
    truncated: pageState?.truncated === true,
  };
}

export function summarizeNoise(noise: any): Array<{ key: string; detail: string }> {
  const findings = Array.isArray(noise?.findings) ? noise.findings : [];
  return findings.slice(0, 24).map((f: any) => ({
    key: String(f?.key ?? f?.id ?? "finding").slice(0, 80),
    detail: String(f?.detail ?? f?.detail ?? f?.message ?? "").slice(0, 240),
  }));
}

export async function uiExploreRun(
  params: { source: string; viewports?: unknown; states?: unknown; widths?: unknown; colorScheme?: unknown; reducedMotion?: unknown; fullPage?: unknown; outputDir?: unknown },
  cwd: string, signal: AbortSignal | undefined, capture: QACapture,
) {
  if (typeof params.source !== "string" || !params.source) throw new Error("ui_explore needs a source (local HTML/SVG path or http(s) URL)");
  const plan = planUiMatrix(params);
  const dir = await qaFolder(params.outputDir, cwd, "ui-review", "matrix");
  const cells: any[] = [];
  for (const cell of plan.cells) {
    signal?.throwIfAborted();
    const dest = path.join(dir, cell.file);
    let receipt: any;
    try {
      receipt = await capture({
        source: params.source, width: cell.width, height: cell.height, fullPage: cell.fullPage,
        colorScheme: cell.colorScheme, reducedMotion: cell.reducedMotion, timeoutMs: 30_000,
        includeState: true, designAudit: true,
      }, dest, cwd, signal);
    } catch (error: any) {
      if (signal?.aborted) throw error;
      cells.push({ ...cell, file: relative(cwd, dest), ok: false, error: String(error?.message ?? error).slice(0, 300) });
      continue;
    }
    const stat = await fs.stat(dest).catch(() => undefined);
    cells.push({
      ...cell, file: relative(cwd, dest), ok: true,
      bytes: stat?.size ?? 0, pixels: { width: receipt?.width ?? 0, height: receipt?.height ?? 0 },
      ...(receipt?.conditions?.captureFallback ? { captureFallback: receipt.conditions.captureFallback } : {}),
      dom: summarizePageState(receipt?.pageState),
      noise: summarizeNoise(receipt?.noise),
      errors: Array.isArray(receipt?.errors) ? receipt.errors.slice(0, 6) : [],
    });
  }
  const overflowCells = cells.filter((c) => c.ok && (c.dom.overflowElements > 0 || c.dom.scopeOverflowPx > 0));
  const altCells = cells.filter((c) => c.ok && c.dom.missingAlt > 0);
  const failed = cells.filter((c) => !c.ok);
  const report = {
    source: params.source, revision: await sourceRevision(params.source, cwd), at: new Date().toISOString(),
    plan: { cells: plan.cells.length, capped: plan.capped, note: plan.capped ? `Matrix capped at ${MATRIX_MAX_CELLS} captures; run again with narrower viewports/states.` : undefined },
    cells,
    findings: [
      ...overflowCells.map((c) => `${c.viewport}/${c.state}: horizontal overflow on ${c.dom.overflowElements} element(s), scope ${c.dom.scopeOverflowPx}px — inspect ${c.file} (overflow may be intentional)`),
      ...altCells.map((c) => `${c.viewport}/${c.state}: ${c.dom.missingAlt} of ${c.dom.images} sampled image(s) without alt text`),
      ...failed.map((c) => `${c.viewport}/${c.state}: capture failed — ${c.error}`),
    ].slice(0, 24),
    note: "Viewport/state pixels plus DOM facts, not interaction proof: hover, focus, menus, loading/empty/error states and keyboard behavior need browser_session passes or design_audit follow-ups. Content stress (long titles, missing images, 100 cards, RTL) is not applied here; probe representative states explicitly.",
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 1) + "\n", { flag: "wx" });
  return { dir: relative(cwd, dir), report: relative(cwd, path.join(dir, "report.json")), ...report };
}

// ─────────────────────────── visual_review ────────────────────────────────

const INK_QUADRANTS = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Ink distribution across quadrants: a proxy for compositional balance,
 * never a taste verdict. Pure. */
export function inkQuadrants(img: Rgba, background: [number, number, number]): Array<{ quadrant: string; share: number }> {
  const quad = [0, 0, 0, 0];
  let total = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 200_000)));
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 4;
    const d = Math.abs(img.data[i] - background[0]) + Math.abs(img.data[i + 1] - background[1]) + Math.abs(img.data[i + 2] - background[2]);
    if (d < 90) continue;
    quad[(y >= img.height / 2 ? 2 : 0) + (x >= img.width / 2 ? 1 : 0)] += d;
    total += d;
  }
  return quad.map((v, i) => ({ quadrant: INK_QUADRANTS[i], share: total ? Math.round((v / total) * 100) : 25 }));
}

export interface VisualRunOptions {
  source: string;
  width?: unknown;
  height?: unknown;
  colorScheme?: unknown;
  selector?: unknown;
  direction?: CreativeDirection;
  outputDir?: unknown;
}

/** Capture plus deterministic measurements and a rubric skeleton. Returns
 * sections with deterministic verdicts where measurement suffices and
 * needsVision gaps elsewhere; the caller attaches pixels for vision models
 * and the agent records the judged verdict. */
export async function visualReviewRun(options: VisualRunOptions, cwd: string, signal: AbortSignal | undefined, capture: QACapture) {
  const width = Math.max(200, Math.min(2048, Math.round(Number(options.width) || 1440)));
  const height = Math.max(200, Math.min(2048, Math.round(Number(options.height) || 900)));
  const dir = await qaFolder(options.outputDir, cwd, "ui-review", "review");
  const dest = path.join(dir, "capture.png");
  const receipt = await capture({
    source: options.source, width, height, fullPage: false,
    ...(options.colorScheme === "dark" ? { colorScheme: "dark" } : {}),
    timeoutMs: 30_000, includeState: true, designAudit: true,
  }, dest, cwd, signal);
  const bytes = await fs.readFile(dest);
  const img = await decodeImage(bytes, { maxWidth: 1280, maxPixels: 6_000_000 }, signal);
  const frame = borderColor(img);
  const sections = segmentSections(img);
  const blocks = detectBlocks(img, sections, { maxBlocks: 120 });
  const rhythm = spacingRhythm(blocks);
  const typeLevels = nameTypeLevels(typeScale(blocks).map((l) => ({ fontSize: Math.max(8, Math.round(l.ink / 2.2)), blocks: l.blocks })));
  const photos = blocks.filter((b) => (b as any).implement === "raster");
  const palette = designPalette(extractPalette(img, { max: 12, mergeDelta: 3.5, exclude: photos as any }), frame.rgb, blocks, sections, 1, img.width);
  const noise = summarizeNoise(receipt?.noise);
  const dom = summarizePageState(receipt?.pageState);
  const quads = inkQuadrants(img, frame.rgb);
  const dominant = quads.reduce((a, b) => (b.share > a.share ? b : a));

  const sectionsOut: QASection[] = [];
  const push = (id: string, verdict: QAVerdict, evidence: string[], needsVision = false) =>
    sectionsOut.push({ id, verdict, evidence: evidence.filter(Boolean).slice(0, 8), ...(needsVision ? { needsVision: true } : {}) });

  const lowContrast = palette.filter((c) => ["text", "muted-text"].includes(c.role) && c.contrastOnBackground < 4.5);
  push("accessibility", lowContrast.length ? "FAIL" : dom.missingAlt > 0 ? "WARN" : "PASS", [
    ...lowContrast.map((c) => `${c.role} ${c.hex} is ${c.contrastOnBackground}:1 on background (WCAG AA body text needs 4.5:1)`),
    ...(dom.missingAlt ? [`${dom.missingAlt} sampled image(s) without alt text`] : []),
    ...(lowContrast.length || dom.missingAlt ? [] : ["no measured text-contrast failure; keyboard/focus behavior still needs an interaction pass"]),
  ]);

  const spacingValues = [...new Set(rhythm.values.map((v) => Math.round(v)).filter((v) => v > 2))];
  push("spacing", spacingValues.length > 6 ? "WARN" : "PASS", [
    `${spacingValues.length} distinct spacing values in view (${spacingValues.slice(0, 10).join(", ") || "none measured"}); unit ~${rhythm.unit}px from ${rhythm.samples} samples`,
    ...(spacingValues.length > 6 ? ["many unrelated spacing values compete; check against the spacing scale"] : []),
  ]);

  push("typography", typeLevels.length > 6 ? "WARN" : "PASS", [
    `${typeLevels.length} measured type levels: ${typeLevels.map((l) => `${l.name} ~${l.fontSize}px`).join(", ") || "none"}`,
    ...(typeLevels.length > 6 ? ["more than 6 levels suggests unscaled type"] : []),
  ], true);

  push("composition", dominant.share >= 55 ? "WARN" : "PASS", [
    `ink share by quadrant: ${quads.map((q) => `${q.quadrant} ${q.share}%`).join(", ")}`,
    ...(dominant.share >= 55 ? [`visual mass strongly biased ${dominant.quadrant}; verify the focal element owns it`] : []),
  ], true);

  const slopSignals = noise.map((n) => `${n.key}: ${n.detail}`);
  push("slop", noise.length >= 6 ? "WARN" : noise.length ? "WARN" : "PASS", [
    `${noise.length} rendered-pattern finding(s)${noise.length ? `: ${noise.slice(0, 6).map((n) => n.key).join("; ")}` : ""}`,
    ...(noise.length ? ["pattern hits are advisory: legitimate semantic status and justified single treatments are exempt"] : []),
  ], noise.length > 0);

  push("hierarchy", "UNKNOWN", ["focal competition needs rendered judgment: does one element own the first viewport, or do hero and secondary cards compete equally?"], true);
  push("distinctiveness", "UNKNOWN", [
    "resemblance to generic template patterns needs rendered judgment against the brief and named peers",
    ...(noise.length ? [`${noise.length} advisory pattern hit(s) available above for the boilerplate check`] : []),
  ], true);

  if (options.direction) {
    const hits = matchAvoidSignals(options.direction, [...slopSignals, ...lowContrast.map((c) => `low contrast ${c.hex}`)]);
    push("direction", hits.length ? "WARN" : "PASS", [
      `direction "${directionSummary(options.direction)}"`,
      ...hits.slice(0, 6).map((h) => `avoid "${h.avoid}" ↔ ${h.signal}`),
      ...(hits.length ? ["avoid-list hits are possible boilerplate, not automatic failures: the reviewer decides whether each is justified"] : ["no avoid-list pattern hit in deterministic signals"]),
    ], hits.length > 0);
  }

  const run = {
    source: options.source, revision: await sourceRevision(options.source, cwd), at: new Date().toISOString(),
    file: relative(cwd, dest), dir: relative(cwd, dir),
    pixels: { width: receipt?.width ?? 0, height: receipt?.height ?? 0 },
    palette: palette.slice(0, 8).map((c) => `${c.role}: ${c.hex} (${c.contrastOnBackground}:1)`),
    dom, noise: noise.slice(0, 12),
    sections: sectionsOut,
    blocking: sectionsOut.filter((s) => s.verdict === "FAIL").length,
    next: "Judge the needsVision sections from the attached pixels (or open the capture), then record the verdict with visual_review action record. Deterministic PASS/FAIL stands unless the pixels prove otherwise; UNKNOWN must never be recorded as PASS without rendered judgment.",
  };
  await fs.writeFile(path.join(dir, "review.json"), JSON.stringify(run, null, 1) + "\n", { flag: "wx" });
  return run;
}

// ─────────────────────────── receipts ────────────────────────────────────

export interface VisualReceipt {
  source: string;
  revision: string;
  at: number;
  sections: QASection[];
  blocking: number;
  improvements: number;
  note?: string;
}

const VERDICTS = new Set(["PASS", "WARN", "FAIL", "UNKNOWN"]);

/** Validate a recorded verdict. Pure. UNKNOWN sections stay open: recording
 * is evidence of review, not of quality. */
export function normalizeVerdict(raw: unknown): { sections: QASection[]; blocking: number; improvements: number } {
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw new Error("verdict needs 1..16 rubric sections");
  const seen = new Set<string>();
  const sections: QASection[] = raw.map((entry: any, index: number) => {
    const id = String(entry?.id ?? "").trim().slice(0, 64);
    if (!id || seen.has(id)) throw new Error(`verdict[${index}] needs a unique section id`);
    seen.add(id);
    const verdict = String(entry?.verdict ?? "").toUpperCase();
    if (!VERDICTS.has(verdict)) throw new Error(`verdict[${index}] needs verdict PASS|WARN|FAIL|UNKNOWN`);
    const evidence = (Array.isArray(entry?.evidence) ? entry.evidence : []).map((e: unknown) => String(e ?? "").slice(0, 300)).filter(Boolean).slice(0, 8);
    if (!evidence.length) throw new Error(`verdict[${index}] needs at least one evidence line (screenshot coordinates, DOM/component refs, measurements)`);
    return { id, verdict: verdict as QAVerdict, evidence };
  });
  return {
    sections,
    blocking: sections.filter((s) => s.verdict === "FAIL").length,
    improvements: sections.filter((s) => s.verdict === "WARN").length,
  };
}

export function receiptKey(source: string, revision: string): string {
  return `${source}\0${revision}`;
}

/** Verification lines for the completion gate. A receipt blocks only while
 * it is the newest receipt for its source AND carries FAIL sections; a
 * newer clean receipt on the same source resolves it. Pure. */
export function creativeVerificationLines(receipts: readonly VisualReceipt[], direction?: { name: string } | undefined): string[] {
  const lines: string[] = [];
  const newest = new Map<string, VisualReceipt>();
  for (const receipt of receipts) {
    const current = newest.get(receipt.source);
    if (!current || receipt.at >= current.at) newest.set(receipt.source, receipt);
  }
  for (const receipt of [...newest.values()].sort((a, b) => a.source.localeCompare(b.source)).slice(0, 6)) {
    if (receipt.blocking > 0) {
      const ids = receipt.sections.filter((s) => s.verdict === "FAIL").map((s) => s.id).slice(0, 4).join(", ");
      lines.push(`visual review: ${receipt.blocking} blocking finding(s) open on ${receipt.source} (rev ${receipt.revision}): ${ids}`.slice(0, 280));
    }
  }
  if (direction && !receipts.length) lines.push(`creative direction "${direction.name}" is set but no visual review is recorded yet`);
  return lines.slice(0, 8);
}

// ─────────────────────────── creative_compare ────────────────────────────

export interface ComparePlan {
  sources: string[];
  width: number;
  height: number;
}

/** Validate a variant-comparison plan. Pure. */
export function planCompare(params: { sources?: unknown; variants?: unknown; width?: unknown; height?: unknown }): ComparePlan {
  const raw = Array.isArray(params.sources) ? params.sources : Array.isArray(params.variants) ? params.variants : [];
  const sources = [...new Set(raw.map(String).filter(Boolean))].slice(0, 4);
  if (sources.length < 2) throw new Error("creative_compare needs 2..4 variant sources (HTML paths or URLs) rendered at the same width");
  return {
    sources,
    width: Math.max(200, Math.min(2048, Math.round(Number(params.width) || 1280))),
    height: Math.max(200, Math.min(2048, Math.round(Number(params.height) || 800))),
  };
}

export async function creativeCompareRun(
  plan: ComparePlan, cwd: string, signal: AbortSignal | undefined, capture: QACapture, direction?: CreativeDirection,
) {
  const dir = await qaFolder(undefined, cwd, "ui-review", "compare");
  const frames: Array<{ source: string; file: string; img: Rgba }> = [];
  for (let i = 0; i < plan.sources.length; i++) {
    signal?.throwIfAborted();
    const dest = path.join(dir, `variant-${i + 1}.png`);
    await capture({ source: plan.sources[i], width: plan.width, height: plan.height, fullPage: false, timeoutMs: 30_000 }, dest, cwd, signal);
    // Exact decode width guarantees the shared comparison canvas; heights
    // crop to the overlap below.
    const img = await decodeImage(await fs.readFile(dest), { exactWidth: 1280, maxPixels: 6_000_000 }, signal);
    frames.push({ source: plan.sources[i], file: relative(cwd, dest), img });
  }
  const pairs: any[] = [];
  for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
    const height = Math.min(frames[a].img.height, frames[b].img.height);
    const left = cropRgba(frames[a].img, { x: 0, y: 0, width: frames[a].img.width, height });
    const r = cropRgba(frames[b].img, { x: 0, y: 0, width: frames[a].img.width, height });
    const { comparison } = compareImages(left, r);
    const paletteA = extractPalette(left, { max: 6 }).map((c) => hex(c.rgb));
    const paletteB = extractPalette(r, { max: 6 }).map((c) => hex(c.rgb));
    pairs.push({
      variants: [plan.sources[a], plan.sources[b]],
      ssim: Math.round(comparison.ssim * 1000) / 1000,
      changedShare: Math.round(comparison.changed * 1000) / 1000,
      meanDelta: Math.round(comparison.meanDelta * 100) / 100,
      paletteA, paletteB,
    });
  }
  const strip = composeRow(frames.map((f) => f.img), 12);
  const stripPath = path.join(dir, "compare.png");
  await fs.writeFile(stripPath, await encodeImage(strip, "png", { maxWidth: 2400 }, signal), { flag: "wx" });
  const report = {
    at: new Date().toISOString(), width: plan.width, height: plan.height,
    variants: frames.map((f, i) => ({ label: `variant-${i + 1}`, source: f.source, file: f.file })),
    strip: relative(cwd, stripPath), pairs,
    ...(direction ? { direction: directionSummary(direction) } : {}),
    note: "Deltas are structural difference, not quality: SSIM near 1 means near-identical variants (weak divergence), near 0 means unrelated concepts. Judge each variant against the creative brief and synthesize one direction; record it with creative_direct set before building.",
  };
  await fs.writeFile(path.join(dir, "compare.json"), JSON.stringify(report, null, 1) + "\n", { flag: "wx" });
  return { dir: relative(cwd, dir), ...report };
}

/** Palette-similarity helper for direction conformance notes. Pure. */
export function paletteContrastNote(palette: Array<{ hex: string; role: string; contrastOnBackground: number }>): string {
  const text = palette.find((c) => c.role === "text");
  return text ? `text on background ${text.contrastOnBackground}:1` : "no text role measured";
}

export { contrastRatio };
