// A local image server and inert POST fixtures; no paid provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(dir=>existsSync(path.join(dir,'extensions/lib/image-generate.ts')));
const { imageGenerateRun, imageEditRun, imageRecoverRun }=await import(pathToFileURL(path.join(agent,'extensions/lib/image-generate.ts')));
const { encodeImage }=await import(pathToFileURL(path.join(agent,'extensions/lib/design-studio.ts')));
const env={PI_IMAGE_BACKEND:'openai-compatible',PI_IMAGE_API_URL:'https://fixture.invalid/v1',PI_IMAGE_API_KEY:'TEST_url_recovery_only',PI_IMAGE_MODEL:'fixture/image'};

test('paid URL-only image results survive cancellation and failed downloads and recover through GET only', {timeout:30_000}, async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'image-url-recovery-'));
  const bytes=await encodeImage({width:8,height:8,data:new Uint8Array(8*8*4).fill(255)},'png');
  let downloads=0, status=200;
  const server=http.createServer((_request,response)=>{downloads++;response.writeHead(status,{'content-type':'image/png'});response.end(status===200?bytes:'fixture failed download');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/paid-result.png?fixture-signature=private`;
  const original=globalThis.fetch; let generations=0;
  t.after(async()=>{globalThis.fetch=original;await new Promise(resolve=>server.close(resolve));await fs.rm(cwd,{recursive:true,force:true});});
  globalThis.fetch=async()=>{generations++;return Response.json({data:[{url}],usage:{input_tokens:10,output_tokens:4,cost:.01}});};
  await fs.writeFile(path.join(cwd,'reference.png'),bytes);
  for (const mode of ['generate','edit']) {
    const stop=new AbortController(), statuses=[];
    const runtime={onUsage:(_usage,state)=>{statuses.push(state);if(state==='completed')stop.abort();}};
    let receipt;
    await assert.rejects(mode==='generate'?imageGenerateRun({prompt:'Authored URL fixture'},cwd,stop.signal,undefined,env,runtime):imageEditRun({path:'reference.png',prompt:'Authored URL fixture edit'},cwd,stop.signal,undefined,env,runtime),error=>{receipt=error.retainedImageDownload;assert.doesNotMatch(error.message,/fixture-signature/);return Boolean(receipt);});
    assert.deepEqual(statuses,['pending','completed']);
    assert.equal((await fs.stat(receipt)).mode&0o777,0o600);
    const saved=JSON.parse(await fs.readFile(receipt,'utf8'));
    assert.equal(saved.url,url);assert.equal(saved.decodeVerified,false);assert.equal(saved.usage.cost.total,.01);
    assert.doesNotMatch(JSON.stringify(saved),/TEST_url_recovery_only/);
    const marker=path.join(path.dirname(receipt),'caller-note.txt');await fs.writeFile(marker,'keep');
    const before=generations, recovered=await imageRecoverRun({path:receipt},cwd);
    assert.equal(recovered.decodeVerified,true);assert.equal(generations,before);
    assert.deepEqual(await fs.readFile(path.resolve(cwd,recovered.file)),bytes);
    const receiptAfter=JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(cwd,recovered.file)),'receipt.json'),'utf8'));
    assert.equal(receiptAfter.recovered,true);
    if(mode==='edit'){assert.equal(receiptAfter.editOf,'reference.png');assert.deepEqual(receiptAfter.references,['reference.png']);assert.equal(receiptAfter.referenceHashes.length,1);}
    assert.equal(await fs.readFile(marker,'utf8'),'keep');assert.equal(existsSync(receipt),true,'recovery preserves its input checkpoint');
  }
  assert.equal(downloads,2,'cancelled calls did not start a download');
  status=503;const statuses=[];let receipt;
  await assert.rejects(imageGenerateRun({prompt:'Authored failed download'},cwd,undefined,undefined,env,{onUsage:(_usage,state)=>statuses.push(state)}),error=>{receipt=error.retainedImageDownload;return Boolean(receipt);});
  assert.deepEqual(statuses,['pending','completed']);
  const before=generations;
  await assert.rejects(imageRecoverRun({path:receipt},cwd),/checkpoint retained/);
  assert.equal(generations,before);assert.ok(existsSync(receipt));
  status=200;assert.equal((await imageRecoverRun({path:receipt},cwd)).decodeVerified,true);assert.equal(generations,3);
});
