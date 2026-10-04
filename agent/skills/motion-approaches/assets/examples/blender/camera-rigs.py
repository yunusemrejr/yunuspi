"""Camera moves as small, named recipes. Each one keys a camera around a subject so the move is editable in the saved .blend.

    blender_run  script:"camera-rigs.py"  args:["blend=blender/product.blend","rig=dolly-zoom","out=blender/product-dz.blend","seconds=3","fps=24"]
    rigs: dolly-zoom | crane | handheld | focus-pull | whip-pan

CONCEPTS  1) the subject sets the scale: every rig measures the subject's bounding sphere first, so one recipe fits a watch or a building
          2) dolly zoom (the "Vertigo" effect) keeps the subject the same size while the background stretches: lens = k * distance
          3) a crane is a camera on a Bezier path (Follow Path constraint, offset_factor keyed 0 -> 1) tracking an Empty on the subject
          4) handheld = seeded fractal noise sampled into keyframes on position and a smaller amount on rotation, never random per run
          5) focus pull animates DOF focus_distance between two objects; depth of field is what makes a shot look photographed
          6) whip pan: an exponential ease into a fast yaw, a blank blur frame, a settle; the cut hides inside the blur
          7) interpolation is chosen before keying (Blender 5 has no Action.fcurves; set the user preference, then key)
"""
import math
import sys

import bpy
from mathutils import Vector, noise

args = dict(a.split("=", 1) for a in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []) if "=" in a)
if args.get("blend"):
    bpy.ops.wm.open_mainfile(filepath=args["blend"])
RIG, SECONDS, FPS = args.get("rig", "dolly-zoom"), float(args.get("seconds", 3)), int(args.get("fps", 24))
scene = bpy.context.scene; scene.render.fps = FPS; scene.frame_start = 1; scene.frame_end = int(round(SECONDS * FPS))
bpy.context.preferences.edit.keyframe_new_interpolation_type = "BEZIER"

meshes = [o for o in scene.objects if o.type in {"MESH", "CURVE", "FONT"}]
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
low, high = Vector((min(c[i] for c in corners) for i in range(3))), Vector((max(c[i] for c in corners) for i in range(3)))
center, radius = (low + high) / 2, max((high - low).length / 2, 0.01)
bpy.ops.object.empty_add(type="PLAIN_AXES", location=center); target = bpy.context.object; target.name = "RigTarget"
cam_data = bpy.data.cameras.new("RigCam"); cam = bpy.data.objects.new("RigCam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
sensor = cam_data.sensor_width

def distance_for(lens, fill=0.62):
    """Camera distance at which the subject's bounding sphere fills `fill` of the frame height."""
    frame_mm = sensor * min(1.0, scene.render.resolution_y / scene.render.resolution_x)
    return 2 * radius * lens / (fill * frame_mm)

direction = Vector((math.sin(math.radians(35)), -math.cos(math.radians(35)), 0.28)).normalized()
last = scene.frame_end

if RIG == "dolly-zoom":
    near, far = distance_for(60), distance_for(60) * 2.6
    for frame, d in ((1, near), (last, far)):
        cam.location = center + direction * d; cam.keyframe_insert("location", frame=frame)
        cam_data.lens = 60 * d / near; cam_data.keyframe_insert("lens", frame=frame)       # lens grows with distance: subject size stays constant
elif RIG == "crane":
    d = distance_for(45)
    curve = bpy.data.curves.new("CranePath", "CURVE"); curve.dimensions = "3D"; spline = curve.splines.new("BEZIER"); spline.bezier_points.add(2)
    for p, (angle, rise, dist) in zip(spline.bezier_points, ((-70, -0.1, 1.35), (-20, 0.55, 1.0), (30, 0.2, 0.85))):
        p.co = center + Vector((math.sin(math.radians(angle)) * d * dist, -math.cos(math.radians(angle)) * d * dist, radius * (0.2 + rise * 2)))
        p.handle_left_type = p.handle_right_type = "AUTO"
    rail = bpy.data.objects.new("CranePath", curve); scene.collection.objects.link(rail)
    follow = cam.constraints.new("FOLLOW_PATH"); follow.target = rail; follow.use_fixed_location = True
    follow.offset_factor = 0.0; follow.keyframe_insert("offset_factor", frame=1); follow.offset_factor = 1.0; follow.keyframe_insert("offset_factor", frame=last)
    cam_data.lens = 45
elif RIG == "handheld":
    d = distance_for(50); cam_data.lens = 50; base = center + direction * d
    for frame in range(1, last + 1, 2):
        t = frame / FPS
        offset = Vector([noise.fractal(Vector((t * 0.9, i * 7.3, 0)), 1.0, 2.0, 3) for i in range(3)]) * radius * 0.05
        cam.location = base + offset; cam.keyframe_insert("location", frame=frame)
elif RIG == "focus-pull":
    others = sorted((o for o in meshes), key=lambda o: (o.matrix_world.translation - center).length)
    first, second = others[0], others[-1]
    d = distance_for(85, 0.5); cam_data.lens = 85; cam.location = center + direction * d
    cam_data.dof.use_dof = True; cam_data.dof.aperture_fstop = 1.6
    for frame, obj in ((1, first), (last, second)):
        cam_data.dof.focus_distance = (cam.location - obj.matrix_world.translation).length; cam_data.dof.keyframe_insert("focus_distance", frame=frame)
elif RIG == "whip-pan":
    d = distance_for(35); cam_data.lens = 35
    for frame, yaw in ((1, -40), (int(last * 0.55), -40), (int(last * 0.7), 20), (last, 14)):
        a = math.radians(yaw); cam.location = center + Vector((math.sin(a) * d, -math.cos(a) * d, radius * 0.3)); cam.keyframe_insert("location", frame=frame)
    scene.render.use_motion_blur = True; scene.render.motion_blur_shutter = 1.2
else:
    raise SystemExit(f"unknown rig {RIG}; choose dolly-zoom, crane, handheld, focus-pull or whip-pan")
# the look-at constraint goes last: constraints run in stack order, so it must see the position the rig (Follow Path) just produced
look = cam.constraints.new("TRACK_TO"); look.target = target; look.track_axis, look.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=args.get("out", "rig.blend"))
print('YUNUSPI_RESULT {"saved": "%s", "rig": "%s", "frames": %d}' % (args.get("out", "rig.blend"), RIG, last))
