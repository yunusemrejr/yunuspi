import assert from "node:assert/strict";
import test from "node:test";
import { stream as chat } from "../core/ai/src/api/openai-completions.js";
import { stream as responses } from "../core/ai/src/api/openai-responses.js";
import { stream as messages } from "../core/ai/src/api/anthropic-messages.js";
import { calculateCost } from "../core/ai/src/models.js";
import { DEEPSEEK_MODELS } from "../core/ai/src/providers/deepseek.models.js";
import { applyDeepSeekPricing } from "../core/ai/src/utils/deepseek-pricing.js";
import { collectSessionCost } from "../core/coding-agent/src/core/session-accounting.js";

const flash = DEEPSEEK_MODELS["deepseek-flash"];
const pro = DEEPSEEK_MODELS["deepseek-v4-pro"];
const context = { messages: [{ role: "user", content: "Synthetic prompt", timestamp: 1 }] };
const web = { web_search_requests: 77, web_fetch_requests: 78, tool_search: 2, tool_image_search: 1, tool_fetch: 1 };
const chatUsage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, completion_tokens: 100, server_tool_use: web };
const responsesUsage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100, total_tokens: 1100, server_tool_use: web };
const messageUsage = { input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 100, server_tool_use: web };
const atHoliday = Date.parse("2026-10-01T07:00:00Z") / 1000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

function price(model, time, serverToolUse) {
  const at = Date.parse(time);
  const usage = { input: 600, output: 100, cacheRead: 400, cacheWrite: 0 };
  calculateCost(model, usage, at);
  applyDeepSeekPricing(model, usage, { server_tool_use: serverToolUse }, at);
  return usage.cost;
}

test("direct DeepSeek rates follow verified UTC intervals and China holiday dates", () => {
  assert.deepEqual(pro.cost, { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0, validUntil: Date.parse("2026-12-12T00:00:00Z") });
  for (const [time, period] of [
    ["2026-11-16T00:59:59Z", "off-peak"], ["2026-11-16T01:00:00Z", "peak"],
    ["2026-11-16T04:00:00Z", "off-peak"], ["2026-11-16T06:00:00Z", "peak"],
    ["2026-11-16T10:00:00Z", "off-peak"], ["2026-11-15T07:00:00Z", "off-peak"],
    ["2026-10-01T07:00:00Z", "off-peak"], ["2027-02-05T07:00:00Z", "off-peak"],
    ["2028-03-06T07:00:00Z", "unknown"],
  ]) {
    // Exercise the calendar on a fixture whose rate has been independently extended.
    const row = time.startsWith("2026-10-01") ? flash : pro;
    const rated = { ...row, cost: { ...row.cost, validUntil: Date.parse("2029-01-01T00:00:00Z") } };
    const evidence = price(rated, time);
    assert.equal(evidence.priceBasis, `deepseek-${period}-2026-11-16`);
    assert.equal(evidence.rates.input, rated.cost.input * (period === "peak" ? 1 : 0.5));
    assert.equal(evidence.complete, period !== "unknown");
  }
});

test("only documented server meters contribute to the direct DeepSeek fee", () => {
  const time = "2026-10-01T07:00:00Z";
  const normal = price(flash, time, web);
  near(normal.total, 0.0031512);
  near(normal.serverToolCost, 0.003);
  const partial = price(flash, time, { tool_search: 2, tool_fetch: "4", tool_future: 1 });
  near(partial.serverToolCost, 0.0015);
  assert.equal(partial.complete, false);
  const custom = price({ ...flash, cost: { ...flash.cost, input: 5 } }, time, web);
  assert.equal(custom.rates.input, 5);
  near(custom.serverToolCost, 0.003);
  const proxy = price({ ...flash, baseUrl: "https://fixture.invalid" }, time, web);
  assert.equal(proxy.serverToolCost, undefined);
  assert.equal(proxy.rates.input, 0.3);
});

test("an expired request price leaves independently metered server tools visible", () => {
  const at = Date.parse("2026-12-12T00:00:00Z");
  const usage = { input: 600, output: 100, cacheRead: 400, cacheWrite: 0 };
  calculateCost(flash, usage, at);
  applyDeepSeekPricing(flash, usage, { server_tool_use: web }, at);
  near(usage.cost.total, 0.003);
  assert.equal(usage.cost.complete, false);
  assert.equal(usage.cost.priceBasis, "catalog-price-expired");
  assert.deepEqual(usage.cost.rates, {});
  const { validUntil, ...explicit } = flash.cost;
  const configured = { ...flash, cost: { ...flash.cost, afterExpiry: explicit } };
  const cost = price(configured, "2026-12-12T00:00:00Z", web);
  near(cost.total, 0.0033024);
  assert.equal(cost.complete, true);
});

function fixtureResponse(frames) {
  const payload = frames.map(([event, body]) => `${event ? `event: ${event}\r\n` : ""}data: ${typeof body === "string" ? body : JSON.stringify(body)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(payload);
  let cursor = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (cursor >= bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(cursor, ++cursor));
  } }), { headers: { "content-type": "text/event-stream" } });
}

for (const failed of [false, true]) {
  test(`DeepSeek ${failed ? "failed" : "completed"} streams bill the same usage on all three native formats`, async () => {
    const content = "Synthetic text · 😀";
    const c = { id: "fixture-chat", model: flash.id, created: atHoliday };
    const r = { id: "fixture-response", status: failed ? "failed" : "completed", created_at: atHoliday, output: [], usage: responsesUsage,
      ...(failed ? { error: { code: "server_error", message: "Synthetic partial failure" } } : {}) };
    const m = { id: "fixture-message", model: flash.id, created_at: atHoliday, usage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 0 } };
    const frames = [
      [chat, "openai-completions", flash.baseUrl, [
        [null, { ...c, choices: [{ index: 0, delta: { content }, finish_reason: failed ? null : "stop" }] }],
        [null, { ...c, choices: [], usage: chatUsage, ...(failed ? { error: { message: "Synthetic partial failure" } } : {}) }],
        ...(!failed ? [[null, "[DONE]"]] : []),
      ]],
      [responses, "openai-responses", flash.baseUrl, [
        ["response.created", { type: "response.created", response: { id: r.id, created_at: atHoliday } }],
        ["response." + r.status, { type: "response." + r.status, response: r }],
      ]],
      [messages, "anthropic-messages", `${flash.baseUrl}/anthropic`, [
        ["message_start", { type: "message_start", message: m }],
        ...(failed
          ? [["error", { type: "error", error: { message: "Synthetic partial failure" }, usage: messageUsage }]]
          : [["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: messageUsage }], ["message_stop", { type: "message_stop" }]]),
      ]],
    ];
    for (const [adapter, api, baseUrl, events] of frames) {
      const output = await adapter({ ...flash, api, baseUrl }, context, {
        apiKey: "synthetic-token", maxRetries: 0,
        fetch: async url => {
          assert.equal(new URL(url).origin, "https://api.deepseek.com");
          return fixtureResponse(events);
        },
      }).result();
      assert.equal(output.stopReason, failed ? "error" : "stop", `${api}: ${output.errorMessage ?? ""}`);
      assert.equal(output.usage.cacheRead, 400, api);
      near(output.usage.cost.total, 0.0031512);
      const cost = collectSessionCost([{ type: "message", message: output }]);
      near(cost.estimated, 0.0031512);
      assert.equal(cost.unknown, false, api);
      if (api === "openai-completions") assert.equal(output.content[0].text, content);
    }
  });
}
