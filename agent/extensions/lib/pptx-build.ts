/** Build .pptx decks from a declarative spec, with no office suite and no dependencies.
 *
 * A model supplies slides (title, bullets, columns, image, table, quote, notes) and never touches
 * OOXML or geometry. The layout engine places every shape inside the slide, measures the text it is
 * about to write, picks the largest type size that fits, and moves what still cannot fit onto a
 * continuation slide instead of shrinking it below a readable size or letting it overflow: the two
 * defects that hand-written python-pptx decks most often ship with. Titles are real title
 * placeholders, notes are real notes slides, images carry alt text, and the output is
 * deterministic for a given spec. */
import { writeZip, type ZipSource } from "./office-zip.ts";
import { escapeXml } from "./xml-lite.ts";
import { XML_HEAD, REL, REL_NS, coreProps, appProps, hexColor, fontName, describeImage, inlineRuns, OFFICE_BUILD_LIMITS, type DocxRun } from "./office-build.ts";

export type PptxItem = string | { text: string; level?: number; items?: PptxItem[]; children?: PptxItem[] } | PptxItem[];
export type PptxSlide = {
  layout?: "title" | "section" | "bullets" | "columns" | "image" | "table" | "quote" | "text";
  title?: string; subtitle?: string; notes?: string;
  bullets?: PptxItem | PptxItem[]; items?: PptxItem | PptxItem[]; text?: string;
  columns?: Array<{ heading?: string; title?: string; bullets?: PptxItem | PptxItem[]; items?: PptxItem | PptxItem[] }>;
  left?: PptxItem | PptxItem[] | { heading?: string; bullets?: PptxItem | PptxItem[] }; right?: PptxItem | PptxItem[] | { heading?: string; bullets?: PptxItem | PptxItem[] };
  image?: { path: string; alt?: string; caption?: string } | string;
  table?: { header?: string[]; rows: Array<Array<string | number | boolean | null>>; widths?: number[] };
  quote?: string | { text: string; cite?: string }; cite?: string;
};
export type PptxSpec = { title?: string; author?: string; size?: "16:9" | "4:3"; font?: string; accent?: string; dark?: boolean; footer?: string; slides: PptxSlide[] };
export type PptxBuild = { buffer: Buffer; stats: { slides: number; split: number; images: number; tables: number; notes: number }; warnings: string[] };

const PPTX_LIMITS = Object.freeze({ slides: 200, items: 400, rows: 500, columns: 10 });
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const CT = "application/vnd.openxmlformats-officedocument.presentationml";
const EMU = 914400;
const emu = (inches: number) => Math.round(inches * EMU);
const clean = (text: unknown) => String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/\r\n?/g, "\n");

/* ───────────── text measurement ───────────── */
const NARROW = new Set("iljtfI.,;:'|!()[]/ ".split("")), WIDE = new Set("mwMW@%&".split(""));
function charWidth(ch: string): number {
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.82;
  if (/[⺀-鿿가-힯＀-￯]/.test(ch)) return 1.0;
  if (/[A-Z]/.test(ch)) return 0.62;
  if (/\d/.test(ch)) return 0.52;
  return 0.5;
}
const SAFETY = 1.08;
const wordWidth = (word: string, size: number) => [...word].reduce((sum, ch) => sum + charWidth(ch), 0) * size * SAFETY;
/** Lines a paragraph takes at `size` points in a box `widthPt` wide (greedy word wrap; a word wider than the line breaks by character). */
function lineCount(text: string, size: number, widthPt: number, bold = false): number {
  const scale = bold ? 1.06 : 1;
  let lines = 0;
  for (const part of text.split("\n")) {
    let used = 0, current = 1;
    for (const word of part.split(/ +/).filter(Boolean)) {
      const width = wordWidth(word, size) * scale, gap = used ? wordWidth(" ", size) : 0;
      if (width > widthPt) { current += Math.floor((used + gap + width) / widthPt); used = (used + gap + width) % widthPt; continue; }
      if (used + gap + width > widthPt) { current++; used = width; } else used += gap + width;
    }
    lines += current;
  }
  return Math.max(lines, 1);
}
const plain = (text: string) => inlineRuns(text).map(run => run.text).join("");

type Item = { text: string; level: number };
function flatten(value: unknown, level = 0, out: Item[] = []): Item[] {
  if (value === undefined || value === null) return out;
  if (typeof value === "string") {
    for (const line of clean(value).split("\n")) { const text = line.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").trim(); if (text) out.push({ text, level }); }
  } else if (typeof value === "number" || typeof value === "boolean") out.push({ text: String(value), level });
  else if (Array.isArray(value)) for (const entry of value) flatten(entry, Array.isArray(entry) ? Math.min(level + 1, 2) : level, out);
  else if (typeof value === "object") {
    const entry = value as { text?: unknown; level?: unknown; items?: unknown; children?: unknown };
    const own = Number.isInteger(entry.level) ? Math.min(Math.max(entry.level as number, 0), 2) : level;
    if (typeof entry.text === "string" && entry.text.trim()) out.push({ text: clean(entry.text).replace(/\n+/g, " ").trim(), level: own });
    flatten(entry.items ?? entry.children, Math.min(own + 1, 2), out);
  }
  return out;
}

const levelSize = (size: number, level: number) => Math.max(size - 2 * level, 12);
const marginOf = (level: number) => 0.3 + 0.4 * level;
/** Height in inches of a bullet list at `size` points inside a box `widthIn` wide. */
function listHeight(items: Item[], size: number, widthIn: number): number {
  let points = 0;
  for (const item of items) {
    const own = levelSize(size, item.level);
    points += lineCount(plain(item.text), own, (widthIn - marginOf(item.level)) * 72) * own * 1.2 + own * 0.45;
  }
  return points / 72;
}
/** Words past which a slide is a wall of text however small it is set; the reader flags above 140. */
const MAX_WORDS = 110;
const wordsIn = (value: string) => (plain(value).match(/\S+/g) ?? []).length;
/** The largest size that fits in one box; when none does, chunks at `splitSize` that each fit. */
function fitList(items: Item[], widthIn: number, heightIn: number, sizes: number[], splitSize: number): { size: number; chunks: Item[][] } {
  const words = (list: Item[]) => list.reduce((sum, item) => sum + wordsIn(item.text), 0);
  if (words(items) <= MAX_WORDS) for (const size of sizes) if (size >= splitSize && listHeight(items, size, widthIn) <= heightIn) return { size, chunks: [items] };
  const chunks: Item[][] = []; let current: Item[] = [];
  for (const item of items) {
    if (current.length && (listHeight([...current, item], splitSize, widthIn) > heightIn || words([...current, item]) > MAX_WORDS)) { chunks.push(current); current = []; }
    current.push(item);
  }
  if (current.length) chunks.push(current);
  return { size: splitSize, chunks };
}
const blockHeight = (text: string, size: number, widthIn: number, bold = false) => lineCount(text, size, widthIn * 72, bold) * size * 1.2 / 72;
const fitBlock = (text: string, widthIn: number, heightIn: number, sizes: number[], bold = false) => sizes.find(size => blockHeight(text, size, widthIn, bold) <= heightIn) ?? sizes[sizes.length - 1];

/* ───────────── colours ───────────── */
const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
const mix = (a: string, b: string, weight: number) => [0, 2, 4].map(at => Math.round(channel(a, at) * weight + channel(b, at) * (1 - weight)).toString(16).padStart(2, "0")).join("").toUpperCase();
const luminance = (hex: string) => (0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 2) + 0.0722 * channel(hex, 4)) / 255;
const onColor = (hex: string) => luminance(hex) > 0.6 ? "1F2937" : "FFFFFF";

/* ───────────── build ───────────── */
type Rel = { id: string; type: string; target: string; external?: boolean };
type Frame = { x: number; y: number; w: number; h: number };
type Built = { xml: string; layout: 1 | 2 | 3; rels: Rel[]; notes?: string };

export function buildPptx(spec: PptxSpec, readImage: (path: string) => Buffer, now = new Date()): PptxBuild {
  if (!spec || !Array.isArray(spec.slides) || spec.slides.length === 0) throw new Error("spec.slides must be a non-empty array of slides");
  if (spec.slides.length > PPTX_LIMITS.slides) throw new Error(`At most ${PPTX_LIMITS.slides} slides are supported`);
  const warnings: string[] = [], font = fontName(spec.font, "Calibri"), accent = hexColor(spec.accent, "2563EB"), dark = spec.dark === true;
  const wide = spec.size !== "4:3", W = wide ? 12192000 / EMU : 10, H = 7.5, M = wide ? 0.75 : 0.6, CW = W - 2 * M;
  const bg = dark ? "111827" : "FFFFFF", text = dark ? "F9FAFB" : "1F2937", muted = dark ? "9CA3AF" : "6B7280", tint = mix(accent, bg, dark ? 0.22 : 0.09), hairline = dark ? "374151" : "D1D5DB";
  const TITLE = { x: M, y: 0.62, w: CW, h: 1.2 }, BODY: Frame = { x: M, y: 2.0, w: CW, h: H - 2.0 - 0.85 };
  const media: ZipSource[] = []; let imageCount = 0, tableCount = 0, noteCount = 0, split = 0;
  const built: Built[] = [];

  const slideContext = () => {
    const rels: Rel[] = [{ id: "rId1", type: `${REL}/slideLayout`, target: "" }]; let shape = 1;
    return {
      rels, id: () => ++shape,
      link(url: string) { const found = rels.find(rel => rel.external && rel.target === url); if (found) return found.id; const id = `rId${rels.length + 1}`; rels.push({ id, type: `${REL}/hyperlink`, target: url, external: true }); return id; },
      image(data: Buffer, format: string) { const name = `image${++imageCount}.${format === "jpeg" ? "jpeg" : "png"}`; media.push({ name: `ppt/media/${name}`, data }); const id = `rId${rels.length + 1}`; rels.push({ id, type: `${REL}/image`, target: `../media/${name}` }); return id; },
    };
  };
  type Context = ReturnType<typeof slideContext>;

  const runs = (value: DocxRun[], size: number, color: string, ctx: Context, extra: { bold?: boolean; italic?: boolean } = {}) => value.map(run => {
    const props = `<a:rPr lang="en-US" sz="${Math.round(size * 100)}"${extra.bold || run.bold ? ' b="1"' : ""}${extra.italic || run.italic ? ' i="1"' : ""}${run.link ? ' u="sng"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${run.link ? accent : color}"/></a:solidFill><a:latin typeface="${run.code ? "Consolas" : font}"/>${run.link ? `<a:hlinkClick r:id="${ctx.link(run.link)}"/>` : ""}</a:rPr>`;
    return `<a:r>${props}<a:t>${escapeXml(run.text)}</a:t></a:r>`;
  }).join("");
  const paragraph = (value: string, size: number, color: string, ctx: Context, options: { bullet?: Item; algn?: "l" | "ctr" | "r"; bold?: boolean; italic?: boolean; after?: number } = {}) => {
    const level = options.bullet?.level ?? 0, own = options.bullet ? levelSize(size, level) : size;
    const indent = options.bullet ? emu(0.3) : 0, left = options.bullet ? emu(marginOf(level)) : 0;
    const bullet = options.bullet ? `<a:buClr><a:srgbClr val="${accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${level ? "–" : "•"}"/>` : "<a:buNone/>";
    return `<a:p><a:pPr marL="${left}" indent="${-indent}" algn="${options.algn ?? "l"}"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="${Math.round(own * (options.after ?? 0.45) * 100)}"/></a:spcAft>${bullet}</a:pPr>${runs(inlineRuns(value), own, color, ctx, options)}</a:p>`;
  };
  const frameXml = (f: Frame) => `<a:xfrm><a:off x="${emu(f.x)}" y="${emu(f.y)}"/><a:ext cx="${emu(f.w)}" cy="${emu(f.h)}"/></a:xfrm>`;
  const shape = (ctx: Context, name: string, f: Frame, paragraphs: string, options: { ph?: string; anchor?: "t" | "ctr" | "b"; fill?: string } = {}) => {
    const id = ctx.id(), locks = options.ph ? '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' : '<p:cNvSpPr txBox="1"/>';
    const ph = options.ph ? `<p:nvPr><p:ph ${options.ph}/></p:nvPr>` : "<p:nvPr/>";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)} ${id}"/>${locks}${ph}</p:nvSpPr><p:spPr>${frameXml(f)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${options.fill ? `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>` : "<a:noFill/>"}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${options.anchor ?? "t"}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  };
  const rect = (ctx: Context, name: string, f: Frame, fill: string) => { const id = ctx.id(); return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${frameXml(f)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`; };

  const titleShape = (ctx: Context, title: string, color = text) => {
    const size = fitBlock(title, TITLE.w, TITLE.h, [34, 32, 30, 28, 26, 24, 22], true);
    if (blockHeight(title, size, TITLE.w, true) > TITLE.h) warnings.push(`Title "${title.slice(0, 40)}…" is long; shorten it so it reads at a glance`);
    return rect(ctx, "Accent", { x: M, y: 0.4, w: 0.8, h: 0.07 }, accent) + shape(ctx, "Title", TITLE, paragraph(title, size, color, ctx, { bold: true, after: 0 }), { ph: 'type="title"', anchor: "t" });
  };
  const footer = (ctx: Context, number: number) => {
    const left = spec.footer ? shape(ctx, "Footer", { x: M, y: H - 0.55, w: CW - 1.2, h: 0.3 }, paragraph(clean(spec.footer), 12, muted, ctx, { after: 0 }), { anchor: "ctr" }) : "";
    const id = ctx.id();
    const field = `<a:p><a:pPr algn="r"/><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" sz="1200" dirty="0"><a:solidFill><a:srgbClr val="${muted}"/></a:solidFill><a:latin typeface="${font}"/></a:rPr><a:t>${number}</a:t></a:fld></a:p>`;
    return left + `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Number ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${frameXml({ x: W - M - 1, y: H - 0.55, w: 1, h: 0.3 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>${field}</p:txBody></p:sp>`;
  };
  const sld = (shapes: string, background?: string) => `${XML_HEAD}<p:sld ${NS}><p:cSld>${background ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : ""}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const bulletBox = (ctx: Context, name: string, f: Frame, items: Item[], size: number, ph?: string) => shape(ctx, name, f, items.map(item => paragraph(item.text, size, text, ctx, { bullet: item })).join(""), { ph });

  const push = (slide: Built, notes?: string) => { built.push({ ...slide, notes }); };
  const imageFrame = (data: { width: number; height: number }, box: Frame): Frame => {
    const scale = Math.min(box.w / data.width, box.h / data.height), w = data.width * scale, h = data.height * scale;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  };
  const picture = (ctx: Context, image: { path: string; alt?: string }, box: Frame, label: string) => {
    let described: ReturnType<typeof describeImage>;
    try { described = describeImage(readImage(image.path)); } catch (error) { throw new Error(`${label}: image ${image.path}: ${(error as Error).message}`); }
    if (!image.alt?.trim()) warnings.push(`${label}: the image has no alt text; pass image.alt (a short description for people who cannot see it)`);
    const id = ctx.id(), rel = ctx.image(described.data, described.format), f = imageFrame(described, box);
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${escapeXml(clean(image.alt ?? ""))}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${frameXml(f)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  };

  const tableXml = (ctx: Context, header: string[] | undefined, rows: string[][], widths: number[], box: Frame, size: number) => {
    const id = ctx.id(), columns = widths.length, total = widths.reduce((a, b) => a + b, 0);
    const colIn = widths.map(width => box.w * width / total), pad = 0.1;
    const rowHeights = (cells: string[], bold: boolean) => Math.max(...cells.map((cell, at) => blockHeight(plain(cell), size, Math.max(colIn[at] - 2 * pad, 0.3), bold))) + 0.16;
    const cell = (value: string, fill: string | undefined, color: string, bold: boolean) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(value, size, color, ctx, { bold, after: 0 })}</a:txBody><a:tcPr marL="${emu(pad)}" marR="${emu(pad)}" marT="${emu(0.06)}" marB="${emu(0.06)}" anchor="ctr"><a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT><a:lnB w="6350"><a:solidFill><a:srgbClr val="${hairline}"/></a:solidFill></a:lnB>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "<a:noFill/>"}</a:tcPr></a:tc>`;
    const trs: string[] = []; let height = 0;
    if (header) { const h = rowHeights(header, true); height += h; trs.push(`<a:tr h="${emu(h)}">${header.map(value => cell(value, accent, onColor(accent), true)).join("")}</a:tr>`); }
    rows.forEach((cells, index) => { const h = rowHeights(cells, false); height += h; trs.push(`<a:tr h="${emu(h)}">${cells.map(value => cell(value, index % 2 ? tint : undefined, text, false)).join("")}</a:tr>`); });
    return { height, xml: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(box.w)}" cy="${emu(height)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${header ? 1 : 0}" bandRow="1"/><a:tblGrid>${colIn.map(width => `<a:gridCol w="${emu(width)}"/>`).join("")}</a:tblGrid>${trs.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`, columns };
  };

  const heading = (slide: PptxSlide) => clean(slide.title ?? (slide as { heading?: string }).heading ?? "").replace(/\s+/g, " ").trim();
  const kindOf = (slide: PptxSlide, index: number): NonNullable<PptxSlide["layout"]> => {
    if (slide.layout) return slide.layout;
    if (slide.image) return "image"; if (slide.table) return "table"; if (slide.quote) return "quote";
    if (slide.columns || slide.left || slide.right) return "columns";
    if (flatten(slide.bullets ?? slide.items).length) return "bullets";
    if (slide.text) return "text";
    return index === 0 ? "title" : "section";
  };

  spec.slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") throw new Error(`Slide ${index + 1} must be an object`);
    const label = `Slide ${index + 1}`, kind = kindOf(slide, index), title = heading(slide);
    const notes = slide.notes ? clean(slide.notes).trim() : undefined;
    if (!["title", "section", "bullets", "columns", "image", "table", "quote", "text"].includes(kind)) throw new Error(`${label}: unknown layout "${kind}"; use title, section, bullets, columns, image, table, quote or text`);
    const number = () => built.length + 1;

    if (kind === "title" || kind === "section") {
      const ctx = slideContext(), subtitle = clean(slide.subtitle ?? slide.text ?? "").replace(/\s+/g, " ").trim();
      const base = kind === "title" ? accent : "1F2937", ink = onColor(base), softer = mix(ink, base, 0.82);
      const box: Frame = { x: M, y: kind === "title" ? 2.0 : 2.6, w: CW, h: kind === "title" ? 2.4 : 1.7 };
      const size = fitBlock(title || " ", box.w, box.h, kind === "title" ? [48, 44, 40, 36, 32, 28] : [40, 36, 32, 28], true);
      const subBox: Frame = { x: M, y: box.y + box.h + 0.2, w: CW, h: 1.4 }, subSize = fitBlock(subtitle || " ", subBox.w, subBox.h, [26, 24, 22, 20, 18]);
      const ph = kind === "title" ? 'type="ctrTitle"' : 'type="title"';
      const shapes = rect(ctx, "Accent", { x: M, y: box.y - 0.35, w: 1.0, h: 0.08 }, kind === "title" ? ink : accent)
        + shape(ctx, "Title", box, paragraph(title, size, ink, ctx, { bold: true, after: 0 }), { ph, anchor: "b" })
        + (subtitle ? shape(ctx, "Subtitle", subBox, paragraph(subtitle, subSize, softer, ctx, { after: 0 }), { ph: kind === "title" ? 'type="subTitle" idx="1"' : undefined }) : "");
      push({ xml: sld(shapes, base), layout: kind === "title" ? 1 : 3, rels: ctx.rels }, notes);
      return;
    }

    if (!title) warnings.push(`${label}: no title; give every content slide a title so the outline and navigation work`);
    const pageTitle = (page: number, total: number) => page ? `${title || "Slide"} (${page + 1}/${total})` : title;

    if (kind === "bullets") {
      const items = flatten(slide.bullets ?? slide.items); if (items.length > PPTX_LIMITS.items) throw new Error(`${label}: at most ${PPTX_LIMITS.items} bullets per slide`);
      if (!items.length && slide.text) items.push(...flatten(clean(slide.text).split(/\n{2,}/)));
      const { size, chunks } = fitList(items, BODY.w, BODY.h, [28, 26, 24, 22, 20], 20);
      if (chunks.length > 1) { split += chunks.length - 1; warnings.push(`${label}: ${items.length} bullets do not fit at a readable size, so they continue over ${chunks.length} slides`); }
      chunks.forEach((chunk, page) => {
        const ctx = slideContext();
        const shapes = titleShape(ctx, pageTitle(page, chunks.length)) + bulletBox(ctx, "Content", BODY, chunk, size, 'idx="1"') + footer(ctx, number());
        push({ xml: sld(shapes), layout: 2, rels: ctx.rels }, page ? undefined : notes);
      });
      return;
    }

    if (kind === "text") {
      const paragraphs = clean(slide.text ?? "").split(/\n{2,}/).map(part => part.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
      if (!paragraphs.length) throw new Error(`${label}: layout text needs a text string`);
      const chunks: string[][] = []; let current: string[] = [];
      const height = (parts: string[], size: number) => parts.reduce((sum, part) => sum + blockHeight(plain(part), size, BODY.w) + size * 0.6 / 72, 0);
      const size = [24, 22, 20].find(candidate => height(paragraphs, candidate) <= BODY.h) ?? 20;
      if (height(paragraphs, size) <= BODY.h) chunks.push(paragraphs);
      else { for (const part of paragraphs) { if (current.length && height([...current, part], 20) > BODY.h) { chunks.push(current); current = []; } current.push(part); } if (current.length) chunks.push(current); split += chunks.length - 1; warnings.push(`${label}: the text does not fit one slide and continues over ${chunks.length} slides`); }
      chunks.forEach((chunk, page) => {
        const ctx = slideContext();
        const shapes = titleShape(ctx, pageTitle(page, chunks.length)) + shape(ctx, "Content", BODY, chunk.map(part => paragraph(part, size, text, ctx, { after: 0.6 })).join("")) + footer(ctx, number());
        push({ xml: sld(shapes), layout: 3, rels: ctx.rels }, page ? undefined : notes);
      });
      return;
    }

    if (kind === "columns") {
      const raw = slide.columns ?? [slide.left, slide.right].filter(value => value !== undefined);
      const columns = (raw as unknown[]).slice(0, PPTX_LIMITS.columns).map(entry => {
        const value = entry as { heading?: string; title?: string; bullets?: unknown; items?: unknown } | unknown[] | string;
        const isObject = value && typeof value === "object" && !Array.isArray(value);
        return { heading: isObject ? clean((value as any).heading ?? (value as any).title ?? "").trim() : "", items: flatten(isObject ? ((value as any).bullets ?? (value as any).items) : value) };
      });
      if (columns.length < 2 || columns.length > 4) throw new Error(`${label}: layout columns needs two to four columns`);
      const gap = 0.5, colW = (CW - gap * (columns.length - 1)) / columns.length, hasHeading = columns.some(column => column.heading), headH = hasHeading ? 0.6 : 0;
      const area: Frame = { x: M, y: BODY.y + headH, w: colW, h: BODY.h - headH };
      const fits = columns.map(column => fitList(column.items, colW, area.h, [24, 22, 20], 18));
      const size = Math.min(...fits.map(fit => fit.size));
      const chunked = columns.map(column => fitList(column.items, colW, area.h, [size], size)), pages = Math.max(...chunked.map(fit => fit.chunks.length));
      if (pages > 1) { split += pages - 1; warnings.push(`${label}: the columns do not fit one slide and continue over ${pages} slides`); }
      for (let page = 0; page < pages; page++) {
        const ctx = slideContext(); let shapes = titleShape(ctx, pageTitle(page, pages));
        columns.forEach((column, at) => {
          const x = M + at * (colW + gap);
          if (column.heading) shapes += shape(ctx, "Heading", { x, y: BODY.y, w: colW, h: 0.5 }, paragraph(column.heading, 20, accent, ctx, { bold: true, after: 0 }), { anchor: "t" });
          const chunk = chunked[at].chunks[page] ?? [];
          if (chunk.length) shapes += bulletBox(ctx, "Column", { ...area, x }, chunk, size);
        });
        push({ xml: sld(shapes + footer(ctx, number())), layout: 3, rels: ctx.rels }, page ? undefined : notes);
      }
      return;
    }

    if (kind === "image") {
      const image = typeof slide.image === "string" ? { path: slide.image } : slide.image;
      if (!image?.path) throw new Error(`${label}: layout image needs image.path`);
      const items = flatten(slide.bullets ?? slide.items), caption = clean((image as any).caption ?? "").replace(/\s+/g, " ").trim();
      const ctx = slideContext(), gap = 0.5, side = items.length > 0;
      const textBox: Frame = { x: M, y: BODY.y, w: side ? CW * 0.42 : CW, h: BODY.h };
      const picBox: Frame = side ? { x: M + CW * 0.42 + gap, y: BODY.y, w: CW * 0.58 - gap, h: BODY.h - (caption ? 0.5 : 0) } : { x: M, y: BODY.y, w: CW, h: BODY.h - (caption ? 0.5 : 0) };
      let shapes = titleShape(ctx, title);
      if (side) {
        const { size, chunks } = fitList(items, textBox.w, textBox.h, [24, 22, 20, 18], 16);
        const shown = chunks[0]; if (chunks.length > 1) warnings.push(`${label}: ${items.length - shown.length} bullets did not fit next to the image and were left off; move them to a text slide`);
        shapes += bulletBox(ctx, "Content", textBox, shown, size);
      }
      shapes += picture(ctx, image, picBox, label);
      if (caption) shapes += shape(ctx, "Caption", { x: picBox.x, y: picBox.y + picBox.h + 0.1, w: picBox.w, h: 0.4 }, paragraph(caption, 14, muted, ctx, { algn: "ctr", after: 0 }), { anchor: "t" });
      push({ xml: sld(shapes + footer(ctx, number())), layout: 3, rels: ctx.rels }, notes);
      return;
    }

    if (kind === "table") {
      const table = slide.table;
      if (!table || !Array.isArray(table.rows) || !table.rows.length) throw new Error(`${label}: layout table needs table.rows (an array of rows)`);
      if (table.rows.length > PPTX_LIMITS.rows) throw new Error(`${label}: at most ${PPTX_LIMITS.rows} table rows per slide`);
      const header = Array.isArray(table.header) && table.header.length ? table.header.map(value => clean(value).replace(/\s+/g, " ").trim()) : undefined;
      const columns = Math.max(header?.length ?? 0, ...table.rows.map(row => row.length));
      if (columns < 1 || columns > 12) throw new Error(`${label}: a table needs 1 to 12 columns`);
      const rows = table.rows.map(row => Array.from({ length: columns }, (_, at) => clean(row[at] ?? "").replace(/\s+/g, " ").trim()));
      const head = header ? Array.from({ length: columns }, (_, at) => header[at] ?? "") : undefined;
      const weights = Array.isArray(table.widths) && table.widths.length === columns && table.widths.every(width => Number.isFinite(width) && width > 0) ? table.widths
        : Array.from({ length: columns }, (_, at) => Math.min(Math.max(Math.max(...[head?.[at] ?? "", ...rows.map(row => row[at])].map(cell => Math.min(cell.length, 40))) , 6), 40));
      const wordTotal = (chunk: string[][]) => chunk.reduce((sum, row) => sum + row.reduce((inner, cellText) => inner + wordsIn(cellText), 0), 0) + (head ? head.reduce((sum, cellText) => sum + wordsIn(cellText), 0) : 0);
      const fitsAt = (chunk: string[][], size: number) => wordTotal(chunk) <= MAX_WORDS + 30 && tableXml(slideContext(), head, chunk, weights, BODY, size).height <= BODY.h;
      let size = [18, 16, 14].find(candidate => fitsAt(rows, candidate)), chunks: string[][][] = [rows];
      if (!size) { size = 14; chunks = []; let current: string[][] = []; for (const row of rows) { if (current.length && !fitsAt([...current, row], size)) { chunks.push(current); current = []; } current.push(row); } if (current.length) chunks.push(current); split += chunks.length - 1; warnings.push(`${label}: ${rows.length} table rows do not fit one slide and continue over ${chunks.length} slides with the header repeated`); }
      chunks.forEach((chunk, page) => {
        const ctx = slideContext(); tableCount++;
        const shapes = titleShape(ctx, pageTitle(page, chunks.length)) + tableXml(ctx, head, chunk, weights, BODY, size!).xml + footer(ctx, number());
        push({ xml: sld(shapes), layout: 3, rels: ctx.rels }, page ? undefined : notes);
      });
      return;
    }

    // quote
    const quote = typeof slide.quote === "string" ? { text: slide.quote, cite: slide.cite } : slide.quote;
    const words = clean(quote?.text ?? "").replace(/\s+/g, " ").trim();
    if (!words) throw new Error(`${label}: layout quote needs quote.text`);
    const cite = clean(quote?.cite ?? slide.cite ?? "").replace(/\s+/g, " ").trim();
    const ctx = slideContext(), box: Frame = { x: M + 0.5, y: BODY.y, w: CW - 1, h: BODY.h - (cite ? 0.9 : 0.2) };
    const size = fitBlock(words, box.w, box.h, [36, 32, 30, 28, 26, 24, 22, 20], false);
    const used = Math.min(blockHeight(words, size, box.w), box.h);
    let shapes = titleShape(ctx, title) + rect(ctx, "Quote bar", { x: M, y: BODY.y, w: 0.08, h: used + (cite ? 0.8 : 0.1) }, accent)
      + shape(ctx, "Quote", box, paragraph(words, size, text, ctx, { italic: true, after: 0 }));
    if (cite) shapes += shape(ctx, "Source", { x: box.x, y: BODY.y + used + 0.3, w: box.w, h: 0.5 }, paragraph(`— ${cite}`, 20, muted, ctx, { after: 0 }));
    push({ xml: sld(shapes + footer(ctx, number())), layout: 3, rels: ctx.rels }, notes);
  });

  /* ───────────── package ───────────── */
  const parts: ZipSource[] = [], slideCount = built.length;
  const relsXml = (rels: Rel[]) => `${XML_HEAD}<Relationships xmlns="${REL_NS}">${rels.map(rel => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  const hasNotes = built.some(slide => slide.notes);
  const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const placeholder = (id: number, name: string, ph: string, f: Frame, body = "") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${frameXml(f)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body || "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>"}</p:txBody></p:sp>`;
  const layoutXml = (type: string, name: string, shapes: string) => `${XML_HEAD}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${grp}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const titleFrame = TITLE, bodyFrame = BODY;
  const colorMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const lvl = (size: number, color: string, extra = "") => `<a:defRPr sz="${size * 100}"${extra}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:defRPr>`;
  const master = `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${grp}${placeholder(2, "Title Placeholder 1", 'type="title"', titleFrame)}${placeholder(3, "Text Placeholder 2", 'type="body" idx="1"', bodyFrame)}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l">${lvl(34, text, ' b="1"')}</a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="274320" indent="-274320"><a:buFont typeface="Arial"/><a:buChar char="•"/>${lvl(24, text)}</a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr>${lvl(18, text)}</a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const colors = [["dk1", "1F2937"], ["lt1", "FFFFFF"], ["dk2", "374151"], ["lt2", "F3F4F6"], ["accent1", accent], ["accent2", mix(accent, "FFFFFF", 0.7)], ["accent3", "10B981"], ["accent4", "F59E0B"], ["accent5", "EF4444"], ["accent6", "8B5CF6"], ["hlink", accent], ["folHlink", "6B7280"]];
  const fills = (n: number) => Array.from({ length: n }, () => '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>').join("");
  const theme = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="YunusPi"><a:themeElements><a:clrScheme name="YunusPi">${colors.map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join("")}</a:clrScheme><a:fontScheme name="YunusPi"><a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="YunusPi"><a:fillStyleLst>${fills(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map(w => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fills(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const sldW = emu(W), sldH = emu(H);
  const notesW = 5486400, notesH = Math.round(notesW * H / W);
  const notesMaster = `${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${grp}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="${notesW}" cy="${notesH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>${colorMap}<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
  const notesSlide = (body: string) => `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${grp}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body.split(/\n+/).map(line => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

  const layouts = [
    layoutXml("title", "Title Slide", placeholder(2, "Title 1", 'type="ctrTitle"', { x: M, y: 2.0, w: CW, h: 2.4 }) + placeholder(3, "Subtitle 2", 'type="subTitle" idx="1"', { x: M, y: 4.6, w: CW, h: 1.4 })),
    layoutXml("obj", "Title and Content", placeholder(2, "Title 1", 'type="title"', titleFrame) + placeholder(3, "Content Placeholder 2", 'idx="1"', bodyFrame)),
    layoutXml("titleOnly", "Title Only", placeholder(2, "Title 1", 'type="title"', titleFrame)),
  ];
  const presentationRels: Rel[] = [{ id: "rId1", type: `${REL}/slideMaster`, target: "slideMasters/slideMaster1.xml" }];
  built.forEach((_, at) => presentationRels.push({ id: `rId${at + 2}`, type: `${REL}/slide`, target: `slides/slide${at + 1}.xml` }));
  let next = slideCount + 2; const notesMasterRel = hasNotes ? `rId${next++}` : "";
  if (hasNotes) presentationRels.push({ id: notesMasterRel, type: `${REL}/notesMaster`, target: "notesMasters/notesMaster1.xml" });
  const tail = [["presProps", "presProps.xml"], ["viewProps", "viewProps.xml"], ["theme", "theme/theme1.xml"], ["tableStyles", "tableStyles.xml"]];
  for (const [type, target] of tail) presentationRels.push({ id: `rId${next++}`, type: `${REL}/${type}`, target });
  const presentation = `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRel}"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${built.map((_, at) => `<p:sldId id="${256 + at}" r:id="rId${at + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${sldW}" cy="${sldH}"${wide ? "" : ' type="screen4x3"'}/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  const overrides: Array<[string, string]> = [["/ppt/presentation.xml", `${CT}.presentation.main+xml`], ["/ppt/slideMasters/slideMaster1.xml", `${CT}.slideMaster+xml`], ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"], ["/ppt/presProps.xml", `${CT}.presProps+xml`], ["/ppt/viewProps.xml", `${CT}.viewProps+xml`], ["/ppt/tableStyles.xml", `${CT}.tableStyles+xml`], ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"], ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"]];
  layouts.forEach((_, at) => overrides.push([`/ppt/slideLayouts/slideLayout${at + 1}.xml`, `${CT}.slideLayout+xml`]));
  built.forEach((slide, at) => { overrides.push([`/ppt/slides/slide${at + 1}.xml`, `${CT}.slide+xml`]); if (slide.notes) overrides.push([`/ppt/notesSlides/notesSlide${at + 1}.xml`, `${CT}.notesSlide+xml`]); });
  if (hasNotes) overrides.push(["/ppt/notesMasters/notesMaster1.xml", `${CT}.notesMaster+xml`], ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"]);
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")}</Types>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;

  parts.push({ name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: coreProps(spec.title, spec.author, now) }, { name: "docProps/app.xml", data: appProps("YunusPi") },
    { name: "ppt/presentation.xml", data: presentation }, { name: "ppt/_rels/presentation.xml.rels", data: relsXml(presentationRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: relsXml([...layouts.map((_, at) => ({ id: `rId${at + 1}`, type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${at + 1}.xml` })), { id: "rId4", type: `${REL}/theme`, target: "../theme/theme1.xml" }]) },
    { name: "ppt/theme/theme1.xml", data: theme },
    { name: "ppt/presProps.xml", data: `${XML_HEAD}<p:presentationPr ${NS}/>` }, { name: "ppt/viewProps.xml", data: `${XML_HEAD}<p:viewPr ${NS}/>` },
    { name: "ppt/tableStyles.xml", data: `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` });
  layouts.forEach((xml, at) => parts.push({ name: `ppt/slideLayouts/slideLayout${at + 1}.xml`, data: xml }, { name: `ppt/slideLayouts/_rels/slideLayout${at + 1}.xml.rels`, data: relsXml([{ id: "rId1", type: `${REL}/slideMaster`, target: "../slideMasters/slideMaster1.xml" }]) }));
  built.forEach((slide, at) => {
    const rels = slide.rels.map(rel => rel.id === "rId1" ? { ...rel, target: `../slideLayouts/slideLayout${slide.layout}.xml` } : rel);
    if (slide.notes) { noteCount++; rels.push({ id: `rId${rels.length + 1}`, type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${at + 1}.xml` }); }
    parts.push({ name: `ppt/slides/slide${at + 1}.xml`, data: slide.xml }, { name: `ppt/slides/_rels/slide${at + 1}.xml.rels`, data: relsXml(rels) });
    if (slide.notes) parts.push({ name: `ppt/notesSlides/notesSlide${at + 1}.xml`, data: notesSlide(slide.notes) }, { name: `ppt/notesSlides/_rels/notesSlide${at + 1}.xml.rels`, data: relsXml([{ id: "rId1", type: `${REL}/notesMaster`, target: "../notesMasters/notesMaster1.xml" }, { id: "rId2", type: `${REL}/slide`, target: `../slides/slide${at + 1}.xml` }]) });
  });
  if (hasNotes) parts.push({ name: "ppt/notesMasters/notesMaster1.xml", data: notesMaster }, { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", data: relsXml([{ id: "rId1", type: `${REL}/theme`, target: "../theme/theme2.xml" }]) }, { name: "ppt/theme/theme2.xml", data: theme });
  parts.push(...media);
  if (imageCount > OFFICE_BUILD_LIMITS.images) throw new Error(`At most ${OFFICE_BUILD_LIMITS.images} images are supported`);
  return { buffer: writeZip(parts), stats: { slides: slideCount, split, images: imageCount, tables: tableCount, notes: noteCount }, warnings };
}
