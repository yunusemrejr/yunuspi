import {registerBrowserSession, isolatedBrowserEnvironment} from "./lib/browser-session.ts";
import {createRenderQueue} from "./lib/render-queue.ts";
import { StringEnum } from "@yunuspi/ai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir } from "@yunuspi/coding-agent";
import { runManagedCommand } from "./managed-bash.ts";
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const encode = (p: any) => Buffer.from(JSON.stringify(p)).toString("base64url");
/** Trusted renderer entrypoint only: no shell or caller-supplied executable.
 * Chromium owns the page sandbox. Nesting its sandbox in the generic command
 * user namespace breaks the root-owned Chromium helper on ordinary projects. */
function runCapture(params: any, output: string, tempRoot: string, cwd: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let stopped: string | undefined;
    const child = execFile(process.execPath, [path.join(scripts, "render-capture.mjs"), encode(params), output], {
      cwd, detached: process.platform !== "win32", encoding: "utf8", maxBuffer: 65536,
      env: isolatedBrowserEnvironment(tempRoot),
    }, (error, stdout, stderr) => {
      clearTimeout(deadline); clearTimeout(hardKill);
      signal?.removeEventListener("abort", abort);
      // Reap a browser descendant if Node exited before cleaning its pipes.
      kill("SIGKILL");
      if (stopped) reject(new Error(stopped));
      else if (error) {
        const message = String(stderr || stdout || error.message).slice(-16384);
        let report;
        try { report = JSON.parse(message); } catch { /* ordinary launch/source failure */ }
        reject(Object.assign(new Error(`Render failed: ${message}`),
          report?.status === "failed" && typeof report.failure?.stage === "string" ? { renderFailure: report } : {}));
      }
      else resolve(stdout);
    });
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already reaped */ }
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason; kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 1500); hardKill.unref();
    };
    const abort = () => stop("Render cancelled");
    const deadline = setTimeout(() => stop("Render timed out"), (params.timeoutMs ?? 15000) + 3000);
    deadline.unref(); signal?.addEventListener("abort", abort, {once:true});
    if (signal?.aborted) abort();
  });
}
export default function (pi: any) {
  registerBrowserSession(pi);
  const acquireRender = createRenderQueue();
  pi.registerTool({
    name: "wait_for",
    label: "Wait for",
    description:
      "Finite HTTP status, file existence or literal match wait. Reopens files, reads last 64 KiB; after 4s returns existing process handle (output yields terminal JSON). Cancel with process kill. No regex execution.",
    parameters: Type.Object({
      kind: StringEnum(["http", "exists", "literal"]),
      target: Type.String(),
      timeout: Type.Number({ minimum: 0.01, maximum: 600 }),
      status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }),
    async execute(_id: any, p: any, signal: any, _update: any, ctx: any) {
      if (p.kind !== "http")
        p = { ...p, target: path.resolve(ctx.cwd, p.target.replace(/^@/, "")) };
      const r = await runManagedCommand(
        `${quote(process.execPath)} ${quote(path.join(scripts, "wait-condition.mjs"))} ${quote(encode(p))}`,
        ctx.cwd,
        p.timeout + 2,
        signal,
      );
      return {
        content: [{ type: "text", text: r.output }],
        details: { exitCode: r.exitCode },
      };
    },
  });
  const renderTool = {
    name: "render_see",
    label: "Render and see",
    description:
      "Built-in browser inspection: use directly without locating/installing Playwright. Inspect or capture local HTML/SVG/image/PDF or HTTP(S). output:text returns bounded live-DOM labels, controls, bounds/overflow, image alt/load status and validation state without pixels; both adds PNG. Default image for vision models, text otherwise. Supports dark/light, reduced motion and sampled CSS/WAAPI frames. Selector scopes DOM inspection and scrolls viewport images to the first match (may clip oversized elements). Oversized full-page captures return explicitly incomplete viewport evidence. Concurrent calls queue per agent (up to four waiting, 120s queue deadline); other agents have independent captures. Isolated, unauthenticated, 30s execution max; no actions/GPU. DOM facts are not visual interpretation.",
    parameters: Type.Object({
      source: Type.String({description: "Local file path (HTML may include #route) or HTTP(S) URL, including localhost. Existing literal '#' filenames take precedence over fragments. Browser isolation is not network isolation; check server readiness on connection failures."}),
      output: Type.Optional(StringEnum(["image", "text", "both"])),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048 })),
      fullPage: Type.Optional(Type.Boolean()),
      ready: Type.Optional(
        StringEnum(["load", "domcontentloaded", "networkidle"]),
      ),
      selector: Type.Optional(Type.String({ maxLength: 256 })),
      colorScheme: Type.Optional(StringEnum(["light", "dark"])),
      reducedMotion: Type.Optional(StringEnum(["reduce", "no-preference"])),
      animationTimeMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000, description: "Pause up to 200 current main-frame document-timeline CSS/WAAPI animations at this local time each. Not JS/rAF playback, scroll timelines, or interaction; unavailable for PDF." })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id: any, p: any, signal: any, _update: any, ctx: any) {
      signal?.throwIfAborted();
      const canSee = ctx.model?.input?.includes("image") === true;
      p = { ...p, output: p.output ?? (canSee ? "image" : "text") };
      const releaseRender = await acquireRender(signal);
      let output: string | undefined;
      let lock: string | undefined;
      let tempRoot: string | undefined;
      try {
        const owner = String(ctx.sessionManager?.getSessionId?.() ?? "current").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
        const dir = path.join(getAgentDir(), "artifacts", "renders", `${owner}-${process.pid}`);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const lockPath = path.join(dir, ".capture-lock");
        try {
          await fs.mkdir(lockPath);
        } catch {
          throw new Error(
            `Another process owns the render lease. If no render is running, remove stale ${lockPath} after verifying its owner.json PID.`,
          );
        }
        lock = lockPath;
        await fs.writeFile(
          path.join(lock, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
        const files = (await fs.readdir(dir)).filter((n) =>
          /^capture-[a-f0-9-]+\.png$/.test(n),
        );
        const ranked = await Promise.all(
          files.map(async (n) => ({
            n,
            t: (await fs.stat(path.join(dir, n))).mtimeMs,
          })),
        );
        for (const { n } of ranked.sort((a, b) => b.t - a.t).slice(19))
          await fs.unlink(path.join(dir, n));
        output = path.join(dir, `capture-${randomUUID()}.png`);
        // Normal project commands cannot write inside the protected harness.
        // Keep the trusted browser runner's profiles and capture staging
        // outside that tree; only this trusted parent publishes the artifact.
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-render-"));
        await fs.chmod(tempRoot, 0o700);
        await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({pid:process.pid, startedAt:new Date().toISOString(), workDir:tempRoot}), {mode:0o600});
        const stagedOutput = path.join(tempRoot, "capture.png");
        if (!/^https?:\/\//i.test(p.source))
          p = {
            ...p,
            source: path.resolve(ctx.cwd, p.source.replace(/^@/, "")),
          };
        const captureResult = await runCapture(p, stagedOutput, tempRoot, ctx.cwd, signal);
        const details = JSON.parse(captureResult.trim());
        signal?.throwIfAborted();
        const content: any[] = [];
        if (details.output) {
          const staged = await fs.lstat(stagedOutput);
          if (!staged.isFile() || staged.isSymbolicLink() || staged.size > 20 * 1024 * 1024)
            throw new Error("Render returned an invalid capture artifact");
          await fs.copyFile(stagedOutput, output);
          await fs.chmod(output, 0o600);
          details.output = output;
          if (canSee) {
            const image = await fs.readFile(output);
            content.push({
              type: "image",
              mimeType: "image/png",
              data: image.toString("base64"),
            });
          } else {
            details.visualInterpretation =
              "Unavailable: current model does not advertise vision. PNG saved, not delivered as pixels. If you only need printed text from this capture, run image_ocr on the output path instead of delegating. For other visual questions, discover routes with subagent({action:'models',model:'input:image'}), then use a permitted image model explicitly for a fresh read-only child to read this output path and return observations with uncertainty. Respect delegation limits; do not claim to have seen it.";
          }
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(details) },
            ...content,
          ],
          details,
        };
      } catch (e) {
        if (output) await fs.unlink(output).catch(() => {});
        if (e.renderFailure) return {
          isError: true,
          content: [{type: "text", text: JSON.stringify(e.renderFailure)}],
          details: e.renderFailure,
        };
        throw e;
      } finally {
        try {
          if (tempRoot)
            await fs.rm(tempRoot, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 100,
            });
        } finally {
          if (lock) {
            await fs.unlink(path.join(lock, "owner.json")).catch(() => {});
            await fs.rmdir(lock).catch(() => {});
          }
          releaseRender();
        }
      }
    },
  };
  pi.registerTool({ ...renderTool, name: "render_see", parameters: renderTool.parameters, execute: renderTool.execute });
  pi.registerTool({
    ...renderTool,
    name: "design_audit",
    parameters: renderTool.parameters,
    label: "Rendered design audit",
    description: "Inspect a rendered web page for typography/spacing distributions, repeated surface effects, overflow, running motion and solid-color text contrast. Uses the existing isolated browser, with screenshot pixels for vision models. Numeric evidence for accessible and anti-slop design review, not a style score or certification. Complex paint is indeterminate. Compare mobile/desktop and reduced-motion calls; use design skills and actual screenshots to judge hierarchy and originality.",
    async execute(id: any, params: any, signal: any, update: any, ctx: any) {
      if (/\.pdf$/i.test(params.source)) throw new Error("design_audit requires rendered HTML; PDF has no computed web styles");
      return renderTool.execute(id, { ...params, output: params.output === "text" ? "text" : "both", designAudit: true }, signal, update, ctx);
    },
  });
}
