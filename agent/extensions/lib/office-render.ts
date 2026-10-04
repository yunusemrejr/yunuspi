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
export async function renderOffice(file: string, outDir: string, options: { pages?: number; dpi?: number; signal?: AbortSignal; binary?: string; stagingRoot?: string } = {}): Promise<RenderResult> {
  const binary = options.binary ?? findOfficeSuite();
  if (!binary) throw new Error("No office suite is installed (LibreOffice: soffice or libreoffice), so pages cannot be rendered. Reading and verifying still work; install LibreOffice to look at layout.");
  const pages = Math.min(Math.max(Math.round(options.pages ?? 3), 0), 8), dpi = Math.min(Math.max(Math.round(options.dpi ?? 70), 40), 150);
  const staging = fs.mkdtempSync(path.join(options.stagingRoot ?? (isSnap(binary) ? os.homedir() : os.tmpdir()), "yunuspi-render-"));
  const notes: string[] = [];
  try {
    const extension = path.extname(file).toLowerCase() || ".docx", staged = path.join(staging, `input${extension}`);
    fs.copyFileSync(file, staged);
    await runGuarded(binary, ["--headless", "--norestore", "--nologo", `-env:UserInstallation=file://${path.join(staging, "profile")}`, "--convert-to", "pdf", "--outdir", staging, staged],
      { cwd: staging, signal: options.signal, timeoutMs: 150_000, guard: false, memoryMb: 2500 });
    const produced = path.join(staging, "input.pdf");
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
    return { pdf, ...(pageCount ? { pageCount } : {}), pngs, engine: path.basename(binary), notes };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
