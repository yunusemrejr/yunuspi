import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const template = path.resolve(import.meta.dirname, "..");
const indexPath = path.join(template, "agent/extensions/pi-memory/index.ts");
const memory = await import(pathToFileURL(indexPath));

function harness() {
  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    on(name, handler) { events.set(name, handler); },
  };
  memory.default(pi);
  return { tools, events };
}

test("memory tools reject blank/oversized writes and bound reads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-tools-"));
  const previousUpdateMode = process.env.PI_MEMORY_QMD_UPDATE;
  process.env.PI_MEMORY_QMD_UPDATE = "off";
  memory._setBaseDir(dir);
  try {
    const { tools } = harness();
    const write = tools.get("memory_write");
    const read = tools.get("memory_read");
    const ctx = { sessionManager: { getSessionId: () => "session-12345678" } };
    await assert.rejects(() => write.execute("id", { target: "long_term", content: "   " }, undefined, undefined, ctx), /non-whitespace/);
    await assert.rejects(() => write.execute("id", { target: "long_term", content: "x".repeat(64001) }, undefined, undefined, ctx), /exceeds/);
    await assert.rejects(() => write.execute("id", { target: "long_term", content: "ok" }, AbortSignal.abort(), undefined, ctx), /aborted/);
    await write.execute("id", { target: "long_term", content: "x".repeat(1500) }, undefined, undefined, ctx);
    const result = await read.execute("id", { target: "long_term", maxChars: 1000 });
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.totalChars > result.details.readChars, true);
    assert.match(result.content[0].text, /pass offset=0 with maxChars/);
    const next = await read.execute("id", { target: "long_term", maxChars: 1000, offset: result.details.nextOffset });
    assert.equal(next.details.offset, 0);
    assert.equal(next.details.exactPage, true);

    const source = "αβ漢字😀\n".repeat(20_000);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), source, "utf8");
    let offset = 0;
    let reconstructed = "";
    while (offset < source.length) {
      const page = await read.execute("id", { target: "long_term", maxChars: 4096, offset });
      const { readChars, nextOffset, hasMore } = page.details;
      assert.equal(page.details.exactPage, true);
      assert.equal(page.content[0].text, source.slice(offset, offset + readChars));
      assert.equal(page.content[0].text.isWellFormed(), true, "pages cannot split a Unicode character");
      reconstructed += page.content[0].text;
      if (!hasMore) break;
      assert.equal(nextOffset, offset + readChars);
      offset = nextOffset;
    }
    assert.equal(reconstructed, source);
    await assert.rejects(() => read.execute("id", { target: "long_term", offset: 5 }), /splits a Unicode character/);
    await assert.rejects(() => read.execute("id", { target: "long_term", offset: source.length + 1 }), /exceeds the file length/);
    await assert.rejects(() => read.execute("id", { target: "long_term" }, AbortSignal.abort()), /aborted/);
  } finally {
    if (previousUpdateMode === undefined) delete process.env.PI_MEMORY_QMD_UPDATE;
    else process.env.PI_MEMORY_QMD_UPDATE = previousUpdateMode;
    memory._resetBaseDir();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
