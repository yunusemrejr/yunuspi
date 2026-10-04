/** Open a produced file and say whether it is what it claims to be.
 *
 * Models routinely stop at "the script printed Saved report.docx": the file may be a zero-byte
 * stub, an HTML error page with a .pdf name, a video in a pixel format most players reject, a
 * workbook whose formulas were never calculated, or a document still full of template markers.
 * Each inspector reads the file itself (headers, structure, a bounded decode) and returns
 * findings in the same shape as the Office reader, so one verdict covers any deliverable.
 * Inspection is read-only, bounded in bytes and time, and never executes the file. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readOffice, officeKindForPath, placeholderHits, type Finding } from "./office-read.ts";
import { openZip } from "./office-zip.ts";
import { parseXml, XmlError, descendantsOf } from "./xml-lite.ts";
import { INPUT_FLAGS } from "./media-process.ts";
import { checkSourceText, sourceCheckSupported } from "./source-check.ts";

const execFileAsync = promisify(execFile);
export type Inspection = { path: string; kind: string; bytes: number; status: "pass" | "warn" | "fail"; findings: Finding[]; facts: Record<string, unknown> };

const EXT_KIND: Array<[RegExp, string]> = [
  [/\.pdf$/i, "pdf"], [/\.(?:png|jpe?g|gif|webp|bmp)$/i, "image"], [/\.svg$/i, "svg"],
  [/\.(?:wav|mp3|flac|m4a|aac|ogg|opus|aiff?)$/i, "audio"], [/\.(?:mp4|m4v|mov|webm|mkv|avi)$/i, "video"],
  [/\.(?:csv|tsv)$/i, "table"], [/\.(?:json|ya?ml|toml)$/i, "data"], [/\.html?$/i, "html"], [/\.(?:md|markdown|txt|rst)$/i, "text"], [/\.(?:zip|jar|epub)$/i, "zip"],
];
export const DELIVERABLE_AUTO_EXTENSIONS = /\.(?:docx|xlsx|pptx|odt|ods|odp|pdf|mp4|m4v|mov|webm|mkv|avi|wav|mp3|flac|m4a|ogg|opus)$/i;

const note = (findings: Finding[], severity: Finding["severity"], code: string, message: string, hint?: string) => { findings.push({ severity, code, message, ...(hint ? { hint } : {}) }); };
const readHead = (file: string, length: number, position = 0): Buffer => {
  const fd = fs.openSync(file, "r");
  try { const buffer = Buffer.alloc(length); const read = fs.readSync(fd, buffer, 0, length, position); return buffer.subarray(0, read); } finally { fs.closeSync(fd); }
};
const readTail = (file: string, length: number, size: number): Buffer => readHead(file, Math.min(length, size), Math.max(0, size - length));
const positionToLineColumn = (text: string, position: number) => { const before = text.slice(0, position); return { line: before.split("\n").length, column: position - before.lastIndexOf("\n") }; };

/* ───── images ───── */
function imageFacts(file: string, size: number, findings: Finding[]): Record<string, unknown> {
  const head = readHead(file, 64 * 1024), tail = readTail(file, 64, size);
  const facts: Record<string, unknown> = {};
  let format = "", width = 0, height = 0;
  if (head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    format = "png"; width = head.readUInt32BE(16); height = head.readUInt32BE(20);
    if (!tail.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))) note(findings, "error", "truncated-image", "The PNG has no end chunk, so it was cut off while being written.", "Re-run the step that wrote it and check the file size afterwards.");
  } else if (head.length > 3 && head[0] === 0xff && head[1] === 0xd8) {
    format = "jpeg";
    for (let at = 2; at + 9 < head.length;) {
      if (head[at] !== 0xff) { at++; continue; }
      const marker = head[at + 1];
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) { height = head.readUInt16BE(at + 5); width = head.readUInt16BE(at + 7); break; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
      at += 2 + head.readUInt16BE(at + 2);
    }
    if (!tail.includes(Buffer.from([0xff, 0xd9]))) note(findings, "error", "truncated-image", "The JPEG has no end-of-image marker, so it was cut off while being written.");
  } else if (head.length > 10 && head.toString("latin1", 0, 3) === "GIF") {
    format = "gif"; width = head.readUInt16LE(6); height = head.readUInt16LE(8);
    if (tail[tail.length - 1] !== 0x3b) note(findings, "error", "truncated-image", "The GIF has no trailer byte, so it was cut off while being written.");
  } else if (head.length > 30 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    format = "webp"; const chunk = head.toString("latin1", 12, 16);
    if (chunk === "VP8X") { width = 1 + head.readUIntLE(24, 3); height = 1 + head.readUIntLE(27, 3); }
    else if (chunk === "VP8 ") { width = head.readUInt16LE(26) & 0x3fff; height = head.readUInt16LE(28) & 0x3fff; }
    else if (chunk === "VP8L") { const bits = head.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
  } else if (head.length > 26 && head.toString("latin1", 0, 2) === "BM") { format = "bmp"; width = head.readInt32LE(18); height = Math.abs(head.readInt32LE(22)); }
  else {
    const text = head.toString("utf8", 0, 200).trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html")) note(findings, "error", "not-an-image", "The file is an HTML page with an image name (typically a failed download or an error response).", "Fetch the real image URL and check the content type before saving.");
    else note(findings, "error", "not-an-image", "The bytes are not a PNG, JPEG, GIF, WebP or BMP image.", "The writer may have saved text, base64 or an error message instead of image data.");
    return facts;
  }
  facts.format = format; if (width && height) { facts.width = width; facts.height = height; }
  const claimed = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
  if (claimed && format && claimed !== format && !(claimed === "bmp" && format === "bmp")) note(findings, "warn", "extension-mismatch", `The file is named .${path.extname(file).slice(1)} but contains ${format.toUpperCase()} data.`, "Some consumers pick the decoder from the extension; save with the matching extension.");
  if (width && height && (width < 8 || height < 8)) note(findings, "error", "degenerate-image", `The image is only ${width}×${height} pixels.`, "A real render is far larger; the producing step likely failed silently.");
  else if (width && height && (width < 64 || height < 64)) note(findings, "warn", "tiny-image", `The image is only ${width}×${height} pixels.`);
  if (size > 25 * 1024 * 1024) note(findings, "info", "large-file", `The image is ${(size / 1048576).toFixed(1)} MiB; consider compressing it for delivery.`);
  note(findings, "info", "visual-check", "Header and structure check only: open the image (read or render_see) to judge content, cropping and legibility.");
  return facts;
}

/* ───── svg ───── */
function svgFacts(file: string, findings: Finding[]): Record<string, unknown> {
  const text = fs.readFileSync(file, "utf8");
  try {
    const root = parseXml(text);
    if (root.name !== "svg") { note(findings, "error", "not-svg", `The root element is <${root.name}>, not <svg>.`); return {}; }
    const facts: Record<string, unknown> = { viewBox: root.attrs.viewBox, width: root.attrs.width, height: root.attrs.height };
    if (!root.attrs.viewBox && !(root.attrs.width && root.attrs.height)) note(findings, "warn", "no-viewbox", "The SVG has no viewBox and no explicit width/height, so it may render at an unpredictable size.", "Add a viewBox so it scales.");
    if (!descendantsOf(root, "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image", "use").length) note(findings, "error", "empty-svg", "The SVG draws nothing (no shapes, text or images).");
    if (descendantsOf(root, "script").length) note(findings, "warn", "svg-script", "The SVG contains a <script>, which is blocked or unsafe when the file is embedded.");
    if (/\b(?:xlink:)?href\s*=\s*["']https?:/i.test(text)) note(findings, "info", "external-reference", "The SVG references an external URL; it will not render offline.");
    note(findings, "info", "visual-check", "Use svg_inspect for geometry and a render matrix; this check only confirms valid structure.");
    return facts;
  } catch (error) {
    note(findings, "error", "xml-malformed", `The SVG is not well-formed XML: ${error instanceof XmlError ? error.message : String((error as Error).message)}`.slice(0, 220));
    return {};
  }
}

/* ───── data ───── */
export function parseDelimited(text: string, delimiter: string, maxRows = 100_000): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch; continue; }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; rows.push(row); row = []; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function tableFacts(file: string, size: number, findings: Finding[]): Record<string, unknown> {
  const raw = readHead(file, Math.min(size, 5 * 1024 * 1024)).toString("utf8");
  const text = raw.replace(/^﻿/, "");
  if (!text.trim()) { note(findings, "error", "empty-file", "The table file has no content."); return {}; }
  const sample = text.split(/\r?\n/).slice(0, 20).filter(Boolean);
  const best = [",", ";", "\t", "|"].map(d => ({ d, score: sample.reduce((n, line) => n + (line.split(d).length > 1 ? 1 : 0), 0), width: sample[0]?.split(d).length ?? 1 })).sort((a, b) => b.score - a.score || b.width - a.width)[0];
  const delimiter = path.extname(file).toLowerCase() === ".tsv" ? "\t" : best.d;
  let rows = parseDelimited(text, delimiter);
  while (rows.length && rows[rows.length - 1].every(cell => cell === "")) rows.pop();
  const widths = new Map<number, number>(); for (const row of rows) widths.set(row.length, (widths.get(row.length) ?? 0) + 1);
  const columns = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  const ragged = rows.filter(row => row.length !== columns).length;
  const header = rows[0] ?? [], emptyHeaders = header.filter(cell => !cell.trim()).length;
  const names = header.map(cell => cell.trim().toLowerCase()).filter(Boolean), duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (rows.length < 2) note(findings, "warn", "no-data-rows", `The table has ${rows.length} row(s): a header and no data.`);
  if (ragged) note(findings, "warn", "ragged-rows", `${ragged} of ${rows.length} rows do not have ${columns} columns.`, "Unquoted delimiters or newlines inside values are the usual cause; quote such fields.");
  if (emptyHeaders) note(findings, "warn", "empty-header", `${emptyHeaders} column header(s) are empty.`);
  if (duplicates.length) note(findings, "warn", "duplicate-header", `Duplicate column names: ${[...new Set(duplicates)].slice(0, 4).join(", ")}.`);
  if (text.includes("\ufffd")) note(findings, "warn", "encoding", "The file contains replacement characters; its text was probably not UTF-8 when it was written.");
  const hits = placeholderHits(text); if (hits.length) note(findings, "warn", "placeholder-text", `Unreplaced placeholder text: ${hits.join("; ")}.`);
  return { rows: rows.length, columns, delimiter: delimiter === "\t" ? "tab" : delimiter, header: header.slice(0, 12).map(cell => cell.slice(0, 40)), ...(size > 5 * 1024 * 1024 ? { sampledBytes: 5 * 1024 * 1024 } : {}) };
}
async function dataFacts(file: string, size: number, cwd: string, findings: Finding[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (size > 20 * 1024 * 1024) { note(findings, "info", "large-file", "Too large to parse in full; only its size was checked."); return {}; }
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) { note(findings, "error", "empty-file", "The file has no content."); return {}; }
  const facts: Record<string, unknown> = {};
  if (/\.json$/i.test(file)) {
    try { const value = JSON.parse(text); facts.type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value; facts.size = Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : undefined; if (Array.isArray(value) && value.length === 0 || value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) note(findings, "warn", "empty-json", "The JSON is valid but empty."); }
    catch (error) {
      const message = String((error as Error).message), at = /position (\d+)/.exec(message)?.[1];
      const where = at && !/\bline \d+/.test(message) ? positionToLineColumn(text, Number(at)) : undefined;
      note(findings, "error", "invalid-json", `${message.slice(0, 160)}${where ? ` (line ${where.line}, column ${where.column})` : ""}`, "Common causes: trailing commas, comments, single quotes, or text before/after the JSON.");
    }
  } else {
    const outcome = await checkSourceText(path.basename(file), text, cwd, signal);
    if (outcome.status === "error") for (const line of (outcome.diagnostics ?? []).slice(0, 4)) note(findings, "error", "syntax-error", String(line).slice(0, 220));
    else if (outcome.status === "unavailable") note(findings, "info", "no-checker", "No parser is available for this data format here; it was not validated.");
  }
  const hits = placeholderHits(text.slice(0, 200_000)); if (hits.length) note(findings, "warn", "placeholder-text", `Unreplaced placeholder text: ${hits.join("; ")}.`);
  return facts;
}

/* ───── html / text ───── */
function localReferences(file: string, text: string, pattern: RegExp, findings: Finding[], label: string) {
  const missing: string[] = []; let checked = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? "").trim();
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/|\{\{|\$\{)/i.test(raw)) continue;
    let target = raw.split("#")[0].split("?")[0];
    if (!target) continue;
    try { target = decodeURIComponent(target); } catch { /* keep raw */ }
    if (++checked > 300) break;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) missing.push(raw.slice(0, 80));
  }
  if (missing.length) note(findings, "error", "broken-reference", `${missing.length} local ${label} point at files that do not exist: ${[...new Set(missing)].slice(0, 5).join(", ")}.`, "Fix the path or copy the file next to the page; the reader will see a broken link.");
}
function htmlFacts(file: string, size: number, findings: Finding[]): Record<string, unknown> {
  if (size === 0) { note(findings, "error", "empty-file", "The HTML file is empty."); return {}; }
  const text = readHead(file, Math.min(size, 4 * 1024 * 1024)).toString("utf8");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
  if (!/<html[\s>]/i.test(text) && !/<body[\s>]/i.test(text) && !/<!doctype/i.test(text)) note(findings, "warn", "not-a-page", "The file has no <html>, <body> or doctype: it is a fragment, not a page.");
  if (!title) note(findings, "info", "no-title", "The page has no <title>.");
  if (!/name=["']viewport["']/i.test(text)) note(findings, "info", "no-viewport", "No viewport meta tag: phones will render the page at desktop width.");
  localReferences(file, text, /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi, findings, "references");
  const hits = placeholderHits(text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")); if (hits.length) note(findings, "warn", "placeholder-text", `Unreplaced placeholder text: ${hits.join("; ")}.`);
  note(findings, "info", "visual-check", "Use render_see or browser_session to look at the rendered page; this check covers structure and links only.");
  return { title, bytes: size };
}
function textFacts(file: string, size: number, findings: Finding[]): Record<string, unknown> {
  if (size === 0) { note(findings, "error", "empty-file", "The file is empty."); return {}; }
  const text = readHead(file, Math.min(size, 4 * 1024 * 1024)).toString("utf8");
  if (text.includes("\ufffd")) note(findings, "warn", "encoding", "The file contains replacement characters; it is probably not valid UTF-8.");
  if (/\.(?:md|markdown)$/i.test(file)) {
    if (((text.match(/^\s*(?:```|~~~)/gm) ?? []).length) % 2) note(findings, "warn", "unclosed-fence", "A code fence is opened and never closed, so everything after it renders as code.");
    localReferences(file, text.replace(/```[\s\S]*?```/g, ""), /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)\)/g, findings, "links");
  }
  const hits = placeholderHits(text); if (hits.length) note(findings, "warn", "placeholder-text", `Unreplaced placeholder text: ${hits.join("; ")}.`);
  return { characters: text.length, lines: text.split("\n").length };
}

/* ───── zip ───── */
function zipFacts(file: string, findings: Finding[]): Record<string, unknown> {
  try {
    const zip = openZip(fs.readFileSync(file));
    for (const problem of zip.integrityProblems()) note(findings, "error", "damaged-entry", problem);
    const junk = zip.entries.filter(entry => /(?:^|\/)(?:__MACOSX|\.DS_Store|node_modules|\.git)(?:\/|$)/.test(entry.name)).length;
    if (junk) note(findings, "info", "archive-junk", `${junk} entries are build or OS leftovers (node_modules, .git, __MACOSX, .DS_Store).`, "Exclude them when building a deliverable archive.");
    if (!zip.entries.some(entry => !entry.directory)) note(findings, "error", "empty-archive", "The archive contains no files.");
    return { entries: zip.entries.length, uncompressedBytes: zip.entries.reduce((n, entry) => n + entry.size, 0), top: [...new Set(zip.entries.map(entry => entry.name.split("/")[0]))].slice(0, 10) };
  } catch (error) { note(findings, "error", "not-a-zip", String((error as Error).message).slice(0, 200)); return {}; }
}

/* ───── pdf ───── */
async function pdfFacts(file: string, size: number, findings: Finding[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const head = readHead(file, 1024).toString("latin1"), tail = readTail(file, 2048, size).toString("latin1");
  if (!head.startsWith("%PDF-")) {
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(head);
    note(findings, "error", "not-a-pdf", looksHtml ? "The file is an HTML page saved with a .pdf name (usually a failed download or error page)." : "The file does not start with %PDF-.", "Regenerate the PDF or fetch the real file.");
    return {};
  }
  if (!tail.includes("%%EOF")) note(findings, "error", "truncated-pdf", "The PDF has no %%EOF trailer, so it was cut off while being written.");
  const facts: Record<string, unknown> = { version: head.slice(5, 8) };
  let pages: number | undefined;
  const tool = async (binary: string, args: string[]) => { try { return (await execFileAsync(binary, args, { timeout: 20000, signal, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" })).stdout; } catch { return undefined; } };
  const info = await tool("pdfinfo", [file]);
  if (info) {
    pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]); facts.pages = pages;
    const pageSize = /^Page size:\s+(.+)$/m.exec(info)?.[1]; if (pageSize) facts.pageSize = pageSize.trim();
    if (/^Encrypted:\s+yes/m.test(info)) note(findings, "info", "encrypted", "The PDF is encrypted; text extraction may be limited.");
  } else {
    const body = fs.readFileSync(file, { encoding: "latin1" }).slice(0, 8 * 1024 * 1024);
    pages = (body.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || undefined; if (pages) facts.pagesApprox = pages;
  }
  if (pages === 0) note(findings, "error", "no-pages", "The PDF declares zero pages.");
  const text = await tool("pdftotext", ["-l", "5", "-layout", file, "-"]);
  if (text !== undefined) {
    facts.textCharsFirstPages = text.replace(/\s+/g, "").length;
    if (pages && pages > 0 && text.replace(/\s+/g, "").length === 0) note(findings, "warn", "no-text-layer", "The first pages have no extractable text (scanned images, or text converted to outlines).", "Fine for scans; if text was expected, the generator dropped it or used an unembedded font.");
    const hits = placeholderHits(text); if (hits.length) note(findings, "warn", "placeholder-text", `Unreplaced placeholder text: ${hits.join("; ")}.`);
  } else if (!info) note(findings, "info", "no-poppler", "pdfinfo/pdftotext are not installed, so only the file structure was checked.");
  note(findings, "info", "visual-check", "Render pages to images (pdftoppm, then render_see or read) to judge layout; this check covers structure and text only.");
  return facts;
}

/* ───── audio / video ───── */
function mp4TopLevelOrder(file: string, size: number): string[] {
  const order: string[] = []; let at = 0; const fd = fs.openSync(file, "r");
  try {
    for (let guard = 0; guard < 64 && at + 8 <= size; guard++) {
      const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, at);
      let boxSize = header.readUInt32BE(0); const type = header.toString("latin1", 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      order.push(type);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8)); else if (boxSize === 0) boxSize = size - at;
      if (boxSize < 8) break;
      at += boxSize;
    }
  } finally { fs.closeSync(fd); }
  return order;
}
async function mediaFacts(file: string, size: number, kind: "audio" | "video", findings: Finding[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  let info: any;
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", ...INPUT_FLAGS, "-show_entries", "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,duration,disposition", "-of", "json", file], { timeout: 30000, signal, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    info = JSON.parse(stdout);
  } catch (error: any) {
    if (error?.code === "ENOENT") { note(findings, "info", "no-ffprobe", "ffprobe is not installed, so the media could not be probed or decoded."); return {}; }
    note(findings, "error", "unreadable-media", `ffprobe cannot read the file: ${String(error?.stderr || error?.message).split("\n").find(Boolean)?.slice(0, 200) ?? "unknown error"}`, "The file is truncated, still being written, or not media; for MP4 a missing moov atom is the usual cause.");
    return {};
  }
  const duration = Number(info.format?.duration), streams: any[] = info.streams ?? [];
  const video = streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic), audio = streams.find(s => s.codec_type === "audio");
  const facts: Record<string, unknown> = { format: info.format?.format_name, durationSeconds: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : undefined };
  if (kind === "video" && !video) note(findings, "error", "no-video-stream", "A video file was expected but it has no video stream.");
  if (kind === "audio" && !audio) note(findings, "error", "no-audio-stream", "An audio file was expected but it has no audio stream.");
  if (!Number.isFinite(duration) || duration <= 0) note(findings, "error", "no-duration", "The media reports no duration.", "A zero-length or unfinalized file; re-run the encoder to completion.");
  else if (duration < 0.5) note(findings, "warn", "very-short", `The media is only ${duration.toFixed(2)} s long.`);
  if (video) {
    facts.video = { codec: video.codec_name, width: video.width, height: video.height, pixFmt: video.pix_fmt, fps: video.avg_frame_rate };
    if (video.codec_name === "h264" && video.pix_fmt && !/^(?:yuvj?420p)$/.test(video.pix_fmt)) note(findings, "warn", "pixel-format", `The video uses pixel format ${video.pix_fmt}; QuickTime, many browsers and phones only play yuv420p.`, "Re-encode with -pix_fmt yuv420p (RGB sources default to yuv444p).");
    if (video.width % 2 || video.height % 2) note(findings, "warn", "odd-dimensions", `The video is ${video.width}×${video.height}; odd dimensions are rejected by many encoders and players.`);
    if (/\.(?:mp4|m4v|mov)$/i.test(file)) {
      const order = mp4TopLevelOrder(file, size);
      if (order.includes("mdat") && order.includes("moov") && order.indexOf("moov") > order.indexOf("mdat")) note(findings, "info", "not-faststart", "The metadata (moov) comes after the media data, so web playback cannot start until the whole file is downloaded.", "Add -movflags +faststart when the video is for the web.");
    }
  }
  if (audio) facts.audio = { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels };
  const videoDuration = Number(video?.duration), audioDuration = Number(audio?.duration);
  if (video && audio && Number.isFinite(videoDuration) && Number.isFinite(audioDuration) && Math.abs(videoDuration - audioDuration) > 0.75) note(findings, "warn", "av-duration-mismatch", `Video runs ${videoDuration.toFixed(1)} s but audio runs ${audioDuration.toFixed(1)} s.`, "The narration or music ends before (or after) the picture; trim or pad one stream.");
  const decode = async (label: string, args: string[]) => {
    try { await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-xerror", ...args, "-f", "null", "-"], { timeout: 60000, signal, maxBuffer: 1024 * 1024, encoding: "utf8" }); return true; }
    catch (error: any) { if (error?.code === "ENOENT") return true; note(findings, "error", "decode-failure", `Decoding ${label} failed: ${String(error?.stderr || error?.message).split("\n").find(Boolean)?.slice(0, 200) ?? "error"}`, "The stream is corrupt or truncated; re-render it."); return false; }
  };
  if (Number.isFinite(duration) && duration > 0) {
    if (await decode("the first 30 seconds", [...INPUT_FLAGS, "-i", file, "-t", "30"]) && duration > 45) await decode("the last 10 seconds", [...INPUT_FLAGS, "-sseof", "-10", "-i", file]);
    if (audio) {
      try {
        const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "info", ...INPUT_FLAGS, "-i", file, "-t", "60", "-vn", "-af", "volumedetect", "-f", "null", "-"], { timeout: 60000, signal, maxBuffer: 1024 * 1024, encoding: "utf8" });
        const mean = Number(/mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1]), peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1]);
        if (Number.isFinite(mean)) { (facts.audio as any).meanVolumeDb = mean; (facts.audio as any).peakDb = peak; }
        if (/mean_volume:\s*-inf/.test(stderr) || (Number.isFinite(mean) && mean < -70)) note(findings, "error", "silent-audio", "The audio track is silent in its first minute.", "The narration or music was not mixed in (a missing input, a zero volume, or a muted channel).");
        else if (Number.isFinite(peak) && peak >= -0.1) note(findings, "warn", "clipping", `The audio peaks at ${peak} dB (digital full scale): it is probably clipping.`, "Lower the gain or add a limiter; check with audio_analyze.");
      } catch { /* a missing ffmpeg was already reported through decode */ }
    }
  }
  note(findings, "info", "playback-check", kind === "video" ? "Decode and metadata only: sample frames (video_frames) and listen for sync and pacing; neither can be judged from metadata." : "Decode and level check only: listening is the only judge of audible quality.");
  return facts;
}

/* ───── entry ───── */
export async function inspectDeliverable(file: string, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<Inspection> {
  const resolved = path.resolve(file), findings: Finding[] = [];
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); } catch { return { path: resolved, kind: "missing", bytes: 0, status: "fail", findings: [{ severity: "error", code: "missing-file", message: "The file does not exist.", hint: "The producing step did not write it, or it wrote it somewhere else; search for the real path." }], facts: {} }; }
  if (!stat.isFile()) return { path: resolved, kind: "directory", bytes: 0, status: "fail", findings: [{ severity: "error", code: "not-a-file", message: "The path is a directory, not a file." }], facts: {} };
  const size = stat.size, cwd = options.cwd ?? path.dirname(resolved);
  let kind = officeKindForPath(resolved) ? "office" : EXT_KIND.find(([pattern]) => pattern.test(resolved))?.[1] ?? "unknown";
  let facts: Record<string, unknown> = {};
  if (size === 0) note(findings, "error", "empty-file", "The file is zero bytes: the writer opened it and wrote nothing.", "Re-run the step that produces it and check for an error earlier in its output.");
  else if (kind === "office") {
    const read = readOffice(resolved, { maxChars: 400 });
    kind = read.kind; findings.push(...read.findings);
    facts = { ...read.meta, ...read.stats, words: read.words, parts: read.parts };
  }
  else if (kind === "image") facts = imageFacts(resolved, size, findings);
  else if (kind === "svg") facts = svgFacts(resolved, findings);
  else if (kind === "pdf") facts = await pdfFacts(resolved, size, findings, options.signal);
  else if (kind === "audio" || kind === "video") facts = await mediaFacts(resolved, size, kind, findings, options.signal);
  else if (kind === "table") facts = tableFacts(resolved, size, findings);
  else if (kind === "data") facts = await dataFacts(resolved, size, cwd, findings, options.signal);
  else if (kind === "html") facts = htmlFacts(resolved, size, findings);
  else if (kind === "text") facts = textFacts(resolved, size, findings);
  else if (kind === "zip") facts = zipFacts(resolved, findings);
  else if (sourceCheckSupported(resolved)) { kind = "source"; const outcome = await checkSourceText(path.basename(resolved), fs.readFileSync(resolved, "utf8"), cwd, options.signal); if (outcome.status === "error") for (const line of (outcome.diagnostics ?? []).slice(0, 4)) note(findings, "error", "syntax-error", String(line).slice(0, 220)); else if (outcome.status === "unavailable") note(findings, "info", "no-checker", "No syntax checker is available for this language here."); }
  else note(findings, "info", "no-inspector", "No inspector exists for this file type; only existence and size were checked.", "Open it with the program that is meant to consume it.");
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const status = findings.some(f => f.severity === "error") ? "fail" : findings.some(f => f.severity === "warn") ? "warn" : "pass";
  return { path: resolved, kind, bytes: size, status, findings, facts: Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) };
}
