import { selectedMediaParams, planImageModel } from "./lib/media-model-routing.ts";
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
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  directionSummary, normalizeDirection, projectDirectionPath, readProjectDirection, renderDirectionBrief,
  type CreativeDirection,
} from "./lib/creative-direction.ts";
import {
  creativeCompareRun, creativeVerificationLines, normalizeVerdict, planCompare, planUiMatrix,
  sourceRevision, uiExploreRun, uiConsistencyRun, visualReviewRun,
  type QACapture, type VisualReceipt,
  localRenderPath,
} from "./lib/creative-qa.ts";
import { motionInspectRun } from "./lib/motion-inspect.ts";
import { svgInspectRun, svgMatrixRun } from "./lib/svg-inspect.ts";
import { svgReviewRun } from "./lib/svg-analysis.ts";
import { normalizeAssetInput, inspectAsset, readRegistry, recordAssetUsage, registerAsset, searchAssets } from "./lib/asset-registry.ts";
import { buildGenerationBrief, imageEditRun, imageGenerateRun, imageRecoverRun, imageBackendStatus, imageBackendEnvironment } from "./lib/image-generate.ts";
import { registerContinuationSource, resumesElsewhere } from "./lib/continuation-notice.ts";
import { createCreativeEvidence } from "./lib/creative-evidence.ts";
import { uiFileCue, uiPromptCue } from "./lib/ui-doctrine.ts";
import { createContextAnchor } from "./lib/context-anchor.ts";
import { isSessionStopped } from "./lib/session-stop.ts";
import { captureToFile } from "./render-and-wait.ts";
import { sniffImage } from "./lib/design-studio.ts";
import { choices } from "./lib/tool-schema.ts";
import { svgRender } from "./lib/svg-render.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const strList = (maxItems: number, maxLength: number) => Type.Array(Type.String({ maxLength }), { maxItems });
const IMAGE_ATTACH_CAP = 1_100_000;

interface SessionCreative {
  direction?: CreativeDirection;
  receipts: VisualReceipt[];
  blockingRuns: Map<string, string>;
  evidence: ReturnType<typeof createCreativeEvidence>;
  followups: number;
  autoSvgStamp?: string;
  browserOrigins: Map<string, { source: string; stamp: string }>;
  verifiedHashes: Map<string, string>;
  /** A delivered film's direction was reviewed with video_qa record. */
  mediaReviewed?: boolean;
}

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
  const sessions = new Map<string, SessionCreative>();
  let active: any, activeKey = '', epoch = 0, disposeNotice: (() => void) | undefined;
  const owner = Symbol('creative-session-owner');
  const assertOwner = (ctx: any) => { if (ctx[owner] !== undefined && ctx[owner] !== epoch) throw Error('Creative tool session changed; the late result cannot approve another session.'); };
  let observationTail = Promise.resolve();
  const anchor = createContextAnchor();
  const calls = new Map<string, { tool: string; input: any; session: any; epoch: number }>();
  const automatic = () => !['off', '0'].includes(process.env.PI_UI_VERIFICATION ?? 'on');
  const sourceKey = (source: string, cwd: string) => /^https?:\/\//i.test(source) ? new URL(source).href : path.relative(cwd, localRenderPath(cwd, source).replace(/[?#].*$/, '')).replaceAll('\\', '/');
  const sessionOf = (ctx: any): { sid: string; state: SessionCreative } => {
    assertOwner(ctx);
    const sid = JSON.stringify([path.resolve(ctx.cwd), ctx?.sessionManager?.getSessionId?.() ?? '']);
    let state = sessions.get(sid);
    if (!state) { state = { receipts: [], blockingRuns: new Map(), evidence: createCreativeEvidence(), followups: 0, browserOrigins: new Map(), verifiedHashes: new Map() }; sessions.set(sid, state); }
    while (sessions.size > 8) sessions.delete(sessions.keys().next().value!);
    if (activeKey !== sid || active?.sessionManager !== ctx.sessionManager) {
      disposeNotice?.(); active = ctx; activeKey = sid; epoch++;
      observationTail = Promise.resolve();
      const own = state;
      disposeNotice = registerContinuationSource({ name: 'creative', session: ctx.sessionManager,
        pending: () => automatic() && own.followups < 2 && own.evidence.gaps().length && !isSessionStopped(ctx) ? ['finish current UI and SVG verification'] : [],
        verification: () => [...(automatic() ? own.evidence.gaps() : []), ...creativeVerificationLines(own.receipts, own.direction, own.mediaReviewed), ...own.blockingRuns.values()],
        verificationReceipts: () => [...(automatic() ? own.evidence.verification() : []), ...[...creativeVerificationLines(own.receipts, own.direction, own.mediaReviewed), ...own.blockingRuns.values()].map(line => ({ id: line, revision: own.evidence.stamp(), state: 'unresolved', line }))].slice(0, 10).map(row => ({ source: 'creative', ...row, brief: row.line })),
      });
    }
    return { sid, state };
  };
  const hashFile = async (file: string, cwd: string, maxBytes = 4 * 1024 * 1024) => {
    const root = await fs.realpath(cwd), resolved = await fs.realpath(path.resolve(cwd, file));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('UI evidence requires an existing file inside the workspace.');
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > maxBytes) throw Error('UI evidence file exceeds its bounded read.');
    const bytes = await fs.readFile(resolved);
    return { file: relative.replaceAll('\\', '/'), hash: createHash('sha256').update(bytes).digest('hex'), content: bytes.subarray(0, 24000).toString('utf8') };
  };
  const refresh = async (ctx: any) => {
    const { state } = sessionOf(ctx);
    const ticket = epoch;
    for (const row of state.evidence.changed()) {
      let hash = 'unavailable';
      try { hash = (await hashFile(row.file, ctx.cwd)).hash; } catch (error: any) { if (error?.code === 'ENOENT') hash = 'missing'; }
      if (ticket !== epoch) return state;
      state.evidence.observe(row.file, hash, row.kind);
    }
    return state;
  };
  const observePaths = async (paths: string[], ctx: any) => {
    if (!automatic()) return;
    const { state } = sessionOf(ctx);
    const ticket = epoch;
    const candidates = paths.filter(file => /\.(?:svg|html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|twig|erb|hbs|php|phtml|[cm]?[jt]s)$/i.test(file));
    if (candidates.length > 64) state.evidence.incompleteChangeCoverage();
    for (const raw of candidates.slice(0, 64)) {
      try {
        const row = await hashFile(raw, ctx.cwd);
        if (ticket !== epoch) return;
        if (state.verifiedHashes.get(row.file) === row.hash) continue;
        if (/\.svg$/i.test(row.file) && !/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|skills|references)\//i.test(row.file)) state.evidence.observe(row.file, row.hash, 'svg');
        else if (uiFileCue(row.file, row.content) && (/\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|twig|erb|hbs|php|phtml)$/i.test(row.file) || /document\.createElement|\.innerHTML\s*=|React\.createElement/.test(row.content))) state.evidence.observe(row.file, row.hash, 'ui');
      } catch { /* the native mutation owner records unavailable paths */ }
    }
    if (ticket !== epoch) return;
    await refresh(ctx);
    if (ticket !== epoch) return;
    if (state.evidence.changed().length) pi.events?.emit?.('adaptive-pipeline-selection', { sessionManager: ctx.sessionManager, names: ['render_see', 'design_audit', 'ui_explore', 'visual_review', 'image_understand', 'browser_session', 'creative_direct', 'svg_inspect'] });
    const svgs = state.evidence.changed().filter(row => row.kind === 'svg').slice(0, 8);
    if (svgs.length && state.autoSvgStamp !== state.evidence.stamp()) {
      try {
        const report = await svgReviewRun({ paths: svgs.map(row => row.file) }, ctx.cwd);
        if (ticket !== epoch) return;
        for (const review of report.reviews) state.evidence.geometry(review.file, review.findings.filter(f => f.severity === 'high').length);
        state.autoSvgStamp = state.evidence.stamp();
        pi.appendEntry?.('creative-svg-auto-v1', { stamp: state.evidence.stamp(), reviews: report.reviews });
      } catch { /* gaps stay open; automatic checks never prevent the edit */ }
    }
  };
  for (const name of ['session_start', 'session_switch', 'session_tree', 'session_fork']) pi.on?.(name, (_event: any, ctx: any) => { epoch++; calls.clear(); observationTail = Promise.resolve(); if (ctx?.cwd) sessionOf(ctx); });
  pi.on?.('session_shutdown', () => { epoch++; calls.clear(); observationTail = Promise.resolve(); sessions.clear(); disposeNotice?.(); active = undefined; activeKey = ''; });
  pi.on?.('input', (event: any, ctx: any) => {
    if (event.source === 'extension' || !ctx?.cwd) return;
    const { state } = sessionOf(ctx);
    state.followups = 0;
    if (!state.evidence.gaps().length && !state.blockingRuns.size && !creativeVerificationLines(state.receipts, state.direction, state.mediaReviewed).length) {
      for (const row of state.evidence.changed()) state.verifiedHashes.set(row.file, row.hash);
      while (state.verifiedHashes.size > 64) state.verifiedHashes.delete(state.verifiedHashes.keys().next().value!);
      state.evidence = createCreativeEvidence();
      state.browserOrigins.clear();
    }
  });
  pi.on?.('before_agent_start', (event: any, ctx: any) => {
    if (!automatic() || !ctx?.cwd) return;
    sessionOf(ctx);
    if (uiPromptCue(String(event.prompt ?? '')).strength !== 'strong') return;
    return { systemPrompt: `${event.systemPrompt ?? ''}\nUI work: inspect the existing product, real content, user tasks, tokens and component states before choosing a direction. Derive hierarchy, type, color, spacing and purposeful motion from the subject and requested ambition. Avoid template gradients, fake proof, decorative status and arbitrary SVGs. Use ui_explore for 320px/mobile/tablet/desktop measurements, visual_review for current rendered judgment, and browser_session for keyboard/focus and the representative task. Repair observed defects before completion. On text-only routes use permitted image_understand for the capture; report unavailable vision explicitly. Skills are optional references. Measurements and clean source cannot prove appearance.` };
  });
  pi.on?.('context', async (event: any, ctx: any) => {
    if (!automatic() || !ctx?.cwd) return;
    const ticket = epoch;
    await observationTail;
    if (ticket !== epoch) return;
    const state = await refresh(ctx), gaps = state.evidence.gaps();
    if (ticket !== epoch) return;
    const messages = event.messages.filter((m: any) => m.customType !== 'creative-verification-context');
    if (!gaps.length) return messages.length !== event.messages.length ? { messages } : undefined;
    return { messages: anchor(messages, { role: 'custom', customType: 'creative-verification-context', content: `[UI verification on the current revision]\n${gaps.join('\n')}\nUse current captures; fix actual defects. Do not repeat unchanged checks or substitute source analysis for pixels. If a required route is unavailable, disclose the specific limit.`, display: false }, state.evidence.stamp()) };
  });
  pi.on?.('tool_call', async (event: any, ctx: any) => {
    if (!automatic() || !ctx?.cwd || typeof event.toolCallId !== 'string') return;
    const ticket = epoch;
    await observationTail;
    if (ticket !== epoch) return;
    calls.set(event.toolCallId, { tool: event.toolName, input: event.input ?? {}, session: ctx.sessionManager, epoch });
    while (calls.size > 128) calls.delete(calls.keys().next().value!);
  });
  pi.on?.('tool_result', async (event: any, ctx: any) => {
    const call = calls.get(event.toolCallId);
    if (!call || call.tool !== event.toolName || call.session !== ctx?.sessionManager || call.epoch !== epoch) return;
    calls.delete(event.toolCallId);
    const committed = event.details?.fileMutation?.resolved;
    if ((!event.isError || committed) && ['write', 'edit'].includes(event.toolName) && typeof (committed ?? call.input.path) === 'string') await observePaths([committed ?? call.input.path], ctx);
    if (call.epoch !== epoch) return;
    const state = await refresh(ctx);
    if (event.isError || call.epoch !== epoch) return;
    // A film's direction is reviewed against its delivered frames with video_qa
    // record. visual_review's page rubric rejects raster media, so requiring it
    // held finished videos open through repeated failing review calls.
    if (event.toolName === 'video_qa' && call.input.action === 'record') state.mediaReviewed = true;
    if (event.toolName === 'image_understand' && event.details?.observations && event.details?.provider && !event.details?.truncated) {
      for (const image of event.details.images ?? []) if (typeof image.hash === 'string' && !image.region) state.evidence.vision(image.hash);
    }
    if (event.toolName === 'read' && ctx.model?.input?.includes('image') && event.content?.some((part: any) => part.type === 'image')) {
      try { state.evidence.vision((await hashFile(call.input.path, ctx.cwd, 20 * 1024 * 1024)).hash); } catch { /* unmatched pixels cannot certify a run */ }
    }
    if (event.toolName === 'browser_session' && event.details?.ok === true && typeof event.details.url === 'string') {
      const action = call.input.action === 'press' && ['Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape'].includes(call.input.key) ? 'keyboard' : call.input.action;
      const handle = JSON.stringify([event.details.session, event.details.tab]);
      if (typeof event.details.session === 'string' && ['open', 'new_tab', 'navigate', 'reload'].includes(action)) {
        const source = typeof call.input.url === 'string' ? sourceKey(call.input.url, ctx.cwd) : state.browserOrigins.get(handle)?.source;
        if (source) state.browserOrigins.set(handle, { source, stamp: state.evidence.stamp() });
        while (state.browserOrigins.size > 8) state.browserOrigins.delete(state.browserOrigins.keys().next().value!);
      }
      if (action !== 'verify' || event.details.verification?.matches === true) {
        state.evidence.interaction(event.details.url, action, event.details.pageIdentity);
        const origin = state.browserOrigins.get(handle);
        if (origin?.stamp === state.evidence.stamp() && typeof event.details.pageIdentity === 'string') state.evidence.interaction(origin.source, action);
      }
      if (action === 'close') state.browserOrigins.delete(handle);
    }
  });
  // The shared bus deliberately emits without awaiting listeners. Retain this
  // owner's bounded observation work so shell/bulk writes cannot race a model
  // context or the completion gate. Do not change the bus or run another scan.
  const observeEvent = (event: any, workspace: boolean) => {
    if (!automatic() || !event.ctx?.cwd || event.ctx.sessionManager !== active?.sessionManager) return;
    const ticket = epoch, ctx = { ...event.ctx, [owner]: epoch };
    const job = observationTail.then(async () => {
      if (ticket !== epoch) return;
      if (workspace) sessionOf(ctx).state.evidence.workspace(`${event.revision}:${event.tree ?? 'unknown'}:${event.complete === true}`);
      await observePaths(event.paths ?? [], ctx);
    });
    observationTail = job.catch(() => {});
    return job;
  };
  pi.events?.on?.('harness:mutation-committed', (event: any) => observeEvent(event, false));
  pi.events?.on?.('project-source-observed', (event: any) => observeEvent(event, true));
  pi.on?.('agent_settled', async (_event: any, ctx: any) => {
    if (!automatic() || !ctx?.cwd || isSessionStopped(ctx) || resumesElsewhere(ctx.sessionManager) || ctx.hasPendingMessages?.()) return;
    const ticket = epoch;
    await observationTail;
    if (ticket !== epoch) return;
    const state = await refresh(ctx), gaps = state.evidence.gaps();
    if (ticket !== epoch || isSessionStopped(ctx)) return;
    if (!gaps.length || state.followups >= 2) return;
    state.followups++;
    await pi.sendMessage?.({ customType: 'creative-verification-followup', content: `Complete current UI/SVG verification (${state.followups}/2 bounded follow-ups):\n${gaps.join('\n')}\nRepair demonstrated defects; retain current evidence. If vision, browser or serving access is unavailable, report the exact gap and stop retrying unchanged failures.`, display: false }, { deliverAs: 'followUp', triggerTurn: true });
  });

  function register(name: string, description: string, parameters: any, handler: (params: any, ctx: any, signal: AbortSignal) => Promise<{ result: any; pixels?: string }>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const cwd = ctx?.cwd || process.cwd();
        sessionOf({ ...ctx, cwd });
        const ticket = epoch;
        await observationTail;
        assertOwner({ [owner]: ticket });
        const { result, pixels } = await handler(params, { ...ctx, cwd, [owner]: ticket }, bounded);
        bounded.throwIfAborted();
        if (ticket !== epoch) throw Error('Creative tool session changed; the late result cannot approve another session.');
        const content: any[] = [];
        if (pixels) {
          const image = await maybePixels(pixels, cwd, ctx);
          assertOwner({ [owner]: ticket });
          if (image) {
            content.push(image);
            const state = sessionOf(ctx).state;
            const hash = (await hashFile(pixels, cwd, 20 * 1024 * 1024)).hash;
            assertOwner({ [owner]: ticket });
            state.evidence.vision(hash);
          }
          else result.pixels = `${pixels} (open with read/vision: this model was not served pixels inline)`;
        }
        content.unshift({ type: 'text', text: JSON.stringify(result) });
        return { content, details: result };
      },
    });
  }

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
        state.evidence.direction(JSON.stringify(direction));
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
      else { delete state.direction; state.evidence.direction('null'); }
      return { result: { cleared: scope } };
    }, 30_000);

  // ── visual_review ──
  register("visual_review",
    "Review actual rendered output. run captures HTML/SVG or a URL and returns runId, rubric sections, measured defects and needsVision gaps. record requires that current runId, every rubric section and delivered pixels or matching image_understand evidence for visual judgments. Repair measured FAILs or supply specific dismissals. UNKNOWN and stale evidence keep completion open. status shows current gaps. Use ui_explore for responsive states and browser_session for actual interaction.",
    Type.Object({
      action: choices(["run", "record", "status"]),
      source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      colorScheme: Type.Optional(choices(["light", "dark"])),
      entrypoint: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Workspace UI entry file represented by this served URL; binds compiled/served captures to changed HTML when source is a URL' })),
      runId: Type.Optional(Type.String({ maxLength: 64 })),
      dismissals: Type.Optional(Type.Array(Type.Object({ id: Type.String({ maxLength: 64 }), reason: Type.String({ minLength: 20, maxLength: 600 }) }), { maxItems: 16 })),
      verdict: Type.Optional(Type.Array(Type.Object({ id: Type.String({ maxLength: 64 }), verdict: Type.String({ maxLength: 16 }), evidence: Type.Array(Type.String({ maxLength: 300 })) }), { minItems: 1, maxItems: 16 })),
      note: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async (params, ctx, signal) => {
      const state = await refresh(ctx);
      const cwd = ctx.cwd as string;
      if (params.action === "run") {
        if (typeof params.source !== "string" || !params.source) throw new Error("visual_review run needs a source (local HTML/SVG path or http(s) URL)");
        const direction = state.direction ?? await readProjectDirection(cwd);
        state.evidence.direction(JSON.stringify(direction ?? null));
        const surface = params.entrypoint ? (await hashFile(params.entrypoint, cwd)).file : undefined;
        assertOwner(ctx);
        const stamp = state.evidence.stamp();
        const responsive = state.evidence.responsive(surface ?? (state.evidence.changed().some(row => row.file === sourceKey(params.source, cwd)) ? sourceKey(params.source, cwd) : 'application'));
        const run = await visualReviewRun({ source: params.source, width: params.width, height: params.height, colorScheme: params.colorScheme, direction, responsive }, cwd, signal, capture);
        await refresh(ctx);
        state.evidence.run({ ...run, source: sourceKey(run.source, cwd), surface } as any, (await hashFile(run.file, cwd, 20 * 1024 * 1024)).hash, false, stamp);
        return { result: run, pixels: run.file };
      }
      if (params.action === "record") {
        if (typeof params.source !== "string" || !params.source) throw new Error("visual_review record needs the reviewed source");
        const verdict = state.evidence.record({ runId: params.runId, source: sourceKey(params.source, cwd), revision: await sourceRevision(params.source, cwd), verdict: params.verdict, dismissals: params.dismissals });
        const receipt: VisualReceipt = {
          source: params.source, revision: await sourceRevision(params.source, cwd), at: Date.now(),
          sections: verdict.sections, blocking: verdict.blocking, improvements: verdict.improvements,
          ...(typeof params.note === "string" && params.note ? { note: params.note.slice(0, 1000) } : {}),
        };
        state.receipts = [...state.receipts, receipt].slice(-24);
        try { pi.appendEntry?.("creative-qa-v1", { action: "visual-record", source: receipt.source, revision: receipt.revision, blocking: receipt.blocking }); } catch { /* entries are optional */ }
        return { result: { recorded: { source: receipt.source, revision: receipt.revision, blocking: receipt.blocking, improvements: receipt.improvements }, gate: receipt.blocking ? "blocking verdicts hold completion until a clean re-review lands" : "no blocking verdict on this revision" } };
      }
      return { result: { receipts: state.receipts.slice(-12), revision: state.evidence.stamp(), gaps: state.evidence.gaps() } };
    }, 300_000);

  // ── ui_explore ──
  register("ui_explore",
    "Render a responsive device/state matrix: defaults to narrow 320px, mobile 390px, tablet and desktop. Optional devices add touch/DPR phone portrait/landscape, tablet and desktop profiles; breakpoints probe b-1/b/b+1 widths. Default, dark, reduced-motion and full-page states share 12 captures, requested widths before variants, with every omitted combination disclosed. Returns a pixel contact sheet, document hashes, actual device/media behavior, DOM geometry, controls/names, alt/load status, measured contrast, design patterns, errors and incomplete coverage. Inspect the contact sheet; keyboard, menus and loading/error tasks require browser_session.",
    Type.Object({
      source: Type.String({ minLength: 1, maxLength: 4096 }),
      entrypoint: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Workspace UI entry file represented by the served URL' })),
      viewports: Type.Optional(Type.Array(choices(["narrow", "mobile", "tablet", "desktop"]), { minItems: 1, maxItems: 4 })),
      states: Type.Optional(Type.Array(choices(["default", "dark", "reduced-motion", "full"]), { minItems: 1, maxItems: 4 })),
      widths: Type.Optional(Type.Array(Type.Integer({ minimum: 200, maximum: 2048 }), { minItems: 1, maxItems: 4 })),
      devices: Type.Optional(Type.Array(choices(["phone-portrait","phone-landscape","tablet-portrait","desktop"]),{minItems:1,maxItems:4})),
      breakpoints: Type.Optional(Type.Array(Type.Integer({minimum:201,maximum:2047}),{minItems:1,maxItems:4,description:'CSS breakpoints; capture the immediate width on either side as well as the breakpoint'})),
      outputDir: Type.Optional(localPath),
    }),
    async (params, ctx, signal) => {
      const state = await refresh(ctx);
      const direction = state.direction ?? await readProjectDirection(ctx.cwd);
      state.evidence.direction(JSON.stringify(direction ?? null));
      const surface = params.entrypoint ? (await hashFile(params.entrypoint, ctx.cwd)).file : sourceKey(params.source, ctx.cwd);
      assertOwner(ctx);
      const stamp = state.evidence.stamp();
      const result = await uiExploreRun(params, ctx.cwd as string, signal, capture);
      await refresh(ctx);
      const hash = result.preview ? (await hashFile(result.preview, ctx.cwd, 20 * 1024 * 1024)).hash : '';
      state.evidence.matrix(surface, result, stamp, hash);
      return { result, pixels: result.preview };
    }, 600_000);

  register("ui_consistency",
    "Compare shared design tokens and component roles across 2..4 local pages or HTTP(S) routes at the same viewport/theme. Explicit selectorGroups identify shared roles; data-ui-role and body/h1/navigation provide defaults. Declare intentional variants with selectorGroups.variant or data-ui-variant. Optional tokens names CSS custom properties; otherwise bounded style-token names are discovered at :root. Captures, document/source hashes and detailed snapshots use the existing isolated renderer and .pi/ui-review report. Returns measured drift and missing/truncated coverage, never an aesthetic score or interaction approval. Read-only page inspection; no component or token edits.",
    Type.Object({
      sources:Type.Array(Type.String({minLength:1,maxLength:4096}),{minItems:2,maxItems:4}),
      selectorGroups:Type.Optional(Type.Array(Type.Object({name:Type.String({pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'}),selector:Type.String({minLength:1,maxLength:256}),variant:Type.Optional(Type.String({pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'}))}),{minItems:1,maxItems:12})),
      tokens:Type.Optional(Type.Array(Type.String({pattern:'^--[A-Za-z_][A-Za-z0-9_-]{0,63}$'}),{minItems:1,maxItems:24})),
      width:Type.Optional(Type.Integer({minimum:200,maximum:2048})),height:Type.Optional(Type.Integer({minimum:200,maximum:2048})),
      colorScheme:Type.Optional(choices(['light','dark'])),outputDir:Type.Optional(localPath),
    }),async(params,ctx,signal)=>({result:await uiConsistencyRun(params,ctx.cwd as string,signal,capture)}),180_000);

  // ── motion_inspect ──
  register("motion_inspect",
    "Inspect running motion with mode:time (default), scroll or render. time inventories and seeks CSS/WAAPI/SMIL clocks in one loaded document. render explicitly awaits the native video window.renderFrame(seconds) clock to inspect reusable canvas/SVG/web choreography; it never guesses or installs a clock. scroll observes actual progress and backtracking in one live document with JS/rAF and scroll timelines running. Reduced-motion passes, retained screenshots, coverage, source/document changes and runtime errors accompany findings. Incomplete coverage cannot approve motion. Samples are not playback, FPS, GPU cost or appearance proof; encoded-video cadence uses media_info action motion.",
    Type.Object({
      source: Type.String({ minLength: 1, maxLength: 4096 }),
      mode:Type.Optional(choices(['time','scroll','render'])),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048 })),
      durationMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 60000 })),
      samples: Type.Optional(Type.Integer({ minimum: 2, maximum: 9 })),
      reducedMotion: Type.Optional(Type.Boolean({ description: "Run the reduced-motion parity pass (default true)" })),
      positions:Type.Optional(Type.Array(Type.Number({minimum:0,maximum:1}),{minItems:2,maxItems:8,description:'scroll: strictly increasing normalized document progress'})),
      backtrack:Type.Optional(Type.Boolean({description:'scroll: return through prior positions in the same document (default true)'})),
      settleMs:Type.Optional(Type.Integer({minimum:0,maximum:1000,description:'scroll: wait before each observation; frame timing remains unknown'})),
      selectors:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:256}),{minItems:1,maxItems:12,description:'scroll: observed sticky/pinned/content targets; missing selectors remain unknown'})),
    }),
    async (params, ctx, signal) => {
      const { state } = sessionOf(ctx);
      const direction = state.direction ?? (await readProjectDirection(ctx.cwd as string).catch(() => undefined));
      const report = await motionInspectRun(params, ctx.cwd as string, signal, capture, direction);
      const key = `motion:${report.source}:${params.mode ?? 'time'}`;
      if (report.coverage?.complete === false) state.blockingRuns.set(key, `motion: incomplete ${params.mode ?? 'time'} capture on ${report.source} (rev ${report.revision}); inspect coverage, errors and reduced-motion results`.slice(0,280));
      else if (report.blocking > 0) state.blockingRuns.set(key, `motion: ${report.blocking} blocking finding(s) on ${report.source} (rev ${report.revision}): ${report.findings.filter((f: any) => f.severity === "FAIL").map((f: any) => f.id).join(", ")}`.slice(0, 280));
      else state.blockingRuns.delete(key);
      return { result: report };
    }, 600_000);

  register("svg_render", "Render raw or saved SVG to timestamped PNG frames or deterministic H.264 video. Preflight validates XML, namespaces, IDs, path/affine-transform grammar and bounded keyframes. CSS/WAAPI, SMIL and data tracks share an absolute-time clock; each property needs one owner. No arbitrary JS or external assets. Returns editable source/tracks, samples, contact sheet, grouped approximate clipping observations and decoded-video cadence/loop QA. Audio may attach a local narration/music mix to video. PNG frames support transparency; video requires a matte. Inspect actual pixels/playback before approval.",
    Type.Object({ path: Type.Optional(localPath), svg: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })), mode: Type.Optional(choices(["frames", "video"])), times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 30 }), { minItems: 1, maxItems: 12 })), duration: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })), fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 1080 })), background: Type.Optional(Type.String({ pattern: "^(transparent|#[0-9a-fA-F]{6})$" })), audio: Type.Optional(localPath), reducedMotion: Type.Optional(Type.Boolean()), loop: Type.Optional(Type.Boolean()), tracks: Type.Optional(Type.Array(Type.Object({ target: Type.String({ minLength: 1, maxLength: 128 }), property: choices(["x", "y", "cx", "cy", "r", "rx", "ry", "width", "height", "opacity", "fill", "stroke", "stroke-width", "stroke-dashoffset", "transform", "d", "viewBox"]), keys: Type.Array(Type.Object({ time: Type.Number({ minimum: 0, maximum: 30 }), value: Type.Union([Type.Number(), Type.String({ maxLength: 8192 })]), ease: Type.Optional(choices(["linear", "smooth", "hold"])) }), { minItems: 2, maxItems: 64 }) }), { maxItems: 64 })), outputDir: Type.Optional(localPath) }),
    async (params, ctx, signal) => { const result = await svgRender(params, ctx.cwd as string, signal); return { result, pixels: result.contactSheet.path }; }, 240000);

  // ── svg_inspect ──
  register("svg_inspect",
    "Measure SVG engineering: viewBox, bounds, stroke language, fills, defs (gradients, filters incl. default regions, masks, clipPaths), id collisions, unresolved fragment refs, transform stacks, accessibility, path complexity and optical center/padding/mass proxies. paths (2..24 files) adds set-consistency review flagging the sibling that drifted (stroke, corners, mass, center, padding, canvas). action review gives each file a score and verdict with fixes (clipped art, missing viewBox, hard-coded colour where currentColor belongs, node bloat, primitives drawn as paths, embedded rasters, live text, active content, size potential); optimize:true also writes a lossless cleaned copy to a fresh git-ignored folder after verifying shapes and bounds are unchanged (originals untouched). matrix rasterizes representative sizes with ink-coverage proxies for legibility judgment. Bounds apply translate, scale, rotation, skew and matrix transforms; sampled curves and unsupported paint retain explicit approximation limits. Runs automatically on saved .svg files.",
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
      if (params.action === "review") {
        await refresh(ctx);
        const report = await svgReviewRun(params, ctx.cwd as string);
        for (const review of report.reviews) state.evidence.geometry(review.file, review.findings.filter(f => f.severity === 'high').length);
        return { result: report };
      }
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
    "Generative imagery inside the creative loop. /models Images sets an independent default. plan checks live capabilities and conservative pricing without generation. model:auto chooses a compatible fixed-price endpoint within maxCostUsd; no paid retry or model fallback. status lists the bundled OpenRouter image catalog; refresh:true discovers its current Images API models for transport:images. generate/edit accept an exact model overriding the environment for this call. edit supports path or 1..5 references, inputFidelity on supported models, and validated transparent PNG masks with openai-compatible. GPT Image requests omit unsupported legacy response_format/seed. Format/compression/transparency/quality are explicit. recover with path to a retained download.json downloads its saved URL without generation credentials or another generation request; original usage is retained. Outputs are decode-verified, registered and returned for review; no cheaper fallback or paid retry is selected automatically.",
    Type.Object({
      action: choices(["status", "brief", "plan", "generate", "edit", "recover"]),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Exact model id or openrouter/auto; /models Images supplies the default" })),
      maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 500, description: "Native OpenRouter preflight cap; automatic choice defaults to $0.25 for one image. Unknown token/megapixel costs cannot pass this cap." })),
      refresh: Type.Optional(Type.Boolean({ description: "status: fetch current OpenRouter Images API catalog" })),
      transport: Type.Optional(choices(["chat", "images"], "OpenRouter: existing chat-image route (default), or native Images API")),
      prompt: Type.Optional(Type.String({ maxLength: 4000 })),
      path: Type.Optional(localPath),
      references: Type.Optional(Type.Array(localPath, { minItems: 1, maxItems: 5 })),
      mask: Type.Optional(localPath),
      role: Type.Optional(choices(["hero-focal", "editorial-support", "diagram", "texture", "icon", "illustration", "background", "product-shot", "avatar", "generic"])),
      negative: Type.Optional(strList(16, 200)),
      aspect: Type.Optional(choices(["square", "landscape", "portrait"])),
      aspectRatio: Type.Optional(Type.String({ pattern: "^(auto|[1-9][0-9]?:[1-9][0-9]?)$", description: "OpenRouter ratio, e.g.16:9; use size or aspectRatio" })), resolution: Type.Optional(choices(["512", "1K", "2K", "4K"], "OpenRouter resolution; must be supported by the chosen model")), size: Type.Optional(Type.String({ maxLength: 32 })),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295 })),
      transparent: Type.Optional(Type.Boolean()),
      quality: Type.Optional(Type.String({ maxLength: 32 })),
      format: Type.Optional(choices(["png", "jpeg", "webp"])),
      compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      inputFidelity: Type.Optional(choices(["low", "high"])),
    }),
    async (params, ctx, signal) => {
      if (params.action === 'recover') { const run = await imageRecoverRun(params, ctx.cwd as string, signal); return { result: run, pixels: run.file }; }
      params = selectedMediaParams(params, 'image', ctx.mediaModels);
      const selectedBackend = params.mediaProvider;
      const imageBaseEnv = { ...process.env, ...(selectedBackend ? { PI_IMAGE_BACKEND: selectedBackend } : {}), ...(params.model ? { PI_IMAGE_MODEL: params.model } : {}) };
      if (selectedBackend && selectedBackend !== process.env.PI_IMAGE_BACKEND) {
        delete imageBaseEnv.PI_IMAGE_API_URL; delete imageBaseEnv.PI_IMAGE_API_KEY;
      }
      if (selectedBackend === 'openrouter' && params.model === 'auto' && params.maxCostUsd === undefined) params.maxCostUsd = .25;
      const ownerSession = ctx.sessionManager?.getSessionId?.();
      const backendName = imageBaseEnv.PI_IMAGE_BACKEND?.trim().toLowerCase();
      const providerKey = params.action !== "brief" && (!backendName || backendName === "openrouter") && !imageBaseEnv.PI_IMAGE_API_KEY && !process.env.OPENROUTER_API_KEY
        ? await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter") : undefined;
      signal.throwIfAborted();
      if (params.action === "status") return { result: await imageBackendStatus(imageBaseEnv, !!providerKey, { refresh: params.refresh, key: imageBaseEnv.PI_IMAGE_API_KEY ?? process.env.OPENROUTER_API_KEY ?? providerKey, signal }) };
      const { state } = sessionOf(ctx);
      const direction = state.direction ?? (await readProjectDirection(ctx.cwd as string).catch(() => undefined));
      if (params.action === "brief") return { result: buildGenerationBrief(direction, params) };
      if (params.action === 'plan') return { result: await planImageModel({ ...params, model: params.model ?? imageBaseEnv.PI_IMAGE_MODEL ?? 'auto' }, signal) };
      const imageEnv = imageBackendEnvironment(imageBaseEnv, !!providerKey, params.model);
      let usageModel = imageEnv.PI_IMAGE_MODEL;
      const usageId = randomUUID();
      const runtime = { providerKey, onModel: (model: string) => { usageModel = model; }, onUsage: (usage: unknown, status: string) => {
        if (ctx.sessionManager?.getSessionId?.() !== ownerSession) return;
        try { pi.appendEntry?.("auxiliary-model-usage-v1", { id: usageId, owner: "image-generate", provider: imageEnv.PI_IMAGE_BACKEND === "openrouter" ? "openrouter" : "openai-compatible", model: usageModel?.trim().slice(0, 128), status, ...(usage === undefined ? {} : { usage }) }); } catch { /* accounting must not discard generated pixels */ }
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
