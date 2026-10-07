/** SVG review and optimization on top of `svg-inspect.ts`, which owns the
 * measurements (geometry, bounds, strokes, ids, active content, set
 * comparison): a verdict with fixes for the file side of the `svg-assessment`
 * checklist, and a lossless optimizer verified against those measurements.
 * Source text only: nothing is rendered, so appearance still needs a look. */
import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "htmlparser2";
import { studioFolder } from "./design-studio.ts";
import { measureSvg, readSvg, type SvgMeasure } from "./svg-inspect.ts";

export type SvgSeverity = "high" | "medium" | "low";
export interface SvgFinding { rule: string; severity: SvgSeverity; message: string; fix: string; count?: number; bytes?: number; }
const MAX_BYTES = 2 * 1024 * 1024;
const rank: Record<SvgSeverity, number> = { high: 3, medium: 2, low: 1 };

// ───────────────────────────── path data ─────────────────────────────

type Segment = { cmd: string; args: number[] };
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
/** Parse path data into segments; undefined when the data is not well formed (callers leave it untouched). */
export function parsePath(d: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let i = 0, cmd = "";
  const whitespace = () => { while (i < d.length && /[ \t\r\n]/.test(d[i])) i++; };
  while (whitespace(), i < d.length) {
    const explicit = /[A-Za-z]/.test(d[i]);
    if (explicit) { cmd = d[i++]; if (!(cmd.toLowerCase() in ARITY)) return undefined; if (cmd.toLowerCase() === "z") { segments.push({ cmd, args: [] }); cmd = ""; continue; } }
    else if (!cmd) return undefined;
    const lower = cmd.toLowerCase(), args: number[] = [];
    for (let k = 0; k < ARITY[lower]; k++) {
      whitespace();
      if (d[i] === ',') {
        // A single comma separates arguments or repeated argument groups.
        // It cannot begin a command, repeat, or trail a completed path.
        if (explicit && k === 0) return undefined;
        i++; whitespace();
        if (i === d.length || d[i] === ',' || /[A-Za-z]/.test(d[i])) return undefined;
      }
      const flag = lower === "a" && (k === 3 || k === 4);
      if (flag) { if (d[i] !== "0" && d[i] !== "1") return undefined; args.push(Number(d[i++])); continue; }
      const m = NUMBER.exec(d.slice(i));
      if (!m || !Number.isFinite(Number(m[0]))) return undefined;
      args.push(Number(m[0])); i += m[0].length;
    }
    segments.push({ cmd, args });
    // Implicit repeats: extra pairs after a moveto are linetos.
    if (lower === "m") cmd = cmd === "m" ? "l" : "L";
  }
  return segments;
}
const trim = (value: number, precision: number) => {
  let text = value.toFixed(precision).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (text === "-0" || text === "") text = "0";
  return text.replace(/^(-?)0\./, "$1.");
};
/** Re-serialize path data with fewer decimals and minimal separators. */
export function compactPath(d: string, precision = 3): string {
  const segments = parsePath(d);
  if (!segments) return d;
  let out = "", previous = "";
  for (const { cmd, args } of segments) {
    out += cmd;
    previous = "";
    args.forEach((value, index) => {
      const flag = cmd.toLowerCase() === "a" && (index === 3 || index === 4);
      const text = flag ? String(value) : trim(value, precision);
      if (previous && !(text.startsWith("-") && !flag) && !(text.startsWith(".") && previous.includes(".") && !flag)) out += " ";
      out += text; previous = flag ? "" : text;
      if (flag) previous = "f";
    });
  }
  return out;
}
// ───────────────────────────── analysis ─────────────────────────────

const EDITOR_NS = /^(?:sodipodi|inkscape|sketch|serif|i|x|ns\d*|cc|dc|rdf):/i;
const NAMED_COLOR = /^(?:black|white|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|maroon|lime|aqua|fuchsia|olive|cyan|magenta)$/i;
const GENERATED_ID = /^(?:svg|path|g|rect|circle|ellipse|line|polygon|polyline|use|mask|clipPath|linearGradient|radialGradient|filter|defs|text|tspan|image|layer|group|shape|vector|artboard)[-_]?\d+(?:[-_]\d+)?$|^(?:Layer|Group|Path|Shape|Rectangle|Oval|Combined-Shape|Page|Artboard|Fill|Stroke)[-_ ]?\d*$/i;
const DEFAULTS: Record<string, string> = { "fill-rule": "nonzero", "clip-rule": "nonzero", "fill-opacity": "1", "stroke-opacity": "1", opacity: "1", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dashoffset": "0" };
const REFERENCEABLE = new Set(["lineargradient", "radialgradient", "filter", "clippath", "mask", "symbol", "pattern", "marker"]);
/** A paint value worth counting as a colour: hex, rgb/hsl, a named colour or currentColor. */
const colorOf = (value: string): string | undefined => {
  const v = value.trim().toLowerCase();
  if (v === "currentcolor") return "currentColor";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) return "#" + (hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1]);
  return /^(?:rgba?|hsla?)\(/.test(v) || NAMED_COLOR.test(v) ? v.replace(/\s+/g, "") : undefined;
};
const bytesOf = (text: string) => Buffer.byteLength(text);

interface Removal { start: number; end: number; kind: "comment" | "metadata" | "editor" | "unused-def" | "empty" | "prolog"; }

/** Every byte range a lossless clean-up may remove, from the parsed document. */
function removals(source: string, doc: any): Removal[] {
  const out: Removal[] = [];
  for (const m of source.matchAll(/<\?xml[^>]*\?>\s*|<!DOCTYPE[^>]*>\s*/gi)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: "prolog" });
  for (const m of source.matchAll(/<!--[\s\S]*?-->\s*/g)) if (!/\b(?:license|copyright|SPDX|@preserve)\b/i.test(m[0]) && !m[0].startsWith("<!--!")) out.push({ start: m.index!, end: m.index! + m[0].length, kind: "comment" });
  const referenced = new Set<string>();
  for (const m of source.matchAll(/url\(\s*['"]?#([^)'"\s]+)|href\s*=\s*["']#([^"']+)|(?:begin|end)\s*=\s*["']([\w-]+)\./g)) referenced.add(m[1] ?? m[2] ?? m[3]);
  const styleText = (source.match(/<style[\s\S]*?<\/style>/gi) ?? []).join(" ");
  const walk = (node: any) => {
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
    const name = node.name.toLowerCase();
    const at = { start: node.startIndex as number, end: (node.endIndex as number) + 1 };
    if (name === "metadata" || EDITOR_NS.test(node.name)) { out.push({ ...at, kind: name === "metadata" ? "metadata" : "editor" }); return; }
    const id = node.attribs?.id;
    if (REFERENCEABLE.has(name) && id && !referenced.has(id) && !new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(styleText)) { out.push({ ...at, kind: "unused-def" }); return; }
    if ((name === "g" || name === "defs") && !(node.children ?? []).some((child: any) => child.type === "tag" || (child.type === "text" && child.data.trim()))
      && !Object.keys(node.attribs ?? {}).some(k => /^(?:id|class|style|filter|clip-path|mask|opacity)$/.test(k) && (k !== "id" || referenced.has(node.attribs[k])))) out.push({ ...at, kind: "empty" });
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of doc.children) walk(node);
  // Drop ranges nested in a larger removal.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Removal[] = [];
  for (const r of out) if (!kept.length || r.start >= kept[kept.length - 1].end) kept.push(r);
  return kept;
}
const hasAncestorAttr = (node: any, attr: string) => { for (let p = node.parent; p; p = p.parent) if (p.attribs && attr in p.attribs) return true; return false; };

/** Lossless clean-up: prolog, comments, metadata, editor data, unused defs, empty groups, default attributes, compact path data. */
export function optimizeSvg(source: string, options: { precision?: number } = {}): { svg: string; before: number; after: number; saved: Record<string, number>; passes: number } {
  const precision = Math.max(0, Math.min(6, options.precision ?? 3));
  const before = bytesOf(source), saved: Record<string, number> = {};
  let current = source, passes = 0;
  const preserveSpace = /<(?:text|tspan|style|pre)\b/i.test(source);
  for (; passes < 4; passes++) {
    const doc = parseDocument(current, { xmlMode: true, withStartIndices: true, withEndIndices: true });
    const cuts = removals(current, doc);
    // Attribute-level edits on start tags that survive.
    const edits: Array<[number, number, string]> = cuts.map(c => [c.start, c.end, ""]);
    const inCut = (index: number) => cuts.some(c => index >= c.start && index < c.end);
    const visit = (node: any) => {
      if (node.type !== "tag" && node.type !== "style" && node.type !== "script") return;
      if (inCut(node.startIndex)) return;
      const open = current.slice(node.startIndex, node.startIndex + (/^<[^>]*>/.exec(current.slice(node.startIndex))?.[0].length ?? 0));
      let next = open;
      for (const m of open.matchAll(/\s+((?:sodipodi|inkscape|sketch|serif|i|x):[\w.-]+|xmlns:(?:sodipodi|inkscape|sketch|serif|i|x|dc|cc|rdf)|enable-background|xml:space|data-name|version|baseProfile)\s*=\s*(?:"[^"]*"|'[^']*')/g))
        if (!(m[1] === "version" && node.name !== "svg")) next = next.replace(m[0], "");
      for (const [attr, value] of Object.entries(DEFAULTS)) {
        if (node.attribs?.[attr] === value && !hasAncestorAttr(node, attr)) next = next.replace(new RegExp(`\\s+${attr}\\s*=\\s*(?:"${value}"|'${value}')`), "");
      }
      // Auto-generated ids nothing points at.
      const id = node.attribs?.id;
      if (id && GENERATED_ID.test(id) && !new RegExp(`#${id}\\b`).test(current) && !new RegExp(`["'(]${id}\\b`).test(current.replace(open, ""))) next = next.replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*')/, "");
      if (node.name === "path" && node.attribs?.d) next = next.replace(/(\sd\s*=\s*)("([^"]*)"|'([^']*)')/, (_m, lead, _q, dq, sq) => `${lead}"${compactPath(dq ?? sq, precision)}"`);
      if (next !== open) edits.push([node.startIndex, node.startIndex + open.length, next]);
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of doc.children) visit(node);
    edits.sort((a, b) => b[0] - a[0]);
    let text = current;
    for (const [start, end, replacement] of edits) text = text.slice(0, start) + replacement + text.slice(end);
    if (!preserveSpace) text = text.replace(/>\s+</g, "><").trim();
    text = text.replace(/\s+\/>/g, "/>");
    for (const c of cuts) saved[c.kind] = (saved[c.kind] ?? 0) + bytesOf(current.slice(c.start, c.end));
    if (text === current) break;
    current = text;
  }
  const after = bytesOf(current);
  const kindTotal = Object.values(saved).reduce((a, b) => a + b, 0);
  saved.attributesAndPaths = Math.max(0, before - after - kindTotal);
  return { svg: current, before, after, saved, passes };
}

export interface SvgReview {
  file: string; kind: "icon" | "logo" | "illustration"; bytes: number; score: number; verdict: "ship" | "fix-first" | "rework";
  findings: SvgFinding[]; optimization: { savedBytes: number; savedPercent: number; breakdown: Record<string, number> }; scope: string;
}

/** Paint values (fill and stroke, as attributes, style declarations and stylesheet rules) counted by colour. */
function paints(source: string): { colors: Map<string, number>; current: boolean; declared: number } {
  const colors = new Map<string, number>();
  let declared = 0;
  for (const m of source.matchAll(/\b(fill|stroke)\s*[=:]\s*["']?\s*([^"';}\s>]+)/g)) {
    if (m[2] !== "none" && m[2] !== "inherit" && !m[2].startsWith("url(")) declared++;
    const c = colorOf(m[2]);
    if (c) colors.set(c, (colors.get(c) ?? 0) + 1);
  }
  return { colors, current: colors.has("currentColor"), declared };
}

/** Review one SVG document against the file side of the svg-assessment checklist. Geometry comes from
 * `measureSvg`; this adds theming, weight, structure and safety verdicts with fixes and the size potential. */
export function reviewSvg(source: string, options: { kind?: SvgReview["kind"]; name?: string; measure?: SvgMeasure } = {}): SvgReview {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES) throw new Error("SVG source must be a string of at most 2 MiB");
  const m = options.measure ?? measureSvg(source, options.name);
  if (m.warnings.includes("no <svg> root element found")) throw new Error("No <svg> root element found");
  const findings: SvgFinding[] = [];
  const add = (rule: string, severity: SvgSeverity, message: string, fix: string, extra: { count?: number; bytes?: number } = {}) => findings.push({ rule, severity, message, fix, ...extra });
  const root = /<svg\b[^>]*>/i.exec(source)?.[0] ?? "", attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const vb = m.viewBox, span = vb ? Math.max(vb.width, vb.height) : Math.max(m.width ?? 0, m.height ?? 0);
  const kind = options.kind ?? (span > 0 && span <= 64 && vb && Math.max(vb.width, vb.height) / Math.max(1e-6, Math.min(vb.width, vb.height)) <= 1.5 ? "icon" : /logo|brand|wordmark/i.test(options.name ?? m.file) ? "logo" : "illustration");
  const paint = paints(source);
  const el = (name: string) => m.elements[name] ?? 0;

  // Sizing and scaling.
  // A present but degenerate viewBox (zero extent) is reported by svg-check; only an absent one is a scaling defect.
  if (!vb && attr("viewBox") === undefined) add("missing-viewbox", m.width || m.height ? "high" : "medium", "No viewBox: the graphic cannot scale and renders at a fixed size.", "Add viewBox=\"0 0 W H\" matching the coordinate space; size it with CSS.");
  if (kind === "icon" && attr("preserveAspectRatio") === "none") add("stretchy-aspect", "medium", "preserveAspectRatio=\"none\" stretches the icon to any container.", "Remove it (default xMidYMid meet) so icons keep their proportions.");
  if (attr("overflow") === "visible") add("overflow-visible", "low", "overflow=\"visible\" on the root usually hides art that falls outside the viewBox.", "Fix the geometry instead of letting it bleed.");
  if (kind === "icon" && (m.width ?? 0) > 64) add("large-default-size", "low", `The default size is ${m.width}px for an icon; without CSS it renders huge.`, "Default to 1em (or 24) so it follows the surrounding text.");

  // Geometry against the viewBox. Bounds cover fill geometry, so stroke extents are added here.
  if (vb && m.padding !== null) {
    const reach = m.strokeWidths.length ? Math.max(...m.strokeWidths) / 2 : 0, tolerance = 0.005 * span;
    const rotated = m.approximationCauses.some(cause => /rotate|skew|matrix/.test(cause));
    const visible = attr("overflow") === "visible";
    if (m.padding < -tolerance && !visible) add("art-outside-viewbox", rotated ? "medium" : "high", `Art extends ${(-m.padding).toFixed(2)} units outside the viewBox and is clipped.`, "Redraw inside the viewBox or widen it; overflow=visible only hides the symptom.");
    else if (m.padding - reach < -tolerance && !visible) add("stroke-clipped", "medium", `Strokes (width up to ${reach * 2}) reach ${(reach - m.padding).toFixed(2)} units past the viewBox edge and are clipped.`, "Keep stroke extents inside the viewBox: inset the geometry by half the stroke width.");
    else if (kind === "icon" && m.padding - reach < 0.03 * span - tolerance) add("no-safe-margin", "low", `The art (with strokes) leaves only ${(m.padding - reach).toFixed(2)} units of margin; icons need about 1/12 of the grid as safe area.`, "Redraw on the icon grid with a 2px (on 24) safe margin so edges survive fractional scaling.");
    if (kind === "icon" && m.centerOffset && (Math.abs(m.centerOffset.dx) > 0.08 * vb.width || Math.abs(m.centerOffset.dy) > 0.08 * vb.height)) add("off-centre", "low", `The visual centre is off by (${m.centerOffset.dx}, ${m.centerOffset.dy}) units.`, "Centre the glyph optically; off-centre icons misalign in buttons and lists.");
  }

  // Colour and theming.
  const explicit = [...paint.colors.keys()].filter(c => c !== "currentColor");
  if (kind === "icon" && !paint.current && explicit.length >= 1 && explicit.length <= 2 && m.gradients === 0)
    add("hardcoded-icon-colour", "medium", `The icon hard-codes ${explicit.join(", ")} and cannot follow dark mode, hover or accent colour.`, "Use fill=\"currentColor\" (or stroke) so one asset re-themes with CSS color; keep hard-coded colours only for brand marks.");
  else if (kind === "icon" && !paint.current && paint.declared === 0 && m.totalNodes + el("rect") + el("circle") + el("ellipse") > 0)
    add("implicit-black", "medium", "No fill or stroke is set, so every shape renders black regardless of theme.", "Set fill=\"currentColor\" on the root (or the shapes).");
  if (kind === "icon" && m.gradients && /gradientUnits\s*=\s*["']userSpaceOnUse/.test(source)) add("userspace-gradient", "low", "A userSpaceOnUse gradient shifts when the icon is resized.", "Prefer objectBoundingBox (the default) so the gradient scales with the shape.");
  if (kind === "icon" && m.gradients > 4) add("gradient-heavy", "low", `${m.gradients} gradients in an icon are over-designed for small sizes.`, "Use flat fills, or 2-3 stop gradients only where they carry meaning.");

  // Weight and geometry economy.
  if (kind === "icon" && (m.totalNodes > 120 || m.bytes > 5000)) add("node-bloat", "medium", `A simple icon carries ${m.totalNodes} path nodes in ${m.bytes} bytes.`, "Simplify or re-export without tracing/outline expansion; a glyph should stay under about 20 nodes per shape.", { count: m.totalNodes, bytes: m.bytes });
  else if (m.longestPathNodes > 1500) add("over-traced-path", "medium", `One path holds ${m.longestPathNodes} nodes, typical of auto-tracing.`, "Simplify curves (fewer nodes) or replace with vector shapes; consider a raster format for photographic detail.", { count: m.longestPathNodes });
  let primitives = 0;
  for (const d of source.matchAll(/\sd\s*=\s*"([^"]*)"/g)) {
    const letters = d[1].replace(/[^A-Za-z]/g, "");
    if (/^Mc{4}z?$/i.test(letters) || /^Ma{2}z?$/i.test(letters) || /^M[LHV]{3,4}z?$/i.test(letters)) primitives++;
  }
  if (primitives) add("primitive-as-path", "low", `${primitives} closed path(s) look like a circle or rectangle and could be <circle>/<rect>.`, "Use primitives: smaller, exact and editable.", { count: primitives });
  let rasterBytes = 0;
  for (const raster of source.matchAll(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+/gi)) rasterBytes += raster[0].length;
  if (rasterBytes) add("embedded-raster", rasterBytes > 10_000 ? "medium" : "low", `A base64 raster image is embedded (${rasterBytes} bytes); it defeats vector scaling and caching.`, "Link an optimized WebP/AVIF, or trace to real vector shapes.", { bytes: rasterBytes });
  const texts = el("text") + el("tspan");
  if (texts && kind !== "illustration") add("live-text", "medium", `${texts} text element(s) depend on installed fonts and can render in a fallback face.`, "Convert to outlines for logos and icons, or set a system font stack and verify the fallback.");
  const animations = el("animate") + el("animateTransform") + el("animateMotion") + el("set");
  if (m.filters) add("filter-cost", animations ? "medium" : "low", `${m.filters} filter(s) add raster work${animations ? " and this file also animates" : ""}.`, "Prefer CSS filter on the container, or bake the effect; measure before animating.");
  if (animations && !/prefers-reduced-motion/.test(source)) add("motion-no-preference", "low", "SMIL animation ignores prefers-reduced-motion.", "Animate with CSS and a prefers-reduced-motion query, or provide a static state.");

  // Structure, safety and accessibility.
  if (m.idCollisions.length) add("duplicate-id", "high", `Duplicate ids (${m.idCollisions.slice(0, 3).join(", ")}) can resolve gradients, masks or names to the wrong element.`, "Make ids unique, or strip them (the optimizer removes generated ids nothing references).", { count: m.idCollisions.length });
  if (m.unresolvedRefs.length) add("missing-reference", "high", `Fragment references with no matching id: ${m.unresolvedRefs.slice(0, 3).join(", ")}.`, "Define the target or remove the reference; broken fills and masks render nothing.", { count: m.unresolvedRefs.length });
  if (m.activeContent.length) add("active-content", "high", `Active content (${[...new Set(m.activeContent)].slice(0, 4).join(", ")}) can run code when the SVG is inlined or opened directly.`, "Remove it; serve untrusted SVG through <img> with a strict Content-Security-Policy, or sanitize.", { count: m.activeContent.length });
  if (m.externalRefs.length) add("external-reference", "low", `External references (${m.externalRefs.slice(0, 2).join(", ")}) make the file depend on another host.`, "Inline or self-host the resource.", { count: m.externalRefs.length });
  if (kind !== "icon" && !m.hasTitle && !m.ariaLabel && attr("aria-hidden") !== "true") add("no-accessible-name", "low", "No <title>, aria-label or aria-hidden: assistive technology may read nothing useful.", "Informative art: role=\"img\" with <title>. Decorative art: aria-hidden=\"true\".");

  // Optimization potential.
  const opt = optimizeSvg(source);
  const savedBytes = Math.max(0, opt.before - opt.after), savedPercent = opt.before ? Math.round((savedBytes / opt.before) * 1000) / 10 : 0;
  if (savedBytes >= 300 && savedPercent >= 12) add("optimizable", savedPercent >= 30 ? "medium" : "low", `${savedBytes} bytes (${savedPercent}%) are removable losslessly: ${Object.entries(opt.saved).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "Run svg_inspect with action review and optimize true for a verified copy, or SVGO with the viewBox preserved.", { bytes: savedBytes });
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + (f.severity === "high" ? 20 : f.severity === "medium" ? 8 : 2), 0));
  return { file: m.file, kind, bytes: m.bytes, score, verdict: score >= 85 ? "ship" : score >= 60 ? "fix-first" : "rework", findings,
    optimization: { savedBytes, savedPercent, breakdown: opt.saved },
    scope: "Source review only: no rendering, so overlap, optical weight and metaphor still need a look at the real size. Bounds come from svg_inspect measurements (fill geometry plus stroke reach)." };
}

/** Losslessness check on measurements: same shapes and nodes, same art bounds, still an SVG. */
export function verifyOptimized(original: string, optimized: string): { ok: boolean; reason?: string } {
  const a = measureSvg(original), b = measureSvg(optimized);
  if (b.warnings.includes("no <svg> root element found")) return { ok: false, reason: "no <svg> root" };
  for (const key of ["paths", "totalNodes"] as const) if (a[key] !== b[key]) return { ok: false, reason: `${key} changed` };
  const shapes = (x: SvgMeasure) => ["rect", "circle", "ellipse", "line", "polygon", "polyline", "path", "text", "image", "use"].map(name => x.elements[name] ?? 0).join(",");
  if (shapes(a) !== shapes(b)) return { ok: false, reason: "element counts changed" };
  if (a.unionBounds && b.unionBounds) {
    const tolerance = 0.01 * Math.max(a.viewBox?.width ?? 24, a.viewBox?.height ?? 24) + 0.01;
    if ((["x", "y", "width", "height"] as const).some(key => Math.abs(a.unionBounds![key] - b.unionBounds![key]) > tolerance)) return { ok: false, reason: "bounds moved" };
  }
  return { ok: true };
}

/** svg_inspect review: verdicts for 1..24 files, optionally with verified optimized copies in a fresh git-ignored folder. */
export async function svgReviewRun(params: { path?: unknown; paths?: unknown; kind?: SvgReview["kind"]; optimize?: boolean; precision?: number; outputDir?: unknown }, cwd: string) {
  const raw = Array.isArray(params.paths) ? params.paths : params.path !== undefined ? [params.path] : [];
  const files = [...new Set(raw.map(String).filter(Boolean))].slice(0, 24);
  if (!files.length) throw new Error("review needs path (one file) or paths (up to 24 files)");
  const dir = params.optimize ? await studioFolder(params.outputDir, cwd, "svg") : undefined;
  const reviews: Array<SvgReview & { optimized?: unknown }> = [];
  for (const [index, file] of files.entries()) {
    const { xml, resolved } = await readSvg(file, cwd);
    const rel = path.relative(cwd, resolved) || path.basename(resolved);
    const review: SvgReview & { optimized?: unknown } = reviewSvg(xml, { kind: params.kind, name: rel });
    if (dir) {
      const result = optimizeSvg(xml, { precision: params.precision });
      const check = verifyOptimized(xml, result.svg);
      if (check.ok && result.after < result.before) {
        const name = `${String(index).padStart(2, "0")}-${path.basename(resolved).replace(/[^\w.-]/g, "_")}`;
        await fs.writeFile(path.join(dir, name), result.svg, { flag: "wx" });
        review.optimized = { file: path.relative(cwd, path.join(dir, name)), before: result.before, after: result.after, verified: true };
      } else review.optimized = { skipped: check.ok ? "no size reduction" : `not verified lossless: ${check.reason}` };
    }
    reviews.push(review);
  }
  reviews.sort((x, y) => x.score - y.score);
  return { reviews, reducibleBytes: reviews.reduce((n, r) => n + r.optimization.savedBytes, 0), ...(dir ? { outputDir: path.relative(cwd, dir) } : {}),
    note: "Optimized copies never replace the original: look at the render, then copy one over it. Hard-coded colours are correct for brand marks. Icon-set consistency is in svg_inspect's set review (paths of 2 or more files)." };
}
