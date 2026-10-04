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
  assert.ok(guidance.length <= design.DESIGN_GUIDANCE_CAP, 'bounded by the guidance cap even with the full tell list');
  assert.match(design.designDirectionSummary(brief), /open visual brief → explore distinct directions.*context-only: yunusemrevurgun\.com/);
});

test('refinement, explicit style references and non-visual work do not trigger a redesign pass', () => {
  const polish = design.heuristicDesignBrief('Polish the UI and fix the chat answer layout in the app.');
  assert.equal(polish.visualDesign, true);
  assert.equal(polish.openEnded, false, 'refining existing work keeps its design language');
  const polishGuidance = design.designDirectionGuidance(polish);
  assert.doesNotMatch(polishGuidance, /divergence pass|distinct directions/, 'no redesign pass for refinement');
  assert.match(polishGuidance, /generated-UI tells while choosing the direction/, 'UI tells arrive before building, not after');
  assert.match(polishGuidance, /hype badges.*gradient-filled headline text.*decorative terminal output/, 'preflight names the ornament families before building');
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

test('ambition is read from what the brief asks for and what the subject is for', () => {
  const level = prompt => design.heuristicDesignBrief(prompt)?.ambition;
  // Spectacle asked for outright, in the user's own kind of words.
  assert.equal(level('Create stunning complex website designs with advanced motion graphics'), 'immersive');
  assert.equal(level('design a portfolio website that feels alive and playful with a 3D hero'), 'immersive');
  assert.equal(level('build a cinematic scroll-driven landing page'), 'immersive');
  // Quality words mean craft for something that is used, spectacle for something that is looked at.
  assert.equal(level('make the admin dashboard stunning'), 'balanced');
  assert.equal(level('build a stunning landing page for my bakery'), 'immersive');
  // Restraint and an explicit refusal of motion win when nothing asks for spectacle.
  assert.equal(level('make this whole mail genie app into a super minimalist jelly vibe, centered UI stuff'), 'restrained');
  assert.equal(level('create a dashboard for our inventory, no animations'), 'restrained');
  assert.equal(level('create a dashboard for our inventory, no animations but make it stunning and cinematic'), 'restrained', 'a refusal of motion is not overridden by a quality word');
  assert.equal(level('fix the settings form UI'), 'restrained', 'functional subjects default to quiet');
  // Mixed or absent signals stay in the middle.
  assert.equal(level('build a landing page for my bakery'), 'balanced');
  assert.equal(level('design a calm website with a 3D hero and cinematic scroll scenes and parallax'), 'immersive', 'a single restraint word does not outvote repeated spectacle');
  assert.equal(level('design a minimalist clean quiet website with one 3D hero'), 'balanced');
  assert.equal(level('not a visual task: explain the cache policy'), undefined);
});

test('the guidance says what each ambition permits, and the immersive level lifts the count caps', () => {
  const open = ambition => design.designDirectionGuidance({ openEnded: true, visualDesign: true, ambition, contextReferences: [], styleReferences: [] });
  assert.match(open('restrained'), /Ambition: restrained[^\n]*finite-set budget/);
  assert.match(open('balanced'), /Ambition: balanced[^\n]*One signature element/);
  const immersive = open('immersive');
  assert.match(immersive, /Ambition: immersive/);
  assert.match(immersive, /signature-experience/);
  assert.match(immersive, /count caps in frontend-design and web-effects stop applying/);
  assert.match(immersive, /static baseline first/);
  assert.match(immersive, /fallback \(reduced motion, no WebGL, phone\)/);
  assert.doesNotMatch(open('restrained'), /count caps/, 'the quiet levels keep the caps');
  assert.match(open('immersive'), /creative_direct set \(include ambition and signature\)/);
  // A brief without a level (older callers) gets no ambition line rather than a guess.
  assert.doesNotMatch(design.designDirectionGuidance({ openEnded: true, visualDesign: true, contextReferences: [], styleReferences: [] }), /Ambition:/);
  assert.match(design.designDirectionSummary(design.heuristicDesignBrief('Create stunning complex website designs with advanced motion graphics')), /ambition immersive/);
});

test('the worst case (immersive, several context references, a style reference) keeps every tell', () => {
  const guidance = design.designDirectionGuidance({ openEnded: true, visualDesign: true, ambition: 'immersive', contextReferences: ['one.example.com', 'two.example.io', 'three.example.dev', 'four.example.net'], styleReferences: ['five.example.org'] });
  assert.ok(guidance.length <= design.DESIGN_GUIDANCE_CAP);
  for (const tell of design.UI_PREFLIGHT_TELLS) assert.ok(guidance.includes(tell), `cut by the size cap: ${tell}`);
  // Regression: with one context reference the old 2,000-character cap already cut the tail of the tell list.
  const withReference = design.designDirectionGuidance({ openEnded: true, visualDesign: true, contextReferences: ['example.com'], styleReferences: [] });
  assert.ok(design.UI_PREFLIGHT_TELLS.every(tell => withReference.includes(tell)));
});

test('model analysis keeps the heuristic ambition because it has no such field', () => {
  const prompt = 'Create stunning complex website designs with advanced motion graphics';
  const brief = design.detectDesignBrief(prompt, { source: 'model', visualDesign: true, openEnded: true, styleReferences: [], contextReferences: [] });
  assert.equal(brief.source, 'analysis');
  assert.equal(brief.ambition, 'immersive');
  assert.equal(design.detectDesignBrief('explain the cache policy', { source: 'model', visualDesign: false, openEnded: false, styleReferences: [], contextReferences: [] }), undefined);
});

test('GUI, app and game phrasing reaches the design protocol when the model analysis is unavailable', () => {
  for (const prompt of ['create a cute GUI app for my notes', 'make a new desktop app with a good look and feel', 'build a chess game with a lovely interface', 'design a mobile app for plant care'])
    assert.equal(design.heuristicDesignBrief(prompt)?.visualDesign, true, prompt);
  assert.equal(design.heuristicDesignBrief('write a compiler for the toy language'), undefined);
});
