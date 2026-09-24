/** Image-to-code tools: analyze a reference (mockup, screenshot or URL),
 * cut and vectorize its assets, and compare a build against it. Discovered on
 * demand through tool_search; the mockup-to-code skill owns the workflow. */
import { Type } from "typebox";
import { imageAnalyze, imageCrop, imageTrace, visualDiff } from "./lib/design-studio.ts";
import { captureToFile } from "./render-and-wait.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const url = Type.String({ minLength: 8, maxLength: 2048, pattern: "^https?://" });
const choices = (values: string[]) => Type.Union(values.map(value => Type.Literal(value)));
const box = Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }) });
const source = { path: Type.Optional(localPath), url: Type.Optional(url) };
const outputDir = Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Existing workspace folder for a fresh artifact subfolder; default .pi/design (git-ignored)" }));
const scale = Type.Optional(Type.Number({ minimum: 0.5, maximum: 4, description: "Device pixel ratio of the reference export (2 for @2x). Inferred from common export widths when omitted" }));

export default function designStudio(pi: any) {
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal) => Promise<any>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  register("image_analyze",
    "Turn a design reference (mockup, screenshot; local path or http(s) URL) into a build plan: page bands with guessed roles (navigation, hero, feature grid, footer), blocks classified as text, flat/container (CSS), gradient (CSS), icon (SVG), image (raster) or divider, palette with roles and contrast, type scale, spacing unit, container width, columns and repeated components, all in CSS px. Writes design-map.json, an annotated overlay.png (block ids by kind) and tokens.css. ocr:true attaches recognized copy to text blocks. Estimates, not the designer's intent: look at the overlay. The mockup-to-code skill owns the workflow.",
    Type.Object({ ...source, scale, ocr: Type.Optional(Type.Boolean()), language: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2,3}([+][A-Za-z]{2,3})*$", maxLength: 31 })), maxWidth: Type.Optional(Type.Integer({ minimum: 240, maximum: 2560 })), maxBlocks: Type.Optional(Type.Integer({ minimum: 8, maximum: 400 })), outputDir }),
    imageAnalyze, 240_000);
  register("image_crop",
    "Cut assets out of a reference at full source resolution: explicit regions (source px, or css with units:\"css\"), or block ids / kinds from an image_analyze map (e.g. kinds:[\"image\"] cuts every photo). Optional padding, background keying to transparency (key:\"auto\" or #rrggbb, edge-connected with de-fringing), trim and format (auto picks PNG for flat/alpha and WebP for photographic). Returns files with CSS sizes. Up to 24 assets per call.",
    Type.Object({ ...source, map: Type.Optional(localPath), blocks: Type.Optional(Type.Array(Type.String({ pattern: "^b\\d{1,4}$" }), { maxItems: 24 })), kinds: Type.Optional(Type.Array(choices(["image", "icon", "gradient", "mixed", "flat", "container"]), { maxItems: 6 })),
      regions: Type.Optional(Type.Array(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }), name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })) }), { maxItems: 24 })),
      units: Type.Optional(choices(["source", "css"])), padding: Type.Optional(Type.Number({ minimum: 0, maximum: 512 })), key: Type.Optional(Type.String({ pattern: "^(none|auto|#[0-9a-fA-F]{6})$" })), tolerance: Type.Optional(Type.Number({ minimum: 1, maximum: 40 })), trim: Type.Optional(Type.Boolean()),
      format: Type.Optional(choices(["auto", "png", "jpg", "webp"])), quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), outputWidth: Type.Optional(Type.Integer({ minimum: 8, maximum: 4096 })), scale, outputDir }),
    imageCrop, 180_000);
  register("image_trace",
    "Vectorize a flat icon, logo or simple illustration from a reference into a compact multi-color SVG (1..8 fills, sub-pixel contours from an upscaled copy, anti-aliasing halos removed). Target a map block id, a region (source px) or the whole image. Reports fidelity (re-rasterized paths vs pixel labels) and a verdict; photographic or soft-shaded regions trace poorly and should be cropped instead. Writes the SVG and a source-vs-trace preview.",
    Type.Object({ ...source, map: Type.Optional(localPath), block: Type.Optional(Type.String({ pattern: "^b\\d{1,4}$" })), region: Type.Optional(box), name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })),
      colors: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })), background: Type.Optional(Type.String({ pattern: "^(auto|none|#[0-9a-fA-F]{6})$" })), epsilon: Type.Optional(Type.Number({ minimum: 0.2, maximum: 16 })), padding: Type.Optional(Type.Number({ minimum: 0, maximum: 64 })), scale, outputDir }),
    imageTrace, 120_000);
  register("visual_diff",
    "Compare a build with its design reference at CSS resolution. candidate is a screenshot path; or source is an HTML path or http(s) URL that is rendered at the reference's CSS width (long pages in slices). Returns a verdict, SSIM, changed share, the worst page bands, bands whose content is displaced vertically (spacing drift), hot regions with zoomed reference|build crops and the reference blocks under them (with map), and reference colors missing from the build; writes compare.png (reference | build | heat). Region limits the comparison to one part of the reference.",
    Type.Object({ reference: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Reference image path or http(s) URL; defaults to the map's source" })), candidate: Type.Optional(localPath), source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), map: Type.Optional(localPath),
      referenceScale: Type.Optional(Type.Number({ minimum: 0.5, maximum: 4 })), region: Type.Optional(box), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048, description: "Viewport height for rendering (default by width: 844 phone, 1024 tablet, 900 desktop)" })),
      colorScheme: Type.Optional(choices(["light", "dark"])), threshold: Type.Optional(Type.Number({ minimum: 1, maximum: 40 })), outputDir }),
    (params, cwd, signal) => visualDiff(params, cwd, signal, captureToFile), 300_000);
}
