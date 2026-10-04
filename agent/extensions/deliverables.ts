/** Deliverables: open, check and build the files a session produces.
 *
 * Three pieces share one ledger. `office_doc` reads, verifies, builds (docx, xlsx) and renders
 * Office files without any office suite; `deliverable_check` opens any produced file (Office,
 * PDF, image, video, audio, data, HTML, archive) and returns findings; and a tracker notices
 * final-product files that scripts wrote during the session. A produced file that nobody opened
 * is reported once in the answer footer and, at most twice per distinct set, wakes the model with
 * one instruction: check it. Weaker models routinely stop at "the script printed Saved
 * report.docx"; this makes opening the result the cheapest next step instead of a skipped one.
 * `PI_DELIVERABLES=off` disables the tracker and follow-ups; the tools stay available. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { choices } from "./lib/tool-schema.ts";
import { inspectDeliverable } from "./lib/deliverable-inspect.ts";
import { readOffice, officeKindForPath, type Finding } from "./lib/office-read.ts";
import { buildDocx, buildXlsx } from "./lib/office-build.ts";
import { renderOffice } from "./lib/office-render.ts";
import { createDeliverableLedger, commandMayProduceFiles, plausibleDeliverable, scanRecentDeliverables, isDeliverableName, type Observed } from "./lib/deliverable-ledger.ts";
import { registerContinuationSource, collectContinuationLines } from "./lib/continuation-notice.ts";
import { isSessionStopped } from "./lib/session-stop.ts";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./lib/self-mutation-guard.ts";
import { outputFolder, textPath } from "./lib/media-process.ts";
import { describeBinary, looksBinary, sniffKind } from "./lib/binary-read.ts";

const MAX_FOLLOWUPS = 2;
const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const compact = (findings: Finding[], limit = 10) => {
  const loud = findings.filter(finding => finding.severity !== "info"), quiet = findings.filter(finding => finding.severity === "info");
  return [...loud, ...quiet.slice(0, loud.length ? 1 : 2)].slice(0, limit).map(({ severity, code, message, hint, where }) => ({ severity, code, message, ...(hint ? { hint } : {}), ...(where ? { where } : {}) }));
};
const statusOf = (findings: Finding[]): "pass" | "warn" | "fail" => findings.some(f => f.severity === "error") ? "fail" : findings.some(f => f.severity === "warn") ? "warn" : "pass";
const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: value });

export default function deliverables(pi: any) {
  const ledger = createDeliverableLedger();
  const started = new Map<string, number>();
  const delivered = new Set<string>();
  let followups = 0, disposeSource: (() => void) | undefined, sessionKey: object | undefined;
  const enabled = () => (process.env.PI_DELIVERABLES ?? "on").toLowerCase() !== "off" && process.env.PI_SUBAGENT_CHILD !== "1";
  const relative = (file: string, cwd?: string) => { const rel = path.relative(cwd ?? process.cwd(), file); return rel && !rel.startsWith("..") ? rel : file; };

  const reset = () => { ledger.reset(); started.clear(); delivered.clear(); followups = 0; disposeSource?.(); disposeSource = undefined; sessionKey = undefined; };
  for (const event of ["session_start", "session_switch", "session_tree", "session_fork", "session_shutdown"]) pi.on(event, reset);

  const lines = (cwd?: string) => ledger.pending().slice(0, 3).map(item => `${relative(item.path, cwd)} was produced but never opened or checked`);
  const receipts = (cwd?: string) => ledger.pending().slice(0, 3).map((item: Observed) => ({
    source: "deliverables", id: item.path, revision: `${Math.round(item.mtimeMs)}:${item.size}`, state: "unverified",
    line: `deliverables: ${relative(item.path, cwd)} was produced but never opened or checked (deliverable_check)`, brief: `${path.basename(item.path)}: produced, not opened`,
  }));
  const ensureSource = (ctx: any) => {
    if (!ctx?.sessionManager || sessionKey === ctx.sessionManager) return;
    disposeSource?.(); sessionKey = ctx.sessionManager;
    const cwd = ctx.cwd;
    disposeSource = registerContinuationSource({ session: ctx.sessionManager, name: "deliverables", pending: () => [], verification: () => enabled() ? lines(cwd) : [], verificationReceipts: () => enabled() ? receipts(cwd) : [] });
  };

  // Produced files: scripts run through bash, and binary writes through the write tool.
  pi.on("tool_call", (event: any) => {
    if (!enabled() || typeof event?.toolCallId !== "string") return;
    if (event.toolName === "bash" && commandMayProduceFiles(event.input?.command)) {
      if (started.size >= 128) started.delete(started.keys().next().value!);
      started.set(event.toolCallId, Date.now());
    }
  });
  pi.on("tool_result", (event: any, ctx: any) => {
    if (!enabled() || event?.isError) { if (event?.toolCallId) started.delete(event.toolCallId); return; }
    const cwd = ctx?.cwd ?? process.cwd();
    try {
      if (event.toolName === "write" && typeof event.input?.path === "string" && isDeliverableName(event.input.path)) {
        if (ledger.noteProduced(path.resolve(cwd, event.input.path), "write")) ensureSource(ctx);
      } else if (event.toolName === "bash" && started.has(event.toolCallId)) {
        const since = started.get(event.toolCallId)! - 1500;
        started.delete(event.toolCallId);
        const seenText = `${event.input?.command ?? ""}\n${(event.content ?? []).filter((row: any) => row?.type === "text").map((row: any) => row.text).join("\n")}`;
        for (const file of scanRecentDeliverables(cwd, since)) if (plausibleDeliverable(file, cwd, seenText) && ledger.noteProduced(file, "bash")) ensureSource(ctx);
      }
    } catch { /* tracking must never turn a successful tool into an error */ }
  });

  // The native read tool decodes every non-image file as UTF-8. A PDF, Office file, archive, database or media file
  // therefore arrives as tens of kilobytes of garbage; show what the file contains instead. Only text that already looks
  // like binary decoding (NUL or replacement characters, or the offset error a short binary produces) costs a disk check.
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event?.toolName !== "read" || (process.env.PI_BINARY_READ ?? "on").toLowerCase() === "off") return;
    const raw = event.input?.path ?? event.input?.file_path;
    if (typeof raw !== "string" || !raw || (event.content ?? []).some((row: any) => row?.type === "image")) return;
    const shown = (event.content ?? []).filter((row: any) => row?.type === "text").map((row: any) => String(row.text)).join("\n");
    if (event.isError ? !/Offset \d+ is beyond end of file/.test(shown) : !(/[\u0000\uFFFD]/.test(shown) || /^%PDF-|^SQLite format 3/.test(shown))) return;
    try {
      const file = canonicalMutationPath(textPath(raw.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), ctx?.cwd ?? process.cwd());
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) return;
      const fd = fs.openSync(file, "r"); let head: Buffer;
      try { head = Buffer.alloc(Math.min(8192, stat.size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      if (!looksBinary(head) && !["pdf", "sqlite"].includes(sniffKind(head, file).kind)) return; // an ASCII-only PDF is still not readable as text
      const view = await describeBinary(file, { offset: typeof event.input?.offset === "number" ? event.input.offset : undefined, signal: ctx?.signal, head });
      if (view.opened) ledger.noteChecked(file, "pass");
      return { content: [{ type: "text", text: view.text }], details: { ...(event.details ?? {}), binaryView: view.facts }, isError: false };
    } catch { /* leave the native result as it is */ }
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (!enabled() || isSessionStopped(ctx) || ctx?.signal?.aborted || ctx?.isIdle?.() !== true || ctx?.hasPendingMessages?.() || followups >= MAX_FOLLOWUPS) return;
    if (collectContinuationLines(3, ctx?.sessionManager).length) return; // other work will resume this session first
    const open = ledger.pending();
    if (!open.length) return;
    const key = open.map(item => `${item.path}\0${Math.round(item.mtimeMs)}:${item.size}`).join("\n");
    if (delivered.has(key)) return;
    delivered.add(key); followups++;
    const names = open.slice(0, 5).map(item => `${relative(item.path, ctx?.cwd)} (${path.extname(item.path).slice(1)})`).join(", ");
    const content = `Files produced in this session have not been opened or checked: ${names}. Call deliverable_check once with these paths, fix every error and any warning that matters, then check again. A file that is only an intermediate needs no check: say so in your answer instead. Automatic follow-up ${followups}/${MAX_FOLLOWUPS}.`;
    // The follow-up tells the model to call deliverable_check: make sure its schema is on the wire for that turn.
    try { pi.events?.emit?.("adaptive-pipeline-selection", { sessionManager: ctx?.sessionManager, beforeStart: true, names: ["deliverable_check"] }); } catch { /* discovery host is optional */ }
    try { await pi.sendMessage({ customType: "deliverable-followup", content, display: false }, { deliverAs: "followUp", triggerTurn: true }); }
    catch { delivered.delete(key); followups--; }
  });

  /* ───────────── deliverable_check ───────────── */
  pi.registerTool({
    name: "deliverable_check",
    label: "Deliverable Check",
    description: "Open files you produced and report whether they are what they claim to be: Office documents (structure, unreplaced placeholders, uncalculated or error formulas, empty slides), PDFs, images (truncation, dimensions), video and audio (decode, pixel format, silence, clipping, faststart), CSV/JSON/YAML, HTML (broken local links), Markdown, archives. Read-only and bounded. Findings carry a fix hint; status is pass, warn or fail per file. Call it for each finished file before saying the work is done; it checks structure and measurable defects, not taste, so still look at renders (render_see, video_frames) and listen to audio.",
    promptSnippet: "Open and verify produced files (documents, PDFs, media, data) before finishing",
    promptGuidelines: ["Before reporting a file as done, call deliverable_check on it: a script that printed 'Saved x' proves nothing about x."],
    parameters: Type.Object({
      paths: Type.Array(localPath, { minItems: 1, maxItems: 8, description: "Files to check (relative to the working directory or absolute)" }),
      path: Type.Optional(localPath),
    }),
    prepareArguments(input: any) {
      if (!input || typeof input !== "object") return input;
      const paths = Array.isArray(input.paths) ? input.paths : typeof input.paths === "string" ? [input.paths] : typeof input.path === "string" ? [input.path] : input.paths;
      const { path: _single, ...rest } = input;
      return { ...rest, paths };
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const cwd = ctx?.cwd || process.cwd(), checked: any[] = [];
      const deadline = AbortSignal.timeout(180_000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      for (const raw of (params.paths ?? []).slice(0, 8)) {
        let file: string;
        try { file = canonicalMutationPath(textPath(raw), cwd); } catch (error) { checked.push({ path: String(raw).slice(0, 200), kind: "invalid", status: "fail", findings: [{ severity: "error", code: "bad-path", message: String((error as Error).message) }], facts: {} }); continue; }
        const inspection = await inspectDeliverable(file, { cwd, signal: bounded });
        ledger.noteChecked(inspection.path, inspection.status);
        checked.push({ path: relative(inspection.path, cwd), kind: inspection.kind, bytes: inspection.bytes, status: inspection.status, findings: compact(inspection.findings), facts: inspection.facts });
      }
      const counts = ["pass", "warn", "fail"].map(status => `${checked.filter(row => row.status === status).length} ${status}`).join(", ");
      const failing = checked.filter(row => row.status === "fail").map(row => row.path);
      return text({ checked, summary: counts, next: failing.length ? `Fix ${failing.slice(0, 3).join(", ")} (errors above), regenerate, and check again.` : checked.some(row => row.status === "warn") ? "Decide whether each warning matters for this deliverable; fix those that do and check again." : "Structure and measurable defects pass. Look at the actual output (render_see, video_frames, listen to audio) before judging quality." });
    },
  });

  /* ───────────── office_doc ───────────── */
  const OFFICE_EXT = /\.(?:docx|xlsx)$/i;
  pi.registerTool({
    name: "office_doc",
    label: "Office Document",
    description: "Read, verify, build and render Office documents with no office suite. read: structured content of docx/xlsx/pptx/odt/ods/odp (headings, tables, sheet cells and formulas, slide text, notes) plus findings. verify: findings only (damaged package, unreplaced {{placeholders}}, uncalculated or error formulas, numbers stored as text, empty slides, tiny type). build: write a .docx or .xlsx from a spec and verify it. docx spec: {title, subtitle, author, page:{size:'A4'|'Letter',orientation,margins}, font:{family,size,accent}, header, footer ('Page {page} of {pages}'), blocks:[{type:'heading',level:1-3,text}, {type:'paragraph',text with **bold** *italic* `code` [link](https://…)}, {type:'bullets'|'numbered',items:[text|{text,level}]}, {type:'table',header:[…],rows:[[…]],widths,align,style:'grid'|'plain'|'banded',caption}, {type:'image',path,width inches,alt,caption}, {type:'quote',text,cite}, {type:'code',text}, {type:'pagebreak'}]}. xlsx spec: {sheets:[{name, columns:[{header,width,format:'text'|'integer'|'decimal'|'currency'|'percent'|'date'|'datetime'}], rows:[[value|'=FORMULA'|…]], totals:{label,sum:[column header or letter]}, freeze, filter}], currency:'$'}; formulas are calculated and stored (SUM, AVERAGE, ROUND, SUMIF(S), COUNTIF(S), AVERAGEIF(S), IF, IFS, IFERROR, VLOOKUP, INDEX, MATCH, XLOOKUP, TEXT, LEFT, CONCAT, TEXTJOIN, DATE, EDATE and more, with cross-sheet and whole-column refs; newer functions get the _xlfn. prefix automatically) and errors like #DIV/0! are reported. render: LibreOffice → PDF plus PNG pages to look at layout (needs LibreOffice); it also converts any docx/xlsx/pptx/odt/ods/odp to PDF: pass pdfPath (a .pdf inside the workspace; overwrite:true to replace one) and pages:0 to skip the page images.",
    promptSnippet: "Read, verify, build (docx/xlsx) and render Office documents",
    parameters: Type.Object({
      action: choices(["read", "verify", "build", "render"]),
      path: localPath,
      spec: Type.Optional(Type.Object({}, { additionalProperties: true, description: "build: the docx or xlsx spec described above" })),
      format: Type.Optional(choices(["docx", "xlsx"], "build: only needed when path has no .docx/.xlsx extension")),
      overwrite: Type.Optional(Type.Boolean({ description: "build, or render with pdfPath: replace an existing file" })),
      sheet: Type.Optional(Type.String({ maxLength: 31, description: "read: only this sheet" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 60000 })),
      pages: Type.Optional(Type.Integer({ minimum: 0, maximum: 8, description: "render: pages to rasterize (default 3; 0 for the PDF only)" })),
      pdfPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "render: also save the PDF here (a .pdf path inside the workspace); an existing file needs overwrite:true" })),
      outputDir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "render: existing workspace folder in which the new media-… folder with the page images is created (default: the working directory)" })),
    }),
    prepareArguments(input: any) {
      if (!input || typeof input !== "object") return input;
      const spec = typeof input.spec === "string" ? (() => { try { return JSON.parse(input.spec); } catch { return input.spec; } })() : input.spec;
      return { ...input, ...(spec !== undefined ? { spec } : {}), action: input.action ?? (input.spec ? "build" : "read") };
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const cwd = ctx?.cwd || process.cwd(), deadline = AbortSignal.timeout(240_000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const root = fs.realpathSync(cwd);
      const file = canonicalMutationPath(textPath(params.path), root);
      if (params.action === "read" || params.action === "verify") {
        if (!fs.existsSync(file)) throw new Error(`${relative(file, cwd)} does not exist`);
        const read = readOffice(file, { maxChars: params.action === "verify" ? 400 : params.maxChars, sheet: params.sheet });
        ledger.noteChecked(file, statusOf(read.findings));
        const { findings, text: body, ...rest } = read;
        const result: any = { ...rest, path: relative(file, cwd), status: statusOf(findings), findings: compact(findings, 14) };
        if (params.action === "read") { result.text = body; if (read.truncated) result.note = "Text is truncated; pass maxChars (up to 60000) or sheet to read more."; } else delete result.sheets;
        return text(result);
      }
      if (params.action === "render") {
        if (!fs.existsSync(file) || !officeKindForPath(file)) throw new Error(`${relative(file, cwd)} is not an existing Office file`);
        let pdfTarget: string | undefined;
        if (params.pdfPath !== undefined) {
          pdfTarget = canonicalMutationPath(textPath(params.pdfPath), root);
          if (!/\.pdf$/i.test(pdfTarget)) throw new Error("pdfPath must end in .pdf");
          if (!containsPath(root, pdfTarget)) throw new Error("pdfPath must be inside the current workspace; choose a path below the working directory");
          const denial = selfMutationDenial(pdfTarget, root); if (denial) throw new Error(denial);
          if (fs.existsSync(pdfTarget) && params.overwrite !== true) throw new Error(`${relative(pdfTarget, cwd)} already exists. Pass overwrite:true to replace it or choose another name.`);
        }
        const outDir = await outputFolder(params.outputDir, cwd);
        try {
          const rendered = await renderOffice(file, outDir, { pages: params.pages, signal: bounded });
          let pdf = rendered.pdf, verification: any;
          if (pdfTarget) {
            fs.mkdirSync(path.dirname(pdfTarget), { recursive: true });
            const temporary = `${pdfTarget}.tmp-${randomBytes(4).toString("hex")}`;
            try { fs.copyFileSync(rendered.pdf, temporary, fs.constants.COPYFILE_EXCL); fs.renameSync(temporary, pdfTarget); } finally { fs.rmSync(temporary, { force: true }); }
            fs.rmSync(rendered.pdf, { force: true });
            pdf = pdfTarget;
            const inspection = await inspectDeliverable(pdfTarget, { cwd, signal: bounded });
            ledger.noteProduced(pdfTarget, "office_doc"); ledger.noteChecked(pdfTarget, inspection.status);
            verification = { status: inspection.status, findings: compact(inspection.findings, 6), facts: inspection.facts };
            if (!rendered.pngs.length) fs.rmSync(outDir, { recursive: true, force: true });
          }
          const note = rendered.pngs.length ? "Open the PNG pages (read or render_see) and judge layout: overflow, clipping, spacing, hierarchy. Structure checks cannot see these."
            : pdfTarget ? `The PDF is at ${relative(pdfTarget, cwd)}${verification?.status === "fail" ? ", but its check failed: read the findings" : ", and its check passed; pass pages (1 to 8) to also see page images"}.` : "Only the PDF was written; pass pages (1 to 8) to also see page images.";
          return text({ ...rendered, pdf: relative(pdf, cwd), pngs: rendered.pngs.map(png => relative(png, cwd)), ...(verification ? { verification } : {}), note });
        } catch (error) { fs.rmSync(outDir, { recursive: true, force: true }); throw error; }
      }
      // build
      const kind = /\.docx$/i.test(file) ? "docx" : /\.xlsx$/i.test(file) ? "xlsx" : params.format;
      if (!kind) throw new Error("build writes .docx or .xlsx: give path an extension or set format");
      if (!OFFICE_EXT.test(file) && !params.format) throw new Error("build writes .docx or .xlsx");
      const target = OFFICE_EXT.test(file) ? file : `${file}.${kind}`;
      if (!containsPath(root, target)) throw new Error("build writes inside the current workspace; choose a path below the working directory");
      const denial = selfMutationDenial(target, root); if (denial) throw new Error(denial);
      if (fs.existsSync(target) && params.overwrite !== true) throw new Error(`${relative(target, cwd)} already exists. Pass overwrite:true to replace it or choose another name.`);
      if (!params.spec || typeof params.spec !== "object") throw new Error(`build needs a spec object (${kind === "docx" ? "{title, blocks:[…]}" : "{sheets:[{name, columns, rows}]}"}); see the tool description for its shape`);
      const built = kind === "docx"
        ? buildDocx(params.spec, imagePath => { const resolved = canonicalMutationPath(textPath(imagePath), cwd); if (!fs.statSync(resolved).isFile()) throw new Error("not a file"); return fs.readFileSync(resolved); })
        : buildXlsx(params.spec);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${randomBytes(4).toString("hex")}`;
      try { fs.writeFileSync(temporary, built.buffer, { flag: "wx" }); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
      const verification = readOffice(target, { maxChars: 200 });
      const status = statusOf(verification.findings);
      ledger.noteProduced(target, "office_doc"); ledger.noteChecked(target, status);
      return text({ action: "build", path: relative(target, cwd), kind, bytes: built.buffer.length, ...("stats" in built ? { stats: built.stats } : { sheets: built.sheets, converted: built.converted }), warnings: built.warnings, verification: { status, findings: compact(verification.findings, 8) },
        next: status === "fail" ? "The built file has errors; fix the spec and rebuild with overwrite:true." : "Built and re-read. Use action render to look at the layout, and replace any warnings' causes before delivery." });
    },
  });
}
