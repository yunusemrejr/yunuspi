// The design-examples pick: a visual prompt gets a bounded pick, a non-visual
// prompt makes no call, and a failing or abstaining judge falls back to the
// static landing-pages, heroes and Refero list. The judge is always mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.PI_JEV = 'off';
const root = path.resolve(import.meta.dirname, '..');
const {
  designExamplesLineFor, exampleCandidates, uncommonReferencesFor, pickExampleLine, DESIGN_EXAMPLES_TIMEOUT_MS,
} = await import(pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href);

const skills = (names) => ({
  systemPromptOptions: {
    skills: names.map((name) => ({ name, description: `${name} guide`, filePath: `/installed/skills/${name}/SKILL.md` })),
  },
});
const installed = skills(['scrolltide', 'uncommon-web', 'ui-design']);
const VISUAL = 'Build a landing page for a bakery with scroll sections and a 3D hero';
const usage = { inputTokens: 24, cached: false, costUsd: 0.0002 };

/** A judge that spreads the remaining weight over every candidate. */
const judgeChoosing = (best, second, scale) => async (_site, _state, questions) => {
  const ids = Object.keys(questions.best.criteria);
  assert.ok(ids.length <= 12, 'the pick never exceeds twelve candidates');
  assert.ok(ids.includes(best));
  const probabilities = Object.fromEntries(ids.map((id) => [id, 0]));
  probabilities[best] = 0.6;
  probabilities[second] = 0.2;
  const rest = ids.filter((id) => id !== best && id !== second);
  for (const id of rest) probabilities[id] = 0.2 / rest.length;
  const answers = { best: { choice: best, probabilities } };
  if (scale) {
    const scaleIds = Object.keys(questions.scale.criteria);
    assert.deepEqual(scaleIds.sort(), ['fresh-build', 'improve', 'keep-design', 'polish', 'redesign']);
    const scaleProbabilities = Object.fromEntries(scaleIds.map((id) => [id, (1 - scale[1]) / (scaleIds.length - 1)]));
    scaleProbabilities[scale[0]] = scale[1];
    answers.scale = { choice: scale[0], probabilities: scaleProbabilities };
  }
  return { ok: true, answers, usage };
};

test('an accepted scale is appended to the example line', async () => {
  const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeChoosing('scrolltide:heroes', 'uncommon:shaders-webgl-3d', ['polish', 0.65]));
  assert.match(line, /Change scale the request implies: polish \(spacing, type, contrast and states; layout and palette stay\); the logo stays unless asked, and colors and layout stay unless the scale or the user says otherwise\.$/);
  assert.match(line, /Open several, take the parts that fit/);
});

test('a scale below one half is not applied', async () => {
  const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeChoosing('scrolltide:heroes', 'uncommon:shaders-webgl-3d', ['improve', 0.4]));
  assert.doesNotMatch(line, /Change scale/);
});

test('keep-design keeps the existing design instead of exploring', async () => {
  const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeChoosing('scrolltide:heroes', 'uncommon:shaders-webgl-3d', ['keep-design', 0.6]));
  assert.match(line, /Keep the existing design; use the examples only for the detail being fixed\./);
  assert.doesNotMatch(line, /Open several/);
  assert.match(line, /Change scale the request implies: keep-design \(a small fix inside an existing design\)/);
});

test('a visual prompt gets the judged best and second as readable paths', async () => {
  let calls = 0;
  const judge = async (...args) => { calls++; return judgeChoosing('scrolltide:heroes', 'uncommon:shaders-webgl-3d')(...args); };
  const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judge);
  assert.equal(calls, 1);
  assert.match(line, /^Examples for this request: /);
  assert.match(line, /\/installed\/skills\/scrolltide\/references\/heroes\.md/);
  assert.match(line, /\/installed\/skills\/uncommon-web\/references\/shaders-webgl-3d\.md/);
  assert.match(line, /Open several, take the parts that fit, adapt them to this project, iterate on screenshots\.$/);
  assert.doesNotMatch(line, /landing-pages/, 'an accepted pick is not topped up with the static list');
});

test('a non-visual prompt gets nothing and never calls the judge', async () => {
  for (const prompt of ['Refactor the parser in src/parser.ts', 'Explain how the landing page works', 'Check the invoice.']) {
    let calls = 0;
    const line = await designExamplesLineFor({ ...installed, prompt }, async () => { calls++; throw new Error('unexpected call'); });
    assert.equal(line, undefined, prompt);
    assert.equal(calls, 0, `${prompt} makes no decision call`);
  }
});

test('a failed or abstaining judge falls back to landing pages, heroes and Refero', async () => {
  const failing = async () => { throw new Error('offline'); };
  const failed = await designExamplesLineFor({ ...installed, prompt: VISUAL }, failing);
  assert.match(failed, /scrolltide\/references\/landing-pages\.md/);
  assert.match(failed, /scrolltide\/references\/heroes\.md/);
  assert.match(failed, /https:\/\/styles\.refero\.design\//);

  const abstaining = await designExamplesLineFor({ ...installed, prompt: VISUAL }, async () => ({ ok: false, skipped: 'breaker' }));
  assert.equal(abstaining, failed, 'an abstention uses the same static pick');

  const lowConfidence = await pickExampleLine(
    exampleCandidates(installed, VISUAL), VISUAL,
    async (_site, _state, questions) => {
      const ids = Object.keys(questions.best.criteria);
      const probabilities = Object.fromEntries(ids.map((id) => [id, 1 / ids.length]));
      return { ok: true, answers: { best: { choice: ids[0], probabilities } }, usage };
    },
    AbortSignal.timeout(DESIGN_EXAMPLES_TIMEOUT_MS),
  );
  assert.equal(lowConfidence, failed, 'a tie is an abstention, not a pick');
});

test('the candidate index is bounded and follows the request vocabulary', () => {
  assert.ok(exampleCandidates(installed, VISUAL).length <= 12);
  const families = uncommonReferencesFor('a shader hero with fluid and glass');
  assert.ok(families.includes('shaders-webgl-3d') && families.includes('materials-3d-splats'), families.join(','));
  assert.ok(families.length <= 3);
  assert.deepEqual(uncommonReferencesFor('refactor the parser and run the unit tests'), []);
  const withoutGuides = exampleCandidates({ prompt: VISUAL }, VISUAL);
  assert.deepEqual(withoutGuides.map((candidate) => candidate.id), ['refero'], 'no installed examples means no made-up paths');
});
