import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Text, visibleWidth, stripTerminalSequences } from '@yunuspi/tui';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';
import { CustomMessageComponent } from '../core/coding-agent/src/modes/interactive/components/custom-message.js';
import { initTheme, theme } from '../core/coding-agent/src/modes/interactive/theme/theme.js';
import { OBSERVER_MESSAGE, boundedObserverText, observerAdviceText } from '../agent/extensions/lib/session-observer.ts';

test('installed observer renderer shows advice and request states at narrow and wide TUI widths', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-tui-'));
  const prior = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  let extensions = [];
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [path.resolve(import.meta.dirname, '../agent/extensions/session-observer.ts')] });
    await loader.reload();
    const loaded = loader.getExtensions();
    extensions = loaded.extensions;
    assert.deepEqual(loaded.errors, []);
    assert.equal(extensions.length, 1);
    const renderer = extensions[0].messageRenderers.get(OBSERVER_MESSAGE);
    assert.equal(typeof renderer, 'function');
    initTheme('dark');
    const advice = observerAdviceText({ note: 'Consider inspecting the parser before changing the field mapping.', evidence: ['read-1'], tools: ['read'], skills: ['type-driven-design'] });
    const fixtures = [
      'Observer started: deepseek/deepseek-flash · high thinking',
      `Observer returned a note\n${advice}`,
      'Observer unavailable: Observer timed out',
      'Observer unavailable: Observer response rejected: evidence contains an identifier absent from this packet; evidence retained for the next review.',
      'Observer unavailable: Observer response was truncated; evidence retained for the next review.',
      'Observer reviewed: Chunk 2: no useful new reminder.',
      'Observer reviewed: Session advanced during review; outdated advice discarded.',
      'Observer checked: Provider has not acknowledged cancellation; overlapping observer calls are paused.',
      'Observer coverage: 44 earlier events exceeded the queue; historical coverage is incomplete.',
      'Observer returned a note\nWould discovering the parser checker help?\nDiscoverable tools (not active): parser_check.',
      `Observer returned a note\n${boundedObserverText('Inspect \x1b[2Jthe café parser and 東京 input.', 1200)}`,
    ];
    for (const content of fixtures) {
      const message = { customType: OBSERVER_MESSAGE, content, display: true, excludeFromContext: true, details: { status: 'completed' } };
      assert.ok(renderer(message, { expanded: false }, theme) instanceof Text);
      const component = new CustomMessageComponent(message, renderer);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        for (const width of [12, 20, 42, 120]) {
          const lines = component.render(width);
          for (const line of lines) {
            assert.ok(visibleWidth(line) <= width, `line exceeds ${width} cells: ${JSON.stringify(line)}`);
            assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f]/);
          }
          assert.match(lines.map(stripTerminalSequences).join('\n'), /Observer/);
        }
      }
      const rendered = component.render(120).map(stripTerminalSequences).join('\n');
      assert.doesNotMatch(rendered, /session-observer|\bLIVE\b|\bACTIVE\b/);
      if (content.includes(advice)) assert.match(rendered, /Consider tools: read/);
    }
  } finally {
    for (const extension of extensions) for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown' }, {});
    if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prior;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
