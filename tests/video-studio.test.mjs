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
const { skillRoutes } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/skill-routing.ts")).href);
const template = path.join(agent, "skills/remotion-video/assets/template");
const example = path.join(agent, "skills/code-first-video/assets/example-attention");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasNumpy = spawnSync("python3", ["-c", "import numpy"]).status === 0;

const registry = (file) => new Set([...(/scenes\s*:[^=]*=\s*\{([\s\S]*?)\}/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "").matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
const baseSpec = () => ({ fps: 30, width: 1920, height: 1080, audio: { sfx: [] }, scenes: [
  { id: "one", component: "A", seconds: 6, narration: "Short line.", narrationOffset: 0.4, cues: { a: 1 } },
  { id: "two", component: "A", seconds: 4, cues: { b: 2 } },
] });

test("template and worked example satisfy the timeline contract", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(template, "video.json"), "utf8"));
  const result = studio.validateVideoSpec(spec, registry(path.join(template, "src/scenes/index.ts")), () => true);
  assert.deepEqual(result.issues.filter((i) => i.severity === "error"), []);
  assert.equal(result.seconds, spec.scenes.reduce((sum, s) => sum + s.seconds, 0));
  const exampleSpec = JSON.parse(fs.readFileSync(path.join(example, "video.json"), "utf8"));
  const exampleResult = studio.validateVideoSpec(exampleSpec, registry(path.join(example, "scenes/index.ts")), () => false);
  assert.deepEqual(exampleResult.issues.filter((i) => i.severity === "error"), [], "the example ships without audio but with a valid timeline");
  for (const scene of fs.readdirSync(path.join(example, "scenes")).filter((f) => f.endsWith(".tsx"))) {
    for (const [, name] of fs.readFileSync(path.join(example, "scenes", scene), "utf8").matchAll(/import \{([^}]+)\} from "\.\.\/primitives"/g)) {
      for (const primitive of name.split(",").map((s) => s.trim()).filter(Boolean)) {
        assert.match(fs.readFileSync(path.join(template, "src/primitives/index.ts"), "utf8"), new RegExp(`\\b${primitive}\\b`), `${scene} imports template primitive ${primitive}`);
      }
    }
  }
});

test("template pins exact dependency versions and local fonts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(template, "package.json"), "utf8"));
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  const remotion = Object.entries(pkg.dependencies).filter(([name]) => name === "remotion" || name.startsWith("@remotion/")).map(([, v]) => v);
  assert.equal(new Set(remotion).size, 1, "all Remotion packages share one version");
  const fonts = fs.readFileSync(path.join(template, "src/fonts.ts"), "utf8");
  for (const family of ["inter", "fraunces", "jetbrains-mono"]) assert.match(fonts, new RegExp(`@fontsource/${family}/`));
  assert.match(fonts, /delayRender/, "rendering waits for fonts");
  for (const file of fs.readdirSync(path.join(template, "src/primitives"))) {
    const source = fs.readFileSync(path.join(template, "src/primitives", file), "utf8");
    assert.doesNotMatch(source, /Math\.random|Date\.now/, `${file} is frame-deterministic`);
  }
  const exports = fs.readFileSync(path.join(template, "src/primitives/index.ts"), "utf8");
  for (const file of fs.readdirSync(path.join(template, "src/primitives")).filter((f) => f.endsWith(".tsx"))) assert.match(exports, new RegExp(`\\./${file.replace(".tsx", "")}"`));
});

test("timeline validation reports structure, cue, narration and asset defects", () => {
  const ok = studio.validateVideoSpec(baseSpec(), new Set(["A"]), () => true);
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.scenes.map((s) => [s.id, s.start, s.end]), [["one", 0, 6], ["two", 6, 10]]);
  const bad = baseSpec();
  bad.scenes[1].id = "one";
  bad.scenes[0].component = "Missing";
  bad.scenes[0].cues.late = 6;
  bad.scenes[0].narrationAudio = "audio/narration/one.wav";
  bad.scenes[0].narrationSeconds = 5.8;
  bad.audio.music = "audio/music.wav";
  bad.audio.sfx = [{ src: "audio/hit.wav", at: 99 }];
  const messages = studio.validateVideoSpec(bad, new Set(["A"]), () => false).issues.map((i) => i.message).join("\n");
  for (const expected of [/duplicate scene id/, /not registered/, /cue "late" must be inside/, /narration audio .* is missing/, /overruns the scene/, /music .* is missing/, /outside the timeline/]) assert.match(messages, expected);
  const fast = baseSpec();
  Object.assign(fast.scenes[0], { narration: "An extraordinarily complicated representation, unquestionably overwhelming comprehension.", narrationAudio: "n.wav", narrationSeconds: 2 });
  assert.match(studio.validateVideoSpec(fast, new Set(["A"]), () => true).issues.map((i) => i.message).join("\n"), /syllables\/s is hard to follow/);
  assert.equal(studio.syllables("In this sentence, what does the word it refer to?"), 12);
  assert.equal(studio.syllables("language models"), 4);
});

test("stills sample settled frames and contact sheets stay legible", () => {
  const { scenes } = studio.validateVideoSpec(baseSpec(), new Set(["A"]), () => true);
  assert.equal(studio.settledSeconds({ seconds: 10, cues: { reveal: 6 } }), 7.5, "a late cue gets time to settle");
  assert.equal(studio.settledSeconds({ seconds: 10, cues: { a: 1 } }), 6, "never earlier than 60%");
  assert.equal(studio.settledSeconds({ seconds: 4, cues: { a: 3.9 } }), 3.68, "never later than 92%");
  assert.deepEqual(studio.planStillFrames(scenes, 30).map((p) => p.frame), [108, 285], "scene two settles 1.5s after its last cue");
  assert.equal(studio.planStillFrames(scenes, 30, { scene: "two", count: 3 }).length, 3);
  assert.deepEqual(studio.planStillFrames(scenes, 30, { times: [0, 99] }).map((p) => p.frame), [0, 299], "explicit times are clamped to the video");
  assert.throws(() => studio.planStillFrames(scenes, 30, { scene: "nope" }), /Unknown scene/);
  assert.match(studio.contactSheetFilter(["a", "b", "c", "d"]), /xstack=inputs=4:layout=0_0\|960_0\|0_540\|960_540/, "four frames get 960px cells in two columns");
  assert.match(studio.contactSheetFilter(Array.from({ length: 12 }, (_, i) => `f${i}`)), /scale=480:270/);
  assert.doesNotMatch(studio.contactSheetFilter(["bad'label;[x]"]), /bad'|\[x\]/, "labels cannot inject filter syntax");
});

test("QA parsing and findings separate defects from intentional structure", () => {
  const log = [
    "[blackdetect @ 0x1] black_start:0 black_end:0.5 black_duration:0.5",
    "[blackdetect @ 0x1] black_start:6 black_end:6.4 black_duration:0.4",
    "[blackdetect @ 0x1] black_start:3 black_end:4.5 black_duration:1.5",
    "[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 1",
    "[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 3.5",
    "[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 4",
    "[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 9",
    "[silencedetect @ 0x3] silence_start: 7",
    "[silencedetect @ 0x3] silence_end: 8.9 | silence_duration: 1.9",
    "[Parsed_ebur128_1 @ 0x4] t: 1.0   TARGET:-23 LUFS    M: -40.0 S: -40.0     I: -40.0 LUFS",
    "[Parsed_ebur128_1 @ 0x4] t: 1.1   TARGET:-23 LUFS    M: -38.0 S: -40.0     I: -40.0 LUFS",
    "[Parsed_ebur128_1 @ 0x4] Summary:",
    "  Integrated loudness:\n    I:         -21.0 LUFS\n  Loudness range:\n    LRA:        16.5 LU\n  True peak:\n    Peak:       -0.4 dBFS",
  ].join("\n");
  const metrics = studio.parseQaLog(log, 10);
  assert.equal(metrics.black.length, 3);
  assert.deepEqual(metrics.freeze, [{ start: 1, end: 3.5 }, { start: 4, end: 9 }]);
  assert.deepEqual(metrics.silence, [{ start: 7, end: 8.9 }]);
  assert.deepEqual([metrics.integratedLufs, metrics.loudnessRange, metrics.truePeak], [-21, 16.5, -0.4]);
  assert.deepEqual(metrics.momentary, [[1, -40], [1.1, -38]]);
  const { scenes } = studio.validateVideoSpec(baseSpec(), new Set(["A"]), () => true);
  scenes[0].narrationAudio = "n.wav"; scenes[0].narrationSeconds = 1;
  const findings = studio.qaFindings(metrics, { duration: 10, hasAudio: true, targetLufs: -16, videoDuration: 10, audioDuration: 10.3 }, scenes);
  const text = findings.map((f) => `${f.severity}:${f.message}`).join("\n");
  assert.match(text, /almost entirely background 3\.00/);
  assert.doesNotMatch(text, /background 6\.00|background 0\.00/, "video edges and sub-second scene entrances are expected");
  assert.match(text, /static for 5\.0s/);
  assert.doesNotMatch(text, /static for 2\.5s/, "short reading holds are not defects");
  assert.match(text, /silent 7\.0/);
  assert.match(text, /error:Audio \(10\.30s\) and video/);
  assert.match(text, /error:Peak -0\.4/);
  assert.match(text, /off target -16/);
  assert.match(text, /Loudness range 16\.5/);
  assert.match(text, /error:Narration is barely audible/);
  assert.match(studio.qaFindings(studio.parseQaLog("", 5), { duration: 5, hasAudio: false, targetLufs: -16 }, scenes).map((f) => f.message).join(), /no audio stream/);
});

test("video_qa measures a real render and produces a contact sheet", { skip: !hasFfmpeg }, async () => {
  const root = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "video-qa-"));
  try {
    const file = path.join(root, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
    const report = await studio.videoQa({ path: file }, root);
    assert.equal(report.hasAudio, true);
    assert.ok(Math.abs(report.seconds - 6) < 0.2);
    assert.equal(typeof report.loudness.integratedLufs, "number");
    assert.ok(fs.statSync(report.contactSheet).size > 1000);
    assert.equal(report.passedAutomatedChecks, true);
    assert.match(report.review, /open the contact sheet/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("procedural audio is deterministic and within level bounds", { skip: !hasNumpy }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synth-"));
  try {
    const synth = path.join(agent, "skills/procedural-audio/scripts/synth.py");
    const render = (spec, out) => JSON.parse(execFileSync("python3", [synth, (fs.writeFileSync(path.join(root, "s.json"), JSON.stringify(spec)), path.join(root, "s.json")), path.join(root, out)], { encoding: "utf8" }));
    const music = { kind: "music", seconds: 4, bpm: 90, key: "A", mode: "minor", seed: 3 };
    const first = render(music, "a.wav"), second = render(music, "b.wav");
    assert.deepEqual(fs.readFileSync(path.join(root, "a.wav")), fs.readFileSync(path.join(root, "b.wav")), "same seed, same bytes");
    assert.equal(first.seconds, 4);
    assert.ok(first.peakDbfs <= -0.9 && Math.abs(first.rmsDbfs + 20) < 1.5, JSON.stringify(first));
    assert.deepEqual(second, { ...first, output: path.join(root, "b.wav") });
    for (const type of ["whoosh", "riser", "impact", "tick", "chime"]) assert.ok(render({ kind: "sfx", type }, `${type}.wav`).peakDbfs <= -0.9);
    assert.throws(() => render({ kind: "sfx", type: "explosion" }, "x.wav"), /sfx type must be/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("video requests route to the direction skill without catching players or edits", () => {
  const route = (name) => skillRoutes.find((r) => r.name === name);
  const video = route("code-first-video");
  for (const prompt of ["make a three-minute documentary-style video explaining the history of transformers", "create a short video about attention", "write the storyboard for our launch", "make a 30 second video for the release"]) assert.ok(video.intent.test(prompt), prompt);
  for (const prompt of ["build a video player component", "trim this video to 10 seconds", "render the video thumbnail", "create the video file upload"]) assert.equal(video.intent.test(prompt), false, prompt);
  assert.ok(route("remotion-video").intent.test("fix the Remotion composition"));
  assert.ok(route("procedural-audio").intent.test("add background music and a whoosh"));
});

test("video studio registers five lazily discovered tools", async () => {
  const tools = [];
  const extension = await import(pathToFileURL(path.join(agent, "extensions/video-studio.ts")).href);
  extension.default({ registerTool: (tool) => tools.push(tool) });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["audio_synth", "narration_tts", "video_project", "video_qa", "video_render"]);
  const { CORE_TOOLS } = await import(pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts")).href);
  for (const tool of tools) {
    assert.equal(CORE_TOOLS.has(tool.name), false, `${tool.name} stays off-wire until tool_search enables it`);
    assert.ok(tool.description.length > 80 && tool.parameters?.type === "object");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(agent, "extensions/manifest.json"), "utf8"));
  assert.ok(manifest.extensions.includes("video-studio.ts") && manifest.lib.includes("video-studio.ts") && manifest.supportFiles.includes("scripts/video-render.mjs"));
  for (const voice of Object.values(studio.PIPER_VOICES)) for (const file of voice.files) {
    assert.match(file.url, /^https:\/\/huggingface\.co\/rhasspy\/piper-voices\/resolve\/v1\.0\.0\//, "voices resolve from an immutable tag");
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});
