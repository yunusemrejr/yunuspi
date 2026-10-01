import test from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingSelectorComponent } from '../core/coding-agent/src/modes/interactive/components/thinking-selector.js';
import { visibleWidth } from '../core/tui/src/utils.js';
import { initTheme } from '../core/coding-agent/src/modes/interactive/theme/theme.js';
initTheme('dark');

test('advertised ultra reasoning remains visible and keyboard selectable at narrow and wide widths',()=>{
 let selected;
 const selector=new ThinkingSelectorComponent('high',['high','max','ultra'],level=>{selected=level;},()=>{});
 for(const width of [32,100]){
  const lines=selector.render(width);
  assert.ok(lines.some(line=>line.includes('ultra')));
  assert.ok(lines.every(line=>visibleWidth(line)<=width));
 }
 selector.handleInput('\x1b[B');selector.handleInput('\x1b[B');selector.handleInput('\r');
 assert.equal(selected,'ultra');
 const unsupported=new ThinkingSelectorComponent('high',['high','max'],()=>{},()=>{});
 assert.ok(!unsupported.render(100).some(line=>line.includes('ultra')));
});
