// Regression: provider-visible history is append-only.
//
// A rendering chosen for a message must never change on a later request because
// *later* state changed (a distillation cache that filled after the fact, an
// evicted baseline, a shifted failure window). Rewriting an earlier message
// invalidates the provider cache prefix and re-bills the whole conversation.
// Measured live: session 2026-09-14T17-16-40-508Z went cacheRead 144256 ->
// 15104 with 144,866 uncached tokens on exactly the request where
// pi-observations.ts:context changed 4 earlier messages (299,096 chars).
//
// Sealing is per extension instance, which is per session, so every scenario
// drives ONE registered instance across both requests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/pi-observations.ts")),
);
const { default: register } = await import(
  pathToFileURL(path.join(agent, "extensions/pi-observations.ts"))
);

const ENV_KEYS = [
  "PI_OUTPUT_DISTILLER",
  "PI_LOCAL_INTELLIGENCE",
  "PI_SMOL_PREPROCESSOR",
  "PI_MINI_PREPROCESSOR",
];
const previous = ENV_KEYS.map((key) => process.env[key]);
process.env.PI_OUTPUT_DISTILLER = "on";
process.env.PI_LOCAL_INTELLIGENCE = "on";
delete process.env.PI_SMOL_PREPROCESSOR;
delete process.env.PI_MINI_PREPROCESSOR;
test.after(() => {
  for (const [index, value] of previous.entries()) {
    if (value === undefined) delete process.env[ENV_KEYS[index]];
    else process.env[ENV_KEYS[index]] = value;
  }
});

/** One registered extension instance with a controllable local cache. */
function session() {
  const handlers = new Map();
  const local = { value: undefined };
  const pi = {
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    getActiveTools: () => ["obs_read", "bash"],
  };
  register(
    pi,
    { reset: () => {}, endTurn: () => {}, select: async () => undefined },
    { reset: () => {}, endTurn: () => {}, offer: () => {}, take: () => local.value, takeAsync: async () => local.value },
  );
  return {
    local,
    request: (messages) => handlers.get("context")[0]({ messages }),
  };
}

function toolResult(id, raw) {
  return {
    role: "toolResult",
    toolCallId: `call_${id}`,
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: raw }],
    details: {
      exitCode: 0,
      piObservation: {
        version: 1,
        id,
        signature: `sig-${id}`,
        operation: `op-${id}`,
        resultHash: `hash-${id}`,
      },
    },
  };
}

const incompressible = "plain unstructured output line\n".repeat(40);

test("a sealed projection keeps its first bytes when local state changes", async () => {
  const s = session();
  s.local.value = '{"kind":"local-projection","v":1}';
  const first = await s.request([toolResult(1, incompressible)]);
  assert.ok(first, "the first exposure must be projected");
  const text = first.messages[0].content[0].text;
  assert.match(text, /^\[observation #1;/);
  assert.ok(text.includes('{"kind":"local-projection","v":1}'));

  s.local.value = '{"kind":"local-projection","v":2}';
  const again = await s.request([toolResult(1, incompressible)]);
  assert.ok(again, "the sealed projection is re-applied");
  assert.equal(
    again.messages[0].content[0].text,
    text,
    "an unchanged result must render byte-identically despite later local state",
  );
});

test("a message left raw is sealed as a decision, not upgraded later", async () => {
  const s = session();
  assert.equal(await s.request([toolResult(2, incompressible)]), undefined);
  s.local.value = '{"kind":"local-projection","appeared":"after the fact"}';
  assert.equal(
    await s.request([toolResult(2, incompressible)]),
    undefined,
    "a sealed raw rendering must not be rewritten once a cache entry exists",
  );
});

test("sealing is per observation: a new result is still projected", async () => {
  const s = session();
  assert.equal(await s.request([toolResult(3, incompressible)]), undefined);
  s.local.value = '{"kind":"local-projection","from":"cache"}';
  const second = await s.request([
    toolResult(3, incompressible),
    toolResult(4, incompressible),
  ]);
  assert.ok(second, "a new observation must still be projected");
  assert.equal(second.messages[0].content[0].text, incompressible);
  assert.match(second.messages[1].content[0].text, /^\[observation #4;/);
});
