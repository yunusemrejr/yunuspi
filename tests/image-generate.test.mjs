// Image generation boundary: backend resolution, brief building and
// request shaping. No live provider calls; backends stay configured.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/image-generate.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const images = await load("extensions/lib/image-generate.ts");

test("resolveImageBackend reports honest unconfigured states", () => {
  const none = images.resolveImageBackend({});
  assert.equal(none.configured, false);
  assert.equal(none.name, "none");
  assert.match(none.setup, /PI_IMAGE_MODEL/);
  assert.match(images.resolveImageBackend({ PI_IMAGE_BACKEND: "midjourney" }).reason, /Unknown PI_IMAGE_BACKEND/);
  assert.match(
    images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_API_URL: "http://example.com/v1" }).reason,
    /must be https/,
  );
  const noModel = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_API_KEY: "test-key-1" });
  assert.equal(noModel.configured, false);
  assert.match(noModel.reason, /PI_IMAGE_MODEL is required/);
  const noKey = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m" });
  assert.match(noKey.reason, /No API key/);
  const ok = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m", PI_IMAGE_API_KEY: "test-key-1" });
  assert.deepEqual(ok, { configured: true, name: "openai-compatible", apiUrl: "https://api.openai.com/v1", model: "m", keySource: "PI_IMAGE_API_KEY" });
  const fallback = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m", OPENAI_API_KEY: "test-key-2" });
  assert.equal(fallback.keySource, "OPENAI_API_KEY");
  assert.ok(!JSON.stringify(ok).includes("test-key-1"), "status never echoes key material");
});

test("validateApiUrl allows https and loopback gateways only", () => {
  assert.equal(images.validateApiUrl("https://api.openai.com/v1"), undefined);
  assert.equal(images.validateApiUrl("http://localhost:8080/v1"), undefined);
  assert.equal(images.validateApiUrl("http://127.0.0.1:8080/v1"), undefined);
  assert.match(images.validateApiUrl("http://example.com/v1"), /must be https/);
  assert.match(images.validateApiUrl(["https://user", "pass@example.com/v1"].join(":")), /must not embed credentials/);
  assert.match(images.validateApiUrl("not a url"), /not a URL/);
});

test("buildGenerationBrief merges direction and role constraints", () => {
  const creative = { intent: ["editorial"], hierarchy: { primary: "content" }, avoid: ["neon glow", "glass cards"], motion: {}, audio: {}, visual: {}, references: [] };
  const brief = images.buildGenerationBrief(creative, { prompt: "  misty ridge at dawn ", role: "hero-focal", negative: ["text"], aspect: "landscape" });
  assert.equal(brief.role, "hero-focal");
  assert.equal(brief.prompt, "misty ridge at dawn");
  assert.deepEqual(brief.negative, ["text", "neon glow", "glass cards"]);
  assert.equal(brief.size, "1536x1024");
  assert.ok(brief.constraints.some((c) => /crop/.test(c)), "hero-focal crop survival");
  assert.match(brief.direction, /editorial/);
  assert.equal(images.buildGenerationBrief(undefined, { prompt: "x", role: "nope", size: "2048x2048" }).role, "generic");
  assert.equal(images.buildGenerationBrief(undefined, { prompt: "x", size: "2048x2048" }).size, "2048x2048");
  assert.throws(() => images.buildGenerationBrief(undefined, { prompt: "  " }), /needs a prompt/);
});

test("buildImageRequest shapes the OpenAI-compatible body", () => {
  const brief = { role: "background", prompt: "soft grain", negative: ["focal point"], constraints: [], size: "1024x1024", direction: null };
  const body = images.buildImageRequest(brief, { model: "m", seed: 7, transparent: true, quality: "high" });
  assert.equal(body.model, "m");
  assert.match(body.prompt, /soft grain/);
  assert.match(body.prompt, /Avoid: focal point/);
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.seed, 7);
  assert.equal(body.background, "transparent");
  assert.equal(body.quality, "high");
});
