---
name: 3d-cad
description: "3D production and CAD: Blender scenes, renders and motion through the blender tool (run, render, inspect, setup), parametric CAD in FreeCAD, OpenSCAD or AutoCAD with STEP, STL, DXF and DWG exchange, and Gaussian splat capture, training and review."
---

## Blender
- Never run the blender binary from bash; use the `blender` tool (actions run, render, inspect, setup). `setup` reports the pinned build; `setup` with `install:true` installs it once.
- Inspect before changing: units, color management, world and lights, material defaults, texture color spaces and packing, modifiers, animation. Keep the editable .blend and its external dependencies.
- Build with bpy.data in `run`; use bpy.ops only in a known mode with the right selection. Name tool-owned objects deterministically so reruns replace instead of duplicate; never delete unrelated objects.
- Print `YUNUSPI_RESULT {json}` for structured results and save with bpy.ops.wm.save_as_mainfile.
- Preview cheaply, then judge pixels: `render` action in preview mode (low resolution, few samples) for framing; stills for hero frames; frame ranges of a few hundred frames per call for sequences, checking for constant dimensions and no missing frame numbers. Open frames with `read` and check silhouettes, clipping, intersections, lighting and temporal continuity. More samples never fix bad lights or broken geometry.
- Long videos: approve a hero frame and a 2-4 s preview first. Verify loop endpoints and real playback before extending a loop or composing audio.
- Headless engines: EEVEE (software GL), Cycles (CPU), Workbench; no GPU is assumed. Size samples to the deadline and render long jobs in frame ranges.
- `video_shot` turns a Blender camera move into a transparent frame sequence; run its plan action before rendering.
- Do not run auto-run scripts from untrusted .blend files; pack or collect external assets and re-inspect for missing ones.
- Deliver the editable scene, assets, engine and version, and unverified assumptions.

## Gaussian splats
- Photo captures need COLMAP poses (sparse model plus images). Synthetic captures need 60-150 orbit views with consistent lighting, transparent background and the subject filling much of the frame, in transforms.json layout.
- Supply seed points (COLMAP points or samples from the mesh). Without them training starts random and small subjects get pruned; add seeds rather than raising steps.
- Steps: about 2000 for a first look, 10000-30000 for delivery. Hold out every 8th view and compare held-out renders with ground truth for sharpness, missing parts, floaters, color and background bleed.
- Fix gaps by adding views or seeds, not bitrate. Review a turntable with the capture's up axis (z-up for Blender, -y for COLMAP). Deliver the .ply, run folder, step count and verdict.

## CAD
- Fix units, coordinate system, dimensions, tolerances and intended use first. Keep the native source (FCStd, DWG, OpenSCAD script). Solids, exchange geometry, 2D drawings and display meshes carry different information.
- Model intent with named parameters and relations; prefer datum references to face indices; avoid redundant constraints. Check degrees vs radians and point vs normal transforms.
- After booleans, check null or invalid results. Do not raise tolerances until an operation passes. Validity, closure, solid count and bounding box are separate checks; for a simple solid compare volume to L*W*H.
- OpenSCAD: expose parameters and assertions, render true geometry before export, and choose $fn from feature size: sagitta error = r*(1-cos(theta/2)), theta = 360/$fn.
- STEP keeps B-rep solids, not feature history. STL has no units; set scale explicitly. Never rename extensions to convert. DWG needs a supported app or converter; compare layers, blocks, dimensions, xrefs, fonts, linetypes and paper vs model space.
- Reimport exports into a fresh document and compare bounding box, body count and features. Fabrication paths need closed contours without duplicate edges; printing needs a watertight manifold mesh, wall-thickness checks and a slicer preview.
- Render orthographic or isometric views to check, but a plausible screenshot is not proof of manufacturability.
- Generating CAD does not authorize fabrication or machine operation.
