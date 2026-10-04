import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)));
const lib = await load('agent/extensions/lib/fs-organize.ts');
const fsOrganize = (await load('agent/extensions/fs-organize.ts')).default;

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'organize-')));
const put = (dir, name, data = name, when) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); if (when) fs.utimesSync(file, when, when); return file; };
/** Every regular file below dir, as sorted relative paths. */
const tree = (dir) => {
  const out = []; const visit = (current) => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const file = path.join(current, entry.name); if (entry.isDirectory()) visit(file); else out.push(path.relative(dir, file).split(path.sep).join('/')); } }; visit(dir); return out.sort();
};
/** Path to content hash for every file: the "nothing lost" oracle. */
const hashes = (dir) => Object.fromEntries(tree(dir).map(rel => [rel, createHash('sha256').update(fs.lstatSync(path.join(dir, rel)).isSymbolicLink() ? fs.readlinkSync(path.join(dir, rel)) : fs.readFileSync(path.join(dir, rel))).digest('hex')]));
const journal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'organize-journal-'));

function mixedFolder() {
  const dir = tmp();
  for (const name of ['report.pdf', 'notes.txt', 'photo.JPG', 'clip.mp4', 'song.mp3', 'backup.zip', 'data.csv', 'script.py', 'setup.exe', 'weird.xyz', 'noext']) put(dir, name);
  return dir;
}

test('engine: by type moves every file into a category folder, journals it, verifies and undoes exactly', async () => {
  const dir = mixedFolder(), journalDir = journal(), before = hashes(dir);
  const { plan, summary } = await lib.createPlan(dir, { by: 'type' }, { journalDir });
  assert.equal(summary.toMove, 11); assert.equal(summary.alreadyInPlace, 0);
  assert.deepEqual(tree(dir), Object.keys(before).sort(), 'planning touches nothing');
  const folders = Object.fromEntries(summary.folders.map(row => [row.folder, row.files]));
  assert.deepEqual(folders, { Documents: 2, Images: 1, Videos: 1, Audio: 1, Archives: 1, Spreadsheets: 1, Code: 1, Installers: 1, Other: 2 });
  const applied = await lib.applyPlan(plan, { journalDir });
  assert.equal(applied.moved, 11);
  assert.deepEqual(tree(dir).filter(rel => !rel.includes('/')), [], 'nothing is left at the top level');
  assert.equal(fs.readFileSync(path.join(dir, 'Documents', 'report.pdf'), 'utf8'), 'report.pdf');
  const check = lib.verifyPlan(plan);
  assert.equal(check.ok, true); assert.equal(check.fileCountBefore, 11); assert.equal(check.fileCountNow, 11); assert.equal(check.fileCountUnchanged, true);
  // The journal survives the process: a fresh load can undo.
  const reloaded = lib.loadPlan(plan.id, journalDir);
  const undone = await lib.undoPlan(reloaded, { journalDir });
  assert.equal(undone.restored, 11); assert.deepEqual(undone.failed, []);
  assert.deepEqual(hashes(dir), before, 'undo restores every file with its content');
  assert.deepEqual(fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isDirectory()), [], 'folders the plan created are removed again');
  assert.equal(lib.loadPlan(plan.id, journalDir).status, 'undone');
  await assert.rejects(() => lib.applyPlan(reloaded, { journalDir }), /undone/);
});

test('engine: name clashes never overwrite, whether planned or arising after the plan', async () => {
  const dir = tmp(), journalDir = journal();
  put(dir, 'Documents/a.pdf', 'already filed');
  put(dir, 'a.pdf', 'new a');
  put(dir, 'sub/a.pdf', 'nested a');
  const { plan, summary } = await lib.createPlan(dir, { by: 'type', recursive: true }, { journalDir });
  assert.equal(summary.renamedToAvoidOverwrite, 2);
  assert.deepEqual(plan.moves.map(move => move.to).sort(), ['Documents/a (2).pdf', 'Documents/a (3).pdf']);
  // Someone creates the planned name between plan and apply: apply must pick another name, not replace it.
  put(dir, 'Documents/a (2).pdf', 'created meanwhile');
  const applied = await lib.applyPlan(plan, { journalDir });
  assert.equal(applied.moved, 2);
  const files = Object.fromEntries(tree(dir).map(rel => [rel, fs.readFileSync(path.join(dir, rel), 'utf8')]));
  assert.equal(files['Documents/a.pdf'], 'already filed');
  assert.equal(files['Documents/a (2).pdf'], 'created meanwhile');
  assert.deepEqual(Object.values(files).sort(), ['already filed', 'created meanwhile', 'nested a', 'new a'], 'all four files exist with their own content');
  assert.equal(tree(dir).length, 4);
  const check = lib.verifyPlan(plan);
  assert.equal(check.ok, true, 'every moved file is accounted for');
  assert.equal(check.fileCountUnchanged, false, 'the file that appeared meanwhile changes the count, and that is said plainly');
  assert.match(check.note, /added or removed by something else/);
});

test('engine: files that changed or vanished after the plan are skipped and reported, not moved blindly', async () => {
  const dir = tmp(), journalDir = journal();
  put(dir, 'a.pdf', 'one'); put(dir, 'b.pdf', 'two'); put(dir, 'c.pdf', 'three');
  const { plan } = await lib.createPlan(dir, { by: 'type' }, { journalDir });
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'one but edited and longer');
  fs.rmSync(path.join(dir, 'b.pdf'));
  const applied = await lib.applyPlan(plan, { journalDir });
  assert.equal(applied.moved, 1);
  assert.deepEqual(applied.skipped.map(row => [row.from, row.reason]).sort(), [['a.pdf', 'changed since the plan was made'], ['b.pdf', 'no longer there']]);
  assert.equal(fs.readFileSync(path.join(dir, 'a.pdf'), 'utf8'), 'one but edited and longer');
});

test('engine: an interrupted apply is partial, resumable, and undoable', async () => {
  const dir = tmp(), journalDir = journal();
  for (let n = 0; n < 6; n++) put(dir, `f${n}.pdf`, `file ${n}`);
  const original = hashes(dir);
  const { plan } = await lib.createPlan(dir, { by: 'type' }, { journalDir });
  let calls = 0;
  const signal = { get aborted() { return ++calls > 3; }, throwIfAborted() {} };
  const first = await lib.applyPlan(plan, { journalDir, signal });
  assert.equal(first.aborted, true); assert.equal(plan.done.length, 3); assert.equal(plan.status, 'partial');
  const second = await lib.applyPlan(lib.loadPlan(plan.id, journalDir), { journalDir });
  assert.equal(second.moved, 3);
  const finished = lib.loadPlan(plan.id, journalDir);
  assert.equal(finished.status, 'applied'); assert.equal(finished.done.length, 6);
  await lib.undoPlan(finished, { journalDir });
  assert.deepEqual(hashes(dir), original);
});

test('engine: duplicates are reported by default and gathered, never deleted, on request', async () => {
  const dir = tmp(), journalDir = journal();
  const old = new Date('2020-01-01'), recent = new Date('2024-01-01');
  put(dir, 'scan.pdf', 'identical bytes', old); put(dir, 'scan copy.pdf', 'identical bytes', recent); put(dir, 'scan (1).pdf', 'identical bytes', recent);
  put(dir, 'other.pdf', 'different');
  const report = await lib.createPlan(dir, { by: 'type', duplicates: 'report' }, { journalDir });
  assert.equal(report.summary.duplicates.groups, 1); assert.equal(report.summary.duplicates.copies, 2);
  assert.equal(report.plan.moves.filter(move => move.to.startsWith('Duplicates/')).length, 0);
  const separate = await lib.createPlan(dir, { by: 'type', duplicates: 'separate' }, { journalDir });
  const toDuplicates = separate.plan.moves.filter(move => move.to.startsWith('Duplicates/')).map(move => move.from).sort();
  assert.deepEqual(toDuplicates, ['scan (1).pdf', 'scan copy.pdf'], 'the oldest file is the one kept in place');
  await lib.applyPlan(separate.plan, { journalDir });
  assert.equal(tree(dir).length, 4, 'every file still exists');
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'scan.pdf')));
  assert.equal(fs.readdirSync(path.join(dir, 'Duplicates')).length, 2);
});

test('engine: by date, by extension and rules with placeholders', async () => {
  const dir = tmp(), journalDir = journal();
  put(dir, 'a.jpg', 'a', new Date(2023, 4, 10)); put(dir, 'b.jpg', 'b', new Date(2024, 0, 2)); put(dir, 'Invoice-9.pdf', 'inv', new Date(2022, 5, 5)); put(dir, 'misc.txt', 'm', new Date(2022, 5, 5));
  const byDate = await lib.createPlan(dir, { by: 'date', date: 'month' }, { journalDir });
  assert.deepEqual(byDate.plan.moves.map(move => move.to).sort(), ['2022-06/Invoice-9.pdf', '2022-06/misc.txt', '2023-05/a.jpg', '2024-01/b.jpg']);
  const byYear = await lib.createPlan(dir, { by: 'date', date: 'year' }, { journalDir });
  assert.ok(byYear.plan.moves.every(move => /^20\d\d\//.test(move.to)));
  const byExt = await lib.createPlan(dir, { by: 'extension' }, { journalDir });
  assert.deepEqual([...new Set(byExt.plan.moves.map(move => path.posix.dirname(move.to)))].sort(), ['JPG', 'PDF', 'TXT']);
  const ruled = await lib.createPlan(dir, { by: 'rules', rules: [{ nameContains: 'invoice', to: 'Finance/{year}' }, { ext: ['jpg'], to: 'Photos/{year}-{month}' }] }, { journalDir });
  assert.deepEqual(ruled.plan.moves.map(move => move.to).sort(), ['Finance/2022/Invoice-9.pdf', 'Photos/2023-05/a.jpg', 'Photos/2024-01/b.jpg']);
  assert.equal(ruled.summary.noRuleMatched, 1, 'misc.txt matched no rule and stays');
  const into = await lib.createPlan(dir, { by: 'type', into: 'Sorted' }, { journalDir });
  assert.ok(into.plan.moves.every(move => move.to.startsWith('Sorted/')));
});

test('engine: rules are validated before anything is planned', async () => {
  const dir = tmp(), journalDir = journal(); put(dir, 'a.pdf');
  for (const [rules, pattern] of [
    [[], /needs a rules array/], [[{ to: 'X' }], /no condition/], [[{ ext: ['pdf'], to: '../escape' }], /invalid part/], [[{ ext: ['pdf'], to: '/abs' }], /relative/],
    [[{ ext: ['pdf'], to: 'A/{nope}' }], /Unknown placeholder/], [[{ regex: '(', to: 'X' }], /not a valid regular expression/], [[{ ext: ['pdf'] }], /needs a "to"/],
  ]) await assert.rejects(() => lib.createPlan(dir, { by: 'rules', rules }, { journalDir }), pattern);
  await assert.rejects(() => lib.createPlan(dir, { by: 'type', into: '../out' }, { journalDir }), /invalid part/);
  assert.deepEqual(fs.readdirSync(journalDir), [], 'no plan was saved');
});

test('engine: tidy-names normalizes names, keeps extensions meaningful, and resolves collisions', async () => {
  assert.equal(lib.tidyName('  My   Report  (Final).PDF'), 'My Report (Final).pdf');
  assert.equal(lib.tidyName('My Report (Final).PDF', 'kebab'), 'my-report-final.pdf');
  assert.equal(lib.tidyName('Q3: Sales / Plan?.xlsx', 'snake'), 'q3_sales_plan.xlsx');
  assert.equal(lib.tidyName('???.pdf'), 'file.pdf');
  assert.equal(lib.tidyName('a.b.TXT'), 'a.b.txt');
  const dir = tmp(), journalDir = journal();
  put(dir, 'My File.TXT', '1'); put(dir, 'my-file.txt', '2'); put(dir, 'clean.txt', '3');
  const { plan, summary } = await lib.createPlan(dir, { by: 'tidy-names', style: 'kebab' }, { journalDir });
  assert.equal(summary.alreadyInPlace, 2); assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].to, 'my-file (2).txt', 'the name taken by another file is not reused');
  await lib.applyPlan(plan, { journalDir });
  assert.equal(fs.readFileSync(path.join(dir, 'my-file.txt'), 'utf8'), '2', 'the file that already had the clean name keeps it');
  assert.equal(fs.readFileSync(path.join(dir, 'my-file (2).txt'), 'utf8'), '1');
  assert.equal(tree(dir).length, 3);
});

test('engine: only plain files move; hidden files, symlinks, project folders and unfinished downloads stay', async () => {
  const dir = tmp(), journalDir = journal();
  put(dir, 'visible.pdf'); put(dir, '.hidden.pdf'); put(dir, 'movie.mp4.crdownload'); put(dir, '~$lock.docx'); put(dir, 'Thumbs.db');
  fs.symlinkSync(path.join(dir, 'visible.pdf'), path.join(dir, 'link.pdf'));
  put(dir, 'proj/package.json', '{}'); put(dir, 'proj/readme.md');
  put(dir, 'plain/inner.pdf');
  const flat = await lib.createPlan(dir, { by: 'type' }, { journalDir });
  assert.deepEqual(flat.plan.moves.map(move => move.from), ['visible.pdf']);
  assert.deepEqual(Object.keys(flat.summary.skipped).sort(), ['hidden', 'symlink', 'system junk', 'unfinished download or lock file']);
  const deep = await lib.createPlan(dir, { by: 'type', recursive: true }, { journalDir });
  assert.deepEqual(deep.plan.moves.map(move => move.from).sort(), ['plain/inner.pdf', 'visible.pdf']);
  assert.equal(deep.summary.skipped['project folder'], 1);
  const hidden = await lib.createPlan(dir, { by: 'type', includeHidden: true }, { journalDir });
  assert.ok(hidden.plan.moves.some(move => move.from === '.hidden.pdf'));
  await lib.applyPlan(deep.plan, { journalDir });
  assert.ok(fs.existsSync(path.join(dir, 'proj', 'readme.md')) && fs.lstatSync(path.join(dir, 'link.pdf')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plain')), [], 'the emptied folder is left in place, not deleted');
  assert.deepEqual(lib.verifyPlan(deep.plan).emptyFolders, ['plain']);
});

test('engine: an already organized folder plans nothing, and recursive runs do not flatten filed subfolders', async () => {
  const dir = tmp(), journalDir = journal();
  put(dir, 'Images/2024/trip/a.jpg'); put(dir, 'Documents/b.pdf');
  const { plan, summary } = await lib.createPlan(dir, { by: 'type', recursive: true }, { journalDir });
  assert.equal(plan, undefined); assert.equal(summary.alreadyInPlace, 2); assert.match(summary.note, /already where it belongs/);
});

test('engine: refuses the home folder, system folders, hidden config folders and projects', async () => {
  const home = tmp(); put(home, 'Downloads/a.pdf'); put(home, '.config/app/x.json'); put(home, 'code/package.json', '{}'); put(home, 'code/.git/HEAD', 'ref');
  assert.match(lib.unsafeRoot(home, home), /home folder itself/);
  assert.match(lib.unsafeRoot(path.dirname(home), home), /contains the home folder|top-level|system/);
  assert.match(lib.unsafeRoot('/etc/nginx', home), /system folder/);
  assert.match(lib.unsafeRoot('/usr', home), /top-level|system/);
  assert.match(lib.unsafeRoot('/', home), /top-level/);
  assert.match(lib.unsafeRoot(path.join(home, '.config', 'app'), home), /hidden configuration/);
  assert.match(lib.unsafeRoot(path.join(home, 'code'), home), /project/);
  assert.equal(lib.unsafeRoot(path.join(home, 'code'), home, true), undefined);
  assert.equal(lib.unsafeRoot(path.join(home, 'Downloads'), home), undefined);
  await assert.rejects(() => lib.resolveRoot(path.join(home, 'code')), /looks like a project/);
  await assert.rejects(() => lib.resolveRoot(path.join(home, 'Downloads', 'a.pdf')), /is a file/);
  await assert.rejects(() => lib.resolveRoot(path.join(home, 'missing')), /does not exist/);
});

test('engine: inventory reports types, duplicates, messy names and what will be left alone', async () => {
  const dir = mixedFolder();
  put(dir, 'dup1.png', 'same'); put(dir, 'dup2.png', 'same'); put(dir, 'Messy  Name.PDF', 'x'); put(dir, '.secret', 'x');
  const found = await lib.inventory(dir);
  assert.equal(found.files, 14); assert.equal(found.skipped.hidden, 1);
  assert.equal(found.duplicates.groups, 1); assert.equal(found.duplicates.copies, 1);
  assert.ok(found.namesNeedingTidy >= 2);
  assert.equal(found.types.find(row => row.type === 'Images').files, 3);
  assert.ok(found.topExtensions.length > 0 && found.largest.length === 5);
});

test('tool: scan, plan, apply, verify and undo through the registered tool, with argument repair', async () => {
  const dir = mixedFolder(), journalDir = journal();
  process.env.PI_ORGANIZE_DIR = journalDir;
  const tools = new Map(), preflights = [];
  const pi = { on() {}, registerTool: (tool) => tools.set(tool.name, tool), events: { emit: (event, payload) => { if (event === 'harness:mutation-preflight') preflights.push(payload.target); }, on() {} } };
  fsOrganize(pi);
  const tool = tools.get('fs_organize'), ctx = { cwd: dir, hasUI: false };
  const call = async (input) => { const prepared = tool.prepareArguments(input); const result = await tool.execute('id', prepared, undefined, undefined, ctx); return result.details; };
  assert.equal(tool.prepareArguments({ path: dir }).action, 'scan');
  assert.equal(tool.prepareArguments({ folder: dir, by: 'categories' }).action, 'plan');
  assert.equal(tool.prepareArguments({ folder: dir, by: 'categories' }).by, 'type');
  assert.equal(tool.prepareArguments({ planId: 'org-abc123' }).action, 'verify', 'a bare planId is a read-only check, never an apply');
  assert.equal(tool.prepareArguments({ action: 'Organize', path: dir, by: 'month' }).date, 'month');
  assert.deepEqual(tool.prepareArguments({ path: dir, rules: '[{"ext":"pdf, docx","folder":"Docs"}]' }).rules, [{ ext: ['pdf', 'docx'], folder: 'Docs', to: 'Docs' }]);
  assert.equal(tool.prepareArguments({ action: 'constructor' }).action, 'constructor');

  const scan = await call({ path: dir });
  assert.equal(scan.files, 11); assert.match(scan.next, /plan/);
  const planned = await call({ action: 'plan', path: dir, by: 'type' });
  assert.equal(planned.toMove, 11); assert.match(planned.planId, /^org-/); assert.match(planned.next, /Nothing has moved/);
  assert.equal(fs.existsSync(path.join(dir, 'Documents')), false);
  const applied = await call({ action: 'apply', planId: planned.planId });
  assert.equal(applied.moved, 11); assert.equal(applied.verification.ok, true); assert.equal(applied.verification.fileCountNow, 11);
  assert.ok(preflights.length >= 2 && preflights.every(target => target.startsWith(dir)), `harness write policy was consulted for each folder: ${preflights.length}`);
  await assert.rejects(() => call({ action: 'apply', planId: planned.planId }), /already applied/);
  assert.equal((await call({ action: 'verify', planId: planned.planId })).ok, true);
  assert.equal((await call({ action: 'plans' })).plans[0].planId, planned.planId);
  const undone = await call({ action: 'undo', planId: planned.planId });
  assert.equal(undone.restored, 11); assert.equal(undone.status, 'undone');
  assert.equal(fs.readdirSync(dir).length, 11);
  await assert.rejects(() => call({ action: 'apply', planId: '../../etc/passwd' }), /not a plan id/);
  await assert.rejects(() => call({ action: 'plan', path: dir }), /needs by/);
  await assert.rejects(() => call({ action: 'plan', path: dir, by: 'color' }), /not one of/);
  await assert.rejects(() => call({ action: 'plan', path: os.homedir(), by: 'type' }), /Refusing/);
  await assert.rejects(() => call({ action: 'apply' }), /needs planId/);
  delete process.env.PI_ORGANIZE_DIR;
});

test('tool: a denied write scope blocks apply and undo before any file moves', async () => {
  const dir = mixedFolder(), journalDir = journal(), before = hashes(dir);
  process.env.PI_ORGANIZE_DIR = journalDir;
  let deny = false;
  const tools = new Map();
  const pi = { on() {}, registerTool: (tool) => tools.set(tool.name, tool), events: { emit: (event, payload) => { if (event === 'harness:mutation-preflight' && deny) payload.checks.push(() => ({ block: true, reason: `Blocked: ${payload.target} is outside the verified writable scope.` })); }, on() {} } };
  fsOrganize(pi);
  const tool = tools.get('fs_organize'), ctx = { cwd: dir, hasUI: false };
  const call = async (input) => (await tool.execute('id', tool.prepareArguments(input), undefined, undefined, ctx)).details;
  const planned = await call({ action: 'plan', path: dir, by: 'type' });
  deny = true;
  await assert.rejects(() => call({ action: 'apply', planId: planned.planId }), /outside the verified writable scope/);
  assert.deepEqual(hashes(dir), before, 'nothing moved');
  deny = false;
  await call({ action: 'apply', planId: planned.planId });
  deny = true;
  await assert.rejects(() => call({ action: 'undo', planId: planned.planId }), /outside the verified writable scope/);
  assert.equal(Object.keys(hashes(dir)).length, 11);
  delete process.env.PI_ORGANIZE_DIR;
});

test('engine: an explicit move list is validated whole, then moves exactly what was asked with the same safety', async () => {
  const dir = tmp(), journalDir = journal(), outside = tmp();
  put(dir, 'inv-acme.pdf', 'acme'); put(dir, 'inv-globex.pdf', 'globex'); put(dir, 'sub/receipt.pdf', 'receipt'); put(dir, 'keep.txt', 'keep'); put(outside, 'secret.txt', 'secret');
  fs.symlinkSync(outside, path.join(dir, 'escape'));
  fs.symlinkSync(path.join(dir, 'keep.txt'), path.join(dir, 'alias.txt'));
  const bad = [
    [[{ from: 'missing.pdf', to: 'X/' }], /does not exist/], [[{ from: '../x', to: 'X/' }], /must be a file inside/], [[{ from: path.join(outside, 'secret.txt'), to: 'X/' }], /must be a file inside/],
    [[{ from: 'escape/secret.txt', to: 'X/' }], /leaves the folder/], [[{ from: 'alias.txt', to: 'X/' }], /not a regular file/], [[{ from: 'sub', to: 'X/' }], /not a regular file/],
    [[{ from: 'keep.txt', to: '../out/' }], /invalid part/], [[{ from: 'keep.txt', to: '/abs/' }], /relative/], [[{ from: 'keep.txt', to: 'a/b:c' }], /invalid file name/],
    [[{ from: 'keep.txt', to: 'X/' }, { from: 'keep.txt', to: 'Y/' }], /listed twice/], [[], /needs moves/],
  ];
  for (const [moves, pattern] of bad) await assert.rejects(() => lib.createPlan(dir, { by: 'moves', moves }, { journalDir }), pattern);
  const before = hashes(dir);
  const { plan, summary } = await lib.createPlan(dir, { by: 'moves', moves: [
    { from: 'inv-acme.pdf', to: 'Finance/Acme/' }, { from: 'inv-globex.pdf', to: 'Finance/Globex/invoice-2024.pdf' }, { from: path.join(dir, 'sub', 'receipt.pdf'), to: 'Finance/Acme/' }, { from: 'keep.txt', to: 'keep.txt' },
  ] }, { journalDir });
  assert.equal(summary.toMove, 3); assert.equal(summary.alreadyInPlace, 1);
  assert.deepEqual(plan.moves.map(move => move.to).sort(), ['Finance/Acme/inv-acme.pdf', 'Finance/Acme/receipt.pdf', 'Finance/Globex/invoice-2024.pdf']);
  await lib.applyPlan(plan, { journalDir });
  assert.equal(fs.readFileSync(path.join(dir, 'Finance/Globex/invoice-2024.pdf'), 'utf8'), 'globex');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
  await lib.undoPlan(plan, { journalDir });
  assert.deepEqual(hashes(dir), before);
});

test('engine: a folder that is a symbolic link is never written through', async () => {
  const dir = tmp(), journalDir = journal(), outside = tmp();
  put(dir, 'a.pdf', 'a'); fs.symlinkSync(outside, path.join(dir, 'Documents'));
  const { plan } = await lib.createPlan(dir, { by: 'type' }, { journalDir });
  await assert.rejects(() => lib.applyPlan(plan, { journalDir }), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the folder');
  assert.ok(fs.existsSync(path.join(dir, 'a.pdf')));
});

test('tool: explicit moves arrive in any shape a model might send', async () => {
  const tools = new Map(); require_(tools);
  const tool = tools.get('fs_organize');
  assert.deepEqual(tool.prepareArguments({ path: '/x', moves: { 'a.pdf': 'Docs/' } }).moves, [{ from: 'a.pdf', to: 'Docs/' }]);
  assert.deepEqual(tool.prepareArguments({ path: '/x', moves: '[{"source":"a.pdf","destination":"Docs/"}]' }).moves.map(({ from, to }) => [from, to]), [['a.pdf', 'Docs/']]);
  const prepared = tool.prepareArguments({ path: '/x', moves: [{ file: 'a.pdf', folder: 'Docs/' }] });
  assert.equal(prepared.action, 'plan'); assert.equal(prepared.by, 'moves'); assert.equal(prepared.moves[0].from, 'a.pdf');
  assert.equal(tool.prepareArguments({ path: '/x', by: 'explicit', moves: [] }).by, 'moves');
});
function require_(tools) { fsOrganize({ on() {}, registerTool: (tool) => tools.set(tool.name, tool), events: { emit() {}, on() {} } }); }
