import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const { inspectDeliverable, parseDelimited, DELIVERABLE_AUTO_EXTENSIONS } = await load('agent/extensions/lib/deliverable-inspect.ts');
const { createDeliverableLedger, commandMayProduceFiles, scanRecentDeliverables, plausibleDeliverable, isDeliverableName } = await load('agent/extensions/lib/deliverable-ledger.ts');
const { buildDocx, buildXlsx } = await load('agent/extensions/lib/office-build.ts');
const { collectVerificationReceipts, collectContinuationLines } = await load('agent/extensions/lib/continuation-notice.ts');
const { noteSessionStopped, unlockSessionStop } = await load('agent/extensions/lib/session-stop.ts');
const { findOfficeSuite } = await load('agent/extensions/lib/office-render.ts');
const deliverables = (await load('agent/extensions/deliverables.ts')).default;

const hasTool = (name) => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfmpeg = hasTool('ffmpeg') && hasTool('ffprobe');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deliverables-'));
const put = (dir, name, data) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const codes = (inspection, severity) => inspection.findings.filter(f => !severity || f.severity === severity).map(f => f.code);
function png(width = 16, height = 16) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('inspector: images, truncation, wrong names and degenerate sizes', async () => {
  const dir = tmp();
  const good = await inspectDeliverable(put(dir, 'ok.png', png(320, 200)));
  assert.equal(good.status, 'pass'); assert.deepEqual([good.facts.format, good.facts.width, good.facts.height], ['png', 320, 200]);
  const cut = png(320, 200);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'cut.png', cut.subarray(0, cut.length - 30))), 'error'), ['truncated-image']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'tiny.png', png(4, 4))), 'error'), ['degenerate-image']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'small.png', png(40, 40))), 'warn'), ['tiny-image']);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(20), Buffer.from([0xff, 0xd9])]);
  const misnamed = await inspectDeliverable(put(dir, 'actually-jpeg.png', jpeg));
  assert.deepEqual(codes(misnamed, 'warn'), ['extension-mismatch']); assert.deepEqual([misnamed.facts.format, misnamed.facts.width, misnamed.facts.height], ['jpeg', 200, 100]);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'page.png', '<!DOCTYPE html><html>404</html>')), 'error'), ['not-an-image']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'text.png', 'base64 text')), 'error'), ['not-an-image']);
});

test('inspector: empty, missing and directory targets fail with a clear cause', async () => {
  const dir = tmp();
  for (const name of ['empty.docx', 'empty.pdf', 'empty.mp4', 'empty.csv', 'empty.png']) assert.ok(codes(await inspectDeliverable(put(dir, name, '')), 'error').includes('empty-file'), name);
  assert.deepEqual(codes(await inspectDeliverable(path.join(dir, 'nope.docx'))), ['missing-file']);
  assert.deepEqual(codes(await inspectDeliverable(dir)), ['not-a-file']);
  assert.equal((await inspectDeliverable(put(dir, 'blob.bin', Buffer.from([1, 2, 3])))).status, 'pass');
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'blob2.bin', Buffer.from([1, 2, 3])))), ['no-inspector']);
});

test('inspector: PDFs, SVG, HTML, Markdown, data and archives', async () => {
  const dir = tmp();
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'fake.pdf', '<!DOCTYPE html><html>Not Found</html>')), 'error'), ['not-a-pdf']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'cut.pdf', '%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n')), 'error'), ['truncated-pdf']);
  const pdf = await inspectDeliverable(put(dir, 'ok.pdf', '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  assert.ok(!codes(pdf, 'error').includes('truncated-pdf') && !codes(pdf, 'error').includes('not-a-pdf'), JSON.stringify(pdf.findings.map(f => f.code)));
  assert.equal((await inspectDeliverable(put(dir, 'ok.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'))).status, 'pass');
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'empty.svg', '<svg viewBox="0 0 1 1"></svg>')), 'error'), ['empty-svg']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'bad.svg', '<svg><rect></svg>')), 'error'), ['xml-malformed']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'script.svg', '<svg viewBox="0 0 1 1"><script>alert(1)</script><rect width="1" height="1"/></svg>')), 'warn'), ['svg-script']);
  put(dir, 'img/ok.png', png(100, 100));
  const html = await inspectDeliverable(put(dir, 'page.html', '<html><head><title>T</title></head><body><img src="img/ok.png"><img src="img/missing.png"><a href="#top">x</a><a href="https://e.com/a.png">y</a> {{name}}</body></html>'));
  assert.deepEqual(codes(html, 'error'), ['broken-reference']); assert.match(html.findings.find(f => f.code === 'broken-reference').message, /img\/missing\.png/); assert.ok(codes(html, 'warn').includes('placeholder-text'));
  const markdown = await inspectDeliverable(put(dir, 'notes.md', 'Text\n\n```js\nunclosed\n\n[ok](img/ok.png) [gone](img/gone.png)\n'));
  assert.ok(codes(markdown, 'warn').includes('unclosed-fence'));
  assert.ok(codes(await inspectDeliverable(put(dir, 'good.md', '# Title\n\n[ok](img/ok.png)\n'))).every(c => c !== 'broken-reference'));
  const csv = await inspectDeliverable(put(dir, 'ragged.csv', 'a,b,c\n1,2,3\n4,5\n6,7,8,9\n'));
  assert.deepEqual(csv.facts.rows, 4); assert.deepEqual(codes(csv, 'warn'), ['ragged-rows']);
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'dups.csv', 'a,A,\n1,2,3\n')), 'warn').sort(), ['duplicate-header', 'empty-header']);
  assert.equal((await inspectDeliverable(put(dir, 'quoted.csv', 'name,note\n"Smith, J","line one\nline two"\n'))).status, 'pass');
  assert.deepEqual(parseDelimited('a;b\n"x;y";2\r\n', ';'), [['a', 'b'], ['x;y', '2']]);
  const badJson = await inspectDeliverable(put(dir, 'bad.json', '{"a": 1,}'));
  assert.deepEqual(codes(badJson, 'error'), ['invalid-json']); assert.match(badJson.findings[0].message, /line 1/);
  assert.equal((await inspectDeliverable(put(dir, 'ok.json', '{"a":[1,2]}'))).status, 'pass');
  assert.deepEqual(codes(await inspectDeliverable(put(dir, 'empty.json', '[]')), 'warn'), ['empty-json']);
  const zipFile = put(dir, 'bundle.zip', await (async () => (await load('agent/extensions/lib/office-zip.ts')).writeZip([{ name: 'a.txt', data: 'hi' }, { name: '__MACOSX/junk', data: 'x' }]))());
  const zip = await inspectDeliverable(zipFile);
  assert.equal(zip.facts.entries, 2); assert.deepEqual(codes(zip), ['archive-junk']);
});

test('inspector: Office files use the structural reader and surface its findings', async () => {
  const dir = tmp();
  const docx = buildDocx({ blocks: [{ type: 'paragraph', text: 'Dear {{customer}}, hello.' }] }, () => png()).buffer;
  const result = await inspectDeliverable(put(dir, 'letter.docx', docx));
  assert.equal(result.kind, 'docx'); assert.equal(result.status, 'warn'); assert.deepEqual(codes(result, 'warn'), ['placeholder-text']);
  const sheet = await inspectDeliverable(put(dir, 'sum.xlsx', buildXlsx({ sheets: [{ name: 'S', rows: [[1, 2, '=A1+B1'], [1, 0, '=A2/B2']] }] }).buffer));
  assert.equal(sheet.status, 'fail'); assert.ok(codes(sheet, 'error').includes('formula-errors'));
});

test('inspector: media decode, pixel format, silence, clipping and truncation', { skip: !hasFfmpeg && 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = tmp(), run = (args) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' }).status, 0);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(dir, 'good.mp4')]);
  const good = await inspectDeliverable(path.join(dir, 'good.mp4'));
  assert.equal(good.status, 'pass', JSON.stringify(good.findings)); assert.equal(good.facts.video.pixFmt, 'yuv420p'); assert.ok(good.facts.audio.meanVolumeDb < 0);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', path.join(dir, 'bad.mp4')]);
  const bad = await inspectDeliverable(path.join(dir, 'bad.mp4'));
  assert.deepEqual(codes(bad).filter(c => c !== 'not-faststart' && c !== 'playback-check').sort(), ['pixel-format', 'silent-audio']);
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'volume=40dB', path.join(dir, 'clip.wav')]);
  assert.ok(codes(await inspectDeliverable(path.join(dir, 'clip.wav')), 'warn').includes('clipping'));
  fs.writeFileSync(path.join(dir, 'cut.mp4'), fs.readFileSync(path.join(dir, 'good.mp4')).subarray(0, 3000));
  const cut = await inspectDeliverable(path.join(dir, 'cut.mp4'));
  assert.equal(cut.status, 'fail'); assert.ok(codes(cut, 'error').some(c => ['unreadable-media', 'decode-failure'].includes(c)), JSON.stringify(cut.findings));
  fs.writeFileSync(path.join(dir, 'notmedia.mp4'), 'this is not media');
  assert.ok(codes(await inspectDeliverable(path.join(dir, 'notmedia.mp4')), 'error').includes('unreadable-media'));
});

test('ledger: a produced file stays open until a check sees the same bytes', () => {
  const dir = tmp(), file = put(dir, 'report.docx', 'one'), ledger = createDeliverableLedger();
  assert.equal(ledger.noteProduced(file, 'bash'), true); assert.equal(ledger.noteProduced(file, 'bash'), false, 'the same bytes are not a new observation');
  assert.deepEqual(ledger.pending().map(o => path.basename(o.path)), ['report.docx']);
  ledger.noteChecked(file, 'pass'); assert.deepEqual(ledger.pending(), []);
  fs.writeFileSync(file, 'changed bytes'); assert.equal(ledger.pending().length, 1, 'a rewrite reopens the file');
  assert.equal(ledger.noteProduced(file, 'bash'), true);
  fs.rmSync(file); assert.deepEqual(ledger.pending(), [], 'a file that no longer exists is dropped');
  assert.equal(ledger.noteProduced(path.join(dir, 'never.docx'), 'bash'), false);
});

test('detection stays narrow: final-product types, plausible places, no fixtures or read-only commands', () => {
  for (const name of ['a.docx', 'a.XLSX', 'a.pptx', 'a.pdf', 'a.mp4', 'a.wav', 'a.mp3', 'a.odt']) assert.ok(isDeliverableName(name) && DELIVERABLE_AUTO_EXTENSIONS.test(name), name);
  for (const name of ['a.png', 'a.json', 'a.txt', 'a.html', 'a.py']) assert.ok(!isDeliverableName(name), name);
  assert.equal(commandMayProduceFiles('python make_report.py'), true); assert.equal(commandMayProduceFiles('ffmpeg -i a b.mp4'), true);
  for (const readOnly of ['ls -la', 'cat report.docx | head', 'git status', 'grep -r x .', 'pdfinfo a.pdf', 'cd out && ls']) assert.equal(commandMayProduceFiles(readOnly), false, readOnly);
  assert.equal(commandMayProduceFiles('ls > listing.txt'), true, 'a redirect can write a file'); assert.equal(commandMayProduceFiles(''), false);
  const dir = tmp(), at = (rel) => path.join(dir, rel);
  assert.equal(plausibleDeliverable(at('report.docx'), dir, ''), true, 'top level of the working directory');
  assert.equal(plausibleDeliverable(at('out/report.pdf'), dir, ''), true, 'a conventional output folder');
  assert.equal(plausibleDeliverable(at('src/data/x.pdf'), dir, ''), false, 'unrelated nested file, never mentioned');
  assert.equal(plausibleDeliverable(at('src/data/x.pdf'), dir, 'wrote src/data/x.pdf'), true, 'but named by the command');
  assert.equal(plausibleDeliverable(at('tests/fixtures/x.pdf'), dir, 'x.pdf'), false, 'test data is never a deliverable');
  assert.equal(plausibleDeliverable(at('node_modules/p/x.pdf'), dir, 'x.pdf'), false); assert.equal(plausibleDeliverable(at('frames/x.mp4'), dir, 'x.mp4'), false);
  assert.equal(plausibleDeliverable(at('~$lock.docx'), dir, '~$lock.docx'), false, 'Office lock files are not deliverables');
  assert.equal(plausibleDeliverable(path.join(os.tmpdir(), 'elsewhere.docx'), dir, 'elsewhere.docx'), false, 'outside the working directory');
  put(dir, 'old.docx', 'x'); const old = new Date(Date.now() - 3_600_000); fs.utimesSync(at('old.docx'), old, old);
  put(dir, 'new.docx', 'x'); put(dir, 'deep/er/est/est/deep.docx', 'x'); put(dir, 'node_modules/p/skip.docx', 'x'); put(dir, 'notes.txt', 'x');
  assert.deepEqual(scanRecentDeliverables(dir, Date.now() - 60_000).map(f => path.relative(dir, f)).sort(), ['new.docx']);
  assert.ok(scanRecentDeliverables(dir, 0, { maxEntries: 1 }).length <= 1, 'the scan honors its entry budget');
});

/** A host API double: records handlers, tools and the messages the extension sends. */
function host() {
  const handlers = new Map(), tools = new Map(), sent = [];
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool: (tool) => tools.set(tool.name, tool), sendMessage: async (message, options) => { sent.push({ message, options }); } };
  const emit = async (event, payload, ctx) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
  const run = async (name, params, ctx) => { const tool = tools.get(name); const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params; return tool.execute('id', prepared, undefined, undefined, ctx); };
  return { pi, handlers, tools, sent, emit, run };
}
const makeCtx = (cwd, extra = {}) => ({ cwd, sessionManager: { getSessionId: () => 'session-under-test' }, isIdle: () => true, hasPendingMessages: () => false, ...extra });
const withEnv = async (env, fn) => { const before = {}; for (const key of Object.keys(env)) { before[key] = process.env[key]; if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } try { return await fn(); } finally { for (const key of Object.keys(env)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } } };
const scriptWrites = async (h, ctx, name, command = 'python make_report.py', output = `Saved ${name}`) => {
  await h.emit('tool_call', { toolName: 'bash', toolCallId: `c-${name}`, input: { command } }, ctx);
  put(ctx.cwd, name, buildDocx({ blocks: [{ type: 'paragraph', text: 'Body text of the report.' }] }, () => png()).buffer);
  await h.emit('tool_result', { toolName: 'bash', toolCallId: `c-${name}`, input: { command }, content: [{ type: 'text', text: output }], isError: false }, ctx);
};

test('extension: a script-made document that nobody opened wakes the model once, and checking it ends the matter', async () => {
  await withEnv({ PI_DELIVERABLES: undefined, PI_SUBAGENT_CHILD: undefined }, async () => {
    const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
    await h.emit('session_start', {}, ctx);
    await scriptWrites(h, ctx, 'report.docx');
    const receipts = collectVerificationReceipts(5, ctx.sessionManager);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].source, 'deliverables'); assert.equal(receipts[0].state, 'unverified'); assert.match(receipts[0].brief, /report\.docx: produced, not opened/);
    await h.emit('agent_settled', {}, ctx);
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.customType, 'deliverable-followup'); assert.equal(h.sent[0].options.triggerTurn, true);
    assert.match(h.sent[0].message.content, /report\.docx \(docx\).*deliverable_check once.*follow-up 1\/2/s);
    await h.emit('agent_settled', {}, ctx); assert.equal(h.sent.length, 1, 'the same set never wakes the model twice');
    const result = await h.run('deliverable_check', { path: 'report.docx' }, ctx);
    assert.equal(result.details.checked[0].status, 'pass'); assert.equal(result.details.checked[0].kind, 'docx'); assert.match(result.details.next, /Look at the actual output/);
    assert.deepEqual(collectVerificationReceipts(5, ctx.sessionManager), [], 'checked bytes close the receipt');
    await h.emit('agent_settled', {}, ctx); assert.equal(h.sent.length, 1);
    await scriptWrites(h, ctx, 'second.docx'); await h.emit('agent_settled', {}, ctx);
    assert.equal(h.sent.length, 2, 'a new unopened file is a new set'); assert.match(h.sent[1].message.content, /follow-up 2\/2/);
    await scriptWrites(h, ctx, 'third.docx'); await h.emit('agent_settled', {}, ctx);
    assert.equal(h.sent.length, 2, 'two automatic follow-ups at most');
    await h.emit('session_shutdown', {}, ctx); assert.deepEqual(collectVerificationReceipts(5, ctx.sessionManager), []);
  });
});

test('extension: tracking is silent where it must be (read-only commands, fixtures, errors, children, opt-out, stops, busy sessions)', async () => {
  const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
  await h.emit('session_start', {}, ctx);
  const settle = async (c = ctx) => { await h.emit('agent_settled', {}, c); return h.sent.length; };
  await scriptWrites(h, ctx, 'listed.docx', 'ls -la');
  const longAgo = new Date(Date.now() - 3_600_000); fs.utimesSync(path.join(dir, 'listed.docx'), longAgo, longAgo); // older than any later command's window
  assert.equal(await settle(), 0, 'a read-only command is never scanned');
  await h.emit('tool_call', { toolName: 'bash', toolCallId: 'f', input: { command: 'node gen.js' } }, ctx);
  put(dir, 'tests/fixtures/sample.pdf', 'x'); put(dir, 'src/deep/unrelated.docx', 'x');
  await h.emit('tool_result', { toolName: 'bash', toolCallId: 'f', input: { command: 'node gen.js' }, content: [{ type: 'text', text: 'done' }], isError: false }, ctx);
  assert.equal(await settle(), 0, 'fixtures and unmentioned nested files are ignored');
  await h.emit('tool_call', { toolName: 'bash', toolCallId: 'e', input: { command: 'node gen.js' } }, ctx);
  put(dir, 'failed.docx', 'x');
  await h.emit('tool_result', { toolName: 'bash', toolCallId: 'e', input: { command: 'node gen.js' }, content: [], isError: true }, ctx);
  assert.equal(await settle(), 0, 'a failed command produced no deliverable worth chasing');
  await h.emit('tool_call', { toolName: 'write', toolCallId: 'w', input: { path: 'notes.txt' } }, ctx);
  await h.emit('tool_result', { toolName: 'write', toolCallId: 'w', input: { path: 'notes.txt' }, content: [], isError: false }, ctx);
  assert.equal(await settle(), 0);
  await scriptWrites(h, ctx, 'busy.docx');
  assert.equal(await settle(makeCtx(dir, { isIdle: () => false, sessionManager: ctx.sessionManager })), 0, 'not while the agent is running');
  assert.equal(await settle(makeCtx(dir, { hasPendingMessages: () => true, sessionManager: ctx.sessionManager })), 0, 'not while messages are queued');
  assert.equal(await settle(makeCtx(dir, { signal: { aborted: true }, sessionManager: ctx.sessionManager })), 0, 'not after an abort');
  const stopped = makeCtx(dir, { sessionManager: ctx.sessionManager }); assert.equal(noteSessionStopped(stopped, 'stop-1'), true);
  assert.equal(await settle(stopped), 0, 'a stopped session stays quiet');
  await withEnv({ PI_DELIVERABLES: 'off' }, async () => { assert.equal(await settle(), 0, 'opt-out'); });
  await withEnv({ PI_SUBAGENT_CHILD: '1' }, async () => { assert.equal(await settle(), 0, 'child sessions never nag'); });
  assert.equal(unlockSessionStop(stopped), true, 'genuine user input unlocks a stop');
  assert.equal(await settle(), 1, 'and the same pending file does wake the model when nothing prevents it');
});

test('extension: a write of a binary deliverable is tracked; bash output naming a file elsewhere is tracked', async () => {
  const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
  put(dir, 'deck.pdf', '%PDF-1.4\n%%EOF');
  await h.emit('tool_result', { toolName: 'write', toolCallId: 'w', input: { path: 'deck.pdf' }, content: [], isError: false }, ctx);
  assert.equal(collectVerificationReceipts(5, ctx.sessionManager).length, 1);
  await h.emit('tool_call', { toolName: 'bash', toolCallId: 'b', input: { command: 'python gen.py' } }, ctx);
  put(dir, 'work/area/deep.mp3', 'x');
  await h.emit('tool_result', { toolName: 'bash', toolCallId: 'b', input: { command: 'python gen.py' }, content: [{ type: 'text', text: 'wrote work/area/deep.mp3' }], isError: false }, ctx);
  assert.equal(collectVerificationReceipts(5, ctx.sessionManager).length, 2, 'named in the output, so tracked');
  assert.equal(collectContinuationLines(5, ctx.sessionManager).length, 0, 'receipts are verification items, not pending work');
});

test('office_doc: build verifies and settles the file; read, verify and path rules behave', async () => {
  const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
  const spec = { title: 'T', blocks: [{ type: 'heading', level: 1, text: 'H' }, { type: 'paragraph', text: 'Body' }] };
  const built = await h.run('office_doc', { action: 'build', path: 'out/t.docx', spec }, ctx);
  assert.equal(built.details.kind, 'docx'); assert.equal(built.details.verification.status, 'pass'); assert.equal(built.details.stats.headings, 2);
  assert.ok(fs.existsSync(path.join(dir, 'out/t.docx')));
  assert.deepEqual(collectVerificationReceipts(5, ctx.sessionManager), [], 'a built-and-verified file leaves no open receipt');
  await assert.rejects(h.run('office_doc', { action: 'build', path: 'out/t.docx', spec }, ctx), /already exists.*overwrite:true/);
  assert.equal((await h.run('office_doc', { action: 'build', path: 'out/t.docx', spec, overwrite: true }, ctx)).details.kind, 'docx');
  await assert.rejects(h.run('office_doc', { action: 'build', path: path.join(os.tmpdir(), 'escape.docx'), spec }, ctx), /inside the current workspace/);
  await assert.rejects(h.run('office_doc', { action: 'build', path: '../escape.docx', spec }, ctx), /inside the current workspace/);
  await assert.rejects(h.run('office_doc', { action: 'build', path: 'x.docx' }, ctx), /needs a spec object/);
  await assert.rejects(h.run('office_doc', { action: 'build', path: 'x.txt', spec }, ctx), /\.docx, \.xlsx or \.pptx/);
  assert.equal((await h.run('office_doc', { action: 'build', path: 'noext', format: 'xlsx', spec: { sheets: [{ name: 'S', rows: [[1, 2, '=A1+B1']] }] } }, ctx)).details.kind, 'xlsx');
  assert.ok(fs.existsSync(path.join(dir, 'noext.xlsx')), 'the extension follows the format');
  const stringSpec = await h.run('office_doc', { action: 'build', path: 's.docx', spec: JSON.stringify(spec) }, ctx);
  assert.equal(stringSpec.details.verification.status, 'pass', 'a spec sent as JSON text is decoded');
  const read = await h.run('office_doc', { action: 'read', path: 'out/t.docx' }, ctx);
  assert.deepEqual(read.details.headings.map(x => x.text), ['T', 'H']); assert.match(read.details.text, /Body/); assert.equal(read.details.status, 'pass');
  const verify = await h.run('office_doc', { action: 'verify', path: 'out/t.docx' }, ctx);
  assert.equal(verify.details.status, 'pass'); assert.equal(verify.details.text, undefined, 'verify reports findings, not content');
  await assert.rejects(h.run('office_doc', { action: 'read', path: 'missing.docx' }, ctx), /does not exist/);
  const inferred = await h.run('office_doc', { path: 's.docx' }, ctx);
  assert.equal(inferred.details.kind, 'docx', 'no action means read');
  const xlsxRead = await h.run('office_doc', { action: 'read', path: 'noext.xlsx', sheet: 'S' }, ctx);
  assert.equal(xlsxRead.details.sheets[0].sample[0][2].value, 3);
});

test('deliverable_check accepts one path or several, reports every file and never throws for a bad path', async () => {
  const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
  put(dir, 'a.png', png(64, 64)); put(dir, 'b.csv', 'a,b\n1,2\n'); put(dir, 'c.json', '{bad');
  const many = await h.run('deliverable_check', { paths: ['a.png', 'b.csv', 'c.json', 'missing.pdf', 'https://example.com/x.pdf'] }, ctx);
  assert.deepEqual(many.details.checked.map(r => [r.path, r.status]), [['a.png', 'pass'], ['b.csv', 'pass'], ['c.json', 'fail'], ['missing.pdf', 'fail'], ['https://example.com/x.pdf', 'fail']]);
  assert.match(many.details.summary, /2 pass, 0 warn, 3 fail/); assert.match(many.details.next, /Fix c\.json, missing\.pdf/);
  assert.match(many.details.checked[4].findings[0].message, /local filesystem path/);
  const text = await h.run('deliverable_check', { paths: 'a.png' }, ctx);
  assert.equal(text.details.checked.length, 1, 'a bare string is accepted as one path');
  assert.equal(h.tools.get('deliverable_check').prepareArguments({ path: 'x' }).paths[0], 'x');
  assert.deepEqual(JSON.parse(many.content[0].text).checked.length, 5);
});

test('render: without a runnable office suite the failure is plain; with one the pages are produced', { timeout: 240_000 }, async (t) => {
  assert.equal(typeof (findOfficeSuite({ PATH: '/nonexistent' }) ?? ''), 'string');
  const { renderOffice } = await load('agent/extensions/lib/office-render.ts');
  const dir = tmp(), file = path.join(dir, 'r.docx'); fs.writeFileSync(file, buildDocx({ blocks: [{ type: 'heading', level: 1, text: 'Render me' }, { type: 'paragraph', text: 'Body paragraph.' }] }, () => png()).buffer);
  await assert.rejects(renderOffice(file, dir, { binary: '/nonexistent/soffice' }), /not installed|ENOENT|spawn/i);
  if (!findOfficeSuite() || process.env.YUNUSPI_SKIP_OFFICE_RENDER === '1') return t.skip('LibreOffice is not installed (or rendering is skipped)');
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  // A private staging root below the home folder (a snap LibreOffice cannot read elsewhere): other renders running at the same time cannot touch it.
  const stagingRoot = fs.mkdtempSync(path.join(os.homedir(), 'yunuspi-stage-test-'));
  try {
    const rendered = await renderOffice(file, out, { pages: 1, stagingRoot });
    assert.ok(fs.statSync(rendered.pdf).size > 500); assert.equal(rendered.pageCount, 1);
    if (hasTool('pdftoppm') || spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0) assert.equal(rendered.pngs.length, 1);
    assert.deepEqual(fs.readdirSync(stagingRoot), [], 'the staging directory is removed');
  } finally { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
});

test('office_doc render: pdfPath converts an Office file to a checked PDF in one call, with the path rules of build', { timeout: 240_000 }, async (t) => {
  const dir = tmp(), h = host(), ctx = makeCtx(dir); deliverables(h.pi);
  const source = path.join(dir, 'memo.docx');
  fs.writeFileSync(source, buildDocx({ title: 'Quarterly memo', blocks: [{ type: 'heading', level: 1, text: 'Findings' }, { type: 'paragraph', text: 'Spending rose by four percent over the quarter.' }] }, () => png()).buffer);
  // The path rules apply before any rendering, so they are checked even where no office suite is installed.
  await assert.rejects(h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: 'memo.txt' }, ctx), /must end in \.pdf/);
  await assert.rejects(h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: path.join(os.tmpdir(), 'escape.pdf') }, ctx), /inside the current workspace/);
  await assert.rejects(h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: '../escape.pdf' }, ctx), /inside the current workspace/);
  put(dir, 'taken.pdf', '%PDF-1.4 placeholder');
  await assert.rejects(h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: 'taken.pdf' }, ctx), /already exists.*overwrite:true/);
  assert.equal(fs.readFileSync(path.join(dir, 'taken.pdf'), 'utf8'), '%PDF-1.4 placeholder', 'a refused conversion leaves the existing file alone');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('media-')), [], 'a refused conversion creates nothing');
  if (!findOfficeSuite() || process.env.YUNUSPI_SKIP_OFFICE_RENDER === '1') return t.skip('LibreOffice is not installed (or rendering is skipped)');
  const made = await h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: 'out/memo.pdf', pages: 0 }, ctx);
  assert.equal(made.details.pdf, 'out/memo.pdf'); assert.deepEqual(made.details.pngs, []);
  assert.equal(fs.readFileSync(path.join(dir, 'out/memo.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.equal(made.details.verification.status, 'pass'); assert.equal(made.details.verification.facts.pages, 1);
  assert.match(made.details.note, /out\/memo\.pdf.*check passed/);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('media-')), [], 'with no page images wanted, no scratch folder is left behind');
  assert.deepEqual(collectVerificationReceipts(5, ctx.sessionManager), [], 'the converted PDF was checked, so it leaves no open receipt');
  await assert.rejects(h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: 'out/memo.pdf', pages: 0 }, ctx), /already exists/);
  const again = await h.run('office_doc', { action: 'render', path: 'memo.docx', pdfPath: 'out/memo.pdf', pages: 1, overwrite: true }, ctx);
  assert.equal(again.details.pdf, 'out/memo.pdf');
  if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0) {
    assert.equal(again.details.pngs.length, 1); assert.match(again.details.pngs[0], /^media-[0-9a-f]+\/page-1\.png$/);
    const folders = fs.readdirSync(dir).filter(name => name.startsWith('media-'));
    assert.equal(folders.length, 1); assert.deepEqual(fs.readdirSync(path.join(dir, folders[0])).filter(name => name.endsWith('.pdf')), [], 'the PDF is not duplicated beside the page images');
  }
});

test('ledger: the way a file was produced is remembered, and a rewrite keeps the latest way', () => {
  const dir = tmp(), ledger = createDeliverableLedger(), file = put(dir, 'a.docx', 'x');
  assert.equal(ledger.originOf(file), undefined); assert.equal(ledger.isProduced(file), false);
  ledger.noteProduced(file, 'convert'); assert.equal(ledger.originOf(file), 'convert'); assert.equal(ledger.isProduced(file), true);
  assert.deepEqual(ledger.producedPaths(), [file]);
  fs.writeFileSync(file, 'xx'); ledger.noteProduced(file, 'bash'); assert.equal(ledger.originOf(file), 'bash');
});
