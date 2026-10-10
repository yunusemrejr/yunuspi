/** Vision questions about local images and full-resolution asset cutting. */
import { Type } from "typebox";
import { imageCrop } from "./lib/design-studio.ts";
import { choices } from "./lib/tool-schema.ts";
import { imageUnderstand } from "./lib/image-understand.ts";
import { randomUUID } from "node:crypto";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const url = Type.String({ minLength: 8, maxLength: 2048, pattern: "^https?://" });
const box = Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }) });
const source = { path: Type.Optional(localPath), url: Type.Optional(url) };

const outputDir = Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Existing workspace folder for a fresh artifact subfolder; default .pi/design (git-ignored)" }));

const scale = Type.Optional(Type.Number({ minimum: 0.5, maximum: 4, description: "Device pixel ratio of the reference export (2 for @2x). Inferred from common export widths when omitted" }));

export default function designStudio(pi: any) {
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal, ctx?: any) => Promise<any>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  register("image_understand", "Ask a vision model about 1..8 local images: content, composition, visible defects, references or sampled-frame comparisons. Uses the current image-capable model or an explicit provider/model for this call; models lists authenticated vision choices. Returns observations, usage and source hash/crop/scale evidence. region isolates small details in one image; maxWidth bounds sent pixels. Files are sent to the selected provider; a design-map.json remains a local alternative for measurements.",
    Type.Object({ action: Type.Optional(choices(["analyze", "models"])), path: Type.Optional(localPath), paths: Type.Optional(Type.Array(localPath, { minItems: 1, maxItems: 8 })), prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), region: Type.Optional(box), maxWidth: Type.Optional(Type.Integer({ minimum: 256, maximum: 2560 })), maxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 8192 })) }),
    (params, cwd, signal, ctx) => { const id = randomUUID(), session = ctx?.sessionManager?.getSessionId?.(); return imageUnderstand(params, cwd, signal, ctx, { onUsage: (usage, status, model) => { if (ctx?.sessionManager?.getSessionId?.() !== session) return; try { pi.appendEntry?.("auxiliary-model-usage-v1", { id, owner: "image-understand", provider: model.provider, model: model.id, status, ...(usage === undefined ? {} : { usage }) }); } catch {} } }); }, 180000);
  register("image_crop",
    "Cut assets out of a reference at full source resolution: explicit regions (source px, or css with units:\"css\"), or block ids / kinds from an existing design-map.json (e.g. kinds:[\"image\"] cuts every photo). Optional padding, background keying to transparency (key:\"auto\" or #rrggbb, edge-connected with de-fringing), trim and format (auto picks PNG for flat/alpha and WebP for photographic). Returns files with CSS sizes. Up to 24 assets per call.",
    Type.Object({ ...source, map: Type.Optional(localPath), blocks: Type.Optional(Type.Array(Type.String({ pattern: "^b\\d{1,4}$" }), { maxItems: 24 })), kinds: Type.Optional(Type.Array(choices(["image", "icon", "gradient", "mixed", "flat", "container"]), { maxItems: 6 })),
      regions: Type.Optional(Type.Array(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }), name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })) }), { maxItems: 24 })),
      units: Type.Optional(choices(["source", "css"])), padding: Type.Optional(Type.Number({ minimum: 0, maximum: 512 })), key: Type.Optional(Type.String({ pattern: "^(none|auto|#[0-9a-fA-F]{6})$" })), tolerance: Type.Optional(Type.Number({ minimum: 1, maximum: 40 })), trim: Type.Optional(Type.Boolean()),
      format: Type.Optional(choices(["auto", "png", "jpg", "webp"])), quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), outputWidth: Type.Optional(Type.Integer({ minimum: 8, maximum: 4096 })), scale, outputDir }),
    imageCrop, 180_000);
}
