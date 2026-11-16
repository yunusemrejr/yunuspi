import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-hosted-web-usage-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.GEMINI_API_KEY = "synthetic-gemini";
delete process.env.GOOGLE_GEMINI_BASE_URL;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const [{ searchWithCurrentModelOpenAI }, { searchWithKimi }, { queryGeminiApiWithInlineData, fetchGeminiApi },
  { extractWithUrlContext }, { setGeminiFetchOverrideForTests, queryWithCookies }, { collectAuxiliaryModelUsage }, { extractVideo }] = await Promise.all([
  import("../agent/extensions/pi-web-access/openai-search.ts"),
  import("../agent/extensions/pi-web-access/kimi-search.ts"),
  import("../agent/extensions/pi-web-access/gemini-api.ts"),
  import("../agent/extensions/pi-web-access/gemini-url-context.ts"),
  import("../agent/extensions/pi-web-access/gemini-web.ts"),
  import("../core/coding-agent/src/core/session-accounting.js"),
  import("../agent/extensions/pi-web-access/video-extract.ts"),
]);

const credentials = async () => ({ ok: true, apiKey: "synthetic-auth" });
function assertReceipt(receipts, provider, status, expected) {
  assert.deepEqual(receipts.map(receipt => receipt.status), ["pending", status]);
  assert.equal(receipts[0].id, receipts[1].id);
  assert.ok(receipts.every(receipt => receipt.provider === provider));
  const entries = receipts.map(receipt => ({ type: "custom", customType: "auxiliary-model-usage-v1",
    data: { ...receipt, owner: "web_search" } }));
  const { rows, truncated } = collectAuxiliaryModelUsage(entries);
  assert.equal(truncated, false);
  assert.equal(rows.length, 1);
  const { tokens, evidence } = rows[0];
  assert.deepEqual({ tokens, estimated: evidence.estimated, unknown: evidence.unknown, subscription: evidence.subscription }, expected);
}

test("OpenAI Responses counts each completed search action once and preserves usage after an incomplete stream", async t => {
  const receipts = [];
  const call = (id, action, status = "completed") => ({ type: "web_search_call", id, status, action: { type: action } });
  const search = call("search-1", "search");
  const output = [search, call("page-1", "open_page"), call("search-2", "search", "failed")];
  const terminal = { status: "incomplete", output, usage: {
    input_tokens: 80, input_tokens_details: { cached_tokens: 12 },
    output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 },
  } };
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(new URL(url).origin, "https://api.openai.com");
    assert.equal(receipts.at(-1)?.status, "pending");
    return new Response(
      [ { type: "response.output_item.done", item: search }, { type: "response.incomplete", response: terminal } ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  const ctx = { model: { provider: "openai", api: "openai-responses", id: "gpt-5", baseUrl: "https://api.openai.com/v1" },
    modelRegistry: { getApiKeyAndHeaders: credentials } };
  await assert.rejects(searchWithCurrentModelOpenAI("synthetic query", { onUsage: receipt => receipts.push(receipt) }, ctx),
    /no answer or sources/);
  assert.equal(receipts[1].usage.input, 68);
  assert.equal(receipts[1].usage.cacheRead, 12);
  assert.equal(receipts[1].usage.reasoning, 8);
  assertReceipt(receipts, "openai", "failed", { tokens: 100, estimated: 0.01, unknown: true, subscription: false });
});

test("an interrupted Responses body preserves search actions already received", async t => {
  const receipts = [];
  fs.rmSync(path.join(directory, "web-search-pacing"), { recursive: true, force: true });
  const event = { type: "response.output_item.done",
    item: { type: "web_search_call", id: "search-1", status: "completed", action: { type: "search" } } };
  const wire = new TextEncoder().encode(`data:${JSON.stringify(event)}\r\n\r\n`);
  t.mock.method(globalThis, "fetch", async () => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error("disconnected"));
        controller.enqueue(wire);
        sent = true;
      },
    }));
  });
  const ctx = { model: { provider: "openai", api: "openai-responses", id: "gpt-5", baseUrl: "https://api.openai.com/v1" },
    modelRegistry: { getApiKeyAndHeaders: credentials } };
  await assert.rejects(searchWithCurrentModelOpenAI("synthetic query", { onUsage: receipt => receipts.push(receipt) }, ctx), /disconnected/);
  assertReceipt(receipts, "openai", "failed", { tokens: 0, estimated: 0.01, unknown: true, subscription: false });
});

test("Codex and Kimi search retain plan attribution without treating purchased credits as free", async t => {
  const receipts = [];
  const source = { url: "https://example.org/reference", title: "Reference" };
  const codex = { model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5", baseUrl: "https://chatgpt.com/backend-api" },
    modelRegistry: { getApiKeyAndHeaders: credentials } };
  const kimi = { modelRegistry: { getAll: () => [{ provider: "kimi-coding" }], getApiKeyAndHeaders: credentials } };
  t.mock.method(globalThis, "fetch", async url => {
    if (new URL(url).hostname === "chatgpt.com") return Response.json({
      output: [{ type: "web_search_call", id: "search-a", status: "completed", action: { type: "search", sources: [source] } }],
      usage: { input_tokens: 8, output_tokens: 4 },
    });
    assert.equal(new URL(url).hostname, "api.kimi.com");
    return Response.json({ search_results: [source], usage: {
      prompt_tokens: 40, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens: 8,
    } });
  });
  await searchWithCurrentModelOpenAI("synthetic query", { onUsage: receipt => receipts.push(receipt) }, codex);
  assertReceipt(receipts.splice(0), "openai-codex", "completed", { tokens: 12, estimated: 0, unknown: true, subscription: true });
  await searchWithKimi("synthetic query", { onUsage: receipt => receipts.push(receipt) }, kimi);
  assertReceipt(receipts, "kimi-code", "completed", { tokens: 48, estimated: 0, unknown: true, subscription: true });
});

test("Gemini preserves cached, tool input and thinking tokens and rejects failed URL retrieval", async t => {
  const receipts = [];
  const requested = "https://example.org/reference";
  const usageMetadata = { promptTokenCount: 100, cachedContentTokenCount: 12, toolUsePromptTokenCount: 50,
    candidatesTokenCount: 30, thoughtsTokenCount: 7, totalTokenCount: 187 };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).origin, "https://generativelanguage.googleapis.com");
    assert.equal(receipts.at(-1)?.status, "pending");
    const isUrl = Boolean(JSON.parse(init.body).tools);
    return Response.json({ usageMetadata, candidates: [{ finishReason: "STOP",
      content: { parts: [{ text: "Model text with enough characters to pass the extraction length check." }] },
      ...(isUrl ? { urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_PAYWALL" }] } } : {}),
    }] });
  });
  const options = { onUsage: receipt => receipts.push(receipt) };
  await queryGeminiApiWithInlineData("synthetic document", "AA==", "application/pdf", options);
  assert.deepEqual(receipts[1].usage, { input: 138, cacheRead: 12, output: 37, reasoning: 7 });
  const expected = { tokens: 187, estimated: 0, unknown: true, subscription: false };
  assertReceipt(receipts.splice(0), "google", "completed", expected);
  assert.equal(await extractWithUrlContext(requested, undefined, options), null);
  assertReceipt(receipts, "google", "completed", expected);
});

test("Gemini Web records generation without counting credential preflight traffic", async t => {
  const receipts = [];
  const expected = "Gemini fixture text.";
  const wire = JSON.stringify([[null, null, JSON.stringify([null, null, null, null, [[null, [expected]]]])]]);
  setGeminiFetchOverrideForTests(async (url, init) => {
    if (!init?.method) {
      assert.equal(receipts.length, 0);
      return new Response('{"SNlM0e":"synthetic-preflight"}');
    }
    assert.match(String(url), /StreamGenerate$/);
    assert.equal(receipts.at(-1)?.status, "pending");
    return new Response(wire);
  });
  t.after(() => setGeminiFetchOverrideForTests(null));
  const answer = await queryWithCookies("synthetic query", {}, { onUsage: receipt => receipts.push(receipt) });
  assert.equal(answer, expected);
  assertReceipt(receipts, "gemini-web", "completed", { tokens: 0, estimated: 0, unknown: true, subscription: false });
});

test("Gemini authenticated fetches reject redirects and accept a validated resumable upload URL", { timeout: 10_000 }, async t => {
  let redirected = 0;
  let origin;
  let finishDelete;
  const deleted = new Promise(resolve => { finishDelete = resolve; });
  const received = [];
  const landing = createServer((_req, res) => { redirected++; res.end("unexpected redirect"); });
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, key: req.headers["x-goog-api-key"], body: Buffer.concat(chunks) });
    const json = value => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/redirect") {
      res.writeHead(307, { location: `http://127.0.0.1:${landing.address().port}/` }).end();
    } else if (req.url === "/upload/v1beta/files") {
      res.writeHead(200, { "x-goog-upload-url": `${origin}/resume?upload_id=synthetic` }).end();
    } else if (req.url === "/resume?upload_id=synthetic") {
      json({ file: { name: "files/fixture", uri: `${origin}/v1beta/files/fixture` } });
    } else if (req.url === "/v1beta/files/fixture") {
      json({ state: "ACTIVE" });
      if (req.method === "DELETE") finishDelete();
    } else if (req.url.endsWith(":generateContent")) {
      json({ candidates: [{ content: { parts: [{ text: "# Fixture video\n\nThe fixture was processed." }] } }] });
    } else {
      res.writeHead(404).end();
    }
  });
  for (const server of [landing, provider]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  origin = `http://127.0.0.1:${provider.address().port}`;
  process.env.GOOGLE_GEMINI_BASE_URL = origin;
  t.after(() => { delete process.env.GOOGLE_GEMINI_BASE_URL; });
  await assert.rejects(fetchGeminiApi(`${origin}/redirect`, { redirect: "follow" }));
  assert.equal(redirected, 0, "the unapproved destination never receives the request or its key");

  const video = path.join(directory, "fixture.mp4");
  const contents = Buffer.from("synthetic video fixture");
  fs.writeFileSync(video, contents);
  fs.writeFileSync(path.join(directory, "web-search.json"), '{"image":{"enabled":false}}');
  const receipts = [];
  const result = await extractVideo({
    absolutePath: video, mimeType: "video/mp4", sizeBytes: contents.length, withinUploadLimit: true,
  }, undefined, { onUsage: receipt => receipts.push(receipt) });
  assert.match(result?.content, /fixture was processed/);
  await deleted;
  assert.deepEqual(received.slice(1).map(({ method, url }) => [method, url.split("?")[0]]), [
    ["POST", "/upload/v1beta/files"], ["PUT", "/resume"], ["GET", "/v1beta/files/fixture"],
    ["POST", "/v1beta/models/gemini-3.6-flash:generateContent"], ["DELETE", "/v1beta/files/fixture"],
  ]);
  assert.ok(received.every(request => request.key === "synthetic-gemini"));
  assert.deepEqual(received[2].body, contents);
  assertReceipt(receipts, "gemini-gateway", "completed", { tokens: 0, estimated: 0, unknown: true, subscription: false });
});
