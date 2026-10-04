/** Build .docx and .xlsx files from declarative specs, with no office suite and no dependencies.
 *
 * A model supplies content (headings, paragraphs, lists, tables, images; sheets, columns, rows,
 * formulas) and never touches OOXML. The writer emits the structure Word and Excel expect (real
 * heading styles and list numbering, a header row that repeats, frozen panes, number formats,
 * shared strings, cached formula results) and rejects what would silently corrupt a file: invalid
 * sheet names, oversized grids, unreadable or unsupported images. Everything is deterministic for
 * a given spec so the result can be rebuilt byte for byte. */
import { writeZip, type ZipSource } from "./office-zip.ts";
import { escapeXml } from "./xml-lite.ts";
import { evaluateFormula, columnName, columnNumber, type CellValue, type SheetLookup } from "./sheet-formula.ts";

export const OFFICE_BUILD_LIMITS = Object.freeze({ blocks: 4000, tableRows: 5000, tableColumns: 30, images: 60, sheets: 40, rows: 100_000, columns: 200, cells: 1_000_000, imageBytes: 12 * 1024 * 1024 });

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const stamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "Z");

function coreProps(title: string | undefined, author: string | undefined, now: Date): string {
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${escapeXml(title)}</dc:title>` : ""}<dc:creator>${escapeXml(author ?? "YunusPi")}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp(now)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp(now)}</dcterms:modified></cp:coreProperties>`;
}
const appProps = (application: string) => `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${escapeXml(application)}</Application></Properties>`;
const rootRels = `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="WORD_OR_XL"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;

/* ───────────────────────────── docx ───────────────────────────── */

export type DocxRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean; color?: string; size?: number; link?: string };
export type DocxBlock =
  | { type: "heading"; level?: number; text: string }
  | { type: "paragraph"; text?: string; runs?: DocxRun[]; align?: "left" | "center" | "right" | "justify" }
  | { type: "bullets" | "numbered"; items: Array<string | { text: string; level?: number }> }
  | { type: "table"; header?: string[]; rows: Array<Array<string | number | boolean | null>>; widths?: number[]; align?: Array<"left" | "center" | "right">; style?: "grid" | "plain" | "banded"; caption?: string }
  | { type: "image"; path: string; width?: number; alt?: string; caption?: string; align?: "left" | "center" | "right" }
  | { type: "quote"; text: string; cite?: string }
  | { type: "code"; text: string }
  | { type: "pagebreak" };
export type DocxSpec = {
  title?: string; subtitle?: string; author?: string;
  page?: { size?: "A4" | "Letter"; orientation?: "portrait" | "landscape"; margins?: "normal" | "narrow" | "wide" };
  font?: { family?: string; size?: number; headingFamily?: string; accent?: string };
  header?: string; footer?: string;
  blocks: DocxBlock[];
};
export type DocxBuild = { buffer: Buffer; stats: { blocks: number; headings: number; paragraphs: number; tables: number; images: number; listItems: number }; warnings: string[] };
export type ImageData = { data: Buffer; format: "png" | "jpeg"; width: number; height: number };

/** PNG and JPEG are the formats every Word version embeds; dimensions come from the file header. */
export function describeImage(data: Buffer): ImageData {
  if (data.length > OFFICE_BUILD_LIMITS.imageBytes) throw new Error(`Image is larger than ${OFFICE_BUILD_LIMITS.imageBytes / 1048576} MiB`);
  if (data.length > 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { data, format: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) { at++; continue; }
      const marker = data[at + 1];
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) return { data, format: "jpeg", height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      if (marker === 0xff) { at += 1; continue; }
      at += 2 + data.readUInt16BE(at + 2);
    }
    throw new Error("JPEG has no frame header (the file is damaged)");
  }
  throw new Error("Only PNG and JPEG images can be embedded (convert other formats first)");
}

const PAGE_SIZES = { A4: [11906, 16838], Letter: [12240, 15840] } as const;
const MARGINS = { normal: 1440, narrow: 720, wide: 2160 } as const;
const hexColor = (value: string | undefined, fallback: string): string => /^#?[0-9a-fA-F]{6}$/.test(value ?? "") ? value!.replace("#", "").toUpperCase() : fallback;
const fontName = (value: string | undefined, fallback: string): string => value && /^[\w .&-]{1,60}$/.test(value) ? value : fallback;

/** `**bold**`, `*italic*`, `` `code` `` and `[text](https://…)` inside a string become runs. */
export function inlineRuns(text: string): DocxRun[] {
  const runs: DocxRun[] = [];
  const pattern = /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1], bold: true });
    else if (match[2] !== undefined) runs.push({ text: match[2], italic: true });
    else if (match[3] !== undefined) runs.push({ text: match[3], code: true });
    else runs.push({ text: match[4], link: match[5] });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

export function buildDocx(spec: DocxSpec, readImage: (path: string) => Buffer, now = new Date()): DocxBuild {
  if (!spec || !Array.isArray(spec.blocks)) throw new Error("spec.blocks must be an array of content blocks");
  if (spec.blocks.length > OFFICE_BUILD_LIMITS.blocks) throw new Error(`At most ${OFFICE_BUILD_LIMITS.blocks} blocks are supported`);
  const warnings: string[] = [];
  const family = fontName(spec.font?.family, "Calibri"), headingFamily = fontName(spec.font?.headingFamily, family);
  const size = Math.min(Math.max(Number(spec.font?.size) || 11, 8), 20), accent = hexColor(spec.font?.accent, "1F2937");
  const [pageW, pageH] = PAGE_SIZES[spec.page?.size ?? "A4"] ?? PAGE_SIZES.A4, landscape = spec.page?.orientation === "landscape";
  const margin = MARGINS[spec.page?.margins ?? "normal"] ?? MARGINS.normal, widthTwips = (landscape ? pageH : pageW) - 2 * margin;
  const rels: Array<{ id: string; type: string; target: string; external?: boolean }> = [
    { id: "rId1", type: "styles", target: "styles.xml" }, { id: "rId2", type: "numbering", target: "numbering.xml" }, { id: "rId3", type: "settings", target: "settings.xml" },
  ];
  const media: ZipSource[] = [];
  const stats = { blocks: 0, headings: 0, paragraphs: 0, tables: 0, images: 0, listItems: 0 };
  let nextRel = 4, nextDrawing = 1, nextNum = 3;
  const numberedIds: number[] = [];
  const relFor = (type: string, target: string, external = false) => { const id = `rId${nextRel++}`; rels.push({ id, type, target, external }); return id; };

  const runXml = (run: DocxRun, base: { bold?: boolean; italic?: boolean; size?: number; color?: string } = {}): string => {
    if (!run.text) return "";
    const props: string[] = [];
    if (run.link) props.push('<w:rStyle w:val="Hyperlink"/>');
    if (run.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    if (run.bold ?? base.bold) props.push("<w:b/>");
    if (run.italic ?? base.italic) props.push("<w:i/>");
    const color = run.color ? hexColor(run.color, "") : base.color; if (color) props.push(`<w:color w:val="${color}"/>`);
    const runSize = run.size ?? base.size; if (runSize) props.push(`<w:sz w:val="${Math.round(Math.min(Math.max(runSize, 6), 72) * 2)}"/>`);
    if (run.underline) props.push('<w:u w:val="single"/>');
    const parts = run.text.split("\n"), body = parts.map((part, index) => `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`).join("");
    const xml = `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${body}</w:r>`;
    return run.link ? `<w:hyperlink r:id="${relFor("hyperlink", escapeXml(run.link), true)}">${xml}</w:hyperlink>` : xml;
  };
  const runsFor = (text: string | undefined, runs: DocxRun[] | undefined, base?: Parameters<typeof runXml>[1]) => (runs ?? inlineRuns(String(text ?? ""))).map(run => runXml(run, base)).join("");
  const paragraph = (inner: string, props: { style?: string; align?: string; keepNext?: boolean; spacing?: string; ind?: string; num?: [number, number]; shade?: string } = {}) => {
    const parts = [props.style ? `<w:pStyle w:val="${props.style}"/>` : "", props.keepNext ? "<w:keepNext/>" : "", props.num ? `<w:numPr><w:ilvl w:val="${props.num[1]}"/><w:numId w:val="${props.num[0]}"/></w:numPr>` : "", props.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${props.shade}"/>` : "", props.spacing ?? "", props.ind ?? "", props.align ? `<w:jc w:val="${props.align === "justify" ? "both" : props.align}"/>` : ""].join("");
    return `<w:p>${parts ? `<w:pPr>${parts}</w:pPr>` : ""}${inner}</w:p>`;
  };

  const body: string[] = [];
  if (spec.title) { body.push(paragraph(runsFor(spec.title, undefined), { style: "Title" })); stats.headings++; }
  if (spec.subtitle) body.push(paragraph(runsFor(spec.subtitle, undefined), { style: "Subtitle" }));
  const imageXml = (block: Extract<DocxBlock, { type: "image" }>): string => {
    stats.images++; if (stats.images > OFFICE_BUILD_LIMITS.images) throw new Error(`At most ${OFFICE_BUILD_LIMITS.images} images are supported`);
    let described: ImageData;
    try { described = describeImage(readImage(block.path)); } catch (error) { throw new Error(`Image ${JSON.stringify(block.path)}: ${(error as Error).message}`); }
    const ext = described.format === "png" ? "png" : "jpeg", name = `image${stats.images}.${ext}`;
    media.push({ name: `word/media/${name}`, data: described.data });
    const rel = relFor("image", `media/${name}`);
    const maxEmu = Math.round(widthTwips * 635), wantedEmu = block.width ? Math.round(Math.min(Math.max(block.width, 0.3), 12) * 914400) : Math.min(maxEmu, Math.round(described.width / 96 * 914400));
    const cx = Math.min(wantedEmu, maxEmu), cy = Math.min(Math.round(cx * described.height / Math.max(described.width, 1)), 8 * 914400), id = nextDrawing++;
    const alt = escapeXml(block.alt ?? block.caption ?? name);
    if (!block.alt) warnings.push(`Image ${JSON.stringify(block.path)} has no alt text; add "alt" so it is accessible.`);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const tableXml = (block: Extract<DocxBlock, { type: "table" }>): string => {
    const rows = block.rows ?? [];
    if (!Array.isArray(rows) || rows.length > OFFICE_BUILD_LIMITS.tableRows) throw new Error(`Tables take at most ${OFFICE_BUILD_LIMITS.tableRows} rows`);
    const columns = Math.max(block.header?.length ?? 0, ...rows.map(row => Array.isArray(row) ? row.length : 0));
    if (!columns) throw new Error("A table needs a header or at least one non-empty row");
    if (columns > OFFICE_BUILD_LIMITS.tableColumns) throw new Error(`Tables take at most ${OFFICE_BUILD_LIMITS.tableColumns} columns`);
    stats.tables++;
    const weights = Array.from({ length: columns }, (_, c) => Math.max(0.2, Number(block.widths?.[c]) || 1)), total = weights.reduce((a, b) => a + b, 0);
    const grid = weights.map(weight => Math.round(widthTwips * weight / total));
    const numericColumn = Array.from({ length: columns }, (_, c) => rows.length > 0 && rows.every(row => row?.[c] === undefined || row[c] === null || row[c] === "" || typeof row[c] === "number" || /^[-+$€£]?\s?[\d,]+(?:\.\d+)?%?$/.test(String(row[c]).trim())));
    const style = block.style ?? "grid";
    const cell = (value: unknown, c: number, kind: "head" | "body", band: boolean) => {
      const text = value === null || value === undefined ? "" : String(value);
      const align = block.align?.[c] ?? (numericColumn[c] && kind === "body" ? "right" : "left");
      const shade = kind === "head" ? "E5E7EB" : band ? "F3F4F6" : "";
      const inner = runsFor(text, undefined, kind === "head" ? { bold: true } : undefined);
      return `<w:tc><w:tcPr><w:tcW w:w="${grid[c]}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}<w:vAlign w:val="${kind === "head" ? "bottom" : "top"}"/></w:tcPr>${paragraph(inner, { align, spacing: '<w:spacing w:before="40" w:after="40"/>' })}</w:tc>`;
    };
    const line = (cells: unknown[], kind: "head" | "body", band: boolean) => `<w:tr><w:trPr><w:cantSplit/>${kind === "head" ? "<w:tblHeader/>" : ""}</w:trPr>${Array.from({ length: columns }, (_, c) => cell(cells[c], c, kind, band)).join("")}</w:tr>`;
    const borders = style === "plain" ? "" : `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(edge => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join("")}</w:tblBorders>`;
    const head = block.header?.length ? line(block.header, "head", false) : "";
    const xml = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${widthTwips}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${head}${rows.map((row, r) => line(Array.isArray(row) ? row : [row], "body", style === "banded" && r % 2 === 1)).join("")}</w:tbl>`;
    return xml + (block.caption ? paragraph(runsFor(block.caption, undefined), { style: "Caption" }) : paragraph("", { spacing: '<w:spacing w:after="0"/>' }));
  };

  for (const block of spec.blocks) {
    stats.blocks++;
    if (!block || typeof block !== "object" || typeof (block as any).type !== "string") throw new Error(`Block ${stats.blocks} has no type (use heading, paragraph, bullets, numbered, table, image, quote, code or pagebreak)`);
    switch (block.type) {
      case "heading": { const level = Math.min(Math.max(Math.round(Number(block.level) || 1), 1), 3); stats.headings++; body.push(paragraph(runsFor(block.text, undefined), { style: `Heading${level}`, keepNext: true })); break; }
      case "paragraph": stats.paragraphs++; body.push(paragraph(runsFor(block.text, block.runs), { align: block.align })); break;
      case "bullets": case "numbered": {
        const numId = block.type === "bullets" ? 1 : (nextNum++, numberedIds.push(nextNum - 1), nextNum - 1);
        for (const item of block.items ?? []) { const level = typeof item === "string" ? 0 : Math.min(Math.max(item.level ?? 0, 0), 2); stats.listItems++; body.push(paragraph(runsFor(typeof item === "string" ? item : item.text, undefined), { style: "ListParagraph", num: [numId, level] })); }
        break;
      }
      case "table": body.push(tableXml(block)); break;
      case "image": body.push(paragraph(imageXml(block), { align: block.align ?? "center", keepNext: !!block.caption })); if (block.caption) body.push(paragraph(runsFor(block.caption, undefined), { style: "Caption", align: block.align ?? "center" })); break;
      case "quote": stats.paragraphs++; body.push(paragraph(runsFor(block.text, undefined, { italic: true }) + (block.cite ? runXml({ text: ` — ${block.cite}` }) : ""), { style: "Quote" })); break;
      case "code": for (const line of String(block.text ?? "").split("\n")) body.push(paragraph(line ? `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>` : "", { style: "Code" })); stats.paragraphs++; break;
      case "pagebreak": body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); break;
      default: throw new Error(`Unknown block type ${JSON.stringify((block as any).type)}`);
    }
  }
  if (stats.blocks === 0 && !spec.title) throw new Error("The document has no content: add at least one block or a title");

  const fieldRuns = (text: string): string => text.split(/(\{pages?\})/).map(part => part === "{page}" ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    : part === "{pages}" ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    : part ? `<w:r><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>` : "").join("");
  const extra: ZipSource[] = [];
  const sectRefs: string[] = [];
  if (spec.header) { extra.push({ name: "word/header1.xml", data: `${XML_HEAD}<w:hdr ${NS_W}>${paragraph(fieldRuns(spec.header), { style: "Header" })}</w:hdr>` }); sectRefs.push(`<w:headerReference w:type="default" r:id="${relFor("header", "header1.xml")}"/>`); }
  if (spec.footer) { extra.push({ name: "word/footer1.xml", data: `${XML_HEAD}<w:ftr ${NS_W}>${paragraph(fieldRuns(spec.footer), { style: "Footer", align: "center" })}</w:ftr>` }); sectRefs.push(`<w:footerReference w:type="default" r:id="${relFor("footer", "footer1.xml")}"/>`); }
  const sect = `<w:sectPr>${sectRefs.join("")}<w:pgSz w:w="${landscape ? pageH : pageW}" w:h="${landscape ? pageW : pageH}"${landscape ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const documentXml = `${XML_HEAD}<w:document ${NS_W}><w:body>${body.join("")}${sect}</w:body></w:document>`;

  const heading = (id: string, name: string, pt: number, before: number, after: number, color: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="${headingFamily}" w:hAnsi="${headingFamily}" w:cs="${headingFamily}"/><w:b/><w:color w:val="${color}"/><w:sz w:val="${pt * 2}"/><w:szCs w:val="${pt * 2}"/></w:rPr></w:style>`;
  const stylesXml = `${XML_HEAD}<w:styles ${NS_W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:eastAsia="${family}" w:cs="${family}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>`
    + `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="${headingFamily}" w:hAnsi="${headingFamily}" w:cs="${headingFamily}"/><w:b/><w:color w:val="${accent}"/><w:sz w:val="${Math.round(size * 2 * 2.4)}"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="${Math.round(size * 2 * 1.3)}"/></w:rPr></w:style>`
    + heading("Heading1", "heading 1", Math.round(size * 1.65), 360, 120, accent) + heading("Heading2", "heading 2", Math.round(size * 1.35), 280, 100, accent) + heading("Heading3", "heading 3", Math.round(size * 1.15), 220, 80, "374151")
    + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="10" w:color="9CA3AF"/></w:pBdr><w:spacing w:before="160" w:after="160"/><w:ind w:left="567" w:right="567"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="${Math.max(16, size * 2 - 2)}"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="${Math.max(16, size * 2 - 2)}"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`
    + `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style></w:styles>`;

  const level = (index: number, format: string, text: string) => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + index * 360}" w:hanging="360"/></w:pPr></w:lvl>`;
  const numberingXml = `${XML_HEAD}<w:numbering ${NS_W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "bullet", "•")}${level(1, "bullet", "–")}${level(2, "bullet", "·")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "%3.")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${numberedIds.map(id => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("")}</w:numbering>`;
  const settingsXml = `${XML_HEAD}<w:settings ${NS_W}><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const docRels = `${XML_HEAD}<Relationships xmlns="${REL_NS}">${rels.map(rel => `<Relationship Id="${rel.id}" Type="${REL}/${rel.type}" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${spec.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}${spec.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const buffer = writeZip([
    { name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: rootRels.replace("WORD_OR_XL", "word/document.xml") },
    { name: "docProps/core.xml", data: coreProps(spec.title, spec.author, now) }, { name: "docProps/app.xml", data: appProps("YunusPi office_doc") },
    { name: "word/document.xml", data: documentXml }, { name: "word/styles.xml", data: stylesXml }, { name: "word/numbering.xml", data: numberingXml }, { name: "word/settings.xml", data: settingsXml },
    { name: "word/_rels/document.xml.rels", data: docRels }, ...extra, ...media,
  ]);
  return { buffer, stats, warnings };
}

/* ───────────────────────────── xlsx ───────────────────────────── */

export type XlsxFormat = "text" | "integer" | "decimal" | "currency" | "percent" | "date" | "datetime";
export type XlsxCell = string | number | boolean | null | { formula: string; format?: XlsxFormat };
export type XlsxSheetSpec = {
  name: string;
  columns?: Array<{ header: string; width?: number; format?: XlsxFormat; align?: "left" | "center" | "right" }>;
  rows: XlsxCell[][];
  headerRow?: boolean;
  freeze?: boolean | string; filter?: boolean; wrap?: boolean;
  totals?: { label?: string; sum?: Array<string> };
};
export type XlsxSpec = { title?: string; author?: string; currency?: string; sheets: XlsxSheetSpec[] };
export type XlsxBuild = {
  buffer: Buffer;
  sheets: Array<{ name: string; rows: number; columns: number; formulas: number; calculated: number; uncalculated: string[]; errors: string[] }>;
  converted: { numericStrings: number; dateStrings: number };
  warnings: string[];
};

const FORMAT_CODES: Record<XlsxFormat, (symbol: string) => string | number> = {
  text: () => 49, integer: () => 3, decimal: () => 4, currency: symbol => `"${symbol}"#,##0.00;[Red]-"${symbol}"#,##0.00`, percent: () => "0.0%", date: () => "yyyy-mm-dd", datetime: () => "yyyy-mm-dd hh:mm",
};
const BAD_SHEET_CHARS = /[\[\]:*?/\\]/;
export function validateSheetName(name: string, seen: Set<string>): string {
  if (typeof name !== "string" || !name.trim()) throw new Error("Every sheet needs a name");
  if (name.length > 31) throw new Error(`Sheet name ${JSON.stringify(name)} is longer than Excel's 31-character limit`);
  if (BAD_SHEET_CHARS.test(name)) throw new Error(`Sheet name ${JSON.stringify(name)} contains one of [ ] : * ? / \\`);
  if (/^'|'$/.test(name)) throw new Error(`Sheet name ${JSON.stringify(name)} cannot start or end with an apostrophe`);
  if (name.toLowerCase() === "history") throw new Error('"History" is reserved by Excel');
  if (seen.has(name.toLowerCase())) throw new Error(`Duplicate sheet name ${JSON.stringify(name)} (names are case-insensitive)`);
  seen.add(name.toLowerCase());
  return name;
}
const excelSerial = (iso: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso.trim());
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isFinite(ms) ? (ms - Date.UTC(1899, 11, 30)) / 86400000 : undefined;
};

class StyleBook {
  fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'];
  fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  numFmts = new Map<string, number>();
  xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  known = new Map<string, number>();
  symbol: string;
  constructor(symbol: string) { this.symbol = symbol; }
  private slot(list: string[], xml: string): number { const at = list.indexOf(xml); if (at >= 0) return at; list.push(xml); return list.length - 1; }
  get(spec: { format?: XlsxFormat; bold?: boolean; fill?: string; top?: boolean; bottom?: boolean; wrap?: boolean; align?: string; vertical?: string }): number {
    if (!spec.format && !spec.bold && !spec.fill && !spec.top && !spec.bottom && !spec.wrap && !spec.align && !spec.vertical) return 0;
    const key = JSON.stringify(spec);
    const known = this.known.get(key); if (known !== undefined) return known;
    let numFmtId = 0;
    if (spec.format) { const code = FORMAT_CODES[spec.format](this.symbol); if (typeof code === "number") numFmtId = code; else { if (!this.numFmts.has(code)) this.numFmts.set(code, 164 + this.numFmts.size); numFmtId = this.numFmts.get(code)!; } }
    const fontId = spec.bold ? this.slot(this.fonts, '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>') : 0;
    const fillId = spec.fill ? this.slot(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${spec.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const edge = (name: string, on?: boolean) => on ? `<${name} style="thin"><color rgb="FF9CA3AF"/></${name}>` : `<${name}/>`;
    const borderId = spec.top || spec.bottom ? this.slot(this.borders, `<border><left/><right/>${edge("top", spec.top)}${edge("bottom", spec.bottom)}<diagonal/></border>`) : 0;
    const alignment = spec.align || spec.wrap || spec.vertical ? `<alignment${spec.align ? ` horizontal="${spec.align}"` : ""}${spec.vertical ? ` vertical="${spec.vertical}"` : ""}${spec.wrap ? ' wrapText="1"' : ""}/>` : "";
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${alignment ? ' applyAlignment="1">' + alignment + "</xf>" : "/>"}`;
    this.xfs.push(xf); this.known.set(key, this.xfs.length - 1);
    return this.xfs.length - 1;
  }
  xml(): string {
    const numFmts = this.numFmts.size ? `<numFmts count="${this.numFmts.size}">${[...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`).join("")}</numFmts>` : "";
    return `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
  }
}

const NUMERIC_TEXT = /^\s*[-+]?[$€£¥₺]?\s?[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?%?\s*$|^\s*[-+]?[$€£¥₺]?\s?[-+]?\d+(?:\.\d+)?\s?%?\s*$/;
function numberFromText(text: string, format: XlsxFormat | undefined): number | undefined {
  if (!NUMERIC_TEXT.test(text)) return undefined;
  const percent = /%\s*$/.test(text), value = Number(text.replace(/[,$€£¥₺%\s]/g, ""));
  if (!Number.isFinite(value)) return undefined;
  return percent ? value / 100 : (format === "percent" && Math.abs(value) > 1 ? value / 100 : value);
}

export function buildXlsx(spec: XlsxSpec, now = new Date()): XlsxBuild {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) throw new Error("spec.sheets must list at least one sheet");
  if (spec.sheets.length > OFFICE_BUILD_LIMITS.sheets) throw new Error(`At most ${OFFICE_BUILD_LIMITS.sheets} sheets are supported`);
  const styles = new StyleBook(typeof spec.currency === "string" && /^[^\s"<>&]{1,3}$/.test(spec.currency) ? spec.currency : "$");
  const shared: string[] = [], sharedIndex = new Map<string, number>();
  const warnings: string[] = [], converted = { numericStrings: 0, dateStrings: 0 };
  const seen = new Set<string>();
  type Placed = { col: number; row: number; value: CellValue; formula?: string; style: number; format?: XlsxFormat };
  type Prepared = { name: string; cells: Placed[]; widths: number[]; rows: number; columns: number; spec: XlsxSheetSpec; headerRows: number; totalRow?: number; freezeRef?: string; filterRef?: string };
  const prepared: Prepared[] = [];
  let cellCount = 0;

  for (const sheet of spec.sheets) {
    const name = validateSheetName(sheet?.name, seen);
    if (!Array.isArray(sheet.rows)) throw new Error(`Sheet ${JSON.stringify(name)} needs a rows array`);
    if (sheet.rows.length > OFFICE_BUILD_LIMITS.rows) throw new Error(`Sheet ${JSON.stringify(name)} has more than ${OFFICE_BUILD_LIMITS.rows} rows`);
    const columnsSpec = sheet.columns ?? [], hasHeader = columnsSpec.length > 0 || sheet.headerRow === true;
    const width = Math.max(columnsSpec.length, ...sheet.rows.map(row => Array.isArray(row) ? row.length : 0));
    if (width > OFFICE_BUILD_LIMITS.columns) throw new Error(`Sheet ${JSON.stringify(name)} has more than ${OFFICE_BUILD_LIMITS.columns} columns`);
    const cells: Placed[] = [], longest = Array.from({ length: width }, () => 0);
    const headStyle = (c: number) => styles.get({ bold: true, fill: "E5E7EB", bottom: true, wrap: true, vertical: "center", align: columnsSpec[c]?.align });
    let rowNumber = 0;
    if (columnsSpec.length) {
      rowNumber++;
      columnsSpec.forEach((column, c) => { cells.push({ col: c + 1, row: rowNumber, value: String(column.header ?? ""), style: headStyle(c) }); longest[c] = Math.max(longest[c], String(column.header ?? "").length); });
    }
    const body = sheet.rows.map(row => Array.isArray(row) ? row : [row as unknown as XlsxCell]);
    body.forEach((row, index) => {
      rowNumber++;
      const isHeaderRow = !columnsSpec.length && sheet.headerRow === true && index === 0;
      row.forEach((raw, c) => {
        if (raw === null || raw === undefined || raw === "") return;
        const column = columnsSpec[c], format = (typeof raw === "object" && raw !== null ? raw.format : undefined) ?? column?.format;
        let value: CellValue = null, formula: string | undefined;
        if (typeof raw === "object" && raw !== null) formula = String(raw.formula).replace(/^=/, "");
        else if (typeof raw === "string" && raw.startsWith("=") && raw.length > 1) formula = raw.slice(1);
        else if (typeof raw === "string") {
          const asNumber = !isHeaderRow && format && ["integer", "decimal", "currency", "percent"].includes(format) ? numberFromText(raw, format) : undefined;
          const asDate = !isHeaderRow && (format === "date" || format === "datetime") ? excelSerial(raw) : undefined;
          if (asNumber !== undefined) { value = asNumber; converted.numericStrings++; } else if (asDate !== undefined) { value = asDate; converted.dateStrings++; } else value = raw;
        } else value = raw;
        const style = isHeaderRow ? headStyle(c) : styles.get({ format, wrap: sheet.wrap || (typeof value === "string" && value.includes("\n")), vertical: sheet.wrap ? "top" : undefined, align: column?.align });
        cells.push({ col: c + 1, row: rowNumber, value, formula, style, format });
        if (typeof value === "string") longest[c] = Math.max(longest[c], ...value.split("\n").map(line => Math.min(line.length, 80)));
        else if (typeof value === "number") longest[c] = Math.max(longest[c], String(Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2)).length + 2);
        cellCount++;
      });
    });
    if (cellCount > OFFICE_BUILD_LIMITS.cells) throw new Error(`The workbook has more than ${OFFICE_BUILD_LIMITS.cells} cells`);
    const headerRows = hasHeader ? 1 : 0, dataLast = rowNumber;
    let totalRow: number | undefined;
    if (sheet.totals?.sum?.length) {
      totalRow = ++rowNumber;
      const label = sheet.totals.label ?? "Total";
      cells.push({ col: 1, row: totalRow, value: label, style: styles.get({ bold: true, top: true }) });
      for (const target of sheet.totals.sum) {
        const byHeader = columnsSpec.findIndex(column => column.header?.toLowerCase() === String(target).toLowerCase()) + 1;
        const letters = byHeader ? columnName(byHeader) : /^[A-Za-z]{1,3}$/.test(target) ? target.toUpperCase() : "";
        const col = letters ? columnNumber(letters) : 0;
        if (!col || col > width) throw new Error(`totals.sum refers to ${JSON.stringify(target)}, which is not a column of sheet ${JSON.stringify(name)}`);
        const format = columnsSpec[col - 1]?.format ?? "decimal";
        cells.push({ col, row: totalRow, value: null, formula: `SUM(${letters}${headerRows + 1}:${letters}${dataLast})`, style: styles.get({ bold: true, top: true, format }), format });
      }
    }
    const freezeRef = typeof sheet.freeze === "string" ? sheet.freeze.toUpperCase() : (sheet.freeze ?? (hasHeader && body.length >= 12)) && headerRows ? `A${headerRows + 1}` : undefined;
    if (freezeRef && !/^[A-Z]{1,3}[1-9]\d*$/.test(freezeRef)) throw new Error(`freeze must be true or a cell reference like "B2", got ${JSON.stringify(sheet.freeze)}`);
    const filterRef = (sheet.filter ?? (hasHeader && body.length >= 8)) && hasHeader && width > 0 ? `A1:${columnName(width)}${dataLast}` : undefined;
    const widths = longest.map((len, c) => columnsSpec[c]?.width ?? Math.min(Math.max(Math.ceil(len * 1.1) + 2, 8), 60));
    prepared.push({ name, cells, widths, rows: rowNumber, columns: width, spec: sheet, headerRows, totalRow, freezeRef, filterRef });
  }

  // Evaluate every formula (across sheets) so cached results are stored and errors are caught now.
  const grid = new Map<string, Map<string, Placed>>();
  for (const sheet of prepared) grid.set(sheet.name.toLowerCase(), new Map(sheet.cells.map(cell => [`${cell.col},${cell.row}`, cell])));
  const results = new Map<Placed, ReturnType<typeof evaluateFormula>>();
  const evaluated = (cell: Placed, sheetName: string) => {
    let result = results.get(cell);
    if (!result) {
      results.set(cell, { ok: false, error: "#REF!" }); // a reference back to itself is a circular reference
      result = evaluateFormula(cell.formula!, lookup, sheetName); results.set(cell, result);
    }
    return result;
  };
  const lookup: SheetLookup = (sheetName, col, row) => {
    const key = (sheetName ?? "").toLowerCase(), target = grid.get(key); const cell = target?.get(`${col},${row}`);
    if (!cell) return null;
    if (cell.formula === undefined) return cell.value;
    const result = evaluated(cell, prepared.find(sheet => sheet.name.toLowerCase() === key)?.name ?? sheetName ?? "");
    return result.ok ? result.value : { error: result.error, unsupported: result.unsupported };
  };
  const report = new Map<string, XlsxBuild["sheets"][number]>();
  for (const sheet of prepared) {
    const info = { name: sheet.name, rows: sheet.rows, columns: sheet.columns, formulas: 0, calculated: 0, uncalculated: [] as string[], errors: [] as string[] };
    report.set(sheet.name, info);
    for (const cell of sheet.cells) {
      if (cell.formula === undefined) continue;
      info.formulas++;
      const result = evaluated(cell, sheet.name);
      const ref = `${columnName(cell.col)}${cell.row}`;
      if (result.ok) { cell.value = result.value; info.calculated++; }
      else if (result.unsupported) { cell.value = null; info.uncalculated.push(`${ref} =${cell.formula.slice(0, 50)}`); }
      else { cell.value = result.error; info.errors.push(`${ref} =${cell.formula.slice(0, 50)} → ${result.error}`); }
    }
  }

  const sheetXml = prepared.map((sheet, index) => {
    const byRow = new Map<number, Placed[]>(); for (const cell of sheet.cells) { const list = byRow.get(cell.row) ?? []; list.push(cell); byRow.set(cell.row, list); }
    const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map(row => {
      const cells = byRow.get(row)!.sort((a, b) => a.col - b.col).map(cell => {
        const ref = `${columnName(cell.col)}${cell.row}`, s = cell.style ? ` s="${cell.style}"` : "";
        const f = cell.formula !== undefined ? `<f>${escapeXml(cell.formula)}</f>` : "";
        const isError = typeof cell.value === "string" && cell.formula !== undefined && /^#[A-Z/0!?]+[!?]?$/.test(cell.value);
        if (isError) return `<c r="${ref}"${s} t="e">${f}<v>${escapeXml(String(cell.value))}</v></c>`;
        if (typeof cell.value === "number") return `<c r="${ref}"${s}>${f}<v>${Number.isFinite(cell.value) ? cell.value : 0}</v></c>`;
        if (typeof cell.value === "boolean") return `<c r="${ref}"${s} t="b">${f}<v>${cell.value ? 1 : 0}</v></c>`;
        if (typeof cell.value === "string") {
          if (cell.formula !== undefined) return `<c r="${ref}"${s} t="str">${f}<v>${escapeXml(cell.value)}</v></c>`;
          let at = sharedIndex.get(cell.value); if (at === undefined) { at = shared.length; shared.push(cell.value); sharedIndex.set(cell.value, at); }
          return `<c r="${ref}"${s} t="s"><v>${at}</v></c>`;
        }
        return `<c r="${ref}"${s}>${f}</c>`;
      }).join("");
      return `<row r="${row}">${cells}</row>`;
    }).join("");
    const pane = sheet.freezeRef ? (() => { const m = /^([A-Z]+)(\d+)$/.exec(sheet.freezeRef!)!; const x = columnNumber(m[1]) - 1, y = Number(m[2]) - 1; const active = x && y ? "bottomRight" : y ? "bottomLeft" : "topRight"; return `<pane${x ? ` xSplit="${x}"` : ""}${y ? ` ySplit="${y}"` : ""} topLeftCell="${sheet.freezeRef}" activePane="${active}" state="frozen"/><selection pane="${active}"/>`; })() : "";
    const cols = sheet.widths.length ? `<cols>${sheet.widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const dimension = sheet.rows && sheet.columns ? `A1:${columnName(sheet.columns)}${sheet.rows}` : "A1";
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ""}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowsXml}</sheetData>${sheet.filterRef ? `<autoFilter ref="${sheet.filterRef}"/>` : ""}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  });

  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${prepared.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const workbookRels = `${XML_HEAD}<Relationships xmlns="${REL_NS}">${prepared.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${prepared.length + 1}" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId${prepared.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const sharedXml = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map(text => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("")}</sst>`;
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${prepared.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const buffer = writeZip([
    { name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: rootRels.replace("WORD_OR_XL", "xl/workbook.xml") },
    { name: "docProps/core.xml", data: coreProps(spec.title, spec.author, now) }, { name: "docProps/app.xml", data: appProps("YunusPi office_doc") },
    { name: "xl/workbook.xml", data: workbook }, { name: "xl/_rels/workbook.xml.rels", data: workbookRels }, { name: "xl/styles.xml", data: styles.xml() }, { name: "xl/sharedStrings.xml", data: sharedXml },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ]);
  for (const info of report.values()) {
    if (info.errors.length) warnings.push(`Sheet ${JSON.stringify(info.name)}: ${info.errors.length} formula(s) evaluate to an error (${info.errors.slice(0, 3).join("; ")}).`);
    if (info.uncalculated.length) warnings.push(`Sheet ${JSON.stringify(info.name)}: ${info.uncalculated.length} formula(s) use features the built-in calculator does not cover (${info.uncalculated.slice(0, 2).join("; ")}); they are calculated when the file is opened.`);
  }
  for (const sheet of prepared) {
    const percentColumns = (sheet.spec.columns ?? []).flatMap((column, c) => column.format === "percent" ? [c + 1] : []);
    const big = sheet.cells.filter(cell => percentColumns.includes(cell.col) && cell.formula === undefined && typeof cell.value === "number" && Math.abs(cell.value) > 1).length;
    if (big) warnings.push(`Sheet ${JSON.stringify(sheet.name)}: ${big} value(s) in percent columns are above 1 and will display as more than 100% (write 12% as 0.12 or "12%").`);
  }
  if (converted.numericStrings) warnings.push(`${converted.numericStrings} numeric-looking text value(s) were stored as numbers because their column has a numeric format.`);
  return { buffer, sheets: [...report.values()], converted, warnings };
}
