import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/mini-preprocessor.ts")),
);
const mini = await import(pathToFileURL(path.join(agent, "extensions/lib/mini-preprocessor.ts")));
const { default: register } = await import(pathToFileURL(path.join(agent, "extensions/pi-observations.ts")));

const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
const curly = "Readers who want the broader picture will find the surrounding chapters useful — they describe the shared vocabulary in a relaxed, conversational “tour” of the workspace.";
const doc = [
  "# Workspace guide",
  "Deployment remains blocked until the release checklist is verified.",
  "## Background",
  filler,
  curly,
  "- first item describes the layout\n- second item describes the tools\n  with a wrapped continuation",
  "| Name | Role |\n| --- | --- |\n| core | runtime |",
  "[Install](docs/INSTALL.md) · [Security](docs/SECURITY.md)",
  "The options are:",
  filler,
].join("\n\n");

test("Markdown structure and printable Unicode prose are eligible; structure is always kept", () => {
  assert.ok(doc.length >= 800 && Buffer.byteLength(doc) <= 4096);
  const source = mini.miniSource(doc);
  assert.ok(source, "headings, lists, tables, link rows, lead-ins and curly quotes no longer disqualify a document");
  const required = [...source.required].sort((a, b) => a - b);
  // Headings (0, 2), the blocked status (1), list (5), table (6), link row (7)
  // and the lead-in (8) are kept; plain background prose (3, 4, 9) may go.
  assert.deepEqual(required, [0, 1, 2, 5, 6, 7, 8]);
  assert.ok(mini.structuralParagraph("## Heading"));
  assert.ok(mini.structuralParagraph("1. one\n2. two"));
  assert.ok(!mini.structuralParagraph(filler));
  // Hidden text, unpaired surrogates, code fences and shapeless prose still abstain.
  for (const bad of [doc.replace("Workspace", "Work​space"), doc + "\n\n\ud800 dangling.", doc.replace("## Background", "```\ncode\n```"), doc.replace(filler + "\n\n" + curly, filler + "\n\n" + curly.slice(0, -1))])
    assert.equal(mini.miniSource(bad), undefined);
  // More words than the worker's 512-token window cannot fit.
  const long = Array(6).fill(Array(100).fill("go").join(" ") + ".").join("\n\n");
  assert.ok(Buffer.byteLength(long) <= 4096 && long.split(/\s+/).length > 510);
  assert.equal(mini.miniSource(long), undefined);
});

test("the Python worker gate agrees with the client on eligibility, spans and kept paragraphs", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("python3 unavailable");
  const fixtures = [
    doc,
    [filler, "The build has not passed yet.", ...Array(4).fill(filler)].join("\n\n"),
    // ASCII word boundaries on both sides: "Noël" contains a protected "No".
    ["Noël arrives with background colour.", ...Array(5).fill(filler)].join("\n\n"),
    ["This paragraph depends on the previous one.", filler, "However, the next idea follows naturally.", ...Array(3).fill(filler)].join("\n\n"),
    ["Plain start.", "{\n  \"json\": true\n}", ...Array(4).fill(filler)].join("\n\n"),
    doc.replace("Workspace", "Work​space"),
    "short",
    Array(30).fill("Background sentence number one.").join("\n\n"),
  ];
  const script = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(agent, "scripts"))})`,
    "from lib.paragraph_selector import paragraph_source",
    "out=[]",
    "for raw in json.load(sys.stdin):",
    " r=paragraph_source(raw)",
    " out.append(None if isinstance(r,str) else {'spans':[list(s) for s in r[0]],'required':sorted(r[2])})",
    "print(json.dumps(out))",
  ].join("\n");
  const run = spawnSync("python3", ["-c", script], { input: JSON.stringify(fixtures), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const worker = JSON.parse(run.stdout);
  const client = fixtures.map((raw) => {
    const source = mini.miniSource(raw);
    return source ? { spans: source.spans, required: [...source.required].sort((a, b) => a - b) } : null;
  });
  assert.deepEqual(worker, client);
  assert.ok(client.filter(Boolean).length >= 4, "the fixtures exercise eligible sources");
});

const runtime = { version: 1, enabled: true, endpoint: "http://127.0.0.1:18736/select", apiKey: "TEST_MINI_PREPROCESSOR_KEY_1234567890" };
const admissible = ["Deployment remains blocked until the release checklist is verified.", ...Array(9).fill(filler)].join("\n\n");

test("a worker refusal made before inference leaves no cooldown; other refusals keep it", async () => {
  let now = 0, calls = 0, header = "0";
  const unknown = () => new Response('{"version":1,"status":"UNKNOWN"}', { headers: header ? { "X-Kompress-Inference": header } : {} });
  const client = mini.createMiniPreprocessor({ runtime, now: () => now, fetch: async () => { calls++; return unknown(); } });
  assert.equal(await client.select(admissible, 0), undefined);
  assert.equal(await client.select(admissible.replace("blocked", "held"), 0), undefined);
  assert.equal(calls, 2, "an unrun refusal spends no slot, so the next offer is sent at once");
  assert.equal(client.inspect().cooldownMs, 0);
  header = "1";
  assert.equal(await client.select(admissible.replace("blocked", "paused"), 0), undefined);
  assert.equal(await client.select(admissible.replace("blocked", "stopped"), 0), undefined);
  assert.equal(calls, 3, "a refusal after inference keeps the ten-second slot");
  now = 10_000; header = "";
  assert.equal(await client.select(admissible.replace("blocked", "frozen"), 0), undefined);
  assert.equal(await client.select(admissible.replace("blocked", "parked"), 0), undefined);
  assert.equal(calls, 4, "services without the header keep the original cooldown");
});

function observations() {
  const selects = [], offers = [];
  const handlers = new Map();
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    getActiveTools: () => ["obs_read", "read", "bash"],
  };
  register(pi,
    { reset: () => {}, endTurn: () => {}, select: async (text) => { selects.push(text); } },
    { reset: () => {}, endTurn: () => {}, offer: (_key, text) => offers.push(text), take: () => undefined, takeAsync: async () => undefined });
  const read = (text, file = "notes.md") => handlers.get("tool_result")[0]({
    toolName: "read", toolCallId: `call-${selects.length + offers.length}`, input: { path: file }, isError: false,
    content: [{ type: "text", text }], details: {},
  }, { model: { cost: { input: 3 } } });
  return { selects, offers, read };
}

test("Kompress claims only output it could shorten; the rest stays with Smol", async () => {
  const s = observations();
  await s.read(admissible);
  assert.deepEqual(s.selects, [admissible], "shortenable prose goes to Kompress");
  assert.equal(s.offers.length, 0);
  // Eligible in shape, but every paragraph is protected: no selection could
  // save anything, so Kompress must not swallow the Smol opportunity.
  const protectedDoc = Array.from({ length: 22 }, (_, i) =>
    `The staging cluster only serves version ${i + 2} of the product catalogue to invited reviewers in the northern region during each quarterly audit window.`).join("\n\n");
  assert.ok(protectedDoc.length >= 3000 && protectedDoc.length <= 4096);
  assert.ok(mini.miniSource(protectedDoc), "the document is Kompress-shaped");
  assert.equal(mini.miniAdmissible(protectedDoc, 3), false);
  await s.read(protectedDoc);
  assert.equal(s.selects.length, 1, "no Kompress request for unshortenable prose");
  assert.deepEqual(s.offers, [protectedDoc], "Smol receives the output instead");
});

test("the worker answers shape refusals without spending its inference slot", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("python3 unavailable");
  const script = [
    "import importlib.util,json,sys,threading,urllib.request,urllib.error",
    `sys.path.insert(0, ${JSON.stringify(path.join(agent, "scripts"))})`,
    `spec=importlib.util.spec_from_file_location('worker', ${JSON.stringify(path.join(agent, "scripts/mini-preprocessor.py"))})`,
    "worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)",
    "from lib.paragraph_selector import paragraph_source",
    "class Stub:",
    " def select(self,raw,admit=lambda:True):",
    "  source=paragraph_source(raw)",
    "  if isinstance(source,str):return {'applied':False,'reason':source,'inference':False}",
    "  if not admit():return {'applied':False,'reason':'rate_limited','inference':False}",
    "  return {'applied':False,'reason':'insufficient_saving','inference':True}",
    "key='k'*40;auth='Bearer '+key;server=worker.Server(('127.0.0.1',0),Stub(),key)",
    "threading.Thread(target=server.serve_forever,daemon=True).start()",
    "def post(raw):",
    " request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/select',data=json.dumps({'version':1,'raw':raw}).encode(),headers={'Authorization':auth,'Content-Type':'application/json'})",
    " try:",
    "  with urllib.request.urlopen(request,timeout=5) as r:return [r.status,r.headers.get('X-Kompress-Inference'),json.loads(r.read())['status']]",
    " except urllib.error.HTTPError as e:return [e.code,e.headers.get('X-Kompress-Inference'),json.loads(e.read())['status']]",
    "texts=json.load(sys.stdin)",
    "print(json.dumps([post(texts[0]),post(texts[1]),post(texts[0]),post(texts[1])]));server.shutdown()",
  ].join("\n");
  const shapeless = "x".repeat(900);
  const run = spawnSync("python3", ["-c", script], { input: JSON.stringify([shapeless, admissible]), encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [
    [200, "0", "UNKNOWN"], // shape refusal: no inference, no slot spent
    [200, "1", "UNKNOWN"], // inference ran and found nothing worth omitting
    [200, "0", "UNKNOWN"], // refusals are still answered during the slot
    [429, "0", "UNKNOWN"], // a second inference within ten seconds waits
  ]);
});
