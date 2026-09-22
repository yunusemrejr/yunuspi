import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Per-payload budget for a real isolated command. Kept short so an unavailable
 * or hanging sandbox costs seconds, not half a minute per payload; the strict
 * timeout assertion below turns a hang into a failure instead of a pass.
 * 2026-09-14: raised 8s -> 20s after the guarded payload measured ~8.0s
 * unloaded on this host and tripped the 8s budget (8016ms); 20s keeps the
 * env override and the ETIMEDOUT assertion while leaving real headroom. */
const ISOLATION_STEP_TIMEOUT_MS =
  Number.parseInt(process.env.PI_ISOLATION_STEP_TIMEOUT_MS ?? "", 10) || 20000;
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
  (p) => fs.existsSync(path.join(p, "extensions/lib/self-mutation-guard.ts")),
);
const { discoverMutationRoots, containsPath } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/self-mutation-guard.ts"))
);
/** Fixture base for real-isolation tests. Avoid a directory with thousands of
 * siblings: the guarded-command wrapper re-binds every existing sibling of a
 * protected root's ancestors writable, so a fixture under a busy /tmp costs
 * ~7k bubblewrap arguments per sandboxed payload (~9s) where a low-entry root
 * costs ~135 (~0.4s). */
const TEMP_BASE =
  ["/var/tmp", os.tmpdir()].find((dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? os.tmpdir();
function fixture() {
  const root = fs.mkdtempSync(path.join(TEMP_BASE, "pi-shared-skills-"));
  const harness = path.join(root, "harness"),
    home = path.join(root, "home"),
    project = path.join(root, "project"),
    external = path.join(root, "external");
  const shared = path.join(external, "shared"),
    future = path.join(external, "future"),
    referent = path.join(external, "referent");
  for (const dir of [
    path.join(harness, "agent/extensions/lib"),
    path.join(harness, "agent/scripts"),
    path.join(harness, "agent/skills"),
    home,
    project,
    shared,
    referent,
  ])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(shared, "SKILL.md"), "shared unchanged");
  fs.writeFileSync(path.join(referent, "SKILL.md"), "referent unchanged");
  fs.writeFileSync(path.join(harness, "original"), "harness unchanged");
  fs.symlinkSync(referent, path.join(harness, "agent/skills/linked"));
  fs.symlinkSync(
    path.join(external, "missing-referent"),
    path.join(harness, "agent/skills/dangling"),
  );
  fs.writeFileSync(
    path.join(harness, "agent/settings.json"),
    JSON.stringify({ skills: [shared, future] }),
  );
  fs.copyFileSync(
    path.join(agent, "extensions/lib/self-mutation-guard.ts"),
    path.join(harness, "agent/extensions/lib/self-mutation-guard.ts"),
  );
  fs.copyFileSync(
    path.join(agent, "scripts/harness-readonly-exec.py"),
    path.join(harness, "agent/scripts/harness-readonly-exec.py"),
  );
  return {
    root,
    harness,
    home,
    project,
    external,
    shared,
    future,
    referent,
    guard: pathToFileURL(
      path.join(harness, "agent/extensions/lib/self-mutation-guard.ts"),
    ).href,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
function node(cwd, script) {
  // The fixture owns its global skill roots. Reading the desktop's real HOME
  // makes mount setup race unrelated applications atomically replacing files.
  const env = { ...process.env, HOME: path.join(path.dirname(cwd), "home") };
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_HARNESS_MUTATION_DENIED;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
}
test("global roots include configured absent paths and symlink referents without protecting project skills", () => {
  const f = fixture();
  try {
    const roots = discoverMutationRoots(f.harness, f.home);
    const protectedPath = (p) => roots.some((root) => containsPath(root, p));
    for (const p of [
      f.harness,
      f.shared,
      f.future,
      f.referent,
      path.join(f.external, "missing-referent"),
      path.join(f.home, ".agents/skills/new/SKILL.md"),
      path.join(f.home, ".codex/skills/new/SKILL.md"),
    ])
      assert.ok(protectedPath(p), p);
    assert.equal(
      protectedPath(path.join(f.project, ".agents/skills/new/SKILL.md")),
      false,
    );
    assert.equal(
      protectedPath(path.join(f.project, ".pi/skills/new/SKILL.md")),
      false,
    );
    assert.equal(protectedPath(path.join(f.external, "ordinary-file")), false);
    fs.writeFileSync(
      path.join(f.harness, "agent/settings.json"),
      JSON.stringify({
        skills: ["~/custom-skills", path.join(f.external, "exact.md")],
      }),
    );
    const configured = discoverMutationRoots(f.harness, f.home);
    assert.ok(configured.includes(path.join(f.home, "custom-skills")));
    assert.ok(configured.includes(path.join(f.external, "exact.md")));
    assert.ok(
      !configured.includes(f.external),
      "a configured file does not protect every sibling file",
    );
  } finally {
    f.close();
  }
});
test("parent link entries cannot redirect global skill loading to a different tree", () => {
  const f = fixture();
  try {
    const parent = path.join(f.external, "alias-parent");
    fs.symlinkSync(f.shared, parent);
    fs.writeFileSync(
      path.join(f.harness, "agent/settings.json"),
      JSON.stringify({ skills: [path.join(parent, "nested")] }),
    );
    const roots = discoverMutationRoots(f.harness, f.home);
    assert.ok(roots.includes(parent));
    assert.ok(roots.includes(path.join(f.shared, "nested")));
  } finally {
    f.close();
  }
});
test("native skill writes require harness launch even when launched inside shared skills", () => {
  const f = fixture();
  try {
    for (const cwd of [f.root, f.project, f.shared]) {
      const r = node(
        cwd,
        `const g=await import(${JSON.stringify(f.guard)});const targets=${JSON.stringify([path.join(f.shared, "SKILL.md"), path.join(f.future, "new/SKILL.md"), path.join(f.referent, "SKILL.md"), path.join(f.project, ".agents/skills/new/SKILL.md")])};console.log(JSON.stringify([g.SELF_MUTATION_ALLOWED,...targets.map(p=>!!g.selfMutationDenial(p,process.cwd()))]));`,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), [false, true, true, true, false]);
    }
    const maintenance = node(
      f.harness,
      `const g=await import(${JSON.stringify(f.guard)});console.log(g.SELF_MUTATION_ALLOWED,!!g.selfMutationDenial(${JSON.stringify(path.join(f.shared, "SKILL.md"))},process.cwd()));`,
    );
    assert.equal(maintenance.stdout.trim(), "true false");
    const captured = node(
      f.project,
      `import fs from 'node:fs';const g=await import(${JSON.stringify(f.guard)});fs.writeFileSync(${JSON.stringify(path.join(f.harness, "agent/settings.json"))},'{}');process.chdir(${JSON.stringify(f.shared)});delete process.env.PI_HARNESS_MUTATION_DENIED;console.log(!!g.selfMutationDenial('SKILL.md',process.cwd()));`,
    );
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(
      captured.stdout.trim(),
      "true",
      "captured roots survive later trusted-host configuration changes",
    );
  } finally {
    f.close();
  }
});
test("unreadable or broad global skill configuration never silently disables isolation", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.harness, "agent/settings.json"),
      JSON.stringify({ skills: [f.home] }),
    );
    assert.throws(() => discoverMutationRoots(f.harness, f.home), /too broad/);
    fs.writeFileSync(path.join(f.harness, "agent/settings.json"), "{invalid");
    const result = node(
      f.project,
      `const g=await import(${JSON.stringify(f.guard)});try {g.guardedCommand('/bin/true',[]);process.exit(99);} catch(e){if(!/protected global skill paths/.test(e.message))throw e;}`,
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    f.close();
  }
});
test("real command isolation protects all shared roots, missing roots and aliases while project skill work remains writable", (t) => {
  const f = fixture();
  try {
    const child = `import {spawnSync} from 'node:child_process';const g=await import(${JSON.stringify(f.guard)});const invoke=g.guardedCommand('/usr/bin/python3',['-c',process.env.FIXTURE_CODE]);const r=spawnSync(invoke.command,invoke.args,{cwd:process.cwd(),encoding:'utf8'});console.log(JSON.stringify({status:r.status,stderr:r.stderr,error:r.error?.code}));`;
    const run = (code) => {
      const env = { ...process.env, HOME: f.home, FIXTURE_CODE: code };
      delete env.PI_SUBAGENT_CHILD;
      delete env.PI_HARNESS_MUTATION_DENIED;
      delete env.NODE_TEST_CONTEXT;
      const startedAt = Date.now();
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", child],
        {
          cwd: f.project,
          env,
          encoding: "utf8",
          timeout: ISOLATION_STEP_TIMEOUT_MS,
        },
      );
      if (process.env.PI_ISOLATION_TIMING === "1")
        console.error(
          `[isolation] ${Date.now() - startedAt}ms status=${r.status} error=${r.error?.code ?? "none"} payload=${code.slice(0, 60).replace(/\s+/g, " ")}`,
        );
      // A timed-out spawn returns status null. Asserting only "non-zero" would
      // then read a hung sandbox as a correct denial and burn the whole budget.
      assert.ok(
        r.error?.code !== "ETIMEDOUT",
        `guarded command did not finish within ${ISOLATION_STEP_TIMEOUT_MS}ms (payload: ${code})`,
      );
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const probe = run(
      "import os;os.makedirs('.agents/skills/local');open('.agents/skills/local/SKILL.md','w').write('local');open('normal','w').write('ok')",
    );
    if (probe.status !== 0) {
      assert.match(
        probe.stderr ?? "",
        /bubblewrap runtime|required executable unavailable|bwrap:.*(?:Operation not permitted|Permission denied|No permissions to create|Creating new namespace failed|namespace)/i,
      );
      assert.notEqual(process.env.PI_REQUIRE_ISOLATION_TEST, "1");
      assert.ok(!fs.existsSync(path.join(f.project, "normal")));
      t.skip("Namespaces unavailable; no payload ran");
      return;
    }
    for (const target of [
      path.join(f.harness, "original"),
      path.join(f.shared, "SKILL.md"),
      path.join(f.referent, "SKILL.md"),
    ]) {
      const p = JSON.stringify(target);
      for (const code of [
        `open(${p},'w').write('bad')`,
        `import os;os.environ.clear();open(${p},'w').write('bad')`,
        `import os;os.unlink(${p})`,
      ])
        assert.notEqual(run(code).status, 0, code);
    }
    for (const target of [f.future, path.join(f.external, "missing-referent")])
      assert.notEqual(
        run(`import os;os.makedirs(${JSON.stringify(target)})`).status,
        0,
      );
    assert.equal(
      run(
        "import os;os.makedirs('.pi/skills/another');open('.pi/skills/another/SKILL.md','w').write('project')",
      ).status,
      0,
    );
    fs.linkSync(
      path.join(f.shared, "SKILL.md"),
      path.join(f.referent, "internal-alias"),
    );
    assert.equal(
      run("open('normal','w').write('internal aliases are protected')").status,
      0,
      "links entirely inside protected roots remain safe",
    );
    fs.linkSync(
      path.join(f.shared, "SKILL.md"),
      path.join(f.project, "hardlink"),
    );
    const linked = run("open('hardlink','w').write('bad')");
    assert.equal(linked.status, 126);
    assert.match(linked.stderr, /hard-linked/);
    const direct = node(
      f.project,
      `const g=await import(${JSON.stringify(f.guard)});console.log(!!g.selfMutationDenial('hardlink',process.cwd()));`,
    );
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout.trim(), "true");
    assert.equal(
      fs.readFileSync(path.join(f.shared, "SKILL.md"), "utf8"),
      "shared unchanged",
    );
    assert.equal(
      fs.readFileSync(path.join(f.referent, "SKILL.md"), "utf8"),
      "referent unchanged",
    );
    assert.equal(
      fs.readFileSync(path.join(f.harness, "original"), "utf8"),
      "harness unchanged",
    );
  } finally {
    f.close();
  }
});
