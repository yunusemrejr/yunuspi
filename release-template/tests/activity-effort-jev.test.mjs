import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const {describeActivity,describeIntelligenceActivity}=await jiti.import('../agent/extensions/lib/activity-indicators.ts');

test('an effort change reads as the thinking level move and its reason', () => {
  assert.deepEqual(describeActivity('effort.change', {from:'high', to:'medium', reason:'standard work'}),
    {label:'Effort', status:'ok', detail:'thinking high → medium · standard work'});
});

test('a held effort level is a skip that names the level and the reason', () => {
  const held=describeActivity('effort.held', {to:'high', reason:'deepseek prompt cache kept warm'});
  assert.equal(held.label, 'Effort');
  assert.equal(held.status, 'skip');
  assert.ok(held.detail.startsWith('thinking held at high'), held.detail);
  assert.equal(held.detail, 'thinking held at high · deepseek prompt cache kept warm');
});

test('a JEV judgement shows its site, answer source and question count', () => {
  const described=describeIntelligenceActivity('ml.jev.used', {route:'x', site:'rank', questions:2, cached:false});
  assert.equal(described.label, 'JEV');
  assert.equal(described.status, 'ok');
  assert.ok(described.detail.includes('Jev · rank · remote judge answered · 2 questions'), described.detail);
});

test('a site label with disallowed characters is omitted, not shown', () => {
  const described=describeIntelligenceActivity('ml.jev.used', {route:'x', site:'a<b>', questions:2, cached:false});
  assert.equal(described.detail, 'Jev · remote judge answered · 2 questions');
  assert.ok(!described.detail.includes('<'));
});
