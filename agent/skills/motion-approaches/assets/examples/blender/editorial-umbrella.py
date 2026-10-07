"""An editorial umbrella with an authored cloth silhouette and real soft shadow.
APPROACH Build an identifiable prop from curved fabric gores, ribs, seam piping, ferrule, shaft and bent handle; stage it against a quiet paper ground. Parameters keep the palette and crop under the director's control. This is an original procedural asset, not a reconstruction of a reference artwork.
USE blender_run script:"blender/scripts/editorial-umbrella.py" args:["out=blender/umbrella.blend","color=#56a8dc","seconds=4","fps=24"]
CONCEPTS 1) curved panel meshes with scalloped hems make a specific silhouette rather than a cone primitive
         2) shared linear-color fabric materials and tiny procedural bump provide finish without noisy geometry
         3) tubular ribs, stitched seams and a curved handle provide physically scaled construction detail
         4) an orthographic camera, broad key and neutral paper ground create room for editable compositor typography
         5) gentle keyed tilt/bob returns at frame N+1, so N delivered frames form a continuous loop
         6) replace only the named example collection; keep unrelated user objects and external dependencies
TAGS umbrella editorial illustration cloth fabric panels rain blue pastel soft shadow paper prop procedural asset silhouette loop
"""
import bpy
import json
import math
import os
import re
import sys
from mathutils import Vector

args=dict(a.split('=',1) for a in (sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []) if '=' in a)
seconds=float(args.get('seconds',4));fps=int(args.get('fps',24))
if not .5<=seconds<=20 or not 1<=fps<=60:raise ValueError('seconds .5..20, fps 1..60')
color=args.get('color','#56a8dc').lstrip('#')
if not re.fullmatch('[0-9a-fA-F]{6}',color):raise ValueError('color must be #rrggbb')
linear=lambda v:v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
rgb=tuple(linear(int(color[i:i+2],16)/255) for i in (0,2,4))
name='YP_EditorialUmbrella'
scene=bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
bpy.context.window.scene=scene
old=bpy.data.collections.get(name)
if old:
    for obj in list(old.objects):bpy.data.objects.remove(obj,do_unlink=True)
    bpy.data.collections.remove(old)
collection=bpy.data.collections.new(name);scene.collection.children.link(collection)
scene.render.engine='BLENDER_EEVEE' if bpy.app.version>=(5,0,0) else 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x=1280;scene.render.resolution_y=720;scene.render.resolution_percentage=100
scene.render.fps=fps;scene.frame_start=1;scene.frame_end=max(2,round(seconds*fps))
scene.render.film_transparent=False
scene.view_settings.view_transform='Standard'
world=bpy.data.worlds.get(name) or bpy.data.worlds.new(name);world.use_nodes=True;scene.world=world
world.node_tree.nodes['Background'].inputs[0].default_value=(.78,.83,.88,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.35

def material(label,color,rough=.5,metal=0,fabric=False):
    m=bpy.data.materials.get(name+'_'+label) or bpy.data.materials.new(name+'_'+label)
    m.use_nodes=True;m.node_tree.nodes.clear();n=m.node_tree.nodes;l=m.node_tree.links
    out=n.new('ShaderNodeOutputMaterial');p=n.new('ShaderNodeBsdfPrincipled')
    p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
    if fabric:
        if 'Specular IOR Level' in p.inputs:p.inputs['Specular IOR Level'].default_value=.22
        noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=220;noise.inputs['Detail'].default_value=2
        bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.06;bump.inputs['Distance'].default_value=.00015
        l.new(noise.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],p.inputs['Normal'])
        if 'Sheen Weight' in p.inputs:p.inputs['Sheen Weight'].default_value=.18
    l.new(p.outputs['BSDF'],out.inputs['Surface']);return m
fabric=material('BlueFabric',rgb,.72,fabric=True)
light=material('LighterGore',tuple(min(1,c*1.15+.015) for c in rgb),.72,fabric=True)
seam=material('Piping',tuple(c*.8 for c in rgb),.5)
metal=material('BrushedFrame',(.41,.49,.53),.35,.65)
handle=material('BlueHandle',tuple(c*.8 for c in rgb),.26)
paper=material('WarmPaper',(.89,.90,.88),.95)
# Keep the editorial backdrop nearly white across the orthographic crop;
# retain a small lit-surface contribution so the real soft shadow survives.
nodes=paper.node_tree.nodes;links=paper.node_tree.links
emission=nodes.new('ShaderNodeEmission');emission.inputs['Color'].default_value=(1,1,1,1)
mix=nodes.new('ShaderNodeMixShader');mix.inputs[0].default_value=.88
links.new(nodes.get('Principled BSDF').outputs['BSDF'],mix.inputs[1]);links.new(emission.outputs[0],mix.inputs[2])
links.new(mix.outputs[0],nodes.get('Material Output').inputs['Surface'])

def object(label,data,mat=None,parent=None):
    obj=bpy.data.objects.new(name+'_'+label,data);collection.objects.link(obj)
    if mat:data.materials.append(mat)
    if parent:obj.parent=parent
    return obj
hero=object('Rig',None)
hero.rotation_euler=(math.radians(-7),math.radians(24),math.radians(-12))
hero.location=(1.1,0,.38)

def mesh(label,vertices,faces,mat,parent=hero):
    data=bpy.data.meshes.new(name+'_'+label);data.from_pydata(vertices,[],faces);data.update()
    obj=object(label,data,mat,parent)
    for face in data.polygons:face.use_smooth=True
    return obj

def tube(label,points,radius,mat,parent=hero):
    data=bpy.data.curves.new(name+'_'+label,'CURVE');data.dimensions='3D';data.resolution_u=16;data.bevel_depth=radius;data.bevel_resolution=3
    spline=data.splines.new('NURBS');spline.points.add(len(points)-1)
    for p,co in zip(spline.points,points):p.co=(*co,1)
    spline.order_u=min(4,len(points));spline.use_endpoint_u=True
    return object(label,data,mat,parent)

def canopy(r,t):
    angle=t*math.tau/8;radius=1.37*(1-.065*math.sin((t%1)*math.pi)**2)
    radial=r*radius
    return (math.cos(angle)*radial,math.sin(angle)*radial,2.14+.5*(1-r**1.65)-.065*math.sin((t%1)*math.pi)*r)
for panel in range(8):
    vertices=[];faces=[];radial=16;angular=8
    for r in range(radial+1):
        for a in range(angular+1):vertices.append(canopy(r/radial,panel+a/angular))
    for r in range(radial):
        for a in range(angular):
            i=r*(angular+1)+a;faces.append((i,i+1,i+angular+2,i+angular+1))
    obj=mesh('Gore%02d'%panel,vertices,faces,light if panel in (1,4,7) else fabric)
    solid=obj.modifiers.new('Fabric thickness','SOLIDIFY');solid.thickness=.002
    seam_points=[canopy(r/20,panel) for r in range(1,21)]
    tube('Seam%02d'%panel,[(x,y,z+.002) for x,y,z in seam_points],.0025,seam)
    tube('Rib%02d'%panel,[(x,y,z-.017) for x,y,z in seam_points],.005,metal)
    tube('Hem%02d'%panel,[canopy(1,panel+a/20) for a in range(21)],.003,seam)
    angle=panel*math.tau/8
    tube('Stretcher%02d'%panel,[(0,0,1.52),(.4*math.cos(angle),.4*math.sin(angle),1.93),(.68*math.cos(angle),.68*math.sin(angle),2.27)],.004,metal)
tube('Shaft',[(0,0,.3),(0,0,2.67)],.015,metal)
tube('Ferrule',[(0,0,2.64),(0,0,2.79)],.018,handle)
tube('Handle',[(0,0,.48),(0,0,.2)]+[(-.13+.13*math.cos(a),0,.2-.13*math.sin(a)) for a in [i/20*math.pi for i in range(21)]]+[(-.26,0,.29)],.034,handle)
mesh('Ground',[(-100,-100,0),(100,-100,0),(100,100,0),(-100,100,0)],[(0,1,2,3)],paper,None)

def area(label,location,energy,size,color,target):
    data=bpy.data.lights.new(name+'_'+label,'AREA');data.energy=energy;data.size=size;data.color=color
    obj=object(label,data);obj.location=location;obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
area('BroadKey',(-3,-4,7),700,5,(1,.97,.94),(0,0,1))
area('SoftFill',(4,-1,5),220,5,(.82,.91,1),(1,0,1))
camera=object('Camera',bpy.data.cameras.new(name+'_Lens'));scene.camera=camera
camera.location=(5,-9,6);camera.rotation_euler=(Vector((.2,0,1.6))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO';camera.data.ortho_scale=6.8;camera.data.lens=50
# The extra closing key is not a duplicate delivered frame.
n=scene.frame_end
for fraction in [0,.25,.5,.75,1]:
    phase=fraction*math.tau
    hero.location=(1.1,0,.38+.05*math.sin(phase))
    hero.rotation_euler=(math.radians(-7)+.018*math.sin(phase),math.radians(24)+.022*math.sin(phase),math.radians(-12)+.015*(math.cos(phase)-1))
    hero.keyframe_insert('location',frame=1+fraction*n);hero.keyframe_insert('rotation_euler',frame=1+fraction*n)
scene.frame_set(1)
out=os.path.abspath(args.get('out','blender/umbrella.blend'));os.makedirs(os.path.dirname(out),exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out)
print('YUNUSPI_RESULT '+json.dumps({'blend':out,'frames':n,'loopClosingKey':n+1,'objects':len(collection.objects),'asset':'curved fabric umbrella with ribs and seams','editable':True}))
