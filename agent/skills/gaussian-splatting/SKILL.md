---
name: gaussian-splatting
description: "Train, review and preview 3D Gaussian splats headless with Brush through the splat_* tools, from COLMAP photo datasets or Blender-captured transforms.json datasets, on any Vulkan GPU (integrated AMD/Intel included), with dataset checks, bounded steps, held-out fidelity sheets and turntable review."
---

# Gaussian splatting

The tools are staged automatically for splat intents; otherwise `tool_search({ names: ["splat_setup", "splat_train", "splat_preview", "blender_export", "video_frames"] })`. `splat_setup` installs the pinned Brush release once and reports the Vulkan driver; there is no CUDA requirement. Never run `brush_app` from bash: the tool runs it guarded, without a window, with GPU access and a deadline.

Datasets. Photos: run COLMAP to `sparse/0` + `images/`. Synthetic: `blender_export format:"dataset"` orbits the renderable meshes on elevation rings and writes nerfstudio `transforms.json`, `images/` and `init.ply` seed points; 60–150 views, consistent lighting, transparent film, subject filling a good part of the frame. `splat_train action:"check"` validates layout, view count, intrinsics, seed points and image sizes before any training time. A dataset without seed points trains from random positions and a small subject can be pruned away: add `init.ply` (COLMAP points, or sample the mesh) rather than raising steps.

Training. Bound it: `steps` 2000 for a first look (about a minute on an integrated GPU), 10000–30000 for delivery; always set `evalSplitEvery` (8) so held-out views are rendered and tiled beside their ground truth in `fidelity-sheet.png`; `maxSplats` when memory or file size matters; `maxResolution`/`subsampleFrames` to go faster. Resume with `startIter` and `extraArgs` for learning-rate flags.

Review before delivery. Open the fidelity sheet with `read` and judge sharpness, missing parts, floaters, colour and background bleed against the truth columns; then `splat_preview` for a turntable (`up:[0,0,1]` for Blender captures, `[0,-1,0]` for COLMAP) and sample it with `video_frames`. Fix by adding views, seed points or steps, not by raising bitrate. Deliver the PLY, the run folder, the step count and the review verdict.
