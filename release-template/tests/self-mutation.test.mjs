import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const templateRoot = path.resolve(
 path.dirname(fileURLToPath(import.meta.url)),
 "..",
);
const agent = [
 path.join(templateRoot, "agent"),
 path.resolve(templateRoot, ".."),
].find((dir) =>
 fs.existsSync(path.join(dir, "extensions/lib/self-mutation-guard.ts")),
);
assert.ok(agent, "self-mutation guard must be shipped");
const moduleUrl = pathToFileURL(
 path.join(agent, "extensions/lib/self-mutation-guard.ts"),
).href;
const harness = path.dirname(agent);
const wrapper = path.join(agent, "scripts/harness-readonly-exec.py");
assert.ok(fs.existsSync(wrapper), "namespace launcher must be shipped");
assert.ok(
 fs.existsSync(path.join(templateRoot, "config/bwrap.apparmor")),
 "Ubuntu namespace policy referenced by CI and installation must be shipped",
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
 const root = fs.mkdtempSync(path.join(TEMP_BASE, "yunuspi-mutation-"));
 const protectedDir = path.join(root, "harness"),
  project = path.join(root, "project");
 fs.mkdirSync(protectedDir);
 fs.mkdirSync(project);
 fs.writeFileSync(path.join(protectedDir, "original"), "unchanged");
 return {
  root,
  protectedDir,
  project,
  close: () => fs.rmSync(root, { recursive: true, force: true }),
 };
}
function node(cwd, code, extra = {}) {
 const env = { ...process.env };
 delete env.PI_HARNESS_MUTATION_DENIED;
 delete env.PI_SUBAGENT_CHILD;
 delete env.NODE_TEST_CONTEXT;
 return spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", code],
  { cwd, env: { ...env, ...extra }, encoding: "utf8" },
 );
}
function authority(cwd, extra = {}, change = false) {
 const result = node(
  cwd,
  `const g=await import(${JSON.stringify(moduleUrl)});${change ? `process.chdir(${JSON.stringify(harness)});` : ""}console.log(JSON.stringify([g.SELF_MUTATION_ALLOWED,!!g.selfMutationDenial(${JSON.stringify(path.join(harness, "new-file"))},process.cwd())]));`,
  extra,
 );
 assert.equal(result.status, 0, result.stderr);
 return JSON.parse(result.stdout.trim());
}
test("maintenance authority is latched at original process launch", () => {
 const f = fixture();
 try {
  for (const cwd of [harness, agent, path.join(agent, "extensions")])
   assert.deepEqual(authority(cwd), [true, false]);
  for (const cwd of [
   path.dirname(harness),
   path.parse(harness).root,
   os.homedir(),
  ])
   if (cwd !== harness) assert.deepEqual(authority(cwd), [false, true]);
  assert.deepEqual(authority(f.project), [false, true]);
  assert.deepEqual(authority(f.project, {}, true), [false, true]);
  assert.deepEqual(authority(harness, { PI_SUBAGENT_CHILD: "1" }), [
   false,
   true,
  ]);
  assert.deepEqual(authority(harness, { PI_HARNESS_MUTATION_DENIED: "1" }), [
   false,
   true,
  ]);
 } finally {
  f.close();
 }
});
test("project tool guidance advertises executable native orchestration", () => {
 const f = fixture();
 try {
  const url = pathToFileURL(
   path.join(
    agent,
    "extensions/pi-subagents/src/extension/tool-description.ts",
   ),
  ).href;
  const inspect = (cwd) =>
   node(
    cwd,
    `const m=await import(${JSON.stringify(url)});console.log(JSON.stringify([m.buildSubagentToolDescription(),m.buildSubagentToolPromptMetadata()]));`,
   );
  const project = inspect(f.project);
  assert.equal(project.status, 0, project.stderr);
  const [description, metadata] = JSON.parse(project.stdout);
  assert.match(
   description,
   /workflowScript is unavailable in this project session/,
  );
  assert.match(description, /tasks:\[/);
  assert.match(description, /chain:\[/);
  assert.ok(
   description.includes("skill:['name'] in native child/task options"),
  );
  assert.ok(
   !description.includes("skills:['name']"),
   "native calls advertise the consumed singular skill parameter",
  );
  assert.doesNotMatch(
   metadata.promptGuidelines.join(" "),
   /Use one async workflowScript/,
  );
  const maintenance = inspect(harness);
  assert.equal(maintenance.status, 0, maintenance.stderr);
  assert.match(JSON.parse(maintenance.stdout)[0], /runs\.all/);
  assert.ok(
   JSON.parse(maintenance.stdout)[0].includes(
    "skills:['name'] in runs.run/runs.all child options",
   ),
   "workflow child options retain their plural skills parameter",
  );
 } finally {
  f.close();
 }
});
test("new targets resolve symlink ancestors and unrelated prefixes remain outside", () => {
 const f = fixture();
 try {
  try {
   fs.symlinkSync(f.protectedDir, path.join(f.project, "alias"), "dir");
  } catch (error) {
   if (error.code === "EPERM" && process.platform === "win32")
    throw new Error(
     "Symlink creation is required for this path-resolution test; enable Developer Mode.",
    );
   throw error;
  }
  const result = node(
   f.project,
   `const g=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([g.canonicalMutationPath('alias/new/deep'),g.containsPath(${JSON.stringify(f.protectedDir)},${JSON.stringify(f.protectedDir + "-sibling")})]));`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
   path.join(f.protectedDir, "new/deep"),
   false,
  ]);
 } finally {
  f.close();
 }
});
test("unsupported namespace platform fails closed before launching a command", () => {
 const f = fixture();
 try {
  const result = node(
   f.project,
   `Object.defineProperty(process,'platform',{value:'unsupported-test'}); const g=await import(${JSON.stringify(moduleUrl)}); try {g.guardedCommand('arbitrary-command',[]);process.exit(99);} catch(e){if(!/No unisolated command was started/.test(e.message))throw e;}`,
  );
  assert.equal(result.status, 0, result.stderr);
 } finally {
  f.close();
 }
});
test("fresh native inventory detects outside aliases and unreadable subtrees", () => {
 const f = fixture();
 try {
  const script = `import importlib.util, os, sys
spec=importlib.util.spec_from_file_location('guard',sys.argv[1])
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
root=sys.argv[2]
# NUL-delimited native records preserve whitespace/newlines in real paths.
inside=os.path.join(root,'inside linked'+chr(10)+'file'+chr(92)+'0 suffix')
os.link(os.path.join(root,'original'),inside)
guard.check_protected_hardlinks([root, inside, os.path.join(root,'missing')])
# An alias introduced after a successful scan must be found on the next call.
alias=os.path.join(os.path.dirname(root),'outside alias')
os.link(os.path.join(root,'original'),alias)
try: guard.check_hardlinks(root)
except RuntimeError as error: assert 'hard-linked' in str(error)
else: raise AssertionError('fresh outside alias was not rejected')
# The protected union may legitimately contain every alias.
guard.check_protected_hardlinks([root, alias])
os.unlink(alias)
# Broken symlinks are not followed and do not hide other entries.
os.symlink(os.path.join(root,'missing'),os.path.join(root,'vanished-lock'))
guard.check_hardlinks(root)
locked=os.path.join(root,'unreadable');os.mkdir(locked);os.chmod(locked,0)
try:
 if os.geteuid()!=0:
  try: guard.check_hardlinks(root)
  except RuntimeError as error: assert 'inventory failed' in str(error)
  else: raise AssertionError('unreadable subtree was accepted')
finally: os.chmod(locked,0o700)

`;
  const result = spawnSync(
   "python3",
   ["-B", "-c", script, wrapper, f.protectedDir],
   { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
 } finally {
  f.close();
 }
});
test("SSH projections preserve bytes and never bless untrusted or unavailable files", () => {
 const script = `import importlib.util, os, stat, sys
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('guard',sys.argv[1])
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
with patch.object(guard.glob,'glob',return_value=[]), patch.object(guard.os.path,'isfile',return_value=True), patch.object(guard.os,'stat',return_value=SimpleNamespace(st_uid=1000,st_mode=stat.S_IFREG|0o644)), patch.object(guard.os,'open',side_effect=AssertionError('untrusted file opened')):
 assert guard.ssh_config_mounts()==([],[])
with patch.object(guard.glob,'glob',return_value=[]), patch.object(guard.os.path,'isfile',return_value=True), patch.object(guard.os,'stat',side_effect=PermissionError('unavailable')):
 assert guard.ssh_config_mounts()==([],[])
if hasattr(os,'memfd_create'):
 mounts,descriptors=guard.ssh_config_mounts()
 try:
  for offset in range(0,len(mounts),5):
   assert mounts[offset:offset+3]==['--perms','0400','--ro-bind-data']
   descriptor=int(mounts[offset+3]);target=mounts[offset+4]
   with open(target,'rb') as source: assert os.read(descriptor,1024*1024+1)==source.read()
 finally:
  for descriptor in descriptors: os.close(descriptor)
`;
 const result = spawnSync("python3", ["-B", "-c", script, wrapper], {
  encoding: "utf8",
 });
 assert.equal(result.status, 0, result.stderr);
});
test("real namespace prevents mutation while allowing project work", (t) => {
 const f = fixture();
 try {
  const python = process.platform === "linux" ? "/usr/bin/python3" : "python3";
  const run = (code) =>
   spawnSync(
    python,
    ["-I", wrapper, f.protectedDir, "--", python, "-c", code],
    { cwd: f.project, encoding: "utf8" },
   );
  const probe = run("open('normal','w').write('ok')");
  if (probe.status !== 0) {
   const unavailable =
    probe.error?.code === "ENOENT" ||
    /Linux bubblewrap runtime required|required executable unavailable: \/usr\/bin\/bwrap|bwrap:.*(?:Operation not permitted|Permission denied|No permissions to create|Creating new namespace failed|namespace)/i.test(
     probe.stderr ?? "",
    );
   assert.ok(
    unavailable,
    `Namespace probe failed unexpectedly: ${probe.stderr ?? probe.error}`,
   );
   assert.notEqual(
    process.env.PI_REQUIRE_ISOLATION_TEST,
    "1",
    `Required namespace integration unavailable: ${probe.stderr ?? probe.error}`,
   );
   assert.ok(
    !fs.existsSync(path.join(f.project, "normal")),
    "failed isolation must not execute payload",
   );
   assert.equal(
    fs.readFileSync(path.join(f.protectedDir, "original"), "utf8"),
    "unchanged",
   );
   t.skip(
    "Real namespace integration unavailable on this host; payload did not execute. Portable fail-closed checks ran separately.",
   );
   return;
  }
  const target = JSON.stringify(path.join(f.protectedDir, "original"));
  const sibling = path.join(f.root, "vanishing-sibling");
  fs.mkdirSync(sibling);
  const raceScript = `import importlib.util, os, sys
spec=importlib.util.spec_from_file_location('guard',sys.argv[1])
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
wrapper,root,sibling=sys.argv[1:]
original_exec=guard.os.execv
def race(executable,args):
 os.rmdir(sibling)
 original_exec(executable,args)
guard.os.execv=race
sys.argv=[wrapper,root,'--',sys.executable,'-c',"open('after-race','w').write('ok')"]
guard.main()
`;
  const race = spawnSync(
   python,
   ["-I", "-c", raceScript, wrapper, f.protectedDir, sibling],
   { cwd: f.project, encoding: "utf8" },
  );
  assert.equal(
   race.status,
   0,
   `Disappearing optional sibling must not fail execution: ${race.stderr}`,
  );
  assert.equal(
   fs.readFileSync(path.join(f.project, "after-race"), "utf8"),
   "ok",
  );
  if (fs.existsSync("/usr/bin/ssh")) {
   const ssh = run(
    "import subprocess; subprocess.run(['/usr/bin/ssh','-G','example.invalid'],stdout=subprocess.DEVNULL,check=True)",
   );
   assert.equal(
    ssh.status,
    0,
    `SSH system config must remain valid in the user namespace: ${ssh.stderr}`,
   );
  }
  for (const code of [
   `open(${target},'w').write('bad')`,
   `import os;os.chmod(${target},0o777)`,
   `import os;os.rename(${JSON.stringify(f.root)},${JSON.stringify(f.root + "-moved")})`,
   `import os;os.chdir(${JSON.stringify(f.protectedDir)});os.environ.clear();open('new','w').write('bad')`,
  ])
   assert.notEqual(run(code).status, 0, code);
  assert.equal(
   fs.readFileSync(path.join(f.protectedDir, "original"), "utf8"),
   "unchanged",
  );
  fs.linkSync(
   path.join(f.protectedDir, "original"),
   path.join(f.project, "hardlink"),
  );
  const linked = run("open('hardlink','w').write('bad')");
  assert.equal(linked.status, 126);
  assert.match(linked.stderr, /hard-linked/);
  assert.equal(
   fs.readFileSync(path.join(f.protectedDir, "original"), "utf8"),
   "unchanged",
  );
 } finally {
  f.close();
 }
});

test("guarded commands cannot mutate host-writable device subtrees", (t) => {
 const f = fixture();
 const target = `/dev/shm/yunuspi-guard-${process.pid}-${Date.now()}`;
 try {
  const python = process.platform === "linux" ? "/usr/bin/python3" : "python3";
  const result = spawnSync(
   python,
   ["-I", wrapper, f.protectedDir, "--", python, "-c", `open(${JSON.stringify(target)},'w').write('bad')`],
   { cwd: f.project, encoding: "utf8" },
  );
  if (result.status !== 0 && /(?:bubblewrap|namespace|Operation not permitted|Permission denied)/i.test(result.stderr ?? "")) {
   if (process.env.PI_REQUIRE_ISOLATION_TEST === "1") assert.fail(result.stderr);
   t.skip("Real namespace integration unavailable on this host");
   return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(target), false, "host /dev/shm must not be writable from the guarded child");
 } finally {
  try { fs.unlinkSync(target); } catch {}
  f.close();
 }
});

test("native guards distinguish protected inode aliases from ordinary project hardlinks", () => {
 const f = fixture();
 try {
  const lib = path.join(f.protectedDir, "agent/extensions/lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(
   path.join(agent, "extensions/lib/self-mutation-guard.ts"),
   path.join(lib, "self-mutation-guard.ts"),
  );
  const guard = pathToFileURL(path.join(lib, "self-mutation-guard.ts")).href;
  fs.symlinkSync(
   path.join(f.protectedDir, "agent"),
   path.join(f.project, "alias"),
  );
  fs.symlinkSync(
   path.join(f.protectedDir, "missing"),
   path.join(f.project, "dangling"),
  );
  fs.linkSync(
   path.join(f.protectedDir, "original"),
   path.join(f.project, "harness-link"),
  );
  fs.writeFileSync(path.join(f.project, "ordinary"), "project");
  fs.linkSync(
   path.join(f.project, "ordinary"),
   path.join(f.project, "ordinary-link"),
  );
  const result = node(
   f.project,
   `const g=await import(${JSON.stringify(guard)});delete process.env.PI_HARNESS_MUTATION_DENIED;process.chdir(${JSON.stringify(f.protectedDir)});console.log(JSON.stringify(['alias/../original','dangling/new','harness-link','ordinary-link'].map(p=>!!g.selfMutationDenial(p,${JSON.stringify(f.project)}))));`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, true, false]);
  assert.equal(
   fs.readFileSync(path.join(f.protectedDir, "original"), "utf8"),
   "unchanged",
  );
 } finally {
  f.close();
 }
});

test("bulk apply cannot use an ancestor workspace to acquire maintenance authority", () => {
 const f = fixture();
 try {
  const lib = path.join(f.protectedDir, "agent/extensions/lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(
   path.join(agent, "extensions/lib/self-mutation-guard.ts"),
   path.join(lib, "self-mutation-guard.ts"),
  );
  const guard = pathToFileURL(path.join(lib, "self-mutation-guard.ts")).href;
  const helper = pathToFileURL(
   path.join(agent, "extensions/lib/bulk-edit.ts"),
  ).href;
  const bulk = path.join(agent, "extensions/bulk-edit.ts");
  const result = node(
   f.root,
   `import fs from 'node:fs';import assert from 'node:assert/strict';import {stripTypeScriptTypes} from 'node:module';
let source=fs.readFileSync(${JSON.stringify(bulk)},'utf8').replace('import { Type } from "typebox";','const Type=new Proxy({},{get:()=>()=>({})});').replace('import { Minimatch } from "minimatch";','class Minimatch {constructor(){throw Error("explicit files only");}}').replace('"./lib/self-mutation-guard.ts"',${JSON.stringify(JSON.stringify(guard))}).replace('"./lib/bulk-edit.ts"',${JSON.stringify(JSON.stringify(helper))});
const m=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));let tool;m.default({registerTool:t=>tool=t});const params={pattern:'unchanged',replacement:'bad',files:['harness/original']};
const preview=await tool.execute('preview',{...params,action:'preview'},undefined,undefined,{cwd:process.cwd()});assert.equal(preview.isError,undefined);
const apply=await tool.execute('apply',{...params,action:'apply',token:preview.details.token},undefined,undefined,{cwd:process.cwd()});assert.equal(apply.isError,true);assert.match(apply.content[0].text,/launched outside/);`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
   fs.readFileSync(path.join(f.protectedDir, "original"), "utf8"),
   "unchanged",
  );
 } finally {
  f.close();
 }
});
