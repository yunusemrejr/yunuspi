"""A procedural material kit: five surfaces that read as real at video resolution, built from nodes with no image files.

    blender_run  script:"materials.py"  args:["out=blender/materials.blend","accent=#d6e35a"]     # a swatch row to judge them side by side
    in your own scene:  exec this file's functions, then  obj.data.materials.append(brushed_metal("Body", "#9aa3a8"))

CONCEPTS  1) real surfaces are never uniform: every material mixes a large-scale and a micro-scale variation in roughness, which is what
             makes a render stop looking like plastic
          2) brushed metal = anisotropic highlight + a bump stretched along one axis (noise with very different scales per axis)
          3) glaze = base colour + clearcoat: the coat layer is what puts a second, sharper reflection over a duller body
          4) wax / skin = subsurface scattering with a short radius, so light bleeds a little at edges and thin parts glow
          5) frosted glass = transmission with roughness; rough transmission blurs what is behind it, which is the entire effect
          6) colour is passed in as hex so the material belongs to the film's palette, never to a library default
"""
import math
import re
import sys

import bpy

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)


def linear(hex_color):
    c = hex_color.lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        raise SystemExit(f"colours are #rrggbb hex; got {hex_color!r}")
    return tuple((lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)(int(c[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def _material(name):
    old = bpy.data.materials.get(name)
    if old:
        bpy.data.materials.remove(old)
    m = bpy.data.materials.new(name); m.use_nodes = True
    return m, m.node_tree.nodes, m.node_tree.links, m.node_tree.nodes["Principled BSDF"]


def _noise(nodes, scale, detail=6.0, mapping_scale=(1, 1, 1)):
    coords = nodes.new("ShaderNodeTexCoord"); mapping = nodes.new("ShaderNodeMapping"); noise = nodes.new("ShaderNodeTexNoise")
    mapping.inputs["Scale"].default_value = mapping_scale
    noise.inputs["Scale"].default_value = scale; noise.inputs["Detail"].default_value = detail
    return coords, mapping, noise


def _roughness_variation(nodes, links, principled, base, spread, scale=6.0):
    """Roughness = base + (noise - 0.5) * spread: the cheapest believable imperfection."""
    coords, mapping, noise = _noise(nodes, scale)
    ramp = nodes.new("ShaderNodeMapRange"); ramp.inputs["To Min"].default_value = max(0.0, base - spread / 2); ramp.inputs["To Max"].default_value = min(1.0, base + spread / 2)
    links.new(coords.outputs["Object"], mapping.inputs["Vector"]); links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Value"]); links.new(ramp.outputs["Result"], principled.inputs["Roughness"])


def brushed_metal(name="BrushedMetal", color="#a7aeb2"):
    m, nodes, links, p = _material(name)
    p.inputs["Base Color"].default_value = linear(color); p.inputs["Metallic"].default_value = 1.0
    p.inputs["Anisotropic"].default_value = 0.8
    _roughness_variation(nodes, links, p, 0.32, 0.12)
    coords, mapping, noise = _noise(nodes, 220.0, 3.0, mapping_scale=(1.0, 0.012, 1.0))        # stretched on Y: the grain runs along one axis
    bump = nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.18
    links.new(coords.outputs["Object"], mapping.inputs["Vector"]); links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"]); links.new(bump.outputs["Normal"], p.inputs["Normal"])
    return m


def ceramic_glaze(name="Glaze", color="#2d4a3e"):
    m, nodes, links, p = _material(name)
    p.inputs["Base Color"].default_value = linear(color); p.inputs["Metallic"].default_value = 0.0
    p.inputs["Coat Weight"].default_value = 1.0; p.inputs["Coat Roughness"].default_value = 0.04
    _roughness_variation(nodes, links, p, 0.38, 0.1, scale=3.0)
    return m


def wax(name="Wax", color="#e6d3a6"):
    m, nodes, links, p = _material(name)
    p.inputs["Base Color"].default_value = linear(color); p.inputs["Roughness"].default_value = 0.42
    p.inputs["Subsurface Weight"].default_value = 0.6; p.inputs["Subsurface Radius"].default_value = (0.9, 0.45, 0.25); p.inputs["Subsurface Scale"].default_value = 0.08
    return m


def frosted_glass(name="Frosted", tint="#cfe6e0"):
    m, nodes, links, p = _material(name)
    p.inputs["Base Color"].default_value = linear(tint); p.inputs["Roughness"].default_value = 0.28
    p.inputs["Transmission Weight"].default_value = 1.0; p.inputs["IOR"].default_value = 1.45
    return m


def rubber(name="Rubber", color="#17191a"):
    m, nodes, links, p = _material(name)
    p.inputs["Base Color"].default_value = linear(color); p.inputs["Roughness"].default_value = 0.78
    coords, mapping, noise = _noise(nodes, 420.0, 2.0); bump = nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.35
    links.new(coords.outputs["Object"], mapping.inputs["Vector"]); links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"]); links.new(bump.outputs["Normal"], p.inputs["Normal"])
    return m


KIT = [("brushed metal", brushed_metal), ("glaze", ceramic_glaze), ("wax", wax), ("frosted glass", frosted_glass), ("rubber", rubber)]

if __name__ == "__main__" or "--" in sys.argv:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for i, (label, build) in enumerate(KIT):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=64, ring_count=32, location=((i - 2) * 1.25, 0, 0.5))
        sphere = bpy.context.object; sphere.name = f"Swatch_{label.replace(' ', '_')}"; bpy.ops.object.shade_smooth()
        sphere.data.materials.append(build(label.title().replace(" ", "")))
    bpy.ops.wm.save_as_mainfile(filepath=args.get("out", "materials.blend"))
    print('YUNUSPI_RESULT {"saved": "%s", "materials": %d}' % (args.get("out", "materials.blend"), len(KIT)))
