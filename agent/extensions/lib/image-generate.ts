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
 *   PI_IMAGE_BACKEND=openai-compatible or openrouter (existing OpenRouter
 *     credentials offer its native catalog when no backend is configured)
 *   PI_IMAGE_API_URL (default https://api.openai.com/v1)
 *   PI_IMAGE_API_KEY (fallback OPENAI_API_KEY)
 *   PI_IMAGE_MODEL or tool model parameter (required: no invented default)
 * Unconfigured backends report honest status; brief building still works.
 */
import { planImageModel } from "./media-model-routing.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactSecrets } from "./memory-redaction.ts";
import { sniffImage, decodeImage } from "./design-studio.ts";
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

const SETUP = "Set PI_IMAGE_BACKEND=openai-compatible or openrouter and PI_IMAGE_MODEL. PI_IMAGE_API_URL can override the selected backend's default URL. Use PI_IMAGE_API_KEY, OPENAI_API_KEY for the compatible backend, or OPENROUTER_API_KEY/session OpenRouter credentials for OpenRouter. Keys never appear in outputs or receipts.";

/** Resolve backend configuration without touching secrets beyond presence.
 * Pure over env. */
export function imageBackendEnvironment(env: Record<string, string | undefined>, providerKeyAvailable = false, selectedModel?: unknown) {
  if (selectedModel !== undefined && (typeof selectedModel !== "string" || !selectedModel.trim())) throw Error("model must be a nonempty exact provider id");
  return {
    ...env,
    ...(!env.PI_IMAGE_BACKEND?.trim() && !env.PI_IMAGE_API_URL && (env.OPENROUTER_API_KEY || providerKeyAvailable) ? { PI_IMAGE_BACKEND: "openrouter" } : {}),
    ...(typeof selectedModel === "string" && selectedModel.trim() ? { PI_IMAGE_MODEL: selectedModel.trim() } : {}),
  };
}

export function resolveImageBackend(env: Record<string, string | undefined> = process.env, providerKeyAvailable = false): BackendStatus {
  env = imageBackendEnvironment(env, providerKeyAvailable);
  const name = (env.PI_IMAGE_BACKEND ?? "").toLowerCase().trim();
  if (!name || name === "off" || name === "none") {
    return { configured: false, name: "none", reason: "No image backend configured (PI_IMAGE_BACKEND is unset). Deterministic plates remain available via image_create.", setup: SETUP };
  }
  if (!["openai-compatible", "openrouter"].includes(name)) return { configured: false, name, reason: `Unknown PI_IMAGE_BACKEND "${name}": use "openai-compatible" or "openrouter".`, setup: SETUP };
  const apiUrl = (env.PI_IMAGE_API_URL ?? (name === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).trim().replace(/\/+$/, "");
  const urlError = validateApiUrl(apiUrl);
  if (urlError) return { configured: false, name, reason: urlError, setup: SETUP };
  const model = (env.PI_IMAGE_MODEL ?? "").trim();
  if (model.length > 200) return { configured: false, name, apiUrl, reason: "Image model id exceeds 200 characters; use its exact provider id.", setup: SETUP };
  if (!model) return { configured: false, name, apiUrl, reason: "PI_IMAGE_MODEL is required: set the backend's image model id explicitly.", setup: SETUP };
  const fallback = name === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  const keySource = env.PI_IMAGE_API_KEY ? "PI_IMAGE_API_KEY" : env[fallback] ? fallback : name === "openrouter" && providerKeyAvailable ? "session provider" : "";
  if (!keySource) return { configured: false, name, apiUrl, model, reason: `No API key: set PI_IMAGE_API_KEY (or ${fallback}).`, setup: SETUP };
  return { configured: true, name, apiUrl, model, keySource };
}

export async function imageBackendStatus(env: Record<string, string | undefined> = process.env, providerKeyAvailable = false, options: { refresh?: boolean; key?: string; signal?: AbortSignal } = {}) {
  const status = resolveImageBackend(env, providerKeyAvailable);
  if (status.name !== "openrouter") return status;
  if (options.refresh) {
    const bounded = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const response = await fetch(`${status.apiUrl ?? "https://openrouter.ai/api/v1"}/images/models`, { headers: options.key ? { authorization: `Bearer ${options.key}` } : {}, signal: bounded });
    const body = await responseText(response, bounded);
    if (!response.ok) throw Error(`Image catalog refused (${response.status}): ${redactSecrets(body).slice(0, 300)}`);
    const payload = JSON.parse(body);
    if (!Array.isArray(payload.data)) throw Error("Image catalog returned no model array");
    const models = payload.data.filter((m: any) => typeof m.id === "string").map((m: any) => ({ id: m.id, name: m.name, input: m.input_modalities ?? m.architecture?.input_modalities, output: m.output_modalities ?? m.architecture?.output_modalities, supportedParameters: m.supported_parameters, pricing: m.pricing }));
    return { ...status, availableModels: models.slice(0, 128), modelsTotal: models.length, catalog: "live images/models", transport: "images", selection: "Use the exact id with transport:images. Catalog presence does not verify generation; no model is selected automatically." };
  }
  const { builtinImagesProviders } = await import("@yunuspi/ai/providers/all");
  const models = builtinImagesProviders().find(provider => provider.id === "openrouter")!.getModels();
  return { ...status, availableModels: models.slice(0, 64).map(model => ({ id: model.id, acceptsReference: model.input.includes("image") })), modelsTotal: models.length, catalog: "bundled chat image models",
    selection: "Pass model with generate/edit to override PI_IMAGE_MODEL for this call. refresh:true discovers the live Images API catalog for transport:images. No fallback model or paid retry is selected automatically." };
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
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) return undefined;
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
export function buildImageRequest(brief: GenerationBrief, params: { seed?: unknown; transparent?: unknown; quality?: unknown; model: string; format?: unknown; compression?: unknown; inputFidelity?: unknown }) {
  const gpt = /^(?:openai\/)?(?:gpt-image-|chatgpt-image-)/i.test(params.model);
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: [brief.prompt, ...(brief.constraints.length ? [`Composition constraints: ${brief.constraints.join("; ")}`] : []), ...(brief.direction ? [`Creative direction: ${brief.direction}`] : []), ...(brief.negative.length ? [`Avoid: ${brief.negative.join("; ")}`] : [])].join("\n\n"),
    size: brief.size,
    ...(!gpt ? { response_format: "b64_json" } : {}),
  };
  if (params.seed !== undefined) {
    if (!Number.isSafeInteger(params.seed) || Number(params.seed) < 0 || Number(params.seed) > 4294967295) throw Error("seed must be an integer 0..4294967295");
    if (gpt) throw Error("GPT Image does not support seed; omit it rather than claiming reproducible generation");
    body.seed = params.seed;
  }
  if (params.transparent !== undefined && typeof params.transparent !== "boolean") throw Error("transparent must be boolean");
  if (params.transparent === true) body.background = "transparent";
  if (params.transparent === false) body.background = "opaque";
  if (typeof params.quality === "string" && params.quality.trim()) body.quality = params.quality.trim().slice(0, 32);
  if (params.format !== undefined) {
    if (!["png", "jpeg", "webp"].includes(String(params.format))) throw Error("format must be png, jpeg or webp");
    if (params.transparent && params.format === "jpeg") throw Error("Transparent output requires PNG or WebP");
    body.output_format = params.format;
  }
  if (params.compression !== undefined) {
    if (!["jpeg", "webp"].includes(String(params.format))) throw Error("compression requires format jpeg or webp");
    if (!Number.isInteger(params.compression) || Number(params.compression) < 0 || Number(params.compression) > 100) throw Error("compression must be an integer 0..100");
    body.output_compression = params.compression;
  }
  if (params.inputFidelity !== undefined) {
    if (!["low", "high"].includes(String(params.inputFidelity))) throw Error("inputFidelity must be low or high");
    if (gpt && !/^(?:openai\/)?gpt-image-1(?:\.5|-mini)?$/.test(params.model)) throw Error("This GPT Image model does not accept inputFidelity; omit it");
    if (/gpt-image-1-mini$/.test(params.model) && params.inputFidelity !== "low") throw Error("gpt-image-1-mini supports only low inputFidelity");
    body.input_fidelity = params.inputFidelity;
  }
  return body;
}

const relative = (cwd: string, file: string): string => relativeOrAbsolute(cwd, file);

async function responseText(response: Response, signal?: AbortSignal): Promise<string> {
  // Bound the HTTP body before materializing JSON/base64, including chunked responses.
  const limit = 56 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Image backend response exceeds its 56 MiB bound"); }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Image backend response exceeds its 56 MiB bound");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

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
  const text = await responseText(response, bounded);
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
    const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    if (bytes.length > 40 * 1024 * 1024) throw new Error("Generated image exceeds the 40 MiB bound");
    return bytes;
  }
  const url = typeof datum?.url === "string" ? datum.url : "";
  if (url) {
    const { fetchBinary } = await import("../http-tools.ts");
    const fetched = await fetchBinary({ url, maxBytes: 40 * 1024 * 1024, timeoutMs: 120_000, accept: /^image\//i }, signal);
    return fetched.bytes;
  }
  throw new Error("Image backend returned neither b64_json nor url payload");
}

type ImageRuntime = { providerKey?: string; onModel?: (model: string) => void; onUsage?: (usage: unknown, status: "pending" | "completed" | "failed" | "cancelled" | "timeout") => void };
type DownloadCheckpoint = { dir: string; receipt: string };
const retainedDownloadError = (error: unknown, checkpoint: DownloadCheckpoint, cwd: string) => Object.assign(new Error(`${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600)}; paid image download checkpoint retained at ${relative(cwd, checkpoint.receipt)}. Run image_generate action:recover path:${relative(cwd, checkpoint.receipt)}; this downloads the saved result and cannot submit generation.`, { cause: error }), { retainedImageDownload: checkpoint.receipt });
const backendKey = (backend: BackendStatus, env: Record<string, string | undefined>, runtime: ImageRuntime) =>
  env.PI_IMAGE_API_KEY ?? (backend.name === "openrouter" ? env.OPENROUTER_API_KEY ?? runtime.providerKey : env.OPENAI_API_KEY) ?? "";

/** Native HTTP counters use different names from the SDK journal. Preserve
 * reported billing/cache evidence without inventing a zero charge. */
export function imageUsage(raw: any) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (raw.input !== undefined || raw.output !== undefined) return raw;
  const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const prompt = raw.prompt_tokens ?? raw.input_tokens, output = raw.completion_tokens ?? raw.output_tokens;
  const details = raw.prompt_tokens_details ?? raw.input_tokens_details;
  const cached = details?.cached_tokens, written = details?.cache_write_tokens;
  const cacheRead = count(cached) ? cached : 0, cacheWrite = count(written) ? written : 0;
  const usage: Record<string, unknown> = { cacheReadReported: count(cached) && (!count(prompt) || cacheRead <= prompt) };
  if (count(prompt) && cacheRead + cacheWrite <= prompt) usage.input = prompt - cacheRead - cacheWrite;
  if (count(output)) usage.output = output;
  if (count(cached)) usage.cacheRead = cached;
  if (count(written)) usage.cacheWrite = written;
  if (count(raw.total_tokens)) usage.totalTokens = raw.total_tokens;
  if (count(raw.completion_tokens_details?.reasoning_tokens)) usage.reasoning = raw.completion_tokens_details.reasoning_tokens;
  if (typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0) usage.cost = { total: raw.cost, source: "provider-reported", complete: true };
  else if (raw.cost && typeof raw.cost === "object") usage.cost = raw.cost;
  return usage;
}

async function nativeImage(runtime: ImageRuntime, signal: AbortSignal | undefined, request: (active: AbortSignal) => Promise<any>, recovery: { cwd: string; brief: GenerationBrief; params: any; backend: BackendStatus; extra?: Record<string, unknown> }) {
  const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000);
  active.throwIfAborted();
  let payload: any, completed = false, checkpoint: DownloadCheckpoint | undefined;
  runtime.onUsage?.(undefined, "pending");
  try {
    payload = await request(active);
    const datum = payload?.data?.[0], url = !datum?.b64_json && !datum?.b64Json && typeof datum?.url === 'string' ? datum.url : undefined;
    const usage = imageUsage(payload.usage);
    if (url) {
      // The generation POST has finished; a later GET/cancellation must not
      // discard an expiring paid URL or misreport generation as cancelled.
      completed = true;
      try { runtime.onUsage?.(usage, 'completed'); } catch { /* completed generation survives accounting failures */ }
      if (url.length > 8192) throw Error('Generated image URL exceeds 8192 characters');
      const dir = await qaFolder(undefined, recovery.cwd, 'assets', 'gen-url');
      const receipt = path.join(dir, 'download.json');
      const params = Object.fromEntries(['seed', 'transparent', 'quality', 'compression', 'format', 'transport', 'size', 'aspect', 'aspectRatio', 'resolution'].filter(key => recovery.params[key] !== undefined).map(key => [key, recovery.params[key]]));
      const saved = JSON.stringify({ version: 1, status: 'awaiting_download', decodeVerified: false, url, brief: recovery.brief, params, backend: recovery.backend, usage: usage ?? null, extra: recovery.extra ?? {} }) + '\n';
      if (Buffer.byteLength(saved) > 64 * 1024) throw Error('Image download checkpoint exceeds 64 KiB');
      const temporary = path.join(dir, 'download.json.tmp');
      await fs.writeFile(temporary, saved, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, receipt);
      checkpoint = { dir, receipt };
    }
    const bytes = await imageBytesFromPayload(payload, active);
    // Complete bytes are a paid result. Storage owns recovery if cancellation
    // arrives now; discarding this response would encourage another charge.
    if (!completed) { completed = true; try { runtime.onUsage?.(usage, 'completed'); } catch { /* preserve received pixels */ } }
    return { bytes, usage: usage ?? null, rawUsage: payload.usage ?? null, checkpoint };
  } catch (error) {
    if (!completed) runtime.onUsage?.(imageUsage(payload?.usage), active.aborted ? active.reason?.name === "TimeoutError" ? "timeout" : "cancelled" : "failed");
    if (checkpoint) throw retainedDownloadError(error, checkpoint, recovery.cwd);
    throw error;
  }
}

export function routerImageOptions(body: Record<string, unknown>, params: any, native = false) {
  if (params.aspectRatio !== undefined && (typeof params.aspectRatio !== "string" || !/^(?:auto|[1-9]\d?:[1-9]\d?)$/.test(params.aspectRatio))) throw Error("aspectRatio must be auto or a positive ratio such as 16:9");
  if (params.resolution !== undefined && !["512", "1K", "2K", "4K"].includes(params.resolution)) throw Error("resolution must be 512, 1K, 2K or 4K");
  if (params.aspectRatio !== undefined && params.size !== undefined) throw Error("Choose size or aspectRatio rather than conflicting dimensions");
  if (params.aspectRatio !== undefined) body.aspect_ratio = params.aspectRatio;
  if (params.resolution !== undefined) body.resolution = params.resolution;
  if (native) {
    delete body.response_format;
    if (params.size === undefined) {
      body.aspect_ratio ??= params.aspect === "landscape" ? "3:2" : params.aspect === "portrait" ? "2:3" : "1:1";
      delete body.size;
    }
  }
  return body;
}

async function openRouterImage(brief: GenerationBrief, params: any, backend: BackendStatus, key: string, signal: AbortSignal | undefined, runtime: ImageRuntime, references: Buffer[] = []) {
  const { builtinImagesProviders } = await import("@yunuspi/ai/providers/all");
  const provider = builtinImagesProviders().find(provider => provider.id === "openrouter")!;
  const known = provider.getModels().find(model => model.id === backend.model);
  const model = { ...known, id: backend.model!, name: backend.model!, provider: "openrouter", api: "openrouter-images", baseUrl: backend.apiUrl!, input: known?.input ?? ["text", "image"], output: known?.output ?? ["image"] };
  if (references.length && !model.input.includes("image")) throw new Error("The configured image model does not accept reference images");
  const body = buildImageRequest(brief, { ...params, model: backend.model! });
  const imageConfig: Record<string, unknown> = { size: brief.size };
  if (body.quality) imageConfig.quality = body.quality;
  if (body.background) imageConfig.background = body.background;
  if (body.output_format) imageConfig.output_format = body.output_format;
  if (body.output_compression !== undefined) imageConfig.output_compression = body.output_compression;
  if (body.input_fidelity) imageConfig.input_fidelity = body.input_fidelity;
  routerImageOptions(imageConfig, params);
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000);
  const input: any[] = [{ type: "text", text: body.prompt }];
  for (const reference of references) {
    const format = sniffImage(reference);
    if (!format) throw new Error("Reference is not a recognized image");
    await decodeImage(reference, { maxWidth: 512, maxPixels: 512 * 512 }, bounded);
    input.push({ type: "image", mimeType: `image/${format}`, data: reference.toString("base64") });
  }
  bounded.throwIfAborted();
  runtime.onUsage?.(undefined, "pending");
  let result;
  try { result = await provider.generateImages(model as any, { input }, {
    apiKey: key, signal: bounded, timeoutMs: 240_000, maxRetries: 0,
    onPayload: (payload: any) => ({ ...payload, image_config: imageConfig, ...(body.seed === undefined ? {} : { seed: body.seed }) }),
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      const text = await responseText(response, bounded);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  }); } catch (error) {
    runtime.onUsage?.(undefined, bounded.aborted ? bounded.reason?.name === "TimeoutError" ? "timeout" : "cancelled" : "failed");
    throw error;
  }
  runtime.onUsage?.(result.usage, result.stopReason === "stop" ? "completed" : bounded.aborted ? bounded.reason?.name === "TimeoutError" ? "timeout" : "cancelled" : result.stopReason === "aborted" ? "cancelled" : "failed");
  if (result.stopReason !== "stop") bounded.throwIfAborted();
  if (result.stopReason !== "stop") throw new Error(`Image backend failed: ${redactSecrets(result.errorMessage ?? result.stopReason).slice(0, 400)}`);
  const image = result.output.find(part => part.type === "image");
  if (!image || image.type !== "image") throw new Error("Image backend returned no image");
  return imageBytesFromPayload({ data: [{ b64_json: image.data }] }, bounded);
}

async function storeGenerated(
  bytes: Buffer, brief: GenerationBrief, params: { seed?: unknown; transparent?: unknown; quality?: unknown; compression?: unknown; format?: unknown; transport?: unknown; size?: unknown; aspect?: unknown; aspectRatio?: unknown; resolution?: unknown },
  backend: BackendStatus, kind: "generated" | "authored", cwd: string, signal: AbortSignal | undefined,
  extra: Record<string, unknown> = {},
  checkpoint?: DownloadCheckpoint,
) {
  const format = sniffImage(bytes);
  if (!format) { const error = new Error("Backend bytes are not a recognized image (PNG, JPEG, WebP, GIF, BMP, TIFF, QOI, PNM)"); throw checkpoint ? retainedDownloadError(error, checkpoint, cwd) : error; }
  const dir = await qaFolder(undefined, cwd, "assets", "gen").catch(error => { throw checkpoint ? retainedDownloadError(error, checkpoint, cwd) : error; });
  const file = path.join(dir, `image.${format === "jpeg" ? "jpg" : format}`);
  let retained = false, decoded: Awaited<ReturnType<typeof decodeImage>> | undefined, registration = 'unverified';
  try {
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    retained = true;
    if (checkpoint) {
      await fs.unlink(checkpoint.receipt).catch(() => {});
      await fs.rmdir(checkpoint.dir).catch(() => {}); // keep any additional caller-owned files
    }
    // Save first, then finish bounded local decoding even when the request was
    // cancelled after its response. No new provider call is allowed here.
    decoded = await decodeImage(bytes, { maxWidth: 512, maxPixels: 512 * 512 }, AbortSignal.timeout(80_000));
    const alphaObserved = decoded.data.some((v, i) => i % 4 === 3 && v < 255);
    const receipt = {
      backend: backend.name, apiUrl: backend.apiUrl, model: backend.model,
      size: backend.name === "openrouter" && params.transport === "images" && params.size === undefined ? null : brief.size, role: brief.role,
      aspectRatio: params.aspectRatio ?? params.aspect ?? null, resolution: params.resolution ?? null,
      seed: params.seed ?? null, transparent: params.transparent === true,
      transparencyRequested: params.transparent ?? null, alphaObservedInPreview: alphaObserved,
      requestedFormat: params.format ?? null, compression: params.compression ?? null,
      transport: backend.name === "openrouter" ? params.transport ?? "chat" : "images",
      ...(typeof params.quality === "string" ? { quality: params.quality.slice(0, 32) } : {}),
      direction: brief.direction, constraints: brief.constraints,
      bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex"), format, width: decoded.sourceWidth, height: decoded.sourceHeight, decodeVerified: true, ...extra,
    };
    await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify({ ...receipt, prompt: brief.prompt, negative: brief.negative }, null, 1) + "\n", { flag: "wx" });
    signal?.throwIfAborted();
    const { record } = await registerAsset({ path: relative(cwd, file), role: brief.role, kind, prompt: brief.prompt, description: `Generated ${brief.role}: ${brief.prompt.slice(0, 200)}` }, cwd);
    registration = 'verified';
    signal?.throwIfAborted();
    return {
      backend: backend.name, model: backend.model, usage: extra.usage ?? null, quote: extra.quote ?? null,
      alphaObserved,
      file: relative(cwd, file), dir: relative(cwd, dir), bytes: bytes.length, format, decodeVerified: true,
      asset: { id: record.id, role: record.role, width: decoded.sourceWidth, height: decoded.sourceHeight },
      brief: { role: brief.role, size: brief.size, negative: brief.negative, constraints: brief.constraints },
      next: `Review the actual pixels before use: visual_review run {source: ${JSON.stringify(relative(cwd, file))}}. An attractive standalone image can still fail inside the page — integrate, render the page, and review the whole.`,
    };
  } catch (error: any) {
    if (!retained) { await fs.rm(dir, { recursive: true, force: true }); throw checkpoint ? retainedDownloadError(error, checkpoint, cwd) : error; }
    // Generation has already happened. A bookkeeping/cancellation failure
    // cannot justify deleting usable pixels or issuing another paid request.
    const recovery = { status: 'retained', file: relative(cwd, file), dir: relative(cwd, dir), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), decodeVerified: !!decoded, role: brief.role,
      registration, usage: extra.usage ?? null, model: backend.model,
      error: redactSecrets(String(error?.message ?? error)).slice(0, 600),
      next: decoded ? 'Reuse this local image. Repair the reported receipt/registry gap, use asset_register on the retained file if registration is unverified, then review its pixels; do not repeat generation.' : 'Provider bytes are retained but decoding is unverified. Inspect the bytes and decoder error before explicitly requesting another generation.' };
    await fs.writeFile(path.join(dir, 'recovery.json'), JSON.stringify(recovery, null, 2) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw new Error(`${recovery.error}\n${decoded ? 'Decoded image' : 'Generated bytes'} retained at ${recovery.file}; recovery folder: ${recovery.dir}. ${recovery.next}`, { cause: error });
  }
}

/** Resume only the safe bounded GET for a saved provider result. No provider
 * credential, generation POST or repeated usage journal entry is needed. */
export async function imageRecoverRun(params: { path?: unknown }, cwd: string, signal?: AbortSignal) {
  const root = await realRoot(cwd);
  if (typeof params.path !== 'string' || !params.path || params.path.length > 4096) throw Error('recover requires path to a saved image download.json');
  const file = await fs.realpath(path.resolve(root, params.path));
  if (!containsPath(root, file)) throw Error('Image download checkpoint must stay inside the workspace');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw Error('Image download checkpoint must be a regular file up to 64 KiB');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  if (saved.version !== 1 || saved.status !== 'awaiting_download' || typeof saved.url !== 'string' || !saved.url || saved.url.length > 8192 || !saved.brief || !ASSET_ROLES.includes(saved.brief.role) || typeof saved.brief.prompt !== 'string' || !saved.params || !['openrouter', 'openai-compatible'].includes(saved.backend?.name)) throw Error('Invalid image download checkpoint');
  const checkpoint = { dir: path.dirname(file), receipt: file };
  // Only remove harness-created checkpoint directories after saving pixels.
  const owned = path.basename(file) === 'download.json' && /^gen-url-[a-zA-Z0-9-]+$/.test(path.basename(checkpoint.dir));
  let bytes: Buffer;
  try { bytes = await imageBytesFromPayload({ data: [{ url: saved.url }] }, signal); }
  catch (error) { throw new Error(`${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600)}; image download checkpoint retained at ${relative(root, file)}. Retry recover while the URL remains valid; do not repeat generation.`, { cause: error }); }
  const extra = Object.fromEntries(['editOf', 'references', 'referenceHashes', 'mask', 'maskHash', 'inputFidelity', 'quote'].filter(key => saved.extra?.[key] !== undefined).map(key => [key, saved.extra[key]]));
  return storeGenerated(bytes, saved.brief, saved.params, saved.backend, 'generated', root, signal, { ...extra, usage: saved.usage ?? null, recovered: true }, owned ? checkpoint : undefined);
}

async function plannedImageParams(params: any, signal?: AbortSignal) {
  if (params.model !== 'auto' && params.maxCostUsd === undefined) return { params, quote: undefined };
  const quote = await planImageModel(params, signal);
  return { params: { ...params, model: quote.model, transport: 'images' }, quote };
}

export async function imageGenerateRun(
  params: { maxCostUsd?: unknown; model?: unknown; prompt?: unknown; role?: unknown; negative?: unknown; aspect?: unknown; aspectRatio?: unknown; resolution?: unknown; size?: unknown; seed?: unknown; transparent?: unknown; quality?: unknown; format?: unknown; compression?: unknown; transport?: unknown; inputFidelity?: unknown },
  cwd: string, signal: AbortSignal | undefined, direction?: CreativeDirection, env: Record<string, string | undefined> = process.env, runtime: ImageRuntime = {},
) {
  const planned = await plannedImageParams(params, signal);
  if (planned.quote && env.PI_IMAGE_BACKEND && env.PI_IMAGE_BACKEND !== "openrouter") throw Error("Capped/automatic image planning requires the OpenRouter backend");
  params = planned.params;
  env = imageBackendEnvironment(env, !!runtime.providerKey, params.model);
  runtime.onModel?.(String(params.model ?? env.PI_IMAGE_MODEL ?? ""));
  const backend = resolveImageBackend(env, !!runtime.providerKey);
  if (!backend.configured) throw new Error(`${backend.reason} ${backend.setup ?? ""}`.trim());
  if (backend.name !== "openrouter" && (params.aspectRatio !== undefined || params.resolution !== undefined)) throw Error("aspectRatio/resolution require OpenRouter; use size with compatible backends");
  const brief = buildGenerationBrief(direction, params);
  const key = backendKey(backend, env, runtime);
  if (params.inputFidelity !== undefined) throw Error("inputFidelity requires edit with reference images");
  if (params.transport !== undefined && !["images", "chat"].includes(String(params.transport))) throw Error("transport must be images or chat");
  if (backend.name !== "openrouter" && params.transport === "chat") throw Error("chat transport requires OpenRouter");
  if (backend.name === "openrouter" && params.transport !== "images") {
    const bytes = await openRouterImage(brief, params, backend, key, signal, runtime);
    return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal);
  }
  const body = buildImageRequest(brief, { ...params, model: backend.model! });
  if (backend.name === "openrouter") routerImageOptions(body, params, true);
  if (planned.quote) body.provider = { only: [planned.quote.provider], allow_fallbacks: false };
  const { bytes, usage, checkpoint } = await nativeImage(runtime, signal, active => postJson(backend.apiUrl!, key, backend.name === "openrouter" ? "/images" : "/images/generations", body, active, 240_000), { cwd, brief, params, backend, extra: { quote: planned.quote } });
  return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal, { usage, quote: planned.quote }, checkpoint);
}

export async function imageEditRun(
  params: { maxCostUsd?: unknown; model?: unknown; path?: unknown; references?: unknown; mask?: unknown; prompt?: unknown; role?: unknown; negative?: unknown; aspect?: unknown; aspectRatio?: unknown; resolution?: unknown; size?: unknown; seed?: unknown; transparent?: unknown; quality?: unknown; format?: unknown; compression?: unknown; inputFidelity?: unknown; transport?: unknown },
  cwd: string, signal: AbortSignal | undefined, direction?: CreativeDirection, env: Record<string, string | undefined> = process.env, runtime: ImageRuntime = {},
) {
  const planned = await plannedImageParams(params, signal);
  if (planned.quote && env.PI_IMAGE_BACKEND && env.PI_IMAGE_BACKEND !== "openrouter") throw Error("Capped/automatic image planning requires the OpenRouter backend");
  params = planned.params;
  env = imageBackendEnvironment(env, !!runtime.providerKey, params.model);
  runtime.onModel?.(String(params.model ?? env.PI_IMAGE_MODEL ?? ""));
  const backend = resolveImageBackend(env, !!runtime.providerKey);
  if (!backend.configured) throw new Error(`${backend.reason} ${backend.setup ?? ""}`.trim());
  if (backend.name !== "openrouter" && (params.aspectRatio !== undefined || params.resolution !== undefined)) throw Error("aspectRatio/resolution require OpenRouter; use size with compatible backends");
  if (backend.name === "openrouter" && params.mask !== undefined) throw new Error("Masked edits require the openai-compatible backend; OpenRouter reference edits do not define mask semantics");
  const inputs = params.references === undefined ? [params.path] : params.references;
  if (params.references !== undefined && params.path !== undefined) throw Error("Provide path or references, not both");
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 5 || inputs.some(p => typeof p !== "string" || !p)) throw Error("image_edit needs path or 1..5 references (source images in the workspace)");
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
  const imageFiles: string[] = [], references: Buffer[] = [];
  let totalBytes = 0;
  for (const input of inputs) {
    signal?.throwIfAborted();
    const file = await resolveIn(input as string), bytes = await fs.readFile(file);
    totalBytes += bytes.length;
    if (totalBytes > 40 * 1024 * 1024) throw Error("Reference images exceed the aggregate 40 MiB bound");
    if (!["png", "jpeg", "webp"].includes(sniffImage(bytes) ?? "")) throw Error("Edit references must be PNG, JPEG or WebP");
    await decodeImage(bytes, { maxWidth: 512, maxPixels: 512 * 512 }, signal);
    imageFiles.push(file); references.push(bytes);
  }
  const imageFile = imageFiles[0];
  if (params.mask !== undefined && (typeof params.mask !== "string" || !params.mask.trim())) throw Error("mask must be a nonempty local PNG path");
  const maskFile = params.mask === undefined ? undefined : await resolveIn(params.mask as string);
  let maskBytes: Buffer | undefined;
  if (maskFile) {
    maskBytes = await fs.readFile(maskFile);
    if (totalBytes + maskBytes.length > 40 * 1024 * 1024) throw Error("Edit references and mask exceed the aggregate 40 MiB bound");
    if (sniffImage(maskBytes) !== "png") throw Error("Edit mask must be PNG with transparency");
    const { probeImage } = await import("./design-studio.ts");
    const imageInfo = await probeImage(references[0], signal), maskInfo = await probeImage(maskBytes, signal);
    if (imageInfo.width !== maskInfo.width || imageInfo.height !== maskInfo.height) throw Error("Mask dimensions must match the first reference image");
    if (maskInfo.width * maskInfo.height > 16000000) throw Error("Mask validation exceeds 16M pixels");
    const mask = await decodeImage(maskBytes, {}, signal);
    if (!mask.data.some((v, i) => i % 4 === 3 && v === 0)) throw Error("Mask has no fully transparent editable pixels; use alpha 0 where edits belong");
  }
  const brief = buildGenerationBrief(direction, params);
  const body = buildImageRequest(brief, { ...params, model: backend.model! });
  const extra = { editOf: relative(cwd, imageFile), references: imageFiles.map(f => relative(cwd, f)), referenceHashes: references.map(bytes => createHash("sha256").update(bytes).digest("hex")), ...(maskFile ? { mask: relative(cwd, maskFile), maskHash: createHash("sha256").update(maskBytes!).digest("hex") } : {}), ...(params.inputFidelity ? { inputFidelity: params.inputFidelity } : {}) };
  if (params.transport !== undefined && !["images", "chat"].includes(String(params.transport))) throw Error("transport must be images or chat");
  if (backend.name === "openrouter") {
    if (maskFile) throw new Error("Masked edits require the openai-compatible backend; OpenRouter reference edits do not define mask semantics");
    let bytes: Buffer;
    let checkpoint: DownloadCheckpoint | undefined;
    if (params.transport === "images") {
      routerImageOptions(body, params, true);
      if (planned.quote) body.provider = { only: [planned.quote.provider], allow_fallbacks: false };
      body.input_references = references.map(bytes => ({ type: "image_url", image_url: { url: `data:image/${sniffImage(bytes)};base64,${bytes.toString("base64")}` } }));
      const generated = await nativeImage(runtime, signal, active => postJson(backend.apiUrl!, backendKey(backend, env, runtime), "/images", body, active, 240000), { cwd, brief, params, backend, extra: { ...extra, quote: planned.quote } });
      bytes = generated.bytes;
      checkpoint = generated.checkpoint;
      Object.assign(extra, { usage: generated.usage, quote: planned.quote });
    } else bytes = await openRouterImage(brief, params, backend, backendKey(backend, env, runtime), signal, runtime, references);
    return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal, extra, checkpoint);
  }
  if (params.transport === "chat") throw Error("chat transport requires OpenRouter");
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.set(key, String(value));
  for (let i = 0; i < references.length; i++) form.append(references.length > 1 ? "image[]" : "image", new Blob([references[i]], { type: `image/${sniffImage(references[i])}` }), path.basename(imageFiles[i]));
  if (maskFile && maskBytes) form.set("mask", new Blob([maskBytes], { type: "image/png" }), path.basename(maskFile));
  const key = env.PI_IMAGE_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const { bytes, usage, checkpoint } = await nativeImage(runtime, signal, async active => {
    const response = await fetch(`${backend.apiUrl}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: active });
    const text = await responseText(response, active);
    if (!response.ok) throw new Error(`Image backend refused (${response.status}): ${redactSecrets(text).slice(0, 400)}`);
    try { return JSON.parse(text); } catch { throw new Error("Image backend returned a non-JSON payload"); }
  }, { cwd, brief, params, backend, extra });
  return storeGenerated(bytes, brief, params, backend, "generated", cwd, signal, { ...extra, usage }, checkpoint);
}
