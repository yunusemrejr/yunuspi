// Check gate: what counts as a check, a code change, a failure; and the once-per-prompt flows at settle and before a push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ev = await jiti.import('../agent/extensions/lib/check-evidence.ts');
const { default: checkGate } = await jiti.import('../agent/extensions/check-gate.ts');

const POSITIVE = [
  'npm test', 'pnpm t', 'yarn test --coverage', 'npm run test:unit', 'npm run build', 'npm run typecheck',
  'npx tsc --noEmit', 'npx -y vitest run', './node_modules/.bin/jest', 'tsc -p .', 'eslint src', 'node --test tests/', 'node --check x.js',
  'pytest -q', 'python3 -m pytest tests', 'python -u -m unittest', 'ruff check .', 'uv run pytest', 'mypy src',
  'go test ./...', 'cargo clippy', 'make', 'make test', 'make -j4 check', 'mvn verify', 'dotnet build', 'shellcheck run.sh', 'bash -n run.sh', 'docker build .',
  'python3 scripts/x.py', 'node build/x.mjs', 'tsx src/a.ts', 'bash tools/x.sh', './scripts/test.sh', 'bin/check',
  'python3 -c "from app import main; main()"', 'curl -s http://localhost:3000/health', 'curl 127.0.0.1:8080/api',
  // wrappers, chains and pipes
  'cd app && npm test', 'NODE_ENV=test npm test', 'timeout 120 pytest -q', 'time nice -n 5 cargo test', 'env -i FOO=1 go test ./...',
  'npm run build && git status', 'git status; npm test | tail -20', 'set -o pipefail; npm test 2>&1 | tee out.log',
];
const NEGATIVE = [
  'git status', 'git diff HEAD', 'grep -rn "npm test" .', 'rg tsc src', 'cat package.json', 'ls -la', 'sed -n 1,20p a.ts',
  'npm install', 'pip install pytest', 'npm run dev', 'npm start', 'node --version', 'pytest --help', 'curl https://example.com/api',
  'python3 -c "print(1)"', 'node -e "console.log(2)"', 'echo "npm test"', 'cd app', 'git push origin main', 'make --version',
];

test('commands that prove a change are recognized, wrapped and piped forms included', () => {
  assert.ok(POSITIVE.length >= 15);
  for (const command of POSITIVE) assert.equal(ev.isCheckCommand(command), true, command);
});

test('commands that only look, install or start something are not checks', () => {
  assert.ok(NEGATIVE.length >= 10);
  for (const command of NEGATIVE) assert.equal(ev.isCheckCommand(command), false, command);
});

test('the goal verification takes the same tool list', () => {
  assert.equal(ev.isCheckToolStep('shellcheck x.sh'), true);
  assert.equal(ev.isCheckToolStep('git push'), false);
});

test('exit and FAIL_MARK decide the outcome', () => {
  const out = (command, result) => ev.checkOutcome(command, result);
  assert.deepEqual(out('npm test', { failed: false, output: '12 passed' }), { kind: 'pass' });
  assert.equal(out('npm test', { failed: true, output: 'boom' }).kind, 'fail');
  assert.equal(out('git status', { failed: true }), undefined);
  assert.equal(out('npm test', { failed: false, background: true }).kind, 'background');
  // exit 0 through a pipe does not clear a failure the output shows
  const piped = out('npm test 2>&1 | tail -5', { failed: false, output: 'Tests: 3 failed, 9 passed' });
  assert.equal(piped.kind, 'fail');
  assert.match(piped.snippet, /3 failed/);
  assert.equal(out('npm test 2>&1 | tail -5', { failed: false, output: '9 passed' }).kind, 'pass');
  // the marker is not read when the command exits 0 without a pipe
  assert.equal(out('npm test', { failed: false, output: '2 failed' }).kind, 'pass');
  // the exit status of a later command hides the check's own, whatever joins them but &&
  for (const command of ['npm test; echo done', 'npm test || true', 'pytest 2>&1 | tail -5', 'npm test\necho done']) {
    assert.equal(out(command, { failed: false, output: 'Tests: 3 failed, 9 passed' }).kind, 'fail', command);
    assert.equal(out(command, { failed: false, output: '9 passed' }).kind, 'pass', command);
  }
  // a lone command, a trailing separator and an && chain keep their exit code
  for (const command of ['npm test', 'npm test;', 'npm test\n', 'cd app && npm test', 'npm test && npm run build'])
    assert.equal(out(command, { failed: false, output: '2 failed' }).kind, 'pass', command);
  for (const sample of ['2 errors', '1 failing', 'not ok 3 - x', 'Traceback (most recent call last):', 'src/a.ts: error TS2322', 'FAIL src/a.test.ts', 'npm ERR! code 1', 'FAILED tests/x.py::t', 'thread panicked at x', 'E   assert 1 == 2'])
    assert.match(sample, ev.FAIL_MARK, sample);
  for (const sample of ['0 failed', 'all passed', 'no errors found']) assert.doesNotMatch(sample, ev.FAIL_MARK, sample);
});

test('code files and exclusions', () => {
  assert.equal(ev.isCodeFile('src/a.ts'), true);
  assert.equal(ev.isCodeFile('/p/app/x.PY', '/p/app'), true);
  for (const file of ['README.md', 'node_modules/x/a.js', 'dist/a.js', 'a.min.js', '/tmp/x.py', 'vendor/a.go', 'data.json']) assert.equal(ev.isCodeFile(file), false, file);
  // a project that lives under a folder named build is not excluded
  assert.equal(ev.isCodeFile('/work/build/proj/a.ts', '/work/build/proj'), true);
  assert.deepEqual(ev.shellWrittenFiles('sed -i s/a/b/ src/a.ts && cat > b.py <<EOF\nx\nEOF'), ['src/a.ts', 'b.py']);
  assert.deepEqual(ev.shellWrittenFiles('echo x | tee -a log.txt > /dev/null'), ['log.txt']);
  // an arrow inside a quoted message is text, not a write
  for (const command of ['git commit -m "rename a.ts -> b.ts"', "git commit -m 'a.ts > b.ts'", 'echo a \\> b.ts', 'npm test 2>&1 | tail -5', 'node x.js >&2'])
    assert.deepEqual(ev.shellWrittenFiles(command), [], command);
  assert.deepEqual(ev.shellWrittenFiles('echo "a > b" > out.py'), ['out.py']);
  assert.deepEqual(ev.shellWrittenFiles('git commit -m "x -> y.ts" && echo hi >> log.ts'), ['log.ts']);
  assert.deepEqual(ev.shellWrittenFiles('echo hi > "my file.ts"'), ['my file.ts']);
  assert.deepEqual(ev.shellWrittenFiles("echo hi >'my file.ts'"), ['my file.ts']);
});

test('publishing commands', () => {
  for (const command of ['git push', 'git push origin main', 'cd x && git -C y push --force', 'npm publish', 'gh release create v1']) assert.equal(ev.isPublishCommand(command), true, command);
  for (const command of ['git pull', 'git status', 'git push --help', 'echo git push']) assert.equal(ev.isPublishCommand(command), false, command);
});

test('a report that puts work off is found', () => {
  assert.equal(ev.deferredPhrase('The pipeline follows as its own small update.'), 'follows as its own small update');
  assert.equal(ev.deferredPhrase('Docs left for later.'), 'left for later');
  assert.equal(ev.deferredPhrase('All done and verified.'), undefined);
  for (const [report, phrase] of [
    ['I deferred the migration.', 'I deferred'],
    ["We've postponed the rollout.", "We've postponed"],
    ['I have deferred the docs.', 'I have deferred'],
    ['The rest is deferred to a later round.', 'deferred to a later'],
    ['Postponed until the next release.', 'Postponed until the next'],
    ['Done.\n**Deferred:** logging', 'Deferred:'],
    ['Done.\n## Postponed:\n- docs', 'Postponed:'],
  ]) assert.equal(ev.deferredPhrase(report), phrase, report);
  // the word as part of the subject is not a promise to do it later
  for (const report of ['Scripts are now loaded deferred.', 'I documented how deferred payments work.', 'The postponed jobs table is unchanged.', 'Deferred rendering is on by default.', 'The change is not deferred or postponed in any way.', 'As a next step you could add tests.'])
    assert.equal(ev.deferredPhrase(report), undefined, report);
});

const BG_TERMINAL = 'pi-background-tasks:terminal:v1';

function harness(cwd = '/p') {
  const handlers = {}, listeners = {}, sent = [];
  const pi = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    events: { on: (name, fn) => { (listeners[name] ??= []).push(fn); } },
    sendMessage: async (message, options) => { sent.push({ message, options }); },
  };
  const ctx = { cwd, hasPendingMessages: () => false, signal: undefined, sessionManager: { getSessionId: () => 'check-gate-fixture', getBranch: () => [] } };
  checkGate(pi);
  const fire = async (name, event) => { let out; for (const fn of handlers[name] ?? []) out = (await fn(event, ctx)) ?? out; return out; };
  const done = fire('session_start', {});
  return {
    sent,
    ready: () => done,
    prompt: (source = 'interactive') => fire('input', { source, text: 'do it' }),
    edit: (path) => fire('tool_result', { toolName: 'edit', input: { path }, details: {}, content: [], isError: false }),
    run: (command, { exitCode = 0, output = '', isError = false } = {}) => fire('tool_result', { toolName: 'bash', input: { command }, details: { exitCode }, content: [{ type: 'text', text: output }], isError }),
    screenshot: () => fire('tool_result', { toolName: 'browser_session', input: { action: 'screenshot' }, details: {}, content: [], isError: false }),
    read: (path, content = []) => fire('tool_result', { toolName: 'read', input: { path }, details: {}, content, isError: false }),
    // The shapes the background-tasks tools return: bg_run and bg_logs carry a task snapshot, bg_status a list of them, bg_wait the provider outcome.
    bgRun: (command, id = 'b1') => fire('tool_result', { toolName: 'bg_run', input: { command, isAgent: false }, details: { task: { id, command, status: 'running' } }, content: [{ type: 'text', text: `Started background task ${id}` }], isError: false }),
    bgWait: (id, status = 'completed', exitCode = 0) => fire('tool_result', { toolName: 'bg_wait', input: { id }, details: { mode: 'management', results: [], providerOutcome: { provider: 'bg_run', id, status, ...(exitCode === undefined ? {} : { exitCode }) } }, content: [{ type: 'text', text: `Waited 3s. Background task "${id}" ${status}${exitCode === undefined ? '' : ` (exit ${exitCode})`}.` }], isError: false }),
    bgStatus: (...tasks) => fire('tool_result', { toolName: 'bg_status', input: {}, details: { tasks }, content: [{ type: 'text', text: tasks.map(task => `${task.id} ${task.status}`).join('\n') }], isError: false }),
    bgLogs: (task, output) => fire('tool_result', { toolName: 'bg_logs', input: { taskId: task.id }, details: { task, path: '/x', bytesRead: output.length, truncated: false, tail: true }, content: [{ type: 'text', text: output }], isError: false }),
    terminal: (task) => { for (const fn of listeners[BG_TERMINAL] ?? []) fn({ schema_version: 1, task }); },
    reply: (text = 'done', stopReason = 'stop') => fire('message_end', { message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } }),
    settle: () => fire('agent_settled', {}),
    call: (command, toolName = 'bash') => fire('tool_call', { toolName, input: { command } }),
  };
}
const start = async () => { const h = harness(); await h.ready(); await h.prompt(); return h; };

test('edit then settle sends one continuation, and a second settle does not repeat it', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts'); await h.reply(); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /Code changed after its last check: src\/a\.ts\./);
  assert.match(h.sent[0].message.content, /list every copy the change must reach/);
  assert.equal(h.sent[0].options.triggerTurn, true);
  await h.reply(); await h.settle();
  assert.equal(h.sent.length, 1, 'once per prompt');
});

test('edit, passing check, settle sends nothing', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts'); await h.run('npm test', { output: '5 passed' }); await h.reply(); await h.settle();
  assert.equal(h.sent.length, 0);
});

test('a failing check names the command and the failure', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts');
  await h.run('npm test 2>&1 | tail -5', { output: 'Tests: 2 failed, 7 passed' });
  await h.reply(); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /The last check failed: `npm test 2>&1 \| tail -5` — Tests: 2 failed/);
});

test('a report that already states the failed check is not asked to do it again', async () => {
  for (const report of ['Two tests still fail: the retry case and the timeout case.', 'I ran `npm test 2>&1 | tail -5` and read the output; the build is red.']) {
    const h = await start();
    await h.edit('/p/src/a.ts');
    await h.run('npm test 2>&1 | tail -5', { output: 'Tests: 2 failed, 7 passed' });
    await h.reply(report); await h.settle();
    assert.equal(h.sent.length, 0, report);
  }
  // a success claim next to the failure still gets the notice
  for (const report of ['All tests pass; fixed the failing test.', 'The build is green now, the earlier failure was a typo.', 'Ran `npm test 2>&1 | tail -5`.']) {
    const h = await start();
    await h.edit('/p/src/a.ts');
    await h.run('npm test 2>&1 | tail -5', { output: 'Tests: 2 failed, 7 passed' });
    await h.reply(report); await h.settle();
    assert.match(h.sent[0]?.message.content ?? '', /The last check failed/, report);
  }
  {
    const h = await start();
    await h.edit('/p/src/a.ts');
    await h.run('npm test', { output: 'Tests: 2 failed, 7 passed' });
    await h.reply('npm test still fails: 2 failed'); await h.settle();
    assert.equal(h.sent.length, 0);
  }
  // unchecked code is still asked about, whatever the report says
  const h = await start();
  await h.edit('/p/src/a.ts'); await h.reply('The failure was a typo; fixed.'); await h.settle();
  assert.match(h.sent[0].message.content, /Code changed after its last check/);
});

test('notes, an interrupted run and a stop with work pending stay silent', async () => {
  const h = await start();
  await h.edit('/p/README.md'); await h.reply(); await h.settle();
  assert.equal(h.sent.length, 0, 'a note is not code');
  await h.edit('/p/a.py'); await h.reply('stopped', 'aborted'); await h.settle();
  assert.equal(h.sent.length, 0, 'an interrupt is not a finish');
});

test('a push is held once per prompt while code is unchecked', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts');
  const first = await h.call('git push origin main');
  assert.equal(first.block, true);
  assert.match(first.reason, /Hold the push: code changed after its last check \(src\/a\.ts\)/);
  assert.equal(await h.call('git push origin main'), undefined, 'the second attempt goes through');
  assert.equal(await h.call('git status'), undefined);
  await h.prompt(); await h.run('npm test');
  assert.equal(await h.call('git push'), undefined, 'nothing unchecked');
});

test('a push started in the background is held like one run in the foreground', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts');
  const first = await h.call('git push origin main', 'bg_run');
  assert.equal(first.block, true);
  assert.match(first.reason, /Hold the push: code changed after its last check \(src\/a\.ts\)/);
  assert.equal(await h.call('git push origin main', 'bg_run'), undefined, 'the second attempt goes through');
  assert.equal(await h.call('git push origin main', 'read'), undefined, 'other tools are not commands');
});

test('a final report that defers work after changes is named once, joined with the check text', async () => {
  const h = await start();
  await h.edit('/p/a.ts'); await h.run('npm test');
  await h.reply('Fixed. The migration follows as its own small update.'); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /Your report puts off «follows as its own small update»/);
});

test('a visible change with no look is asked for, and a screenshot clears it', async () => {
  const h = await start();
  await h.edit('/p/site/index.html'); await h.reply(); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /Changed and not looked at: site\/index\.html\./);
  const looked = await start();
  await looked.edit('/p/site/index.html'); await looked.screenshot(); await looked.reply(); await looked.settle();
  assert.equal(looked.sent.length, 0);
});

test('the switches turn the gate off', async () => {
  process.env.PI_LOOK_GATE = '0';
  try {
    const h = await start();
    await h.edit('/p/site/index.html'); await h.reply(); await h.settle();
    assert.equal(h.sent.length, 0, 'PI_LOOK_GATE=0 silences the look part');
    await h.edit('/p/a.ts'); await h.reply(); await h.settle();
    assert.equal(h.sent.length, 1, 'the check part still speaks');
  } finally { delete process.env.PI_LOOK_GATE; }
  process.env.PI_CHECK_GATE = '0';
  try {
    const h = await start();
    await h.edit('/p/a.ts'); await h.reply(); await h.settle();
    assert.equal(h.sent.length, 0);
  } finally { delete process.env.PI_CHECK_GATE; }
});

test('one message per settle and one hold per command across the older gates', async () => {
  const h = await start();
  assert.equal(ev.checkGateCovers(), false, 'nothing unchecked');
  await h.edit('/p/src/a.ts');
  assert.equal(ev.checkGateCovers(), true, 'the older test and checkpoint nudges stay silent');
  await h.reply(); await h.settle();
  assert.equal(ev.checkGateCovers(), true, 'and after the ask too, for the rest of the prompt');
  await h.run('npm test'); await h.prompt();
  assert.equal(ev.checkGateCovers(), false);
  // a command another gate already held passes this one
  await h.edit('/p/src/b.ts');
  ev.noteHeld('git push origin main', 'receipts');
  assert.equal(await h.call('git push origin main'), undefined);
  ev.clearHeld();
  assert.equal((await h.call('git push origin main')).block, true);
});

// A project folder with real image files: whether a read image counts as a look depends on when the file was written.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'check-gate-'));
  const image = (name, ageMs) => {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'png');
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
    return file;
  };
  return { dir, page: join(dir, 'site/page.html'), image, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const startIn = async cwd => { const h = harness(cwd); await h.ready(); await h.prompt(); return h; };
const PICTURE = [{ type: 'image', data: 'x', mimeType: 'image/png' }];

test('reading an old image from the project is not a look at the page that changed', async () => {
  const p = project();
  try {
    const h = await startIn(p.dir);
    await h.edit(p.page);
    await h.read(p.image('logo.png', 3_600_000), PICTURE);
    await h.reply(); await h.settle();
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].message.content, /Changed and not looked at: site\/page\.html/);
    // the push hold names it too
    const pushed = await startIn(p.dir);
    await pushed.edit(p.page);
    await pushed.read(join(p.dir, 'logo.png'), PICTURE);
    assert.match((await pushed.call('git push')).reason, /Changed and not looked at: site\/page\.html/);
  } finally { p.cleanup(); }
});

test('an image written after the change is a look, found by relative path, with a little slack for coarse mtimes', async () => {
  const p = project();
  try {
    for (const [path, ageMs] of [['shots/new.png', 0], ['./shots/slack.PNG', 1_000]]) {
      const h = await startIn(p.dir);
      await h.edit(p.page);
      p.image(path.replace(/^\.\//, ''), ageMs);
      await h.read(path, PICTURE);
      await h.reply(); await h.settle();
      assert.equal(h.sent.length, 0, path);
    }
    // not later than the slack allows
    const h = await startIn(p.dir);
    await h.edit(p.page);
    await h.read(p.image('shots/stale.png', 10_000), PICTURE);
    await h.reply(); await h.settle();
    assert.equal(h.sent.length, 1);
  } finally { p.cleanup(); }
});

test('an image that cannot be read from disk is not a look, and a page read from a document is', async () => {
  const p = project();
  try {
    const missing = await startIn(p.dir);
    await missing.edit(p.page); await missing.read('shots/gone.png', PICTURE); await missing.reply(); await missing.settle();
    assert.equal(missing.sent.length, 1);
    const text = await startIn(p.dir);
    await text.edit(p.page); await text.read(p.image('notes.png', 0), []); await text.reply(); await text.settle();
    assert.equal(text.sent.length, 0, 'a fresh image path is a look even when the tool shows no image part');
    const pdf = await startIn(p.dir);
    await pdf.edit(p.page); await pdf.read(join(p.dir, 'out.pdf'), PICTURE); await pdf.reply(); await pdf.settle();
    assert.equal(pdf.sent.length, 0, 'a rendered PDF page is image content from a path that is not an image file');
    const plain = await startIn(p.dir);
    await plain.edit(p.page); await plain.read(join(p.dir, 'out.pdf'), [{ type: 'text', text: 'words' }]); await plain.reply(); await plain.settle();
    assert.equal(plain.sent.length, 1, 'text from a file shows no pixels');
  } finally { p.cleanup(); }
});

test('a check started in the background does not count until it finishes', async () => {
  const started = await start();
  await started.edit('/p/src/a.ts'); await started.bgRun('npm test'); await started.reply(); await started.settle();
  assert.match(started.sent[0]?.message.content ?? '', /Code changed after its last check: src\/a\.ts\./, 'still unchecked while it runs');

  const passed = await start();
  await passed.edit('/p/src/a.ts'); await passed.bgRun('npm test'); await passed.bgWait('b1'); await passed.reply(); await passed.settle();
  assert.equal(passed.sent.length, 0);

  for (const [status, exitCode] of [['failed', 1], ['killed', undefined]]) {
    const failed = await start();
    await failed.edit('/p/src/a.ts'); await failed.bgRun('npm test'); await failed.bgWait('b1', status, exitCode); await failed.reply(); await failed.settle();
    assert.match(failed.sent[0]?.message.content ?? '', /The last check failed: `npm test`/, status);
  }

  // an id the gate never saw start a check changes nothing
  const other = await start();
  await other.edit('/p/src/a.ts'); await other.bgWait('elsewhere'); await other.reply(); await other.settle();
  assert.match(other.sent[0]?.message.content ?? '', /Code changed after its last check/);
});

test('bg_status, bg_logs and the terminal event end a background check with its real exit and output', async () => {
  const running = await start();
  await running.edit('/p/src/a.ts'); await running.bgRun('npm test'); await running.bgStatus({ id: 'b1', status: 'running' }); await running.reply(); await running.settle();
  assert.match(running.sent[0]?.message.content ?? '', /Code changed after its last check/, 'a running task is not a result');

  const status = await start();
  await status.edit('/p/src/a.ts'); await status.bgRun('npm test');
  await status.bgStatus({ id: 'zz', status: 'completed', exitCode: 0 }, { id: 'b1', status: 'failed', exitCode: 2 }); await status.reply(); await status.settle();
  assert.match(status.sent[0]?.message.content ?? '', /The last check failed: `npm test`/);

  // the exit of `| tail` is not the check's: the output decides
  const logs = await start();
  await logs.edit('/p/src/a.ts'); await logs.bgRun('npm test 2>&1 | tail -5');
  await logs.bgLogs({ id: 'b1', status: 'completed', exitCode: 0 }, 'Tests: 2 failed, 7 passed'); await logs.reply(); await logs.settle();
  assert.match(logs.sent[0]?.message.content ?? '', /The last check failed: `npm test 2>&1 \| tail -5` — Tests: 2 failed/);

  // the registry announces every end, also when the agent never asks
  const passing = await start();
  await passing.edit('/p/src/a.ts'); await passing.bgRun('npm test'); passing.terminal({ id: 'b1', status: 'completed', exitCode: 0 }); await passing.reply(); await passing.settle();
  assert.equal(passing.sent.length, 0);
  const failing = await start();
  await failing.edit('/p/src/a.ts'); await failing.bgRun('npm test'); failing.terminal({ id: 'b1', status: 'failed', exitCode: 1 }); await failing.reply(); await failing.settle();
  assert.match(failing.sent[0]?.message.content ?? '', /The last check failed/);
  // a second report of the same end changes nothing
  failing.terminal({ id: 'b1', status: 'completed', exitCode: 0 });
  assert.equal(failing.sent.length, 1);
});

test('code edited while a background check ran is still unchecked when it passes', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts'); await h.bgRun('npm test'); await h.edit('/p/src/b.ts'); await h.bgWait('b1'); await h.reply(); await h.settle();
  assert.match(h.sent[0]?.message.content ?? '', /Code changed after its last check: src\/b\.ts\./);
  // the same file edited again after the start
  const again = await start();
  await again.edit('/p/src/a.ts'); await again.bgRun('npm test'); await again.edit('/p/src/a.ts'); await again.bgWait('b1'); await again.reply(); await again.settle();
  assert.match(again.sent[0]?.message.content ?? '', /Code changed after its last check: src\/a\.ts\./);
});

test('a push is held while the background check runs and goes through once it passed', async () => {
  const running = await start();
  await running.edit('/p/src/a.ts'); await running.bgRun('npm test');
  assert.match((await running.call('git push origin main')).reason, /Hold the push: code changed after its last check \(src\/a\.ts\)/);
  const passed = await start();
  await passed.edit('/p/src/a.ts'); await passed.bgRun('npm test'); await passed.bgWait('b1');
  assert.equal(await passed.call('git push origin main'), undefined);
  const failed = await start();
  await failed.edit('/p/src/a.ts'); await failed.bgRun('npm test'); await failed.bgWait('b1', 'failed', 1);
  assert.match((await failed.call('git push origin main')).reason, /Hold the push: the last check failed \(`npm test`\)/);
});

test('a check that managed bash detached to the background is not a pass yet', async () => {
  const h = await start();
  await h.edit('/p/src/a.ts');
  await h.run('npm test', { output: '[managed bash] Still running — detached to background after 30s grace.\n  job: j1 · pid 4 · state: running' });
  await h.reply('Done.'); await h.settle();
  assert.match(h.sent[0]?.message.content ?? '', /Code changed after its last check/);
});
