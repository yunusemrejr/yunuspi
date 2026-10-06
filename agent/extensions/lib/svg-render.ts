/** Render authored SVG on an explicit clock. CSS + SMIL + data keyframes;
 * no arbitrary scripts, external assets, network or wall-clock frame sampling. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { inspectSvg } from "./svg-check.ts";
import { readSvg } from "./svg-inspect.ts";
import { studioFolder } from "./design-studio.ts";
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, probe, produced, requireStream, run } from "./media-process.ts";
import { createRenderQueue } from "./render-queue.ts";
import { contactSheet } from "./video-studio.ts";
import { videoMotion } from "./video-motion.ts";

const require = createRequire(new URL("../../npm/package.json", import.meta.url));
const queue = createRenderQueue(4);
const ATTRIBUTES = ["x", "y", "cx", "cy", "r", "rx", "ry", "width", "height", "opacity", "fill", "stroke", "stroke-width", "stroke-dashoffset", "transform", "d", "viewBox"];
const scalar = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Pure absolute-time interpolation, also embedded verbatim in the browser.
 * Same-topology path/transform numbers interpolate; colors interpolate RGB. */
export function sampleSvgValue(keys: any[], time: number): string {
  if (time <= keys[0].time) return String(keys[0].value);
  if (time >= keys.at(-1).time) return String(keys.at(-1).value);
  const i = keys.findIndex(key => key.time > time), a = keys[i - 1], b = keys[i];
  let t = (time - a.time) / (b.time - a.time);
  if (a.ease === "hold") t = 0;
  if (a.ease === "smooth") t = t * t * (3 - 2 * t);
  const start = String(a.value), end = String(b.value);
  if (/^#[\da-f]{6}$/i.test(start) && /^#[\da-f]{6}$/i.test(end)) return "#" + [1, 3, 5].map(j => Math.round(parseInt(start.slice(j, j + 2), 16) * (1 - t) + parseInt(end.slice(j, j + 2), 16) * t).toString(16).padStart(2, "0")).join("");
  const pattern = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  const other = end.match(pattern)?.map(Number) ?? [];
  let n = 0;
  return start.replace(pattern, value => String(Number((Number(value) * (1 - t) + other[n++] * t).toFixed(6))));
}

export function planSvgRender(params: any) {
  const mode = params.mode ?? "frames";
  if (!["frames", "video"].includes(mode)) throw Error("mode must be frames or video");
  const width = integer(params.width, 640, 64, 1920, "width"), height = integer(params.height, 640, 64, 1080, "height");
  const fps = integer(params.fps, 30, 1, 60, "fps"), duration = number(params.duration, 3, 0.1, 30, "duration");
  const background = params.background ?? "#ffffff";
  if (background !== "transparent" && !/^#[\da-f]{6}$/i.test(background)) throw Error("background must be transparent or #rrggbb");
  if (mode === "video" && (width % 2 || height % 2)) throw Error("H.264 video needs even width and height");
  if (mode === "video" && background === "transparent") throw Error("H.264 has no alpha; choose a background or render transparent PNG frames");
  if (params.reducedMotion !== undefined && typeof params.reducedMotion !== "boolean") throw Error("reducedMotion must be boolean");
  if (params.loop !== undefined && typeof params.loop !== "boolean") throw Error("loop must be boolean");
  if (mode === "video" && params.times !== undefined) throw Error("times requires frames mode");
  if (mode === "frames" && params.audio !== undefined) throw Error("audio requires video mode");
  const times = mode === "video" ? Array.from({ length: Math.ceil(duration * fps) }, (_, i) => i / fps) : params.times ?? [0];
  if (!Array.isArray(times) || !times.length || (mode === "frames" && times.length > 12) || times.length > 900 || times.some(t => typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > duration)) throw Error("Use 1..12 frame times within duration, or a video of at most 900 frames");
  if (times.length * width * height > 600000000) throw Error("SVG render exceeds 600M pixel-frames; reduce size, fps or duration");
  return { mode, width, height, fps, duration, times, background, reducedMotion: params.reducedMotion === true, loop: params.loop === true };
}

async function validateSvgTracks(svg: string, value: unknown, duration: number) {
  const { parseDocument } = await import("htmlparser2");
  const document = parseDocument(svg, { xmlMode: true });
  const ids = new Set<string>();
  const walk = (node: any) => { if (node.attribs?.id) ids.add(node.attribs.id); for (const child of node.children ?? []) walk(child); };
  walk(document);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw Error("tracks accepts at most 64 entries");
  let total = 0;
  const owners = new Set<string>();
  for (const track of value) {
    if (!track || typeof track.target !== "string" || !ids.has(track.target)) throw Error("Each SVG track target must name an existing element id");
    if (!ATTRIBUTES.includes(track.property)) throw Error(`Unsupported SVG track property: ${track.property}`);
    const owner = `${track.target}:${track.property}`;
    if (owners.has(owner)) throw Error(`Duplicate SVG track owner ${owner}`);
    owners.add(owner);
    if (!Array.isArray(track.keys) || track.keys.length < 2 || track.keys.length > 64) throw Error("SVG tracks need 2..64 keys each");
    total += track.keys.length;
    if (total > 512) throw Error("SVG tracks exceed 512 keys");
    let last = -1, topology: string | undefined;
    for (const key of track.keys) {
      if (!key || typeof key.time !== "number" || !Number.isFinite(key.time) || key.time < 0 || key.time > duration || key.time <= last) throw Error("SVG keys need strictly increasing times inside duration");
      last = key.time;
      if (key.ease !== undefined && !["linear", "smooth", "hold"].includes(key.ease)) throw Error("SVG key ease must be linear, smooth or hold");
      if (typeof key.value !== "string" && typeof key.value !== "number") throw Error("SVG key values must be numeric or strings");
      const text = String(key.value);
      if (text.length > 8192 || /[<>;&\x00-\x1f]|url\s*\(/i.test(text)) throw Error("Unsafe or oversized SVG track value");
      const color = /^#[\da-f]{6}$/i.test(text);
      if ((track.property === "fill" || track.property === "stroke") && !color) throw Error("Animated SVG colors must be #rrggbb");
      const shape = color ? "color" : text.replace(scalar, "#");
      const nums = color ? [] : text.match(scalar)?.map(Number) ?? [];
      if (!color && (!nums.length || nums.some(n => !Number.isFinite(n) || Math.abs(n) > 1000000))) throw Error("SVG track numbers must be finite and bounded");
      if (!["fill", "stroke", "d", "transform", "viewBox"].includes(track.property) && (nums.length !== 1 || !/^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?(?:px|%)?$/.test(text))) throw Error("SVG scalar attributes need one numeric value with an optional px/% unit");
      if (["r", "rx", "ry", "width", "height", "stroke-width"].includes(track.property) && nums[0] < 0) throw Error("SVG dimensions and stroke widths cannot be negative");
      if (track.property === "viewBox" && (nums.length !== 4 || nums[2] <= 0 || nums[3] <= 0 || /[^\d\s.,eE+\-]/.test(text))) throw Error("viewBox keys need x y positive-width positive-height");
      if (topology !== undefined && topology !== shape) throw Error("SVG path/transform key values must keep identical topology; use separate tracks for other changes");
      if (track.property === "d" && /[aA]/.test(text)) throw Error("Arc path morphing needs flag-aware geometry; convert arcs to cubics before animating d");
      if (track.property === "opacity" && (nums.length !== 1 || nums[0] < 0 || nums[0] > 1)) throw Error("Opacity keys must be 0..1");
      topology = shape;
    }
  }
  return value;
}

function svgRuntime(tracks: any[], sample: typeof sampleSvgValue) {
  const root = document.querySelector("svg")!;
  const collisions = tracks.filter(track => {
    const target = document.getElementById(track.target)!;
    return target.getAnimations().some(animation => animation.effect?.getKeyframes().some(frame => track.property in frame)) || [...target.children].some(child => ["animate", "animateTransform", "set"].includes(child.localName) && child.getAttribute("attributeName") === track.property);
  }).map(track => `${track.target}:${track.property}`);
  return (time: number) => {
    for (const svg of document.querySelectorAll("svg")) { svg.pauseAnimations(); svg.setCurrentTime(time); }
    const animations = document.getAnimations();
    for (const animation of animations) { if (animation.timeline !== document.timeline) throw Error("Scroll/view timeline cannot be sampled by the SVG export clock"); animation.pause(); animation.currentTime = time * 1000; }
    for (const track of tracks) document.getElementById(track.target)!.setAttribute(track.property, sample(track.keys, time));
    const box = root.getBoundingClientRect();
    const clipped: string[] = [];
    for (const element of root.querySelectorAll("path,rect,circle,ellipse,text,polygon,polyline,line,use")) {
      if (element.closest("defs,clipPath,mask,marker,pattern,symbol")) continue;
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || !bounds.width || !bounds.height) continue;
      if (bounds.left < box.left - 1 || bounds.top < box.top - 1 || bounds.right > box.right + 1 || bounds.bottom > box.bottom + 1) clipped.push(element.id || element.tagName);
    }
    return { time, cssAnimations: animations.length, smilAnimations: root.querySelectorAll("animate,animateTransform,animateMotion,set").length, programmaticTracks: tracks.length, ownerCollisions: collisions, clipped: clipped.slice(0, 12), clippingApproximate: true };
  };
}

export async function prepareSvgSource(params: any, cwd: string) {
  const plan = planSvgRender(params);
  if ((params.path === undefined) === (params.svg === undefined)) throw Error("Provide path or raw svg, exactly one");
  const xml = params.path === undefined ? params.svg : (await readSvg(params.path, cwd)).xml;
  if (typeof xml !== "string") throw Error("svg must be source text");
  const source = await inspectSvg(xml);
  const forbidden = source.findings.filter(f => f.severity === "error" || ["active-content", "event-handler", "external-reference"].includes(f.key));
  if (forbidden.length) throw Error(`SVG render preflight: ${forbidden.map(f => `${f.key}: ${f.message}`).join("; ").slice(0, 1500)}`);
  const tracks = await validateSvgTracks(xml, params.tracks, plan.duration);
  return { xml, tracks, plan };
}

export async function svgRender(params: any, cwd: string, signal?: AbortSignal) {
  const { xml, tracks, plan } = await prepareSvgSource(params, cwd);
  const audio = params.audio === undefined ? undefined : await inputFile(params.audio, cwd);
  if (audio) requireStream(await probe(audio, signal), "audio");
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const release = await queue(bounded);
  let browser: any, dir: string | undefined;
  const close = () => { void browser?.close().catch(() => {}); };
  bounded.addEventListener("abort", close, { once: true });
  try {
    bounded.throwIfAborted();
    const { chromium } = require("playwright");
    browser = await chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? "chrome", headless: true, chromiumSandbox: true, timeout: 15000, args: ["--disable-gpu"] });
    bounded.throwIfAborted();
    const context = await browser.newContext({ viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false, permissions: [], reducedMotion: plan.reducedMotion ? "reduce" : "no-preference" });
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; object-src 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${plan.background}}body>svg{display:block;width:100%;height:100%}</style><body></body>`;
    await context.route("**/*", (route: any) => route.request().url() === "http://yunuspi-svg.invalid/" && route.request().isNavigationRequest() ? route.fulfill({ status: 200, contentType: "text/html", body: html }) : route.abort());
    const page = await context.newPage();
    await page.goto("http://yunuspi-svg.invalid/", { waitUntil: "load", timeout: 15000 });
    // Parse as XML (HTML's forgiving recovery is not validity evidence).
    await page.evaluate((xml: string) => {
      const parsed = new DOMParser().parseFromString(xml, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw Error("SVG source is not well-formed XML");
      if ([parsed.documentElement, ...parsed.querySelectorAll("*")].some(element => element.namespaceURI !== "http://www.w3.org/2000/svg" || ["script", "foreignObject"].includes(element.localName) || [...element.attributes].some(attr => /^on/i.test(attr.localName)))) throw Error("SVG export accepts inert SVG namespace elements only");
      document.body.append(document.importNode(parsed.documentElement, true));
    }, xml);
    // DevTools evaluates only harness-owned functions and serialized data.
    // No eval() in the document and no weakening of the page's script CSP.
    await page.evaluate(`window.__svgRender = (${svgRuntime.toString()})(${JSON.stringify(tracks)}, (${sampleSvgValue.toString()}))`);
    await page.evaluate(() => document.fonts.ready);
    dir = await studioFolder(params.outputDir, cwd, "svg-render");
    await fs.writeFile(path.join(dir, "source.svg"), xml, { flag: "wx" });
    await fs.writeFile(path.join(dir, "tracks.json"), JSON.stringify(tracks, null, 2) + "\n", { flag: "wx" });
    const frameDir = path.join(dir, "frames"); await fs.mkdir(frameDir);
    const diagnostics: any[] = [], frames: any[] = [];
    let totalBytes = 0;
    for (let i = 0; i < plan.times.length; i++) {
      bounded.throwIfAborted();
      const diagnostic = await page.evaluate((time: number) => (window as any).__svgRender(time), plan.times[i]);
      if (i === 0 || diagnostic.clipped.length || diagnostic.ownerCollisions.length) diagnostics.push({ frame: i, ...diagnostic });
      const output = path.join(frameDir, `${String(i).padStart(6, "0")}.png`);
      const bytes = await page.screenshot({ type: "png", omitBackground: plan.background === "transparent", timeout: 20000 });
      totalBytes += bytes.length;
      if (totalBytes > 512 * 1024 * 1024) throw Error("SVG frames exceed the 512 MiB disk budget");
      await fs.writeFile(output, bytes, { flag: "wx" });
      frames.push({ ...await produced(output), time: plan.times[i] });
    }
    await browser.close(); browser = undefined;
    let video: any, output: any, motion: any;
    if (plan.mode === "video") {
      const file = path.join(dir, "animation.mp4"), args = [...FFMPEG_FLAGS, "-v", "error", "-framerate", String(plan.fps), "-i", path.join(frameDir, "%06d.png")];
      if (audio) args.push(...inputArgs(audio, 0));
      args.push("-map", "0:v:0");
      if (audio) args.push("-map", "1:a:0", "-af", "apad", "-c:a", "aac", "-ar", "48000", "-b:a", "192k");
      args.push("-t", String(frames.length / plan.fps), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", "-map_metadata", "-1", file);
      await run("ffmpeg", args, bounded);
      output = await probe(file, bounded);
      await run("ffmpeg", [...FFMPEG_FLAGS, "-v", "error", "-xerror", ...inputArgs(file, 0), "-f", "null", "-"], bounded);
      video = await produced(file);
      if (frames.length > 1) motion = await videoMotion({ path: file, duration: Math.min(30, frames.length / plan.fps), expectedFps: plan.fps, loop: plan.loop }, cwd, bounded);
    }
    const chosen = plan.mode === "frames" ? frames : [...new Set([0, Math.floor((frames.length - 1) / 2), frames.length - 1])].map(i => frames[i]);
    const samples = [];
    for (let i = 0; i < chosen.length; i++) { const dest = path.join(dir, `sample-${i}.png`); await fs.copyFile(chosen[i].path, dest, fs.constants.COPYFILE_EXCL); samples.push({ ...await produced(dest), time: chosen[i].time }); }
    const sheet = path.join(dir, "contact-sheet.png");
    await contactSheet(samples.map(f => ({ path: f.path, label: `${f.time.toFixed(3)}s` })), sheet, bounded);
    await fs.rm(frameDir, { recursive: true, force: true });
    const result = { mode: plan.mode, sourceHash: createHash("sha256").update(xml).digest("hex"), source: path.join(dir, "source.svg"), tracks: path.join(dir, "tracks.json"), width: plan.width, height: plan.height, fps: plan.fps, frames: frames.length, duration: plan.mode === "video" ? frames.length / plan.fps : 0, samples, contactSheet: await produced(sheet), ...(video ? { video, output, decodeVerified: true, motion } : {}), diagnostics: diagnostics.slice(0, 24), diagnosticsTruncated: diagnostics.length > 24, reducedMotion: plan.reducedMotion, timing: "CSS/WAAPI local time, SVG SMIL root time and data-keyframe attributes are sampled at the same absolute seconds. Video samples i/fps and excludes the duration endpoint.", note: "Clipping uses approximate screen bounds without stroke/filter expansion; intentional off-canvas motion may be valid. Programmatic tracks are explicit export data and do not automatically implement reduced-motion alternatives. Inspect pixels and playback before artistic approval." };
    await fs.writeFile(path.join(dir, "render.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    bounded.throwIfAborted();
    return result;
  } catch (error) { if (dir) await fs.rm(dir, { recursive: true, force: true }); throw error; }
  finally { bounded.removeEventListener("abort", close); await browser?.close().catch(() => {}); release(); }
}
