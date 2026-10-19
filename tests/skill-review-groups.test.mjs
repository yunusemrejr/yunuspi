import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {pathToFileURL} from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const {registerSkillReview} = await import(pathToFileURL(path.join(root, "agent/extensions/lib/skill-review.ts")));
const {CAPABILITY_GROUPS, capabilityGroup, groupOverview} = await import(pathToFileURL(path.join(root, "agent/extensions/lib/capability-groups.ts")));

const names = [
  "database-migration", "browser", "ml",
  "product-photoshoot", "google-sheets", "investment-banking",
  "research-notes", "misc-thing", "video-editing",
];

function fixture(skillNames = names, systemPromptOptions) {
  const tools = new Map(), hooks = new Map();
  const entries = [];
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({type: "custom", customType, data}),
  };
  const systemPrompt = `<available_skills>${skillNames.map(name =>
    `<skill><name>${name}</name><description>${name.replaceAll("-", " ")}</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join("")}</available_skills>`;
  registerSkillReview(pi);
  hooks.get("before_agent_start")({prompt: "Explain the available workflows", systemPrompt, systemPromptOptions});
  return {review: tools.get("skill_review"), entries};
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

  // A topic sent as a group searches it as a query and lists the real group ids.
  const topic = await f.review.execute("browse", {action: "browse", group: "video", limit: 5});
  assert.equal(topic.isError, undefined);
  assert.equal(topic.details.unknownGroup, "video");
  assert.equal(topic.details.query, "video");
  assert.ok(topic.details.groups.includes("media"));
  assert.ok(topic.details.results.some(result => result.name === "video-editing"));
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

test("a catalogue read from the prompt text stays complete", async () => {
  const f = fixture(Array.from({length:300},(_,i)=>`fallback-${i}`));
  const found = await f.review.execute('search',{action:'search',query:'fallback-299'});
  assert.equal(found.details.results[0].name,'fallback-299');
});

test("explicit discovery keeps short domain names ahead of incidental description matches", async () => {
  const skills = [
    {name:'frontend',description:'Web libraries for server-side templating static site generators',filePath:'/fixture/skills/web/SKILL.md'},
    {name:'systems-languages',description:'Build PHP applications across development and shared hosting.',filePath:'/fixture/skills/php/SKILL.md'},
    {name:'api-security',description:'Design request contracts and HTTP responses.',filePath:'/fixture/skills/api/SKILL.md'},
    {name:'capital-planning',description:'Capital investments and financing.',filePath:'/fixture/skills/capital/SKILL.md'},
  ];
  const f = fixture([], {skills});
  const before = f.entries.length;
  // The consolidated name carries the domain term; PHP alone now lives only in its description.
  const php = await f.review.execute('search',{action:'search',query:'systems languages server-side templating static site generator'});
  assert.equal(php.details.results[0].name,'systems-languages');
  const api = await f.review.execute('search',{action:'search',query:'API',limit:8});
  assert.deepEqual(api.details.results.map(skill=>skill.name),['api-security']);
  assert.equal(f.entries.length,before,'search does not create review obligations or delivery receipts');
});
