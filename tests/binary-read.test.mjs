import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const { looksBinary, sniffKind, describeBinary } = await load('agent/extensions/lib/binary-read.ts');
const { buildDocx, buildXlsx } = await load('agent/extensions/lib/office-build.ts');
const { writeZip } = await load('agent/extensions/lib/office-zip.ts');
const deliverables = (await load('agent/extensions/deliverables.ts')).default;
const { createReadTool } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/tools/read.js')));

const has = (name, flag = '-v') => spawnSync(name, [flag], { stdio: 'ignore' }).status === 0;
const hasPdf = has('pdftotext') && has('pdfinfo');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binread-')));

/** A real multi-page PDF with one text line per page; pdftotext reads it. */
function pdf(lines) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(''), pagesObject = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = lines.map((line) => {
    const stream = `BT /F1 14 Tf 72 720 Td (${line}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('looksBinary: text in any common encoding is text, NULs and control noise are binary', () => {
  assert.equal(looksBinary(Buffer.from('plain text\nwith lines\n')), false);
  assert.equal(looksBinary(Buffer.from('héllo wörld — ünïcode', 'utf8')), false);
  assert.equal(looksBinary(Buffer.from('﻿UTF-16 text', 'utf16le')), false, 'UTF-16 with a BOM contains NUL bytes and is still text');
  assert.equal(looksBinary(Buffer.from([0x25, 0x50, 0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : 65)))), true);
  assert.equal(looksBinary(Buffer.alloc(0)), false);
});

test('sniffKind recognizes the files weaker models actually try to read', () => {
  const zipHead = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]);
  assert.deepEqual(sniffKind(Buffer.from('%PDF-1.7\n'), 'a.pdf').kind, 'pdf');
  assert.equal(sniffKind(zipHead, 'report.docx').kind, 'office');
  assert.equal(sniffKind(zipHead, 'bundle.zip').kind, 'zip');
  assert.equal(sniffKind(Buffer.from('SQLite format 3\0'), 'x.db').kind, 'sqlite');
  assert.equal(sniffKind(Buffer.from([0x1f, 0x8b, 8, 0]), 'x.gz').kind, 'archive');
  assert.equal(sniffKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]), 'x.mp4').kind, 'media');
  assert.equal(sniffKind(Buffer.from('RIFF\0\0\0\0WAVEfmt '), 'x.wav').kind, 'media');
  assert.equal(sniffKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), 'tool').kind, 'executable');
  assert.equal(sniffKind(Buffer.from([0, 1, 2, 3, 4, 5]), 'blob').kind, 'other');
});

test('PDF: text by page with a continuation offset, no text layer and damaged files named plainly', { skip: !hasPdf && 'poppler is not installed' }, async () => {
  const dir = tmp();
  const lines = Array.from({ length: 30 }, (_, i) => `Quarterly figure number ${i + 1}`);
  const file = path.join(dir, 'report.pdf'); fs.writeFileSync(file, pdf(lines));
  const first = await describeBinary(file);
  assert.match(first.text, /\[read: PDF document, not text\] report\.pdf/);
  assert.match(first.text, /--- page 1 ---\nQuarterly figure number 1\b/);
  assert.match(first.text, /--- page 25 ---/); assert.doesNotMatch(first.text, /--- page 26 ---/);
  assert.match(first.text, /\[Pages 1-25 of 30 shown\. Use offset=26 to continue from page 26\.\]/);
  assert.equal(first.opened, true); assert.equal(first.facts.pages, 30);
  const next = await describeBinary(file, { offset: 26 });
  assert.match(next.text, /--- page 26 ---\nQuarterly figure number 26\b/); assert.match(next.text, /\[All 30 pages shown\.\]|\[Pages 26-30 of 30 shown/);
  assert.doesNotMatch(next.text, /Use offset=/);
  const blank = path.join(dir, 'scan.pdf'); fs.writeFileSync(blank, pdf(['']));
  assert.match((await describeBinary(blank)).text, /No text layer found.*scanned images/s);
  const cut = path.join(dir, 'cut.pdf'); fs.writeFileSync(cut, Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n'), Buffer.alloc(300, 1)]));
  const damaged = await describeBinary(cut);
  assert.equal(damaged.opened, false); assert.match(damaged.text, /could not be opened|Text extraction failed/);
});

test('Office, archive and generic binaries are shown as what they contain', async () => {
  const dir = tmp();
  const docx = path.join(dir, 'memo.docx');
  fs.writeFileSync(docx, buildDocx({ title: 'Budget memo', blocks: [{ type: 'heading', level: 1, text: 'Findings' }, { type: 'paragraph', text: 'Spending rose by 4 percent.' }] }, () => Buffer.alloc(0)).buffer);
  const word = await describeBinary(docx);
  assert.match(word.text, /Findings/); assert.match(word.text, /Spending rose by 4 percent/); assert.equal(word.opened, true);
  const xlsx = path.join(dir, 'book.xlsx');
  fs.writeFileSync(xlsx, buildXlsx({ sheets: [{ name: 'Sales', columns: [{ header: 'Region' }, { header: 'Units', format: 'integer' }], rows: [['North', 12], ['South', 7]] }] }).buffer);
  assert.match((await describeBinary(xlsx)).text, /North/);
  const zip = path.join(dir, 'bundle.zip'); fs.writeFileSync(zip, writeZip([{ name: 'a/one.txt', data: 'one' }, { name: 'two.csv', data: 'x,y\n1,2\n' }]));
  const listed = await describeBinary(zip);
  assert.match(listed.text, /2 files:\na\/one\.txt \(3 bytes\)\ntwo\.csv/); assert.match(listed.text, /archive_probe lists, stats and reads one member/); assert.match(listed.text, /never the folder it came from/);
  const broken = path.join(dir, 'broken.docx'); fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(100, 7)]));
  const bad = await describeBinary(broken);
  assert.match(bad.text, /deliverable_check|damaged|not a/i); 
  const blob = path.join(dir, 'blob.bin'); fs.writeFileSync(blob, Buffer.from([0, 1, 2, 3, 250, 251]));
  const other = await describeBinary(blob);
  assert.match(other.text, /binary data/); assert.match(other.text, /First bytes: 00 01 02 03 fa fb/);
});

test('SQLite and audio files report their schema and streams', { skip: !(has('sqlite3', '-version') && has('ffprobe', '-version')) && 'sqlite3 or ffprobe is not installed' }, async () => {
  const dir = tmp();
  const db = path.join(dir, 'app.db');
  assert.equal(spawnSync('sqlite3', [db, 'CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users(email) VALUES (\'a@b.c\');']).status, 0);
  const schema = await describeBinary(db);
  assert.match(schema.text, /CREATE TABLE users/); assert.match(schema.text, /sqlite_probe/); assert.equal(schema.opened, true);
  const wav = path.join(dir, 'tone.wav'), samples = 8000, data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wav, Buffer.concat([header, data]));
  const audio = await describeBinary(wav);
  assert.match(audio.text, /audio pcm_s16le 8000 Hz 1 ch/); assert.match(audio.text, /1\.00 s/);
});

function registered() {
  const handlers = new Map();
  deliverables({ on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), registerTool() {}, sendMessage: async () => {}, events: { emit() {}, on() {} } });
  return async (event, ctx) => { for (const handler of handlers.get('tool_result') ?? []) { const result = await handler(event, ctx); if (result) return result; } };
}

test('read hook: the real read tool on a binary file is replaced, text and images are left alone', { skip: !hasPdf && 'poppler is not installed' }, async () => {
  const dir = tmp(), ctx = { cwd: dir };
  const call = registered();
  const read = createReadTool(dir);
  const result = async (name, input) => { const output = await read.execute(`id-${name}`, input, undefined, undefined, ctx); return { toolName: 'read', toolCallId: `id-${name}`, input, isError: false, content: output.content, details: output.details }; };

  fs.writeFileSync(path.join(dir, 'report.pdf'), pdf(['Alpha line', 'Beta line']));
  const pdfEvent = await result('pdf', { path: 'report.pdf' });
  assert.match(pdfEvent.content[0].text, /\ufffd|\u0000|%PDF/, 'the native read returns raw bytes for a PDF');
  const replaced = await call(pdfEvent, ctx);
  assert.match(replaced.content[0].text, /--- page 1 ---\nAlpha line/); assert.match(replaced.content[0].text, /--- page 2 ---\nBeta line/);
  assert.equal(replaced.isError, false); assert.equal(replaced.details.binaryView.pages, 2);
  assert.ok(replaced.content[0].text.length < 600, 'a few hundred characters instead of the raw dump');

  fs.writeFileSync(path.join(dir, 'memo.docx'), buildDocx({ title: 'T', blocks: [{ type: 'paragraph', text: 'Memo body text here.' }] }, () => Buffer.alloc(0)).buffer);
  assert.match((await call(await result('docx', { path: 'memo.docx' }), ctx)).content[0].text, /Memo body text here/);
  assert.match((await call(await result('abs', { path: path.join(dir, 'memo.docx') }), ctx)).content[0].text, /Memo body text here/);
  assert.match((await call(await result('at', { path: '@memo.docx' }), ctx)).content[0].text, /Memo body text here/);

  fs.writeFileSync(path.join(dir, 'tiny.bin'), Buffer.from([0, 1, 2]));
  const offsetError = { toolName: 'read', toolCallId: 'x', input: { path: 'tiny.bin', offset: 40 }, isError: true, content: [{ type: 'text', text: 'Offset 40 is beyond end of file (1 lines total)' }] };
  assert.match((await call(offsetError, ctx)).content[0].text, /binary data/, 'a short binary read with an offset reports the file instead of an offset error');

  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ordinary text\nwith a stray \ufffd character\n');
  assert.equal(await call(await result('text', { path: 'notes.txt' }), ctx), undefined, 'text with a replacement character is still text');
  fs.writeFileSync(path.join(dir, 'wide.txt'), Buffer.from('﻿UTF-16 text file', 'utf16le'));
  assert.equal(await call(await result('wide', { path: 'wide.txt' }), ctx), undefined);
  assert.equal(await call({ toolName: 'read', toolCallId: 'i', input: { path: 'x.png' }, isError: false, content: [{ type: 'text', text: 'Read image file' }, { type: 'image', data: '\u0000', mimeType: 'image/png' }] }, ctx), undefined);
  assert.equal(await call({ toolName: 'bash', toolCallId: 'b', input: { command: 'cat report.pdf' }, isError: false, content: [{ type: 'text', text: '%PDF\u0000\ufffd' }] }, ctx), undefined, 'only read is rewritten');
  assert.equal(await call({ toolName: 'read', toolCallId: 'm', input: { path: 'missing.pdf' }, isError: false, content: [{ type: 'text', text: '\u0000\ufffd' }] }, ctx), undefined, 'a path that does not exist leaves the native result alone');
  process.env.PI_BINARY_READ = 'off';
  try { assert.equal(await call(pdfEvent, ctx), undefined, 'PI_BINARY_READ=off restores the raw read'); } finally { delete process.env.PI_BINARY_READ; }
});
