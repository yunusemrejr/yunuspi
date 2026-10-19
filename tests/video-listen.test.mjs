import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) => fs.existsSync(path.join(p, "extensions/lib/video-listen.ts")));
assert.ok(agent, "video listen source must exist");
const listen = await import(pathToFileURL(path.join(agent, "extensions/lib/video-listen.ts")).href);
const helper = path.join(agent, "scripts/asr-listen.py");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
const systemHasWhisper = hasPython && spawnSync("python3", ["-I", "-c", "import faster_whisper"]).status === 0;

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? "value"}: ${actual} not within ${tolerance} of ${expected}`);
const tmpDir = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-listen-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Run `fn` with env vars set (undefined deletes), restoring the previous values afterwards. */
async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** 16 kHz mono 16-bit WAV written by hand, so tests need no ffmpeg just to make input. */
function writeWav(file, samples, rate = 16000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}
/** Sine of `seconds` at `hz`, amplitude `amp(t)` (number or function of time). */
function tone(seconds, hz, amp, rate = 16000) {
  const out = new Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = (typeof amp === "function" ? amp(t) : amp) * Math.sin(2 * Math.PI * hz * t);
  }
  return out;
}
const mix = (...tracks) => tracks[0].map((_, i) => tracks.reduce((sum, track) => sum + track[i], 0));

/** Words spaced evenly from `start`, each `step` seconds long. */
function wordsFrom(text, start, step) {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, s: Number((start + i * step).toFixed(3)), e: Number((start + (i + 1) * step).toFixed(3)), p: 0.9 }));
}
function resultFixture(file, { text, words, speechWindows, meanLogprob = -0.2, duration = 3 }) {
  const body = { model: "small.en", language: "en", durationSeconds: duration, text, words, wordCount: words.length, wordsTruncated: false,
    segments: [{ s: words[0]?.s ?? 0, e: words.at(-1)?.e ?? 0, avgLogprob: meanLogprob, noSpeechProb: 0.01 }],
    meanLogprob: words.length ? meanLogprob : null, speechSeconds: 1, speechWindows: speechWindows ?? [] };
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

/** Stand-in for `python -I asr-listen.py`: a node script with a shebang, so it runs anywhere node does.
 * It answers the import probe, logs the request it received, and prints the fixture as the result. */
function fakePython(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[1] === "-c") {
  if (process.env.FAKE_ASR_PROBES) fs.appendFileSync(process.env.FAKE_ASR_PROBES, "probe\\n");
  if (process.env.FAKE_ASR_IMPORT === "fail") { console.error("ModuleNotFoundError: No module named 'faster_whisper'"); process.exitCode = 1; }
} else {
  const request = JSON.parse(fs.readFileSync(args[args.length - 1], "utf8"));
  if (process.env.FAKE_ASR_LOG) fs.appendFileSync(process.env.FAKE_ASR_LOG, JSON.stringify(request) + "\\n");
  process.stdout.write("LISTEN_PROGRESS loading fake model\\n");
  if (process.env.FAKE_ASR_MODE === "error") { process.stdout.write("LISTEN_ERROR model small.en is not cached locally\\n"); process.exitCode = 2; }
  else {
    const result = fs.readFileSync(process.env.FAKE_ASR_FIXTURE, "utf8");
    if (request.resultFile) fs.writeFileSync(request.resultFile, result);
    process.stdout.write("LISTEN_RESULT " + result + "\\n");
  }
}
`, { mode: 0o755 });
  return file;
}

// ---- pure helpers ----------------------------------------------------------

test("normalizeWords lowercases, drops apostrophes and splits punctuation, dashes and digit groups", () => {
  assert.deepEqual(listen.normalizeWords("Welcome, to THE car—it's 1,228 km/h! Café"), ["welcome", "to", "the", "car", "its", "1", "228", "km", "h", "café"]);
  assert.deepEqual(listen.normalizeWords("  \n "), []);
  assert.deepEqual(listen.normalizeWords("Thrust-SSC (1997)."), ["thrust", "ssc", "1997"]);
});

test("wordErrorRate counts substitutions, deletions and insertions over the script length", () => {
  const words = (s) => s.split(" ");
  assert.equal(listen.wordErrorRate(words("a b c"), words("a b c")), 0);
  assert.equal(listen.wordErrorRate(words("a b c"), words("a x c")), 1 / 3);
  assert.equal(listen.wordErrorRate(words("a b c"), words("a c")), 1 / 3);
  assert.equal(listen.wordErrorRate(words("a b c"), words("a b c d")), 1 / 3);
  assert.equal(listen.wordErrorRate(words("a b c"), []), 1);
  assert.equal(listen.wordErrorRate(words("a b c"), words("x y z")), 1);
  assert.equal(listen.wordErrorRate([], []), 0);
  assert.equal(listen.wordErrorRate([], words("a")), 1);
  const script = Array.from({ length: 20 }, (_, i) => `w${i}`);
  const heard = script.map((w, i) => (i < 3 ? "x" : w));
  assert.equal(listen.wordErrorRate(script, heard), 0.15, "3 of 20 words wrong sits exactly on the limit");
});

test("scriptWords reads plain text, narration JSON scenes, keyed narration and rejects empty or bad files", () => {
  assert.deepEqual(listen.scriptWords("# Hook\n\nThis is ThrustSSC.", "script.md"), ["hook", "this", "is", "thrustssc"]);
  const scenes = JSON.stringify({ scenes: [{ id: "hook", narration: "This is ThrustSSC." }, { id: "shape", lines: ["Start with the shape."] }] });
  assert.deepEqual(listen.scriptWords(scenes, "narration.json"), ["this", "is", "thrustssc", "start", "with", "the", "shape"]);
  const keyed = JSON.stringify({ hook: { display: "In 1997, it broke the barrier.", seconds: 4 }, cta: { display: "Learn more." } });
  assert.deepEqual(listen.scriptWords(keyed, "narration.json"), ["in", "1997", "it", "broke", "the", "barrier", "learn", "more"]);
  const bare = JSON.stringify(["Plain line one.", "Plain line two."]);
  assert.deepEqual(listen.scriptWords(bare, "lines.json"), ["plain", "line", "one", "plain", "line", "two"]);
  assert.throws(() => listen.scriptWords(JSON.stringify({ id: "hook", seconds: 4 }), "narration.json"), /no narration text/);
  assert.throws(() => listen.scriptWords("{not json", "narration.json"), /not valid JSON/);
});

test("numberNotes reports digits missing from the transcript without treating them as failures", () => {
  const notes = listen.numberNotes(["the", "1228", "km", "1997"], ["the", "one", "thousand", "1997", "km"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /"1228" in the script/);
  assert.deepEqual(listen.numberNotes(["a"], ["a"]), []);
});

test("listenVerdicts passes a clean master and fails each measured limit with the fix", () => {
  const clean = { wer: 0.1, meanLogprob: -0.2, speechOverMusicDb: 12, integratedLufs: -16, truePeakDbtp: -1.5, targetLufs: -16 };
  assert.deepEqual(listen.listenVerdicts(clean).findings, []);
  assert.equal(listen.listenVerdicts(clean).passed, true);
  assert.equal(listen.listenVerdicts({ ...clean, speechOverMusicDb: 3.2 }).passed, false);
  const drowned = listen.listenVerdicts({ ...clean, speechOverMusicDb: 3.2 }).findings;
  assert.equal(drowned[0].severity, "error");
  assert.match(drowned[0].message, /only 3.2 dB above the music/);
  assert.match(drowned[0].message, /at least 7 dB/);
  assert.match(drowned[0].message, /re-master/);
});

test("listenVerdicts boundaries: WER and log-probability floor", () => {
  const base = { wer: 0.15, meanLogprob: null, speechOverMusicDb: 20, integratedLufs: -16, truePeakDbtp: -1, targetLufs: -16 };
  assert.equal(listen.listenVerdicts(base).intelligible, true, "WER exactly 0.15 is intelligible");
  assert.equal(listen.listenVerdicts({ ...base, wer: 0.1501 }).intelligible, false, "just above 0.15 is not");
  const noScript = { ...base, wer: null };
  assert.equal(listen.listenVerdicts({ ...noScript, meanLogprob: -0.59 }).intelligible, true);
  assert.equal(listen.listenVerdicts({ ...noScript, meanLogprob: -0.6 }).intelligible, false, "the floor is strict");
  assert.equal(listen.listenVerdicts({ ...noScript, meanLogprob: null }).intelligible, false, "no words is not intelligible");
  assert.match(listen.listenVerdicts({ ...noScript, meanLogprob: null }).findings[0].message, /no words/);
});

test("listenVerdicts boundaries: balance thresholds for stems and for the master-only estimate", () => {
  const stems = { wer: 0, meanLogprob: -0.2, integratedLufs: -16, truePeakDbtp: -1, targetLufs: -16 };
  assert.equal(listen.listenVerdicts({ ...stems, speechOverMusicDb: 10 }).balanced, true, "exactly 10 dB");
  assert.equal(listen.listenVerdicts({ ...stems, speechOverMusicDb: 9.99 }).balanced, false);
  assert.match(listen.listenVerdicts({ ...stems, speechOverMusicDb: 9.99 }).findings[0].message, /at least 1 dB/);
  assert.equal(listen.listenVerdicts({ ...stems, speechOverMusicDb: null }).balanced, false);
  const estimate = { wer: 0, meanLogprob: -0.2, integratedLufs: -16, truePeakDbtp: -1, targetLufs: -16 };
  const bed = (db) => listen.listenVerdicts({ ...estimate, speechOverBedDb: db });
  assert.equal(bed(8).balanced, true, "exactly 8 dB");
  assert.equal(bed(7.99).balanced, false);
  assert.equal(bed(8).balanceMode, "estimate");
  assert.equal(listen.listenVerdicts({ ...stems, speechOverMusicDb: 12 }).balanceMode, "stems");
  const unmeasured = bed(null);
  assert.equal(unmeasured.balanced, false);
  assert.match(unmeasured.findings[0].message, /could not be estimated/);
});

test("listenVerdicts boundaries: loudness tolerance and true-peak ceiling", () => {
  const ok = { wer: 0, meanLogprob: -0.2, speechOverMusicDb: 20, targetLufs: -16 };
  const loud = (integratedLufs, truePeakDbtp) => listen.listenVerdicts({ ...ok, integratedLufs, truePeakDbtp });
  assert.equal(loud(-17.5, -1).loudnessOk, true, "1.5 LU below target, peak exactly -1.0");
  assert.equal(loud(-14.5, -1).loudnessOk, true, "1.5 LU above target");
  assert.equal(loud(-17.51, -1).loudnessOk, false);
  assert.equal(loud(-16, -0.99).loudnessOk, false, "peak above -1.0 dBTP");
  assert.match(loud(-16, -0.4).findings[0].message, /True peak is -0.4 dBTP/);
  assert.match(loud(-12.4, -1.5).findings[0].message, /Integrated loudness is -12.4 LUFS, 3.6 LU/);
  assert.equal(loud(null, -1).loudnessOk, false);
  assert.equal(loud(-16, null).loudnessOk, false);
});

test("listenVerdicts: warnings never fail the verdict, errors sort first, thresholds can be overridden", () => {
  const m = { wer: 0.2, meanLogprob: -0.2, speechOverMusicDb: 20, integratedLufs: -16, truePeakDbtp: -1, targetLufs: -16, numberNotes: ["check 1228"] };
  const verdict = listen.listenVerdicts(m);
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.findings.map((f) => f.severity), ["error", "warning"]);
  const warnOnly = listen.listenVerdicts({ ...m, wer: 0.1 });
  assert.equal(warnOnly.passed, true, "a number note alone does not fail");
  assert.deepEqual(warnOnly.findings.map((f) => f.severity), ["warning"]);
  assert.equal(listen.listenVerdicts(m, { werMax: 0.25 }).intelligible, true);
  assert.equal(listen.LISTEN_THRESHOLDS.werMax, 0.15);
});

test("speechOverMusicDb measures narration over music on voiced narration frames only", () => {
  assert.equal(listen.speechOverMusicDb([0.01, 0.01], [0.001, 0.001]), 10);
  assert.equal(listen.speechOverMusicDb([0.01, 1e-6, 1e-6], [0.001, 1, 1]), 10, "unvoiced frames are ignored");
  assert.equal(listen.speechOverMusicDb([1e-6, 0], [0.5, 0.5]), null, "no voiced narration");
  assert.notEqual(listen.speechOverMusicDb([3.2e-5], [1e-9]), null, "just above -45 dBFS counts as voiced");
  assert.equal(listen.speechOverMusicDb([3.0e-5], [1e-9]), null, "just below -45 dBFS does not");
});

test("speechOverBedDb compares word spans with wordless gaps of at least 0.5 s", () => {
  const frames = (values) => Float64Array.from(values);
  const master = new Float64Array(200).fill(0.01); // 10 s at 50 ms frames
  for (let i = 40; i < 80; i++) master[i] = 1; // 2-4 s speech
  for (let i = 120; i < 140; i++) master[i] = 1; // 6-7 s speech
  const spans = [[2, 4], [6, 7]];
  const base = listen.speechOverBedDb(master, spans, 10);
  assert.equal(base.db, 20, "speech at 0 dB over a 0.01 bed");
  assert.equal(base.speechFrames, 60);
  assert.equal(base.bedFrames, 40 + 40 + 60, "gaps 0-2, 4-6 and 7-10 s");

  const shortGap = new Float64Array(master);
  for (let i = 80; i < 88; i++) shortGap[i] = 1; // 4.0-4.4 s: a 0.2 s gap is loud, and the word at 4.2-4.4 s is speech
  assert.equal(listen.speechOverBedDb(shortGap, [[2, 4], [4.2, 4.4], [6, 7]], 10).db, 20, "a 0.2 s gap must not count as bed");

  const silentTail = new Float64Array(master);
  for (let i = 140; i < 200; i++) silentTail[i] = 0; // digital silence is not a bed
  const silent = listen.speechOverBedDb(silentTail, spans, 10);
  assert.equal(silent.db, 20);
  assert.equal(silent.silentGapFrames, 60);

  assert.equal(listen.speechOverBedDb(master, [], 10).db, null, "no word spans");
  assert.equal(listen.speechOverBedDb(frames(Array(200).fill(1)), [[0, 10]], 10).db, null, "no gap at all");
  const allSilentBed = new Float64Array(200);
  for (let i = 40; i < 80; i++) allSilentBed[i] = 1;
  assert.equal(listen.speechOverBedDb(allSilentBed, [[2, 4]], 10).db, null, "silent gaps leave no bed");
});

test("the python helper rejects bad requests before importing faster_whisper", { skip: !hasPython && "python3 is not installed" }, (t) => {
  const dir = tmpDir(t);
  const audio = path.join(dir, "master.wav");
  writeWav(audio, tone(0.1, 440, 0.1));
  const run = (request) => {
    const file = path.join(dir, `request-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, typeof request === "string" ? request : JSON.stringify(request));
    return spawnSync("python3", ["-I", helper, file], { encoding: "utf8", timeout: 60_000 });
  };
  const bad = run({ audio, model: "tiny" });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^LISTEN_ERROR model must be one of small\.en, base\.en, medium, large-v3-turbo/m);
  const missing = run({ audio: path.join(dir, "nope.wav") });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /LISTEN_ERROR audio file not found/);
  assert.match(run("[1,2]").stdout, /LISTEN_ERROR request must be a JSON object/);
  assert.match(run("{broken").stdout, /LISTEN_ERROR request file is not readable JSON/);
  assert.match(run({ audio, language: "english!" }).stdout, /LISTEN_ERROR language must be/);
  const usage = spawnSync("python3", ["-I", helper], { encoding: "utf8", timeout: 60_000 });
  assert.match(usage.stdout, /LISTEN_ERROR usage: asr-listen\.py request\.json/);
  if (!systemHasWhisper) {
    const noModel = run({ audio, model: "small.en" });
    assert.equal(noModel.status, 2);
    assert.match(noModel.stdout, /LISTEN_ERROR faster_whisper is not importable/);
  }
});

// ---- videoListen with a fake interpreter and tiny generated audio ----------

test("frameMeanSquare streams 50 ms power frames from ffmpeg", { skip: !hasFfmpeg && "ffmpeg is not installed" , timeout: 120_000 }, async (t) => {
  const dir = tmpDir(t);
  const wav = path.join(dir, "tone.wav");
  writeWav(wav, tone(3, 440, 0.5));
  const frames = await listen.frameMeanSquare(wav);
  assert.equal(frames.length, 60, "3 s of 50 ms frames");
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  near(mean, 0.125, 0.01, "mean-square of a 0.5 amplitude sine");
});

test("videoListen fails fast with the install instruction when no interpreter has faster_whisper", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 120_000 }, async (t) => {
  const dir = tmpDir(t);
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(0.5, 440, 0.2));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  await withEnv({ PI_ASR_PYTHON: undefined, PI_ASR_AUTO_INSTALL: "0", PI_CODING_AGENT_DIR: undefined, HOME: home }, async () => {
    await assert.rejects(listen.videoListen({ path: master }, dir), (error) => {
      assert.match(error.message, /Speech recognition is not installed\. Create it once with: python3 -m venv ~\/\.pi\/agent\/local-models\/asr\/venv && ~\/\.pi\/agent\/local-models\/asr\/venv\/bin\/pip install faster-whisper==1\.2\.1/);
      assert.match(error.message, /Automatic setup is off \(PI_ASR_AUTO_INSTALL=0\)/);
      return true;
    });
  });
});

test("videoListen runs the helper, measures the master and writes the listen report", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 300_000 }, async (t) => {
  const dir = tmpDir(t);
  const fake = fakePython(dir, "fake-python");
  const log = path.join(dir, "requests.log"), probes = path.join(dir, "probes.log");
  // Master: speech at 0.5-1.5 s over a quiet bed; the wordless gaps are 0.5 s and 1.5 s long.
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(3, 440, (t) => (t >= 0.5 && t < 1.5 ? 0.5 : 0.05)));
  const script = path.join(dir, "script.txt");
  fs.writeFileSync(script, "Welcome to the car.\n");
  const fixture = resultFixture(path.join(dir, "result.json"), { text: "Welcome to the car.", words: wordsFrom("Welcome to the car", 0.5, 0.25), speechWindows: [[0.5, 1.5]] });
  const outcome = await withEnv({ PI_ASR_PYTHON: fake, FAKE_ASR_FIXTURE: fixture, FAKE_ASR_LOG: log, FAKE_ASR_PROBES: probes, FAKE_ASR_MODE: undefined }, async () => {
    const first = await listen.videoListen({ path: master, script }, dir, undefined, undefined);
    const second = await listen.videoListen({ path: master, script }, dir);
    return { first, second };
  });
  const { first } = outcome;
  assert.equal(path.basename(first.path), "master.wav");
  assert.equal(first.wer, 0);
  assert.equal(first.intelligible, true);
  assert.equal(first.transcriptPreview, "Welcome to the car.");
  near(first.speechOverBedDb, 20, 0.5, "speech at 0.5 over a 0.05 bed");
  assert.equal("speechOverMusicDb" in first, false, "no stems, so no stem balance");
  assert.equal(first.balanced, true);
  assert.equal(first.sha256, sha256(master));
  assert.equal(typeof first.loudness.integratedLufs, "number");
  assert.equal(first.note, listen.LISTEN_NOTE);
  assert.equal(path.basename(first.report), "master.wav.listen.json");
  assert.equal(path.dirname(first.report), path.dirname(first.path));
  const report = JSON.parse(fs.readFileSync(first.report, "utf8"));
  assert.equal(report.format, "yunuspi-listen-v1");
  assert.equal(report.sha256, first.sha256);
  assert.equal(report.script.sha256, sha256(script));
  assert.equal(report.transcript.text, "Welcome to the car.");
  assert.equal(report.transcript.words.length, 4);
  assert.equal(report.thresholds.werMax, 0.15);
  assert.equal(report.verdicts.balanceMode, "estimate");
  assert.equal(typeof report.createdAt, "string");
  const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.equal(path.basename(requests[0].audio), "master.wav");
  assert.equal(requests[0].model, "small.en");
  assert.equal(requests[0].language, "en");
  assert.equal(requests[0].speechWindows, true);
  assert.equal(fs.existsSync(requests[0].resultFile), false, "the private transport file is removed");
  assert.equal(fs.readFileSync(probes, "utf8").trim().split("\n").length, 1, "the import probe runs once per interpreter");
});

test("videoListen compares against spoken text passed as script instead of a file path", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 300_000 }, async (t) => {
  const dir = tmpDir(t);
  const fake = fakePython(dir, "fake-python");
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(3, 440, (t) => (t >= 0.5 && t < 1.5 ? 0.5 : 0.05)));
  const fixture = resultFixture(path.join(dir, "result.json"), { text: "Welcome to the car.", words: wordsFrom("Welcome to the car", 0.5, 0.25), speechWindows: [[0.5, 1.5]] });
  const spoken = "Welcome to the car.";
  const result = await withEnv({ PI_ASR_PYTHON: fake, FAKE_ASR_FIXTURE: fixture, FAKE_ASR_LOG: undefined, FAKE_ASR_PROBES: undefined, FAKE_ASR_MODE: undefined }, () => listen.videoListen({ path: master, script: spoken }, dir));
  assert.equal(result.wer, 0);
  const report = JSON.parse(fs.readFileSync(result.report, "utf8"));
  assert.equal(report.script.path, null);
  assert.equal(report.script.wordCount, 4);
  assert.equal(report.script.sha256, crypto.createHash("sha256").update(spoken).digest("hex"));
  assert.equal(listen.isInlineScript("out/script-v2.txt", dir), false, "a script file path stays a path");
  assert.equal(listen.isInlineScript(path.join(dir, "master.wav"), dir), false, "an existing file stays a path");
  await assert.rejects(listen.videoListen({ path: master, script: "missing.txt" }, dir), /ENOENT|no such file/i);
});

test("videoListen sets up speech recognition itself and reports a setup failure with the manual command", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 120_000 }, async (t) => {
  const dir = tmpDir(t);
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(0.5, 440, 0.2));
  const home = path.join(dir, "home"), emptyBin = path.join(dir, "bin");
  fs.mkdirSync(home); fs.mkdirSync(emptyBin);
  // No python3 on PATH: the automatic setup is attempted and its failure is explicit.
  await withEnv({ PI_ASR_PYTHON: undefined, PI_ASR_AUTO_INSTALL: undefined, PI_CODING_AGENT_DIR: undefined, HOME: home, PATH: emptyBin }, async () => {
    await assert.rejects(listen.videoListen({ path: master }, dir), (error) => {
      assert.match(error.message, /Speech recognition is not installed\./);
      assert.match(error.message, /Automatic setup failed: /);
      return true;
    });
  });
  assert.ok(fs.existsSync(path.join(home, ".pi/agent/local-models/asr")), "setup ran in the agent's local-models folder");
});

test("videoListen measures speech over music exactly from narration and music stems", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 300_000 }, async (t) => {
  const dir = tmpDir(t);
  const fake = fakePython(dir, "fake-python");
  const narration = path.join(dir, "narration.wav"), music = path.join(dir, "music.wav"), master = path.join(dir, "master.wav");
  const voice = tone(2, 440, 0.25), bed = tone(2, 220, 0.05);
  writeWav(narration, voice);
  writeWav(music, bed);
  writeWav(master, mix(voice, bed));
  const fixture = resultFixture(path.join(dir, "result.json"), { text: "Welcome to the car", words: wordsFrom("Welcome to the car", 0.2, 0.4), speechWindows: [[0.2, 1.8]], duration: 2 });
  const result = await withEnv({ PI_ASR_PYTHON: fake, FAKE_ASR_FIXTURE: fixture, FAKE_ASR_LOG: undefined, FAKE_ASR_PROBES: undefined, FAKE_ASR_MODE: undefined }, () =>
    listen.videoListen({ path: master, narration, music }, dir));
  // A 0.25 amplitude voice over a 0.05 amplitude bed: 20 log10(5) = 13.98 dB.
  near(result.speechOverMusicDb, 20 * Math.log10(5), 0.3, "stems balance");
  assert.equal("speechOverBedDb" in result, false);
  assert.equal(result.balanced, true);
  const report = JSON.parse(fs.readFileSync(result.report, "utf8"));
  assert.equal(report.verdicts.balanceMode, "stems");
  assert.equal(report.stems.narration.sha256, sha256(narration));
  assert.equal(report.stems.music.sha256, sha256(music));
  assert.equal(report.script, null);
  assert.equal(result.wer, null, "no script, so no word error rate");
});

test("videoListen surfaces the helper's own error line and rejects a narration stem without music", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 300_000 }, async (t) => {
  const dir = tmpDir(t);
  const fake = fakePython(dir, "fake-python");
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(1, 440, 0.2));
  const fixture = resultFixture(path.join(dir, "result.json"), { text: "", words: [] });
  await withEnv({ PI_ASR_PYTHON: fake, FAKE_ASR_FIXTURE: fixture, FAKE_ASR_MODE: "error", FAKE_ASR_LOG: undefined, FAKE_ASR_PROBES: undefined }, async () => {
    await assert.rejects(listen.videoListen({ path: master }, dir), /Speech recognition failed: model small\.en is not cached locally/);
  });
  await withEnv({ PI_ASR_PYTHON: fake, FAKE_ASR_MODE: undefined }, async () => {
    await assert.rejects(listen.videoListen({ path: master, narration: master }, dir), /both narration and music stems/);
    await assert.rejects(listen.videoListen({ path: master, model: "tiny" }, dir), /model must be one of small\.en/);
    await assert.rejects(listen.videoListen({ path: master, targetLufs: 3 }, dir), /targetLufs must be/);
  });
});

test("an import probe that fails is cached per interpreter and reported with the install hint", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 300_000 }, async (t) => {
  const dir = tmpDir(t);
  const broken = fakePython(dir, "broken-python");
  const probes = path.join(dir, "probes.log");
  const master = path.join(dir, "master.wav");
  writeWav(master, tone(0.5, 440, 0.2));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  await withEnv({ PI_ASR_PYTHON: broken, PI_ASR_AUTO_INSTALL: "0", FAKE_ASR_IMPORT: "fail", FAKE_ASR_PROBES: probes, PI_CODING_AGENT_DIR: undefined, HOME: home }, async () => {
    await assert.rejects(listen.videoListen({ path: master }, dir), /pip install faster-whisper==1\.2\.1/);
    await assert.rejects(listen.videoListen({ path: master }, dir), /pip install faster-whisper==1\.2\.1/);
  });
  assert.equal(fs.readFileSync(probes, "utf8").trim().split("\n").length, 1);
});

test("video-listen exposes its public surface and the helper script ships beside the other agent scripts", () => {
  assert.equal(typeof listen.videoListen, "function");
  assert.deepEqual(listen.ASR_MODELS, ["small.en", "base.en", "medium", "large-v3-turbo"]);
  assert.equal(listen.DEFAULT_ASR_MODEL, "small.en");
  assert.ok(fs.existsSync(helper), "asr-listen.py ships beside the other agent scripts");
});
