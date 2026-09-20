import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const root = [projectRoot, path.resolve(projectRoot, "..")].find((candidate) =>
  fs.existsSync(path.join(candidate, "agent/extensions/lib/context-profile.mjs")),
);
assert.ok(root, "context profile helpers must be available");

const {
  buildRecord,
  isPrefixBreak,
  payloadMessages,
  payloadEnvelope,
  prefixSummary,
  selectProbeMessages,
} = await import(
  pathToFileURL(path.join(root, "agent/extensions/lib/context-profile.mjs")),
);
const { convertToLlm } = await import(
  pathToFileURL(path.join(root, "core/coding-agent/src/core/messages.js")),
);

test("context profile follows the provider-visible message array", () => {
  const base = [
    { role: "user", content: [{ type: "text", text: "do the work" }] },
    { role: "assistant", content: [{ type: "text", text: "working" }] },
  ];
  const pending = [
    ...base,
    {
      role: "custom",
      customType: "harness-activity",
      excludeFromContext: true,
      content: "display-only subprocess status",
    },
  ];

  assert.strictEqual(payloadMessages({ messages: base }), base);
  assert.strictEqual(payloadMessages({ input: base }), base);
  assert.strictEqual(payloadMessages({ contents: base }), base);
  assert.equal(payloadMessages({ prompt: "legacy string prompt" }), null);
  assert.notEqual(
    payloadEnvelope({ systemInstruction: { parts: [{ text: "one" }] } }).system.hash,
    payloadEnvelope({ systemInstruction: { parts: [{ text: "two" }] } }).system.hash,
  );
  const providerMessages = convertToLlm(pending);
  assert.deepEqual(providerMessages, base);
  assert.strictEqual(selectProbeMessages(providerMessages, pending), providerMessages);

  const first = buildRecord({
    seq: 1,
    at: 1,
    msSincePrev: null,
    messages: selectProbeMessages(providerMessages, pending),
    previousDigests: [],
    baseline: true,
  });
  const second = buildRecord({
    seq: 2,
    at: 2,
    msSincePrev: 1,
    messages: [...base, { role: "assistant", content: "done" }],
    previousDigests: first.digests,
  });

  assert.equal(second.record.appendedOnly, true);
  assert.equal(isPrefixBreak(first.record), false);
  assert.equal(isPrefixBreak(second.record), false);
  assert.equal(prefixSummary([first.record, second.record]).breaks, 0);
});

test("envelope changes remain breaks even when messages only append", () => {
  const first = buildRecord({
    seq: 1,
    at: 1,
    msSincePrev: null,
    messages: [{ role: "user", content: "hello" }],
    previousDigests: [],
    baseline: true,
  });
  const second = buildRecord({
    seq: 2,
    at: 2,
    msSincePrev: 1,
    messages: [...[{ role: "user", content: "hello" }], { role: "assistant", content: "hi" }],
    previousDigests: first.digests,
    envelopeChanges: [{ component: "tools" }],
  });

  assert.equal(second.record.appendedOnly, true);
  assert.equal(isPrefixBreak(second.record), true);
  assert.equal(prefixSummary([first.record, second.record]).envelopeBreaks, 1);
});
