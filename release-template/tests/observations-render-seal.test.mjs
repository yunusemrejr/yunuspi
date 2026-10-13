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
  "PI_MINI_PREPROCESSOR",
];
const previous = ENV_KEYS.map((key) => process.env[key]);
process.env.PI_OUTPUT_DISTILLER = "on";
process.env.PI_LOCAL_INTELLIGENCE = "on";
delete process.env.PI_MINI_PREPROCESSOR;
test.after(() => {
  for (const [index, value] of previous.entries()) {
    if (value === undefined) delete process.env[ENV_KEYS[index]];
    else process.env[ENV_KEYS[index]] = value;
  }
});

const { miniSource } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/mini-preprocessor.ts"))
);

/** One registered extension instance. Kompress selections arrive on each tool
 * result's details, as the tool_result hook attaches them in production. */
function session() {
  const handlers = new Map();
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
  register(pi, { reset: () => {}, endTurn: () => {}, select: async () => undefined });
  return {
    request: (messages) => handlers.get("context")[0]({ messages }),
  };
}

function toolResult(id, raw, selection) {
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
      ...(selection ? { piMiniSelection: selection } : {}),
    },
  };
}

const filler =
  "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
const document = [
  "Deployment remains blocked until external verification.",
  ...Array(9).fill(filler),
].join("\n\n");
const select = (keep) => ({
  version: 1,
  status: "SELECT",
  sourceHash: miniSource(document).hash,
  keep,
});

test("a sealed projection keeps its first bytes when a later selection arrives", async () => {
  const s = session();
  const first = await s.request([toolResult(1, document, select([0]))]);
  assert.ok(first, "the first exposure must be projected");
  const text = first.messages[0].content[0].text;
  assert.match(text, /^\[observation #1;/);
  assert.ok(text.includes("Deployment remains blocked until external verification."));

  const again = await s.request([toolResult(1, document, select([1]))]);
  assert.ok(again, "the sealed projection is re-applied");
  assert.equal(
    again.messages[0].content[0].text,
    text,
    "an unchanged result must render byte-identically despite a later selection",
  );
});

test("a message left raw is sealed as a decision, not upgraded later", async () => {
  const s = session();
  assert.equal(await s.request([toolResult(2, document)]), undefined);
  assert.equal(
    await s.request([toolResult(2, document, select([0]))]),
    undefined,
    "a sealed raw rendering must not be rewritten once a selection exists",
  );
});

test("sealing is per observation: a new result is still projected", async () => {
  const s = session();
  assert.equal(await s.request([toolResult(3, document)]), undefined);
  const second = await s.request([
    toolResult(3, document, select([0])),
    toolResult(4, document, select([0])),
  ]);
  assert.ok(second, "a new observation must still be projected");
  assert.equal(second.messages[0].content[0].text, document);
  assert.match(second.messages[1].content[0].text, /^\[observation #4;/);
});
