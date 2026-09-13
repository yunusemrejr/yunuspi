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
    /import \{\s*getAgentDir,[\s\S]*?from "@earendil-works\/pi-coding-agent";/,
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
  "git push --force-with-lease origin feature",
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
  let confirmations = 0;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      async confirm() {
        confirmations++;
        return true;
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
    assert.equal((await call('rm -rf "$UNKNOWN"', tool))?.block, true);
    assert.equal(await call("rm -rf .", tool), undefined);
  }
  assert.equal(confirmations, 2);
  ctx.hasUI = false;
  assert.equal((await call("rm -rf ."))?.block, true);
});

// Only schema construction is stubbed; explicit file lists use the actual
// collector, planner, preview registry, path checks and filesystem apply code.
const bulk = await load("bulk-edit.ts", [
  [
    /import \{ Type \} from "typebox";/,
    "const Type = new Proxy({}, {get:()=>()=>({})});",
  ],
  [
    /import \{ Minimatch \} from "minimatch";/,
    'class Minimatch { constructor(){throw Error("This fixture must use explicit file lists");} }',
  ],
]);
function bulkTool() {
  let tool;
  bulk.default({ registerTool: (t) => (tool = t) });
  return tool;
}
const tool = bulkTool();
const bulkCall = (params, root = cwd, instance = tool) =>
  instance.execute("test", params, undefined, undefined, { cwd: root });
const params = {
  pattern: "old",
  replacement: "new",
  files: ["a.txt", "b.txt"],
};
const preview = () => bulkCall({ ...params, action: "preview" });
test("bulk edits require a real single-use preview bound to root and unchanged inputs", async () => {
  fs.writeFileSync(path.join(cwd, "a.txt"), "old A");
  fs.writeFileSync(path.join(cwd, "b.txt"), "old B");
  const p = await preview();
  assert.equal(p.isError, undefined);
  const apply = { ...params, action: "apply", token: p.details.token };
  assert.equal(
    (await bulkCall(apply, cwd, bulkTool())).isError,
    true,
    "another instance has no preview",
  );
  const other = path.join(cwd, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "a.txt"), "old A");
  fs.writeFileSync(path.join(other, "b.txt"), "old B");
  assert.equal(
    (await bulkCall(apply, other)).isError,
    true,
    "identical bytes in a different root",
  );
  fs.writeFileSync(path.join(cwd, "b.txt"), "old changed");
  assert.equal((await bulkCall(apply)).isError, true);
  assert.equal(
    fs.readFileSync(path.join(cwd, "a.txt"), "utf8"),
    "old A",
    "no partial writes for stale preview",
  );
  const fresh = await preview();
  const good = { ...apply, token: fresh.details.token };
  assert.equal((await bulkCall(good)).isError, undefined);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "new A");
  fs.writeFileSync(path.join(cwd, "a.txt"), "old A");
  fs.writeFileSync(path.join(cwd, "b.txt"), "old changed");
  assert.equal(
    (await bulkCall(good)).isError,
    true,
    "consumed token cannot be replayed after restoring bytes",
  );
});
test("bulk edit rejects parent symlink escapes before reading or writing their files", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bulk-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "file"), "old");
    fs.symlinkSync(outside, path.join(cwd, "outside"));
    const r = await bulkCall({
      action: "preview",
      pattern: "old",
      replacement: "new",
      files: ["outside/file"],
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /escapes the workspace/);
    assert.equal(fs.readFileSync(path.join(outside, "file"), "utf8"), "old");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
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

test("bulk commit rolls back earlier files after a late rename failure", async () => {
  const fsp = await import('node:fs/promises');
  const originalRename = fsp.default.rename;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-rollback-'));
  const instance = bulkTool();
  try {
    for (const name of ['a.txt','b.txt']) fs.writeFileSync(path.join(root,name),'old content');
    fs.chmodSync(path.join(root,'a.txt'),0o640);
    const input = {action:'preview',pattern:'old',replacement:'new',files:['a.txt','b.txt']};
    const preview = await bulkCall(input,root,instance);
    const token = JSON.parse(preview.content[0].text).token;
    fsp.default.rename = async (from,to) => {
      if (from.endsWith('.tmp') && to === path.join(root,'b.txt')) throw Error('injected disk failure');
      return originalRename(from,to);
    };
    const result = await bulkCall({...input,action:'apply',token},root,instance);
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/all committed files rolled back/);
    for (const name of ['a.txt','b.txt']) assert.equal(fs.readFileSync(path.join(root,name),'utf8'),'old content');
    assert.equal(fs.statSync(path.join(root,'a.txt')).mode & 0o777,0o640);
    assert.deepEqual(fs.readdirSync(root).sort(),['a.txt','b.txt']);
  } finally { fsp.default.rename = originalRename; fs.rmSync(root,{recursive:true,force:true}); }
});

test("bulk rollback preserves a concurrent writer and leaves the original backup", async () => {
  const fsp = await import('node:fs/promises');
  const originalRename = fsp.default.rename;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-conflict-'));
  const instance = bulkTool();
  try {
    for (const name of ['a.txt','b.txt']) fs.writeFileSync(path.join(root,name),'old content');
    const input = {action:'preview',pattern:'old',replacement:'new',files:['a.txt','b.txt']};
    const preview = await bulkCall(input,root,instance);
    const token = JSON.parse(preview.content[0].text).token;
    fsp.default.rename = async (from,to) => {
      if (from.endsWith('.tmp') && to === path.join(root,'b.txt')) {
        fs.writeFileSync(path.join(root,'a.txt'),'peer update');
        throw Error('injected disk failure');
      }
      return originalRename(from,to);
    };
    const result = await bulkCall({...input,action:'apply',token},root,instance);
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/rollback incomplete/);
    assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'peer update');
    const backups = fs.readdirSync(root).filter(name=>name.endsWith('.bak'));
    assert.equal(backups.length,1);
    assert.equal(fs.readFileSync(path.join(root,backups[0]),'utf8'),'old content');
  } finally { fsp.default.rename = originalRename; fs.rmSync(root,{recursive:true,force:true}); }
});

test("extension mutations invoke the same filesystem policy before any write", async () => {
  const listeners = new Map();
  const events = {on:(name,fn)=>listeners.set(name,[...(listeners.get(name)??[]),fn]),emit:(name,event)=>{for(const fn of listeners.get(name)??[])fn(event)}};
  safety.default({on(){},events});
  let invoked = 0;
  // A second owner participates in the same preflight; its rejection must
  // prevent every target, including ones validated before the denied file.
  events.on('harness:mutation-preflight', request => request.checks.push(async () => {invoked++; return {block:true,reason:'fixture overlapping peer'};}));
  let instance;
  bulk.default({registerTool:t=>instance=t,events});
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bulk-policy-'));
  try {
    fs.writeFileSync(path.join(root,'a.txt'),'old');
    const input={action:'preview',pattern:'old',replacement:'new',files:['a.txt']};
    const preview=await bulkCall(input,root,instance);
    const token=JSON.parse(preview.content[0].text).token;
    const result=await bulkCall({...input,action:'apply',token},root,instance);
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/overlapping peer/);
    assert.equal(invoked,1);
    assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'old');
    assert.deepEqual(fs.readdirSync(root),['a.txt']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
