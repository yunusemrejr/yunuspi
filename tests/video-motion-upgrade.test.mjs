import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertDifferentBytes, assertSameBytes } from "./bytes.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/video-studio.ts")));
assert.ok(agent, "video studio source must exist");
const studio = await import(pathToFileURL(path.join(agent, "extensions/lib/video-studio.ts")).href);
const score = await import(pathToFileURL(path.join(agent, "extensions/lib/music-score.ts")).href);
const hasNumpy = spawnSync("python3", ["-c", "import numpy"]).status === 0;

test("pronunciation lexicon validates, orders longest-first and applies literally", () => {
  assert.deepEqual(studio.validateLexicon(undefined), []);
  assert.deepEqual(studio.validateLexicon({ GPT: "G P T" }), [["GPT", "G P T"]]);
  assert.deepEqual(studio.validateLexicon({ GPT: "x", "GPT-4": "y" }).map(([k]) => k), ["GPT-4", "GPT"]);
  assert.deepEqual(studio.applyLexicon("GPT-4 and GPT", [["GPT-4", "gee pee tee four"], ["GPT", "gee pee tee"]]), { text: "gee pee tee four and gee pee tee", edits: 2 });
  assert.deepEqual(studio.applyLexicon("plain text", [["GPT", "x"]]), { text: "plain text", edits: 0 });
  assert.throws(() => studio.validateLexicon([["a", "b"]]), /lexicon must be an object/);
  assert.throws(() => studio.validateLexicon(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`w${i}`, "x"]))), /at most 64/);
  assert.throws(() => studio.validateLexicon({ "": "x" }), /spellings must be/);
  assert.throws(() => studio.validateLexicon({ a: " ".repeat(129) }), /pronunciations must be/);
});

test("procedural drums follow the style arrangement, can be removed and stay deterministic", { skip: !hasNumpy }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synth-drums-"));
  try {
    const synth = path.join(agent, "skills/audio/scripts/synth.py");
    const render = (spec, out) => {
      const specPath = path.join(root, `${out}.json`);
      fs.writeFileSync(specPath, JSON.stringify(spec));
      return JSON.parse(execFileSync("python3", [synth, specPath, path.join(root, out)], { encoding: "utf8" }));
    };
    const bed = { kind: "music", seconds: 4, bpm: 90, key: "A", mode: "minor", seed: 3 };
    const wav = (name) => fs.readFileSync(path.join(root, name));
    render(bed, "plain.wav");
    render(bed, "plain-again.wav");
    assertSameBytes(wav("plain.wav"), wav("plain-again.wav"), "same seed, same bytes");
    render({ ...bed, layers: { drums: 0 } }, "nodrums.wav");
    assertDifferentBytes(wav("nodrums.wav"), wav("plain.wav"), "the style's own drum arrangement is audible until layers.drums removes it");
    const first = render({ ...bed, layers: { drums: 0.4 } }, "drums-a.wav");
    render({ ...bed, layers: { drums: 0.4 } }, "drums-b.wav");
    assertSameBytes(wav("drums-a.wav"), wav("drums-b.wav"), "same seed, same bytes");
    assertDifferentBytes(wav("drums-a.wav"), wav("nodrums.wav"), "drums are audible in the mix");
    assert.ok(first.peakDbfs <= -0.9, JSON.stringify(first));
    for (const type of ["downlifter", "pop"]) {
      const sfx = render({ kind: "sfx", type }, `${type}.wav`);
      assert.ok(sfx.peakDbfs <= -0.9, `${type}: ${JSON.stringify(sfx)}`);
      assert.ok(sfx.seconds > 0.05, `${type} has a body`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("score audition adds band-limited square/saw, pan and stereo without changing mono", async () => {
  assert.equal(score.oscillator("sine", 0, 440), 0);
  assert.ok(Math.abs(score.oscillator("triangle", Math.PI / 2, 110) - 1) < 0.1);
  assert.ok(Math.abs(score.oscillator("square", Math.PI / 2, 110) - 1) < 0.15);
  assert.ok(Math.abs(score.oscillator("saw", Math.PI / 2, 110) - 0.5) < 0.1);
  assert.equal(score.oscillator("square", 1, 30000), 0, "harmonics above Nyquist are silent");
  assert.throws(() => score.validateScore({ tracks: [{ waveform: "pulse", notes: [{ pitch: 60, start: 0, duration: 1 }] }] }), /waveform must be sine, triangle, square or saw/);
  assert.throws(() => score.validateScore({ stereo: "yes", tracks: [{ notes: [{ pitch: 60, start: 0, duration: 1 }] }] }), /stereo must be true or false/);
  const one = { bpm: 120, beats: 4, tracks: [{ waveform: "triangle", notes: [{ pitch: 69, start: 0, duration: 1 }] }] };
  assert.equal(score.validateScore(one).tracks[0].pan, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "score-stereo-"));
  try {
    const mono = await score.composeMusic({ score: one }, root);
    assert.equal(mono.channels, 1);
    const wav = (dir) => fs.readFileSync(path.join(dir, "preview.wav"));
    const monoBytes = wav(path.dirname(mono.files[0].path));
    assert.equal(monoBytes.readUInt16LE(22), 1, "mono header keeps one channel");
    const stereo = await score.composeMusic({ score: { ...one, stereo: true, tracks: [{ waveform: "square", pan: -1, notes: [{ pitch: 69, start: 0, duration: 4 }] }] } }, root);
    assert.equal(stereo.channels, 2);
    const stereoBytes = wav(path.dirname(stereo.files[0].path));
    assert.equal(stereoBytes.readUInt16LE(22), 2, "stereo header carries two channels");
    let leftPeak = 0, rightPeak = 0;
    for (let i = 44; i + 3 < stereoBytes.length; i += 4) {
      leftPeak = Math.max(leftPeak, Math.abs(stereoBytes.readInt16LE(i)));
      rightPeak = Math.max(rightPeak, Math.abs(stereoBytes.readInt16LE(i + 2)));
    }
    assert.ok(leftPeak > 1000 && rightPeak < leftPeak / 4, `hard-left pan images left (${leftPeak} vs ${rightPeak})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log("PASS video-motion-upgrade: lexicon, drums and score");
