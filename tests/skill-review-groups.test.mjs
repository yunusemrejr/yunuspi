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
  const tools = new Map();
  const entries = [];
  const active = ["read", "skill_review"];
  const pi = {
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
  return {guidance, review: tools.get("skill_review"), entries, ctx};
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
