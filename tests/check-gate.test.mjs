// Check gate: what counts as a check, a code change, a failure; and the once-per-prompt flows at settle and before a push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

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
});

test('publishing commands', () => {
  for (const command of ['git push', 'git push origin main', 'cd x && git -C y push --force', 'npm publish', 'gh release create v1']) assert.equal(ev.isPublishCommand(command), true, command);
  for (const command of ['git pull', 'git status', 'git push --help', 'echo git push']) assert.equal(ev.isPublishCommand(command), false, command);
});

test('a report that puts work off is found', () => {
  assert.equal(ev.deferredPhrase('The pipeline follows as its own small update.'), 'follows as its own small update');
  assert.equal(ev.deferredPhrase('Docs left for later.'), 'left for later');
  assert.equal(ev.deferredPhrase('All done and verified.'), undefined);
});

function harness() {
  const handlers = {}, sent = [];
  const pi = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    events: { on: () => {} },
    sendMessage: async (message, options) => { sent.push({ message, options }); },
  };
  const ctx = { cwd: '/p', hasPendingMessages: () => false, signal: undefined, sessionManager: { getSessionId: () => 'check-gate-fixture', getBranch: () => [] } };
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
    reply: (text = 'done', stopReason = 'stop') => fire('message_end', { message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } }),
    settle: () => fire('agent_settled', {}),
    call: (command) => fire('tool_call', { toolName: 'bash', input: { command } }),
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
