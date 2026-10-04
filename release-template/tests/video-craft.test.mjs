import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/video-derive.ts")));
assert.ok(agent, "video derive source must exist");
const load = (rel) => import(pathToFileURL(path.join(agent, rel)).href);
const derive = await load("extensions/lib/video-derive.ts");
const looks = await load("extensions/lib/video-looks.ts");
const shotLib = await load("extensions/lib/video-shot.ts");
const blender = await load("extensions/lib/blender-studio.ts");

const BRIEFS = [
  "how tides and ocean currents move heat around the planet", "why banks fail: a history of runs on deposits", "a launch film for a developer tool that compiles in milliseconds",
  "the life cycle of a mycelium network", "introducing a quiet journaling app for evenings", "inside a jet engine: compressors, combustors and turbines", "a documentary on the Silk Road",
  "tax software for freelancers", "a loud, bold trailer for an indie racing game", "how vaccines train the immune system", "a calm guided breathing video", "the economics of a neighbourhood bakery",
  "quantum error correction explained", "a wedding invitation for a vineyard ceremony", "cybersecurity threat briefing for executives", "a museum tour of Bronze Age tools",
];

test("derived looks are deterministic, varied and never one of the stock defaults", () => {
  const seen = new Set();
  for (const brief of BRIEFS) {
    const a = derive.deriveLook(brief), b = derive.deriveLook(brief);
    assert.deepEqual(a.theme, b.theme, `${brief}: same brief, same look`);
    const issues = looks.lintDesign({ theme: a.theme, scenes: [] }).filter((i) => ["indigo-accent", "cream-terracotta", "pure-neutral", "contrast", "default-font", "same-font", "mono-display", "legacy-palette"].includes(i.id));
    assert.deepEqual(issues, [], `${brief}: ${issues.map((i) => i.id)}`);
    assert.notEqual(a.theme.display, a.theme.text, `${brief}: a real pairing`);
    assert.ok(a.derived.domains.length >= 0 && a.derived.hue >= 0 && a.derived.hue < 360);
    seen.add(`${a.theme.background}|${a.theme.accent}`);
  }
  assert.ok(seen.size >= BRIEFS.length - 1, "different subjects get different palettes");
  assert.notDeepEqual(derive.deriveLook(BRIEFS[0], { variation: 1 }).theme, derive.deriveLook(BRIEFS[0]).theme, "variation re-rolls");
});

test("a brand accent and a forced tone anchor the derivation", () => {
  const brand = "#c2185b";
  const look = derive.deriveLook("launch film for a payments company", { accent: brand });
  const want = derive.oklchHue(brand).hue, got = derive.oklchHue(look.theme.accent).hue;
  assert.ok(Math.min(Math.abs(want - got), 360 - Math.abs(want - got)) < 20, `accent hue ${got} follows the brand hue ${want}`);
  for (const tone of ["dark", "light"]) assert.equal(derive.deriveLook("a film about maps", { tone }).tone, tone);
  assert.ok(derive.curatedIds().includes("paper-lab"));
});

test("design lint names metronome pacing, transition monotony and avoided defaults", () => {
  const theme = derive.deriveLook("the life of a river").theme;
  const even = Array.from({ length: 6 }, (_, i) => ({ component: i % 2 ? "TitleCard" : "DiagramScene", seconds: 6, transition: { type: "fade" } }));
  const ids = looks.lintDesign({ theme, scenes: even }).map((i) => i.id);
  assert.ok(ids.includes("metronome") && ids.includes("transition-monotony"), ids.join());
  const varied = even.map((scene, i) => ({ ...scene, seconds: [3, 9, 5, 12, 4, 7][i], transition: { type: ["fade", "wipe", "slide", "zoom", "fade", "blur"][i] } }));
  const quiet = looks.lintDesign({ theme, scenes: varied }).map((i) => i.id);
  assert.ok(!quiet.includes("metronome") && !quiet.includes("transition-monotony"), quiet.join());
  assert.ok(looks.lintDesign({ theme: { ...theme, background: "#0d0b2a", accent: "#7a5cff" }, scenes: [] }).some((i) => i.id === "indigo-accent"));
});

test("source lint flags non-deterministic and stock-looking scene code, and honours the allow list", () => {
  const bad = {
    "src/scenes/A.tsx": `const x = Math.random(); const t = Date.now(); const s = <div style={{ boxShadow: "0 0 60px #7a5cff", borderLeft: "4px solid #7a5cff", fontFamily: "Inter, sans-serif" }}>🚀</div>; const g = "linear-gradient(120deg, #6d28d9, #c026d3)";`,
  };
  const ids = looks.lintSource(bad).map((i) => i.id);
  for (const id of ["nondeterministic", "glow-halo", "accent-rail", "hard-coded-font", "emoji-icons", "violet-gradient"]) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.equal(looks.lintSource(bad).find((i) => i.id === "nondeterministic").severity, "error");
  assert.deepEqual(looks.lintSource({ "src/scenes/B.tsx": `// Math.random in a comment\nconst t = useTheme(); const y = rng(3)();` }), []);
  assert.ok(!looks.lintSource(bad, new Set(["glow-halo"])).some((i) => i.id === "glow-halo"));
});

test("a shot plan is cheap as a preview, project-sized as a final, and bounded", () => {
  const spec = { width: 1920, height: 1080, fps: 30 };
  const preview = shotLib.planShot({ seconds: 4 }, spec), final = shotLib.planShot({ seconds: 4, mode: "final" }, spec);
  assert.deepEqual([preview.width, preview.height, preview.fps, preview.samples], [960, 540, 12, 16]);
  assert.deepEqual([final.width, final.height, final.fps, final.samples], [1920, 1080, 30, 64]);
  assert.equal(preview.frames, 48);
  assert.equal(shotLib.planShot({ seconds: 3 }, { width: 1080, height: 1920, fps: 30 }).height % 2, 0);
  assert.throws(() => shotLib.planShot({ seconds: 30, mode: "final" }, spec), /600-frame limit/);
  assert.deepEqual(shotLib.SHOT_RIGS.slice(0, 3), ["turntable", "orbit", "push-in"]);
});

const installed = blender.blenderBinary();
const quick = process.env.YUNUSPI_SKIP_BLENDER_RENDER === "1";
test("a Blender shot renders a lit RGBA sequence with a manifest and review sheet, and refuses to overwrite", { skip: !installed ? "Blender is not installed" : quick ? "YUNUSPI_SKIP_BLENDER_RENDER" : false, timeout: 400_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-shot-"));
  fs.writeFileSync(path.join(dir, "video.json"), JSON.stringify({ width: 640, height: 360, fps: 30, theme: { background: "#0d1512", accent: "#d6e35a", accent2: "#3f7a58" }, scenes: [] }));
  const result = await shotLib.videoShot({ dir, name: "title", title: { text: "TIDE" }, seconds: 1, fps: 6, width: 192, height: 108, samples: 8, anchors: ["bbox:top"] }, dir);
  assert.equal(result.frames, 6);
  assert.equal(result.alpha, true);
  assert.deepEqual(result.anchors, ["top"]);
  const shot = path.join(dir, "public/shots/title");
  const manifest = JSON.parse(fs.readFileSync(path.join(shot, "shot.json"), "utf8"));
  assert.equal(manifest.format, "yunuspi-shot-v1");
  assert.equal(manifest.quality, "preview");
  for (let i = 1; i <= 6; i++) assert.ok(fs.statSync(path.join(shot, `frame-${String(i).padStart(4, "0")}.png`)).size > 100);
  const track = JSON.parse(fs.readFileSync(path.join(shot, "anchors.json"), "utf8"));
  assert.equal(track.frames.length, 6);
  assert.ok(track.frames.every((f) => f.anchors.top.x >= 0 && f.anchors.top.x <= 1 && f.anchors.top.y >= 0 && f.anchors.top.y <= 1));
  assert.ok(fs.existsSync(path.join(dir, "blender/title.blend")), "the editable scene is kept");
  assert.ok(result.contactSheet, "a contact sheet is produced for review");
  assert.match(result.use, /BlenderShot|ShotScene/);
  await assert.rejects(shotLib.videoShot({ dir, name: "title", title: { text: "TIDE" }, seconds: 1, fps: 6, width: 192, height: 108 }, dir), /already exists/);
  // a bad path leaves nothing behind, and the project-relative path the saved scene is known by works from another cwd
  await assert.rejects(shotLib.videoShot({ dir, name: "ghost", blend: "blender/none.blend" }, dir), /does not exist/);
  assert.equal(fs.existsSync(path.join(dir, "public/shots/ghost")), false);
  fs.mkdirSync(path.join(dir, "public/shots/stale"), { recursive: true });
  const again = await shotLib.videoShot({ dir, name: "stale", blend: "blender/title.blend", seconds: 1, fps: 6, width: 160, height: 90, samples: 8, lights: "scene" }, path.dirname(dir));
  assert.equal(again.frames, 6, "an empty folder from a failed render is replaced without replace:true, and a project-relative blend resolves");
  assert.equal(fs.existsSync(path.join(dir, "blender/title.blend")), true);
  await assert.rejects(shotLib.videoShot({ dir, name: "Bad Name", title: { text: "x" } }, dir), /kebab-case/);
  await assert.rejects(shotLib.videoShot({ dir, name: "two", title: { text: "x" }, model: "m.glb" }, dir), /exactly one source/);
});
