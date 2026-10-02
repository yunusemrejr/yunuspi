"""Headless Blender worker for the YunusPi blender_* tools.

Runs inside Blender (`blender -b [file.blend] -P blender-studio.py -- request.json`).
The request JSON carries one `op` (inspect, render, export, dataset); the
result is printed as a single `YUNUSPI_RESULT {json}` line so the harness
can parse it out of Blender's own stdout noise. Everything here uses the
data API with deterministic names and never deletes user objects.
"""
import json
import math
import os
import sys
import time

import bpy

MARK = "YUNUSPI_RESULT "


def emit(payload):
    sys.stdout.write(MARK + json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def request_from_argv():
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("missing request path after --")
    with open(argv[argv.index("--") + 1], "r", encoding="utf-8") as handle:
        return json.load(handle)


def vec(value):
    return [round(float(v), 5) for v in value]


def apply_render_settings(scene, req):
    render = scene.render
    engine = (req.get("engine") or "").upper()
    if engine:
        wanted = {"EEVEE": "BLENDER_EEVEE", "CYCLES": "CYCLES", "WORKBENCH": "BLENDER_WORKBENCH"}.get(engine, engine)
        try:
            render.engine = wanted
        except TypeError as error:
            raise RuntimeError(f"render engine {wanted} is not available in this Blender build: {error}")
    if req.get("width"):
        render.resolution_x = int(req["width"])
    if req.get("height"):
        render.resolution_y = int(req["height"])
    if req.get("scale"):
        render.resolution_percentage = max(1, min(200, int(round(float(req["scale"]) * 100))))
    samples = req.get("samples")
    if samples:
        if render.engine == "CYCLES":
            scene.cycles.samples = int(samples)
        elif render.engine == "BLENDER_EEVEE":
            scene.eevee.taa_render_samples = int(samples)
    if render.engine == "CYCLES":
        # Always CPU here: the harness owns the machine budget and no GPU is assumed.
        scene.cycles.device = "CPU"
        if req.get("denoise") is not None:
            scene.cycles.use_denoising = bool(req["denoise"])
    if req.get("transparent") is not None:
        render.film_transparent = bool(req["transparent"])
    fmt = (req.get("format") or "PNG").upper()
    render.image_settings.file_format = fmt
    if fmt in ("PNG", "WEBP", "TIFF") and req.get("transparent"):
        render.image_settings.color_mode = "RGBA"
    if fmt == "JPEG":
        render.image_settings.quality = int(req.get("quality") or 92)
    if req.get("threads"):
        render.threads_mode = "FIXED"
        render.threads = int(req["threads"])
    return render


def summarize_render(scene):
    render = scene.render
    out = {
        "engine": render.engine,
        "resolution": [render.resolution_x, render.resolution_y],
        "scale": render.resolution_percentage,
        "effective": [int(render.resolution_x * render.resolution_percentage / 100), int(render.resolution_y * render.resolution_percentage / 100)],
        "fps": scene.render.fps,
        "frames": [scene.frame_start, scene.frame_end],
        "format": render.image_settings.file_format,
        "camera": scene.camera.name if scene.camera else None,
    }
    if render.engine == "CYCLES":
        out["samples"] = scene.cycles.samples
        out["denoise"] = scene.cycles.use_denoising
        out["device"] = scene.cycles.device
    elif render.engine == "BLENDER_EEVEE":
        out["samples"] = scene.eevee.taa_render_samples
    return out


def op_inspect(req):
    scene = bpy.context.scene
    objects = []
    for obj in bpy.data.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": vec(obj.location),
            "rotation": vec(obj.rotation_euler),
            "scale": vec(obj.scale),
            "dimensions": vec(obj.dimensions),
            "parent": obj.parent.name if obj.parent else None,
            "visible": not obj.hide_render,
            "collections": [c.name for c in obj.users_collection],
        }
        if obj.type == "MESH":
            mesh = obj.data
            entry["verts"] = len(mesh.vertices)
            entry["faces"] = len(mesh.polygons)
            entry["materials"] = [m.name for m in mesh.materials if m]
        if obj.modifiers:
            entry["modifiers"] = [f"{m.name}:{m.type}" for m in obj.modifiers]
        if obj.type == "CAMERA":
            cam = obj.data
            entry["camera"] = {"lens_mm": round(cam.lens, 3), "sensor_mm": round(cam.sensor_width, 3), "clip": [round(cam.clip_start, 4), round(cam.clip_end, 2)], "type": cam.type}
        if obj.type == "LIGHT":
            light = obj.data
            entry["light"] = {"type": light.type, "energy": round(light.energy, 3), "color": vec(light.color)}
        if obj.animation_data and obj.animation_data.action:
            action = obj.animation_data.action
            entry["animation"] = {"action": action.name, "frame_range": vec(action.frame_range)}
        objects.append(entry)
    missing = []
    for image in bpy.data.images:
        if image.source == "FILE" and image.filepath and not os.path.exists(bpy.path.abspath(image.filepath)):
            missing.append(bpy.path.abspath(image.filepath))
    for library in bpy.data.libraries:
        if not os.path.exists(bpy.path.abspath(library.filepath)):
            missing.append(bpy.path.abspath(library.filepath))
    world = scene.world
    return {
        "blender": bpy.app.version_string,
        "file": bpy.data.filepath or None,
        "scene": scene.name,
        "scenes": [s.name for s in bpy.data.scenes],
        "units": {"system": scene.unit_settings.system, "scale_length": scene.unit_settings.scale_length, "length": scene.unit_settings.length_unit},
        "render": summarize_render(scene),
        "world": {"name": world.name, "use_nodes": world.use_nodes} if world else None,
        "collections": [{"name": c.name, "objects": len(c.objects), "hidden": c.hide_render} for c in bpy.data.collections],
        "objects": objects,
        "materials": [m.name for m in bpy.data.materials],
        "cameras": [o.name for o in bpy.data.objects if o.type == "CAMERA"],
        "lights": [o.name for o in bpy.data.objects if o.type == "LIGHT"],
        "missingFiles": missing,
        "counts": {"objects": len(bpy.data.objects), "meshes": len(bpy.data.meshes), "materials": len(bpy.data.materials), "images": len(bpy.data.images)},
    }


def ensure_camera(scene):
    if scene.camera:
        return scene.camera
    cams = [o for o in bpy.data.objects if o.type == "CAMERA"]
    if cams:
        scene.camera = cams[0]
        return cams[0]
    raise RuntimeError("the scene has no camera; add one (bpy.data.cameras.new + bpy.data.objects.new) and set scene.camera before rendering")


def op_render(req):
    scene = bpy.context.scene
    if req.get("scene"):
        # Background mode has no window to switch; the render operator takes the scene by name instead.
        scene = bpy.data.scenes[req["scene"]]
    if req.get("camera"):
        scene.camera = bpy.data.objects[req["camera"]]
    ensure_camera(scene)
    render = apply_render_settings(scene, req)
    out_dir = req["outputDir"]
    os.makedirs(out_dir, exist_ok=True)
    frames = req.get("frames") or [scene.frame_current]
    ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "OPEN_EXR": "exr", "TIFF": "tif", "BMP": "bmp"}.get(render.image_settings.file_format, "png")
    stem = req.get("stem") or "frame"
    files = []
    started = time.time()
    for index, frame in enumerate(frames):
        scene.frame_set(int(frame))
        target = os.path.join(out_dir, f"{stem}-{int(frame):04d}.{ext}")
        render.filepath = target
        t0 = time.time()
        bpy.ops.render.render(write_still=True, scene=scene.name)
        if not os.path.exists(target):
            raise RuntimeError(f"Blender reported success but {target} was not written")
        files.append({"frame": int(frame), "path": target, "bytes": os.path.getsize(target), "seconds": round(time.time() - t0, 2)})
        sys.stdout.write(f"YUNUSPI_PROGRESS frame {index + 1}/{len(frames)} ({int(frame)}) in {time.time() - t0:.1f}s\n")
        sys.stdout.flush()
    return {"files": files, "render": summarize_render(scene), "seconds": round(time.time() - started, 2)}


def op_export(req):
    scene = bpy.context.scene
    target = req["path"]
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    fmt = req["format"].lower()
    selected = req.get("objects")
    use_selection = False
    if selected:
        bpy.ops.object.select_all(action="DESELECT")
        for name in selected:
            bpy.data.objects[name].select_set(True)
        use_selection = True
    apply_mods = bool(req.get("applyModifiers", True))
    if fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(filepath=target, export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE", use_selection=use_selection, export_apply=apply_mods, export_animations=bool(req.get("animation", True)), export_yup=True)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=target, export_selected_objects=use_selection, apply_modifiers=apply_mods, export_materials=True, export_uv=True, export_normals=True)
    elif fmt == "ply":
        bpy.ops.wm.ply_export(filepath=target, export_selected_objects=use_selection, apply_modifiers=apply_mods, export_colors="SRGB", ascii_format=False)
    elif fmt == "stl":
        bpy.ops.wm.stl_export(filepath=target, export_selected_objects=use_selection, apply_modifiers=apply_mods)
    elif fmt in ("usd", "usda", "usdc", "usdz"):
        bpy.ops.wm.usd_export(filepath=target, selected_objects_only=use_selection, export_animation=bool(req.get("animation", False)))
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=target, use_selection=use_selection, use_mesh_modifiers=apply_mods, bake_anim=bool(req.get("animation", True)))
    elif fmt == "abc":
        bpy.ops.wm.alembic_export(filepath=target, selected=use_selection, start=scene.frame_start, end=scene.frame_end)
    elif fmt == "blend":
        bpy.ops.wm.save_as_mainfile(filepath=target, copy=True, compress=True)
    else:
        raise RuntimeError(f"unsupported export format {fmt}")
    written = [target]
    if fmt == "gltf":
        base = os.path.splitext(target)[0]
        for extra in (base + ".bin",):
            if os.path.exists(extra):
                written.append(extra)
    for file in written:
        if not os.path.exists(file):
            raise RuntimeError(f"export reported success but {file} is missing")
    return {"files": [{"path": f, "bytes": os.path.getsize(f)} for f in written], "format": fmt, "objects": selected or "all"}


def look_at(obj, target):
    from mathutils import Vector
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def op_dataset(req):
    """Render a multi-view dataset in the NeRF/Blender transforms.json layout
    that LichtFeld Studio (and nerfstudio, instant-ngp) train from directly.
    Cameras orbit the target on one or more elevation rings; the transform
    matrix is Blender's camera matrix_world (OpenGL axes), exactly what the
    loaders expect from a Blender-authored dataset."""
    from mathutils import Vector
    scene = bpy.context.scene
    render = apply_render_settings(scene, req)
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.film_transparent = bool(req.get("transparent", True))
    out_dir = req["outputDir"]
    images_dir = os.path.join(out_dir, "images")
    os.makedirs(images_dir, exist_ok=True)
    count = int(req.get("views") or 60)
    radius = float(req.get("radius") or 0)
    center = req.get("center")
    targets = [o for o in bpy.data.objects if o.type == "MESH" and not o.hide_render]
    if center is None:
        if targets:
            lo = Vector((math.inf,) * 3)
            hi = Vector((-math.inf,) * 3)
            for obj in targets:
                for corner in obj.bound_box:
                    world = obj.matrix_world @ Vector(corner)
                    lo = Vector(min(a, b) for a, b in zip(lo, world))
                    hi = Vector(max(a, b) for a, b in zip(hi, world))
            center = list((lo + hi) / 2)
            extent = (hi - lo).length
        else:
            center, extent = [0.0, 0.0, 0.0], 2.0
    else:
        extent = 2.0
    if radius <= 0:
        radius = max(extent * 1.6, 0.5)
    elevations = req.get("elevations") or [15, 35, 55]
    cam_data = bpy.data.cameras.new("YunusPiDatasetCamera")
    cam_data.lens = float(req.get("lensMm") or 35)
    cam_data.sensor_width = 36.0
    cam = bpy.data.objects.new("YunusPiDatasetCamera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    width = int(render.resolution_x * render.resolution_percentage / 100)
    height = int(render.resolution_y * render.resolution_percentage / 100)
    fov_x = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))
    frames = []
    seed = float(req.get("seed") or 0)
    per_ring = max(1, count // len(elevations))
    index = 0
    started = time.time()
    for ring, elevation in enumerate(elevations):
        for k in range(per_ring):
            if index >= count:
                break
            azimuth = (k / per_ring) * 2 * math.pi + seed + ring * 0.37
            el = math.radians(float(elevation))
            cam.location = Vector(center) + Vector((radius * math.cos(el) * math.cos(azimuth), radius * math.cos(el) * math.sin(azimuth), radius * math.sin(el)))
            look_at(cam, center)
            bpy.context.view_layer.update()
            name = f"r_{index:03d}.png"
            render.filepath = os.path.join(images_dir, name)
            bpy.ops.render.render(write_still=True)
            if not os.path.exists(render.filepath):
                raise RuntimeError(f"view {index} was not written")
            frames.append({"file_path": f"images/{name}", "transform_matrix": [[round(v, 8) for v in row] for row in cam.matrix_world]})
            index += 1
            if index % 5 == 0 or index == count:
                sys.stdout.write(f"YUNUSPI_PROGRESS view {index}/{count} ({time.time() - started:.0f}s)\n")
                sys.stdout.flush()
    transforms = {
        "camera_model": "OPENCV",
        "camera_angle_x": fov_x,
        "fl_x": width / (2 * math.tan(fov_x / 2)),
        "fl_y": width / (2 * math.tan(fov_x / 2)),
        "cx": width / 2,
        "cy": height / 2,
        "w": width,
        "h": height,
        "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
        "frames": frames,
    }
    with open(os.path.join(out_dir, "transforms.json"), "w", encoding="utf-8") as handle:
        json.dump(transforms, handle, indent=1)
    # The dataset camera is a tool-owned object; drop it so the user's scene is unchanged.
    bpy.data.objects.remove(cam)
    bpy.data.cameras.remove(cam_data)
    return {"outputDir": out_dir, "transforms": os.path.join(out_dir, "transforms.json"), "views": len(frames), "resolution": [width, height], "center": [round(c, 4) for c in center], "radius": round(radius, 4), "elevations": elevations, "seconds": round(time.time() - started, 1), "render": summarize_render(scene)}


OPS = {"inspect": op_inspect, "render": op_render, "export": op_export, "dataset": op_dataset}


def main():
    req = request_from_argv()
    op = req.get("op")
    if op not in OPS:
        emit({"ok": False, "error": f"unknown op {op}"})
        sys.exit(2)
    try:
        result = OPS[op](req)
        emit({"ok": True, "op": op, **result})
    except Exception as error:  # noqa: BLE001 - reported to the harness as data
        emit({"ok": False, "op": op, "error": f"{type(error).__name__}: {error}"})
        sys.exit(1)


main()
