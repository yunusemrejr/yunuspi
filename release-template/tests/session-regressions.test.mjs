// Regressions found by mining live sessions (2026-09-21..25).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/file-verification.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const FV = await load('extensions/pi-subagents/src/runs/shared/file-verification.ts');

test('PHP templates without a closing tag keep their HTML balance (three finished workers were rejected)', () => {
  const tool = `<?php\ndeclare(strict_types=1);\nrequire_once __DIR__ . '/lib.php';\n$stage = <<<'HTML'\n<div class="tool" data-metronome>\n  <div class="bar"><button>Play</button></div>\n</div>\nHTML;\nrender($stage);\n`;
  assert.deepEqual(FV.inspectStaticHtml(tool).orphan, {});
  assert.equal(FV.inspectStaticHtml(tool).unclosed.div, 0);
  // A template split across heredocs still balances overall.
  assert.deepEqual(FV.inspectStaticHtml("<?php\n$a = <<<HTML\n<section>\nHTML;\n$b = <<<\"HTML\"\n</section>\nHTML;\n").orphan, {});
  // Mixed PHP/HTML files and arrow functions with '>' in code.
  assert.deepEqual(FV.inspectStaticHtml("<?php $f = fn($x) => $x > 2; ?>\n<main><div>ok</div></main>\n<?php if ($y): ?><p>y</p><?php endif;").orphan, {});
  // Real imbalance is still caught.
  assert.deepEqual(FV.inspectStaticHtml("<?php\n$s = <<<'HTML'\n<div></div></div>\nHTML;\n").orphan, { div: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-verify-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'));
    const contract = { scope: ['tools/metronome.php'] };
    const baseline = FV.captureFileVerification(contract, dir);
    fs.writeFileSync(path.join(dir, 'tools/metronome.php'), tool);
    const checks = FV.verifyFileContract(contract, baseline, dir);
    assert.ok(checks.every(check => check.status === 'passed'), JSON.stringify(checks));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a chain whose active step is a parallel group renders its progress label', async () => {
  const render = await load('extensions/pi-subagents/src/tui/render.ts');
  const { initTheme, theme } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/modes/interactive/theme/theme.js')).href);
  initTheme('dark');
  const details = {
    mode: 'chain', chainAgents: ['scout', '[worker+worker]'], totalSteps: 2, currentStepIndex: 1,
    results: [{ agent: 'scout', task: 'look', exitCode: 0, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, progress: { index: 0, status: 'completed' } }],
    progress: [{ index: 0, status: 'completed' }, { index: 1, status: 'running' }, { index: 2, status: 'completed' }],
  };
  const component = render.renderSubagentResult({ content: [{ type: 'text', text: 'running' }], details }, { expanded: false }, theme);
  const text = component.render(100).join('\n');
  assert.match(text, /parallel group/, 'the active group label renders instead of throwing on undefined bounds');
});

test('an over-long explanation is shortened with a marker instead of costing a turn; everything else still rejects', async () => {
  const { validateToolArguments } = await import(pathToFileURL(path.join(root, 'core/ai/src/utils/validation.js')).href);
  const { Type } = await import('typebox');
  const tool = { name: 'quality_review', parameters: Type.Object({ action: Type.String(), reason: Type.Optional(Type.String({ maxLength: 120 })), path: Type.Optional(Type.String({ maxLength: 12 })) }) };
  const repaired = validateToolArguments(tool, { name: 'quality_review', arguments: { action: 'record', reason: 'Because '.repeat(40) } });
  assert.ok(repaired.reason.length <= 120);
  assert.match(repaired.reason, /\[shortened from 320 characters\]$/);
  assert.throws(() => validateToolArguments(tool, { name: 'quality_review', arguments: { action: 'record', path: 'a/very/long/path/name.ts' } }), /Validation failed/, 'identifiers and paths are never trimmed');
  assert.throws(() => validateToolArguments(tool, { name: 'quality_review', arguments: { reason: 'x'.repeat(200) } }), /Validation failed/, 'a missing required field still rejects the call');
});
