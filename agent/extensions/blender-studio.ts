/** Headless Blender as one action tool. Staged automatically for 3D intents and
 * discoverable through tool_search; the 3d-cad skill owns the workflow and the
 * review discipline. */
import { Type } from "typebox";
import fs from 'node:fs/promises';
import { IMAGE_FORMATS, INSPECTION_VIEWS, RENDER_ENGINES, blenderInspect, blenderRender, blenderRun, blenderSetup } from "./lib/blender-studio.ts";
import { videoReviewRouting } from './lib/video-production-flow.ts';
import { actionTool, choices } from "./lib/tool-schema.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });

export default function blenderStudio(pi: any) {
  const parts: any[] = [];
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal, progress?: (text: string) => void) => Promise<any>, deadlineMs: number) {
    parts.push({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, update: ((partial: any) => void) | undefined, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const progress = (text: string) => { try { update?.({ content: [{ type: "text", text }], details: { progress: text } }); } catch { /* progress is advisory */ } };
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded, progress);
        const content: any[] = [];
        if (name === 'blender_render') {
          const acceptsImages = ctx?.model?.input?.includes('image') === true;
          const route = videoReviewRouting(result, acceptsImages);
          if (route) result.visualReview = route;
          else if (acceptsImages) {
            const frames = [...new Set([result.contactSheet, result.files?.find((file: any) => /\.(png|jpe?g|webp)$/i.test(file.path))?.path].filter(Boolean))] as string[];
            for (const frame of frames) try {
              const mimeType = /\.png$/i.test(frame) ? 'image/png' : /\.webp$/i.test(frame) ? 'image/webp' : 'image/jpeg';
              if ((await fs.stat(frame)).size <= 8 * 1024 * 1024) content.push({ type: 'image', data: (await fs.readFile(frame)).toString('base64'), mimeType });
            } catch { /* Report keeps the exact paths for explicit review. */ }
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }, ...content], details: result };
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
    "Headless Blender for 3D work. setup reports (or with install:true installs) the binary (harness-local pinned 5.2.2 LTS, YUNUSPI_BLENDER or PATH), version, engines (EEVEE headless, Cycles CPU, Workbench), CPU threads and the memory budget every render is watched against. install downloads the pinned portable Linux build once (sha256-verified, ≈350 MB) into the harness tool directory; no system packages, no GPU assumed. The 3d-cad skill offers optional scene-building guidance.",
    Type.Object({ install: Type.Optional(Type.Boolean({ description: "setup: download and install the pinned Blender build (once); omit to report status" })) }),
    blenderSetup, 1_800_000);
  register("blender_run",
    "Run Python (bpy) headless in Blender: code (inline) or script (a .py path), optionally opening blend first, with args passed after `--` (sys.argv). The script builds or edits scenes with the data API, saves .blend files, bakes, exports or renders anything blender_render does not cover. Print `YUNUSPI_RESULT {json}` to return structured data; the tool also returns the stdout tail and the workspace files the script wrote. Runs with --factory-startup (set factoryStartup:false for user add-ons), niced, memory-watched, harness read-only, timeoutSec default 900 (max 3500). Blender exits non-zero on Python exceptions; the traceback is in the error.",
    Type.Object({ code: Type.Optional(Type.String({ maxLength: 200_000 })), script: Type.Optional(localPath), blend: Type.Optional(localPath), args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 })), factoryStartup: Type.Optional(Type.Boolean()), timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 3500 })) }),
    blenderRun, 3_600_000);
  register("blender_inspect",
    "Inspect a .blend without rendering. Large scenes return a compact summary and complete inspectionReport. Page view:objects/materials/animation with offset/limit or exact names; reuse inspectionReport with the same blend to avoid restarting Blender (exact source bytes are checked). view:full requests all worker detail. Reports include Blender version, scenes, units, render settings, color management, world shader sockets, selected-scene light count, every object's scene membership, transform, dimensions, smooth mesh faces, modifiers, camera lens/clip and area-light size. Material details expose stored Principled/emission socket defaults, immediate links and texture color spaces/packing; linked values are not evaluated shader output. Includes layered action channels, interpolation, driver/NLA counts, optional evaluated world transforms and missing external files (packed textures remain valid). Read before changing or rendering; inspect actual pixels before approving appearance.",
    Type.Object({ blend: localPath, view: Type.Optional(choices([...INSPECTION_VIEWS], 'auto keeps small scenes complete and summarizes large scenes; full is an explicit unbounded detail request')), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })), names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 48 })), inspectionReport: Type.Optional(localPath), scene: Type.Optional(Type.String({ maxLength: 120 })), frames: Type.Optional(Type.Array(Type.Integer({ minimum: -100000, maximum: 1000000 }), { minItems: 1, maxItems: 12, description: "Evaluate transforms at specific source frames without rendering; also reports layered-action channels, drivers and NLA" })) }),
    blenderInspect, 400_000);
  register("blender_render",
    "Render a .blend headless with bounded overrides. still: one frame or up to 24 listed frames at full settings. preview: quarter resolution and 16 samples to judge framing and motion cheaply. animation: from/to (optional step) as a PNG sequence assembled into animation.mp4 (holds source-frame gaps at scene fps/fps_base; explicit fps retimes samples uniformly) plus a labelled contact sheet of up to 12 frames. Overrides (engine, width/height, scale, samples, denoise, transparent, format, camera, scene) apply to this render only; the .blend is never modified. Output lands in a fresh folder under outputDir (default .pi/blender). Open the frames with read: a finished render is not visual approval.",
    Type.Object({ blend: localPath, mode: Type.Optional(choices(["still", "preview", "animation"])), frame: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), frames: Type.Optional(Type.Array(Type.Integer({ minimum: -100000, maximum: 1000000 }), { minItems: 1, maxItems: 24 })), from: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), to: Type.Optional(Type.Integer({ minimum: -100000, maximum: 1000000 })), step: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      ...renderOverrides, denoise: Type.Optional(Type.Boolean()), format: Type.Optional(choices([...IMAGE_FORMATS])), camera: Type.Optional(Type.String({ maxLength: 120 })), scene: Type.Optional(Type.String({ maxLength: 120 })), threads: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), outputDir: Type.Optional(localPath) }),
    blenderRender, 3_600_000);
  pi.registerTool(actionTool({
    name: "blender", label: "Blender", prefix: "blender_",
    description: "Headless Blender for 3D work. action setup: binary, version, engines and memory budget (or install the pinned build); run: execute bpy Python (inline code or a script) to build or edit scenes; inspect: summarize a .blend (objects, materials, animation); render: still, preview or animation from a .blend with bounded overrides and a contact sheet. Each action accepts only its own fields.",
  }, parts));
}
