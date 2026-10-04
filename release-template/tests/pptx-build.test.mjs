import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const { buildPptx } = await load('agent/extensions/lib/pptx-build.ts');
const { openZip } = await load('agent/extensions/lib/office-zip.ts');
const { parseXml } = await load('agent/extensions/lib/xml-lite.ts');
const { readOffice } = await load('agent/extensions/lib/office-read.ts');
const { findOfficeSuite } = await load('agent/extensions/lib/office-render.ts');
const deliverables = (await load('agent/extensions/deliverables.ts')).default;

const NOW = new Date('2026-10-04T09:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-'));
function png(width = 320, height = 200) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const build = (spec, images = { 'pic.png': png() }) => buildPptx(spec, (name) => { if (!images[name]) throw new Error('not found'); return images[name]; }, NOW);
const entries = (buffer) => { const zip = openZip(buffer); return new Map(zip.entries.filter(e => !e.directory).map(e => [e.name, zip.read(e.name).toString('utf8')])); };
const slideXml = (parts) => [...parts.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/))).map(name => parts.get(name));
const sizes = (xml) => [...xml.matchAll(/ sz="(\d+)"/g)].map(m => Number(m[1]) / 100);
const titleOf = (xml) => { const m = /type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/.exec(xml); return m ? [...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(t => t[1]).join('') : ''; };

const FULL = {
  title: 'Review', author: 'Tester', footer: 'Acme',
  slides: [
    { title: 'Quarterly review', subtitle: 'Operations', notes: 'Welcome.\nBe brief.' },
    { title: 'Agenda', bullets: ['Results', { text: 'Hiring', level: 0 }, ['Engineering', 'Sales'], 'Next steps [plan](https://example.com/plan)'] },
    { title: 'Before and after', columns: [{ heading: 'Before', bullets: ['Manual'] }, { heading: 'After', bullets: ['Automatic', 'Alerts'] }] },
    { title: 'Dashboard', image: { path: 'pic.png', alt: 'Dashboard screenshot', caption: 'Figure 1' }, bullets: ['Live metrics'] },
    { title: 'Revenue', table: { header: ['Region', 'Q3'], rows: [['North', '1,450'], ['South', '1,010']] } },
    { title: 'Voice of the customer', quote: { text: 'It saved us a day every week.', cite: 'Head of Ops' } },
    { title: 'Summary', text: 'We grew.\n\nNext we retain.' },
    { layout: 'section', title: 'Appendix' },
  ],
};

test('pptx: every layout builds a well-formed, fully linked package that the reader understands', () => {
  const built = build(FULL), parts = entries(built.buffer);
  for (const [name, body] of parts) if (/\.(xml|rels)$/.test(name)) parseXml(body);
  assert.deepEqual(built.stats, { slides: 8, split: 0, images: 1, tables: 1, notes: 1 }); assert.deepEqual(built.warnings, []);
  // Every relationship target exists, and every part has a content type.
  const types = parts.get('[Content_Types].xml');
  for (const [name, body] of parts) {
    if (name.endsWith('.rels')) {
      const base = path.posix.dirname(path.posix.dirname(name));
      for (const m of body.matchAll(/Target="([^"]+)"(?: TargetMode="External")?/g)) if (!/TargetMode="External"/.test(m[0]) && !/^https?:/.test(m[1])) assert.ok(parts.has(path.posix.normalize(path.posix.join(base === '.' ? '' : base, m[1]))), `${name} -> ${m[1]}`);
    } else if (name !== '[Content_Types].xml') assert.ok(types.includes(`PartName="/${name}"`) || types.includes(`Extension="${name.split('.').pop()}"`), `${name} has a content type`);
  }
  const read = readOffice(path.join(tmpFile(built.buffer)), { maxChars: 4000 });
  assert.equal(read.kind, 'pptx'); assert.equal(read.slides.length, 8);
  assert.deepEqual(read.slides.map(s => s.title), ['Quarterly review', 'Agenda', 'Before and after', 'Dashboard', 'Revenue', 'Voice of the customer', 'Summary', 'Appendix']);
  assert.match(read.slides[0].notes, /Welcome\./); assert.equal(read.slides.reduce((n, s) => n + s.emptyPlaceholders, 0), 0);
  assert.deepEqual(read.findings.filter(f => f.severity !== 'info'), [], 'no empty slides, tiny type or dense slides');
  assert.match(parts.get('ppt/slides/_rels/slide2.xml.rels'), /hyperlink" Target="https:\/\/example\.com\/plan" TargetMode="External"/);
});
function tmpFile(buffer) { const file = path.join(tmp(), 'deck.pptx'); fs.writeFileSync(file, buffer); return file; }

test('pptx: a short list is large; a long one continues on numbered slides and never drops below a readable size', () => {
  const short = slideXml(entries(build({ slides: [{ title: 'Three', bullets: ['One', 'Two', 'Three'] }] }).buffer))[0];
  assert.ok(Math.max(...sizes(short)) >= 28 && sizes(short).includes(28), 'few words are set large');
  const long = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}: a bullet with enough words that it takes a full line on the slide and then some more`);
  const built = build({ slides: [{ title: 'Everything', bullets: long }] }), slides = slideXml(entries(built.buffer));
  assert.ok(slides.length >= 4 && built.stats.split === slides.length - 1);
  assert.deepEqual(slides.map(titleOf), ['Everything', ...slides.slice(1).map((_, at) => `Everything (${at + 2}/${slides.length})`)]);
  assert.ok(built.warnings.some(w => /continue over/.test(w)));
  const bodies = slides.map(xml => (xml.match(/<a:t>Item \d+/g) ?? []).length);
  assert.equal(bodies.reduce((a, b) => a + b, 0), 30, 'no bullet is lost or duplicated');
  for (const xml of slides) assert.ok(Math.min(...sizes(xml)) >= 12 && sizes(xml).filter(size => size >= 20).length > 0, 'type stays readable');
  assert.deepEqual(readOffice(tmpFile(built.buffer), { maxChars: 500 }).findings.filter(f => f.severity !== 'info'), [], 'no slide counts as dense');
});

test('pptx: tables continue with the header repeated and every row kept', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`Row ${i + 1}`, 'x', 'y']);
  const built = build({ slides: [{ title: 'Data', table: { header: ['A', 'B', 'C'], rows } }] }), slides = slideXml(entries(built.buffer));
  assert.ok(slides.length > 1); let total = 0;
  for (const xml of slides) { assert.match(xml, /firstRow="1"/); assert.match(xml, /<a:t>A<\/a:t>/); total += (xml.match(/<a:tr /g) ?? []).length - 1; }
  assert.equal(total, 40);
  const ragged = slideXml(entries(build({ slides: [{ title: 'Ragged', table: { rows: [['a', 'b', 'c'], ['d']] } }] }).buffer))[0];
  assert.equal((ragged.match(/<a:tc>/g) ?? []).length, 6, 'short rows are padded to the widest row');
  assert.match(ragged, /firstRow="0"/);
});

test('pptx: text is escaped, control characters are dropped and a title never carries markup', () => {
  const built = build({ slides: [{ title: 'Q&A <b>"live"</b> \u0001\u0007', bullets: ['5 < 6 & 7 > 4', 'tab\there', 'emoji 🚀 and ünïcode'] }] });
  const parts = entries(built.buffer); for (const [name, body] of parts) if (/\.(xml|rels)$/.test(name)) parseXml(body);
  const read = readOffice(tmpFile(built.buffer), { maxChars: 2000 });
  assert.equal(read.slides[0].title, 'Q&A <b>"live"</b>'); assert.match(read.slides[0].text, /5 < 6 & 7 > 4/); assert.match(read.slides[0].text, /🚀 and ünïcode/);
});

test('pptx: models can pass a string, items, nested arrays or objects for a list', () => {
  const read = (slide) => readOffice(tmpFile(build({ slides: [slide] }).buffer), { maxChars: 2000 }).slides[0];
  assert.match(read({ title: 'S', bullets: '- one\n* two\n3. three\n\n' }).text, /one[\s\S]*two[\s\S]*three/);
  assert.match(read({ title: 'S', items: ['a', ['b1', 'b2'], { text: 'c', items: ['c1'] }, 42] }).text, /a[\s\S]*b1[\s\S]*b2[\s\S]*c[\s\S]*c1[\s\S]*42/);
  assert.equal(read({ heading: 'Alias title', bullets: ['x'] }).title, 'Alias title');
  assert.match(read({ title: 'Cols', left: ['l1'], right: { heading: 'R', bullets: ['r1'] } }).text, /l1[\s\S]*R[\s\S]*r1/);
  assert.match(read({ title: 'Q', quote: 'Plain string quote', cite: 'Someone' }).text, /Plain string quote[\s\S]*Someone/);
  assert.equal(read({ title: 'Only title' }).title, 'Only title', 'a bare slide after the first becomes a section');
});

test('pptx: mistakes are named by slide and fix', () => {
  const run = (spec, images) => () => build(spec, images);
  assert.throws(run({}), /non-empty array of slides/); assert.throws(run({ slides: [] }), /non-empty/);
  assert.throws(run({ slides: [{ title: 'A' }, { layout: 'poster', title: 'B' }] }), /Slide 2: unknown layout "poster"/);
  assert.throws(run({ slides: [{ title: 'A', columns: [{ bullets: ['x'] }] }] }), /two to four columns/);
  assert.throws(run({ slides: [{ title: 'A', table: { rows: [] } }] }), /needs table\.rows/);
  assert.throws(run({ slides: [{ title: 'A', quote: { text: '  ' } }] }), /needs quote\.text/);
  assert.throws(run({ slides: [{ title: 'A', image: {} }] }), /needs image\.path/);
  assert.throws(run({ slides: [{ title: 'Ok' }, { title: 'Pic', image: { path: 'missing.png' } }] }), /Slide 2: image missing\.png: not found/);
  assert.throws(run({ slides: [{ title: 'Pic', image: { path: 'bad.gif' } }] }, { 'bad.gif': Buffer.from('GIF89a....') }), /Only PNG and JPEG/);
  assert.throws(run({ slides: Array.from({ length: 201 }, () => ({ title: 'x' })) }), /At most 200 slides/);
});

test('pptx: images keep their aspect ratio inside the slide, and a missing alt text is reported', () => {
  const built = build({ slides: [{ title: 'Wide', image: { path: 'pic.png' } }] }), xml = slideXml(entries(built.buffer))[0];
  assert.ok(built.warnings.some(w => /no alt text/.test(w)));
  const frame = /<p:pic>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml).slice(1).map(Number);
  assert.ok(Math.abs(frame[2] / frame[3] - 1.6) < 0.01, 'a 320x200 image stays 1.6:1');
  assert.ok(frame[0] >= 0 && frame[1] >= 0 && frame[0] + frame[2] <= 12192000 && frame[1] + frame[3] <= 6858000, 'inside the slide');
  assert.match(xml, /descr=""/);
  assert.match(slideXml(entries(build({ slides: [{ title: 'Wide', image: { path: 'pic.png', alt: 'A grey box' } }] }).buffer))[0], /descr="A grey box"/);
});

test('pptx: size and theme options apply, and the same spec builds the same bytes', () => {
  const a = build(FULL).buffer, b = build(FULL).buffer; assert.ok(a.equals(b));
  const four = entries(build({ size: '4:3', dark: true, accent: '#10B981', font: 'Arial', slides: [{ title: 'T', bullets: ['x'] }] }).buffer);
  assert.match(four.get('ppt/presentation.xml'), /<p:sldSz cx="9144000" cy="6858000" type="screen4x3"\/>/);
  assert.match(four.get('ppt/slideMasters/slideMaster1.xml'), /srgbClr val="111827"/);
  assert.match(four.get('ppt/theme/theme1.xml'), /accent1><a:srgbClr val="10B981"/); assert.match(four.get('ppt/theme/theme1.xml'), /latin typeface="Arial"/);
  assert.match(entries(build({ slides: [{ title: 'T', bullets: ['x'] }] }).buffer).get('ppt/presentation.xml'), /cx="12192000" cy="6858000"\/>/);
});

test('pptx: a long title shrinks to fit and a hopeless one is reported', () => {
  const title = 'A title that goes on and on about everything the team did, learned, broke and fixed during the quarter, including the parts nobody wanted to talk about';
  const [xml] = slideXml(entries(build({ slides: [{ title, bullets: ['x'] }] }).buffer));
  assert.ok(Math.max(...sizes(xml.match(/type="title"[\s\S]*?<\/p:sp>/)[0])) <= 28, 'the title is set smaller, not clipped');
  assert.ok(build({ slides: [{ title: title.repeat(3), bullets: ['x'] }] }).warnings.some(w => /is long/.test(w)));
});

function host() {
  const handlers = new Map(), tools = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool: (tool) => tools.set(tool.name, tool), sendMessage: async () => {} };
  const run = async (name, params, ctx) => { const tool = tools.get(name); const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params; return tool.execute('id', prepared, undefined, undefined, ctx); };
  return { pi, run };
}

test('office_doc build writes, verifies and settles a deck; the format option and path rules follow docx and xlsx', async () => {
  const dir = tmp(), h = host(), ctx = { cwd: dir, sessionManager: { getSessionId: () => 's' } }; deliverables(h.pi);
  fs.writeFileSync(path.join(dir, 'pic.png'), png());
  const built = await h.run('office_doc', { action: 'build', path: 'out/deck.pptx', spec: FULL }, ctx);
  assert.equal(built.details.kind, 'pptx'); assert.equal(built.details.stats.slides, 8); assert.equal(built.details.verification.status, 'pass');
  assert.ok(fs.existsSync(path.join(dir, 'out/deck.pptx')));
  await assert.rejects(h.run('office_doc', { action: 'build', path: 'out/deck.pptx', spec: FULL }, ctx), /already exists.*overwrite:true/);
  assert.equal((await h.run('office_doc', { action: 'build', path: 'out/deck.pptx', spec: FULL, overwrite: true }, ctx)).details.kind, 'pptx');
  assert.equal((await h.run('office_doc', { action: 'build', path: 'noext', format: 'pptx', spec: { slides: [{ title: 'Hi', subtitle: 'there' }] } }, ctx)).details.kind, 'pptx');
  assert.ok(fs.existsSync(path.join(dir, 'noext.pptx')));
  const asText = await h.run('office_doc', { action: 'build', path: 'text.pptx', spec: JSON.stringify({ slides: [{ title: 'Hi', subtitle: 'there' }] }) }, ctx);
  assert.equal(asText.details.verification.status, 'pass');
  await assert.rejects(h.run('office_doc', { action: 'build', path: 'x.pptx' }, ctx), /needs a spec object \(\{title, slides/);
  await assert.rejects(h.run('office_doc', { action: 'build', path: '../x.pptx', spec: FULL }, ctx), /inside the current workspace/);
  const read = await h.run('office_doc', { action: 'read', path: 'out/deck.pptx' }, ctx);
  assert.equal(read.details.slides.length, 8); assert.equal(read.details.status, 'pass');
  const checked = await h.run('deliverable_check', { path: 'out/deck.pptx' }, ctx);
  assert.equal(checked.details.checked[0].status, 'pass');
});

test('pptx: LibreOffice renders every slide the builder wrote', { timeout: 240_000 }, async (t) => {
  if (!findOfficeSuite() || process.env.YUNUSPI_SKIP_OFFICE_RENDER === '1') return t.skip('LibreOffice is not installed (or rendering is skipped)');
  const { renderOffice } = await load('agent/extensions/lib/office-render.ts');
  const dir = tmp(), file = path.join(dir, 'deck.pptx'), out = path.join(dir, 'out'); fs.mkdirSync(out);
  fs.writeFileSync(file, build({ slides: [{ title: 'Deck', subtitle: 'Sub' }, { title: 'Points', bullets: ['One', 'Two'] }, { title: 'Numbers', table: { header: ['A', 'B'], rows: [['1', '2']] } }] }).buffer);
  const stagingRoot = fs.mkdtempSync(path.join(os.homedir(), 'yunuspi-stage-test-'));
  try { const rendered = await renderOffice(file, out, { pages: 0, stagingRoot }); assert.equal(rendered.pageCount, 3); } finally { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
});

test('pptx: numbered steps become real automatic numbers, and the numbering continues on follow-on slides', () => {
  const run = (slide) => slideXml(entries(build({ slides: [slide] }).buffer));
  const [steps] = run({ title: 'Steps', bullets: ['1. Record', '2) Structure', '3. Redline'] });
  assert.deepEqual([...steps.matchAll(/buAutoNum type="arabicPeriod" startAt="(\d+)"/g)].map(m => m[1]), ['1', '2', '3']);
  assert.doesNotMatch(steps, /buChar/); assert.match(steps, /<a:t>Record<\/a:t>/); assert.doesNotMatch(steps, /<a:t>\d[.)] /, 'the typed prefix is replaced by the automatic number');
  assert.doesNotMatch(run({ title: 'Mixed', bullets: ['1. one', 'two', 'three'] })[0], /buAutoNum/, 'a list that is only partly numbered stays a bullet list');
  const [forced] = run({ title: 'Forced', numbered: true, bullets: ['a', ['sub'], 'b'] });
  assert.deepEqual([...forced.matchAll(/startAt="(\d+)"/g)].map(m => m[1]), ['1', '2'], 'sub-bullets keep their dash, the top level counts');
  const long = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1} with enough words to fill a line and then some more words`);
  const slides = run({ title: 'Many', bullets: long });
  assert.ok(slides.length > 1);
  assert.deepEqual(slides.flatMap(xml => [...xml.matchAll(/startAt="(\d+)"/g)].map(m => Number(m[1]))), Array.from({ length: 30 }, (_, i) => i + 1));
  const columns = run({ title: 'Two', numbered: true, columns: [{ heading: 'A', bullets: ['x', 'y'] }, { heading: 'B', bullets: ['p', 'q'] }] })[0];
  assert.deepEqual([...columns.matchAll(/startAt="(\d+)"/g)].map(m => m[1]), ['1', '2', '1', '2'], 'each column counts from one');
});
