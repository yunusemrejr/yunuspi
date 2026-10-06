"""Headless Blender worker for the YunusPi blender_* tools.

Runs inside Blender (`blender -b [file.blend] -P blender-studio.py -- request.json`).
The request JSON carries one `op` (inspect, render, export, dataset, splat_preview, shot); the
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
        "fps": scene.render.fps / scene.render.fps_base,
        "fpsNumerator": scene.render.fps,
        "fpsBase": scene.render.fps_base,
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


def animation_summary(owner):
    """Read legacy and layered/slotted Actions without relying on removed APIs."""
    data = getattr(owner, "animation_data", None)
    if not data:
        return None
    action = data.action
    curves = []
    if action:
        slot = getattr(data, "action_slot", None)
        for layer in getattr(action, "layers", []):
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", []):
                    if slot is None or bag.slot_handle == slot.handle:
                        curves.extend(bag.fcurves)
        if not curves:
            curves.extend(getattr(action, "fcurves", []))
    details = []
    key_count = 0
    for curve in curves:
        key_count += len(curve.keyframe_points)
        if len(details) >= 64:
            continue
        points = list(curve.keyframe_points)
        times = [float(point.co.x) for point in points]
        details.append({"path": curve.data_path, "index": curve.array_index,
                        "keys": len(points), "range": [min(times), max(times)] if times else None,
                        "interpolation": sorted(set(point.interpolation for point in points)),
                        "extrapolation": curve.extrapolation, "muted": curve.mute,
                        "modifiers": [modifier.type for modifier in curve.modifiers],
                        "duplicateTimes": len(times) - len(set(times))})
    tracks = [{"name": track.name, "muted": track.mute,
               "strips": [{"name": strip.name, "from": strip.frame_start, "to": strip.frame_end,
                           "scale": strip.scale, "repeat": strip.repeat, "influence": strip.influence,
                           "action": strip.action.name if strip.action else None} for strip in list(track.strips)[:32]]}
              for track in list(data.nla_tracks)[:32]]
    return {"action": action.name if action else None,
            "frame_range": vec(action.frame_range) if action else None,
            "slot": getattr(getattr(data, "action_slot", None), "identifier", None),
            "curves": len(curves), "keys": key_count, "channels": details,
            "truncated": len(curves) > 64, "drivers": len(data.drivers), "nla": tracks,
            "scope": "Stored animation channels and driver/NLA counts; evaluated samples include their combined scene effect."}


def op_inspect(req):
    scene = bpy.context.scene
    if req.get("scene"):
        scene = bpy.data.scenes[req["scene"]]
    if bpy.context.window:
        bpy.context.window.scene = scene
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
        animation = animation_summary(obj)
        if animation:
            entry["animation"] = animation
        data_animation = animation_summary(obj.data) if obj.data else None
        if data_animation:
            entry["dataAnimation"] = data_animation
        objects.append(entry)
    missing = []
    for image in bpy.data.images:
        if image.source == "FILE" and image.filepath and not os.path.exists(bpy.path.abspath(image.filepath)):
            missing.append(bpy.path.abspath(image.filepath))
    for library in bpy.data.libraries:
        if not os.path.exists(bpy.path.abspath(library.filepath)):
            missing.append(bpy.path.abspath(library.filepath))
    world = scene.world
    samples = []
    original_frame, original_subframe = scene.frame_current, scene.frame_subframe
    try:
        for frame in req.get("frames", []):
            scene.frame_set(int(frame))
            graph = bpy.context.evaluated_depsgraph_get()
            sampled = []
            for obj in list(scene.objects)[:512]:
                evaluated = obj.evaluated_get(graph)
                sampled.append({"name": obj.name, "worldMatrix": [[round(float(v), 6) for v in row] for row in evaluated.matrix_world],
                                "dimensions": vec(evaluated.dimensions), "visible": not obj.hide_render})
            samples.append({"frame": frame, "seconds": (frame - scene.frame_start) / (scene.render.fps / scene.render.fps_base),
                            "objects": sampled, "truncated": len(scene.objects) > 512})
    finally:
        scene.frame_set(original_frame, subframe=original_subframe)
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
        "animationSamples": samples,
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


def material_rgb(obj, material_index):
    """Base color of a face's material: node Base Color when present, else the viewport diffuse."""
    if not obj.data.materials or material_index >= len(obj.data.materials) or obj.data.materials[material_index] is None:
        return (0.8, 0.8, 0.8)
    mat = obj.data.materials[material_index]
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                return tuple(node.inputs["Base Color"].default_value[:3])
    return tuple(mat.diffuse_color[:3])


def write_seed_points(targets, path, cap=120000):
    """Seed point cloud (x y z + sRGB) from evaluated mesh vertices and face centres, in world space.
    Gaussian-splat trainers start from it like COLMAP's sparse points; without one, random
    initialisation rarely lands on a small object and the optimiser prunes everything."""
    import struct
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in targets:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            matrix = evaluated.matrix_world
            colors = [material_rgb(obj, poly.material_index) for poly in mesh.polygons]
            for poly in mesh.polygons:
                center = matrix @ poly.center
                rgb = colors[poly.index]
                points.append((center.x, center.y, center.z, rgb))
                for index in poly.vertices:
                    co = matrix @ mesh.vertices[index].co
                    points.append((co.x, co.y, co.z, rgb))
        finally:
            evaluated.to_mesh_clear()
    if len(points) > cap:
        step = len(points) / cap
        points = [points[int(i * step)] for i in range(cap)]
    with open(path, "wb") as handle:
        handle.write(("ply\nformat binary_little_endian 1.0\ncomment YunusPi seed points\n"
                      f"element vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\n"
                      "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n").encode("ascii"))
        for x, y, z, rgb in points:
            srgb = [max(0, min(255, int(round((c ** (1 / 2.2)) * 255)))) for c in rgb]
            handle.write(struct.pack("<fffBBB", x, y, z, *srgb))
    return len(points)


def pad_png(path, minimum=17000):
    """Some splat trainers read a fixed 16 KB header probe with read_exact and fail on tiny files;
    a tEXt chunk before IEND keeps small renders loadable without touching the pixels."""
    import struct
    import zlib
    data = open(path, "rb").read()
    if len(data) >= minimum:
        return False
    iend = data.rfind(b"IEND") - 4
    payload = b"yunuspi-pad\x00" + b"0" * (minimum - len(data))
    chunk = struct.pack(">I", len(payload)) + b"tEXt" + payload + struct.pack(">I", zlib.crc32(b"tEXt" + payload) & 0xFFFFFFFF)
    with open(path, "wb") as handle:
        handle.write(data[:iend] + chunk + data[iend:])
    return True


def look_at(obj, target):
    from mathutils import Vector
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def op_dataset(req):
    """Render a multi-view dataset in the NeRF/Blender transforms.json layout
    that Brush (and nerfstudio, instant-ngp) train from directly, plus init.ply seed points.
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
        radius = max(extent * 1.3, 0.5)
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
            pad_png(render.filepath)
            frames.append({"file_path": f"images/{name}", "transform_matrix": [[round(v, 8) for v in row] for row in cam.matrix_world]})
            index += 1
            if index % 5 == 0 or index == count:
                sys.stdout.write(f"YUNUSPI_PROGRESS view {index}/{count} ({time.time() - started:.0f}s)\n")
                sys.stdout.flush()
    seed_points = write_seed_points(targets, os.path.join(out_dir, "init.ply")) if targets else 0
    transforms = {
        "ply_file_path": "init.ply" if seed_points else None,
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
    if not seed_points:
        transforms.pop("ply_file_path")
    with open(os.path.join(out_dir, "transforms.json"), "w", encoding="utf-8") as handle:
        json.dump(transforms, handle, indent=1)
    # The dataset camera is a tool-owned object; drop it so the user's scene is unchanged.
    bpy.data.objects.remove(cam)
    bpy.data.cameras.remove(cam_data)
    return {"outputDir": out_dir, "transforms": os.path.join(out_dir, "transforms.json"), "views": len(frames), "seedPoints": seed_points, "resolution": [width, height], "center": [round(c, 4) for c in center], "radius": round(radius, 4), "elevations": elevations, "seconds": round(time.time() - started, 1), "render": summarize_render(scene)}


def read_gaussian_ply(path, max_points):
    """Positions, colours (SH DC → sRGB), opacity and mean radius from a 3DGS PLY (binary little-endian)."""
    import numpy as np
    with open(path, "rb") as handle:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = handle.readline()
            if not line:
                raise RuntimeError("not a PLY file")
            header += line
        text = header.decode("ascii", "replace")
        if "binary_little_endian" not in text:
            raise RuntimeError("only binary little-endian PLY splats are supported")
        count = int([l for l in text.splitlines() if l.startswith("element vertex")][0].split()[-1])
        names, types = [], []
        kinds = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1", "uint8": "u1", "int": "<i4", "uint": "<u4"}
        for line in text.splitlines():
            if line.startswith("property"):
                _, kind, name = line.split()[:3]
                names.append(name)
                types.append(kinds[kind])
        data = np.fromfile(handle, dtype=np.dtype(list(zip(names, types))), count=count)
    if count > max_points:
        data = data[np.linspace(0, count - 1, max_points).astype(int)]
    xyz = np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float32)
    if "f_dc_0" in names:
        rgb = np.clip(0.5 + 0.28209479177 * np.stack([data["f_dc_0"], data["f_dc_1"], data["f_dc_2"]], axis=1), 0, 1)
    elif "red" in names:
        rgb = np.stack([data["red"], data["green"], data["blue"]], axis=1).astype(np.float32) / 255.0
    else:
        rgb = np.full((len(data), 3), 0.8, dtype=np.float32)
    opacity = 1 / (1 + np.exp(-data["opacity"])) if "opacity" in names else np.ones(len(data), dtype=np.float32)
    if "scale_0" in names:
        radius = np.exp(np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], axis=1)).mean(axis=1)
    else:
        radius = np.full(len(data), 0.01, dtype=np.float32)
    return xyz, rgb.astype(np.float32), opacity.astype(np.float32), radius.astype(np.float32), count


def op_splat_preview(req):
    """Turntable of a Gaussian-splat PLY rendered as a coloured point cloud (opaque points sized by
    the splat scale): a shape, colour and coverage check, not the view-dependent splat appearance."""
    import numpy as np
    from mathutils import Vector
    xyz, rgb, opacity, radius, total = read_gaussian_ply(req["path"], int(req.get("maxPoints") or 400000))
    keep = opacity >= float(req.get("minOpacity") or 0.15)
    xyz, rgb, radius = xyz[keep], rgb[keep], radius[keep]
    if len(xyz) == 0:
        raise RuntimeError("no splats above the opacity threshold; the training produced an empty scene")
    # Robust bounds: ignore far floaters when framing.
    lo, hi = np.percentile(xyz, 2, axis=0), np.percentile(xyz, 98, axis=0)
    center = (lo + hi) / 2
    extent = float(np.linalg.norm(hi - lo))
    scene = bpy.context.scene
    for obj in bpy.data.objects:
        obj.hide_render = True
    mesh = bpy.data.meshes.new("YunusPiSplatPoints")
    mesh.vertices.add(len(xyz))
    mesh.vertices.foreach_set("co", xyz.ravel())
    color = mesh.color_attributes.new("Color", "FLOAT_COLOR", "POINT")
    color.data.foreach_set("color", np.concatenate([rgb, np.ones((len(rgb), 1), dtype=np.float32)], axis=1).ravel())
    size = mesh.attributes.new("radius", "FLOAT", "POINT")
    size.data.foreach_set("value", np.clip(radius * float(req.get("pointScale") or 1.0), extent * 0.0015, extent * 0.05))
    mesh.update()
    obj = bpy.data.objects.new("YunusPiSplatPoints", mesh)
    scene.collection.objects.link(obj)
    mat = bpy.data.materials.new("YunusPiSplatColor")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    attr = nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "Color"
    bsdf = nodes.get("Principled BSDF")
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 0.6
    obj.data.materials.append(mat)
    modifier = obj.modifiers.new("Points", "NODES")
    tree = bpy.data.node_groups.new("YunusPiMeshToPoints", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_in = tree.nodes.new("NodeGroupInput")
    group_out = tree.nodes.new("NodeGroupOutput")
    to_points = tree.nodes.new("GeometryNodeMeshToPoints")
    named = tree.nodes.new("GeometryNodeInputNamedAttribute")
    named.data_type = "FLOAT"
    named.inputs["Name"].default_value = "radius"
    set_mat = tree.nodes.new("GeometryNodeSetMaterial")
    set_mat.inputs["Material"].default_value = mat
    tree.links.new(group_in.outputs[0], to_points.inputs["Mesh"])
    tree.links.new(named.outputs["Attribute"], to_points.inputs["Radius"])
    tree.links.new(to_points.outputs["Points"], set_mat.inputs["Geometry"])
    tree.links.new(set_mat.outputs["Geometry"], group_out.inputs[0])
    modifier.node_group = tree
    world = scene.world or bpy.data.worlds.new("YunusPiSplatWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (*(req.get("background") or [0.02, 0.02, 0.02]), 1)
        bg.inputs["Strength"].default_value = 1.0
    cam_data = bpy.data.cameras.new("YunusPiSplatCamera")
    cam_data.lens = float(req.get("lensMm") or 35)
    cam = bpy.data.objects.new("YunusPiSplatCamera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    render = apply_render_settings(scene, req)
    render.image_settings.file_format = "PNG"
    render.film_transparent = False
    out_dir = req["outputDir"]
    os.makedirs(out_dir, exist_ok=True)
    frames = int(req.get("frames") or 48)
    up = Vector(req.get("up") or [0, 0, 1]).normalized()
    helper = Vector((0, 1, 0)) if abs(up.y) < 0.9 else Vector((1, 0, 0))
    e1 = up.cross(helper).normalized()
    e2 = up.cross(e1).normalized()
    distance = float(req.get("radius") or 0) or max(extent * 1.25, 0.1)
    elevation = math.radians(float(req.get("elevationDeg") if req.get("elevationDeg") is not None else 20))
    target = Vector(center.tolist())
    files = []
    started = time.time()
    for index in range(frames):
        angle = 2 * math.pi * index / frames
        cam.location = target + (e1 * math.cos(angle) + e2 * math.sin(angle)) * (distance * math.cos(elevation)) + up * (distance * math.sin(elevation))
        look_at(cam, target)
        render.filepath = os.path.join(out_dir, f"frame-{index + 1:04d}.png")
        bpy.ops.render.render(write_still=True)
        files.append({"frame": index + 1, "path": render.filepath, "bytes": os.path.getsize(render.filepath)})
        if (index + 1) % 8 == 0:
            sys.stdout.write(f"YUNUSPI_PROGRESS frame {index + 1}/{frames} ({time.time() - started:.0f}s)\n")
            sys.stdout.flush()
    return {"files": files, "splats": int(total), "shown": int(len(xyz)), "center": [round(float(c), 4) for c in center], "extent": round(extent, 4), "radius": round(distance, 4), "seconds": round(time.time() - started, 1), "render": summarize_render(scene)}


# ───────────────────────────── shots for video projects ─────────────────────────────
# A shot is a short camera move around one subject, rendered as an RGBA image
# sequence with a manifest and per-frame screen positions of named anchors, so
# a video timeline can composite it and pin 2D annotations to 3D features.

SUBJECT_TYPES = {"MESH", "CURVE", "FONT", "SURFACE", "META"}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_color(value, fallback):
    """#rrggbb -> linear RGBA tuple (Blender colours are scene-linear)."""
    text = value if isinstance(value, str) else fallback
    text = text.strip().lstrip("#")
    if len(text) != 6:
        text = fallback.lstrip("#")
    r, g, b = (int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)


def mix_color(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3)) + (1.0,)


def subject_objects(scene):
    return [o for o in scene.objects if o.type in SUBJECT_TYPES and not o.hide_render and not o.name.startswith("YP_")]


def subject_bounds(scene):
    from mathutils import Vector
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in subject_objects(scene):
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector(min(a, b) for a, b in zip(lo, world))
            hi = Vector(max(a, b) for a, b in zip(hi, world))
    if lo.x == math.inf:
        raise RuntimeError("the shot has no renderable subject (mesh, curve or text object)")
    center = (lo + hi) / 2
    radius = max((Vector(c) - center).length for c in [(x, y, z) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)])
    return lo, hi, center, max(radius, 1e-4)


def clear_scene_objects():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise RuntimeError(f"model format {ext} is not supported; use glb, gltf, obj, ply, stl or fbx")


def make_title(spec):
    """Extruded, bevelled 3D text standing upright and facing the default camera (-Y)."""
    curve = bpy.data.curves.new("YP_TitleCurve", "FONT")
    curve.body = str(spec.get("text") or "TITLE")[:120]
    curve.size = 1.0
    curve.extrude = float(spec.get("depth") or 0.18)
    curve.bevel_depth = float(spec.get("bevel") or 0.025)
    curve.bevel_resolution = 4
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.space_line = 0.9
    if spec.get("font"):
        curve.font = bpy.data.fonts.load(spec["font"])
    obj = bpy.data.objects.new("Title", curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler = (math.radians(90), 0, 0)
    return obj


def principled(name, color, kind):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    node = material.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = color
    settings = {
        "clay": {"Roughness": 0.62, "Metallic": 0.0},
        "satin": {"Roughness": 0.38, "Metallic": 0.55},
        "metal": {"Roughness": 0.24, "Metallic": 1.0},
        "glass": {"Roughness": 0.04, "Metallic": 0.0, "Transmission Weight": 1.0, "IOR": 1.45},
        "glow": {"Roughness": 0.5, "Metallic": 0.0},
    }[kind]
    for key, value in settings.items():
        if key in node.inputs:
            node.inputs[key].default_value = value
    if kind == "glow":
        for key in ("Emission Color", "Emission"):
            if key in node.inputs:
                node.inputs[key].default_value = color
        if "Emission Strength" in node.inputs:
            node.inputs["Emission Strength"].default_value = 2.5
    return material


def override_materials(scene, kind, color):
    material = principled(f"YP_{kind}", color, kind)
    for obj in subject_objects(scene):
        if obj.type in {"MESH", "CURVE", "FONT", "SURFACE"}:
            obj.data.materials.clear()
            obj.data.materials.append(material)


def ease_curve(t, kind):
    t = max(0.0, min(1.0, t))
    if kind == "linear":
        return t
    if kind == "out":
        return 1 - (1 - t) ** 3
    if kind == "in":
        return t ** 3
    return t * t * (3 - 2 * t)


def camera_pose(rig, t, p):
    """Camera azimuth (degrees from -Y toward +X), elevation (degrees) and a distance factor at progress t."""
    a0, el, deg = p["azimuth"], p["elevation"], p["degrees"]
    e = ease_curve(t, p["ease"])
    if rig == "turntable":
        return a0 + deg * t, el, 1.0
    if rig == "orbit":
        return a0 + deg * (e - 0.5), el + 3.0 * math.sin(math.pi * e), 1.0
    if rig == "push-in":
        return a0 + 6.0 * e, el, 1.0 + (p["travel"] - 1.0) * e
    if rig == "pull-out":
        return a0 + 6.0 * e, el, p["travel"] + (1.0 - p["travel"]) * e
    if rig == "crane":
        return a0 + deg * 0.5 * e, el + (p["elevation_end"] - el) * e, 0.85 + 0.3 * e
    if rig == "drift":
        w = 2 * math.pi * t
        return a0 + 2.6 * math.sin(w) + 1.1 * math.sin(2 * w + 0.8), el + 1.4 * math.sin(w + 1.7), 1.0 + 0.012 * math.sin(w + 0.4)
    return a0, el, 1.0


LOOPING_RIGS = {"turntable", "drift"}
RIGS = ("turntable", "orbit", "push-in", "pull-out", "crane", "drift", "static")


def add_studio_lights(scene, center, radius, preset, key_color, rim_color, strength):
    """Area lights sized to the subject: a large soft key, a dim opposing fill and a rim for separation."""
    from mathutils import Vector

    def area(name, azimuth, elevation, distance, size, power, color):
        az, el = math.radians(azimuth), math.radians(elevation)
        data = bpy.data.lights.new(f"YP_{name}", "AREA")
        data.shape = "RECTANGLE"
        data.size = size
        data.size_y = size * 0.7
        data.energy = power * strength * (distance / 4.0) ** 2
        data.color = color[:3]
        obj = bpy.data.objects.new(f"YP_{name}", data)
        scene.collection.objects.link(obj)
        obj.location = center + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * distance
        look_at(obj, center)
        return obj

    d = radius * 3.2
    if preset == "softbox":
        area("Key", -42, 38, d, radius * 3.4, 520, key_color)
        area("Fill", 58, 14, d * 1.1, radius * 4.0, 120, mix_color(key_color, rim_color, 0.5))
        area("Rim", 155, 28, d, radius * 2.2, 560, rim_color)
    elif preset == "rim":
        area("RimL", 128, 22, d, radius * 2.0, 760, rim_color)
        area("RimR", -138, 26, d, radius * 2.0, 520, key_color)
        area("Fill", -20, 10, d * 1.3, radius * 3.0, 40, key_color)
    elif preset == "top":
        area("Top", 0, 82, d, radius * 5.0, 620, key_color)
        area("Fill", -60, 12, d * 1.2, radius * 3.5, 90, mix_color(key_color, rim_color, 0.4))
        area("Rim", 150, 20, d, radius * 2.0, 360, rim_color)
    elif preset == "overcast":
        area("Dome", 0, 70, d * 1.2, radius * 8.0, 520, key_color)
        area("Fill", 180, 30, d * 1.2, radius * 6.0, 180, mix_color(key_color, rim_color, 0.3))


def shot_lens_distance(scene, cam_data, radius, margin):
    aspect = scene.render.resolution_x / max(1, scene.render.resolution_y)
    hfov = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))
    vfov = 2 * math.atan(math.tan(hfov / 2) / aspect)
    half = min(hfov, vfov) / 2
    return radius / math.sin(half) * margin


def anchor_points(spec, lo, hi, center):
    """Resolve anchor specs to callables returning a world-space point (Vector) at the current frame."""
    from mathutils import Vector
    named = {
        "bbox:top": Vector((center.x, center.y, hi.z)), "bbox:bottom": Vector((center.x, center.y, lo.z)),
        "bbox:left": Vector((lo.x, center.y, center.z)), "bbox:right": Vector((hi.x, center.y, center.z)),
        "bbox:front": Vector((center.x, lo.y, center.z)), "bbox:back": Vector((center.x, hi.y, center.z)),
        "bbox:center": center.copy(),
    }
    out = {}
    for item in spec:
        name = str(item)
        if name in named:
            out[name.split(":", 1)[1] if name.startswith("bbox:") else name] = (lambda point=named[name]: point)
        elif name in bpy.data.objects:
            out[name] = (lambda obj=bpy.data.objects[name]: obj.matrix_world.translation.copy())
        else:
            raise RuntimeError(f"anchor {name!r} is neither an object in the scene nor one of {sorted(named)}")
    return out


def write_png(path, rgba):
    """Write an 8-bit RGBA PNG from an H x W x 4 uint8 array (top row first) without extra libraries."""
    import struct
    import zlib
    height, width, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def read_pixels(path, raw=False):
    """Load a rendered image as an H x W x 4 float array, top row first. raw keeps the stored (display) values."""
    import numpy
    image = bpy.data.images.load(path)
    try:
        if raw:
            image.colorspace_settings.name = "Non-Color"
        data = numpy.empty(len(image.pixels), dtype=numpy.float32)
        image.pixels.foreach_get(data)
        return data.reshape(image.size[1], image.size[0], 4)[::-1].copy()
    finally:
        bpy.data.images.remove(image)


def render_pass(scene, render, path):
    render.filepath = path
    bpy.ops.render.render(write_still=True, scene=scene.name)
    if not os.path.exists(path):
        raise RuntimeError(f"Blender reported success but {path} was not written")


def box_blur(values, radius):
    """Separable box blur of an H x W array through cumulative sums (edges clamp)."""
    import numpy
    out = values.astype(numpy.float32)
    for axis in (0, 1):
        padded = numpy.concatenate([numpy.repeat(numpy.take(out, [0], axis=axis), radius, axis=axis), out, numpy.repeat(numpy.take(out, [-1], axis=axis), radius, axis=axis)], axis=axis)
        total = numpy.cumsum(padded, axis=axis, dtype=numpy.float64)
        head = numpy.take(total, range(2 * radius, total.shape[axis]), axis=axis)
        tail = numpy.concatenate([numpy.zeros_like(numpy.take(total, [0], axis=axis)), numpy.take(total, range(0, total.shape[axis] - 2 * radius - 1), axis=axis)], axis=axis)
        out = ((head - tail) / (2 * radius + 1)).astype(numpy.float32)
    return out


def soft_shadow_layer(scene, render, floor, contact, subjects, work_path, samples):
    """Ground shadow as an alpha map: the floor lit with the subject casting shadows, divided by the floor lit
    without them. Works in EEVEE, which has no shadow catcher; the lights and softness are the scene's own.
    The passes are scene-linear EXR so bright floors never clip and the ratio stays physical."""
    import numpy
    settings = render.image_settings
    saved = (render.film_transparent, settings.file_format, settings.color_depth, settings.color_mode, scene.eevee.taa_render_samples if render.engine == "BLENDER_EEVEE" else None)
    floor.visible_camera = True
    contact.hide_render = False
    render.film_transparent = False
    settings.file_format, settings.color_depth, settings.color_mode = "OPEN_EXR", "16", "RGBA"
    if saved[4] is not None:
        scene.eevee.taa_render_samples = samples
    exr = work_path.replace(".png", ".exr")
    try:
        for obj in subjects:
            obj.visible_camera = False
        render_pass(scene, render, exr)
        shadowed = read_pixels(exr)
        for obj in subjects:
            obj.visible_shadow = False
        os.remove(exr)
        render_pass(scene, render, exr)
        open_floor = read_pixels(exr)
    finally:
        for obj in subjects:
            obj.visible_camera = True
            obj.visible_shadow = True
        floor.visible_camera = False
        contact.hide_render = True
        render.film_transparent = saved[0]
        settings.file_format, settings.color_depth, settings.color_mode = saved[1], saved[2], saved[3]
        if saved[4] is not None:
            scene.eevee.taa_render_samples = saved[4]
        if os.path.exists(exr):
            os.remove(exr)
    weights = numpy.array([0.2126, 0.7152, 0.0722], dtype=numpy.float32)
    lit, free = shadowed[..., :3] @ weights, open_floor[..., :3] @ weights
    # Few-sample EEVEE shadows are noisy; a small box blur reads as the penumbra they stand for.
    radius_px = max(2, render.resolution_x * render.resolution_percentage // 100 // 320)
    shadow = box_blur(numpy.clip(1.0 - lit / numpy.maximum(free, 1e-4), 0.0, 1.0), radius_px)
    # The shadowed floor itself, normalised, is the lighting a flat background borrows: a pool of light with falloff and the shadow in it.
    pool = box_blur(lit, radius_px) / max(float(numpy.percentile(free, 98)), 1e-4)
    return shadow, pool


def composite_shot(beauty, layers, shadow_rgb, strength, flat):
    """Subject over its ground shadow, or over a flat colour lit by the same floor pool, straight alpha, uint8."""
    import numpy
    alpha_b = beauty[..., 3:4]
    if flat is not None:
        base = numpy.array(flat[:3], dtype=numpy.float32)
        if layers is not None:
            base = base * (0.4 + 1.0 * numpy.clip(layers[1], 0.0, 1.25))[..., None]
        base = numpy.clip(numpy.broadcast_to(base, beauty[..., :3].shape), 0.0, 1.0)
        out = beauty[..., :3] * alpha_b + base * (1.0 - alpha_b)
        return (numpy.clip(numpy.concatenate([out, numpy.ones_like(alpha_b)], axis=-1), 0, 1) * 255 + 0.5).astype("uint8")
    alpha_s = (layers[0][..., None] * strength) if layers is not None else numpy.zeros_like(alpha_b)
    color_s = numpy.broadcast_to(numpy.array(shadow_rgb[:3], dtype=numpy.float32), beauty[..., :3].shape)
    out_a = alpha_b + alpha_s * (1.0 - alpha_b)
    out_c = (beauty[..., :3] * alpha_b + color_s * alpha_s * (1.0 - alpha_b)) / numpy.maximum(out_a, 1e-6)
    return (numpy.clip(numpy.concatenate([out_c, out_a], axis=-1), 0, 1) * 255 + 0.5).astype("uint8")


def display_hex(value, fallback):
    """#rrggbb -> display-space floats (what a PNG stores), for compositing outside Blender's colour pipeline."""
    text = (value if isinstance(value, str) else fallback).strip().lstrip("#")
    if len(text) != 6:
        text = fallback.lstrip("#")
    return tuple(int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def op_shot(req):
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    scene = bpy.context.scene
    started = time.time()
    source = req.get("source") or "blend"
    if source != "blend":
        clear_scene_objects()
        for light in list(bpy.data.lights):
            bpy.data.lights.remove(light)
        if source == "model":
            import_model(req["model"])
        elif source == "title":
            make_title(req.get("title") or {})
        else:
            raise RuntimeError(f"unknown shot source {source}")
    elif not subject_objects(scene):
        raise RuntimeError("the .blend has no renderable subject object")
    palette = req.get("palette") or {}
    accent = hex_color(palette.get("accent"), "#D9A441")
    accent2 = hex_color(palette.get("accent2"), "#4A8FA3")
    ground = hex_color(palette.get("background"), "#181A1B")
    if req.get("material") and req["material"] != "keep":
        override_materials(scene, req["material"], hex_color(req.get("color"), palette.get("accent") or "#D9A441"))
    elif source != "blend" and not any(m.users for m in bpy.data.materials if m.name != "Dots Stroke"):
        override_materials(scene, "clay", hex_color(req.get("color"), palette.get("accent") or "#D9A441"))
    bpy.context.view_layer.update()
    # The subject's own animation (letters dropping in, a rig turning) plays on the blend's clock; the shot clock maps onto it.
    blend_fps = scene.render.fps / (scene.render.fps_base or 1.0)
    blend_start, blend_end = scene.frame_start, scene.frame_end
    shot_fps = float(req.get("fps") or 30)
    shot_count = max(2, int(round(float(req.get("seconds") or 4) * shot_fps)))
    blend_frame = lambda k: min(blend_end, blend_start + int(round(k / shot_fps * blend_fps)))
    scene.frame_set(blend_frame(shot_count - 1))
    lo, hi, center, radius = subject_bounds(scene)

    # The beauty pass is always transparent; a flat background is composited afterwards so the shadow layer can sit under the subject.
    render = apply_render_settings(scene, {**req, "format": "PNG", "transparent": True})
    render.image_settings.color_mode = "RGBA"
    try:
        scene.view_settings.view_transform = "Khronos PBR Neutral"
    except TypeError:
        scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = scene.world or bpy.data.worlds.new("YP_World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = mix_color(ground, (1, 1, 1, 1), 0.04)
    background.inputs["Strength"].default_value = float(req.get("ambient", 0.35))

    preset = req.get("lights") or "softbox"
    if preset != "scene":
        for light in [o for o in scene.objects if o.type == "LIGHT" and not o.name.startswith("YP_")]:
            bpy.data.objects.remove(light, do_unlink=True)
        add_studio_lights(scene, center, radius, preset, mix_color(hex_color("#FFF3E2", "#FFF3E2"), accent, 0.06), mix_color(accent2, (1, 1, 1, 1), 0.25), float(req.get("lightStrength", 1.0)))

    # shadow: "none" (floating subject), "soft" (EEVEE-friendly ground shadow composited per frame) or "catcher" (Cycles shadow catcher).
    shadow_mode = req.get("shadow") or ("none" if source == "title" else "soft")
    if shadow_mode not in ("none", "soft", "catcher"):
        raise RuntimeError("shadow must be none, soft or catcher")
    floor = contact_obj = None
    if shadow_mode != "none":
        size = radius * 40
        mesh = bpy.data.meshes.new("YP_GroundMesh")
        mesh.from_pydata([(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)], [], [(0, 1, 2, 3)])
        floor = bpy.data.objects.new("YP_Ground", mesh)
        scene.collection.objects.link(floor)
        floor.location = (0, 0, lo.z - 0.0005 * radius)
        floor.data.materials.append(principled("YP_GroundMat", (0.8, 0.8, 0.8, 1.0), "clay"))
        if shadow_mode == "catcher":
            floor.is_shadow_catcher = True
        else:
            floor.visible_camera = False
            # A soft overhead light that exists only in the shadow passes: it grounds the subject with a contact shadow.
            contact = bpy.data.lights.new("YP_Contact", "AREA")
            contact.size = radius * 7.0
            contact.energy = 2600 * float(req.get("lightStrength", 1.0)) * (radius * 3.2 / 4.0) ** 2
            contact_obj = bpy.data.objects.new("YP_Contact", contact)
            scene.collection.objects.link(contact_obj)
            contact_obj.location = center + Vector((0, 0, radius * 3.2))
            contact_obj.rotation_euler = (0, 0, 0)
            contact_obj.hide_render = True

    cam_data = bpy.data.cameras.new("YP_Camera")
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = 36.0
    cam_data.lens = float(req.get("lensMm") or 60)
    cam = bpy.data.objects.new("YP_Camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    offset = req.get("offset") or [0, 0]
    # Blender shifts the camera frame, so the subject moves the opposite way; negate so a positive offset moves the subject right and up.
    cam_data.shift_x, cam_data.shift_y = -float(offset[0]), -float(offset[1])
    if req.get("fStop"):
        cam_data.dof.use_dof = True
        cam_data.dof.aperture_fstop = float(req["fStop"])
    if req.get("motionBlur"):
        scene.render.use_motion_blur = True

    rig = req.get("rig") or "turntable"
    if rig not in RIGS:
        raise RuntimeError(f"rig must be one of {', '.join(RIGS)}")
    fps, count = shot_fps, shot_count
    params = {
        "azimuth": float(req.get("azimuth", 28)), "elevation": float(req.get("elevation", 20)), "ease": req.get("ease") or "inOut",
        "degrees": float(req.get("degrees", 360 if rig == "turntable" else 70 if rig == "orbit" else 80)),
        "travel": float(req.get("travel", 0.62)), "elevation_end": float(req.get("elevationEnd", 36)),
    }
    base_distance = shot_lens_distance(scene, cam_data, radius, float(req.get("margin", 1.18)))
    anchors = anchor_points(req.get("anchors") or [], lo, hi, center)
    poses = []
    for k in range(count):
        t = k / count if rig in LOOPING_RIGS else k / (count - 1)
        azimuth, elevation, factor = camera_pose(rig, t, params)
        az, el = math.radians(azimuth), math.radians(elevation)
        d = base_distance * factor
        poses.append((center + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * d, d))

    def aim(k):
        cam.location, distance = poses[k]
        look_at(cam, center)
        if cam_data.dof.use_dof:
            cam_data.dof.focus_distance = distance

    out_dir = req["outputDir"]
    os.makedirs(out_dir, exist_ok=True)
    files, track = [], []
    subjects = subject_objects(scene)
    flat_background = None if req.get("transparent", True) else display_hex(palette.get("background"), "#181A1B")
    shadow_color = (0.0, 0.0, 0.0)
    for frame in range(1, count + 1):
        scene.frame_set(blend_frame(frame - 1))
        aim(frame - 1)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        target = os.path.join(out_dir, f"frame-{frame:04d}.png")
        t0 = time.time()
        render_pass(scene, render, target)
        if shadow_mode == "soft" or flat_background is not None:
            beauty = read_pixels(target, raw=True)
            layers = soft_shadow_layer(scene, render, floor, contact_obj, subjects, os.path.join(out_dir, ".pass.png"), int(req.get("shadowSamples") or 20)) if shadow_mode == "soft" else None
            write_png(target, composite_shot(beauty, layers, shadow_color, float(req.get("shadowStrength", 0.62)), flat_background))
        files.append({"frame": frame, "path": target, "bytes": os.path.getsize(target), "seconds": round(time.time() - t0, 2)})
        if anchors:
            row = {}
            for name, locate in anchors.items():
                point = locate()
                u, v, depth = world_to_camera_view(scene, cam, point)
                visible = depth > 0 and 0.0 <= u <= 1.0 and 0.0 <= v <= 1.0
                if visible:
                    direction = point - cam.matrix_world.translation
                    distance = direction.length
                    hit, _loc, _n, _i, _obj, _m = scene.ray_cast(depsgraph, cam.matrix_world.translation, direction.normalized(), distance=distance)
                    # A hit nearer than the anchor means something stands in front of it.
                    if hit and (_loc - cam.matrix_world.translation).length < distance - radius * 0.03:
                        visible = False
                row[name] = {"x": round(u, 5), "y": round(1.0 - v, 5), "depth": round(depth, 4), "visible": bool(visible)}
            track.append({"frame": frame, "anchors": row})
        sys.stdout.write(f"YUNUSPI_PROGRESS shot frame {frame}/{count} in {time.time() - t0:.1f}s\n")
        sys.stdout.flush()
    anchors_file = None
    if track:
        anchors_file = os.path.join(out_dir, "anchors.json")
        with open(anchors_file, "w", encoding="utf-8") as handle:
            json.dump({"format": "yunuspi-shot-anchors-v1", "origin": "top-left", "units": "fraction of frame", "fps": fps, "names": list(anchors), "frames": track}, handle)
    if req.get("save"):
        # The editable copy carries the camera move as keyframes on the subject's own timeline.
        edit = bpy.context.preferences.edit
        previous_interpolation = edit.keyframe_new_interpolation_type
        edit.keyframe_new_interpolation_type = "LINEAR"
        try:
            for k in range(count):
                aim(k)
                cam.keyframe_insert("location", frame=blend_frame(k))
                cam.keyframe_insert("rotation_euler", frame=blend_frame(k))
        finally:
            edit.keyframe_new_interpolation_type = previous_interpolation
        os.makedirs(os.path.dirname(req["save"]) or ".", exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=req["save"], copy=True)
    summary = summarize_render(scene)
    manifest = {
        "format": "yunuspi-shot-v1", "name": req.get("name"), "rig": rig, "loop": rig in LOOPING_RIGS, "fps": fps, "frames": count,
        "width": summary["effective"][0], "height": summary["effective"][1], "alpha": flat_background is None,
        "pattern": "frame-%04d.png", "anchors": "anchors.json" if anchors_file else None, "anchorNames": list(anchors),
        "engine": summary["engine"], "samples": summary.get("samples"), "blender": bpy.app.version_string, "subject": {"center": [round(c, 4) for c in center], "radius": round(radius, 4)},
        "secondsPerFrame": round((time.time() - started) / max(1, len(files)), 2),
    }
    with open(os.path.join(out_dir, "shot.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
    return {"files": files, "manifest": manifest, "anchorsFile": anchors_file, "render": summary, "seconds": round(time.time() - started, 2)}


OPS = {"inspect": op_inspect, "render": op_render, "export": op_export, "dataset": op_dataset, "splat_preview": op_splat_preview, "shot": op_shot}


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
