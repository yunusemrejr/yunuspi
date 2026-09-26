import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quality-routing-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "exclusions.json");
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, "missing-preferences.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) =>
 fs.existsSync(
  path.join(p, "extensions/pi-subagents/src/runs/shared/model-quality.ts"),
 ),
);
if (!agent) throw new Error("Model routing source is missing");
const shared = pathToFileURL(
 path.join(agent, "extensions/pi-subagents/src/runs/shared/"),
).href;
const { selectAffordableModel, refreshModelRankingCache, readRankCache } =
 await import(shared + "model-selection.ts");
const {
 assessModelQuality,
 compareModelVersions,
 taskQuality,
 QUALITY_TTL_MS,
} = await import(shared + "model-quality.ts");
const {
 publishFreeEvidence,
 publishProviderFreeEvidence,
 FREE_CATALOG_URL,
 ORCA_PRICING_URL,
} = await import(shared + "free-route-evidence.ts");
const { planAssistance, selectAssistanceTeam } = await import(
 shared + "assistance-plan.ts"
);
const { unreliableRoutes } = await import(shared + "run-history.ts");
const { artificialAnalysisEvidence, modelCardEvidence, refreshModelResearch } =
 await import(shared + "model-research.ts");
const { loadModelEconomyConfig } = await import(shared + "model-economy.ts");
const { buildModelCandidates } = await import(shared + "model-fallback.ts");
const { clearLlmPreferencesCache } = await import(
 shared + "llm-preferences.ts"
);
const cfg = loadModelEconomyConfig(),
 at = Date.now();
const model = (id, provider = "openrouter", price = 0) => ({
 provider,
 id,
 fullId: `${provider}/${id}`,
 api: "openai-completions",
 baseUrl:
  provider === "openrouter"
   ? "https://openrouter.ai/api/v1"
   : "https://api.orcarouter.ai/v1",
 contextWindow: 65536,
 maxTokens: 8192,
 input: ["text"],
 reasoning: true,
 cost: { input: price, output: price, cacheRead: price, cacheWrite: price },
});
const old = model("lab/x-1.2", "openrouter", 0.1),
 fresh = model("lab/x-1.3:free"),
 weak = model("lab/small-1.3:free"),
 other = model("org/y-2.1", "orcarouter"),
 paid = model("lab/paid-1.0", "openrouter", 0.15);
const models = [old, fresh, weak, other, paid];
publishFreeEvidence(
 models
  .filter((m) => m.provider === "openrouter")
  .map((m) => ({
   id: m.id,
   pricing: {
    prompt: String(m.cost.input / 1e6),
    completion: String(m.cost.output / 1e6),
   },
   capabilities: {
    toolCalling: true,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
   },
  })),
 FREE_CATALOG_URL,
);
publishProviderFreeEvidence(
 "orcarouter",
 [
  {
   id: other.id,
   pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   capabilities: { toolCalling: true },
  },
 ],
 ORCA_PRICING_URL,
);
const bench = (m, score, suite = "code", extra = {}) => ({
 model: m.id.replace(/:free$/, ""),
 suite,
 protocol: "fixture-v1",
 domain: "coding",
 score,
 observedAt: at,
 source: "https://artificialanalysis.ai/api/v2/data/llms/models",
 authority: "independent",
 ...extra,
});
const rows = [
 bench(old, 80),
 bench(fresh, 81),
 bench(weak, 30),
 bench(other, 79),
 bench(paid, 82),
];
const publish = async (observations) =>
 assert.equal(
  (
   await refreshModelRankingCache(async () => ({
    ok: true,
    body: {
     version: 2,
     fetchedAt: new Date().toISOString(),
     asOf: new Date(at).toISOString(),
     observations,
    },
   }))
  ).ok,
  true,
 );
let count = 0;
const check = (name, fn) => {
 fn();
 count++;
 console.log("PASS " + name);
};
try {
 await publish(rows);
 check("newer measured free model beats paid predecessor", () =>
  assert.equal(
   selectAffordableModel(models, cfg, {
    preferredModel: old.fullId,
    task: "Implement a repository function and tests",
   }).model,
   fresh.fullId,
  ),
 );
 check("regressing free model loses to capable paid model", () =>
  assert.equal(
   selectAffordableModel([old, weak], cfg, {
    preferredModel: old.fullId,
    task: "Implement a repository function",
   }).model,
   old.fullId,
  ),
 );
 // Same model identity and admitted prices: measured retry cost breaks a
 // near-price tie, but disabling the optimizer restores the cold price order.
 const health = await import(shared + "provider-health.ts");
 const reliable = {
  ...old,
  provider: "reliablehost",
  fullId: "reliablehost/" + old.id,
  cost: { input: 0.105, output: 0.105, cacheRead: 0.105, cacheWrite: 0.105 },
 };
 const flaky = { ...old, provider: "flakyhost", fullId: "flakyhost/" + old.id };
 for (const candidate of [reliable, flaky])
  for (let i = 0; i < 8; i++) {
   const rates = health.economyRateIdentity(
     candidate.cost,
     candidate.baseUrl,
     candidate.api,
    ),
    now = at - 10000 + i;
   if (candidate === flaky && i < 3)
    health.recordFailure({
     provider: candidate.provider,
     model: candidate.id,
     now,
     errorMessage: "500 server error",
     rates,
    });
   else
    health.recordSuccess({
     provider: candidate.provider,
     model: candidate.id,
     now,
     economyUsage: {
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.001,
      rates,
      elapsedMs: 2000,
     },
    });
  }
 check(
  "observed retry cost ranks only quality-admitted routes with sufficient effective samples",
  () =>
   assert.equal(
    selectAffordableModel([flaky, reliable], cfg, {
     preferredModel: flaky.fullId,
     task: "Implement a repository function",
    }).model,
    reliable.fullId,
   ),
 );
 process.env.PI_LOCAL_INTELLIGENCE = "off";
 check("disabled optimizer restores existing price ordering", () =>
  assert.equal(
   selectAffordableModel([flaky, reliable], cfg, {
    preferredModel: flaky.fullId,
    task: "Implement a repository function",
   }).model,
   flaky.fullId,
  ),
 );
 delete process.env.PI_LOCAL_INTELLIGENCE;
 check("healthy provider cannot confer intelligence on its weak model", () =>
  assert.equal(
   assessModelQuality(
    [old, weak],
    rows,
    { domain: "coding", level: "standard" },
    old,
   ).get(weak.fullId).eligible,
   false,
  ),
 );
 check("price and version alone do not establish quality", () =>
  assert.equal(
   selectAffordableModel([fresh], cfg, {
    task: "Implement a production authentication service",
   }),
   undefined,
  ),
 );
 check("critical work needs at least two independent measures", () =>
  assert.equal(
   assessModelQuality(
    [fresh],
    rows,
    { domain: "coding", level: "critical" },
    old,
   ).get(fresh.fullId).eligible,
   false,
  ),
 );
 await publish([...rows, bench(old, 70, "code-2"), bench(fresh, 71, "code-2")]);
 check(
  "critical free candidate qualifies with comparable independent evidence",
  () =>
   assert.equal(
    selectAffordableModel(models, cfg, {
     preferredModel: old.fullId,
     task: "Implement production authentication tests",
    }).model,
    fresh.fullId,
   ),
 );
 check("publisher measurements cannot alone qualify critical work", () =>
  assert.equal(
   assessModelQuality(
    [fresh],
    [
     bench(fresh, 90, "a", {
      authority: "publisher",
      source: "https://huggingface.co/lab/x-1.3",
     }),
     bench(fresh, 90, "b", {
      authority: "publisher",
      source: "https://huggingface.co/lab/x-1.3",
     }),
    ],
    { domain: "coding", level: "critical" },
   ).get(fresh.fullId).eligible,
   false,
  ),
 );
 check("stale/future evidence is not quality proof", () => {
  for (const observedAt of [at - QUALITY_TTL_MS - 1, at + 100000])
   assert.equal(
    assessModelQuality([fresh], [bench(fresh, 100, "code", { observedAt })], {
     domain: "coding",
     level: "standard",
    }).get(fresh.fullId).eligible,
    false,
   );
 });
 check("ambiguous namespace/size/version cannot borrow scores", () => {
  for (const id of ["evil/x-1.3", "lab/x-1.3-small", "lab/x-1.4"])
   assert.equal(
    assessModelQuality([model(id)], rows, {
     domain: "coding",
     level: "standard",
    }).get("openrouter/" + id).eligible,
    false,
   );
  assert.equal(compareModelVersions("lab/x-1.3-7b", "lab/x-1.2-70b"), 0);
  assert.ok(compareModelVersions("lab/x-1.10", "lab/x-1.9") > 0);
 });
 check("explicit smaller task capacity overrides parent capacity", () => {
  const giant = { ...old, contextWindow: 1000000 };
  assert.equal(
   selectAffordableModel([giant, fresh], cfg, {
    preferredModel: giant.fullId,
    task: "Implement a function",
    requirements: {
     minContextWindow: 16384,
     minOutputTokens: 1024,
     reasoning: false,
     inputModalities: ["text"],
    },
   }).model,
   fresh.fullId,
  );
  assert.equal(
   selectAffordableModel([giant, fresh], cfg, {
    preferredModel: giant.fullId,
    task: "Implement a function",
   }).model,
   giant.fullId,
  );
 });
 check("free-only cannot escape failed quality gate into paid", () =>
  assert.equal(
   selectAffordableModel([old, weak], cfg, {
    preferredModel: old.fullId,
    task: "Implement code",
    freeOnly: true,
   }),
   undefined,
  ),
 );
 check(
  "explicit route and free-only restrictions survive task-aware selection",
  () => {
   assert.equal(
    buildModelCandidates(old.fullId, [], models, undefined, {
     origin: "inherited",
     task: "Implement code. Do not switch model.",
     allowAutomaticAlternatives: false,
    })[0],
    old.fullId,
   );
   assert.throws(
    () =>
     buildModelCandidates(paid.fullId, [], [paid], undefined, {
      origin: "inherited",
      task: "Review code. Only use free models.",
     }),
    /No eligible free route/,
   );
  },
 );
 check(
  "free-only and fixed-route tasks constrain configured fallback members too",
  () => {
   assert.deepEqual(
    buildModelCandidates(fresh.fullId, [paid.fullId], models, undefined, {
     origin: "inherited",
     task: "Review code. Only use free models.",
    }),
    [fresh.fullId],
   );
   assert.deepEqual(
    buildModelCandidates(old.fullId, [paid.fullId], models, undefined, {
     origin: "inherited",
     task: "Implement code. Do not switch model.",
    }),
    [old.fullId],
   );
  },
 );
 check("a single low score without peers cannot validate itself", () =>
  assert.equal(
   assessModelQuality([fresh], [bench(fresh, 1)], {
    domain: "coding",
    level: "standard",
   }).get(fresh.fullId).eligible,
   false,
  ),
 );
 check("inconsistent same-time measurements are rejected", () =>
  assert.equal(
   assessModelQuality(
    [old, fresh],
    [bench(old, 80), bench(fresh, 100), bench(fresh, 10)],
    { domain: "coding", level: "standard" },
    old,
   ).get(fresh.fullId).eligible,
   false,
  ),
 );
 const snapshot = {
  version: 1,
  updatedAt: at,
  providers: {
   openrouter: {
    updatedAt: at,
    cooldownUntil: 0,
    requests: [],
    models: { [fresh.id]: { updatedAt: at, cooldownUntil: at + 60000 } },
   },
  },
  pending: [],
 };
 fs.writeFileSync(process.env.PI_PROVIDER_STATE_FILE, JSON.stringify(snapshot));
 check("known strong model on a cooling route cannot be selected", () =>
  assert.notEqual(
   selectAffordableModel(models, cfg, {
    preferredModel: old.fullId,
    task: "Implement code",
   }).model,
   fresh.fullId,
  ),
 );
 fs.unlinkSync(process.env.PI_PROVIDER_STATE_FILE);
 check(
  "task reaches normal inherited child selection; explicit choice remains exact",
  () => {
   assert.equal(
    buildModelCandidates(old.fullId, [], models, undefined, {
     origin: "inherited",
     task: "Implement a function",
     allowAutomaticAlternatives: false,
    })[0],
    fresh.fullId,
   );
   assert.equal(
    buildModelCandidates(old.fullId, [], models, undefined, {
     origin: "explicit",
     task: "Implement a function",
    })[0],
    old.fullId,
   );
  },
 );
 check(
  "planner uses a helper for bounded work, fusion for alternatives, swarm for independent project work",
  () => {
   assert.equal(
    planAssistance(
     "Investigate why the repository test suite fails after startup",
    ).mode,
    "subagent",
   );
   assert.equal(
    planAssistance(
     "Compare architectural alternatives for the API cache implementation",
    ).mode,
    "fusion",
   );
   const p = planAssistance(
    "Implement cross-file changes in the frontend and backend with tests",
    true,
   );
   assert.equal(p.mode, "swarm");
   assert.equal(p.roles.length, 3);
  },
 );
 check(
  "planner preserves opt-outs, trivial work, quoted instructions, and free-only assistance",
  () => {
   for (const text of [
    "Fix this typo",
    "Do not delegate. Investigate the repository failure",
    "Do not use fusion. Compare architectural alternatives for the API",
   ])
    assert.equal(planAssistance(text).mode, "none");
   assert.equal(
    planAssistance(
     "Investigate this failure in the repository. Only use free models.",
    ).mode,
    "subagent",
   );
   assert.equal(
    planAssistance("Hello\n> Implement multiple changes across the repository")
     .mode,
    "none",
   );
  },
 );
 check(
  "team diversifies model identities and mostly uses free routes within total budget",
  () => {
   const p = planAssistance(
    "Implement cross-file changes in the frontend and backend with tests",
    true,
   );
   const team = selectAssistanceTeam(models, cfg, p, { task: "Review code" });
   assert.equal(team.length, 3);
   assert.ok(team.filter((m) => !m.free).length <= 1);
   assert.ok(new Set(team.map((m) => m.route.split("/")[0])).size >= 2);
   assert.equal(
    new Set(
     team.map((m) => m.route.replace(/^\w+\//, "").replace(/:free$/, "")),
    ).size,
    3,
   );
   assert.ok(p.maxCostUsd <= 0.03);
  },
 );
 check("same model behind two routers is not independent consensus", () => {
  const alias = model(fresh.id, "orcarouter");
  publishProviderFreeEvidence(
   "orcarouter",
   [
    {
     id: alias.id,
     pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
     capabilities: { toolCalling: true },
    },
   ],
   ORCA_PRICING_URL,
  );
  assert.equal(
   selectAssistanceTeam(
    [fresh, alias],
    cfg,
    planAssistance("Compare two implementation approaches in this repository"),
   ).length,
   1,
  );
 });
 check("configured router aliases do not consume independent team slots", () => {
  const alias = model(fresh.id, "orcarouter");
  const prefsFile = path.join(root, "llm-prefs-aliases.json");
  fs.writeFileSync(prefsFile, JSON.stringify({
   preferences: { fusion: [
    { provider: fresh.provider, model: fresh.id },
    { provider: alias.provider, model: alias.id },
   ] },
  }));
  const oldPrefs = process.env.PI_LLM_PREFERENCES_FILE;
  process.env.PI_LLM_PREFERENCES_FILE = prefsFile;
  clearLlmPreferencesCache();
  try {
   const plan = planAssistance("Compare two implementation approaches in this repository");
   const team = selectAssistanceTeam([...models, alias], cfg, plan, { task: "Review code" });
   assert.equal(team.length, 2);
   assert.equal(team[0].route, fresh.fullId);
   assert.equal(team[0].role, plan.roles[0]);
   assert.equal(team[1].role, plan.roles[1]);
   assert.notEqual(team[1].route, alias.fullId, "a router alias cannot serve as independent critique");
   assert.notEqual(team[1].route, fresh.fullId);
   fs.writeFileSync(prefsFile, JSON.stringify({
    preferences: { fusion: [
     { provider: fresh.provider, model: fresh.id },
     { provider: alias.provider, model: alias.id },
     { provider: other.provider, model: other.id },
    ] },
   }));
   clearLlmPreferencesCache();
   const configured = selectAssistanceTeam([...models, alias], cfg, plan, { task: "Review code" });
   assert.deepEqual(configured.map(member => member.route), [fresh.fullId, other.fullId]);
   assert.equal(configured[1].proof, "explicit llm_preferences");
  } finally {
   if (oldPrefs === undefined) delete process.env.PI_LLM_PREFERENCES_FILE;
   else process.env.PI_LLM_PREFERENCES_FILE = oldPrefs;
   clearLlmPreferencesCache();
  }
 });
 check("routes that mostly fail to finish move behind reliable preferences", () => {
  const now = Date.parse("2026-09-26T06:30:00Z"), ts = (minutesAgo) => Math.floor((now - minutesAgo * 60000) / 1000);
  const run = (model, outcome, minutesAgo, cause) => ({ agent: "automatic-free-assistant", task: "[redacted]", ts: ts(minutesAgo), status: outcome === "completed" ? "ok" : "error", outcome, duration: 1, evidence: { version: 1, model, ...(cause ? { cause } : {}) } });
  const history = [
   run("orcarouter/z-ai/slow", "stopped", 1), run("orcarouter/z-ai/slow:high", "timed_out", 2), run("orcarouter/z-ai/slow", "completed", 3), run("orcarouter/z-ai/slow", "stopped", 4),
   run("meta/fast", "completed", 1), run("meta/fast", "failed", 2, { stage: "execute", category: "acceptance" }), run("meta/fast", "failed", 3, { stage: "launch", category: "internal" }), run("meta/fast", "completed", 4), run("meta/fast", "failed", 5, { stage: "execute", category: "acceptance" }),
   run("orcarouter/old/flaky", "stopped", 60 * 24 * 4), run("orcarouter/old/flaky", "stopped", 60 * 24 * 4), run("orcarouter/old/flaky", "stopped", 60 * 24 * 4), run("orcarouter/old/flaky", "stopped", 60 * 24 * 4),
   run("other/sparse", "stopped", 1), run("other/sparse", "stopped", 2), run("other/sparse", "completed", 3),
  ];
  assert.deepEqual([...unreliableRoutes(history, now)], ["orcarouter/z-ai/slow"], "harness verdicts, stale runs and sparse samples demote nothing");
  const prefsFile = path.join(root, "llm-prefs-unreliable.json");
  fs.writeFileSync(prefsFile, JSON.stringify({ preferences: { fusion: [
   { provider: fresh.provider, model: fresh.id }, { provider: other.provider, model: other.id }, { provider: old.provider, model: old.id },
  ] } }));
  const oldPrefs = process.env.PI_LLM_PREFERENCES_FILE;
  process.env.PI_LLM_PREFERENCES_FILE = prefsFile;
  clearLlmPreferencesCache();
  try {
   const plan = planAssistance("Compare two implementation approaches in this repository");
   const configured = selectAssistanceTeam(models, cfg, plan, { task: "Review code" });
   const demoted = selectAssistanceTeam(models, cfg, plan, { task: "Review code", unreliable: new Set([other.fullId]) });
   assert.deepEqual(configured.map(member => member.route), [fresh.fullId, other.fullId]);
   assert.deepEqual(demoted.map(member => member.route), [fresh.fullId, old.fullId], "the configured order stands among reliable routes");
   const alone = selectAssistanceTeam(models, cfg, plan, { task: "Review code", unreliable: new Set([fresh.fullId, other.fullId, old.fullId]) });
   assert.ok(alone.length >= 1, "an all-unreliable chain still serves rather than leaving the role empty");
   // Council shape: the flaky configured route yields its slot to a reliable autonomous pick.
   const withoutFlaky = selectAssistanceTeam(models, cfg, plan, { task: "Review code", unreliable: new Set([old.fullId]) });
   const flakyOnly = selectAssistanceTeam([fresh, other, old], cfg, plan, { task: "Review code", unreliable: new Set([other.fullId]) });
   assert.ok(!withoutFlaky.some(member => member.route === old.fullId), "a reliable route fills the slot before the flaky one");
   assert.deepEqual(flakyOnly.map(member => member.route), [fresh.fullId, old.fullId]);
   const lastResort = selectAssistanceTeam([fresh, other], cfg, plan, { task: "Review code", unreliable: new Set([other.fullId]) });
   assert.deepEqual(lastResort.map(member => member.route), [fresh.fullId, other.fullId], "with nothing reliable left, the configured route still serves");
   assert.match(lastResort[1].explanation.join(" "), /no reliable route was available/);
  } finally {
   if (oldPrefs === undefined) delete process.env.PI_LLM_PREFERENCES_FILE;
   else process.env.PI_LLM_PREFERENCES_FILE = oldPrefs;
   clearLlmPreferencesCache();
  }
 });
 check("team freeOnly filters paid preferences unless explicitly honored", () => {
  const prefsFile = path.join(root, "llm-prefs-team-freeonly.json");
  fs.writeFileSync(
   prefsFile,
   JSON.stringify({
    version: 1,
    models: {
     paid_one: {
      provider: "openrouter",
      model: "lab/paid-1.0",
      thinking: "low",
     },
    },
    preferences: { swarm: { models: ["paid_one"] } },
   }),
  );
  const oldPrefs = process.env.PI_LLM_PREFERENCES_FILE;
  process.env.PI_LLM_PREFERENCES_FILE = prefsFile;
  clearLlmPreferencesCache();
  try {
   const p = planAssistance(
    "Migrate the billing and auth subsystems end to end",
    true,
   );
   assert.equal(p.mode, "swarm");
   const strict = selectAssistanceTeam([paid], cfg, p, {
    freeOnly: true,
    requiresTools: false,
   });
   assert.equal(strict.length, 0, "strict freeOnly drops the paid pref");
   const honored = selectAssistanceTeam([paid], cfg, p, {
    freeOnly: true,
    honorPaidPreferences: true,
    requiresTools: false,
   });
   assert.equal(honored.length, 1, "opt-out keeps the configured route");
   assert.equal(honored[0].proof, "explicit llm_preferences");
  } finally {
   if (oldPrefs === undefined) delete process.env.PI_LLM_PREFERENCES_FILE;
   else process.env.PI_LLM_PREFERENCES_FILE = oldPrefs;
   clearLlmPreferencesCache();
  }
 });
 check(
  "schema rejects forged sources, corrupt values and future research timestamps",
  () => {},
 );
 for (const patch of [
  { observations: [bench(old, NaN)] },
  {
   observations: [
    bench(old, 99, "code", { source: "https://untrusted.example/benchmark" }),
   ],
  },
  { researchAt: Date.now() + 100000 },
 ])
  assert.equal(
   (
    await refreshModelRankingCache(async () => ({
     ok: true,
     body: {
      version: 2,
      fetchedAt: new Date().toISOString(),
      asOf: new Date(at).toISOString(),
      ...patch,
     },
    }))
   ).ok,
   false,
  );
 check(
  "AA adapter uses exact identity and documented units, never missing/null values",
  () => {
   const data = {
    data: [
     {
      id: "stable",
      slug: "x-1.3",
      model_creator: { slug: "lab" },
      evaluations: {
       livecodebench: 0.8,
       scicode: null,
       artificial_analysis_coding_index: 80,
      },
     },
    ],
   };
   const parsed = artificialAnalysisEvidence(data, [fresh], at);
   assert.equal(parsed.length, 2);
   assert.ok(parsed.every((b) => b.score === 80));
   assert.equal(
    artificialAnalysisEvidence(
     { data: [...data.data, ...data.data] },
     [fresh],
     at,
    ).length,
    0,
   );
   assert.equal(artificialAnalysisEvidence(data, [weak], at).length, 0);
  },
 );
 check(
  "model card parser refuses unknown units and mismatched repository",
  () => {
   const card = {
    id: "lab/x-1.3",
    cardData: {
     "model-index": [
      {
       results: [
        {
         dataset: { type: "coding" },
         task: { type: "text-generation" },
         metrics: [{ type: "pass@1", value: 0.85 }],
        },
       ],
      },
     ],
    },
   };
   assert.equal(modelCardEvidence(card, "lab/x-1.3", at).length, 0);
   card.cardData["model-index"][0].results[0].metrics[0].unit = "ratio";
   assert.equal(modelCardEvidence(card, "lab/x-1.3", at)[0].score, 85);
   assert.equal(modelCardEvidence(card, "lab/other", at).length, 0);
  },
 );
 let lookups = 0,
  searches = 0;
 const deps = {
  apiKey: "",
  json: async () => {
   lookups++;
   throw Error("offline");
  },
  search: async () => {
   searches++;
   return ["https://example.com/score-is-only-a-search-hit"];
  },
 };
 await Promise.all([
  refreshModelResearch(models, undefined, deps),
  refreshModelResearch(models, undefined, deps),
 ]);
 check(
  "research coalesces and bounds requests; search cannot invent scores",
  () => {
   assert.ok(lookups <= 4);
   assert.equal(searches, 1);
   assert.ok(readRankCache().cache.researchAt);
   assert.ok(
    readRankCache().cache.discoveries.some((d) =>
     d.sources.includes("https://example.com/score-is-only-a-search-hit"),
    ),
   );
   assert.equal(
    readRankCache().cache.observations.some((b) =>
     b.source.includes("example.com"),
    ),
    false,
   );
  },
 );
 await refreshModelResearch(models, undefined, deps);
 check("negative cache avoids repeated failed research on hot path", () =>
  assert.ok(lookups <= 4),
 );
 const publishedBefore = readRankCache().cache.researchAt;
 const cancel = new AbortController();
 const cancelTimer = setTimeout(() => cancel.abort(), 5);
 await refreshModelResearch([...models, model("new/unseen")], cancel.signal, {
  json: () => new Promise(() => {}),
  search: () => new Promise(() => {}),
 });
 clearTimeout(cancelTimer);
 check(
  "cancellation bounds uncooperative research adapters and retains prior evidence",
  () => assert.equal(readRankCache().cache.researchAt, publishedBefore),
 );
 const late = await refreshModelRankingCache(async () => ({
  ok: true,
  body: {
   version: 2,
   fetchedAt: new Date(at - 10000).toISOString(),
   asOf: new Date(at - 10000).toISOString(),
   observations: [],
  },
 }));
 check("late cache refresh cannot overwrite a newer snapshot", () =>
  assert.equal(late.ok, false),
 );
 // A realistic loaded catalog, warm cache and zero network. This is a latency
 // regression bound, not a universal machine performance claim.
 const large = Array.from({ length: 500 }, (_, i) =>
  model(`synthetic/candidate-${i}`, "openrouter", 0.1),
 );
 const samples = [];
 for (let i = 0; i < 12; i++) {
  const start = performance.now();
  selectAffordableModel(large, cfg, {
   quality: { domain: "coding", level: "advisory" },
  });
  samples.push(performance.now() - start);
 }
 samples.sort((a, b) => a - b);
 // Regression bound, not a universal machine claim. Parallel release runs add
 // scheduler contention in the tail; report it for diagnosis while the median
 // detects a lost cache or an algorithmic regression.
 check("500-route cached selector stays below 150ms median", () =>
  assert.ok(samples[6] < 150, JSON.stringify(samples)),
 );
 console.log(
  JSON.stringify({
   checks: count,
   routing500P50Ms: samples[6],
   routing500P95Ms: samples[11],
  }),
 );
} finally {
 fs.rmSync(root, { recursive: true, force: true });
}
