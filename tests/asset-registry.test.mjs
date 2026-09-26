// Asset registry: header sniffing, registration round-trip and search.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/asset-registry.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const registry = await load("extensions/lib/asset-registry.ts");

const pngBytes = (width, height, colorType) => {
  const bytes = Buffer.alloc(33, 0);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = colorType;
  return bytes;
};

test("sniffDimensions reads PNG, GIF, JPEG and WebP headers", () => {
  assert.deepEqual(registry.sniffDimensions(pngBytes(640, 480, 6)), { width: 640, height: 480, alpha: true });
  assert.deepEqual(registry.sniffDimensions(pngBytes(100, 50, 2)), { width: 100, height: 50, alpha: false });
  const gif = Buffer.alloc(10, 0);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(registry.sniffDimensions(gif), { width: 320, height: 200, alpha: null });
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x01, 0x2c, 0x01, 0x01, 0x11, 0x00]),
  ]);
  assert.deepEqual(registry.sniffDimensions(jpeg), { width: 300, height: 100, alpha: false });
  const webp = Buffer.alloc(25, 0);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBP", 8, "latin1");
  webp.write("VP8L", 12, "latin1");
  webp.writeUInt32LE(15 | (15 << 14), 21);
  assert.deepEqual(registry.sniffDimensions(webp), { width: 16, height: 16, alpha: true });
  assert.deepEqual(registry.sniffDimensions(Buffer.from("not an image at all........")), { width: null, height: null, alpha: null });
});

test("normalizeAssetInput falls back safely and validates ids", () => {
  const input = registry.normalizeAssetInput({ role: "hero-focal", kind: "generated", id: "hero-1", usage: ["a", "a", 42] });
  assert.equal(input.role, "hero-focal");
  assert.deepEqual(input.usage, ["a"]);
  assert.equal(registry.normalizeAssetInput({ role: "nope" }).role, "generic");
  assert.equal(registry.normalizeAssetInput({ id: "../evil" }).id, null);
  assert.match(registry.roleConstraints("icon").join(" "), /16px/);
  assert.ok(registry.roleConstraints("nope").length > 0);
});

test("register/search/usage round-trip stays inside the workspace", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asset-reg-"));
  try {
    await fs.promises.writeFile(path.join(dir, "hero.png"), pngBytes(1200, 800, 2));
    const { record, duplicateOf } = await registry.registerAsset(
      { path: "hero.png", role: "hero-focal", kind: "generated", prompt: "misty ridge line art", description: "industrial line illustration hero", id: "hero-ridge" },
      dir,
    );
    assert.equal(duplicateOf, null);
    assert.equal(record.id, "hero-ridge");
    assert.equal(record.width, 1200);
    assert.equal(record.height, 800);
    assert.match(record.hash, /^[0-9a-f]{16}$/);
    const dup = await registry.registerAsset({ path: "hero.png", role: "icon" }, dir);
    assert.equal(dup.duplicateOf, "hero-ridge");
    await assert.rejects(registry.registerAsset({ path: "hero.png", id: "hero-ridge" }, dir), /already registered/);
    await assert.rejects(registry.registerAsset({ path: "../escape.png" }, dir), /inside the workspace/);
    const stored = await registry.readRegistry(dir);
    assert.equal(stored.assets.length, 1);
    assert.deepEqual(registry.searchAssets(stored, { role: "hero-focal" }).map((a) => a.id), ["hero-ridge"]);
    assert.deepEqual(registry.searchAssets(stored, { query: "industrial line" }).map((a) => a.id), ["hero-ridge"]);
    assert.deepEqual(registry.searchAssets(stored, { query: "watercolor portrait" }), []);
    const used = await registry.recordAssetUsage(dir, "hero-ridge", "pages/index.html");
    assert.deepEqual(used.usage, ["pages/index.html"]);
    await fs.promises.writeFile(path.join(dir, "hero-mobile.png"), pngBytes(800, 1200, 2));
    const child = await registry.registerAsset({ path: "hero-mobile.png", role: "hero-focal", parent: "hero-ridge" }, dir);
    assert.equal(child.record.parent, "hero-ridge");
    const after = await registry.readRegistry(dir);
    assert.deepEqual(after.assets.find((a) => a.id === "hero-ridge").variants, [child.record.id]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
