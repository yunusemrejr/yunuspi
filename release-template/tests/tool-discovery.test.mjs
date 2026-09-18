import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
 (p) => fs.existsSync(path.join(p, "extensions/lib/tool-discovery.ts")),
);
const { registerToolDiscovery } = await import(
 pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts"))
);
// Lexical pins below stay hermetic: Jev re-ranking needs ambient network and
// is covered by the dedicated mocked test at the end of this file.
process.env.PI_JEV = "off";
function fixture(extraTools = []) {
 const hooks = {},
  entries = [],
  defs = new Map();
 let active = [
   "read",
   "bash",
   "subagent",
   "quality_review",
   "session_self",
   "project_report",
   "browser_session",
   "http_request",
   "bg_run",
   ...extraTools.map((tool) => tool.name),
  ],
  executed = 0;
 const catalog = active.map(
  (name) =>
   extraTools.find((tool) => tool.name === name) ?? {
    name,
    description:
     name === "browser_session"
      ? "Browser navigation screenshot interaction"
      : name.replaceAll("_", " "),
    parameters: { type: "object", properties: {} },
   },
 );
 const commands = [
  {
   name: "inspect",
   description: "Inspect a source file",
   source: "extension",
   sourceInfo: {
    path: "/extensions/inspect.ts",
    scope: "user",
    source: "top-level",
    origin: "top-level",
   },
  },
  {
   name: "plan",
   description: "Plan a change",
   source: "prompt",
   sourceInfo: {
    path: "/prompts/plan.md",
    scope: "project",
    source: "top-level",
    origin: "top-level",
   },
  },
  {
   name: "skill:frontend",
   description: "Frontend workflow",
   source: "skill",
   sourceInfo: {
    path: "/skills/frontend/SKILL.md",
    scope: "user",
    source: "package",
    origin: "package",
   },
  },
 ];
 const ctx = {
  cwd: "/workspace",
  sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
 };
 const api = {
  on: (name, fn) => {
   hooks[name] = fn;
  },
  getAllTools: () => catalog,
  getActiveTools: () => active,
  getCommands: () => commands.slice(),
  setActiveTools: (names) => {
   active = names;
  },
  appendEntry: (customType, data) =>
   entries.push({ type: "custom", customType, data }),
  registerTool: (def) => {
   defs.set(def.name, def);
   catalog.push(def);
   active.push(def.name);
  },
  executeTool: () => {
   executed++;
  },
 };
 registerToolDiscovery(api);
 hooks.session_start?.({}, ctx);
 return {
  hooks,
  entries,
  defs,
  api,
  ctx,
  catalog,
  active: () => active,
  executed: () => executed,
  call: (input) =>
   defs.get("tool_search").execute("id", input, undefined, undefined, ctx),
 };
}
test("startup retains essential operations and loads specialized schemas only on discovery", async () => {
 const f = fixture();
 assert.ok(
  f.active().includes("subagent") && f.active().includes("quality_review"),
 );
 assert.ok(!f.active().includes("browser_session"));
 const result = await f.call({
  query: "browser screenshot",
  limit: 1,
  enable: true,
 });
 assert.deepEqual(
  result.details.tools.map((t) => t.name),
  ["browser_session"],
 );
 assert.ok(
  !f.active().includes("browser_session"),
  "activation stages without swapping the mid-turn wire",
 );
 assert.equal(f.executed(), 0);
 assert.equal(f.entries.length, 1);
 f.hooks.before_agent_start();
 assert.ok(
  f.active().includes("browser_session"),
  "staged schemas join the wire at the run boundary",
 );
 await f.call({ names: ["browser_session"] });
 assert.equal(f.entries.length, 1, "repeat discovery adds no receipts");
});
test("unknown names cannot broaden authority, and external selection changes are respected", async () => {
 const f = fixture();
 const before = f.active().slice();
 assert.equal(
  (await f.call({ names: ["not_registered", "http_request"] })).isError,
  true,
 );
 assert.deepEqual(f.active(), before);
 f.api.setActiveTools(["read", "tool_search"]);
 assert.equal((await f.call({ names: ["http_request"] })).isError, true);
 assert.deepEqual(f.active(), ["read", "tool_search"]);
});
test("activation receipts restore on resume and separate session switches retain discovery", async () => {
 const f = fixture();
 await f.call({ names: ["http_request"] });
 f.hooks.session_start({}, f.ctx);
 assert.ok(f.active().includes("http_request"));
 const other = {
  ...f.ctx,
  sessionManager: { getSessionId: () => "session-b", getBranch: () => [] },
 };
 f.hooks.session_switch({}, other);
 assert.ok(!f.active().includes("http_request"));
 const result = await f.defs
  .get("tool_search")
  .execute("id", { names: ["http_request"] }, undefined, undefined, other);
 assert.equal(result.isError, undefined);
 f.hooks.before_agent_start();
 assert.ok(
  f.active().includes("http_request"),
  "switch does not lose original hidden catalog",
 );
});
test("child sessions and explicit opt-out preserve their original tool selection", () => {
 const oldChild = process.env.PI_SUBAGENT_CHILD,
  oldMode = process.env.PI_TOOL_DISCOVERY;
 try {
  process.env.PI_SUBAGENT_CHILD = "1";
  let f = fixture();
  assert.ok(f.active().includes("browser_session"));
  assert.equal(f.defs.size, 0);
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.PI_TOOL_DISCOVERY = "off";
  f = fixture();
  assert.ok(f.active().includes("browser_session"));
  assert.equal(f.defs.size, 0);
 } finally {
  if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = oldChild;
  if (oldMode === undefined) delete process.env.PI_TOOL_DISCOVERY;
  else process.env.PI_TOOL_DISCOVERY = oldMode;
 }
});
test("skill projection removes only the configured SDK catalog and keeps user instructions", async () => {
 const { compactSkillCatalog, skillCatalogProjectionMiss } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts"))
 );
 const skill = {
  name: "voxel-art",
  description: "Compose voxel scenes",
  filePath: "/skills/voxel-art/SKILL.md",
 };
 const block =
  "<available_skills>\n  <skill>\n    <name>voxel-art</name>\n    <description>Compose voxel scenes</description>\n    <location>/skills/voxel-art/SKILL.md</location>\n  </skill>\n</available_skills>";
 const event = {
  systemPrompt:
   "Keep the user requirement.\n" + block + "\nPreserve project conventions.",
  systemPromptOptions: { skills: [skill] },
 };
 const projected = compactSkillCatalog(event, ["skill_review"]);
 assert.ok(
  projected.startsWith("Keep the user requirement.") &&
   projected.endsWith("Preserve project conventions."),
 );
 assert.ok(projected.includes('action:"search"'));
 assert.ok(!projected.includes("<available_skills>"));
 assert.equal(
  compactSkillCatalog(event, ["read"]),
  undefined,
  "no projection when discovery is unavailable",
 );
 assert.equal(
  compactSkillCatalog(
   {
    ...event,
    systemPromptOptions: {
     skills: [{ ...skill, description: "Different registered evidence" }],
    },
   },
   ["skill_review"],
  ),
  undefined,
  "custom catalogs are not rewritten",
 );
 assert.equal(
  compactSkillCatalog(
   { ...event, systemPrompt: event.systemPrompt + "\n" + block },
   ["skill_review"],
  ),
  undefined,
  "ambiguous duplicates are preserved",
 );
 assert.equal(skillCatalogProjectionMiss(event, ["skill_review"]), null);
 assert.equal(
  skillCatalogProjectionMiss(
   {
    ...event,
    systemPromptOptions: {
     skills: [{ ...skill, description: "Different registered evidence" }],
    },
   },
   ["skill_review"],
  ),
  "block-not-exact",
  "a foreign block is reported, never rewritten",
 );
 assert.equal(
  skillCatalogProjectionMiss(
   { ...event, systemPrompt: event.systemPrompt + "\n" + block },
   ["skill_review"],
  ),
  "duplicate-blocks",
 );
 assert.equal(skillCatalogProjectionMiss(event, ["read"]), null);
});

test("group browsing and query previews do not expose schemas until a specific activation", async () => {
 const f = fixture(),
  before = f.active().slice();
 const overview = await f.call({});
 assert.ok(overview.details.groups.length > 0);
 assert.ok(!JSON.stringify(overview.details).includes("parameters"));
 const group = overview.details.groups[0].id;
 const page = await f.call({ group, limit: 1 });
 assert.ok(page.details.tools.length <= 1);
 const preview = await f.call({ query: "browser screenshot" });
 assert.equal(preview.details.tools[0].name, "browser_session");
 assert.equal(preview.details.tools[0].active, false);
 assert.deepEqual(f.active(), before);
 assert.equal(f.entries.length, 0);
 await f.call({ names: ["browser_session"] });
 assert.ok(
  !f.active().includes("browser_session"),
  "names activation stages without swapping the mid-turn wire",
 );
 f.hooks.before_agent_start();
 assert.ok(f.active().includes("browser_session"));
 assert.equal(f.executed(), 0);
 assert.equal((await f.call({ group: "not-real" })).isError, true);
});
test("default overview points to live command metadata and command pages stay bounded", async () => {
 const f = fixture();
 const overview = await f.call({});
 assert.deepEqual(
  overview.details.commands.sources.map((group) => group.id),
  ["extension", "prompt", "skill"],
 );
 assert.match(overview.details.next, /kind:"capabilities"/);
 const page = await f.call({
  kind: "commands",
  query: "workflow",
  limit: 1,
  detail: true,
 });
 assert.deepEqual(
  page.details.commands.map((command) => command.name),
  ["skill:frontend"],
 );
 assert.equal(page.details.commands[0].source, "skill");
 assert.equal(
  page.details.commands[0].sourceInfo.path,
  "/skills/frontend/SKILL.md",
 );
 assert.equal(page.details.note.includes("executed"), true);
 assert.deepEqual(f.active(), [
  "read",
  "bash",
  "subagent",
  "quality_review",
  "session_self",
  "project_report",
  "bg_run",
  "tool_search",
 ]);
 const source = await f.call({
  kind: "commands",
  group: "extension",
  limit: 1,
 });
 assert.deepEqual(
  source.details.commands.map((command) => command.name),
  ["inspect"],
 );
 assert.equal(
  (await f.call({ kind: "commands", id: "missing" })).isError,
  true,
 );
 assert.equal(
  (await f.call({ kind: "commands", names: ["inspect"] })).isError,
  true,
 );
});
test("capability index pages are bounded, source-backed on detail, and expose live tool status", async () => {
 const f = fixture();
 const page = await f.call({ kind: "capabilities", limit: 2 });
 assert.ok(page.details.capabilities.length <= 2);
 assert.ok(page.details.groups.length > 0);
 assert.ok(
  page.details.capabilities.every((capability) =>
   Array.isArray(capability.toolAvailability),
  ),
 );
 assert.equal(page.details.capabilities[1].id, "tool-catalog");
 assert.equal(
  page.details.capabilities[1].toolAvailability[0].name,
  "tool_search",
 );
 assert.equal(page.details.capabilities[1].toolAvailability[0].available, true);
 assert.equal(page.details.capabilities[1].toolAvailability[0].active, true);
 assert.deepEqual(page.details.capabilities[1].inspect, {
  kind: "capabilities",
  id: "tool-catalog",
 });
 assert.equal(
  page.details.capabilities[1].options,
  undefined,
  "summary pages omit empty detail fields",
 );
 assert.equal(page.details.nextOffset, 2);
 const detail = await f.call({ kind: "capabilities", id: "tool-catalog" });
 assert.equal(detail.details.capability.id, "tool-catalog");
 assert.ok(
  detail.details.capability.sourceFiles.some((file) =>
   file.endsWith("/agent/extensions/lib/tool-discovery.ts"),
  ),
 );
 assert.ok(
  detail.details.capability.doc.endsWith("/docs/GUIDANCE-AND-DIAGNOSTICS.md"),
 );
 const searched = await f.call({
  kind: "capabilities",
  query: "background",
  limit: 1,
 });
 assert.ok(searched.details.capabilities.length <= 1);
 assert.equal(
  (await f.call({ kind: "capabilities", group: "not-real" })).isError,
  true,
 );
 assert.equal(
  (await f.call({ kind: "capabilities", id: "not-real" })).isError,
  true,
 );
 assert.equal(
  (await f.call({ kind: "capabilities", names: ["browser_session"] })).isError,
  true,
 );
 assert.equal(f.executed(), 0);
});
test("read-only discovery follows the current active set after external or explicit selection", async () => {
 const f = fixture();
 f.api.setActiveTools(["read", "tool_search"]);
 const preview = await f.call({ query: "browser screenshot", limit: 1 });
 assert.equal(preview.isError, undefined);
 assert.deepEqual(preview.details.tools, []);
 assert.equal(
  (await f.call({ kind: "commands", query: "inspect" })).isError,
  undefined,
 );
 assert.equal(
  (await f.call({ kind: "capabilities", id: "tool-catalog" })).isError,
  undefined,
 );
 assert.equal(
  (await f.call({ names: ["http_request"], enable: false })).isError,
  true,
 );
 assert.deepEqual(f.active(), ["read", "tool_search"]);
 const oldArgv = process.argv;
 try {
  process.argv = [...oldArgv, "--tools=read,tool_search"];
  const restricted = fixture();
  restricted.api.setActiveTools(["read", "tool_search"]);
  assert.equal(
   (await restricted.call({ kind: "commands", query: "inspect" })).isError,
   undefined,
  );
  assert.equal(
   (
    await restricted.call({
     kind: "capabilities",
     query: "background",
     limit: 1,
    })
   ).isError,
   undefined,
  );
  assert.deepEqual(
   (await restricted.call({ query: "browser screenshot" })).details.tools,
   [],
  );
  assert.equal(
   (await restricted.call({ names: ["browser_session"] })).isError,
   true,
  );
  assert.deepEqual(restricted.active(), ["read", "tool_search"]);
 } finally {
  process.argv = oldArgv;
 }
});
test("discovery shortcuts reach local ML and SLM metadata without starting inference or activating tools", async () => {
 const f = fixture(),
  before = f.active().slice();
 const overview = await f.call({});
 const entry = overview.details.shortcuts.localAI;
 assert.equal(entry.tool, "tool_search");
 const detail = await f.call(entry.arguments);
 assert.equal(detail.details.capability.id, "local-intelligence");
 assert.match(detail.details.capability.summary, /optional Kompress SLM/);
 assert.ok(
  detail.details.capability.sourceFiles.every((file) => fs.existsSync(file)),
 );
 const searched = await f.call({ kind: "capabilities", query: "SLM" });
 assert.ok(
  searched.details.capabilities.some((row) => row.id === "local-intelligence"),
 );
 assert.deepEqual(f.active(), before);
 assert.equal(f.executed(), 0);
});

test("tool pages accept safe offsets beyond the old thousand item cap", async () => {
 const extra = Array.from({ length: 1105 }, (_, i) => ({
  name: `special_${String(i).padStart(4, "0")}`,
  description: "A searchable special capability",
  parameters: { type: "object", properties: {} },
 }));
 const f = fixture(extra);
 const page = await f.call({ query: "special", limit: 1, offset: 1104 });
 assert.deepEqual(
  page.details.tools.map((tool) => tool.name),
  ["special_1104"],
 );
 assert.equal(page.details.offset, 1104);
 assert.equal(page.details.remaining, 0);
});

test("explicit tool search uses domain words without incidental substring matches", async () => {
 const f = fixture([
  { name: "api_probe", description: "Inspect request contracts." },
  { name: "capital_report", description: "Capital investments and financing." },
  {
   name: "session_coordinate",
   description: "Inspect peer sessions and coordination in this workspace.",
  },
 ]);
 const api = await f.call({ query: "API", limit: 8 });
 assert.deepEqual(
  api.details.tools.map((tool) => tool.name),
  ["api_probe"],
 );
 const peers = await f.call({
  query: "session sibling coordination board peer",
  limit: 1,
 });
 assert.equal(peers.details.tools[0].name, "session_coordinate");
 assert.equal(f.entries.length, 0, "ranking changes no tool exposure");
});
test("resume bounds old discoveries, drops stale receipts and retains unresolved calls", async () => {
 const { restoredToolNames } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/tool-discovery.ts"))
 );
 const names = Array.from({ length: 40 }, (_, i) => "special_" + i),
  allowed = new Set(names);
 const receipt = {
  type: "custom",
  customType: "harness-tool-activation-v1",
  data: { names },
 };
 assert.equal(restoredToolNames([receipt], allowed).size, 6);
 const conversation = Array.from({ length: 13 }, () => ({
  type: "message",
  message: { role: "user", content: "Next task" },
 }));
 assert.equal(restoredToolNames([receipt, ...conversation], allowed).size, 0);
 const calls = {
  type: "message",
  message: {
   role: "assistant",
   content: names
    .slice(0, 8)
    .map((name, i) => ({ type: "toolCall", name, id: String(i) })),
  },
 };
 const result = {
  type: "message",
  message: { role: "toolResult", toolCallId: "0", toolName: names[0] },
 };
 assert.equal(
  restoredToolNames([calls, ...conversation], allowed).size,
  0,
  "abandoned calls before newer user turns do not pin schemas",
 );
 const restored = restoredToolNames([...conversation, calls, result], allowed);
 assert.equal(
  restored.size,
  8,
  "recent completed tool plus all seven outstanding calls survive the soft schema cap",
 );
 assert.ok(restored.has(names[0]));
 assert.ok(restored.has(names[7]));
});

test("jev rerank reorders ambiguous matches with a ledger mark", async () => {
 const { configureJevClient, resetJevClient } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/jev-client.ts"))
 );
 const seen = [];
 resetJevClient();
 configureJevClient({
  fetchImpl: async (url, opts) => {
   if (String(url).includes("/api/v1/models"))
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" };
   seen.push(JSON.parse(opts.body).model);
   return {
    ok: true,
    status: 200,
    json: async () => ({
     answers: {
      rank: { type: "choice", choice: "bravo_tool", probabilities: { bravo_tool: 0.9, alpha_tool: 0.1 }, confidence: 0.85 },
      exists: { type: "noul", noul: 0.95 },
     },
    }),
    text: async () => "",
   };
  },
 });
 const previousKey = process.env.OPENROUTER_API_KEY;
 process.env.OPENROUTER_API_KEY = "sk-or-test";
 delete process.env.PI_JEV;
 try {
  const f = fixture([
   { name: "alpha_tool", description: "Handle fruit inventory." },
   { name: "bravo_tool", description: "Handle fruit exports." },
  ]);
  const page = await f.call({ query: "fruit", limit: 8 });
  const names = page.details.tools.map((tool) => tool.name);
  assert.ok(names.includes("alpha_tool") && names.includes("bravo_tool"));
  assert.ok(names.indexOf("bravo_tool") < names.indexOf("alpha_tool"), "jev order wins");
  assert.equal(seen[0], "~typesafe/jev-latest");
  assert.match(page.details.jev.mark, /successfully routed with Jev/);
  assert.equal(page.details.jev.top, "bravo_tool");
  assert.ok(f.entries.some((entry) => entry.customType === "jev-usage-v1"), "ledger entry appended");
 } finally {
  process.env.PI_JEV = "off";
  if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousKey;
  resetJevClient();
 }
});
