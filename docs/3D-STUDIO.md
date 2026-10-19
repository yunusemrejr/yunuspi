# 3D studio: headless Blender

Agents build, render and inspect 3D work with Blender, entirely headless and on ordinary hardware (integrated AMD/Intel graphics included). The `blender` tool runs the binary guarded (harness read-only, GPU render nodes bound in), niced, memory-watched and under a deadline, and parses the engine output into structured results. The harness stages the tool automatically when a prompt or file reads as 3D work (skill route `3d-cad`); `tool_search` finds it otherwise. `/3d <assignment>` (see [GOAL.md](GOAL.md#3d-video-anatomy-and-chaining)) turns a whole 3D job — Blender, three.js/WebGL or hybrid — into a goal judged on grounding, real assets, multi-angle rendered craft, performance and a clean end-to-end run; it chains with `/video` and `/noslop`.

## The `blender` tool

One tool with four actions:

| Action | What it does |
| --- | --- |
| `setup` | `status` reports the binary (harness-local pinned 5.2.2 LTS under `~/.pi/agent/local-tools/blender`, `YUNUSPI_BLENDER`, or PATH), version, engines and the memory budget; `install` downloads the pinned portable Linux build once (sha256-verified, no system packages) |
| `inspect` | Ground truth for a `.blend`: units, render settings, cameras, lights, objects with transforms, mesh counts, materials, modifiers, animation ranges, missing linked files, warnings |
| `run` | Runs agent-authored bpy Python (`code` or `script`, optional `blend`, `args` after `--`) with `--factory-startup --python-exit-code 1`; `YUNUSPI_RESULT {json}` lines come back as data, with the stdout tail and the workspace files the script wrote |
| `render` | `still` (up to 24 frames), `preview` (quarter resolution, 16 samples) or `animation` (`from`/`to`/`step` → PNG sequence, `animation.mp4`, labelled contact sheet); per-call overrides for engine, size, scale, samples, denoise, transparency, format, camera and scene never touch the file |

Engines available headless on a plain Linux box: EEVEE (GL through the bound DRI device, software fallback), Cycles on the CPU, Workbench. Keep resolution, samples and frame ranges proportional to the deadline, and render long sequences range by range (the PNG sequence is resumable). Export formats other than render outputs are written from a `run` script with Blender's own exporters.

```text
blender({ action: "run", code: "import bpy ... bpy.ops.wm.save_as_mainfile(filepath='scene.blend')" })
blender({ action: "inspect", blend: "scene.blend" })
blender({ action: "render", blend: "scene.blend", mode: "preview" })               // look at the frame with read
blender({ action: "render", blend: "scene.blend", mode: "animation", from: 1, to: 120 })
```

## Blender in a film

Blender models and renders with the `blender` tool; the film does the rest. Two outputs go into a film:

- **Footage.** `blender` with `action:"render"` and `mode:"animation"` writes a PNG sequence, `animation.mp4` and a labelled contact sheet. Place the footage in the film's `public/` folder and use it on the timeline.
- **GLB for three.js.** A `run` script exports the scene as GLB with Blender's own exporters. Inside the film, mount a `<ThreeCanvas>` scene in an act and drive its transforms from `useCurrentFrame()`. `video_project init` installs three.js, `@remotion/three` and `@react-three/fiber`. Inspect the file with `asset_register` `inspect` first; see [motion and model preflight](MEDIA-PREFLIGHT.md).

Use Blender for photoreal or heavy scenes. Designed 3D subjects, type and motion graphics can live in the film's three.js scene instead. The [video studio](VIDEO-STUDIO.md) covers the film workflow.

## Boundaries

- Blender processes run through the shared guarded runner (`agent/extensions/lib/guarded-process.ts`): harness directories are read-only, `/dev/dri` is bound for this GPU engine only (other guarded commands keep the minimal `/dev`), the process group is killed on abort or when it exceeds the memory budget, and output tails are bounded.
- Renders and scene output write under the workspace (`.pi/blender` by default) and never modify the source `.blend`.
- A successful render run is not approval: open the frames and judge them, as the skills require.