# 3D studio: headless Blender and Gaussian splatting

Agents build, render and export 3D work with Blender and train, review and preview 3D Gaussian splats with Brush, entirely headless and on ordinary hardware (integrated AMD/Intel graphics included). Both engines are driven by tools that run the binaries guarded (harness read-only, GPU render nodes bound in), niced, memory-watched and under a deadline, and that parse the engine output into structured results. The harness stages the tools automatically when a prompt or file reads as 3D or splat work (skill routes `blender-production` and `gaussian-splatting`); `tool_search` finds them otherwise.

## Blender

| Tool | What it does |
| --- | --- |
| `blender_setup` | `status` reports the binary (harness-local pinned 5.2.2 LTS under `~/.pi/agent/local-tools/blender`, `YUNUSPI_BLENDER`, or PATH), version, engines and the memory budget; `install` downloads the pinned portable Linux build once (sha256-verified, no system packages) |
| `blender_inspect` | Ground truth for a `.blend`: units, render settings, cameras, lights, objects with transforms, mesh counts, materials, modifiers, animation ranges, missing linked files, warnings |
| `blender_run` | Runs agent-authored bpy Python (`code` or `script`, optional `blend`, `args` after `--`) with `--factory-startup --python-exit-code 1`; `YUNUSPI_RESULT {json}` lines come back as data, with the stdout tail and the workspace files the script wrote |
| `blender_render` | `still` (up to 24 frames), `preview` (quarter resolution, 16 samples) or `animation` (`from`/`to`/`step` → PNG sequence, `animation.mp4`, labelled contact sheet); per-call overrides for engine, size, scale, samples, denoise, transparency, format, camera and scene never touch the file |
| `blender_export` | glb/gltf, obj, ply, stl, usd*, fbx, abc, packed blend copy (optionally only named objects); `dataset` orbits the renderable meshes and writes a nerfstudio `transforms.json` + `images/` + `init.ply` seed points (sampled from the meshes) for splat training |

Engines available headless on a plain Linux box: EEVEE (GL through the bound DRI device, software fallback), Cycles on the CPU, Workbench. Keep resolution, samples and frame ranges proportional to the deadline, and render long sequences range by range (the PNG sequence is resumable).

```text
blender_run({ code: "import bpy ... bpy.ops.wm.save_as_mainfile(filepath='scene.blend')" })
blender_inspect({ blend: "scene.blend" })
blender_render({ blend: "scene.blend", mode: "preview" })               // look at the frame with read
blender_render({ blend: "scene.blend", mode: "animation", from: 1, to: 120 })
blender_export({ blend: "scene.blend", format: "glb", objects: ["Hero"] })
blender_export({ blend: "scene.blend", format: "dataset", views: 90 })  // → splat_train
```

## Gaussian splatting (Brush)

[Brush](https://github.com/ArthurBrussee/brush) is an Apache-2.0 Gaussian-splatting engine in Rust on wgpu: it needs only a Vulkan driver (Mesa RADV/ANV or a vendor driver), not CUDA, so it trains on the same laptop that runs Blender. The harness keeps a pinned 44 MB release under `~/.pi/agent/local-tools/brush` (`YUNUSPI_BRUSH` or PATH override). Measured on a Ryzen 5 7530U with integrated Radeon graphics: 1500 steps on 48 views at 256 px in about 20 s; a 10 000-step delivery run on larger views is minutes, not hours.

| Tool | What it does |
| --- | --- |
| `splat_setup` | Vulkan preflight (ICDs, GPU), binary/version, dataset formats; `install` downloads the pinned release |
| `splat_train` | `check` validates a COLMAP (`sparse/0` + `images/`) or `transforms.json` dataset (views, intrinsics, seed points, image sizes) and prints the command; `train` runs headless with bounded `steps`, `evalSplitEvery` held-out views rendered at `evalEvery`, `maxSplats`, `shDegree`, resolution and frame caps, returning the PLY, the eval renders and `fidelity-sheet.png` (truth beside splat) |
| `splat_preview` | Turntable MP4 and contact sheet of any splat PLY, rendered by the Blender worker as a coloured point cloud sized by splat scale (`up:[0,0,1]` for Blender captures, `[0,-1,0]` for COLMAP) |

Two trainer facts the tools handle for you: Brush starts from the dataset's point cloud and, without one, random points rarely land on a small subject (the capture writes `init.ply`, and `check` warns when a dataset lacks one); and its image loader probes a fixed 16 KB header, so tiny renders are padded with a PNG text chunk and undersized photos are flagged.

```text
splat_train({ dataset: ".pi/blender/dataset-…", action: "check" })
splat_train({ dataset: ".pi/blender/dataset-…", steps: 10000, evalSplitEvery: 8, maxSplats: 500000 })
splat_preview({ path: ".pi/splats/run/splat_10000.ply", up: [0, 0, 1] })   // review with read / video_frames
```

## Blender in a video

`video_shot` renders a camera move around a `.blend`, an imported model or extruded 3D title text into a video project as a transparent RGBA image sequence, lit in the project's palette, with named anchors projected to screen space per frame so 2D annotations follow 3D features. The editable scene (with the rig) is saved in the project's `blender/` folder. See [the video studio](VIDEO-STUDIO.md#looks-blender-shots-and-motion-examples). `motion_examples` provides Blender starting points (product hero with anchors, procedural materials, camera rigs, geometry-node terrain, an HTML sequence as a device screen) and the merges with HTML and FFmpeg.

## Boundaries

- Blender and Brush processes run through the shared guarded runner (`agent/extensions/lib/guarded-process.ts`): harness directories are read-only, `/dev/dri` is bound for these GPU engines only (other guarded commands keep the minimal `/dev`), the process group is killed on abort or when it exceeds the memory budget, and output tails are bounded.
- Renders, datasets, splats and exports write under the workspace (`.pi/blender`, `.pi/splats` by default) and never modify the source `.blend`.
- A successful render or training run is not approval: open the frames, the fidelity sheet or the turntable and judge them, as the skills require.

Native video shots now support alpha image cards, shared arrays, per-key easing, staggered animation and editable camera/target/lens paths. `video_shot action:"plan"` validates render work and source inputs before creating output. See [advanced motion contracts](VIDEO-STUDIO.md#image-cards-arrays-and-camera-flythroughs) for examples and bounds.
