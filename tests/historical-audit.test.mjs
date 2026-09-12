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
