"""An atmospheric kiosk built from code, with a generated image backplate.
APPROACH Authored architecture, procedural paint/stone, interior light and a packed image card share one camera. Editable geometry carries the foreground; an image model supplies distant atmosphere. This is an original technique study, not a replica of a reference artist's work.
USE blender_run script:"blender/atmospheric-kiosk.py" args:["out=blender/kiosk.blend","backplate=public/assets/valley.png","seconds=6","fps=30"]
CONCEPTS 1) specific silhouettes: roof fascia, canopy, mullions, vents, shelf products and authored signage
         2) macro form first, then consistent bevels, rough painted metal, glass and restrained procedural wear
         3) warm interior practicals contrast with cool exterior light; shadow and wet stone ground the subject
         4) a packed camera-facing image card supplies distant atmosphere without pretending to be fully modeled geometry
         5) a slow editable camera move exposes geometry parallax; typography stays in the compositor
TAGS hybrid image generated backplate architecture rainy atmospheric kiosk cinematic editable Blender procedural materials lighting parallax
"""
import json
import math
import os
import random
import sys
import bpy
from mathutils import Vector

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
rng = random.Random(73)
seconds, fps = float(args.get("seconds", 6)), int(args.get("fps", 30))
if not .5 <= seconds <= 20 or not 1 <= fps <= 60:
    raise ValueError("seconds .5..20, fps 1..60")
out = os.path.abspath(args.get("out", "blender/kiosk.blend"))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE' if bpy.app.version >= (5, 0, 0) else 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.render.resolution_percentage = 100
scene.render.fps = fps
scene.frame_start, scene.frame_end = 1, round(seconds * fps)
scene.view_settings.view_transform = 'AgX'
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'BEZIER'
scene.world.use_nodes = True
scene.world.node_tree.nodes.get('Background').inputs[0].default_value = (.07, .14, .2, 1)
scene.world.node_tree.nodes.get('Background').inputs[1].default_value = .22

def material(name, color, metallic=0, rough=.5, wear=False, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    n, links = m.node_tree.nodes, m.node_tree.links
    p = n.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = rough
    if emission:
        p.inputs['Emission Color'].default_value = (*color, 1)
        p.inputs['Emission Strength'].default_value = emission
    if wear:
        noise = n.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 55
        noise.inputs['Detail'].default_value = 3
        ramp = n.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = .28
        ramp.color_ramp.elements[0].color = (*(c*.74 for c in color), 1)
        ramp.color_ramp.elements[1].position = .72
        ramp.color_ramp.elements[1].color = (*color, 1)
        links.new(noise.outputs['Fac'], ramp.inputs[0])
        links.new(ramp.outputs[0], p.inputs['Base Color'])
        bump = n.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .09
        bump.inputs['Distance'].default_value = .001
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs[0], p.inputs['Normal'])
    return m

paint = material('Weathered petrol painted steel', (.035,.14,.16), .5, .42, True)
edge = material('Anodized dark trim', (.024,.048,.052), .7, .31)
roof = material('Wet zinc roof', (.12,.19,.21), .82, .23, True)
stone = material('Wet irregular slate', (.065,.1,.115), .12, .19, True)
inside = material('Warm wood and paper', (.42,.29,.12), 0, .72, True)
light = material('Warm cream practical', (.95,.73,.3), 0, .3, emission=3)
mint = material('Mint service lamp', (.18,.85,.65), 0, .2, emission=5)
ink = material('Sign lettering', (.013,.04,.037), 0, .6)

def box(name, center, size, mat, bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    o = bpy.context.object
    o.name = name
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel:
        b=o.modifiers.new('Machined edge', 'BEVEL');b.width=min(bevel,min(size)*.4);b.segments=3
        o.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    return o

def text(name, value, location, size, mat):
    c=bpy.data.curves.new(name,'FONT');c.body=value;c.align_x='CENTER';c.size=size;c.extrude=.002;c.bevel_depth=.0005
    o=bpy.data.objects.new(name,c);scene.collection.objects.link(o)
    o.location=location;o.rotation_euler=(math.pi/2,0,0);c.materials.append(mat)
    return o

def bottle(center, color, height):
    m=material('Ceramic stock jar',color,0,.3)
    bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=.058,depth=height,location=center)
    o=bpy.context.object;o.name='Shelf jar';o.data.materials.append(m)
    box('Jar paper band',(center[0],center[1]-.058,center[2]),(.075,.01,height*.4),light,.001)
    box('Jar cap',(center[0],center[1],center[2]+height/2),(.105,.105,.025),edge,.007)

# The open service window avoids noisy dithered transparency over fine stock.
box('Raised foundation',(0,0,.15),(4.3,2.8,.3),edge)
box('Back wall',(0,1.15,1.7),(4.05,.13,3),paint)
for x in [-2,2]:
    box('Side panel',(x,0,1.7),(.14,2.35,3),paint)
box('Lower front panel',(0,-1.16,.72),(4.05,.12,1.1),paint)
box('Interior counter',(0,-.78,1.23),(3.7,.7,.12),inside)
box('Upper lintel',(0,-1.18,2.76),(4.15,.18,.28),paint)
box('Roof overhang',(0,-.12,3.26),(4.65,3.12,.18),roof)
box('Canopy lip',(0,-1.69,3.05),(4.65,.14,.34),paint)
box('Cream fascia sign',(0,-1.775,3.1),(4.31,.022,.24),light)
text('Authored original signage','AFTER HOURS',(0,-1.798,3.015),.22,ink)
box('Warm service light',(0,-1.25,2.77),(3.5,.14,.04),light)
for x in [-1.78,-.63,.63,1.78]:
    box('Window mullion',(x,-1.23,1.97),(.055,.065,1.38),edge,.006)
for z in [1.65,2.15,2.65]:
    box('Interior stock shelf',(0,.42,z),(3.65,.53,.055),inside)
    for i in range(14):
        color=[(.3,.09,.05),(.12,.24,.19),(.39,.29,.15)][i%3]
        m=material('Stock paper carton',color,0,.8)
        x=-1.64+i*.25;h=.23+rng.random()*.12
        if i%3==0:bottle((x,.39,z+h/2),color,h)
        else:
            box('Shelf paper box',(x,.39,z+h/2),(.16,.18,h),m,.007)
            box('Printed cream label',(x,.291,z+h*.53),(.10,.006,h*.34),light,.001)
            box('Printed dark rule',(x,.285,z+h*.53),(.075,.004,.018),ink,.001)
# Visible secondary parts establish scale and silhouette specificity.
box('Service cabinet',(1.35,-1.51,.83),(.63,.48,1.43),paint)
box('Dark service display',(1.35,-1.765,1.22),(.48,.028,.41),edge)
text('Service interface','24 / H',(1.35,-1.797,1.25),.115,mint)
for i in range(3):box('Selection light',(1.19+i*.16,-1.801,1.11),(.09,.012,.035),mint,.003)
box('Coin slot',(1.35,-1.795,.69),(.25,.04,.06),edge,.009)
text('Service label','OPEN LATE',(-.03,-1.254,.69),.115,light)
for z in [.47,.51,.55,.59]:
    box('Service grille slat',(1.35,-1.795,z),(.32,.04,.012),edge,.003)
box('Rooftop compressor',(.97,.6,3.62),(1.04,.8,.55),paint)
for z in [3.44+i*.06 for i in range(6)]:
    box('Compressor louver',(.97,.183,z),(.87,.035,.022),edge,.004)
for i in range(12):
    box('Standing seam roof',(-2.1+i*.38,-.12,3.37),(.012,2.96,.024),edge,.003)
for x in [-2.035,2.035]:
    for z in [.4,1.1,2.7]:
        box('Panel fastener',(x,-1.225,z),(.035,.024,.035),roof,.008)
for z in [1.2+i*.10 for i in range(9)]:
    box('Side ventilation fin',(2.08,.53,z),(.04,.62,.025),edge,.003)
for x in [-1.65,-.2]:box('Lower panel seam',(x,-1.235,.65),(.012,.012,.87),edge,.002)
for row in range(7):
    for col in range(10):
        x=(col-4.5)*.66+(row%2)*.28;y=(row-3)*.67
        tile=box('Ground slate',(x,y,-.012+rng.random()*.008),(.61,.6,.035),stone,.013)
        tile['yp_role']='background'
        tile.rotation_euler.z=rng.uniform(-.045,.045)

def area(name, location, color, power, size, target):
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.color=color;d.shape='DISK';d.size=size
    o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=location
    o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
area('Cool moon through haze',(-4,-1,7),(.38,.7,1),1100,6,(0,0,1))
area('Warm window practical',(0,-.4,2.55),(1,.61,.23),170,2,(0,-2,.8))
area('Mint under canopy',(1.5,-1.4,2.6),(.17,1,.76),100,1,(1.5,-2,.5))
area('Edge separation',(3,3,5),(.24,.48,.7),600,4,(0,0,1))
camera=bpy.data.objects.new('Authored camera',bpy.data.cameras.new('Authored lens'))
scene.collection.objects.link(camera);scene.camera=camera;camera.data.lens=48
camera.data.shift_x=.10
for f,location in [(1,(7,-11,5.5)),(scene.frame_end,(6.7,-10.7,5.4))]:
    camera.location=location
    camera.rotation_euler=(Vector((0,0,1.6))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.keyframe_insert('location',frame=f);camera.keyframe_insert('rotation_euler',frame=f)
scene.frame_set(1)

if args.get('backplate'):
    image=bpy.data.images.load(os.path.abspath(args['backplate']),check_existing=True);image.pack()
    d=35;w=d*camera.data.sensor_width/camera.data.lens*1.35;h=w*720/1280
    mesh=bpy.data.meshes.new('Backplate card');mesh.from_pydata([(-w/2,-h/2,0),(w/2,-h/2,0),(w/2,h/2,0),(-w/2,h/2,0)],[],[(0,1,2,3)])
    uv=mesh.uv_layers.new(name='Image UV')
    for loop,coord in zip(uv.data,[(0,0),(1,0),(1,1),(0,1)]):loop.uv=coord
    card=bpy.data.objects.new('Generated distant atmosphere',mesh);scene.collection.objects.link(card)
    card['yp_role']='background'
    card.parent=camera;card.location=(0,0,-d)
    m=bpy.data.materials.new('Unlit atmospheric image');m.use_nodes=True;m.node_tree.nodes.clear()
    n=m.node_tree.nodes;links=m.node_tree.links
    output=n.new('ShaderNodeOutputMaterial');emission=n.new('ShaderNodeEmission');texture=n.new('ShaderNodeTexImage');texture.image=image
    links.new(texture.outputs['Color'],emission.inputs['Color']);links.new(emission.outputs[0],output.inputs['Surface']);mesh.materials.append(m)
os.makedirs(os.path.dirname(out),exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out)
print('YUNUSPI_RESULT '+json.dumps({'blend':out,'objects':len(scene.objects),'frames':scene.frame_end,'packedBackplate':bool(args.get('backplate')),'artworkMode':'camera-facing illustration; geometry retains real parallax'}))
