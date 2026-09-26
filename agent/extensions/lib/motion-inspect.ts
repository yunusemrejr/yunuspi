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
import type { CreativeDirection } from "./creative-direction.ts";

export interface AnimationDescriptor {
  index: number;
  kind: string;
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

const sanitizeDescriptors = (raw: unknown): AnimationDescriptor[] => {
  if (!Array.isArray(raw)) return [];
  const out: AnimationDescriptor[] = [];
  for (const entry of raw.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const durationMs = num(e.durationMs);
    const delayMs = num(e.delayMs) ?? 0;
    const iterations = e.iterations === "infinite" ? "infinite" as const : Math.max(1, Math.floor(Number(e.iterations) || 1));
    out.push({
      index: out.length,
      kind: String(e.kind ?? "unknown").slice(0, 32),
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
  reducedMotion: { full: number; reduced: number; ignored: boolean };
  findings: MotionFinding[];
}

/** Deterministic timeline analysis. Pure. Reduced-motion "ignored" is set
 * only when the reduced pass reports the same live animations as the full
 * pass; anything subtler stays a WARN for rendered judgment. */
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
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let running = 0, maxConcurrent = 0;
  for (const [, delta] of events) { running += delta; maxConcurrent = Math.max(maxConcurrent, running); }

  const infinite = descriptors.filter((d) => d.iterations === "infinite");
  const transformOwners = [...new Set(descriptors.filter((d) => d.properties.includes("transform") || d.properties.includes("translate") || d.properties.includes("rotate") || d.properties.includes("scale")).map((d) => d.target))];
  const layoutAnimations = descriptors.filter((d) => d.properties.some((p) => LAYOUT_PROPS.has(p.toLowerCase()))).map((d) => `${d.target} (${d.properties.filter((p) => LAYOUT_PROPS.has(p.toLowerCase())).join(", ")})`);
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
  if (transformOwners.length >= 3) findings.push({ severity: "WARN", id: "transform-owners", detail: `${transformOwners.length} animation owners touch transform: ${transformOwners.slice(0, 5).join("; ")}`, evidence: transformOwners.slice(0, 8) });
  if (layoutAnimations.length) findings.push({ severity: "WARN", id: "layout-props", detail: `${layoutAnimations.length} animation(s) drive layout-triggering properties (jank risk): ${layoutAnimations.slice(0, 4).join("; ")}`, evidence: layoutAnimations.slice(0, 8) });
  if (distinctDurations.length > 6) findings.push({ severity: "WARN", id: "duration-soup", detail: `${distinctDurations.length} distinct durations (${distinctDurations.slice(0, 8).join(", ")}ms…) — no shared timing scale`, evidence: distinctDurations.slice(0, 12).map((v) => `${v}ms`) });

  const ignored = descriptors.length > 0 && reduced.length === descriptors.length;
  if (descriptors.length > 0 && reduced.length > 0) {
    findings.push({
      severity: ignored ? "FAIL" : "WARN", id: "reduced-motion",
      detail: ignored
        ? `prefers-reduced-motion ignored: all ${descriptors.length} animation(s) still run under reduce`
        : `${reduced.length} of ${descriptors.length} animation(s) still run under prefers-reduced-motion — verify the calm equivalent covers them`,
      evidence: reduced.slice(0, 6).map((d) => `${d.target} kind=${d.kind}`),
    });
  }
  return {
    count: descriptors.length, infinite: infinite.length, maxConcurrent, distinctDurations,
    transformOwners, layoutAnimations,
    reducedMotion: { full: descriptors.length, reduced: reduced.length, ignored },
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

const relative = (cwd: string, file: string) => { const r = path.relative(cwd, file); return r.startsWith("..") ? file : r; };

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
  if (params.reducedMotion !== false) {
    try {
      const reducedFile = path.join(dir, "inventory-reduced.png");
      const receipt = await capture({ source: params.source, width, height, fullPage: false, timeoutMs: 30_000, includeState: true, animationInventory: true, reducedMotion: "reduce" }, reducedFile, cwd, signal);
      reducedInventory = receipt?.animationInventory ?? receipt?.conditions?.animationSample?.descriptors ?? [];
    } catch (error: any) {
      if (signal?.aborted) throw error;
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
  const dead = samples.filter((s) => s.flag === "dead");
  const jumps = samples.filter((s) => s.flag === "jump");
  if (analysis.count > 0 && dead.length >= Math.ceil((samples.length - 1) / 2)) temporal.push({ severity: "WARN", id: "dead-time", detail: `${dead.length} of ${samples.length - 1} sampled intervals show no pixel change — dead time or animation outside the sampled clock (JS/rAF, scroll)`, evidence: dead.slice(0, 5).map((s) => `t=${s.timeMs}ms Δ=${s.meanDelta}`) });
  for (const jump of jumps.slice(0, 3)) temporal.push({ severity: "WARN", id: "jump", detail: `t=${jump.timeMs}ms: large ${(jump.changedShare! * 100).toFixed(1)}% discontinuity — likely jump cut rather than intentional motion; verify against frames`, evidence: [jump.file] });
  if (analysis.infinite > 0 && frames.length >= 2) {
    const first = frames[0].img, last = frames[frames.length - 1].img;
    const h = Math.min(first.height, last.height);
    const { comparison } = compareImages(
      { width: first.width, height: h, data: first.data.subarray(0, first.width * h * 4) },
      { width: last.width, height: h, data: last.data.subarray(0, last.width * h * 4) },
    );
    if (comparison.changed > 0.02) temporal.push({ severity: "WARN", id: "loop-seam", detail: `first/last sampled frames differ (${(comparison.changed * 100).toFixed(1)}% changed) — loop seam or non-looping content inside an infinite run`, evidence: [frames[0].file, frames[frames.length - 1].file] });
  }

  const strip = composeRow(frames.map((f) => f.img), 8);
  const stripPath = path.join(dir, "sequence.png");
  await fs.writeFile(stripPath, await encodeImage(strip, "png", { maxWidth: 2400 }, signal), { flag: "wx" });

  const findings = [...analysis.findings, ...temporal];
  const report = {
    source: params.source, revision: await sourceRevision(params.source, cwd), at: new Date().toISOString(),
    dir: relative(cwd, dir), durationMs, sampledClock: "CSS/WAAPI document timeline only; JS/rAF, scroll timelines, frames and not-yet-created animations are invisible to sampling",
    inventory: { count: analysis.count, infinite: analysis.infinite, maxConcurrent: analysis.maxConcurrent, distinctDurationsMs: analysis.distinctDurations, transformOwners: analysis.transformOwners, layoutAnimations: analysis.layoutAnimations, reducedMotion: analysis.reducedMotion },
    timeline: renderMotionTimeline(sanitizeDescriptors(fullInventory), durationMs),
    descriptors: sanitizeDescriptors(fullInventory).slice(0, 40),
    samples: samples.map((s) => ({ ...s })),
    sequence: relative(cwd, stripPath),
    findings,
    blocking: findings.filter((f) => f.severity === "FAIL").length,
    note: "Timeline + sampled pixels, not playback proof: easing feel, velocity continuity, overshoot character and focal hierarchy over time need the sequence plus real playback judgment. Focal targets moving during interaction and focus-stranding need a browser_session pass.",
  };
  await fs.writeFile(path.join(dir, "timeline.json"), JSON.stringify({ ...report, descriptors: report.descriptors }, null, 1) + "\n", { flag: "wx" });
  return report;
}
