/** Headless Blender and Brush (Gaussian splatting) tools. Staged automatically
 * for 3D and splat intents and discoverable through tool_search; the
 * blender-production and gaussian-splatting skills own the workflows and the
 * review discipline. */
import { Type } from "typebox";
import { EXPORT_FORMATS as BLENDER_FORMATS, IMAGE_FORMATS, RENDER_ENGINES, blenderExport, blenderInspect, blenderRender, blenderRun, blenderSetup } from "./lib/blender-studio.ts";
import { splatPreview, splatSetup, splatTrain } from "./lib/splat-studio.ts";
import { choices } from "./lib/tool-schema.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const vec3 = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });

export default function blenderStudio(pi: any) {
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal, progress?: (text: string) => void) => Promise<any>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, update: ((partial: any) => void) | undefined, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const progress = (text: string) => { try { update?.({ content: [{ type: "text", text }], details: { progress: text } }); } catch { /* progress is advisory */ } };
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded, progress);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  const renderOverrides = {
    engine: Type.Optional(choices([...RENDER_ENGINES], "EEVEE (fast, headless software GL), CYCLES (path tracing on CPU), WORKBENCH (flat preview)")),
    width: Type.Optional(Type.Integer({ minimum: 16, maximum: 7680 })), height: Type.Optional(Type.Integer({ minimum: 16, maximum: 4320 })),
    scale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 2, description: "resolution percentage as a fraction; previews default to 0.25" })),
    samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Cycles or EEVEE render samples" })),
    transparent: Type.Optional(Type.Boolean({ description: "film transparent (RGBA)" })),
  };
  register("blender_setup",
    "Headless Blender for 3D work. status reports the binary (harness-local pinned 5.2.2 LTS, YUNUSPI_BLENDER or PATH), version, engines (EEVEE headless, Cycles CPU, Workbench), CPU threads and the memory budget every render is watched against. install downloads the pinned portable Linux build once (sha256-verified, ≈350 MB) into the harness tool directory; no system packages, no GPU assumed. The blender-production skill offers optional scene-building guidance.",
    Type.Object({ action: Type.Optional(choices(["status", "install"])) }),
    blenderSetup, 1_800_000);
  register("blender_run",
    "Run Python (bpy) headless in Blender: code (inline) or script (a .py path), optionally opening blend first, with args passed after `--` (sys.argv). The script builds or edits scenes with the data API, saves .blend files, bakes, exports or renders anything blender_render does not cover. Print `YUNUSPI_RESULT {json}` to return structured data; the tool also returns the stdout tail and the workspace files the script wrote. Runs with --factory-startup (set factoryStartup:false for user add-ons), niced, memory-watched, harness read-only, timeoutSec default 900 (max 3500). Blender exits non-zero on Python exceptions; the traceback is in the error.",
    Type.Object({ code: Type.Optional(Type.String({ maxLength: 200_000 })), script: Type.Optional(localPath), blend: Type.Optional(localPath), args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 })), factoryStartup: Type.Optional(Type.Boolean()), timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 3500 })) }),
    blenderRun, 3_600_000);
  register("blender_inspect",
    "Inspect a .blend without rendering: Blender version, scenes, units, render settings (engine, resolution, samples, frame range, fps, active camera), collections, every object with type, transform, dimensions, mesh counts, materials, modifiers, camera lens/clip, light energy, layered action channels, interpolation, driver/NLA counts and optional evaluated world transforms, plus missing linked files and warnings (no camera, no lights). Read this before changing or rendering a scene; it is the ground truth the blender-production skill asks for.",
    Type.Object({ blend: localPath, scene: Type.Optional(Type.String({ maxLength: 120 })), frames: Type.Optional(Type.Array(Type.Integer({ minimum: -100000, maximum: 1000000 }), { minItems: 1, maxItems: 12, description: "Evaluate transforms at specific source frames without rendering; also reports layered-action channels, drivers and NLA" })) }),
    blenderInspect, 400_000);
  register("blender_render",
    "Render a .blend headless with bounded overrides. still: one frame or up to 24 listed frames at full settings. preview: quarter resolution and 16 samples to judge framing and motion cheaply. animation: from/to (optional step) as a PNG sequence assembled into animation.mp4 (holds source-frame gaps at scene fps/fps_base; explicit fps retimes samples uniformly) plus a labelled contact sheet of up to 12 frames. Overrides (engine, width/height, scale, samples, denoise, transparent, format, camera, scene) apply to this render only; the .blend is never modified. Output lands in a fresh folder under outputDir (default .pi/blender). Open the frames with read: a finished render is not visual approval.",
    Type.Object({ blend: localPath, mode: Type.Optional(choices(["still", "preview", "animation"])), frame: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), frames: Type.Optional(Type.Array(Type.Integer({ minimum: -100000, maximum: 1000000 }), { minItems: 1, maxItems: 24 })), from: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), to: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), step: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      ...renderOverrides, denoise: Type.Optional(Type.Boolean()), format: Type.Optional(choices([...IMAGE_FORMATS])), camera: Type.Optional(Type.String({ maxLength: 120 })), scene: Type.Optional(Type.String({ maxLength: 120 })), threads: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), outputDir: Type.Optional(localPath) }),
    blenderRender, 3_600_000);
  register("blender_export",
    "Export from a .blend. Geometry: glb/gltf (for video_project feature 3d, web, asset_register), obj/ply, stl, usd/usda/usdc/usdz, fbx, abc, or a compressed blend copy; objects limits the export to named objects, applyModifiers defaults true. dataset: render a multi-view training set (nerfstudio transforms.json + images/ + init.ply seed points sampled from the meshes) by orbiting the renderable meshes on elevation rings — views (default 60), radius/center (auto from bounds), elevations [15,35,55], lensMm, width/height (800), engine (EEVEE), samples (32), transparent (true); this is the input splat_train needs for a splat of a Blender scene.",
    Type.Object({ blend: localPath, format: choices([...BLENDER_FORMATS]), path: Type.Optional(localPath), objects: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { minItems: 1, maxItems: 500 })), applyModifiers: Type.Optional(Type.Boolean()), animation: Type.Optional(Type.Boolean()),
      outputDir: Type.Optional(localPath), views: Type.Optional(Type.Integer({ minimum: 4, maximum: 600 })), radius: Type.Optional(Type.Number({ minimum: 0.01, maximum: 100000 })), center: Type.Optional(vec3), elevations: Type.Optional(Type.Array(Type.Number({ minimum: -89, maximum: 89 }), { minItems: 1, maxItems: 8 })), lensMm: Type.Optional(Type.Number({ minimum: 5, maximum: 400 })), seed: Type.Optional(Type.Number()), ...renderOverrides }),
    blenderExport, 3_600_000);

  register("splat_setup",
    "Gaussian splatting with Brush (Apache-2.0, Rust + wgpu): trains on any Vulkan GPU, including AMD and Intel integrated graphics, no CUDA. status reports the binary (harness-local pinned release, YUNUSPI_BRUSH or PATH), version, the Vulkan drivers found (lspci GPU, ICDs) and accepted dataset formats. install downloads the pinned 44 MB linux-x64 release once (sha256-verified).",
    Type.Object({ action: Type.Optional(choices(["status", "install"])) }),
    splatSetup, 900_000);
  register("splat_train",
    "Train Gaussian splats headless from a dataset: COLMAP (sparse/0 + images/) or nerfstudio/Blender transforms.json (blender_export format dataset, which also writes init.ply seed points). action check validates the dataset (views, intrinsics, image sizes, seed points) and prints the exact brush_app command. train runs steps (default 5000; 2000 previews in about a minute on an integrated GPU, 10000–30000 for delivery), evalSplitEvery N holds every Nth view out and writes its render at evalEvery steps, maxSplats caps memory and file size, shDegree (3), maxResolution (1920), maxFrames/subsampleFrames/subsamplePoints to go faster, seed, startIter, extraArgs for learning-rate flags. Output: .pi/splats/<run>/splat_<steps>.ply plus eval_<step>/ renders and fidelity-sheet.png (truth beside splat). Open the sheet before judging.",
    Type.Object({ dataset: localPath, action: Type.Optional(choices(["check", "train"])), output: Type.Optional(localPath), steps: Type.Optional(Type.Integer({ minimum: 50, maximum: 200000 })), exportEvery: Type.Optional(Type.Integer({ minimum: 50 })), exportName: Type.Optional(Type.String({ maxLength: 120 })), evalSplitEvery: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })), evalEvery: Type.Optional(Type.Integer({ minimum: 50 })), evalImages: Type.Optional(Type.Boolean()), maxSplats: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000000 })), shDegree: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })), maxResolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192 })), maxFrames: Type.Optional(Type.Integer({ minimum: 1 })), subsampleFrames: Type.Optional(Type.Integer({ minimum: 1 })), subsamplePoints: Type.Optional(Type.Integer({ minimum: 1 })), seed: Type.Optional(Type.Integer({ minimum: 0 })), startIter: Type.Optional(Type.Integer({ minimum: 0 })), invertMasks: Type.Optional(Type.Boolean()), extraArgs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 32, description: "further brush_app flags, e.g. --lr-mean 1e-5" })), logLevel: Type.Optional(choices(["info", "debug", "warn"])), timeoutSec: Type.Optional(Type.Integer({ minimum: 60, maximum: 7200 })) }),
    splatTrain, 7_200_000);
  register("splat_preview",
    "Turntable MP4 plus labelled contact sheet of a Gaussian-splat PLY, rendered by the Blender worker as a coloured point cloud (opaque points sized by splat scale; shape, coverage, floaters and colour are judged, not view-dependent shading). frames (48), fps (24), width/height (640x480), engine (EEVEE; CYCLES for round points), samples, radius/elevationDeg (auto from the splat bounds), up ([0,0,1] for Blender-captured datasets, [0,-1,0] for COLMAP), minOpacity (0.15), maxPoints (400000), pointScale, background. Also accepts any splat PLY (f_dc colours) or an x/y/z/rgb point cloud.",
    Type.Object({ path: localPath, outputDir: Type.Optional(localPath), frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), radius: Type.Optional(Type.Number({ minimum: 0.01, maximum: 100000 })), elevationDeg: Type.Optional(Type.Number({ minimum: -89, maximum: 89 })), lensMm: Type.Optional(Type.Number({ minimum: 5, maximum: 400 })), up: Type.Optional(vec3), minOpacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), maxPoints: Type.Optional(Type.Integer({ minimum: 100, maximum: 5000000 })), pointScale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 20 })), background: Type.Optional(vec3), ...renderOverrides }),
    splatPreview, 1_900_000);
}
