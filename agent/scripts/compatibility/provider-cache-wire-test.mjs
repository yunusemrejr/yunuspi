import {resolveOwnedCore} from "../lib/owned-core.mjs";
import {createToolJsonCompactor} from '../../extensions/lib/compact-tool-json.ts';
// Offline protocol-family cache accounting + real SDK request-count regression.
// Only synthetic fetch responses and an ephemeral loopback HTTP server; no keys or prompts leave the host.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-provider-cache-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_OFFLINE = "1";
const core = resolveOwnedCore();
const aiRoot = path.join(core, "../ai/dist");
const sdk = await import(path.join(core, "dist/index.js")),
 ai = await import(path.join(aiRoot, "index.js"));
const chat = await import(path.join(aiRoot, "api/openai-completions.js"));
const responses = await import(path.join(aiRoot, "api/openai-responses.js"));
const anthropic = await import(path.join(aiRoot, "api/anthropic-messages.js"));
const model = {
 id: "fixture",
 name: "fixture",
 provider: "openai",
 api: "openai-completions",
 baseUrl: "https://fixture.invalid/v1",
 reasoning: false,
 input: ["text"],
 cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
 contextWindow: 128000,
 maxTokens: 4096,
};
const context = {
 systemPrompt: "Fixed fixture instructions",
 messages: [{ role: "user", content: "fixture", timestamp: 1 }],
};
const chunk = (usage) => ({
 id: "fixture",
 object: "chat.completion.chunk",
 created: 1,
 model: "fixture",
 choices: [
  {
   index: 0,
   delta: { role: "assistant", content: "ok" },
   finish_reason: "stop",
  },
 ],
 usage,
});
const chatSse = (usage) =>
 "data: " + JSON.stringify(chunk(usage)) + "\n\ndata: [DONE]\n\n";
function stub(body, status = 200) {
 const requests = [];
 const headers = [];
 return {
  requests,
  headers,
  fetch: async (url, options) => {
   try {
    assert.ok(["fixture.invalid", "openrouter.ai", "api.deepinfra.com", "api.deepseek.com", "api.openai.com"].includes(new URL(url).hostname));
    requests.push(JSON.parse(options.body));
    headers.push(new Headers(options.headers));
    return new Response(body, {
     status,
     headers: {
      "content-type": status === 200 ? "text/event-stream" : "application/json",
     },
    });
   } catch (error) {
    throw new Error("Invalid synthetic request", { cause: error });
   }
  },
 };
}
let session, server;
try {
 // Capture the actual HTTP serializer after lossless context compaction.
 const rawToolText=JSON.stringify({rows:Array.from({length:80},(_,id)=>({id,text:'keep  spacing'}))},null,2);
 const history=[...context.messages,
   {role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:2,stopReason:'toolUse',content:[{type:'toolCall',id:'wire-fixture',name:'sqlite_probe',arguments:{path:'fixture.sqlite',action:'tables'}}]},
   {role:'toolResult',toolCallId:'wire-fixture',toolName:'sqlite_probe',timestamp:3,isError:false,content:[{type:'text',text:rawToolText}]}];
 const transformed=createToolJsonCompactor().transform(history);
 const compactMock=stub(chatSse({prompt_tokens:100,completion_tokens:1}));
 const compactResult=await chat.stream(model,{...context,messages:transformed,tools:[{name:'sqlite_probe',description:'fixture',parameters:{type:'object',properties:{}}}]},{apiKey:'TEST_fixture-only',fetch:compactMock.fetch,maxRetries:0}).result();
 assert.equal(compactResult.stopReason,'stop',compactResult.errorMessage);
 assert.equal(compactMock.requests.length,1,'one provider call per successful generation');
 const wireTools=compactMock.requests[0].messages.filter(m=>m.role==='tool');
 assert.equal(wireTools.length,1,'tool result is serialized exactly once');
 assert.equal(wireTools[0].content,transformed.at(-1).content[0].text);
 assert.deepEqual(JSON.parse(wireTools[0].content),JSON.parse(rawToolText));
 assert.ok(wireTools[0].content.length<rawToolText.length*.8);
 assert.equal(history.at(-1).content[0].text,rawToolText);
 console.log('PASS actual provider wire: one fetch, one compact tool result, full evidence preserved');
 // Same-model reasoning must survive final-answer turns as well as tool turns.
 // This exercises the actual SDK serializer, never contacts a provider.
 const deepseekModel = {...model,id:"deepseek-flash",provider:"deepseek",baseUrl:"https://api.deepseek.com/v1",reasoning:true,
   thinkingLevelMap:{off:"none",low:"low",medium:"high",high:"high",max:"max"}};
 const prior = (text, thinking, timestamp) => ({role:"assistant",api:deepseekModel.api,provider:"deepseek",model:"deepseek-flash",timestamp,
   stopReason:"stop",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
   content:[{type:"thinking",thinking,thinkingSignature:"reasoning_content"},{type:"text",text}]});
 const dmock=stub(chatSse({prompt_tokens:10,completion_tokens:1}));
 const dresult=await chat.stream(deepseekModel,{...context,messages:[...context.messages,prior("first answer","exact prior reasoning\nwith spaces",2),{role:"user",content:"continue",timestamp:3}],
   tools:[{name:"check",description:"fixture",parameters:{type:"object",properties:{}}}]},
   {apiKey:"TEST_fixture-only",fetch:dmock.fetch,reasoningEffort:"medium",maxRetries:0}).result();
 assert.notEqual(dresult.stopReason,"error",dresult.errorMessage);
 assert.equal(dmock.requests[0].messages.find(m=>m.role==="assistant").reasoning_content,"exact prior reasoning\nwith spaces");
 assert.deepEqual(dmock.requests[0].thinking,{type:"enabled"});
 assert.equal(dmock.requests[0].reasoning_effort,"high");
 console.log("PASS DeepSeek Flash exact prior-final reasoning replay and mapped thinking wire");
 for (const [name, usage] of [
  [
   "OpenAI / GLM / Qwen compatible",
   {
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
   },
  ],
  [
   "DeepSeek",
   {
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
   },
  ],
  [
   "top-level cached tokens",
   { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 80 },
  ],
 ]) {
  const mock = stub(chatSse(usage));
  const result = await chat
   .stream(model, context, {
    apiKey: "TEST_fixture-only",
    fetch: mock.fetch,
    sessionId: "stable-fixture",
    maxRetries: 0,
   })
   .result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(mock.requests.length, 1);
  assert.equal(result.usage.cacheRead, 80);
  assert.equal(
   result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
   100,
  );
  assert.equal(result.usage.totalTokens, 105);
  assert.equal(mock.requests[0].stream_options?.include_usage, true);
  console.log(
   "PASS " + name + " cache normalization, no double counting, one fetch",
  );
 }
 const deepinfraMock=stub(chatSse({prompt_tokens:100,completion_tokens:20,cached_tokens:80,reasoning_tokens:12,estimated_cost:0.00123456}));
 const deepinfraResult=await chat.stream({...model,provider:'deepinfra',baseUrl:'https://api.deepinfra.com/v1/openai'},context,{apiKey:'TEST_fixture-only',fetch:deepinfraMock.fetch,sessionId:'deepinfra-stable'}).result();
 assert.equal(deepinfraResult.stopReason,'stop',deepinfraResult.errorMessage);
 assert.equal(deepinfraResult.usage.cost.source,'provider-estimate');
 assert.equal(deepinfraResult.usage.cost.total,0.00123456);
 assert.equal(deepinfraResult.usage.reasoning,12);
 assert.equal(deepinfraResult.usage.totalTokens,120);
 assert.equal(deepinfraMock.requests.length,1);
 assert.equal(deepinfraMock.requests[0].prompt_cache_key,undefined);
 assert.equal(deepinfraMock.requests[0].prompt_cache_options,undefined);
 console.log('PASS installed DeepInfra driver retains provider estimate and reasoning breakdown');
 // Preserve numeric compatibility while recording missing versus explicit zero.
 for (const extra of [{}, { prompt_tokens_details: { cached_tokens: 0 } }]) {
  const mock = stub(
   chatSse({ prompt_tokens: 100, completion_tokens: 5, ...extra }),
  );
  const result = await chat
   .stream(model, context, { apiKey: "TEST_fixture-only", fetch: mock.fetch })
   .result();
  assert.equal(result.usage.cacheRead, 0);
  assert.equal(result.usage.cacheReadReported, !!extra.prompt_tokens_details);
 }
 const routerMock = stub(chatSse({prompt_tokens:100,completion_tokens:5,prompt_tokens_details:{cached_tokens:80},cost:0.0042}));
 const routerModel={...model,provider:"openrouter",baseUrl:"https://openrouter.ai/api/v1",compat:{sendSessionAffinityHeaders:true}};
 for(let i=0;i<2;i++){
  const result=await chat.stream(routerModel,context,{apiKey:"TEST_fixture-only",fetch:routerMock.fetch,sessionId:"stable-router",maxRetries:0}).result();
  assert.equal(result.stopReason,"stop",result.errorMessage);
  assert.equal(result.usage.cost.total,0.0042);
  assert.equal(result.usage.cost.source,"provider-reported");
  assert.equal(result.usage.cacheReadReported,true);
 }
 assert.equal(routerMock.requests.length,2);
 assert.equal(routerMock.headers[0].get("x-session-id"),"stable-router");
 assert.equal(routerMock.headers[1].get("x-session-id"),"stable-router");
 console.log("PASS OpenRouter wire retains stable affinity and provider-reported charge without probes");
 const responseEvent = {
  type: "response.completed",
  response: {
   id: "resp_fixture",
   model: "fixture",
   status: "completed",
   output: [],
   usage: {
    input_tokens: 100,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens_details: { reasoning_tokens: 0 },
   },
  },
 };
 const mock = stub(
  "event: response.completed\ndata: " + JSON.stringify(responseEvent) + "\n\n",
 );
 for (let i = 0; i < 2; i++) {
  const result = await responses
   .stream({ ...model, api: "openai-responses" }, context, {
    apiKey: "TEST_fixture-only",
    fetch: mock.fetch,
    sessionId: "stable-fixture",
    cacheRetention: "short",
    maxRetries: 0,
   })
   .result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.cacheReadReported, true);
  assert.equal(result.usage.cacheRead, 80);
 }
 assert.equal(mock.requests[0].prompt_cache_key, "stable-fixture");
 assert.equal(mock.requests[1].prompt_cache_key, "stable-fixture");
 console.log("PASS Responses accounting and stable per-session cache key");
 // Responses-compatible gateways must retain their own billed amount, including zero.
 for (const amount of [0,0.0042]) {
  const event={...responseEvent,response:{...responseEvent.response,usage:{...responseEvent.response.usage,cost:amount,cost_details:{upstream_inference_cost:10}}}};
  const wire=stub('event: response.completed\ndata: '+JSON.stringify(event)+'\n\n');
  const out=await responses.stream({...routerModel,api:'openai-responses'},context,{apiKey:'TEST_fixture-only',fetch:wire.fetch,maxRetries:0}).result();
  assert.equal(out.usage.cost.total,amount);assert.equal(out.usage.cost.source,'provider-reported');assert.equal(out.usage.cost.upstreamInferenceCost,10);
 }
 // The response's effective tier overrides the requested tier; never charge a
 // downgraded request at priority prices. Pricing metadata stays on the response.
 for (const [returned,requested,multiplier] of [['fast','fast',1.8],['default','fast',1],['flex','flex',.5]]) {
  const event={...responseEvent,response:{...responseEvent.response,service_tier:returned}};
  const wire=stub('event: response.completed\ndata: '+JSON.stringify(event)+'\n\n');
  const m={...model,id:'gpt-5-mini',baseUrl:'https://api.openai.com/v1',api:'openai-responses',cost:{input:.25,output:2,cacheRead:.025,cacheWrite:0}};
  const out=await responses.stream(m,context,{apiKey:'TEST_fixture-only',fetch:wire.fetch,serviceTier:requested,maxRetries:0}).result();
  assert.ok(Math.abs(out.usage.cost.total-0.000017*multiplier)<1e-12);
  assert.equal(out.usage.cost.serviceTier,returned);assert.equal(out.usage.cost.model,'gpt-5-mini');
 }
 console.log('PASS Responses reported charges and effective OpenAI model-specific fast/flex tiers');
 const chatFast=stub('data: '+JSON.stringify({...chunk({prompt_tokens:100,completion_tokens:5,prompt_tokens_details:{cached_tokens:80}}),service_tier:'fast'})+'\n\ndata: [DONE]\n\n');
 const chatFastResult=await chat.stream({...model,id:'gpt-4o-mini',baseUrl:'https://api.openai.com/v1',cost:{input:.15,output:.6,cacheRead:.075,cacheWrite:0}},context,{apiKey:'TEST_fixture-only',fetch:chatFast.fetch,samplingParams:{service_tier:'fast'},maxRetries:0}).result();
 assert.ok(Math.abs(chatFastResult.usage.cost.total-.000020)<1e-12);
 assert.equal(chatFastResult.usage.cost.serviceTier,'fast');
 console.log('PASS Chat Completions effective service-tier pricing');


 const events = [
  {
   type: "message_start",
   message: {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "fixture",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
     input_tokens: 10,
     output_tokens: 0,
     cache_read_input_tokens: 80,
     cache_creation_input_tokens: 10,
    },
   },
  },
  {
   type: "content_block_start",
   index: 0,
   content_block: { type: "text", text: "" },
  },
  {
   type: "content_block_delta",
   index: 0,
   delta: { type: "text_delta", text: "ok" },
  },
  { type: "content_block_stop", index: 0 },
  {
   type: "message_delta",
   delta: { stop_reason: "end_turn", stop_sequence: null },
   usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
 ];
 const amock = stub(
  events
   .map((e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n")
   .join(""),
 );
 const ar = await anthropic
  .stream(
   { ...model, provider: "anthropic", api: "anthropic-messages" },
   context,
   {
    apiKey: "TEST_fixture-only",
    fetch: amock.fetch,
    cacheRetention: "short",
    maxRetries: 0,
   },
  )
  .result();
 assert.equal(ar.stopReason, "stop", ar.errorMessage);
 assert.equal(ar.usage.input, 10);
 assert.equal(ar.usage.cacheRead, 80);
 assert.equal(ar.usage.cacheWrite, 10);
 assert.equal(ar.usage.totalTokens, 105);
 assert.equal(amock.requests.length, 1);
 assert.ok(
  JSON.stringify(amock.requests[0]).includes("cache_control"),
  "Anthropic cache breakpoint retained",
 );
 console.log(
  "PASS Anthropic separate read/write accounting and cache breakpoint",
 );
 for (const driver of [chat, responses, anthropic]) {
  const bad = stub(
   JSON.stringify({
    error: { message: "Too Many Requests", type: "rate_limit_error" },
   }),
   429,
  );
  const m =
   driver === chat
    ? model
    : driver === responses
      ? { ...model, api: "openai-responses" }
      : { ...model, provider: "anthropic", api: "anthropic-messages" };
  const result = await driver
   .stream(m, context, { apiKey: "TEST_fixture-only", fetch: bad.fetch })
   .result();
  assert.equal(result.stopReason, "error");
  assert.equal(
   bad.requests.length,
   1,
   "default provider retry must not amplify requests",
  );
 }
 console.log(
  "PASS all three driver families: default 429 produces exactly one HTTP attempt",
 );
 let count = 0,
  mode = "recover";
 server = http.createServer(async (req, res) => {
  for await (const ignored of req) void ignored;
  count++;
  if (mode === "429" || count === 1) {
   res.writeHead(mode === "429" ? 429 : 500, {
    "content-type": "application/json",
   });
   res.end(
    JSON.stringify({
     error: {
      message: mode === "429" ? "Too Many Requests" : "Internal server error",
     },
    }),
   );
  } else {
   res.writeHead(200, { "content-type": "text/event-stream" });
   res.end(
    chatSse({
     prompt_tokens: 100,
     completion_tokens: 5,
     prompt_tokens_details: { cached_tokens: 80 },
    }),
   );
  }
 });
 await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
 const runtime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(),
  modelsPath: path.join(root, "models.json"),
  modelsStorePath: path.join(root, "models-store.json"),
 });
 await runtime.setRuntimeApiKey("openai", "TEST_fixture-only");
 const settings = sdk.SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: {
   enabled: true,
   maxRetries: 1,
   baseDelayMs: 1,
   provider: { maxRetries: 0 },
  },
 });
 const loader = new sdk.DefaultResourceLoader({
  cwd: root,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
 });
 await loader.reload();
 ({ session } = await sdk.createAgentSession({
  cwd: root,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  resourceLoader: loader,
  modelRuntime: runtime,
  model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
  settingsManager: settings,
  sessionManager: sdk.SessionManager.create(root, path.join(root, "sessions")),
  noTools: "all",
 }));
 await session.prompt("synthetic fixture");
 assert.equal(
  count,
  2,
  "one failed request plus exactly one successful outer retry",
 );
 mode = "429";
 const before = count;
 const off = session.subscribe((e) => {
  if (e.type === "auto_retry_start") session.abortRetry();
 });
 await session.prompt("synthetic cancelled retry");
 off();
 assert.equal(count - before, 1, "Stop must prevent a second HTTP request");
 assert.ok(
  session.sessionManager
   .getEntries()
   .some(
    (e) =>
     e.type === "custom" &&
     e.customType === "harness-retry" &&
     e.data.status === "cancelled",
   ),
 );
 mode = "recover";
 count = 0;
 await session.prompt("synthetic fresh prompt");
 assert.equal(count, 2, "new user prompt rearms after cancellation");
 console.log(
  "PASS real SDK + loopback: no nested request multiplier, immediate Stop, persisted cancel cause, fresh prompt recovery",
 );
 // A completed catalog update reaches the selected route before the next prompt.
 runtime.registerProvider("openai", {api:"openai-completions",baseUrl:`http://127.0.0.1:${server.address().port}/v1`,
  models:[{...model,maxTokens:2048,contextWindow:64000,reasoning:true,
   thinkingLevelMap:{off:null,minimal:null,low:null,medium:null,high:"high",xhigh:null,max:null}}]});
 await runtime.refresh({allowNetwork:false,providers:["openai"]});
 await session.prompt("synthetic refreshed capabilities");
 assert.equal(session.model.maxTokens,2048);
 assert.equal(session.model.contextWindow,64000);
 assert.equal(session.thinkingLevel,"high");
 console.log("PASS selected session adopts refreshed capacities and reasoning without changing route");
} finally {
 session?.dispose();
 if (server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
 }
 await fs.rm(root, { recursive: true, force: true });
}
