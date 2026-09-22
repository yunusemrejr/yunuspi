import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let agent = path.join(root, "agent");
try { await fs.access(agent); } catch { agent = path.resolve(root, ".."); }
const { collectScopeHistory } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/project-intelligence/scope-history.mjs")),
);

const line = (value) => JSON.stringify(value);
const message = (id, parentId, role, text, timestamp) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role, content: [{ type: "text", text }], timestamp },
});

async function writeSession(file, { id, cwd, parentSession, entries, mtime = 10_000 }) {
  const header = { type: "session", version: 3, id, cwd, timestamp: new Date(mtime).toISOString() };
  if (parentSession) header.parentSession = parentSession;
  await fs.writeFile(file, [header, ...entries].map(line).join("\n") + "\n");
  await fs.utimes(file, new Date(mtime), new Date(mtime));
}

test("collects the active same-project chain and live branch with provenance", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scope-history-"));
  try {
    const cwd = path.join(temp, "project");
    const foreign = path.join(temp, "other-project");
    const sessions = path.join(temp, "sessions");
    await Promise.all([fs.mkdir(cwd), fs.mkdir(foreign), fs.mkdir(sessions)]);
    await writeSession(path.join(sessions, "same.jsonl"), {
      id: "same-session",
      cwd,
      entries: [
        message("u-old", null, "user", "Prefer compact controls and preserve keyboard navigation.", 1_000),
        message("a-old", "u-old", "assistant", "I chose a compact control layout.", 2_000),
        message("inactive", "u-old", "user", "INACTIVE BRANCH SHOULD NOT APPEAR", 3_000),
        message("u-active", "a-old", "user", "Keep the compact controls while changing the button color.", 4_000),
        {
          type: "custom_message",
          id: "synthetic",
          parentId: "u-active",
          timestamp: new Date(5_000).toISOString(),
          customType: "extension",
          content: [{ type: "text", text: "synthetic text should not appear" }],
          display: false,
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "synthetic",
          timestamp: new Date(6_000).toISOString(),
          message: { role: "toolResult", content: [{ type: "text", text: "tool body should not appear" }] },
        },
      ],
      mtime: 20_000,
    });
    await writeSession(path.join(sessions, "foreign.jsonl"), {
      id: "foreign-session",
      cwd: foreign,
      entries: [message("foreign-u", null, "user", "button color from another project", 7_000)],
      mtime: 30_000,
    });
    await writeSession(path.join(sessions, "child.jsonl"), {
      id: "child-session",
      cwd,
      parentSession: "same-session",
      entries: [message("child-u", null, "user", "child button color should not appear", 8_000)],
      mtime: 40_000,
    });

    const branch = [
      message("live-u", "u-active", "user", "Please make the compact button color calmer.", 9_000),
      {
        ...message("live-a", "live-u", "assistant", "I can adjust the button color.", 10_000),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I can adjust the button color." },
            { type: "thinking", thinking: "private reasoning must not enter evidence" },
            { type: "toolCall", name: "read", arguments: { path: "/private/path" } },
          ],
        },
      },
    ];
    const result = await collectScopeHistory({
      cwd,
      sessionsDir: sessions,
      currentSessionId: "live-session",
      prompt: "Redesign the compact button color",
      branch,
    });
    assert.ok(result.evidence.some((entry) => entry.source === "current-branch" && entry.role === "user"));
    assert.ok(result.evidence.some((entry) => entry.source === "session:same-session" && entry.role === "assistant"));
    assert.ok(result.evidence.some((entry) => entry.text.includes("Prefer compact controls")));
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /INACTIVE BRANCH|another project|child button|synthetic text|tool body|private reasoning|private\/path/);
    assert.match(result.coverage, /^COMPLETE/);
    assert.match(result.coverage, /Canonical cwd headers filtered cross-project files/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("keeps the in-memory branch when no persisted session is available", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scope-history-live-"));
  try {
    const branch = [message("live-only", null, "user", "Keep this spacing preference for the current redesign.", 1_000)];
    const result = await collectScopeHistory({
      cwd: temp,
      sessionsDir: path.join(temp, "missing-sessions"),
      currentSessionId: "live-session",
      prompt: "redesign spacing",
      branch,
    });
    assert.deepEqual(result.evidence.map((entry) => entry.text), [branch[0].message.content[0].text]);
    assert.equal(result.evidence[0].role, "user");
    assert.equal(result.evidence[0].source, "current-branch");
    assert.equal(result.incomplete, true);
    assert.match(result.coverage, /^INCOMPLETE;/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("keeps adjacent user corrections and treats an omitted newer correction as unknown", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scope-history-correction-"));
  try {
    const sessions = path.join(temp, "sessions");
    await fs.mkdir(sessions);
    await writeSession(path.join(sessions, "correction.jsonl"), {
      id: "correction-session",
      cwd: temp,
      entries: [
        message("preference", null, "user", "I prefer serif typography and a blue palette.", 1_000),
        message("correction", "preference", "user", "Actually no, keep that part.", 2_000),
      ],
    });
    const adjacent = await collectScopeHistory({
      cwd: temp,
      sessionsDir: sessions,
      currentSessionId: "current-session",
      prompt: "Redesign the UI mascot animation",
      branch: [],
    });
    assert.ok(adjacent.evidence.some((entry) => entry.text === "Actually no, keep that part."));
    assert.ok(adjacent.evidence.some((entry) => entry.text.includes("serif typography")));

    const longBranch = [
      message("old-preference", null, "user", "Prefer serif typography and blue palette.", 3_000),
      message("long-correction", "old-preference", "user", `Actually no, keep that part ${"x".repeat(5_000)}`, 4_000),
    ];
    const omitted = await collectScopeHistory({
      cwd: temp,
      sessionsDir: path.join(temp, "missing"),
      currentSessionId: "current-session",
      prompt: "Redesign the UI",
      branch: longBranch,
    });
    assert.equal(omitted.evidence.some((entry) => entry.text.includes("old-preference")), false);
    assert.equal(omitted.evidence.some((entry) => entry.text.includes("Prefer serif")), false);
    assert.equal(omitted.incomplete, true);
    assert.match(omitted.coverage, /newer omitted message/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("omits credentials, symlinks and aborted reads", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scope-history-safe-"));
  try {
    const sessions = path.join(temp, "sessions");
    await fs.mkdir(sessions);
    await writeSession(path.join(sessions, "secret.jsonl"), {
      id: "secret-session",
      cwd: temp,
      entries: [
        message("secret-u", null, "user", "Use api_key=super-secret-value for this button change.", 1_000),
        message("safe-u", "secret-u", "user", "The button color should remain calm.", 2_000),
      ],
    });
    try {
      await fs.symlink(path.join(sessions, "secret.jsonl"), path.join(sessions, "alias.jsonl"));
    } catch { /* Symlink creation is unavailable on some test hosts. */ }
    const result = await collectScopeHistory({
      cwd: temp,
      sessionsDir: sessions,
      currentSessionId: "other-session",
      prompt: "button color",
      branch: [],
    });
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
    assert.ok(result.evidence.every((entry) => ["user", "assistant"].includes(entry.role)));

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collectScopeHistory({ cwd: temp, sessionsDir: sessions, prompt: "button", branch: [], signal: controller.signal }),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});


test("a session replaced between header discovery and content read cannot contribute foreign evidence", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scope-history-race-"));
  const originalOpen = fs.open;
  try {
    const cwd=path.join(temp,'project'), foreign=path.join(temp,'foreign'), sessions=path.join(temp,'sessions');
    await Promise.all([fs.mkdir(cwd),fs.mkdir(foreign),fs.mkdir(sessions)]);
    const file=path.join(sessions,'history.jsonl');
    await writeSession(file,{id:'same-id',cwd,entries:[message('before',null,'user','Preserve checkout keyboard access.',1)]});
    let reads=0;
    fs.open = async function (target, ...args) {
      if(target===file && ++reads===2) {
        const replacement=path.join(temp,'replacement.jsonl');
        await writeSession(replacement,{id:'same-id',cwd:foreign,entries:[message('after',null,'user','Checkout FOREIGN REPLACEMENT MUST NOT APPEAR.',2)]});
        await fs.rename(replacement,file);
      }
      return originalOpen.call(this,target,...args);
    };
    const collected=await collectScopeHistory({cwd,sessionsDir:sessions,currentSessionId:'current',prompt:'Redesign checkout',branch:[]});
    assert.equal(reads,2);
    assert.equal(collected.incomplete,true);
    assert.doesNotMatch(JSON.stringify(collected.evidence),/FOREIGN REPLACEMENT/);
  } finally {fs.open=originalOpen;await fs.rm(temp,{recursive:true,force:true});}
});
