import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const lib = (name) => import(pathToFileURL(path.join(root, 'agent/extensions/lib', name)));
const { openZip, writeZip, safeEntryName } = await lib('office-zip.ts');
const { parseXml, XmlError, descendantsOf, textOf, escapeXml, decodeEntities } = await lib('xml-lite.ts');
const { evaluateFormula, columnName, columnNumber } = await lib('sheet-formula.ts');
const { buildDocx, buildXlsx, inlineRuns, validateSheetName, describeImage } = await lib('office-build.ts');
const { readOffice, placeholderHits } = await lib('office-read.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-files-'));
const codes = (read, severity) => read.findings.filter(f => !severity || f.severity === severity).map(f => f.code);
/** A valid 8x8 PNG made from raw zlib data, so tests need no image library. */
function png(width = 8, height = 8) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('zip: entries round-trip, damage is detected and unsafe names are refused', () => {
  const zip = openZip(writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: 'x'.repeat(5000) }]));
  assert.deepEqual(zip.entries.map(e => e.name), ['a.txt', 'dir/b.txt']);
  assert.equal(zip.text('a.txt'), 'hello');
  assert.equal(zip.read('dir/b.txt').length, 5000);
  assert.deepEqual(zip.integrityProblems(), []);
  assert.deepEqual(writeZip([{ name: 'a.txt', data: 'hello' }]), writeZip([{ name: 'a.txt', data: 'hello' }]), 'deterministic output');
  const bytes = Buffer.from(writeZip([{ name: 'a.txt', data: 'hello world' }]));
  bytes[bytes.indexOf('hello world')] ^= 0xff;
  assert.match(openZip(bytes).integrityProblems().join(' '), /CRC-32 mismatch/);
  assert.throws(() => writeZip([{ name: '../evil', data: 'x' }]), /Invalid or duplicate/);
  assert.throws(() => writeZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /Invalid or duplicate/);
  assert.ok(!safeEntryName('/abs') && !safeEntryName('a/../b') && !safeEntryName('a\\b') && safeEntryName('ok/path.xml'));
  assert.throws(() => openZip(Buffer.from('not a zip at all, just text of some length')), /Not a ZIP archive/);
  assert.throws(() => openZip(bytes.subarray(0, bytes.length - 10)), /Not a ZIP archive|Corrupt/);
});

test('xml: entities, CDATA, namespaces and well-formedness errors with positions', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a:r x="1 &amp; 2" y=\'q\'><b>t&lt;1&#x41;&#66;</b><![CDATA[<raw>]]><c/></a:r>');
  assert.equal(root.name, 'a:r'); assert.equal(root.attrs.x, '1 & 2'); assert.equal(textOf(root), 't<1AB<raw>');
  assert.equal(descendantsOf(root, 'b', 'c').length, 2);
  assert.equal(decodeEntities('&unknown; &#0;'), '&unknown; &#0;');
  assert.equal(escapeXml('a<b>&"\u0001'), 'a&lt;b&gt;&amp;&quot;');
  assert.throws(() => parseXml('<a>\n<b></a>'), (e) => e instanceof XmlError && e.line === 2 && /does not match/.test(e.message));
  assert.throws(() => parseXml('<a><b>'), /never closed/);
  assert.throws(() => parseXml('<a/><b/>'), /More than one root/);
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a/>'), /Entity declarations/);
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /Duplicate attribute/);
  assert.throws(() => parseXml('text'), /outside the root|No root/);
  const deep = '<a>'.repeat(300) + '</a>'.repeat(300);
  assert.throws(() => parseXml(deep), /too deep/);
});

test('formulas: precedence, functions, cross-sheet references, errors, laziness and unsupported features', () => {
  const sheets = { S: { '1,1': 10, '1,2': 20, '1,3': 'x', '2,1': { formula: 'A1*2' }, '1,4': null } };
  const lookup = (sheet, col, row) => (sheets[sheet ?? 'S'] ?? {})[`${col},${row}`] ?? null;
  const calc = (formula) => evaluateFormula(formula, lookup, 'S');
  const value = (formula) => { const r = calc(formula); assert.ok(r.ok, `${formula}: ${JSON.stringify(r)}`); return r.value; };
  assert.equal(value('=1+2*3'), 7); assert.equal(value('=(1+2)*3'), 9); assert.equal(value('=-2^2'), 4); assert.equal(value('=2^3^2'), 512);
  assert.equal(value('=A1+A2'), 30); assert.equal(value('=B1'), 20, 'a formula cell is evaluated through its reference');
  assert.equal(value('=SUM(A1:A2, 5)'), 35); assert.equal(value('=AVERAGE(A1:A2)'), 15); assert.equal(value('=MAX(A1:A2)'), 20); assert.equal(value('=COUNT(A1:A3)'), 2); assert.equal(value('=COUNTA(A1:A4)'), 3);
  assert.equal(value('=ROUND(2.345,2)'), 2.35); assert.equal(value('=ROUND(-2.5)'), -3); assert.equal(value('=ABS(-4)'), 4); assert.equal(value('=50%'), 0.5);
  assert.equal(value('=IF(A1>5,"big","small")'), 'big'); assert.equal(value('=IF(A1>50,1/0,"safe")'), 'safe', 'the untaken branch is never evaluated');
  assert.equal(value('=IFERROR(1/0,"fallback")'), 'fallback'); assert.equal(value('="a"&"b"&1'), 'ab1'); assert.equal(value('=AND(A1>1,A2>1)'), true);
  assert.equal(value('=LEN("hello")'), 5); assert.equal(value('=A1=10'), true); assert.equal(value('=A3="X"'), true, 'string comparison ignores case');
  assert.deepEqual(calc('=1/0'), { ok: false, error: '#DIV/0!' });
  assert.deepEqual(calc('=A3+1'), { ok: false, error: '#VALUE!' });
  assert.equal(calc('=VLOOKUP(1,A1:B2,2,0)').unsupported, true);
  assert.equal(calc('=NOSUCH(1)').unsupported, true);
  assert.equal(calc('=1 +').ok, false);
  assert.equal(columnName(1), 'A'); assert.equal(columnName(27), 'AA'); assert.equal(columnNumber('AB'), 28);
});

test('inline markup becomes runs; sheet names and images are validated', () => {
  assert.deepEqual(inlineRuns('a **b** *c* `d` [e](https://x.io)'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }, { text: ' ' }, { text: 'e', link: 'https://x.io' }]);
  assert.deepEqual(inlineRuns('2 * 3 * 4'), [{ text: '2 * 3 * 4' }], 'spaced asterisks are arithmetic, not emphasis');
  const seen = new Set();
  assert.equal(validateSheetName('Budget', seen), 'Budget');
  for (const bad of ['', 'x'.repeat(32), 'a/b', 'a:b', "'quoted'", 'History', 'budget']) assert.throws(() => validateSheetName(bad, seen), /sheet|Sheet|31|reserved|Duplicate|name/i, bad);
  assert.deepEqual(describeImage(png(3, 2)), { data: png(3, 2), format: 'png', width: 3, height: 2 });
  assert.throws(() => describeImage(Buffer.from('GIF89a......')), /PNG and JPEG/);
});

test('docx: built content is read back intact and independent of any office suite', () => {
  const spec = {
    title: 'Quarterly report', subtitle: 'Q3', author: 'QA', header: 'Acme', footer: 'Page {page} of {pages}',
    blocks: [
      { type: 'heading', level: 1, text: 'Summary' },
      { type: 'paragraph', text: 'Revenue grew **12%**, see [docs](https://example.com).' },
      { type: 'bullets', items: ['one', { text: 'nested', level: 1 }, 'two'] }, { type: 'numbered', items: ['first', 'second'] },
      { type: 'heading', level: 2, text: 'Numbers' },
      { type: 'table', header: ['Region', 'Revenue'], rows: [['North', 1200], ['South', '1,540']], style: 'banded', caption: 'Table 1' },
      { type: 'image', path: 'fig.png', width: 2, alt: 'A green square', caption: 'Figure 1' },
      { type: 'quote', text: 'Short', cite: 'Someone' }, { type: 'code', text: 'a\nb' }, { type: 'pagebreak' }, { type: 'paragraph', text: 'End' },
    ],
  };
  const dir = tmp(), built = buildDocx(spec, () => png(40, 20), new Date('2026-01-02T03:04:05Z'));
  assert.deepEqual(built.stats, { blocks: 11, headings: 3, paragraphs: 4, tables: 1, images: 1, listItems: 5 });
  assert.deepEqual(buildDocx(spec, () => png(40, 20), new Date('2026-01-02T03:04:05Z')).buffer, built.buffer, 'a spec builds the same bytes every time');
  const file = path.join(dir, 'report.docx'); fs.writeFileSync(file, built.buffer);
  const read = readOffice(file);
  assert.equal(read.kind, 'docx'); assert.equal(read.meta.title, 'Quarterly report'); assert.equal(read.meta.author, 'QA');
  assert.deepEqual(read.headings.map(h => [h.level, h.text]), [[0, 'Quarterly report'], [1, 'Summary'], [2, 'Numbers']]);
  assert.equal(read.stats.tables, 1); assert.equal(read.stats.images, 1); assert.equal(read.stats.hyperlinks, 1); assert.equal(read.stats.pageBreaks, 1); assert.equal(read.stats.lists, 5);
  assert.deepEqual(read.tables[0].sample, [['Region', 'Revenue'], ['North', '1200'], ['South', '1,540']]);
  assert.match(read.text, /Revenue grew 12%, see docs\./); assert.match(read.text, /\| North \| 1200 \|/);
  assert.deepEqual(codes(read, 'error'), [], JSON.stringify(read.findings));
  assert.deepEqual(codes(read, 'warn'), []);
  assert.ok(built.warnings.length === 0, 'alt text was given, so nothing to warn about');
  assert.match(buildDocx({ blocks: [{ type: 'image', path: 'x.png' }] }, () => png()).warnings[0], /no alt text/);
  assert.throws(() => buildDocx({ blocks: [] }, () => png()), /no content/);
  assert.throws(() => buildDocx({ blocks: [{ type: 'nope' }] }, () => png()), /Unknown block type/);
  assert.throws(() => buildDocx({ blocks: [{ paragraph: 'x' }] }, () => png()), /has no type/);
  assert.throws(() => buildDocx({ blocks: [{ type: 'image', path: 'bad.gif' }] }, () => Buffer.from('GIF89a......')), /Image "bad.gif": Only PNG and JPEG/);
  assert.throws(() => buildDocx({ blocks: [{ type: 'table', rows: [] }] }, () => png()), /needs a header or at least one/);
  const landscape = readOffice((() => { const f = path.join(dir, 'l.docx'); fs.writeFileSync(f, buildDocx({ page: { size: 'Letter', orientation: 'landscape' }, blocks: [{ type: 'paragraph', text: 'x' }] }, () => png()).buffer); return f; })());
  assert.equal(landscape.stats.pageWidthTwips, 15840);
});

test('docx reader names placeholders, blank-line layout, skipped headings, comments and tracked changes', () => {
  const dir = tmp(), file = path.join(dir, 'defects.docx');
  const body = `<w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Deep</w:t></w:r></w:p>
    <w:p><w:r><w:t>Dear {{customer_name}}, [insert date] and lorem ipsum.</w:t></w:r></w:p>
    <w:p/><w:p/><w:p/><w:p><w:r><w:t>After blanks</w:t></w:r></w:p>
    <w:p><w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>
  </w:body>`;
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: `<w:document ${w}>${body}</w:document>` },
    { name: 'word/comments.xml', data: `<w:comments ${w}><w:comment w:id="0"><w:p/></w:comment></w:comments>` },
  ]));
  const read = readOffice(file);
  assert.deepEqual(codes(read).sort(), ['blank-line-spacing', 'heading-skip', 'placeholder-text', 'review-comments', 'tracked-changes'].sort());
  const placeholder = read.findings.find(f => f.code === 'placeholder-text').message;
  assert.match(placeholder, /\{\{customer_name\}\}/); assert.match(read.text, /After blanks/); assert.doesNotMatch(read.text, /removed/);
  assert.deepEqual(placeholderHits('Contact: TODO and click to add title'), ['TODO/TBD marker: “TODO”', 'unfilled slide prompt: “click to add title”']);
  assert.deepEqual(placeholderHits('A perfectly ordinary sentence about templates and braces {x}.'), []);
});

test('package damage is reported precisely: not a zip, wrong format, missing parts, broken relationships, malformed XML', () => {
  const dir = tmp(), at = (name) => path.join(dir, name);
  fs.writeFileSync(at('text.docx'), '<html>404</html>');
  assert.equal(codes(readOffice(at('text.docx')))[0], 'not-a-zip');
  fs.writeFileSync(at('empty.docx'), '');
  assert.equal(codes(readOffice(at('empty.docx')))[0], 'not-a-zip');
  const xlsx = buildXlsx({ sheets: [{ name: 'S', rows: [['a', 1]] }] }).buffer;
  fs.writeFileSync(at('actually-xlsx.docx'), xlsx);
  const mismatch = readOffice(at('actually-xlsx.docx'));
  assert.equal(mismatch.kind, 'xlsx'); assert.ok(codes(mismatch, 'error').includes('extension-mismatch'));
  fs.writeFileSync(at('other.docx'), writeZip([{ name: 'readme.txt', data: 'hi' }]));
  const foreign = readOffice(at('other.docx'));
  assert.ok(codes(foreign, 'error').includes('missing-part') && foreign.findings.some(f => /word\/document\.xml/.test(f.message)), 'a zip with no Word parts says which part is missing');
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  fs.writeFileSync(at('broken.docx'), writeZip([
    { name: 'word/document.xml', data: `<w:document ${w}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:body></w:document>` },
  ]));
  const broken = readOffice(at('broken.docx'));
  assert.deepEqual(codes(broken, 'error').sort(), ['missing-part', 'xml-malformed']);
  assert.match(broken.findings.find(f => f.code === 'xml-malformed').message, /word\/document\.xml is not well-formed XML.*line 1/);
  fs.writeFileSync(at('rels.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="x"/>' },
    { name: 'word/document.xml', data: `<w:document ${w}><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships xmlns="r"><Relationship Id="rId9" Type="http://x/image" Target="media/missing.png"/></Relationships>' },
  ]));
  assert.ok(codes(readOffice(at('rels.docx')), 'error').includes('broken-relationship'));
  // A stored (uncompressed) entry lets the test flip one byte of known content; the recorded CRC no longer matches.
  const small = Buffer.from(writeZip([{ name: '[Content_Types].xml', data: '<Types xmlns="x"/>' }, { name: 'word/document.xml', data: '<w:document><w:body/></w:document>' }]));
  const at_ = small.indexOf('<w:body/>'); assert.ok(at_ > 0, 'the small entry is stored, not deflated'); small[at_ + 3] ^= 0x01;
  fs.writeFileSync(at('damaged.docx'), small);
  const damagedRead = readOffice(at('damaged.docx'));
  assert.ok(codes(damagedRead, 'error').includes('damaged-entry'), JSON.stringify(damagedRead.findings.map(f => f.code)));
  assert.match(damagedRead.findings.find(f => f.code === 'damaged-entry').message, /CRC-32 mismatch/);
});

test('xlsx: formulas are calculated and stored, numbers and dates are typed, totals, freeze and filter are written', () => {
  const rows = [['Rent', 1200, '2026-10-01'], ['Food', '$350.50', '2026-10-05'], ['Fun', '1,000', '2026-10-09'], ['Misc', 49.5, '2026-10-12'], ['Gifts', 80, '2026-10-13'], ['Gas', 90, '2026-10-14'], ['Bills', 70, '2026-10-15'], ['Other', 60, '2026-10-16']];
  const spec = { currency: '€', sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Cost', format: 'currency' }, { header: 'Due', format: 'date' }], rows: rows.map((row, i) => [...row, `=B${i + 2}/B10`]), totals: { label: 'Total', sum: ['Cost'] }, freeze: true }] };
  spec.sheets[0].columns.push({ header: 'Share', format: 'percent' });
  const built = buildXlsx(spec), dir = tmp(), file = path.join(dir, 'budget.xlsx'); fs.writeFileSync(file, built.buffer);
  assert.equal(built.converted.numericStrings, 2); assert.equal(built.converted.dateStrings, 8);
  assert.equal(built.sheets[0].formulas, 9); assert.equal(built.sheets[0].calculated, 9); assert.deepEqual(built.sheets[0].errors, []);
  const read = readOffice(file, { maxRows: 12 }), sheet = read.sheets[0];
  assert.equal(sheet.rows, 10); assert.equal(sheet.columns, 4); assert.equal(sheet.frozen, true); assert.equal(sheet.filter, true, 'a header over eight data rows gets a filter');
  const cell = (ref) => sheet.sample.flat().find(c => c.ref === ref);
  assert.equal(cell('B3').value, 350.5); assert.equal(cell('B4').value, 1000); assert.equal(cell('C2').value, '2026-10-01');
  assert.equal(cell('B10').value, 1200 + 350.5 + 1000 + 49.5 + 80 + 90 + 70 + 60); assert.equal(cell('B10').formula, 'SUM(B2:B9)');
  assert.ok(Math.abs(cell('D2').value - 1200 / 2900) < 1e-9);
  assert.deepEqual(codes(read, 'error'), []); assert.deepEqual(codes(read, 'warn'), []);
  assert.ok(codes(read).includes('formulas-calculate-on-open') === false, 'every formula has a stored result');
  assert.match(built.warnings.join('\n'), /2 numeric-looking text value/);
});

test('xlsx: errors, unsupported formulas, cross-sheet references and bad specs are reported at build time', () => {
  const built = buildXlsx({ sheets: [
    { name: 'Data', rows: [['n', 'v'], ['a', 2], ['b', 4]], headerRow: true },
    { name: 'My Sheet', rows: [['=SUM(Data!B2:B3)', '=Data!B2/0', '=VLOOKUP(1,A1:B2,2,FALSE)', '=A1+B1', "='My Sheet'!A1*2"]] },
  ] });
  const second = built.sheets[1];
  assert.equal(second.calculated, 2); assert.equal(second.errors.length, 2, 'an error propagates to the cell that uses it'); assert.match(second.errors[0], /B1 =Data!B2\/0 → #DIV\/0!/); assert.match(second.errors[1], /D1 =A1\+B1/); assert.match(second.uncalculated[0], /VLOOKUP/);
  const dir = tmp(), file = path.join(dir, 'e.xlsx'); fs.writeFileSync(file, built.buffer);
  const read = readOffice(file);
  assert.ok(codes(read, 'error').includes('formula-errors'));
  assert.match(read.findings.find(f => f.code === 'formula-errors').message, /B1 #DIV\/0!/);
  assert.equal(read.sheets[1].sample[0].find(c => c.ref === 'A1').value, 6);
  assert.match(built.warnings.join('\n'), /evaluate to an error/); assert.match(built.warnings.join('\n'), /calculated when the file is opened/);
  assert.throws(() => buildXlsx({ sheets: [] }), /at least one sheet/);
  assert.throws(() => buildXlsx({ sheets: [{ name: 'a', rows: [] }, { name: 'A', rows: [] }] }), /Duplicate sheet name/);
  assert.throws(() => buildXlsx({ sheets: [{ name: 'S', rows: [['x']], totals: { sum: ['Nope'] } }] }), /not a column/);
  assert.throws(() => buildXlsx({ sheets: [{ name: 'S', rows: [['x']], freeze: 'zzzz' }] }), /freeze must be/);
  const percent = buildXlsx({ sheets: [{ name: 'P', columns: [{ header: 'rate', format: 'percent' }], rows: [[12], ['5%'], [0.1]] }] });
  assert.match(percent.warnings.join('\n'), /above 1 and will display as more than 100%/);
  const short = buildXlsx({ sheets: [{ name: 'T', columns: [{ header: 'Qty' }, { header: 'Cost', format: 'decimal' }], rows: [['a', 1], ['b', 2]], totals: { sum: ['Qty'] } }] });
  assert.equal(short.sheets[0].errors.length, 0, 'a header called Qty is a header, not column QTY');
});

test('xlsx reader flags uncalculated formulas, numbers stored as text and error values in files written elsewhere', () => {
  const dir = tmp(), file = path.join(dir, 'foreign.xlsx');
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="x"/>' },
    { name: 'xl/workbook.xml', data: `<workbook ${ns}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="r"><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet ${ns}><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Amount</t></is></c></row>
      <row r="2"><c r="A2"><v>10</v></c></row><row r="3"><c r="A3"><v>20</v></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>30</t></is></c></row>
      <row r="5"><c r="A5"><f>SUM(A2:A3)</f></c></row>
      <row r="6"><c r="A6" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
    </sheetData></worksheet>` },
  ]));
  const read = readOffice(file);
  assert.deepEqual(codes(read).sort(), ['formula-errors', 'numbers-as-text', 'uncalculated-formulas'].sort());
  assert.match(read.findings.find(f => f.code === 'uncalculated-formulas').message, /1 of 2 formulas have no stored result/);
});

test('pptx reader reports empty slides, empty placeholders, dense text, tiny type and duplicate titles', () => {
  const dir = tmp(), file = path.join(dir, 'deck.pptx');
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const shape = (type, text, size) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:p>${text ? `<a:r><a:rPr${size ? ` sz="${size}"` : ""}/><a:t>${text}</a:t></a:r>` : ''}</a:p></p:txBody></p:sp>`;
  const slide = (...shapes) => `<p:sld ${ns}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
  const dense = 'word '.repeat(150);
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="x"/>' },
    { name: 'ppt/presentation.xml', data: `<p:presentation ${ns}><p:sldIdLst>${[1, 2, 3, 4].map(i => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<Relationships xmlns="r">${[1, 2, 3, 4].map(i => `<Relationship Id="rId${i}" Type="http://x/slide" Target="slides/slide${i}.xml"/>`).join('')}</Relationships>` },
    { name: 'ppt/slides/slide1.xml', data: slide(shape('title', 'Plan'), shape('body', dense)) },
    { name: 'ppt/slides/slide2.xml', data: slide(shape('title', 'Plan'), shape('body', '')) },
    { name: 'ppt/slides/slide3.xml', data: slide() },
    { name: 'ppt/slides/slide4.xml', data: slide(shape('title', 'Small'), shape('body', 'tiny text', 900), shape('body', 'tiny text 2', 900), shape('body', 'tiny 3', 900), shape('body', 'tiny 4', 900)) },
  ]));
  const read = readOffice(file);
  assert.deepEqual(read.slides.map(s => [s.index, s.title ?? null, s.emptyPlaceholders]), [[1, 'Plan', 0], [2, 'Plan', 1], [3, null, 0], [4, 'Small', 0]]);
  assert.deepEqual([...new Set(codes(read))].sort(), ['dense-slide', 'duplicate-titles', 'empty-placeholder', 'empty-slide', 'tiny-text'].sort());
  assert.equal(read.stats.emptySlides, 1);
});
