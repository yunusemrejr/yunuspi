// Open briefs get a divergence protocol; incidental references are context,
// not templates (live session 2026-09-24: a music blog copied the typography
// of a personal site the user only asked to link to).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/design-direction.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const design = await load('extensions/lib/design-direction.ts');
const interpretation = await load('extensions/lib/prompt-interpretation.ts');
const { councilMode, shouldRunScopeCouncil } = await load('extensions/lib/scope-deliberation.ts');

const MUSIC = 'I want you to create this website. It is a music theory blog; the landing page should be elegant and there is no AI slop. It is created by me, so put a link to my personal website yunusemrevurgun.com, and deploy it to musics.name.';

test('a new open visual brief asks for explored directions and marks mentioned sites as context only', () => {
  const brief = design.heuristicDesignBrief(MUSIC);
  assert.equal(brief.visualDesign, true);
  assert.equal(brief.openEnded, true);
  assert.deepEqual(brief.styleReferences, []);
  assert.ok(brief.contextReferences.includes('yunusemrevurgun.com'));
  const guidance = design.designDirectionGuidance(brief);
  assert.match(guidance, /divergence pass/);
  assert.match(guidance, /3 genuinely distinct directions/);
  assert.match(guidance, /Context-only references: "yunusemrevurgun\.com"/);
  assert.match(guidance, /not design sources/);
  assert.ok(guidance.length <= 1600);
  assert.match(design.designDirectionSummary(brief), /open visual brief → explore distinct directions.*context-only: yunusemrevurgun\.com/);
});

test('refinement, explicit style references and non-visual work do not trigger a redesign pass', () => {
  const polish = design.heuristicDesignBrief('Polish the UI and fix the chat answer layout in the app.');
  assert.equal(polish.visualDesign, true);
  assert.equal(polish.openEnded, false, 'refining existing work keeps its design language');
  const polishGuidance = design.designDirectionGuidance(polish);
  assert.doesNotMatch(polishGuidance, /divergence pass|distinct directions/, 'no redesign pass for refinement');
  assert.match(polishGuidance, /generated-UI tells while choosing the direction/, 'UI tells arrive before building, not after');
  const styled = design.heuristicDesignBrief('Build a dashboard that looks like linear.app with our palette: #112233');
  assert.equal(styled.openEnded, false);
  assert.deepEqual(styled.styleReferences, ['linear.app']);
  assert.equal(design.heuristicDesignBrief('Fix the failing unit test in parser.ts'), undefined);
  assert.equal(design.heuristicDesignBrief('design an API for user accounts'), undefined);
});

test('model analysis flags lead while the heuristic fills gaps', () => {
  const analysis = { source: 'model', openEnded: true, visualDesign: false, contextReferences: ['example.org'] };
  const brief = design.detectDesignBrief('Plan the data pipeline however you think best.', analysis);
  assert.equal(brief.openEnded, true);
  assert.match(design.designDirectionGuidance(brief), /thought experiment/);
  assert.equal(design.detectDesignBrief('Fix the typo in README.', { source: 'model', openEnded: false, visualDesign: false }), undefined);
  const fallback = design.detectDesignBrief(MUSIC, { source: 'fallback' });
  assert.equal(fallback.source, 'heuristic');
});

test('the interpretation block says what it is, which message it reads and that the user wins', () => {
  const prompt = 'Create a portfolio site. Keep it fast.';
  const parsed = interpretation.parsePromptAnalysis(JSON.stringify({ intent: 'Build portfolio', taskLabel: 'Portfolio', confidence: 0.9, openEnded: true, visualDesign: true, styleReferences: [], contextReferences: ['github.com/me'] }), prompt, 'initial');
  assert.equal(parsed.openEnded, true);
  assert.deepEqual(parsed.contextReferences, ['github.com/me']);
  const text = interpretation.renderPromptAnalysisContext(parsed, 'prompt_analysis');
  const [header, json] = text.split('\n');
  assert.match(header, /^Auxiliary interpretation \(advisory only; the literal user prompt is authoritative\)/);
  assert.match(header, /user message directly above/);
  assert.match(header, /follow the user/);
  assert.equal(JSON.parse(json).visualDesign, true);
  assert.match(interpretation.buildPromptAnalysisRequest(prompt, 'initial'), /contextReferences lists sites/);
});

test('the council explores directions for a new open brief and deliberates scope otherwise', () => {
  assert.equal(councilMode(MUSIC), 'direction');
  assert.equal(shouldRunScopeCouncil(MUSIC), true);
  assert.equal(councilMode('Redesign the distracting mascot.'), 'scope');
  assert.equal(councilMode('Please do not redesign the landing page; only fix the footer link.'), 'scope');
  assert.equal(shouldRunScopeCouncil('How would you design a new landing page?'), false, 'a question is not a brief');
});
