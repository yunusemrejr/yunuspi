// Regression: a background Jev distillation must be able to reach context.
//
// The next provider request follows a tool result within milliseconds, while a
// Jev answer takes ~0.6s, and the first render is sealed for the branch
// lifetime. Before the bounded context-time wait, paid selections never reached
// the model (no "JEV · added to model context" line in any recorded session).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/pi-observations.ts")),
);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jev-distill-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "OPENROUTER_API_KEY", "PI_JEV", "PI_OFFLINE", "PI_OUTPUT_DISTILLER"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = fixture;
process.env.OPENROUTER_API_KEY = "synthetic-key";
process.env.PI_OUTPUT_DISTILLER = "on";
delete process.env.PI_JEV;
delete process.env.PI_OFFLINE;
test.after(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(fixture, { recursive: true, force: true });
});

const { default: register } = await import(pathToFileURL(path.join(agent, "extensions/pi-observations.ts")));
const { configureJevClient, resetJevClient } = await import(pathToFileURL(path.join(agent, "extensions/lib/jev-client.ts")));

test("a Jev distillation that settles after the tool result is used in the first render", async () => {
  const bodies = [];
  resetJevClient();
  configureJevClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.1 }]));
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const handlers = new Map();
  const pi = {
    on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    getActiveTools: () => ["obs_read", "bash"],
  };
  register(pi, { reset: () => {}, endTurn: () => {}, select: async () => undefined },
    { reset: () => {}, endTurn: () => {}, offer: () => {}, take: () => undefined, takeAsync: async () => undefined });
  handlers.get("before_agent_start")[0]({ prompt: "Bundle the dashboard assets for deployment" });
  const segment = (label) => Array.from({ length: 60 }, (_, i) => `  bundling ${label} segment ${i} into chunk ${i * 7}`).join("\n");
  const text = ["Starting asset bundler", segment("vendor"), segment("charts"), segment("icons"), segment("fonts"), "Bundle summary: total 240 segments written"].join("\n");
  assert.ok(text.length >= 6000 && text.length <= 16000);
  const event = { toolName: "bash", toolCallId: "call_1", input: { command: "npm run bundle" }, content: [{ type: "text", text }], isError: false, details: { exitCode: 0 } };
  const result = handlers.get("tool_result")[0](event, { model: { cost: { input: 1 } } });
  const message = { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: event.content, details: result.details };
  const started = Date.now();
  const projected = await handlers.get("context")[0]({ messages: [message] });
  assert.ok(Date.now() - started < 1500 + 500, "the wait stays bounded");
  assert.equal(bodies.length, 1, "one Jev judgment");
  assert.match(bodies[0].state.task, /dashboard/, "the relevance question carries the task");
  const rendered = projected.messages[0].content[0].text;
  assert.match(rendered, /chunk\(s\) omitted/);
  assert.match(rendered, /routed with Jev · distill/);
  assert.match(rendered, /Bundle summary: total 240 segments/, "the final chunk is always kept");
  const again = await handlers.get("context")[0]({ messages: [message] });
  assert.equal(again.messages[0].content[0].text, rendered, "the sealed render stays byte-identical");
  resetJevClient();
});
