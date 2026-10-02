---
name: blender-production
description: "Build and verify Blender 3D scenes, procedural designs, rigged or physics animations and headless renders with bpy through the blender_* tools: reproducible scenes, bounded renders, exports and multi-view datasets."
---

# Blender production

The harness drives Blender headless and stages the tools for 3D intents; otherwise `tool_search({ names: ["blender_setup", "blender_inspect", "blender_run", "blender_render", "blender_export"] })`. `blender_setup` installs the pinned local build once if nothing is installed. Never call the `blender` binary from bash: the tools run it guarded, niced, memory-watched and with a deadline, and they parse Blender's output for you.

Workflow:

1. **Inspect before changing.** `blender_inspect` on an existing `.blend` returns units, render settings, cameras, lights, objects, modifiers, animation ranges and missing linked files. Preserve the editable blend file and external dependencies.
2. **Build with the data API.** `blender_run` with inline `code` (or a `.py` `script`) creates or edits scenes: `bpy.data.*` for objects, meshes, materials, cameras, lights and keyframes; `bpy.ops` only in a known mode with the right selection. Name tool-owned objects and collections deterministically so reruns replace instead of duplicate; do not remove unrelated user objects. Save with `bpy.ops.wm.save_as_mainfile(filepath=...)` and print `YUNUSPI_RESULT {json}` for structured return values. Choose geometry, materials, camera and motion to serve the shot; use physical units and one coordinate convention.
3. **Preview cheaply, then judge pixels.** `blender_render mode:"preview"` (quarter resolution, few samples) for framing and motion, `mode:"still"` for representative frames, `mode:"animation" from/to` for sequences (PNG frames, `animation.mp4`, labelled contact sheet). Open the frames with `read` and check silhouettes, clipping, shading, intersections, lighting and temporal continuity. More samples never fix bad lights or broken geometry.
4. **Deliver verified artifacts.** `blender_export` writes glb/gltf (web, `video_project feature:"3d"`), obj/ply/stl, usd, fbx, abc or a packed blend copy; `format:"dataset"` renders a multi-view `transforms.json` set with `init.ply` seed points for Gaussian-splat training with `splat_train` (see the gaussian-splatting skill). Deliver the editable scene and required assets with the render, stating engine, version and any unverified assumptions.

Read [scene and motion](references/scene-motion.md) for procedural modeling, rigging and physics checks. Read [render pipeline](references/render-pipeline.md) for engine choice, budgets, image sequences and verification. Query the installed bpy API (`blender_run` with introspection code) instead of assuming web examples match the local version. Engines available headless: EEVEE (software GL), Cycles on CPU, Workbench; no GPU is assumed, so keep resolution and samples proportional to the deadline and render long jobs frame-range by frame-range.
