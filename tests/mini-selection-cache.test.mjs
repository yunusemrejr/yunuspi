import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
 fs.existsSync(path.join(p, "extensions/lib/mini-preprocessor.ts")),
);
const { createMiniPreprocessor, miniSource } = await import(
 pathToFileURL(path.join(agent, "extensions/lib/mini-preprocessor.ts"))
);
const runtime = {
 version: 1,
 enabled: true,
 endpoint: "http://127.0.0.1:18736/select",
 apiKey: "TEST_MINI_PREPROCESSOR_KEY_1234567890",
};
const fact =
 "The current status remains blocked until verification confirms the deployment result.";
const filler =
 "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
const raw = [fact, ...Array(9).fill(filler)].join("\n\n");
const selection = (text) => ({
 version: 1,
 status: "SELECT",
 sourceHash: miniSource(text).hash,
 keep: [0],
});

test("validated source selections save repeat inference, resist mutation and reset with the branch", async () => {
 let calls = 0,
  now = 0;
 const c = createMiniPreprocessor({
  runtime,
  now: () => now,
  fetch: async (_url, o) => {
   calls++;
   return new Response(JSON.stringify(selection(JSON.parse(o.body).raw)));
  },
 });
 const first = await c.select(raw, 0);
 assert.deepEqual(first, selection(raw));
 first.keep.push(1);
 assert.deepEqual(await c.select(raw, 0), selection(raw));
 assert.equal(calls, 1);
 assert.equal(c.inspect().cacheHits, 1);
 const changed = raw.replace("blocked", "pending");
 assert.equal(
  await c.select(changed, 0),
  undefined,
  "different source cannot use cached IDs",
 );
 now = 10000;
 assert.deepEqual(await c.select(changed, 0), selection(changed));
 assert.equal(calls, 2);
 c.reset();
 assert.equal(c.inspect().cached, 0);
 assert.equal(await c.select(raw, 0), undefined, "reset preserves cooldown");
 now = 20000;
 assert.deepEqual(await c.select(raw, 0), selection(raw));
 assert.equal(calls, 3);
 for (let i = 0; i < 20; i++) {
  now += 10000;
  await c.select(raw.replace("status", `status ${i}`), 0);
 }
 assert.equal(c.inspect().cached, 16, "cache storage is bounded");
 assert.ok(c.inspect().projectedSavedChars > 0);
});

test("worker failures back off without turning unavailable or malformed output into a selection", async () => {
 let calls = 0,
  now = 0,
  healthy = false;
 const c = createMiniPreprocessor({
  runtime,
  now: () => now,
  fetch: async () => {
   calls++;
   return new Response(
    JSON.stringify(
     healthy ? selection(raw) : { version: 1, status: "MALFORMED" },
    ),
   );
  },
 });
 assert.equal(await c.select(raw, 0), undefined);
 assert.equal(c.inspect().cooldownMs, 20000);
 now = 10000;
 assert.equal(await c.select(raw, 0), undefined);
 assert.equal(calls, 1);
 now = 20000;
 assert.equal(await c.select(raw, 0), undefined);
 assert.equal(calls, 2);
 assert.equal(c.inspect().cooldownMs, 40000);
 now = 60000;
 healthy = true;
 assert.deepEqual(await c.select(raw, 0), selection(raw));
 assert.equal(c.inspect().cooldownMs, 10000);
 assert.equal(c.inspect().fallbacks, 2);
 assert.equal(c.inspect().accepted, 1);
});

test("noncooperative inference remains bounded and stale completions cannot populate the cache", async () => {
 let finish;
 const c = createMiniPreprocessor({
  runtime,
  fetch: () => new Promise((r) => (finish = r)),
 });
 const work = c.select(raw, 0);
 c.reset();
 finish(new Response(JSON.stringify(selection(raw))));
 assert.equal(await work, undefined);
 assert.equal(c.inspect().cached, 0);
 const hold = setTimeout(() => {}, 1000),
  started = performance.now();
 try {
  const stuck = createMiniPreprocessor({
   runtime,
   fetch: () => new Promise(() => {}),
  });
  assert.equal(await stuck.select(raw, 0), undefined);
  assert.ok(performance.now() - started < 900);
  assert.equal(stuck.inspect().busy, false);
 } finally {
  clearTimeout(hold);
 }
});

const { createSmolPreprocessor, validSmolRuntime } = await import(
 pathToFileURL(path.join(agent, "extensions/lib/smol-preprocessor.ts"))
);
const smolRuntime = {
 version: 2,
 enabled: true,
 model: "Qwen3.5-0.8B",
 endpoint: "http://127.0.0.1:18736/completion",
 apiKey: "TEST_SYNTHETIC_LOCAL_KEY",
 execution: "background",
 timeoutMs: 1000,
};
const lineRaw = [
 "Build completed: source bundles are ready.",
 ...Array(30).fill(
  "Background prose describes a typical compilation workspace and routine intermediate processing stages.",
 ),
 "Summary: deployment remains pending external verification.",
].join("\n");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("declined local lease does not claim Smol inference ran", async () => {
 const key = Symbol.for('yunus-pi.health.v1'), before = globalThis[key], events = [];
 globalThis[key] = (kind, data) => events.push({kind, data});
 try {
  const client = createSmolPreprocessor({runtime: smolRuntime, acquireLease: async () => false,
   fetch: async () => { throw Error('a declined lease must not call inference'); }});
  client.offer('unleased', lineRaw, 0);
  await flush();
  assert.equal(client.inspect().requests, 0);
  assert.ok(events.some(event => event.kind === 'ml.smol.offer' && event.data.decision === 'no-lease'));
  assert.equal(events.filter(event => event.kind === 'ml.smol.inference').length, 0);
  client.reset();
 } finally { if (before === undefined) delete globalThis[key]; else globalThis[key] = before; }
});

test("background SLM freezes first exposure and reuses validated source/task cache without more inference", async () => {
 let finish,
  calls = 0,
  signal;
 const client = createSmolPreprocessor({
  runtime: smolRuntime,
  acquireLease: async () => true,
  fetch: async (_url, options) => {
   calls++;
   signal = options.signal;
   return new Promise((resolve) => (finish = resolve));
  },
 });
 assert.equal(validSmolRuntime(smolRuntime), true);
 assert.equal(validSmolRuntime({ ...smolRuntime, timeoutMs: 8001 }), false);
 assert.equal(validSmolRuntime({ ...smolRuntime, model: "SmolLM2-135M-Instruct" }), false, "the retired model is never loaded");
 client.offer("first", lineRaw, 0);
 await flush();
 assert.equal(
  client.take("first", lineRaw),
  undefined,
  "pending selection immediately exposes original",
 );
 assert.equal(
  signal.aborted,
  false,
  "first exposure preserves background work for a later source",
 );
 finish(
  new Response(
   JSON.stringify({ content: '{"status":"SELECT","lineIds":[2]}' }),
  ),
 );
 await flush();
 assert.equal(
  client.take("first", lineRaw),
  undefined,
  "late completion never rewrites first exposure",
 );
 client.offer("later", lineRaw, 0);
 const selected = JSON.parse(client.take("later", lineRaw));
 assert.deepEqual(
  selected.lines.map((line) => line.id),
  [1, 2, 32],
  "protected boundary evidence is unioned independently",
 );
 for (const line of selected.lines)
  assert.equal(lineRaw.slice(line.start, line.end), line.text);
 assert.equal(
  client.take("later", lineRaw + " changed"),
  undefined,
  "wrong source cannot use cached evidence",
 );
 assert.equal(calls, 1);
 assert.equal(client.inspect().cacheHits, 1);
 client.offer("different-task", lineRaw, 0, "intermediate processing");
 assert.equal(
  client.take("different-task", lineRaw),
  undefined,
  "task changes cannot reuse prior selection",
 );
 client.reset();
 assert.equal(client.inspect().cached, 0);
});

test("background SLM rejects invented IDs, unknown outputs, poor savings and aborts noncooperative work", async () => {
 for (const content of [
  '{"status":"SELECT","lineIds":[999]}',
  '{"status":"UNKNOWN","lineIds":[]}',
  '{"status":"SELECT","lineIds":[1],"claim":"invented"}',
  JSON.stringify({
   status: "SELECT",
   lineIds: Array.from({ length: 16 }, (_, i) => i + 1),
  }),
 ]) {
  const client = createSmolPreprocessor({
   runtime: smolRuntime,
   acquireLease: async () => true,
   fetch: async () => new Response(JSON.stringify({ content })),
  });
  client.offer("first", lineRaw, 0);
  await flush();
  assert.equal(client.take("first", lineRaw), undefined);
  assert.equal(client.inspect().cached, 0);
 }
 let signal;
 const client = createSmolPreprocessor({
  runtime: smolRuntime,
  acquireLease: async () => true,
  fetch: async (_url, options) => {
   signal = options.signal;
   return new Promise(() => {});
  },
 });
 client.offer("first", lineRaw, 0);
 await flush();
 client.reset();
 await flush();
 assert.equal(signal.aborted, true);
 assert.equal(
  client.inspect().busy,
  false,
  "reset settles a fetch that ignores cancellation",
 );
});

test("native observation consumer uses background SLM alongside Kompress without duplicate work", async () => {
 const { default: register } = await import(
  pathToFileURL(path.join(agent, "extensions/pi-observations.ts"))
 );
 let finish;
 const client = createSmolPreprocessor({
  runtime: smolRuntime,
  acquireLease: async () => true,
  fetch: async () => new Promise((resolve) => (finish = resolve)),
 });
 const handlers = {},
  tools = {},
  entries = [];
 let miniCalls = 0;
 const pi = {
  registerCommand() {},
  on: (name, fn) => {
   handlers[name] = fn;
  },
  registerTool: (tool) => {
   tools[tool.name] = tool;
  },
  getActiveTools: () => ["bash", "read", "obs_read"],
 };
 register(
  pi,
  {
   reset() {},
   endTurn() {},
   select() {
    miniCalls++;
    throw Error("structured lines must not run Kompress");
   },
  },
  client,
 );
 const ctx = {
  model: { cost: { input: 0 } },
  sessionManager: { getEntries: () => entries, getBranch: () => entries },
 };
 handlers.session_start({}, ctx);
 async function observe(id) {
  const event = {
   toolName: "bash",
   toolCallId: id,
   input: { command: id },
   content: [{ type: "text", text: lineRaw }],
   isError: false,
   details: { exitCode: 0 },
  };
  const patch = await handlers.tool_result(event, ctx);
  const message = {
   role: "toolResult",
   toolName: "bash",
   toolCallId: id,
   content: event.content,
   isError: false,
   details: patch.details,
  };
  entries.push({ type: "message", message });
  handlers.message_end({ message });
  return message;
 }
 const first = await observe("synthetic-first");
 await flush();
 assert.equal(
  ((await handlers.context({ messages: [first] }, ctx))?.messages ?? [first])[0]
   .content[0].text,
  lineRaw,
  "native first exposure is immediate raw",
 );
 finish(
  new Response(
   JSON.stringify({ content: '{"status":"SELECT","lineIds":[2]}' }),
  ),
 );
 await flush();
 const later = await observe("synthetic-later");
 const projected = (await handlers.context({ messages: [later] }, ctx)).messages[0]
  .content[0].text;
 assert.ok(projected.length < lineRaw.length - 1000);
 assert.match(projected, /deployment remains pending/);
 assert.equal(
  ((await handlers.context({ messages: [first] }, ctx))?.messages ?? [first])[0]
   .content[0].text,
  lineRaw,
  "original provider prefix stays raw",
 );
 assert.equal(
  later.content[0].text,
  lineRaw,
  "transcript retains exact original",
 );
 const recovered = await tools.obs_read.execute(
  "recover",
  { id: later.details.piObservation.id },
  undefined,
  undefined,
  ctx,
 );
 assert.equal(recovered.content[0].text, lineRaw);
 assert.equal(miniCalls, 0);
 assert.equal(client.inspect().requests, 1);
});
