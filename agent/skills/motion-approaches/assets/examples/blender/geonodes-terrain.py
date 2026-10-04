"""A living terrain from Geometry Nodes: a grid displaced by animated 4D noise, shaded by height, all procedural and editable.

    blender_run  script:"geonodes-terrain.py"  args:["out=blender/terrain.blend","seconds=6","fps=24","low=#0d1512","high=#d6e35a"]
    video_shot   dir:"my-film" name:"terrain" blend:"blender/terrain.blend" rig:"drift" lights:"scene" elevation:24

CONCEPTS  1) a node group is a function from geometry to geometry; the modifier stays live, so changing one number re-shapes the world
          2) 4D noise: the fourth axis (W) is time, so the terrain evolves smoothly instead of sliding; the keys sit on a Value node inside the group
          3) displacement happens in Set Position along Z only; a modifier replaces the mesh, so Set Material re-applies the surface inside the group
          4) the shader colours by object-space height, the same quantity the displacement produced, so colour and form always agree
          5) the whole terrain is one object and one material: cheap to render, trivial to reframe, and nothing is a baked image
"""
import math
import re
import sys

import bpy

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
SECONDS, FPS = float(args.get("seconds", 6)), int(args.get("fps", 24))
LOW, HIGH = args.get("low", "#0d1512"), args.get("high", "#d6e35a")


def linear(hex_color):
    c = hex_color.lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        raise SystemExit(f"colours are #rrggbb hex; got {hex_color!r}")
    return tuple((lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)(int(c[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
scene = bpy.context.scene; scene.render.fps = FPS; scene.frame_start, scene.frame_end = 1, int(SECONDS * FPS)
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0)); land = bpy.context.object; land.name = "Terrain"

mat = bpy.data.materials.new("TerrainMat"); mat.use_nodes = True; t = mat.node_tree; p = t.nodes["Principled BSDF"]
geo = t.nodes.new("ShaderNodeNewGeometry"); sep = t.nodes.new("ShaderNodeSeparateXYZ"); ramp = t.nodes.new("ShaderNodeValToRGB")
rng = t.nodes.new("ShaderNodeMapRange"); rng.inputs["From Min"].default_value, rng.inputs["From Max"].default_value = -1.4, 1.8      # the height range of the field
t.links.new(geo.outputs["Position"], sep.inputs["Vector"]); t.links.new(sep.outputs["Z"], rng.inputs["Value"]); t.links.new(rng.outputs["Result"], ramp.inputs["Fac"]); t.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[1].position = 0.30, 0.78
ramp.color_ramp.elements[0].color, ramp.color_ramp.elements[1].color = linear(LOW), linear(HIGH)
p.inputs["Roughness"].default_value = 0.55

group = bpy.data.node_groups.new("TerrainField", "GeometryNodeTree")
group.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
group.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
n = group.nodes; link = group.links.new
gin, gout = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
grid = n.new("GeometryNodeMeshGrid"); grid.inputs["Size X"].default_value = grid.inputs["Size Y"].default_value = 12.0
grid.inputs["Vertices X"].default_value = grid.inputs["Vertices Y"].default_value = 220
position = n.new("GeometryNodeInputPosition")
noise = n.new("ShaderNodeTexNoise"); noise.noise_dimensions = "4D"; noise.inputs["Scale"].default_value = 0.35; noise.inputs["Detail"].default_value = 5.0; noise.inputs["Roughness"].default_value = 0.55
time = n.new("ShaderNodeValue"); time.name = "Time"; time.outputs[0].default_value = 0.0
height = n.new("ShaderNodeMath"); height.operation = "MULTIPLY_ADD"; height.inputs[1].default_value = 3.2; height.inputs[2].default_value = -1.4     # (noise * 3.2) - 1.4: valleys below zero
lift = n.new("ShaderNodeCombineXYZ")
setpos = n.new("GeometryNodeSetPosition"); paint = n.new("GeometryNodeSetMaterial"); paint.inputs["Material"].default_value = mat
link(position.outputs["Position"], noise.inputs["Vector"]); link(time.outputs[0], noise.inputs["W"])
link(noise.outputs["Fac"], height.inputs[0]); link(height.outputs["Value"], lift.inputs["Z"])
link(grid.outputs["Mesh"], setpos.inputs["Geometry"]); link(lift.outputs["Vector"], setpos.inputs["Offset"]); link(setpos.outputs["Geometry"], paint.inputs["Geometry"]); link(paint.outputs["Geometry"], gout.inputs["Geometry"])
mod = land.modifiers.new("Terrain", "NODES"); mod.node_group = group
# time: W drifts from 0 to 2 over the clip, keyed linear so the terrain evolves at constant speed (the keys live on the node group)
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
time.outputs[0].default_value = 0.0; time.outputs[0].keyframe_insert("default_value", frame=1)
time.outputs[0].default_value = 2.0; time.outputs[0].keyframe_insert("default_value", frame=scene.frame_end)

bpy.ops.wm.save_as_mainfile(filepath=args.get("out", "terrain.blend"))
print('YUNUSPI_RESULT {"saved": "%s", "frames": %d}' % (args.get("out", "terrain.blend"), scene.frame_end))
