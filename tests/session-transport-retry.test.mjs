import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { streamSimple as openAICompletions } from "../core/ai/src/api/openai-completions.js";
import { streamSimple as openAIResponses } from "../core/ai/src/api/openai-responses.js";
import { streamSimple as anthropic } from "../core/ai/src/api/anthropic-messages.js";
import { streamSimple as google } from "../core/ai/src/api/google-generative-ai.js";
import { stream as vertex } from "../core/ai/src/api/google-vertex.js";
import { streamSimple as bedrock } from "../core/ai/src/api/bedrock-converse-stream.js";
import { streamSimple as codex } from "../core/ai/src/api/openai-codex-responses.js";
import { readRetryAfterMs, retryProviderRequest } from "../core/ai/src/utils/provider-retry.js";
import { isContextOverflow } from "../core/ai/src/utils/overflow.js";
import { isRetryableAssistantError, retryAssistantCall, usesProviderCooldown } from "../core/ai/src/utils/retry.js";
import { collectSessionCost } from "../core/coding-agent/src/core/session-accounting.js";

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

const footerLabel = message => collectSessionCost([{type:"message", message}]).formatted;
const fixtureSse = (origin, endpoint, frames) => async input => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, endpoint);
  return new Response([...frames, "[DONE]"].map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""),
    {headers:{"content-type":"text/event-stream"}});
};

const responsesTokens = {input_tokens:12, output_tokens:3, total_tokens:15, input_tokens_details:{cached_tokens:0}};
const hostedSearch = {type:"web_search_call", id:"synthetic-web-search", status:"completed", action:{type:"search"}};
const hostedImage = {type:"image_generation_call", id:"synthetic-image", status:"completed"};
const reportTool = (item, output_index = 0) => ({type:"response.output_item.done", output_index, item});
const hostedTerminal = (output, usage = responsesTokens, type = "response.completed", id = "synthetic-hosted-response") => ({type,
  response:{id, status:type.slice("response.".length), output, usage, ...(type === "response.failed" ? {error:{message:"Fixture failed"}} : {})}});

async function hostedResponse(frames, toolTypes = ["web_search"], origin = "https://api.openai.com", provider = "openai", responseUrl) {
  const basePath = provider === "openrouter" ? "/api/v1" : "/v1";
  const selected = model("fixture", provider, "openai-responses", `${origin}${basePath}`);
  const tools = toolTypes.map(tool => typeof tool === "string" ? {type:tool} : tool);
  const respond = fixtureSse(origin, `${basePath}/responses`, frames);
  return await openAIResponses(selected, prompt, {...session, onPayload:params => ({...params, tools}),
    fetch:async (input, init) => {
      assert.deepEqual(JSON.parse(init.body).tools, tools);
      const response = await respond(input);
      if (responseUrl) Object.defineProperty(response, "url", {value:responseUrl});
      return response;
    }}).result();
}

test("native Responses search prices each actual search and file call once", async () => {
  const openPage = {...hostedSearch, id:"synthetic-open-page", action:{type:"open_page"}};
  const findInPage = {...hostedSearch, id:"synthetic-find-page", action:{type:"find_in_page"}};
  const secondSearch = {...hostedSearch, id:"synthetic-second-search"};
  const fileSearch = {type:"file_search_call", id:"synthetic-file-search", status:"completed"};
  const frames = [
    {type:"response.web_search_call.searching", item_id:hostedSearch.id, output_index:0},
    {type:"response.web_search_call.completed", item_id:hostedSearch.id, output_index:0},
    reportTool(hostedSearch), reportTool(secondSearch, 1),
    hostedTerminal([hostedSearch, secondSearch, openPage, findInPage, fileSearch]),
  ];
  const result = await hostedResponse(frames, ["web_search", "file_search"]);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.content, []);
  assert.deepEqual(result.usage.cost.serverToolUse, {web_search_call:2, file_search_call:1});
  assert.equal(result.usage.cost.serverToolCost, .0225);
  assert.equal(result.usage.cost.serverToolPriceBasis, "openai-api-published-tool-rates");
  assert.equal(footerLabel(result), "$~0.022515+?");

  const fileOnly = await hostedResponse([hostedTerminal([fileSearch])], ["file_search"]);
  assert.deepEqual(fileOnly.usage.cost.serverToolUse, {file_search_call:1});
  assert.equal(footerLabel(fileOnly), "$~0.002515");
  const navigationOnly = await hostedResponse([hostedTerminal([openPage, findInPage])]);
  assert.equal(navigationOnly.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(navigationOnly), "$~0.000015");
});

test("native Responses retains known hosted charges with incomplete or unavailable evidence", async () => {
  const frames = [reportTool(hostedSearch)];
  const failures = [
    {frames:[...frames, hostedTerminal([null, hostedImage], responsesTokens, "response.failed")], stop:"error", label:"$~0.010015+?"},
    {frames:[...frames, hostedTerminal([], null, "response.failed")], stop:"error", label:"$~0.010000+?"},
    {frames, stop:"error", label:"$~0.010000+?"},
  ];
  for (const fixture of failures) {
    const result = await hostedResponse(fixture.frames, ["web_search", "image_generation"]);
    assert.equal(result.stopReason, fixture.stop);
    assert.equal(result.usage.cost.serverToolUse?.web_search_call, 1);
    assert.equal(result.usage.cost.serverToolCost, .01);
    assert.equal(footerLabel(result), fixture.label);
  }
  const missingAction = {...hostedSearch, action:undefined};
  const result = await hostedResponse([reportTool(hostedImage), hostedTerminal([missingAction, hostedImage])]);
  assert.deepEqual(result.usage.cost.serverToolUse, {image_generation_call:1});
  assert.equal(result.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(result), "$~0.000015+?");

  const earlyImage = {type:"response.image_generation_call.generating", item_id:hostedImage.id, output_index:0};
  const unsettled = await hostedResponse([earlyImage, hostedTerminal([])]);
  assert.equal(footerLabel(unsettled), "$~0.000015+?");
});

test("native Responses isolates response, route and price provenance", async () => {
  const response = id => ({type:"response.created", response:{id}});
  const differentResponse = await hostedResponse([response("other-response"), reportTool(hostedSearch), hostedTerminal([])]);
  assert.equal(differentResponse.usage.cost.serverToolUse, undefined);
  assert.equal(footerLabel(differentResponse), "$~0.000015");
  const foreign = {...reportTool({...hostedSearch, action:{type:"open_page"}}), response_id:"other-response"};
  const matching = {...reportTool(hostedSearch), response_id:"synthetic-hosted-response"};
  const byId = await hostedResponse([foreign, matching, hostedTerminal([])]);
  assert.deepEqual(byId.usage.cost.serverToolUse, {web_search_call:1});
  assert.equal(footerLabel(byId), "$~0.010015+?");
  const frames = [hostedTerminal([hostedSearch])];
  for (const result of [await hostedResponse(frames, ["web_search_preview"]),
    await hostedResponse(frames, ["web_search"], "https://api.openai.com.example.invalid")]) {
    assert.deepEqual(result.usage.cost.serverToolUse, {web_search_call:1});
    assert.equal(result.usage.cost.serverToolCost, undefined);
    assert.equal(footerLabel(result), "$~0.000015+?");
  }
  for (const [cost, label] of [[0,"$0.000"], [.125,"$0.125000"]]) {
    const reported = await hostedResponse([hostedTerminal([hostedSearch, hostedImage], {...responsesTokens, cost})],
      ["web_search", "image_generation"], "https://openrouter.ai", "openrouter");
    assert.deepEqual(reported.usage.cost.serverToolUse, {web_search_call:1, image_generation_call:1});
    assert.equal(reported.usage.cost.serverToolCost, undefined);
    assert.equal(footerLabel(reported), label);
  }
  const localShell = {type:"shell_call", id:"synthetic-shell", environment:{type:"local"}, status:"completed"};
  const localTool = {type:"function_call", id:"synthetic-local", name:"web_search", status:"completed"};
  const local = await hostedResponse([hostedTerminal([localShell, localTool])], []);
  assert.equal(local.usage.cost.serverToolUse, undefined);
  assert.equal(footerLabel(local), "$~0.000015");
});

const meteredImage = {input_tokens:200, input_tokens_details:{text_tokens:100, image_tokens:100}, output_tokens:1000,
  output_tokens_details:{image_tokens:1000, text_tokens:0}, cached_tokens:70, cached_tokens_details:{cached_text_tokens:20, cached_image_tokens:50}, total_tokens:1200};
const standardHostedImage = {type:"image_generation", model:"gpt-image-2.6-sunburst"};
const hostedMeter = (tool_usage, output = [], type, usage = responsesTokens) => {
  const event = hostedTerminal(output, usage, type);
  return {...event, response:{...event.response, tool_usage}};
};

test("Responses billing uses reported search units ahead of visible action guesses", async () => {
  const reported = await hostedResponse([hostedMeter({web_search:{num_requests:2}})]);
  assert.equal(reported.usage.cost.serverToolUse.web_search_billable_requests, 2);
  assert.equal(reported.usage.cost.serverToolCost, .02);
  assert.equal(footerLabel(reported), "$~0.020015+?");
  const discounted = await hostedResponse([reportTool(hostedSearch), hostedMeter({web_search:{num_requests:0}}, [hostedSearch])]);
  assert.equal(discounted.usage.cost.serverToolUse.web_search_call, 1);
  assert.equal(discounted.usage.cost.serverToolUse.web_search_billable_requests, 0);
  assert.equal(discounted.usage.cost.serverToolCost, 0);
  assert.equal(footerLabel(discounted), "$~0.000015+?");
  const unused = await hostedResponse([hostedMeter({web_search:{num_requests:0}, image_gen:{input_tokens:0, output_tokens:0, total_tokens:0}})]);
  assert.equal(footerLabel(unused), "$~0.000015");
});

test("Responses billing prices separate hosted image tokens and keeps valid evidence through sparse failures", async () => {
  const tools = [standardHostedImage, "web_search"];
  const imageOnly = await hostedResponse([hostedMeter({image_gen:meteredImage}, [hostedImage])], tools);
  assert.equal(imageOnly.usage.cost.serverToolUse.image_generation_cached_tokens, 70);
  assert.ok(Math.abs(imageOnly.usage.cost.serverToolCost - .030925) < 1e-12);
  assert.equal(footerLabel(imageOnly), "$~0.030940+?");
  const snapshot = hostedMeter({image_gen:meteredImage, web_search:{num_requests:2}}, [hostedImage, hostedSearch]);
  const stale = hostedMeter({web_search:{num_requests:1}}, []);
  const preIdentity = {...snapshot, type:"response.in_progress", response:{...snapshot.response, id:undefined}};
  const partial = await hostedResponse([preIdentity, {...stale, type:"response.in_progress"},
    hostedMeter({image_gen:{input_tokens:200, output_tokens:0, total_tokens:200}}, [hostedImage, hostedSearch], "response.failed")], tools);
  assert.equal(partial.stopReason, "error");
  assert.equal(partial.usage.cost.serverToolUse.web_search_billable_requests, 2);
  assert.ok(Math.abs(partial.usage.cost.serverToolCost - .050925) < 1e-12);
  const replay = JSON.parse(JSON.stringify({type:"message", message:partial}));
  assert.equal(collectSessionCost([replay, replay]).formatted, "$~0.050940+?");
  const noCache = await hostedResponse([hostedMeter({image_gen:{...meteredImage, cached_tokens:undefined, cached_tokens_details:undefined}})], tools);
  assert.equal(noCache.usage.cost.serverToolCost, .03);
  assert.equal(footerLabel(noCache), "$~0.030015+?");
  const mismatched = hostedMeter({image_gen:meteredImage});
  mismatched.response.tools = [{type:"image_generation", model:"chatgpt-image-latest"}];
  assert.equal(footerLabel(await hostedResponse([mismatched], tools)), "$~0.000015+?");
  const otherTier = hostedMeter({image_gen:meteredImage});
  otherTier.response.service_tier = "flex";
  assert.equal(footerLabel(await hostedResponse([otherTier], tools)), "$~0.000015+?");
});

test("Responses retains aggregate hosted meters on gateways without applying direct endpoint prices twice", async () => {
  const meters = {web_search:{num_requests:2}, image_gen:meteredImage};
  const tools = [standardHostedImage, "web_search"];
  const gateway = await hostedResponse([hostedMeter(meters)], tools, "https://api.openai.com.example.invalid");
  assert.equal(gateway.usage.cost.serverToolUse.web_search_billable_requests, 2);
  assert.equal(gateway.usage.cost.serverToolUse.image_generation_output_tokens, 1000);
  assert.equal(gateway.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(gateway), "$~0.000015+?");
  const redirect = await hostedResponse([hostedMeter(meters)], tools, "https://api.openai.com", "openai", "https://other.example.invalid/v1/responses");
  assert.equal(footerLabel(redirect), "$~0.000015+?");
  const routed = await hostedResponse([hostedMeter(meters, [], "response.completed", {...responsesTokens, cost:0})], tools, "https://openrouter.ai", "openrouter");
  assert.equal(routed.usage.cost.serverToolUse.web_search_billable_requests, 2);
  assert.equal(routed.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(routed), "$0.000");
});

const anthropicId = "synthetic-anthropic-hosted-response";
const anthropicTools = [{type:"web_search_20250305", name:"web_search"}, {type:"web_fetch_20250910", name:"web_fetch"}];
const anthropicUsage = {input_tokens:12, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:0};
const anthropicStart = usage => ({type:"message_start", message:{id:anthropicId, model:"claude-sonnet-4-6", role:"assistant",
  type:"message", content:[], usage:{...anthropicUsage, ...usage}}});
const anthropicDelta = usage => ({type:"message_delta", delta:{stop_reason:"end_turn"}, usage:{output_tokens:3, ...usage}});
const anthropicStop = {type:"message_stop"};
const anthropicServerTool = (name, id) => ({type:"content_block_start", index:0, content_block:{type:"server_tool_use", id, name}});
const anthropicSearchResult = (id, content = []) => ({type:"content_block_start", index:1,
  content_block:{type:"web_search_tool_result", tool_use_id:id, content}});

async function anthropicHostedResponse(frames, {origin = "https://api.anthropic.com", tools = anthropicTools, inferenceGeo, responseUrl, credentials = session} = {}) {
  const selected = model("claude-sonnet-4-6", "anthropic", "anthropic-messages", origin);
  return await anthropic(selected, prompt, {...credentials,
    onPayload:params => ({...params, tools, inference_geo:inferenceGeo}),
    fetch:async (input, init) => {
      const url = new URL(String(input.url ?? input));
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/v1/messages");
      const sent = JSON.parse(init.body);
      assert.deepEqual(sent.tools, tools);
      assert.equal(sent.inference_geo, inferenceGeo);
      const response = new Response(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        {headers:{"content-type":"text/event-stream"}});
      if (responseUrl) Object.defineProperty(response, "url", {value:responseUrl});
      return response;
    },
  }).result();
}

test("Anthropic native search counts distinct proven successes and keeps cumulative provider meters", async () => {
  const first = anthropicSearchResult("synthetic-search-one");
  const second = anthropicSearchResult("synthetic-search-two");
  const blocks = [anthropicServerTool("web_search", "synthetic-search-one"), first, first,
    anthropicServerTool("web_search", "synthetic-search-two"), second,
    anthropicServerTool("web_fetch", "synthetic-fetch")];
  const result = await anthropicHostedResponse([
    anthropicStart({server_tool_use:{web_search_requests:1, web_fetch_requests:0}}), ...blocks,
    anthropicDelta({server_tool_use:{web_search_requests:2, web_fetch_requests:1}}), anthropicDelta(), anthropicStop,
  ]);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.content, []);
  assert.deepEqual(result.usage.cost.serverToolUse, {web_search_requests:2, web_fetch_requests:1, web_search_successes:2});
  assert.equal(result.usage.cost.serverToolCost, .02);
  assert.equal(result.usage.cost.serverToolPriceBasis, "anthropic-api-published-web-search-rate");
  const replay = JSON.parse(JSON.stringify(result));
  assert.equal(footerLabel(replay), "$~0.020015");
  assert.equal(collectSessionCost([{type:"message", message:replay}, {type:"message", message:replay}]).formatted, "$~0.020015");
});

test("Anthropic hosted billing preserves attested spend across transport failure and exposes unresolved attempts", async () => {
  const first = anthropicSearchResult("synthetic-search-one");
  const failed = anthropicSearchResult("synthetic-search-two", {type:"web_search_tool_result_error", error_code:"unavailable"});
  const meter = anthropicDelta({server_tool_use:{web_search_requests:2, web_fetch_requests:0}});
  const failure = {type:"error", error:{type:"api_error", message:"Synthetic Anthropic failure"}};
  const result = await anthropicHostedResponse([anthropicStart(), first, failed, meter, anthropicDelta(), failure]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /Synthetic Anthropic failure/);
  assert.deepEqual(result.usage.cost.serverToolUse, {web_search_requests:2, web_fetch_requests:0, web_search_successes:1});
  assert.equal(result.usage.cost.serverToolCost, .01);
  assert.equal(footerLabel(result), "$~0.010015+?");

  const hidden = await anthropicHostedResponse([anthropicStart(), meter, anthropicStop]);
  assert.equal(hidden.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(hidden), "$~0.000015+?");
  const free = await anthropicHostedResponse([anthropicStart(), failed, anthropicServerTool("web_fetch", "synthetic-fetch"),
    anthropicDelta({server_tool_use:{web_search_requests:0, web_fetch_requests:1}}), anthropicStop]);
  assert.deepEqual(free.usage.cost.serverToolUse, {web_search_requests:0, web_fetch_requests:1, web_search_successes:0});
  assert.equal(free.usage.cost.serverToolCost, 0);
  assert.equal(footerLabel(free), "$~0.000015");
  const contradiction = await anthropicHostedResponse([anthropicStart(), first,
    anthropicDelta({server_tool_use:{web_search_requests:0}}), anthropicStop]);
  assert.equal(contradiction.usage.cost.serverToolCost, .01);
  assert.equal(footerLabel(contradiction), "$~0.010015+?");
  const malformed = await anthropicHostedResponse([anthropicStart(),
    anthropicDelta({server_tool_use:{web_search_requests:-1}}), anthropicStop]);
  assert.equal(malformed.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(malformed), "$~0.000015+?");
});

test("Anthropic hosted code keeps container pricing unknown unless the submitted tool includes it", async () => {
  const frames = [anthropicStart(), anthropicServerTool("code_execution", "synthetic-code"), anthropicDelta(), anthropicStop];
  const unpriced = await anthropicHostedResponse(frames, {tools:[{type:"code_execution_20250825", name:"code_execution"}]});
  assert.equal(unpriced.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(unpriced), "$~0.000015+?");
  const bundled = await anthropicHostedResponse(frames, {tools:[{type:"web_search_20260209", name:"web_search"}]});
  assert.equal(bundled.usage.cost.serverToolCost, 0);
  assert.equal(footerLabel(bundled), "$~0.000015");
});

test("Anthropic hosted prices require the direct API route and verified US requests scale only the tokens", async () => {
  const frames = [anthropicStart({inference_geo:"us"}), anthropicSearchResult("synthetic-search-one"),
    anthropicDelta({server_tool_use:{web_search_requests:1, web_fetch_requests:0}}), anthropicStop];
  const global = await anthropicHostedResponse([anthropicStart({inference_geo:"global"}), ...frames.slice(1)], {inferenceGeo:"global"});
  assert.equal(global.usage.cost.total, .010015);
  const us = await anthropicHostedResponse(frames, {inferenceGeo:"us"});
  assert.equal(us.usage.cost.serverToolCost, .01);
  assert.equal(us.usage.cost.tokenPriceMultiplier, 1.1);
  assert.ok(Math.abs(us.usage.cost.total - .0100165) < 1e-12);
  assert.ok(Math.abs(us.usage.cost.input - .0000132) < 1e-12);
  assert.equal(us.usage.cost.complete, true);
  const ambiguous = await anthropicHostedResponse([anthropicStart(), ...frames.slice(1)], {inferenceGeo:"us"});
  assert.equal(ambiguous.usage.cost.tokenPriceMultiplier, undefined);
  assert.equal(footerLabel(ambiguous), "$~0.010015+?");

  for (const options of [{origin:"https://api.anthropic.com.example.invalid"}, {responseUrl:"https://proxy.example.invalid/v1/messages"}]) {
    const gateway = await anthropicHostedResponse(frames, {...options, inferenceGeo:"us"});
    assert.equal(gateway.usage.cost.serverToolUse?.web_search_successes, 1);
    assert.equal(gateway.usage.cost.serverToolCost, undefined);
    assert.equal(gateway.usage.cost.tokenPriceMultiplier, undefined);
    assert.equal(footerLabel(gateway), "$~0.000015+?");
  }
  const oauth = await anthropicHostedResponse(frames, {credentials:{...session, apiKey:"synthetic-sk-ant-oat"}});
  assert.equal(oauth.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(oauth), "sub+?");
});

const googleResponseId = "synthetic-gemini-hosted-response";
const googleBaseUsage = {promptTokenCount:12, candidatesTokenCount:3, totalTokenCount:15, cachedContentTokenCount:0};
const urlContext = {urlContext:{}};
const googleSearch = {googleSearch:{}};
const urlContextMetadata = {urlMetadata:[{retrievedUrl:"https://example.invalid/synthetic-url", urlRetrievalStatus:"URL_RETRIEVAL_STATUS_SUCCESS"}]};
const googleUrlUsage = {toolUsePromptTokenCount:1000, toolUsePromptTokensDetails:[{modality:"TEXT", tokenCount:1000}], totalTokenCount:1015};
const googleFinish = {finishReason:"STOP", content:{role:"model", parts:[{text:"Fixture answer"}]}};
const googleChunk = (candidate, usageMetadata, responseId = googleResponseId) => ({responseId, candidates:candidate ? [{index:0, ...candidate}] : [], usageMetadata});
const groundingMetadata = {webSearchQueries:["synthetic one", "synthetic two", "synthetic one", ""],
  groundingChunks:[{web:{uri:"https://example.invalid/synthetic-source", title:"Fixture"}}], groundingSupports:[{groundingChunkIndices:[0]}]};
const googleRoutes = [
  {request:google, provider:"google", api:"google-generative-ai", origin:"https://generativelanguage.googleapis.com", basePath:"/v1beta"},
  {request:vertex, provider:"google-vertex", api:"google-vertex", origin:"https://aiplatform.googleapis.com", basePath:""},
];

async function googleHostedResponse(t, route, frames, tools, id = "gemini-3.1-pro-preview") {
  const fetch = t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input.url ?? input));
    assert.equal(url.origin, route.origin);
    assert.ok(url.pathname.endsWith(":streamGenerateContent"));
    assert.deepEqual(JSON.parse(init.body).tools ?? [], tools);
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}});
  });
  try {
    const selected = model(id, route.provider, route.api, `${route.origin}${route.basePath}`);
    const result = await route.request(selected, prompt, {...session, onPayload:params=>({...params, config:{...params.config, tools}})}).result();
    assert.equal(fetch.mock.callCount(), 1, result.errorMessage);
    return result;
  } finally {
    fetch.mock.restore();
  }
}

test("Gemini native URL context prices the separately reported text tokens once across sparse chunks", async t => {
  for (const route of googleRoutes) {
    const result = await googleHostedResponse(t, route, [googleChunk({urlContextMetadata}, googleUrlUsage), googleChunk({urlContextMetadata}, googleUrlUsage),
      googleChunk(googleFinish, {promptTokenCount:12, cachedContentTokenCount:0, candidatesTokenCount:3})], [urlContext]);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.usage.input, 1012);
    assert.equal(result.usage.totalTokens, 1015);
    assert.deepEqual(result.usage.cost.serverToolUse, {google_tool_prompt_tokens:1000, google_url_context_input_tokens:1000});
    const replay = JSON.parse(JSON.stringify(result));
    assert.equal(footerLabel(replay), "$~0.001015");
    assert.equal(collectSessionCost([{type:"message", message:replay}, {type:"message", message:replay}]).formatted, "$~0.001015");
  }
});

test("Gemini native search keeps only numeric distinct units and respects grounding source rules", async t => {
  for (const route of googleRoutes) {
    const result = await googleHostedResponse(t, route, [googleChunk({groundingMetadata}, googleBaseUsage),
      googleChunk({...googleFinish, groundingMetadata})], [googleSearch]);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.usage.cost.serverToolUse, {google_search_queries:2, google_web_grounded_prompts:1});
    assert.equal(result.usage.cost.googleGroundingUnit, "query");
    assert.equal(result.usage.cost.serverToolCost, undefined);
    assert.equal(footerLabel(result), "$~0.000015+?");
    assert.doesNotMatch(JSON.stringify(result.usage), /synthetic two|https:\/\/example\.invalid/);

    const noSources = {...groundingMetadata, groundingChunks:[], groundingSupports:[]};
    const sourceFree = await googleHostedResponse(t, route, [googleChunk({...googleFinish, groundingMetadata:noSources}, googleBaseUsage)], [googleSearch], "gemini-2.5-flash");
    assert.equal(sourceFree.usage.cost.googleGroundingUnit, "grounded-prompt");
    assert.equal(sourceFree.usage.cost.serverToolUse.google_search_queries, 2);
    assert.equal(footerLabel(sourceFree), route.provider === "google-vertex" ? "$~0.000015" : "$~0.000015+?");
    const staleEmpty = await googleHostedResponse(t, route, [googleChunk({groundingMetadata:noSources}, googleBaseUsage),
      googleChunk(googleFinish)], [googleSearch]);
    assert.equal(staleEmpty.usage.cost.serverToolUse.google_web_grounded_prompts, undefined);
    assert.equal(footerLabel(staleEmpty), "$~0.000015+?");
  }
});

test("Gemini hosted accounting isolates mixed, foreign and interrupted evidence", async t => {
  const [developer] = googleRoutes;
  const usage = {...googleBaseUsage, ...googleUrlUsage};
  const mixed = await googleHostedResponse(t, developer, [googleChunk({...googleFinish, urlContextMetadata, groundingMetadata}, usage)], [urlContext, googleSearch]);
  assert.equal(mixed.usage.input, 12);
  assert.equal(mixed.usage.cost.serverToolUse.google_tool_prompt_tokens, 1000);
  assert.equal(footerLabel(mixed), "$~0.000015+?");
  const unverifiable = await googleHostedResponse(t, developer, [googleChunk({...googleFinish, urlContextMetadata},
    {...usage, toolUsePromptTokensDetails:[{modality:"AUDIO", tokenCount:1000}]})], [urlContext]);
  assert.equal(unverifiable.usage.input, 12);
  assert.equal(footerLabel(unverifiable), "$~0.000015+?");
  const foreign = await googleHostedResponse(t, developer, [googleChunk({}, googleBaseUsage),
    googleChunk({...googleFinish, urlContextMetadata, groundingMetadata}, usage, "unrelated-google-response"), googleChunk(googleFinish)], [urlContext]);
  assert.equal(foreign.responseId, googleResponseId);
  assert.equal(foreign.usage.cost.serverToolUse, undefined);
  assert.equal(footerLabel(foreign), "$~0.000015");
  const stopped = await googleHostedResponse(t, developer, [googleChunk({urlContextMetadata}, usage)], [urlContext]);
  assert.equal(stopped.stopReason, "error");
  assert.equal(stopped.usage.input, 1012);
  assert.equal(footerLabel(stopped), "$~0.001015+?");
  const sparseBase = await googleHostedResponse(t, developer, [googleChunk({...googleFinish, urlContextMetadata}, googleUrlUsage)], [urlContext]);
  assert.equal(sparseBase.usage.input, 1000);
  assert.equal(footerLabel(sparseBase), "$~0.001000+?");
  const gateway = await googleHostedResponse(t, {...developer, origin:"https://google.example.invalid"}, [googleChunk({...googleFinish, urlContextMetadata}, usage)], [urlContext]);
  assert.equal(gateway.usage.input, 12);
  assert.equal(footerLabel(gateway), "$~0.000015+?");
});

test("Responses billing and terminal identity survive malformed optional output", async () => {
  const origin = "https://openrouter.ai";
  const selected = model("fixture", "openrouter", "openai-responses", `${origin}/api/v1`);
  const responseId = "synthetic-terminal-response";
  const terminal = {id:responseId, usage:{input_tokens:12, output_tokens:3, total_tokens:15, cost:.125}};
  const fixtures = [
    {type:"response.failed", response:{...terminal, output:[null], status:"failed", error:{code:"fixture", message:"Fixture provider failure"}}, stop:"error"},
    {type:"response.incomplete", response:{...terminal, output:{}, status:"incomplete", incomplete_details:{reason:"max_output_tokens"}}, stop:"length"},
  ];
  for (const {type, response, stop} of fixtures) {
    const result = await openAIResponses(selected, prompt, {...session, fetch:fixtureSse(origin, "/api/v1/responses", [{type, response}])}).result();
    assert.equal(result.responseId, responseId);
    assert.equal(result.stopReason, stop);
    assert.equal(result.usage.input, 12);
    assert.equal(footerLabel(result), "$0.125000");
    if (stop === "error") assert.match(result.errorMessage, /Fixture provider failure/);
  }
  const failure = {type:"response.failed", response:{id:responseId, status:"failed", error:{code:"fixture", message:"Fixture provider failure"}}};
  const unpriced = await openAIResponses(selected, prompt, {...session, fetch:fixtureSse(origin, "/api/v1/responses", [failure])}).result();
  assert.equal(unpriced.responseId, responseId);
  assert.equal(unpriced.stopReason, "error");
  assert.match(unpriced.errorMessage, /Fixture provider failure/);
  assert.equal(footerLabel(unpriced), "$?");
});

test("Chat Completions retains authoritative OpenRouter prices across same-response token updates", async () => {
  const origin = "https://openrouter.ai";
  const selected = model("fixture", "openrouter", "openai-completions", `${origin}/api/v1`);
  const id = "synthetic-usage-response";
  const tokens = {prompt_tokens:12, completion_tokens:3};
  const updatedTokens = {...tokens, prompt_tokens:18};
  const priced = (usage, responseId = id) => ({id:responseId, choices:[], usage});
  const choiceUsage = {id, choices:[{index:0, delta:{}, usage:updatedTokens}]};
  const finish = {id, choices:[{index:0, delta:{content:"Fixture answer"}, finish_reason:"stop"}]};
  const fixtures = [
    {frames:[priced({...tokens, cost:.125}), priced(updatedTokens)], label:"$0.125000", input:18},
    {frames:[priced({...tokens, cost:0}), choiceUsage], label:"$0.000", input:18},
    {frames:[priced({...tokens, cost:.125}), priced({...updatedTokens, cost:.0625})], label:"$0.062500", input:18},
    {frames:[priced({...tokens, cost:.125}), priced({...updatedTokens, cost:0})], label:"$0.000", input:18},
    {frames:[priced({...tokens, cost:.125}), priced({...updatedTokens, cost:.5}, "unrelated-response")], label:"$0.125000", input:12},
    {frames:[priced(tokens), priced({...updatedTokens, cost:.5}, "unrelated-response")], label:"$~0.000015", input:12},
    {frames:[priced({...tokens, cost:.1, is_byok:true, cost_details:{upstream_inference_cost:.025}}), choiceUsage], label:"$0.125000", input:18},
    {frames:[priced({...tokens, cost:.1, is_byok:true}), choiceUsage], label:"$0.100000+?", input:18},
  ];
  for (const {frames, label, input} of fixtures) {
    const result = await openAICompletions(selected, prompt, {...session,
      fetch:fixtureSse(origin, "/api/v1/chat/completions", [finish, ...frames])}).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseId, id);
    assert.equal(result.usage.input, input);
    assert.equal(footerLabel(result), label);
  }
  const gateway = "https://example.invalid";
  const result = await openAICompletions({...selected, baseUrl:`${gateway}/v1`}, prompt, {...session,
    fetch:fixtureSse(gateway, "/v1/chat/completions", [finish, priced({...tokens, cost:.125}), choiceUsage])}).result();
  assert.equal(footerLabel(result), "$~0.000021");
});

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

const codexFixtureModel = model("fixture", "openai-codex", "openai-codex-responses", "https://example.invalid/backend-api");
const codexCreated = { type: "response.created", response: { id: "synthetic-response" } };
const codexText = [
  { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Fixture café" },
];
const codexWire = (frames, newline = "\n") => frames.map(frame => `data: ${JSON.stringify(frame)}${newline}${newline}`).join("");

function fakeCodex(fetch, options = {}) {
  return codex(codexFixtureModel, prompt, { ...session, apiKey: codexAuth, transport: "sse", fetch, ...options });
}

for (const [name, newline] of [["CRLF", "\r\n"], ["CR", "\r"]]) {
  test(`Codex fake SSE decodes ${name} split across reads without waiting for response EOF`, { timeout: 3000 }, async () => {
    const terminal = JSON.stringify(responsesDone, null, 2).split("\n").map(line => `data: ${line}`).join(newline);
    const wire = new TextEncoder().encode(`: keepalive${newline}${newline}${codexWire([codexCreated, ...codexText], newline)}${terminal}${newline}${newline}`);
    let cancelled = false;
    const signal = AbortSignal.timeout(1000);
    const result = await fakeCodex(async () => new Response(new ReadableStream({
      start(controller) {
        for (const byte of wire) {
          controller.enqueue(Uint8Array.of(byte));
          if (byte === 0x0d) controller.enqueue(new Uint8Array());
        }
      },
      cancel() { cancelled = true; },
    })), { signal }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseId, "synthetic-response");
    assert.equal(result.content[0].text, "Fixture café");
    assert.equal(cancelled, true);
  });
}

test("Codex fake SSE flushes the final data line at EOF", async () => {
  const wire = `${codexWire([codexCreated, ...codexText])}data: ${JSON.stringify(responsesDone)}`;
  const result = await fakeCodex(async () => new Response(wire)).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content[0].text, "Fixture café");
});

test("Codex fake SSE abort wakes a pending response body read", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let announceRead;
  const reading = new Promise(resolve => { announceRead = resolve; });
  let cancelled = false;
  const result = fakeCodex(async () => new Response(new ReadableStream({
    pull() { announceRead(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })), { signal: controller.signal }).result();
  await reading;
  controller.abort();
  assert.equal((await result).stopReason, "aborted");
  assert.equal(cancelled, true);
});

test("Codex fake SSE structured transient failure returns ownership to the session retry loop", async () => {
  const failure = { type: "response.failed", response: {
    id: "synthetic-response", status: "failed", error: { code: "server_error", message: "Fixture processing interruption" },
  } };
  let requests = 0;
  let admissions = 0;
  const attempt = () => fakeCodex(async () => new Response(codexWire(++requests === 1
    ? [codexCreated, failure]
    : [codexCreated, ...codexText, responsesDone])), { onPayload() { admissions++; } }).result();
  const result = await retryAssistantCall(attempt, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests, 2);
  assert.equal(admissions, 2);
});

test("a Codex failed terminal frame retains identity and usage without waiting for EOF", { timeout: 4000 }, async () => {
  const id = "synthetic-codex-terminal";
  for (const usage of [undefined, {input_tokens:12, output_tokens:3, total_tokens:15}]) {
    const failure = {type:"response.failed", response:{id, status:"failed", output:[null], usage,
      error:{code:"rate_limit_exceeded", message:"Fixture Codex failure"}}};
    let cancelled = false;
    const wire = new TextEncoder().encode(codexWire([failure]));
    const result = await fakeCodex(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(wire); },
      cancel() { cancelled = true; },
    })), {signal:AbortSignal.timeout(1500)}).result();
    assert.equal(result.responseId, id);
    assert.equal(result.stopReason, "error");
    assert.equal(result.rawStopReason, "failed");
    assert.equal(result.usage.input, usage?.input_tokens ?? 0);
    assert.match(result.errorMessage, /Fixture Codex failure/);
    assert.equal(isRetryableAssistantError(result), true);
    assert.equal(usesProviderCooldown(result), true);
    assert.equal(footerLabel(result), "sub");
    assert.equal(cancelled, true);
  }
});

test("Codex hosted work preserves subscription and possible extra charges", async () => {
  const fileSearch = {type:"response.file_search_call.completed", item_id:"synthetic-file-search", output_index:0};
  const result = await fakeCodex(async () => new Response(codexWire([fileSearch, hostedTerminal([hostedImage])]))).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.usage.cost.serverToolUse, {file_search_call:1, image_generation_call:1});
  assert.equal(result.usage.cost.serverToolCost, undefined);
  assert.equal(footerLabel(result), "sub+?");
});

test("Codex fake SSE in-band error codes preserve throttling, known terminal failures and default policy", async () => {
  for (const { code, message, retry, cooldown = false, overflow = false } of [
    { code: "rate_limit_exceeded", message: "Fixture processing interruption", retry: true, cooldown: true },
    { code: "invalid_prompt", message: "Fixture server error", retry: false },
    { code: "model_not_found", message: "Fixture server error", retry: false },
    { code: "invalid_api_key", message: "Fixture server error", retry: false },
    { code: "context_length_exceeded", message: "Fixture server error", retry: false, overflow: true },
    { code: "insufficient_quota", message: "Fixture server error", retry: false },
    { code: "server_errorish", message: "Fixture processing interruption", retry: false },
    { code: "unknown", message: "Fixture server error", retry: true },
  ]) {
    const frame = { type: "error", error: { code, message } };
    const result = await fakeCodex(async () => new Response(codexWire([codexCreated, frame]))).result();
    assert.equal(result.stopReason, "error", code);
    assert.equal(isRetryableAssistantError(result), retry, code);
    assert.equal(usesProviderCooldown(result), cooldown, code);
    assert.equal(isContextOverflow(result), overflow, code);
  }
});

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
