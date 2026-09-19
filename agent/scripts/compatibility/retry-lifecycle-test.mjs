import {resolveOwnedCore} from '../lib/owned-core.mjs';
// Offline regression of the actual SDK and CLI method bodies; no inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
const WINDOW_MS = 120_000, COOLDOWN_MS = 25_000;
const core = resolveOwnedCore();
const sdk = fs.readFileSync(
 path.join(core, "dist/core/agent-session.js"),
 "utf8",
);
const { isRetryableAssistantError } = await import(
 path.join(core, "../ai/dist/utils/retry.js")
);

let failures = 0,
 checks = 0;
function check(label, callback) {
 checks++;
 try {
  callback();
  console.log("PASS " + label);
 } catch (error) {
  failures++;
  console.error("FAIL " + label + ": " + error.message);
 }
}
const originalNow = Date.now;
let now = 1_000;
Date.now = () => now;
try {
 for (const [label, source] of [["owned SDK/CLI", sdk]]) {
  const start = source.indexOf("_willRetryAfterAgentEnd(");
  // First occurrence can be the call site. Require the method definition.
  const prediction = source.match(
   /_willRetryAfterAgentEnd\(\w+\)\s*\{[\s\S]*?(?=\s*(?:\/\*\*[\s\S]*?\*\/\s*)?_findLastAssistantMessage\()/,
  )?.[0];
  assert.ok(start >= 0 && prediction);
  const begin = source.indexOf("async _prepareRetry("),
   end = source.indexOf("abortRetry()", begin);
  const prepare = source.slice(begin, end);
  const sleepName = prepare.match(
   /await (\w+)\(delayMs,\s*this\._retryAbortController\.signal\)/,
  )?.[1];
  assert.ok(sleepName);
  const sleep = async (delay, signal) => {
   assert.equal(delay, COOLDOWN_MS);
   if (signal.aborted) throw new Error("aborted");
  };
  const Class = runInNewContext(
   `(class {${prediction}\n${prepare}\nabortRetry(){this._retryAbortController?.abort();}})`,
   {
    [sleepName]: sleep,
    Date,
    AbortController,
    // The real body carries the autonomous-recovery preamble
    // (PI_AUTONOMOUS_RECOVERY_V2), which reads process.env and asks the
    // extension runner for recovery handlers. Provide a sandbox-safe env and
    // NO handlers so the preamble takes its skip path and the cooldown logic
    // under test runs directly.
    process: { env: {} },
   },
   { timeout: 1000 },
  );
  const message = (error = "429 Too Many Requests") => ({
   role: "assistant",
   provider: "fixture-provider",
   model: "fixture-model",
   stopReason: "error",
   errorMessage: error,
   content: [],
  });
  function fixture(attempt = 0, started = undefined) {
   const events = [],
    records = [],
    value = new Class();
   Object.assign(value, {
    _retryAttempt: attempt,
    _piRateLimitLoopStart: started,
    settingsManager: {
     getRetrySettings: () => ({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
     }),
    },
    agent: { state: { messages: [message()] } },
    sessionManager: {
     appendCustomEntry: (type, data) =>
      records.push({ type, ...structuredClone(data) }),
    },
    _isRetryableError: isRetryableAssistantError,
    _extensionRunner: { hasHandlers: () => false },
    _emit: (event) => events.push(event),
   });
   return { value, events, records };
  }
  let f = fixture(3, 1_000);
  now = 76_000;
  check(label + " cooldown prediction exceeds ordinary cap", () =>
   assert.equal(
    f.value._willRetryAfterAgentEnd({ messages: [message()] }),
    true,
   ),
  );
  const retry = await f.value._prepareRetry(message());
  check(label + " actual cooldown retry agrees", () =>
   assert.equal(retry, true),
  );
  check(label + " ordinary errors still capped", () =>
   assert.equal(
    f.value._willRetryAfterAgentEnd({
     messages: [message("500 server error")],
    }),
    false,
   ),
  );
  check(label + " auth failures do not retry", () =>
   assert.equal(
    f.value._willRetryAfterAgentEnd({
     messages: [message("401 invalid API key")],
    }),
    false,
   ),
  );
  f = fixture(4, 1_000);
  now = 1_001 + WINDOW_MS;
  check(label + " expired prediction", () =>
   assert.equal(
    f.value._willRetryAfterAgentEnd({ messages: [message()] }),
    false,
   ),
  );
  const stopped = await f.value._prepareRetry(message());
  check(label + " budget stops without another request", () =>
   assert.equal(stopped, false),
  );
  check(label + " pause cause persisted without changing model", () =>
   assert.deepEqual(f.records, [
    {
     type: "harness-retry",
     status: "paused",
     reason: "cooldown-window-exhausted",
     provider: "fixture-provider",
     model: "fixture-model",
     attempt: 4,
    },
   ]),
  );
  f = fixture();
  now = 1_000;
  f.value._emit = (event) => {
   f.events.push(event);
   if (event.type === "auto_retry_start") f.value.abortRetry();
  };
  const cancelled = await f.value._prepareRetry(message());
  check(label + " immediate Stop cancels announced retry", () =>
   assert.equal(cancelled, false),
  );
  check(label + " cancel controller cleaned", () =>
   assert.equal(f.value._retryAbortController, undefined),
  );
  check(label + " cancellation recorded", () =>
   assert.equal(f.records[0]?.status, "cancelled"),
  );
  f = fixture();
  now = 500_000;
  check(label + " fresh prompt-equivalent clock rearms", () =>
   assert.equal(
    f.value._willRetryAfterAgentEnd({ messages: [message()] }),
    true,
   ),
  );

 }
} finally {
 Date.now = originalNow;
}
// 2026-09-06 codex-transport + moderation-parity revisions (same classifiers
// the runtime uses — imported from the patched SDK copy, structure-checked in
// the CLI chunk).
check("WebSocket transport death is retryable (stock budget)", () =>
 assert.equal(
  isRetryableAssistantError({
   role: "assistant",
   provider: "openai-codex",
   model: "gpt-6-astra",
   stopReason: "error",
   errorMessage: "WebSocket error",
   content: [],
   usage: { output: 0 },
  }),
  true,
 ),
);
check("deterministic moderation rejection fails fast (SDK)", () =>
 assert.equal(
  isRetryableAssistantError({
   role: "assistant",
   provider: "fixture-provider",
   model: "fixture-model",
   stopReason: "error",
   errorMessage: "data_inspection_failed: content policy",
   content: [],
  }),
  false,
 ),
);
check("quota/billing rejections still fail fast", () =>
 assert.equal(
  isRetryableAssistantError({
   role: "assistant",
   provider: "fixture-provider",
   model: "fixture-model",
   stopReason: "error",
   errorMessage: "insufficient_quota: billing cycle exhausted",
   content: [],
  }),
  false,
 ),
);
// Run the installed SDK retry loop before/after the durable declaration
// upgrade with a virtual delay. This catches the wrapper precedence bug, not
// merely a regex literal changing. Neither copy calls a model or writes core.
const retrySource=fs.readFileSync(path.join(core,"../ai/dist/utils/retry.js"),"utf8");
const ownedModule=await import(path.join(core,"../ai/dist/utils/retry.js"));
const invalidRequest='400: '+JSON.stringify({message:"Provider returned error",metadata:{raw:JSON.stringify({error:{message:"The request contains invalid parameters.",type:"invalid_request_error"}})}});
for(const errorMessage of [invalidRequest,"Provider returned error: unsupported parameter temperature"]){
 let produced=0,retries=0;
 await ownedModule.retryAssistantCall(async()=>{produced++;return {role:"assistant",content:[],stopReason:"error",errorMessage};},
  {enabled:true,maxRetries:3,baseDelayMs:0},undefined,{onRetryScheduled:()=>retries++});
 check("invalid payload exits after one provider attempt",()=>{assert.equal(produced,1);assert.equal(retries,0);});
}
check("owned SDK still retries transient HTTP 400 wrappers",()=>assert.equal(ownedModule.isRetryableAssistantError({stopReason:"error",errorMessage:"400 Provider returned error: overloaded"}),true));
console.log(
 `${checks - failures}/${checks} retry lifecycle checks passed`,
);
process.exitCode = failures ? 1 : 0;
