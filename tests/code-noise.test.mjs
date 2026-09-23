import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectCodeNoise} from '../agent/extensions/lib/code-noise.mjs';
import registerSourceCheck, {sourceCheck} from '../agent/extensions/lib/source-check.ts';

test('actual WASM AST flags exact narration and empty catches, abstaining on explanations and quoted code',async()=>{
  const source = `export function total(value) {
// Return value
return value;
}
try { total(1); } catch {}
try { total(1); } catch { /* optional telemetry; caller continues */ }
function maintained(value) {
// Return value because the caller retains ownership.
return value;
}
/** Return value. */
function documented(value) { return value; }
const example = '// Return value\\nreturn value;';
function different(value) {
// Return value
return value + 1;
}
// Optional telemetry cannot interrupt the caller.
try { total(1); } catch {}
try { total(1); } /* Best-effort cleanup. */ catch {}`;
  const result = await inspectCodeNoise('module.ts',source);
  assert.equal(result.status,'checked');
  assert.deepEqual(result.findings,[{kind:'comment-restates-return',line:2,relatedLine:3},{kind:'undocumented-empty-catch',line:5}]);
  assert.equal(JSON.stringify(result).includes('caller retains'),false);
  const python = await inspectCodeNoise('module.py','def total(value):\n    # Return value\n    return value\n');
  assert.deepEqual(python.findings,[{kind:'comment-restates-return',line:2,relatedLine:3}]);
  const invalid = await inspectCodeNoise('module.ts','function { // Return value\n return value;');
  assert.equal(invalid.status,'syntax-unavailable');assert.deepEqual(invalid.findings,[]);
});

test('noise scans disclose byte/finding bounds and never convert advice into syntax failure',async()=>{
  const huge = await inspectCodeNoise('module.js',' '.repeat(65537));
  assert.equal(huge.status,'incomplete');assert.equal(huge.truncated,true);
  const many = await inspectCodeNoise('module.js',Array.from({length:100},()=> 'try { call(); } catch {}').join('\n'));
  assert.equal(many.findings.length,3);assert.equal(many.truncated,true);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'code-noise-'));
  try {
    fs.writeFileSync(path.join(directory,'module.js'),'try { call(); } catch {}');
    const checked = await sourceCheck({cwd:directory,paths:['module.js']});
    assert.equal(checked.ok,true);assert.equal(checked.results[0].status,'passed');
    assert.equal(checked.results[0].noise.findings[0].kind,'undocumented-empty-catch');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('successful edit hook emits one bounded advisory per source revision and resets with its session',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'code-noise-hook-'));
  const hooks=new Map(),tools=[];
  const activity=[],sink=Symbol.for('yunus-pi.health.v1'),previousSink=globalThis[sink];
  globalThis[sink]=(kind,data)=>activity.push({kind,...data});
  registerSourceCheck({registerTool:tool=>tools.push(tool),on:(name,handler)=>hooks.set(name,handler)});
  const ctx={cwd:directory,sessionManager:{getSessionId:()=> 'first'}};
  const event={toolName:'write',input:{path:'module.js'},content:[{type:'text',text:'Successfully wrote module.js'}],details:{bytes:25},isError:false};
  try {
    fs.writeFileSync(path.join(directory,'module.js'),'try { call(); } catch {}');
    const first=await hooks.get('tool_result')(event,ctx);
    assert.equal(first.content.length,2);assert.equal(first.content[0],event.content[0]);assert.equal(first.details.bytes,25);
    assert.match(first.content[1].text,/advisory/);assert.match(first.details.codeNoise.digest,/^[a-f0-9]{24}$/);
    assert.equal(first.isError,undefined);
    assert.equal(activity.length,1);assert.equal(activity[0].kind,'ml.wasm.completed');
    assert.equal(activity[0].findings,1);assert.equal(activity[0].runtime,'tree-sitter-wasm');assert.equal(activity[0].decision,'checked');
    assert.equal('source' in activity[0],false);
    assert.equal(await hooks.get('tool_result')(event,ctx),undefined);
    assert.equal(activity.length,1,'deduplicated source did not execute or report another parser run');
    assert.equal(await hooks.get('tool_result')({...event,isError:true},ctx),undefined);
    hooks.get('session_switch')();
    assert.ok(await hooks.get('tool_result')(event,{...ctx,sessionManager:{getSessionId:()=> 'second'}}));
    hooks.get('session_start')();
    for(let index=0;index<5;index++) {
      fs.writeFileSync(path.join(directory,'module.js'),`try { call(${index}); } catch {}`);
      const note=await hooks.get('tool_result')(event,ctx);
      assert.equal(Boolean(note),index<4);
    }
    hooks.get('before_agent_start')();
    assert.ok(await hooks.get('tool_result')(event,ctx));
    hooks.get('session_start')();
    fs.writeFileSync(path.join(directory,'module.js'),'try { previous(); } catch {}\nexport const value = 2;');
    assert.equal(await hooks.get('tool_result')({...event,toolName:'edit',input:{path:'module.js',newText:'export const value = 2;'}},ctx),undefined,'an edit cannot flag unrelated legacy code');
    hooks.get('session_start')();
    const pending=hooks.get('tool_result')(event,ctx);
    hooks.get('session_switch')();
    assert.equal(await pending,undefined,'an old session cannot post a late inspection');
    assert.equal(tools.length,1,'existing syntax_check owns the explicit audit');
  } finally {if(previousSink===undefined)delete globalThis[sink];else globalThis[sink]=previousSink;fs.rmSync(directory,{recursive:true,force:true});}
});
