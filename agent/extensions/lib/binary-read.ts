/** A readable view of a file the read tool would otherwise dump as garbage.
 *
 * The native read tool decodes every non-image file as UTF-8. Pointed at a PDF, a Word or Excel
 * file, a zip, a database or a video, it returns tens of kilobytes of replacement characters that
 * waste the context and leave a weaker model guessing. This module recognizes such files from their
 * first bytes and returns what a person would see when opening them: the text of a PDF (by page),
 * the structure and text of an Office file, the entries of an archive, the schema of a SQLite
 * database, the streams of an audio or video file, and for anything else a plain statement of what it
 * is and which tool looks at it. Everything is bounded and read-only. */
import fs from "node:fs";
import path from "node:path";
import { run, probe } from "./media-process.ts";
import { officeKindForPath, readOffice } from "./office-read.ts";
import { openZip } from "./office-zip.ts";

export type BinaryKind = "pdf" | "office" | "zip" | "archive" | "sqlite" | "media" | "font" | "executable" | "other";
export type BinaryView = { kind: BinaryKind; label: string; text: string; opened: boolean; facts: Record<string, unknown> };

/** True when the first bytes are not text: a NUL byte, or many control characters. UTF-16 and UTF-8 byte-order marks mean text. */
export function looksBinary(head: Buffer): boolean {
  if (!head.length) return false;
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) return false;
  let control = 0;
  for (const byte of head) { if (byte === 0) return true; if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) control++; }
  return control / head.length > 0.1;
}

const hex = (head: Buffer, count = 24) => [...head.subarray(0, count)].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
const ascii = (head: Buffer, from: number, to: number) => head.toString("latin1", from, to);

export function sniffKind(head: Buffer, file: string): { kind: BinaryKind; label: string } {
  const extension = path.extname(file).toLowerCase();
  if (ascii(head, 0, 5) === "%PDF-") return { kind: "pdf", label: "PDF document" };
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) return officeKindForPath(file) ? { kind: "office", label: `${extension.slice(1).toUpperCase()} document` } : { kind: "zip", label: "ZIP archive" };
  if (ascii(head, 0, 15) === "SQLite format 3") return { kind: "sqlite", label: "SQLite database" };
  if (head[0] === 0x1f && head[1] === 0x8b) return { kind: "archive", label: "gzip-compressed data" };
  if (ascii(head, 0, 6) === "7z\xbc\xaf\x27\x1c" || ascii(head, 0, 4) === "Rar!" || ascii(head, 257, 262) === "ustar" || (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) || (head[0] === 0xfd && ascii(head, 1, 5) === "7zXZ")) return { kind: "archive", label: "compressed archive" };
  if (ascii(head, 4, 8) === "ftyp" || (ascii(head, 0, 4) === "RIFF" && /^(?:WAVE|AVI )$/.test(ascii(head, 8, 12))) || ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || ascii(head, 0, 4) === "OggS" || ascii(head, 0, 4) === "fLaC" || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) return { kind: "media", label: "audio or video file" };
  if (ascii(head, 0, 4) === "wOFF" || ascii(head, 0, 4) === "wOF2" || ascii(head, 0, 4) === "OTTO" || (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)) return { kind: "font", label: "font file" };
  if ((head[0] === 0x7f && ascii(head, 1, 4) === "ELF") || (head[0] === 0x4d && head[1] === 0x5a) || (head[0] === 0xcf && head[1] === 0xfa)) return { kind: "executable", label: "executable program" };
  return { kind: "other", label: "binary data" };
}

async function pdfView(file: string, offset: number | undefined, maxChars: number, signal?: AbortSignal): Promise<Pick<BinaryView, "text" | "opened" | "facts">> {
  const facts: Record<string, unknown> = {};
  let pages = 0;
  try {
    const info = (await run("pdfinfo", [file], signal, 20_000)).stdout;
    pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0); facts.pages = pages || undefined;
    const title = /^Title:\s+(.+)$/m.exec(info)?.[1]?.trim(); if (title) facts.title = title;
    if (/^Encrypted:\s+yes/m.test(info)) { facts.encrypted = true; return { text: "The PDF is encrypted; its text cannot be extracted without the password.", opened: false, facts }; }
  } catch (error: any) {
    if (/not installed|ENOENT|not found/i.test(String(error?.message))) return { text: "pdftotext/pdfinfo (poppler-utils) is not installed, so the PDF text cannot be extracted here. Install poppler-utils, or render pages to images with another tool and look at them.", opened: false, facts };
    return { text: `The PDF could not be opened (${String(error?.message ?? error).slice(0, 160)}); it may be damaged or truncated. deliverable_check reports the exact problem.`, opened: false, facts };
  }
  const first = Math.min(Math.max(Math.floor(offset ?? 1), 1), Math.max(pages, 1));
  const last = Math.min(first + 24, pages || first + 24);
  let raw = "";
  try { raw = (await run("pdftotext", ["-layout", "-f", String(first), "-l", String(last), file, "-"], signal, 45_000)).stdout; }
  catch (error: any) { return { text: `Text extraction failed (${String(error?.message ?? error).slice(0, 160)}).`, opened: false, facts }; }
  const chunks = raw.split("\f"); if (chunks.length && !chunks[chunks.length - 1].trim()) chunks.pop();
  let out = "", shown = 0;
  for (const [index, chunk] of chunks.entries()) {
    const body = chunk.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
    const block = `--- page ${first + index} ---\n${body}\n\n`;
    if (shown > 0 && out.length + block.length > maxChars) break;
    out += block.length > maxChars ? `${block.slice(0, maxChars)}\n[page text cut at ${maxChars} characters]\n\n` : block; shown++;
  }
  const lastShown = first + shown - 1;
  facts.shownPages = shown ? `${first}-${lastShown}` : undefined;
  const letters = raw.replace(/\s/g, "").length;
  if (letters < 20 * Math.max(shown, 1)) {
    facts.textLayer = false;
    return { text: `${out}No text layer found on these pages: the PDF is probably scanned images. Render pages to PNG (pdftoppm -png -r 80 -f ${first} -l ${last} file.pdf out) and look at them with render_see, or run OCR (tesseract) if it is installed.`, opened: true, facts };
  }
  const more = pages && lastShown < pages ? `[Pages ${first}-${lastShown} of ${pages} shown. Use offset=${lastShown + 1} to continue from page ${lastShown + 1}.]` : pages ? `[All ${pages} pages shown.]` : "";
  return { text: `${out.trimEnd()}\n\n${more}`.trimEnd(), opened: true, facts };
}

async function sqliteView(file: string, signal?: AbortSignal): Promise<Pick<BinaryView, "text" | "opened" | "facts">> {
  try {
    const schema = (await run("sqlite3", ["-readonly", "-batch", file, ".schema"], signal, 15_000)).stdout.trim();
    return { text: `Schema:\n${schema.slice(0, 6000)}${schema.length > 6000 ? "\n[schema cut]" : ""}\n\nQuery it with sqlite_probe (tables, schema, describe, query; read-only) rather than shell snippets.`, opened: true, facts: { schemaChars: schema.length } };
  } catch { return { text: `Use sqlite_probe (tables, schema, describe, query; read-only) to inspect it; the sqlite3 command was not usable here.`, opened: false, facts: {} }; }
}

async function mediaView(file: string, signal?: AbortSignal): Promise<Pick<BinaryView, "text" | "opened" | "facts">> {
  try {
    const info = await probe(file, signal), format = info.format ?? {};
    const streams = (info.streams ?? []).map((stream: any) => stream.codec_type === "video" ? `video ${stream.codec_name} ${stream.width}x${stream.height}${stream.pix_fmt ? ` ${stream.pix_fmt}` : ""}` : stream.codec_type === "audio" ? `audio ${stream.codec_name}${stream.sample_rate ? ` ${stream.sample_rate} Hz` : ""}${stream.channels ? ` ${stream.channels} ch` : ""}` : `${stream.codec_type} ${stream.codec_name ?? ""}`.trim());
    const duration = Number(format.duration);
    return { text: `Container ${format.format_name ?? "unknown"}${Number.isFinite(duration) ? `, ${duration.toFixed(2)} s` : ""}. Streams: ${streams.join("; ") || "none"}.\nLook at it with media_info, audio_analyze, video_frames or deliverable_check; the bytes themselves are not readable.`, opened: true, facts: { duration: Number.isFinite(duration) ? duration : undefined, streams: streams.length } };
  } catch { return { text: "ffprobe could not read it (missing, or the file is damaged). deliverable_check reports what is wrong; audio_analyze, video_frames and media_info look at working files.", opened: false, facts: {} }; }
}

function zipView(file: string): Pick<BinaryView, "text" | "opened" | "facts"> {
  try {
    const entries = openZip(fs.readFileSync(file)).entries.filter(entry => !entry.directory);
    const rows = entries.slice(0, 60).map(entry => `${entry.name} (${size(entry.size)})`);
    return { text: `${entries.length} files:\n${rows.join("\n")}${entries.length > rows.length ? `\n… ${entries.length - rows.length} more` : ""}\narchive_probe lists, stats and reads one member without extracting. To extract, use a new folder (unzip -d <new folder> file.zip), never the folder it came from.`, opened: true, facts: { entries: entries.length } };
  } catch (error: any) { return { text: `Not a readable ZIP (${String(error?.message ?? error).slice(0, 140)}).`, opened: false, facts: {} }; }
}

export async function describeBinary(file: string, options: { offset?: number; maxChars?: number; signal?: AbortSignal; head?: Buffer } = {}): Promise<BinaryView> {
  const stat = fs.statSync(file);
  const head = options.head ?? (() => { const fd = fs.openSync(file, "r"); try { const buffer = Buffer.alloc(Math.min(8192, stat.size)); fs.readSync(fd, buffer, 0, buffer.length, 0); return buffer; } finally { fs.closeSync(fd); } })();
  const { kind, label } = sniffKind(head, file);
  const maxChars = Math.min(Math.max(options.maxChars ?? 18000, 2000), 40000);
  let part: Pick<BinaryView, "text" | "opened" | "facts">;
  if (kind === "pdf") part = await pdfView(file, options.offset, maxChars, options.signal);
  else if (kind === "office") {
    try {
      const read = readOffice(file, { maxChars: Math.min(maxChars, 20000) });
      const errors = read.findings.filter(finding => finding.severity === "error").slice(0, 3).map(finding => `- ${finding.message}`);
      part = { text: `${read.text}${read.truncated ? "\n[Text cut. office_doc read with maxChars (up to 60000) or sheet shows more.]" : ""}${errors.length ? `\n\nProblems found while opening it:\n${errors.join("\n")}` : ""}\n\nFor structure, formulas, slide notes and every finding use office_doc read or verify.`, opened: true, facts: { words: read.words, findings: read.findings.length } };
    } catch (error: any) { part = { text: `Could not open it as a document (${String(error?.message ?? error).slice(0, 160)}). deliverable_check reports what is wrong with it.`, opened: false, facts: {} }; }
  }
  else if (kind === "zip") part = zipView(file);
  else if (kind === "sqlite") part = await sqliteView(file, options.signal);
  else if (kind === "media") part = await mediaView(file, options.signal);
  else {
    const extra = kind === "archive" ? "archive_probe lists ZIP and TAR (also gzip, bzip2, xz) without extracting; for 7z and RAR use 7z l. Extract into a new folder." : kind === "font" ? "Use fc-scan or fonts tooling to inspect glyphs and metrics." : kind === "executable" ? "Inspect with file, ldd or strings through bash if that is really needed." : "Use file, xxd -l 256 or strings through bash if the bytes matter.";
    part = { text: `${extra}\nFirst bytes: ${hex(head)}`, opened: false, facts: {} };
  }
  return { kind, label, text: `[read: ${label}, not text] ${path.basename(file)} (${size(stat.size)})\nThe file is binary, so it is shown as what it contains instead of raw bytes.\n\n${part.text}`, opened: part.opened, facts: { kind, label, bytes: stat.size, ...part.facts } };
}
