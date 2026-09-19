import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")]
  .find(dir => fs.existsSync(path.join(dir, "extensions/lib/relevant-guidance.ts")));
const {createRelevantGuidance} = await import(pathToFileURL(path.join(agent, "extensions/lib/relevant-guidance.ts")));
const {matchHook} = await import(pathToFileURL(path.join(agent, "extensions/lib/session-hooks.ts")));
const {collectSessionMetrics} = await import(pathToFileURL(path.join(agent, "extensions/lib/session-metrics.ts")));
const {activitySource,transformActivity} = await import(pathToFileURL(path.join(agent,"scripts/compatibility/legacy-transforms/cache-hit-footer.mjs")));

function fixture(active = [], skills = []) {
  const entries = [];
  const pi = {getActiveTools: () => active, appendEntry: (customType, data) => entries.push({type:"custom", customType, data})};
  const ctx = {cwd:"/fixture/workspace", sessionManager:{getBranch:()=>entries}};
  const guidance = createRelevantGuidance(pi);
  guidance.restore(ctx);
  const catalog = `<available_skills>${skills.map(name => `<skill><name>${name}</name><description>${name.replaceAll('-', ' ')}</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join('')}</available_skills>`;
  return {guidance, active, entries, ctx, pi,
    start(prompt) { guidance.userInput(); guidance.start({prompt, systemPrompt:catalog},ctx); },
    step(toolName="read", input={path:"evidence.txt"}, isError=false) { guidance.record({toolName,input,isError}); },
    take() { const hints=guidance.candidates(); assert.ok(hints.length<=2); guidance.commit(hints); return hints; },
  };
}

const task = [
  "Inspect JSON keys", "Review git status", "Inspect HTTP response headers",
  "Check listening ports", "Replace labels across multiple files",
  "Inspect website login forms", "Run integration tests", "Wait for HTTP readiness",
  "Plan tasks with dependencies", "Calculate the median", "Check Unicode normalization",
  "Decode Base64", "Prepare a handoff", "Retrieve cached evidence",
  "Rank context items", "Inspect implementation code", "Inspect callers and references",
  "Review the patch diff", "Check type errors", "Audit code duplication",
].join(". ");
const toolNames = ["data_query","git_info","http_request","sys_probe","bulk_edit","web_probe","bg_run","wait_for","todo","math_check","artifact_check","value_convert","handoff_capsule","evidence_cache","context_score","context_slice","symbol_expand","ast_diff","lsp_diagnostics","lens_diagnostics"];

test("browser inspection does not receive submission recovery or posting workflow prompts",()=>{
 for (const action of ['open','navigate','snapshot','inspect','logs']) {
  const failure=matchHook('browser_session',{action},true);
  assert.equal(failure.key,'browser-session-read-recovery');
  assert.doesNotMatch(failure.line,/successful post|submission receipt/);
  assert.equal(matchHook('browser_session',{action}),null);
 }
 assert.equal(matchHook('browser_session',{action:'click'},true).key,'browser-session-recovery');
 assert.equal(matchHook('browser_session',{action:'press'}).key,'browser-session-workflow');
});

test("utility tools receive automatic contextual guidance only when active", () => {
  for (const [tool, prompt] of [
    ['sqlite_probe', 'Inspect SQLite tables'], ['package_probe', 'Check the installed package version'],
    ['openapi_probe', 'Inspect OpenAPI endpoints'], ['coverage_probe', 'Inspect uncovered lines'],
    ['contract_diff', 'Inspect schema changes'], ['env_audit', 'Audit environment variables'],
    ['net_probe', 'Inspect DNS records'], ['archive_probe', 'Inspect archive contents'],
    ['net_probe', 'Connect to the host and check why it is unreachable'],
    ['net_probe', 'The request timed out, check the endpoint'],
  ]) {
    const enabled = fixture([tool]); enabled.start(prompt);
    assert.ok(enabled.take().some(h => h.tool === tool), tool);
    const disabled = fixture([]); disabled.start(prompt);
    assert.equal(disabled.take().filter(h => h.tool === tool).length, 0);
  }
});

test("advisory capability hints retain one useful operation while preserving recovery priority", () => {
  const f=fixture(['read','data_query','tool_search']);
  f.start('Inspect JSON keys');
  const hint=f.guidance.candidates().find(h=>h.discovery==='capability');
  assert.ok(hint?.text.includes('data_query'),'a concrete match does not turn into generic catalog browsing');
  assert.match(hint.text,/optional|if useful/i);
  for(let i=0;i<3;i++)f.step('read',{path:'missing.txt'},true);
  assert.equal(f.guidance.candidates()[0].key,'signal:repeated-failure','recovery keeps its higher priority');
  f.take();
  for(let i=0;i<20;i++)f.step('read',{path:'settings.json'});
  assert.equal(f.guidance.candidates().filter(h=>h.discovery==='capability').length,0,'ignored advice stays coalesced for the request');
});

test("inactive capability advice checks registration and never promises activation authority", () => {
  for(const registered of [false,true]) {
    const f=fixture(['read','tool_search']);
    f.pi.getAllTools=()=>[...f.active,...(registered?['data_query']:[])].map(name=>({name,description:name}));
    f.start('Inspect JSON keys');
    const hint=f.guidance.candidates().find(h=>h.discovery==='capability');
    if(!registered)assert.equal(hint,undefined,'an unavailable tool is not advertised');
    else {
      assert.ok(hint?.text.includes('data_query'),'registered metadata can remain discoverable');
      assert.match(hint.text,/query:/,'an inactive tool is previewed against the current session selection');
      assert.doesNotMatch(hint.text,/names:|can enable/,'registration is not evidence of activation authority');
    }
    assert.deepEqual(f.active,['read','tool_search']);
  }
});

test("sustained multi-phase work can discover twenty applicable tools without a catalog dump", () => {
  const f=fixture(toolNames); f.start(task);
  const delivered=[...f.take(),...f.take()];
  assert.equal(delivered.length,3);
  for(let i=0;i<10;i++) assert.equal(f.take().length,0,"reads of candidates do not replenish delivery");
  for(let i=0;i<100;i++) { f.step(); delivered.push(...f.take()); }
  assert.equal(new Set(delivered.map(h=>h.tool)).size,20);
  assert.equal(delivered.length,20,"bounded even when the model ignores every suggestion");
  assert.equal(f.take().length,0);
  for(let i=0;i<3;i++) f.step('read',{path:'missing.txt'},true);
  assert.ok(f.take().some(h=>h.key==='signal:repeated-failure'),"recovery has a reserved slot after ordinary hints are exhausted");
  assert.equal(f.take().length,0);
});

test("available skill routes continue beyond the first three suggestions", () => {
  const names=["python-software-engineering","rust-systems-engineering","go-service-engineering","typescript-contract-engineering","sql-query-engineering","numerical-computing","compiler-construction","physics-modeling"];
  const f=fixture(["read"],names);
  f.start("Review Python, Rust, Golang, TypeScript and SQL code. Verify numerical matrix computations. Review a compiler parser. Inspect physics mechanics.");
  const offered=new Set();
  for(let i=0;i<60;i++) {
    for(const h of f.take()) if(h.skill) offered.add(h.skill);
    f.step();
  }
  assert.equal(offered.size,names.length);
  for(const file of offered) assert.ok(names.some(name=>file===`/fixture/skills/${name}/SKILL.md`));
  assert.deepEqual(f.entries.at(-1).data.read,[],"suggestions are not read receipts");
});

test("management discovery does not consume execution guidance and availability is rechecked", () => {
  const f=fixture(["subagent"]); f.start("Use independent subagents to review the change");
  f.step("subagent",{action:"list",capabilities:true});
  const hints=f.guidance.candidates();
  assert.equal(hints.filter(h=>h.tool==='subagent').length,1,"discovery and execution guidance share one contract receipt");
  assert.ok(hints.some(h=>h.key==='delegation-contract'));
  f.active.length=0;
  assert.equal(f.guidance.candidates().length,0);
  f.active.push("subagent");
  f.step("subagent",{agent:"reviewer",task:"Inspect source"});
  assert.equal(f.guidance.candidates().length,0);
});

test("request constraints, quoted instructions and new prompts do not leak suggestions", () => {
  const f=fixture(toolNames);
  for(const prompt of ["Explain JSON keys","> Inspect JSON keys","```\nInspect JSON keys\n```","Do not inspect HTTP headers","Inspect JSON without tools"]) {
    f.start(prompt); f.step("read",{path:"evidence.txt"});
    // Keep file evidence neutral while testing whether the prompt itself
    // causes suggestions. UI files independently justify UI source guidance.
    assert.ok(f.guidance.candidates().every(h=>!h.tool));
  }
  f.start("Inspect JSON without tools"); f.step("read",{path:"widget.tsx"});
  assert.equal(f.guidance.candidates().length,0,"the no-tools constraint also suppresses file-based suggestions");
  f.start(task); assert.equal(f.take().length,2);
  f.start("Hello"); assert.equal(f.take().length,0,"pending task hints reset on new input");
  const noDelegate=fixture(["subagent"]);
  noDelegate.start("Use subagents to inspect code, but no delegation");
  assert.equal(noDelegate.take().length,0);
});

test("vague actionable prompts with zero skill routes get the explore-first fallback", () => {
  const f=fixture(toolNames,["evidence-first-engineering"]);
  f.start("Fix the wobblewidget alignment, make it unique and less weird");
  assert.ok(f.take().some(h=>h.key==="skill:/fixture/skills/evidence-first-engineering/SKILL.md"),"vague unmatched action routes explore-first guidance");
  const plain=fixture(toolNames,["evidence-first-engineering"]);
  plain.start("Fix the wobblewidget alignment");
  assert.ok(plain.take().every(h=>h.key!=="skill:/fixture/skills/evidence-first-engineering/SKILL.md"),"specified unmatched action stays silent");
  const q=fixture(toolNames,["evidence-first-engineering"]);
  q.start("Explain JSON keys");
  assert.ok(q.take().every(h=>h.key!=="skill:/fixture/skills/evidence-first-engineering/SKILL.md"),"read-only questions stay silent");
});

test("successful tool and skill reads suppress recommendations, failed reads do not", () => {
  const f=fixture(["data_query","read"],["sql-query-engineering"]);
  f.start("Inspect JSON keys. Review SQL queries");
  f.step("data_query",{op:"keys",text:"{}"});
  const file="/fixture/skills/sql-query-engineering/SKILL.md";
  f.step("read",{path:file},true);
  assert.ok(f.guidance.candidates().some(h=>h.skill===file));
  f.step("read",{path:file});
  assert.ok(f.guidance.candidates().every(h=>!h.skill&&!h.tool));
  assert.ok(f.entries.at(-1).data.read.includes(file));
});

test("delivery receipts survive reload without treating them as skill reads", () => {
  const f=fixture(["data_query"]); f.start("Inspect JSON keys"); f.take();
  const restored=createRelevantGuidance(f.pi); restored.restore(f.ctx);
  restored.start({prompt:"Inspect JSON keys",systemPrompt:""},f.ctx);
  assert.equal(restored.candidates().length,0);
  assert.deepEqual(f.entries.at(-1).data.read,[]);
});

test("a full delivery history remains bounded without disabling new capabilities", () => {
  const f=fixture(['data_query']);
  f.entries.push({type:'custom',customType:'relevant-guidance',data:{
    version:1,cwd:f.ctx.cwd,shown:Array.from({length:96},(_,i)=>`past:${i}`),read:[],
  }});
  f.guidance.restore(f.ctx); f.start('Inspect JSON keys');
  assert.ok(f.take().some(h=>h.tool==='data_query'));
  const receipts=f.entries.at(-1).data.shown;
  assert.equal(receipts.length,96);
  assert.ok(!receipts.includes('past:0'));
  assert.ok(receipts.includes('utility:data_query'));
});

test("new file phases route existing tools and file cues still expire", () => {
  const f=fixture(['data_query','lsp_diagnostics']); f.start('Investigate the issue');
  f.step('read',{path:'settings.json'});
  assert.ok(f.guidance.candidates().some(h=>h.tool==='data_query'));
  for(let i=0;i<5;i++) f.step();
  assert.equal(f.take().length,0);
  f.step('edit',{path:'handler.ts',newText:'const value = 1;'});
  assert.ok(f.guidance.candidates().some(h=>h.tool==='lsp_diagnostics'&&h.text.includes('handler.ts')));
  f.step('edit',{path:'other.ts',newText:'const next = 2;'});
  assert.ok(f.guidance.candidates().some(h=>h.tool==='lsp_diagnostics'&&h.text.includes('other.ts')&&!h.text.includes('handler.ts')));
});

test("hooks distinguish execution, native parallel work and task prose", () => {
  assert.equal(matchHook('subagent',{action:'list',capabilities:true}),null);
  assert.equal(matchHook('subagent',{action:'validate',workflowScript:'await runs.fuse(results)'}),null);
  assert.equal(matchHook('subagent',{agent:'reviewer',task:'Explain nuclear fusion'})?.key,'subagent-contract');
  assert.equal(matchHook('subagent',{tasks:[{agent:'a'},{agent:'b'}]})?.key,'subagent-fusion-budget');
  assert.equal(matchHook('subagent',{workflowScript:'await runs.all(tasks)'})?.key,'subagent-fusion-budget');
  assert.equal(matchHook('web_probe',{})?.key,'form-reconnaissance');
  assert.equal(matchHook('todo',{})?.key,'task-dependencies');
});

test("activity reports distinguish repeated calls, tool breadth and catalog-based skill offers", () => {
  const result=(id,toolName)=>({type:'message',message:{role:'toolResult',toolCallId:id,toolName}});
  const a=result('a','read');
  const m=collectSessionMetrics([a,a,result('b','read'),result('c','data_query'),
    {type:'custom',customType:'relevant-guidance',data:{shown:['skillctx:/fixture/custom/SKILL.md'],read:[]}}]);
  assert.equal(m.toolResults,3); assert.equal(m.distinctTools,2);
  assert.deepEqual(m.skillsRouted,['custom']); assert.deepEqual(m.skillsRead,[]);
});

test("released activity collectors upgrade without overwriting unknown local changes", () => {
  // Reconstruct the released helper and verify its frozen fingerprint before
  // exercising migration. This fixture contains source, never session data.
  const releasedSource=fs.readFileSync(new URL('./fixtures/session-metrics-released.ts',import.meta.url),'utf8')
    .replace('export function collectSessionMetrics','function collectSessionMetrics').replace(/^.*\n/,'').trim();
  assert.equal(createHash('sha256').update(releasedSource).digest('hex'),'61c16b6a591f8438e1fca219d159cf80e4f95a8ebd78aa80dc8220d731f6e4a7');
  const previous=releasedSource
    .replace("if(p.startsWith('skill:')||p.startsWith('skillctx:'))", "if(p.startsWith('skill:'))")
    .replace(" m.distinctTools=Object.keys(m.tools).length;\n", "")
    .replace("; distinct tools observed: ${m.distinctTools}. Breadth is descriptive, not a target or proof of effective use.", "");
  assert.equal(createHash('sha256').update(previous).digest('hex'),'69cb692ba5dc040c678704ac65c57fb15f18590b7aff96e5168285ebd04eec47');
  for(const bundled of [false,true]) for(const historical of [previous,releasedSource]) {
    const anchor=bundled?',extensionStatuses=this.footerData.getExtensionStatuses()':'const extensionStatuses = this.footerData.getExtensionStatuses()';
    const current=transformActivity(anchor,bundled);
    const released=current.replace(activitySource,()=>historical);
    assert.equal(transformActivity(released,bundled),current);
    assert.equal(transformActivity(current,bundled),current);
    assert.throws(()=>transformActivity(released.replace(historical,()=>historical+'\n'),bundled),/drift/);
    assert.throws(()=>transformActivity(released.replace("let activityLine = ''","let activityLine = 'local edit'"),bundled),/drift/);
  }
});
