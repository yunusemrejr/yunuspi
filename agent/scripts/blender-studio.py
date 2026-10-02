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


OPS = {"inspect": op_inspect, "render": op_render, "export": op_export, "dataset": op_dataset, "splat_preview": op_splat_preview}


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
