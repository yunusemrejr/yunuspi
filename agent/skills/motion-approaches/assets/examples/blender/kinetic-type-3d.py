"""3D kinetic typography: each letter is its own object that drops in with a bounce, staggered by reading order.

    blender_run  script:"kinetic-type-3d.py"  args:["text=TIDES","out=blender/title.blend","accent=#e9a63d","font=/path/to/Font.ttf"]
    video_shot   dir:"my-film" name:"title" blend:"blender/title.blend" rig:"static" seconds:3.5 lights:"rim"

CONCEPTS  1) one Text object per character, spaced by measured width, so each letter has its own pivot and its own keyframes
          2) animation is data: keyframes at explicit frames with BOUNCE interpolation, not an add-on and not a simulation
          3) stagger follows left-to-right order with a small random-free jitter (index based), so reruns are identical
          4) depth is the point of doing this in 3D: a bevelled extrusion catches the key and rim lights while the letters settle
          5) the camera stays almost still (rig:"static" or "drift"), because the letters are the motion
Blender reads .ttf/.otf only (not woff2); copy an OFL font from the project's fonts or the OS.
"""
import math
import re
import sys

import bpy

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
TEXT, OUT, FPS = args.get("text", "TIDES"), args.get("out", "title.blend"), int(args.get("fps", 30))
DROP, STAGGER = int(args.get("drop", 20)), int(args.get("stagger", 3))

def linear(hex_color):
    c = hex_color.lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        raise SystemExit(f"colours are #rrggbb hex; got {hex_color!r}")
    return tuple((lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)(int(c[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
# One Text object per character: a converted multi-letter mesh splits into bevel and counter islands, not letters.
font = bpy.data.fonts.load(args["font"]) if args.get("font") else None
letters, cursor, GAP = [], 0.0, 0.07
for ch in TEXT:
    if ch == " ":
        cursor += 0.45
        continue
    curve = bpy.data.curves.new(f"Glyph_{len(letters)}", "FONT")
    curve.body, curve.extrude, curve.bevel_depth, curve.bevel_resolution = ch, 0.16, 0.022, 4
    if font:
        curve.font = font
    obj = bpy.data.objects.new(f"Letter_{len(letters)}_{ch}", curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.view_layer.update()
    width = obj.dimensions.x
    obj.location.x = cursor
    cursor += width + GAP
    letters.append(obj)
for obj in letters:                                  # centre the whole word on the origin
    obj.location.x -= (cursor - GAP) / 2
mat = bpy.data.materials.new("Letter"); mat.use_nodes = True
node = mat.node_tree.nodes["Principled BSDF"]
node.inputs["Base Color"].default_value = linear(args.get("accent", "#e9a63d")); node.inputs["Metallic"].default_value = 0.85; node.inputs["Roughness"].default_value = 0.26
edit = bpy.context.preferences.edit
previous = edit.keyframe_new_interpolation_type
edit.keyframe_new_interpolation_type = "BOUNCE"
for i, letter in enumerate(letters):
    letter.data.materials.clear(); letter.data.materials.append(mat)
    start = 1 + i * STAGGER
    rest_z, rest_rot = letter.location.z, letter.rotation_euler.x
    letter.location.z, letter.rotation_euler.x, letter.scale = rest_z + 2.2, rest_rot + math.radians(55 + 9 * (i % 3)), (0.7, 0.7, 0.7)
    for path in ("location", "rotation_euler", "scale"):
        letter.keyframe_insert(path, frame=start)
    letter.location.z, letter.rotation_euler.x, letter.scale = rest_z, rest_rot, (1, 1, 1)
    for path in ("location", "rotation_euler", "scale"):
        letter.keyframe_insert(path, frame=start + DROP)
edit.keyframe_new_interpolation_type = previous
scene = bpy.context.scene
scene.render.fps, scene.frame_start, scene.frame_end = FPS, 1, 1 + (len(letters) - 1) * STAGGER + DROP + 18
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('YUNUSPI_RESULT {"saved": "%s", "letters": %d, "frames": %d}' % (OUT.replace("\\", "/"), len(letters), scene.frame_end))
