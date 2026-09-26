/**
 * SVG inspection — real geometry over icon/illustration source, not prose
 * guidance. Dependency-free parsing plus a path-data engine.
 *
 * WHY: icon quality lives in details the main model will not reliably
 * compute by eye: mixed stroke widths, drifting optical centers, padding
 * collapse, mass outliers, unresolved fragment refs, id collisions, default
 * filter regions and small-size clogging. svg_inspect measures viewBox,
 * bounds, strokes, fills, defs, transforms, accessibility and path
 * complexity; the set review flags the icon that drifted from its siblings;
 * the render matrix rasterizes representative sizes for legibility judgment.
 * Bounds apply translate/scale transforms; rotate/skew/matrix are reported
 * but not applied, so rotated artwork keeps approximate bounds — stated in
 * the output, never silently exact.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodeImage } from "./design-studio.ts";
import { qaFolder, type QACapture } from "./creative-qa.ts";

export interface SvgBounds { x: number; y: number; width: number; height: number }
export interface SvgPathStat { commands: number; nodes: number; closed: boolean; arcs: boolean; curves: number; bounds: SvgBounds | null }

export interface SvgMeasure {
  file: string;
  bytes: number;
  width: number | null;
  height: number | null;
  viewBox: SvgBounds | null;
  elements: Record<string, number>;
  ids: number;
  idCollisions: string[];
  unresolvedRefs: string[];
  gradients: number;
  gradientStops: number;
  filters: number;
  filterDefaultRegions: number;
  masks: number;
  clipPaths: number;
  uses: number;
  paths: number;
  totalNodes: number;
  longestPathNodes: number;
  strokeWidths: number[];
  linecaps: string[];
  linejoins: string[];
  fills: string[];
  hasTitle: boolean;
  hasDesc: boolean;
  role: string | null;
  ariaLabel: boolean;
  activeContent: string[];
  externalRefs: string[];
  transforms: { count: number; maxDepth: number; nonTrivial: string[] };
  unionBounds: SvgBounds | null;
  padding: number | null;
  centerOffset: { dx: number; dy: number } | null;
  inkShare: number | null;
  cornerLanguage: string;
  boundsApproximate: boolean;
  warnings: string[];
}

interface Tag { name: string; attrs: Record<string, string>; selfClosing: boolean; closing: boolean }

const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Minimal XML tag tokenizer: comments, CDATA, doctypes and PIs skipped;
 * entity refs in attributes decoded for the five predefined entities. */
export function tokenizeSvg(xml: string): Tag[] {
  const tags: Tag[] = [];
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<!DOCTYPE[^>]*>/gi, "");
  const tagRe = /<\s*(\/?)\s*([A-Za-z][\w.-]*)([^<>]*?)(\/?)\s*>/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = tagRe.exec(clean)) && guard++ < 200_000) {
    const [, closing, name, attrText, selfClosing] = match;
    if (name.startsWith("?") || name.startsWith("!")) continue;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let attr: RegExpExecArray | null;
    let attrGuard = 0;
    while ((attr = ATTR.exec(attrText)) && attrGuard++ < 500) {
      const key = attr[1];
      if (!key || key === "/" || attrs[key] !== undefined) continue;
      let value = attr[2] ?? "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      attrs[key] = value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").slice(0, 4096);
    }
    tags.push({ name: name.toLowerCase(), attrs, selfClosing: selfClosing === "/", closing: closing === "/" });
  }
  return tags;
}

const num = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseViewBox = (value: string | undefined): SvgBounds | null => {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
};

const parseStyleAttr = (value: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const decl of value.split(";").slice(0, 64)) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const key = decl.slice(0, colon).trim().toLowerCase();
    if (key) out[key] = decl.slice(colon + 1).trim().slice(0, 256);
  }
  return out;
};

// ─────────────────────────── path engine ─────────────────────────────────

const COMMAND_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Parse path data into absolute moves; curves and arcs are flattened to
 * sampled polylines for deterministic approximate bounds. Pure. */
export function flattenPath(d: string, curveSamples = 12, arcSamples = 24): { points: Array<[number, number]>; stat: Omit<SvgPathStat, "bounds"> } {
  const stat = { commands: 0, nodes: 0, closed: false, arcs: false, curves: 0 };
  const points: Array<[number, number]> = [];
  const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, x = 0, y = 0, startX = 0, startY = 0, command = "";
  const push = (px: number, py: number) => { points.push([px, py]); stat.nodes++; };
  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let k = 1; k <= curveSamples; k++) {
      const t = k / curveSamples, u = 1 - t;
      push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  };
  const quad = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) => {
    for (let k = 1; k <= curveSamples; k++) {
      const t = k / curveSamples, u = 1 - t;
      push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
  };
  // Endpoint→center arc sampling (SVG 1.1 F.6.5), deterministic.
  const arc = (x0: number, y0: number, rx: number, ry: number, rot: number, large: boolean, sweep: boolean, x1: number, y1: number) => {
    stat.arcs = true;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) { push(x1, y1); return; }
    const phi = (rot * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
    const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
    const numC = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const den = rx * rx * yp * yp + ry * ry * xp * xp;
    const c = Math.sqrt(Math.max(0, numC / (den || 1))) * (large === sweep ? -1 : 1);
    const cxp = (c * rx * yp) / ry, cyp = (-c * ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x0 + x1) / 2, cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => {
      const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
      let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    let t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    for (let k = 1; k <= arcSamples; k++) {
      const t = t1 + (dt * k) / arcSamples;
      push(cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
    }
  };
  let guard = 0;
  let prevCubicX = 0, prevCubicY = 0, prevQuadX = 0, prevQuadY = 0, prevCommand = "";
  while (i < tokens.length && guard++ < 100_000) {
    const token = tokens[i];
    if (/[A-Za-z]/.test(token)) { command = token.toUpperCase(); i++; stat.commands++; prevCommand = command; }
    else if (!command) { i++; continue; }
    const relativeCmd = tokens[i - 1] ? /[a-z]/.test(tokens[command === tokens[i - 1].toUpperCase() ? i - 1 : i - 1] ?? "") : false;
    const rel = (tokens[Math.max(0, i - 1)] && /[a-z]/.test(tokens[i - 1]) && COMMAND_ARGS[tokens[i - 1].toUpperCase()] !== undefined) ? true : /[a-z]/.test(command === command.toUpperCase() ? "" : command);
    const isRelative = (() => {
      // The case of the most recent command letter decides relativity.
      for (let k = i - 1; k >= 0; k--) {
        if (/[A-Za-z]/.test(tokens[k])) return tokens[k] === tokens[k].toLowerCase();
      }
      return false;
    })();
    void relativeCmd; void rel;
    const need = COMMAND_ARGS[command] ?? 0;
    if (command === "Z") { stat.closed = true; x = startX; y = startY; push(x, y); command = ""; continue; }
    if (i + need > tokens.length || tokens.slice(i, i + need).some((t) => /[A-Za-z]/.test(t))) break;
    const args = tokens.slice(i, i + need).map(Number);
    i += need;
    if (args.some((a) => !Number.isFinite(a))) break;
    stat.commands += 0; // counted on the letter; implicit repeats share it
    const X = (v: number) => (isRelative ? x + v : v);
    const Y = (v: number) => (isRelative ? y + v : v);
    switch (command) {
      case "M": x = X(args[0]); y = Y(args[1]); startX = x; startY = y; push(x, y); command = "L"; break;
      case "L": x = X(args[0]); y = Y(args[1]); push(x, y); break;
      case "H": x = X(args[0]); push(x, y); break;
      case "V": y = Y(args[0]); push(x, y); break;
      case "C": {
        stat.curves++;
        const [x1, y1, x2, y2, x3, y3] = [X(args[0]), Y(args[1]), X(args[2]), Y(args[3]), X(args[4]), Y(args[5])];
        cubic(x, y, x1, y1, x2, y2, x3, y3); prevCubicX = x2; prevCubicY = y2; x = x3; y = y3; break;
      }
      case "S": {
        stat.curves++;
        const x1 = prevCommand === "C" || prevCommand === "S" ? 2 * x - prevCubicX : x;
        const y1 = prevCommand === "C" || prevCommand === "S" ? 2 * y - prevCubicY : y;
        const [x2, y2, x3, y3] = [X(args[0]), Y(args[1]), X(args[2]), Y(args[3])];
        cubic(x, y, x1, y1, x2, y2, x3, y3); prevCubicX = x2; prevCubicY = y2; x = x3; y = y3; break;
      }
      case "Q": {
        stat.curves++;
        const [x1, y1, x2, y2] = [X(args[0]), Y(args[1]), X(args[2]), Y(args[3])];
        quad(x, y, x1, y1, x2, y2); prevQuadX = x1; prevQuadY = y1; x = x2; y = y2; break;
      }
      case "T": {
        stat.curves++;
        const x1 = prevCommand === "Q" || prevCommand === "T" ? 2 * x - prevQuadX : x;
        const y1 = prevCommand === "Q" || prevCommand === "T" ? 2 * y - prevQuadY : y;
        const [x2, y2] = [X(args[0]), Y(args[1])];
        quad(x, y, x1, y1, x2, y2); prevQuadX = x1; prevQuadY = y1; x = x2; y = y2; break;
      }
      case "A": {
        const [rx, ry, rot, large, sweep, nx, ny] = args;
        arc(x, y, rx, ry, rot, large !== 0, sweep !== 0, X(nx), Y(ny));
        x = X(nx); y = Y(ny); break;
      }
      default: command = "";
    }
    prevCommand = command;
    // Implicit repetition: the same command continues for bare numbers.
    if (i < tokens.length && !/[A-Za-z]/.test(tokens[i]) && command === "M") command = "L";
  }
  return { points, stat };
}

export function boundsOfPoints(points: Array<[number, number]>): SvgBounds | null {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const unionBounds = (a: SvgBounds | null, b: SvgBounds | null): SvgBounds | null => {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

// translate/scale-only 2D matrix stack for icon-typical transforms.
interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const applyMatrix = (m: Matrix, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const multiplyMatrix = (m: Matrix, n: Matrix): Matrix => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});

const parseTransform = (value: string): { matrix: Matrix; trivial: boolean } => {
  let matrix = { ...IDENTITY };
  let trivial = true;
  const re = /(translate|scale|rotate|skewX|skewY|matrix)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = re.exec(value)) && guard++ < 32) {
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (match[1] === "translate" && args.length >= 1) {
      const [tx, ty = 0] = args;
      matrix = multiplyMatrix(matrix, { ...IDENTITY, e: tx, f: ty });
    } else if (match[1] === "scale" && args.length >= 1) {
      const [sx, sy = sx] = args;
      matrix = multiplyMatrix(matrix, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    } else trivial = false;
  }
  return { matrix, trivial };
};

const SHAPE_TAGS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

/** Measure one SVG document. Pure over the XML string. */
export function measureSvg(xml: string, file = "<input>"): SvgMeasure {
  const warnings: string[] = [];
  const tags = tokenizeSvg(xml.slice(0, 4_000_000));
  const measure: SvgMeasure = {
    file, bytes: Buffer.byteLength(xml), width: null, height: null, viewBox: null,
    elements: {}, ids: 0, idCollisions: [], unresolvedRefs: [],
    gradients: 0, gradientStops: 0, filters: 0, filterDefaultRegions: 0, masks: 0, clipPaths: 0, uses: 0,
    paths: 0, totalNodes: 0, longestPathNodes: 0,
    strokeWidths: [], linecaps: [], linejoins: [], fills: [],
    hasTitle: false, hasDesc: false, role: null, ariaLabel: false,
    activeContent: [], externalRefs: [],
    transforms: { count: 0, maxDepth: 0, nonTrivial: [] },
    unionBounds: null, padding: null, centerOffset: null, inkShare: null,
    cornerLanguage: "unknown", boundsApproximate: false, warnings,
  };
  if (!tags.some((t) => t.name === "svg" && !t.closing)) {
    warnings.push("no <svg> root element found");
    return measure;
  }
  const seenIds = new Map<string, number>();
  const fragmentRefs = new Set<string>();
  const strokeSet = new Set<number>();
  const capSet = new Set<string>();
  const joinSet = new Set<string>();
  const fillSet = new Set<string>();
  let curveCommands = 0, lineCommands = 0, rxCount = 0;
  let inkArea = 0, inkCx = 0, inkCy = 0;
  const matrixStack: Matrix[] = [{ ...IDENTITY }];
  let depth = 0, maxTransformDepth = 0, nonTrivialPresent = false;

  const shapeBounds = (name: string, attrs: Record<string, string>): { bounds: SvgBounds | null; filled: boolean; stroked: boolean; strokeWidth: number } => {
    const style = parseStyleAttr(attrs.style);
    const fill = attrs.fill ?? style.fill ?? "black";
    const stroke = attrs.stroke ?? style.stroke ?? "none";
    const strokeWidth = num(attrs["stroke-width"] ?? style["stroke-width"]) ?? (stroke !== "none" ? 1 : 0);
    const filled = fill !== "none";
    const stroked = stroke !== "none" && strokeWidth > 0;
    let local: SvgBounds | null = null;
    if (name === "path" && attrs.d) {
      const { points, stat } = flattenPath(attrs.d);
      measure.paths++;
      measure.totalNodes += stat.nodes;
      measure.longestPathNodes = Math.max(measure.longestPathNodes, stat.nodes);
      curveCommands += stat.curves + (stat.arcs ? 1 : 0);
      lineCommands += Math.max(0, stat.commands - stat.curves - (stat.arcs ? 1 : 0));
      local = boundsOfPoints(points);
    } else if (name === "rect") {
      const x = num(attrs.x) ?? 0, y = num(attrs.y) ?? 0, w = num(attrs.width) ?? 0, h = num(attrs.height) ?? 0;
      if (num(attrs.rx) || num(attrs.ry)) rxCount++;
      if (w > 0 && h > 0) local = { x, y, width: w, height: h };
    } else if (name === "circle") {
      const cx = num(attrs.cx) ?? 0, cy = num(attrs.cy) ?? 0, r = num(attrs.r) ?? 0;
      if (r > 0) { local = { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }; curveCommands++; }
    } else if (name === "ellipse") {
      const cx = num(attrs.cx) ?? 0, cy = num(attrs.cy) ?? 0, rx = num(attrs.rx) ?? 0, ry = num(attrs.ry) ?? 0;
      if (rx > 0 && ry > 0) { local = { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry }; curveCommands++; }
    } else if (name === "line") {
      const x1 = num(attrs.x1) ?? 0, y1 = num(attrs.y1) ?? 0, x2 = num(attrs.x2) ?? 0, y2 = num(attrs.y2) ?? 0;
      local = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      lineCommands++;
    } else if (name === "polyline" || name === "polygon") {
      const nums = (attrs.points ?? "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      const pts: Array<[number, number]> = [];
      for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
      measure.totalNodes += pts.length;
      lineCommands += Math.max(0, pts.length - 1);
      local = boundsOfPoints(pts);
    }
    if (local) {
      const m = matrixStack[matrixStack.length - 1];
      const corners = [[local.x, local.y], [local.x + local.width, local.y], [local.x, local.y + local.height], [local.x + local.width, local.y + local.height]]
        .map(([px, py]) => applyMatrix(m, px, py));
      local = boundsOfPoints(corners as Array<[number, number]>);
    }
    if (strokeWidth > 0) strokeSet.add(Math.round(strokeWidth * 100) / 100);
    const cap = (attrs["stroke-linecap"] ?? style["stroke-linecap"] ?? "").toLowerCase();
    const join = (attrs["stroke-linejoin"] ?? style["stroke-linejoin"] ?? "").toLowerCase();
    if (cap) capSet.add(cap);
    if (join) joinSet.add(join);
    if (filled && fill !== "black") fillSet.add(fill.slice(0, 64));
    else if (filled) fillSet.add("black");
    return { bounds: local, filled, stroked, strokeWidth };
  };

  for (const tag of tags) {
    if (tag.closing) {
      depth = Math.max(0, depth - 1);
      if (matrixStack.length > 1) matrixStack.pop();
      continue;
    }
    measure.elements[tag.name] = (measure.elements[tag.name] ?? 0) + 1;
    const { attrs } = tag;
    if (tag.name === "svg" && measure.viewBox === null && measure.width === null) {
      measure.viewBox = parseViewBox(attrs.viewBox ?? attrs.viewbox);
      measure.width = num(attrs.width);
      measure.height = num(attrs.height);
      if (attrs.role) measure.role = attrs.role.slice(0, 64);
      if (attrs["aria-label"] || attrs["aria-labelledby"]) measure.ariaLabel = true;
    }
    if (attrs.id) {
      measure.ids++;
      const count = (seenIds.get(attrs.id) ?? 0) + 1;
      seenIds.set(attrs.id, count);
      if (count === 2) measure.idCollisions.push(attrs.id.slice(0, 128));
    }
    for (const key of ["href", "xlink:href"]) {
      const ref = attrs[key];
      if (typeof ref === "string" && ref.startsWith("#") && ref.length > 1) fragmentRefs.add(ref.slice(1, 129));
      else if (typeof ref === "string" && /^(https?:)?\/\//i.test(ref)) measure.externalRefs.push(`${tag.name} ${key}=${ref.slice(0, 120)}`);
    }
    for (const value of Object.values(attrs)) {
      const urlMatch = /url\(\s*#([^)\s]+)\s*\)/.exec(value);
      if (urlMatch) fragmentRefs.add(urlMatch[1].slice(0, 128));
    }
    if (tag.name === "title") measure.hasTitle = true;
    if (tag.name === "desc") measure.hasDesc = true;
    if (tag.name === "lineargradient" || tag.name === "radialgradient") measure.gradients++;
    if (tag.name === "stop") measure.gradientStops++;
    if (tag.name === "mask") measure.masks++;
    if (tag.name === "clippath") measure.clipPaths++;
    if (tag.name === "use") measure.uses++;
    if (tag.name === "filter") {
      measure.filters++;
      if (attrs.x === undefined && attrs.y === undefined && attrs.width === undefined && attrs.height === undefined) measure.filterDefaultRegions++;
    }
    if (tag.name === "script") measure.activeContent.push("<script> element");
    for (const key of Object.keys(attrs)) {
      if (key.toLowerCase().startsWith("on")) measure.activeContent.push(`${tag.name} ${key} handler`);
    }
    let pushed = false;
    if (attrs.transform) {
      measure.transforms.count++;
      const { matrix, trivial } = parseTransform(attrs.transform);
      matrixStack.push(multiplyMatrix(matrixStack[matrixStack.length - 1], matrix));
      pushed = true;
      maxTransformDepth = Math.max(maxTransformDepth, depth + 1);
      if (!trivial) {
        nonTrivialPresent = true;
        if (measure.transforms.nonTrivial.length < 8) measure.transforms.nonTrivial.push(attrs.transform.slice(0, 120));
      }
    }
    if (SHAPE_TAGS.has(tag.name)) {
      const { bounds, filled, stroked, strokeWidth } = shapeBounds(tag.name, attrs);
      if (bounds && bounds.width >= 0 && bounds.height >= 0) {
        measure.unionBounds = unionBounds(measure.unionBounds, bounds);
        const area = Math.max(0, bounds.width * bounds.height);
        const weight = filled ? area : stroked ? area * Math.min(1, strokeWidth / 8) : 0;
        if (weight > 0) {
          inkArea += weight;
          inkCx += (bounds.x + bounds.width / 2) * weight;
          inkCy += (bounds.y + bounds.height / 2) * weight;
        }
      }
    }
    if (!tag.selfClosing && !pushed) {
      depth++;
      matrixStack.push(matrixStack[matrixStack.length - 1]);
    } else if (!tag.selfClosing) {
      depth++;
    }
    if (tag.selfClosing && pushed) matrixStack.pop();
    if (matrixStack.length > 400) break;
  }

  for (const ref of fragmentRefs) {
    if (!seenIds.has(ref)) measure.unresolvedRefs.push(ref);
    if (measure.unresolvedRefs.length >= 24) break;
  }
  measure.transforms.maxDepth = maxTransformDepth;
  measure.strokeWidths = [...strokeSet].sort((a, b) => a - b);
  measure.linecaps = [...capSet].sort();
  measure.linejoins = [...joinSet].sort();
  measure.fills = [...fillSet].sort().slice(0, 24);
  const vb = measure.viewBox;
  if (vb && measure.unionBounds) {
    const u = measure.unionBounds;
    measure.padding = Math.round(Math.min(u.x - vb.x, u.y - vb.y, vb.x + vb.width - (u.x + u.width), vb.y + vb.height - (u.y + u.height)) * 100) / 100;
    if (inkArea > 0) {
      const cx = inkCx / inkArea, cy = inkCy / inkArea;
      measure.centerOffset = {
        dx: Math.round((cx - (vb.x + vb.width / 2)) * 100) / 100,
        dy: Math.round((cy - (vb.y + vb.height / 2)) * 100) / 100,
      };
    }
    measure.inkShare = Math.round(Math.min(1, inkArea / (vb.width * vb.height)) * 1000) / 1000;
  }
  const rounded = measure.linejoins.includes("round") || measure.linecaps.includes("round") || rxCount > 0;
  const sharp = measure.linejoins.includes("miter") || measure.linejoins.includes("bevel");
  const curvy = curveCommands > lineCommands * 2;
  measure.cornerLanguage = rounded ? (sharp ? "mixed round/sharp" : "round") : sharp ? "sharp" : curvy ? "curved" : lineCommands ? "angular" : "unknown";
  measure.boundsApproximate = nonTrivialPresent;
  if (nonTrivialPresent) warnings.push("rotate/skew/matrix transforms present: bounds ignore rotation, so padding/center are approximate");
  if (!vb) warnings.push("no viewBox: scaling behavior is undefined");
  if (measure.unresolvedRefs.length) warnings.push(`${measure.unresolvedRefs.length} fragment reference(s) resolve to no id`);
  if (measure.idCollisions.length) warnings.push(`${measure.idCollisions.length} duplicate id(s)`);
  if (measure.activeContent.length) warnings.push("active content present (script or event handler)");
  return measure;
}

// ─────────────────────────── set review ──────────────────────────────────

export interface SetOutlier { file: string; check: string; detail: string }

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Compare sibling icon measures: stroke language, mass, centering,
 * padding and canvas consistency. Pure. */
export function compareSvgSet(measures: readonly SvgMeasure[]): { summary: string[]; outliers: SetOutlier[] } {
  const summary: string[] = [];
  const outliers: SetOutlier[] = [];
  if (!measures.length) return { summary, outliers };
  const modes = <T>(values: T[]): T | undefined => {
    const counts = new Map<T, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const strokeModes = measures.map((m) => m.strokeWidths.join("/") || "none");
  summary.push(`stroke widths: ${modes(strokeModes) ?? "none"} (mode across ${measures.length} files)`);
  measures.forEach((m) => {
    const key = m.strokeWidths.join("/") || "none";
    if (key !== modes(strokeModes)) outliers.push({ file: m.file, check: "stroke", detail: `stroke ${key || "none"} differs from set mode ${modes(strokeModes)}` });
  });
  const corners = measures.map((m) => m.cornerLanguage);
  summary.push(`corner language: ${modes(corners) ?? "unknown"} (mode)`);
  measures.forEach((m) => {
    if (m.cornerLanguage !== modes(corners)) outliers.push({ file: m.file, check: "corners", detail: `corner language "${m.cornerLanguage}" differs from set mode "${modes(corners)}"` });
  });
  const masses = measures.map((m) => m.inkShare ?? 0).filter((v) => v > 0);
  const massMedian = median(masses);
  if (massMedian > 0) {
    summary.push(`visual mass (ink share): median ${(massMedian * 100).toFixed(1)}%`);
    measures.forEach((m) => {
      if (m.inkShare === null || m.inkShare === 0) return;
      const delta = (m.inkShare - massMedian) / massMedian;
      if (Math.abs(delta) >= 0.35) outliers.push({ file: m.file, check: "mass", detail: `ink share ${(m.inkShare * 100).toFixed(1)}% is ${Math.abs(Math.round(delta * 100))}% ${delta > 0 ? "heavier" : "lighter"} than median` });
    });
  }
  measures.forEach((m) => {
    if (!m.centerOffset) return;
    if (Math.abs(m.centerOffset.dx) > 1.5 || Math.abs(m.centerOffset.dy) > 1.5) {
      const axis = Math.abs(m.centerOffset.dy) >= Math.abs(m.centerOffset.dx) ? `${m.centerOffset.dy > 0 ? "+" : ""}${m.centerOffset.dy}px vertical` : `${m.centerOffset.dx > 0 ? "+" : ""}${m.centerOffset.dx}px horizontal`;
      outliers.push({ file: m.file, check: "center", detail: `optical center offset ${axis} from canvas center` });
    }
  });
  const paddings = measures.map((m) => m.padding).filter((v): v is number => v !== null && Number.isFinite(v));
  const padMedian = median(paddings);
  if (paddings.length) {
    summary.push(`padding: median ${Math.round(padMedian * 100) / 100} units`);
    measures.forEach((m) => {
      if (m.padding === null) return;
      if (m.padding < 0) outliers.push({ file: m.file, check: "padding", detail: `artwork overflows the viewBox by ${Math.abs(Math.round(m.padding * 100) / 100)} units` });
      else if (padMedian > 0 && m.padding < padMedian * 0.4) outliers.push({ file: m.file, check: "padding", detail: `padding ${m.padding} is under half the set median ${Math.round(padMedian * 100) / 100} — edge crowding` });
    });
  }
  const canvases = measures.map((m) => (m.viewBox ? `${m.viewBox.width}x${m.viewBox.height}` : "?"));
  summary.push(`canvas: ${modes(canvases) ?? "?"} (mode)`);
  measures.forEach((m, i) => {
    if (canvases[i] !== modes(canvases)) outliers.push({ file: m.file, check: "canvas", detail: `canvas ${canvases[i]} differs from set mode ${modes(canvases)}` });
  });
  return { summary, outliers: outliers.slice(0, 48) };
}

// ─────────────────────────── runners ─────────────────────────────────────

const relative = (cwd: string, file: string) => { const r = path.relative(cwd, file); return r.startsWith("..") ? file : r; };

async function readSvg(file: string, cwd: string): Promise<{ xml: string; resolved: string }> {
  const resolved = path.resolve(cwd, file.replace(/^@/, ""));
  const root = await fs.realpath(cwd);
  if (!resolved.startsWith(root)) throw new Error("SVG path must stay inside the workspace");
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("SVG must be a regular file under 2 MiB");
  return { xml: await fs.readFile(resolved, "utf8"), resolved };
}

export async function svgInspectRun(params: { path?: unknown; paths?: unknown; files?: unknown }, cwd: string) {
  const raw = Array.isArray(params.paths) ? params.paths : Array.isArray(params.files) ? params.files : params.path !== undefined ? [params.path] : [];
  const files = [...new Set(raw.map(String).filter(Boolean))].slice(0, 24);
  if (!files.length) throw new Error("svg_inspect needs path (one file) or paths (2..24 files for a set review)");
  const measures: SvgMeasure[] = [];
  for (const file of files) {
    const { xml, resolved } = await readSvg(file, cwd);
    measures.push(measureSvg(xml, relative(cwd, resolved)));
  }
  const single = measures.length === 1 ? measures[0] : undefined;
  const set = measures.length > 1 ? compareSvgSet(measures) : undefined;
  const blocking = measures.filter((m) => m.activeContent.length > 0 || m.unresolvedRefs.length > 0 || m.idCollisions.length > 0).length;
  return {
    files: measures.map((m) => m.file),
    measures: measures.map((m) => ({ ...m, elements: m.elements })),
    ...(single ? { single } : {}),
    ...(set ? { set } : {}),
    blocking,
    note: "Geometry from source, not taste: stroke/mass/center/padding outliers flag the icon that drifted from its siblings. Bounds apply translate/scale only (see boundsApproximate). Small-size legibility needs the render matrix plus vision judgment.",
  };
}

const MATRIX_SIZES = [16, 24, 48, 256];

/** Matrix render plan: one capture at a browser-legal viewport, then
 * exact-width decodes per target size (captures cannot render below the
 * 64px viewport floor, so small sizes downscale from the master). Pure. */
export function planSvgMatrix(sizes: unknown): { captureSize: number; targets: number[] } {
  const list = (Array.isArray(sizes) ? sizes : MATRIX_SIZES)
    .map((s) => Math.round(Number(s)))
    .filter((s) => Number.isFinite(s) && s >= 8 && s <= 1024);
  const targets = [...new Set(list)].slice(0, 6);
  if (!targets.length) throw new Error("sizes must be 1..6 widths between 8 and 1024");
  return { captureSize: Math.max(256, ...targets), targets };
}

/** Rasterize one SVG at icon-representative sizes and measure ink coverage
 * per size as a clogging proxy. */
export async function svgMatrixRun(params: { path: string; sizes?: unknown }, cwd: string, signal: AbortSignal | undefined, capture: QACapture) {
  const { resolved } = await readSvg(params.path, cwd);
  const plan = planSvgMatrix(params.sizes);
  const dir = await qaFolder(undefined, cwd, "ui-review", "svg");
  signal?.throwIfAborted();
  const master = path.join(dir, "svg-master.png");
  await capture({ source: resolved, width: plan.captureSize, height: plan.captureSize, fullPage: false, timeoutMs: 30_000 }, master, cwd, signal);
  const bytes = await fs.readFile(master);
  const cells: any[] = [];
  for (const size of plan.targets) {
    signal?.throwIfAborted();
    const img = await decodeImage(bytes, { exactWidth: Math.min(size, plan.captureSize), maxPixels: 2_000_000 }, signal);
    const bg: [number, number, number] = [img.data[0], img.data[1], img.data[2]];
    let ink = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const d = Math.abs(img.data[i * 4] - bg[0]) + Math.abs(img.data[i * 4 + 1] - bg[1]) + Math.abs(img.data[i * 4 + 2] - bg[2]);
      if (d >= 60) ink++;
    }
    const dest = path.join(dir, `svg-${size}px.png`);
    await fs.writeFile(dest, await encodeImage(img, "png", {}, signal), { flag: "wx" });
    cells.push({ size, file: relative(cwd, dest), coverage: Math.round((ink / (img.width * img.height)) * 1000) / 10 });
  }
  return {
    source: relative(cwd, resolved), dir: relative(cwd, dir), master: relative(cwd, master), cells,
    note: "Coverage is an ink proxy, not legibility: near-0% at 16px means vanished detail, near-100% means a clogged blob. Judge silhouettes from the pixels.",
  };
}
