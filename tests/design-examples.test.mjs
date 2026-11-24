// The design-examples pick: a visual prompt gets a bounded pick, a non-visual
// prompt makes no call, and a failing or abstaining judge falls back to the
// static landing-pages, heroes and Refero list. The judge is always mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.PI_JEV = 'off';
const root = path.resolve(import.meta.dirname, '..');
const {
  designExamplesLineFor, designScaleMemory, exampleCandidates, uncommonReferencesFor, pickExampleLine, DESIGN_EXAMPLES_TIMEOUT_MS,
} = await import(pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href);

const skills = (names) => ({
  systemPromptOptions: {
    skills: names.map((name) => ({ name, description: `${name} guide`, filePath: `/installed/skills/${name}/SKILL.md` })),
  },
});
const { boldExamplePicks, EXAMPLE_SCALE_DESCRIPTIONS } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/micro-intelligence/jev-decisions.ts')).href);
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

/** A judge whose best answer and per-example probabilities are given outright, with a scale. */
const judgeWith = (best, weights, scale) => async (_site, _state, questions) => {
  const ids = Object.keys(questions.best.criteria);
  const named = ids.filter((id) => id in weights);
  const rest = ids.filter((id) => !(id in weights));
  const left = 1 - named.reduce((sum, id) => sum + weights[id], 0);
  const probabilities = Object.fromEntries(ids.map((id) => [id, id in weights ? weights[id] : (rest.length ? left / rest.length : 0)]));
  const scaleIds = Object.keys(questions.scale.criteria);
  const scaleProbabilities = Object.fromEntries(scaleIds.map((id) => [id, id === scale ? 0.8 : 0.2 / (scaleIds.length - 1)]));
  return { ok: true, answers: { best: { choice: best, probabilities }, scale: { choice: scale, probabilities: scaleProbabilities } }, usage };
};
const CRAFT = 'Open at least three of them live in the browser, from different sources and past the first familiar one';
const BOLD_TAIL = /the name, the logo and what the product says stay unless asked; nothing else is kept only because it is there\.$/;

test('a big improvement is the boldest scale: layout may change, each part stays only if it is good', () => {
  assert.match(EXAMPLE_SCALE_DESCRIPTIONS.redesign, /^a big, complete or tremendous improvement of the UI\/UX, design or aesthetic: bold changes are the default, layout and flow may change, and each existing part stays only if it is good$/);
  assert.doesNotMatch(EXAMPLE_SCALE_DESCRIPTIONS.improve, /bold|big/);
});

test('a bold scale reads the bold guide, opens three live examples and iterates twice', async () => {
  for (const scale of ['redesign', 'fresh-build']) {
    const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeWith('scrolltide:heroes', { 'scrolltide:heroes': 0.6, 'uncommon:shaders-webgl-3d': 0.3 }, scale));
    assert.match(line, /Read \/installed\/skills\/ui-design\/references\/bold-redesign\.md first/, scale);
    assert.ok(line.includes(CRAFT), scale);
    assert.match(line, /Commit to one strong idea that suits this brand \(3D, scroll motion, a shader, kinetic type or a tactile part where it serves; a tool people work in daily keeps a stable layout\)/, scale);
    assert.match(line, /iterate on the screenshot at least twice: a first pass that looks nice is usually the median/, scale);
    assert.match(line, BOLD_TAIL, scale);
    assert.doesNotMatch(line, /colors and layout stay unless/, scale);
  }
});

test('the boldest scale holds for the session: a complaint never lowers it, an explicit keep does', async () => {
  const memory = designScaleMemory();
  const bold = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeWith('scrolltide:heroes', { 'scrolltide:heroes': 0.6, 'uncommon:shaders-webgl-3d': 0.3 }, 'redesign'), memory.remember(VISUAL));
  assert.match(bold, /Change scale the request implies: redesign/);
  assert.ok(bold.includes(CRAFT));
  const complaint = 'The landing page hero looks off; make it better';
  const afterComplaint = await designExamplesLineFor({ ...installed, prompt: complaint }, judgeWith('scrolltide:heroes', { 'scrolltide:heroes': 0.8 }, 'polish'), memory.remember(complaint));
  assert.match(afterComplaint, /Change scale the request implies: redesign/, 'the complaint keeps the bold scale');
  assert.ok(afterComplaint.includes(CRAFT), 'the bold guide still applies');
  assert.equal(memory.get(), 'redesign');
  const keep = 'Keep the design as it is; only polish the landing page hero spacing';
  const kept = await designExamplesLineFor({ ...installed, prompt: keep }, judgeWith('scrolltide:heroes', { 'scrolltide:heroes': 0.8 }, 'keep-design'), memory.remember(keep));
  assert.match(kept, /Change scale the request implies: keep-design/);
  assert.equal(memory.get(), 'keep-design', 'an explicit keep lowers it');
  memory.reset();
  assert.equal(memory.get(), undefined);
});

test('the other scales keep their wording and never name the bold guide', async () => {
  for (const scale of ['polish', 'improve']) {
    const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeWith('scrolltide:heroes', { 'scrolltide:heroes': 0.6, 'uncommon:shaders-webgl-3d': 0.3 }, scale));
    assert.doesNotMatch(line, /bold-redesign|at least three/, scale);
    assert.match(line, /Open several, take the parts that fit/, scale);
    assert.match(line, /the logo stays unless asked, and colors and layout stay unless the scale or the user says otherwise\.$/, scale);
  }
});

test('a bold scale admits others from 4 percent, at most four, and one index with a point of view', async () => {
  const weights = { 'ui-design:galleries': 0.5, refero: 0.3, 'scrolltide:components': 0.1, 'scrolltide:sections': 0.06, 'scrolltide:heroes': 0.035, 'uncommon:shaders-webgl-3d': 0.005 };
  const line = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeWith('ui-design:galleries', weights, 'redesign'));
  const named = ['ui-design/references/patterns.md', 'styles.refero.design', 'scrolltide/references/components.md', 'scrolltide/references/sections.md'].map((x) => line.indexOf(x));
  assert.ok(named.every((i) => i > 0) && named.every((i, k) => k === 0 || i > named[k - 1]), 'four picks in rank order');
  assert.doesNotMatch(line, /heroes\.md|shaders-webgl-3d\.md/, 'a share under 4 percent is not admitted');
  // The same answer at a plain scale names the usual two at most.
  const plain = await designExamplesLineFor({ ...installed, prompt: VISUAL }, judgeWith('ui-design:galleries', weights, 'improve'));
  assert.doesNotMatch(plain, /scrolltide\/references\/(?:components|sections)\.md/);
});

test('boldExamplePicks puts the likeliest index with a point of view in the last place', () => {
  const ids = ['ui-design:galleries', 'refero', 'scrolltide:heroes', 'uncommon:shaders-webgl-3d', 'scrolltide:components'];
  const picks = boldExamplePicks('ui-design:galleries', ids, { 'ui-design:galleries': 0.5, refero: 0.3, 'scrolltide:components': 0.001, 'scrolltide:heroes': 0.1, 'uncommon:shaders-webgl-3d': 0.0001 });
  assert.deepEqual(picks, ['ui-design:galleries', 'refero', 'scrolltide:heroes']);
  const crowded = boldExamplePicks('ui-design:galleries', ['ui-design:galleries', 'refero', 'a', 'b', 'c', 'uncommon:typography-text'], { 'ui-design:galleries': 0.4, refero: 0.2, a: 0.15, b: 0.15, c: 0.08, 'uncommon:typography-text': 0.02 });
  assert.equal(crowded.length, 4);
  assert.equal(crowded[3], 'uncommon:typography-text', 'the fourth place goes to the index with a point of view');
  assert.deepEqual(boldExamplePicks('refero', ['refero', 'ui-design:galleries'], { refero: 0.9, 'ui-design:galleries': 0.1 }), ['refero', 'ui-design:galleries'], 'none with a point of view and none with probability: nothing is forced');
});

test('the bold guide ships with the harness and the guides point to it', () => {
  const skillsDir = path.join(root, 'agent/skills');
  const guide = fs.readFileSync(path.join(skillsDir, 'ui-design/references/bold-redesign.md'), 'utf8');
  assert.match(guide, /Existing work is judged part by part/);
  assert.match(guide, /Open the best four to six fully|the best four to six opened in full/);
  assert.match(guide, /Two rounds at least/);
  assert.match(guide, /a bold curved accent or thick darker edge under a button; blinking or pulsing dot indicators; common pastel colors/);
  assert.match(guide, /Dashboards and daily tools\*\* keep a stable, predictable layout/);
  assert.match(guide, /An existing design that is good, that the user is happy with/);
  assert.doesNotMatch(guide, /\.claude|web-design\/|deslop/, 'no path that does not exist in this harness');
  assert.match(fs.readFileSync(path.join(skillsDir, 'ui-design/SKILL.md'), 'utf8'), /references\/bold-redesign\.md/);
  for (const name of ['scrolltide', 'uncommon-web']) {
    assert.match(fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'), /\.\.\/ui-design\/references\/bold-redesign\.md/, name);
  }
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
