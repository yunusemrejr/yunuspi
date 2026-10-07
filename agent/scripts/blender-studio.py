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


def emit(payload, result_file=None):
    encoded = json.dumps(payload, default=str)
    if result_file:
        if len(encoded.encode("utf-8")) > 32 * 1024 * 1024:
            raise RuntimeError("structured result exceeds 32 MiB")
        with open(result_file, "w", encoding="utf-8") as handle:
            handle.write(encoded)
        encoded = json.dumps({"ok": payload.get("ok"), "op": payload.get("op"), "resultWritten": True})
    sys.stdout.write(MARK + encoded + "\n")
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


def shader_details(owner):
    tree = owner.node_tree if owner.use_nodes else None
    if not tree:
        return {"nodes": 0, "surfaces": [], "textures": []}
    names = ['Base Color', 'Roughness', 'Metallic', 'IOR', 'Alpha', 'Transmission Weight', 'Coat Weight', 'Sheen Weight', 'Emission Color', 'Emission Strength', 'Color', 'Strength']
    surfaces = []
    for node in tree.nodes:
        if node.type not in ('BSDF_PRINCIPLED', 'EMISSION', 'BACKGROUND'):
            continue
        sockets = {}
        for name in names:
            socket = node.inputs.get(name)
            if socket is None:
                continue
            value = getattr(socket, 'default_value', None)
            sockets[name] = {"default": vec(value) if hasattr(value, '__iter__') else value,
                             "linked": socket.is_linked,
                             "sources": [{"node": link.from_node.name, "type": link.from_node.type, "socket": link.from_socket.name} for link in list(socket.links)[:4]]}
        surfaces.append({"name": node.name, "type": node.type, "inputs": sockets})
        if len(surfaces) >= 32:
            break
    textures = [{"node": node.name, "image": node.image.name, "packed": bool(node.image.packed_file),
                 "colorSpace": node.image.colorspace_settings.name} for node in tree.nodes if node.type == 'TEX_IMAGE' and node.image]
    return {"nodes": len(tree.nodes), "surfaces": surfaces, "textures": textures[:64],
            "truncated": len(textures) > 64 or len(surfaces) == 32,
            "scope": "Stored socket defaults and immediate links; linked values are not evaluated shader output."}


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
            "inScene": obj.name in scene.objects,
            "collections": [c.name for c in obj.users_collection],
        }
        if obj.type == "MESH":
            mesh = obj.data
            entry["verts"] = len(mesh.vertices)
            entry["faces"] = len(mesh.polygons)
            entry["smoothFaces"] = sum(face.use_smooth for face in mesh.polygons)
            entry["materials"] = [m.name for m in mesh.materials if m]
        if obj.modifiers:
            entry["modifiers"] = [f"{m.name}:{m.type}" for m in obj.modifiers]
        if obj.type == "CAMERA":
            cam = obj.data
            entry["camera"] = {"lens_mm": round(cam.lens, 3), "sensor_mm": round(cam.sensor_width, 3), "clip": [round(cam.clip_start, 4), round(cam.clip_end, 2)], "type": cam.type}
        if obj.type == "LIGHT":
            light = obj.data
            entry["light"] = {"type": light.type, "energy": round(light.energy, 3), "color": vec(light.color)}
            if light.type == 'AREA':
                entry["light"].update({"shape": light.shape, "size": light.size, "sizeY": light.size_y})
        animation = animation_summary(obj)
        if animation:
            entry["animation"] = animation
        data_animation = animation_summary(obj.data) if obj.data else None
        if data_animation:
            entry["dataAnimation"] = data_animation
        objects.append(entry)
    missing = []
    for image in bpy.data.images:
        if image.source == "FILE" and image.filepath and not image.packed_file and not os.path.exists(bpy.path.abspath(image.filepath)):
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
        "world": {"name": world.name, "use_nodes": world.use_nodes, "shader": shader_details(world)} if world else None,
        "colorManagement": {"viewTransform": scene.view_settings.view_transform, "look": scene.view_settings.look,
                            "exposure": scene.view_settings.exposure, "gamma": scene.view_settings.gamma,
                            "displayDevice": scene.display_settings.display_device},
        "collections": [{"name": c.name, "objects": len(c.objects), "hidden": c.hide_render} for c in bpy.data.collections],
        "objects": objects,
        "materials": [m.name for m in bpy.data.materials],
        "materialDetails": [{"name": m.name, "useNodes": m.use_nodes, "diffuseColor": vec(m.diffuse_color), "shader": shader_details(m)} for m in list(bpy.data.materials)[:1024]],
        "materialDetailsTruncated": len(bpy.data.materials) > 1024,
        "cameras": [o.name for o in bpy.data.objects if o.type == "CAMERA"],
        "lights": [o.name for o in bpy.data.objects if o.type == "LIGHT"],
        "sceneLights": [o.name for o in scene.objects if o.type == 'LIGHT' and not o.hide_render],
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
    visible = [o for o in scene.objects if o.type in SUBJECT_TYPES and not o.hide_render and not o.name.startswith("YP_")]
    def background(obj):
        while obj:
            if obj.get("yp_role") == "background":
                return True
            obj = obj.parent
        return False
    subjects = [o for o in visible if not background(o)]
    return subjects or visible


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


def detail_surfaces(scene, spec, radius):
    """Opt-in, scale-aware PBR detail; copy materials so shared originals
    retain their authored nodes. Bevel lives on the render object only."""
    if not spec:
        return
    kind = spec.get("texture")
    if kind not in ("brushed-metal", "ceramic", "organic"):
        raise RuntimeError("unknown surface texture")
    scale = float(spec.get("scale", 80))
    bump = float(spec.get("bump", 0.03))
    bevel = float(spec.get("bevel", 0))
    if not (1 <= scale <= 1000 and 0 <= bump <= 0.2 and 0 <= bevel <= 0.03):
        raise RuntimeError("surface detail exceeds its scale/bump/bevel bounds")
    copied = {}
    for obj in subject_objects(scene):
        if obj.type not in {"MESH", "CURVE", "FONT", "SURFACE"}:
            continue
        for slot in obj.material_slots:
            original = slot.material
            if not original or not original.use_nodes:
                continue
            if original.name not in copied:
                material = original.copy()
                material.name = original.name + "_YP_detail"
                copied[original.name] = material
                nodes, links = material.node_tree.nodes, material.node_tree.links
                shader = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
                if not shader:
                    continue
                for key, label in (("roughness", "Roughness"), ("metallic", "Metallic")):
                    if key in spec:
                        value = float(spec[key])
                        if not 0 <= value <= 1:
                            raise RuntimeError("surface roughness/metallic must be 0..1")
                        for link in list(shader.inputs[label].links):
                            links.remove(link)
                        shader.inputs[label].default_value = value
                coords = nodes.new("ShaderNodeTexCoord")
                mapping = nodes.new("ShaderNodeMapping")
                mapping.inputs["Scale"].default_value = (1, 1, 0.025) if kind == "brushed-metal" else (1, 1, 1)
                noise = nodes.new("ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = scale
                noise.inputs["Detail"].default_value = 2 if kind == "ceramic" else 4
                links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
                links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
                normal = nodes.new("ShaderNodeBump")
                normal.inputs["Strength"].default_value = bump
                normal.inputs["Distance"].default_value = max(radius, 0.001) * 0.002
                links.new(noise.outputs["Fac"], normal.inputs["Height"])
                if shader.inputs["Normal"].is_linked:
                    links.new(shader.inputs["Normal"].links[0].from_socket, normal.inputs["Normal"])
                links.new(normal.outputs["Normal"], shader.inputs["Normal"])
                if kind == "brushed-metal" and "Anisotropic IOR Level" in shader.inputs:
                    shader.inputs["Anisotropic IOR Level"].default_value = 0.55
            slot.material = copied[original.name]
        if obj.type == "MESH" and bevel > 0:
            modifier = obj.modifiers.new("YP_EdgeHighlights", "BEVEL")
            # Modifier width is local-space. Divide by maximum object scale
            # so a metre-sized subject has comparable edge highlights.
            modifier.width = radius * bevel / max(1e-6, max(abs(s) for s in obj.scale))
            modifier.segments = 3
            modifier.limit_method = "ANGLE"
            modifier.harden_normals = True


def ease_curve(t, kind):
    t = max(0.0, min(1.0, t))
    if kind == "linear":
        return t
    if kind == "backOut":
        u = t - 1
        return 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2
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
RIGS = ("turntable", "orbit", "push-in", "pull-out", "crane", "drift", "static", "scene", "path")


def build_shot_scene(spec, seconds, fps, palette):
    """Native, editable scene graph: finished device rigs, smooth forms,
    imported hero assets and deterministic object choreography. Metres, Z up,
    camera faces from -Y. Rotations in the tool contract are degrees."""
    from mathutils import Matrix, Vector
    scene = bpy.context.scene
    scene.render.fps = int(round(fps))
    scene.render.fps_base = scene.render.fps / fps
    scene.frame_start = 1
    scene.frame_end = max(2, int(round(seconds * fps)))
    roots, screens = {}, []

    def link(name, data=None):
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        return obj

    def finish(obj, name, material, bevel=0):
        obj.name = name
        if hasattr(obj.data, "materials"):
            obj.data.materials.append(material)
        if obj.type == "MESH":
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
            if bevel:
                modifier = obj.modifiers.new("Edge highlights", "BEVEL")
                modifier.width = bevel
                modifier.segments = 5
                modifier = obj.modifiers.new("Face normals", "WEIGHTED_NORMAL")
                modifier.keep_sharp = True
        return obj

    def box(name, size, position, mat, bevel=.035, parent=None):
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.object
        obj.data.transform(Matrix.Diagonal(Vector((*size, 1))))
        obj.location = position
        obj.parent = parent
        return finish(obj, name, mat, min(bevel, min(size) * .45))

    def screen_corners(root, prefix, width, height, y, z):
        for corner, x, dz in [("tl", -width/2, height/2), ("tr", width/2, height/2), ("br", width/2, -height/2), ("bl", -width/2, -height/2)]:
            anchor = link(f"{prefix}:{corner}")
            anchor.parent = root
            anchor.location = (x, y, z + dz)
            screens.append(anchor.name)

    for item in spec["objects"]:
        name, shape = item["id"], item["shape"]
        root = link(f"{name}-rig")
        roots[name] = root
        root["yp_role"] = item.get("role", "support")
        root.location = item.get("position", (0, 0, 0))
        root.rotation_euler = tuple(math.radians(v) for v in item.get("rotation", (0, 0, 0)))
        root.scale = item.get("scale", (1, 1, 1))
        mat = principled(f"{name}-material", hex_color(item.get("color"), palette.get("accent") or "#D9A441"), item.get("material") or "satin")
        if "roughness" in item:
            mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = item["roughness"]
        maps = item.get("maps") or {}
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        for kind in ("diffuse", "roughness", "metallic", "normal"):
            if not maps.get(kind):
                continue
            texture = mat.node_tree.nodes.new("ShaderNodeTexImage")
            texture.image = bpy.data.images.load(maps[kind], check_existing=True)
            texture.image.colorspace_settings.name = "sRGB" if kind == "diffuse" else "Non-Color"
            target = {"diffuse": "Base Color", "roughness": "Roughness", "metallic": "Metallic"}.get(kind)
            if target:
                mat.node_tree.links.new(texture.outputs["Color"], bsdf.inputs[target])
            else:
                normal = mat.node_tree.nodes.new("ShaderNodeNormalMap")
                mat.node_tree.links.new(texture.outputs["Color"], normal.inputs["Color"])
                mat.node_tree.links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
        size = item.get("size", (1, 1, 1))
        bevel = item.get("bevel", .025)
        obj = None
        if shape == "box":
            obj = box(name, size, (0, 0, 0), mat, bevel, root)
        elif shape == "image-plane":
            # An RGBA card in the XZ plane, facing the native camera from -Y.
            # Geometry stays editable; artwork can be layered in real depth
            # with modeled subjects and packed into the saved .blend.
            w, _, h = size
            mesh = bpy.data.meshes.new(f"{name}-card")
            mesh.from_pydata([(-w/2, 0, -h/2), (w/2, 0, -h/2), (w/2, 0, h/2), (-w/2, 0, h/2)], [], [(0, 1, 2, 3)])
            uv = mesh.uv_layers.new(name="Artwork UV")
            for loop, coordinate in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                loop.uv = coordinate
            nodes, links = mat.node_tree.nodes, mat.node_tree.links
            nodes.clear()
            output = nodes.new("ShaderNodeOutputMaterial")
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = bpy.data.images.load(item["image"], check_existing=True)
            texture.image.pack()
            surface = nodes.new("ShaderNodeBsdfPrincipled" if item.get("lit", False) else "ShaderNodeEmission")
            links.new(texture.outputs["Color"], surface.inputs["Base Color" if item.get("lit", False) else "Color"])
            if item.get("lit", False):
                surface.inputs["Roughness"].default_value = float(item.get("roughness", .6))
            transparent = nodes.new("ShaderNodeBsdfTransparent")
            blend = nodes.new("ShaderNodeMixShader")
            links.new(texture.outputs["Alpha"], blend.inputs[0])
            links.new(transparent.outputs[0], blend.inputs[1])
            links.new(surface.outputs[0], blend.inputs[2])
            links.new(blend.outputs[0], output.inputs["Surface"])
            if hasattr(mat, "surface_render_method"):
                mat.surface_render_method = 'DITHERED'
            obj = link(name, mesh)
            obj.parent = root
            finish(obj, name, mat)
        elif shape in ("sphere", "cylinder", "torus"):
            if shape == "sphere":
                bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=.5)
            elif shape == "cylinder":
                bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=.5, depth=1)
            else:
                bpy.ops.mesh.primitive_torus_add(major_segments=80, minor_segments=24, major_radius=.4, minor_radius=.1)
            obj = bpy.context.object
            obj.data.transform(Matrix.Diagonal(Vector((*size, 1))))
            obj.parent = root
            finish(obj, name, mat, bevel if shape == "cylinder" else 0)
        elif shape == "image":
            # Generated RGBA plates and browser UI become exact textured cards.
            # Shared Blender image datablocks keep repeated cards cheap.
            image = bpy.data.images.load(item["path"], check_existing=True)
            image.pack()
            image.colorspace_settings.name = "sRGB"
            w = size[0]
            h = size[2] if "size" in item else w * image.size[1] / max(1, image.size[0])
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata([(-w/2, 0, -h/2), (w/2, 0, -h/2), (w/2, 0, h/2), (-w/2, 0, h/2)], [], [(0, 1, 2, 3)])
            mesh.update()
            uv = mesh.uv_layers.new(name="UVMap")
            for loop, coords in zip(uv.data, [(0,0), (1,0), (1,1), (0,1)]):
                loop.uv = coords
            nodes, links = mat.node_tree.nodes, mat.node_tree.links
            nodes.clear()
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = image
            shader = nodes.new("ShaderNodeEmission" if item.get("unlit", True) else "ShaderNodeBsdfPrincipled")
            links.new(texture.outputs["Color"], shader.inputs["Color" if item.get("unlit", True) else "Base Color"])
            alpha = nodes.new("ShaderNodeMath")
            alpha.operation = "MULTIPLY"
            alpha.inputs[1].default_value = item.get("opacity", 1)
            links.new(texture.outputs["Alpha"], alpha.inputs[0])
            transparent = nodes.new("ShaderNodeBsdfTransparent")
            mix = nodes.new("ShaderNodeMixShader")
            links.new(alpha.outputs[0], mix.inputs[0])
            links.new(transparent.outputs[0], mix.inputs[1])
            links.new(shader.outputs[0], mix.inputs[2])
            output = nodes.new("ShaderNodeOutputMaterial")
            links.new(mix.outputs[0], output.inputs["Surface"])
            if hasattr(mat, "surface_render_method"):
                mat.surface_render_method = "DITHERED"
            obj = link(name, mesh)
            obj.parent = root
            mesh.materials.append(mat)
        elif shape == "lathe":
            # Radial profile makes bowls, bottles, food props and turned parts;
            # it is a real silhouette, not a pile of unrefined primitives.
            points, segments = item["points"], 80
            verts = [(r * math.cos(2 * math.pi * j / segments), r * math.sin(2 * math.pi * j / segments), z) for r, z in points for j in range(segments)]
            faces = [(i*segments+j, i*segments+(j+1)%segments, (i+1)*segments+(j+1)%segments, (i+1)*segments+j) for i in range(len(points)-1) for j in range(segments)]
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(verts, [], faces)
            mesh.update()
            obj = link(name, mesh)
            obj.parent = root
            finish(obj, name, mat)
        elif shape == "tube":
            curve = bpy.data.curves.new(name, "CURVE")
            curve.dimensions = "3D"
            curve.bevel_depth = item.get("radius", .035)
            curve.bevel_resolution = 5
            spline = curve.splines.new("BEZIER")
            spline.bezier_points.add(len(item["points"])-1)
            for point, coords in zip(spline.bezier_points, item["points"]):
                point.co = coords
                point.handle_left_type = point.handle_right_type = "AUTO"
            obj = link(name, curve)
            obj.parent = root
            finish(obj, name, mat)
        elif shape == "text":
            obj = make_title({"text": item["text"], "font": item.get("font"), "depth": item.get("depth", .04), "bevel": min(bevel, .01)})
            obj.parent = root
            obj.scale = size
            finish(obj, name, mat)
        elif shape == "model":
            before = set(scene.objects)
            import_model(item["path"])
            imported = list(set(scene.objects) - before)
            bpy.context.view_layer.update()
            geometry = [o for o in imported if o.type in SUBJECT_TYPES]
            if not geometry:
                raise RuntimeError(f"{name}: imported asset has no geometry")
            corners = [o.matrix_world @ Vector(c) for o in geometry for c in o.bound_box]
            lo = Vector(min(p[i] for p in corners) for i in range(3))
            hi = Vector(max(p[i] for p in corners) for i in range(3))
            extent = max(hi - lo)
            # Scale uniformly to size.x (longest extent), place its bottom at
            # the parent origin. Preserve authored materials and hierarchy.
            factor = size[0] / max(extent, 1e-6)
            normalization = link(f"{name}-asset-normalization")
            normalization.parent = root
            normalization.scale = (factor,) * 3
            normalization.location = (-((lo.x+hi.x)/2)*factor, -((lo.y+hi.y)/2)*factor, -lo.z*factor)
            for imported_obj in imported:
                if imported_obj.parent not in imported:
                    matrix = imported_obj.matrix_world.copy()
                    imported_obj.parent = normalization
                    imported_obj.matrix_basis = matrix
        elif shape in ("phone", "laptop"):
            metal = principled(f"{name}-aluminium", hex_color(item.get("color"), "#343B44"), "metal")
            black = principled(f"{name}-bezel", hex_color("#0B0E13", "#0B0E13"), "clay")
            screen_mat = principled(f"{name}-screen", hex_color("#171B24", "#171B24"), "clay")
            screen_mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = .19
            if shape == "phone":
                w, h, d = 1.45, 2.9, .14
                box(f"{name}-body", (w, d, h), (0, 0, h/2), metal, .065, root)
                box(f"{name}-bezel", (w-.045, .018, h-.04), (0, -d/2-.007, h/2), black, .045, root)
                sw, sh = w-.14, h-.18
                box(f"{name}-display", (sw, .008, sh), (0, -d/2-.02, h/2), screen_mat, .028, root)
                box(f"{name}-speaker", (.23, .012, .022), (0, -d/2-.03, h-.095), black, .008, root)
                box(f"{name}-button", (.025, .06, .27), (w/2+.005, 0, h*.67), metal, .008, root)
                screen_corners(root, item.get("screenPrefix", "screen"), sw, sh, -d/2-.026, h/2)
            else:
                w, h = 3.5, 2.12
                lid = link(f"{name}-lid")
                lid.parent = root
                lid.location = (0, .48, .15)
                lid.rotation_euler = (math.radians(-8), 0, 0)
                box(f"{name}-back", (w, .1, h), (0, 0, h/2), metal, .04, lid)
                box(f"{name}-bezel", (w-.07, .014, h-.06), (0, -.058, h/2), black, .02, lid)
                sw, sh = w-.22, h-.18
                box(f"{name}-display", (sw, .008, sh), (0, -.073, h/2), screen_mat, .006, lid)
                box(f"{name}-base", (w, 2.05, .13), (0, -.47, .065), metal, .04, root)
                for row in range(5):
                    for col in range(12):
                        box(f"{name}-key-{row}-{col}", (.2, .14, .015), (-1.32+col*.24, -.1-row*.19, .14), black, .012, root)
                box(f"{name}-trackpad", (1.05, .57, .009), (0, -1.16, .137), metal, .025, root)
                screen_corners(lid, item.get("screenPrefix", "screen"), sw, sh, -.078, h/2)
            if "size" in item:
                dimensions = (w, d, h) if shape == "phone" else (w, 2.35, 2.25)
                root.scale = tuple(a*b/c for a, b, c in zip(root.scale, size, dimensions))
        if item.get("motion"):
            keys = item["motion"]
            defaults = {"position": list(root.location), "rotation": [math.degrees(v) for v in root.rotation_euler], "scale": list(root.scale)}
            for k in range(scene.frame_end):
                t = k/fps
                index = 0
                while index+1 < len(keys) and keys[index+1]["t"] <= t:
                    index += 1
                a, b = keys[index], keys[min(index+1, len(keys)-1)]
                p = ease_curve((t-a["t"])/max(1e-6, b["t"]-a["t"]), a.get("ease", "inOut")) if b != a else 0
                for field, target in [("position", "location"), ("rotation", "rotation_euler"), ("scale", "scale")]:
                    def value(end):
                        for n in range(end, -1, -1):
                            if field in keys[n]:
                                return keys[n][field]
                        return defaults[field]
                    va, vb = value(index), value(min(index+1, len(keys)-1))
                    result = [v+(w-v)*p for v, w in zip(va, vb)]
                    if field == "rotation":
                        result = [math.radians(v) for v in result]
                    if field == "scale":
                        result = [max(0.0001, v) for v in result]
                    setattr(root, target, result)
                    root.keyframe_insert(target, frame=k+1)
    for item in spec["objects"]:
        if item.get("parent"):
            roots[item["id"]].parent = roots[item["parent"]]
    def offset_for(instance, i):
        spacing = instance.get("spacing", [1.5, 0, 0])
        if instance.get("layout") == "radial":
            angle = math.radians(instance.get("startAngle", 0) + instance.get("sweep", 360) * i / max(1, instance["count"] if instance.get("sweep", 360) == 360 else instance["count"]-1))
            radius = instance.get("radius", 2)
            return (radius * math.cos(angle), radius * math.sin(angle), i * spacing[2])
        if instance.get("layout") == "grid":
            columns = instance.get("columns", int(math.ceil(math.sqrt(instance["count"]))))
            return ((i % columns) * spacing[0], (i // columns) * spacing[1], (i // columns) * spacing[2])
        return tuple(i * v for v in spacing)

    def copy_tree(original, parent, label):
        clone = original.copy()  # shares mesh/curve/material/image datablocks
        scene.collection.objects.link(clone)
        clone.name = label
        clone.parent = parent
        for child in original.children:
            copy_tree(child, clone, f"{label}-{child.name}")
        return clone

    def shift_action(obj, delay):
        data = obj.animation_data
        if not data or not data.action or delay == 0:
            return
        data.action = data.action.copy()
        slots = list(getattr(data.action, "slots", []))
        if slots:
            data.action_slot = slots[0]
        curves = list(getattr(data.action, "fcurves", []))
        for layer in getattr(data.action, "layers", []):
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", []):
                    curves.extend(bag.fcurves)
        for curve in curves:
            for point in curve.keyframe_points:
                point.co.x += delay
                point.handle_left.x += delay
                point.handle_right.x += delay
        for child in obj.children:
            shift_action(child, delay)

    for item in spec["objects"]:
        instance = item.get("instances")
        if not instance:
            continue
        original = roots[item["id"]]
        parent = original.parent
        for i in range(1, instance["count"]):
            placement = link(f"{item['id']}-instance-{i}-offset")
            placement.parent = parent
            placement.location = offset_for(instance, i)
            clone = copy_tree(original, placement, f"{item['id']}-instance-{i}-rig")
            shift_action(clone, i * instance.get("stagger", 0) * fps)
        placement = link(f"{item['id']}-instance-0-offset")
        placement.parent = parent
        placement.location = offset_for(instance, 0)
        original.parent = placement
    scene.frame_set(1)
    bpy.context.view_layer.update()
    return screens


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
    palette = req.get("palette") or {}
    native_screens = []
    if source != "blend":
        clear_scene_objects()
        for light in list(bpy.data.lights):
            bpy.data.lights.remove(light)
        if source == "model":
            import_model(req["model"])
        elif source == "title":
            make_title(req.get("title") or {})
        elif source == "scene":
            native_screens = build_shot_scene(req["scene"], float(req.get("seconds") or 4), float(req.get("fps") or 30), palette)
        else:
            raise RuntimeError(f"unknown shot source {source}")
    elif not subject_objects(scene):
        raise RuntimeError("the .blend has no renderable subject object")
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
    blend_frame = lambda k: min(blend_end, blend_start + k / shot_fps * blend_fps)
    def set_shot_frame(k):
        value = blend_frame(k)
        scene.frame_set(math.floor(value), subframe=value-math.floor(value))
    # Frame the swept subject, including its entrance and articulation. A
    # final-frame-only bound makes earlier motion disappear off screen.
    sampled_bounds = []
    for k in sorted(set(int(round(i*(shot_count-1)/11)) for i in range(12))):
        set_shot_frame(k)
        bpy.context.view_layer.update()
        sampled_bounds.append(subject_bounds(scene)[:2])
    lo = Vector(min(pair[0][axis] for pair in sampled_bounds) for axis in range(3))
    hi = Vector(max(pair[1][axis] for pair in sampled_bounds) for axis in range(3))
    center = (lo+hi)/2
    radius = max((hi-lo).length/2, 1e-4)
    detail_surfaces(scene, req.get("surface"), radius)

    # The beauty pass is always transparent; a flat background is composited afterwards so the shadow layer can sit under the subject.
    render = apply_render_settings(scene, {**req, "format": "PNG", "transparent": True})
    render.image_settings.color_mode = "RGBA"
    rig = req.get("rig") or ("scene" if source == "blend" and scene.camera else "orbit")
    if rig not in RIGS:
        raise RuntimeError(f"rig must be one of {', '.join(RIGS)}")
    if rig != "scene":
        try:
            scene.view_settings.view_transform = "Khronos PBR Neutral"
        except TypeError:
            scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    # Authored shots retain their world, lights, camera and color management.
    # An explicit environment replaces the world surface; never assume a
    # user's Background node still has Blender's default name.
    if rig != "scene" or req.get("environment") or not scene.world:
        world = scene.world or bpy.data.worlds.new("YP_World")
        scene.world = world
        world.use_nodes = True
        background = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
        if not background:
            background = world.node_tree.nodes.new('ShaderNodeBackground')
        output = next((n for n in world.node_tree.nodes if n.type == 'OUTPUT_WORLD' and n.is_active_output), None)
        if not output:
            output = world.node_tree.nodes.new('ShaderNodeOutputWorld')
        world.node_tree.links.new(background.outputs['Background'], output.inputs['Surface'])
        background.inputs["Color"].default_value = mix_color(ground, (1, 1, 1, 1), 0.04)
        background.inputs["Strength"].default_value = float(req.get("ambient", 0.35))
        if req.get("environment"):
            hdri = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
            hdri.image = bpy.data.images.load(req["environment"], check_existing=True)
            world.node_tree.links.new(hdri.outputs["Color"], background.inputs["Color"])
            background.inputs["Strength"].default_value = float(req.get("environmentStrength", .6))

    preset = req.get("lights") or ("scene" if rig == "scene" else "softbox")
    if preset != "scene":
        for light in [o for o in scene.objects if o.type == "LIGHT" and not o.name.startswith("YP_")]:
            bpy.data.objects.remove(light, do_unlink=True)
        add_studio_lights(scene, center, radius, preset, mix_color(hex_color("#FFF3E2", "#FFF3E2"), accent, 0.06), mix_color(accent2, (1, 1, 1, 1), 0.25), float(req.get("lightStrength", 1.0)))

    # shadow: "none" (floating subject), "soft" (EEVEE-friendly ground shadow composited per frame) or "catcher" (Cycles shadow catcher).
    shadow_mode = req.get("shadow") or ("none" if source == "title" or rig == "scene" else "soft")
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

    if rig == "scene":
        cam = ensure_camera(scene)
        cam_data = cam.data
    else:
        cam_data = bpy.data.cameras.new("YP_Camera")
        cam_data.sensor_fit = "HORIZONTAL"
        cam_data.sensor_width = 36.0
        cam_data.lens = float(req.get("lensMm") or 60)
        cam = bpy.data.objects.new("YP_Camera", cam_data)
        scene.collection.objects.link(cam)
        scene.camera = cam
    offset = req.get("offset") or [0, 0]
    # Blender shifts the camera frame, so the subject moves the opposite way; negate so a positive offset moves the subject right and up.
    if rig != "scene":
        cam_data.shift_x, cam_data.shift_y = -float(offset[0]), -float(offset[1])
    if req.get("projection") == "orthographic":
        cam_data.type = "ORTHO"
        # Horizontal sensor fit: orthographic scale is the view width. Fit
        # the swept sphere to both axes, keeping authored planar forms flat.
        aspect = render.resolution_x / max(1, render.resolution_y)
        cam_data.ortho_scale = 2 * radius * float(req.get("margin") or 1.15) * max(1, aspect)
    elif req.get("projection") == "perspective":
        cam_data.type = "PERSP"
    if req.get("fStop"):
        cam_data.dof.use_dof = True
        cam_data.dof.aperture_fstop = float(req["fStop"])
    if req.get("motionBlur"):
        scene.render.use_motion_blur = True

    fps, count = shot_fps, shot_count
    params = {
        "azimuth": float(req.get("azimuth", 8 if source in ("title", "scene") else 28)), "elevation": float(req.get("elevation", 8 if source in ("title", "scene") else 20)), "ease": req.get("ease") or "inOut",
        "degrees": float(req.get("degrees", 360 if rig == "turntable" else 18 if rig == "orbit" else 80)),
        "travel": float(req.get("travel", 0.62)), "elevation_end": float(req.get("elevationEnd", 36)),
    }
    base_distance = shot_lens_distance(scene, cam_data, radius, float(req.get("margin", 1.18)))
    # Fit the actual bounding corners in the chosen projection instead of a
    # sphere around them. Thin devices and long text no longer become tiny.
    if rig not in ("scene", "path"):
        hfov = 2*math.atan(cam_data.sensor_width/(2*cam_data.lens))
        vfov = 2*math.atan(math.tan(hfov/2)*render.resolution_y/render.resolution_x)
        corners = [Vector((x,y,z))-center for x in (lo.x,hi.x) for y in (lo.y,hi.y) for z in (lo.z,hi.z)]
        distances = []
        for k in range(count):
            azimuth, elevation, factor = camera_pose(rig, k/max(1,count-1), params)
            az, el = math.radians(azimuth), math.radians(elevation)
            direction = Vector((math.sin(az)*math.cos(el), -math.cos(az)*math.cos(el), math.sin(el)))
            cam.location = center+direction
            look_at(cam, center)
            basis = cam.rotation_euler.to_matrix()
            right, up = basis.col[0], basis.col[1]
            required = max(max(p.dot(direction)+abs(p.dot(right))/math.tan(hfov/2), p.dot(direction)+abs(p.dot(up))/math.tan(vfov/2)) for p in corners)
            distances.append(required/max(.2,factor))
        base_distance = max(distances)*float(req.get("margin", 1.1))/max(.1,1-2*max(abs(float(v)) for v in offset))
    anchors = anchor_points(list(req.get("anchors") or [])+native_screens, lo, hi, center)
    poses = []
    for k in range(count):
        t = k / count if rig in LOOPING_RIGS else k / (count - 1)
        azimuth, elevation, factor = camera_pose(rig, t, params)
        az, el = math.radians(azimuth), math.radians(elevation)
        d = base_distance * factor
        poses.append((center + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * d, d))

    def aim(k):
        if rig == "scene":
            return
        target = center
        if rig == "path":
            keys = req.get("cameraPath")
            if not keys or len(keys) < 2:
                raise RuntimeError("rig:path requires two or more cameraPath keys")
            t = k / fps
            index = 0
            while index+1 < len(keys) and keys[index+1]["t"] <= t:
                index += 1
            a, b = keys[index], keys[min(index+1, len(keys)-1)]
            p = ease_curve((t-a["t"])/max(1e-6, b["t"]-a["t"]), a.get("ease", "inOut")) if b != a else 0
            cam.location = Vector([v+(w-v)*p for v,w in zip(a["position"], b["position"])])
            target = Vector([v+(w-v)*p for v,w in zip(a["target"], b["target"])])
            def lens_at(end):
                for n in range(end, -1, -1):
                    if "lensMm" in keys[n]:
                        return keys[n]["lensMm"]
                return float(req.get("lensMm") or 60)
            left, right = lens_at(index), lens_at(min(index+1, len(keys)-1))
            cam_data.lens = left+(right-left)*p
            distance = (target-cam.location).length
            if distance < .001:
                raise RuntimeError("cameraPath intersects its look target")
        else:
            cam.location, distance = poses[k]
        look_at(cam, target)
        if cam_data.dof.use_dof:
            cam_data.dof.focus_distance = distance

    out_dir = req["outputDir"]
    os.makedirs(out_dir, exist_ok=True)
    files, track, framing = [], [], []
    subjects = subject_objects(scene)
    flat_background = None if req.get("transparent", True) else display_hex(palette.get("background"), "#181A1B")
    shadow_color = (0.0, 0.0, 0.0)
    for frame in range(1, count + 1):
        set_shot_frame(frame - 1)
        aim(frame - 1)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        projected = [world_to_camera_view(scene, cam, obj.matrix_world @ Vector(c)) for obj in subject_objects(scene) for c in obj.evaluated_get(depsgraph).bound_box]
        positive = [p for p in projected if p.z > 0]
        if positive:
            framing.append({"frame": frame, "box": [round(min(p.x for p in positive),4), round(1-max(p.y for p in positive),4), round(max(p.x for p in positive)-min(p.x for p in positive),4), round(max(p.y for p in positive)-min(p.y for p in positive),4)], "behindCamera": len(projected)-len(positive)})
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
            if rig != "scene":
                for k in range(count):
                    aim(k)
                    cam.keyframe_insert("location", frame=blend_frame(k))
                    cam.keyframe_insert("rotation_euler", frame=blend_frame(k))
                    if rig == "path":
                        cam_data.keyframe_insert("lens", frame=blend_frame(k))
                    if cam_data.dof.use_dof:
                        cam_data.keyframe_insert("dof.focus_distance", frame=blend_frame(k))
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
        "framing": framing, "screenAnchors": native_screens,
        "nativeInstances": sum(item.get("instances", {}).get("count", 1) for item in (req.get("scene") or {}).get("objects", [])),
        "cameraPath": req.get("cameraPath"),
    }
    with open(os.path.join(out_dir, "shot.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
    return {"files": files, "manifest": manifest, "anchorsFile": anchors_file, "render": summary, "seconds": round(time.time() - started, 2)}


OPS = {"inspect": op_inspect, "render": op_render, "export": op_export, "dataset": op_dataset, "splat_preview": op_splat_preview, "shot": op_shot}


def main():
    req = request_from_argv()
    op = req.get("op")
    result_file = req.get("resultFile")
    if op not in OPS:
        emit({"ok": False, "error": f"unknown op {op}"}, result_file)
        sys.exit(2)
    try:
        result = OPS[op](req)
        emit({"ok": True, "op": op, **result}, result_file)
    except Exception as error:  # noqa: BLE001 - reported to the harness as data
        emit({"ok": False, "op": op, "error": f"{type(error).__name__}: {error}"}, result_file)
        sys.exit(1)


main()
