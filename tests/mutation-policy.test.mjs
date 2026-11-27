// Policy decisions never execute the shell strings below. Filesystem integration
// uses only per-test disposable fixtures. No providers, host deletion or network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
  (p) => fs.existsSync(path.join(p, "extensions/filesystem-safety.ts")),
);
const url = (file) => pathToFileURL(path.join(agent, "extensions", file)).href;
async function load(file, replacements = []) {
  let source = fs.readFileSync(path.join(agent, "extensions", file), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  source = source.replace(
    /from "(\.\/?[^"\n]+)"/g,
    (_, ref) => `from ${JSON.stringify(new URL(ref, url(file)).href)}`,
  );
  return import(
    "data:text/javascript;base64," +
      Buffer.from(stripTypeScriptTypes(source)).toString("base64")
  );
}
const safety = await load("filesystem-safety.ts", [
  [
    /import \{\s*getAgentDir,[\s\S]*?from "@yunuspi\/coding-agent";/,
    `const getAgentDir=()=>${JSON.stringify(agent)};`,
  ],
]);
const home = os.homedir();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-"));
fs.mkdirSync(path.join(cwd, "work"));
const env = {
  HOME: home,
  TMPDIR: "/tmp",
  TMP: "/var/tmp/allocated",
  TEMP: "/tmp/allocated",
};
const risk = (command, dir = cwd, environment = env) =>
  safety.assessShellMutation(command, dir, environment);
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const allowed = [
  "rm -rf ./build",
  `rm -rf ${cwd}/build`,
  "rm -f -- old.txt",
  "rm *.log",
  'rm -rf "build with spaces"',
  "rm -rf build\\ with\\ spaces",
  "chmod +x /tmp/test-script; cat /proc/cpuinfo",
  'chmod 600 "/tmp/test script"; ls /etc',
  "cp -rf /etc/skel /tmp/work-copy",
  "cp -t /tmp/work-copy /etc/skel/file",
  'rm -rf ./build; rg "/etc" /proc/mounts',
  'git commit -m "fix rm -rf / and git reset --hard examples"',
  'echo "rm -rf /"; printf "%s" /etc/passwd',
  "echo prefix'$(rm -rf /)'",
  'echo "\\$(rm -rf /)"',
  "# rm -rf /\nls /etc",
  "cat > ./example.sh <<'EOF'\nrm -rf /\nEOF",
  'T=$(mktemp -d); cp -r . "$T/"; rm -rf "$T"',
  'T=`mktemp -d`; rm -rf "$T"',
  'T=$(mktemp -d /var/tmp/test.XXXXXX); rm -rf "$T"',
  'T=/tmp/work; U="$T/child"; T=/etc; rm -rf "$U"',
  'T=/tmp/work; printf x | cat; rm -rf "$T"',
  "(cd /etc; cat passwd); rm -rf ./build",
  'T=/tmp/work; (T=/etc; cat "$T/passwd"); rm -rf "$T"',
  `cd ${cwd}; cd work; rm -rf ./build`,
  'rm -rf "$TMP"',
  'rm -rf "${TMPDIR:-/tmp}/work"',
  'find . -name "*.tmp" -delete',
  'find -P /tmp/work -name "*.tmp" -exec rm {} +',
  "find . -name node_modules -print",
  "dd if=/dev/zero of=/tmp/small-fixture count=0",
  'sed -i "s/old/new/g" src/*.ts',
  'perl -pi -e "s/old/new/g" src/*.ts',
  "git clean -ndx",
  "git push --dry-run --force origin feature",
  "rsync --delete --dry-run source/ target/",
  "rsync -an --delete source/ target/",
  "env MODE=test command rm -rf ./build",
  "/usr/bin/rm -fr -- ./build",
  "sh -c 'rm -rf ./build'",
  'T=/tmp/work; rm -rf "$T" >/dev/null 2>&1',
];
for (const command of allowed)
  test(`ordinary workflow: ${command}`, () =>
    assert.equal(risk(command), undefined, JSON.stringify(risk(command))));

const blocked = [
  "rm -rf /",
  "rm -r /etc",
  "rm /etc/passwd",
  "rm -f -- /etc/passwd",
  "rm -- --help /etc/passwd",
  "/usr/bin/rm -f /etc/passwd",
  "rm -rf /tmp",
  "rm -rf /tmp/*",
  "rm -rf /var/tmp",
  'rm -rf "$HOME"',
  'T=/etc; rm -rf "$T"; T=/tmp/safe',
  'TMPDIR=/etc T=$(mktemp -d); rm -rf "$T"',
  "sudo -u root rm /etc/passwd",
  "timeout 5 rm -f /etc/passwd",
  "chmod -w /etc/passwd",
  "if rm /etc/passwd; then echo bad; fi",
  'T=/etc; U=$T; T=/tmp; rm -rf "$U"',
  'T=""; rm -rf "$T/"',
  'T=/tmp/work; rm -rf "$T/../.."',
  "cd /etc; rm -f passwd",
  "cd /etc; cd ssh; rm -rf .",
  "chmod -R 777 /",
  "chown root:root /etc",
  "cp -rf /tmp/copy /etc",
  "cp /tmp/source --target-directory=/etc",
  "mv /etc /tmp/stolen",
  "mv /tmp/file /etc/file",
  "find -P /etc -name x -delete",
  'find "$HOME" -exec rm {} +',
  'dd if=/tmp/image of="/dev/sda"',
  "truncate -s 0 /etc/passwd",
  'sed -i "s/old/new/g" /etc/*.conf',
  'perl -pi -e "s/old/new/g" /etc/*.conf',
  "printf bad > /etc/passwd",
  "echo x >> /etc/passwd",
  "bash -c 'rm -rf /etc'",
  "cat <<EOF\n$(rm -rf /etc)\nEOF",
  "bash <<'EOF'\nrm -rf /etc\nEOF",
  'echo "$(rm -rf /etc)"',
];
for (const command of blocked)
  test(`protected target: ${command}`, () =>
    assert.equal(risk(command)?.level, "block", JSON.stringify(risk(command))));
for (const command of [
  'T=/etc; if false; then T=/tmp; fi; rm -rf "$T"',
  "cd /etc; cd /pi-not-existing-dir; rm -rf .",
  'rm -rf "$UNKNOWN"',
  'T=$(mktemp -d; echo /etc); rm -rf "$T"',
  'T=$(mktemp -u); rm -rf "$T"',
  "rm -rf *",
  "rm -rf .",
  "git reset --hard",
  "git clean -xdf",
  "git push --force origin feature",
  "git push --force-with-lease origin feature",
  "git push origin feature",
  "rsync --delete source/ target/",
])
  test(`bounded review: ${command}`, () =>
    assert.equal(
      risk(command)?.level,
      "review",
      JSON.stringify(risk(command)),
    ));

test("child shells receive only exported values and env wrappers apply their actual overrides", () => {
  for (const command of [
    `T=/tmp/work; env T=/etc sh -c 'rm -rf "$T"'`,
    `T=/tmp/work; export T; env T=/etc sh -c 'rm -rf "$T"'`,
    `env -C /etc rm -f passwd`,
    `env --chdir=/etc rm -f passwd`,
    `env -S 'rm -rf /etc'`,
  ])
    assert.equal(risk(command)?.level, "block", command);
  for (const command of [
    `T=/tmp/work; bash -c 'rm -rf "$T/"'`,
    `export T=/tmp/work; env -u T sh -c 'rm -rf "$T/"'`,
    `export T=/tmp/work; env -i sh -c 'rm -rf "$T/"'`,
  ])
    assert.equal(risk(command)?.level, "review", command);
  for (const command of [
    `export T=/tmp/work; bash -c 'rm -rf "$T"'`,
    `T=/tmp/work; export T; bash -c 'rm -rf "$T"'`,
    `env T=/tmp/work sh -c 'rm -rf "$T"'`,
    `env -C /tmp rm -rf work; rm -rf ./build`,
  ])
    assert.equal(risk(command), undefined, command);
});

test("environment values and broad launch directories cannot grant destructive scope", () => {
  for (const name of ["TMPDIR", "TMP", "TEMP", "SCRATCH"]) {
    assert.equal(
      risk(`rm -rf "$${name}"`, cwd, { ...env, [name]: "/etc" })?.level,
      "block",
    );
    assert.equal(
      risk(`rm -rf "$${name}"`, cwd, { ...env, [name]: "/tmp/allocated" }),
      undefined,
    );
  }
  assert.equal(
    risk('T=$(mktemp -d); rm -rf "$T"', cwd, { ...env, TMPDIR: "/etc" })?.level,
    "block",
  );
  assert.equal(risk('rm -rf "$TMPDIR"', cwd, { HOME: home })?.level, "review");
  for (const dir of ["/", home])
    for (const command of ["rm -rf /etc", 'rm -rf "$HOME"', "rm -rf /tmp"])
      assert.equal(risk(command, dir)?.level, "block");
});
test("physical paths are checked before lexical .. normalization, including missing descendants", () => {
  const nested = path.join(cwd, "alias");
  fs.symlinkSync("/etc/ssh", nested);
  assert.equal(
    risk(`rm -f "${nested}"`),
    undefined,
    "unlinking a symlink does not edit its referent",
  );
  assert.equal(risk(`chmod 600 "${nested}"`)?.level, "block");
  for (const command of [
    `rm -f "${nested}/../passwd"`,
    `printf x > "${nested}/missing/new"`,
  ])
    assert.equal(risk(command)?.level, "block", command);
  const dangling = path.join(cwd, "dangling");
  fs.symlinkSync("/etc/pi-missing-fixture", dangling);
  assert.equal(risk(`printf x > "${dangling}/new"`)?.level, "block");
});
test("foreground and background hooks share policy; review approvals never override hard boundaries", async () => {
  const hooks = new Map();
  safety.default({
    on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  });
  let confirmations = 0, answer = true;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      async confirm() {
        confirmations++;
        return answer;
      },
    },
  };
  const call = async (command, toolName = "bash") => {
    for (const hook of hooks.get("tool_call")) {
      const result = await hook({ toolName, input: { command } }, ctx);
      if (result?.block) return result;
    }
  };
  for (const tool of ["bash", "bg_run"]) {
    assert.equal(await call("rm -rf ./build", tool), undefined);
    assert.equal((await call("rm -f /etc/passwd", tool))?.block, true);
    // A target nobody can read is put to the user, not guessed and not refused unseen.
    assert.equal(await call('rm -rf "$UNKNOWN"', tool), undefined);
    assert.equal(await call("rm -rf .", tool), undefined);
  }
  assert.equal(confirmations, 4);
  answer = false;
  assert.equal((await call('rm -rf "$UNKNOWN"'))?.block, true, "declined");
  assert.equal(confirmations, 5);
  ctx.hasUI = false;
  assert.equal((await call("rm -rf ."))?.block, true);
  assert.equal((await call('rm -rf "$UNKNOWN"'))?.block, true, "nobody to ask");
  assert.equal(confirmations, 5);
});
test("safety confirms record accounted waits for hook-health attribution", async () => {
  const hooks = new Map();
  const entries = [];
  safety.default({
    on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    appendEntry: (type, data) => entries.push({ type, data }),
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      async confirm() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return true;
      },
    },
  };
  for (const hook of hooks.get("tool_call")) {
    await hook({ toolName: "bash", input: { command: "rm -rf ." } }, ctx);
  }
  const waits = entries.filter((entry) => entry.type === "fs-confirm-wait-v1");
  assert.equal(waits.length, 1);
  assert.equal(waits[0].data.allowed, true);
  assert.equal(waits[0].data.title, "Review destructive operation");
  assert.ok(waits[0].data.waitMs >= 10, `wait spans the dialog (${waits[0].data.waitMs}ms)`);
});

test("parallel calls sharing one scope dialog emit one receipt counting every waiter", async () => {
  const hooks = new Map();
  const entries = [];
  safety.default({
    on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    appendEntry: (type, data) => entries.push({ type, data }),
  });
  let dialogs = 0;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      async confirm(_title, body) {
        dialogs++;
        assert.ok(body.includes(scopeFile));
        await new Promise((resolve) => setTimeout(resolve, 30));
        return true;
      },
    },
  };
  const scopeFile = path.join(home, `.yunuspi-shared-scope-${process.pid}.txt`);
  const call = { toolName: "write", input: { path: scopeFile, content: "shared scope probe\n" } };
  const handlers = hooks.get("tool_call");
  const [first, second] = await Promise.all([
    (async () => { for (const hook of handlers) { const r = await hook(call, ctx); if (r) return r; } })(),
    (async () => { for (const hook of handlers) { const r = await hook(call, ctx); if (r) return r; } })(),
  ]);
  assert.equal(first, undefined, "the shared approval admits the first call");
  assert.equal(second, undefined, "the shared approval admits the second call");
  assert.equal(dialogs, 1, "parallel calls share one dialog");
  const waits = entries.filter((entry) => entry.type === "fs-confirm-wait-v1");
  assert.equal(waits.length, 1);
  assert.equal(waits[0].data.title, "Additional write scope");
  assert.equal(waits[0].data.waiters, 2, "the receipt counts both hook records the dialog held");
  ctx.hasUI = false;
  const anotherFile = path.join(home, `yunuspi-other-scope-${process.pid}.txt`);
  const headlessCall = { toolName: "write", input: { path: anotherFile, content: "fixture\n" } };
  for (const hook of handlers) {
    const result = await hook(headlessCall, ctx);
    if (!result) continue;
    assert.match(result.reason, /Ask the user about this exact write/);
    assert.ok(result.reason.includes(anotherFile));
    return;
  }
  assert.fail("The headless request should wait for operator approval");
});

test("a resolved workspace file copy requests exact approval and leaves protected operations blocked", async () => {
  const source = path.join(cwd, "work", "artifact.txt");
  const destination = path.join(home, `yunuspi-policy-copy-${process.pid}.txt`);
  fs.writeFileSync(source, "fixture\n");
  const command = `cp -- ${JSON.stringify(source)} ${JSON.stringify(destination)}`;
  assert.equal(risk(command)?.level, "review");
  assert.equal(risk(`cp -r ${source} ${destination}`)?.level, "block");
  assert.equal(risk(`cp ${source} "${home}/"`)?.level, "block");
  assert.equal(risk(`cp ${source} "${home}/.ssh/example"`)?.level, "block");
  assert.equal(risk(`cp ${source} "${home}/.bashrc"`)?.level, "block");
  assert.equal(risk(`cp ${source} /etc/fixture`)?.level, "block");
  assert.equal(risk(`rm -f ${destination}`)?.level, "block");
  const alias = path.join(cwd, "work", "artifact-alias.txt");
  fs.linkSync(source, alias);
  assert.equal(risk(command)?.level, "block", "the source must have a single link");
  fs.unlinkSync(alias);

  const hooks = [];
  safety.default({ on: (name, fn) => { if (name === "tool_call") hooks.push(fn); } });
  const prompts = [];
  let answer = () => true;
  const ctx = {
    cwd, hasUI: true,
    ui: { async confirm(title, body) { prompts.push([title, body]); return answer(); } },
  };
  const call = (toolName = "bash") => hooks[0]({ toolName, input: { command } }, ctx);
  assert.equal(await call(), undefined);
  assert.equal(prompts[0][0], "Confirm external file copy");
  assert.ok(prompts[0][1].includes(command) && prompts[0][1].includes(destination));
  answer = () => false;
  assert.match((await call("bg_run")).reason, /declined/);
  answer = () => { fs.appendFileSync(source, "changed while waiting\n"); return true; };
  assert.match((await call()).reason, /changed while approval was pending/);
  ctx.hasUI = false;
  assert.match((await call()).reason, /exact destination and why/);
  assert.equal(prompts.length, 3);
});

test("ordinary repetitions pass while large degeneration and accidental truncation are identified", () => {
  const line =
    "An ordinary repeated example sentence with enough content to resemble a paragraph. ";
  assert.equal(safety.writeDegeneration((line + "\n").repeat(3)), undefined);
  assert.match(safety.writeDegeneration((line + "\n").repeat(200)), /85%/);
  assert.equal(safety.writeReplacementRisk("old file", "new file"), undefined);
  assert.equal(
    safety.writeReplacementRisk("a".repeat(20000), "b".repeat(15000)),
    undefined,
  );
  assert.match(safety.writeReplacementRisk("a".repeat(20000), ""), /95%/);
});

test("agent memory has one write policy for shell and edit: entries writable, trees never wiped", () => {
  const memory = path.join(agent, "memory");
  for (const command of [
    `echo "- [ ] note" >> ${memory}/SCRATCHPAD.md`,
    `cp ${cwd}/notes.md ${memory}/projects/notes.md`,
  ]) assert.equal(risk(command)?.level, undefined, command);
  for (const command of [`rm -rf ${memory}`, `rm -rf ${memory}/projects`, `rm -f ${memory}/*`])
    assert.equal(risk(command)?.level, "block", command);
  assert.equal(risk(`echo x >> ${home}/.bashrc`)?.level, "block", "other home files stay protected");
});

test("a loop variable bound to literal words is read as each of them, and unknown otherwise", () => {
  const clear = [
    'for f in a.txt b.txt; do rm -f "$f"; done',
    'for f in app.css panel.css; do cp "$f" ../../verify/$f; done',
    'for t in one two; do ./run --$t > /tmp/out_$t.log 2>&1; done',
    'for a in x y; do for b in 1 2; do rm -f "$a$b"; done; done',
    'for f in *.log; do rm -f "$f"; done',
  ];
  for (const command of clear) assert.equal(risk(command), undefined, command);
  // Every word is read, so one that reaches a protected place still blocks.
  for (const command of ['for d in build /etc; do rm -rf "$d"; done', 'for d in tmp-a /; do rm -rf $d; done', 'for f in ok.txt ../../../etc/hosts; do rm -f "$f"; done'])
    assert.equal(risk(command)?.level, "block", command);
  // Anything else about the operand, or the loop, stays unknown.
  for (const command of [
    'for f in $(ls); do rm -f "$f"; done',
    'for f in a b; do f=$(pick); rm -f "$f"; done',
    'for f in a b; do read f; rm -f "$f"; done',
    'for f in a b; do rm -f "$f"; done; rm -f "$f"',
    'for f in a b; do rm -f "$f$x"; done',
    `for f in ${Array.from({ length: 65 }, (_, n) => `f${n}`).join(" ")}; do rm -f "$f"; done`,
  ]) assert.equal(risk(command)?.resolved, false, command);
});

test("one named file among the user's own files asks instead of being refused; trees, globs, system paths and secrets stay refused", async () => {
  const asks = [
    "echo probe > ~/Downloads/.fusewrite_probe",
    "rm -f ~/Downloads/.fusewrite_probe",
    "printf x > ~/.config/autostart/keyring.desktop",
    "sed -i s/a/b/ ~/.local/share/applications/app.desktop",
    "echo hi > ~/Desktop/some-project/dev/logs/serve.log",
  ];
  for (const command of asks) {
    const found = risk(command);
    assert.equal(found?.level, "review", command);
    assert.equal(found.resolved, true, command);
  }
  for (const command of [
    "rm -rf ~/Downloads/old", "rm ~/Downloads/*", "rm ~/Downloads", "echo x > ~/Desktop", "mv a.txt ~/Downloads/b.txt",
    "echo x > ~/.ssh/authorized_keys", "echo x > ~/.config/user-dirs.dirs", "echo x > ~/.local/share/keyrings/login.keyring",
    "echo x > /etc/hosts", "echo x > ~/.pi/agent/settings.json",
  ]) assert.equal(risk(command)?.level, "block", command);

  const hooks = new Map();
  safety.default({ on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) });
  const prompts = [];
  let answer = true;
  const ctx = { cwd, hasUI: true, ui: { notify() {}, async confirm(title, body) { prompts.push({ title, body }); return answer; } } };
  const call = async command => {
    for (const hook of hooks.get("tool_call")) {
      const result = await hook({ toolName: "bash", input: { command } }, ctx);
      if (result?.block) return result;
    }
  };
  assert.equal(await call(asks[0]), undefined, "the user said yes");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body, /fusewrite_probe/);
  answer = false;
  assert.equal((await call(asks[0]))?.block, true, "the user said no");
  ctx.hasUI = false;
  assert.equal((await call(asks[0]))?.block, true, "headless keeps refusing");
  assert.equal(prompts.length, 2, "headless never asks");
});

test("a refusal whose reason already says Blocked reads with one prefix and one full stop", () => {
  const guard = "Blocked: this session was launched outside the harness maintenance directory. Harness writes require a new human-started session inside the harness root.";
  const line = safety.describeShellRisk({ level: "block", reason: guard, target: "x.ts", resolved: true });
  assert.equal(line, 'Blocked: this session was launched outside the harness maintenance directory. Harness writes require a new human-started session inside the harness root: "x.ts".');
  assert.equal(safety.describeShellRisk({ level: "review", reason: "This changes a file outside the project", resolved: true }), "Review required: This changes a file outside the project.");
});
