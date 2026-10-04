import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/motion-library.ts")));
assert.ok(agent, "motion library source must exist");
const lib = await import(pathToFileURL(path.join(agent, "extensions/lib/motion-library.ts")).href);
const { skillRoutes } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")).href);
const { INTENT_BUNDLES } = await import(pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts")).href);
const skill = path.join(agent, "skills/motion-approaches");
const route = skillRoutes.find((r) => r.name === "motion-approaches");

test("the catalogue is read from every example's own header", async () => {
  const catalog = await lib.motionCatalog();
  for (const approach of lib.MOTION_APPROACHES) assert.ok(catalog.some((e) => e.approach === approach), `${approach} has examples`);
  assert.ok(catalog.length >= 20, `${catalog.length} examples`);
  for (const example of catalog) {
    assert.ok(fs.existsSync(path.join(skill, "assets/examples", example.file)), example.file);
    assert.ok(example.title.length > 6 && example.summary.length > 20, `${example.id} has a title and summary`);
    if (example.id !== "html/extract-envelope") assert.ok(example.concepts.length >= 4, `${example.id} lists its concepts`);
    assert.ok(example.use.length >= 1, `${example.id} says how to run it`);
    assert.ok(example.bytes < 12_000, `${example.id} stays small enough to read whole`);
  }
  assert.equal(new Set(catalog.map((e) => e.id)).size, catalog.length, "ids are unique");
});

test("every HTML example obeys the page contract and keeps its frames pure", async () => {
  const pages = (await lib.motionCatalog()).filter((e) => e.file.endsWith(".html"));
  assert.ok(pages.length >= 13);
  for (const page of pages) {
    const source = fs.readFileSync(path.join(skill, "assets/examples", page.file), "utf8");
    for (const [, script] of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script), `${page.id} parses`);
    assert.match(source, /window\.renderFrame\s*=/, `${page.id} exposes renderFrame`);
    assert.match(source, /__PROPS__/, `${page.id} reads props`);
    const code = source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.doesNotMatch(code, /Date\.now\s*\(|performance\.now\s*\(|Math\.random\s*\(|requestAnimationFrame\s*\(\s*(?!\(\s*\)\s*=>)|setTimeout\s*\(|setInterval\s*\(/, `${page.id} is a pure function of t`);
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${page.id} avoids fetch (file:// in the exporter)`);
  }
});

test("search ranks the example a task describes first", async () => {
  const top = async (query, approach) => (await lib.searchMotion(query, approach)).matches[0]?.id;
  assert.equal(await top("liquid distortion on headline type"), "html/svg-filter-liquid");
  assert.equal(await top("animated terrain landscape"), "blender/geonodes-terrain");
  assert.equal(await top("morph one shape into another and draw a path"), "html/svg-morph-draw");
  assert.equal(await top("labels pinned to features of a 3D object"), "merge/shot-overlay");
  assert.equal(await top("camera dolly zoom or crane move"), "blender/camera-rigs");
  assert.equal(await top("visuals driven by music", "html"), "html/audio-reactive-field");
  assert.equal(await top("ui on a laptop screen in a 3d scene"), "blender/html-as-texture");
  const none = await lib.searchMotion("zzzz qqqq");
  assert.equal(none.matches.length, 0);
  assert.ok(none.none.length >= 20, "an empty search lists what exists");
  assert.ok((await lib.searchMotion("type", "ffmpeg")).matches.every((m) => m.approach === "ffmpeg"));
});

test("get returns concepts and, on request, the file; copy places it where the project looks", async () => {
  const brief = await lib.motionExample("html/webgl-domain-warp", false);
  assert.ok(brief.concepts.length >= 4 && !brief.source);
  const full = await lib.motionExample("html/webgl-domain-warp", true);
  assert.match(full.source, /renderFrame/);
  await assert.rejects(lib.motionExample("html/nope", false), /No example/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-motion-"));
  fs.writeFileSync(path.join(dir, "video.json"), JSON.stringify({ scenes: [] }));
  const html = await lib.copyMotionExample({ dir, id: "html/svg-morph-draw", name: "my-morph" }, dir);
  assert.equal(html.copied, "public/html/my-morph.html");
  assert.match(html.then, /HtmlScene/);
  assert.ok(fs.existsSync(path.join(dir, "public/html/my-morph.html")));
  await assert.rejects(lib.copyMotionExample({ dir, id: "html/svg-morph-draw", name: "my-morph" }, dir), /already exists/);
  await lib.copyMotionExample({ dir, id: "html/svg-morph-draw", name: "my-morph", replace: true }, dir);
  assert.equal((await lib.copyMotionExample({ dir, id: "blender/product-hero" }, dir)).copied, "blender/scripts/product-hero.py");
  assert.equal((await lib.copyMotionExample({ dir, id: "merge/composite" }, dir)).copied, "scripts/composite.mjs");
  await assert.rejects(lib.copyMotionExample({ dir, id: "html/svg-morph-draw", name: "../escape" }, dir), /kebab-case/);
});

test("the skill, its references and its routing are wired for autonomous delivery", async () => {
  const text = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: motion-approaches\ndescription: /);
  const links = [...text.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 6, "every reference is linked from SKILL.md");
  for (const link of links) assert.ok(fs.existsSync(path.join(skill, link)), link);
  const guide = await lib.motionGuide();
  assert.match(guide.choosing, /Matrix/);
  assert.ok(guide.guides.length >= 6);

  assert.ok(route && route.priority >= 60);
  for (const prompt of ["make a stunning product video with blender and html overlays", "build a vanilla css js html motion graphic for the intro", "a webgl shader transition between scenes", "add a dolly zoom camera move to the product shot", "create a cinematic title sequence video", "render a raymarched sdf scene for the video"]) assert.ok(route.intent.test(prompt), prompt);
  for (const prompt of ["fix the typo in the readme", "add a video player component", "write a SQL migration"]) assert.equal(route.intent.test(prompt), false, prompt);
  assert.ok(route.file.test("/work/film/public/html/title.html"));
  const bundled = INTENT_BUNDLES.filter((b) => ["code-first-video", "motion-approaches"].includes(b.skill)).flatMap((b) => b.tools);
  for (const tool of ["motion_examples", "video_shot"]) assert.ok(bundled.includes(tool), `${tool} is staged on the first turn`);
});

const rendering = process.env.YUNUSPI_SKIP_MOTION_RENDER === "1" ? "YUNUSPI_SKIP_MOTION_RENDER" : (() => { try { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "quiet", "-version"]); return fs.existsSync(path.join(agent, "scripts/../skills/motion-graphics-production/scripts/render.mjs")) ? false : "no exporter"; } catch { return "ffmpeg is not installed"; } })();
test("vanilla examples render distinct, non-blank frames through the exporter", { skip: rendering, timeout: 240_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-motion-render-"));
  const exporter = path.join(skill, "../motion-graphics-production/scripts/render.mjs");
  for (const id of ["waapi-timeline", "svg-morph-draw", "kinetic-type-lines", "css-3d-stage", "data-reveal", "svg-filter-liquid", "halftone-transition", "canvas-flow-field"]) {
    const dir = path.join(out, id); fs.mkdirSync(dir);
    execFileSync("node", [exporter, path.join(skill, "assets/examples/html", `${id}.html`), dir, "2", "6", "320", "180"], { stdio: "pipe", timeout: 90_000 });
    const run = fs.readdirSync(dir).find((n) => n.startsWith("motion-"));
    const frames = fs.readdirSync(path.join(dir, run)).filter((n) => n.endsWith(".png")).sort();
    assert.equal(frames.length, 12, id);
    const sizes = frames.map((n) => fs.statSync(path.join(dir, run, n)).size);
    assert.ok(Math.max(...sizes) > 1500, `${id} frames are not blank`);
    assert.ok(new Set(frames.map((n) => fs.readFileSync(path.join(dir, run, n)).toString("base64"))).size >= 4, `${id} moves over time`);
    const twice = path.join(out, `${id}-again`); fs.mkdirSync(twice);
    execFileSync("node", [exporter, path.join(skill, "assets/examples/html", `${id}.html`), twice, "2", "6", "320", "180"], { stdio: "pipe", timeout: 90_000 });
    const again = fs.readdirSync(twice).find((n) => n.startsWith("motion-"));
    assert.deepEqual(fs.readFileSync(path.join(twice, again, frames[7])), fs.readFileSync(path.join(dir, run, frames[7])), `${id} renders the same frame identically`);
  }
});

test("FFmpeg and numpy examples produce video", { skip: rendering, timeout: 120_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-motion-tools-"));
  const hasPy = (() => { try { execFileSync("python3", ["-c", "import numpy"], { stdio: "pipe" }); return true; } catch { return false; } })();
  const hasAss = /subtitles/.test(execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }));
  if (hasPy) {
    execFileSync("python3", [path.join(skill, "assets/examples/python/numpy-frames.py"), path.join(out, "np.mp4"), "--seconds", "1", "--size", "320x180"], { stdio: "pipe" });
    assert.ok(fs.statSync(path.join(out, "np.mp4")).size > 2000);
  }
  if (hasAss) {
    execFileSync("node", [path.join(skill, "assets/examples/ffmpeg/ass-kinetic.mjs"), "--text", "Measure what the *water* does", "--out", path.join(out, "ass.mp4"), "--seconds", "2"], { stdio: "pipe" });
    assert.ok(fs.statSync(path.join(out, "ass.mp4")).size > 2000);
  }
});
