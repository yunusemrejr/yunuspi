---
name: gaussian-splatting
description: "Train, render and convert 3D Gaussian splats headless with LichtFeld Studio through the lichtfeld_* tools, from COLMAP photo datasets or Blender-captured transforms.json datasets, with GPU preflight, bounded iterations, evaluation and turntable review."
---

# Gaussian splatting

Stage `tool_search({ names: ["lichtfeld_setup", "lichtfeld_train", "lichtfeld_render", "lichtfeld_convert", "blender_export", "video_frames"] })`. Start with `lichtfeld_setup` (status): training needs an NVIDIA GPU (compute ≥ 7.5, driver ≥ 570, CUDA 12.8+). When the preflight reports a blocker, do not retry or work around it: say so, prepare the dataset and the exact command (`lichtfeld_train action:"check"`), and deliver what runs on this machine (Blender renders, datasets, mesh exports) for training on a CUDA host. On capable hardware without a binary, `lichtfeld_setup action:"install"` builds from source (long; it lists missing apt packages instead of guessing).

Datasets. Photos: run COLMAP to `sparse/0` + `images/` (undistort or pass `undistort:true`; `gut:true` for strongly distorted lenses). Synthetic: `blender_export format:"dataset"` orbits the renderable meshes on elevation rings and writes NeRF/Blender `transforms.json` with camera matrices in Blender's world frame; 60–150 views, consistent lighting, transparent film. `lichtfeld_train action:"check"` validates layout, view count and intrinsics before any GPU time.

Training. Bound it: `iterations` 7000 for a first look, 30000 for delivery; `strategy:"mcmc"` with `maxGaussians` when VRAM or file size matters; `testEvery` + `eval:true` for PSNR/SSIM/LPIPS on held-out views; `export` ply (editable), spz/sog (compact), html (standalone viewer). Resume with `resume` on the `.resume`/`.licht` written to the run folder.

Review before delivery. `lichtfeld_render` produces a closing turntable MP4 (pass `up:[0,0,1]` for Blender-captured datasets, radius around the scene bounds); sample it with `video_frames` and judge floaters, holes, background bleed, popping and sharpness against the source views. Fix by adding views, raising iterations, enabling `bilateralGrid` for exposure drift or `mip` for aliasing, not by raising bitrate. `lichtfeld_convert` converts formats or turns a Blender mesh (`blender_export format:"obj"`) into splats with `mesh2splat` for composing authored objects with captured scenes. Deliver the exported splat, the project folder path, metrics when evaluated, and the review verdict.
