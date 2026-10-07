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
const splat = await import(pathToFileURL(path.join(agent, "extensions/lib/splat-studio.ts")).href);
const { skillRoutes } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")).href);
const route = (name) => skillRoutes.find((r) => r.name === name);
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-3d-"));

test("3d studio registers eight lazily discovered tools wired into manifest, catalog, bundles and hooks", async () => {
  const tools = [];
  const extension = await import(pathToFileURL(path.join(agent, "extensions/blender-studio.ts")).href);
  extension.default({ registerTool: (tool) => tools.push(tool) });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["blender_export", "blender_inspect", "blender_render", "blender_run", "blender_setup", "splat_preview", "splat_setup", "splat_train"]);
  const { CORE_TOOLS, INTENT_BUNDLES } = await import(pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts")).href);
  for (const tool of tools) {
    assert.equal(CORE_TOOLS.has(tool.name), false, `${tool.name} stays off-wire until tool_search enables it`);
    assert.ok(tool.description.length > 80 && tool.parameters?.type === "object", tool.name);
  }
  const bundled = new Set(INTENT_BUNDLES.filter((b) => ["blender-production", "gaussian-splatting"].includes(b.skill)).flatMap((b) => b.tools));
  for (const name of names) assert.ok(bundled.has(name), `${name} is staged by a skill intent bundle`);
  const manifest = JSON.parse(fs.readFileSync(path.join(agent, "extensions/manifest.json"), "utf8"));
  assert.ok(manifest.extensions.includes("blender-studio.ts"));
  for (const lib of ["blender-studio.ts", "splat-studio.ts", "guarded-process.ts"]) assert.ok(manifest.lib.includes(lib), lib);
  assert.ok(manifest.supportFiles.includes("scripts/blender-studio.py"));
  assert.ok(fs.existsSync(blender.BLENDER_WORKER));
  const { HARNESS_CAPABILITIES } = await import(pathToFileURL(path.join(agent, "extensions/lib/harness-capabilities.ts")).href);
  const record = HARNESS_CAPABILITIES.find((c) => c.id === "3d-studio");
  assert.ok(record && names.every((n) => record.tools.includes(n)), "catalog lists every tool");
  for (const file of record.sourceFiles) assert.ok(fs.existsSync(path.join(repo, file)) || fs.existsSync(path.join(agent, "..", file)), file);
  const hooks = fs.readFileSync(path.join(agent, "extensions/lib/session-hooks.ts"), "utf8");
  assert.ok(hooks.includes('"blender_render"') && hooks.includes('"splat_train"'), "media recovery hook covers the 3d tools");
  assert.match(splat.BRUSH_RELEASE.sha256, /^[0-9a-f]{64}$/);
  assert.match(splat.BRUSH_RELEASE.url, /^https:\/\/github\.com\/ArthurBrussee\/brush\/releases\/download\//);
  assert.match(blender.BLENDER_RELEASE.sha256, /^[0-9a-f]{64}$/);
  assert.match(blender.BLENDER_RELEASE.url, /^https:\/\/download\.blender\.org\/release\//);
});

test("skills route 3d prompts: blender-production and gaussian-splatting", () => {
  const blend = route("blender-production"), splat = route("gaussian-splatting");
  assert.ok(blend && splat);
  for (const prompt of ["model a chair in Blender and render it", "make a 3D model of a coffee cup and a turntable animation", "write a bpy script for a procedural city", "animate a 3d character walk cycle"]) assert.ok(blend.intent.test(prompt), prompt);
  for (const prompt of ["render the video thumbnail", "fix the 3d-secure checkout flow typo", "build a video player"]) assert.equal(blend.intent.test(prompt), false, prompt);
  for (const prompt of ["train gaussian splats from these photos", "turn this COLMAP dataset into a 3DGS scene", "render a NeRF-style radiance field", "make a splat of this object"]) assert.ok(splat.intent.test(prompt), prompt);
  for (const prompt of ["fix the splash screen", "add a splatter brush to the paint app"]) assert.equal(splat.intent.test(prompt), false, prompt);
  assert.ok(splat.file.test("scene/transforms.json") && splat.file.test("out/splat_1500.ply") && blend.file.test("assets/scene.blend"));
  assert.ok(fs.existsSync(path.join(agent, "skills/gaussian-splatting/SKILL.md")));
  const skill = fs.readFileSync(path.join(agent, "skills/blender-production/SKILL.md"), "utf8");
  for (const tool of ["blender_inspect", "blender_run", "blender_render", "blender_export"]) assert.ok(skill.includes(tool), tool);
});

test("brush CLI translation, dataset inspection and vulkan preflight", async () => {
  const args = splat.trainArgs({ steps: 2000, evalSplitEvery: 8, maxSplats: 300000, shDegree: 2, extraArgs: ["--lr-mean", "1e-5"] }, "/data", "/out");
  assert.deepEqual(args, ["/data", "--total-steps", "2000", "--export-path", "/out", "--export-every", "2000", "--export-name", "splat_{iter}.ply", "--eval-split-every", "8", "--eval-every", "500", "--eval-save-to-disk", "--max-splats", "300000", "--sh-degree", "2", "--lr-mean", "1e-5"]);
  assert.throws(() => splat.trainArgs({ extraArgs: ["--x; rm -rf /"] }, "/d", "/o"), /unsafe/);
  assert.ok(!splat.trainArgs({ steps: 500 }, "/d", "/o").includes("--eval-save-to-disk"), "no eval split, no eval renders");
  const dir = workspace();
  await assert.rejects(splat.inspectDataset(dir), /not a dataset/);
  fs.mkdirSync(path.join(dir, "images"));
  fs.writeFileSync(path.join(dir, "transforms.json"), JSON.stringify({ camera_angle_x: 0.69, w: 64, h: 64, frames: [{ file_path: "images/r_000.png", transform_matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 3], [0, 0, 0, 1]] }] }));
  const missing = await splat.inspectDataset(dir);
  assert.equal(missing.format, "nerfstudio");
  assert.ok(missing.issues.some((i) => /missing/.test(i)) && missing.issues.some((i) => /only 1 views/.test(i)) && missing.issues.some((i) => /seed point/.test(i)));
  fs.writeFileSync(path.join(dir, "images/r_000.png"), "x");
  const small = await splat.inspectDataset(dir);
  assert.ok(small.issues.some((i) => /under 16387 bytes/.test(i)), "tiny images are flagged for the Brush header probe");
  fs.writeFileSync(path.join(dir, "init.ply"), "ply\n");
  assert.equal((await splat.inspectDataset(dir)).issues.some((i) => /seed point/.test(i)), false);
  const colmap = workspace();
  fs.mkdirSync(path.join(colmap, "sparse/0"), { recursive: true });
  fs.writeFileSync(path.join(colmap, "sparse/0/cameras.bin"), "");
  assert.equal((await splat.inspectDataset(colmap)).format, "colmap");
  const check = await splat.splatTrain({ dataset: dir, action: "check", steps: 100 }, dir);
  assert.equal(check.command[0], "brush_app");
  assert.ok(check.command.includes("--total-steps") && typeof check.vulkan.ok === "boolean");
  await assert.rejects(splat.splatTrain({ dataset: dir, steps: 100 }, dir), /cannot load|Dataset problems/);
  const status = await splat.brushStatus();
  assert.equal(status.pinned, splat.BRUSH_RELEASE.version);
  assert.ok(Array.isArray(status.vulkan.icds));
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
for face in ball.data.polygons: face.use_smooth = True
material = bpy.data.materials.new('InspectionFabric'); material.use_nodes = True
shader = material.node_tree.nodes.get('Principled BSDF')
shader.inputs['Roughness'].default_value = 0.37
shader.inputs['Metallic'].default_value = 0.65
noise = material.node_tree.nodes.new('ShaderNodeTexNoise')
material.node_tree.links.new(noise.outputs['Color'], shader.inputs['Base Color'])
image = bpy.data.images.new('PackedInspectionTexture', width=1, height=1)
image.filepath_raw = ${JSON.stringify(path.join(dir, 'packed-source.png'))}
image.file_format = 'PNG'; image.save()
image = bpy.data.images.load(image.filepath_raw)
image.pack(); image.filepath = '//missing-but-packed.png'
texture = material.node_tree.nodes.new('ShaderNodeTexImage'); texture.image = image
ball.data.materials.append(material)
bpy.data.objects['Cube'].hide_render = True
bpy.data.objects['Light'].hide_render = True
other = bpy.data.scenes.new('UnrelatedScene')
other_light = bpy.data.objects.new('UnrelatedLight', bpy.data.lights.new('UnrelatedLightData', 'POINT'))
other.collection.objects.link(other_light)
scene = bpy.context.scene; scene.frame_end = 3
ball.location = (0, 0, 0); ball.keyframe_insert('location', frame=1)
ball.location = (0, 0, 1); ball.keyframe_insert('location', frame=3)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})
print("YUNUSPI_RESULT " + json.dumps({"objects": len(bpy.data.objects)}))
` }, dir);
  assert.equal(made.result.objects, 5);
  assert.ok(made.written.includes("scene.blend"));
  await assert.rejects(blender.blenderRun({ code: "raise RuntimeError('boom')" }, dir), /RuntimeError: boom/);
  const info = await blender.blenderInspect({ blend }, dir);
  assert.ok(info.objects.some((o) => o.name === "Ball" && o.type === "MESH" && o.animation));
  assert.equal(info.render.camera, "Camera");
  assert.deepEqual(info.render.frames, [1, 3]);
  const fabric = info.materialDetails.find((m) => m.name === "InspectionFabric");
  const inputs = fabric.shader.surfaces.find((s) => s.type === "BSDF_PRINCIPLED").inputs;
  assert.ok(Math.abs(inputs.Roughness.default - 0.37) < 1e-5);
  assert.ok(Math.abs(inputs.Metallic.default - 0.65) < 1e-5);
  assert.equal(inputs["Base Color"].linked, true);
  assert.equal(inputs["Base Color"].sources[0].type, "TEX_NOISE");
  assert.equal(fabric.shader.textures[0].packed, true);
  assert.ok(fabric.shader.textures[0].colorSpace);
  assert.ok(info.colorManagement.viewTransform);
  assert.ok(info.world.shader.surfaces.length);
  assert.equal(info.objects.find((o) => o.name === "Ball").inScene, true);
  assert.ok(info.objects.find((o) => o.name === "Ball").smoothFaces > 0);
  assert.deepEqual(info.sceneLights, []);
  assert.equal(info.objects.find((o) => o.name === 'UnrelatedLight').inScene, false);
  assert.ok(info.warnings.some((w) => w.includes('selected scene')));
  assert.equal(info.missingFiles.some((f) => String(f).includes('missing-but-packed')), false);
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
  const checked = await splat.inspectDataset(dataset.outputDir);
  assert.equal(checked.views, 4);
  assert.ok(checked.pointCloud && dataset.seedPoints > 0, "dataset capture writes init.ply seed points");
  for (const frame of transforms.frames) assert.ok(fs.statSync(path.join(dataset.outputDir, frame.file_path)).size >= splat.MIN_IMAGE_BYTES, "tiny renders are padded for the trainer");
});

test("brush trains headless and the preview renders the splat", { skip: !splat.brushBinary() ? "Brush is not installed" : !installed ? "Blender is not installed" : quick ? "YUNUSPI_SKIP_BLENDER_RENDER" : !(await splat.detectVulkan()).ok ? "no Vulkan driver" : false, timeout: 900_000 }, async () => {
  const dir = workspace();
  const blend = path.join(dir, "scene.blend");
  await blender.blenderRun({ code: `
import bpy
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 0))
bpy.data.objects['Cube'].hide_render = True
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})` }, dir);
  const dataset = await blender.blenderExport({ blend, format: "dataset", views: 16, elevations: [20, 45], width: 96, height: 96, engine: "WORKBENCH" }, dir);
  const trained = await splat.splatTrain({ dataset: dataset.outputDir, steps: 300, evalSplitEvery: 8, maxSplats: 50000 }, dir);
  assert.ok(fs.statSync(trained.splat).size > 1000 && trained.splats > 0, JSON.stringify(trained.warnings));
  assert.ok(trained.fidelitySheet && fs.existsSync(trained.fidelitySheet), "held-out renders are tiled beside ground truth");
  const preview = await splat.splatPreview({ path: trained.splat, frames: 3, width: 64, height: 48, engine: "WORKBENCH" }, dir);
  assert.ok(preview.video && fs.existsSync(preview.video) && preview.contactSheet, preview.videoError);
  assert.ok(preview.outputDir.startsWith(path.join(dir, ".pi", "splats")));
});
