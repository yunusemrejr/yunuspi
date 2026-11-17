import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "../core/ai/src/api/openai-responses.js";
import { metaProvider } from "../core/ai/src/providers/meta.js";
import { AuthStorage } from "../core/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../core/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../core/coding-agent/src/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/src/core/settings-manager.js";
import { createAgentSession } from "../core/coding-agent/src/core/sdk.js";
import { collectSessionCost } from "../core/coding-agent/src/core/session-accounting.js";

const origin = "https://api.meta.ai";
const metered = "synthetic-metered-key";
const subscription = "synthetic-subscription-token";
const meteredLabel = "$~0.000028";

for (const startsOnPlan of [false, true]) {
  test(`overlapping Meta sessions keep their ${startsOnPlan ? "initial plan" : "initial metered"} request billing across credential rotation`,
    {timeout:15_000}, t => verifyRotation(t, startsOnPlan));
}

async function verifyRotation(t, startsOnPlan) {
  const {runtime, openSession, holdPost, calls} = await fixture(t);
  if (!startsOnPlan) await runtime.setRuntimeApiKey("meta", metered);
  assert.equal(runtime.isUsingSubscription("meta"), startsOnPlan);
  const first = await openSession(), second = await openSession();
  const firstPost = holdPost(), secondPost = holdPost();
  const firstDone = first.prompt("First synthetic request.");
  let secondDone;
  try {
    assert.equal(await committed(firstPost, firstDone), startsOnPlan ? subscription : metered);
    if (startsOnPlan) await runtime.setRuntimeApiKey("meta", metered);
    else await runtime.removeRuntimeApiKey("meta");
    assert.equal(runtime.isUsingSubscription("meta"), !startsOnPlan);
    secondDone = second.prompt("Second synthetic request.");
    assert.equal(await committed(secondPost, secondDone), startsOnPlan ? metered : subscription);
    secondPost.finish.resolve(response("second"));
    await secondDone;
  } finally {
    firstPost.finish.resolve(response("first"));
    secondPost.finish.resolve(response("second"));
  }
  await firstDone;
  assert.equal(calls(), 2);
  const firstBilling = await reopenedBilling(first), secondBilling = await reopenedBilling(second);
  assert.deepEqual(firstBilling, startsOnPlan ? ["subscription", "sub"] : ["metered", meteredLabel]);
  assert.deepEqual(secondBilling, startsOnPlan ? ["metered", meteredLabel] : ["subscription", "sub"]);
}

test("a direct SDK request with an explicit API key records metered usage on an OAuth-configured runtime", {timeout:15_000}, async t => {
  const {runtime, model, holdPost, calls} = await fixture(t);
  const post = holdPost();
  assert.equal(runtime.isUsingSubscription("meta"), true);
  const done = runtime.completeSimple(model, {messages:[{role:"user", content:"Synthetic override.", timestamp:1}]}, {apiKey:metered});
  try {
    assert.equal(await committed(post, done), metered);
  } finally {
    post.finish.resolve(response("explicit-override"));
  }
  const message = await done;
  assert.equal(calls(), 1);
  assert.equal(message.usage.cost.billing, "metered");
  assert.equal(collectSessionCost([{type:"message", message}]).formatted, meteredLabel);
  assert.doesNotMatch(JSON.stringify(message), /synthetic-metered-key|synthetic-subscription-token/);
});

for (const [operation, expectedPosts, owner] of [["compaction", 2, "compaction"], ["branch navigation", 1, "branch-summary"]]) {
  test(`a native ${operation} preserves its resolved subscription bearer when the active key changes`, {timeout:15_000}, async t => {
    const {runtime, openSession, holdPost, calls} = await fixture(t);
    const session = await openSession(true);
    const manager = session.sessionManager;
    const firstUser = manager.getBranch().find(entry => entry.message?.role === "user").id;
    const posts = Array.from({length:expectedPosts}, holdPost);
    const done = operation === "compaction" ? session.compact() : session.navigateTree(firstUser, {summarize:true});
    try {
      assert.equal(await committed(posts[0], done), subscription);
      await runtime.setRuntimeApiKey("meta", metered);
      for (let index = 0; index < posts.length; index++) {
        const post = posts[index];
        assert.equal(await committed(post, done), subscription);
        post.finish.resolve(response(`summary-${index}`, "Synthetic retained summary."));
      }
    } finally {
      posts.forEach((post, index) => post.finish.resolve(response(`summary-${index}`, "Synthetic retained summary.")));
    }
    await done;
    assert.equal(calls(), expectedPosts);
    const file = manager.getSessionFile();
    const entries = SessionManager.open(file, session.cwd).getEntries();
    const attempts = entries.filter(entry => entry.customType === "auxiliary-model-usage-v1" && entry.data.owner === owner);
    const terminal = attempts.filter(entry => entry.data.status === "completed");
    assert.equal(terminal.length, expectedPosts);
    assert.ok(terminal.every(entry => entry.data.usage.costDetails.subscription && entry.data.usage.costDetails.estimated === 0));
    assert.equal(collectSessionCost(entries).formatted, "sub");
    assert.equal(collectSessionCost([...entries, ...entries]).formatted, "sub");
    assert.doesNotMatch(await readFile(file, "utf8"), /synthetic-metered-key|synthetic-subscription-token|synthetic-refresh-token/);
  });
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "request-billing-fixture-"));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const credentials = AuthStorage.inMemory({meta:{type:"oauth", access:subscription, refresh:"synthetic-refresh-token", expires:Date.now()+3_600_000}});
  const runtime = await ModelRuntime.create({credentials, modelsPath:null, allowModelNetwork:false});
  const pending = [];
  let requests = 0;
  runtime.registerNativeProvider({...metaProvider(), streamSimple(model, context, options) {
    return streamSimple(model, context, {...options, fetch:async (input, init) => {
      assert.equal(String(input), origin+"/v1/responses");
      assert.equal(init.method, "POST");
      assert.equal(JSON.parse(init.body).model, "muse-spark-1.3");
      const gate = pending[requests++];
      assert.ok(gate, "unexpected duplicate provider POST");
      const header = new Headers(init.headers).get("authorization");
      gate.arrived.resolve(header?.replace(/^Bearer /, ""));
      return gate.finish.promise;
    }});
  }});
  await runtime.whenRegistrationsRestored();
  const model = runtime.getModel("meta", "muse-spark-1.3");
  return {
    runtime, model, calls:() => requests,
    holdPost() {
      const gate = {arrived:Promise.withResolvers(), finish:Promise.withResolvers()};
      pending.push(gate);
      return gate;
    },
    async openSession(seedHistory = false) {
      const settingsManager = SettingsManager.inMemory({compaction:{enabled:false, keepRecentTokens:64, reserveTokens:128},
        retry:{enabled:false}, providerRetry:{maxRetries:0}});
      const resourceLoader = new DefaultResourceLoader({cwd, agentDir:cwd, settingsManager, noExtensions:true, noSkills:true,
        noContextFiles:true, noThemes:true, noPromptTemplates:true});
      await resourceLoader.reload();
      const sessionManager = SessionManager.create(cwd, cwd);
      if (seedHistory) {
        const usage = {input:12, output:3, totalTokens:15, cacheRead:0, cacheWrite:0,
          cost:{input:0, output:0, total:0, cacheRead:0, cacheWrite:0, billing:"subscription"}};
        for (let index = 0; index < 3; index++) {
          sessionManager.appendMessage({role:"user", content:"Synthetic history. ".repeat(70), timestamp:index*2+1});
          sessionManager.appendMessage({role:"assistant", content:[{type:"text", text:"Synthetic previous answer. ".repeat(100)}],
            timestamp:index*2+2, api:"openai-responses", provider:"meta", model:"muse-spark-1.3", stopReason:"stop", usage});
        }
        sessionManager.flush();
      }
      const {session} = await createAgentSession({cwd, agentDir:cwd, model, modelRuntime:runtime, settingsManager,
        resourceLoader, sessionManager, tools:[]});
      t.after(() => session.dispose());
      return session;
    },
  };
}

async function reopenedBilling(session) {
  const file = session.sessionManager.getSessionFile();
  const entries = SessionManager.open(file, session.cwd).getEntries();
  const message = entries.find(entry => entry.message?.role === "assistant")?.message;
  assert.equal(message?.stopReason, "stop", message?.errorMessage);
  assert.doesNotMatch(await readFile(file,"utf8"), /synthetic-metered-key|synthetic-subscription-token|synthetic-refresh-token/);
  return [message.usage.cost.billing, collectSessionCost(entries).formatted];
}

function committed(gate, done) {
  return Promise.race([gate.arrived.promise, done.then(() => assert.fail("request ended before dispatch"))]);
}

function response(id, text) {
  const responseId = "synthetic-response-"+id;
  const item = {type:"message", id:"synthetic-item-"+id, role:"assistant", content:[]};
  const frames = text ? [
    {type:"response.created", response:{id:responseId, status:"in_progress"}},
    {type:"response.output_item.added", output_index:0, item},
    {type:"response.content_part.added", item_id:item.id, output_index:0, content_index:0, part:{type:"output_text", text:"", annotations:[]}},
    {type:"response.output_text.delta", item_id:item.id, output_index:0, content_index:0, delta:text},
  ] : [];
  frames.push({
    type:"response.completed",
    response:{id:responseId, status:"completed", output:[],
      usage:{input_tokens:12, output_tokens:3, total_tokens:15, input_tokens_details:{cached_tokens:0}}},
  });
  const result = new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    {headers:{"content-type":"text/event-stream"}});
  Object.defineProperty(result, "url", {value:origin+"/v1/responses"});
  return result;
}
