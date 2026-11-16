import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { streamSimple as openAICompletions } from "../core/ai/src/api/openai-completions.js";
import { streamSimple as openAIResponses } from "../core/ai/src/api/openai-responses.js";
import { streamSimple as anthropic } from "../core/ai/src/api/anthropic-messages.js";
import { streamSimple as google } from "../core/ai/src/api/google-generative-ai.js";
import { streamSimple as bedrock } from "../core/ai/src/api/bedrock-converse-stream.js";
import { streamSimple as codex } from "../core/ai/src/api/openai-codex-responses.js";
import { readRetryAfterMs, retryProviderRequest } from "../core/ai/src/utils/provider-retry.js";

const prompt = { messages: [{ role: "user", content: [{ type: "text", text: "Fixture prompt" }], timestamp: 1 }] };
const session = { retryOwner: "session", maxRetries: 2, apiKey: "synthetic-token" };
const model = (id, provider, api, baseUrl) => ({
  id, provider, api, name: "Fixture", baseUrl, contextWindow: 65_536, maxTokens: 128,
  input: ["text"], reasoning: false, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
});
const sse = (res, frames) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""));
};
const responsesDone = { type: "response.completed", response: { id: "synthetic-response", status: "completed" } };

async function relay(t, respond) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    hits.push({ path: req.url, body: Buffer.concat(chunks), headers: req.headers });
    respond(req, res, hits.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, hits, origin: `http://127.0.0.1:${server.address().port}` };
}

test("session OpenAI SDK request surfaces the first throttled gateway attempt and preserves Retry-After", { timeout: 10_000 }, async t => {
  const { origin, hits } = await relay(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "17", "retry-after": "20", "x-should-retry": "true" });
    res.end(JSON.stringify({ error: { message: "Fixture throttled" } }));
  });
  let admissions = 0;
  const response = await openAICompletions(model("fixture", "openrouter", "openai-completions", `${origin}/v1`), prompt, {
    ...session,
    onPayload(payload) {
      admissions++;
      return { ...payload, provider: { only: ["fixture-upstream"], allow_fallbacks: false } };
    },
  }).result();
  assert.equal(response.stopReason, "error");
  assert.equal(hits.length, 1);
  assert.equal(admissions, 1);
  assert.deepEqual(JSON.parse(hits[0].body).provider, { only: ["fixture-upstream"], allow_fallbacks: false });
  assert.deepEqual(response.providerRetry, { status: 429, retryAfterMs: 17, retryAllowed: true });
});

test("standalone OpenAI SDK still recovers within its own configured retry budget", { timeout: 10_000 }, async t => {
  const { origin, hits } = await relay(t, (_req, res, attempt) => {
    if (attempt === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after-ms": "1" });
      return res.end(JSON.stringify({ error: { message: "Fixture unavailable" } }));
    }
    return sse(res, [responsesDone]);
  });
  const result = await openAIResponses(model("fixture", "openai", "openai-responses", `${origin}/v1`), prompt, {
    apiKey: "synthetic-token", maxRetries: 1,
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(hits.length, 2);
});

test("Anthropic and Google session adapters return the failed attempt without an SDK resend", { timeout: 10_000 }, async t => {
  const { origin, hits } = await relay(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0.013", "x-should-retry": "true" });
    res.end(JSON.stringify({ error: { type: "rate_limit_error", code: 429, message: "Fixture throttled" } }));
  });
  const first = await anthropic(model("claude-sonnet-4-6", "anthropic", "anthropic-messages", origin), prompt, session).result();
  assert.equal(first.stopReason, "error");
  assert.deepEqual(first.providerRetry, { status: 429, retryAfterMs: 13, retryAllowed: true });
  assert.equal(hits.length, 1);
  const second = await google(model("gemini-3.6-flash", "google", "google-generative-ai", origin), prompt, session).result();
  assert.equal(second.stopReason, "error");
  assert.equal(second.providerRetry?.status, 429, second.errorMessage);
  assert.equal(hits.length, 2);
  const standalone = { apiKey: "synthetic-token", maxRetries: 1 };
  await anthropic(model("claude-sonnet-4-6", "anthropic", "anthropic-messages", origin), prompt, standalone).result();
  assert.equal(hits.length, 4);
  await google(model("gemini-3.6-flash", "google", "google-generative-ai", origin), prompt, standalone).result();
  assert.equal(hits.length, 6);
});

test("Bedrock session ownership overrides Smithy's internal attempt budget", { timeout: 10_000 }, async t => {
  const priorMaxAttempts = process.env.AWS_MAX_ATTEMPTS;
  process.env.AWS_MAX_ATTEMPTS = "2";
  t.after(() => {
    if (priorMaxAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
    else process.env.AWS_MAX_ATTEMPTS = priorMaxAttempts;
  });
  const { origin, hits } = await relay(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "x-amzn-errortype": "ThrottlingException", "retry-after": "0" });
    res.end(JSON.stringify({ message: "Fixture throttled" }));
  });
  const selected = model("fixture", "amazon-bedrock", "bedrock-converse-stream", origin);
  const env = { AWS_REGION: "us-east-1", AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" };
  const result = await bedrock(selected, prompt, { ...session, env }).result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.providerRetry, { status: 429, retryAfterMs: 0 }, result.errorMessage);
  assert.equal(hits.length, 1);
  await bedrock(selected, prompt, { env }).result();
  assert.equal(hits.length, 3, "standalone AWS defaults still retry");
});

const codexAuth = ["synthetic", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
  chatgpt_account_id: "synthetic-account",
} })).toString("base64url"), "synthetic"].join(".");

test("Codex SSE preserves HTTP retry advice without privately retrying a session request", { timeout: 10_000 }, async t => {
  const { origin, hits } = await relay(t, (_req, res) => {
    res.writeHead(503, { "content-type": "application/json", "retry-after-ms": "7", "x-should-retry": "false" });
    res.end(JSON.stringify({ error: { message: "Fixture unavailable" } }));
  });
  const result = await codex(model("fixture", "openai-codex", "openai-codex-responses", `${origin}/backend-api`),
    prompt, { ...session, apiKey: codexAuth, transport: "sse" }).result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.providerRetry, { status: 503, retryAfterMs: 7, retryAllowed: false });
  assert.equal(hits.length, 1);
});

test("Codex falls back to SSE only before WebSocket inference submission in a session", { timeout: 10_000 }, async t => {
  const { server, origin, hits } = await relay(t, (_req, res) => sse(res, [responsesDone]));
  const ws = new WebSocketServer({ noServer: true });
  t.after(() => new Promise(resolve => ws.close(resolve)));
  let rejectUpgrade = true;
  let frames = 0;
  server.on("upgrade", (req, socket, head) => {
    if (rejectUpgrade) return socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n");
    ws.handleUpgrade(req, socket, head, connection => {
      connection.on("message", () => {
        frames++;
        connection.close(1011, "Fixture disconnect");
      });
    });
  });
  const selected = model("fixture", "openai-codex", "openai-codex-responses", `${origin}/backend-api`);
  const options = { ...session, apiKey: codexAuth, transport: "auto" };
  const first = await codex(selected, prompt, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(frames, 0);
  assert.equal(hits.length, 1);

  rejectUpgrade = false;
  const second = await codex(selected, prompt, options).result();
  assert.equal(second.stopReason, "error");
  assert.equal(frames, 1);
  assert.equal(hits.length, 1);
});

test("Retry-After only accepts exact durations and valid HTTP dates", () => {
  const now = 1_800_000_000_000;
  assert.equal(readRetryAfterMs({ "Retry-After": new Date(now + 9000).toUTCString() }, now), 9000);
  assert.equal(readRetryAfterMs(new Headers({ "retry-after-ms": "0", "retry-after": "45" }), now), 0);
  assert.equal(readRetryAfterMs(new Headers({ "retry-after-ms": "0.5 seconds", "retry-after": "1" }), now), 1000);
  assert.equal(readRetryAfterMs(new Headers({ "retry-after": "-1" }), now), undefined);
});

test("a valid Retry-After beyond the timer range never becomes an immediate retry", async () => {
  let hits = 0;
  await assert.rejects(retryProviderRequest(async () => {
    hits++;
    throw Object.assign(new Error("Fixture throttled"), {
      status: 429, headers: new Headers({ "retry-after": "99999999999999999" }),
    });
  }, { maxRetries: 1, maxRetryDelayMs: 0 }), /Server requested .*retry delay/);
  assert.equal(hits, 1);
});
