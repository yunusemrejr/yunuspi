import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/code-quality.ts')));
const load=file=>import(pathToFileURL(path.join(agent,'extensions',file)));
const {codeSlop,proseReport}=await load('lib/code-quality.ts');
const {slopGuidanceSignals,inspectUiSource}=await load('lib/slop-guidance-signals.ts');
const rules=(file,source)=>codeSlop(file,source).map(f=>f.rule);
const keys=(file,source)=>slopGuidanceSignals(file,source,12).map(s=>s.key);

test('tests that cannot fail are named: tautological assertions, empty bodies, no assertion, unexplained skips',()=>{
 const js=`import test from 'node:test';
import assert from 'node:assert/strict';
test('literal', () => { assert.equal(1, 1); });
test('same value', () => { const v = build(); assert.deepEqual(v, v); });
test('truthy literal', () => { expect(true).toBe(true); });
test('empty', () => {});
test('only runs', async () => { const x = add(1, 2); console.log(x); });
it.skip('later', () => { assert.equal(add(1, 2), 3); });
test('real', () => { assert.equal(add(1, 2), 3); });
test('documented skip', () => { assert.equal(add(1, 2), 3); }); // flaky on CI until #412 lands
it.skip('documented', () => { assert.equal(add(1, 2), 3); }); // blocked on upstream #412
test('callback style', (done) => { setTimeout(done, 1); });
`;
 const found=codeSlop('tests/math.test.mjs',js);
 const byLine=Object.fromEntries(found.map(f=>[f.line,f.rule]));
 assert.equal(byLine[3],'vacuous-assertion');
 assert.equal(byLine[4],'vacuous-assertion','the same value on both sides');
 assert.equal(byLine[5],'vacuous-assertion');
 assert.equal(byLine[6],'empty-test');
 assert.equal(byLine[7],'test-without-assertion');
 assert.equal(byLine[8],'skipped-test');
 for(const line of [9,10,11,12]) assert.equal(byLine[line],undefined,`line ${line} is a real or documented test`);
 assert.deepEqual(rules('src/math.mjs',js).filter(rule=>/test|vacuous/.test(rule)),[],'production files are not test files');
});

test('Python and test-runner shapes: vacuous asserts, empty bodies and bare skips',()=>{
 const py=`import pytest
def test_a():
    assert True
def test_b():
    pass
def test_c():
    assert add(1, 2) == 3
@pytest.mark.skip
def test_d():
    assert add(2, 2) == 4
@pytest.mark.skip(reason="needs the staging database")
def test_e():
    assert add(2, 3) == 5
class T(unittest.TestCase):
    def test_f(self):
        self.assertEqual(a.b, a.b)
`;
 const byLine=Object.fromEntries(codeSlop('tests/test_math.py',py).map(f=>[f.line,f.rule]));
 assert.equal(byLine[3],'vacuous-assertion');
 assert.equal(byLine[4],'empty-test');
 assert.equal(byLine[8],'skipped-test');
 assert.equal(byLine[11],undefined,'a skip with a stated reason is documented');
 assert.equal(byLine[16],'vacuous-assertion');
 assert.equal(byLine[7],undefined);
});

test('a skip that hides a failing check and a vacuous assertion reach the automatic post-edit review',async()=>{
 const source=fs.readFileSync(path.join(agent,'extensions/lib/source-check.ts'),'utf8');
 const set=/const AUTOMATIC_SLOP = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]??'';
 for(const rule of ['vacuous-assertion','empty-test','skipped-test']) assert.ok(set.includes(`'${rule}'`),`${rule} is reviewed on every edit`);
 assert.ok(!set.includes('test-without-assertion'),'the broader no-assertion cue stays on demand: smoke tests are legitimate');
});

test('ambient blobs and placeholder image hosts are named, ordinary blur and real images stay quiet',()=>{
 const blob='<div class="absolute -top-24 -left-24 h-96 w-96 rounded-full bg-purple-500/30 blur-3xl"></div>';
 assert.ok(keys('hero.html',blob).includes('ui-ambient-blob'));
 assert.ok(keys('hero.css','.orb{position:absolute;width:480px;height:480px;border-radius:50%;filter:blur(90px);background:#7c3aed55}').includes('ui-ambient-blob'));
 assert.ok(!keys('card.html','<div class="rounded-full blur-sm h-6 w-6 bg-slate-200"></div>').includes('ui-ambient-blob'),'a small soft avatar placeholder is not an ambient wash');
 assert.ok(!keys('card.css','.thumb{border-radius:50%;filter:blur(2px)}').includes('ui-ambient-blob'));
 assert.ok(keys('page.html','<img src="https://picsum.photos/seed/a/600/400" alt="Team">').includes('ui-placeholder-media'));
 assert.ok(keys('page.html','<div style="background:url(https://placehold.co/600x400)"></div>').includes('ui-placeholder-media'));
 assert.ok(!keys('page.html','<img src="/assets/team.jpg" alt="The team at the 2025 offsite">').includes('ui-placeholder-media'));
});

test('coloured glow halos are named; neutral shadows, offset shadows and focus rings stay quiet',()=>{
 assert.ok(keys('a.css','.card{box-shadow:0 0 40px rgba(99,102,241,.5)}').includes('ui-glow-halo'));
 assert.ok(keys('a.css','h1{text-shadow:0 0 30px #0ff}').includes('ui-glow-halo'));
 assert.ok(keys('a.html','<h1 class="drop-shadow-[0_0_30px_#8b5cf6]">Ship</h1>').includes('ui-glow-halo'));
 assert.ok(keys('a.html','<button class="shadow-lg shadow-indigo-500/50">Go</button>').includes('ui-glow-halo'));
 for(const quiet of ['.n{box-shadow:0 10px 30px rgba(0,0,0,.1)}','.f:focus{box-shadow:0 0 0 3px rgba(99,102,241,.4)}','.s{box-shadow:0 0 24px rgba(0,0,0,.4)}','.t{box-shadow:0 4px 12px #6366f166}'])
  assert.ok(!keys('b.css',quiet).includes('ui-glow-halo'),quiet);
});

test('the default font rotation and dark purple gradient washes are named; one font and a brand gradient decision stay quiet',()=>{
 assert.ok(keys('a.html','<style>body{font-family:Inter}h1{font-family:"Space Grotesk"}</style>').includes('ui-stock-fonts'));
 assert.ok(!keys('a.html','<style>body{font-family:Inter,system-ui}</style>').includes('ui-stock-fonts'),'a single common face is not a rotation');
 assert.ok(keys('a.html','<div class="bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900"></div>').includes('ui-stock-palette'));
 assert.ok(keys('a.html','<div class="bg-linear-to-r from-violet-500 to-slate-900"></div>').includes('ui-stock-palette'),'Tailwind v4 gradient names are covered');
 assert.ok(!keys('a.html','<div class="bg-gradient-to-b from-slate-100 to-white"></div>').includes('ui-stock-palette'));
 const inspected=inspectUiSource('a.html','<h1 class="drop-shadow-[0_0_30px_#8b5cf6]">x</h1>');
 assert.ok(inspected.findings.some(f=>f.key==='ui-glow-halo'),'the explicit UI check shares the edit-time policy');
});

test('stat-banner figures need a basis and chat-assistant boilerplate is named in prose',()=>{
 assert.ok(keys('a.html','<p>Trusted by 10K+ developers. 99.99% uptime guaranteed.</p>').includes('prose-metric-theater'));
 assert.ok(!keys('a.html','<p>Measured on our staging fleet: 99.95% uptime over 90 days (n = 12 hosts).</p>').includes('prose-metric-theater'));
 const prose=proseReport('Great question! I hope this helps. Feel free to reach out if you need anything. It is worth mentioning that this comprehensive guide plays a crucial role in your workflow, and I would be happy to help. Rest assured, it is production-ready.');
 const phrases=prose.phrases.map(p=>p.phrase);
 for(const expected of ['great question','hope this helps','feel free to reach','worth mentioning','comprehensive guide','plays a crucial role in','would be happy to','rest assured','production-ready']) assert.ok(phrases.some(p=>p.includes(expected)),expected);
 const technical=proseReport('Unmatched rows are written to the reject file. The deep dive section below measures the parser. The suite covers all-in-one wiring only when the flag is set.');
 assert.ok(!technical.phrases.map(p=>p.phrase).some(p=>/unmatched|deep dive/.test(p)),'ordinary technical words are not stock phrases');
});

test('every pre-build UI tell survives the guidance size cap, so a new tell can never silently push an old one out',async()=>{
 const {UI_PREFLIGHT_TELLS,designDirectionGuidance}=await load('lib/design-direction.ts');
 const guidance=designDirectionGuidance({openEnded:true,visualDesign:true,contextReferences:[],styleReferences:[]});
 for(const tell of UI_PREFLIGHT_TELLS) assert.ok(guidance.includes(tell),`cut by the size cap: ${tell}`);
 assert.ok(UI_PREFLIGHT_TELLS.some(tell=>/blob/.test(tell)&&/glow/.test(tell)),'the ambient blob and glow halo tells are part of the pre-build list');
});
