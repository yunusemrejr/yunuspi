import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
 fs.existsSync(path.join(p, "extensions/lib/quality-review.ts")),
);
// Schema construction is not under test; the installed harness uses TypeBox.
// The release's dependency-free fixtures exercise actual lifecycle/IO owners.
const schema =
 "data:text/javascript," +
 encodeURIComponent(
  "export const Type=new Proxy({}, {get:(_t,name)=>(...args)=>({name,args})});",
 );
register(
 "data:text/javascript," +
  encodeURIComponent(
   `export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`,
  ),
 import.meta.url,
);
const {
 createQualityReviewLifecycle,
 reviewAspects,
 parseReviewReport,
 REVIEW_LIMITS,
 settleSharedQualityReview,
 validReviewEvidence,
} = await import(
 pathToFileURL(path.join(agent, "extensions/lib/quality-review.ts"))
);
const { projectTestFacts, isProjectReviewSource } = await import(
 pathToFileURL(path.join(agent, "scripts/workspace-facts.mjs"))
);
const storePath = path.join(
 agent,
 "extensions/lib/project-intelligence/store.mjs",
);
const openStore = fs.existsSync(storePath)
 ? (await import(pathToFileURL(storePath))).openStore
 : undefined;
const pass = (aspect) => ({
 aspect,
 ok: true,
 text: JSON.stringify({
  outcome: "pass",
  evidence: [
   "src/value.js:1 preserves zero and negative inputs; source and focused tests checked.",
  ],
  findings: [],
  gap: "",
 }),
});
async function fixture(t, { runner, context, beforeRefresh } = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-check-"));
 const tools = {},
  sent = [],
  branch = [],
  calls = [],
  hooks = {};
 let idle = true,
  queued = false,
  tests = { need: null },
  rejectDelivery = false;
 const ctx = {
  cwd: dir,
  isIdle: () => idle,
  hasPendingMessages: () => queued,
  sessionManager: { getBranch: () => branch, getSessionId: () => dir },
 };
 const api = createQualityReviewLifecycle(
  {
   on: (event, hook) => (hooks[event] = hook),
   registerTool: (d) => (tools[d.name] = d),
   getActiveTools: () => ["quality_review", "project_tests", "subagent"],
   appendEntry: (customType, data) =>
    branch.push({ type: "custom", customType, data: structuredClone(data) }),
   sendMessage: (m, o) => {
    if (rejectDelivery) throw Error("queue unavailable");
    sent.push({ m, o });
   },
  },
  {
   refresh: async () => {
    await beforeRefresh?.();
    api.observe(await projectTestFacts(dir), false);
   },
   tests: () => tests,
   runner: async (...args) => {
    calls.push(args);
    return runner ? runner(...args) : args[0].aspects.map((a) => pass(a.id));
   },
   context:
    context ??
    (async () => ({
     graph: "Checkout-scoped source graph; evidence may be incomplete.",
     history: [],
    })),
  },
 );
 api.restore(ctx);
 await api.run(ctx);
 api.input({
  source: "interactive",
  text: "Implement the behavior and verify quality",
 });
 t.after(() => {
  api.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
 });
 return {
  api,
  ctx,
  calls,
  sent,
  branch,
  tools,
  dir,
  tests: (v) => (tests = v),
  idle: (v) => (idle = v),
  queued: (v) => (queued = v),
  rejectDelivery: (v) => (rejectDelivery = v),
  state: () => api.snapshot(),
  async mutate(
   file = "src/value.js",
   text = "export const value = 1;",
   isError = false,
  ) {
   if (!isError) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
   }
   api.observe(await projectTestFacts(dir), true);
   api.result({ toolName: "write", input: { path: file }, isError }, ctx);
  },
  tool: (params) =>
   tools.quality_review.execute("test", params, undefined, undefined, ctx),
  compact: () => hooks.session_compact?.({}, ctx),
  settle: () => api.settled({}, ctx),
 };
}

test("routing includes text, CSS/HTML, technical stack, security and delivery without turning every project into a web audit", () => {
 assert.deepEqual(
  reviewAspects(["README.md"]).map((a) => a.id),
  ["content"],
 );
 assert.ok(
  reviewAspects(["styles.css", "index.html"]).some((a) => a.id === "interface"),
 );
 assert.ok(reviewAspects(["a.wasm"]).some((a) => a.id === "runtime"));
 assert.ok(reviewAspects(["a.py"]).some((a) => a.id === "runtime"));
 assert.ok(reviewAspects(["a.php"]).some((a) => a.id === "runtime"));
 assert.equal(reviewAspects(["auth.ts", "a.py"])[0].id, "security");
 assert.ok(
  reviewAspects(["build.yml"], "Verify the production deployment").some(
   (a) => a.id === "delivery",
  ),
 );
 const aspects = reviewAspects(
  ["a.py", "README.md"],
  "",
  Array.from({ length: 20 }, () => ({ aspect: "content", outcome: "changes" })),
 );
 assert.equal(aspects[0].id, "content");
 assert.equal(REVIEW_LIMITS.rounds, 2);
});
test("malformed, empty and unsupported verdicts never pass; suggestions remain nonblocking", () => {
 for (const text of [
  "",
  "NO_USEFUL_FINDINGS",
  "Looks fine",
  "{}",
  JSON.stringify({ outcome: "pass", evidence: [], findings: [] }),
  JSON.stringify({
   outcome: "pass",
   evidence: ["source content reviewed"],
   findings: [
    {
     severity: "blocking",
     file: "a.js",
     detail: "A real failure boundary is broken here",
    },
   ],
  }),
 ])
  assert.equal(parseReviewReport(text, "correctness").outcome, "unknown");
 const v = {
  outcome: "pass",
  evidence: ["README.md:1 contains the clarified sentence."],
  findings: [
   {
    severity: "improvement",
    file: "README.md",
    detail: "Optional shortening would reduce repetition in this sentence.",
   },
  ],
  gap: "",
 };
 assert.equal(parseReviewReport(JSON.stringify(v), "content").outcome, "pass");
 v.findings[0].file = "../secret";
 assert.equal(
  parseReviewReport(JSON.stringify(v), "content").outcome,
  "unknown",
 );
});
test("automatic settled review runs once; parent assessment and current tests are required; edits invalidate acceptance", async (t) => {
 const f = await fixture(t);
 await f.settle();
 assert.equal(f.calls.length, 0);
 await f.mutate();
 await f.settle();
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 assert.equal(f.state().status, "awaiting_assessment");
 await f.settle();
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 assert.equal(
  f.calls[0][0].graph,
  "Checkout-scoped source graph; evidence may be incomplete.",
 );
 f.tests({ need: "failed" });
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "Reviewed current source and the relevant behavior.",
  }),
  /test evidence/,
 );
 f.tests({ need: null });
 await f.tool({
  action: "assess",
  disposition: "accepted",
  reason:
   "Reviewed current source and relevant test results; no blocking defects.",
 });
 assert.equal(f.state().status, "accepted");
 await f.mutate("src/value.js", "export const value=2;");
 assert.equal(f.state().status, "pending");
 await f.settle();
 // Step 19: same-request automatic re-review is budget-skipped.
 assert.equal(f.calls.length, 1);
 await f.tool({ action: "review" });
 assert.equal(f.calls.length, 2, "explicit review still runs");
 await f.mutate("src/value.js", "export const value=3;");
 await f.settle();
 assert.equal(f.calls.length, 2);
 assert.equal(f.state().status, "budget_exhausted");
 for (let i = 0; i < 5; i++) {
  f.api.input({ source: "extension", text: "continue" });
  await f.settle();
 }
 assert.ok(f.sent.length <= 3);
 await f.tool({
  action: "assess",
  disposition: "blocked",
  reason:
   "The bounded review budget is exhausted; report the remaining source review gap.",
 });
 assert.equal(f.state().status, "blocked");
});
test("unresolved project checks own automatic continuation until their scoped evidence is ready", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 for (const need of ["assessment", "missing", "running", "failed"]) {
  f.tests({ need });
  assert.equal(
   f.api.notice(),
   "",
   "do not compete with pending project-test guidance",
  );
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
 }
 assert.equal(
  f.state().rounds,
  0,
  "waiting for checks does not consume an independent review round",
 );
 f.tests({ need: null });
 assert.match(f.api.notice(), /quality_review/);
 assert.equal(
  f.api.notice(),
  "",
  "the same review instruction is not injected on every model call",
 );
 await f.compact();
 assert.match(f.api.notice(), /quality_review/);
 assert.equal(f.api.notice(), "", "compaction restores one notice");
 await f.settle();
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 assert.match(f.api.notice(), /assess/);
 assert.equal(f.api.notice(), "");
 await f.settle();
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 const explicit = await fixture(t);
 await explicit.mutate();
 explicit.tests({ need: "running" });
 await explicit.tool({ action: "review" });
 assert.equal(
  explicit.calls.length,
  1,
  "explicit early source review remains available",
 );
 await assert.rejects(
  explicit.tool({
   action: "assess",
   disposition: "accepted",
   reason: "The test process is still running and has no completed evidence.",
  }),
  /test evidence/,
 );
});

test("watchdog joins the same quality owner without duplicate rounds, prompts or stale session access", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 f.tests({ need: "running" });
 await settleSharedQualityReview(f.ctx);
 assert.equal(
  f.calls.length,
  0,
  "shared review respects the project-test owner",
 );
 f.tests({ need: null });
 await Promise.all([
  settleSharedQualityReview(f.ctx),
  f.settle(),
  settleSharedQualityReview(f.ctx),
 ]);
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 assert.equal(f.state().rounds, 1);
 const other = {
  ...f.ctx,
  sessionManager: {
   ...f.ctx.sessionManager,
   getSessionId: () => f.dir + "-next",
  },
 };
 f.api.restore(other);
 assert.equal(
  await settleSharedQualityReview(f.ctx),
  undefined,
  "restore releases the previous session owner",
 );
 assert.ok(await settleSharedQualityReview(other));
 f.api.shutdown();
 assert.equal(
  await settleSharedQualityReview(other),
  undefined,
  "shutdown releases shared state",
 );
});
test("docs and native writes beyond scan limits trigger reviews; read-only and failed writes do not", async (t) => {
 const f = await fixture(t);
 await f.mutate("README.md", "No write", true);
 await f.settle();
 assert.equal(f.calls.length, 0);
 await f.mutate("README.md", "Public documentation update");
 await f.settle();
 assert.equal(f.calls[0][0].aspects[0].id, "content");
 await f.mutate("a/b/c/d/e/f/g/theme.css", "body { color: black }");
 assert.ok(f.state().changed.includes("a/b/c/d/e/f/g/theme.css"));
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "No independent source evidence for the latest changes yet.",
  }),
  /Current independent/,
 );
});
test("deployment workflow edits are reviewed while credentials and hidden runtime state remain excluded", async (t) => {
 const f = await fixture(t);
 await f.mutate(".github/workflows/deploy.yml", "name: Deploy");
 await f.settle();
 assert.ok(f.calls[0][0].aspects.some((a) => a.id === "delivery"));
 const before = f.state().revision;
 await f.mutate(".env", "TEST_PRIVATE_PLACEHOLDER");
 await f.mutate("auth.json", "{}");
 assert.equal(f.state().revision, before);
 const facts = await projectTestFacts(f.dir);
 assert.ok(facts.reviewSources[".github/workflows/deploy.yml"]);
 assert.equal(facts.reviewSources[".env"], undefined);
});
test("credential configuration is excluded across formats, native receipts, scans and restored scopes", async (t) => {
 const f = await fixture(t);
 const files = [
  "secrets.yaml",
  "credentials.yml",
  "config/secrets.json",
  "auth.toml",
  "config/settings.xml",
  "models.yaml",
  "production.credentials.json",
  "api-key.txt",
  "config/private_key.toml",
  "config/tokens.yml",
  "credentials/identity.json",
  ".env",
  "nested/secrets/test.json",
 ];
 for (const file of files) {
  assert.equal(isProjectReviewSource(file), false, file);
  assert.equal(isProjectReviewSource(file.replaceAll("/", "\\")), false, file);
  await f.mutate(file, "TEST_PRIVATE_PLACEHOLDER");
 }
 await f.settle();
 assert.equal(f.calls.length, 0);
 assert.equal(f.state().changed.length, 0);
 const facts = await projectTestFacts(f.dir);
 for (const file of files)
  assert.equal(facts.reviewSources[file], undefined, file);
 f.branch.push({
  type: "custom",
  customType: "quality-review-v1",
  data: { root: f.dir, revision: 0, changed: files },
 });
 f.api.restore(f.ctx);
 assert.equal(f.state().changed.length, 0);
 for (const file of [
  "src/auth.ts",
  "src/settings.py",
  "src/models.rs",
  "config/public.yaml",
 ])
  assert.equal(isProjectReviewSource(file), true, file);
});
test("extensionless delivery files participate in both source discovery and native review dispatch", async (t) => {
 const f = await fixture(t);
 const files = [
  "Dockerfile",
  "containers/Dockerfile.production",
  "Containerfile",
  "release.Containerfile",
  "Makefile",
  "GNUmakefile",
  "Jenkinsfile",
  "Procfile",
  "Justfile",
 ];
 for (const file of files) {
  assert.equal(isProjectReviewSource(file), true, file);
  assert.ok(
   reviewAspects([file]).some((a) => a.id === "delivery"),
   file,
  );
  await f.mutate(file, "FROM example.invalid/base");
 }
 const facts = await projectTestFacts(f.dir);
 for (const file of files) assert.ok(facts.reviewSources[file], file);
 await f.settle();
 assert.equal(f.calls.length, 1);
 assert.deepEqual(new Set(f.calls[0][0].files), new Set(files));
 assert.ok(f.calls[0][0].aspects.some((a) => a.id === "delivery"));
});
test("real bounded discovery detects shell source edits and deletion without attributing unrelated idle changes", async (t) => {
 const f = await fixture(t);
 fs.writeFileSync(path.join(f.dir, "external.md"), "peer work");
 f.api.observe(await projectTestFacts(f.dir), false);
 assert.equal(f.state().changed.length, 0);
 fs.writeFileSync(path.join(f.dir, "external.md"), "shell mutation");
 f.api.observe(await projectTestFacts(f.dir), true);
 await f.settle();
 assert.equal(f.calls.length, 1);
 fs.unlinkSync(path.join(f.dir, "external.md"));
 await f.tool({ action: "inspect" });
 assert.equal(f.state().status, "pending");
});
test("metadata-only rewrites and duplicate receipts do not charge review revisions", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 const afterEdit = f.state().revision;
 assert.equal(f.state().changed.length, 1);
 const file = path.join(f.dir, "src/value.js");
 // Same bytes, newer mtime/ctime: a build or touch must not invalidate the review.
 fs.utimesSync(file, new Date(Date.now() + 3000), new Date(Date.now() + 3000));
 f.api.observe(await projectTestFacts(f.dir), true);
 assert.equal(
  f.state().revision,
  afterEdit,
  "metadata-only change must not charge a revision",
 );
 // A real content change still invalidates exactly once, and the receipt for
 // that same content cannot charge the revision a second time.
 fs.writeFileSync(file, "export const value = 2;");
 f.api.observe(await projectTestFacts(f.dir), true);
 assert.equal(f.state().revision, afterEdit + 1);
 f.api.result(
  { toolName: "write", input: { path: "src/value.js" }, isError: false },
  f.ctx,
 );
 assert.equal(
  f.state().revision,
  afterEdit + 1,
  "duplicate receipt for accounted content",
 );
 assert.equal(f.state().changed.length, 1);
});

test("missing reviewers, invalid responses and omitted aspects are explicit gaps; no repeated retry or false pass", async (t) => {
 const f = await fixture(t, { runner: async () => [] });
 await f.mutate();
 await f.settle();
 assert.equal(f.state().reports[0].outcome, "unknown");
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "This should never accept a missing reviewer response.",
  }),
  /missing evidence/,
 );
 await f.settle();
 await f.tool({ action: "review" });
 assert.equal(f.calls.length, 1);
 await f.tool({
  action: "assess",
  disposition: "blocked",
  reason:
   "No permitted reviewer is available; disclose the independent review gap.",
 });
 assert.equal(f.state().status, "blocked");
});
test("unavailable reviewers settle once with an actionable gap and no automatic acknowledgement turn", async (t) => {
 const gap =
  "No healthy permitted reviewer has the required tool/context/output capacity within the economy policy.";
 const f = await fixture(t, {
  runner: async (req) =>
   req.aspects.map((a) => ({ aspect: a.id, ok: false, text: "", gap })),
 });
 await f.mutate();
 await f.settle();
 assert.equal(f.state().status, "blocked");
 assert.equal(f.state().reports[0].gap, gap);
 assert.equal(f.sent.length, 1);
 assert.equal(f.sent[0].m.customType, "quality-review-status");
 assert.equal(f.sent[0].o.triggerTurn, false);
 assert.equal(f.api.notice(), "");
 for (let i = 0; i < 4; i++) {
  await f.settle();
  await f.tool({ action: "review" });
 }
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "Review capacity failure must never become a quality pass.",
  }),
  /missing evidence/,
 );
});
test("concurrent settled hooks deliver one blocked status receipt", async (t) => {
 const f = await fixture(t, { runner: async () => [] });
 await f.mutate();
 await Promise.all([f.settle(), f.settle()]);
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent.length, 1);
 assert.equal(f.sent[0].m.customType, "quality-review-status");
 assert.equal(f.sent[0].o.triggerTurn, false);
});
test("blocking findings require an explicit evidence-based dismissal or a repair and new review", async (t) => {
 const f = await fixture(t, {
  runner: async (req) =>
   req.aspects.map((a) => ({
    aspect: a.id,
    ok: true,
    text: JSON.stringify({
     outcome: "changes",
     evidence: ["src/value.js:1 returns a wrong result for negative inputs."],
     findings: [
      {
       severity: "blocking",
       file: "src/value.js",
       detail:
        "A negative input becomes positive, violating the documented result contract.",
      },
     ],
     gap: "",
    }),
   })),
 });
 await f.mutate();
 await f.settle();
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "All findings were considered and this looks good enough.",
  }),
  /correctness-1/,
 );
 await f.tool({
  action: "assess",
  disposition: "accepted",
  reason:
   "The independent finding conflicts with the documented absolute-value contract.",
  dismissals: [
   {
    id: "correctness-1",
    reason:
     "The function contract explicitly returns an absolute value; the negative-input test confirms that behavior.",
   },
  ],
 });
 assert.equal(f.state().status, "accepted");
});
test("late reviewer completion after edits cannot approve newer content", async (t) => {
 let finish;
 const f = await fixture(t, {
  runner: (req) =>
   new Promise(
    (resolve) => (finish = () => resolve(req.aspects.map((a) => pass(a.id)))),
   ),
 });
 await f.mutate();
 const pending = f.settle();
 while (!finish) await new Promise((r) => setImmediate(r));
 await f.mutate("src/value.js", "export const value=9;");
 finish();
 await pending;
 assert.notEqual(f.state().status, "accepted");
 assert.equal(f.state().reports.length, 0);
});
test("a peer deadline preserves completed aspect evidence but rejects late results", async (t) => {
 const original = REVIEW_LIMITS.deadlineMs;
 REVIEW_LIMITS.deadlineMs = 40;
 t.after(() => {
  REVIEW_LIMITS.deadlineMs = original;
 });
 let late;
 const f = await fixture(t, {
  runner: async (req) => {
   req.onResult?.(pass("correctness"));
   late = new Promise((resolve) =>
    setTimeout(() => {
     req.onResult?.(pass("content"));
     resolve();
    }, 100),
   );
   await late;
   return req.aspects.map((a) => pass(a.id));
  },
 });
 await f.mutate();
 await f.mutate("README.md", "Explain the current behavior.");
 await f.settle();
 assert.equal(
  f.state().reports.find((r) => r.aspect === "correctness").outcome,
  "pass",
 );
 assert.equal(
  f.state().reports.find((r) => r.aspect === "content").outcome,
  "unknown",
 );
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "A partial review cannot establish all required aspect evidence.",
  }),
  /missing evidence/,
 );
 const snapshot = JSON.stringify(f.state());
 await late;
 assert.equal(JSON.stringify(f.state()), snapshot);
});
test("slow review streams aspect progress to the tool UI without adding model messages", async (t) => {
 let finish;
 const f = await fixture(t, {runner: req => new Promise(resolve => {
  req.onResult(pass('correctness'));
  finish = () => { req.onResult({aspect:'content',ok:false,gap:'The configured reviewer is unavailable.'}); resolve([]); };
 })});
 await f.mutate(); await f.mutate('README.md', 'Document the behavior.');
 const updates = [];
 const pending = f.tools.quality_review.execute('progress', {action:'review'}, undefined, value => updates.push(structuredClone(value)), f.ctx);
 while (!finish) await new Promise(resolve => setImmediate(resolve));
 assert.ok(updates.some(update => update.details.reviewProgress.aspects.correctness === 'received'));
 assert.ok(updates.some(update => update.details.reviewProgress.aspects.content === 'pending'));
 assert.ok(updates.every(update => update.details.reviewProgress.deadlineMs === REVIEW_LIMITS.deadlineMs));
 assert.equal(f.sent.length, 0, 'progress must not trigger model work');
 finish(); await pending;
 assert.equal(updates.at(-1).details.reviewProgress.aspects.content, 'unavailable');
 assert.equal(f.sent.length, 0);
 const count = updates.length;
 await f.tool({action:'inspect'});
 assert.equal(updates.length, count, 'finished review releases its tool observer');
});
test("repair review carries earlier blockers and hashes only actual changed source", async (t) => {
 const f = await fixture(t, {runner: req => req.aspects.map(aspect => aspect.id === 'correctness' ? {...pass(aspect.id),text:JSON.stringify({outcome:'changes',evidence:['src/value.js:1 input reaches the unchecked computation.'],findings:[{severity:'blocking',file:'src/value.js',detail:'A negative input reaches an unchecked allocation and throws.'},{severity:'improvement',file:'src/value.js',detail:'Optional naming cleanup would make this easier to read.'}],gap:''})} : pass(aspect.id))});
 await f.mutate(); await f.mutate('README.md', 'Document the behavior.');
 await f.tool({action:'review'});
 assert.equal(f.calls[0][0].previousReview, undefined);
 await f.mutate('src/value.js', 'export const value = 2;');
 await f.tool({action:'review'});
 const previous = f.calls[1][0].previousReview;
 assert.equal(previous.revision < f.state().revision, true);
 assert.deepEqual(previous.changedFiles, ['src/value.js']);
 assert.equal(previous.reports.find(report => report.aspect === 'correctness').findings.length, 1, 'optional polish does not become a repair task');
 assert.match(f.state().nextAction, /rounds are exhausted.*Assess/);
 assert.match(f.state().nextAction, /Do not add optional polish/);
});
test("Stop cancels a noncooperative runner; late output and extension messages cannot resume it", async (t) => {
 let started, finish;
 const f = await fixture(t, {
  runner: (req) => {
   started = true;
   return new Promise(
    (resolve) => (finish = () => resolve(req.aspects.map((a) => pass(a.id)))),
   );
  },
 });
 await f.mutate();
 const pending = f.settle();
 while (!started) await new Promise((r) => setImmediate(r));
 f.api.message({ message: { role: "assistant", stopReason: "aborted" } });
 await pending;
 finish();
 f.api.message({ message: { role: "assistant", stopReason: "stop" } });
 f.api.input({ source: "extension", text: "resume" });
 await f.settle();
 assert.equal(f.sent.length, 0);
 assert.equal(f.state().reports.length, 0);
});
test("queued messages, failed delivery, reload and new user scopes retain bounded continuation semantics", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 f.queued(true);
 await f.settle();
 assert.equal(f.calls.length, 0);
 f.queued(false);
 f.rejectDelivery(true);
 await f.settle();
 assert.equal(f.sent.length, 0);
 f.rejectDelivery(false);
 await f.settle();
 assert.equal(f.sent.length, 1);
 f.api.restore(f.ctx);
 await f.settle();
 assert.equal(f.sent.length, 1);
 // Verified restore replays the still-valid pass evidence for assessment
 // instead of invalidating it and re-spending a review round; no automatic
 // re-review runs for the identical tree (explicit input below still does).
 assert.equal(f.state().reports.length, 1);
 f.api.input({ source: "interactive", text: "Continue reviewing this change" });
 await f.settle();
 assert.equal(f.calls.length, 2);
});
test("new user input can retry unavailable capacity or a blocked review without an artificial edit", async (t) => {
 let capacity = false;
 const f = await fixture(t, {
  runner: async (req) => (capacity ? req.aspects.map((a) => pass(a.id)) : []),
 });
 await f.mutate();
 await f.settle();
 assert.equal(f.state().reports[0].outcome, "unknown");
 capacity = true;
 f.api.input({ source: "interactive", text: "Retry the quality review" });
 await f.settle();
 assert.equal(f.calls.length, 2);
 assert.equal(f.state().reports[0].outcome, "pass");
 await f.tool({
  action: "assess",
  disposition: "blocked",
  reason: "An environment check remains unavailable; report this limitation.",
 });
 f.api.input({ source: "interactive", text: "Continue reviewing the changes" });
 await f.settle();
 assert.equal(f.calls.length, 3);
});
test("file-count overflow remains explicit and cannot certify an omitted part of the change", async (t) => {
 const f = await fixture(t);
 for (let i = 0; i < 140; i++) {
  const file = "file-" + i + ".md";
  fs.writeFileSync(path.join(f.dir, file), "Scoped content");
  f.api.result(
   { toolName: "write", input: { path: file }, isError: false },
   f.ctx,
  );
 }
 await f.settle();
 assert.equal(f.state().changed.length, 128);
 assert.equal(f.state().truncated, true);
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "The reviewer returned passes for the bounded subset of files.",
  }),
  /incomplete/,
 );
 f.api.restore(f.ctx);
 assert.equal(f.state().truncated, true);
});
test("history is checkout-scoped, excludes the current session, is bounded and preserves earlier discovered defects", {
 skip: !openStore,
}, (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-history-")),
  db = openStore(path.join(dir, "project.sqlite"));
 t.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
 });
 if (typeof db.reviewHistory !== "function") {
  t.skip(
   "Project intelligence is installed without the optional quality-history adapter.",
  );
  return;
 }
 db.reviewHistory("checkout-a", "session-a", [
  { aspect: "content", outcome: "changes", secret: "TEST_MUST_NOT_PERSIST" },
 ]);
 db.reviewHistory("checkout-a", "session-a", [
  { aspect: "content", outcome: "pass" },
 ]);
 assert.equal(db.reviewHistory("checkout-a", "session-a").length, 0);
 const records = db.reviewHistory("checkout-a", "session-b");
 assert.equal(records[0].outcome, "pass");
 assert.equal(records[0].hadChanges, true);
 assert.doesNotMatch(JSON.stringify(records), /secret|session-a/);
 assert.deepEqual(db.reviewHistory("checkout-b", "session-b"), []);
 for (let i = 0; i < 90; i++)
  db.reviewHistory("checkout-a", "peer-" + i, [
   { aspect: "content", outcome: "unknown" },
  ]);
 assert.equal(db.reviewHistory("checkout-a", "last").length, 20);
 assert.throws(
  () =>
   db.reviewHistory("checkout-a", "session-a", [
    { aspect: "secret text", outcome: "pass" },
   ]),
  /Invalid review/,
 );
});

test("exhausted rounds retain earlier reports as stale evidence without approving changed source", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 await f.settle();
 assert.equal(f.calls.length, 1, "first automatic round admitted");
 await f.mutate("src/value.js", "export const value=2;");
 await f.settle();
 // Step 19 (1/request automation budget): the same-request automatic
 // re-review is skipped — no runner call, round not spent, earlier
 // report retained. Explicit review below is never gated.
 assert.equal(f.calls.length, 1, "second automatic round skipped by budget");
 assert.equal(f.state().rounds, 1, "refused round spends nothing");
 await f.tool({ action: "review" });
 assert.equal(f.calls.length, 2, "explicit review always runs");
 const previous = f.state();
 assert.equal(previous.reports.length, 1);
 await f.mutate("src/value.js", "export const value=3;");
 const result = await f.tool({ action: "review" });
 assert.equal(f.calls.length, 2);
 assert.equal(result.details.status, "budget_exhausted");
 assert.equal(result.details.reports.length, 0);
 assert.deepEqual(result.details.previousReview, {
  revision: previous.revision,
  reports: previous.reports,
 });
 assert.match(result.details.reason, /changed.*not reviewed/i);
 await f.settle();
 assert.ok(
  !f.sent.at(-1).m.content.includes('"previousReview"'),
  "automatic continuations do not replay stale report bodies",
 );
 await assert.rejects(
  f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "An older report cannot verify the latest changed source.",
  }),
  /Current independent/,
 );
 f.api.restore(f.ctx);
 const restored = await f.tool({ action: "inspect" });
 assert.deepEqual(restored.details.previousReview, {
  revision: previous.revision,
  reports: previous.reports,
 });
 assert.equal(restored.details.reports.length, 0);
});

test("restored malformed reports are not exposed as retained evidence", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 f.branch.push({
  type: "custom",
  customType: "quality-review-v1",
  data: {
   root: f.dir,
   revision: 2,
   reviewed: 2,
   changed: ["src/value.js"],
   rounds: 2,
   reports: [
    { aspect: "correctness", outcome: "pass", evidence: [], findings: [] },
   ],
  },
 });
 f.api.restore(f.ctx);
 assert.equal(f.state().previousReview, undefined);
});

test("an unavailable-review receipt retries failed delivery without another review or model turn", async (t) => {
 const f = await fixture(t, { runner: async () => [] });
 await f.mutate();
 f.rejectDelivery(true);
 await f.settle();
 assert.equal(f.state().status, "blocked");
 assert.equal(f.sent.length, 0);
 assert.equal(f.calls.length, 1);
 f.rejectDelivery(false);
 await f.settle();
 assert.equal(f.sent.length, 1);
 assert.equal(f.calls.length, 1);
 assert.equal(f.sent[0].m.customType, "quality-review-status");
 assert.equal(f.sent[0].o.triggerTurn, false);
 await f.settle();
 assert.equal(f.sent.length, 1);
});

test("idle edits outside the observed task scope do not reopen an accepted review", async (t) => {
 const f = await fixture(t);
 await f.mutate();
 await f.settle();
 await f.tool({
  action: "assess",
  disposition: "accepted",
  reason: "The current source and checks establish the scoped behavior.",
 });
 const revision = f.state().revision;
 fs.writeFileSync(
  path.join(f.dir, "peer.md"),
  "Unrelated work from another session",
 );
 await f.tool({ action: "inspect" });
 assert.equal(f.state().revision, revision);
 assert.equal(f.state().status, "accepted");
 assert.ok(!f.state().changed.includes("peer.md"));
 fs.writeFileSync(path.join(f.dir, "src/value.js"), "export const value=9;");
 await f.tool({ action: "inspect" });
 assert.equal(
  f.state().status,
  "pending",
  "changes to reviewed files still invalidate acceptance",
 );
});

test("a review invalidated in flight retains its output as incomplete evidence instead of disappearing", async (t) => {
 let finish;
 const f = await fixture(t, {
  runner: (req) =>
   new Promise(
    (resolve) => (finish = () => resolve(req.aspects.map((a) => pass(a.id)))),
   ),
 });
 await f.mutate();
 const revision = f.state().revision;
 const pending = f.api.run(f.ctx);
 while (!finish) await new Promise((resolve) => setImmediate(resolve));
 await f.mutate("src/value.js", "export const value=9;");
 finish();
 await pending;
 const result = await f.tool({ action: "inspect" });
 assert.equal(result.details.reports.length, 0);
 assert.equal(result.details.previousReview.revision, revision);
 assert.equal(result.details.previousReview.reports[0].outcome, "unknown");
 assert.match(result.details.previousReview.reports[0].gap, /changed during/i);
 assert.equal(result.details.previousReview.reports[0].evidence.length, 1);
 assert.equal(
  result.details.rounds,
  1,
  "executed reviews still consume their bounded budget",
 );
});

test("assessment waits for an in-flight source scan before accepting evidence", async (t) => {
 let release,
  scanning = false;
 const f = await fixture(t, {
  beforeRefresh: () =>
   scanning ? new Promise((r) => (release = r)) : undefined,
 });
 await f.mutate();
 await f.tool({ action: "review" });
 scanning = true;
 const inspecting = f.tool({ action: "inspect" });
 while (!release) await new Promise((r) => setImmediate(r));
 fs.writeFileSync(path.join(f.dir, "src/value.js"), "export const value=999;");
 const assessment = f.tool({
  action: "assess",
  disposition: "accepted",
  reason: "Previously reviewed source and its focused tests passed.",
 });
 const rejected = assert.rejects(assessment, /Current independent/);
 scanning = false;
 release();
 await inspecting;
 await rejected;
 assert.notEqual(f.state().status, "accepted");
});

test("a tool waiting for discovery cannot assess a replacement user turn", async (t) => {
 let release,
  scanning = false;
 const f = await fixture(t, {
  beforeRefresh: () =>
   scanning ? new Promise((r) => (release = r)) : undefined,
 });
 await f.mutate();
 scanning = true;
 const assessment = f.tool({
  action: "assess",
  disposition: "blocked",
  reason: "Old turn has no independent evidence available.",
 });
 while (!release) await new Promise((r) => setImmediate(r));
 f.api.input({ source: "interactive", text: "Fix a different issue" });
 const rejected = assert.rejects(assessment, /cancelled/i);
 scanning = false;
 release();
 await rejected;
 assert.notEqual(f.state().status, "blocked");
});

test("review evidence paths validate like findings: relative, bounded, no traversal", () => {
 assert.deepEqual(validReviewEvidence(["shots/a.png", "logs/out.log"]), ["shots/a.png", "logs/out.log"]);
 assert.deepEqual(validReviewEvidence(["/abs/x.png", "../evil", "", "ok.log", "ok.log", 42, "x".repeat(300)]), ["ok.log"]);
 assert.deepEqual(validReviewEvidence("nope"), []);
 assert.deepEqual(validReviewEvidence(undefined), []);
 assert.equal(validReviewEvidence(Array.from({ length: 12 }, (_, i) => `f${i}.log`)).length, 8);
});

test("review evidence reaches the runner brief", async (t) => {
 let seen;
 const f = await fixture(t, {
  runner: async (req) => {
   seen = req.evidence;
   return req.aspects.map((a) => pass(a.id));
  },
 });
 await f.mutate();
 fs.mkdirSync(path.join(f.dir, "shots"), { recursive: true });
 fs.writeFileSync(path.join(f.dir, "shots/a.png"), "reviewed screenshot bytes");
 await f.tool({ action: "review", evidence: ["shots/a.png", "/abs/x", "../evil"] });
 assert.deepEqual(seen, ["shots/a.png"]);
});

test("rounds with no dispatched reviewer are refunded, not charged", async (t) => {
 const f = await fixture(t, {
  runner: async (req) =>
   req.aspects.map((a) => ({ aspect: a.id, ok: false, text: "", gap: "No healthy permitted reviewer.", unattempted: true })),
 });
 await f.mutate();
 await f.tool({ action: "review" });
 await f.tool({ action: "review" });
 assert.equal(f.state().rounds, 0);
 assert.equal(f.state().refunded, 1);
 assert.equal(f.state().status, "unavailable");
 assert.match(f.state().reason, /No healthy permitted reviewer/);
 assert.equal(f.state().reports[0].outcome, "unknown");
 await f.settle(); await f.settle();
 assert.equal(f.calls.length, 1, "unchanged capacity and settled hooks do not retry");
 assert.ok(f.sent.every(s => s.o.triggerTurn === false), "no model wakeup to acknowledge a dispatch gap");
});

test("disposition changes emit review.disposition telemetry", async (t) => {
 const events = [];
 const key = Symbol.for("yunus-pi.health.v1");
 const prev = globalThis[key];
 globalThis[key] = (kind, data) => events.push({ kind, data });
 try {
  const blocked = await fixture(t, { runner: async () => [] });
  await blocked.mutate();
  await blocked.tool({ action: "review" });
  assert.ok(events.some((e) => e.kind === "review.disposition" && e.data.decision === "blocked"));
  const f = await fixture(t);
  await f.mutate();
  await f.tool({ action: "review" });
  await f.tool({
   action: "assess",
   disposition: "accepted",
   reason: "Reviewed current source and relevant test results; no blocking defects.",
  });
  assert.ok(events.some((e) => e.kind === "review.disposition" && e.data.decision === "accepted"));
 } finally {
  if (prev === undefined) delete globalThis[key];
  else globalThis[key] = prev;
 }
});


test('extra reviewer citations retain concrete findings instead of erasing the report', () => {
 const finding = {severity:'blocking',file:'src/window.cpp',detail:'The resize error path retains an old buffer and writes beyond its allocation.'};
 const report = parseReviewReport(JSON.stringify({outcome:'changes',evidence:Array.from({length:9},(_,i)=>`src/window.cpp:${i+1} inspected buffer ownership and the displayed frame path`),findings:[finding],gap:''}), 'correctness');
 assert.equal(report.outcome,'changes'); assert.equal(report.evidence.length,6);
 assert.equal(report.findings[0].detail,finding.detail); assert.equal(report.gap,'');
 const invalid = parseReviewReport(JSON.stringify({outcome:'changes',evidence:report.evidence,findings:[finding,{...finding,file:'../private'}],gap:''}), 'correctness');
 assert.equal(invalid.outcome,'unknown'); assert.equal(invalid.findings.length,1);
 assert.match(invalid.gap,/invalid finding/); assert.ok(!JSON.stringify(invalid).includes('../private'));
 const unavailable = parseReviewReport(JSON.stringify({outcome:'unknown',evidence:[],findings:[],gap:'The display capture could not be read.'}),'interface');
 assert.equal(unavailable.gap,'The display capture could not be read.');
});

test('native games receive interface review before documentation and require actual displayed behavior', () => {
 const aspects=reviewAspects(['src/window.cpp','src/main.cpp','README.md','Makefile'],'Create a pixel art space game on Ubuntu');
 assert.equal(aspects[1].id,'interface');
 assert.match(aspects[1].rubric,/native desktop\/game windows/);
 assert.match(aspects[1].rubric,/Offscreen renders.*do not prove/);
 assert.match(aspects[1].rubric,/independent probe/);
 assert.ok(!reviewAspects(['src/server.cpp'],'Fix server buffer ownership').some(a=>a.id==='interface'));
});

test('an explicit retry can recover refunded capacity while later edits do not auto-retry it', async t => {
 let available=false;
 const f=await fixture(t,{runner:async req=>req.aspects.map(a=>available?pass(a.id):{aspect:a.id,ok:false,text:'',gap:'No permitted reviewer has capacity.',unattempted:true})});
 await f.mutate(); await f.tool({action:'review'});
 await f.mutate('src/value.js','export const value=2;'); await f.settle();
 assert.equal(f.calls.length,1); assert.equal(f.state().status,'unavailable');
 available=true; await f.tool({action:'review',retryReason:'A reviewer slot is now available after the prior job completed.'});
 assert.equal(f.calls.length,2); assert.equal(f.state().rounds,1);
 assert.equal(f.state().reports[0].outcome,'pass'); assert.equal(f.state().status,'awaiting_assessment');
});

test('malformed report fields preserve valid blockers as unknown and normalization is stable', () => {
 const finding = {severity:'blocking',file:'src/window.cpp',detail:'The resize handler writes through the previous allocation after replacing its dimensions.'};
 const raw = {outcome:'failure', evidence:{path:'src/window.cpp'}, findings:[{...finding,file:'../private'},finding], gap:''};
 const report = parseReviewReport(JSON.stringify(raw),'runtime');
 assert.equal(report.outcome,'unknown');
 assert.equal(report.findings.length,1);
 assert.equal(report.findings[0].detail,finding.detail);
 assert.match(report.gap,/invalid outcome/);
 assert.deepEqual(parseReviewReport(JSON.stringify(report),'runtime'),report);
 const long = parseReviewReport(JSON.stringify({outcome:'changes',evidence:['src/window.cpp:42 retains a stale allocation.'],findings:[{...finding,detail:finding.detail.repeat(15)}],gap:''}),'runtime');
 assert.equal(long.outcome,'unknown');
 assert.equal(long.findings.length,1);
 assert.equal(long.findings[0].detail.length,900);
 assert.match(long.gap,/detail truncated/);
 const overflow = parseReviewReport(JSON.stringify({outcome:'changes',evidence:['src/window.cpp:42 retains a stale allocation.'],findings:Array.from({length:7},(_,i)=>({...finding,severity:i===6?'blocking':'improvement'})),gap:''}),'runtime');
 assert.equal(overflow.findings[0].severity,'blocking');
 assert.deepEqual(parseReviewReport(JSON.stringify(overflow),'runtime'),overflow);
});

test('review paths share project-relative validation across findings and evidence', () => {
 const invalid = [' C:\\private\\shot.png ', 'C:private.png', '\\\\host\\share\\shot.png', ' /tmp/shot.png ', '..\\shot.png', 'shots/../shot.png', 'shots/evil\npath.png'];
 assert.deepEqual(validReviewEvidence([...invalid,' shots/live.png ']),['shots/live.png']);
 for (const file of invalid) {
  const report=parseReviewReport(JSON.stringify({outcome:'changes',evidence:['src/window.cpp:42 retains a stale allocation.'],findings:[{severity:'blocking',file,detail:'The displayed frame does not reflect the current state.'}],gap:''}),'interface');
  assert.equal(report.outcome,'unknown'); assert.equal(report.findings.length,0);
 }
});

test('new outcome evidence reopens an incomplete same-revision review without a source edit', async t => {
 let ready=false;
 const f=await fixture(t,{runner:async req=>req.aspects.map(a=>ready?pass(a.id):{aspect:a.id,ok:true,text:JSON.stringify({outcome:'unknown',evidence:['src/value.js:1 implements the requested behavior.'],findings:[],gap:'The normal runtime output has not been observed.'})})});
 await f.mutate();
 fs.writeFileSync(path.join(f.dir,'runtime.log'),'initial runtime observation');
 const revision=f.state().revision;
 await f.tool({action:'review',evidence:['runtime.log']});
 await f.tool({action:'assess',disposition:'blocked',reason:'The runtime output is missing and must be observed before acceptance.'});
 await f.tool({action:'review',evidence:['runtime.log']});
 await f.settle();
 assert.equal(f.calls.length,1,'identical missing evidence and settled hooks cannot spend the second round');
 fs.writeFileSync(path.join(f.dir,'runtime.log'),'normal entrypoint exercised and output captured');
 ready=true;
 await f.tool({action:'review',evidence:['runtime.log']});
 assert.equal(f.calls.length,2);
 assert.equal(f.state().revision,revision,'gathering evidence must not require a fake source edit');
 assert.equal(f.state().rounds,2);
 assert.equal(f.state().reports[0].outcome,'pass');
 await f.tool({action:'assess',disposition:'accepted',reason:'Current source and the newly observed runtime output have been reviewed.'});
 assert.equal(f.state().status,'accepted');
});

test('changed evidence cannot exceed the two-round cap or reopen a complete review', async t => {
 const f=await fixture(t);
 await f.mutate(); await f.tool({action:'review'});
 fs.writeFileSync(path.join(f.dir,'runtime.log'),'additional observation');
 await f.tool({action:'review',evidence:['runtime.log']});
 assert.equal(f.calls.length,1);
 const g=await fixture(t,{runner:async req=>req.aspects.map(a=>({aspect:a.id,ok:true,text:JSON.stringify({outcome:'unknown',evidence:[],findings:[],gap:'The display capture remains unavailable for inspection.'})}))});
 await g.mutate(); await g.tool({action:'review'});
 fs.writeFileSync(path.join(g.dir,'runtime.log'),'first observation');
 await g.tool({action:'review',evidence:['runtime.log']});
 fs.writeFileSync(path.join(g.dir,'runtime.log'),'second observation');
 await g.tool({action:'review',evidence:['runtime.log']});
 assert.equal(g.calls.length,2);
 assert.equal(g.state().rounds,2);
 assert.equal(g.state().status,'awaiting_assessment');
 assert.equal(g.state().reports[0].outcome,'unknown');
});

test('bounded evidence normalization never turns whitespace into a source citation', () => {
 const raw={outcome:'pass',evidence:[' '.repeat(701)+'src/value.js:1 has the expected return value.'],findings:[],gap:''};
 const report=parseReviewReport(JSON.stringify(raw),'correctness');
 assert.equal(report.outcome,'pass');
 assert.equal(report.evidence[0],'src/value.js:1 has the expected return value.');
 assert.deepEqual(parseReviewReport(JSON.stringify(report),'correctness'),report);
 const spaced=parseReviewReport(JSON.stringify({outcome:'changes',evidence:['source'+' '.repeat(800)+'citation identifies the faulty state'],findings:[{severity:'blocking',file:'src/value.js',detail:'Bug:'+' '.repeat(950)+'the resize callback writes outside its allocation.'}],gap:''}),'correctness');
 assert.equal(spaced.outcome,'changes');assert.equal(spaced.findings.length,1);
 assert.deepEqual(parseReviewReport(JSON.stringify(spaced),'correctness'),spaced);
});

test('outcome artifacts changed during or after review cannot receive current acceptance', async t => {
 let release,held=true;
 const f=await fixture(t,{runner:async req=>{
  if(held)await new Promise(resolve=>{release=resolve;});
  return req.aspects.map(a=>pass(a.id));
 }});
 await f.mutate();
 const artifact=path.join(f.dir,'runtime.log');fs.writeFileSync(artifact,'old runtime observation');
 const review=f.tool({action:'review',evidence:['runtime.log']});
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 fs.writeFileSync(artifact,'new contradictory observation');release();await review;
 assert.equal(f.state().reports[0].outcome,'unknown');assert.match(f.state().reports[0].gap,/Outcome evidence changed/);
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'The source report appeared successful but its output artifact changed.'}),/missing evidence/);
 held=false;await f.tool({action:'review',evidence:['runtime.log']});
 assert.equal(f.calls.length,2);assert.equal(f.state().reports[0].outcome,'pass');
 await f.tool({action:'assess',disposition:'accepted',reason:'The second review observes the current source and outcome artifact.'});
 fs.writeFileSync(artifact,'another contradictory observation');
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'The previous pass must not certify an overwritten outcome artifact.'}),/missing evidence/);
 assert.equal(f.state().status,'awaiting_assessment');assert.equal(f.state().reports[0].outcome,'unknown');
 assert.equal(f.state().rounds,2,'freshness invalidation never replenishes the budget');
});

test("accepted assessment names the open aspects and gaps instead of failing blind", async (t) => {
 const gappy = (aspect) => ({
  aspect,
  ok: true,
  text: JSON.stringify({
   outcome: "pass",
   evidence: [
    "src/value.js:1 preserves zero and negative inputs; source checked.",
   ],
   findings: [],
   gap: "Prior content unavailable without a Git history; judged against current source only.",
  }),
 });
 const f = await fixture(t, {
  runner: async (req) => req.aspects.map((a) => gappy(a.id)),
 });
 await f.mutate();
 await f.tool({ action: "review" });
 const err = await f
  .tool({
   action: "assess",
   disposition: "accepted",
   reason: "Reviewed current source and the relevant behavior.",
  })
  .then(
   () => null,
   (e) => e,
  );
 assert.ok(err, "a pass with an open gap must not be accepted");
 assert.match(err.message, /Current independent reviews.*missing evidence/);
 assert.match(err.message, /Open: .*\(gap: Prior content unavailable/);
});

test('launch failure cannot be retried by changing evidence or source; a corrected cause explicitly reopens it', async t => {
 let available=false;
 const f=await fixture(t,{runner:async req=>req.aspects.map(a=>available?pass(a.id):{aspect:a.id,ok:false,gap:'Reviewer launch failed: runtime configuration was missing.'})});
 await f.mutate();fs.writeFileSync(path.join(f.dir,'screen.png'),'synthetic evidence fixture');
 await f.tool({action:'review',evidence:['screen.png']});
 fs.writeFileSync(path.join(f.dir,'screen.png'),'new fixture evidence');
 await f.tool({action:'review',evidence:['screen.png']});
 await f.tool({action:'review'});
 await f.mutate('src/value.js','export const value=2;');await f.settle();
 assert.equal(f.calls.length,1,'neither screenshots nor source repairs fix the reviewer environment');
 assert.equal(f.state().rounds,1);assert.match(f.state().nextAction,/retryReason/);
 assert.ok(f.sent.every(s=>s.o.triggerTurn===false));
 assert.ok(f.state().aspects.every(a=>!Object.hasOwn(a,'rubric')),'parent receipts omit repeated reviewer-only rubrics');
 available=true;
 await f.tool({action:'review',retryReason:'Corrected the missing reviewer runtime configuration and verified the launch.'});
 assert.equal(f.calls.length,2);assert.equal(f.state().reports[0].outcome,'pass');
 await f.tool({action:'assess',disposition:'accepted',reason:'The repaired reviewer inspected the current source and found no blockers.'});
 assert.equal(f.state().status,'accepted');
});

test('source changes during failed review do not erase the infrastructure retry gate', async t => {
 for (const unattempted of [false, true]) {
  let release, started;
  const waiting = new Promise(resolve => started = resolve);
  const f = await fixture(t, { runner: async request => {
   started(); await new Promise(resolve => release = resolve);
   return request.aspects.map(a => ({ aspect: a.id, ok: false, unattempted, gap: 'Reviewer unavailable because the configured runtime could not start.' }));
  } });
  await f.mutate();
  const running = f.tool({ action: 'review' });
  await waiting;
  await f.mutate('src/value.js', 'export const value = 2;');
  release(); await running;
  assert.equal(f.state().status, 'unavailable');
  assert.equal(f.state().rounds, unattempted ? 0 : 1);
  await f.settle();
  assert.equal(f.calls.length, 1, 'a source edit cannot repair unavailable reviewer infrastructure');
  assert.ok(f.sent.every(({ o }) => o.triggerTurn === false));
  await assert.rejects(f.tool({ action: 'assess', disposition: 'accepted', reason: 'This unsupported acceptance must remain rejected.' }), /Current independent reviews/);
  await f.tool({ action: 'assess', disposition: 'blocked', reason: 'Independent review remains unavailable until its runtime is repaired.' });
  assert.equal(f.state().status, 'blocked', 'source changes do not prevent truthful acknowledgement of unavailable infrastructure');
 }
});

test('review follow-up budget is reserved while a triggered model turn edits and settles', async t => {
 // Exercise the actual lifecycle with a sendMessage promise that, like the
 // core idle dispatcher, resolves only after the triggered work has finished.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-reentrant-')),sent=[],tools={};
 let api,edit=0;
 const ctx={cwd:dir,isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getBranch:()=>[]}};
 const mutate=async()=>{fs.writeFileSync(path.join(dir,'app.js'),`const value=${++edit};`);api.observe(await projectTestFacts(dir),true);};
 api=createQualityReviewLifecycle({on(){},registerTool:d=>tools[d.name]=d,getActiveTools:()=>['quality_review'],appendEntry(){},async sendMessage(message,options){
  sent.push({message,options});assert.ok(sent.length<=3);
  api.message({message:{role:'custom',customType:message.customType}});
  await mutate();await api.settled({},ctx);
 }},{refresh:async()=>api.observe(await projectTestFacts(dir),false),tests:()=>({need:null}),runner:async req=>req.aspects.map(a=>pass(a.id))});
 t.after(()=>{api.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 api.restore(ctx);await api.run(ctx);api.input({source:'interactive',text:'Implement the behavior'});await mutate();
 await api.settled({},ctx);assert.equal(sent.length,3);
 await api.settled({},ctx);assert.equal(sent.length,3,'edits do not replenish acknowledgement turns');
});
