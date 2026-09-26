/**
 * Provider-agnostic image generation and editing for the creative loop.
 *
 * WHY: image_create synthesizes deterministic plates (fills, gradients,
 * grain) — infrastructure, not art direction. Generative imagery needs a
 * backend boundary that is configured, never hardcoded: prompt plus
 * negative constraints merged from the creative direction avoid-list and
 * the asset role, one OpenAI-compatible HTTP client, bounded bytes,
 * decode validation, secret hygiene, automatic asset-registry provenance,
 * and routing back into visual review. Generation without the loop (brief
 * → generate → review → crop/edit/regenerate → integrate → page review)
 * is just a prettier island.
 *
 * Backends are configured via environment, never code:
 *   PI_IMAGE_BACKEND=openai-compatible (default when unset: none)
 *   PI_IMAGE_API_URL (default https://api.openai.com/v1)
 *   PI_IMAGE_API_KEY (fallback OPENAI_API_KEY)
 *   PI_IMAGE_MODEL (required: no invented default)
 * Unconfigured backends report honest status; brief building still works.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./memory-redaction.ts";
import { sniffImage } from "./design-studio.ts";
import { qaFolder } from "./creative-qa.ts";
import { ASSET_ROLES, registerAsset, roleConstraints, type AssetRole } from "./asset-registry.ts";
import { containsPath, realRoot, relativeOrAbsolute } from "./path-safety.ts";
import { directionSummary, type CreativeDirection } from "./creative-direction.ts";

export interface ImageBackend {
  name: string;
  apiUrl: string;
  model: string;
  keySource: string;
}

export interface BackendStatus {
  configured: boolean;
  name: string;
  apiUrl?: string;
  model?: string;
  keySource?: string;
  reason?: string;
  setup?: string;
}

const SETUP = "Set PI_IMAGE_BACKEND=openai-compatible, PI_IMAGE_API_URL (default https://api.openai.com/v1), PI_IMAGE_API_KEY and PI_IMAGE_MODEL. Keys stay in the environment and never appear in outputs, receipts or logs.";

/** Resolve backend configuration without touching secrets beyond presence.
 * Pure over env. */
export function resolveImageBackend(env: Record<string, string | undefined> = process.env): BackendStatus {
  const name = (env.PI_IMAGE_BACKEND ?? "").toLowerCase().trim();
  if (!name || name === "off" || name === "none") {
    return { configured: false, name: "none", reason: "No image backend configured (PI_IMAGE_BACKEND is unset). Deterministic plates remain available via image_create.", setup: SETUP };
  }
  if (name !== "openai-compatible") return { configured: false, name, reason: `Unknown PI_IMAGE_BACKEND "${name}": only "openai-compatible" is supported.`, setup: SETUP };
  const apiUrl = (env.PI_IMAGE_API_URL ?? "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const urlError = validateApiUrl(apiUrl);
  if (urlError) return { configured: false, name, reason: urlError, setup: SETUP };
  const model = (env.PI_IMAGE_MODEL ?? "").trim().slice(0, 128);
  if (!model) return { configured: false, name, apiUrl, reason: "PI_IMAGE_MODEL is required: set the backend's image model id explicitly.", setup: SETUP };
  const keySource = env.PI_IMAGE_API_KEY ? "PI_IMAGE_API_KEY" : env.OPENAI_API_KEY ? "OPENAI_API_KEY" : "";
  if (!keySource) return { configured: false, name, apiUrl, model, reason: "No API key: set PI_IMAGE_API_KEY (or OPENAI_API_KEY).", setup: SETUP };
  return { configured: true, name, apiUrl, model, keySource };
}

/** API base URL policy: https anywhere, http loopback only, no embedded
 * credentials. Pure. */
export function validateApiUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `PI_IMAGE_API_URL is not a URL: ${value.slice(0, 120)}`;
  }
  if (url.username || url.password) return "PI_IMAGE_API_URL must not embed credentials.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) return undefined;
  return "PI_IMAGE_API_URL must be https (http is allowed for loopback gateways only).";
}

export interface GenerationBrief {
  role: AssetRole;
  prompt: string;
  negative: string[];
  constraints: string[];
  size: string;
  direction: string | null;
}

const ASPECT_SIZES: Record<string, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/** Merge user prompt with direction avoid-list and role constraints into
 * one generation brief. Pure. */
export function buildGenerationBrief(
  direction: CreativeDirection | undefined,
  params: { prompt?: unknown; role?: unknown; negative?: unknown; aspect?: unknown; size?: unknown },
): GenerationBrief {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim().slice(0, 4000) : "";
  if (!prompt) throw new Error("image_generate needs a prompt (what the image must show and why)");
  const role = ASSET_ROLES.includes(params.role as AssetRole) ? (params.role as AssetRole) : "generic";
  const negative = [
    ...(Array.isArray(params.negative) ? params.negative : []).map(String).map((s) => s.trim()).filter(Boolean),
    ...(direction?.avoid ?? []),
  ].slice(0, 16).map((s) => s.slice(0, 200));
  const size = typeof params.size === "string" && params.size.trim()
    ? params.size.trim().slice(0, 32)
    : ASPECT_SIZES[String(params.aspect ?? "").toLowerCase()] ?? "1024x1024";
  return {
    role, prompt, negative,
    constraints: [...roleConstraints(role)],
    size,
    direction: direction ? directionSummary(direction) : null,
  };
}

/** Shape the OpenAI-compatible request body. Pure (key attached at send). */
export function buildImageRequest(brief: GenerationBrief, params: { seed?: unknown; transparent?: unknown; quality?: unknown; model: string }) {
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: brief.negative.length ? `${brief.prompt}\n\nAvoid: ${brief.negative.join("; ")}` : brief.prompt,
    size: brief.size,
    response_format: "b64_json",
  };
  if (params.seed !== undefined) {
    const seed = Math.floor(Number(params.seed));
    if (Number.isFinite(seed)) body.seed = seed;
  }
  if (params.transparent === true) body.background = "transparent";
  if (typeof params.quality === "string" && params.quality.trim()) body.quality = params.quality.trim().slice(0, 32);
  return body;
}

const relative = (cwd: string, file: string): string => relativeOrAbsolute(cwd, file);

async function postJson(apiUrl: string, key: string, endpoint: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<any> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: bounded,
    });
  } catch (error: any) {
    throw new Error(`Image backend unreachable: ${redactSecrets(String(error?.message ?? error)).slice(0, 300)}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`Image backend refused (${response.status}): ${redactSecrets(text).slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Image backend returned a non-JSON payload");
  }
}

async function imageBytesFromPayload(payload: any, signal: AbortSignal | undefined): Promise<Buffer> {
  const datum = payload?.data?.[0];
  const b64 = typeof datum?.b64_json === "string" ? datum.b64_json : typeof datum?.b64Json === "string" ? datum.b64Json : "";
  if (b64) {
    if (b64.length > 40 * 1024 * 1024) throw new Error("Generated image exceeds the 40 MiB bound");
    return Buffer.from(b64.replace(/\s+/g, ""), "base64");
  }
  const url = typeof datum?.url === "string" ? datum.url : "";
  if (url) {
    const { fetchBinary } = await import("../http-tools.ts");
    const fetched = await fetchBinary({ url, maxBytes: 40 * 1024 * 1024, timeoutMs: 120_000, accept: /^image\//i }, signal);
    return fetched.bytes;
  }
  throw new Error("Image backend returned neither b64_json nor url payload");
}

async function storeGenerated(
  bytes: Buffer, brief: GenerationBrief, params: { seed?: unknown; transparent?: unknown; quality?: unknown },
  backend: BackendStatus, kind: "generated" | "authored", cwd: string, signal: AbortSignal | undefined,
  extra: Record<string, unknown> = {},
) {
  const format = sniffImage(bytes);
  if (!format) throw new Error("Backend bytes are not a recognized image (PNG, JPEG, WebP, GIF, BMP, TIFF, QOI, PNM)");
  const dir = await qaFolder(undefined, cwd, "assets", "gen");
  const file = path.join(dir, `image.${format === "jpeg" ? "jpg" : format}`);
  await fs.writeFile(file, bytes, { flag: "wx" });
  const receipt = {
    backend: backend.name, apiUrl: backend.apiUrl, model: backend.model,
    size: brief.size, role: brief.role,
    seed: params.seed ?? null, transparent: params.transparent === true,
    ...(typeof params.quality === "string" ? { quality: params.quality.slice(0, 32) } : {}),
    direction: brief.direction, constraints: brief.constraints,
    bytes: bytes.length, format, ...extra,
  };
  await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify({ ...receipt, prompt: brief.prompt, negative: brief.negative }, null, 1) + "\n", { flag: "wx" });
  const { record } = await registerAsset({ path: relative(cwd, file), role: brief.role, kind, prompt: brief.prompt, description: `Generated ${brief.role}: ${brief.prompt.slice(0, 200)}` }, cwd);
  return {
    file: relative(cwd, file), dir: relative(cwd, dir), bytes: bytes.length, format,
    asset: { id: record.id, role: record.role, width: record.width, height: record.height },
    brief: { role: brief.role, size: brief.size, negative: brief.negative, constraints: brief.constraints },
    next: `Review the actual pixels before use: visual_review run {source: ${JSON.stringify(relative(cwd, file))}}. An attractive standalone image can still fail inside the page — integrate, render the page, and review the whole.`,
  };
}

export async function imageGenerateRun(
  params: { prompt?: unknown; role?: unknown; negative?: unknown; aspect?: unknown; size?: unknown; seed?: unknown; transparent?: unknown; quality?: unknown },
  cwd: string, signal: AbortSignal | undefined, direction?: CreativeDirection, env: Record<string, string | undefined> = process.env,
) {
  const backend = resolveImageBackend(env);
  if (!backend.configured) throw new Error(`${backend.reason} ${backend.setup ?? ""}`.trim());
  const brief = buildGenerationBrief(direction, params);
  const key = env.PI_IMAGE_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const payload = await postJson(backend.apiUrl!, key, "/images/generations", buildImageRequest(brief, { ...params, model: backend.model! }), signal, 240_000);
  const bytes = await imageBytesFromPayload(payload, signal);
  signal?.throwIfAborted();
  return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal);
}

export async function imageEditRun(
  params: { path?: unknown; mask?: unknown; prompt?: unknown; role?: unknown; negative?: unknown; size?: unknown; seed?: unknown },
  cwd: string, signal: AbortSignal | undefined, direction?: CreativeDirection, env: Record<string, string | undefined> = process.env,
) {
  const backend = resolveImageBackend(env);
  if (!backend.configured) throw new Error(`${backend.reason} ${backend.setup ?? ""}`.trim());
  if (typeof params.path !== "string" || !params.path) throw new Error("image_edit needs path (source image in the workspace)");
  const root = realRoot(cwd);
  const resolveIn = async (value: string): Promise<string> => {
    const candidate = path.resolve(root, value.replace(/^@/, ""));
    const resolved = await fs.realpath(candidate).catch(() => {
      throw new Error("Edit inputs must stay inside the workspace");
    });
    if (!containsPath(root, resolved)) throw new Error("Edit inputs must stay inside the workspace");
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Edit inputs must be regular files under 20 MiB");
    return resolved;
  };
  const imageFile = await resolveIn(params.path);
  const maskFile = typeof params.mask === "string" && params.mask ? await resolveIn(params.mask) : undefined;
  const brief = buildGenerationBrief(direction, params);
  const form = new FormData();
  form.set("model", backend.model!);
  form.set("prompt", brief.negative.length ? `${brief.prompt}\n\nAvoid: ${brief.negative.join("; ")}` : brief.prompt);
  form.set("size", brief.size);
  form.set("response_format", "b64_json");
  if (params.seed !== undefined && Number.isFinite(Math.floor(Number(params.seed)))) form.set("seed", String(Math.floor(Number(params.seed))));
  form.set("image", new Blob([await fs.readFile(imageFile)]), path.basename(imageFile));
  if (maskFile) form.set("mask", new Blob([await fs.readFile(maskFile)]), path.basename(maskFile));
  const deadline = AbortSignal.timeout(240_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const key = env.PI_IMAGE_API_KEY ?? env.OPENAI_API_KEY ?? "";
  let response: Response;
  try {
    response = await fetch(`${backend.apiUrl}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: bounded });
  } catch (error: any) {
    throw new Error(`Image backend unreachable: ${redactSecrets(String(error?.message ?? error)).slice(0, 300)}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`Image backend refused (${response.status}): ${redactSecrets(text).slice(0, 400)}`);
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Image backend returned a non-JSON payload");
  }
  const bytes = await imageBytesFromPayload(payload, signal);
  signal?.throwIfAborted();
  return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal, { editOf: relative(cwd, imageFile), ...(maskFile ? { mask: relative(cwd, maskFile) } : {}) });
}
