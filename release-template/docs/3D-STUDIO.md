# 3D studio: headless Blender and LichtFeld Studio

Agents build, render and export 3D work with Blender and train, render and convert 3D Gaussian splats with LichtFeld Studio, entirely headless. Both engines are driven by tools that run the binaries guarded (harness read-only), niced, memory-watched and under a deadline, and that parse the engine output into structured results. The tools stay off the wire until `tool_search` stages them; the `blender-production` and `gaussian-splatting` skills route the work and own the review discipline.

## Blender

| Tool | What it does |
| --- | --- |
| `blender_setup` | `status` reports the binary (harness-local pinned 5.2.2 LTS under `~/.pi/agent/local-tools/blender`, `YUNUSPI_BLENDER`, or PATH), version, engines and the memory budget; `install` downloads the pinned portable Linux build once (sha256-verified, no system packages) |
| `blender_inspect` | Ground truth for a `.blend`: units, render settings, cameras, lights, objects with transforms, mesh counts, materials, modifiers, animation ranges, missing linked files, warnings |
| `blender_run` | Runs agent-authored bpy Python (`code` or `script`, optional `blend`, `args` after `--`) with `--factory-startup --python-exit-code 1`; `YUNUSPI_RESULT {json}` lines come back as data, with the stdout tail and the workspace files the script wrote |
| `blender_render` | `still` (up to 24 frames), `preview` (quarter resolution, 16 samples) or `animation` (`from`/`to`/`step` → PNG sequence, `animation.mp4`, labelled contact sheet); per-call overrides for engine, size, scale, samples, denoise, transparency, format, camera and scene never touch the file |
| `blender_export` | glb/gltf, obj, ply, stl, usd*, fbx, abc, packed blend copy (optionally only named objects); `dataset` orbits the renderable meshes and writes a NeRF/Blender `transforms.json` + `images/` set for splat training |

Engines available headless on a plain Linux box: EEVEE (software GL), Cycles on the CPU, Workbench. No GPU is assumed; keep resolution, samples and frame ranges proportional to the deadline, and render long sequences range by range (the PNG sequence is resumable).

```text
tool_search({ names: ["blender_setup", "blender_inspect", "blender_run", "blender_render", "blender_export"] })
blender_run({ code: "import bpy ... bpy.ops.wm.save_as_mainfile(filepath='scene.blend')" })
blender_inspect({ blend: "scene.blend" })
blender_render({ blend: "scene.blend", mode: "preview" })               // look at the frame with read
blender_render({ blend: "scene.blend", mode: "animation", from: 1, to: 120 })
blender_export({ blend: "scene.blend", format: "glb", objects: ["Hero"] })
blender_export({ blend: "scene.blend", format: "dataset", views: 90 })  // → lichtfeld_train
```

## LichtFeld Studio

LichtFeld Studio (GPLv3) is a CUDA application: training needs an NVIDIA GPU with compute capability ≥ 7.5, driver ≥ 570 and CUDA 12.8+. `lichtfeld_setup` runs that preflight first and, on AMD/Intel/no-GPU machines, every `lichtfeld_*` tool returns the blocker as plain data so an agent prepares the dataset and the exact command instead of looping; the Blender side still works. On capable hardware `lichtfeld_setup action:"install"` builds from source into `~/.pi/agent/local-tools/lichtfeld` (vcpkg, portable layout, `-DLFS_ENFORCE_LINUX_GUI_BACKENDS=OFF`); it lists the missing toolchain and apt packages rather than installing system packages itself. A binary built elsewhere is picked up through `YUNUSPI_LICHTFELD` or PATH.

| Tool | What it does |
| --- | --- |
| `lichtfeld_setup` | GPU preflight, binary/version, toolchain, dataset formats; `install` builds from source |
| `lichtfeld_train` | `check` validates a COLMAP (`sparse/0` + `images/`) or `transforms.json` dataset and prints the command without a GPU; `train` runs `--headless -d DATA -o OUT --export …` with bounded iterations, `mcmc`/`maxGaussians`, evaluation (PSNR/SSIM/LPIPS), bilateral grid, mip, 3DGUT, undistortion, init/resume and timelapse options, returning the exported splats, project file and parsed metrics |
| `lichtfeld_render` | Renders a trained splat along a camera path to MP4; generates a closing turntable (`center`, `radius`, `elevationDeg`, `seconds`, `up`) or takes explicit keyframes; `action:"path"` writes the timeline JSON only |
| `lichtfeld_convert` | `convert` between ply/sog/ssog/spz/usd/html, `mesh2splat` from a Blender-exported mesh |

Camera-path positions are in LichtFeld's viewer world; for Blender-captured datasets that is Blender's own world frame (Z up, pass `up:[0,0,1]`), for COLMAP captures Y is up.

```text
lichtfeld_setup({})                                                      // preflight first
lichtfeld_train({ dataset: ".pi/blender/dataset-…", action: "check" })
lichtfeld_train({ dataset: ".pi/blender/dataset-…", iterations: 30000, strategy: "mcmc", eval: true, export: ["ply", "html"] })
lichtfeld_render({ model: ".pi/lichtfeld/run/splat.ply", up: [0, 0, 1], radius: 4 })   // review with video_frames
lichtfeld_convert({ input: ".pi/blender/hero.obj", action: "mesh2splat" })
```

## Boundaries

- Blender and LichtFeld processes run through the shared guarded runner (`agent/extensions/lib/guarded-process.ts`): harness directories are read-only, the process group is killed on abort or when it exceeds the memory budget, and output tails are bounded.
- Renders, datasets and exports write under the workspace (`.pi/blender`, `.pi/lichtfeld` by default) and never modify the source `.blend`.
- A successful render or training run is not approval: open the frames, the contact sheet or the turntable and judge them, as the skills require.
