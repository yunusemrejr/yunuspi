/** Closed-loop creative production: one shared direction, rendered QA, and
 * revision-sensitive receipts. Discovered on demand through tool_search;
 * the design-direction protocol and Expert Director critics own the
 * creative workflow. Tools:
 *   creative_direct  set/get/brief the structured task direction
 *   visual_review    capture + rubric review with recorded verdicts
 *   ui_explore       viewport/state capture matrix with DOM facts
 *   motion_inspect   animation inventory + sampled temporal QA
 *   svg_inspect      SVG geometry, set consistency, size matrix
 *   asset_register   asset provenance, roles and reuse search
 *   image_generate   provider-agnostic generation/editing with briefs
 *   creative_compare side-by-side direction variants for design fusion
 * Blocking visual verdicts and unreviewed directions feed the completion
 * gate through the "creative" continuation source. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  directionSummary, normalizeDirection, projectDirectionPath, readProjectDirection, renderDirectionBrief,
  type CreativeDirection,
} from "./lib/creative-direction.ts";
import {
  creativeCompareRun, creativeVerificationLines, normalizeVerdict, planCompare, planUiMatrix,
  sourceRevision, uiExploreRun, visualReviewRun,
  type QACapture, type VisualReceipt,
} from "./lib/creative-qa.ts";
import { motionInspectRun } from "./lib/motion-inspect.ts";
import { svgInspectRun, svgMatrixRun } from "./lib/svg-inspect.ts";
import { svgReviewRun } from "./lib/svg-analysis.ts";
import { normalizeAssetInput, inspectAsset, readRegistry, recordAssetUsage, registerAsset, searchAssets } from "./lib/asset-registry.ts";
import { buildGenerationBrief, imageEditRun, imageGenerateRun, imageBackendStatus, imageBackendEnvironment } from "./lib/image-generate.ts";
import { registerContinuationSource } from "./lib/continuation-notice.ts";
import { captureToFile } from "./render-and-wait.ts";
import { sniffImage } from "./lib/design-studio.ts";
import { choices } from "./lib/tool-schema.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const strList = (maxItems: number, maxLength: number) => Type.Array(Type.String({ maxLength }), { maxItems });
const IMAGE_ATTACH_CAP = 1_100_000;

interface SessionCreative {
  direction?: CreativeDirection;
  receipts: VisualReceipt[];
  blockingRuns: Map<string, string>;
}

const sessions = new Map<string, SessionCreative>();
const sessionOf = (ctx: any): { sid: string; state: SessionCreative } => {
  const sid = String(ctx?.sessionManager?.getSessionId?.() ?? "");
  let state = sessions.get(sid);
  if (!state) {
    state = { receipts: [], blockingRuns: new Map() };
    sessions.set(sid, state);
    while (sessions.size > 8) sessions.delete(sessions.keys().next().value!);
  }
  return { sid, state };
};

const isChild = () => process.env.PI_SUBAGENT_CHILD === "1";

async function projectDirectionFile(cwd: string): Promise<string> {
  return projectDirectionPath(await fs.realpath(cwd));
}

async function writeProjectDirection(cwd: string, direction: CreativeDirection): Promise<string> {
  const file = await projectDirectionFile(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(path.dirname(file), ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(direction), { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}

async function maybePixels(pngPath: string, cwd: string, ctx: any) {
  try {
    if (ctx?.model?.input?.includes("image") !== true) return undefined;
    const resolved = path.resolve(cwd, pngPath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > IMAGE_ATTACH_CAP) return undefined;
    const bytes = await fs.readFile(resolved), format = sniffImage(bytes);
    if (!format || !["png", "jpeg", "webp", "gif"].includes(format)) return undefined;
    return { type: "image", mimeType: `image/${format}`, data: bytes.toString("base64") };
  } catch {
    return undefined;
  }
}

export default function artDirection(pi: any) {
  const capture: QACapture = (params, destination, cwd, signal) => captureToFile(params as any, destination, cwd, signal);

  function register(name: string, description: string, parameters: any, handler: (params: any, ctx: any, signal: AbortSignal) => Promise<{ result: any; pixels?: string }>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const cwd = ctx?.cwd || process.cwd();
        const { result, pixels } = await handler(params, { ...ctx, cwd }, bounded);
        const content: any[] = [{ type: "text", text: JSON.stringify(result) }];
        if (pixels) {
          const image = await maybePixels(pixels, cwd, ctx);
          if (image) content.push(image);
          else result.pixels = `${pixels} (open with read/vision: this model was not served pixels inline)`;
        }
        return { content, details: result };
      },
    });
  }

  registerContinuationSource({
    name: "creative",
    pending: () => [],
    verification: () => {
      const lines: string[] = [];
      for (const state of sessions.values()) {
        lines.push(...creativeVerificationLines(state.receipts, state.direction ? { name: state.direction.name } : undefined));
        for (const line of state.blockingRuns.values()) lines.push(line);
      }
      return [...new Set(lines)].slice(0, 8);
    },
  });

  // ── creative_direct ──
  register("creative_direct",
    "Own the task's structured creative direction: intent, ambition (restrained, balanced or immersive), the one signature element, focal hierarchy, visual bounds, avoid-list, motion and audio character, references. Every creative subsystem reads it; visual_review, ui_explore and motion_inspect check conformance against it. set validates and stores (scope session default, project persists to .pi/creative-direction.json); get reads session then project; brief renders the compact context block; status summarizes; clear removes. Parent owns mutation; children stay read-only.",
    Type.Object({
      action: choices(["set", "get", "brief", "status", "clear"]),
      scope: Type.Optional(choices(["session", "project"])),
      direction: Type.Optional(Type.Object({}, { additionalProperties: true } as any)),
    }),
    async (params, ctx) => {
      const { state } = sessionOf(ctx);
      const cwd = ctx.cwd as string;
      const scope = params.scope ?? "session";
      if (params.action === "set") {
        if (isChild()) throw new Error("creative_direct set is parent-only; children read the direction with get/brief.");
        const direction = normalizeDirection(params.direction);
        if (scope === "project") {
          const file = await writeProjectDirection(cwd, direction);
          state.direction = direction;
          try { pi.appendEntry?.("creative-direction-v1", { scope: "project", file, summary: directionSummary(direction) }); } catch { /* entries are optional */ }
          return { result: { scope: "project", file, summary: directionSummary(direction), brief: renderDirectionBrief(direction) } };
        }
        state.direction = direction;
        try { pi.appendEntry?.("creative-direction-v1", { scope: "session", summary: directionSummary(direction) }); } catch { /* entries are optional */ }
        return { result: { scope: "session", summary: directionSummary(direction), brief: renderDirectionBrief(direction) } };
      }
      if (params.action === "get" || params.action === "brief") {
        const direction = scope === "project" ? await readProjectDirection(cwd) : state.direction ?? await readProjectDirection(cwd);
        if (!direction) throw new Error("No creative direction is set. Record one with creative_direct set (scope session or project) before building or reviewing.");
        if (params.action === "brief") return { result: { scope: state.direction ? "session" : "project", brief: renderDirectionBrief(direction) } };
        return { result: { scope: state.direction ? "session" : "project", direction } };
      }
      if (params.action === "status") {
        const project = await readProjectDirection(cwd);
        return { result: { session: state.direction ? { summary: directionSummary(state.direction), updatedAt: state.direction.updatedAt } : null, project: project ? { summary: directionSummary(project), updatedAt: project.updatedAt } : null, receipts: state.receipts.length, openBlockingRuns: [...state.blockingRuns.values()] } };
      }
      if (isChild()) throw new Error("creative_direct clear is parent-only.");
      if (scope === "project") await fs.rm(await projectDirectionFile(cwd), { force: true });
      else delete state.direction;
      return { result: { cleared: scope } };
    }, 30_000);

  // ── visual_review ──
  register("visual_review",
    "Review actual rendered output, not source inference. run captures a source (HTML/SVG path or URL) and returns structured rubric sections (accessibility, spacing, typography, composition, slop, hierarchy, distinctiveness, direction conformance) with deterministic evidence plus explicit needsVision gaps; pixels attach for vision models. record stores a judged verdict as a revision-sensitive receipt (UNKNOWN stays open); status lists receipts. Blocking verdicts hold the completion gate until a clean re-review lands.",
    Type.Object({
      action: choices(["run", "record", "status"]),
      source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      colorScheme: Type.Optional(choices(["light", "dark"])),
      verdict: Type.Optional(Type.Array(Type.Object({ id: Type.String({ maxLength: 64 }), verdict: Type.String({ maxLength: 16 }), evidence: Type.Array(Type.String({ maxLength: 300 })) }), { minItems: 1, maxItems: 16 })),
      note: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async (params, ctx, signal) => {
      const { state } = sessionOf(ctx);
      const cwd = ctx.cwd as string;
      if (params.action === "run") {
        if (typeof params.source !== "string" || !params.source) throw new Error("visual_review run needs a source (local HTML/SVG path or http(s) URL)");
        const direction = state.direction ?? await readProjectDirection(cwd);
        const run = await visualReviewRun({ source: params.source, width: params.width, height: params.height, colorScheme: params.colorScheme, direction }, cwd, signal, capture);
        return { result: run, pixels: run.file };
      }
      if (params.action === "record") {
        if (typeof params.source !== "string" || !params.source) throw new Error("visual_review record needs the reviewed source");
        const verdict = normalizeVerdict(params.verdict);
        const receipt: VisualReceipt = {
          source: params.source, revision: await sourceRevision(params.source, cwd), at: Date.now(),
          sections: verdict.sections, blocking: verdict.blocking, improvements: verdict.improvements,
          ...(typeof params.note === "string" && params.note ? { note: params.note.slice(0, 1000) } : {}),
        };
        state.receipts = [...state.receipts, receipt].slice(-24);
        try { pi.appendEntry?.("creative-qa-v1", { action: "visual-record", source: receipt.source, revision: receipt.revision, blocking: receipt.blocking }); } catch { /* entries are optional */ }
        return { result: { recorded: { source: receipt.source, revision: receipt.revision, blocking: receipt.blocking, improvements: receipt.improvements }, gate: receipt.blocking ? "blocking verdicts hold completion until a clean re-review lands" : "no blocking verdict on this revision" } };
      }
      return { result: { receipts: state.receipts.slice(-12) } };
    }, 300_000);

  // ── ui_explore ──
  register("ui_explore",
    "Render the viewport/state matrix for a page (local HTML/SVG path or URL): mobile/tablet/desktop viewports × default, dark, reduced-motion and full-page states (bounded to 12 captures). Each cell reports DOM facts (overflow elements, missing alt, controls), rendered-pattern findings and load errors into .pi/ui-review with report.json. Viewport/state pixels, not interaction proof: keyboard, hover, menus and loading/empty/error flows need browser_session passes.",
    Type.Object({
      source: Type.String({ minLength: 1, maxLength: 4096 }),
      viewports: Type.Optional(Type.Array(choices(["mobile", "tablet", "desktop"]), { minItems: 1, maxItems: 4 })),
      states: Type.Optional(Type.Array(choices(["default", "dark", "reduced-motion", "full"]), { minItems: 1, maxItems: 4 })),
      widths: Type.Optional(Type.Array(Type.Integer({ minimum: 200, maximum: 2048 }), { minItems: 1, maxItems: 4 })),
      outputDir: Type.Optional(localPath),
    }),
    async (params, ctx, signal) => ({ result: await uiExploreRun(params, ctx.cwd as string, signal, capture) }), 600_000);

  // ── motion_inspect ──
  register("motion_inspect",
    "Inspect running motion as a system: enumerate main-frame CSS/WAAPI animations (target, timing, iterations, animated properties), render an ASCII timeline, and flag concurrency, transform-owner collisions, layout-property animation, duration soup, infinite loops and possible shared-target transform owners. Temporal QA samples animation-local clock frames; reduced-motion failures require unchanged infinite transform timing plus actual moving reduced-state pixels. Known equal-period loops get endpoint-parity evidence; arbitrary first/last samples cannot prove seams. Encoded-video cadence/loop QA uses media_info action motion. JS/rAF, scroll timelines and cross-frame choreography are out of scope and reported unknown.",
    Type.Object({
      source: Type.String({ minLength: 1, maxLength: 4096 }),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      durationMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 60000 })),
      samples: Type.Optional(Type.Integer({ minimum: 2, maximum: 9 })),
      reducedMotion: Type.Optional(Type.Boolean({ description: "Run the reduced-motion parity pass (default true)" })),
    }),
    async (params, ctx, signal) => {
      const { state } = sessionOf(ctx);
      const direction = state.direction ?? (await readProjectDirection(ctx.cwd as string).catch(() => undefined));
      const report = await motionInspectRun(params, ctx.cwd as string, signal, capture, direction);
      const key = `motion:${report.source}`;
      if (report.blocking > 0) state.blockingRuns.set(key, `motion: ${report.blocking} blocking finding(s) on ${report.source} (rev ${report.revision}): ${report.findings.filter((f: any) => f.severity === "FAIL").map((f: any) => f.id).join(", ")}`.slice(0, 280));
      else state.blockingRuns.delete(key);
      return { result: report };
    }, 600_000);

  // ── svg_inspect ──
  register("svg_inspect",
    "Measure SVG engineering: viewBox, bounds, stroke language, fills, defs (gradients, filters incl. default regions, masks, clipPaths), id collisions, unresolved fragment refs, transform stacks, accessibility, path complexity and optical center/padding/mass proxies. paths (2..24 files) adds set-consistency review flagging the sibling that drifted (stroke, corners, mass, center, padding, canvas). action review gives each file a score and verdict with fixes (clipped art, missing viewBox, hard-coded colour where currentColor belongs, node bloat, primitives drawn as paths, embedded rasters, live text, active content, size potential); optimize:true also writes a lossless cleaned copy to a fresh git-ignored folder after verifying shapes and bounds are unchanged (originals untouched). matrix rasterizes representative sizes with ink-coverage proxies for legibility judgment. Bounds apply translate/scale only; rotation stays approximate and is disclosed. Runs automatically on saved .svg files.",
    Type.Object({
      action: Type.Optional(choices(["inspect", "review", "matrix"])),
      path: Type.Optional(localPath),
      paths: Type.Optional(Type.Array(localPath, { minItems: 1, maxItems: 24 })),
      sizes: Type.Optional(Type.Array(Type.Integer({ minimum: 8, maximum: 1024 }), { minItems: 1, maxItems: 6 })),
      kind: Type.Optional(choices(["icon", "logo", "illustration"], "review: override the inferred kind")),
      optimize: Type.Optional(Type.Boolean({ description: "review: write verified lossless copies" })),
      precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: "review optimize: path decimals kept (default 3)" })),
      outputDir: Type.Optional(localPath),
    }),
    async (params, ctx, signal) => {
      const { state } = sessionOf(ctx);
      if (params.action === "review") return { result: await svgReviewRun(params, ctx.cwd as string) };
      if (params.action === "matrix") {
        if (typeof params.path !== "string" || !params.path) throw new Error("svg_inspect matrix needs path");
        return { result: await svgMatrixRun({ path: params.path, sizes: params.sizes }, ctx.cwd as string, signal, capture) };
      }
      const report = await svgInspectRun({ path: params.path, paths: params.paths }, ctx.cwd as string);
      for (const m of (report.measures as any[])) {
        const key = `svg:${m.file}`;
        if (m.activeContent?.length || m.unresolvedRefs?.length || m.idCollisions?.length) {
          state.blockingRuns.set(key, `svg: blocking geometry on ${m.file}: ${[...(m.activeContent ?? []), ...(m.unresolvedRefs ?? []).map((r: string) => `#${r}?`), ...(m.idCollisions ?? []).map((c: string) => `dup ${c}`)].slice(0, 3).join("; ")}`.slice(0, 280));
        } else state.blockingRuns.delete(key);
      }
      return { result: report };
    }, 300_000);

  // ── asset_register ──
  register("asset_register",
    "Record and reuse creative assets with provenance: role (hero-focal, editorial-support, diagram, texture, icon, illustration, background, product-shot, avatar), source kind, prompt, parent/variant chains, usage, license and description in workspace .pi/assets/registry.json. register validates inside-workspace files, hashes, header-sniffs dimensions and dedupes by content; search filters by role/kind/parent with lexical and palette-near matching; usage links an asset to its placement. inspect is read-only current-file evidence: local glTF/GLB resource containment and budgets, decoded mesh-local bounds/animation times, counts and required loaders; it does not render or approve art. sourceUrl/creator/licenseUrl preserve provenance. Generation tools register automatically.",
    Type.Object({
      action: choices(["register", "get", "search", "usage", "inspect"]),
      path: Type.Optional(localPath),
      id: Type.Optional(Type.String({ maxLength: 64 })),
      role: Type.Optional(choices(["hero-focal", "editorial-support", "diagram", "texture", "icon", "illustration", "background", "product-shot", "avatar", "generic"])),
      kind: Type.Optional(choices(["generated", "cropped", "traced", "authored", "plate", "captured"])),
      prompt: Type.Optional(Type.String({ maxLength: 2000 })),
      parent: Type.Optional(Type.String({ maxLength: 64 })),
      usage: Type.Optional(Type.Union([Type.String({ maxLength: 1024 }), Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 })])),
      license: Type.Optional(Type.String({ maxLength: 256 })),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      query: Type.Optional(Type.String({ maxLength: 200 })),
      paletteNear: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$", maxLength: 7 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      sourceImage: Type.Optional(Type.String({ maxLength: 1024 })),
      sourceUrl: Type.Optional(Type.String({ maxLength: 1024 })), creator: Type.Optional(Type.String({ maxLength: 200 })), licenseUrl: Type.Optional(Type.String({ maxLength: 1024 })),
    }),
    async (params, ctx, signal) => {
      const cwd = ctx.cwd as string;
      if (params.action === "inspect") { if (typeof params.path !== "string") throw new Error("asset_register inspect needs path"); return { result: await inspectAsset({ path: params.path }, cwd, signal) }; }
      if (params.action === "register") {
        if (isChild()) throw new Error("asset_register register is parent-only; children stay read-only.");
        normalizeAssetInput(params);
        const { record, duplicateOf } = await registerAsset(params as any, cwd);
        return { result: duplicateOf ? { duplicateOf, record } : { record } };
      }
      if (params.action === "get") {
        const registry = await readRegistry(await fs.realpath(cwd));
        const record = registry.assets.find((a) => a.id === params.id);
        if (!record) throw new Error(`Asset "${params.id}" is not registered`);
        return { result: { record } };
      }
      if (params.action === "search") {
        const registry = await readRegistry(await fs.realpath(cwd));
        return { result: { assets: searchAssets(registry, params), total: registry.assets.length } };
      }
      if (isChild()) throw new Error("asset_register usage is parent-only; children stay read-only.");
      if (typeof params.id !== "string" || !params.id) throw new Error("asset_register usage needs id");
      const location = Array.isArray(params.usage) ? params.usage[0] : params.usage;
      if (typeof location !== "string" || !location) throw new Error("asset_register usage needs a usage location");
      return { result: { record: await recordAssetUsage(cwd, params.id, location) } };
    }, 120_000);

  // ── image_generate ──
  register("image_generate",
    "Generative imagery inside the creative loop. status lists configured backend and available OpenRouter image models; generate/edit accept an explicit model from that catalog. Existing OpenRouter credentials enable that route when no backend is configured; PI_IMAGE_BACKEND/MODEL keep precedence. brief merges prompt, direction and role constraints without inference. Outputs are decode-verified and registered, with pixels returned for review. OpenRouter edit supplies a reference image; masks require openai-compatible. PI_IMAGE_API_URL/API_KEY optionally override configuration. Deterministic plates stay on image_create.",
    Type.Object({
      action: choices(["status", "brief", "generate", "edit"]),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact image model id; status lists the native OpenRouter catalog. PI_IMAGE_MODEL takes precedence when configured." })),
      prompt: Type.Optional(Type.String({ maxLength: 4000 })),
      path: Type.Optional(localPath),
      mask: Type.Optional(localPath),
      role: Type.Optional(choices(["hero-focal", "editorial-support", "diagram", "texture", "icon", "illustration", "background", "product-shot", "avatar", "generic"])),
      negative: Type.Optional(strList(16, 200)),
      aspect: Type.Optional(choices(["square", "landscape", "portrait"])),
      size: Type.Optional(Type.String({ maxLength: 32 })),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295 })),
      transparent: Type.Optional(Type.Boolean()),
      quality: Type.Optional(Type.String({ maxLength: 32 })),
    }),
    async (params, ctx, signal) => {
      const ownerSession = ctx.sessionManager?.getSessionId?.();
      const backendName = process.env.PI_IMAGE_BACKEND?.trim().toLowerCase();
      const providerKey = params.action !== "brief" && (!backendName || backendName === "openrouter") && !process.env.PI_IMAGE_API_KEY && !process.env.OPENROUTER_API_KEY
        ? await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter") : undefined;
      signal.throwIfAborted();
      if (params.action === "status") return { result: await imageBackendStatus(process.env, !!providerKey) };
      const { state } = sessionOf(ctx);
      const direction = state.direction ?? (await readProjectDirection(ctx.cwd as string).catch(() => undefined));
      if (params.action === "brief") return { result: buildGenerationBrief(direction, params) };
      const imageEnv = imageBackendEnvironment(process.env, !!providerKey, params.model);
      const usageId = randomUUID();
      const runtime = { providerKey, onUsage: (usage: unknown, status: string) => {
        if (ctx.sessionManager?.getSessionId?.() !== ownerSession) return;
        try { pi.appendEntry?.("auxiliary-model-usage-v1", { id: usageId, owner: "image-generate", provider: "openrouter", model: imageEnv.PI_IMAGE_MODEL?.trim().slice(0, 128), status, ...(usage === undefined ? {} : { usage }) }); } catch { /* accounting must not discard generated pixels */ }
      } };
      if (params.action === "generate") {
        const run = await imageGenerateRun(params, ctx.cwd as string, signal, direction, imageEnv, runtime);
        return { result: run, pixels: run.file };
      }
      const run = await imageEditRun(params as any, ctx.cwd as string, signal, direction, imageEnv, runtime);
      return { result: run, pixels: run.file };
    }, 300_000);

  // ── creative_compare ──
  register("creative_compare",
    "Compare 2..4 direction variants cheaply for design fusion: render each at the same width, build a side-by-side strip, and report pairwise structural deltas (SSIM, changed share, palette). Deltas measure difference, not quality — judge each variant against the creative brief, synthesize one direction, and record it with creative_direct set before building.",
    Type.Object({
      sources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 2, maxItems: 4 })),
      variants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 2, maxItems: 4 })),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
    }),
    async (params, ctx, signal) => {
      const { state } = sessionOf(ctx);
      const direction = state.direction ?? (await readProjectDirection(ctx.cwd as string).catch(() => undefined));
      const run = await creativeCompareRun(planCompare(params), ctx.cwd as string, signal, capture, direction);
      return { result: run, pixels: run.strip };
    }, 300_000);
}
