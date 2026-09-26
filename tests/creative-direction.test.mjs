// Creative Direction State: one validated brief every creative subsystem
// reads, instead of prose scattered across skills.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/creative-direction.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const creative = await load("extensions/lib/creative-direction.ts");

const MINIMAL = { intent: ["editorial", "restrained"], hierarchy: { primary: "content" } };

test("normalizeDirection validates, normalizes and drops unknown fields", () => {
  const direction = creative.normalizeDirection({
    ...MINIMAL,
    name: "  Launch page ",
    visual: { density: "medium", bogus: "dropped" },
    avoid: ["neon glow", "neon glow", "  ", 42],
    motion: { continuous: false, character: "precise" },
    extra: "dropped",
  });
  assert.equal(direction.format, "yunuspi-creative-direction-v1");
  assert.equal(direction.name, "Launch page");
  assert.deepEqual(direction.avoid, ["neon glow"]);
  assert.deepEqual(direction.visual, { density: "medium" });
  assert.deepEqual(direction.motion, { character: "precise", continuous: false });
  assert.ok(!("extra" in direction) && !("bogus" in direction.visual));
  assert.ok(Number.isFinite(direction.updatedAt));
});

test("normalizeDirection requires a focal decision and bounds lists", () => {
  assert.throws(() => creative.normalizeDirection({ intent: ["x"] }), /hierarchy\.primary/);
  assert.throws(() => creative.normalizeDirection({ hierarchy: { primary: "content" } }), /intent/);
  assert.throws(() => creative.normalizeDirection("nope"), /must be an object/);
  const many = creative.normalizeDirection({ ...MINIMAL, intent: Array.from({ length: 20 }, (_, i) => `term-${i}`) });
  assert.equal(many.intent.length, 12);
  const long = creative.normalizeDirection({ ...MINIMAL, name: "x".repeat(500) });
  assert.equal(long.name.length, 120);
});

test("renderDirectionBrief stays bounded and names the loop inputs", () => {
  const direction = creative.normalizeDirection({
    ...MINIMAL, name: "brief", avoid: ["gradient text", "pill spam"],
    motion: { character: "precise" }, audio: { music: "none" }, references: ["ref-a"],
  });
  const brief = creative.renderDirectionBrief(direction);
  assert.match(brief, /Creative direction "brief"/);
  assert.match(brief, /focal|primary content/);
  assert.match(brief, /avoid: gradient text; pill spam/);
  assert.ok(brief.length <= 1600);
  assert.match(creative.directionSummary(direction), /brief: editorial\/restrained · focal content/);
});

test("matchAvoidSignals matches shared vocabulary, not substrings", () => {
  const direction = creative.normalizeDirection({ ...MINIMAL, avoid: ["neon glow", "pill spam", "xy"] });
  const hits = creative.matchAvoidSignals(direction, [
    "decorative glow behind hero",
    "repeated pill capsules in nav",
    "glowing review copy",
    "",
  ]);
  assert.ok(hits.some((h) => h.avoid === "neon glow" && /glow behind hero/.test(h.signal)));
  assert.ok(hits.some((h) => h.avoid === "pill spam"));
  assert.ok(!hits.some((h) => /glowing review/.test(h.signal)), "glow must not match glowing prose");
  const capped = creative.matchAvoidSignals(direction, Array.from({ length: 100 }, () => "glow everywhere"));
  assert.ok(capped.length <= 24);
});

test("parseDirectionFile degrades corrupt briefs to undefined", () => {
  const direction = creative.normalizeDirection(MINIMAL);
  const round = creative.parseDirectionFile(JSON.stringify({ ...direction, updatedAt: 123 }));
  assert.equal(round.hierarchy.primary, "content");
  assert.equal(round.updatedAt, 123);
  assert.equal(creative.parseDirectionFile("{"), undefined);
  assert.equal(creative.parseDirectionFile(JSON.stringify({ format: "other" })), undefined);
  assert.equal(creative.parseDirectionFile(JSON.stringify({ format: "yunuspi-creative-direction-v1" })), undefined);
});
