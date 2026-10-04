import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const { convertOffice, openLegacyOffice, isLegacyOffice, CONVERT_TARGETS, findOfficeSuite } = await load('agent/extensions/lib/office-render.ts');
const { describeBinary, sniffKind } = await load('agent/extensions/lib/binary-read.ts');
const { buildDocx, buildXlsx } = await load('agent/extensions/lib/office-build.ts');
const deliverables = (await load('agent/extensions/deliverables.ts')).default;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'convert-'));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const suite = () => findOfficeSuite() && process.env.YUNUSPI_SKIP_OFFICE_RENDER !== '1';
function host() {
  const handlers = new Map(), tools = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool: (tool) => tools.set(tool.name, tool), sendMessage: async () => {} };
  const run = async (name, params, ctx) => { const tool = tools.get(name); const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params; return tool.execute('id', prepared, undefined, undefined, ctx); };
  return { pi, run };
}

test('convert: targets, legacy names and plain failures need no office suite', async () => {
  for (const to of ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'doc', 'xls', 'ppt', 'rtf', 'txt', 'html', 'csv']) assert.ok(CONVERT_TARGETS.includes(to), to);
  assert.ok(['a.doc', 'A.XLS', 'x.ppt', 'n.rtf', 'p.pps'].every(isLegacyOffice)); assert.ok(!['a.docx', 'b.xlsx', 'c.txt', 'd.pdf'].some(isLegacyOffice));
  const dir = tmp(), file = path.join(dir, 'a.docx'); fs.writeFileSync(file, buildDocx({ blocks: [{ type: 'paragraph', text: 'x' }] }, () => Buffer.alloc(0)).buffer);
  await assert.rejects(convertOffice(file, 'exe', dir), /Cannot convert to "exe"; use one of pdf/);
  await assert.rejects(convertOffice(file, 'pdf', dir, { binary: '/nonexistent/soffice' }), /not installed|ENOENT|spawn/i);
  assert.equal(sniffKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'old.doc').kind, 'legacy');
  assert.equal(sniffKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'setup.msi').kind, 'other', 'an OLE file that is not an Office format stays unclaimed');
  assert.equal(sniffKind(Buffer.from('{\\rtf1\\ansi Hello}'), 'x.rtf').kind, 'legacy');
  const view = await withoutSuite(() => describeBinary(path.join(dir, 'old.doc'), {}), dir);
  assert.equal(view.opened, false); assert.match(view.text, /needs LibreOffice/);
});
async function withoutSuite(fn, dir) {
  fs.writeFileSync(path.join(dir, 'old.doc'), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]));
  const before = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    if (findOfficeSuite()) return { opened: false, text: 'needs LibreOffice (an office suite exists at a fixed path on this machine)' }; // a fixed-path install cannot be hidden by PATH
    return await fn();
  } finally { process.env.PATH = before; }
}

test('office_doc convert: a document becomes a checked PDF, text and a legacy doc; the source never changes', { timeout: 280_000 }, async (t) => {
  if (!suite()) return t.skip('LibreOffice is not installed (or conversion is skipped)');
  const dir = tmp(), h = host(), branch = [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Convert my memo to PDF' }] } }], ctx = { cwd: dir, sessionManager: { getSessionId: () => 's', getBranch: () => branch } }; deliverables(h.pi);
  const source = path.join(dir, 'memo.docx');
  fs.writeFileSync(source, buildDocx({ title: 'Memo', blocks: [{ type: 'heading', level: 1, text: 'Findings' }, { type: 'paragraph', text: 'Spending rose by four percent over the quarter. Call +1 202 555 0143.' }] }, () => Buffer.alloc(0)).buffer);
  const before = sha(source);
  const pdf = await h.run('office_doc', { action: 'convert', path: 'memo.docx', to: 'pdf' }, ctx);
  assert.equal(pdf.details.files[0].path, 'memo.pdf'); assert.equal(pdf.details.files[0].status, 'pass'); assert.ok(fs.existsSync(path.join(dir, 'memo.pdf')));
  const checked = await h.run('deliverable_check', { path: 'memo.pdf' }, ctx);
  assert.ok(!checked.details.checked[0].findings.some(f => f.code.startsWith('unsupported')), 'a converted file adds no content, so its specifics are not questioned');
  await assert.rejects(h.run('office_doc', { action: 'convert', path: 'memo.docx', to: 'pdf' }, ctx), /already exists.*overwrite:true/);
  assert.equal((await h.run('office_doc', { action: 'convert', path: 'memo.docx', to: 'pdf', overwrite: true }, ctx)).details.files.length, 1);
  const txt = await h.run('office_doc', { action: 'convert', path: 'memo.docx', to: 'txt', outPath: 'out/notes' }, ctx);
  assert.equal(txt.details.files[0].path, 'out/notes.txt'); assert.match(fs.readFileSync(path.join(dir, 'out/notes.txt'), 'utf8'), /Spending rose by four percent/);
  const doc = await h.run('office_doc', { to: 'doc', path: 'memo.docx' }, ctx);
  assert.equal(doc.details.files[0].path, 'memo.doc', 'a to without an action means convert');
  assert.equal(sha(source), before, 'the source file is untouched');
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('.convert-')).length, 0, 'no staging folder is left behind');
  // The legacy file reads as text, both through the binary view the read tool uses and through office_doc read.
  const view = await describeBinary(path.join(dir, 'memo.doc'), {});
  assert.equal(view.kind, 'legacy'); assert.equal(view.opened, true); assert.match(view.text, /Word 97-2003 document/); assert.match(view.text, /Spending rose by four percent/);
  const read = await h.run('office_doc', { action: 'read', path: 'memo.doc' }, ctx);
  assert.match(read.details.text, /Spending rose by four percent/); assert.ok(read.details.findings.some(f => f.code === 'converted-legacy'));
  const modern = await h.run('office_doc', { action: 'convert', path: 'memo.doc', to: 'docx', outPath: 'memo-modern.docx' }, ctx);
  assert.equal(modern.details.files[0].status, 'pass');
  const legacy = await openLegacyOffice(path.join(dir, 'memo.doc')); try { assert.equal(legacy.kind, 'docx'); assert.ok(fs.existsSync(legacy.path)); } finally { legacy.cleanup(); }
  assert.ok(!fs.existsSync(legacy.path), 'the temporary conversion is removed');
});

test('office_doc convert: rules apply before any conversion, and a workbook becomes one csv per sheet', { timeout: 280_000 }, async (t) => {
  const dir = tmp(), h = host(), ctx = { cwd: dir, sessionManager: { getSessionId: () => 's' } }; deliverables(h.pi);
  fs.writeFileSync(path.join(dir, 'book.xlsx'), buildXlsx({ sheets: [{ name: 'North', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer' }], rows: [['a', 1], ['b', 2]] }, { name: 'South', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer' }], rows: [['c', 3]] }] }).buffer);
  await assert.rejects(h.run('office_doc', { action: 'convert', path: 'book.xlsx' }, ctx), /convert needs to: one of pdf/);
  await assert.rejects(h.run('office_doc', { action: 'convert', path: 'book.xlsx', to: 'pdf', outPath: '../escape.pdf' }, ctx), /inside the current workspace/);
  await assert.rejects(h.run('office_doc', { action: 'convert', path: 'missing.xlsx', to: 'pdf' }, ctx), /is not an existing file/);
  await assert.rejects(h.run('office_doc', { action: 'convert', path: 'book.xlsx', to: 'xlsx', outPath: 'book.xlsx' }, ctx), /would replace its source/);
  if (!suite()) return t.skip('LibreOffice is not installed (or conversion is skipped)');
  const csv = await h.run('office_doc', { action: 'convert', path: 'book.xlsx', to: 'csv' }, ctx);
  assert.deepEqual(csv.details.files.map(f => f.path).sort(), ['book-North.csv', 'book-South.csv']);
  assert.match(fs.readFileSync(path.join(dir, 'book-North.csv'), 'utf8'), /Item,Qty\s+a,1\s+b,2/);
  assert.match(csv.details.note, /one csv per sheet/);
});

test('office_doc read: a legacy file without LibreOffice fails with the way forward', async (t) => {
  if (findOfficeSuite()) return t.skip('LibreOffice is installed, so the legacy file would be converted');
  const dir = tmp(), h = host(), ctx = { cwd: dir, sessionManager: { getSessionId: () => 's' } }; deliverables(h.pi);
  fs.writeFileSync(path.join(dir, 'old.doc'), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]));
  await assert.rejects(h.run('office_doc', { action: 'read', path: 'old.doc' }, ctx), /No office suite is installed/);
});
