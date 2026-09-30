/**
 * Motion inspection — animation inventory plus temporal QA over sampled
 * frames. Pure timeline analysis plus a bounded capture runner.
 *
 * WHY: motion guidance ("deterministic timelines") never inspects the
 * running page, so agents ship forever-loops, layout-thrashing keyframes
 * and ignored prefers-reduced-motion. The capture script enumerates the
 * main-frame document-timeline animations (CSS + WAAPI) with timing and
 * animated properties; this module turns that inventory into a timeline,
 * concurrency/owner/property findings, and sampled-frame analysis (dead
 * time, jumps, loop seams, reduced-motion behavior). JS/rAF systems,
 * scroll timelines and cross-frame choreography stay out of scope and are
 * reported as unknown, never inferred.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodeImage } from "./design-studio.ts";
import { compareImages, composeRow, type Rgba } from "./image-analysis.ts";
import { qaFolder, sourceRevision, type QACapture } from "./creative-qa.ts";
import { relativeOrAbsolute } from "./path-safety.ts";
import type { CreativeDirection } from "./creative-direction.ts";

export interface AnimationDescriptor {
  index: number;
  kind: string;
  playState: string;
  target: string;
  durationMs: number | null;
  delayMs: number;
  endMs: number | null;
  iterations: number | "infinite";
  playbackRate: number;
  properties: string[];
}

export interface MotionFinding {
  severity: "FAIL" | "WARN";
  id: string;
  detail: string;
  evidence: string[];
}

const LAYOUT_PROPS = new Set([
  "width", "height", "top", "left", "right", "bottom",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "font-size", "line-height",
]);

const propertyName = (p: string) => p.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).toLowerCase();

const sanitizeDescriptors = (raw: unknown): AnimationDescriptor[] => {
  if (!Array.isArray(raw)) return [];
  const out: AnimationDescriptor[] = [];
  for (const entry of raw.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const durationMs = num(e.durationMs);
    const delayMs = num(e.delayMs) ?? 0;
    const iterations = e.iterations === "infinite" ? "infinite" as const : Math.max(0, Math.min(10_000, typeof e.iterations === "number" && Number.isFinite(e.iterations) ? e.iterations : 1));
    out.push({
      index: out.length,
      kind: String(e.kind ?? "unknown").slice(0, 32),
      playState: ["running", "paused", "finished", "idle"].includes(String(e.playState)) ? String(e.playState) : "unknown",
      target: String(e.target ?? "?").slice(0, 120),
      durationMs: durationMs === null ? null : Math.max(0, Math.min(600_000, durationMs)),
      delayMs: Math.max(-600_000, Math.min(600_000, delayMs)),
      endMs: durationMs === null || iterations === "infinite" ? null : delayMs + durationMs * iterations,
      iterations,
      playbackRate: num(e.playbackRate) ?? 1,
      properties: Array.isArray(e.properties) ? e.properties.map(String).map((p) => p.slice(0, 48)).slice(0, 12) : [],
    });
  }
  return out;
};

/** ASCII timeline of animation activity. Pure. Infinite animations run to
 * the right edge with a continuation marker. */
export function renderMotionTimeline(descriptors: readonly AnimationDescriptor[], durationMs: number, width = 56): string {
  const total = Math.max(1, durationMs);
  descriptors = sanitizeDescriptors(descriptors as unknown);
  const lines = [`Motion timeline  0ms ${"─".repeat(Math.max(8, width - 16))} ${total}ms`];
  for (const d of descriptors.slice(0, 24)) {
    const start = Math.max(0, Math.min(1, d.delayMs / total));
    const end = d.endMs === null ? 1 : Math.max(start, Math.min(1, d.endMs / total));
    const from = Math.floor(start * width), to = d.endMs === null ? width : Math.max(from + 1, Math.ceil(end * width));
    const bar = " ".repeat(from) + "█".repeat(Math.max(0, to - from)) + (d.endMs === null ? "→" : "");
    lines.push(`${d.target.slice(0, 22).padEnd(22)} ${bar.slice(0, width + 1)}${d.iterations === "infinite" ? " ∞" : ""}`);
  }
  if (descriptors.length > 24) lines.push(`… ${descriptors.length - 24} more`);
  return lines.join("\n").slice(0, 4000);
}

export interface TimelineAnalysis {
  count: number;
  infinite: number;
  maxConcurrent: number;
  distinctDurations: number[];
  transformOwners: string[];
  layoutAnimations: string[];
  reducedMotion: { full: number; reduced: number; ignored: boolean; unchangedInventory: boolean };
  findings: MotionFinding[];
}

/** Deterministic timeline analysis. Pure. Reduced-motion inventory parity is advisory; blocking ignored-preference
 * findings require retained infinite transform timing and changing reduced
 * pixels from the capture runner. */
export function analyzeMotionTimeline(raw: unknown, options: { reduced?: unknown; direction?: CreativeDirection } = {}): TimelineAnalysis {
  const descriptors = sanitizeDescriptors(raw);
  const reduced = sanitizeDescriptors(options.reduced);
  const findings: MotionFinding[] = [];

  // Sweep-line concurrency over finite animations; infinite ones overlap all.
  const events: Array<[number, number]> = [];
  for (const d of descriptors) {
    const start = Math.max(0, d.delayMs);
    if (d.endMs === null) { events.push([start, 1]); }
    else if (d.endMs > start) { events.push([start, 1], [d.endMs, -1]); }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0, maxConcurrent = 0;
  for (const [, delta] of events) { running += delta; maxConcurrent = Math.max(maxConcurrent, running); }

  const infinite = descriptors.filter((d) => d.iterations === "infinite");
  const transformOwners = [...new Set(descriptors.filter((d) => d.properties.includes("transform") || d.properties.includes("translate") || d.properties.includes("rotate") || d.properties.includes("scale")).map((d) => d.target))];
  const layoutAnimations = descriptors.filter((d) => d.properties.some((p) => LAYOUT_PROPS.has(propertyName(p)))).map((d) => `${d.target} (${d.properties.filter((p) => LAYOUT_PROPS.has(propertyName(p))).join(", ")})`);
  const distinctDurations = [...new Set(descriptors.map((d) => d.durationMs).filter((v): v is number => v !== null).map((v) => Math.round(v)))].sort((a, b) => a - b);

  if (infinite.length) {
    findings.push({
      severity: "WARN", id: "continuous-motion",
      detail: `${infinite.length} animation(s) repeat forever: ${infinite.slice(0, 5).map((d) => d.target).join("; ")}`,
      evidence: infinite.slice(0, 5).map((d) => `${d.target} kind=${d.kind} duration=${d.durationMs ?? "?"}ms`),
    });
    const continuous = options.direction?.motion?.continuous;
    if (continuous === false) findings.push({ severity: "WARN", id: "direction-continuous", detail: "direction forbids continuous motion but infinite animations run", evidence: infinite.slice(0, 3).map((d) => d.target) });
  }
  if (maxConcurrent > 12) findings.push({ severity: "WARN", id: "too-many-concurrent", detail: `${maxConcurrent} concurrent moving elements at peak; entrances compete instead of guiding the eye`, evidence: [`peak concurrency ${maxConcurrent} across ${descriptors.length} animations`] });
  const possibleCollisions = transformOwners.filter(target => descriptors.filter(d => d.target === target && d.properties.some(p => ["transform", "translate", "rotate", "scale"].includes(p))).length > 1);
  if (possibleCollisions.length) findings.push({ severity: "WARN", id: "transform-owners", detail: "Multiple transform animations share target labels; inspect overlapping property owners. Labels may identify separate elements with the same classes.", evidence: possibleCollisions.slice(0, 8) });
  if (layoutAnimations.length) findings.push({ severity: "WARN", id: "layout-props", detail: `${layoutAnimations.length} animation(s) drive layout-triggering properties (jank risk): ${layoutAnimations.slice(0, 4).join("; ")}`, evidence: layoutAnimations.slice(0, 8) });
  if (distinctDurations.length > 6) findings.push({ severity: "WARN", id: "duration-soup", detail: `${distinctDurations.length} distinct durations (${distinctDurations.slice(0, 8).join(", ")}ms…) — no shared timing scale`, evidence: distinctDurations.slice(0, 12).map((v) => `${v}ms`) });

  const signature = (items: AnimationDescriptor[]) => items.map(d => JSON.stringify([d.target, d.kind, d.playState, d.durationMs, d.delayMs, d.iterations, d.playbackRate, [...d.properties].sort()])).sort().join("|");
  const unchangedInventory = descriptors.length > 0 && signature(descriptors) === signature(reduced);
  // Inventory parity alone cannot establish that reduction is ignored: opacity,
  // shorter duration, paused timelines and static summaries can retain animations.
  const ignored = false;
  if (reduced.some(d => d.durationMs === null || d.durationMs > 80)) findings.push({
    severity: "WARN", id: "reduced-motion", detail: unchangedInventory
      ? "Reduced-motion inventory retains equivalent animation timing; compare actual reduced-state pixels before calling the preference ignored."
      : "Reduced-motion retains animations; verify the calm equivalent, useful controls and message in rendered frames.",
    evidence: reduced.slice(0, 6).map(d => `${d.target} duration=${d.durationMs ?? "?"}ms`),
  });
  return {
    count: descriptors.length, infinite: infinite.length, maxConcurrent, distinctDurations,
    transformOwners, layoutAnimations,
    reducedMotion: { full: descriptors.length, reduced: reduced.length, ignored, unchangedInventory },
    findings,
  };
}

export interface MotionSample {
  timeMs: number;
  file: string;
  changedShare: number | null;
  meanDelta: number | null;
  ssim: number | null;
  flag: "ok" | "dead" | "jump";
}

const relative = (cwd: string, file: string): string => relativeOrAbsolute(cwd, file);

export async function motionInspectRun(
  params: { source: string; width?: unknown; height?: unknown; durationMs?: unknown; samples?: unknown; reducedMotion?: unknown },
  cwd: string, signal: AbortSignal | undefined, capture: QACapture, direction?: CreativeDirection,
) {
  if (typeof params.source !== "string" || !params.source) throw new Error("motion_inspect needs a source (local HTML/SVG path or http(s) URL)");
  const width = Math.max(200, Math.min(2048, Math.round(Number(params.width) || 1280)));
  const height = Math.max(200, Math.min(2048, Math.round(Number(params.height) || 800)));
  const dir = await qaFolder(undefined, cwd, "motion", "timeline");

  // Inventory first: full pass plus a reduced-motion pass for parity.
  const probeFile = path.join(dir, "inventory.png");
  const full = await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, includeState: true, animationInventory: true }, probeFile, cwd, signal);
  const fullInventory: unknown = full?.animationInventory ?? full?.conditions?.animationSample?.descriptors ?? [];
  let reducedInventory: unknown = [];
  let reducedPass: "disabled" | "checked" | "failed" = params.reducedMotion === false ? "disabled" : "failed";
  let reducedError: string | undefined;
  if (params.reducedMotion !== false) {
    try {
      const reducedFile = path.join(dir, "inventory-reduced.png");
      const receipt = await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, includeState: true, animationInventory: true, reducedMotion: "reduce" }, reducedFile, cwd, signal);
      reducedPass = "checked";
      reducedInventory = receipt?.animationInventory ?? receipt?.conditions?.animationSample?.descriptors ?? [];
    } catch (error: any) {
      if (signal?.aborted) throw error;
      reducedError = String(error?.message ?? error).slice(0, 200);
    }
  }
  const analysis = analyzeMotionTimeline(fullInventory, { reduced: reducedInventory, direction });
  const finiteEnds = sanitizeDescriptors(fullInventory).map((d) => d.endMs).filter((v): v is number => v !== null);
  const durationMs = params.durationMs !== undefined
    ? Math.max(200, Math.min(60_000, Math.round(Number(params.durationMs) || 0)))
    : Math.max(800, Math.min(12_000, Math.round(Math.max(...finiteEnds, 2000))));
  const sampleCount = Math.max(2, Math.min(9, Math.round(Number(params.samples) || 6)));

  // Temporal QA: sample the deterministic CSS/WAAPI clock across the run.
  const times = Array.from({ length: sampleCount }, (_, i) => Math.round((durationMs * i) / (sampleCount - 1)));
  const frames: Array<{ timeMs: number; file: string; img: Rgba }> = [];
  for (const timeMs of times) {
    signal?.throwIfAborted();
    const dest = path.join(dir, `t-${String(timeMs).padStart(5, "0")}.png`);
    await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, animationTimeMs: timeMs }, dest, cwd, signal);
    frames.push({ timeMs, file: relative(cwd, dest), img: await decodeImage(await fs.readFile(dest), { maxWidth: 960, maxPixels: 4_000_000 }, signal) });
  }
  const samples: MotionSample[] = frames.map((frame, i) => {
    if (!i) return { timeMs: frame.timeMs, file: frame.file, changedShare: null, meanDelta: null, ssim: null, flag: "ok" as const };
    const prev = frames[i - 1].img, cur = frame.img;
    const h = Math.min(prev.height, cur.height);
    const { comparison } = compareImages(
      { width: prev.width, height: h, data: prev.data.subarray(0, prev.width * h * 4) },
      { width: cur.width, height: h, data: cur.data.subarray(0, cur.width * h * 4) },
    );
    const changedShare = Math.round(comparison.changed * 10_000) / 10_000;
    const meanDelta = Math.round(comparison.meanDelta * 100) / 100;
    const ssim = Math.round(comparison.ssim * 1000) / 1000;
    const flag = changedShare < 0.002 && meanDelta < 0.4 ? "dead" : changedShare > 0.5 && meanDelta > 20 ? "jump" : "ok";
    return { timeMs: frame.timeMs, file: frame.file, changedShare, meanDelta, ssim, flag };
  });

  const temporal: MotionFinding[] = [];
  if (reducedPass === "failed") temporal.push({ severity: "WARN", id: "reduced-motion-unverified", detail: "Reduced-motion capture failed; preference handling remains unknown.", evidence: [reducedError ?? "capture unavailable"] });
  let reducedPixels: { changedShare: number; meanDelta: number; files: string[] } | undefined;
  if (reducedPass === "checked" && analysis.count > 0) {
    const reducedFrames: Array<{ file: string; img: Rgba }> = [];
    for (const timeMs of [0, Math.min(durationMs, 333)]) {
      const dest = path.join(dir, `reduce-${timeMs}.png`);
      await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, animationTimeMs: timeMs, reducedMotion: "reduce" }, dest, cwd, signal);
      reducedFrames.push({ file: relative(cwd, dest), img: await decodeImage(await fs.readFile(dest), { maxWidth: 960, maxPixels: 4_000_000 }, signal) });
    }
    const { comparison } = compareImages(reducedFrames[0].img, reducedFrames[1].img);
    reducedPixels = { changedShare: Math.round(comparison.changed * 10_000) / 10_000, meanDelta: Math.round(comparison.meanDelta * 100) / 100, files: reducedFrames.map(f => f.file) };
    const retainedInfiniteTransform = sanitizeDescriptors(reducedInventory).some(d => d.iterations === "infinite" && d.playState === "running" && d.playbackRate !== 0 && d.properties.some(p => ["transform", "translate", "rotate", "scale"].includes(p)));
    if (analysis.reducedMotion.unchangedInventory && retainedInfiniteTransform && comparison.changed > .002 && comparison.meanDelta > .4) {
      analysis.reducedMotion.ignored = true;
      temporal.push({ severity: "FAIL", id: "reduced-motion-moving-loop", detail: "Equivalent infinite transform animations retain visible pixel changes under reduce. Provide a static state or explicit playback control and recheck.", evidence: reducedPixels.files });
    }
  }
  const dead = samples.filter((s) => s.flag === "dead");
  const jumps = samples.filter((s) => s.flag === "jump");
  if (analysis.count > 0 && dead.length >= Math.ceil((samples.length - 1) / 2)) temporal.push({ severity: "WARN", id: "dead-time", detail: `${dead.length} of ${samples.length - 1} sampled intervals show no pixel change — same loop phase, an intentional hold or animation outside the sampled clock (JS/rAF, scroll); inspect playback`, evidence: dead.slice(0, 5).map((s) => `t=${s.timeMs}ms Δ=${s.meanDelta}`) });
  for (const jump of jumps.slice(0, 3)) temporal.push({ severity: "WARN", id: "jump", detail: `t=${jump.timeMs}ms: large ${(jump.changedShare! * 100).toFixed(1)}% difference between sparse frames; motion and intentional cuts can both explain it, so inspect playback`, evidence: [jump.file] });
  // A random run endpoint is not a loop boundary. Seek the explicit local
  // period only when every infinite animation shares a known duration/offset.
  const loops = sanitizeDescriptors(fullInventory).filter(d => d.iterations === "infinite");
  const period = loops[0]?.durationMs;
  let loopBoundary: { periodMs: number; files: string[]; changedShare: number } | undefined;
  if (loops.length && period && loops.every(d => d.durationMs === period && d.delayMs === 0) && period <= 60_000) {
    const loopFrames: Array<{ file: string; img: Rgba }> = [];
    for (const timeMs of [0, period]) {
      const dest = path.join(dir, `loop-${timeMs}.png`);
      await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, animationTimeMs: timeMs }, dest, cwd, signal);
      loopFrames.push({ file: relative(cwd, dest), img: await decodeImage(await fs.readFile(dest), { maxWidth: 960, maxPixels: 4_000_000 }, signal) });
    }
    const { comparison } = compareImages(loopFrames[0].img, loopFrames[1].img);
    loopBoundary = { periodMs: period, files: loopFrames.map(f => f.file), changedShare: Math.round(comparison.changed * 10_000) / 10_000 };
    // Sampling exactly at the restart establishes endpoint parity, not velocity
    // continuity or a near-boundary jump. Report this narrow fact accurately.
    if (comparison.changed > .02) temporal.push({ severity: "WARN", id: "loop-endpoint-parity", detail: "Frames at 0 and one known local loop period differ; finite content or unstable page state may explain it. Inspect the boundary in playback.", evidence: loopBoundary.files });
  }

  const strip = composeRow(frames.map((f) => f.img), 8);
  const stripPath = path.join(dir, "sequence.png");
  await fs.writeFile(stripPath, await encodeImage(strip, "png", { maxWidth: 2400 }, signal), { flag: "wx" });

  const findings = [...analysis.findings, ...temporal];
  const report = {
    source: params.source, revision: await sourceRevision(params.source, cwd), at: new Date().toISOString(),
    dir: relative(cwd, dir), durationMs, sampledClock: "CSS/WAAPI document timeline only; JS/rAF, scroll timelines, frames and not-yet-created animations are invisible to sampling; each animation is sought to its own local time",
    inventory: { count: analysis.count, infinite: analysis.infinite, maxConcurrent: analysis.maxConcurrent, distinctDurationsMs: analysis.distinctDurations, transformOwners: analysis.transformOwners, layoutAnimations: analysis.layoutAnimations, reducedMotion: analysis.reducedMotion },
    timeline: renderMotionTimeline(sanitizeDescriptors(fullInventory), durationMs),
    descriptors: sanitizeDescriptors(fullInventory).slice(0, 40),
    samples: samples.map((s) => ({ ...s })),
    reducedPass, reducedPixels: reducedPixels ?? null, loopBoundary: loopBoundary ?? null,
    sequence: relative(cwd, stripPath),
    findings,
    blocking: findings.filter((f) => f.severity === "FAIL").length,
    note: "Timeline + sampled pixels, not playback proof: easing feel, velocity continuity, overshoot character and focal hierarchy over time need the sequence plus real playback judgment. Focal targets moving during interaction and focus-stranding need a browser_session pass.",
  };
  await fs.writeFile(path.join(dir, "timeline.json"), JSON.stringify({ ...report, descriptors: report.descriptors }, null, 1) + "\n", { flag: "wx" });
  return report;
}
