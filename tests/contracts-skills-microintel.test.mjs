import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/skill-telemetry.ts')),
);
assert.ok(agent, 'agent tree with skill-telemetry.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { recordSkillSuggestion, precisionRankSkill, recordMicroIntel, summarizeMicroIntelUsefulness } = await import(lib + 'skill-telemetry.ts');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { routeSkillsPrecise, routeSkills } = await import(shared + 'skill-routing.ts');

test('overbroad keyword matches demote without evidence', () => {
  const bare = precisionRankSkill({ skill: 'github-repo-presentation', requestedAction: 'review', text: 'Audit the GitHub client code for bugs.', keywordScore: 0.77 });
  assert.equal(bare.evidenceMatch, false);
  assert.ok(bare.score < 0.77 * 0.5, 'keyword-only repo-presentation match demoted');

  const evidenced = precisionRankSkill({ skill: 'github-repo-presentation', requestedAction: 'plan', text: 'Add a license file and contributing guide.', keywordScore: 0.77 });
  assert.equal(evidenced.evidenceMatch, true);
  assert.ok(evidenced.score >= 0.77);

  const slides = precisionRankSkill({ skill: 'presentation-authoring', requestedAction: 'review', text: 'Review the presentation layer components for state bugs.', keywordScore: 0.77 });
  assert.equal(slides.evidenceMatch, false, 'UI presentation layer is not a slide deck');
});

test('precise routing keeps every candidate, advisory only', () => {
  const prompt = 'Audit the GitHub webhook handler code and fix the parsing bug in src/hooks.ts';
  const base = routeSkills(prompt, 'src/hooks.ts');
  const precise = routeSkillsPrecise(prompt, 'src/hooks.ts');
  assert.deepEqual(precise.map((m) => m.name).sort(), base.map((m) => m.name).sort(), 'nothing removed');
  assert.ok(precise.every((m) => typeof m.precision === 'number' && m.precisionReason));
});

test('suggestion lifecycle distinguishes inspected, deferred, and applied', () => {
  let ledger = { version: 1, suggestions: [] };
  ledger = recordSkillSuggestion(ledger, 'debugging', 'suggested', 'keyword + intent');
  ledger = recordSkillSuggestion(ledger, 'debugging', 'inspected-preview');
  ledger = recordSkillSuggestion(ledger, 'debugging', 'not-relevant', 'frontend-only task');
  ledger = recordSkillSuggestion(ledger, 'web-security', 'suggested');
  ledger = recordSkillSuggestion(ledger, 'web-security', 'applied');
  const debug = ledger.suggestions.find((s) => s.skill === 'debugging');
  const sec = ledger.suggestions.find((s) => s.skill === 'web-security');
  assert.equal(debug.state, 'not-relevant');
  assert.equal(sec.state, 'applied');
});

test('micro-intel usefulness rewards correct skips, not invocations', () => {
  let ledger = { version: 1, samples: [] };
  for (let i = 0; i < 5; i++) ledger = recordMicroIntel(ledger, { helper: 'smol', outcome: 'skipped-correctly', ineligibility: 'too-small-to-benefit' });
  ledger = recordMicroIntel(ledger, { helper: 'smol', outcome: 'accepted', decisionChanged: true, tokenDelta: -500 });
  ledger = recordMicroIntel(ledger, { helper: 'jev', outcome: 'invoked' });
  ledger = recordMicroIntel(ledger, { helper: 'jev', outcome: 'rejected' });
  const summary = summarizeMicroIntelUsefulness(ledger);
  const smol = summary.find((s) => s.helper === 'smol');
  const jev = summary.find((s) => s.helper === 'jev');
  assert.equal(smol.skippedCorrectly, 5);
  assert.equal(smol.decisionChanged, 1);
  assert.equal(smol.totalTokenDelta, -500);
  assert.ok(smol.usefulness > jev.usefulness, 'correct skips beat empty invocations');
});

test('smol offers carry structured skip reasons on the live gates', async () => {
  const smol = await import(pathToFileURL(path.join(agent, 'extensions/lib/smol-preprocessor.ts')));
  const seen = [];
  const key = Symbol.for('yunus-pi.health.v1');
  const prior = globalThis[key];
  globalThis[key] = (kind, data) => { if (kind === 'ml.smol.offer') seen.push(data); };
  try {
    const clean = 'Routine output line with ordinary words. '.repeat(90);
    // No runtime: model unavailable.
    smol.createSmolPreprocessor({}).offer('k1', clean, 1);
    // Unsafe content: protected.
    smol.createSmolPreprocessor({}).offer('k2', `${clean} the password is hunter2`.slice(0, 4100), 1);
    // Valid v1 runtime but below its floor: too small to benefit.
    const v1 = {
      version: 1, enabled: true, model: 'SmolLM2-135M-Instruct', endpoint: 'http://127.0.0.1:18735/completion',
      calibrated: { eligible: true, p95LatencyMs: 100, outputReductionRatio: 8, minInputChars: 8000, localCostUsdPerSecondCeiling: 0.0001, minSavedChars: 1500 },
    };
    smol.createSmolPreprocessor({ runtime: v1 }).offer('k3', clean, 1);
  } finally {
    if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior;
  }
  const byKey = Object.fromEntries(seen.map((s, i) => [i, s]));
  assert.equal(seen[0].decision, 'no-runtime');
  assert.equal(seen[0].reason, 'model-unavailable');
  assert.equal(seen[1].decision, 'ineligible');
  assert.equal(seen[1].reason, 'protected-content');
  assert.equal(seen[2].decision, 'ineligible');
  assert.equal(seen[2].reason, 'too-small-to-benefit');
  assert.ok(byKey, 'hook observed all offers');
});

test('Smol reports size and shape eligibility separately without weakening protected evidence gates', async () => {
  const smol = await import(pathToFileURL(path.join(agent, 'extensions/lib/smol-preprocessor.ts')));
  const clean = 'Routine output line with ordinary words. '.repeat(90);
  const cases = [
    ['bash', 'short output', false, undefined, 'too-small-to-benefit'],
    ['bash', clean.repeat(2), false, undefined, 'input-budget'],
    ['bash', clean + 'é ✓ → ├──', false, undefined, undefined],
    ['bash', clean + '\u202e', false, undefined, 'input-shape-unsupported'],
    ['bash', clean + '\x1b[31m', false, undefined, 'input-shape-unsupported'],
    ['bash', clean, false, { truncated: true }, 'protected-content'],
    ['bash', clean + ' warning: inspect this evidence', false, undefined, 'protected-content'],
    ['bash', clean, true, undefined, 'protected-content'],
    ['custom', clean, false, undefined, 'unsupported-tool'],
    ['bash', clean, false, undefined, undefined],
  ];
  for (const [tool, raw, isError, details, reason] of cases) {
    assert.equal(smol.smolOutputSkipReason(tool, raw, isError, details), reason);
    assert.equal(smol.safeSmolOutput(tool, raw, isError, details), reason === undefined);
  }
});

test('smol/kompress ineligibility is structured', () => {
  let ledger = { version: 1, samples: [] };
  for (const reason of ['input-shape-unsupported', 'protected-content', 'already-compact', 'latency-budget-exceeded', 'confidence-too-low', 'model-unavailable']) {
    ledger = recordMicroIntel(ledger, { helper: 'kompress', outcome: 'eligible', ineligibility: reason });
  }
  assert.equal(ledger.samples.length, 6);
  assert.ok(ledger.samples.every((s) => s.ineligibility && s.ineligibility.length > 0));
});
