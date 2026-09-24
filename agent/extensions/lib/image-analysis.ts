/** Pure image analysis for design-to-code work. Everything here operates on
 * decoded RGBA buffers: no I/O, no subprocesses, no models. Results are
 * measurements and suggestions (which regions look like text, flat fills,
 * gradients, icons or photographs; palette roles; grid and spacing), never a
 * claim about the designer's intent. Coordinates are in the analyzed image's
 * pixels; callers map them back to source pixels with their scale factor. */

export interface Rgba { width: number; height: number; data: Uint8Array; }
export type Rgb = [number, number, number];

// ───────────────────────────── color science ──────────────────────────────

const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => toLinear(i));
// Mockups repeat few exact colors, so conversions are memoized per 24-bit
// color. The cache is bounded and cleared wholesale when it fills.
const LAB_CACHE = new Map<number, [number, number, number]>();
/** OKLab (Björn Ottosson). L in 0..1, a/b roughly -0.4..0.4. */
const channel = (v: number) => !(v > 0) ? 0 : v >= 255 ? 255 : Math.round(v);
export function oklab(rgb: Rgb): [number, number, number] {
  // Averaged colors are fractional; the 8-bit grid is the working precision.
  const r8 = channel(rgb[0]), g8 = channel(rgb[1]), b8 = channel(rgb[2]);
  const key = (r8 << 16) | (g8 << 8) | b8;
  const cached = LAB_CACHE.get(key);
  if (cached) return cached;
  const r = LINEAR[r8], g = LINEAR[g8], b = LINEAR[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lab: [number, number, number] = [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  if (LAB_CACHE.size >= 262_144) LAB_CACHE.clear();
  LAB_CACHE.set(key, lab);
  return lab;
}
/** Perceptual distance in OKLab × 100 (about 2 is a just-noticeable difference). */
export function deltaE(a: Rgb, b: Rgb): number {
  const x = oklab(a), y = oklab(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
export function oklch(rgb: Rgb): { l: number; c: number; h: number } {
  const [l, a, b] = oklab(rgb);
  const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { l: Math.round(l * 1000) / 10, c: Math.round(Math.hypot(a, b) * 1000) / 1000, h: Math.round(h) };
}
export const hex = (rgb: Rgb) => `#${rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
export function parseHex(value: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function luminance(rgb: Rgb): number { return 0.2126 * LINEAR[channel(rgb[0])] + 0.7152 * LINEAR[channel(rgb[1])] + 0.0722 * LINEAR[channel(rgb[2])]; }
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round((x + 0.05) / (y + 0.05) * 100) / 100;
}
const pixel = (img: Rgba, x: number, y: number): Rgb => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const alphaAt = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
const quantKey = (r: number, g: number, b: number, bits: number) => { const s = 8 - bits; return ((r >> s) << (2 * bits)) | ((g >> s) << bits) | (b >> s); };

// ─────────────────────────────── palette ──────────────────────────────────

export interface PaletteColor { hex: string; rgb: Rgb; coverage: number; oklch: { l: number; c: number; h: number }; role?: string; }

/** Dominant colors by coverage: 5-bit histogram, then greedy merging of bins
 * closer than a perceptual threshold, weighted by pixel count. */
export function extractPalette(img: Rgba, options: { max?: number; region?: Box; mergeDelta?: number; exclude?: Box[] } = {}): PaletteColor[] {
  const max = Math.max(1, Math.min(24, options.max ?? 10));
  const box = options.region ?? { x: 0, y: 0, width: img.width, height: img.height };
  const area = box.width * box.height, stride = Math.max(1, Math.floor(Math.sqrt(area / 250_000)));
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const exclude = options.exclude ?? [];
  for (let y = box.y; y < box.y + box.height; y += stride) for (let x = box.x; x < box.x + box.width; x += stride) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 16) continue;
    if (exclude.length && exclude.some(e => x >= e.x && x < e.x + e.width && y >= e.y && y < e.y + e.height)) continue;
    const key = quantKey(img.data[i], img.data[i + 1], img.data[i + 2], 5);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += img.data[i]; bin.g += img.data[i + 1]; bin.b += img.data[i + 2]; bins.set(key, bin); total++;
  }
  if (!total) return [];
  const candidates = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 96).map(bin => ({ n: bin.n, rgb: [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n] as Rgb }));
  const merged: Array<{ n: number; rgb: Rgb }> = [];
  const threshold = options.mergeDelta ?? 7;
  for (const candidate of candidates) {
    const home = merged.find(cluster => deltaE(cluster.rgb, candidate.rgb) < threshold);
    if (home) {
      const n = home.n + candidate.n;
      home.rgb = home.rgb.map((value, i) => (value * home.n + candidate.rgb[i] * candidate.n) / n) as Rgb; home.n = n;
    } else merged.push({ ...candidate, rgb: [...candidate.rgb] as Rgb });
  }
  return merged.sort((a, b) => b.n - a.n).slice(0, max).map(cluster => {
    const rgb = cluster.rgb.map(Math.round) as Rgb;
    return { hex: hex(rgb), rgb, coverage: Math.round(cluster.n / total * 1000) / 10, oklch: oklch(rgb) };
  });
}

/** Design palette from structure first, pixels second: the frame color is
 * the background; text colors come from the ink of text blocks on it; the
 * primary color from button fills; surfaces from card fills and tinted
 * bands; dark surfaces, borders and on-color text likewise. Remaining pixel
 * clusters follow as secondary accents or neutrals. Each entry carries its
 * evidence. Heuristic, labelled as such. */
export interface PaletteEntry { hex: string; rgb: Rgb; role: string; coverage: number; evidence: string; oklch: { l: number; c: number; h: number }; contrastOnBackground: number; }
export function designPalette(pixels: PaletteColor[], background: Rgb, blocks: Block[], sections: Section[], cssPerPx = 1, pageWidth = 1440): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const coverageOf = (rgb: Rgb) => pixels.filter(color => deltaE(color.rgb, rgb) < 5).reduce((sum, color) => sum + color.coverage, 0);
  // Two roles may share a near color (heading ink and a dark footer); pixel
  // leftovers only join when no structural role already names the color.
  const add = (rgb: Rgb, role: string, evidence: string, structural = true) => {
    // "On" colors are pairings (white text on the primary), kept even when the
    // same value already names the background.
    if (out.some(entry => (!role.startsWith('on-') && deltaE(entry.rgb, rgb) < (structural ? 0.3 : 3)) || (entry.role === role && deltaE(entry.rgb, rgb) < 3))) return false;
    const exact = rgb.map(Math.round) as Rgb;
    out.push({ hex: hex(exact), rgb: exact, role, coverage: Math.round(coverageOf(exact) * 10) / 10, evidence, oklch: oklch(exact), contrastOnBackground: contrastRatio(exact, background) });
    return true;
  };
  add(background, 'background', 'page edges');
  const onPage = (block: Block) => deltaE(parseHex(block.colors[0]) ?? background, background) < 4;
  const texts = blocks.filter(block => block.kind === 'text' && block.colors.length >= 2);
  const weigh = (list: Block[]) => {
    const found: Array<{ rgb: Rgb; weight: number }> = [];
    for (const block of list) { const rgb = parseHex(block.colors[1]); if (!rgb) continue; const w = block.width * (block.lines ?? 1); const home = found.find(c => deltaE(c.rgb, rgb) < 5); if (home) home.weight += w; else found.push({ rgb, weight: w }); }
    return found.sort((a, b) => b.weight - a.weight);
  };
  const size = (block: Block) => (block.ink ?? 0) * cssPerPx / INK_PER_EM;
  const body = weigh(texts.filter(block => onPage(block) && size(block) < 24)).filter(c => contrastRatio(c.rgb, background) >= 2.2);
  const large = weigh(texts.filter(block => onPage(block) && size(block) >= 24)).filter(c => contrastRatio(c.rgb, background) >= 3);
  const text = body.find(c => contrastRatio(c.rgb, background) >= 4.5 && oklch(c.rgb).c < 0.1) ?? body[0];
  if (text) add(text.rgb, 'text', 'most used body-size ink on the background');
  if (large[0] && (!text || deltaE(large[0].rgb, text.rgb) >= 5)) add(large[0].rgb, 'heading', 'ink of large type on the background');
  const muted = body.find(c => c !== text && oklch(c.rgb).c < 0.1 && (!text || contrastRatio(c.rgb, background) < contrastRatio(text.rgb, background)));
  if (muted) add(muted.rgb, 'muted-text', 'lower-contrast body ink');
  const fills = (list: Block[]) => { const found: Array<{ rgb: Rgb; weight: number }> = []; for (const block of list) { const rgb = block.fill ? parseHex(block.fill) : undefined; if (!rgb) continue; const w = block.width * block.height; const home = found.find(c => deltaE(c.rgb, rgb) < 4); if (home) home.weight += w; else found.push({ rgb, weight: w }); } return found.sort((a, b) => b.weight - a.weight); };
  const buttonFills = fills(blocks.filter(block => block.role === 'button')).filter(c => deltaE(c.rgb, background) > 8);
  const primary = buttonFills.find(c => oklch(c.rgb).c >= 0.06) ?? buttonFills[0];
  if (primary) add(primary.rgb, 'primary', 'button fill');
  const bands = sections.filter(section => !section.busy && deltaE(section.background, background) >= 1.5).map(section => ({ rgb: section.background, weight: section.height * pageWidth }));
  const containers = fills(blocks.filter(block => (block.kind === 'container' || block.kind === 'flat') && block.role !== 'button' && block.width * block.height * cssPerPx * cssPerPx >= 4000));
  const light = luminance(background) > 0.4;
  let surfaces = 0;
  for (const c of [...containers, ...bands].sort((a, b) => b.weight - a.weight)) {
    const dark = luminance(c.rgb) < 0.05, chroma = oklch(c.rgb).c;
    if (light && dark) add(c.rgb, 'dark-surface', 'dark band or panel');
    else if (chroma >= 0.1 && deltaE(c.rgb, background) > 20) { if (!primary) add(c.rgb, 'primary', 'saturated band or panel'); else add(c.rgb, 'accent-surface', 'saturated band or panel'); }
    else if (surfaces < 2 && add(c.rgb, surfaces ? 'surface-2' : 'surface', 'card or band fill')) surfaces++;
  }
  const borders = blocks.filter(block => block.border).map(block => parseHex(block.border!)!);
  if (borders[0]) add(borders[0], 'border', 'outline of a panel');
  // Text on colored or dark fills: white on the primary button, light on a footer.
  const onColor = texts.filter(block => !onPage(block)).map(block => ({ rgb: parseHex(block.colors[1])!, on: parseHex(block.colors[0])! })).filter(c => c.rgb && c.on);
  const onPrimary = primary && onColor.find(c => deltaE(c.on, primary.rgb) < 6);
  if (onPrimary) add(onPrimary.rgb, 'on-primary', 'text on the primary fill');
  const onDark = onColor.find(c => luminance(c.on) < 0.05 && (!onPrimary || deltaE(c.rgb, onPrimary.rgb) >= 3));
  if (onDark) add(onDark.rgb, 'on-dark', 'text on a dark band');
  for (const icon of blocks.filter(block => block.kind === 'icon')) { const rgb = icon.colors.map(parseHex).find(c => c && deltaE(c, background) > 10 && oklch(c).c >= 0.08); if (rgb) add(rgb, 'secondary-accent', 'icon color', false); }
  for (const color of pixels) if (color.coverage >= 0.5) add(color.rgb, color.oklch.c >= 0.08 ? 'secondary-accent' : 'neutral', `${color.coverage}% of pixels`, false);
  return out.slice(0, 16);
}

/** The color that dominates the outer frame, and how uniform the frame is. */
export function borderColor(img: Rgba): { rgb: Rgb; uniformity: number } {
  const counts = new Map<number, { n: number; rgb: Rgb }>();
  let total = 0;
  const visit = (x: number, y: number) => {
    const rgb = pixel(img, x, y), key = quantKey(rgb[0], rgb[1], rgb[2], 4);
    const row = counts.get(key) ?? { n: 0, rgb }; row.n++; counts.set(key, row); total++;
  };
  const step = Math.max(1, Math.floor((img.width + img.height) / 800));
  for (let x = 0; x < img.width; x += step) { visit(x, 0); visit(x, img.height - 1); }
  for (let y = 0; y < img.height; y += step) { visit(0, y); visit(img.width - 1, y); }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return { rgb: best?.rgb ?? [255, 255, 255], uniformity: best ? Math.round(best.n / total * 100) / 100 : 0 };
}

// ───────────────────────────── segmentation ───────────────────────────────

export interface Box { x: number; y: number; width: number; height: number; }
export interface Section { id: string; y: number; height: number; background: Rgb; busy?: boolean; gradient?: { from: string; to: string }; }

/** Row-wise background: the color at both page edges when they agree (a
 * band's background shows at its edges even when content fills the middle),
 * else the dominant color and its share. A row without agreeing edges whose
 * dominant color covers under 45% of the width is "busy": a full-bleed photo
 * or pattern rather than a flat band. */
function rowProfile(img: Rgba, y: number): { rgb: Rgb; share: number; edges: boolean } {
  const edge = (x0: number) => { let r = 0, g = 0, b = 0; for (let x = x0; x < x0 + 3; x++) { const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; } return [r / 3, g / 3, b / 3].map(Math.round) as Rgb; };
  if (img.width >= 24) {
    const left = edge(0), right = edge(img.width - 3);
    if (deltaE(left, right) < 2) return { rgb: left, share: 1, edges: true };
  }
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(img.width / 160));
  let total = 0;
  for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 4, key = quantKey(img.data[i], img.data[i + 1], img.data[i + 2], 5);
    const bin = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += img.data[i]; bin.g += img.data[i + 1]; bin.b += img.data[i + 2]; counts.set(key, bin); total++;
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of counts.values()) if (bin.n > best.n) best = bin;
  return { rgb: [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) as Rgb, share: best.n / total, edges: false };
}
/** Horizontal bands of consistent background (navigation, hero, feature
 * band, footer…). Consecutive rows are compared with each other, so a smooth
 * gradient stays one band while a step of about one just-noticeable
 * difference (a #f5f3ff band on white) starts a new one. */
export function segmentSections(img: Rgba, options: { minHeight?: number } = {}): Section[] {
  const minHeight = options.minHeight ?? Math.max(16, Math.round(img.height / 120));
  const runs: Array<{ y: number; height: number; first: Rgb; last: Rgb; busy: boolean }> = [];
  for (let y = 0; y < img.height; y++) {
    const row = rowProfile(img, y), current = runs.at(-1);
    const busy = !row.edges && row.share < 0.45;
    if (current && (busy ? current.busy : !current.busy && deltaE(current.last, row.rgb) < 2)) { current.height++; if (!busy) current.last = row.rgb; continue; }
    runs.push({ y, height: 1, first: row.rgb, last: row.rgb, busy });
  }
  const merged: typeof runs = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && (run.height < minHeight || (!run.busy && !last.busy && deltaE(last.last, run.first) < 2))) { last.height += run.height; if (!run.busy && run.height >= minHeight) last.last = run.last; }
    else merged.push({ ...run });
  }
  if (merged.length > 1 && merged[0].height < minHeight) { merged[1].y = 0; merged[1].height += merged[0].height; merged.shift(); }
  return merged.map((run, index) => {
    const gradient = !run.busy && deltaE(run.first, run.last) >= 4 ? { from: hex(run.first), to: hex(run.last) } : undefined;
    return { id: `s${index + 1}`, y: run.y, height: run.height, background: run.first, ...(run.busy ? { busy: true } : {}), ...(gradient ? { gradient } : {}) };
  });
}

// ──────────────────────────────── blocks ──────────────────────────────────

export type BlockKind = 'text' | 'flat' | 'gradient' | 'icon' | 'image' | 'container' | 'divider' | 'mixed';
export interface Block extends Box {
  id: string; section: string; kind: BlockKind; confidence: number; parent?: string; role?: string;
  colors: string[]; fill?: string; border?: string; radius?: number; lines?: number; ink?: number; pitch?: number; gradient?: { from: string; to: string; angle: number };
  implement: 'css' | 'svg' | 'raster' | 'text' | 'css+children';
}

const inside = (outer: Box, inner: Box, slack = 0) => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Foreground ("ink") mask on a coarse grid: cells whose pixels differ
 * clearly from the local background, dilated so letters join into words and
 * lines, then connected components as boxes. Excluded boxes (surfaces found
 * separately) are left out. */
function components(img: Rgba, area: Box, background: Rgb, cell: number, dilate: number, exclude: Box[] = []): Box[] {
  const cols = Math.ceil(area.width / cell), rows = Math.ceil(area.height / cell);
  if (cols < 1 || rows < 1) return [];
  const on = new Uint8Array(cols * rows);
  const bgLab = oklab(background);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = area.x + cx * cell, y0 = area.y + cy * cell;
    const cx0 = x0 + cell / 2, cy0 = y0 + cell / 2, slack = cell / 2 + 1;
    if (exclude.some(box => cx0 >= box.x - slack && cx0 < box.x + box.width + slack && cy0 >= box.y - slack && cy0 < box.y + box.height + slack)) continue;
    let hits = 0, seen = 0;
    for (let y = y0; y < Math.min(y0 + cell, area.y + area.height); y++) for (let x = x0; x < Math.min(x0 + cell, area.x + area.width); x++) {
      seen++;
      if (alphaAt(img, x, y) < 16) continue;
      const lab = oklab(pixel(img, x, y));
      if (100 * Math.hypot(lab[0] - bgLab[0], lab[1] - bgLab[1], lab[2] - bgLab[2]) > 9) hits++;
    }
    if (seen && hits / seen >= 0.12) on[cy * cols + cx] = 1;
  }
  const grown = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (!on[cy * cols + cx]) continue;
    for (let dy = -dilate; dy <= dilate; dy++) for (let dx = -dilate; dx <= dilate; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < cols && y < rows) grown[y * cols + x] = 1;
    }
  }
  const label = new Int32Array(cols * rows).fill(-1), boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, cells = 0;
    stack.push(start); label[start] = boxes.length;
    while (stack.length) {
      const index = stack.pop()!, x = index % cols, y = (index - x) / cols;
      if (on[index]) { cells++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      for (const next of [index - 1, index + 1, index - cols, index + cols]) {
        if (next < 0 || next >= cols * rows || label[next] >= 0 || !grown[next]) continue;
        if ((next === index - 1 && x === 0) || (next === index + 1 && x === cols - 1)) continue;
        label[next] = boxes.length; stack.push(next);
      }
    }
    boxes.push(cells >= 2 && maxX >= 0 ? { x: area.x + minX * cell, y: area.y + minY * cell, width: Math.min(area.x + area.width, area.x + (maxX + 1) * cell) - (area.x + minX * cell), height: Math.min(area.y + area.height, area.y + (maxY + 1) * cell) - (area.y + minY * cell) } : { x: 0, y: 0, width: 0, height: 0 });
  }
  return boxes.filter(box => box.width > 0 && box.height > 0);
}

/** Subtle filled panels (cards, bands, inputs) that the ink threshold does
 * not see: uniform grid cells a just-noticeable step away from the
 * background, grown by color similarity, kept when their outline is closed. */
function surfaces(img: Rgba, area: Box, background: Rgb, cell: number, minSize: number): Array<Box & { fill: Rgb }> {
  const cols = Math.floor(area.width / cell), rows = Math.floor(area.height / cell);
  if (cols < 3 || rows < 3) return [];
  const mean: Rgb[] = new Array(cols * rows), flat = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = area.x + cx * cell, y0 = area.y + cy * cell;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) { const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    const m: Rgb = [r / n, g / n, b / n]; mean[cy * cols + cx] = m;
    if (deltaE(m, background) < 1.2) continue;
    let uniform = true;
    for (const [x, y] of [[x0, y0], [x0 + cell - 1, y0], [x0, y0 + cell - 1], [x0 + cell - 1, y0 + cell - 1], [x0 + (cell >> 1), y0 + (cell >> 1)]]) if (deltaE(pixel(img, x, y), m) > 2.5) { uniform = false; break; }
    if (uniform) flat[cy * cols + cx] = 1;
  }
  const seen = new Uint8Array(cols * rows), found: Array<Box & { fill: Rgb }> = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!flat[start] || seen[start]) continue;
    const seed = mean[start], stack = [start];
    // Grown by similarity to the seed; seeds at a panel edge are mixed, so
    // the final fill is recomputed from the panel's core below.
    seen[start] = 1;
    let minX = cols, minY = rows, maxX = -1, maxY = -1, count = 0;
    const member = new Set<number>();
    while (stack.length) {
      const i = stack.pop()!, x = i % cols, y = (i - x) / cols;
      member.add(i); count++;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const next of [i - 1, i + 1, i - cols, i + cols]) {
        if (next < 0 || next >= cols * rows || seen[next] || !flat[next]) continue;
        if ((next === i - 1 && x === 0) || (next === i + 1 && x === cols - 1)) continue;
        if (deltaE(mean[next], seed) > 2) continue;
        seen[next] = 1; stack.push(next);
      }
    }
    const w = (maxX - minX + 1) * cell, h = (maxY - minY + 1) * cell;
    if (w < minSize || h < minSize * 0.6 || count < 6) continue;
    if (w >= area.width * 0.97 && h >= area.height * 0.9) continue;
    // Rectangular panels fill their corners (12% in); circles and blobs do not.
    const probe = (fx: number, fy: number) => member.has(Math.round(minY + fy * (maxY - minY)) * cols + Math.round(minX + fx * (maxX - minX)));
    if ([probe(0.12, 0.12), probe(0.88, 0.12), probe(0.12, 0.88), probe(0.88, 0.88)].filter(Boolean).length < 3) continue;
    // A panel's outline (one cell in from its box) is mostly the panel itself;
    // an irregular blob or an illustration is not.
    let ring = 0, hits = 0;
    for (let x = minX + 1; x < maxX; x++) for (const y of [minY + 1, maxY - 1]) { ring++; if (member.has(y * cols + x)) hits++; }
    for (let y = minY + 1; y < maxY; y++) for (const x of [minX + 1, maxX - 1]) { ring++; if (member.has(y * cols + x)) hits++; }
    if (!ring || hits / ring < 0.7) continue;
    // The fill is the panel's most distinct cells (edge cells mix with the
    // background at low contrast), then the box grows to the true edge:
    // cells align to the area, panels do not.
    const cellsByDistance = [...member].map(i => ({ rgb: mean[i], d: deltaE(mean[i], background) })).sort((a, b) => b.d - a.d);
    const core = cellsByDistance.slice(0, Math.max(1, Math.ceil(cellsByDistance.length * 0.6)));
    const fill = core.reduce((acc, c) => [acc[0] + c.rgb[0] / core.length, acc[1] + c.rgb[1] / core.length, acc[2] + c.rgb[2] / core.length], [0, 0, 0]) as Rgb;
    const box = { x: area.x + minX * cell, y: area.y + minY * cell, width: w, height: h };
    const edge = (x: number, y: number) => { if (x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height) return false; const p = pixel(img, x, y), d = deltaE(p, fill); return d < 3 && d < deltaE(p, background); };
    const mx = box.x + (box.width >> 1), my = box.y + (box.height >> 1);
    while (box.x > area.x && edge(box.x - 1, my)) { box.x--; box.width++; }
    while (box.x + box.width < area.x + area.width && edge(box.x + box.width, my)) box.width++;
    while (box.y > area.y && edge(mx, box.y - 1)) { box.y--; box.height++; }
    while (box.y + box.height < area.y + area.height && edge(mx, box.y + box.height)) box.height++;
    found.push({ ...box, fill: fill.map(Math.round) as Rgb });
  }
  // Largest first; nested panels belong to the recursion into their parent.
  found.sort((a, b) => b.width * b.height - a.width * a.height);
  return found.filter((panel, i) => !found.slice(0, i).some(other => inside(other, panel, 2))).slice(0, 48);
}

/** Outlined panels (cards and inputs drawn with a thin low-contrast border
 * on the background color): paired long horizontal runs joined by vertical
 * runs. Also returns long unpaired runs as dividers. */
function outlines(img: Rgba, area: Box, background: Rgb, minLength: number): { boxes: Array<Box & { border: Rgb; radius: number }>; rules: Array<Box & { color: Rgb }> } {
  const differs = (x: number, y: number) => deltaE(pixel(img, x, y), background) > 3;
  const runs: Array<{ y: number; x0: number; x1: number; color: Rgb }> = [];
  for (let y = area.y; y < area.y + area.height; y++) {
    let start = -1;
    for (let x = area.x; x <= area.x + area.width; x++) {
      const on = x < area.x + area.width && differs(x, y) && (start < 0 || deltaE(pixel(img, x, y), pixel(img, start, y)) < 6);
      if (on && start < 0) start = x;
      else if (!on && start >= 0) { if (x - start >= minLength) runs.push({ y, x0: start, x1: x - 1, color: pixel(img, start + ((x - start) >> 1), y) }); start = on ? x : -1; if (x < area.x + area.width && differs(x, y)) start = x; }
    }
  }
  // Thick fills produce many stacked runs; keep only runs whose row above or
  // below is background (a line's edges), then collapse stacked neighbours.
  const edges = runs.filter(run => { const mid = (run.x0 + run.x1) >> 1; return (run.y === area.y || !differs(mid, run.y - 1)) || (run.y === area.y + area.height - 1 || !differs(mid, run.y + 1)); });
  const lines: typeof runs = [];
  for (const run of edges) { const prev = lines.at(-1); if (prev && run.y - prev.y <= 2 && Math.abs(run.x0 - prev.x0) <= 2 && Math.abs(run.x1 - prev.x1) <= 2) continue; lines.push(run); }
  const thin = lines.filter(run => { const mid = (run.x0 + run.x1) >> 1; let t = 0; while (t < 6 && run.y + t < area.y + area.height && differs(mid, run.y + t)) t++; return t <= 4; });
  const boxes: Array<Box & { border: Rgb; radius: number }> = [], used = new Set<number>();
  const column = (x: number, y0: number, y1: number) => { let n = 0; for (let y = y0; y <= y1; y++) if (differs(x, y)) n++; return n / Math.max(1, y1 - y0 + 1); };
  for (let i = 0; i < thin.length; i++) {
    if (used.has(i)) continue;
    const top = thin[i];
    for (let j = i + 1; j < thin.length; j++) {
      const bottom = thin[j];
      if (used.has(j) || bottom.y - top.y < 16 || Math.abs(bottom.x0 - top.x0) > 3 || Math.abs(bottom.x1 - top.x1) > 3 || deltaE(top.color, bottom.color) > 8) continue;
      const y0 = top.y + 1, y1 = bottom.y - 1, reach = Math.min(40, (bottom.y - top.y) >> 1);
      let left = -1, right = -1;
      for (let x = top.x0 + 2; x >= Math.max(area.x, top.x0 - reach) && left < 0; x--) if (column(x, y0 + reach, y1 - reach) >= 0.8) left = x;
      for (let x = top.x1 - 2; x <= Math.min(area.x + area.width - 1, top.x1 + reach) && right < 0; x++) if (column(x, y0 + reach, y1 - reach) >= 0.8) right = x;
      if (left < 0 || right < 0) continue;
      used.add(i); used.add(j);
      boxes.push({ x: left, y: top.y, width: right - left + 1, height: bottom.y - top.y + 1, border: top.color, radius: Math.max(0, top.x0 - left) });
      break;
    }
  }
  const rules = thin.filter((run, i) => !used.has(i) && run.x1 - run.x0 >= minLength * 2 && !boxes.some(box => inside(box, { x: run.x0, y: run.y, width: run.x1 - run.x0 + 1, height: 1 }, 2)))
    .map(run => ({ x: run.x0, y: run.y, width: run.x1 - run.x0 + 1, height: 1, color: run.color }));
  return { boxes: boxes.slice(0, 48), rules: rules.slice(0, 48) };
}

interface BlockStats { top: Array<{ rgb: Rgb; share: number }>; unique: number; edge: number; smooth: number; transitions: number; lines: number; ink: number; pitch: number; }
function blockStats(img: Rgba, box: Box, background: Rgb): BlockStats {
  const stride = Math.max(1, Math.floor(Math.sqrt(box.width * box.height / 40_000)));
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0, edges = 0, pairs = 0, diffSum = 0;
  const bgLab = oklab(background);
  let transitions = 0, rowsWithInk = 0;
  const inkRows: boolean[] = [];
  for (let y = box.y; y < box.y + box.height; y += stride) {
    let previousInk = false, rowTransitions = 0, rowInk = false, previousLum = -1;
    for (let x = box.x; x < box.x + box.width; x += stride) {
      const rgb = pixel(img, x, y), key = quantKey(rgb[0], rgb[1], rgb[2], 4);
      const bin = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }; bin.n++; bin.r += rgb[0]; bin.g += rgb[1]; bin.b += rgb[2]; counts.set(key, bin); total++;
      const lab = oklab(rgb), ink = 100 * Math.hypot(lab[0] - bgLab[0], lab[1] - bgLab[1], lab[2] - bgLab[2]) > 12;
      if (ink !== previousInk && x > box.x) rowTransitions++;
      previousInk = ink; rowInk ||= ink;
      const lum = lab[0] * 255;
      if (previousLum >= 0) { const diff = Math.abs(lum - previousLum); diffSum += diff; pairs++; if (diff > 40) edges++; }
      previousLum = lum;
    }
    inkRows.push(rowInk);
    if (rowInk) { rowsWithInk++; transitions += rowTransitions; }
  }
  // Text lines: runs of rows containing ink, separated by empty rows. Ink is
  // the run height (ascender to descender); pitch is the start-to-start step.
  const runs: Array<{ start: number; length: number }> = [];
  let run = 0;
  inkRows.push(false);
  inkRows.forEach((ink, index) => { if (ink) run++; else if (run) { runs.push({ start: (index - run) * stride, length: run * stride }); run = 0; } });
  const lengths = runs.map(r => r.length).sort((a, b) => a - b);
  const steps = runs.slice(1).map((r, i) => r.start - runs[i].start).sort((a, b) => a - b);
  const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 4).map(bin => ({ rgb: [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n].map(Math.round) as Rgb, share: bin.n / total }));
  return { top, unique: counts.size, edge: pairs ? edges / pairs : 0, smooth: pairs ? diffSum / pairs : 0, transitions: rowsWithInk ? transitions / rowsWithInk / Math.max(1, box.width / stride) : 0,
    lines: runs.length, ink: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0, pitch: steps.length ? steps[Math.floor(steps.length / 2)] : 0 };
}

function gradientOf(img: Rgba, box: Box): { from: string; to: string; angle: number; monotonic: boolean } {
  const sample = (fx: number, fy: number) => pixel(img, Math.min(img.width - 1, Math.round(box.x + fx * (box.width - 1))), Math.min(img.height - 1, Math.round(box.y + fy * (box.height - 1))));
  const horizontal = deltaE(sample(0.05, 0.5), sample(0.95, 0.5)), vertical = deltaE(sample(0.5, 0.05), sample(0.5, 0.95));
  const diagonal = deltaE(sample(0.05, 0.05), sample(0.95, 0.95));
  const best = Math.max(horizontal, vertical, diagonal);
  const [from, to, angle] = best === vertical ? [sample(0.5, 0.02), sample(0.5, 0.98), 180] : best === horizontal ? [sample(0.02, 0.5), sample(0.98, 0.5), 90] : [sample(0.02, 0.02), sample(0.98, 0.98), 135];
  const steps = [0.1, 0.3, 0.5, 0.7, 0.9].map(t => angle === 180 ? sample(0.5, t) : angle === 90 ? sample(t, 0.5) : sample(t, t)).map(rgb => oklab(rgb)[0]);
  const increasing = steps.every((v, i) => i === 0 || v >= steps[i - 1] - 0.01), decreasing = steps.every((v, i) => i === 0 || v <= steps[i - 1] + 0.01);
  return { from: hex(from), to: hex(to), angle, monotonic: increasing || decreasing };
}

/** Estimate a rounded-corner radius for a panel: walk the top-left diagonal
 * until the panel's fill color is reached. */
function cornerRadius(img: Rgba, box: Box, fill: Rgb): number {
  const limit = Math.min(64, Math.floor(Math.min(box.width, box.height) / 2));
  for (let d = 0; d < limit; d++) {
    const x = box.x + d, y = box.y + d;
    if (x >= img.width || y >= img.height) break;
    if (deltaE(pixel(img, x, y), fill) < 6) return d <= 1 ? 0 : Math.round(d / (1 - Math.SQRT1_2));
  }
  return 0;
}

/** Classify one box against its local background. `unit` is analysis
 * pixels per CSS pixel, so size rules hold at any analysis scale. */
export function classifyBlock(img: Rgba, box: Box, background: Rgb, unit = 1): Omit<Block, 'id' | 'section' | keyof Box> {
  const stats = blockStats(img, box, background);
  const [first, second] = stats.top;
  const colors = stats.top.slice(0, 3).map(row => hex(row.rgb));
  const w = box.width / unit, h = box.height / unit;
  const thin = h <= 4 || w <= 4;
  if (thin && Math.max(w, h) >= 24) return { kind: 'divider', confidence: 0.8, colors, fill: colors[0], implement: 'css' };
  const textFields = { lines: stats.lines, ink: stats.ink, ...(stats.lines >= 2 && stats.pitch ? { pitch: stats.pitch } : {}) };
  // Small, roughly square marks with few colors whose corners are background
  // are icons, even when one fill dominates (a filled circle is 78% fill).
  const cornersBackground = [[0.04, 0.04], [0.96, 0.04], [0.04, 0.96], [0.96, 0.96]].filter(([fx, fy]) => deltaE(pixel(img, Math.round(box.x + fx * (box.width - 1)), Math.round(box.y + fy * (box.height - 1))), background) < 6).length >= 3;
  if (w <= 96 && h <= 96 && w / h > 0.55 && w / h < 1.8 && stats.unique <= 40 && cornersBackground && first.share < 0.97) return { kind: 'icon', confidence: 0.7, colors, implement: 'svg' };
  if (first.share >= 0.92) {
    const radius = cornerRadius(img, box, first.rgb);
    return { kind: 'flat', confidence: Math.min(0.95, first.share), colors, fill: colors[0], ...(radius ? { radius } : {}), implement: first.share < 0.985 ? 'css+children' : 'css' };
  }
  const fillDiffers = deltaE(first.rgb, background) > 6;
  if (fillDiffers && first.share >= 0.5 && w >= 48 && h >= 24) {
    const radius = cornerRadius(img, box, first.rgb);
    return { kind: 'container', confidence: Math.min(0.9, first.share + 0.2), colors, fill: colors[0], ...(radius ? { radius } : {}), implement: 'css+children' };
  }
  if (stats.unique >= 16 && stats.smooth < 2.5 && stats.edge < 0.01 && w >= 40 && h >= 40) {
    const gradient = gradientOf(img, box);
    if (gradient.monotonic && deltaE(parseHex(gradient.from)!, parseHex(gradient.to)!) > 6)
      return { kind: 'gradient', confidence: 0.75, colors, gradient: { from: gradient.from, to: gradient.to, angle: gradient.angle }, implement: 'css' };
  }
  const twoTone = first.share + (second?.share ?? 0);
  // Stroke transitions per pixel fall as glyphs grow: about 2 per letter.
  const textLike = twoTone >= 0.72 && stats.transitions >= Math.min(0.035, 1.5 / Math.max(1, stats.ink)) && stats.ink > 0 && stats.ink / unit <= 120 && box.width >= box.height * 1.2;
  if (textLike) return { kind: 'text', confidence: Math.min(0.9, 0.5 + stats.transitions * 3), colors, ...textFields, implement: 'text' };
  const topThree = stats.top.slice(0, 3).reduce((sum, row) => sum + row.share, 0);
  if (Math.max(w, h) <= 160 && stats.unique <= 40 && topThree >= 0.7) return { kind: 'icon', confidence: 0.6, colors, implement: 'svg' };
  if (stats.unique >= 48 || stats.edge >= 0.06) return { kind: 'image', confidence: Math.min(0.9, 0.5 + stats.unique / 400), colors, implement: 'raster' };
  return { kind: 'mixed', confidence: 0.4, colors, ...(stats.lines ? textFields : {}), implement: stats.unique > 24 ? 'raster' : 'css+children' };
}

/** Join text fragments: words on one line (gap under ~1.2 ink heights) and
 * lines of one paragraph (similar ink, aligned, gap under ~1.1 ink). */
function mergeText(items: Array<Box & { kind: BlockKind; ink?: number }>, reclassify: (box: Box) => Box & { kind: BlockKind; ink?: number }) {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < items.length && !changed; i++) for (let j = 0; j < items.length && !changed; j++) {
      const a = items[i], b = items[j];
      // Large glyph fragments can classify as icons; they join a text line
      // of the same height beside them.
      const fragment = (x: typeof a, text: typeof a) => (x.kind === 'icon' || x.kind === 'mixed') && text.kind === 'text' && !!text.ink && Math.abs(x.height - text.height) <= 0.35 * text.height;
      if (i === j || !((a.kind === 'text' && b.kind === 'text') || fragment(a, b) || fragment(b, a))) continue;
      const aInk = a.ink || (a.kind === 'text' ? 0 : b.ink ?? 0), bInk = b.ink || (b.kind === 'text' ? 0 : a.ink ?? 0);
      if (!aInk || !bInk) continue;
      const ink = Math.max(aInk, bInk), similar = Math.min(aInk, bInk) / ink >= 0.65;
      const vOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const hGap = b.x - (a.x + a.width), vGap = b.y - (a.y + a.height);
      const sameLine = similar && vOverlap >= 0.6 * Math.min(a.height, b.height) && hGap >= -2 && hGap <= 1.2 * ink;
      const hOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      // Lines of one paragraph share their ink height (a title above body
      // copy is larger) and sit less than one ink height apart.
      const sameParagraph = a.kind === 'text' && b.kind === 'text' && Math.min(aInk, bInk) / ink >= 0.74 && vGap >= -2 && vGap <= ink && (Math.abs(a.x - b.x) <= Math.max(6, ink * 0.5) || hOverlap >= 0.5 * Math.min(a.width, b.width));
      if (!sameLine && !sameParagraph) continue;
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) };
      if (items.some((other, k) => k !== i && k !== j && overlapArea(other, box) > 0.2 * other.width * other.height && other.kind !== 'text')) continue;
      const merged = reclassify(box);
      if (merged.kind !== 'text') merged.kind = 'text';
      items.splice(Math.max(i, j), 1); items.splice(Math.min(i, j), 1, merged);
      changed = true;
    }
    if (!changed) break;
  }
}

/** Sections, then panels (subtle fills and outlines) and ink blocks within
 * them; panels and filled blocks are searched again for their children
 * against their own fill. `unit` is analysis pixels per CSS pixel. */
export function detectBlocks(img: Rgba, sections: Section[], options: { maxBlocks?: number; unit?: number } = {}): Block[] {
  const max = Math.max(1, Math.min(400, options.maxBlocks ?? 160)), unit = options.unit ?? 1;
  const cell = Math.max(2, Math.round(Math.max(img.width, 400) / 400));
  const blocks: Block[] = [];
  let counter = 0;
  const add = (block: Omit<Block, 'id'>) => { const full = { id: `b${++counter}`, ...block } as Block; blocks.push(full); return full; };
  const visit = (area: Box, background: Rgb, section: string, parent: string | undefined, depth: number) => {
    if (blocks.length >= max || area.width < 8 || area.height < 8) return;
    const panels: Array<Box & { fill?: Rgb; border?: Rgb; radius?: number }> = [];
    if (depth < 2) {
      for (const panel of surfaces(img, area, background, cell, Math.round(40 * unit))) panels.push(panel);
      const drawn = outlines(img, area, background, Math.round(40 * unit));
      for (const box of drawn.boxes) if (!panels.some(panel => overlapArea(panel, box) > 0.5 * box.width * box.height)) panels.push(box);
      for (const rule of drawn.rules) if (blocks.length < max && !panels.some(panel => inside(panel, rule, 2))) add({ section, ...rule, kind: 'divider', confidence: 0.7, colors: [hex(rule.color)], fill: hex(rule.color), implement: 'css', ...(parent ? { parent } : {}) });
    }
    for (const panel of panels) {
      if (blocks.length >= max) return;
      const fill = panel.fill ?? background;
      const radius = panel.radius ?? cornerRadius(img, panel, fill);
      const block = add({ section, x: panel.x, y: panel.y, width: panel.width, height: panel.height, kind: 'container', confidence: 0.75, colors: [hex(fill), ...(panel.border ? [hex(panel.border)] : [])],
        fill: hex(fill), ...(panel.border ? { border: hex(panel.border) } : {}), ...(radius ? { radius } : {}), implement: 'css+children', ...(parent ? { parent } : {}) });
      const inset = Math.max(2, Math.round(radius / 3), panel.border ? 3 : 0);
      visit({ x: panel.x + inset, y: panel.y + inset, width: panel.width - 2 * inset, height: panel.height - 2 * inset }, fill, section, block.id, depth + 1);
    }
    const items: Array<Box & { kind: BlockKind; ink?: number; info: Omit<Block, 'id' | 'section' | keyof Box> }> = [];
    const classify = (box: Box) => { const info = classifyBlock(img, box, background, unit); return { ...box, kind: info.kind, ink: info.ink, info }; };
    for (const box of components(img, area, background, cell, 2, panels)) {
      if (box.width * box.height < cell * cell * 3) continue;
      if (!parent && box.width >= img.width * 0.98 && box.height >= area.height * 0.98) continue;
      items.push(classify(box));
    }
    mergeText(items, classify as any);
    for (const item of items) {
      if (blocks.length >= max) return;
      const { info } = item as any;
      const block = add({ section, x: item.x, y: item.y, width: item.width, height: item.height, ...info, kind: item.kind, ...(parent ? { parent } : {}) });
      const recurse = (info.kind === 'container' || (info.kind === 'flat' && info.implement === 'css+children')) && depth < 2 && info.fill;
      if (recurse) {
        const inset = Math.max(2, info.radius ? Math.round(info.radius / 3) : 2);
        visit({ x: item.x + inset, y: item.y + inset, width: Math.max(1, item.width - 2 * inset), height: Math.max(1, item.height - 2 * inset) }, parseHex(info.fill)!, section, block.id, depth + 1);
      }
    }
  };
  for (const section of sections) visit({ x: 0, y: section.y, width: img.width, height: section.height }, section.background, section.id, undefined, 0);
  return blocks;
}

// ─────────────────────────── layout and rhythm ────────────────────────────

const cluster = (values: number[], tolerance: number) => {
  const sorted = [...values].sort((a, b) => a - b), groups: number[][] = [];
  for (const value of sorted) { const last = groups.at(-1); if (last && value - last.at(-1)! <= tolerance) last.push(value); else groups.push([value]); }
  return groups.map(group => ({ value: Math.round(group.reduce((sum, v) => sum + v, 0) / group.length), count: group.length })).sort((a, b) => b.count - a.count);
};

/** Content container, alignment lines and column structure inferred from
 * top-level block edges. */
export function layoutGrid(blocks: Block[], width: number, minPeerHeight = 0) {
  const top = blocks.filter(block => !block.parent && block.kind !== 'divider' && block.width < width * 0.98);
  if (!top.length) return { container: { x: 0, width, margin: 0 }, alignment: [] as number[], columns: [] as Array<{ section: string; count: number; gutter: number }> };
  const left = cluster(top.map(block => block.x), 6), right = cluster(top.map(block => block.x + block.width), 6);
  const x0 = Math.min(...top.map(block => block.x)), x1 = Math.max(...top.map(block => block.x + block.width));
  const columns: Array<{ section: string; count: number; gutter: number }> = [];
  const bySection = new Map<string, Block[]>();
  for (const block of top) bySection.set(block.section, [...(bySection.get(block.section) ?? []), block]);
  for (const [section, all] of bySection) {
    // Peer blocks share a top edge within tolerance and have similar widths;
    // short rows of buttons or links are not columns.
    const rows = all.filter(block => block.height >= minPeerHeight);
    const bands = cluster(rows.map(block => block.y), 12).filter(band => band.count >= 2);
    for (const band of bands.slice(0, 1)) {
      const peers = rows.filter(block => Math.abs(block.y - band.value) <= 12).sort((a, b) => a.x - b.x);
      const widths = peers.map(block => block.width), mean = widths.reduce((s, v) => s + v, 0) / widths.length;
      if (peers.length >= 2 && widths.every(w => Math.abs(w - mean) / mean < 0.25)) {
        const gaps = peers.slice(1).map((block, i) => block.x - (peers[i].x + peers[i].width)).filter(gap => gap > 0);
        columns.push({ section, count: peers.length, gutter: gaps.length ? Math.round(gaps.reduce((s, v) => s + v, 0) / gaps.length) : 0 });
      }
    }
  }
  return { container: { x: x0, width: x1 - x0, margin: Math.round((x0 + (width - x1)) / 2) }, alignment: [...left.slice(0, 4), ...right.slice(0, 2)].map(row => row.value).sort((a, b) => a - b), columns };
}

/** Spacing values between vertically stacked blocks and the base unit that
 * explains them best (4, 5, 6 or 8 px). */
export function spacingRhythm(blocks: Block[]) {
  const gaps: number[] = [];
  const bySection = new Map<string, Block[]>();
  for (const block of blocks.filter(block => !block.parent)) bySection.set(block.section, [...(bySection.get(block.section) ?? []), block]);
  for (const rows of bySection.values()) {
    const sorted = [...rows].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1], current = sorted[i];
      const overlap = Math.min(previous.x + previous.width, current.x + current.width) - Math.max(previous.x, current.x);
      const gap = current.y - (previous.y + previous.height);
      if (overlap > 0 && gap > 0 && gap < 400) gaps.push(gap);
    }
  }
  const values = cluster(gaps, 3).slice(0, 6).map(row => row.value).sort((a, b) => a - b);
  let unit = 8, bestError = Infinity;
  for (const candidate of [4, 5, 6, 8]) {
    const error = gaps.reduce((sum, gap) => sum + Math.abs(gap - Math.round(gap / candidate) * candidate) / candidate, 0) / Math.max(1, gaps.length) + (candidate === 8 ? 0 : candidate === 4 ? 0.02 : 0.05);
    if (error < bestError) { bestError = error; unit = candidate; }
  }
  return { unit, values, samples: gaps.length };
}

/** Text size levels from the ink height of text lines. Ink spans ascenders
 * to descenders, about 0.93 em in common Latin fonts (all-caps lines read
 * about 20% small). Pitch, when a block has several lines, is the line
 * height. Values are analysis pixels. */
export const INK_PER_EM = 0.93;
export function typeScale(blocks: Block[]) {
  const texts = blocks.filter(block => block.kind === 'text' && block.ink);
  const sorted = [...texts].sort((a, b) => a.ink! - b.ink!), groups: Block[][] = [];
  for (const block of sorted) { const last = groups.at(-1); if (last && block.ink! - last.at(-1)!.ink! <= Math.max(2, last.at(-1)!.ink! * 0.1)) last.push(block); else groups.push([block]); }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return groups.map(group => {
    const pitches = group.filter(block => block.pitch).map(block => block.pitch!);
    return { ink: median(group.map(block => block.ink!)), ...(pitches.length ? { pitch: median(pitches) } : {}), blocks: group.length, area: group.reduce((sum, block) => sum + block.width * block.height, 0) };
  }).sort((a, b) => b.blocks * Math.sqrt(b.area) - a.blocks * Math.sqrt(a.area)).slice(0, 6).sort((a, b) => b.ink - a.ink);
}

/** Name type levels around the body size (the most used level between 13
 * and 20 px): larger levels become display/h1/h2…, smaller small/caption.
 * One-off levels below body are dropped as noise. */
export function nameTypeLevels<T extends { fontSize: number; blocks: number }>(levels: T[]): Array<T & { name: string }> {
  const sorted = [...levels].sort((a, b) => b.fontSize - a.fontSize);
  const body = sorted.filter(level => level.fontSize >= 13 && level.fontSize <= 20).sort((a, b) => b.blocks - a.blocks)[0] ?? sorted.at(-1);
  if (!body) return [];
  const above = sorted.filter(level => level.fontSize > body.fontSize), below = sorted.filter(level => level.fontSize < body.fontSize && level.blocks >= 2);
  const heads = above.length >= 4 ? ['display', 'h1', 'h2', 'h3', 'h4', 'h5'] : ['h1', 'h2', 'h3'];
  return [
    ...above.map((level, index) => ({ ...level, name: heads[index] ?? `h${index + 1}` })),
    { ...body, name: 'body' },
    ...below.map((level, index) => ({ ...level, name: ['small', 'caption', 'micro'][index] ?? `small-${index + 1}` })),
  ];
}

// ─────────────────────────────── compare ──────────────────────────────────

export interface SectionComparison { id: string; y: number; height: number; meanDelta: number; changed: number; shift: number; shiftImprovement: number; }
export interface Comparison {
  width: number; height: number; heightDelta: number; meanDelta: number; changed: number; ssim: number;
  regions: Array<Box & { score: number }>; rowShift: { pixels: number; improvement: number }; missingColors: Array<{ hex: string; coverage: number }>; extraColors: Array<{ hex: string; coverage: number }>;
  sections: SectionComparison[];
}
const gray = (img: Rgba) => { const out = new Float32Array(img.width * img.height); for (let i = 0; i < out.length; i++) out[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]; return out; };

/** Compare a reference and a candidate of the same width. Heights may differ;
 * the overlap is compared and the difference reported. */
export function compareImages(reference: Rgba, candidate: Rgba, options: { threshold?: number; grid?: number; sections?: Section[] } = {}): { comparison: Comparison; heat: Rgba } {
  if (reference.width !== candidate.width) throw new Error('compareImages needs images of equal width');
  const width = reference.width, height = Math.min(reference.height, candidate.height);
  const threshold = options.threshold ?? 6;
  const a = gray(reference), b = gray(candidate);
  const delta = new Float32Array(width * height);
  let sum = 0, changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, p = i * 4;
    const d = deltaEFast(reference.data, candidate.data, p);
    delta[i] = d; sum += d; if (d > threshold) changed++;
  }
  // SSIM on 8x8 windows of luminance.
  let ssimSum = 0, windows = 0;
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  for (let y = 0; y + 8 <= height; y += 8) for (let x = 0; x + 8 <= width; x += 8) {
    let ma = 0, mb = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) { const i = (y + j) * width + x + k; ma += a[i]; mb += b[i]; }
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) { const i = (y + j) * width + x + k; va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb); }
    va /= 63; vb /= 63; cov /= 63;
    ssimSum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); windows++;
  }
  // Grid regions ranked by mean difference, adjacent hot cells merged.
  const grid = Math.max(8, options.grid ?? Math.round(width / 24));
  const cols = Math.ceil(width / grid), rows = Math.ceil(height / grid), cellScore = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    let s = 0, n = 0;
    for (let y = cy * grid; y < Math.min(height, (cy + 1) * grid); y += 2) for (let x = cx * grid; x < Math.min(width, (cx + 1) * grid); x += 2) { s += delta[y * width + x]; n++; }
    cellScore[cy * cols + cx] = n ? s / n : 0;
  }
  const hot = new Uint8Array(cols * rows); for (let i = 0; i < hot.length; i++) hot[i] = cellScore[i] > threshold * 1.5 ? 1 : 0;
  const seen = new Uint8Array(cols * rows), regions: Array<Box & { score: number }> = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    const stack = [start]; seen[start] = 1; let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, score = 0, cells = 0;
    while (stack.length) {
      const i = stack.pop()!, x = i % cols, y = (i - x) / cols; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); score += cellScore[i]; cells++;
      for (const n of [i - 1, i + 1, i - cols, i + cols]) { if (n < 0 || n >= hot.length || seen[n] || !hot[n]) continue; if ((n === i - 1 && x === 0) || (n === i + 1 && x === cols - 1)) continue; seen[n] = 1; stack.push(n); }
    }
    regions.push({ x: minX * grid, y: minY * grid, width: Math.min(width, (maxX + 1) * grid) - minX * grid, height: Math.min(height, (maxY + 1) * grid) - minY * grid, score: Math.round(score / cells * 10) / 10 });
  }
  regions.sort((p, q) => q.score * q.width * q.height - p.score * p.width * p.height);
  // Vertical shift: row luminance profiles aligned by minimum mean difference.
  const profile = (g: Float32Array, h: number) => Float32Array.from({ length: h }, (_, y) => { let s = 0; for (let x = 0; x < width; x += 4) s += g[y * width + x]; return s / Math.ceil(width / 4); });
  const pa = profile(a, reference.height), pb = profile(b, candidate.height);
  const score = (shift: number) => { let s = 0, n = 0; for (let y = 0; y < pa.length; y++) { const z = y + shift; if (z < 0 || z >= pb.length) continue; s += Math.abs(pa[y] - pb[z]); n++; } return n > pa.length * 0.5 ? s / n : Infinity; };
  const base = score(0); let bestShift = 0, best = base;
  const range = Math.min(240, Math.floor(height / 3));
  for (let shift = -range; shift <= range; shift += 2) { const s = score(shift); if (s < best) { best = s; bestShift = shift; } }
  // Per reference section: where it differs, and whether the candidate holds
  // the same content displaced vertically (spacing drift above it).
  const sections: SectionComparison[] = [];
  for (const section of options.sections ?? []) {
    const y0 = section.y, y1 = Math.min(section.y + section.height, height);
    if (y1 - y0 < 8) continue;
    let s = 0, n = 0, over = 0;
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < width; x += 2) { const d = delta[y * width + x]; s += d; n++; if (d > threshold) over++; }
    const local = (shift: number) => { let t = 0, m = 0; for (let y = y0; y < y1; y++) { const z = y + shift; if (z < 0 || z >= pb.length) continue; t += Math.abs(pa[y] - pb[z]); m++; } return m >= (y1 - y0) * 0.6 ? t / m : Infinity; };
    const zero = local(0); let shift = 0, bestLocal = zero;
    const reach = Math.min(240, Math.max(16, Math.round((y1 - y0) * 0.75)));
    for (let d = -reach; d <= reach; d++) { const v = local(d); if (v < bestLocal - 1e-6) { bestLocal = v; shift = d; } }
    const improvement = zero > 0 && Number.isFinite(bestLocal) ? Math.round((1 - bestLocal / zero) * 100) : 0;
    sections.push({ id: section.id, y: y0, height: y1 - y0, meanDelta: n ? Math.round(s / n * 10) / 10 : 0, changed: n ? Math.round(over / n * 1000) / 10 : 0, shift: improvement >= 15 ? shift : 0, shiftImprovement: improvement >= 15 ? improvement : 0 });
  }
  const refPalette = extractPalette(reference, { max: 12 }), candPalette = extractPalette(candidate, { max: 16 });
  const missingColors = refPalette.filter(color => color.coverage >= 0.5 && !candPalette.some(other => deltaE(other.rgb, color.rgb) < 8)).map(color => ({ hex: color.hex, coverage: color.coverage }));
  const extraColors = candPalette.filter(color => color.coverage >= 0.5 && !extractPalette(reference, { max: 16 }).some(other => deltaE(other.rgb, color.rgb) < 8)).map(color => ({ hex: color.hex, coverage: color.coverage }));
  // Heat map: dimmed reference luminance with red difference overlay.
  const heat = { width, height, data: new Uint8Array(width * height * 4) };
  for (let i = 0; i < width * height; i++) {
    const g = a[i] * 0.35 + 150 * 0.3, d = Math.min(1, delta[i] / 25);
    heat.data[i * 4] = Math.round(g * (1 - d) + 255 * d); heat.data[i * 4 + 1] = Math.round(g * (1 - d)); heat.data[i * 4 + 2] = Math.round(g * (1 - d)); heat.data[i * 4 + 3] = 255;
  }
  const comparison: Comparison = { width, height, heightDelta: candidate.height - reference.height, meanDelta: Math.round(sum / (width * height) * 100) / 100, changed: Math.round(changed / (width * height) * 1000) / 10,
    ssim: windows ? Math.round(ssimSum / windows * 1000) / 1000 : 1, regions: regions.slice(0, 12), rowShift: { pixels: bestShift, improvement: base > 0 && Number.isFinite(best) ? Math.round((1 - best / base) * 100) : 0 }, missingColors, extraColors, sections };
  return { comparison, heat };
}
/** Fast perceptual difference for two RGBA buffers at the same offset. */
function deltaEFast(a: Uint8Array, b: Uint8Array, p: number): number {
  if (a[p] === b[p] && a[p + 1] === b[p + 1] && a[p + 2] === b[p + 2]) return 0;
  return deltaE([a[p], a[p + 1], a[p + 2]], [b[p], b[p + 1], b[p + 2]]);
}

// ──────────────────────────────── tracing ─────────────────────────────────

/** Trace one binary mask into closed polygons along pixel boundaries, then
 * simplify with Ramer–Douglas–Peucker. Output coordinates are in pixels. */
export function traceMask(mask: Uint8Array, width: number, height: number, epsilon = 0.9): Array<Array<[number, number]>> {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  // Directed boundary edges with the inside on the left; keyed by start vertex.
  const edges = new Map<number, number[]>();
  const vkey = (x: number, y: number) => y * (width + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number) => { const k = vkey(x0, y0); const list = edges.get(k) ?? []; list.push(vkey(x1, y1)); edges.set(k, list); };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) add(x + 1, y, x, y);
    if (!inside(x, y + 1)) add(x, y + 1, x + 1, y + 1);
    if (!inside(x - 1, y)) add(x, y, x, y + 1);
    if (!inside(x + 1, y)) add(x + 1, y + 1, x + 1, y);
  }
  const loops: Array<Array<[number, number]>> = [];
  const point = (k: number): [number, number] => [k % (width + 1), Math.floor(k / (width + 1))];
  for (const [start] of edges) {
    while ((edges.get(start)?.length ?? 0) > 0) {
      const loop: Array<[number, number]> = [];
      let current = start, guard = 0;
      do {
        const next = edges.get(current)!.shift()!;
        if ((edges.get(current)?.length ?? 0) === 0) edges.delete(current);
        loop.push(point(current)); current = next;
        if (++guard > 4 * (width + 1) * (height + 1)) break;
      } while (current !== start && edges.has(current));
      if (loop.length >= 4) loops.push(simplify(loop, epsilon));
      if (!edges.has(start)) break;
    }
  }
  return loops.filter(loop => loop.length >= 3);
}
function simplify(points: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  if (points.length <= 4) return points;
  // Closed polygon: split at the farthest point from the first, simplify halves.
  let far = 0, farDistance = -1;
  for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]); if (d > farDistance) { farDistance = d; far = i; } }
  const rdp = (pts: Array<[number, number]>): Array<[number, number]> => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts.at(-1)!, length = Math.hypot(bx - ax, by - ay) || 1;
    let index = 0, max = -1;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / length; if (d > max) { max = d; index = i; } }
    if (max <= epsilon) return [pts[0], pts.at(-1)!];
    return [...rdp(pts.slice(0, index + 1)).slice(0, -1), ...rdp(pts.slice(index))];
  };
  const first = rdp(points.slice(0, far + 1)), second = rdp([...points.slice(far), points[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Project a color onto the segment between two colors (in RGB) and report
 * the mix ratio and the perceptual distance to that mix. */
function blendOf(color: Rgb, a: Rgb, b: Rgb): { t: number; distance: number } | undefined {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [color[0] - a[0], color[1] - a[1], color[2] - a[2]];
  const length = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (length < 1) return undefined;
  const t = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / length;
  if (t <= 0 || t >= 1) return undefined;
  return { t, distance: deltaE(color, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]) };
}

/** A color that sits on the line between two others is anti-aliasing (or a
 * soft edge), not a design color: tracing it would draw halo rings. */
function isBlend(color: Rgb, a: Rgb, b: Rgb): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [color[0] - a[0], color[1] - a[1], color[2] - a[2]];
  const length = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (length < 1) return false;
  const t = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / length;
  if (t < 0.08 || t > 0.92) return false;
  return deltaE(color, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]) < 5;
}

/** Fill colors for tracing: dominant non-background colors with blends between
 * already accepted colors (and the background) removed. */
export function tracePalette(img: Rgba, background: Rgb | undefined, colors = 4): Rgb[] {
  const candidates = extractPalette(img, { max: 16, mergeDelta: 9 });
  const accepted: Rgb[] = [];
  for (const color of candidates) {
    if (accepted.length >= colors) break;
    if (color.coverage < 0.4) continue;
    if (background && deltaE(color.rgb, background) < 10) continue;
    const anchors = background ? [background, ...accepted] : accepted;
    let blend = false;
    for (let i = 0; i < anchors.length && !blend; i++) for (let j = i + 1; j < anchors.length && !blend; j++) blend = isBlend(color.rgb, anchors[i], anchors[j]);
    if (!blend) accepted.push(color.rgb);
  }
  return accepted;
}

/** Scanline even-odd fill of closed polygons, sampled at pixel centers. */
export function rasterizeLoops(loops: Array<Array<[number, number]>>, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const crossings: number[] = [];
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    crossings.length = 0;
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length];
      if ((y0 <= cy && y1 > cy) || (y1 <= cy && y0 > cy)) crossings.push(x0 + (cy - y0) / (y1 - y0) * (x1 - x0));
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5)), to = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export interface TraceResult {
  svg: string; layers: Array<{ fill: string; paths: number; points: number }>; background: string | null;
  coverage: number; fidelity: number; unexplained: number; meanError: number; labels: Uint8Array; predicted: Uint8Array; palette: Rgb[];
}
/** Vectorize a flat-colored region: label every pixel with its nearest fill
 * (or the background), trace each fill's mask along pixel edges, simplify,
 * and measure fidelity by rasterizing the result again. Transparent pixels
 * count as background. Photographs and soft shading trace poorly; the
 * `unexplained` share (pixels far from every fill) says so. */
export function traceToSvg(img: Rgba, box: Box, options: { colors?: number; background?: Rgb | null; palette?: Rgb[]; epsilon?: number; minArea?: number; outputWidth?: number; outputHeight?: number; cornerAngle?: number } = {}): TraceResult {
  const w = box.width, h = box.height, n = w * h;
  const region: Rgba = { width: w, height: h, data: new Uint8Array(n * 4) };
  for (let y = 0; y < h; y++) region.data.set(img.data.subarray(((box.y + y) * img.width + box.x) * 4, ((box.y + y) * img.width + box.x + w) * 4), y * w * 4);
  let transparent = 0;
  for (let i = 0; i < n; i++) if (region.data[i * 4 + 3] < 128) transparent++;
  const background = options.background === null || transparent / n >= 0.05 ? undefined : options.background ?? borderColor(region).rgb;
  const palette = (options.palette ?? tracePalette(region, background, Math.max(1, Math.min(8, options.colors ?? 4)))).slice(0, 8);
  const labels = new Uint8Array(n);
  let unexplained = 0, foreground = 0, errorSum = 0, opaque = 0;
  for (let i = 0; i < n; i++) {
    if (region.data[i * 4 + 3] < 128) continue;
    opaque++;
    const rgb: Rgb = [region.data[i * 4], region.data[i * 4 + 1], region.data[i * 4 + 2]];
    let best = background ? deltaE(rgb, background) : Infinity, label = 0;
    for (let k = 0; k < palette.length; k++) { const d = deltaE(rgb, palette[k]); if (d < best) { best = d; label = k + 1; } }
    // Anti-aliased edges are blends of a fill and the background: a gray
    // edge pixel of black text can sit nearer a saturated fill of similar
    // lightness than to black. Classify blends by their mix ratio instead.
    if (background && best > 2) for (let k = 0; k < palette.length; k++) {
      const blend = blendOf(rgb, background, palette[k]);
      if (blend && blend.distance + 0.5 < best) { best = blend.distance; label = blend.t >= 0.5 ? k + 1 : 0; }
    }
    labels[i] = label;
    if (label) foreground++;
    if (Number.isFinite(best)) errorSum += best;
    if (best > 25) unexplained++;
  }
  const layers: TraceResult['layers'] = [], paths: string[] = [];
  const predicted = new Uint8Array(n);
  const minArea = options.minArea ?? Math.max(4, Math.round(n / 40_000));
  for (let k = 0; k < palette.length; k++) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (labels[i] === k + 1) mask[i] = 1;
    const loops = traceMask(mask, w, h, options.epsilon ?? 0.9).filter(loop => Math.abs(area(loop)) >= minArea);
    if (!loops.length) continue;
    const curves = loops.map(loop => smoothLoop(loop, options.cornerAngle ?? 40));
    const fill = rasterizeLoops(curves.map(curve => curve.flat), w, h);
    for (let i = 0; i < n; i++) if (fill[i]) predicted[i] = k + 1;
    const d = curves.map(curve => curve.d).join('');
    paths.push(`<path fill="${hex(palette[k])}" fill-rule="evenodd" d="${d}"/>`);
    layers.push({ fill: hex(palette[k]), paths: loops.length, points: loops.reduce((sum, loop) => sum + loop.length, 0) });
  }
  let agree = 0, union = 0;
  for (let i = 0; i < n; i++) { if (labels[i] || predicted[i]) { union++; if (labels[i] === predicted[i]) agree++; } }
  const size = options.outputWidth && options.outputHeight ? ` width="${options.outputWidth}" height="${options.outputHeight}"` : ` width="${w}" height="${h}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${size}>${paths.join('')}</svg>`;
  return { svg, layers, background: background ? hex(background) : null, coverage: Math.round(foreground / Math.max(1, n) * 1000) / 10,
    fidelity: union ? Math.round(agree / union * 1000) / 1000 : 1, unexplained: Math.round(unexplained / Math.max(1, n) * 1000) / 10, meanError: Math.round(errorSum / Math.max(1, opaque) * 10) / 10, labels, predicted, palette };
}
/** Closed path through simplified contour points: vertices turning more
 * than `cornerAngle` degrees stay sharp corners, the rest are joined by
 * Catmull-Rom cubic Béziers, so circles come out round and rectangles
 * square. Also returns the curve flattened for re-rasterization. */
export function smoothLoop(points: Array<[number, number]>, cornerAngle = 40): { d: string; flat: Array<[number, number]> } {
  const n = points.length;
  const r = (v: number) => Math.round(v * 100) / 100;
  if (n < 4) return { d: `M${points.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`, flat: points };
  const at = (i: number) => points[(i + n) % n];
  const corner = points.map((p, i) => {
    const a = at(i - 1), b = at(i + 1);
    const u = [p[0] - a[0], p[1] - a[1]], v = [b[0] - p[0], b[1] - p[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI > cornerAngle;
  });
  const parts = [`M${r(at(0)[0])} ${r(at(0)[1])}`], flat: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    if (corner[i] && corner[(i + 1) % n]) { parts.push(`L${r(p2[0])} ${r(p2[1])}`); flat.push(p1); continue; }
    const c1: [number, number] = corner[i] ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = corner[(i + 1) % n] ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    parts.push(`C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`);
    for (let s = 0; s < 8; s++) {
      const t = s / 8, m = 1 - t;
      flat.push([m * m * m * p1[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p2[0], m * m * m * p1[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p2[1]]);
    }
  }
  return { d: parts.join('') + 'Z', flat };
}
function area(loop: Array<[number, number]>) { let s = 0; for (let i = 0; i < loop.length; i++) { const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length]; s += x0 * y1 - x1 * y0; } return s / 2; }

// ─────────────────────────────── drawing ──────────────────────────────────

const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
/** Draw a rectangle outline and a small numeric label (3x5 digit font). */
export function drawBox(img: Rgba, box: Box, rgb: Rgb, label?: number, thickness = 2) {
  const set = (x: number, y: number, c: Rgb) => { if (x < 0 || y < 0 || x >= img.width || y >= img.height) return; const i = (y * img.width + x) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; };
  for (let t = 0; t < thickness; t++) {
    for (let x = box.x; x < box.x + box.width; x++) { set(x, box.y + t, rgb); set(x, box.y + box.height - 1 - t, rgb); }
    for (let y = box.y; y < box.y + box.height; y++) { set(box.x + t, y, rgb); set(box.x + box.width - 1 - t, y, rgb); }
  }
  if (label === undefined) return;
  const text = String(label), scale = 2, w = text.length * 4 * scale + scale, h = 5 * scale + 2 * scale;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(box.x + x, box.y + y, rgb);
  [...text].forEach((digit, index) => {
    const glyph = DIGITS[Number(digit)];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) if (glyph[gy * 3 + gx] === '1')
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) set(box.x + scale + index * 4 * scale + gx * scale + sx, box.y + scale + gy * scale + sy, [255, 255, 255]);
  });
}
export const KIND_COLORS: Record<BlockKind, Rgb> = { text: [37, 99, 235], flat: [100, 116, 139], gradient: [168, 85, 247], icon: [22, 163, 74], image: [234, 88, 12], container: [15, 118, 110], divider: [148, 163, 184], mixed: [220, 38, 38] };

// ──────────────────────────── asset helpers ───────────────────────────────

export function blank(width: number, height: number, rgb: Rgb = [255, 255, 255]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { width, height, data };
}
export function cropRgba(img: Rgba, box: Box): Rgba {
  const x = Math.max(0, Math.min(img.width - 1, Math.round(box.x))), y = Math.max(0, Math.min(img.height - 1, Math.round(box.y)));
  const width = Math.max(1, Math.min(img.width - x, Math.round(box.width))), height = Math.max(1, Math.min(img.height - y, Math.round(box.height)));
  const out = { width, height, data: new Uint8Array(width * height * 4) };
  for (let row = 0; row < height; row++) out.data.set(img.data.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + width) * 4), row * width * 4);
  return out;
}
/** Place images left to right, top-aligned, on a neutral canvas. */
export function composeRow(images: Rgba[], gap = 16, background: Rgb = [245, 245, 245]): Rgba {
  const width = images.reduce((sum, img) => sum + img.width, 0) + gap * Math.max(0, images.length - 1);
  const height = Math.max(...images.map(img => img.height));
  const out = blank(width, height, background);
  let x0 = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4, o = (y * width + x0 + x) * 4, a = img.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(img.data[i + c] * a + out.data[o + c] * (1 - a));
    }
    x0 += img.width + gap;
  }
  return out;
}
/** Render a label map (0 = background) with the given fill colors. */
export function paintLabels(labels: Uint8Array, width: number, height: number, colors: Rgb[], background: Rgb = [255, 255, 255]): Rgba {
  const out = blank(width, height, background);
  for (let i = 0; i < width * height; i++) { const k = labels[i]; if (!k) continue; const rgb = colors[k - 1]; out.data[i * 4] = rgb[0]; out.data[i * 4 + 1] = rgb[1]; out.data[i * 4 + 2] = rgb[2]; }
  return out;
}

/** Make a flat background transparent with a soft ramp. By default only
 * background reachable from the border is keyed, so interior pixels of the
 * same color (the white of an eye on a white page) stay opaque. Edge pixels
 * are un-blended from the background so no light or dark fringe remains. */
export function keyBackground(img: Rgba, background: Rgb, options: { tolerance?: number; softness?: number; connected?: boolean } = {}): { keyed: number } {
  const tolerance = options.tolerance ?? 8, softness = Math.max(1, options.softness ?? 10);
  const w = img.width, h = img.height, n = w * h, limit = tolerance + softness;
  const distance = new Float32Array(n);
  for (let i = 0; i < n; i++) distance[i] = deltaE([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]], background);
  const reach = new Uint8Array(n);
  if (options.connected === false) { for (let i = 0; i < n; i++) if (distance[i] < limit) reach[i] = 1; }
  else {
    const stack: number[] = [];
    const seed = (i: number) => { if (!reach[i] && distance[i] < limit) { reach[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop()!, x = i % w;
      // A ramp pixel is reached but does not spread: keying stops at the edge.
      if (distance[i] > tolerance) continue;
      if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (i >= w) seed(i - w); if (i < n - w) seed(i + w);
    }
  }
  let keyed = 0;
  for (let i = 0; i < n; i++) {
    if (!reach[i]) continue;
    const alpha = distance[i] <= tolerance ? 0 : Math.min(1, (distance[i] - tolerance) / softness);
    const p = i * 4;
    if (alpha > 0) for (let c = 0; c < 3; c++) img.data[p + c] = Math.max(0, Math.min(255, Math.round((img.data[p + c] - (1 - alpha) * background[c]) / alpha)));
    img.data[p + 3] = Math.min(img.data[p + 3], Math.round(alpha * 255));
    if (alpha < 1) keyed++;
  }
  return { keyed: Math.round(keyed / Math.max(1, n) * 1000) / 10 };
}
/** Bounding box of visible content: alpha above a floor, or (for opaque
 * images) pixels perceptibly different from the given background. */
export function trimBox(img: Rgba, background?: Rgb, tolerance = 6): Box {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const visible = img.data[i + 3] > 8 && (!background || deltaE([img.data[i], img.data[i + 1], img.data[i + 2]], background) > tolerance);
    if (visible) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? { x: 0, y: 0, width: img.width, height: img.height } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ─────────────────────────── design patterns ──────────────────────────────

export interface ComponentGroup { kind: BlockKind; role?: string; count: number; width: number; height: number; fill?: string; border?: string; radius?: number; inset?: { x: number; y: number }; children: string; blocks: string[]; }
/** Repeated components: blocks of one kind and fill with similar sizes.
 * Three cards with the same shape are one component used three times, which
 * is the pattern to reuse on pages no reference image shows. */
export function componentGroups(blocks: Block[]): ComponentGroup[] {
  const candidates = blocks.filter(block => block.kind !== 'divider' && block.kind !== 'text');
  const used = new Set<string>(), groups: ComponentGroup[] = [];
  const similar = (a: Block, b: Block) => a.kind === b.kind && (a.fill ?? '') === (b.fill ?? '')
    && Math.abs(a.width - b.width) <= Math.max(8, a.width * 0.08) && Math.abs(a.height - b.height) <= Math.max(8, a.height * 0.12);
  for (const block of candidates) {
    if (used.has(block.id)) continue;
    const members = candidates.filter(other => !used.has(other.id) && similar(block, other));
    if (members.length < 2) continue;
    members.forEach(member => used.add(member.id));
    const ids = new Set(members.map(member => member.id));
    const childKinds = new Map<string, number>(), insetX: number[] = [], insetY: number[] = [];
    for (const child of blocks) if (child.parent && ids.has(child.parent)) childKinds.set(child.kind, (childKinds.get(child.kind) ?? 0) + 1);
    for (const member of members) {
      const kids = blocks.filter(child => child.parent === member.id);
      if (!kids.length) continue;
      insetX.push(Math.min(...kids.map(kid => kid.x)) - member.x); insetY.push(Math.min(...kids.map(kid => kid.y)) - member.y);
    }
    const median = (values: number[]) => values.sort((p, q) => p - q)[Math.floor(values.length / 2)];
    groups.push({ kind: block.kind, ...(members[0].role ? { role: members[0].role } : {}), count: members.length, width: median(members.map(m => m.width)), height: median(members.map(m => m.height)),
      ...(block.fill ? { fill: block.fill } : {}), ...(block.border ? { border: block.border } : {}), ...(block.radius ? { radius: block.radius } : {}), ...(insetX.length ? { inset: { x: median(insetX), y: median(insetY) } } : {}),
      children: [...childKinds].map(([kind, count]) => `${Math.round(count / members.length * 10) / 10}×${kind}`).join(' + ') || 'none', blocks: members.slice(0, 12).map(m => m.id) });
  }
  return groups.sort((a, b) => b.count * b.width * b.height - a.count * a.width * a.height).slice(0, 16);
}

/** Guess interface roles for blocks (button, card, logo, badge). `cssPerPx`
 * converts analysis pixels to CSS pixels. Guesses, labelled as such. */
export function annotateRoles(blocks: Block[], sections: Section[], cssPerPx: number): void {
  const children = new Map<string, Block[]>();
  for (const block of blocks) if (block.parent) children.set(block.parent, [...(children.get(block.parent) ?? []), block]);
  const groups = componentGroups(blocks);
  const grouped = new Set(groups.flatMap(group => group.blocks));
  for (const block of blocks) {
    const w = block.width * cssPerPx, h = block.height * cssPerPx, kids = children.get(block.id) ?? [];
    const filled = block.kind === 'flat' || block.kind === 'container' || block.kind === 'gradient';
    if (filled && h >= 24 && h <= 72 && w >= 48 && w <= 420 && (kids.some(kid => kid.kind === 'text' || kid.kind === 'mixed') || block.kind !== 'flat')) block.role = 'button';
    else if (filled && h >= 16 && h <= 36 && w >= 24 && w <= 200 && !kids.length) block.role = 'badge';
    else if ((block.kind === 'container' || block.kind === 'flat') && kids.length >= 2 && grouped.has(block.id)) block.role = 'card';
  }
  const first = sections[0];
  if (first && first.height * cssPerPx <= 160) {
    const top = blocks.filter(block => block.section === first.id && !block.parent).sort((a, b) => a.x - b.x)[0];
    if (top && top.width * cssPerPx <= 260 && ['icon', 'image', 'text', 'mixed'].includes(top.kind)) top.role = 'logo';
  }
}

export interface SectionRole { id: string; role: string; reason: string; }
/** Guess each band's page role from position, type size and structure. */
export function sectionRoles(sections: Section[], blocks: Block[], width: number, cssPerPx: number, pageBackground: Rgb): SectionRole[] {
  const lines = blocks.filter(block => block.kind === 'text' && block.ink).map(block => block.ink! * cssPerPx / INK_PER_EM).sort((a, b) => a - b);
  const bodyLine = lines.length ? lines[Math.floor(lines.length / 2)] : 16;
  const grid = layoutGrid(blocks, width, 60 / cssPerPx);
  const roles: SectionRole[] = [];
  let hero = false;
  sections.forEach((section, index) => {
    const inside = blocks.filter(block => block.section === section.id), top = inside.filter(block => !block.parent);
    const texts = inside.filter(block => block.kind === 'text');
    const largest = Math.max(0, ...texts.map(block => (block.ink ?? 0) * cssPerPx / INK_PER_EM));
    const heightCss = section.height * cssPerPx;
    const columns = grid.columns.find(column => column.section === section.id);
    const image = top.find(block => block.kind === 'image' && block.width * block.height >= section.height * width * 0.35);
    const accentBand = oklch(section.background).c >= 0.08 && deltaE(section.background, pageBackground) > 15;
    const button = inside.some(block => block.role === 'button');
    let role = 'content', reason = `${top.length} top-level blocks`;
    if (!inside.length) { role = 'spacer'; reason = 'no content'; }
    else if (index === 0 && heightCss <= 160 && top.length >= 2) { role = 'navigation'; reason = `short first band (${Math.round(heightCss)}px) with ${top.length} items`; }
    else if (!hero && index <= 2 && largest >= Math.max(36, bodyLine * 1.8)) { role = 'hero'; hero = true; reason = `largest type (~${Math.round(largest)}px) near the top`; }
    else if (index === sections.length - 1 && sections.length > 2 && (luminance(section.background) < 0.12 || (texts.length >= 4 && largest <= bodyLine * 1.2))) { role = 'footer'; reason = 'last band with small dense text or a dark background'; }
    else if (columns && columns.count >= 3) { role = 'feature-grid'; reason = `${columns.count} peer blocks in a row (gutter ${Math.round(columns.gutter * cssPerPx)}px)`; }
    else if (columns && columns.count === 2) { role = 'split'; reason = 'two peer columns'; }
    else if (image) { role = 'media'; reason = 'one image dominates the band'; }
    else if (accentBand && button) { role = 'call-to-action'; reason = 'accent band with a button'; }
    else if (texts.length >= 2 && largest <= bodyLine * 1.3 && heightCss > 200) { role = 'text'; reason = 'mostly body-size text'; }
    roles.push({ id: section.id, role, reason });
  });
  return roles;
}
