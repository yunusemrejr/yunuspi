import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.dirname);
const lib = await jiti.import("../agent/extensions/lib/colab.ts");
const jobs = await jiti.import("../agent/extensions/lib/colab-jobs.ts");
const auth = await jiti.import("../agent/extensions/lib/colab-auth.ts");
const extension = await jiti.import("../agent/extensions/colab.ts");
const { CORE_TOOLS, INTENT_BUNDLES } = await jiti.import("../agent/extensions/lib/tool-discovery.ts");

const TOOLS = [];
extension.default({ registerTool: (tool) => TOOLS.push(tool), on: () => {} });
const tool = TOOLS.find((candidate) => candidate.name === "colab");
assert.ok(tool, "colab tool registered");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-colab-test-"));
const fake = path.join(tmp, "fake-colab");
const helper = path.join(tmp, "fake-helper.mjs");
const state = path.join(tmp, "state");
const previous = { ...process.env };

function fakeCli() {
  const script = `#!/usr/bin/env bash
set -u
STATE="${"$"}{FAKE_COLAB_STATE:?}"
mkdir -p "$STATE"
AUTHED="$STATE/authed"
SESSION="$STATE/session-train1"
args=("$@"); i=0; cmd=""
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    --auth|--config|--client-oauth-config|-c) i=$((i+2));;
    --auth=*|--config=*) i=$((i+1));;
    -*) i=$((i+1));;
    *) cmd="$a"; break;;
  esac
done
case "$cmd" in
  version|--version) echo "Version: 0.7.4";;
  whoami)
    if [ -f "$AUTHED" ]; then
      echo "Auth provider: oauth2"; echo "Email:         smoke.test@example.com"; echo "Expires in:    59m"; echo "Scopes:"; echo "  - openid"; echo "  - https://www.googleapis.com/auth/colaboratory"; exit 0
    fi
    echo "To authorize colab-cli, visit this URL in any browser:" >&2
    echo "  https://accounts.google.com/o/oauth2/auth?client_id=fake&state=smoke" >&2
    printf "Enter the authorization code: "
    if IFS= read -r code; then
      case "$code" in
        4/fake-authorization-code-123456) touch "$AUTHED"; echo "Auth provider: oauth2"; echo "Email:         smoke.test@example.com"; echo "Expires in:    59m"; echo "Scopes:"; echo "  - openid"; exit 0;;
      esac
    fi
    exit 1;;
  sessions)
    if [ -f "$SESSION" ]; then echo "[train1] m-s-fake-endpoint | Hardware: T4 | Shape: STANDARD | Variant: GPU | Status: IDLE"; else echo "[colab] No active sessions found on server."; fi;;
  status)
    if [ -f "$SESSION" ]; then echo "[train1] m-s-fake-endpoint | Hardware: T4 | Shape: STANDARD | Variant: GPU | Status: IDLE"; else echo "[colab] No active sessions."; fi;;
  usage) printf 'Current balance: 42.50 compute units\\nUsage rate: 0.25/hr\\nActive assignments: 1\\n';;
  new) touch "$SESSION"; echo "[colab] Creating session..."; echo "[colab] Session READY.";;
  exec)
    code=$(cat)
    if printf '%s' "$code" | grep -q SLEEP; then sleep 5; fi
    printf 'EXEC:%s\\n' "$code"
    if printf '%s' "$code" | grep -q TRACEBACK; then printf 'An exception has occurred, use %%tb to see the full traceback.\n'; exit 0; fi
    if printf '%s' "$code" | grep -q FAIL; then exit 2; fi
    exit 0;;
  run) echo "[run] ok";;
  install) echo "[install] ok";;
  upload) echo "[upload] ok";;
  download) echo "[download] ok";;
  ls) echo "checkpoints/";;
  rm) echo "[rm] ok";;
  log) printf '# log\\ncell 1\\n' > "$STATE/log.md"; echo "[log] done";;
  stop) rm -f "$SESSION"; echo "[colab] Session terminated.";;
  restart-kernel) echo "[colab] Kernel restarted.";;
  url) echo "https://colab.research.google.com/notebooks/empty.ipynb?dbu=%2Ftun%2Fm%2Ffake";;
  update) echo "already current";;
  *) echo "[fake-colab] unsupported: $*" >&2; exit 64;;
esac
`;
  fs.writeFileSync(fake, script, { mode: 0o755 });
  fs.writeFileSync(helper, `process.stdout.write(JSON.stringify({status:"opened",browser:"fake"})+"\\n");\nsetTimeout(()=>process.stdout.write(JSON.stringify({status:"code",code:"4/fake-authorization-code-123456"})+"\\n"),100);\n`);
}

function configure(authed = false) {
  fs.mkdirSync(state, { recursive: true });
  fs.rmSync(path.join(state, "authed"), { force: true });
  fs.rmSync(path.join(state, "session-train1"), { force: true });
  if (authed) fs.writeFileSync(path.join(state, "authed"), "");
  process.env.PI_COLAB_CLI = fake;
  process.env.PI_COLAB_STATE_DIR = state;
  process.env.FAKE_COLAB_STATE = state;
  process.env.PI_COLAB_AUTH_BROWSER = helper;
  process.env.PI_COLAB_USE_BROWSER_COOKIES = "0";
}

async function call(params) {
  return tool.execute(`call-${Math.random()}`, params, undefined, () => {}, { cwd: tmp, sessionManager: {}, hasUI: false });
}

test.before(() => { fakeCli(); configure(false); });
test.after(() => {
  try { auth.shutdownAuth(); } catch {}
  try { jobs.shutdownJobs(); } catch {}
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the colab tool is one discoverable action tool wired into manifest, staging and routing", async () => {
  assert.deepEqual(TOOLS.map((item) => item.name), ["colab"]);
  assert.equal(CORE_TOOLS.has("colab"), false, "colab stays off-wire until tool_search or its intent bundle stages it");
  assert.ok(tool.description.length > 400 && tool.parameters?.type === "object");
  assert.ok(tool.parameters.properties.action.enum.includes("setup"));
  assert.ok(tool.parameters.properties.action.enum.includes("job_output"));
  assert.ok(INTENT_BUNDLES.some((bundle) => bundle.skill === "colab" && bundle.tools.includes("colab")));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "agent/extensions/manifest.json"), "utf8"));
  for (const file of ["colab.ts"]) assert.ok(manifest.extensions.includes(file), file);
  for (const file of ["colab.ts", "colab-auth.ts", "colab-jobs.ts"]) assert.ok(manifest.lib.includes(file), file);
  assert.ok(manifest.supportFiles.includes("scripts/colab-auth-browser.mjs"));
  for (const file of ["agent/extensions/colab.ts", "agent/extensions/lib/colab.ts", "agent/extensions/lib/colab-auth.ts", "agent/extensions/lib/colab-jobs.ts", "agent/scripts/colab-auth-browser.mjs", "agent/skills/colab/SKILL.md", "docs/GOOGLE-COLAB.md"]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  const routes = await jiti.import("../agent/extensions/lib/skill-routing.ts");
  const route = routes.skillRoutes.find((item) => item.name === "colab");
  assert.ok(route);
  assert.ok(route.intent.test("fine-tune Qwen with QLoRA in Google Colab"));
  assert.ok(route.intent.test("rent a GPU session for RL training"));
});

test("parsers read usage, whoami, sessions and errors without losing unit meaning", () => {
  assert.deepEqual(lib.parseUsage("Current balance: 42.50 compute units\nUsage rate: 0.25/hr\nActive assignments: 1\n"), {
    balance: 42.5,
    ratePerHour: 0.25,
    activeAssignments: 1,
    raw: "Current balance: 42.50 compute units\nUsage rate: 0.25/hr\nActive assignments: 1\n",
  });
  const who = lib.parseWhoami("Auth provider: oauth2\nEmail: test@example.com\nExpires in: 59m\nScopes:\n  - openid\n  - https://www.googleapis.com/auth/colaboratory\n");
  assert.equal(who.provider, "oauth2");
  assert.equal(who.email, "test@example.com");
  assert.equal(who.expiresIn, "59m");
  assert.deepEqual(who.scopes, ["openid", "https://www.googleapis.com/auth/colaboratory"]);
  const sessions = lib.parseSessions("[train1] m-s-abc | Hardware: T4 | Shape: STANDARD | Variant: GPU | Status: IDLE\n[colab] No active sessions found on server.\n");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "train1");
  assert.equal(sessions[0].hardware, "T4");
  assert.equal(sessions[0].status, "IDLE");
  assert.match(lib.parseErrorHints("HTTP 401 unauthorized") ?? "", /authentication/i);
  assert.match(lib.parseErrorHints("412 precondition failed") ?? "", /too many active sessions/i);
});

test("argument builders order global auth before the subcommand and reject unsafe values", () => {
  assert.deepEqual(lib.newArgs({ session: "train1", gpu: "T4", auth: "oauth2" }), ["--auth", "oauth2", "new", "-s", "train1", "--gpu", "T4"]);
  assert.deepEqual(lib.newArgs({ session: "train1", tpu: "v6e1", highMem: true }), ["--auth", "oauth2", "new", "-s", "train1", "--tpu", "v6e1", "--high-mem"]);
  assert.throws(() => lib.newArgs({ session: "train1", gpu: "A200" }), /Unsupported GPU/);
  assert.throws(() => lib.newArgs({ session: "-evil" }), /Session names/);
  assert.throws(() => lib.newArgs({ session: "train1", gpu: "T4", tpu: "v5e1" }), /not both/);
  assert.deepEqual(lib.execArgs({ session: "train1", timeoutSec: 90, env: { HF_TOKEN: "x" } }), ["--auth", "oauth2", "exec", "-s", "train1", "--timeout", "90", "--env", "HF_TOKEN=x"]);
  assert.throws(() => lib.execArgs({ env: { "bad-name": "x" } }), /Invalid environment variable/);
  assert.deepEqual(lib.runScriptArgs({ script: "/tmp/train.py", scriptArgs: ["--epochs", "1"], gpu: "L4", keep: true }), ["--auth", "oauth2", "run", "--gpu", "L4", "--keep", "--timeout", "120", "/tmp/train.py", "--epochs", "1"]);
});

test("redaction removes tokens and masks account identities before output or logs", () => {
  const source = "Authorization: Bearer ya29.a0AX07CmtzRy9C7uT3wC343q84AX3PHv5XSxRXQLu7SU2uG0KWvPCGs5ppj2odaqPVxJkw8pWamRC43uf6R contact test.user@example.com hf_abcdefghij-TESTONLY-0123456789 4/0AbCdEfGhIjKlMnOpQrStUvWxYz";
  const redacted = lib.redactSecrets(source);
  assert.doesNotMatch(redacted, /ya29|hf_|4\/0Ab/);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /t\*\*\*@example\.com/);
});

test("setup finds an existing CLI instead of trying to reinstall it", async () => {
  configure(false);
  const result = await call({ action: "setup", install: true });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.cli.bin, fake);
  assert.equal(result.details.cli.version, "0.7.4");
});

test("status reports the authenticated account, balance and sessions from the official CLI output", async () => {
  configure(true);
  const result = await call({ action: "status" });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.auth.authenticated, true);
  assert.match(result.details.auth.email, /s\*\*\*@example\.com/);
  assert.equal(result.details.usage.balance, 42.5);
  assert.equal(result.details.sessions.sessions.length, 0);
});

test("auth login completes the CLI prompt with the browser-captured code and never returns the code", async () => {
  configure(false);
  const result = await call({ action: "auth", auth_action: "login", wait_sec: 8 });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, "authenticated");
  assert.equal(result.details.auth.authenticated, true);
  const text = JSON.stringify(result.details);
  assert.doesNotMatch(text, /4\/fake-authorization-code/);
  assert.ok(fs.existsSync(path.join(state, "authed")));
});

test("exec accepts the script alias for a local file", async () => {
  configure(true);
  const script = path.join(tmp, "alias.py");
  fs.writeFileSync(script, "import sys\nprint('alias', sys.argv)\n");
  const result = await call({ action: "exec", session: "train1", script, args: ["--demo", "1"], wait_sec: 5 });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.state, "completed");
  assert.equal(result.details.exit_code, 0);
  assert.match(result.details.output, /__yunuspi_sys\.argv = \["alias\.py","--demo","1"\]/);
});

test("a kernel exception is a failed exec even when the CLI exits zero", async () => {
  configure(true);
  const result = await call({ action: "exec", session: "train1", code: "TRACEBACK", wait_sec: 5 });
  assert.equal(result.isError, true);
  assert.equal(result.details.state, "completed");
  assert.match(result.details.hint, /uncaught exception/i);
});

test("redaction masks token and API-key assignments, not just bearer headers", () => {
  const redacted = lib.redactSecrets("HF_TOKEN=hf_abcdefghij-TESTONLY-0123456789 WANDB_API_KEY=very-secret-value COLAB_JUPYTER_TOKEN=jupyter-secret");
  assert.doesNotMatch(redacted, /hg_|hf_abcdefghij|very-secret|jupyter-secret/i);
  assert.match(redacted, /HF_TOKEN=<redacted>/);
  assert.match(redacted, /WANDB_API_KEY=<redacted>/);
  assert.match(redacted, /COLAB_JUPYTER_TOKEN=<redacted>/);
});

test("new allocates a named session and exec returns its output", async () => {
  configure(true);
  const created = await call({ action: "new", session: "train1", gpu: "T4" });
  assert.equal(created.isError, undefined);
  assert.equal(created.details.session, "train1");
  assert.deepEqual(created.details.other_sessions, []);
  assert.match(created.details.output, /Session READY/);
  const executed = await call({ action: "exec", session: "train1", code: "print(1)", wait_sec: 5 });
  assert.equal(executed.isError, undefined);
  assert.equal(executed.details.state, "completed");
  assert.match(executed.details.output, /EXEC:print\(1\)/);
});

test("a failing exec returns the remote output and a classified hint", async () => {
  configure(true);
  const result = await call({ action: "exec", session: "train1", code: "raise FAIL", wait_sec: 5 });
  assert.equal(result.isError, true);
  assert.equal(result.details.state, "failed");
  assert.match(result.details.output, /EXEC:raise FAIL/);
});

test("a long exec detaches after the foreground grace and can be polled and killed", async () => {
  configure(true);
  const started = await call({ action: "exec", session: "train1", code: "SLEEP", wait_sec: 2 });
  assert.equal(started.isError, undefined);
  assert.equal(started.details.state, "running");
  assert.ok(started.details.job_id);
  const listing = await call({ action: "jobs" });
  assert.ok(listing.details.jobs.some((job) => job.id === started.details.job_id));
  const output = await call({ action: "job_output", job_id: started.details.job_id });
  assert.equal(output.details.ok, true);
  const killed = await call({ action: "job_kill", job_id: started.details.job_id, force: true });
  assert.equal(killed.details.ok, true);
});

test("download refuses to overwrite a local file unless overwrite is explicit", async () => {
  configure(true);
  const local = path.join(tmp, "checkpoint.bin");
  fs.writeFileSync(local, "keep me");
  const result = await call({ action: "download", remote: "/content/checkpoint.bin", local });
  assert.equal(result.isError, true);
  assert.match(result.details.error, /already exists/);
  assert.equal(fs.readFileSync(local, "utf8"), "keep me");
});

test("doctor reports a healthy authenticated install without claiming remote GPU access", async () => {
  configure(true);
  // A headless host (SSH, CI, cloud VM) is healthy: sign-in falls back to a code or ADC.
  const display = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  let result;
  try { result = await call({ action: "doctor" }); }
  finally { for (const [key, value] of Object.entries(display)) if (value !== undefined) process.env[key] = value; }
  assert.equal(result.details.ok, true);
  assert.equal(result.details.healthy, true, JSON.stringify(result.details.checks.filter((check) => check.ok === false)));
  assert.equal(result.details.checks.find((check) => check.name === "display")?.ok, undefined);
  assert.ok(result.details.checks.some((check) => check.name === "auth" && check.ok === true));
  assert.ok(result.details.checks.some((check) => check.name === "compute_units" && check.ok === true));
  assert.ok(result.details.checks.some((check) => check.name === "uv"));
  assert.ok(result.details.checks.some((check) => check.name === "gcloud"));
  assert.ok(result.details.checks.some((check) => check.name === "adc"));
});
