import {createRenderQueue} from "./lib/render-queue.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runManagedCommand } from "./managed-bash.ts";
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const encode = (p: any) => Buffer.from(JSON.stringify(p)).toString("base64url");
export default function (pi: any) {
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
  pi.registerTool({
    name: "render_see",
    label: "Render and see",
    description:
      "Inspect or capture local HTML/SVG/image/PDF or HTTP(S). output:text returns bounded live-DOM labels, controls, bounds/overflow, image alt/load status and validation state without pixels; both adds PNG. Default image for vision models, text otherwise. Supports dark/light, reduced motion and sampled CSS/WAAPI frames. Selector scopes DOM inspection and scrolls viewport images to the first match (may clip oversized elements). Oversized full-page captures return explicitly incomplete viewport evidence. Concurrent calls queue (up to four waiting, 120s queue deadline). Isolated, unauthenticated, 30s execution max; no actions/GPU. DOM facts are not visual interpretation.",
    parameters: Type.Object({
      source: Type.String(),
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
        const dir = path.join(getAgentDir(), "artifacts", "renders");
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
        tempRoot = await fs.mkdtemp(path.join(dir, "work-"));
        if (!/^https?:\/\//i.test(p.source))
          p = {
            ...p,
            source: path.resolve(ctx.cwd, p.source.replace(/^@/, "")),
          };
        const r = await runManagedCommand(
          `TMPDIR=${quote(tempRoot)} HOME=${quote(tempRoot)} XDG_CACHE_HOME=${quote(path.join(tempRoot, "cache"))} XDG_CONFIG_HOME=${quote(path.join(tempRoot, "config"))} ${quote(process.execPath)} ${quote(path.join(scripts, "render-capture.mjs"))} ${quote(encode(p))} ${quote(output)}`,
          ctx.cwd,
          (p.timeoutMs ?? 15000) / 1000 + 3,
          signal,
          35000,
          1500,
        );
        if (r.exitCode !== 0) throw new Error(`Render failed: ${r.output}`);
        const details = JSON.parse(r.output.trim());
        signal?.throwIfAborted();
        const content: any[] = [];
        if (details.output) {
          await fs.chmod(output, 0o600);
          if (canSee) {
            const image = await fs.readFile(output);
            content.push({
              type: "image",
              mimeType: "image/png",
              data: image.toString("base64"),
            });
          } else {
            details.visualInterpretation =
              "Unavailable: current model does not advertise vision. PNG saved, not delivered as pixels. For a visual question, discover routes with subagent({action:'models',model:'input:image'}), then use a permitted image model explicitly for a fresh read-only child to read this output path and return observations with uncertainty. Respect delegation limits; do not claim to have seen it.";
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
  });
}
