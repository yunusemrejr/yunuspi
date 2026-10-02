/** Headless Blender and LichtFeld Studio tools. Discovered on demand through
 * tool_search; the blender-production and gaussian-splatting skills own the
 * workflows and the review discipline. */
import { Type } from "typebox";
import { EXPORT_FORMATS as BLENDER_FORMATS, IMAGE_FORMATS, RENDER_ENGINES, blenderExport, blenderInspect, blenderRender, blenderRun, blenderSetup } from "./lib/blender-studio.ts";
import { EXPORT_FORMATS as SPLAT_FORMATS, STRATEGIES, lichtfeldConvert, lichtfeldRender, lichtfeldSetup, lichtfeldTrain } from "./lib/lichtfeld-studio.ts";
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
    "Headless Blender for 3D work. status reports the binary (harness-local pinned 5.2.2 LTS, YUNUSPI_BLENDER or PATH), version, engines (EEVEE headless, Cycles CPU, Workbench), CPU threads and the memory budget every render is watched against. install downloads the pinned portable Linux build once (sha256-verified, ≈350 MB) into the harness tool directory; no system packages, no GPU assumed. Read the blender-production skill before building scenes.",
    Type.Object({ action: Type.Optional(choices(["status", "install"])) }),
    blenderSetup, 1_800_000);
  register("blender_run",
    "Run Python (bpy) headless in Blender: code (inline) or script (a .py path), optionally opening blend first, with args passed after `--` (sys.argv). The script builds or edits scenes with the data API, saves .blend files, bakes, exports or renders anything blender_render does not cover. Print `YUNUSPI_RESULT {json}` to return structured data; the tool also returns the stdout tail and the workspace files the script wrote. Runs with --factory-startup (set factoryStartup:false for user add-ons), niced, memory-watched, harness read-only, timeoutSec default 900 (max 3500). Blender exits non-zero on Python exceptions; the traceback is in the error.",
    Type.Object({ code: Type.Optional(Type.String({ maxLength: 200_000 })), script: Type.Optional(localPath), blend: Type.Optional(localPath), args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 })), factoryStartup: Type.Optional(Type.Boolean()), timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 3500 })) }),
    blenderRun, 3_600_000);
  register("blender_inspect",
    "Inspect a .blend without rendering: Blender version, scenes, units, render settings (engine, resolution, samples, frame range, fps, active camera), collections, every object with type, transform, dimensions, mesh counts, materials, modifiers, camera lens/clip, light energy and animation range, plus missing linked files and warnings (no camera, no lights). Read this before changing or rendering a scene; it is the ground truth the blender-production skill asks for.",
    Type.Object({ blend: localPath }),
    blenderInspect, 400_000);
  register("blender_render",
    "Render a .blend headless with bounded overrides. still: one frame or up to 24 listed frames at full settings. preview: quarter resolution and 16 samples to judge framing and motion cheaply. animation: from/to (optional step) as a PNG sequence assembled into animation.mp4 (fps from the scene unless given) plus a labelled contact sheet of up to 12 frames. Overrides (engine, width/height, scale, samples, denoise, transparent, format, camera, scene) apply to this render only; the .blend is never modified. Output lands in a fresh folder under outputDir (default .pi/blender). Open the frames with read: a finished render is not visual approval.",
    Type.Object({ blend: localPath, mode: Type.Optional(choices(["still", "preview", "animation"])), frame: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), frames: Type.Optional(Type.Array(Type.Integer({ minimum: -100000, maximum: 1000000 }), { minItems: 1, maxItems: 24 })), from: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), to: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), step: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      ...renderOverrides, denoise: Type.Optional(Type.Boolean()), format: Type.Optional(choices([...IMAGE_FORMATS])), camera: Type.Optional(Type.String({ maxLength: 120 })), scene: Type.Optional(Type.String({ maxLength: 120 })), threads: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), outputDir: Type.Optional(localPath) }),
    blenderRender, 3_600_000);
  register("blender_export",
    "Export from a .blend. Geometry: glb/gltf (for video_project feature 3d, web, asset_register), obj/ply (lichtfeld_convert mesh2splat turns them into Gaussian splats), stl, usd/usda/usdc/usdz, fbx, abc, or a compressed blend copy; objects limits the export to named objects, applyModifiers defaults true. dataset: render a multi-view training set (NeRF/Blender transforms.json + images/) by orbiting the renderable meshes on elevation rings — views (default 60), radius/center (auto from bounds), elevations [15,35,55], lensMm, width/height (800), engine (EEVEE), samples (32), transparent (true); this is the input lichtfeld_train needs for a splat of a Blender scene.",
    Type.Object({ blend: localPath, format: choices([...BLENDER_FORMATS]), path: Type.Optional(localPath), objects: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { minItems: 1, maxItems: 500 })), applyModifiers: Type.Optional(Type.Boolean()), animation: Type.Optional(Type.Boolean()),
      outputDir: Type.Optional(localPath), views: Type.Optional(Type.Integer({ minimum: 4, maximum: 600 })), radius: Type.Optional(Type.Number({ minimum: 0.01, maximum: 100000 })), center: Type.Optional(vec3), elevations: Type.Optional(Type.Array(Type.Number({ minimum: -89, maximum: 89 }), { minItems: 1, maxItems: 8 })), lensMm: Type.Optional(Type.Number({ minimum: 5, maximum: 400 })), seed: Type.Optional(Type.Number()), ...renderOverrides }),
    blenderExport, 3_600_000);

  register("lichtfeld_setup",
    "LichtFeld Studio (3D Gaussian Splatting, CUDA) headless. status reports the binary (harness-local build, YUNUSPI_LICHTFELD or PATH), version, the GPU preflight (NVIDIA compute ≥ 7.5, driver ≥ 570, CUDA 12.8+; AMD/Intel/no-GPU machines get a plain blocker and must train elsewhere), build toolchain and accepted dataset formats. install builds from source (GPLv3 repository, vcpkg, portable layout) into the harness tool directory on capable hardware: a long compile that needs the CUDA toolkit and the listed apt packages; it refuses and lists them otherwise.",
    Type.Object({ action: Type.Optional(choices(["status", "install"])), update: Type.Optional(Type.Boolean({ description: "install: pull the latest source before building" })), ref: Type.Optional(Type.String({ maxLength: 120, description: "install: git branch or tag" })), force: Type.Optional(Type.Boolean({ description: "install: attempt the build even when the GPU preflight failed" })) }),
    lichtfeldSetup, 7_200_000);
  register("lichtfeld_train",
    "Train Gaussian splats headless from a dataset: COLMAP (sparse/0 + images/) or Blender/NeRF transforms.json (blender_export format dataset). action check validates the dataset and prints the exact command without the GPU. train runs `--headless -d DATA -o OUT --export …` with iterations (default 30000), strategy (default or mcmc with maxGaussians), shDegree, maxWidth, testEvery/eval/evalSteps for PSNR/SSIM/LPIPS, bilateralGrid, mip, gut (distorted cameras), undistort, init (start from a splat), resume (.resume/.licht), outputName, saveProjectAtIter, timelapseImages, export formats (ply default; sog, ssog, spz, usd*, html viewer, rad). Output goes to .pi/lichtfeld/<run> with project.licht; returns the splat files, metrics parsed from the log and a review instruction. Long: timeoutSec default 5400.",
    Type.Object({ dataset: localPath, action: Type.Optional(choices(["check", "train"])), output: Type.Optional(localPath), iterations: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })), strategy: Type.Optional(choices([...STRATEGIES])), maxGaussians: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000000 })), shDegree: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })), maxWidth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8192 })), imagesFolder: Type.Optional(Type.String({ maxLength: 120 })), testEvery: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })), eval: Type.Optional(Type.Boolean()), evalSteps: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 16 })), bilateralGrid: Type.Optional(Type.Boolean()), mip: Type.Optional(Type.Boolean()), gut: Type.Optional(Type.Boolean()), undistort: Type.Optional(Type.Boolean()), random: Type.Optional(Type.Boolean()), init: Type.Optional(localPath), resume: Type.Optional(localPath), outputName: Type.Optional(Type.String({ maxLength: 120 })), saveProjectAtIter: Type.Optional(Type.Integer({ minimum: 1 })), timelapseImages: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 8 })), timelapseEvery: Type.Optional(Type.Integer({ minimum: 1 })), noProvenance: Type.Optional(Type.Boolean()), export: Type.Optional(Type.Array(choices([...SPLAT_FORMATS]), { minItems: 1, maxItems: 9 })), extraArgs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 32, description: "further LichtFeld CLI flags, e.g. --min-opacity 0.01" })), gpuIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })), logLevel: Type.Optional(choices(["info", "debug", "warn"])), timeoutSec: Type.Optional(Type.Integer({ minimum: 60, maximum: 7200 })) }),
    lichtfeldTrain, 7_200_000);
  register("lichtfeld_render",
    "Render a trained splat (.ply/.sog/.ssog/.spz or .resume) to MP4 along a camera path, headless. Without cameraPath it generates a closing turntable: center, radius, elevationDeg (20), seconds (8), orbitKeyframes (24), up ([0,1,0]; Blender-captured datasets use [0,0,1]), focalMm, startDeg; or give explicit keyframes [{time, position, lookAt|rotation[w,x,y,z], focalMm}]. action path only writes the LichtFeld timeline JSON (version 4) for inspection. width/height default 1280x720, fps 30, crf 18. Review the output with video_frames.",
    Type.Object({ model: localPath, action: Type.Optional(choices(["render", "path"])), output: Type.Optional(localPath), cameraPath: Type.Optional(localPath), keyframes: Type.Optional(Type.Array(Type.Object({ time: Type.Number({ minimum: 0 }), position: vec3, lookAt: Type.Optional(vec3), rotation: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4 })), focalMm: Type.Optional(Type.Number({ minimum: 5, maximum: 400 })), easing: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })) }), { minItems: 2, maxItems: 240 })),
      center: Type.Optional(vec3), radius: Type.Optional(Type.Number({ minimum: 0.01, maximum: 100000 })), elevationDeg: Type.Optional(Type.Number({ minimum: -89, maximum: 89 })), seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })), orbitKeyframes: Type.Optional(Type.Integer({ minimum: 4, maximum: 240 })), up: Type.Optional(vec3), focalMm: Type.Optional(Type.Number({ minimum: 5, maximum: 400 })), startDeg: Type.Optional(Type.Number()),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 7680 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4320 })), fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), timeoutSec: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })) }),
    lichtfeldRender, 3_700_000);
  register("lichtfeld_convert",
    "LichtFeld subcommands. convert: between splat formats (.ply, .sog, .ssog, .spz, .usd/.usda/.usdc, .html standalone viewer) — format picks the default output extension. mesh2splat: turn a mesh (obj/ply/glb from blender_export) into Gaussian splats, so Blender-authored objects can be composed with captured scenes. extraArgs passes further flags (see `<subcommand> --help`). Needs the installed CUDA binary.",
    Type.Object({ input: localPath, action: Type.Optional(choices(["convert", "mesh2splat"])), output: Type.Optional(localPath), format: Type.Optional(choices(["ply", "sog", "ssog", "spz", "usd", "usda", "usdc", "html"])), extraArgs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 32 })) }),
    lichtfeldConvert, 1_900_000);
}
