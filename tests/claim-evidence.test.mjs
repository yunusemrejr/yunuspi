import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-memory/context-evidence.ts')));
const { checkClaims } = await import(pathToFileURL(path.join(agent, 'extensions/pi-memory/context-evidence.ts')));
const { registerContextTools } = await import(pathToFileURL(path.join(agent, 'extensions/pi-memory/context-tools.ts')));
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-evidence-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'Measurement scope: fixture only.\nMedian elapsed time was 123 ms.\nUnverified promotional example: 3x faster.\n');
  return cwd;
}
const quote = 'Median elapsed time was 123 ms.';
const input = (overrides = {}) => ({ claim: quote, kind: 'quotation', evidence: [{ source: 'report.txt', quote }], ...overrides });
test('quotation provenance is exact and current; interpretations are never called true', t => {
  const cwd = fixture(t);
  const result = checkClaims(cwd, [input(), input({kind:'interpretation'}), input({claim:'Median elapsed time was 12 ms.'}), input({evidence:[]})]);
  assert.deepEqual(result.results.map(x => x.status), ['quotation_matched', 'interpretation_requires_review', 'interpretation_requires_review', 'evidence_gap']);
  assert.equal(result.results[0].references[0].line, 2);
  assert.match(result.results[0].references[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.match(result.scope, /does not verify source authority/);
  assert.equal(result.gaps, 1); assert.equal(result.reviewRequired, 2);
  // Invented semantic relation is never established just because the numbers occur.
  assert.equal(checkClaims(cwd, [input({ claim: 'Production is 123 ms and 3x faster.', kind: 'interpretation' })]).results[0].status, 'interpretation_requires_review');
});
test('missing, stale and partially valid references remain evidence gaps', t => {
  const cwd = fixture(t), hash = checkClaims(cwd, [input()]).results[0].references[0].sourceHash;
  fs.appendFileSync(path.join(cwd, 'report.txt'), 'Revision changes scope.\n');
  const result = checkClaims(cwd, [input({evidence:[{source:'report.txt',quote,sourceHash:hash}]}), input({evidence:[{source:'report.txt',quote:'A fabricated source statement.'}]}), input({evidence:[{source:'missing',quote}]}), input({evidence:[{source:'report.txt',quote},{source:'missing',quote}]})]);
  assert.deepEqual(result.results.map(x=>x.status), Array(4).fill('evidence_gap'));
  assert.deepEqual(result.results.slice(0,3).map(x=>x.references[0].status), ['source_changed','quote_missing','source_unavailable']);
});
test('source confinement, private paths, binary data and bounds fail closed', t => {
  const cwd = fixture(t);
  fs.symlinkSync('/etc/passwd', path.join(cwd, 'outside'));
  fs.writeFileSync(path.join(cwd, '.env'), quote);
  fs.writeFileSync(path.join(cwd, 'binary'), Buffer.from([0, 65]));
  fs.writeFileSync(path.join(cwd, 'huge'), 'a'.repeat(262145));
  for (const source of ['outside','.env','binary','huge','../unavailable']) assert.equal(checkClaims(cwd,[input({evidence:[{source,quote}]})]).results[0].references[0].status,'source_unavailable');
  assert.throws(()=>checkClaims(cwd,[]), /1..12/);
  assert.throws(()=>checkClaims(cwd,Array(13).fill(input())), /1..12/);
  assert.throws(()=>checkClaims(cwd,[input({claim:'x'})]), /8..1000/);
  assert.throws(()=>checkClaims(cwd,[input({evidence:Array(4).fill({source:'report.txt',quote})})]), /at most three/);
  assert.throws(()=>checkClaims(cwd,[input()], AbortSignal.abort()), {name:'AbortError'});
});
test('native tool works without persisted branch or memory mutations and emits bounded receipts', async t => {
  const cwd = fixture(t), tools = new Map();
  registerContextTools({registerTool:tool=>tools.set(tool.name,tool)},()=>{throw Error('claim_check must not access memory');});
  const tool = tools.get('claim_check'); assert.ok(tool);
  const reply = await tool.execute('test', {claims:[input()]}, undefined, undefined, {cwd});
  assert.equal(reply.details.results[0].status,'quotation_matched');
  assert.ok(reply.content[0].text.length < 1600);
  assert.equal(fs.readdirSync(cwd).length, 1);
});
test('large missing source labels cannot inflate returned evidence receipts', t => {
  const cwd = fixture(t);
  const claims = Array.from({length:12},()=>input({evidence:Array.from({length:3},(_,i)=>({source:String(i)+'a'.repeat(4095),quote}))}));
  const result = checkClaims(cwd,claims);
  assert.equal(result.gaps,12);
  assert.ok(JSON.stringify(result).length < 4096);
  assert.equal(result.results[0].references[2].referenceIndex,2);
});
