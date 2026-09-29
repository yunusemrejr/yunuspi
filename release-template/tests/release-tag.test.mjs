import test from 'node:test';
import assert from 'node:assert/strict';
import {safetyState} from '../scripts/release-tag.mjs';

const sha='a'.repeat(40);
const run=(over)=>({id:1,head_sha:sha,head_branch:'main',event:'push',status:'completed',conclusion:'success',...over});

test('a tag waits for the exact commit\'s main push run and only a success releases it',()=>{
  assert.equal(safetyState([run({})],sha),'passed');
  assert.equal(safetyState([run({status:'in_progress',conclusion:null})],sha),'pending');
  assert.equal(safetyState([run({status:'queued',conclusion:null})],sha),'pending');
  assert.equal(safetyState([run({conclusion:'failure'})],sha),'failed');
  assert.equal(safetyState([],sha),'missing');
  assert.equal(safetyState(undefined,sha),'missing');
});

test('runs for other commits, branches or events never count as evidence',()=>{
  assert.equal(safetyState([run({head_sha:'b'.repeat(40)})],sha),'missing');
  assert.equal(safetyState([run({head_branch:'v1.0.0'})],sha),'missing');
  assert.equal(safetyState([run({event:'pull_request'})],sha),'missing');
});

test('the newest run for the commit decides, so a rerun can recover a failure',()=>{
  assert.equal(safetyState([run({id:1,conclusion:'failure'}),run({id:2})],sha),'passed');
  assert.equal(safetyState([run({id:1}),run({id:2,conclusion:'failure'})],sha),'failed');
});
