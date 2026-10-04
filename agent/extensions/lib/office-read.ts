/** Read and verify Office files (docx, xlsx, pptx, and OpenDocument text/sheet/slides) without
 * any office suite. One pass over the parts produces both the readable content and the findings
 * that matter for a deliverable: damaged archives, malformed parts, broken relationships,
 * unreplaced placeholders, formulas that were never calculated or that evaluate to errors,
 * numbers stored as text, empty slides, walls of text and tiny type.
 *
 * Output is bounded (text, sample rows, findings) so a large file cannot flood a context, and
 * everything is derived from the file bytes: nothing here claims to know how Word, Excel or
 * PowerPoint will paginate or lay out the result. Rendering is a separate, optional step. */
import fs from "node:fs";
import path from "node:path";
import { openZip, type ZipReader } from "./office-zip.ts";
import { parseXml, XmlError, childOf, childrenOf, descendantsOf, elementsOf, textOf, type XmlNode } from "./xml-lite.ts";
import { unprefixedFutureFunctions } from "./sheet-formula.ts";

export type OfficeKind = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";
export type Finding = { severity: "error" | "warn" | "info"; code: string; message: string; hint?: string; where?: string };
export type ReadOptions = { maxChars?: number; maxRows?: number; maxCols?: number; sheet?: string; maxSlides?: number };
export type CellSample = { ref: string; value: string | number | boolean | null; formula?: string; type?: string };
export type SheetRead = {
  name: string; state: string; dimension?: string; rows: number; columns: number; nonEmptyCells: number; formulas: number; formulasWithoutResult: number;
  errors: string[]; merged: number; frozen: boolean; filter: boolean; tables: number; charts: number; sample: CellSample[][];
};
export type SlideRead = { index: number; layout?: string; title?: string; text: string; words: number; shapes: number; images: number; tables: number; charts: number; notes?: string; emptyPlaceholders: number };
export type OfficeRead = {
  kind: OfficeKind; path: string; bytes: number; parts: number;
  meta: { title?: string; author?: string; created?: string; modified?: string; application?: string };
  text: string; truncated: boolean; words: number;
  stats: Record<string, number>;
  headings?: Array<{ level: number; text: string }>;
  tables?: Array<{ rows: number; columns: number; sample: string[][] }>;
  sheets?: SheetRead[]; slides?: SlideRead[];
  findings: Finding[];
};

const EXTENSIONS: Record<string, OfficeKind> = { ".docx": "docx", ".dotx": "docx", ".docm": "docx", ".xlsx": "xlsx", ".xltx": "xlsx", ".xlsm": "xlsx", ".pptx": "pptx", ".potx": "pptx", ".pptm": "pptx", ".odt": "odt", ".ods": "ods", ".odp": "odp" };
export const OFFICE_EXTENSIONS = Object.freeze(Object.keys(EXTENSIONS));
export const officeKindForPath = (file: string): OfficeKind | undefined => EXTENSIONS[path.extname(file).toLowerCase()];

const PLACEHOLDERS: Array<[RegExp, string]> = [
  [/\{\{[^{}\n]{1,60}\}\}/, "template field {{…}}"], [/\$\{[^{}\n]{1,60}\}/, "template field ${…}"], [/<<[^<>\n]{1,60}>>/, "template field <<…>>"],
  [/\[(?:insert|your|enter|add|company|client|customer|name|date|title|todo|tbd|placeholder|address|phone|email)[^\]\n]{0,50}\]/i, "bracketed placeholder"],
  [/\blorem ipsum\b|\bdolor sit amet\b/i, "lorem ipsum filler"], [/\b(?:TODO|TBD|FIXME)\b|\bXX{2,}\b/, "TODO/TBD marker"],
  [/click to add (?:title|text|subtitle|notes)/i, "unfilled slide prompt"], [/\bsample text\b|\bplaceholder text\b|\byour text here\b/i, "sample text"],
];
export function placeholderHits(text: string, limit = 5): string[] {
  const hits: string[] = [];
  for (const [pattern, label] of PLACEHOLDERS) {
    const match = pattern.exec(text);
    if (match) { hits.push(`${label}: “${match[0].slice(0, 60)}”`); if (hits.length >= limit) break; }
  }
  return hits;
}

const attr = (node: XmlNode | undefined, name: string): string | undefined => node?.attrs[name];
const words = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) : text;
const cleanText = (text: string) => text.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n");

function partXml(zip: ZipReader, name: string, findings: Finding[], required = true): XmlNode | undefined {
  if (!zip.has(name)) { if (required) findings.push({ severity: "error", code: "missing-part", message: `The archive has no ${name}.`, hint: "The file is incomplete or is not this Office format.", where: name }); return undefined; }
  try { return parseXml(zip.text(name)); }
  catch (error) {
    const detail = error instanceof XmlError ? error.message : String((error as Error)?.message ?? error);
    findings.push({ severity: "error", code: "xml-malformed", message: `${name} is not well-formed XML: ${detail.slice(0, 160)}`, hint: "Rebuild the file from its source; an editor that opens it may silently repair or drop content.", where: name });
    return undefined;
  }
}

function relationshipTargets(zip: ZipReader, owner: string, findings: Finding[], checkMissing = true): Map<string, { target: string; type: string; external: boolean }> {
  const dir = path.posix.dirname(owner), relsName = `${dir === "." ? "" : dir + "/"}_rels/${path.posix.basename(owner)}.rels`;
  const map = new Map<string, { target: string; type: string; external: boolean }>();
  if (!zip.has(relsName)) return map;
  let root: XmlNode;
  try { root = parseXml(zip.text(relsName)); } catch { return map; }
  for (const rel of childrenOf(root, "Relationship")) {
    const id = attr(rel, "Id"), target = attr(rel, "Target"), external = attr(rel, "TargetMode") === "External";
    if (!id || !target) continue;
    const resolved = external ? target : target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(dir === "." ? "" : dir, target));
    map.set(id, { target: resolved, type: (attr(rel, "Type") ?? "").split("/").pop() ?? "", external });
    let decoded = resolved; try { decoded = decodeURIComponent(resolved); } catch { /* keep the raw target */ }
    if (checkMissing && !external && !zip.has(resolved) && !zip.has(decoded))
      findings.push({ severity: "error", code: "broken-relationship", message: `${owner} refers to ${resolved}, which is not in the file.`, hint: "A missing image, slide or style part makes Office offer to repair the file.", where: owner });
  }
  return map;
}

function documentMeta(zip: ZipReader): OfficeRead["meta"] {
  const meta: OfficeRead["meta"] = {};
  try {
    if (zip.has("docProps/core.xml")) {
      const core = parseXml(zip.text("docProps/core.xml"));
      const pick = (name: string) => { const value = textOf(descendantsOf(core, name)[0]).trim(); return value || undefined; };
      meta.title = pick("dc:title"); meta.author = pick("dc:creator"); meta.created = pick("dcterms:created"); meta.modified = pick("dcterms:modified");
    }
    if (zip.has("docProps/app.xml")) meta.application = textOf(descendantsOf(parseXml(zip.text("docProps/app.xml")), "Application")[0]).trim() || undefined;
    if (zip.has("meta.xml")) {
      const odf = parseXml(zip.text("meta.xml"));
      meta.title ??= textOf(descendantsOf(odf, "dc:title")[0]).trim() || undefined;
      meta.author ??= textOf(descendantsOf(odf, "meta:initial-creator")[0]).trim() || undefined;
      meta.application ??= textOf(descendantsOf(odf, "meta:generator")[0]).trim() || undefined;
    }
  } catch { /* metadata is optional */ }
  for (const key of Object.keys(meta) as Array<keyof typeof meta>) if (meta[key] === undefined) delete meta[key];
  return meta;
}

/* ───────────────────────────── docx ───────────────────────────── */

function readDocx(zip: ZipReader, options: Required<Pick<ReadOptions, "maxChars" | "maxRows" | "maxCols">>, findings: Finding[]) {
  const main = partXml(zip, "word/document.xml", findings);
  const styles = new Map<string, string>();
  const stylesRoot = partXml(zip, "word/styles.xml", findings, false);
  if (stylesRoot) for (const style of childrenOf(stylesRoot, "w:style")) { const id = attr(style, "w:styleId"), name = attr(childOf(style, "w:name"), "w:val"); if (id && name) styles.set(id, name); }
  const rels = relationshipTargets(zip, "word/document.xml", findings);
  const fonts = new Map<string, number>(), sizes = new Map<number, number>();
  const headings: Array<{ level: number; text: string }> = [], tables: NonNullable<OfficeRead["tables"]> = [];
  const blocks: string[] = [];
  let paragraphs = 0, blankRun = 0, maxBlankRun = 0, longest = 0, images = 0, hyperlinks = 0, lists = 0, pageBreaks = 0, emptyCells = 0, cells = 0;

  const runText = (run: XmlNode): string => {
    let out = "";
    for (const child of elementsOf(run)) {
      if (child.name === "w:t") out += textOf(child);
      else if (child.name === "w:tab") out += "\t";
      else if (child.name === "w:br" || child.name === "w:cr") { if (attr(child, "w:type") === "page") pageBreaks++; else out += "\n"; }
      else if (child.name === "w:noBreakHyphen") out += "-";
      else if (child.name === "w:drawing" || child.name === "w:pict") images++;
    }
    const props = childOf(run, "w:rPr");
    if (props && out.trim()) {
      const font = attr(childOf(props, "w:rFonts"), "w:ascii") ?? attr(childOf(props, "w:rFonts"), "w:hAnsi");
      if (font) fonts.set(font, (fonts.get(font) ?? 0) + out.length);
      const size = Number(attr(childOf(props, "w:sz"), "w:val")); if (Number.isFinite(size) && size > 0) sizes.set(size / 2, (sizes.get(size / 2) ?? 0) + out.length);
    }
    return out;
  };
  const inlineText = (node: XmlNode): string => {
    let out = "";
    for (const child of elementsOf(node)) {
      if (child.name === "w:r") out += runText(child);
      else if (child.name === "w:hyperlink") { hyperlinks++; out += inlineText(child); }
      else if (["w:ins", "w:smartTag", "w:fldSimple", "w:sdt", "w:sdtContent", "w:customXml"].includes(child.name)) out += inlineText(child);
    }
    return out;
  };
  const paragraph = (node: XmlNode): string => {
    const props = childOf(node, "w:pPr");
    const styleId = attr(childOf(props, "w:pStyle"), "w:val") ?? "", styleName = styles.get(styleId) ?? styleId;
    const text = cleanText(inlineText(node));
    const heading = /^(?:heading\s*(\d)|title)$/i.exec(styleName.replace(/\s+/g, " ").trim()) ?? /^Heading(\d)$/.exec(styleId);
    if (props && childOf(props, "w:numPr") || /^list/i.test(styleName)) lists++;
    if (!text.trim()) { blankRun++; maxBlankRun = Math.max(maxBlankRun, blankRun); return ""; }
    blankRun = 0; paragraphs++; longest = Math.max(longest, words(text));
    if (heading) headings.push({ level: heading[1] ? Number(heading[1]) : 0, text: text.trim().slice(0, 160) });
    return heading ? `${"#".repeat(Math.min(6, Math.max(1, Number(heading[1] ?? 1))))} ${text.trim()}` : text;
  };
  const table = (node: XmlNode) => {
    const rows = childrenOf(node, "w:tr").map(row => childrenOf(row, "w:tc").map(cell => {
      const content = elementsOf(cell).filter(child => child.name === "w:p").map(child => cleanText(inlineText(child)).trim()).filter(Boolean).join("\n");
      cells++; if (!content) emptyCells++;
      return content;
    }));
    if (!rows.length) return "";
    const columns = Math.max(...rows.map(row => row.length));
    tables.push({ rows: rows.length, columns, sample: rows.slice(0, options.maxRows).map(row => row.slice(0, options.maxCols).map(cell => clip(cell, 80))) });
    return rows.map(row => `| ${row.map(cell => cell.replace(/\n/g, " ")).join(" | ")} |`).join("\n");
  };
  const walk = (container: XmlNode) => {
    for (const child of elementsOf(container)) {
      if (child.name === "w:p") { const text = paragraph(child); if (text) blocks.push(text); }
      else if (child.name === "w:tbl") { const text = table(child); if (text) blocks.push(text); }
      else if (child.name === "w:sdt") walk(childOf(child, "w:sdtContent") ?? child);
    }
  };
  const body = childOf(main, "w:body");
  if (body) walk(body);
  const extraText: string[] = [];
  for (const entry of zip.entries) {
    if (/^word\/(?:header|footer)\d*\.xml$/.test(entry.name)) { try { const root = parseXml(zip.text(entry.name)); const text = descendantsOf(root, "w:t").map(textOf).join(" ").trim(); if (text) extraText.push(text); } catch { /* reported by integrity */ } }
  }
  let comments = 0, trackedInsertions = 0, trackedDeletions = 0;
  if (zip.has("word/comments.xml")) { try { comments = childrenOf(parseXml(zip.text("word/comments.xml")), "w:comment").length; } catch { /* ignore */ } }
  if (main) { trackedInsertions = descendantsOf(main, "w:ins").length; trackedDeletions = descendantsOf(main, "w:del").length; }
  const mediaFiles = zip.entries.filter(entry => entry.name.startsWith("word/media/")).length;
  const text = blocks.join("\n\n");
  const total = words(text);
  const pageSize = attr(descendantsOf(main, "w:pgSz")[0], "w:w");

  if (main && !text.trim() && images === 0) findings.push({ severity: "error", code: "empty-document", message: "The document body has no text, tables or images.", hint: "The writer produced a shell; check that the content was actually added before saving." });
  if (maxBlankRun >= 3) findings.push({ severity: "warn", code: "blank-line-spacing", message: `${maxBlankRun} empty paragraphs in a row are used as spacing.`, hint: "Use paragraph spacing or page breaks instead of blank lines; blank lines shift when the text reflows." });
  let skipped = 0; for (let i = 1; i < headings.length; i++) if (headings[i].level > headings[i - 1].level + 1 && headings[i - 1].level > 0) skipped++;
  if (skipped) findings.push({ severity: "info", code: "heading-skip", message: `${skipped} heading(s) skip a level (for example Heading 1 straight to Heading 3).`, hint: "Keep heading levels consecutive so navigation and the outline stay meaningful." });
  if (total >= 400 && headings.length === 0) findings.push({ severity: "warn", code: "no-headings", message: `A ${total}-word document has no headings.`, hint: "Use real heading styles (not bold body text) so readers and tools can navigate it." });
  if (longest >= 250) findings.push({ severity: "info", code: "wall-of-text", message: `One paragraph runs ${longest} words.`, hint: "Split long paragraphs; walls of text are rarely read." });
  const fontList = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
  if (fontList.length > 3) findings.push({ severity: "warn", code: "font-sprawl", message: `${fontList.length} different fonts are applied directly to text (${fontList.slice(0, 4).map(f => f[0]).join(", ")}).`, hint: "Set fonts in styles; more than two or three families reads as unplanned." });
  const tiny = [...sizes.entries()].filter(([size]) => size < 8).reduce((n, [, count]) => n + count, 0);
  if (tiny > 40) findings.push({ severity: "warn", code: "tiny-text", message: "Body text smaller than 8 pt is used.", hint: "Raise it; print and projection need 10–12 pt or more." });
  if (cells >= 6 && emptyCells / cells > 0.5) findings.push({ severity: "warn", code: "sparse-tables", message: `${emptyCells} of ${cells} table cells are empty.`, hint: "A mostly empty table usually means the data never reached it." });
  if (comments > 0) findings.push({ severity: "info", code: "review-comments", message: `${comments} review comment(s) remain in the document.`, hint: "Resolve or remove comments before sending a deliverable." });
  if (trackedInsertions + trackedDeletions > 0) findings.push({ severity: "info", code: "tracked-changes", message: `${trackedInsertions} tracked insertion(s) and ${trackedDeletions} deletion(s) are unresolved.`, hint: "Accept or reject tracked changes before sending the final file." });
  const hits = placeholderHits([text, ...extraText].join("\n"));
  if (hits.length) findings.push({ severity: "warn", code: "placeholder-text", message: `Unreplaced placeholder text: ${hits.join("; ")}.`, hint: "Search the document for these markers and replace them with real content." });

  const stats: Record<string, number> = { paragraphs, headings: headings.length, tables: tables.length, images: Math.max(images, mediaFiles), lists, hyperlinks, comments, trackedChanges: trackedInsertions + trackedDeletions, pageBreaks, fonts: fontList.length };
  if (pageSize) stats.pageWidthTwips = Number(pageSize);
  return { text, words: total, headings, tables, stats };
}

/* ───────────────────────────── xlsx ───────────────────────────── */

const columnIndex = (letters: string): number => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
const columnLetters = (index: number): string => { let out = ""; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const splitRef = (ref: string): { col: number; row: number } | undefined => { const match = /^([A-Z]{1,3})(\d+)$/.exec(ref); return match ? { col: columnIndex(match[1]), row: Number(match[2]) } : undefined; };
const ERROR_VALUE = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/;
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateFormatCode = (code: string): boolean => /[ymdhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, "")) && !/^(?:general|@)$/i.test(code);
function excelDate(serial: number): string {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16);
}

function readXlsx(zip: ZipReader, options: Required<Pick<ReadOptions, "maxChars" | "maxRows" | "maxCols">> & { sheet?: string }, findings: Finding[]) {
  const workbook = partXml(zip, "xl/workbook.xml", findings);
  const rels = relationshipTargets(zip, "xl/workbook.xml", findings);
  const shared: string[] = [];
  const sharedRoot = partXml(zip, "xl/sharedStrings.xml", findings, false);
  if (sharedRoot) for (const si of childrenOf(sharedRoot, "si")) shared.push(descendantsOf(si, "t").filter(t => !descendantsOf(si, "rPh").some(ph => descendantsOf(ph, "t").includes(t))).map(textOf).join(""));
  const dateStyles = new Set<number>();
  const stylesRoot = partXml(zip, "xl/styles.xml", findings, false);
  if (stylesRoot) {
    const custom = new Map<number, string>();
    for (const fmt of descendantsOf(childOf(stylesRoot, "numFmts"), "numFmt")) custom.set(Number(attr(fmt, "numFmtId")), attr(fmt, "formatCode") ?? "");
    childrenOf(childOf(stylesRoot, "cellXfs"), "xf").forEach((xf, index) => {
      const id = Number(attr(xf, "numFmtId") ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) dateStyles.add(index);
    });
  }
  const calcOnLoad = attr(childOf(workbook, "calcPr"), "fullCalcOnLoad") === "1" || attr(childOf(workbook, "calcPr"), "fullCalcOnLoad") === "true";
  const sheets: SheetRead[] = [], allText: string[] = [];
  let totalFormulas = 0, totalNoResult = 0, totalErrors = 0, textAsNumber = 0, clipped = 0, futureCount = 0;
  const futureHits: string[] = [];
  const sheetNodes = childrenOf(childOf(workbook, "sheets"), "sheet");
  if (workbook && sheetNodes.length === 0) findings.push({ severity: "error", code: "no-sheets", message: "The workbook lists no sheets." });
  for (const sheetNode of sheetNodes) {
    const name = attr(sheetNode, "name") ?? "Sheet", state = attr(sheetNode, "state") ?? "visible";
    const target = rels.get(attr(sheetNode, "r:id") ?? "");
    const wanted = !options.sheet || options.sheet.toLowerCase() === name.toLowerCase();
    const root = target && !target.external ? partXml(zip, target.target, findings, false) : undefined;
    if (!root) { sheets.push({ name, state, rows: 0, columns: 0, nonEmptyCells: 0, formulas: 0, formulasWithoutResult: 0, errors: [], merged: 0, frozen: false, filter: false, tables: 0, charts: 0, sample: [] }); continue; }
    const sheetRels = target ? relationshipTargets(zip, target.target, findings) : new Map();
    const widths = new Map<number, number>();
    for (const col of descendantsOf(childOf(root, "cols"), "col")) { const min = Number(attr(col, "min")), max = Number(attr(col, "max")), width = Number(attr(col, "width")); if (Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(width)) for (let c = min; c <= Math.min(max, min + 200); c++) widths.set(c, width); }
    const sheet: SheetRead = { name, state, dimension: attr(childOf(root, "dimension"), "ref"), rows: 0, columns: 0, nonEmptyCells: 0, formulas: 0, formulasWithoutResult: 0, errors: [], merged: childrenOf(childOf(root, "mergeCells"), "mergeCell").length,
      frozen: attr(childOf(childOf(childOf(root, "sheetViews"), "sheetView"), "pane"), "state") === "frozen", filter: !!childOf(root, "autoFilter"),
      tables: [...sheetRels.values()].filter(rel => rel.type === "table").length, charts: [...sheetRels.values()].filter(rel => rel.type === "drawing").length, sample: [] };
    const grid = new Map<string, CellSample>();
    const columnKinds = new Map<number, { numeric: number; text: number; numericText: number }>();
    const occupied = new Set<number>(), longText: number[] = [];
    for (const row of childrenOf(childOf(root, "sheetData"), "row")) {
      const rowIndex = Number(attr(row, "r")) || sheet.rows + 1;
      for (const cell of childrenOf(row, "c")) {
        const ref = attr(cell, "r") ?? "", pos = splitRef(ref), type = attr(cell, "t") ?? "n", style = Number(attr(cell, "s") ?? 0);
        const rawValue = textOf(childOf(cell, "v")), formulaNode = childOf(cell, "f");
        let value: CellSample["value"] = null;
        if (type === "s") value = shared[Number(rawValue)] ?? null;
        else if (type === "inlineStr") value = descendantsOf(childOf(cell, "is"), "t").map(textOf).join("");
        else if (type === "str") value = rawValue;
        else if (type === "b") value = rawValue === "1";
        else if (type === "e") value = rawValue;
        else if (rawValue !== "") { const number = Number(rawValue); value = Number.isFinite(number) ? (dateStyles.has(style) ? excelDate(number) : number) : rawValue; }
        const hasFormula = !!formulaNode;
        if (value === null && !hasFormula) continue;
        sheet.nonEmptyCells++;
        sheet.rows = Math.max(sheet.rows, pos?.row ?? rowIndex); sheet.columns = Math.max(sheet.columns, pos?.col ?? 0);
        if (hasFormula) {
          sheet.formulas++; if (value === null || value === "") sheet.formulasWithoutResult++;
          const raw = textOf(formulaNode), future = unprefixedFutureFunctions(raw);
          if (future.length) { futureCount++; if (futureHits.length < 4) futureHits.push(`${name}!${ref} ${future[0]}`); }
        }
        if (type === "e" || (typeof value === "string" && ERROR_VALUE.test(value))) sheet.errors.push(`${ref} ${value}`);
        if (typeof value === "string" && value) allText.push(value);
        if (pos && !hasFormula) {
          const kind = columnKinds.get(pos.col) ?? { numeric: 0, text: 0, numericText: 0 };
          if (typeof value === "number") kind.numeric++; else if (typeof value === "string") { kind.text++; if (/^\s*[-+]?\d[\d,]*(?:\.\d+)?%?\s*$/.test(value) && pos.row > 1) kind.numericText++; }
          columnKinds.set(pos.col, kind);
          if (typeof value === "string" && value.length > 14 && (widths.get(pos.col) ?? 8.43) < value.length * 0.85) longText.push(pos.row * 16384 + pos.col);
        }
        if (pos) occupied.add(pos.row * 16384 + pos.col);
        if (wanted && pos && pos.row <= options.maxRows && pos.col <= options.maxCols) grid.set(ref, { ref, value: typeof value === "string" ? clip(value, 120) : value, ...(hasFormula ? { formula: clip(textOf(formulaNode).replace(/_xlfn\.(?:_xlws\.)?/g, ""), 120) } : {}), ...(type === "e" ? { type: "error" } : {}) });
      }
    }
    // Text wider than its column is cut off at the next filled cell; count the cells where that happens.
    clipped += longText.filter(key => occupied.has(key + 1)).length;
    for (const [, kind] of columnKinds) if (kind.numeric >= 2 && kind.numericText >= 1 && kind.numericText <= kind.numeric * 3) textAsNumber += kind.numericText;
    if (wanted) {
      for (let r = 1; r <= Math.min(sheet.rows, options.maxRows); r++) {
        const line: CellSample[] = [];
        for (let c = 1; c <= Math.min(sheet.columns, options.maxCols); c++) { const cell = grid.get(`${columnLetters(c)}${r}`); if (cell) line.push(cell); }
        if (line.length) sheet.sample.push(line);
      }
    }
    totalFormulas += sheet.formulas; totalNoResult += sheet.formulasWithoutResult; totalErrors += sheet.errors.length;
    sheets.push(sheet);
    if (state === "visible" && sheet.nonEmptyCells === 0) findings.push({ severity: "warn", code: "empty-sheet", message: `Sheet “${name}” is empty.`, hint: "Remove unused sheets or fill them before delivery.", where: name });
    if (sheet.errors.length) findings.push({ severity: "error", code: "formula-errors", message: `Sheet “${name}” shows error values: ${sheet.errors.slice(0, 6).join(", ")}${sheet.errors.length > 6 ? ` (+${sheet.errors.length - 6} more)` : ""}.`, hint: "Trace each error to its input (#REF! is a deleted reference, #DIV/0! an empty divisor, #NAME? a misspelled function).", where: name });
  }
  if (totalNoResult > 0 && !calcOnLoad) findings.push({ severity: "warn", code: "uncalculated-formulas", message: `${totalNoResult} of ${totalFormulas} formulas have no stored result.`, hint: "Excel and LibreOffice recalculate on open, but previewers, pandas and many viewers show empty cells. Recalculate and re-save (soffice --headless --convert-to xlsx) or write the formulas with a calculation-on-load flag." });
  else if (totalNoResult > 0) findings.push({ severity: "info", code: "formulas-calculate-on-open", message: `${totalNoResult} formula results are computed when the file is opened (calculation on load is set).`, hint: "Viewers that do not calculate formulas will show these cells empty." });
  if (futureCount > 0) findings.push({ severity: "warn", code: "missing-xlfn-prefix", message: `${futureCount} formula${futureCount === 1 ? "" : "s"} call functions added after Excel 2007 without the _xlfn. prefix (${futureHits.join("; ")}).`, hint: "Excel shows #NAME? in those cells until each one is re-entered. Store the function as _xlfn.IFS(…), _xlfn.XLOOKUP(…), _xlfn.TEXTJOIN(…) (office_doc build does this), or use a classic equivalent (IF, VLOOKUP/INDEX+MATCH, &). Dynamic-array functions (FILTER, SORT, UNIQUE, SEQUENCE…) cannot be stored reliably by a script; use classic formulas." });
  if (textAsNumber > 0) findings.push({ severity: "warn", code: "numbers-as-text", message: `${textAsNumber} numeric-looking values are stored as text in columns that are otherwise numbers.`, hint: "Text-numbers do not sum, sort or chart correctly; write them as numbers with a number format." });
  if (clipped > 3) findings.push({ severity: "warn", code: "narrow-columns", message: `${clipped} text cells are wider than their column and are cut off by the neighbouring cell.`, hint: "Set column widths to fit the longest value (or wrap the text) so nothing is hidden when the sheet is opened." });
  if (zip.entries.some(entry => entry.name.startsWith("xl/externalLinks/"))) findings.push({ severity: "warn", code: "external-links", message: "The workbook links to other files.", hint: "Excel asks to update links on open; replace linked cells with values unless the link is intended." });
  if (zip.has("xl/vbaProject.bin")) findings.push({ severity: "info", code: "macros", message: "The workbook contains a VBA macro project." });
  const hits = placeholderHits(allText.join("\n"));
  if (hits.length) findings.push({ severity: "warn", code: "placeholder-text", message: `Unreplaced placeholder text in cells: ${hits.join("; ")}.`, hint: "Replace the markers with real values." });
  const text = sheets.filter(sheet => !options.sheet || sheet.name.toLowerCase() === options.sheet.toLowerCase()).map(sheet => `## ${sheet.name}\n` + sheet.sample.map(line => line.map(cell => cell.value === null ? "" : String(cell.value)).join(" | ")).join("\n")).join("\n\n");
  const stats: Record<string, number> = { sheets: sheets.length, formulas: totalFormulas, formulasWithoutResult: totalNoResult, errors: totalErrors, charts: sheets.reduce((n, s) => n + s.charts, 0), tables: sheets.reduce((n, s) => n + s.tables, 0), cells: sheets.reduce((n, s) => n + s.nonEmptyCells, 0) };
  return { text, words: words(allText.join(" ")), sheets, stats };
}

/* ───────────────────────────── pptx ───────────────────────────── */

function readPptx(zip: ZipReader, options: Required<Pick<ReadOptions, "maxChars" | "maxSlides">>, findings: Finding[]) {
  const presentation = partXml(zip, "ppt/presentation.xml", findings);
  const rels = relationshipTargets(zip, "ppt/presentation.xml", findings);
  const order = descendantsOf(childOf(presentation, "p:sldIdLst"), "p:sldId").map(node => rels.get(attr(node, "r:id") ?? "")?.target).filter((value): value is string => !!value);
  const slides: SlideRead[] = [], allText: string[] = [];
  const titles = new Map<string, number>();
  let tiny = 0, denseSlides = 0, emptySlides = 0;
  order.forEach((slidePart, position) => {
    const root = partXml(zip, slidePart, findings, false);
    if (!root) return;
    const slideRels = relationshipTargets(zip, slidePart, findings);
    const layoutPart = [...slideRels.values()].find(rel => rel.type === "slideLayout")?.target;
    let layout: string | undefined;
    if (layoutPart && zip.has(layoutPart)) { try { layout = attr(descendantsOf(parseXml(zip.text(layoutPart)), "p:cSld")[0], "name"); } catch { /* ignore */ } }
    const tree = childOf(childOf(root, "p:cSld"), "p:spTree");
    let title: string | undefined, images = 0, tables = 0, charts = 0, shapes = 0, emptyPlaceholders = 0;
    const parts: string[] = [];
    for (const shape of descendantsOf(tree, "p:sp", "p:pic", "p:graphicFrame")) {
      if (shape.name === "p:pic") { images++; continue; }
      if (shape.name === "p:graphicFrame") { if (descendantsOf(shape, "a:tbl").length) tables++; if (descendantsOf(shape, "c:chart").length) charts++; }
      else shapes++;
      const holder = descendantsOf(shape, "p:ph")[0], type = attr(holder, "type") ?? (holder ? "body" : "");
      const paragraphs = descendantsOf(shape, "a:p").map(p => cleanText(descendantsOf(p, "a:t").map(textOf).join("")).trim()).filter(Boolean);
      for (const run of descendantsOf(shape, "a:rPr")) { const size = Number(attr(run, "sz")); if (size && size < 1200) tiny++; }
      if (holder && paragraphs.length === 0 && shape.name === "p:sp" && !["sldNum", "dt", "ftr", "hdr"].includes(type)) emptyPlaceholders++;
      if (paragraphs.length) { if (!title && ["title", "ctrTitle"].includes(type)) title = paragraphs[0]; parts.push(...paragraphs); }
    }
    for (const rel of slideRels.values()) if (rel.type === "chart") charts++;
    let notes: string | undefined;
    const notesPart = [...slideRels.values()].find(rel => rel.type === "notesSlide")?.target;
    if (notesPart && zip.has(notesPart)) { try { notes = descendantsOf(parseXml(zip.text(notesPart)), "a:p").map(p => descendantsOf(p, "a:t").map(textOf).join("")).join("\n").trim().slice(0, 600) || undefined; } catch { /* ignore */ } }
    const text = parts.join("\n"), count = words(text);
    allText.push(text);
    if (title) titles.set(title, (titles.get(title) ?? 0) + 1);
    if (!text.trim() && images === 0 && tables === 0 && charts === 0) { emptySlides++; findings.push({ severity: "warn", code: "empty-slide", message: `Slide ${position + 1} has no text, picture, table or chart.`, hint: "Fill it or delete it.", where: `slide ${position + 1}` }); }
    if (count > 140) denseSlides++;
    if (emptyPlaceholders > 0) findings.push({ severity: "warn", code: "empty-placeholder", message: `Slide ${position + 1} has ${emptyPlaceholders} empty placeholder(s) that show prompt text such as “Click to add text” when edited.`, hint: "Fill or delete the placeholder.", where: `slide ${position + 1}` });
    slides.push({ index: position + 1, ...(layout ? { layout } : {}), ...(title ? { title } : {}), text: clip(text, 1500), words: count, shapes, images, tables, charts, ...(notes ? { notes } : {}), emptyPlaceholders });
  });
  if (presentation && slides.length === 0) findings.push({ severity: "error", code: "no-slides", message: "The presentation has no slides." });
  if (denseSlides) findings.push({ severity: "warn", code: "dense-slide", message: `${denseSlides} slide(s) carry more than 140 words.`, hint: "Slides are read at a glance: move detail to notes or split the slide." });
  if (tiny > 3) findings.push({ severity: "warn", code: "tiny-text", message: "Text smaller than 12 pt is used on slides.", hint: "Anything below 12 pt is unreadable when projected; shorten the text instead of shrinking it." });
  const duplicate = [...titles.entries()].filter(([, count]) => count > 1).map(([title]) => title);
  if (duplicate.length) findings.push({ severity: "info", code: "duplicate-titles", message: `Repeated slide titles: ${duplicate.slice(0, 3).map(t => `“${t.slice(0, 40)}”`).join(", ")}.`, hint: "Distinct titles let a reader follow the argument slide by slide." });
  const noTitle = slides.filter(slide => !slide.title && slide.words > 0).length;
  if (slides.length >= 3 && noTitle > slides.length / 2) findings.push({ severity: "info", code: "missing-titles", message: `${noTitle} of ${slides.length} slides have no title placeholder.`, hint: "Use the title placeholder so outline view and accessibility tools can name each slide." });
  const hits = placeholderHits(allText.join("\n"));
  if (hits.length) findings.push({ severity: "warn", code: "placeholder-text", message: `Unreplaced placeholder text on slides: ${hits.join("; ")}.`, hint: "Replace the markers with real content." });
  const text = slides.slice(0, options.maxSlides).map(slide => `## Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""}\n${slide.text}`).join("\n\n");
  return { text, words: slides.reduce((n, s) => n + s.words, 0), slides, stats: { slides: slides.length, images: slides.reduce((n, s) => n + s.images, 0), tables: slides.reduce((n, s) => n + s.tables, 0), charts: slides.reduce((n, s) => n + s.charts, 0), notes: slides.filter(s => s.notes).length, emptySlides } };
}

/* ─────────────────────────── OpenDocument ─────────────────────────── */

function readOpenDocument(zip: ZipReader, kind: "odt" | "ods" | "odp", findings: Finding[]) {
  const content = partXml(zip, "content.xml", findings);
  const blocks: string[] = [], headings: Array<{ level: number; text: string }> = [];
  const paragraphText = (node: XmlNode): string => node.children.map(child => typeof child === "string" ? child : child.name === "text:s" ? " ".repeat(Number(attr(child, "text:c") ?? 1)) : child.name === "text:tab" ? "\t" : child.name === "text:line-break" ? "\n" : paragraphText(child)).join("");
  for (const node of descendantsOf(content, "text:h", "text:p")) {
    const text = cleanText(paragraphText(node)).trim();
    if (!text) continue;
    if (node.name === "text:h") { const level = Number(attr(node, "text:outline-level") ?? 1); headings.push({ level, text: text.slice(0, 160) }); blocks.push(`${"#".repeat(Math.min(6, level))} ${text}`); } else blocks.push(text);
  }
  const tables = descendantsOf(content, "table:table").length;
  const text = blocks.join("\n\n");
  if (content && !text.trim()) findings.push({ severity: "error", code: "empty-document", message: `The ${kind.toUpperCase()} file has no text content.` });
  const hits = placeholderHits(text);
  if (hits.length) findings.push({ severity: "warn", code: "placeholder-text", message: `Unreplaced placeholder text: ${hits.join("; ")}.`, hint: "Replace the markers with real content." });
  return { text, words: words(text), headings, stats: { paragraphs: blocks.length, headings: headings.length, tables } };
}

/* ───────────────────────────── entry ───────────────────────────── */

export function readOffice(file: string, options: ReadOptions = {}): OfficeRead {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${resolved} is not a file`);
  const findings: Finding[] = [];
  const opts = { maxChars: Math.min(Math.max(options.maxChars ?? 6000, 200), 60000), maxRows: Math.min(Math.max(options.maxRows ?? 25, 1), 200), maxCols: Math.min(Math.max(options.maxCols ?? 12, 1), 40), maxSlides: Math.min(Math.max(options.maxSlides ?? 40, 1), 200), sheet: options.sheet };
  let zip: ZipReader;
  try { zip = openZip(fs.readFileSync(resolved)); }
  catch (error) {
    return { kind: officeKindForPath(resolved) ?? "docx", path: resolved, bytes: stat.size, parts: 0, meta: {}, text: "", truncated: false, words: 0, stats: {},
      findings: [{ severity: "error", code: "not-a-zip", message: String((error as Error).message).slice(0, 240), hint: "An Office file is a ZIP container. If this file came from a script, check that it wrote the whole file and did not write text or an error page instead." }] };
  }
  let kind = officeKindForPath(resolved);
  const sniffed: OfficeKind | undefined = zip.has("word/document.xml") ? "docx" : zip.has("xl/workbook.xml") ? "xlsx" : zip.has("ppt/presentation.xml") ? "pptx" : zip.has("content.xml") ? (path.extname(resolved).toLowerCase() === ".ods" ? "ods" : path.extname(resolved).toLowerCase() === ".odp" ? "odp" : "odt") : undefined;
  if (kind && sniffed && kind !== sniffed && !(kind.startsWith("od") && sniffed.startsWith("od"))) findings.push({ severity: "error", code: "extension-mismatch", message: `The file is named .${path.extname(resolved).slice(1)} but its content is a ${sniffed} package.`, hint: `Rename it to .${sniffed} or rebuild it in the format that was asked for.` });
  kind = sniffed ?? kind;
  if (!kind) return { kind: "docx", path: resolved, bytes: stat.size, parts: zip.entries.length, meta: {}, text: "", truncated: false, words: 0, stats: {}, findings: [{ severity: "error", code: "unknown-package", message: "The ZIP archive is not a recognizable Office package (no word/, xl/, ppt/ or content.xml part).", hint: "It may be a different kind of archive." }] };
  if (!zip.has("[Content_Types].xml") && !kind.startsWith("od")) findings.push({ severity: "error", code: "missing-part", message: "The package has no [Content_Types].xml.", hint: "Office refuses files without it.", where: "[Content_Types].xml" });
  for (const problem of zip.integrityProblems()) findings.push({ severity: "error", code: "damaged-entry", message: problem, hint: "The archive is corrupt or was truncated while being written; regenerate the file." });
  const base = { kind, path: resolved, bytes: stat.size, parts: zip.entries.length, meta: documentMeta(zip), findings };
  let body: { text: string; words: number; stats: Record<string, number>; headings?: OfficeRead["headings"]; tables?: OfficeRead["tables"]; sheets?: SheetRead[]; slides?: SlideRead[] };
  if (kind === "docx") body = readDocx(zip, opts, findings);
  else if (kind === "xlsx") body = readXlsx(zip, opts, findings);
  else if (kind === "pptx") body = readPptx(zip, opts, findings);
  else body = readOpenDocument(zip, kind as "odt" | "ods" | "odp", findings);
  const text = clip(body.text, opts.maxChars);
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { ...base, text, truncated: body.text.length > opts.maxChars, words: body.words, stats: body.stats, ...(body.headings ? { headings: body.headings.slice(0, 60) } : {}), ...(body.tables ? { tables: body.tables.slice(0, 12) } : {}), ...(body.sheets ? { sheets: body.sheets } : {}), ...(body.slides ? { slides: body.slides.slice(0, opts.maxSlides) } : {}) };
}
