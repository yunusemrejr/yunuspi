import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const film = await import(path.join(root, "agent/extensions/lib/film.ts"));

test("three.js add-ons are pinned to the starter's Remotion version", () => {
  const starter = JSON.parse(fs.readFileSync(path.join(root, "agent/skills/cinetic/assets/remotion-starter/package.json"), "utf8"));
  const remotion = starter.dependencies.remotion;
  for (const [name, version] of Object.entries(film.FILM_EXTRA_PACKAGES)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is an exact pin`);
    if (name.startsWith("@remotion/")) assert.equal(version, remotion, `${name} matches remotion ${remotion}`);
  }
  assert.ok(film.FILM_PYTHON_PACKAGES.every((spec) => /^[\w-]+==[\d.]+$/.test(spec)), "Python tools are exact pins");
});

test("a film directory stays inside the workspace and must be a film once scaffolded", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "film-dir-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await assert.rejects(film.filmDir("../elsewhere", cwd, false), /inside the current workspace/);
  await assert.rejects(film.filmDir("", cwd, false), /film directory/);
  await assert.rejects(film.filmDir("missing", cwd), /not a film .*video_project action:"init"/);
  fs.mkdirSync(path.join(cwd, "made/src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "made/src/timeline.ts"), "export {};\n");
  assert.equal(await film.filmDir("made", cwd), path.join(fs.realpathSync(cwd), "made"));
});

test("render audio must be a file inside the workspace", (t) => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-audio-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-outside-")));
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const dir = path.join(workspace, "made");
  fs.mkdirSync(path.join(dir, "public/audio"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public/audio/soundtrack.wav"), "");
  fs.writeFileSync(path.join(outside, "README.md"), "not audio\n");
  fs.symlinkSync(path.join(outside, "README.md"), path.join(dir, "public/audio/linked.wav"));
  assert.equal(film.checkedAudio("public/audio/soundtrack.wav", dir, workspace), path.join(dir, "public/audio/soundtrack.wav"));
  assert.throws(() => film.checkedAudio(path.join(outside, "README.md"), dir, workspace), /must be inside the workspace/);
  assert.throws(() => film.checkedAudio(path.relative(dir, path.join(outside, "README.md")), dir, workspace), /must be inside the workspace/);
  assert.throws(() => film.checkedAudio("public/audio/linked.wav", dir, workspace), /must be inside the workspace/);
  assert.throws(() => film.checkedAudio("public/audio/missing.wav", dir, workspace), /is not a file/);
});

test("render flags are an allowlist of render.sh options", () => {
  assert.deepEqual(film.checkedFlags(["--frames 0-299", "--keep"]), ["--frames", "0-299", "--keep"]);
  assert.deepEqual(film.checkedFlags(["--frames", "0-299", "--crf", "18"]), ["--frames", "0-299", "--crf", "18"]);
  assert.deepEqual(film.checkedFlags(["--measure --max 64 --step 2"]), ["--measure", "--max 64 --step 2"]);
  assert.deepEqual(film.checkedFlags(undefined), []);
  assert.throws(() => film.checkedFlags(["--samples out/samples.json"]), /"--samples" is not an allowed render option\. Allowed: --frames A-B/);
  assert.throws(() => film.checkedFlags(["--budget", "3"]), /budget parameter/);
  assert.throws(() => film.checkedFlags(["--"]), /bare --/);
  assert.throws(() => film.checkedFlags(["--frames 0-299 --keep"]), /takes A-B/);
  assert.throws(() => film.checkedFlags(["--frames"]), /needs a value/);
  assert.throws(() => film.checkedFlags(["--measure --analytic /home/user/speed.json"]), /takes ARGS/);
});

test("film out/ must stay inside the film folder", (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-out-")));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-elsewhere-")));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  const dir = path.join(base, "made");
  fs.mkdirSync(dir);
  assert.equal(film.checkedOut(dir), path.join(dir, "out"));
  fs.symlinkSync(elsewhere, path.join(dir, "out"));
  assert.throws(() => film.checkedOut(dir), /out\/ must stay inside the film folder/);
});

test("flags only apply to preview and final renders", async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-stills-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "made/src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "made/src/timeline.ts"), "export {};\n");
  fs.mkdirSync(path.join(cwd, "made/node_modules/remotion"), { recursive: true });
  await assert.rejects(film.filmRender({ dir: "made", mode: "stills", flags: ["--keep"] }, cwd), /flags apply to preview and final renders/);
});

test("a film's own scripts run through bash or bg_run find the film's Python tools first", (t) => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "film-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "film-cwd-"));
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; fs.rmSync(agent, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  process.env.PI_CODING_AGENT_DIR = agent;
  const venv = path.join(agent, "local-tools/film/venv/bin");
  fs.mkdirSync(venv, { recursive: true });
  fs.mkdirSync(path.join(cwd, "film/scripts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "film/scripts/render.sh"), "");
  fs.writeFileSync(path.join(cwd, "film/remotion.config.ts"), "");
  const render = `cd ${path.join(cwd, "film")} && bash scripts/render.sh Film out/master.mp4 --audio public/audio/soundtrack.wav 2>&1 | tail -60`;
  assert.equal(film.withFilmTools(render, cwd), `export PATH='${venv}':"$PATH" && ${render}`);
  assert.equal(film.withFilmTools(`PATH=/opt/py/bin:$PATH ${render}`, cwd), undefined, "a command that sets PATH itself is left alone");
  assert.equal(film.withFilmTools("cd film && python3 scripts/check-sync.py public/audio/soundtrack.wav", cwd)?.startsWith("export PATH="), true, "a relative cd is resolved against the session cwd");
  assert.equal(film.withFilmTools("python3 scripts/check-sync.py x.wav", path.join(cwd, "film"))?.startsWith("export PATH="), true, "the session cwd may be the film itself");
  assert.equal(film.withFilmTools("python3 scripts/check-sync.py x.wav", cwd), undefined, "outside a film folder nothing changes");
  assert.equal(film.withFilmTools("cd film && npm run check", cwd), undefined, "other commands are left alone");
  assert.equal(film.withFilmTools("cd film && python3 - <<'PY'\nimport soundfile\nPY", cwd)?.startsWith("export PATH="), true, "an inline python3 in a film folder gets the film's packages too");
  assert.equal(film.withFilmTools("cd film && pythonic-tool run", cwd), undefined, "only the python executable itself");
  assert.equal(film.withFilmTools(film.withFilmTools(render, cwd), cwd), undefined, "applied once");
  fs.rmSync(venv, { recursive: true });
  assert.equal(film.withFilmTools(render, cwd), undefined, "without the film environment the command runs as written");
});
