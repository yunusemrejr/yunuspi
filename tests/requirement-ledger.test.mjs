import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/requirement-ledger.ts')));
const { extractRequirements, foldRequirements, renderRequirementLedger, settleRequirements, emptyRequirementLedger } =
  await import(pathToFileURL(path.join(agent, 'extensions/lib/requirement-ledger.ts')));

test('every part of a short multi-part demand becomes a tracked requirement', () => {
  const found = extractRequirements('Use "developed by" instead of "written by" in the footer. Move the AI disclosure to the article header; also add llms.txt for AI agents.');
  assert.equal(found.items.length, 3, JSON.stringify(found.items));
  assert.match(found.items[1], /AI disclosure/);
  assert.match(found.items[2], /llms\.txt/);
});

test('list items are always requirements; long pasted charters do not flood the ledger', () => {
  const charter = `${'We always value quality and the harness should stay coherent. '.repeat(40)}\n1. Block push when review rounds are zero\n2. Register real suites as checks\n- Keep the release in sync`;
  const found = extractRequirements(charter);
  assert.deepEqual(found.items, ['Block push when review rounds are zero', 'Register real suites as checks', 'Keep the release in sync']);
  const pasted = extractRequirements('Fix it.\n<pasted_content id="x">You must do A. You must do B. You should do C.</pasted_content>');
  assert.deepEqual(pasted.items, [], 'pasted evidence is not the demand');
});

test('subjective criteria and open-ended mandates are bounded by an explicit definition of done', () => {
  let { ledger } = foldRequirements(emptyRequirementLedger(), "Make the landing page more visual and premium, no slop. Don't stop until done.");
  assert.equal(ledger.unbounded, true);
  assert.deepEqual(ledger.subjective.sort(), ['more visual', 'no slop', 'premium']);
  const text = renderRequirementLedger(ledger);
  assert.match(text, /concrete observable check/);
  assert.match(text, /done means every R# above is met/);
  assert.equal(foldRequirements(emptyRequirementLedger(), 'Fix the typo in README.').added.length, 0, 'single-part work stays simple');
});

test('ids stay stable across follow-ups; reported items settle, unreported ones stay open', () => {
  let { ledger } = foldRequirements(emptyRequirementLedger(), '1. Add the chart\n2. Fix the footer\n3. Deploy it');
  ({ ledger } = foldRequirements(ledger, '- Rename the header\n- Add alt text to images'));
  assert.deepEqual(ledger.items.map(i => i.id), ['R1', 'R2', 'R3', 'R4', 'R5']);
  const first = settleRequirements(ledger, 'R1 done (chart renders), R2 fixed, R4 renamed. R5: alt text added.');
  assert.deepEqual(first.open.map(i => i.id), ['R3']);
  ({ ledger } = foldRequirements(first.ledger, '1. Add dark mode\n2. Add a print stylesheet'));
  assert.deepEqual(ledger.items.map(i => i.id), ['R3', 'R6', 'R7'], 'settled ids are never reused');
  const all = settleRequirements(ledger, 'R3 deployed and verified; R6 and R7 done.');
  assert.deepEqual(all.open, []);
  assert.deepEqual(all.ledger.items, []);
  assert.equal(all.ledger.next, 7);
});
