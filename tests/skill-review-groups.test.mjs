// Keep metadata/routing fixtures independent of remote judge configuration.
process.env.PI_JEV = "off";
process.env.PI_NEEDLE = "off";
process.env.PI_LOCAL_LM = "off";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")]
  .find(dir => fs.existsSync(path.join(dir, "extensions/lib/relevant-guidance.ts")));
const {createRelevantGuidance} = await import(pathToFileURL(path.join(agent, "extensions/lib/relevant-guidance.ts")));
const {CAPABILITY_GROUPS, capabilityGroup, groupOverview} = await import(pathToFileURL(path.join(agent, "extensions/lib/capability-groups.ts")));

const names = [
  "database-migration", "browser-task-recovery", "ml-engineering",
  "product-photoshoot", "google-sheets", "investment-banking",
  "research-notes", "misc-thing", "video-editing",
];

function fixture(skillNames = names, systemPromptOptions) {
  const tools = new Map(), hooks = new Map();
  const entries = [];
  const active = ["read", "skill_review"];
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    getActiveTools: () => active,
    registerTool: tool => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({type: "custom", customType, data}),
  };
  const ctx = {cwd: "/fixture", sessionManager: {getBranch: () => entries}};
  const systemPrompt = `<available_skills>${skillNames.map(name =>
    `<skill><name>${name}</name><description>${name.replaceAll("-", " ")}</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join("")}</available_skills>`;
  const guidance = createRelevantGuidance(pi);
  guidance.restore(ctx);
  guidance.start({prompt: "Explain the available workflows", systemPrompt, systemPromptOptions}, ctx);
  return {guidance, review: tools.get("skill_review"), entries, ctx, hooks};
}

test("capability grouping is total, deterministic and compact", () => {
  const items = names.map(name => ({name, description: name === "misc-thing" ? "misc capability" : name.replaceAll("-", " ")}));
  const first = groupOverview(items);
  assert.deepEqual(groupOverview(items), first);
  assert.ok(first.length <= CAPABILITY_GROUPS.length);
  assert.equal(first.reduce((sum, group) => sum + group.count, 0), names.length);
  assert.ok(first.some(group => group.id === "other"));
  assert.equal(capabilityGroup("mystery-item", "no known domain"), "other");
  for (const name of ["bg_run", "obs_read", "subagent"]) assert.equal(capabilityGroup(name,"model helper"),"operations");
  assert.equal(capabilityGroup("http_request","API diagnostics"),"web");
  assert.ok(first.every(group => Object.keys(group).sort().join(",") === "count,description,id,label"));
});

test("skill_review browse exposes group counts and bounded metadata search", async () => {
  const f = fixture();
  const before = f.entries.length;
  const overview = await f.review.execute("browse", {action: "browse"});
  assert.equal(overview.isError, undefined);
  assert.equal(overview.details.groups.reduce((sum, group) => sum + group.count, 0), names.length);
  assert.ok(overview.details.groups.length <= 8);
  assert.equal(f.entries.length, before, "metadata browse does not create review state");

  const media = await f.review.execute("browse", {action: "browse", group: "media", limit: 1});
  assert.equal(media.details.group, "media");
  assert.equal(media.details.results.length, 1);
  assert.equal(media.details.results[0].name, "product-photoshoot");
  assert.ok(media.details.remaining >= 1);
  assert.ok(media.details.results.every(result => Object.keys(result).sort().join(",") === "description,name,path"));

  const found = await f.review.execute("search", {action: "search", query: "database migration", limit: 8});
  assert.equal(found.details.results[0].name, "database-migration");
  assert.doesNotMatch(found.content[0].text, /SKILL BODY|secret/i);
  const page = await f.review.execute("search", {action: "search", group: "media", query: "", limit: 1, offset: 1});
  assert.equal(page.details.results[0].name, "video-editing");
  assert.equal(page.details.remaining, 0);

  const unknown = await f.review.execute("browse", {action: "browse", group: "missing-group"});
  assert.equal(unknown.isError, true);
});

test("restored skill review targets are paginated without losing later items", async () => {
  const f = fixture();
  f.entries.push({type:"custom", customType:"relevant-guidance", data:{cwd:"/fixture", reviews:Array.from({length:10},(_,i)=>({skill:{name:`workflow-${i}`,file:`/fixture/skills/workflow-${i}/SKILL.md`,description:"Workflow"},reason:"Verify the applicable behavior",origin:"file"}))}});
  f.guidance.restore(f.ctx);
  const first = await f.review.execute("inspect",{action:"inspect"});
  assert.equal(first.details.skills.length,3);
  assert.equal(first.details.remaining,7);
  const next = await f.review.execute("inspect",{action:"inspect",offset:3,limit:8});
  assert.equal(next.details.skills.length,7);
  assert.equal(next.details.remaining,0);
  assert.equal(new Set([...first.details.skills,...next.details.skills].map(skill=>skill.path)).size,10);
});

test("the complete SDK catalogue remains searchable and pageable beyond old caps", async () => {
  const skills = Array.from({length:1105}, (_,i) => ({
    name:`workflow-${String(i).padStart(4,'0')}`,
    description:'Installed workflow metadata',
    filePath:`/fixture/skills/workflow-${i}/SKILL.md`,
  }));
  const f = fixture(['prompt-only-decoy'], {skills});
  const overview = await f.review.execute('browse',{action:'browse'});
  assert.equal(overview.details.groups.reduce((sum,g)=>sum+g.count,0),1105);
  const found = await f.review.execute('search',{action:'search',query:'workflow-1104'});
  assert.equal(found.details.results[0].name,'workflow-1104');
  const tail = await f.review.execute('search',{action:'search',offset:1100,limit:8});
  assert.equal(tail.details.results.length,5);
  assert.equal(tail.details.remaining,0);
  assert.equal(tail.details.results.at(-1).name,'workflow-1104');
  assert.doesNotMatch(JSON.stringify(tail.details),/prompt-only-decoy/);
});

test("fallback catalogue search remains complete with ambient guidance disabled", async () => {
  const previous = process.env.PI_RELEVANT_GUIDANCE;
  process.env.PI_RELEVANT_GUIDANCE = 'off';
  try {
    const f = fixture(Array.from({length:300},(_,i)=>`fallback-${i}`));
    const found = await f.review.execute('search',{action:'search',query:'fallback-299'});
    assert.equal(found.details.results[0].name,'fallback-299');
    assert.deepEqual(f.guidance.candidates(),[],'discovery does not re-enable ambient suggestions');
  } finally {
    if(previous === undefined) delete process.env.PI_RELEVANT_GUIDANCE;
    else process.env.PI_RELEVANT_GUIDANCE = previous;
  }
});

test("explicit discovery keeps short domain names ahead of incidental description matches", async () => {
  const skills = [
    {name:'vanilla-web-libs',description:'Web libraries for server-side templating static site generators',filePath:'/fixture/skills/web/SKILL.md'},
    {name:'php-application-engineering',description:'Build PHP applications across development and shared hosting.',filePath:'/fixture/skills/php/SKILL.md'},
    {name:'api-design',description:'Design request contracts and HTTP responses.',filePath:'/fixture/skills/api/SKILL.md'},
    {name:'capital-planning',description:'Capital investments and financing.',filePath:'/fixture/skills/capital/SKILL.md'},
  ];
  const f = fixture([], {skills});
  const before = f.entries.length;
  const php = await f.review.execute('search',{action:'search',query:'php server-side templating static site generator'});
  assert.equal(php.details.results[0].name,'php-application-engineering');
  const api = await f.review.execute('search',{action:'search',query:'API',limit:8});
  assert.deepEqual(api.details.results.map(skill=>skill.name),['api-design']);
  assert.equal(f.entries.length,before,'search does not create review obligations or delivery receipts');
});

test('skill discovery uses shared Jev with local IDs while preserving exact names, families and fallback', async () => {
  const {configureJevClient, resetJevClient} = await import(pathToFileURL(path.join(agent, 'extensions/lib/jev-client.ts')));
  const previousKey = process.env.OPENROUTER_API_KEY, previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  process.env.OPENROUTER_API_KEY = 'TEST_JEV_SKILL_DISCOVERY'; process.env.PI_JEV = 'on';
  const skills = Array.from({length: 7}, (_, index) => ({name: `layout-check-${index}`, description: 'Browser interface screenshot workflow', filePath: `/fixture/private/skills/layout-${index}/SKILL.md`}));
  let calls = 0, target = 'layout-check-5', unavailable = false;
  configureJevClient({fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.doesNotMatch(JSON.stringify(body), /\/fixture\/|SKILL\.md/);
    assert.ok(body.state.candidates.every(candidate => /^skill-\d+$/.test(candidate.id)));
    if (unavailable) return new Response('', {status: 503});
    const top = body.state.candidates.find(candidate => candidate.text.startsWith(target + ':')).id;
    return new Response(JSON.stringify({answers: {rank: {type:'choice', choice:top, probabilities:{[top]:.98}}, exists:{type:'noul',noul:.98}}, usage:{input_tokens:40,cost:.000001}}), {status:200});
  }});
  try {
    resetJevClient();
    const f = fixture([], {skills}), before = f.entries.length;
    const result = await f.review.execute('search', {action:'search',query:'browser interface screenshot workflow',limit:8});
    assert.equal(result.details.results[0].name, target); assert.equal(result.details.ranking, 'jev'); assert.equal(calls, 1);
    assert.equal(result.details.results.length, skills.length);
    assert.deepEqual(f.entries.slice(before).map(entry => entry.customType), ['jev-usage-v1'], 'ranking usage does not become a review or read receipt');
    const exact = await f.review.execute('search', {action:'search',query:'layout-check-2'});
    assert.equal(exact.details.results[0].name, 'layout-check-2'); assert.equal(calls, 1, 'exact names bypass inference');
    const family = ['copywriting','resourceful-market-strategy','organic-growth-engineering','community-promotion','natural-editorial-writing','unrelated-layout','unrelated-images'].map(name => ({name,description:'Marketing conversion workflow',filePath:`/fixture/private/skills/${name}/SKILL.md`}));
    target = 'unrelated-layout';
    const familyResult = await fixture([], {skills:family}).review.execute('family', {action:'search',query:'marketing conversion workflows',limit:8});
    assert.deepEqual(new Set(familyResult.details.results.slice(0,5).map(row => row.name)), new Set(family.slice(0,5).map(row => row.name)));
    resetJevClient(); unavailable = true;
    const fallback = await f.review.execute('fallback', {action:'search',query:'browser interface screenshot workflow',limit:8});
    assert.equal(fallback.isError, undefined); assert.equal(fallback.details.results.length, skills.length);
    assert.notEqual(fallback.details.ranking, 'jev');
  } finally {
    process.env.PI_JEV = 'off';
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    resetJevClient(); configureJevClient({fetchImpl:(...args)=>globalThis.fetch(...args)});
  }
});

test('skill discovery cancels transport and withholds results after caller or session changes', async () => {
  const {configureJevClient, resetJevClient} = await import(pathToFileURL(path.join(agent, 'extensions/lib/jev-client.ts')));
  const previousKey = process.env.OPENROUTER_API_KEY, previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  process.env.OPENROUTER_API_KEY = 'TEST_JEV_SKILL_DISCOVERY'; process.env.PI_JEV = 'on';
  try {
    for (const mode of ['caller','input','restore','switch']) {
      resetJevClient(); let entered, transportSignal;
      const started = new Promise(resolve => { entered = resolve; });
      configureJevClient({fetchImpl: async (_url, options) => {
        transportSignal = options.signal; entered();
        return new Promise((_resolve,reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
      }});
      const skills = Array.from({length:7},(_,index)=>({name:`workflow-${index}`,description:'Browser interface screenshot workflow',filePath:`/fixture/private/${index}/SKILL.md`}));
      const f = fixture([], {skills}), controller = new AbortController(), before = f.entries.length;
      const pending = f.review.execute('search',{action:'search',query:'browser interface screenshot workflow'},controller.signal);
      await started;
      if (mode === 'caller') controller.abort();
      if (mode === 'input') f.guidance.userInput();
      if (mode === 'restore') f.guidance.restore(f.ctx);
      if (mode === 'switch') f.hooks.get('session_before_switch')();
      const result = await pending;
      assert.equal(result.isError,true,mode); assert.equal(result.details,undefined,mode);
      assert.equal(transportSignal.aborted,true,mode);
      assert.equal(f.entries.slice(before).some(entry=>entry.customType==='jev-usage-v1'),false,mode);
    }
  } finally {
    process.env.PI_JEV = 'off';
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    resetJevClient(); configureJevClient({fetchImpl:(...args)=>globalThis.fetch(...args)});
  }
});
