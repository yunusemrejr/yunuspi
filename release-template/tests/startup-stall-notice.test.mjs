import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {time,watchStartupStall} from '../core/coding-agent/src/core/timings.js';

test('a stalled headless start names its last completed step once; a finished start says nothing',async()=>{
  const lines=[];
  time('createSessionManager');
  watchStartupStall(30,(text)=>lines.push(text));
  await new Promise((resolve)=>setTimeout(resolve,80));
  assert.deepEqual(lines,['YunusPi is still starting after 0s (last completed step: createSessionManager).\n']);
  const quiet=[];
  const stop=watchStartupStall(30,(text)=>quiet.push(text));
  stop();
  await new Promise((resolve)=>setTimeout(resolve,80));
  assert.deepEqual(quiet,[]);
});

test('the stall watch never keeps a finished process alive',async()=>{
  const script=`import {watchStartupStall} from ${JSON.stringify(new URL('../core/coding-agent/src/core/timings.js',import.meta.url).href)}; watchStartupStall(60000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
  const started=Date.now();
  const code=await new Promise((resolve)=>child.on('exit',resolve));
  assert.equal(code,0);
  assert.ok(Date.now()-started<10_000,'exits without waiting for the timer');
});
