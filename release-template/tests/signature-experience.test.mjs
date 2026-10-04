import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// The signature-experience skill ships two artifacts an agent copies into a project. They are only worth
// shipping if they are verified: the palette must keep every text role legible, and the scene kit must render
// real pixels through the same capture path the harness uses to check a page.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "skills/signature-experience/SKILL.md")));
const skill = path.join(agent, "skills/signature-experience");
const palette = await import(pathToFileURL(path.join(skill, "scripts/palette.mjs")));
const kit = await import(pathToFileURL(path.join(skill, "scripts/world-kit.mjs")));

test("palette contrast is computed with the WCAG formula", () => {
	assert.equal(Math.round(palette.contrast("#000000", "#ffffff") * 100) / 100, 21);
	assert.equal(palette.contrast("#777777", "#777777"), 1);
	assert.ok(Math.abs(palette.contrast("#767676", "#ffffff") - 4.54) < 0.01, "the classic AA-grey boundary");
});

test("every text role of every generated palette clears 4.5:1, light and dark, across hues, moods and harmonies", () => {
	let pairs = 0;
	for (const mood of ["vivid", "soft", "deep", "muted"]) for (const harmony of ["mono", "analogous", "complement", "split", "triad"]) for (let hue = 0; hue < 360; hue += 20) {
		const p = palette.derivePalette({ hue, mood, harmony, dark: true });
		for (const row of p.report) { pairs++; assert.ok(row.aa, `${mood}/${harmony}/${hue} ${row.theme} ${row.fg} on ${row.bg} = ${row.ratio}`); }
		for (const theme of [p.light, p.dark]) for (const value of Object.values(theme)) assert.match(value, /^#[0-9a-f]{6}$/, "gamut mapping always yields a valid sRGB hex");
	}
	assert.ok(pairs > 3000);
	const strict = palette.derivePalette({ hue: 200, target: 7, dark: true });
	assert.ok(strict.report.filter((row) => row.fg === "muted" || row.fg === "link" || row.fg === "accent-ink").every((row) => row.ratio >= 7), "a higher target is honoured");
});

test("palettes are deterministic, and the neutral hue follows the chosen bias", () => {
	assert.deepEqual(palette.derivePalette({ hue: 150, mood: "deep" }), palette.derivePalette({ hue: 150, mood: "deep" }));
	assert.equal(palette.derivePalette({ hue: 150 }).neutralHue, 150, "neutrals lean toward the accent by default");
	assert.equal(palette.derivePalette({ hue: 150, bias: "warm" }).neutralHue, 65);
	assert.equal(palette.derivePalette({ hue: 150, bias: "cool" }).neutralHue, 245);
	assert.equal(palette.derivePalette({ hue: 150, bias: "20" }).neutralHue, 20);
	assert.throws(() => palette.derivePalette({}), /hue/);
});

test("the two house-default looks are flagged, and a distinct palette is not", () => {
	assert.match(palette.derivePalette({ hue: 280, chroma: 0.2 }).flags.join(" "), /indigo-to-purple/);
	assert.match(palette.derivePalette({ hue: 48, mood: "vivid", bias: "warm" }).flags.join(" "), /cream background with a terracotta/);
	assert.deepEqual(palette.derivePalette({ hue: 165, mood: "deep", bias: "cool" }).flags, []);
	const css = palette.paletteCss(palette.derivePalette({ hue: 165, dark: true }), "t-");
	assert.match(css, /--t-bg: #[0-9a-f]{6};/);
	assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme="light"\]\)/);
	assert.match(css, /:root\[data-theme="dark"\]/);
});

test("the world generator is deterministic, keeps plots on land and apart, and looks like land and water", () => {
	const a = kit.generateTerrain({ seed: 7, size: 22, plots: 6 }), b = kit.generateTerrain({ seed: 7, size: 22, plots: 6 }), c = kit.generateTerrain({ seed: 8, size: 22, plots: 6 });
	assert.equal(a.signature, b.signature, "the same seed is the same world, so a plot is a stable place");
	assert.notEqual(a.signature, c.signature);
	for (const seed of [1, 2, 7, 42, 99]) {
		const t = kit.generateTerrain({ seed, size: 22, plots: 6 }), count = {};
		t.columns.forEach((col) => { count[col.biome] = (count[col.biome] ?? 0) + 1; });
		assert.equal(t.plots.length, 6, `seed ${seed} places every plot`);
		assert.ok(count.grass > 10 && count.water > 100, `seed ${seed} has grass and a sea: ${JSON.stringify(count)}`);
		for (const p of t.plots) {
			assert.ok(t.heights[p.z * t.size + p.x] > t.waterLevel, "a plot never sits in the water");
			assert.ok(p.x >= 2 && p.z >= 2 && p.x < t.size - 2 && p.z < t.size - 2, "a plot keeps clear of the edge");
		}
		for (let i = 0; i < t.plots.length; i++) for (let j = i + 1; j < t.plots.length; j++) assert.ok(Math.hypot(t.plots[i].x - t.plots[j].x, t.plots[i].z - t.plots[j].z) >= 2.5, "plots keep their distance");
		for (let k = 0; k < t.size; k++) assert.equal(t.heights[k] + t.heights[(t.size - 1) * t.size + k] + t.heights[k * t.size] + t.heights[k * t.size + t.size - 1], 0, "the outer ring is sea, so the world fits its base");
	}
	assert.equal(kit.hashSeed("a"), kit.hashSeed("a"));
	const rnd = kit.mulberry32(5), first = [rnd(), rnd(), rnd()];
	assert.deepEqual([kit.mulberry32(5)(), 0, 0].slice(0, 1), first.slice(0, 1));
	assert.ok(first.every((v) => v >= 0 && v < 1));
});

const requireFromHere = createRequire(import.meta.url);
function threeBuild() {
	for (const base of [root, agent, path.join(agent, "npm")]) { try { return path.dirname(createRequire(path.join(base, "package.json")).resolve("three")); } catch { /* try the next install */ } }
	return undefined;
}
const PAGE = `<!doctype html><meta charset="utf-8"><title>pending</title><style>html,body{margin:0;height:100%;background:#cfe6f7}canvas{display:block;width:100%;height:100%}</style>
<canvas id="c"></canvas><script type="importmap">{"imports":{"three":"/three.module.js"}}</script><script type="module">
import * as THREE from "three"; import { generateTerrain, createDiorama, makeIsoCamera, bootScene } from "/world-kit.mjs";
const canvas = document.getElementById("c"), terrain = generateTerrain({ seed: 7, size: 22, plots: 6 });
const scene = new THREE.Scene(); scene.background = new THREE.Color("#cfe6f7");
const world = createDiorama({ THREE, terrain }); scene.add(world.group);
const camera = makeIsoCamera(THREE, terrain.size, canvas.clientWidth / canvas.clientHeight);
const stage = bootScene({ THREE, canvas, scene, camera, preserveDrawingBuffer: true, onResize: (w, h, cam) => cam.userData.setFrame(w / h), onFrame: (t) => world.update(t) });
stage.renderOnce(); stage.start();
const gl = stage.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
const seen = new Set(); let drawn = 0;
for (let i = 0; i < px.length; i += 16) { seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]); if (Math.abs(px[i] - 207) + Math.abs(px[i + 1] - 230) + Math.abs(px[i + 2] - 247) > 24) drawn++; }
const before = stage.running; stage.dispose({ scene: true });
document.title = JSON.stringify({ colors: seen.size, drawn: drawn / (px.length / 16), calls: stage.renderer.info.render.calls, plots: world.plots.length, loopWasRunning: before, runningAfterDispose: stage.running });
</script>`;

test("the scene kit renders a real, varied diorama through the harness's own software-WebGL capture, and tears down cleanly", { timeout: 120000 }, async (t) => {
	const build = threeBuild();
	if (!build) return t.skip("three is not installed in this checkout");
	const { renderCapture } = await import(pathToFileURL(path.join(agent, "scripts/render-capture.mjs")));
	const files = { "/three.module.js": path.join(build, "three.module.js"), "/three.core.js": path.join(build, "three.core.js"), "/world-kit.mjs": path.join(skill, "scripts/world-kit.mjs") };
	const server = http.createServer((req, res) => {
		const file = files[new URL(req.url, "http://x").pathname];
		if (file) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(file)); }
		res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-kit-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	try {
		for (const [width, height] of [[1280, 800], [390, 844]]) {
			const result = await renderCapture({ source: `http://127.0.0.1:${server.address().port}/`, output: "both", width, height, timeoutMs: 25000 }, path.join(dir, `${width}.png`));
			const stats = JSON.parse(result.pageState.title);
			assert.equal(result.conditions.webgl, "software");
			assert.ok(stats.colors > 400, `${width}px: a varied scene, not a flat fill (${stats.colors} colors)`);
			assert.ok(stats.drawn > 0.1 && stats.drawn < 0.6, `${width}px: the world covers part of the frame, not none or all of it (${stats.drawn})`);
			assert.ok(stats.calls > 5 && stats.calls < 120, `${width}px: instancing keeps draw calls low (${stats.calls})`);
			assert.equal(stats.plots, 6);
			assert.equal(stats.loopWasRunning, true, "the loop runs when motion is allowed");
			assert.equal(stats.runningAfterDispose, false, "dispose stops the loop");
			assert.deepEqual(result.errors, []);
		}
	} catch (error) {
		if (process.env.PI_BROWSER_REQUIRE !== "1" && /browserType\.launch|browser startup failure/i.test(String(error?.message))) return t.skip("Chromium unavailable; PI_BROWSER_REQUIRE=1 requires it");
		throw error;
	}
});

const { routeSkills } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")));
const routed = (prompt) => routeSkills(prompt).some((route) => route.name === "signature-experience");

test("immersive web briefs reach the skill, and ordinary, quiet or non-design work does not", () => {
	for (const prompt of [
		"Create stunning complex website designs with advanced motion graphics",
		"build a landing page with a 3D hero and parallax scroll",
		"make my portfolio website immersive and cinematic",
		"design a website with a mascot that reacts to the cursor",
		"create a webgl hero for the homepage",
		"build an awwwards-level landing page",
	]) assert.equal(routed(prompt), true, prompt);
	for (const prompt of [
		"fix the login bug in the website",
		"make a minimalist settings page",
		"build a dashboard for the inventory",
		"add a dark mode toggle to the app",
		"explain how three.js raycasting works",
		"build a website for a bakery with a menu and opening hours",
	]) assert.equal(routed(prompt), false, prompt);
});

test("the skill is well formed and every file it points to exists", () => {
	const text = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8");
	const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(block, "the skill opens with frontmatter");
	const front = parseYaml(block[1]);
	assert.equal(front.name, "signature-experience");
	assert.ok(front.description.length > 200 && front.description.length < 1500, "the description is specific enough to route on and short enough to list");
	for (const rel of [...text.matchAll(/`((?:scripts|references)\/[a-z0-9.-]+)`/g)].map((m) => m[1])) assert.ok(fs.existsSync(path.join(skill, rel)), `${rel} exists`);
	assert.match(text, /creative_direct set/);
	assert.match(text, /swap test/);
	assert.match(text, /static baseline|Baseline/);
	for (const rel of ["three-world.md", "motion-system.md", "living-things.md", "palette-and-type.md"]) assert.ok(fs.statSync(path.join(skill, "references", rel)).size > 1500, `${rel} has substance`);
});

test("the design doctrine no longer vetoes the level it asks the agent to reach", () => {
	const read = (name) => fs.readFileSync(path.join(agent, "skills", name, "SKILL.md"), "utf8");
	assert.match(read("frontend-design"), /## Expression levels/);
	assert.match(read("frontend-design"), /do not downscale an immersive brief/);
	assert.match(read("web-effects"), /ambient life that \*is\* the world/);
	assert.match(read("threejs"), /signature-experience\/scripts\/world-kit\.mjs/);
});

test("visual_review asks the reviewer to confirm the signature and judges immersive work on coherence, and leaves plain directions alone", { timeout: 120000 }, async (t) => {
	const { visualReviewRun } = await import(pathToFileURL(path.join(agent, "extensions/lib/creative-qa.ts")));
	const { normalizeDirection } = await import(pathToFileURL(path.join(agent, "extensions/lib/creative-direction.ts")));
	const { renderCapture } = await import(pathToFileURL(path.join(agent, "scripts/render-capture.mjs")));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-signature-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const page = path.join(dir, "page.html");
	fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>t</title><body style="margin:0;font:16px sans-serif;background:#f4f1ea;color:#1b2430"><main style="padding:48px"><h1 style="font-size:44px;margin:0 0 12px">A page with a headline</h1><p style="max-width:52ch">Body copy that is long enough to be measured as text and not as an icon or a divider.</p><button style="padding:12px 20px;background:#0b6b5c;color:#fff;border:0;border-radius:6px">Open</button></main>`);
	const capture = (params, dest, _cwd, signal) => renderCapture({ ...params, output: "both" }, dest, signal);
	const base = { name: "world", intent: ["alive"], hierarchy: { primary: "the generated world" } };
	try {
		const rich = await visualReviewRun({ source: page, width: 800, height: 500, outputDir: path.join(dir, "rich"), direction: normalizeDirection({ ...base, ambition: "immersive", signature: "generated isometric island of destinations" }) }, dir, undefined, capture);
		const section = rich.sections.find((s) => s.id === "direction");
		assert.equal(section.needsVision, true, "a pixel judgment is needed: measurement cannot tell whether the signature is there");
		assert.match(section.evidence.join("\n"), /signature "generated isometric island of destinations" must be visible in this render/);
		assert.match(section.evidence.join("\n"), /ambition immersive: judge coherence/);
		const plain = await visualReviewRun({ source: page, width: 800, height: 500, outputDir: path.join(dir, "plain"), direction: normalizeDirection({ ...base, intent: ["calm"] }) }, dir, undefined, capture);
		const quiet = plain.sections.find((s) => s.id === "direction");
		assert.equal(quiet.needsVision, undefined, "a direction without a signature or immersive level adds no new demand");
		assert.doesNotMatch(quiet.evidence.join("\n"), /signature|ambition immersive/);
	} catch (error) {
		if (process.env.PI_BROWSER_REQUIRE !== "1" && /browserType\.launch|browser startup failure|ffmpeg|ENOENT/i.test(String(error?.message))) return t.skip("Chromium or ffmpeg unavailable");
		throw error;
	}
});
