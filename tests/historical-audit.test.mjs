import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let agent = path.join(root, "agent");
try { await fs.access(agent); } catch { agent = path.resolve(root, ".."); }
const { scanSessionAudit } = await import(pathToFileURL(path.join(agent, "extensions/lib/session-audit.ts")));

test("historical audit selects workspace evidence before applying the file cap", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-public-audit-"));
  try {
    const sessions = path.join(temp, "sessions"), workspace = path.join(temp, "work");
    await fs.mkdir(sessions); await fs.mkdir(workspace);
    const write = async (name, cwd, tool, at) => {
      const file = path.join(sessions, name);
      await fs.writeFile(file, [
        { type: "session", cwd },
        { type: "message", message: { role: "toolResult", toolCallId: name, toolName: tool,
          content: [{ type: "text", text: "PRIVATE-PROMPT /private/error/path" }] } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      await fs.utimes(file, at, at);
    };
    await write("matching.jsonl", workspace, "read", new Date(1000));
    await write("foreign.jsonl", temp, "bash", new Date(2000));
    const report = await scanSessionAudit({ sessionsDir: sessions, workspace, maxFiles: 1 });
    assert.equal(report.sessions, 1); assert.equal(report.tools.read, 1);
    assert.equal(report.tools.bash, undefined);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE-PROMPT|private\/error|pi-public-audit-/);
    const all = await scanSessionAudit({ sessionsDir: sessions, workspace, scope: "all", maxFiles: 1 });
    assert.equal(all.tools.bash, 1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(scanSessionAudit({ sessionsDir: sessions, workspace, signal: abort.signal }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('traffic audit aggregates raw text without returning bodies or cross-session duplicate claims', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-traffic-audit-'));
  try {
    const payload = 'PRIVATE_SOURCE_BODY '.repeat(40);
    const entries = [{type:'session',cwd:temp}];
    for (let i=0;i<2;i++) entries.push(
      {type:'message',message:{role:'assistant',content:[{type:'toolCall',id:`call-${i}`,name:'read',arguments:{path:'/private/source.txt'}}]}},
      {type:'message',message:{role:'toolResult',toolName:'read',toolCallId:`call-${i}`,content:[{type:'text',text:payload}]}}
    );
    for (const name of ['one.jsonl','two.jsonl']) await fs.writeFile(path.join(temp,name),entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
    const report=await scanSessionAudit({sessionsDir:temp,scope:'all',maxFiles:2});
    assert.equal(report.traffic.totalReturnedChars,payload.length*4);
    assert.equal(report.traffic.totalResults,4);
    assert.equal(report.traffic.identicalContentChars,payload.length*2);
    assert.equal(report.traffic.exactRequestResultChars,payload.length*2);
    assert.deepEqual(report.traffic.largestContributors,[{tool:'read',chars:payload.length*4}]);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SOURCE_BODY|private\/source|call-0/);
    assert.match(report.traffic.interpretation,/not wire tokens/);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test("oversized sessions retain their newest complete records within the byte and entry budgets", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-audit-tail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tool = (name, text) => JSON.stringify({ type: "message", message: {
    role: "toolResult", toolCallId: name, toolName: name, content: [{ type: "text", text }],
  } });
  const prefix = [JSON.stringify({ type: "session", cwd: directory }), tool("old", "🛰".repeat(600))].join("\n") + "\n";
  const suffix = [tool("read", "complete 🌿"), "{malformed}", tool("edit", "complete 🌱"), '{"type":"message","message":'].join("\n");
  await fs.writeFile(path.join(directory, "active.jsonl"), prefix + suffix);
  // Exercise a byte window beginning both at a true delimiter and inside an older UTF-8 record.
  for (const maxFileBytes of [Buffer.byteLength(suffix), Buffer.byteLength(suffix) + 17]) {
    const report = await scanSessionAudit({ sessionsDir: directory, workspace: directory, maxFileBytes, maxEntriesPerFile: 2 });
    assert.equal(report.sessions, 1);
    assert.equal(report.truncatedSessions, 1);
    assert.equal(report.sampledOversize, 1);
    assert.equal(report.skippedOversize, 0);
    assert.equal(report.inspected, 2);
    assert.equal(report.malformedLines, 1);
    assert.equal(report.partialLines, 1);
    assert.deepEqual(report.tools, { edit: 1, read: 1 });
    assert.doesNotMatch(JSON.stringify(report), /complete 🌿|complete 🌱|pi-audit-tail-/);
  }
});

test("an oversized file containing only a clipped record contributes no session evidence", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-audit-empty-tail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "huge.jsonl"), JSON.stringify({ type: "session", cwd: directory }) + "\n" +
    JSON.stringify({ type: "message", message: { content: "x".repeat(500) } }) + "\n");
  const report = await scanSessionAudit({ sessionsDir: directory, scope: "all", maxFileBytes: 50 });
  assert.equal(report.sessions, 0);
  assert.equal(report.skippedOversize, 1);
  assert.equal(report.malformedLines, 0);
});
