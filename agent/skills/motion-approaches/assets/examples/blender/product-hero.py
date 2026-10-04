"""Procedural hero object with named anchors, ready for video_shot.

    blender_run  script:"product-hero.py"  args:["out=public/../blender/instrument.blend","body=#2c3e46","accent=#e9a63d"]
    video_shot   dir:"my-film" name:"instrument" blend:"blender/instrument.blend" rig:"orbit" anchors:["Anchor_Screen","Anchor_Dial","Anchor_Port"]

CONCEPTS  1) build with the data API and deterministic names, so a re-run replaces instead of duplicating
          2) one bevel width everywhere (a physical radius), because bevels catch the light that makes forms read
          3) detail that holds up at 4K: a knurled dial from a radial Array of ridges, an inset display with a real emission material
          4) anchors are Empties at 3D features; video_shot projects them to screen space per frame so 2D callouts follow the object
          5) palette comes from the film (body/accent arguments), so the 3D belongs to the 2D look
"""
import math
import re
import sys

import bpy

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
OUT = args.get("out", "instrument.blend")


def linear(hex_color):
    c = hex_color.lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        raise SystemExit(f"colours are #rrggbb hex; got {hex_color!r}")
    return tuple((lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)(int(c[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def material(name, color, metallic=0.0, roughness=0.5, emission=None, coat=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]
    n.inputs["Base Color"].default_value = linear(color)
    n.inputs["Metallic"].default_value = metallic
    n.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in n.inputs:
        n.inputs["Coat Weight"].default_value = coat
    if emission:
        n.inputs["Emission Color"].default_value = linear(emission)
        n.inputs["Emission Strength"].default_value = 2.2
    return m


for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

BEVEL = 0.035                                                     # one physical radius for the whole object
def add(kind, name, location, scale=(1, 1, 1), **kw):
    getattr(bpy.ops.mesh, f"primitive_{kind}_add")(location=location, **kw)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)   # keep the location: anchors and arrays pivot on it
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width, mod.segments, mod.limit_method = BEVEL, 4, "ANGLE"
    bpy.ops.object.shade_smooth()
    return obj

body = add("cube", "Body", (0, 0, 0.55), (1.7, 0.62, 0.9), size=1.0)
body.data.materials.append(material("Body", args.get("body", "#2c3e46"), 0.15, 0.42, coat=0.4))
screen = add("cube", "Screen", (-0.42, -0.625, 0.7), (0.62, 0.02, 0.34), size=1.0)
screen.data.materials.append(material("Screen", args.get("accent", "#e9a63d"), 0.0, 0.2, emission=args.get("accent", "#e9a63d")))
dial = add("cylinder", "Dial", (0.62, -0.66, 0.62), (0.2, 0.2, 0.07), vertices=64, radius=1.0, depth=1.0, rotation=(math.radians(90), 0, 0))
dial.data.materials.append(material("Dial", "#c9ced1", 1.0, 0.28))
# knurling: a radial Array of small ridges around the dial, driven by an Empty so the count and spacing stay editable
bpy.ops.object.empty_add(type="PLAIN_AXES", location=dial.location)
spin = bpy.context.object; spin.name = "DialSpin"; spin.rotation_euler = (0, math.radians(360 / 40), 0)
bpy.ops.mesh.primitive_cube_add(size=1.0, location=dial.location)
ridge = bpy.context.object; ridge.name = "DialRidge"; ridge.scale = (0.012, 0.075, 0.012); bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
for vertex in ridge.data.vertices:
    vertex.co.x += 0.205                        # the ridge sits on the dial's rim, but the object origin stays at the dial centre: that is the array's pivot
arr = ridge.modifiers.new("Radial", "ARRAY"); arr.count, arr.use_relative_offset, arr.use_object_offset, arr.offset_object = 40, False, True, spin
ridge.data.materials.append(material("Ridge", "#9aa3a8", 1.0, 0.35))
for i, (x, y) in enumerate([(-0.7, -0.22), (0.7, -0.22), (-0.7, 0.22), (0.7, 0.22)]):
    foot = add("cylinder", f"Foot{i}", (x, y, 0.03), (0.08, 0.08, 0.03), vertices=24, radius=1.0, depth=1.0)
    foot.data.materials.append(material("Foot", "#111417", 0.0, 0.8))
for name, loc in (("Anchor_Screen", (-0.42, -0.65, 0.7)), ("Anchor_Dial", (0.62, -0.7, 0.62)), ("Anchor_Port", (-0.2, -0.64, 0.27))):
    bpy.ops.object.empty_add(type="SPHERE", location=loc, radius=0.02)
    bpy.context.object.name = name
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('YUNUSPI_RESULT {"saved": "%s", "anchors": ["Anchor_Screen", "Anchor_Dial", "Anchor_Port"]}' % OUT)
