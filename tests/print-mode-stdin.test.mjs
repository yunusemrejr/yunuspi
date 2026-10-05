import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readPipedStdin} from '../core/coding-agent/src/main.js';

const pipe=()=>Object.assign(new PassThrough(),{isTTY:false});

test('an open stdin that never sends anything does not hold a prompt given on the command line',async()=>{
  const stdin=pipe(), warnings=[];
  const started=Date.now();
  assert.equal(await readPipedStdin(50,stdin,(text)=>warnings.push(text)),undefined);
  assert.ok(Date.now()-started<2000);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/No input arrived on stdin .* \/dev\/null/);
  assert.equal(stdin.destroyed,true,'the unused stdin is released so the process can exit');
});

test('piped input is still read to the end, even past the grace period once it has started',async()=>{
  const stdin=pipe(), warnings=[];
  const reading=readPipedStdin(50,stdin,(text)=>warnings.push(text));
  stdin.write('first ');
  await new Promise((resolve)=>setTimeout(resolve,120));
  stdin.end('second\n');
  assert.equal(await reading,'first second');
  assert.deepEqual(warnings,[]);
});

test('without a command-line prompt stdin is the prompt, so it is awaited without a limit',async()=>{
  const stdin=pipe();
  const reading=readPipedStdin(undefined,stdin,()=>assert.fail('no warning expected'));
  setTimeout(()=>stdin.end('late prompt'),120);
  assert.equal(await reading,'late prompt');
  assert.equal(await readPipedStdin(undefined,Object.assign(new PassThrough(),{isTTY:true})),undefined,'a terminal is never read');
});
