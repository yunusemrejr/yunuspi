import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import registerDesignStudio from "../agent/extensions/design-studio.ts";
import { streamSimple } from "../core/ai/src/api/openai-completions.js";
import { AgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from "../core/coding-agent/src/index.js";
import { collectSessionCost } from "../core/coding-agent/src/core/session-accounting.js";

const cases = [
  {mode:"complete", label:"$~0.000900", unknown:false, status:"completed"},
  {mode:"cancel with usage", label:"$~0.000900", unknown:false, status:"failed"},
  {mode:"cancel without usage", label:"$?", unknown:true, status:"failed"},
  {mode:"lose transport", label:"$?", unknown:true, status:"failed"},
];
for (const scenario of cases) {
  test(`image_understand settles the source SDK session after a fork: ${scenario.mode}`, {timeout:15_000}, t => verifyFork(t, scenario));
}

async function verifyFork(t, {mode, label, unknown, status}) {
  const cwd = await mkdtemp(join(tmpdir(), "vision-cost-fixture-"));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const png = join(cwd, "synthetic-source.png");
  await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:size=16x16", "-frames:v", "1", "-threads", "1", png]);
  const originalPng = await readFile(png);
  const dispatched = Promise.withResolvers(), finish = Promise.withResolvers(), waitingForTail = Promise.withResolvers();
  const cancellation = new AbortController();
  t.after(() => cancellation.abort());
  const cancelling = mode.startsWith("cancel");
  const model = {provider:"deepseek", id:"deepseek-v4-flash", name:"Synthetic vision fixture", api:"openai-completions",
    baseUrl:"https://api.deepseek.com/v1", input:["text","image"], reasoning:false, contextWindow:8192, maxTokens:2048,
    cost:{input:.3, output:1.2, cacheRead:.006, cacheWrite:0}};
  const providerId = "synthetic-vision-response";
  let posts = 0;
  const modelRuntime = {
    getModel:() => model, getAvailable:() => [model], hasConfiguredAuth:() => true, isUsingSubscription:() => false,
    streamSimple() { assert.fail("the fixture makes no primary model request"); },
    completeSimple(selected, context, options) {
      return streamSimple(selected, context, {...options, apiKey:"synthetic-fixture", maxRetries:0, fetch:async (url, init) => {
        assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
        assert.equal(init.method, "POST");
        assert.equal(JSON.parse(init.body).messages.at(-1).content.filter(item => item.type === "image_url").length, 1);
        posts++;
        dispatched.resolve();
        return finish.promise;
      }}).result();
    },
  };
  async function create(sessionManager) {
    let context;
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({cwd, agentDir:cwd, settingsManager, noExtensions:true, noSkills:true,
      noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[pi => {
        registerDesignStudio(pi);
        pi.on("session_start", (_event, ctx) => { context = ctx; });
      }]});
    await resourceLoader.reload();
    const runtime = await createAgentSession({cwd, agentDir:cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager, tools:[]});
    await runtime.session.bindExtensions({mode:"print"});
    return {...runtime, context, services:{cwd, agentDir:cwd}};
  }
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({role:"user", content:"Inspect the synthetic source", timestamp:1});
  manager.flush();
  const sourceFile = manager.getSessionFile();
  const original = await create(manager);
  const sourceLeaf = manager.getLeafId();
  const host = new AgentSessionRuntime(original.session, original.services, ({sessionManager}) => create(sessionManager));
  t.after(() => host.dispose());
  const tool = original.session.extensionRunner.getToolDefinition("image_understand");
  const invoke = tool.execute("paid-vision-fixture", {path:png, prompt:"Observe the color"}, cancellation.signal, undefined, original.context)
    .then(result => ({result}), error => ({error}));
  const readSource = () => SessionManager.open(sourceFile, cwd).getEntries();
  const forkEvents = [];
  let forkWhilePending;
  try {
    await Promise.race([dispatched.promise, invoke.then(value => assert.fail(value.error?.message ?? "vision ended before dispatch"))]);
    assert.equal(collectSessionCost(readSource()).pending, 1);
    const leaf = manager.getLeafId();
    assert.equal((await host.fork(leaf, {position:"at"})).cancelled, false);
    host.session.subscribe(event => forkEvents.push(event.type));
    forkWhilePending = collectSessionCost(host.session.sessionManager.getEntries());
  } finally {
    const created = Date.UTC(2026, 10, 17, 2) / 1_000;
    const chunks = [
      {id:providerId, created, choices:[{index:0, delta:{content:"Synthetic observations."}, finish_reason:null}], usage:null},
      {id:providerId, created, choices:[{index:0, delta:{content:""}, finish_reason:"stop"}],
        usage:{prompt_tokens:1_000, completion_tokens:500, total_tokens:1_500, prompt_cache_hit_tokens:0,
          prompt_cache_miss_tokens:1_000, prompt_tokens_details:{cached_tokens:0}}},
    ];
    if (mode === "complete") {
      finish.resolve(visionResponse([...chunks, "[DONE]"]));
    } else if (cancelling) {
      finish.resolve(visionResponse(mode === "cancel with usage" ? chunks : chunks.slice(0, 1), {waitingForTail}));
      await Promise.race([waitingForTail.promise, invoke.then(() => assert.fail("vision ended before cancellation"))]);
      cancellation.abort();
    } else {
      finish.resolve(visionResponse([], {transportFailure:true}));
    }
  }
  const result = await invoke;
  const entries = readSource();
  const source = collectSessionCost(entries), fork = collectSessionCost(host.session.sessionManager.getEntries());
  assert.deepEqual({
    posts, sourcePending:source.pending, sourceAmount:source.formatted, sourceUnknown:source.unknown,
    forkPending:forkWhilePending.pending, forkTotal:fork.total, forkUnknown:fork.unknown, forkRows:fork.rows,
  }, {posts:1,sourcePending:0,sourceAmount:label,sourceUnknown:unknown,
    forkPending:0,forkTotal:0,forkUnknown:false,forkRows:[]});
  if (mode === "complete") assert.equal(result.result?.details.observations, "Synthetic observations.");
  else if (cancelling) assert.equal(result.error?.name, "AbortError");
  else assert.match(result.error?.message ?? "", /Synthetic response transport lost/);
  const receipts = entries.filter(entry => entry.customType === "auxiliary-model-usage-v1");
  assert.deepEqual(receipts.map(entry => [entry.parentId, entry.accountingOnly, entry.data.status]), [
    [sourceLeaf,true,"pending"], [sourceLeaf,true,status],
  ]);
  assert.equal(receipts[0].data.id, receipts[1].data.id);
  assert.equal(receipts[1].data.toolCallId, "paid-vision-fixture");
  assert.equal(collectSessionCost([...entries, ...entries]).formatted, label);
  assert.ok(!forkEvents.includes("entry_appended"));
  assert.deepEqual(await readFile(png), originalPng);
  assert.deepEqual((await readdir(cwd)).filter(name => !name.endsWith(".jsonl")), ["synthetic-source.png"]);
}

function visionResponse(chunks, {waitingForTail, transportFailure = false} = {}) {
  const sse = chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  const headers = {"content-type":"text/event-stream"};
  if (transportFailure) {
    return new Response(new ReadableStream({start(controller) { controller.error(new Error("Synthetic response transport lost")); }}), {headers});
  }
  if (!waitingForTail) return new Response(sse, {headers});
  let first = true;
  return new Response(new ReadableStream({pull(controller) {
    if (first) {
      first = false;
      controller.enqueue(new TextEncoder().encode(sse));
    } else waitingForTail.resolve();
  }}, {highWaterMark:0}), {headers});
}
