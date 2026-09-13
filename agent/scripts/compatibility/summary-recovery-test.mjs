import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
const core = path.join(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const { retryAssistantCall } = await import(
  pathToFileURL(
    path.join(core, "node_modules/@earendil-works/pi-ai/dist/utils/retry.js"),
  )
);
const { generateSummaryWithUsage, getSummarizationFailure } = await import(
  pathToFileURL(path.join(core, "dist/core/compaction/compaction.js"))
);
const model = {
  id: "future-summary-model",
  provider: "offline",
  api: "openai-completions",
  reasoning: false,
  maxTokens: 2048,
};
const message = (content = [], stopReason = "stop") => ({
  role: "assistant",
  ...model,
  model: model.id,
  content,
  stopReason,
  usage: { input: 10, output: 5 },
  timestamp: 0,
});
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
const text = [{ type: "text", text: "Preserved context." }];
for (const empty of [
  [],
  [{ type: "thinking", thinking: "internal only" }],
  [{ type: "text", text: "  \n" }],
]) {
  let calls = 0;
  const recovered = await retryAssistantCall(
    async () => message(++calls === 1 ? empty : text),
    policy,
  );
  assert.equal(calls, 2);
  assert.deepEqual(recovered.content, text);
  calls = 0;
  const exhausted = await retryAssistantCall(async () => {
    calls++;
    return message(empty);
  }, policy);
  assert.equal(calls, 3);
  assert.equal(exhausted.stopReason, "error");
  calls = 0;
  const disabled = await retryAssistantCall(
    async () => {
      calls++;
      return message(empty);
    },
    { ...policy, enabled: false },
  );
  assert.equal(calls, 1);
  assert.equal(disabled.stopReason, "stop");
}
for (const original of [
  message([
    { type: "toolCall", id: "t", name: "read", arguments: { path: "x" } },
  ]),
  message([], "aborted"),
]) {
  let calls = 0;
  assert.equal(
    await retryAssistantCall(async () => {
      calls++;
      return original;
    }, policy),
    original,
  );
  assert.equal(calls, 1);
}
const controller = new AbortController();
const aborted = await retryAssistantCall(
  async () => message(),
  policy,
  controller.signal,
  { onRetryScheduled: () => controller.abort() },
);
assert.equal(aborted.stopReason, "aborted");
const summary = (stream, retry) =>
  generateSummaryWithUsage(
    [],
    model,
    1024,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "off",
    stream,
    undefined,
    retry,
  );
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("unexpected network request");
};
try {
  for (const response of [
    message(),
    message([{ type: "thinking", thinking: "only thought" }]),
    message(text, "aborted"),
  ]) {
    await assert.rejects(
      summary(async () => ({ result: async () => response }), {
        ...policy,
        enabled: false,
      }),
      /empty summary|summary aborted/,
    );
  }
  let calls = 0;
  const recovered = await summary(
    async () => ({ result: async () => message(++calls === 1 ? [] : text) }),
    policy,
  );
  assert.equal(calls, 2);
  assert.equal(recovered.text, "Preserved context.");
} finally {
  globalThis.fetch = originalFetch;
}
const chunks = path.join(core, "dist/bundle/chunks");
const source = fs
  .readdirSync(chunks)
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(chunks, f), "utf8"))
  .find((s) => s.includes("function getSummarizationFailure("));
const start = source.indexOf("function getSummarizationFailure(");
const end = source.indexOf("function createSummarizationOptions(", start);
assert.ok(end > start);
const bundled = runInNewContext(
  source.slice(start, end) + ";getSummarizationFailure;",
  {},
  { timeout: 1000 },
);
for (const response of [
  message(),
  message(text),
  message(text, "length"),
  message(text, "aborted"),
  { ...message([], "error"), errorMessage: "upstream unavailable" },
]) {
  assert.equal(
    bundled(response, "Summary"),
    getSummarizationFailure(response, "Summary"),
  );
}
console.log(
  "PASS empty auxiliary retry recovery, exhaustion/disabled/abort/tool-call semantics; native summary rejection and SDK/runtime summary guard parity",
);
