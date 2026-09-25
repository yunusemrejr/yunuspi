import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/video-studio.ts")));
assert.ok(agent, "video studio source must exist");
const studio = await import(pathToFileURL(path.join(agent, "extensions/lib/video-studio.ts")).href);
const score = await import(pathToFileURL(path.join(agent, "extensions/lib/music-score.ts")).href);
const hooks = await import(pathToFileURL(path.join(agent, "extensions/lib/session-hooks.ts")).href);
const template = path.join(agent, "skills/remotion-video/assets/template");
const timing = await import(pathToFileURL(path.join(template, "src/timing.ts")).href);
const captions = await import(pathToFileURL(path.join(template, "src/captions.ts")).href);
const hasNumpy = spawnSync("python3", ["-c", "import numpy"]).status === 0;

const baseSpec = () => ({ fps: 30, width: 1920, height: 1080, audio: { sfx: [] }, scenes: [
  { id: "one", component: "A", seconds: 6, narration: "Short line.", narrationOffset: 0.4, cues: { a: 1 } },
  { id: "two", component: "A", seconds: 4, cues: { b: 2 } },
] });

test("beat and loop timing helpers are pure frame functions", () => {
  assert.equal(timing.beat(0, 30, 120), 0);
  assert.equal(timing.beat(7.5, 30, 120), 0.5);
  assert.equal(timing.beat(15, 30, 120), 0, "phase wraps each beat");
  assert.equal(timing.beat(-5, 30, 120), 0, "before the offset reads as beat start");
  assert.equal(timing.pulse(0, 30, 120), 1);
  assert.ok(timing.pulse(7, 30, 120) < timing.pulse(1, 30, 120) && timing.pulse(7, 30, 120) > 0);
  assert.equal(timing.beatCount(30, 30, 120), 2);
  assert.equal(timing.beatCount(0, 30, 120), 0);
  assert.equal(timing.loopProgress(15, 30), 0.5);
  assert.equal(timing.loopProgress(30, 30), 0, "loops seam back to zero");
  assert.equal(timing.pingpong(0, 40), 0);
  assert.equal(timing.pingpong(10, 40), 0.5);
  assert.equal(timing.pingpong(20, 40), 1);
  assert.equal(timing.pingpong(30, 40), 0.5);
  assert.equal(timing.hold(0), 0);
  assert.equal(timing.hold(0.5), 1);
  assert.equal(timing.hold(1), 0);
  assert.equal(timing.hold(-1), 0);
  assert.equal(timing.beat(10, 0, 120), 0, "degenerate fps never divides by zero");
});

test("caption pace reports characters per second for reading checks", () => {
  assert.equal(captions.captionPace("Hello world", 1), 11);
  assert.equal(captions.captionPace("  spaced   out  ", 2), 5);
  assert.equal(captions.captionPace("", 5), null);
  assert.equal(captions.captionPace("ab", 0), null);
});

test("timeline validation covers vertical transitions, volumes and caption pace", () => {
  const spec = baseSpec();
  spec.scenes[0].transition = { type: "slideup", seconds: 0.4 };
  spec.scenes[1].transition = { type: "slidedown", seconds: 0.4 };
  spec.audio = { musicVolume: 0.22, musicDuckedVolume: 0.07, narrationVolume: 1, sfx: [{ src: "audio/hit.wav", at: 1, volume: 0.6 }] };
  assert.deepEqual(studio.validateVideoSpec(spec, new Set(["A"]), () => true).issues, []);
  const bad = baseSpec();
  bad.audio = { musicVolume: 3, musicDuckedVolume: 0.5, narrationVolume: 1, sfx: [{ src: "audio/hit.wav", at: 1, volume: -1 }] };
  bad.scenes[0].transition = { type: "spin" };
  const messages = studio.validateVideoSpec(bad, new Set(["A"]), () => true).issues.map((i) => i.message).join("\n");
  assert.match(messages, /transition\.type must be fade, slide, slideup, slidedown/);
  assert.match(messages, /musicVolume must be a number 0\.\.2/);
  assert.match(messages, /volume must be a number 0\.\.2/);
  const ducked = baseSpec();
  ducked.audio = { musicVolume: 0.1, musicDuckedVolume: 0.2, sfx: [] };
  assert.match(studio.validateVideoSpec(ducked, new Set(["A"]), () => true).issues.map((i) => i.message).join("\n"), /musicDuckedVolume should sit below musicVolume/);
  const dense = baseSpec();
  Object.assign(dense.scenes[0], { narration: "An extraordinarily complicated representation, unquestionably overwhelming comprehension and more.", narrationAudio: "n.wav", narrationSeconds: 2 });
  assert.match(studio.validateVideoSpec(dense, new Set(["A"]), () => true).issues.map((i) => i.message).join("\n"), /caption text runs at .* characters\/s/);
  const calm = baseSpec();
  Object.assign(calm.scenes[0], { narration: "Short line.", narrationAudio: "n.wav", narrationSeconds: 2 });
  assert.doesNotMatch(studio.validateVideoSpec(calm, new Set(["A"]), () => true).issues.map((i) => i.message).join("\n"), /characters\/s/);
});

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

test("procedural drums default off, stay deterministic and keep old bytes", { skip: !hasNumpy }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synth-drums-"));
  try {
    const synth = path.join(agent, "skills/procedural-audio/scripts/synth.py");
    const render = (spec, out) => {
      const specPath = path.join(root, `${out}.json`);
      fs.writeFileSync(specPath, JSON.stringify(spec));
      return JSON.parse(execFileSync("python3", [synth, specPath, path.join(root, out)], { encoding: "utf8" }));
    };
    const bed = { kind: "music", seconds: 4, bpm: 90, key: "A", mode: "minor", seed: 3 };
    render(bed, "plain.wav");
    render({ ...bed, layers: { drums: 0 } }, "nodrums.wav");
    assert.deepEqual(fs.readFileSync(path.join(root, "plain.wav")), fs.readFileSync(path.join(root, "nodrums.wav")), "drums:0 renders the historical bytes");
    const first = render({ ...bed, layers: { drums: 0.4 } }, "drums-a.wav");
    render({ ...bed, layers: { drums: 0.4 } }, "drums-b.wav");
    assert.deepEqual(fs.readFileSync(path.join(root, "drums-a.wav")), fs.readFileSync(path.join(root, "drums-b.wav")), "same seed, same bytes");
    assert.notDeepEqual(fs.readFileSync(path.join(root, "drums-a.wav")), fs.readFileSync(path.join(root, "plain.wav")), "drums are audible in the mix");
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

test("video workflow hooks fire once per session on their tools", () => {
  for (const key of ["video-timeline-check", "video-render-review", "video-qa-review", "narration-fit", "audio-synth-balance", "timeline-compose-review"]) {
    assert.ok(hooks.HOOK_RULES.some((rule) => rule.key === key), `${key} is registered`);
  }
  assert.equal(hooks.matchHook("video_project", {})?.key, "video-timeline-check");
  assert.equal(hooks.matchHook("video_render", {})?.key, "video-render-review");
  assert.equal(hooks.matchHook("video_qa", {})?.key, "video-qa-review");
  assert.equal(hooks.matchHook("narration_tts", {})?.key, "narration-fit");
  assert.equal(hooks.matchHook("audio_synth", {})?.key, "audio-synth-balance");
  assert.equal(hooks.matchHook("video_compose", {})?.key, "timeline-compose-review");
  assert.equal(hooks.matchHook("audio_mix", {})?.key, "timeline-compose-review");
});

test("template wires vertical transitions, timing helpers and new primitives", () => {
  const main = fs.readFileSync(path.join(template, "src/Main.tsx"), "utf8");
  assert.match(main, /slideup/);
  assert.match(main, /slidedown/);
  assert.match(fs.readFileSync(path.join(template, "src/timeline.ts"), "utf8"), /"slideup" \| "slidedown"/);
  assert.match(fs.readFileSync(path.join(template, "src/motion.ts"), "utf8"), /from "\.\/timing"/);
  const index = fs.readFileSync(path.join(template, "src/primitives/index.ts"), "utf8");
  for (const name of ["LowerThird", "Counter", "ProgressBar", "Callout"]) {
    assert.match(index, new RegExp(`\\./${name}"`), `${name} is exported`);
    const source = fs.readFileSync(path.join(template, "src/primitives", `${name}.tsx`), "utf8");
    assert.doesNotMatch(source, /Math\.random|Date\.now/, `${name} is frame-deterministic`);
    assert.match(source, /progress/, `${name} is progress-driven`);
  }
});

console.log("PASS video-motion-upgrade: timing, captions, lexicon, drums, score, hooks and primitives");
