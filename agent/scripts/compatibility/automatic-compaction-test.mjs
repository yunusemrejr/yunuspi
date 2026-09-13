// Offline: deployed SDK + CLI predicate and the real between-tool-turn hook.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  targets,
  automaticCompactionThreshold,
  compactionSettingsForWindow,
} from "../patches/compaction-early.mjs";
const settings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  maxContextTokens: 256000,
};
const ts = targets();
const sdk = ts.find((t) => t.name === "sdk: shouldCompact cap");
const core = path.resolve(path.dirname(sdk.file), "..");
const { shouldCompact, prepareCompaction, estimateContextTokens } = await import(sdk.file);
const bundle = ts.find((t) => t.name === "bundle: shouldCompact cap");
const code = fs
  .readFileSync(bundle.file, "utf8")
  .match(/function shouldCompact\([^}]+\}/)[0];
const cli = vm.runInNewContext(`(${code})`);
for (const predicate of [shouldCompact, cli]) {
  assert.equal(predicate(170261, 272000, settings), false);
  assert.equal(
    predicate(205042, 272000, settings),
    true,
    "compact before the 90% unsafe-payload warning",
  );
  assert.equal(predicate(234364, 272000, settings), true);
  assert.equal(
    predicate(234364, 272000, { ...settings, enabled: false }),
    false,
  );
  assert.equal(
    predicate(40000, 272000, settings),
    false,
    "retained tail does not loop",
  );
  assert.equal(
    predicate(220000, 1000000, settings),
    true,
    "large windows still respect the absolute cap",
  );
  assert.equal(
    predicate(86000, 272000, { ...settings, maxContextTokens: 100000 }),
    true,
  );
  for (const cap of [undefined, -1, NaN, Infinity, "1000"]) {
    assert.equal(
      predicate(100000, 272000, { ...settings, maxContextTokens: cap }),
      false,
    );
  }
  for (const tokens of [1, 40000, 170261, 195000, 195100, 205042, 234364]) {
    assert.equal(
      predicate(tokens, 272000, settings),
      tokens > automaticCompactionThreshold(tokens, 272000, settings),
    );
  }
}
assert.ok(automaticCompactionThreshold(205042, 272000, settings) < 205042);
assert.deepEqual(compactionSettingsForWindow(272000, settings), settings, "large windows retain configured defaults");
assert.equal(compactionSettingsForWindow(1000000, { ...settings, keepRecentTokens: 0 }).keepRecentTokens, 0, "explicit zero tail is preserved");
for (const window of [8192, 16384, 32768]) {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    type: "message", id: `fixture-${i}`, parentId: i ? `fixture-${i-1}` : null,
    timestamp: new Date(i).toISOString(),
    message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(Math.floor(window * 0.13)) }], timestamp: i },
  }));
  const before = estimateContextTokens(entries.map(entry => entry.message)).tokens;
  assert.ok(automaticCompactionThreshold(1, window, settings) > window / 3, "small windows must not compact from token one");
  assert.equal(shouldCompact(before, window, settings), true);
  const preparation = prepareCompaction(entries, settings, window);
  assert.ok(preparation, `${window}: configured 20k tail must not prevent compaction`);
  assert.deepEqual(preparation.settings, compactionSettingsForWindow(window, settings));
  assert.equal(prepareCompaction(entries, { ...settings, keepRecentTokens: 0 }, window).settings.keepRecentTokens, 0);
  assert.ok(preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length > 0);
  const firstKept = entries.findIndex(entry => entry.id === preparation.firstKeptEntryId);
  assert.ok(firstKept > 0, "old work moves into summary rather than being silently discarded");
  const summaryTokens = Math.ceil(preparation.settings.reserveTokens * (preparation.isSplitTurn ? 1.3 : 0.8));
  const retained = [{ role: "user", content: "s".repeat(summaryTokens * 4) }, ...entries.slice(firstKept).map(entry => entry.message)];
  assert.equal(shouldCompact(estimateContextTokens(retained).tokens, window, settings), false, `${window}: bounded summary plus retained work leaves continuation room`);
}

const { pressureFacts } = await import(
  "../../extensions/lib/session-signals.ts"
);
const facts = pressureFacts(
  {
    model: {
      provider: "fixture",
      id: "fixture",
      contextWindow: 272000,
      maxTokens: 32768,
    },
    getContextUsage: () => ({ tokens: 205042, compactionSettings: settings }),
  },
  {},
);
assert.equal(
  facts.compactionTrigger,
  automaticCompactionThreshold(205042, 272000, settings),
);
assert.ok(
  facts.compactionTrigger < facts.usableBudget * 0.9,
  "the diagnostic distinguishes the proactive trigger from the budget cap",
);

for (const window of [8192, 16384, 32768]) {
  const small = pressureFacts({ model: { provider: "fixture", id: "small", contextWindow: window, maxTokens: window },
    getContextUsage: () => ({ tokens: 100, compactionSettings: settings }) }, {});
  assert.ok(small.usableBudget > window / 2, "small models retain meaningful input budget");
  assert.ok(small.percent < 5, "small-model diagnostics must not falsely report full context at startup");
}
const { payloadPressureWarning } = await import("../../extensions/lib/session-signals.ts");
assert.match(payloadPressureWarning(95), /Compaction is routine; do not skip required work or verification/);
assert.equal(payloadPressureWarning(20), undefined, "no pressure, no extra reminder");
for (const t of ts) assert.ok(t.isApplied(), t.name);
const { AgentSession } = await import(path.join(core, "agent-session.js"));
const retained = [
  {
    role: "user",
    content: "Keep the task constraints and recent edits.",
    timestamp: 2,
  },
];
const large = [
  {
    role: "assistant",
    content: [],
    timestamp: 1,
    usage: { input: 205042, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];
let calls = 0;
const harness = {
  model: { contextWindow: 272000 },
  settingsManager: { getCompactionSettings: () => settings },
  agent: { state: { messages: large } },
  async _runAutoCompaction(reason, retry) {
    assert.equal(reason, "threshold");
    assert.equal(retry, false);
    calls++;
    this.agent.state.messages = retained;
  },
};
const result =
  await AgentSession.prototype._compactBeforeNextAssistantResponse.call(
    harness,
    { messages: large },
  );
assert.equal(calls, 1, "compaction starts automatically between tool turns");
assert.deepEqual(
  result.messages,
  retained,
  "continuation receives the retained state without another user prompt",
);
await AgentSession.prototype._compactBeforeNextAssistantResponse.call(
  harness,
  result,
);
assert.equal(calls, 1, "the compacted continuation does not compact again");
harness.agent.state.messages = large;
harness._runAutoCompaction = async () => false;
const failed =
  await AgentSession.prototype._compactBeforeNextAssistantResponse.call(
    harness,
    { messages: large },
  );
assert.deepEqual(
  failed.messages,
  large,
  "a failed compaction does not discard history",
);
console.log(
  "PASS automatic compaction: live-budget regression, SDK/CLI parity, disabled policy, retained tail and between-turn continuation",
);

// Real preparation, persistence and automatic retry handoff on short history.
// Only model inference is replaced with a deterministic summary.
{
 const {SessionManager}=await import(path.join(core,'session-manager.js'));
 const manager=SessionManager.inMemory('/tmp');
 for(const message of [
  {role:'user',content:'Implement the requested fix and preserve constraints.',timestamp:1},
  {role:'assistant',content:[{type:'text',text:'Inspected the code and identified the cause.'}],stopReason:'stop',timestamp:2},
  {role:'user',content:'Continue and test it.',timestamp:3},
 ]) manager.appendMessage(message);
 assert.equal(prepareCompaction(manager.getBranch(),settings,32768),undefined,'ordinary tail keeps this entire short history');
 let summaries=0;
 const events=[];
 const host={model:{provider:'fixture',id:'small',contextWindow:32768},
  settingsManager:{getCompactionSettings:()=>settings},sessionManager:manager,
  agent:{state:{messages:manager.buildSessionContext().messages},hasQueuedMessages:()=>false},
  _extensionRunner:{hasHandlers:()=>false,emit:async()=>{}},
  _getSummarizationRequestAuth:async model=>({model}),
  _emit:event=>events.push(event),_emitSessionCompactFailed:async()=>{},_resolveIdleWaitIfIdle:()=>{},
  async _runDefaultCompaction(preparation){
   summaries++;
   assert.equal(preparation.settings.keepRecentTokens,0);
   assert.ok(preparation.messagesToSummarize.length>0);
   return {summary:'Objective: implement the fix, preserve constraints, then test. Code inspection completed.',
    firstKeptEntryId:preparation.firstKeptEntryId,tokensBefore:preparation.tokensBefore};
  }};
 const originalSummary=host._runDefaultCompaction;
 const originalMessages=host.agent.state.messages;
 for (const invalid of [{summary:' '},{firstKeptEntryId:'unknown-boundary'},{tokensBefore:NaN}]) {
  host._runDefaultCompaction=async preparation=>({...await originalSummary.call(host,preparation),...invalid});
  assert.equal(await AgentSession.prototype._runAutoCompaction.call(host,'overflow',true),false);
  assert.equal(host.agent.state.messages,originalMessages);
  assert.equal(manager.getEntries().some(entry=>entry.type==='compaction'),false);
  assert.equal(host._autoCompactionAbortController,undefined,'failed compaction releases busy state');
 }
 summaries=0;
 host._runDefaultCompaction=originalSummary;
 assert.equal(await AgentSession.prototype._runAutoCompaction.call(host,'overflow',true),true);
 assert.equal(summaries,1);
 assert.equal(host.agent.state.messages.at(-1).content,'Continue and test it.');
 assert.ok(manager.getEntries().some(entry=>entry.type==='compaction'));
 assert.ok(events.some(event=>event.type==='compaction_end'&&event.willRetry===true&&!event.errorMessage));
 console.log('PASS automatic short-history fallback: native preparation, saved summary, retained latest prompt and retry handoff');
}
