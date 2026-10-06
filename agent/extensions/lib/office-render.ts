/** Render an Office file to PDF and PNG pages with a locally installed LibreOffice.
 *
 * Structure checks cannot tell whether a table overflows its page or an image sits on text,
 * so judging layout needs pixels. This step is optional: without LibreOffice it reports
 * that plainly and nothing else in the Office tools depends on it. A snap-packaged
 * LibreOffice can only read and write below the user's home folder (no /tmp), so inputs are
 * staged in a visible directory there and removed afterwards. The conversion runs in its own
 * process group with a private profile, a deadline and a memory ceiling. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGuarded } from "./guarded-process.ts";
import { memoryBudgetMb } from "./memory-guard.ts";

const execFileAsync = promisify(execFile);
const CANDIDATES = ["soffice", "libreoffice"];
const FIXED = ["/snap/bin/libreoffice", "/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];

export function findOfficeSuite(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of CANDIDATES) for (const dir of dirs) { const file = path.join(dir, name); try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ } }
  for (const file of FIXED) { try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ } }
  return undefined;
}
const isSnap = (binary: string): boolean => { try { return fs.realpathSync(binary).startsWith("/snap/") || binary.startsWith("/snap/"); } catch { return binary.startsWith("/snap/"); } };

export type RenderResult = { pdf: string; pageCount?: number; pngs: string[]; engine: string; notes: string[] };

/** Run one LibreOffice conversion of a staged copy; the caller reads `staging` and calls `cleanup`. */
async function convertStaged(file: string, filter: string, options: { signal?: AbortSignal; binary?: string; stagingRoot?: string }): Promise<{ staging: string; engine: string; cleanup: () => void }> {
  const binary = options.binary ?? findOfficeSuite();
  if (!binary) throw new Error("No office suite is installed (LibreOffice: soffice or libreoffice), so rendering and conversion are not possible. Reading and verifying docx, xlsx, pptx and OpenDocument still work; install LibreOffice to render pages, convert files or read legacy doc, xls and ppt files.");
  const staging = fs.mkdtempSync(path.join(options.stagingRoot ?? (isSnap(binary) ? os.homedir() : os.tmpdir()), "yunuspi-render-"));
  const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });
  try {
    const extension = path.extname(file).toLowerCase() || ".docx", staged = path.join(staging, `input${extension}`);
    fs.copyFileSync(file, staged);
    await runGuarded(binary, ["--headless", "--norestore", "--nologo", `-env:UserInstallation=file://${path.join(staging, "profile")}`, "--convert-to", filter, "--outdir", staging, staged],
      // Office startup and conversion share the host-aware media budget.
      // Small Calc workbooks can exceed 2.5GB with some suite builds; cap at 4GB.
      { cwd: staging, signal: options.signal, timeoutMs: 150_000, guard: false, memoryMb: Math.min(4096, memoryBudgetMb()) });
    return { staging, engine: path.basename(binary), cleanup };
  } catch (error) { cleanup(); throw error; }
}

export async function renderOffice(file: string, outDir: string, options: { pages?: number; dpi?: number; signal?: AbortSignal; binary?: string; stagingRoot?: string } = {}): Promise<RenderResult> {
  const pages = Math.min(Math.max(Math.round(options.pages ?? 3), 0), 8), dpi = Math.min(Math.max(Math.round(options.dpi ?? 70), 40), 150);
  const notes: string[] = [];
  const run = await convertStaged(file, "pdf", options);
  try {
    const produced = path.join(run.staging, "input.pdf");
    if (!fs.existsSync(produced) || fs.statSync(produced).size === 0) throw new Error("LibreOffice finished without producing a PDF (the file may be damaged or password-protected)");
    const pdf = path.join(outDir, `${path.basename(file, path.extname(file))}.pdf`);
    fs.copyFileSync(produced, pdf);
    let pageCount: number | undefined;
    try { pageCount = Number(/^Pages:\s+(\d+)/m.exec((await execFileAsync("pdfinfo", [pdf], { timeout: 15000, encoding: "utf8" })).stdout)?.[1]) || undefined; } catch { notes.push("pdfinfo is not installed, so the page count is unknown."); }
    const pngs: string[] = [];
    if (pages > 0) try {
      const prefix = path.join(outDir, "page");
      await execFileAsync("pdftoppm", ["-png", "-r", String(dpi), "-f", "1", "-l", String(pages), pdf, prefix], { timeout: 90_000, encoding: "utf8" });
      for (const name of fs.readdirSync(outDir).filter(entry => /^page-\d+\.png$/.test(entry)).sort()) pngs.push(path.join(outDir, name));
    } catch { notes.push("pdftoppm (poppler) is not installed, so only the PDF was written; convert pages to images to look at them."); }
    if (pages > 0 && pageCount && pageCount > pages) notes.push(`Only the first ${pages} of ${pageCount} pages were rasterized; pass pages to see more.`);
    return { pdf, ...(pageCount ? { pageCount } : {}), pngs, engine: run.engine, notes };
  } finally { run.cleanup(); }
}

/** Formats a conversion can write. csv writes one file per sheet. */
const TARGETS: Record<string, { filter: string; extension: string }> = {
  pdf: { filter: "pdf", extension: "pdf" }, docx: { filter: "docx", extension: "docx" }, xlsx: { filter: "xlsx", extension: "xlsx" }, pptx: { filter: "pptx", extension: "pptx" },
  odt: { filter: "odt", extension: "odt" }, ods: { filter: "ods", extension: "ods" }, odp: { filter: "odp", extension: "odp" },
  doc: { filter: "doc", extension: "doc" }, xls: { filter: "xls", extension: "xls" }, ppt: { filter: "ppt", extension: "ppt" }, rtf: { filter: "rtf", extension: "rtf" },
  txt: { filter: "txt:Text", extension: "txt" }, html: { filter: "html", extension: "html" },
  csv: { filter: "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", extension: "csv" },
};
export const CONVERT_TARGETS = Object.keys(TARGETS);
export const isLegacyOffice = (file: string): boolean => /\.(?:doc|dot|xls|xlt|ppt|pps|pot|rtf)$/i.test(file);

/** Convert a document, workbook or deck to another format. Returns the files written to `outDir` (more than one for a csv of several sheets). */
export async function convertOffice(file: string, to: string, outDir: string, options: { name?: string; signal?: AbortSignal; binary?: string; stagingRoot?: string } = {}): Promise<{ files: string[]; engine: string }> {
  const target = TARGETS[to.toLowerCase()];
  if (!target) throw new Error(`Cannot convert to "${to}"; use one of ${CONVERT_TARGETS.join(", ")}`);
  const base = options.name ?? path.basename(file, path.extname(file));
  const run = await convertStaged(file, target.filter, options);
  try {
    const names = fs.readdirSync(run.staging).filter(name => name !== "profile" && name.startsWith("input") && name.endsWith(`.${target.extension}`) && fs.statSync(path.join(run.staging, name)).size > 0).sort();
    if (!names.length) throw new Error("LibreOffice finished without producing the converted file (the file may be damaged, password-protected or not convertible to this format)");
    // One file is named after the base; a workbook with several sheets becomes one file per sheet, named base-Sheet.
    const files = names.map(name => path.join(outDir, names.length === 1 || name === `input.${target.extension}` ? `${base}.${target.extension}` : `${base}-${name.slice("input-".length, -(target.extension.length + 1))}.${target.extension}`));
    names.forEach((name, at) => fs.copyFileSync(path.join(run.staging, name), files[at]));
    return { files, engine: run.engine };
  } finally { run.cleanup(); }
}

/** A legacy .doc, .xls, .ppt or .rtf turned into its modern twin in a private folder, so the structural reader can open it. */
export async function openLegacyOffice(file: string, options: { signal?: AbortSignal; binary?: string; stagingRoot?: string } = {}): Promise<{ path: string; kind: "docx" | "xlsx" | "pptx"; cleanup: () => void }> {
  const to = /\.(?:xls|xlt)$/i.test(file) ? "xlsx" : /\.(?:ppt|pps|pot)$/i.test(file) ? "pptx" : "docx";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-legacy-"));
  try { const { files } = await convertOffice(file, to, dir, { ...options, name: "converted" }); return { path: files[0], kind: to, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }; }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}
