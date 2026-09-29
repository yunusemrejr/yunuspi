import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const {auditSource,codeAudit,auditable}=await jiti.import('../agent/extensions/lib/code-audit.ts');
const {default:registerAuditTools}=await jiti.import('../agent/extensions/code-audit.ts');
const {default:registerSourceCheck}=await jiti.import('../agent/extensions/lib/source-check.ts');
const {authoredReviewSignals}=await jiti.import('../agent/extensions/lib/authored-review.ts');
const {reviewAspects}=await jiti.import('../agent/extensions/lib/quality-review.ts');
const rules=(file,source,options)=>auditSource(file,source,options).map(f=>f.rule);
// Built at runtime so this fixture is not itself a committed credential literal.
const assign=value=>['pass','word'].join('')+' = "'+value+'"';
const has=(file,source,rule,options)=>assert.ok(rules(file,source,options).includes(rule),`${rule} expected in ${file}: ${JSON.stringify(auditSource(file,source,options).map(f=>f.rule))}`);
const lacks=(file,source,rule,options)=>assert.ok(!rules(file,source,options).includes(rule),`${rule} unexpected in ${file}`);

test('injection sinks fire on built strings and stay quiet on parameterized or literal forms',()=>{
  has('src/a.js','db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);','sql-injection');
  has('src/a.js','db.query("SELECT * FROM t WHERE a = " + id);','sql-injection');
  lacks('src/a.js','db.query("SELECT * FROM users WHERE id = $1", [id]);','sql-injection');
  lacks('src/a.js','db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => "?").join(",")}) AND k = ${KIND_COLUMN}`);','sql-injection');
  lacks('src/a.js','db.prepare(`SELECT * FROM t WHERE ${conditions.join(" AND ")}`);','sql-injection');
  assert.equal(auditSource('src/a.js','db.query(`SELECT * FROM t WHERE id = ${req.params.id}`);')[0].severity,'high');
  assert.equal(auditSource('src/a.js','db.query(`SELECT * FROM t WHERE ${field} = 1`);')[0].severity,'medium');
  lacks('src/a.js','db.exec(`PRAGMA busy_timeout = ${ms};`);','command-injection');
  lacks('src/a.js','const m = re.exec(`${a}${b}`);','command-injection');
  lacks('src/a.js','prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`;','sql-injection');
  has('src/a.py','cur.execute(f"SELECT * FROM t WHERE id={x}")','sql-injection');
  lacks('src/a.py','cur.execute("SELECT * FROM t WHERE id=%s", (x,))','sql-injection');
  has('src/a.go','db.Query(fmt.Sprintf("SELECT * FROM t WHERE id=%s", id))','sql-injection');
  has('src/a.js','exec("ls " + req.query.dir);','command-injection');
  has('src/a.js','execSync(`git log ${branch}`);','command-injection');
  lacks('src/a.js','execFile("git", ["log", branch]);','command-injection');
  has('src/a.py','os.system(f"rm {name}")','command-injection');
  has('src/a.py','subprocess.run(cmd, shell=True)','command-injection');
  lacks('src/a.py','subprocess.run(["ls", name])','command-injection');
});

test('code execution, HTML sinks and deserialization are graded and literals are ignored',()=>{
  has('src/a.js','const v = eval(userCode);','code-execution');
  lacks('src/a.js','const v = eval("1 + 1");','code-execution');
  lacks('src/a.js','const load = new Function(\n  "specifier",\n  "return import(specifier)",\n);','code-execution');
  lacks('src/a.js','// eval(userCode) is forbidden\nconst s = "eval(x)";','code-execution');
  assert.equal(auditSource('src/a.js','el.innerHTML = location.hash;').find(f=>f.rule==='xss-sink').severity,'high');
  assert.equal(auditSource('src/a.js','el.innerHTML = userBio;').find(f=>f.rule==='xss-sink').severity,'medium');
  assert.equal(auditSource('src/a.js','el.innerHTML = tableHtml;').find(f=>f.rule==='xss-sink').severity,'low');
  lacks('src/a.js','el.innerHTML = "";','xss-sink');
  lacks('src/a.js','if (el.innerHTML === expected) {}','xss-sink');
  lacks('src/a.js','el.innerHTML = DOMPurify.sanitize(html);','xss-sink');
  has('src/View.tsx','<div dangerouslySetInnerHTML={{__html: html}} />','xss-sink');
  has('src/a.py','data = pickle.loads(blob)','unsafe-deserialization');
  has('src/a.py','cfg = yaml.load(text)','unsafe-deserialization');
  lacks('src/a.py','cfg = yaml.safe_load(text)','unsafe-deserialization');
});

test('secrets: provider formats always, generic assignments only when they look real, placeholders ignored',()=>{
  const key='AKIA'+'ABCDEFGHIJKLMNOP';
  has('src/config.js',`const k = "${key}";`,'hardcoded-provider-key');
  has('.env',`AWS_KEY=${key}`,'hardcoded-provider-key');
  has('tests/fixture.test.js',`const k = "${key}";`,'hardcoded-provider-key');
  has('src/a.py',assign('hunter2hunter2X9zzQ'),'hardcoded-secret',{minSeverity:'medium'});
  lacks('src/a.py',assign('changeme-changeme-1'),'hardcoded-secret',{minSeverity:'medium'});
  lacks('src/a.js','const password = process.env.DB_PASSWORD;','hardcoded-secret');
  lacks('README.md',`sk-${'x'.repeat(40)}`,'hardcoded-provider-key');
  lacks('src/a.js',`const example = "sk-${'x'.repeat(40)}";`,'hardcoded-provider-key');
});

test('transport, crypto, session and request-flow cues',()=>{
  has('src/a.js','https.request({ rejectUnauthorized: false });','tls-verification-off');
  has('src/a.py','requests.get(url, verify=False)','tls-verification-off');
  has('src/a.js','const token = Math.random().toString(36);','weak-randomness');
  lacks('src/a.js','const jitter = Math.random() * 100;','weak-randomness');
  has('src/a.py','session_id = random.randint(0, 99999999)','weak-randomness');
  has('src/a.js','crypto.createHash("md5").update(password)','weak-hash');
  has('src/a.js','app.use(cors({ origin: true, credentials: true }));','cors-credentials-open');
  lacks('src/a.js','app.use(cors({ origin: "https://app.example.com", credentials: true }));','cors-credentials-open');
  has('src/a.js','res.cookie("sid", id, { httpOnly: false });','cookie-flags');
  has('src/a.js','jwt.verify(t, key, { algorithms: ["none"] });','jwt-misuse');
  has('src/a.js','fs.readFile(req.query.file, cb);','path-traversal');
  has('src/a.py','open(request.args["f"]).read()','path-traversal');
  has('src/a.js','res.redirect(req.query.next);','open-redirect');
  has('src/a.js','const r = await fetch(req.body.url);','ssrf');
});

test('backend cues: timeouts, mass assignment, leaks, blocking, N+1 and handler scope',()=>{
  has('src/a.py','r = requests.get(url)','missing-timeout');
  lacks('src/a.py','r = requests.get(url, timeout=5)','missing-timeout');
  lacks('src/a.py','r = requests.get(\n    url,\n    timeout=5,\n)','missing-timeout');
  has('src/a.go','resp, err := http.Get(url)','missing-timeout');
  has('src/a.js','await User.create(req.body);','mass-assignment');
  has('src/a.js','await User.update(id, req.body);','mass-assignment');
  lacks('src/a.js','await User.create(req.body.name);','mass-assignment');
  has('src/a.js','res.status(500).send(err.stack);','error-detail-leak');
  has('src/a.js','logger.info("login", password);','secret-in-log');
  lacks('src/a.js','logger.info("login failed for user");','secret-in-log');
  const http='const express = require("express");\n';
  has('src/a.js',http+'app.get("/x", (req, res) => {\n  const d = fs.readFileSync("f");\n});','sync-io-in-handler');
  lacks('src/a.js','function load(request, options) {\n  const d = fs.readFileSync("f");\n}','sync-io-in-handler');
  lacks('src/a.js',http+'function load(request) {\n  const d = fs.readFileSync("f");\n}','sync-io-in-handler');
  lacks('src/a.js','const d = fs.readFileSync("f");','sync-io-in-handler');
  has('src/a.js',http+'app.get("/x", (req: Request, res: Response) => {\n  const p = new Pool({});\n});','connection-per-request');
  lacks('src/a.js','const pool = new Pool({});','connection-per-request');
  has('src/a.js','for (const id of ids) {\n  const u = await db.users.findOne({ id });\n}','query-in-loop');
  has('src/a.js','ids.forEach(async (id) => {\n  await prisma.user.findUnique({ where: { id } });\n});','query-in-loop');
  lacks('src/a.js','const u = await db.users.findOne({ id });','query-in-loop');
  lacks('src/a.js','for (const id of ids) {\n  const item = await item.compute(id);\n}','query-in-loop');
  has('src/a.py','for u in users:\n    cur.execute("select 1")','query-in-loop');
  has('src/a.py','async def f():\n    time.sleep(1)','blocking-in-async');
  lacks('src/a.py','def f():\n    time.sleep(1)','blocking-in-async');
  const express='const express = require("express");\n';
  has('src/a.js',express+'app.get("/x", async (req, res) => {\n  res.json(await load());\n});','async-route-unhandled');
  lacks('src/a.js',express+'app.get("/x", async (req, res) => {\n  try { res.json(await load()); } catch (e) { next(e); }\n});','async-route-unhandled');
  lacks('src/a.js','app.get("/x", async (req, res) => {\n  res.json(await load());\n});','async-route-unhandled');
});

test('efficiency, patterns and UI-source cues',()=>{
  has('src/a.js','items.reduce((acc, x) => ({ ...acc, [x.id]: x }), {});','reduce-spread');
  lacks('src/a.js','items.reduce((acc, x) => acc + x.n, 0);','reduce-spread');
  has('src/a.js','for (const f of files) {\n  const s = fs.readFileSync(f);\n}','sync-io-in-loop');
  has('src/a.js','window.addEventListener("scroll", onScroll);','passive-listener');
  lacks('src/a.js','window.addEventListener("scroll", onScroll, { passive: true });','passive-listener');
  has('src/a.css','.a { transition: all .3s; }','transition-all');
  has('index.html','<html lang="en"><head><script src="a.js"></script></head></html>','blocking-script');
  lacks('index.html','<html lang="en"><head><script defer src="a.js"></script></head></html>','blocking-script');
  lacks('index.html','<html lang="en"><head></head><body><script src="a.js"></script></body></html>','blocking-script');
  has('src/a.js','throw "failed";','throw-string');
  has('src/a.py','def f(a, b=[]):\n    pass','mutable-default');
  has('src/a.py','try:\n    x()\nexcept:\n    pass','bare-except');
  has('src/a.py','if name is "admin":\n    pass','is-literal');
  lacks('src/a.py','print("the value is 5 things")','is-literal');
  has('src/a.js','const c = JSON.parse(JSON.stringify(o));','json-clone');
  has('src/List.tsx','items.map((x, i) => <li key={i}>{x}</li>)','array-index-key');
  has('index.html','<html><body><img src="a.png"></body></html>','img-without-alt');
  lacks('src/Card.tsx','<Img src={staticFile(logo)} />','img-without-alt');
  lacks('rules.yml','pattern: requests.get(verify=False)','tls-verification-off');
  lacks('index.html','<html lang="en"><body><img src="a.png" alt=""></body></html>','img-without-alt');
  has('a.css','a:focus { outline: none; }','focus-outline-removed');
  lacks('a.css','a:focus { outline: none; }\na:focus-visible { outline: 2px solid; }','focus-outline-removed');
  has('index.html','<meta name="viewport" content="width=device-width, user-scalable=no">','zoom-disabled');
  has('index.html','<div onclick="go()">x</div>','click-on-non-interactive');
  lacks('index.html','<button onclick="go()">x</button>','click-on-non-interactive');
});

test('options limit scope: domains, severity, changed line spans; tests, vendored and lock files are skipped',()=>{
  const source='eval(code);\nel.innerHTML = html;\nvar x = 1;\n';
  assert.deepEqual([...new Set(auditSource('src/a.js',source,{domains:['patterns']}).map(f=>f.domain))],['patterns']);
  assert.ok(auditSource('src/a.js',source,{minSeverity:'high'}).every(f=>f.severity==='high'));
  assert.deepEqual(rules('src/a.js',source,{lines:[2,2],domains:['security']}),['xss-sink']);
  assert.deepEqual(auditSource('src/a.test.js','eval(code);'),[]);
  assert.deepEqual(auditSource('node_modules/x/a.js','eval(code);'),[]);
  assert.deepEqual(auditSource('package-lock.json',`{"k":"AKIA${'ABCDEFGHIJKLMNOP'}"}`),[]);
  assert.ok(auditable('src/a.py')&&auditable('.env')&&auditable('config/app.yaml')&&!auditable('image.png')&&!auditable('package-lock.json'));
});

test('codeAudit walks a workspace, honours changed scope and keeps results bounded',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-audit-'));
  try {
    fs.mkdirSync(path.join(dir,'src'));
    fs.writeFileSync(path.join(dir,'src/db.js'),'export const find = (id) => db.query(`SELECT * FROM t WHERE id = ${id}`);\n');
    fs.writeFileSync(path.join(dir,'src/ok.js'),'export const add = (a, b) => a + b;\n');
    fs.writeFileSync(path.join(dir,'page.html'),'<html><body><img src="a.png"></body></html>');
    const report=await codeAudit({domains:['security','ui']},dir);
    assert.equal(report.scope.files,3);
    assert.ok(report.findings.some(f=>f.file==='src/db.js'&&f.rule==='sql-injection'&&f.severity==='high'));
    assert.ok(report.findings.some(f=>f.file==='page.html'&&f.rule==='img-without-alt'));
    assert.equal(report.findings[0].severity,'high');
    assert.equal((await codeAudit({domains:['security'],paths:['src/ok.js']},dir)).counts.total,0);
    await assert.rejects(codeAudit({paths:['../outside']},dir),/escapes|does not exist/);
    await assert.rejects(codeAudit({domains:['nope']},dir),/domains must be/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('code_audit tool returns each rule message once and compact locations',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-audit-tool-'));
  const tools=new Map();registerAuditTools({registerTool:t=>tools.set(t.name,t)});
  try {
    fs.writeFileSync(path.join(dir,'a.js'),'db.query(`SELECT * FROM t WHERE a = ${x}`);\ndb.query(`SELECT * FROM t WHERE b = ${y}`);\n');
    assert.deepEqual([...tools.keys()],['code_audit']);
    const result=await tools.get('code_audit').execute('1',{domains:['security']},undefined,undefined,{cwd:dir});
    const body=JSON.parse(result.content[0].text);
    assert.equal(Object.keys(body.rules).length,1);
    assert.deepEqual(body.findings.map(f=>f.at),['a.js:1','a.js:2']);
    assert.ok(body.rules['sql-injection'].fix);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('edits get audit advisories once per finding, and audit cues route review aspects',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-audit-hook-'));
  const hooks=new Map();
  registerSourceCheck({registerTool(){},on:(name,handler)=>hooks.set(name,handler)});
  const ctx={cwd:dir,sessionManager:{getSessionId:()=> 'audit'}};
  try {
    fs.writeFileSync(path.join(dir,'handler.js'),'export function find(id) {\n  return db.query(`SELECT * FROM t WHERE id = ${id}`);\n}\n');
    const event={toolName:'write',input:{path:'handler.js'},content:[{type:'text',text:'wrote'}],details:{},isError:false};
    const first=await hooks.get('tool_result')(event,ctx);
    assert.match(first.content[1].text,/security\/sql-injection \(high\)/);
    assert.match(first.content[1].text,/code_audit\(\{changed: ?true\}\)/);
    assert.equal(first.details.codeAudit[0].rule,'sql-injection');
    fs.appendFileSync(path.join(dir,'handler.js'),'export const other = 1;\n');
    const second=await hooks.get('tool_result')({...event,toolName:'write'},ctx);
    assert.ok(!second||!/sql-injection/.test(second.content.map(c=>c.text).join('')),'the announced finding is not repeated');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  const signals=authoredReviewSignals('src/handler.js',['db.query(`SELECT * FROM t WHERE id = ${id}`);']);
  assert.ok(signals.some(s=>s.key==='audit-security'));
  assert.ok(reviewAspects(['src/handler.js'],'',[],signals).some(a=>a.id==='security'));
  const runtime=authoredReviewSignals('src/a.py',['r = requests.get(url)']);
  assert.ok(runtime.some(s=>s.key==='audit-runtime'));
  assert.ok(reviewAspects(['src/a.py'],'',[],runtime).some(a=>a.id==='runtime'));
});
