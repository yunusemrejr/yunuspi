import test from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from '@yunuspi/tui';
import { initTheme, theme } from '../core/coding-agent/dist/modes/interactive/theme/theme.js';
import { ToolExecutionComponent } from '../core/coding-agent/dist/modes/interactive/components/tool-execution.js';
import { createMetricsPanel } from '../agent/extensions/lib/metrics-panel.ts';
import registerSignals from '../agent/extensions/session-signals.ts';
initTheme('dark', false);
const plain = lines => lines.map(stripTerminalSequences).join('\n');
const safe = (lines, width) => {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`);
    assert.doesNotMatch(stripTerminalSequences(line), /[\x00-\x1f\x7f-\x9f]/);
  }
};

test('cost and self commands use the same navigable report panel and retain unknown coverage', async () => {
  const commands = new Map();
  registerSignals({ on() {}, registerTool() {}, registerCommand: (name, command) => commands.set(name, command) });
  const entries = [{ type: 'message', message: { role: 'assistant', provider: 'fixture', model: 'example', content: [], stopReason: 'error' } }];
  for (const name of ['cost', 'self']) {
    let panel, notifications = 0;
    const tui = { terminal: { rows: 12 }, requestRender() {} };
    const ctx = { hasUI: true, sessionManager: { getEntries: () => entries }, ui: {
      notify() { notifications++; }, custom: async (factory, options) => {
        assert.equal(options.overlay, true);
        panel = factory(tui, theme, {}, () => {});
      },
    } };
    await commands.get(name).handler('', ctx);
    assert.equal(notifications, 0, 'long reports do not enter the transcript as notifications');
    for (const width of [1,12,40,80,120]) {
      const lines = panel.render(width);
      safe(lines, width);
      assert.ok(lines.length <= tui.terminal.rows);
    }
    const output = plain(panel.render(120));
    assert.match(output, name === 'cost' ? /Session cost/ : /Session diagnostics/);
    assert.match(output, /[Pp]artial total/);
    if (name === 'cost') assert.match(output, /\$\? total/);
    else { assert.match(output, /1 attempts · 1 failed/); assert.doesNotMatch(output, /"assistantAttempts"/); }
    let fallback;
    await commands.get(name).handler('', { ...ctx, hasUI: false, ui: { notify: text => { fallback = text; } } });
    assert.match(fallback, /Coverage/);
  }
});

test('report panels keep section navigation, scrolling and the logical resize anchor', () => {
  let closed = 0, renders = 0;
  const tui = { terminal: { rows: 8 }, requestRender: () => { renders++; } };
  const lines = ['Overview', 'snapshot', '', 'Failure evidence · current branch', ...Array.from({ length: 12 }, (_, n) => `failure ${n}`), '', 'Context traffic · current branch', ...Array.from({ length: 24 }, (_, n) => `traffic ${n}`), '\x1b[2Junsafe\x07\tvalue'];
  const panel = createMetricsPanel(lines, tui, theme, () => { closed++; });
  safe(panel.render(80),80);
  panel.handleInput('2');
  assert.match(stripTerminalSequences(panel.render(80)[1]), /Context traffic/);
  assert.match(stripTerminalSequences(panel.render(40)[1]), /Context traffic/);
  panel.handleInput('j');
  assert.match(stripTerminalSequences(panel.render(40)[1]), /traffic 0/);
  panel.handleMouse({ type: 'wheel', wheelDelta: 2 });
  assert.match(stripTerminalSequences(panel.render(40)[1]), /traffic 2/);
  panel.handleInput('G');
  const end = panel.render(40); safe(end,40);
  assert.match(plain(end), /unsafe  value/);
  panel.handleInput('g');
  assert.match(stripTerminalSequences(panel.render(40)[1]), /Overview/);
  for (const rows of [1,2,4,24]) { tui.terminal.rows=rows; const frame=panel.render(40); safe(frame,40); assert.ok(frame.length<=rows); }
  for (const key of ['q','\x1b','\r']) panel.handleInput(key);
  assert.equal(closed,3);
  assert.ok(renders>0);
});

test('fallback tool previews bound wrapped JSON rows and expansion keeps the full result', () => {
  const text = JSON.stringify({ records: Array.from({ length: 60 }, (_, id) => ({ id, note: 'retained complete evidence' })), end: 'LAST-EVIDENCE' });
  for (const definition of [undefined, {}]) for (const isError of [false,true]) {
    const tool = new ToolExecutionComponent('fixture_tool','fixture',{action:'report'},{showImages:false},definition,{requestRender(){}},'/workspace');
    tool.updateResult({content:[{type:'text',text}],isError},false);
    for (const width of [12,40,80,120]) {
      tool.setExpanded(false);
      const collapsed=tool.render(width); safe(collapsed,width);
      assert.ok(collapsed.length <= (isError ? 12 : 9), `preview grew to ${collapsed.length}`);
      if (width>=40) assert.match(plain(collapsed), /more rows/);
      assert.doesNotMatch(plain(collapsed), /LAST-EVIDENCE/);
      tool.setExpanded(true);
      const expanded=tool.render(width); safe(expanded,width);
      assert.match(plain(expanded).replace(/\s+/g,''), /LAST-EVIDENCE/);
      assert.ok(expanded.length>collapsed.length);
    }
  }
});

test('collapsing generic tool text preserves the complete native image transport', () => {
  const previous = getCapabilities();
  try {
    setCapabilities({images:'kitty',trueColor:true,hyperlinks:false});
    const tool = new ToolExecutionComponent('image_fixture','image',{}, {showImages:true},undefined,{requestRender(){}},'/workspace');
    // Self-authored fixture: Pillow Image.new('RGBA', (1,1), (0,0,0,0)), encoded as PNG.
    tool.updateResult({content:[{type:'text',text:'long result '.repeat(500)},{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='}],isError:false},false);
    const collapsed=tool.render(80);
    assert.match(plain(collapsed), /more rows/);
    assert.ok(collapsed.some(line=>line.includes('\x1b_G')), 'native image payload follows the collapsed text');
    tool.setShowImages(false);
    assert.ok(!tool.render(80).some(line=>line.includes('\x1b_G')));
  } finally { setCapabilities(previous); }
});
