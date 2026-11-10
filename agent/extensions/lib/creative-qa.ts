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
 * clicking. Open blocking verdicts feed the completion gate.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { normalizeUiSnapshotOptions } from "../../scripts/render-design-state.mjs";

export type QAVerdict = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface QASection {
  id: string;
  verdict: QAVerdict;
  evidence: string[];
  needsVision?: boolean;
}

export interface CaptureParams {
    source: string; width: number; height: number; fullPage: boolean;
    colorScheme?: string; reducedMotion?: string; animationTimeMs?: number;
    timeoutMs?: number; clip?: { y: number; height: number };
    includeState?: boolean; designAudit?: boolean; animationInventory?: boolean;
    deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean;
    scrollCapture?: {positions?: number[]; backtrack?: boolean; settleMs?: number; selectors?: string[]};
    temporalCapture?: {timesMs: number[]; clock?: 'document' | 'render'};
    uiSnapshot?: {groups?: Array<{name: string; selector: string; variant?: string}>; tokens?: string[]};
}
export interface QACapture {
  (params: CaptureParams, destination: string, cwd: string, signal?: AbortSignal): Promise<any>;
}

export const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  narrow: { width: 320, height: 740 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

export const DEVICE_PRESETS: Record<string,{width:number;height:number;deviceScaleFactor:number;hasTouch:boolean;isMobile:boolean}> = {
  'phone-portrait': {width:390,height:844,deviceScaleFactor:2,hasTouch:true,isMobile:true},
  'phone-landscape': {width:844,height:390,deviceScaleFactor:2,hasTouch:true,isMobile:true},
  'tablet-portrait': {width:834,height:1112,deviceScaleFactor:2,hasTouch:true,isMobile:true},
  desktop: {width:1440,height:900,deviceScaleFactor:1,hasTouch:false,isMobile:false},
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
  const output = path.join(parent, `${prefix}-${randomBytes(5).toString("hex")}`);
  const denial = selfMutationDenial(output, root);
  if (denial) throw new Error(denial);
  // A missing workspace folder is created rather than failing the capture
  // with a raw ENOENT the agent then has to diagnose and retry.
  await fs.mkdir(parent, { recursive: true });
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Output directory is not a directory");
  await fs.mkdir(output, { mode: 0o700 });
  return output;
}

/** A local render source as a filesystem path. A `file:` URL is decoded
 * (measured: `file:///…/fixture.html#idle` was joined onto the cwd); its
 * query and fragment stay on the page URL, where scripts read them. */
export function localRenderPath(cwd: string, source: string): string {
  if (/^file:/i.test(source)) {
    const url = new URL(source), suffix = url.search + url.hash;
    url.hash = ""; url.search = "";
    return fileURLToPath(url) + suffix;
  }
  return path.resolve(cwd, source.replace(/^@/, ""));
}
/** Revision of a review source: content hash for local files (bounded),
 * so edits invalidate receipts; URLs hash to "live" and always re-verify. */
export async function sourceRevision(source: string, cwd: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) return "live";
  try {
    let file = localRenderPath(cwd, source),stat;
    try {stat=await fs.stat(file);}
    catch(error:any) {
      const suffix=file.search(/[?#]/);
      if(error.code!=='ENOENT'||suffix<0||!/\.html?$/i.test(file.slice(0,suffix)))throw error;
      file=file.slice(0,suffix);stat=await fs.stat(file);
    }
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
  deviceScaleFactor: number;
  hasTouch: boolean;
  isMobile: boolean;
  breakpoint?: number;
}

export interface UiMatrixPlan {
  cells: MatrixCell[];
  capped: boolean;
  requested: number;
  omitted: Array<{viewport:string;state:string}>;
}

const MATRIX_MAX_CELLS = 12;

/** Expand viewports × states into a bounded capture plan. Pure. States:
 * default, dark (color-scheme), reduced-motion, full (full-page). */
export function planUiMatrix(params: {
  viewports?: unknown; states?: unknown; widths?: unknown; devices?: unknown; breakpoints?: unknown; colorScheme?: unknown; reducedMotion?: unknown; fullPage?: unknown;
}): UiMatrixPlan {
  if (params.devices !== undefined && (!Array.isArray(params.devices) || !params.devices.length || params.devices.length > 4 || params.devices.some(v=>typeof v !== 'string' || !DEVICE_PRESETS[v]))) throw Error('devices requires 1..4 known device profiles');
  if (params.breakpoints !== undefined && (!Array.isArray(params.breakpoints) || params.breakpoints.length > 4 || params.breakpoints.some(w=>!Number.isInteger(w)||w<201||w>2047))) throw Error('breakpoints requires at most 4 integer widths in 201..2047');
  if (params.widths !== undefined && (!Array.isArray(params.widths) || params.widths.length > 4 || params.widths.some(w=>!Number.isInteger(w)||w<200||w>2048))) throw Error('widths requires at most 4 integer widths in 200..2048');
  const viewportNames = (Array.isArray(params.viewports) ? params.viewports : ["narrow", "mobile", "tablet", "desktop"]).map(String).filter((v) => VIEWPORT_PRESETS[v]);
  const viewports = [...new Set(params.devices ? (params.viewports ? viewportNames : []) : viewportNames.length ? viewportNames : ["desktop"])];
  const profiles = new Map<string,any>();
  for (const viewport of viewports) profiles.set(viewport,{...VIEWPORT_PRESETS[viewport],deviceScaleFactor:1,hasTouch:false,isMobile:false});
  for (const device of (params.devices as string[] ?? [])) profiles.set(device,{...DEVICE_PRESETS[device]});
  if (Array.isArray(params.widths)) {
    for (const width of params.widths) if (![...profiles.values()].some(profile => profile.width === width && profile.deviceScaleFactor === 1 && !profile.hasTouch && !profile.isMobile))
      profiles.set(`w${width}`,{width,height:900,deviceScaleFactor:1,hasTouch:false,isMobile:false});
  }
  for (const breakpoint of [...new Set(params.breakpoints as number[] ?? [])]) for (const width of [breakpoint-1,breakpoint,breakpoint+1])
    profiles.set(`b${breakpoint}-w${width}`,{width,height:900,deviceScaleFactor:1,hasTouch:false,isMobile:false,breakpoint});
  const wantStates = new Set((Array.isArray(params.states) ? params.states : ["default"]).map(String));
  if (params.colorScheme === "dark" || wantStates.has("dark")) wantStates.add("dark");
  if (params.reducedMotion === true || wantStates.has("reduced-motion")) wantStates.add("reduced-motion");
  if (params.fullPage === true || wantStates.has("full")) wantStates.add("full");
  wantStates.add("default");
  const cells: MatrixCell[] = [];
  // Cover every requested width before spending the capture budget on variants.
  for (const state of ["default", "dark", "reduced-motion", "full"]) {
    if (!wantStates.has(state)) continue;
    for (const [viewport,preset] of profiles) {
      cells.push({
        viewport, width: preset.width, height: preset.height, state,
        colorScheme: state === "dark" ? "dark" : "light",
        reducedMotion: state === "reduced-motion" ? "reduce" : "no-preference",
        fullPage: state === "full",
        file: `${viewport}-${state}.png`,
        deviceScaleFactor:preset.deviceScaleFactor,hasTouch:preset.hasTouch,isMobile:preset.isMobile,
        ...(preset.breakpoint ? {breakpoint:preset.breakpoint} : {}),
      });
    }
  }
  const capped = cells.length > MATRIX_MAX_CELLS;
  if (!capped) return {cells,capped,requested:cells.length,omitted:[]};
  return {cells:cells.slice(0,MATRIX_MAX_CELLS),capped,requested:cells.length,omitted:cells.slice(MATRIX_MAX_CELLS).map(({viewport,state})=>({viewport,state}))};
}

export interface PageStateSummary {
  documentType?: string;
  available: boolean;
  items: number;
  overflowElements: number;
  scopeOverflowPx: number;
  missingAlt: number;
  images: number;
  controls: number;
  unnamedControls: number;
  smallTargets: number;
  brokenImages: number;
  truncated: boolean;
}

/** Bounded roll-up of render page-state DOM facts. Pure. Overflow may be
 * intentional (carousels, menus); counts select inspection targets. */
export function summarizePageState(pageState: any): PageStateSummary {
  const items = Array.isArray(pageState?.items) ? pageState.items : [];
  let overflowElements = 0, missingAlt = 0, images = 0, controls = 0, unnamedControls = 0, smallTargets = 0, brokenImages = 0;
  for (const item of items.slice(0, 500)) {
    if (typeof item?.horizontalOverflowPx === "number" && item.horizontalOverflowPx > 1) overflowElements++;
    if (item?.tag === "img" || item?.kind === "img" || item?.role === "img") {
      images++;
      if (item?.alt === null || item?.alt === undefined) missingAlt++;
      if (item?.image?.loadState === "unavailable") brokenImages++;
    }
    if (/^(?:button|input|select|textarea)$/.test(item?.tag ?? "") || item?.tag === "a" && item?.target || /^(?:button|link|checkbox|radio|textbox|combobox|menuitem|tab|switch|slider)$/.test(item?.role ?? "")) {
      controls++;
      if (!String(item?.name ?? item?.label ?? "").trim()) unnamedControls++;
      if (item?.disabled !== true && item?.bounds?.width > 0 && item?.bounds?.height > 0 && (item.bounds.width < 24 || item.bounds.height < 24)) smallTargets++;
    }
  }
  return {
    ...(typeof pageState?.documentType === 'string' ? { documentType: pageState.documentType } : {}),
    available: Array.isArray(pageState?.items), items: items.length,
    overflowElements,
    scopeOverflowPx: Math.max(0, Math.round(Number(pageState?.layout?.horizontalOverflowPx ?? pageState?.layout?.scopeHorizontalOverflowPx ?? pageState?.scopeHorizontalOverflowPx) || 0)),
    missingAlt, images, controls, unnamedControls, smallTargets, brokenImages,
    truncated: pageState?.truncated === true,
  };
}

export function summarizeNoise(noise: any): Array<{ key: string; detail: string }> {
  const findings = Array.isArray(noise?.findings) ? noise.findings : [];
  return findings.slice(0, 24).map((f: any) => ({
    key: String(f?.kind ?? f?.key ?? f?.id ?? "finding").slice(0, 80),
    detail: String(f?.detail ?? f?.message ?? f?.selector ?? "").slice(0, 240),
  }));
}

const OWN_CELL_KEYS = new Set(['viewport', 'width', 'height', 'state', 'file', 'ok']);
const isPlain = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
function sameValue(a: any, b: any): boolean {
  if (a === b || !a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const keys = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && keys.length === Object.keys(b).length
    && keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}
function prune(node: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    const value = isPlain(v) ? prune(v) : v;
    const empty = v === 0 || v === null || (Array.isArray(v) && v.length === 0) || (isPlain(value) && Object.keys(value).length === 0);
    if (!empty) out[k] = value;
  }
  return out;
}
const collect = (value: any, into: Set<string>) => { for (const text of [value].flat()) if (text) into.add(String(text)); };
function tidyDesign(design: any, texts: Set<string>): any {
  const facts: any = { ...design };
  collect(facts.limitations, texts);
  for (const key of ['typography', 'spacing', 'limitations', 'limits', 'version', 'viewport']) delete facts[key];
  if (isPlain(facts.svg)) { facts.svg = { ...facts.svg }; collect(facts.svg.limitations, texts); delete facts.svg.limitations; }
  return prune(facts);
}
function tidyMeasures(node: any, texts: Set<string>): any {
  const out = { ...node };
  if (isPlain(out.dom)) out.dom = prune(out.dom);
  if (isPlain(out.design)) out.design = tidyDesign(out.design, texts);
  return out;
}
// Keys every item shares: equal values, or the equal sub-keys of objects that differ.
function commonPart(items: any[], top = true): Record<string, any> {
  const shared: Record<string, any> = {};
  for (const key of Object.keys(items[0])) {
    if ((top && OWN_CELL_KEYS.has(key)) || !items.every((item) => Object.hasOwn(item, key))) continue;
    const values = items.map((item) => item[key]);
    if (values.every((v) => sameValue(v, values[0]))) shared[key] = values[0];
    else if (values.every(isPlain)) {
      const part = commonPart(values, false);
      if (Object.keys(part).length) shared[key] = part;
    }
  }
  return shared;
}
function withoutShared(item: any, shared: any): any {
  const out: any = {};
  for (const [key, value] of Object.entries(item)) {
    if (!Object.hasOwn(shared, key)) out[key] = value;
    else if (isPlain(value) && !sameValue(value, shared[key])) {
      const rest = withoutShared(value, shared[key]);
      if (Object.keys(rest).length) out[key] = rest;
    }
  }
  return out;
}

/** Compact reply for the model: keeps decisions, failures, coverage, truncation,
 * findings and provenance. Zeros and empty lists go, each limitation text is listed
 * once, and ui_explore moves what every successful viewport shares into `shared`,
 * so the reply stays small. The full report on disk keeps everything. */
export function compactQAResult(tool: string, result: any): any {
  if (!result || (tool !== 'ui_explore' && tool !== 'visual_review')) return result;
  if (tool === 'visual_review' && !result.runId) return result;
  const texts = new Set<string>();
  const { at, previewOrder, responsiveHash, detail, measurementLimitations, loaded, ...top } = result;
  if (top.initialRevision === top.revision) delete top.initialRevision;
  if (top.sourceChanged === false) delete top.sourceChanged;
  if (top.plan && top.plan.capped !== true && !top.plan.omitted?.length) delete top.plan;
  const out = tidyMeasures(top, texts);
  if (Array.isArray(top.cells)) {
    const ok = (cell: any) => cell?.ok === true;
    const filled = (cell: any) => Object.fromEntries(Object.entries(cell).filter(([, value]) => !(Array.isArray(value) && !value.length)));
    const good = top.cells.filter(ok).map(({ typography, bytes, pixels, device, ...cell }: any) => filled(tidyMeasures(cell, texts)));
    const shared = good.length >= 2 ? commonPart(good) : {};
    let next = 0;
    out.cells = top.cells.map((cell: any) => (ok(cell) ? withoutShared(good[next++], shared) : cell));
    if (Object.keys(shared).length) out.shared = shared;
  }
  if (texts.size) out.measurementLimitations = [...texts];
  out.detail = tool === 'ui_explore'
    ? 'Measurements leave out zero counts and empty lists; shared holds what every captured viewport has in common. Typography and spacing tables are in the report file; detail:true returns everything.'
    : 'Measurements leave out zero counts and empty lists. Typography and spacing tables are in the report file; detail:true returns everything.';
  return out;
}

/** Caveats that stand for every capture are said once per conversation. `said` holds the texts
 * already sent; a later reply carries only the new ones and a short pointer to the rest. The
 * caller empties `said` when the conversation is compacted, so they are said once more. */
export function onceStanding(reply: any, said: Set<string>): any {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  const out = { ...reply };
  if (Array.isArray(out.measurementLimitations)) {
    const fresh = out.measurementLimitations.filter((text: unknown) => typeof text === 'string' && !said.has(text));
    for (const text of fresh) said.add(text);
    if (fresh.length < out.measurementLimitations.length) out.measurementLimitations = fresh.length ? [...fresh, 'The rest as stated in earlier replies.'] : 'As stated in earlier replies.';
  }
  if (typeof out.detail === 'string') { if (said.has(out.detail)) delete out.detail; else said.add(out.detail); }
  return out;
}

export async function uiExploreRun(
  params: { source: string; viewports?: unknown; states?: unknown; widths?: unknown; devices?: unknown; breakpoints?: unknown; colorScheme?: unknown; reducedMotion?: unknown; fullPage?: unknown; outputDir?: unknown },
  cwd: string, signal: AbortSignal | undefined, capture: QACapture,
) {
  if (typeof params.source !== "string" || !params.source) throw new Error("ui_explore needs a source (local HTML/SVG path or http(s) URL)");
  const plan = planUiMatrix(params);
  signal?.throwIfAborted();
  const initialRevision = await sourceRevision(params.source,cwd);
  const dir = await qaFolder(params.outputDir, cwd, "ui-review", "matrix");
  const cells: any[] = [];
  // The local files these captures asked for; undefined once one capture cannot say (a page over HTTP, a failed capture).
  let loaded: Set<string> | undefined = new Set();
  for (const cell of plan.cells) {
    signal?.throwIfAborted();
    const dest = path.join(dir, cell.file);
    let receipt: any;
    try {
      receipt = await capture({
        source: params.source, width: cell.width, height: cell.height, fullPage: cell.fullPage,
        colorScheme: cell.colorScheme, reducedMotion: cell.reducedMotion, timeoutMs: 30_000,
        deviceScaleFactor:cell.deviceScaleFactor,hasTouch:cell.hasTouch,isMobile:cell.isMobile,
        includeState: true, designAudit: true,
      }, dest, cwd, signal);
    } catch (error: any) {
      if (signal?.aborted) throw error;
      cells.push({ ...cell, file: relative(cwd, dest), ok: false, error: String(error?.message ?? error).slice(0, 300) });
      loaded = undefined;
      continue;
    }
    if (loaded && Array.isArray(receipt?.localFiles)) for (const file of receipt.localFiles) loaded.add(file);
    else loaded = undefined;
    const stat = await fs.stat(dest).catch(() => undefined);
    cells.push({
      ...cell, file: relative(cwd, dest), ok: true,
      bytes: stat?.size ?? 0, pixels: { width: receipt?.width ?? 0, height: receipt?.height ?? 0 },
      documentSha256:receipt?.conditions?.documentSha256 ?? null,device:receipt?.conditions?.deviceObserved ?? null,
      ...(receipt?.conditions?.captureFallback ? { captureFallback: receipt.conditions.captureFallback } : {}),
      dom: summarizePageState(receipt?.pageState),
      design: receipt?.pageState?.design ?? null,
      typography:(receipt?.pageState?.design?.typography ?? []).slice(0,5),
      noise: summarizeNoise(receipt?.noise),
      inspectionIncomplete: receipt?.noise?.truncated === true || receipt?.noise?.status === 'unavailable',
      errors: Array.isArray(receipt?.errors) ? receipt.errors.slice(0, 6) : [],
    });
  }
  const overflowCells = cells.filter((c) => c.ok && (c.dom.overflowElements > 0 || c.dom.scopeOverflowPx > 0));
  const altCells = cells.filter((c) => c.ok && c.dom.missingAlt > 0);
  const failed = cells.filter((c) => !c.ok);
  const revision = await sourceRevision(params.source, cwd), sourceChanged = initialRevision !== revision;
  const consistent = !sourceChanged && revision !== "missing" && !revision.startsWith("unhashed-");
  const incomplete = !consistent || plan.capped || cells.some(c => c.ok && (!c.dom.available || !c.design || c.dom.truncated || c.design.truncated || c.inspectionIncomplete || c.captureFallback?.incomplete));
  const defects = cells.filter(c => c.ok && (c.dom.brokenImages || c.dom.missingAlt || c.design?.contrast?.belowThreshold || c.design?.svg?.unresolvedRefs || c.design?.svg?.duplicateIds));
  const previewCells = cells.filter(c => c.ok);
  let preview: string | undefined;
  if (previewCells.length) {
    const rows: Rgba[] = [];
    for (let start = 0; start < previewCells.length; start += 4) {
      const images: Rgba[] = [];
      for (const cell of previewCells.slice(start, start + 4)) images.push(await decodeImage(await fs.readFile(path.resolve(cwd, cell.file)), { maxWidth: 480, maxPixels: 240_000 }, signal));
      rows.push(composeRow(images, 12));
    }
    const width = Math.max(...rows.map(row => row.width)), height = rows.reduce((sum, row) => sum + row.height, 0) + (rows.length - 1) * 12;
    if (width * height > 8_000_000) throw Error('Responsive contact sheet exceeds its pixel bound; use fewer states and inspect saved captures individually.');
    const data = new Uint8Array(width * height * 4).fill(245);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    let y = 0;
    for (const row of rows) {
      for (let line = 0; line < row.height; line++) data.set(row.data.subarray(line * row.width * 4, (line + 1) * row.width * 4), ((y + line) * width) * 4);
      y += row.height + 12;
    }
    const dest = path.join(dir, 'viewports.png');
    await fs.writeFile(dest, await encodeImage({ width, height, data }, 'png', { maxWidth: 1920 }, signal), { flag: 'wx' });
    preview = relative(cwd, dest);
  }
  // One line per distinct fact, naming every capture it holds for: the same missing alt text at four widths is one finding.
  const facts = new Map<string, string[]>();
  const fact = (cell: MatrixCell, text: string) => facts.set(text, [...(facts.get(text) ?? []), `${cell.viewport}/${cell.state}`]);
  for (const c of overflowCells) fact(c, `horizontal overflow on ${c.dom.overflowElements} element(s), scope ${c.dom.scopeOverflowPx}px; inspect the capture (overflow may be intentional)`);
  for (const c of altCells) fact(c, `${c.dom.missingAlt} of ${c.dom.images} sampled image(s) without alt text`);
  for (const c of cells) {
    if (!c.ok) continue;
    if (c.dom.brokenImages) fact(c, `${c.dom.brokenImages} sampled image(s) failed to load`);
    if (c.design?.contrast?.belowThreshold) fact(c, `${c.design.contrast.belowThreshold} measured solid-text contrast failure(s)`);
    if (c.design?.svg?.unresolvedRefs || c.design?.svg?.duplicateIds) fact(c, `inline SVG has ${c.design.svg.unresolvedRefs} unresolved reference(s) and ${c.design.svg.duplicateIds} duplicate id(s)`);
    if (c.dom.unnamedControls) fact(c, `${c.dom.unnamedControls} sampled control(s) without a DOM-derived name; inspect accessible names`);
    if (c.dom.smallTargets) fact(c, `${c.dom.smallTargets} target(s) below 24 CSS px; check spacing, inline/equivalent/native-control exceptions before judging WCAG 2.5.8`);
  }
  const report = {
    source: params.source, revision, initialRevision, sourceChanged, consistent, at: new Date().toISOString(),
    status: failed.length || defects.length ? "fail" : incomplete ? "incomplete" : cells.some(c => c.dom.scopeOverflowPx || c.dom.overflowElements || c.dom.unnamedControls || c.dom.smallTargets || c.noise.length || c.errors.length) ? "warn" : "measured",
    coverage: { widths: cells.filter(c => c.ok).map(c => c.width).filter((w, i, all) => all.indexOf(w) === i), requested: plan.requested, captured: cells.filter(c => c.ok).length, complete: !incomplete && !failed.length && !cells.some(c => c.ok && c.errors.length), visualJudgment: "pending", interaction: "pending" },
    preview, previewOrder: previewCells.map((c, i) => ({ viewport: c.viewport, state: c.state, width: c.width, file: c.file, row: Math.floor(i / 4), column: i % 4 })),
    plan: { cells: plan.cells.length, requested: plan.requested, capped: plan.capped, omitted: plan.omitted, note: plan.capped ? `Matrix capped at ${MATRIX_MAX_CELLS} captures; omitted combinations remain unverified. Run again with narrower viewports/states.` : undefined },
    cells,
    findings: [
      ...[...facts].map(([text, where]) => `${where.join(", ")}: ${text}`),
      ...(!consistent ? ["Source changed during capture or its revision is unavailable; re-capture the final revision"] : []),
      ...failed.map((c) => `${c.viewport}/${c.state}: capture failed — ${c.error}`),
    ].slice(0, 24),
    note: "The contact sheet shows every capture in row and column order; open a full-size PNG for small text. Pixels and DOM facts are not interaction proof: keyboard, focus, hover and loading, empty or error states need browser_session. Content stress (long titles, missing images, many items, right-to-left text) is not applied here.",
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 1) + "\n", { flag: "wx" });
  return { dir: relative(cwd, dir), report: relative(cwd, path.join(dir, "report.json")), ...report, ...(loaded ? { loaded: [...loaded] } : {}) };
}

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
  responsive?: { widths: number[]; status: string; findings: string[]; imageHash: string; file?: string };
}

/** Capture plus deterministic measurements and a rubric skeleton. Returns
 * sections with deterministic verdicts where measurement suffices and
 * needsVision gaps elsewhere; the caller attaches pixels for vision models
 * and the agent records the judged verdict. */
export async function visualReviewRun(options: VisualRunOptions, cwd: string, signal: AbortSignal | undefined, capture: QACapture) {
  const before = await sourceRevision(options.source, cwd);
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

  // Pixel palette roles are estimates; a photo must not fail text contrast.
  const design = receipt?.pageState?.design;
  const lowContrast = (design?.findings ?? []).filter((f: any) => f.kind === "solid-text-contrast");
  push("accessibility", lowContrast.length || dom.missingAlt || dom.brokenImages ? "FAIL" : "UNKNOWN", [
    ...lowContrast.map((f: any) => `${f.selector}: ${f.ratio}:1 below ${f.threshold}:1`),
    ...(dom.missingAlt ? [`${dom.missingAlt} sampled image(s) without alt text`] : []),
    `${dom.brokenImages} sampled broken images; ${dom.unnamedControls} controls need accessible-name inspection`,
    "Keyboard, focus, complex paint and unsampled states require separate checks; no sampled defect is not accessibility proof",
  ]);

  const spacingValues = [...new Set(rhythm.values.map((v) => Math.round(v)).filter((v) => v > 2))];
  push("spacing", spacingValues.length > 6 ? "WARN" : "PASS", [
    `${spacingValues.length} distinct spacing values in view (${spacingValues.slice(0, 10).join(", ") || "none measured"}); unit ~${rhythm.unit}px from ${rhythm.samples} samples`,
    ...(spacingValues.length > 6 ? ["many unrelated spacing values compete; check against the spacing scale"] : []),
  ]);

  const textStyles = Array.isArray(design?.typography) ? design.typography : [];
  const measuredSizes = [...new Set<number>(textStyles.map((style:any) => style.sizePx).filter((size:any) => typeof size === 'number' && Number.isFinite(size)))].sort((a,b)=>a-b);
  push("typography", "UNKNOWN", [
    measuredSizes.length ? `${measuredSizes.length} sampled text sizes: ${measuredSizes.map(size=>`${size}px`).join(', ')}; ${design.textElements ?? '?'} text-bearing elements` : `No computed text scale available; ${typeLevels.length} pixel-ink clusters are estimates and may include illustration or controls`,
    ...(design?.truncated ? ['Computed-style coverage is bounded or truncated; omitted styles remain unknown'] : []),
    'Judge reading hierarchy, line length, line height, font roles and intended density against this product. Font-count thresholds and empty wrappers cannot establish typography quality.',
  ], true);

  push("composition", dominant.share >= 55 ? "WARN" : "PASS", [
    `ink share by quadrant: ${quads.map((q) => `${q.quadrant} ${q.share}%`).join(", ")}`,
    ...(dominant.share >= 55 ? [`visual mass strongly biased ${dominant.quadrant}; verify the focal element owns it`] : []),
  ], true);

  const slopSignals = noise.map((n) => `${n.key}: ${n.detail}`);
  push("slop", noise.length >= 6 ? "WARN" : noise.length ? "WARN" : "PASS", [
    `${noise.length} rendered-pattern finding(s)${noise.length ? `: ${noise.slice(0, 6).map((n) => n.key).join("; ")}` : ""}`,
    ...(noise.length ? ["pattern hits are advisory: legitimate semantic status and justified single treatments are exempt"] : []),
  ], true);

  push("hierarchy", "UNKNOWN", ["focal competition needs rendered judgment: does one element own the first viewport, or do hero and secondary cards compete equally?"], true);
  push("distinctiveness", "UNKNOWN", [
    "resemblance to generic template patterns needs rendered judgment against the brief and named peers",
    ...(noise.length ? [`${noise.length} advisory pattern hit(s) available above for the boilerplate check`] : []),
  ], true);
  if (/^(text\/html|application\/xhtml\+xml)$/.test(dom.documentType ?? '') || /\.html?(?:[?#].*)?$/i.test(options.source)) push('responsive', options.responsive?.status === 'fail' ? 'FAIL' : 'UNKNOWN', [
    options.responsive ? `Current matrix: ${[...new Set(options.responsive.widths)].join(', ')} CSS px; ${options.responsive.status}; inspect ${options.responsive.file ?? 'the contact sheet'}` : 'No current responsive matrix; run ui_explore and inspect its contact sheet before recording this section',
    ...(options.responsive?.findings ?? []),
    'Judge narrow layout, breakpoint composition, clipped content, readable labels and intended scroll regions from the matrix pixels; a desktop capture cannot approve mobile appearance',
  ], true);
  if (design?.svg?.sampled) push('svg', design.svg.unresolvedRefs || design.svg.duplicateIds ? 'FAIL' : 'UNKNOWN', [
    `${design.svg.sampled} inline SVG(s): ${design.svg.missingViewBox} missing viewBox, ${design.svg.unresolvedRefs} unresolved refs, ${design.svg.duplicateIds} duplicate IDs, ${design.svg.clippingCandidates} fill-clipping candidates`,
    'Inspect intended-size legibility, stroke/corner consistency, optical mass and background/theme contrast; fill bounds exclude stroke/filter paint',
  ], true);

  if (options.direction) {
    const hits = matchAvoidSignals(options.direction, [...slopSignals, ...lowContrast.map((c: any) => `low contrast ${c.ratio}:1 at ${c.selector}`)]);
    // What measurement cannot decide: is the chosen signature actually there, and does an immersive page hold together.
    const judged = [
      ...(options.direction.signature ? [`signature "${options.direction.signature}" must be visible in this render; a still frame shows it, motion needs two captures apart`] : []),
      ...(options.direction.ambition === "immersive" ? ["ambition immersive: judge coherence (one world model, every layer with a job, a fallback for reduced motion and no WebGL), not element count"] : []),
    ];
    push("direction", hits.length ? "WARN" : "PASS", [
      `direction "${directionSummary(options.direction)}"`,
      ...hits.slice(0, 6).map((h) => `avoid "${h.avoid}" ↔ ${h.signal}`),
      ...(hits.length ? ["avoid-list hits are possible boilerplate, not automatic failures: the reviewer decides whether each is justified"] : ["no avoid-list pattern hit in deterministic signals"]),
      ...judged,
    ], hits.length > 0 || judged.length > 0);
  }

  const run = {
    runId: randomUUID(), source: options.source, revision: await sourceRevision(options.source, cwd), at: new Date().toISOString(),
    file: relative(cwd, dest), dir: relative(cwd, dir),
    pixels: { width: receipt?.width ?? 0, height: receipt?.height ?? 0 },
    palette: palette.slice(0, 8).map((c) => `${c.role}: ${c.hex} (${c.contrastOnBackground}:1)`),
    dom, design, noise: noise.slice(0, 12), errors: receipt?.errors ?? [],
    ...(options.responsive ? { responsiveHash: options.responsive.imageHash } : {}),
    sections: sectionsOut,
    blocking: sectionsOut.filter((s) => s.verdict === "FAIL").length,
    next: "Judge the needsVision sections from the attached pixels (or open the capture), then record the verdict with visual_review action record. Deterministic PASS/FAIL stands unless the pixels prove otherwise; UNKNOWN must never be recorded as PASS without rendered judgment. A page with controls also needs a key press and a matching verify in browser_session: open the same file there by its path.",
  };
  Object.assign(run, { consistent: before === run.revision && run.revision !== "missing" && !run.revision.startsWith("unhashed-") });
  await fs.writeFile(path.join(dir, "review.json"), JSON.stringify(run, null, 1) + "\n", { flag: "wx" });
  return { ...run, report: relative(cwd, path.join(dir, "review.json")), ...(Array.isArray(receipt?.localFiles) ? { loaded: receipt.localFiles as string[] } : {}) };
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
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw new Error('record needs verdict: one entry for each rubric section that run returned, as [{ id: "spacing", verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN", evidence: ["what was seen"] }]');
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
    blocking: sections.filter((s) => s.verdict === "FAIL" || s.verdict === "UNKNOWN").length,
    improvements: sections.filter((s) => s.verdict === "WARN").length,
  };
}

export function receiptKey(source: string, revision: string): string {
  return `${source}\0${revision}`;
}

/** Verification lines for the completion gate. A receipt blocks only while
 * it is the newest receipt for its source AND carries FAIL sections; a
 * newer clean receipt on the same source resolves it. Pure. */
export function creativeVerificationLines(receipts: readonly VisualReceipt[], direction?: { name: string } | undefined, mediaReviewed = false): string[] {
  const lines: string[] = [];
  const newest = new Map<string, VisualReceipt>();
  for (const receipt of receipts) {
    const current = newest.get(receipt.source);
    if (!current || receipt.at >= current.at) newest.set(receipt.source, receipt);
  }
  for (const receipt of [...newest.values()].sort((a, b) => a.source.localeCompare(b.source)).slice(0, 6)) {
    if (receipt.blocking > 0) {
      const ids = receipt.sections.filter((s) => s.verdict === "FAIL" || s.verdict === "UNKNOWN").map((s) => s.id).slice(0, 4).join(", ");
      lines.push(`visual review: ${receipt.blocking} blocking finding(s) open on ${receipt.source} (rev ${receipt.revision}): ${ids}`.slice(0, 280));
    }
  }
  if (direction && !receipts.length && !mediaReviewed) lines.push(`creative direction "${direction.name}" is set but no visual review is recorded yet`);
  return lines.slice(0, 8);
}

export { contrastRatio };
