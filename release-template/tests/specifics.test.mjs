import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const { makeEvidence, unsupportedSpecifics, specificsFindings, collectEvidence, documentFindings } = await load('agent/extensions/lib/specifics.ts');
const deliverables = (await load('agent/extensions/deliverables.ts')).default;

const NOW = new Date('2026-10-04T09:00:00Z');
const check = (document, ...evidence) => unsupportedSpecifics(document, makeEvidence(evidence, NOW));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'specifics-'));

test('contact data: an email, phone number or link nobody mentioned is reported; one the user gave is not', () => {
  const prompt = 'Contact Maria at maria@acme.example or (555) 123-4567; docs live at https://acme.example/handbook/';
  const found = check('Write to maria@acme.example, call 555.123.4567 or read https://www.acme.example/handbook. Or write to sales@acme.example, call +1 202 555 0143, see https://acme.example/pricing.', prompt);
  assert.deepEqual([...found.contact].sort(), ['+1 202 555 0143', 'https://acme.example/pricing', 'sales@acme.example']);
  assert.deepEqual(check('Mail Maria@ACME.example', prompt).contact, [], 'case does not matter');
  assert.deepEqual(check('Reference 2026-10-04 and 12.345.678 and 1,234,567.89', '').contact, [], 'dates and long numbers are not phone numbers');
  assert.deepEqual(check('Call 0555 123 45 67', 'my number is 05551234567').contact, [], 'spacing does not matter');
});

test('names: greetings, signatures, labels and honorifics need a source; roles and groups do not', () => {
  const doc = 'Dear Alice Brown,\n\nWelcome aboard.\n\nBest regards,\nJordan Rivera\nOperations\n\nFrom: Casey Lee <casey@x.example>\nCc: Dr. Patel';
  assert.deepEqual(check(doc, 'Write to Alice Brown from Jordan Rivera. Cc Dr Patel and casey lee').name, []);
  assert.deepEqual(check(doc, 'Write a welcome note').name.sort(), ['Alice Brown', 'Casey Lee', 'Jordan Rivera', 'Patel']);
  assert.deepEqual(check('Dear Team,\nHello Everyone\nDear Hiring Manager,\nDear Valued Customer,\nTo: All Staff\nFrom: Facilities Department\nSincerely,\nThe Facilities Team', 'x').name, [], 'roles and groups are not people');
  assert.deepEqual(check('Dear [Name],\n\nSincerely,\n[Your Name]', 'x').name, [], 'a visible placeholder is the honest answer');
  assert.deepEqual(check('Dear Dr. Smith,', 'Please address it to Doctor Smith').name, [], 'an honorific spelling does not decide support');
  assert.deepEqual(check('Dear Dr. Smith,', 'x').name, ['Dr. Smith']);
});

test('places: a room or address that was never given is reported, a given one is not', () => {
  const prompt = 'The meeting moves to Room B at 12 Baker Street.';
  assert.deepEqual(check('Held in Room B at 12 Baker Street (previously Room A).', prompt).place, ['Room A']);
  assert.deepEqual(check('Held in Room B at 12 Baker Street.', prompt).place, []);
  assert.deepEqual(check('Moved to Suite 200, 45 Oak Avenue.', prompt).place, ['Suite 200', '45 Oak Avenue']);
  assert.deepEqual(check('See Room Rates and Hall of Fame; Table 1 lists Level 2 items.', 'x').place, [], 'ordinary words after a place word are not rooms');
  assert.deepEqual(check('Building 3, Floor 2', 'building 3 and floor 2').place, []);
});

test('figures: dates, times and amounts need a source, spelled however the user spelled them', () => {
  assert.deepEqual(check('From 1 November the meeting is at 14:00; cost $1,250.00.', 'from 1 November, 10:00 to 2 PM; the budget is 1250').figure, []);
  assert.deepEqual(check('Date: 4 October 2026', 'x').figure, [], "today's date is known to the model");
  assert.deepEqual(check('Effective 12 December 2026 at 15:30 for €99', 'from 1 November, 14:00, $50').figure.sort(), ['12 December 2026', '15:30', '€99']);
  assert.deepEqual(check('Due 2026-11-01.', 'due November 1').figure, []);
  assert.deepEqual(check('Due 03/04/2026.', 'due April 3rd').figure, [], 'an ambiguous numeric date is supported by either reading');
  assert.deepEqual(check('Toplantı 1 Kasım, Mayıs 5', '1 kasım ve 5 mayıs').figure, []);
  assert.deepEqual(check('Toplantı 7 Aralık', '1 Kasım').figure, ['7 Aralik']);
  assert.deepEqual(check('at 9 am', 'at 9:00').figure, [], 'times match across 12 and 24 hour spellings');
  assert.deepEqual(check('March 2026 report', 'x').figure, [], 'a month and year is not a day');
});

test('findings: contact data, names and places warn; figures only inform; a data merge is one soft note', () => {
  const found = check('Dear Alice Brown,\nCall +1 202 555 0143. Room A at 15:30.', 'write a note');
  const findings = specificsFindings(found);
  assert.deepEqual(findings.map(f => [f.severity, f.code]), [['warn', 'unsupported-contact'], ['warn', 'unsupported-name'], ['warn', 'unsupported-place'], ['info', 'unsupported-figure']]);
  assert.match(findings[0].message, /\+1 202 555 0143/); assert.match(findings[0].hint, /placeholder/);
  const merge = Array.from({ length: 14 }, (_, i) => `person${i}@x.example`).join(' ');
  assert.deepEqual(specificsFindings(check(merge, 'x')).map(f => [f.severity, f.code]), [['info', 'unsupported-specifics']]);
  assert.deepEqual(specificsFindings(check('All good.', 'x')), []);
});

const message = (role, content, extra = {}) => ({ type: 'message', message: { role, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, ...extra } });
const call = (id, name, args) => message('assistant', [{ type: 'toolCall', id, name, arguments: args }]);
const result = (id, toolName, text) => message('toolResult', text, { toolCallId: id, toolName });

test('evidence: user words and tool output count; reading back a produced file does not; originals read before an in-place edit do', async () => {
  const dir = tmp();
  const produced = path.join(dir, 'cv.docx');
  fs.writeFileSync(produced, 'placeholder');
  const branch = [
    message('user', 'Fix the typos in cv.docx'),
    call('1', 'read', { path: 'cv.docx' }), result('1', 'read', 'Jane Original, +44 20 7946 0958'),
    call('2', 'bash', { command: 'python fix.py cv.docx' }), result('2', 'bash', 'Saved cv.docx'),
    call('3', 'read', { path: 'cv.docx' }), result('3', 'read', 'Invented Person, +1 202 555 0143'),
    call('4', 'office_doc', { action: 'read', path: 'cv.docx' }), result('4', 'office_doc', 'Another Invention'),
    call('5', 'bash', { command: 'ls' }), result('5', 'bash', 'notes.txt'),
    { type: 'compaction', summary: 'Earlier the user said the office is in Room C.' },
    { type: 'custom_message', customType: 'task-pipeline', content: 'Hidden Harness Text' },
  ];
  const text = (await collectEvidence(branch, { cwd: dir, produced: [produced] })).join('\n');
  assert.match(text, /Fix the typos/); assert.match(text, /Jane Original/, 'what was read before the file was written is the material');
  assert.match(text, /Room C/, 'compaction summaries keep earlier facts');
  assert.doesNotMatch(text, /Invented Person|Another Invention/, 'the file read back after writing is not evidence');
  assert.doesNotMatch(text, /Hidden Harness Text/);
});

test('evidence: files the session referenced supply their contents, bounded and never the produced file itself', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'customers.csv'), 'name,email\nGreta Hall,greta@hall.example\n');
  fs.writeFileSync(path.join(dir, 'letters.docx'), 'not a real docx');
  const branch = [
    message('user', 'Write a letter to every customer in customers.csv, output letters.docx'),
    call('1', 'bash', { command: 'python merge.py customers.csv letters.docx' }), result('1', 'bash', 'ok'),
  ];
  const parts = await collectEvidence(branch, { cwd: dir, produced: [path.join(dir, 'letters.docx')] });
  const text = parts.join('\n');
  assert.match(text, /Greta Hall/); assert.match(text, /greta@hall\.example/); assert.doesNotMatch(text, /not a real docx/);
  const letter = 'Dear Greta Hall,\n\nWe wrote to greta@hall.example.\n\nSincerely,\nCasey Morgan';
  assert.deepEqual(documentFindings(letter, parts).map(f => f.code), ['unsupported-name'], 'the data file covers the customer, the invented signature stands out');
});

function host() {
  const handlers = new Map(), tools = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool: (tool) => tools.set(tool.name, tool), sendMessage: async () => {} };
  const run = async (name, params, ctx) => { const tool = tools.get(name); const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params; return tool.execute('id', prepared, undefined, undefined, ctx); };
  return { pi, run };
}
const withEnv = async (env, fn) => { const before = {}; for (const key of Object.keys(env)) { before[key] = process.env[key]; if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } try { return await fn(); } finally { for (const key of Object.keys(env)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } } };

test('office_doc and deliverable_check: a produced document with invented specifics warns, a supplied one does not, and the opt-out works', async () => {
  const dir = tmp(), h = host();
  const branch = [message('user', 'Write a memo: from 1 November the Friday meeting is in Room B.')];
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 's', getBranch: () => branch } };
  deliverables(h.pi);
  const spec = { title: 'Memo', blocks: [{ type: 'paragraph', text: 'From 1 November the meeting is in Room B (previously Room A). Call +1 202 555 0143.' }, { type: 'paragraph', text: 'Best regards,' }, { type: 'paragraph', text: 'Jordan Rivera' }] };
  const built = await h.run('office_doc', { action: 'build', path: 'memo.docx', spec }, ctx);
  const codes = built.details.verification.findings.map(f => f.code);
  assert.ok(codes.includes('unsupported-place') && codes.includes('unsupported-contact') && codes.includes('unsupported-name'), codes.join());
  assert.equal(built.details.verification.status, 'warn');
  const checked = await h.run('deliverable_check', { path: 'memo.docx' }, ctx);
  assert.ok(checked.details.checked[0].findings.some(f => f.code === 'unsupported-place'));
  const read = await h.run('office_doc', { action: 'verify', path: 'memo.docx' }, ctx);
  assert.ok(read.details.findings.some(f => f.code === 'unsupported-contact'));
  // A document the user supplied was never produced by this session: its specifics are the user's.
  const supplied = path.join(dir, 'supplied.docx');
  fs.copyFileSync(path.join(dir, 'memo.docx'), supplied);
  assert.ok(!(await h.run('deliverable_check', { path: 'supplied.docx' }, ctx)).details.checked[0].findings.some(f => f.code.startsWith('unsupported')));
  await withEnv({ PI_SPECIFICS: 'off' }, async () => {
    const off = await h.run('office_doc', { action: 'build', path: 'memo2.docx', spec }, ctx);
    assert.ok(!off.details.verification.findings.some(f => f.code.startsWith('unsupported')));
  });
  // Without a readable branch there is no evidence to compare with, so the check stays silent.
  const bare = await h.run('office_doc', { action: 'build', path: 'memo3.docx', spec }, { cwd: dir, sessionManager: { getSessionId: () => 's' } });
  assert.ok(!bare.details.verification.findings.some(f => f.code.startsWith('unsupported')));
});
