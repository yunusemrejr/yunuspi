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
const { skillRoutes } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")).href);
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-3d-"));

test("3d studio registers one lazily discovered blender tool wired into manifest, catalog, bundles and hooks", async () => {
  const tools = [];
  const extension = await import(pathToFileURL(path.join(agent, "extensions/blender-studio.ts")).href);
  extension.default({ registerTool: (tool) => tools.push(tool) });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["blender"]);
  const { CORE_TOOLS, INTENT_BUNDLES } = await import(pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts")).href);
  for (const tool of tools) {
    assert.equal(CORE_TOOLS.has(tool.name), false, `${tool.name} stays off-wire until tool_search enables it`);
    assert.ok(tool.description.length > 80 && tool.parameters?.type === "object", tool.name);
  }
  const bundled = new Set(INTENT_BUNDLES.filter((b) => b.skill === "3d-cad").flatMap((b) => b.tools));
  for (const name of names) assert.ok(bundled.has(name), `${name} is staged by a skill intent bundle`);
  const manifest = JSON.parse(fs.readFileSync(path.join(agent, "extensions/manifest.json"), "utf8"));
  assert.ok(manifest.extensions.includes("blender-studio.ts"));
  for (const lib of ["blender-studio.ts", "guarded-process.ts"]) assert.ok(manifest.lib.includes(lib), lib);
  assert.ok(manifest.supportFiles.includes("scripts/blender-studio.py"));
  assert.ok(fs.existsSync(blender.BLENDER_WORKER));
  const { HARNESS_CAPABILITIES } = await import(pathToFileURL(path.join(agent, "extensions/lib/harness-capabilities.ts")).href);
  const record = HARNESS_CAPABILITIES.find((c) => c.id === "3d-studio");
  assert.ok(record && names.every((n) => record.tools.includes(n)), "catalog lists every tool");
  for (const file of record.sourceFiles) assert.ok(fs.existsSync(path.join(repo, file)) || fs.existsSync(path.join(agent, "..", file)), file);
  assert.match(blender.BLENDER_RELEASE.sha256, /^[0-9a-f]{64}$/);
  assert.match(blender.BLENDER_RELEASE.url, /^https:\/\/download\.blender\.org\/release\//);
});

test("skills route 3d prompts to the 3d-cad skill", () => {
  const cad = skillRoutes.filter((r) => r.name === "3d-cad");
  const blend = cad.find((r) => r.file.test("assets/scene.blend"));
  const splat = cad.find((r) => r.file.test("out/splat_1500.ply"));
  assert.ok(blend && splat);
  for (const prompt of ["model a chair in Blender and render it", "make a 3D model of a coffee cup and a turntable animation", "write a bpy script for a procedural city", "animate a 3d character walk cycle"]) assert.ok(blend.intent.test(prompt), prompt);
  for (const prompt of ["render the video thumbnail", "fix the 3d-secure checkout flow typo", "build a video player"]) assert.equal(blend.intent.test(prompt), false, prompt);
  for (const prompt of ["train gaussian splats from these photos", "turn this COLMAP dataset into a 3DGS scene", "render a NeRF-style radiance field", "make a splat of this object"]) assert.ok(splat.intent.test(prompt), prompt);
  for (const prompt of ["fix the splash screen", "add a splatter brush to the paint app"]) assert.equal(splat.intent.test(prompt), false, prompt);
  assert.ok(splat.file.test("scene/transforms.json") && splat.file.test("out/splat_1500.ply") && blend.file.test("assets/scene.blend"));
  assert.ok(fs.existsSync(path.join(agent, "skills/3d-cad/SKILL.md")));
  const skill = fs.readFileSync(path.join(agent, "skills/3d-cad/SKILL.md"), "utf8");
  assert.match(skill, /`blender` tool \(actions run, render, inspect, setup\)/);
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
});

const installed = blender.blenderBinary();
const quick = process.env.YUNUSPI_SKIP_BLENDER_RENDER === "1";
test("blender builds, inspects and renders headless", { skip: !installed ? "Blender is not installed" : quick ? "YUNUSPI_SKIP_BLENDER_RENDER" : false, timeout: 600_000 }, async () => {
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
});
