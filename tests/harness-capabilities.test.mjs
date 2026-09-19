import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")] .find((dir) =>
  fs.existsSync(path.join(dir, "extensions/lib/harness-capabilities.ts")),
);
assert.ok(agent, "harness capability catalog is present");
const catalog = await import(pathToFileURL(path.join(agent, "extensions/lib/harness-capabilities.ts")));

test("installed capability details prefer runtime docs over stale legacy templates", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-docs-'));
  try {
    const module = path.join(fixture, 'agent/extensions/lib/harness-capabilities.ts');
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.copyFileSync(path.join(agent, 'extensions/lib/harness-capabilities.ts'), module);
    const current = path.join(fixture, 'agent/runtime/docs/SKILLS-AND-CHECKS.md');
    const stale = path.join(fixture, 'agent/public-template/docs/SKILLS-AND-CHECKS.md');
    for (const file of [current, stale]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic documentation'); }
    const installed = await import(pathToFileURL(module));
    const record = installed.HARNESS_CAPABILITIES.find(item => item.doc.endsWith('/SKILLS-AND-CHECKS.md'));
    assert.equal(installed.getCapabilityDetail(record.id).doc, current);
    fs.unlinkSync(current);
    assert.equal(installed.getCapabilityDetail(record.id).doc, stale, 'older installations retain their fallback');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("capability catalog is static, source-backed and covers the requested surfaces", () => {
  const { HARNESS_CAPABILITIES: records, getCapabilityDetail } = catalog;
  assert.ok(records.length >= 20, "the catalog remains broad enough to orient a new session");
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  assert.ok(Object.isFrozen(records));
  assert.doesNotMatch(JSON.stringify(records), /\/(?:home|Users|root)\//, "static export contains no personal absolute paths");

  for (const record of records) {
    assert.match(record.id, /^[a-z0-9-]+$/);
    assert.ok(record.group && record.summary);
    assert.ok(Array.isArray(record.entrypoints));
    assert.ok(Array.isArray(record.tools));
    assert.ok(Array.isArray(record.commands));
    assert.ok(Array.isArray(record.options));
    assert.ok(Array.isArray(record.related));
    assert.ok(record.sourceFiles.every((file) => !path.isAbsolute(file)));
    assert.ok(!path.isAbsolute(record.doc));

    const detail = getCapabilityDetail(record.id);
    assert.ok(detail);
    assert.ok(detail.sourceFiles.every((file) => path.isAbsolute(file) && fs.existsSync(file)), record.id);
    assert.ok(path.isAbsolute(detail.doc) && fs.existsSync(detail.doc), record.id);
  }
});

test("browse and search return small bounded previews with progressive detail", () => {
  const { HARNESS_CAPABILITIES: records, browseCapabilities, searchCapabilities, getCapabilityDetail } = catalog;
  const overview = browseCapabilities({ limit: 3 });
  assert.equal(overview.limit, 3);
  assert.equal(overview.results.length, 3);
  assert.equal(overview.total, records.length);
  assert.equal(overview.groups.reduce((sum, group) => sum + group.count, 0), records.length);
  assert.ok(overview.results.every((row) =>
    Object.keys(row).every((key) => ["id", "group", "summary", "tools"].includes(key)) &&
    !Object.hasOwn(row, "sourceFiles") && !Object.hasOwn(row, "doc") && !Object.hasOwn(row, "options"),
  ));

  const memoryFirst = browseCapabilities({ group: "memory", limit: 2 });
  const memoryNext = browseCapabilities({ group: "memory", limit: 2, offset: 2 });
  assert.equal(memoryFirst.total, 3);
  assert.equal(memoryFirst.results.length, 2);
  assert.equal(memoryNext.results.length, 1);
  assert.equal(memoryNext.remaining, 0);

  const searches = [
    ["swarm", "swarm-execution"],
    ["fusion", "fusion-review"],
    ["free:true", "model-selection"],
    ["future session notes", "memory-notes"],
    ["prior memory", "memory-retrieval"],
    ["search old memory", "memory-retrieval"],
    ["free provider", "model-selection"],
    ["workdir", "subagent-dispatch"],
    ["same checkout", "session-coordination"],
    ["provider selection", "provider-routing"],
  ];
  for (const [query, id] of searches) {
    assert.ok(searchCapabilities({ query }).results.some((row) => row.id === id), `${query} finds ${id}`);
  }

  const detail = getCapabilityDetail("SESSION-COORDINATION");
  assert.ok(detail);
  assert.ok(detail.sourceFiles.every((file) => path.isAbsolute(file)));
  assert.ok(detail.options.some((item) => item.name === "PI_SIBLING_STALE_WRITES"));
  detail.sourceFiles.push("/mutating-a-copy-does-not-change-the-catalog");
  assert.equal(getCapabilityDetail("session-coordination").sourceFiles.includes("/mutating-a-copy-does-not-change-the-catalog"), false);
  assert.equal(getCapabilityDetail("unknown-capability"), undefined);
});

test("invalid paging inputs fail closed and do not expand the result page", () => {
  const { browseCapabilities, searchCapabilities } = catalog;
  const page = browseCapabilities({ limit: Number.POSITIVE_INFINITY, offset: -10 });
  assert.equal(page.limit, 3);
  assert.equal(page.offset, 0);
  assert.ok(page.results.length <= 3);
  const noMatch = searchCapabilities({ query: "\u0000\u0001" });
  assert.equal(noMatch.results.length, 0);
  assert.equal(noMatch.total, 0);
  assert.equal(searchCapabilities({ query: "memory xyzzy" }).total, 0, "one grounded term of two is not enough");
  assert.ok(searchCapabilities({ query: "prior memory" }).total >= 1, "two grounded terms still match");
});
