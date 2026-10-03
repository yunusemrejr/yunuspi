// Persistent Needle embedding cache: round trips, invalidation, retention and
// fail-safe behaviour. Pure SQLite; no model required.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/needle-embedding-cache.mjs")));
const { openEmbeddingDisk } = await import(pathToFileURL(path.join(agent, "extensions/lib/needle-embedding-cache.mjs")));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "needle-emb-")), "nested", "cache.sqlite");
const vec = (dim, seed) => Float32Array.from({ length: dim }, (_, i) => Math.sin(seed * 31 + i) / 2);

test("vectors round trip bit-exactly and survive reopening", () => {
  const file = tmp(), dim = 16;
  const first = openEmbeddingDisk({ path: file, fingerprint: "model-a", dim });
  assert.ok(first);
  first.set("k1", vec(dim, 1)); first.set("k2", vec(dim, 2));
  assert.deepEqual([...first.get("k1")], [...vec(dim, 1)]);
  assert.equal(first.get("missing"), undefined);
  first.close();
  const again = openEmbeddingDisk({ path: file, fingerprint: "model-a", dim });
  assert.equal(again.size(), 2);
  assert.deepEqual([...again.get("k2")], [...vec(dim, 2)]);
  assert.equal(again.get("k2").length, dim);
  again.close();
});

test("a different model fingerprint or dimension discards the stored vectors", () => {
  const file = tmp();
  const a = openEmbeddingDisk({ path: file, fingerprint: "model-a", dim: 8 });
  a.set("k", vec(8, 3)); a.close();
  const b = openEmbeddingDisk({ path: file, fingerprint: "model-b", dim: 8 });
  assert.equal(b.get("k"), undefined, "vectors from another model are never served");
  assert.equal(b.size(), 0); b.set("k", vec(8, 4)); b.close();
  const c = openEmbeddingDisk({ path: file, fingerprint: "model-b", dim: 12 });
  assert.equal(c.get("k"), undefined, "a dimension change invalidates too");
  c.close();
});

test("malformed rows are ignored and input is validated", () => {
  const file = tmp();
  const store = openEmbeddingDisk({ path: file, fingerprint: "m", dim: 4 });
  store.set("wrong-length", new Float32Array(3));
  store.set("not-a-float32", [1, 2, 3, 4]);
  assert.equal(store.size(), 0);
  store.close();
  assert.equal(openEmbeddingDisk({ path: "", fingerprint: "m", dim: 4 }), null);
  assert.equal(openEmbeddingDisk({ path: file, fingerprint: "m", dim: 0 }), null);
});

test("a corrupt database file disables the layer instead of throwing", () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from("this is not a sqlite database".repeat(40)));
  assert.equal(openEmbeddingDisk({ path: file, fingerprint: "m", dim: 4 }), null);
});

test("retention keeps the newest rows once the cap is exceeded", () => {
  const store = openEmbeddingDisk({ path: tmp(), fingerprint: "m", dim: 4, maxRows: 300, keepRows: 200 });
  for (let i = 0; i < 512; i++) store.set(`k${i}`, vec(4, i));
  assert.ok(store.size() <= 300 && store.size() >= 200, `size ${store.size()}`);
  assert.deepEqual([...store.get("k511")], [...vec(4, 511)], "newest survives");
  assert.equal(store.get("k0"), undefined, "oldest was pruned");
  store.close();
});

test("two connections share one file without losing writes", () => {
  const file = tmp();
  const a = openEmbeddingDisk({ path: file, fingerprint: "m", dim: 6 });
  const b = openEmbeddingDisk({ path: file, fingerprint: "m", dim: 6 });
  a.set("from-a", vec(6, 7)); b.set("from-b", vec(6, 8));
  assert.deepEqual([...b.get("from-a")], [...vec(6, 7)]);
  assert.deepEqual([...a.get("from-b")], [...vec(6, 8)]);
  a.close(); b.close();
});
