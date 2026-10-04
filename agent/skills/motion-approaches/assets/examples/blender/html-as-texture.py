"""A rendered HTML/Remotion sequence as the screen of a 3D device: UI on glass in a Blender shot.

    1. render the motion page:   node motion-graphics-production/scripts/render.mjs ui.html OUTDIR 4 30 1280 720
    2. build the scene:          blender_run script:"html-as-texture.py" args:["frames=OUTDIR/motion-XXXX","out=blender/device.blend","fps=30"]
    3. render the shot:          video_shot dir:"my-film" name:"device" blend:"blender/device.blend" rig:"push-in" seconds:4 fps:30

CONCEPTS  1) an image SEQUENCE datablock plays the rendered frames; frame_offset aligns file numbering (render.mjs starts at 000000) to scene frame 1
          2) the screen is an emission surface at strength 1, so UI colours land on screen as designed; a thin glass layer in front adds the reflection
          3) the display's aspect comes from the frames, so a 16:9 page is not stretched onto a 16:10 bezel
          4) the HTML page keeps its own clock: this scene only plays it, so edit the page and re-render to change the screen
          5) Blender never renders type, which is why the type stays crisp: it was rasterised once, at the resolution of the page
"""
import glob
import math
import os
import sys

import bpy

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
FRAMES, OUT, FPS = args["frames"], args.get("out", "device.blend"), int(args.get("fps", 30))
files = sorted(glob.glob(os.path.join(FRAMES, "frame-*.png")))
if not files:
    raise SystemExit(f"no frame-*.png files in {FRAMES}")
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
image = bpy.data.images.load(files[0], check_existing=False)
image.source = "SEQUENCE"
aspect = image.size[0] / image.size[1]
scene = bpy.context.scene
scene.render.fps, scene.frame_start, scene.frame_end = FPS, 1, len(files)

def principled(name, color, metallic, roughness):
    m = bpy.data.materials.new(name); m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]; n.inputs["Base Color"].default_value = color; n.inputs["Metallic"].default_value = metallic; n.inputs["Roughness"].default_value = roughness
    return m

# bezel: a rounded slab; screen: a plane just in front of it with the sequence as emission
H = 1.0; Wd = H * aspect; T = 0.06
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, H / 2 + 0.05))
bezel = bpy.context.object; bezel.name = "Bezel"; bezel.scale = (Wd + 0.1, T, H + 0.1); bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
mod = bezel.modifiers.new("Bevel", "BEVEL"); mod.width, mod.segments = 0.02, 4
bezel.data.materials.append(principled("Bezel", (0.02, 0.02, 0.025, 1), 0.6, 0.3)); bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, -T / 2 - 0.001, H / 2 + 0.05), rotation=(math.radians(90), 0, 0))
screen = bpy.context.object; screen.name = "Screen"; screen.scale = (Wd, H, 1); bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
mat = bpy.data.materials.new("ScreenMat"); mat.use_nodes = True
tree = mat.node_tree; tree.nodes.clear()
tex = tree.nodes.new("ShaderNodeTexImage"); tex.image = image; tex.interpolation = "Cubic"
user = tex.image_user; user.frame_duration, user.frame_start, user.frame_offset, user.use_auto_refresh, user.use_cyclic = len(files), 1, -1, True, False
emit = tree.nodes.new("ShaderNodeEmission"); emit.inputs["Strength"].default_value = 1.0
out = tree.nodes.new("ShaderNodeOutputMaterial")
tree.links.new(tex.outputs["Color"], emit.inputs["Color"]); tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
screen.data.materials.append(mat)
bpy.ops.object.empty_add(type="SPHERE", location=(0, -T, H / 2 + 0.05), radius=0.02); bpy.context.object.name = "Anchor_Screen"
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('YUNUSPI_RESULT {"saved": "%s", "frames": %d, "aspect": %.3f}' % (OUT, len(files), aspect))
