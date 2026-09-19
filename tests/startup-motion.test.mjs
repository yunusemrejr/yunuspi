import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root,'agent'),path.resolve(root,'..')].find(dir=>fs.existsSync(path.join(dir,'scripts/compatibility/legacy-transforms/tui-branding.mjs')));
const {startRatMotion} = await import(pathToFileURL(path.join(agent,'scripts/compatibility/legacy-transforms/tui-branding.mjs')));
test('startup animation stops before repainting an overflowing terminal', () => {
  let tick, time=0, stopped=false, renders=0;
  const owner={isInitialized:true,chatContainer:{children:[]},builtInHeader:{setExpanded(){}},getStartupExpansionState:()=>false,
    ui:{terminal:{columns:80,rows:40},render:()=>Array(26).fill('startup'),requestRender(){renders++;}}};
  const animate=vm.runInNewContext(`(${startRatMotion.toString()})`,{process:{env:{}},Date:{now:()=>time},setInterval:fn=>{tick=fn;return{unref(){}};},clearInterval:()=>{stopped=true;}});
  animate(owner);time=100;tick();assert.equal(renders,1);
  owner.ui.terminal.rows=12;time=200;tick();
  assert.equal(stopped,true);assert.equal(renders,1);assert.equal(owner._yunusRatFrame,1);
  assert.equal(owner._yunusRatDispose,undefined);
});
