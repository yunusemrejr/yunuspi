import test from 'node:test';
import assert from 'node:assert/strict';
import {safetyState,rateLimitWait,fullSafetyPassed} from '../scripts/release-tag.mjs';

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

test('manual and recurring main checks are reusable, while skipped full checks never authorize a tag',()=>{
  for(const event of ['workflow_dispatch','schedule']) assert.equal(safetyState([run({event})],sha),'passed');
  assert.equal(fullSafetyPassed([{name:'safety',status:'completed',conclusion:'success'}]),true);
  for(const jobs of [undefined,[],[{name:'minimum-node',status:'completed',conclusion:'success'}],[{name:'safety',status:'completed',conclusion:'skipped'}],[{name:'safety',status:'in_progress',conclusion:null}]])assert.equal(fullSafetyPassed(jobs),false);
});

test('the newest run for the commit decides, so a rerun can recover a failure',()=>{
  assert.equal(safetyState([run({id:1,conclusion:'failure'}),run({id:2})],sha),'passed');
  assert.equal(safetyState([run({id:1}),run({id:2,conclusion:'failure'})],sha),'failed');
});

test('a used-up rate limit is waited out, any other refusal still stops the tag',()=>{
  const headers=(h)=>new Headers(h), now=1_000_000;
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+30)}),now),32_000,'waits until the reset plus a margin');
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000-5)}),now),1000,'a reset already past retries after a second');
  assert.equal(rateLimitWait(429,headers({'retry-after':'7'}),now),7000);
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'12'}),now),undefined,'a 403 with budget left is a real refusal');
  assert.equal(rateLimitWait(404,headers({'x-ratelimit-remaining':'0'}),now),undefined);
  assert.equal(rateLimitWait(500,headers({}),now),undefined);
});
