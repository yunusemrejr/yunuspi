import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/blender-studio.ts")));
assert.ok(agent, "blender studio source must exist");
const blender = await import(pathToFileURL(path.join(agent, "extensions/lib/blender-studio.ts")).href);
const lichtfeld = await import(pathToFileURL(path.join(agent, "extensions/lib/lichtfeld-studio.ts")).href);
const { skillRoutes } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")).href);
const route = (name) => skillRoutes.find((r) => r.name === name);
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-3d-"));

test("3d studio registers nine lazily discovered tools wired into manifest, catalog, bundles and hooks", async () => {
  const tools = [];
  const extension = await import(pathToFileURL(path.join(agent, "extensions/blender-studio.ts")).href);
  extension.default({ registerTool: (tool) => tools.push(tool) });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["blender_export", "blender_inspect", "blender_render", "blender_run", "blender_setup", "lichtfeld_convert", "lichtfeld_render", "lichtfeld_setup", "lichtfeld_train"]);
  const { CORE_TOOLS, INTENT_BUNDLES } = await import(pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts")).href);
  for (const tool of tools) {
    assert.equal(CORE_TOOLS.has(tool.name), false, `${tool.name} stays off-wire until tool_search enables it`);
    assert.ok(tool.description.length > 80 && tool.parameters?.type === "object", tool.name);
  }
  const bundled = new Set(INTENT_BUNDLES.filter((b) => ["blender-production", "gaussian-splatting"].includes(b.skill)).flatMap((b) => b.tools));
  for (const name of names) assert.ok(bundled.has(name), `${name} is staged by a skill intent bundle`);
  const manifest = JSON.parse(fs.readFileSync(path.join(agent, "extensions/manifest.json"), "utf8"));
  assert.ok(manifest.extensions.includes("blender-studio.ts"));
  for (const lib of ["blender-studio.ts", "lichtfeld-studio.ts", "guarded-process.ts"]) assert.ok(manifest.lib.includes(lib), lib);
  assert.ok(manifest.supportFiles.includes("scripts/blender-studio.py"));
  assert.ok(fs.existsSync(blender.BLENDER_WORKER));
  const { HARNESS_CAPABILITIES } = await import(pathToFileURL(path.join(agent, "extensions/lib/harness-capabilities.ts")).href);
  const record = HARNESS_CAPABILITIES.find((c) => c.id === "3d-studio");
  assert.ok(record && names.every((n) => record.tools.includes(n)), "catalog lists every tool");
  for (const file of record.sourceFiles) assert.ok(fs.existsSync(path.join(repo, file)) || fs.existsSync(path.join(agent, "..", file)), file);
  const hooks = fs.readFileSync(path.join(agent, "extensions/lib/session-hooks.ts"), "utf8");
  assert.ok(hooks.includes('"blender_render"') && hooks.includes('"lichtfeld_train"'), "media recovery hook covers the 3d tools");
  assert.match(blender.BLENDER_RELEASE.sha256, /^[0-9a-f]{64}$/);
  assert.match(blender.BLENDER_RELEASE.url, /^https:\/\/download\.blender\.org\/release\//);
});

test("skills route 3d prompts: blender-production and gaussian-splatting", () => {
  const blend = route("blender-production"), splat = route("gaussian-splatting");
  assert.ok(blend && splat);
  for (const prompt of ["model a chair in Blender and render it", "make a 3D model of a coffee cup and a turntable animation", "write a bpy script for a procedural city", "animate a 3d character walk cycle"]) assert.ok(blend.intent.test(prompt), prompt);
  for (const prompt of ["render the video thumbnail", "fix the 3d-secure checkout flow typo", "build a video player"]) assert.equal(blend.intent.test(prompt), false, prompt);
  for (const prompt of ["train gaussian splats from these photos", "turn this COLMAP dataset into a 3DGS scene", "render a NeRF-style radiance field", "use lichtfeld to make a splat"]) assert.ok(splat.intent.test(prompt), prompt);
  for (const prompt of ["fix the splash screen", "add a splatter brush to the paint app"]) assert.equal(splat.intent.test(prompt), false, prompt);
  assert.ok(splat.file.test("scene/transforms.json") && splat.file.test("out/project.licht") && blend.file.test("assets/scene.blend"));
  assert.ok(fs.existsSync(path.join(agent, "skills/gaussian-splatting/SKILL.md")));
  const skill = fs.readFileSync(path.join(agent, "skills/blender-production/SKILL.md"), "utf8");
  for (const tool of ["blender_inspect", "blender_run", "blender_render", "blender_export"]) assert.ok(skill.includes(tool), tool);
});

test("lichtfeld CLI translation, dataset inspection and camera-path math", async () => {
  const args = lichtfeld.trainArgs({ iterations: 7000, strategy: "mcmc", maxGaussians: 500000, eval: true, evalSteps: [1000, 7000], export: ["ply", "html"], bilateralGrid: true, extraArgs: ["--min-opacity", "0.01"] }, "/data", "/out");
  assert.deepEqual(args, ["--headless", "-d", "/data", "-o", "/out", "--iter", "7000", "--strategy", "mcmc", "--max-cap", "500000", "--eval", "--eval-steps", "1000,7000", "--bilateral-grid", "--export", "ply,html", "--min-opacity", "0.01"]);
  assert.throws(() => lichtfeld.trainArgs({ extraArgs: ["--x; rm -rf /"] }, "/d", "/o"), /unsafe/);
  assert.throws(() => lichtfeld.trainArgs({ export: ["exe"] }, "/d", "/o"), /export formats/);
  assert.deepEqual(lichtfeld.trainArgs({}, "/d", "/o").slice(-2), ["--export", "ply"]);
  // Identity when looking down -Z; a quarter turn about Y from +X.
  assert.deepEqual(lichtfeld.lookAtQuaternion([0, 0, 5], [0, 0, 0]), [1, 0, 0, 0]);
  const quarter = lichtfeld.lookAtQuaternion([5, 0, 0], [0, 0, 0]);
  assert.ok(Math.abs(quarter[0] - Math.SQRT1_2) < 1e-6 && Math.abs(quarter[2] - Math.SQRT1_2) < 1e-6 && Math.abs(quarter[1]) < 1e-6 && Math.abs(quarter[3]) < 1e-6);
  const orbit = lichtfeld.orbitPath({ radius: 2, elevationDeg: 30, seconds: 4, keyframes: 8, up: [0, 0, 1] });
  assert.equal(orbit.version, 4);
  assert.equal(orbit.keyframes.length, 9);
  assert.deepEqual(orbit.keyframes[0].position, orbit.keyframes.at(-1).position, "the turntable closes its loop");
  for (const k of orbit.keyframes) {
    assert.ok(Math.abs(Math.hypot(...k.position) - 2) < 1e-4, "every keyframe sits on the orbit sphere");
    assert.ok(Math.abs(k.position[2] - 1) < 1e-4, "elevation 30° at radius 2 keeps z = 1 with Z up");
    assert.ok(Math.abs(Math.hypot(...k.rotation) - 1) < 1e-5, "unit quaternion");
    assert.equal(typeof k.easing, "number");
  }
  assert.equal(orbit.keyframes.at(-1).time, 4);
  const dir = workspace();
  await assert.rejects(lichtfeld.inspectDataset(dir), /not a dataset/);
  fs.mkdirSync(path.join(dir, "images"));
  fs.writeFileSync(path.join(dir, "transforms.json"), JSON.stringify({ camera_angle_x: 0.69, w: 64, h: 64, frames: [{ file_path: "images/r_000.png", transform_matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 3], [0, 0, 0, 1]] }] }));
  const missing = await lichtfeld.inspectDataset(dir);
  assert.equal(missing.format, "blender");
  assert.ok(missing.issues.some((i) => /missing/.test(i)) && missing.issues.some((i) => /only 1 views/.test(i)));
  fs.writeFileSync(path.join(dir, "images/r_000.png"), "x");
  assert.equal((await lichtfeld.inspectDataset(dir)).issues.some((i) => /missing/.test(i)), false);
  const colmap = workspace();
  fs.mkdirSync(path.join(colmap, "sparse/0"), { recursive: true });
  fs.writeFileSync(path.join(colmap, "sparse/0/cameras.bin"), "");
  assert.equal((await lichtfeld.inspectDataset(colmap)).format, "colmap");
  const check = await lichtfeld.lichtfeldTrain({ dataset: dir, action: "check", iterations: 100 }, dir);
  assert.equal(check.command[0], "LichtFeld-Studio");
  assert.ok(check.command.includes("--headless"));
  assert.ok(typeof check.gpu.nvidia === "boolean");
  const status = await lichtfeld.lichtfeldStatus();
  assert.ok(status.hardware.minComputeCapability === 7.5 && Array.isArray(status.exports));
  if (!status.gpu.nvidia) {
    assert.match(status.note, /NVIDIA GPU/);
    await assert.rejects(lichtfeld.lichtfeldTrain({ dataset: dir }, dir), /NVIDIA GPU/);
    const skipped = await lichtfeld.lichtfeldInstall({});
    assert.equal(skipped.skipped, true);
    assert.ok(skipped.aptPackages.includes("cmake"));
  }
  const pathOnly = await lichtfeld.lichtfeldRender({ model: path.join(dir, "transforms.json"), action: "path", up: [0, 0, 1], radius: 3, orbitKeyframes: 6 }, dir);
  const written = JSON.parse(fs.readFileSync(pathOnly.cameraPath, "utf8"));
  assert.equal(written.keyframes.length, 7);
  assert.ok(pathOnly.cameraPath.startsWith(dir), "camera path is written inside the workspace");
});

test("blender status and workspace write guards", async () => {
  const status = await blender.blenderStatus();
  assert.equal(typeof status.installed, "boolean");
  assert.equal(status.pinned, blender.BLENDER_RELEASE.version);
  const dir = workspace();
  await assert.rejects(blender.writablePath("/etc/passwd", dir), /inside the current workspace/);
  await assert.rejects(blender.writablePath("http://x/y", dir), /local path/);
  await assert.rejects(blender.blenderInspect({ blend: path.join(dir, "missing.blend") }, dir), /does not exist/);
  await assert.rejects(blender.blenderRun({}, dir), /script.*or code/);
  fs.writeFileSync(path.join(dir, "x.blend"), "");
  await assert.rejects(blender.blenderExport({ blend: "x.blend", format: "exe" }, dir), /format must be one of/);
});

const installed = blender.blenderBinary();
const quick = process.env.YUNUSPI_SKIP_BLENDER_RENDER === "1";
test("blender builds, inspects, renders, exports and captures a dataset headless", { skip: !installed ? "Blender is not installed" : quick ? "YUNUSPI_SKIP_BLENDER_RENDER" : false, timeout: 600_000 }, async () => {
  const dir = workspace();
  const blend = path.join(dir, "scene.blend");
  const made = await blender.blenderRun({ code: `
import bpy, json
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 0))
ball = bpy.context.object; ball.name = "Ball"
bpy.data.objects['Cube'].hide_render = True
scene = bpy.context.scene; scene.frame_end = 3
ball.location = (0, 0, 0); ball.keyframe_insert('location', frame=1)
ball.location = (0, 0, 1); ball.keyframe_insert('location', frame=3)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})
print("YUNUSPI_RESULT " + json.dumps({"objects": len(bpy.data.objects)}))
` }, dir);
  assert.equal(made.result.objects, 4);
  assert.ok(made.written.includes("scene.blend"));
  await assert.rejects(blender.blenderRun({ code: "raise RuntimeError('boom')" }, dir), /RuntimeError: boom/);
  const info = await blender.blenderInspect({ blend }, dir);
  assert.ok(info.objects.some((o) => o.name === "Ball" && o.type === "MESH" && o.animation));
  assert.equal(info.render.camera, "Camera");
  assert.deepEqual(info.render.frames, [1, 3]);
  const still = await blender.blenderRender({ blend, mode: "still", width: 64, height: 36, engine: "WORKBENCH" }, dir);
  assert.equal(still.files.length, 1);
  assert.ok(fs.statSync(still.files[0].path).size > 100);
  assert.deepEqual(still.render.effective, [64, 36]);
  assert.ok(still.outputDir.startsWith(path.join(dir, ".pi", "blender")));
  const anim = await blender.blenderRender({ blend, mode: "animation", from: 1, to: 3, width: 64, height: 36, engine: "WORKBENCH", fps: 3 }, dir);
  assert.equal(anim.frames, 3);
  assert.ok(anim.video && fs.statSync(anim.video).size > 0, anim.videoError);
  assert.ok(anim.contactSheet && fs.existsSync(anim.contactSheet), anim.contactSheetError);
  const glb = await blender.blenderExport({ blend, format: "glb", objects: ["Ball"] }, dir);
  assert.ok(glb.files[0].bytes > 500 && glb.files[0].path.endsWith(".glb"));
  const dataset = await blender.blenderExport({ blend, format: "dataset", views: 4, elevations: [30], width: 32, height: 32, engine: "WORKBENCH" }, dir);
  assert.equal(dataset.views, 4);
  const transforms = JSON.parse(fs.readFileSync(dataset.transforms, "utf8"));
  assert.equal(transforms.frames.length, 4);
  assert.ok(transforms.camera_angle_x > 0 && transforms.w === 32);
  for (const frame of transforms.frames) {
    assert.ok(fs.existsSync(path.join(dataset.outputDir, frame.file_path)));
    const m = frame.transform_matrix;
    assert.equal(m.length, 4);
    assert.ok(Math.abs(Math.hypot(m[0][3], m[1][3], m[2][3]) - dataset.radius) < 1e-3, "camera sits on the capture sphere");
  }
  const again = await blender.blenderInspect({ blend }, dir);
  assert.equal(again.objects.some((o) => o.name === "YunusPiDatasetCamera"), false, "the dataset camera never lands in the user's file");
  const checked = await lichtfeld.inspectDataset(dataset.outputDir);
  assert.equal(checked.views, 4);
});
