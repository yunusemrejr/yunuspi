import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-routing-test-runtime-"));
process.env.PI_PROVIDER_STATE_FILE = path.join(runtimeRoot, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(runtimeRoot, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(runtimeRoot, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

const { createModelRoutingEditorServer } = await import("../agent/extensions/model-routing-config.ts");
const { scoreModelRoutingSearch } = await import("../agent/extensions/lib/model-routing-store.ts");
const { chromium } = await import("playwright");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-routing-ui-"));
  const configPath = path.join(root, "settings", "llm_preferences.json");
  const models = [
    { provider: "openrouter", id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 131072, maxTokens: 8192, reasoning: true, input: ["text"], cost: { knownFree: true } },
    { provider: "openrouter", id: "z-ai/glm-3.5-flash", name: "GLM-3.5-Flash", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ["text"] },
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", contextWindow: 65536, maxTokens: 8192, reasoning: false, input: ["text"] },
    { provider: "openrouter", id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ["text"] },
    { provider: "openrouter", id: "deepseek/deepseek-flash", name: "DeepSeek Flash", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 65536, maxTokens: 8192, reasoning: false, input: ["text"] },
    { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com", contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ["text"] },
    { provider: "friendli", id: "zai-org/GLM-5.3-Flash", name: "GLM-5.3-Flash", api: "openai-completions", baseUrl: "https://api.friendli.ai/serverless/v1", contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ["text"] },
  ];
  const doc = {
    version: 1,
    models: { first: { provider: "openrouter", model: "z-ai/glm-5.3-flash", manualExtension: { keep: true } } },
    preferences: {
      subagents: { models: ["first"], customPreferenceField: "preserve" },
      "Quality-Review": { models: ["first"], manualRoleField: "keep" },
    },
    manualTopLevelField: { keep: true },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2), { mode: 0o600 });
  const ctx = { modelRegistry: { getAll: () => models, getAvailable: () => models }, hasUI: true };
  const resolver = (_ctx, role) => ({
    source: role === "prompt_analysis" ? "subagents" : role,
    skipped: role === "subagents" ? [{ priority: 1, route: "openrouter/missing", reason: "unavailable in this session's model registry" }] : [],
    routes: role === "subagents" ? [{ route: "openrouter/z-ai/glm-5.3-flash", providerRouting: undefined, explanation: ["fixture"] }] : [],
  });
  return { root, configPath, models, doc, ctx, resolver };
}

function headers(url, token) {
  const origin = new URL(url).origin;
  return { origin, "content-type": "application/json", "x-model-routing-token": token };
}
async function post(url, token, endpoint, body, extraHeaders = {}) {
  return fetch(`${url.replace(/\/[a-f0-9]{64}$/, "")}/${token}/api/${endpoint}`, {
    method: "POST", headers: { ...headers(url, token), ...extraHeaders }, body: JSON.stringify(body),
  });
}
async function openPage(t, url, viewport = { width: 1280, height: 900 }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport });
  await page.goto(url);
  return page;
}

 test("search distinguishes compact versions and requires provider specificity", () => {
  const glm53 = { provider: "openrouter", id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash", enabled: true };
  const glm35 = { provider: "openrouter", id: "z-ai/glm-3.5-flash", name: "GLM-3.5-Flash", enabled: true };
  assert.ok(scoreModelRoutingSearch("openrouter glm53", glm53) > 0);
  assert.equal(scoreModelRoutingSearch("openrouter glm53", glm35), 0);
  const deepseek = { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", enabled: true };
  const thirdParty = { provider: "openrouter", id: "deepseek/deepseek-flash", name: "DeepSeek Flash", enabled: true };
  assert.ok(scoreModelRoutingSearch("deepseek flash official", deepseek) > 0);
  assert.equal(scoreModelRoutingSearch("deepseek flash official", thirdParty), 0);
  assert.ok(scoreModelRoutingSearch("deepseek openruter flash", thirdParty) > 0);
  assert.ok(scoreModelRoutingSearch("h4 openrouter", { provider: "openrouter", id: "nousresearch/hermes-4", name: "Hermes 4", enabled: true }) > 0);
});

test("a named provider outranks an equivalent saved upstream pin", () => {
  const openrouter = { provider: "openrouter", id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash", enabled: true };
  const together = { provider: "together", id: "zai-org/GLM-5.3-Flash", name: "GLM-5.3-Flash", enabled: true };
  for (const query of ["together glm flash", "glm 5.3 flash together", "togetherai glm53 flash", "together ai glm 5.3 flash"]) {
    const ranked = [openrouter, together]
      .map(model => ({ model, score: scoreModelRoutingSearch(query, model, [], ["together"]) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.model.provider.localeCompare(b.model.provider));
    assert.ok(ranked.length > 0, query);
    assert.equal(ranked[0].model.provider, "together", `${query} must rank the real provider first`);
  }
  // The OpenRouter route with the same upstream stays selectable, just behind it.
  assert.ok(scoreModelRoutingSearch("together glm flash", openrouter, [], ["together"]) > 0);
});

test("the graphical editor accepts every canonical server role alias", async () => {
  const { renderModelRoutingEditor } = await import("../agent/extensions/model-routing-config.ts");
  const { normalizePreferenceRole } = await import("../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts");
  const html = renderModelRoutingEditor({
    ok: true, revision: "0".repeat(64), exists: true, configPath: "/tmp/llm_preferences.json", backupAvailable: false,
    document: { version: 1, models: {}, preferences: {} }, models: [], roles: [], resolvedByRole: {}, routingMetrics: {},
  }, "token", "nonce");
  const match = html.match(/const canonicalRole=x=>\(\{([\s\S]*?)\}\[roleId\(x\)\]\|\|roleId\(x\)\)/);
  assert.ok(match, "the client role normalizer must be present in the rendered page");
  const roleId = value => String(value).trim().toLowerCase().replace(/[-_\s]+/g, "");
  const canonicalRole = new Function("roleId", `return x=>({${match[1]}}[roleId(x)]||roleId(x))`)(roleId);
  for (const alias of ["main", "main_fallback", "main_session_fallback", "subagent", "subagents", "swarms", "councils",
    "quality_reviews", "project_reviews", "error_reviews", "bug_review", "bug_reviews", "prompt_analysis",
    "initial_intent_analysis", "follow_up_intent_analysis", "session_observer", "Session Observer"]) {
    assert.equal(canonicalRole(alias), normalizePreferenceRole(alias), alias);
  }
});

test("observer GUI edits the canonical role, thinking and opt-out without changing other preferences", async t => {
  const f = fixture();
  f.models.find(model => model.provider === "deepseek").reasoning = true;
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "Session Observer", exact: true }).click();
  await page.getByText("Default: official DeepSeek Flash, high thinking.", { exact: true }).waitFor();
  assert.match(await page.locator(".diagnostics:not(#routing-diagnostics)").innerText(), /deepseek\/deepseek-flash/);

  await page.getByRole("button", { name: "Disable observer", exact: true }).press("Enter");
  await page.getByRole("status").filter({ hasText: "Observer disabled." }).waitFor();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")).preferences.session_observer.models, []);
  await page.getByText("Observer is disabled.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reset role", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Role reset" }).waitFor();
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.configPath, "utf8")).preferences, "session_observer"), false);
  await page.getByText("Default: official DeepSeek Flash, high thinking.", { exact: true }).waitFor();

  await page.getByRole("searchbox", { name: "Search models" }).fill("deepseek flash official");
  await page.locator(".result").filter({ hasText: "DeepSeek Official API" }).getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Route saved to Session Observer" }).waitFor();
  let saved = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(saved.preferences.session_observer.models, [{ provider: "deepseek", model: "deepseek-flash", thinking: "high" }]);
  const thinking = page.getByRole("combobox", { name: "Observer thinking" });
  assert.equal(await thinking.inputValue(), "high");
  assert.equal(await page.locator("#editor > .notice").count(), 0, "ordinary observer routing is plain prose, not a warning");
  assert.equal(await page.locator(".route-row .first").count(), 0, "route ordinal already conveys first choice");
  await thinking.selectOption("medium");
  await page.getByRole("status").filter({ hasText: "Observer thinking saved" }).waitFor();
  saved = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.equal(saved.preferences.session_observer.models[0].thinking, "medium");
  assert.deepEqual(saved.models, f.doc.models);
  assert.deepEqual(saved.preferences.subagents, f.doc.preferences.subagents);
  assert.deepEqual(saved.preferences["Quality-Review"], f.doc.preferences["Quality-Review"]);
  assert.deepEqual(saved.manualTopLevelField, f.doc.manualTopLevelField);
  await page.screenshot({ path: "/var/tmp/yunuspi-session-observer-wide.png", fullPage: true });

  await page.reload();
  await page.getByRole("button", { name: "Session Observer", exact: true }).click();
  assert.equal(await thinking.inputValue(), "medium", "reloading preserves thinking from canonical JSON");
  await page.setViewportSize({ width: 356, height: 820 });
  await thinking.focus();
  assert.equal(await thinking.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "observer controls fit narrow screens");
  await page.screenshot({ path: "/var/tmp/yunuspi-session-observer-narrow.png", fullPage: true });
  assert.deepEqual(errors, []);
});

test("observer resolver preview enforces the runtime context and output capacity", async t => {
  const f = fixture();
  const model = f.models.find(model => model.provider === "deepseek");
  model.reasoning = true;
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  for (const capacity of [{ contextWindow: 8192, maxTokens: 8192 }, { contextWindow: 12287, maxTokens: 4096 }, { contextWindow: 12288, maxTokens: 2048 }, { contextWindow: 12288, maxTokens: 4096, api: "openai-codex-responses" }]) {
    Object.assign(model, capacity);
    const snapshot = await (await post(handle.url, token, "snapshot", {})).json();
    assert.equal(snapshot.resolvedByRole.session_observer.status, "unavailable");
    assert.deepEqual(snapshot.resolvedByRole.session_observer.routes, []);
  }
  Object.assign(model, { contextWindow: 12288, maxTokens: 4096, api: "openai-completions" });
  const ready = await (await post(handle.url, token, "snapshot", {})).json();
  assert.equal(ready.resolvedByRole.session_observer.status, "ready");
});

test("observer thinking edits honor suffix precedence and preserve shared aliases", async t => {
  const f = fixture();
  f.models.find(model => model.provider === "deepseek").reasoning = true;
  f.doc.models.observer = { provider: "deepseek", model: "deepseek-flash:high", thinking: "low", futureField: "preserve" };
  f.doc.preferences.session_observer = { models: ["observer"] };
  fs.writeFileSync(f.configPath, JSON.stringify(f.doc));
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  await page.getByRole("button", { name: "Session Observer", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Observer thinking" }).inputValue(), "high");
  assert.match(await page.locator(".route-row > .route-meta").innerText(), /resolver accepts this route/);
  await page.getByRole("combobox", { name: "Observer thinking" }).selectOption("off");
  await page.getByRole("status").filter({ hasText: "Observer thinking saved" }).waitFor();
  const saved = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(saved.models, f.doc.models);
  assert.deepEqual(saved.preferences.session_observer.models, [{ provider: "deepseek", model: "deepseek-flash", thinking: "off", futureField: "preserve" }]);
});

test("production server renders the routing GUI and serves verified, persistent upstream variants", async t => {
  const f = fixture();
  let endpointReads = 0;
  const handle = await createModelRoutingEditorServer(f.ctx, {
    configPath: f.configPath,
    resolveRole: f.resolver,
    endpointLoader: async id => {
      endpointReads++;
      assert.equal(id, "z-ai/glm-5.3-flash");
      return [{ tag: "together", provider_name: "Together AI", status: 0, context_length: 131072, max_completion_tokens: 8192 }];
    },
  });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await fetch(handle.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await page.text();
  assert.match(html, /Prompt Analysis/);
  assert.match(html, /function renderTrace/);
  assert.match(html, /Priority /);
  const token = new URL(handle.url).pathname.slice(1);

  let response = await post(handle.url, token, "search", { query: "openrouter glm53", role: "subagents" });
  assert.equal(response.status, 200);
  assert.equal(endpointReads, 0, "model-only queries do not make an upstream network request");
  let result = await response.json();
  assert.equal(result.models[0].id, "z-ai/glm-5.3-flash");
  assert.ok(!result.models.some(item => item.id === "z-ai/glm-3.5-flash"));
  response = await post(handle.url, token, "search", { query: "google gemini official", role: "subagents" });
  result = await response.json();
  assert.ok(result.models.some(item => item.provider === "google"));
  assert.ok(!result.models.some(item => item.provider === "openrouter"), "official direct routes are never re-ranked through an unrelated provider");
  assert.equal(endpointReads, 0, "direct-provider searches do not trigger upstream discovery");
  response = await post(handle.url, token, "search", { query: "deepseek flash deepseek", role: "subagents" });
  result = await response.json();
  assert.equal(result.models[0].provider, "deepseek", "repeated direct-provider intent favors official DeepSeek over its OpenRouter catalog twin");
  assert.ok(result.models.findIndex(item => item.provider === "openrouter") > 0);
  response = await post(handle.url, token, "search", { query: "glm flash friendli", role: "subagents" });
  result = await response.json();
  assert.equal(result.models[0].provider, "friendli", "without OpenRouter in the query, Friendli means its direct route");
  assert.equal(endpointReads, 0);

  response = await post(handle.url, token, "search", { query: "openrouter glm53 togetherai", role: "subagents" });
  result = await response.json();
  assert.equal(endpointReads, 1);
  const variant = result.models.find(item => item.selectedProviderRouting?.only?.[0] === "together");
  assert.equal(variant.upstreamName, "Together AI");
  assert.match(variant.routeAvailability, /Verified in current/);
  assert.equal(variant.fullId, "openrouter/z-ai/glm-5.3-flash", "the route remains a real registry identifier");

  const changed = structuredClone(f.doc);
  changed.models.first.provider_options = { routing: "pinned", order: ["together"] };
  const { readModelRoutingSnapshot } = await import("../agent/extensions/lib/model-routing-store.ts");
  const revision = readModelRoutingSnapshot(f.configPath, f.ctx.modelRegistry).revision;
  response = await post(handle.url, token, "save", { revision, document: changed });
  assert.equal(response.status, 200);
  const saved = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(saved.models.first.provider_options, { routing: "pinned", order: ["together"] });
  assert.deepEqual(saved.models.first.manualExtension, { keep: true });
  assert.deepEqual(saved.manualTopLevelField, { keep: true });
  assert.equal(saved.preferences.subagents.customPreferenceField, "preserve");
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(`${f.configPath}.bak`, "utf8")).models.first.provider_options, undefined);

  const badOrigin = await post(handle.url, token, "snapshot", {}, { origin: "http://attacker.invalid" });
  assert.equal(badOrigin.status, 403);
  const noCapability = await fetch(`${new URL(handle.url).origin}/${token}/api/snapshot`, { method: "POST", headers: { origin: new URL(handle.url).origin, "content-type": "application/json" }, body: "{}" });
  assert.equal(noCapability.status, 403);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(async () => { await browser.close(); });
  const pageView = await browser.newPage();
  await pageView.goto(handle.url);
  await pageView.locator(".route-row").waitFor();
  assert.match(await pageView.locator(".diagnostics:not(#routing-diagnostics)").innerText(), /Priority 1 skipped/);
  await pageView.locator("#routing-diagnostics summary").click();
  assert.match(await pageView.locator("#routing-metrics").innerText(), /Config load/);
  await pageView.getByRole("button", { name: "Refresh diagnostics" }).click();
  await pageView.getByRole("status").filter({ hasText: "Routing diagnostics refreshed" }).waitFor();
  await pageView.getByRole("button", { name: "Prompt Analysis" }).click();
  assert.match(await pageView.locator("#editor").innerText(), /inherits the Subagents ordered routes/);
  await pageView.getByRole("button", { name: "Quality Reviews" }).click();
  assert.equal(await pageView.locator(".route-row").count(), 1, "hyphenated manual role keys are displayed as their canonical role");
  await pageView.locator('.route-row button[data-action="remove"]').click();
  await pageView.getByRole("status").filter({ hasText: "Model routing configuration updated" }).waitFor();
  let roleDoc = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(roleDoc.preferences["Quality-Review"].models, []);
  assert.equal(roleDoc.preferences["Quality-Review"].manualRoleField, "keep");
  assert.equal(Object.hasOwn(roleDoc.preferences, "quality_review"), false, "the editor updates the existing manual key in place");
  await pageView.getByRole("button", { name: "Subagents" }).click();
  // The saved alias already pins this exact route; clear the list so the add
  // below starts from a unique state.
  await pageView.locator('.route-row button[data-action="remove"]').click();
  await pageView.getByRole("status").filter({ hasText: "Model routing configuration updated" }).waitFor();
  const search = pageView.getByRole("searchbox", { name: "Search models" });
  await search.fill("openrouter glm53 together");
  await pageView.getByText("Verified in current OpenRouter endpoint registry").waitFor();
  const togetherRow = pageView.locator(".result").filter({ hasText: "OpenRouter → Together AI" }).first();
  await togetherRow.getByRole("button", { name: "Add" }).click();
  await pageView.getByRole("status").filter({ hasText: "Model routing configuration updated" }).waitFor();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")).preferences.subagents.models.at(-1).provider_options, { routing: "pinned", order: ["together"] });
  assert.equal(await pageView.evaluate(() => document.activeElement?.closest(".result") !== null), true, "save rerender preserves focus on the selected result action");
  // The identical route already occupies priority 1: the editor refuses a
  // duplicate instead of writing a second identical entry.
  await pageView.locator(".result").filter({ hasText: "OpenRouter → Together AI" }).first().getByRole("button", { name: "Add" }).click();
  await pageView.getByRole("status").filter({ hasText: "already priority" }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).preferences.subagents.models.length, 1, "an exact duplicate route is never appended");
  await pageView.close();
});

test("offline upstream lookup keeps configured pins visible and reports the outage", async t => {
  const f = fixture();
  const configured = structuredClone(f.doc);
  configured.models.first.provider_options = { routing: "pinned", order: ["together"] };
  fs.writeFileSync(f.configPath, JSON.stringify(configured, null, 2));
  const handle = await createModelRoutingEditorServer(f.ctx, {
    configPath: f.configPath,
    resolveRole: f.resolver,
    endpointLoader: async () => { throw new Error("offline"); },
  });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  const response = await post(handle.url, token, "search", { query: "openrouter glm53 together", role: "subagents" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.endpointWarning, /lookup failed/);
  const variant = result.models.find(item => item.selectedProviderOptions?.order?.[0] === "together");
  assert.ok(variant, "an existing configured pin remains selectable without network access");
  assert.match(variant.routeAvailability, /not checked/);
  assert.equal(variant.selectedProviderRouting.only[0], "together");
});

test("search offers OpenRouter upstreams only for an exact available endpoint tag", async t => {
  const f = fixture();
  let calls = 0;
  const handle = await createModelRoutingEditorServer(f.ctx, {
    configPath: f.configPath,
    resolveRole: f.resolver,
    endpointLoader: async () => { calls++; return [{ tag: "friendli", provider_name: "Friendli AI", status: 0 }]; },
  });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  const response = await post(handle.url, token, "search", { query: "openrouter glm53 togetherai", role: "subagents" });
  const result = await response.json();
  assert.ok(calls > 0, "explicit upstream intent performs lazy endpoint discovery");
  assert.ok(result.models.some(item => item.id === "z-ai/glm-5.3-flash"), "base OpenRouter route remains available");
  assert.ok(!result.models.some(item => item.selectedProviderRouting?.only?.[0] === "together"), "no endpoint tag means no selectable Together variant");
});

test("endpoint lookup timeout returns base search results with an honest warning", async t => {
  const f = fixture();
  let signal;
  const handle = await createModelRoutingEditorServer(f.ctx, {
    configPath: f.configPath,
    resolveRole: f.resolver,
    endpointTimeoutMs: 100,
    endpointLoader: async (_id, requestSignal) => { signal = requestSignal; return new Promise(() => {}); },
  });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  const started = performance.now();
  const response = await post(handle.url, token, "search", { query: "openrouter glm53 together", role: "subagents" });
  const result = await response.json();
  assert.ok(performance.now() - started < 2000, "request does not wait indefinitely for upstream metadata");
  assert.match(result.endpointWarning, /timed out/);
  assert.ok(result.models.some(item => item.provider === "openrouter"), "base route results survive endpoint service timeout");
  assert.equal(signal?.aborted, true, "timed out endpoint loader receives cancellation");
  assert.ok(result.routingMetrics.latency.search.lastMs >= 0);
});

test("malformed JSON is read-only until the valid backup is restored", async t => {
  const f = fixture();
  const backup = structuredClone(f.doc);
  const malformed = Buffer.from('{"version":1,,broken');
  fs.writeFileSync(f.configPath, malformed);
  fs.writeFileSync(`${f.configPath}.bak`, JSON.stringify(backup, null, 2), { mode: 0o600 });
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  assert.match(await page.locator("#editor").innerText(), /Editing is blocked/);
  assert.equal(await page.getByRole("button", { name: "Reset role" }).isDisabled(), true);
  assert.equal(fs.readFileSync(f.configPath).compare(malformed), 0, "opening the editor never overwrites malformed bytes");
  await page.getByRole("button", { name: "Restore previous file" }).click();
  await page.getByRole("status").filter({ hasText: "Model routing configuration updated" }).waitFor();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")), backup);
});

test("invalid pinned route is rejected in the UI without writing JSON", async t => {
  const f = fixture();
  const original = fs.readFileSync(f.configPath);
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  await page.locator('.route-row [data-field="routing"]').first().selectOption("pinned");
  await page.getByRole("status").filter({ hasText: "Pinned routing needs at least one OpenRouter provider slug" }).waitFor();
  assert.equal(fs.readFileSync(f.configPath).compare(original), 0, "invalid pin state is never submitted or persisted");
});

test("external JSON edits conflict safely and reload before the next save", async t => {
  const f = fixture();
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  const external = structuredClone(f.doc);
  external.manualConcurrentEdit = { preserved: true };
  fs.writeFileSync(f.configPath, JSON.stringify(external, null, 2), { mode: 0o600 });
  await page.locator('.route-row button[data-action="remove"]').first().click();
  await page.getByRole("status").filter({ hasText: "file changed on disk" }).waitFor();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, "utf8")).manualConcurrentEdit, { preserved: true });
  await page.getByRole("button", { name: "Reload latest JSON" }).click();
  await page.getByRole("status").filter({ hasText: "Latest JSON loaded" }).waitFor();
  await page.locator('.route-row button[data-action="remove"]').first().click();
  await page.getByRole("status").filter({ hasText: "Model routing configuration updated" }).waitFor();
  const saved = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(saved.manualConcurrentEdit, { preserved: true });
  assert.deepEqual(saved.manualTopLevelField, { keep: true });
});

test("actual HTTP search measures a realistic 12,000 model registry", async t => {
  const f = fixture();
  const models = Array.from({ length: 12_000 }, (_, index) => ({
    provider: "openrouter", id: `fixture/model-${index}`, name: `Synthetic Model ${index}`,
    api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 32768,
  }));
  f.ctx.modelRegistry = { getAll: () => models, getAvailable: () => models };
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  const started = performance.now();
  const response = await post(handle.url, token, "search", { query: "openrouter synthetic11999", role: "subagents" });
  const elapsed = performance.now() - started;
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.models[0].id, "fixture/model-11999");
  assert.ok(elapsed < 3000, `12k-registry HTTP search took ${elapsed.toFixed(1)} ms`);
  assert.ok(result.routingMetrics.latency.search.lastMs >= 0);
  assert.ok(result.routingMetrics.latency.search.count > 0);
});

test("narrow role route metadata stays in the readable content column", async t => {
  const f = fixture();
  const doc = structuredClone(f.doc);
  doc.models.first.provider_options = { routing: "pinned", order: ["together"] };
  fs.writeFileSync(f.configPath, JSON.stringify(doc, null, 2));
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url, { width: 356, height: 820 });
  const metadata = page.locator(".route-row > .route-meta").first();
  assert.equal(await metadata.evaluate(el => getComputedStyle(el).gridColumnStart), "2");
  assert.match(await metadata.innerText(), /Pinned to together/);
  assert.ok(await metadata.evaluate(el => el.getBoundingClientRect().width > 100));
});

test("real resolver traces the edited document and browser role edits preserve shared aliases", async t => {
  const f = fixture();
  f.doc.models.first.provider_options = { routing: "custom", order: ["together"] };
  f.doc.preferences.swarm = { models: ["first", { provider: "deepseek", model: "deepseek-flash" }] };
  f.doc.preferences.custom_future_role = { models: ["first"] };
  fs.writeFileSync(f.configPath, JSON.stringify(f.doc));
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  let snapshot = await (await post(handle.url, token, "snapshot", {})).json();
  assert.equal(snapshot.resolvedByRole.subagents.routes[0]?.route, "openrouter/z-ai/glm-5.3-flash", "the production resolver uses this editor's canonical JSON path");
  assert.equal(snapshot.resolvedByRole.prompt_analysis.source, "subagents");
  assert.equal(snapshot.roles.find(role => role.id === "customfuturerole")?.id, "customfuturerole");
  const page = await openPage(t, handle.url);
  assert.match(await page.locator(".route-row > .route-meta").innerText(), /resolver accepts this route/);
  assert.equal(await page.locator('[data-field="fallbacks"]').isChecked(), true, "omitted custom allow_fallbacks displays the runtime default");
  await page.locator('[data-field="order"]').fill("friendli");
  await page.locator('[data-field="order"]').press("Tab");
  await page.getByRole("status").filter({ hasText: "Provider routing saved" }).waitFor();
  const edited = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(edited.models.first, f.doc.models.first, "editing this role does not alter an alias used by other roles");
  assert.equal(edited.preferences["Quality-Review"].models[0], "first");
  assert.deepEqual(edited.preferences.subagents.models[0].provider_options, { routing: "custom", order: ["friendli"], allow_fallbacks: true });
  assert.deepEqual(edited.preferences.subagents.models[0].manualExtension, { keep: true });
  await page.getByRole("button", { name: "Swarm", exact: true }).click();
  await page.locator('.route-row').first().getByRole('button', { name: /Move .* down/ }).click();
  await page.getByRole("status").filter({ hasText: "Priority order updated" }).waitFor();
  snapshot = await (await post(handle.url, token, "snapshot", {})).json();
  assert.deepEqual(snapshot.resolvedByRole.swarm.routes.map(route => route.route), ["deepseek/deepseek-flash", "openrouter/z-ai/glm-5.3-flash"]);
  await handle.close();
  const restarted = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(() => restarted.close());
  const reopened = await openPage(t, restarted.url);
  await reopened.getByRole("button", { name: "Swarm", exact: true }).click();
  assert.equal(await reopened.locator(".route-row").first().getAttribute("data-route"), "deepseek/deepseek-flash", "restart and reopen retain the saved priority");
});

test("malformed provider options render an actionable editor instead of crashing its script", async t => {
  const f = fixture();
  f.doc.models.first.provider_options = { routing: "pinned", order: "together" };
  fs.writeFileSync(f.configPath, JSON.stringify(f.doc));
  const before = fs.readFileSync(f.configPath);
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => { await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const page = await openPage(t, handle.url);
  assert.match(await page.locator("#editor").innerText(), /strict GUI validation/);
  assert.equal(await page.locator(".route-row").count(), 1);
  assert.equal(fs.readFileSync(f.configPath).compare(before), 0);
});

test("HTTP editor callbacks retain their owning session's routing metrics", async t => {
  const { withSessionObservability } = await import("@yunuspi/coding-agent");
  const f = fixture();
  const make = sessionId => {
    const ctx = { ...f.ctx, sessionManager: { getSessionId: () => sessionId } };
    return withSessionObservability(ctx, () => createModelRoutingEditorServer(ctx, { configPath: f.configPath, resolveRole: f.resolver }));
  };
  const a = await make("routing-session-a"), b = await make("routing-session-b");
  t.after(async () => { await Promise.all([a.close(), b.close()]); fs.rmSync(f.root, { recursive: true, force: true }); });
  const tokenA = new URL(a.url).pathname.slice(1), tokenB = new URL(b.url).pathname.slice(1);
  await post(a.url, tokenA, "search", { query: "friendli glm" });
  const metricsA = await (await post(a.url, tokenA, "metrics", {})).json();
  const metricsB = await (await post(b.url, tokenB, "metrics", {})).json();
  assert.equal(metricsA.routingMetrics.latency.search.count, 1);
  assert.equal(metricsB.routingMetrics.latency.search.count, 0, "another server cannot observe this session's searches");
});

test('configured routes lead search, failed and unconfigured routes are labelled, and selection preserves exact identity', async t => {
  const f = fixture();
  const providers = ['xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'];
  const models = providers.map(provider => ({ ...f.models[0], provider, id: 'mimo-v2.6-flash', name: 'MiMo v2.6 Flash', baseUrl: 'https://example.invalid/v1' }));
  f.ctx.modelRegistry = { getAll: () => models, getAvailable: () => models.filter(model => ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'].includes(model.provider)), getProviderAuthStatus: provider => ({ configured: ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'].includes(provider) }) };
  const { recordModelFailure, clearExclusions } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-exclusions.ts');
  recordModelFailure({ provider: 'xiaomi-token-plan-cn', modelId: 'mimo-v2.6-flash', reason: 'model-not-found', ttlMs: 60_000 });
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath, resolveRole: f.resolver });
  t.after(async () => { clearExclusions(); await handle.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const token = new URL(handle.url).pathname.slice(1);
  const response = await post(handle.url, token, 'search', { query: 'mimo flash', role: 'prompt_analysis' });
  const result = await response.json();
  assert.equal(result.models[0].provider, 'xiaomi-token-plan-sgp');
  assert.deepEqual(result.models.map(model => model.availability), ['available', 'blocked', 'unconfigured', 'unconfigured']);
  assert.match(result.models[1].availabilityLabel, /failure exclusion/);
  assert.match(result.models[2].availabilityLabel, /provider not configured/);
  for (const query of ['xiaomi-token-plan-sgp', 'xiaomi-token-plan-sgp/mimo-v2.6-flash', 'XIAOMI-TOKEN-PLAN-SGP/MIMO-V2.6-FLASH', 'xiaomi-token-plan-sgp mimo flash', 'mimo flash XIAOMI-TOKEN-PLAN-SGP']) {
    const exact = await (await post(handle.url, token, 'search', { query, role: 'prompt_analysis' })).json();
    assert.deepEqual(exact.models.map(model => model.fullId), ['xiaomi-token-plan-sgp/mimo-v2.6-flash'], `exact provider/route search: ${query}`);
  }
  const missing = await (await post(handle.url, token, 'search', { query: 'xiaomi-token-plan-unknown/mimo-v2.6-flash', role: 'prompt_analysis' })).json();
  assert.deepEqual(missing.models, [], 'unknown provider never loses its identity to a model-only match');
  const wrongVersion = await (await post(handle.url, token, 'search', { query: 'xiaomi-token-plan-sgp mimo-v2.5-flash', role: 'prompt_analysis' })).json();
  assert.deepEqual(wrongVersion.models, [], 'provider extraction does not drop an unmatched model/version term');
  const broad = await (await post(handle.url, token, 'search', { query: 'xiaomi', role: 'prompt_analysis' })).json();
  assert.equal(broad.models[0].provider, 'xiaomi-token-plan-sgp', 'broad brand searches retain configured regional routes');
  const { compareModelRoutingSearch } = await import('../agent/extensions/lib/model-routing-store.ts');
  assert.ok(compareModelRoutingSearch({ model: result.models[0], score: 1 }, { model: result.models[2], score: 1000 }) < 0, 'text match strength cannot put an unconfigured route ahead of a matching ready route');
  const page = await openPage(t, handle.url);
  await page.getByRole('searchbox', { name: 'Search models' }).fill('mimo flash');
  await page.locator('.result').nth(3).waitFor();
  assert.match(await page.locator('.result').first().innerText(), /xiaomi-token-plan-sgp\/mimo-v2\.6-flash/);
  assert.match(await page.locator('.result').nth(1).innerText(), /Add \(unavailable\)/);
  assert.match(await page.locator('.result').nth(2).innerText(), /Add \(not configured\)/);
  await page.locator('.result').first().getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Model routing configuration updated' }).waitFor();
  const saved = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.deepEqual(saved.preferences.subagents.models.at(-1), { provider: 'xiaomi-token-plan-sgp', model: 'mimo-v2.6-flash' });
});

test('catalog visibility never mislabels unavailable or unknown authentication as unconfigured', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { readModelRoutingSnapshot } = await import('../agent/extensions/lib/model-routing-store.ts');
  const configured = readModelRoutingSnapshot(f.configPath, { getAll: () => [f.models[0]], getAvailable: () => [], getProviderAuthStatus: () => ({ configured: true }) });
  assert.equal(configured.models[0].availability, 'unavailable');
  assert.match(configured.models[0].availabilityLabel, /Configured provider · model not available/);
  const unknown = readModelRoutingSnapshot(f.configPath, { getAll: () => [f.models[0]], getAvailable: () => [] });
  assert.equal(unknown.models[0].availability, 'unavailable');
  assert.match(unknown.models[0].availabilityLabel, /availability not confirmed/);
});

test('opening and refreshing the editor keeps unavailable preferences visible without runtime warning or health events', async t => {
  const f = fixture();
  f.doc.preferences.prompt_analysis = { models: [{ provider: 'unconfigured-region', model: 'fixture-flash' }] };
  fs.writeFileSync(f.configPath, JSON.stringify(f.doc));
  const warnings = [], activity = [], key = Symbol.for('yunus-pi.health.v1');
  const originalWarn = console.warn, originalSink = globalThis[key];
  console.warn = message => warnings.push(String(message));
  globalThis[key] = (kind, data) => activity.push({ kind, data });
  const handle = await createModelRoutingEditorServer(f.ctx, { configPath: f.configPath });
  t.after(async () => {
    console.warn = originalWarn;
    if (originalSink === undefined) delete globalThis[key]; else globalThis[key] = originalSink;
    await handle.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });
  const page = await openPage(t, handle.url);
  await page.getByRole('button', { name: 'Prompt Analysis', exact: true }).click();
  assert.match(await page.locator('.diagnostics:not(#routing-diagnostics)').innerText(), /unconfigured-region.*no models/);
  const token = new URL(handle.url).pathname.slice(1);
  const response = await post(handle.url, token, 'snapshot', {});
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.ok(snapshot.resolvedByRole.prompt_analysis.skipped.some(item => item.route === 'unconfigured-region/fixture-flash'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(activity, []);
});
