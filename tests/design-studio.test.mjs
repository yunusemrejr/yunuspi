import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find(candidate => fs.existsSync(path.join(candidate, "extensions/lib/design-studio.ts")));
assert.ok(agentRoot, "design studio ships with the distribution");
const studio = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/design-studio.ts")));
const analysis = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/image-analysis.ts")));
const register = (await import(pathToFileURL(path.join(agentRoot, "extensions/design-studio.ts")))).default;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "design-studio-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

// ── synthetic landing page ────────────────────────────────────────────────
function canvas(width, height, rgb) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}
function rect(img, x, y, w, h, rgb, radius = 0) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
    if (radius) {
      const cx = xx < x + radius ? x + radius : xx >= x + w - radius ? x + w - radius - 1 : xx;
      const cy = yy < y + radius ? y + radius : yy >= y + h - radius ? y + h - radius - 1 : yy;
      if ((xx - cx) ** 2 + (yy - cy) ** 2 > radius * radius) continue;
    }
    img.data.set([...rgb, 255], (yy * img.width + xx) * 4);
  }
}
function circle(img, cx, cy, r, rgb) {
  for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
    if (d > 0.5) continue;
    const a = Math.min(1, 0.5 - d), i = (y * img.width + x) * 4;
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * (1 - a) + rgb[c] * a);
  }
}
/** Text-like line: letters as stems and bars, some ascenders and descenders. */
function textLine(img, x, y, w, size, rgb, seed = 1) {
  let s = seed, px = x;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const letter = Math.max(3, Math.round(size * 0.5)), gap = Math.max(1, Math.round(size * 0.12)), cap = Math.round(size * 0.7), bar = Math.max(1, Math.round(size * 0.12));
  while (px < x + w - letter) {
    const word = 3 + Math.floor(rnd() * 6);
    for (let k = 0; k < word && px < x + w - letter; k++) {
      const r = rnd(), tall = r < 0.3 ? cap : Math.round(cap * 0.72), desc = r > 0.85 ? Math.round(size * 0.22) : 0;
      rect(img, px, y + cap - tall, Math.max(1, Math.round(letter * 0.35)), tall + desc, rgb);
      rect(img, px + Math.round(letter * 0.35), y + cap - Math.round(cap * 0.72), Math.max(1, Math.round(letter * 0.5)), bar, rgb);
      rect(img, px + Math.round(letter * 0.35), y + cap - bar, Math.max(1, Math.round(letter * 0.5)), bar, rgb);
      px += letter + gap;
    }
    px += letter;
  }
}
function paragraph(img, x, y, w, size, lines, rgb, leading = 1.5) {
  for (let i = 0; i < lines; i++) textLine(img, x, y + Math.round(i * size * leading), i === lines - 1 ? Math.round(w * 0.6) : w, size, rgb, 7 + i * 13);
}
function photo(img, x, y, w, h, seed = 3) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const t = (xx - x) / w, u = (yy - y) / h;
    const base = [60 + 120 * t + 40 * Math.sin(u * 9), 90 + 80 * u + 30 * Math.cos(t * 7), 140 - 60 * t + 25 * Math.sin((t + u) * 11)];
    img.data.set([...base.map(v => Math.max(0, Math.min(255, Math.round(v + (rnd() - 0.5) * 50)))), 255], (yy * img.width + xx) * 4);
  }
}
const INDIGO = [79, 70, 229];
function landing({ shift = 0, cta = INDIGO, heroImage = true } = {}) {
  const W = 1440, img = canvas(W, 1900, [255, 255, 255]);
  circle(img, 96, 40, 16, INDIGO); textLine(img, 124, 30, 90, 20, [17, 24, 39], 5);
  for (let i = 0; i < 4; i++) textLine(img, 760 + i * 110, 32, 70, 16, [55, 65, 81], 11 + i);
  rect(img, 1220, 20, 140, 44, INDIGO, 10); textLine(img, 1244, 34, 92, 15, [255, 255, 255], 3);
  rect(img, 0, 80, W, 620, [245, 243, 255]);
  paragraph(img, 120, 200, 560, 56, 2, [17, 24, 39], 1.2);
  paragraph(img, 120, 380, 520, 18, 3, [75, 85, 99], 1.6);
  rect(img, 120, 500, 180, 52, INDIGO, 12); textLine(img, 146, 517, 128, 17, [255, 255, 255], 9);
  rect(img, 320, 500, 160, 52, [255, 255, 255], 12); textLine(img, 344, 517, 110, 17, INDIGO, 4);
  if (heroImage) photo(img, 780, 150, 540, 480, 21);
  const fy = 780 + shift;
  paragraph(img, 520, fy, 400, 36, 1, [17, 24, 39]);
  for (let k = 0; k < 3; k++) {
    const x = 120 + k * 410;
    rect(img, x, fy + 100, 380, 360, [248, 250, 252], 16);
    circle(img, x + 56, fy + 156, 24, [22, 163, 74]);
    textLine(img, x + 32, fy + 210, 220, 24, [17, 24, 39], 30 + k);
    paragraph(img, x + 32, fy + 260, 316, 16, 4, [75, 85, 99], 1.6);
  }
  rect(img, 0, 1320 + shift, W, 300, cta);
  paragraph(img, 420, 1400 + shift, 600, 40, 1, [255, 255, 255]);
  rect(img, 630, 1500 + shift, 180, 52, [255, 255, 255], 12); textLine(img, 656, 1517 + shift, 128, 17, cta, 12);
  rect(img, 0, 1680, W, 220, [15, 23, 42]);
  for (let c = 0; c < 4; c++) paragraph(img, 120 + c * 320, 1730, 200, 14, 4, [148, 163, 184], 1.7);
  return img;
}
const write = async (name, img) => { fs.writeFileSync(path.join(work, name), await studio.encodeImage(img, "png")); return name; };
const mock = await write("mock.png", landing());
await write("build.png", landing({ shift: 40, cta: [220, 38, 38], heroImage: false }));
let analyzed;
const analyze = async () => analyzed ??= await studio.imageAnalyze({ path: mock }, work);

test("images are recognized by content, never by name, and vector input is redirected", () => {
  const png = fs.readFileSync(path.join(work, mock));
  assert.equal(studio.sniffImage(png), "png");
  assert.equal(studio.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "jpeg");
  assert.equal(studio.sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "webp");
  assert.equal(studio.sniffImage(Buffer.from("GIF89a....", "latin1")), "gif");
  assert.equal(studio.sniffImage(Buffer.from("<html>not an image</html>")), undefined);
  fs.writeFileSync(path.join(work, "logo.png"), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
  return assert.rejects(studio.loadImage({ path: "logo.png" }, work), /SVG is vector already.*render_see/);
});

test("decode bounds width and pixels and round-trips through the encoder", async () => {
  const bytes = fs.readFileSync(path.join(work, mock));
  const small = await studio.decodeImage(bytes, { maxWidth: 360 });
  assert.equal(small.width, 360); assert.equal(small.height, 475); assert.equal(small.scale, 0.25);
  const bounded = await studio.decodeImage(bytes, { maxPixels: 100_000 });
  assert.ok(bounded.width * bounded.height <= 100_000);
  const crop = await studio.decodeImage(bytes, { crop: { x: 1220, y: 20, width: 140, height: 44 } });
  assert.deepEqual([crop.width, crop.height], [140, 44]);
  const inside = (22 * 140 + 5) * 4;
  assert.deepEqual([...crop.data.subarray(inside, inside + 4)], [79, 70, 229, 255], "crop origin is the button's corner");
  const jpg = await studio.encodeImage(crop, "jpg");
  assert.equal(studio.sniffImage(jpg), "jpeg");
});

test("device pixel ratio follows common export widths unless given", () => {
  assert.equal(studio.inferDpr(2880, 9000).dpr, 2);
  assert.equal(studio.inferDpr(1170, 2532).dpr, 3);
  assert.equal(studio.inferDpr(750, 1624).dpr, 2);
  assert.equal(studio.inferDpr(1440, 5000).dpr, 1);
  assert.deepEqual(studio.inferDpr(2880, 9000, 1), { dpr: 1, assumed: false, reason: "given" });
});

test("image_analyze maps bands, components, palette roles and a type scale", async () => {
  const result = await analyze();
  const map = JSON.parse(fs.readFileSync(path.join(work, result.files.map), "utf8"));
  assert.equal(map.format, "yunuspi-design-map-v1");
  assert.deepEqual(map.sections.map(s => s.role), ["navigation", "hero", "feature-grid", "call-to-action", "spacer", "footer"]);
  const role = name => map.palette.find(color => color.role === name)?.hex;
  assert.equal(role("background"), "#ffffff");
  assert.equal(role("primary"), "#4f46e5");
  assert.equal(role("surface"), "#f5f3ff");
  assert.equal(role("surface-2"), "#f8fafc");
  assert.equal(role("dark-surface"), "#0f172a");
  assert.equal(role("heading"), "#111827");
  assert.equal(role("text"), "#4b5563");
  const cards = map.components.find(group => group.role === "card");
  assert.equal(cards.count, 3); assert.equal(cards.fill, "#f8fafc");
  assert.ok(Math.abs(cards.width - 380) <= 4 && Math.abs(cards.height - 360) <= 4);
  assert.match(cards.children, /icon/); assert.match(cards.children, /text/);
  assert.ok(map.blocks.filter(block => block.role === "button").length >= 4, "nav, hero and CTA buttons");
  assert.equal(map.blocks.filter(block => block.kind === "image").length, 1, "one photograph");
  assert.equal(result.assets.raster.length, 1); assert.equal(result.assets.icons.length, 3);
  const body = map.typography.find(level => level.name === "body");
  assert.ok(body && Math.abs(body.fontSize - 16) <= 2, `body ≈ 16px, got ${body?.fontSize}`);
  assert.ok(Math.abs(Math.max(...map.typography.map(level => level.fontSize)) - 56) <= 5, "display ≈ 56px");
  assert.equal(map.layout.columns.find(column => column.section === "s3")?.count, 3);
  const tokens = fs.readFileSync(path.join(work, result.files.tokens), "utf8");
  assert.match(tokens, /--color-primary: #4f46e5;/); assert.match(tokens, /--font-size-body: 1[5-7]px;/); assert.match(tokens, /--container: \d+px;/);
  assert.ok(fs.statSync(path.join(work, result.files.overlay)).size > 1000);
  assert.equal(fs.readFileSync(path.join(work, ".pi/design/.gitignore"), "utf8"), "*\n", "scratch artifacts stay out of git");
  assert.ok(JSON.stringify(result).length < 12_000, "tool result stays compact; details live in the map");
});

test("image_crop cuts mapped assets, keys backgrounds with de-fringing and picks formats", async () => {
  const result = await analyze();
  const cut = await studio.imageCrop({ map: result.files.map, kinds: ["image", "icon"] }, work);
  const photoAsset = cut.assets.find(asset => asset.kind === "image");
  assert.equal(photoAsset.format, "webp");
  assert.ok(Math.abs(photoAsset.css.width - 540) <= 8 && Math.abs(photoAsset.css.height - 480) <= 8, JSON.stringify(photoAsset.css));
  assert.equal(cut.assets.filter(asset => asset.kind === "icon").length, 3);
  const map = JSON.parse(fs.readFileSync(path.join(work, result.files.map), "utf8"));
  const icon = map.blocks.find(block => block.kind === "icon").id;
  const keyed = await studio.imageCrop({ map: result.files.map, blocks: [icon], key: "auto", trim: true, format: "png" }, work);
  const asset = keyed.assets[0];
  assert.equal(asset.alpha, true); assert.equal(asset.background, "#f8fafc");
  const decoded = await studio.decodeImage(fs.readFileSync(path.join(work, asset.file)));
  assert.equal(decoded.data[3], 0, "keyed corner is transparent");
  const center = ((decoded.height >> 1) * decoded.width + (decoded.width >> 1)) * 4;
  assert.deepEqual([...decoded.data.subarray(center, center + 4)], [22, 163, 74, 255], "interior keeps its color");
  assert.ok(decoded.width <= 50 && decoded.height <= 50, "trimmed to the mark");
  const region = await studio.imageCrop({ path: mock, regions: [{ x: 10, y: 10, width: 20, height: 20, name: "../escape" }], format: "jpg" }, work);
  assert.equal(region.assets[0].name, "region-1", "unsafe names fall back");
  await assert.rejects(studio.imageCrop({ path: mock }, work), /Nothing to crop/);
  await assert.rejects(studio.imageCrop({ path: mock, blocks: ["b1"] }, work), /need the map/);
});

test("image_crop serves every region from one decode without cross-talk", async () => {
  const box = { x: 10, y: 10, width: 120, height: 80 };
  const cut = await studio.imageCrop({ path: mock, regions: [{ ...box, name: "a" }, { ...box, name: "b" }], key: "auto", format: "png" }, work);
  assert.equal(cut.assets.length, 2);
  assert.deepEqual(cut.assets[0].pixels, cut.assets[1].pixels);
  const [a, b] = await Promise.all(cut.assets.map(asset => studio.decodeImage(fs.readFileSync(path.join(work, asset.file)))));
  assert.equal(a.width, 120); assert.equal(a.height, 80);
  assert.deepEqual(Buffer.from(a.data), Buffer.from(b.data), "identical keyed regions decode identically: no target mutates the shared decode");
});

test("image_trace vectorizes flat marks faithfully and flags photographs", async () => {
  const result = await analyze();
  const map = JSON.parse(fs.readFileSync(path.join(work, result.files.map), "utf8"));
  const icon = map.blocks.find(block => block.kind === "icon").id;
  const traced = await studio.imageTrace({ map: result.files.map, block: icon, colors: 2 }, work);
  assert.equal(traced.verdict, "good"); assert.ok(traced.fidelity >= 0.95); assert.ok(traced.posterizationError < 4);
  const svg = fs.readFileSync(path.join(work, traced.svg), "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="\d+" height="\d+">/);
  assert.match(svg, /<path fill="#1[67]a3[45]b"/); assert.match(svg, /\dC\d/, "curves, not only polygon edges");
  assert.doesNotMatch(svg, /<script|href=/);
  const photoBlock = map.blocks.find(block => block.kind === "image").id;
  const poor = await studio.imageTrace({ map: result.files.map, block: photoBlock, colors: 4 }, work);
  assert.match(poor.verdict, /^poor/);
});

test("anti-aliased edges of dark text do not leak into a saturated fill", () => {
  const img = canvas(160, 60, [255, 255, 255]);
  circle(img, 30, 30, 20, INDIGO);
  for (let x = 70; x < 150; x += 12) for (let y = 10; y < 50; y++) for (let dx = 0; dx < 6; dx++) {
    const i = (y * 160 + x + dx) * 4, edge = dx === 0 || dx === 5 ? 0.5 : 1;
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(255 * (1 - edge) + [17, 24, 39][c] * edge);
  }
  const result = analysis.traceToSvg(img, { x: 0, y: 0, width: 160, height: 60 }, { palette: [INDIGO, [17, 24, 39]], background: [255, 255, 255] });
  const indigo = result.layers.find(layer => layer.fill === "#4f46e5");
  assert.equal(indigo.paths, 1, "the circle alone");
});

test("visual_diff finds spacing drift, recolored bands, removed images and new colors", async () => {
  const result = await analyze();
  const diff = await studio.visualDiff({ map: result.files.map, candidate: "build.png" }, work, undefined, undefined);
  assert.notEqual(diff.verdict, "close");
  assert.ok(diff.shifts.some(shift => /^s3 .* 40px lower/.test(shift)), diff.shifts.join("; "));
  assert.ok(diff.extraColors.some(color => color.startsWith("#dc2626")));
  assert.ok(diff.regions.some(region => region.referenceBlocks?.some(block => / image$/.test(block))), "the missing hero image is named");
  assert.ok(diff.worstSections[0].startsWith("s4"), "the recolored call-to-action band is worst");
  for (const file of [diff.files.compare, diff.files.heat, ...diff.files.zooms]) assert.ok(fs.statSync(path.join(work, file)).size > 500);
  const same = await studio.visualDiff({ reference: mock, candidate: mock }, work, undefined, undefined);
  assert.equal(same.verdict, "close"); assert.equal(same.ssim, 1); assert.equal(same.changedPercent, 0);
  await assert.rejects(studio.visualDiff({ reference: mock, source: "index.html" }, work, undefined, undefined), /render_see/);
});

test("visual_diff renders long pages in clipped slices and stitches them", async () => {
  const calls = [];
  const reference = canvas(400, 5200, [255, 255, 255]);
  for (let y = 0; y < 5200; y += 400) rect(reference, 0, y, 400, 200, [(y / 20) % 255, 120, 200]);
  await write("tall.png", reference);
  const fake = async (params, destination) => {
    calls.push(params.clip);
    const slice = canvas(400, params.clip.height, [255, 255, 255]);
    slice.data.set(reference.data.subarray(params.clip.y * 400 * 4, (params.clip.y + params.clip.height) * 400 * 4));
    fs.writeFileSync(destination, await studio.encodeImage(slice, "png"));
    return { output: destination, conditions: { documentSize: { width: 400, height: 5300 } } };
  };
  const diff = await studio.visualDiff({ reference: "tall.png", source: "page.html", referenceScale: 1 }, work, undefined, fake);
  assert.deepEqual(calls, [{ y: 0, height: 4000 }, { y: 4000, height: 1200 }]);
  assert.equal(diff.verdict, "close"); assert.equal(diff.size.heightDelta, 100, "page height comes from the renderer");
  assert.match(diff.next[0], /100px taller/);
});

test("URL references download through the guarded fetcher, are kept locally and honor offline mode", async () => {
  const png = fs.readFileSync(path.join(work, mock));
  const server = createServer((request, response) => {
    if (request.url === "/mock.png") { response.writeHead(200, { "content-type": "image/png" }); response.end(png); }
    else if (request.url === "/page") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html></html>"); }
    else { response.writeHead(302, { location: "/mock.png" }); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await studio.imageAnalyze({ url: `${base}/redirect`, maxBlocks: 40 }, work);
    assert.ok(fs.existsSync(path.join(work, result.files.reference)), "downloaded reference is saved for reuse");
    assert.equal(result.source.url, `${base}/mock.png`);
    await assert.rejects(studio.loadImage({ url: `${base}/page` }, work), /Unexpected content type text\/html/);
    const previous = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try { await assert.rejects(studio.loadImage({ url: `${base}/mock.png` }, work), /Offline session/); }
    finally { if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous; }
  } finally { server.close(); }
});

test("outputs stay inside the workspace and tools register with bounded schemas", async () => {
  await assert.rejects(studio.imageAnalyze({ path: mock, outputDir: os.tmpdir() }, work), /inside the current workspace/);
  const tools = new Map();
  register({ registerTool: definition => tools.set(definition.name, definition) });
  assert.deepEqual([...tools.keys()].sort(), ["image_analyze", "image_create", "image_crop", "image_trace", "visual_diff"]);
  for (const tool of tools.values()) assert.ok(tool.description.length > 200 && tool.description.length < 900, tool.name);
  const out = await tools.get("image_trace").execute("t", { path: mock, region: { x: 80, y: 24, width: 32, height: 32 }, colors: 1 }, undefined, undefined, { cwd: work });
  assert.equal(out.details.verdict, "good");
});

test("real renderer captures a clipped slice of a long page", { timeout: 60_000 }, async () => {
  const { renderCapture } = await import(pathToFileURL(path.join(agentRoot, "scripts/render-capture.mjs")));
  const page = path.join(work, "long.html");
  fs.writeFileSync(page, `<!doctype html><style>body{margin:0}div{height:1000px}</style>${Array.from({ length: 6 }, (_, i) => `<div style="background:${["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff"][i]}"></div>`).join("")}`);
  const output = path.join(work, "slice.png");
  const result = await renderCapture({ source: page, output: "image", width: 320, height: 600, fullPage: true, clip: { y: 4500, height: 1000 } }, output);
  assert.deepEqual(result.conditions.clip, { x: 0, y: 4500, width: 320, height: 1000 });
  assert.equal(result.conditions.captureFallback, undefined, "a clip is not a full-page fallback");
  const img = await studio.decodeImage(fs.readFileSync(output));
  assert.deepEqual([img.width, img.height], [320, 1000]);
  const at = y => [...img.data.subarray(y * 320 * 4 + 40, y * 320 * 4 + 43)];
  assert.deepEqual(at(100), [0, 255, 255], "y 4600 is the fifth band"); assert.deepEqual(at(900), [255, 0, 255], "y 5400 is the sixth");
  await assert.rejects(renderCapture({ source: page, output: "text", clip: { y: 0, height: 100 } }, output), /Invalid clip/);
});

test("image-to-code prompts route to the skill and stage the studio tools; verification prompts do not", async () => {
  const routing = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/skill-routing.ts")));
  const discovery = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/tool-discovery.ts")));
  for (const prompt of ["turn this mockup into a website", "make my pricing page look more like this screenshot", "Convert the attached image to HTML/CSS",
    "Here is https://example.com/hero.png, recreate it in React", "implement this Figma design as Vue components", "edit site to look more like this: https://cdn.example.com/ref.jpg"]) {
    assert.ok(routing.routeSkills(prompt).some(route => route.name === "mockup-to-code"), prompt);
    assert.ok(discovery.intentBundleTools(prompt).includes("image_analyze"), prompt);
  }
  for (const prompt of ["take a screenshot of the page", "compare the screenshot with the page", "Create a website for my bakery", "update the screenshot in the README", "fix the css bug on the page"]) {
    assert.equal(routing.routeSkills(prompt).some(route => route.name === "mockup-to-code"), false, prompt);
    assert.equal(discovery.intentBundleTools(prompt).some(name => ["image_analyze", "image_crop", "image_trace", "visual_diff"].includes(name)), false, prompt);
  }
  assert.ok(discovery.intentBundleTools("make the site look like this", 1).includes("visual_diff"), "an attached image is the reference");
  assert.deepEqual(discovery.intentBundleTools("what is in this picture?", 1), []);
  assert.ok(discovery.intentBundleTools("Make a 60 second explainer video about attention").includes("video_project"));
});

test("image_create synthesizes deterministic plates with bounded parameters", async () => {
  const synth = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/image-synth.ts")));
  assert.deepEqual([...synth.SYNTH_OPS], ["solid", "linear-gradient", "checker", "noise", "grid"]);
  const tools = new Map();
  register({ registerTool: definition => tools.set(definition.name, definition) });
  assert.ok(tools.has("image_create"));
  const first = await synth.imageCreate({ op: "solid", width: 8, height: 8, color: "#ff0000" }, work);
  const second = await synth.imageCreate({ op: "solid", width: 8, height: 8, color: "#ff0000" }, work);
  assert.equal(first.format, "png"); assert.deepEqual(first.pixels, { width: 8, height: 8 });
  assert.deepEqual(first.design, { color: "#ff0000" });
  assert.deepEqual(fs.readFileSync(path.join(work, first.file)), fs.readFileSync(path.join(work, second.file)), "same inputs render the same bytes");
  await assert.rejects(synth.imageCreate({ op: "solid", width: 5000, height: 8 }, work), /width/);
  await assert.rejects(synth.imageCreate({ op: "photo", width: 8, height: 8 }, work), /op must be one of/);
});
